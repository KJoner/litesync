import { Modal, Notice } from "obsidian";
import { ConflictError } from "../api/client";
import { assembleResolution } from "../merge/three-way";
import { SyncContext } from "../sync/context";
import { keepBothForConflict, loadConflict, LocalChangedError, saveResolution } from "./conflict-actions";
import { listPendingConflicts, LoadedConflict } from "./conflict-state";

/** 未解决冲突列表（计划书 Phase 15）。 */
export class ConflictListModal extends Modal {
	constructor(private ctx: SyncContext) {
		super(ctx.app);
	}

	onOpen(): void {
		this.titleEl.setText("未解决的同步冲突");
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const conflicts = listPendingConflicts(this.ctx);
		if (conflicts.length === 0) {
			contentEl.setText("没有未解决的冲突 ✓");
			return;
		}
		const list = contentEl.createDiv({ cls: "litesync-conflict-list" });
		for (const [path, pending] of conflicts) {
			const item = list.createDiv({ cls: "litesync-conflict-item" });
			const info = item.createDiv();
			info.createDiv({ text: `● ${path}` });
			info.createDiv({
				cls: "litesync-history-meta",
				text: `发现于 ${new Date(pending.createdAt).toLocaleString()}`,
			});
			item.createEl("button", { text: "处理", attr: { "aria-label": `处理 ${path} 的冲突` } });
			item.onclick = () => {
				this.close();
				new ResolverModal(this.ctx, path).open();
			};
		}
	}
}

/** 单个文件的冲突 Resolver。 */
export class ResolverModal extends Modal {
	private loaded: LoadedConflict | null = null;
	/** 每个冲突段的当前选择文本（undefined = 未选择） */
	private choices: Record<string, string> = {};
	private manualEdit = false;
	/** 已处理 X / N（UI 焕新 U5）：选择进度以文字公布，不只靠按钮的颜色。 */
	private progressEl: HTMLElement | null = null;
	private progressTotal = 0;
	private saveBtn: HTMLButtonElement | null = null;
	private saveHint: HTMLElement | null = null;
	/** 保存请求进行中：按钮禁用，防重复提交。 */
	private saving = false;
	private mergedTextarea: HTMLTextAreaElement | null = null;
	private hunkEls: HTMLElement[] = [];
	private currentHunk = 0;

	constructor(
		private ctx: SyncContext,
		private path: string,
	) {
		super(ctx.app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("mod-sync-resolver");
		this.titleEl.setText(`解决冲突 — ${this.path}`);
		this.contentEl.setText("加载中…");
		await this.reload();
	}

	private async reload(): Promise<void> {
		this.choices = {};
		this.manualEdit = false;
		this.hunkEls = [];
		this.currentHunk = 0;
		try {
			this.loaded = await loadConflict(this.ctx, this.path);
		} catch (e) {
			this.contentEl.setText(e instanceof Error ? e.message : String(e));
			this.ctx.onConflictsChanged();
			return;
		}
		// 加载后可能发现其实可以干净合并（远端变化后冲突消失）
		if (this.loaded.merge.clean) {
			try {
				await saveResolution(
					this.ctx,
					this.path,
					this.loaded.merge.mergedText,
					this.loaded.remoteRevision,
					this.loaded.localHash,
					this.loaded.remoteGeneration,
				);
				new Notice(`冲突已自动消除：${this.path}`);
				this.ctx.onConflictsChanged();
				this.close();
				return;
			} catch {
				/* 失败则继续人工处理 */
			}
		}
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("litesync-resolver");
		const loaded = this.loaded!;

		if (loaded.baseText === null) {
			contentEl.createDiv({
				cls: "litesync-history-meta",
				text: "共同祖先版本已不可用，以下按“本地 vs 远端”整体对比。",
			});
		}

		// LOCAL / REMOTE 双栏
		const panes = contentEl.createDiv({ cls: "litesync-resolver-panes" });
		const localPane = panes.createDiv({ cls: "litesync-resolver-pane" });
		localPane.createEl("h4", { text: "本机（此设备）" });
		localPane.createEl("pre", { cls: "litesync-resolver-pre", text: loaded.localText });
		const remotePane = panes.createDiv({ cls: "litesync-resolver-pane" });
		remotePane.createEl("h4", { text: `云端（版本 ${loaded.remoteRevision}）` });
		remotePane.createEl("pre", { cls: "litesync-resolver-pre", text: loaded.remoteText });

		// 冲突段列表
		const hunksBox = contentEl.createDiv();
		const conflicts = loaded.merge.conflicts;
		const nav = contentEl.createDiv({ cls: "litesync-hunk-buttons" });
		nav.createEl("button", { text: "上一个冲突" }).onclick = () => this.gotoHunk(this.currentHunk - 1);
		nav.createEl("button", { text: "下一个冲突" }).onclick = () => this.gotoHunk(this.currentHunk + 1);
		this.progressEl = nav.createSpan({ cls: "litesync-hunk-progress" });
		this.progressEl.setAttr("role", "status");
		this.progressTotal = conflicts.length;
		const autoResolved = loaded.merge.stats?.autoResolved ?? 0;
		if (autoResolved > 0) nav.createSpan({ cls: "litesync-history-meta", text: `另有 ${autoResolved} 处已自动合并` });
		// 「采用全部建议」：一次性接受引擎给出的全部建议（仍需「保存合并」才生效）
		const suggestionAppliers: Array<() => void> = [];
		const suggestedCount = conflicts.filter((c) => c.suggestedText !== undefined).length;
		if (suggestedCount > 0) {
			nav.createEl("button", { text: `采用全部建议 (${suggestedCount})`, cls: "mod-cta" }).onclick = () => {
				for (const apply of suggestionAppliers) apply();
			};
		}

		conflicts.forEach((c, idx) => {
			const box = hunksBox.createDiv({ cls: "litesync-hunk" });
			this.hunkEls.push(box);
			box.createDiv({ cls: "litesync-hunk-label", text: `第 ${idx + 1} / ${conflicts.length} 处冲突` });
			if (c.baseText !== "" || c.localText === "" || c.remoteText === "") {
				box.createDiv({ cls: "litesync-hunk-label", text: "原来的内容" });
				box.createDiv({ cls: "litesync-hunk-text", text: c.baseText || "（空）" });
			}
			box.createDiv({ cls: "litesync-hunk-label", text: "本机" });
			box.createDiv({ cls: "litesync-hunk-text litesync-hunk-local", text: c.localText || "（删除该段）" });
			box.createDiv({ cls: "litesync-hunk-label", text: "云端" });
			box.createDiv({ cls: "litesync-hunk-text litesync-hunk-remote", text: c.remoteText || "（删除该段）" });

			// 智能合并建议（v0.8.1）：只建议，绝不自动写入；用户点击才采纳
			let bSuggest: HTMLButtonElement | null = null;
			if (c.suggestedText !== undefined) {
				const confidenceText = c.confidence === "high" ? "高" : c.confidence === "low" ? "低" : "中";
				const sug = box.createDiv({ cls: "litesync-hunk-suggest" });
				sug.createDiv({
					cls: "litesync-hunk-label",
					text: `LiteSync 建议（置信度：${confidenceText}）：${c.reason ?? ""}`,
				});
				sug.createDiv({ cls: "litesync-hunk-text", text: c.suggestedText || "（删除该段）" });
			}

			const btns = box.createDiv({ cls: "litesync-hunk-buttons" });
			if (c.suggestedText !== undefined) {
				bSuggest = btns.createEl("button", { text: "采用建议", cls: "mod-cta" });
			}
			// UI 焕新 U5（UX-08）：中文动作；「依次保留两段」是段落拼接，与文件级的「保留两个文件」区分开。
			const bLocal = btns.createEl("button", { text: "保留本机段落" });
			const bRemote = btns.createEl("button", { text: "保留云端段落" });
			const bBoth = btns.createEl("button", { text: "依次保留两段" });
			for (const b of [bLocal, bRemote, bBoth]) b.setAttr("aria-pressed", "false");
			if (bSuggest) bSuggest.setAttr("aria-pressed", "false");
			const allBtns = [bLocal, bRemote, bBoth, ...(bSuggest ? [bSuggest] : [])];
			const pick = (text: string, chosen: HTMLButtonElement) => {
				this.choices[c.id] = text;
				box.addClass("litesync-hunk-resolved");
				for (const b of allBtns) {
					b.removeClass("litesync-chosen");
					b.setAttr("aria-pressed", "false");
				}
				chosen.addClass("litesync-chosen");
				// The choice is announced, not only coloured.
				chosen.setAttr("aria-pressed", "true");
				this.refreshMerged();
				this.refreshProgress();
			};
			if (bSuggest) {
				const applySuggestion = () => pick(c.suggestedText!, bSuggest);
				bSuggest.onclick = applySuggestion;
				suggestionAppliers.push(() => {
					// 批量采用时不覆盖用户已手动做出的选择
					if (this.choices[c.id] === undefined) applySuggestion();
				});
			}
			bLocal.onclick = () => pick(c.localText, bLocal);
			bRemote.onclick = () => pick(c.remoteText, bRemote);
			bBoth.onclick = () =>
				pick(
					c.localText === "" ? c.remoteText : c.remoteText === "" ? c.localText : `${c.localText}\n${c.remoteText}`,
					bBoth,
				);
		});

		// 合并结果（可编辑）
		const mergedBox = contentEl.createDiv({ cls: "litesync-resolver-merged" });
		mergedBox.createEl("h4", { text: "合并结果（可以直接编辑）" });
		this.mergedTextarea = mergedBox.createEl("textarea");
		this.mergedTextarea.placeholder = "为每处冲突选择「保留本机段落 / 保留云端段落 / 依次保留两段」，或者直接在这里编辑最终内容";
		this.mergedTextarea.addEventListener("input", () => {
			this.manualEdit = true;
			this.updateSaveState();
		});
		this.refreshMerged();
		this.refreshProgress();

		// 底部操作
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		this.saveHint = footer.createDiv({ cls: "litesync-history-meta litesync-resolver-hint" });
		this.saveHint.setAttr("aria-live", "polite");
		this.saveBtn = footer.createEl("button", { text: "保存合并", cls: "mod-cta" });
		this.saveBtn.onclick = () => void this.save();
		const keepBoth = footer.createEl("button", { text: "保留两个文件" });
		keepBoth.setAttr("title", "不合并：本机版本另存为一个新文件，云端版本保留原名");
		keepBoth.onclick = () => void this.keepBoth();
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		this.updateSaveState();
	}

	private gotoHunk(idx: number): void {
		if (this.hunkEls.length === 0) return;
		this.currentHunk = Math.max(0, Math.min(idx, this.hunkEls.length - 1));
		this.hunkEls[this.currentHunk].scrollIntoView({ behavior: "smooth", block: "center" });
	}

	private refreshProgress(): void {
		if (this.progressEl && this.progressTotal > 0) {
			const done = Object.keys(this.choices).length;
			this.progressEl.setText(`已处理 ${Math.min(done, this.progressTotal)} / ${this.progressTotal} 处冲突`);
		}
		this.updateSaveState();
	}

	/** 「保存合并」只在有完整结果时可用；不可用时就地说明原因（UI 焕新 U5，UX-08）。 */
	private updateSaveState(): void {
		if (!this.saveBtn) return;
		const ready = this.finalText() !== null;
		this.saveBtn.disabled = !ready || this.saving;
		if (this.saveHint) {
			const left = this.loaded ? this.loaded.merge.conflicts.filter((c) => this.choices[c.id] === undefined).length : 0;
			this.saveHint.setText(ready || this.saving ? "" : `还有 ${left} 处冲突没有选择；也可以直接编辑上面的合并结果。`);
		}
	}

	/** 根据当前选择重建合并预览（用户手动编辑后不再自动覆盖）。 */
	private refreshMerged(): void {
		if (!this.mergedTextarea || this.manualEdit || !this.loaded) return;
		const allChosen = this.loaded.merge.conflicts.every((c) => this.choices[c.id] !== undefined);
		if (!allChosen) return;
		this.mergedTextarea.value = assembleResolution(this.loaded.merge.segments, this.choices);
	}

	private finalText(): string | null {
		if (!this.loaded) return null;
		if (this.manualEdit) return this.mergedTextarea?.value ?? null;
		const allChosen = this.loaded.merge.conflicts.every((c) => this.choices[c.id] !== undefined);
		if (!allChosen) return null;
		return assembleResolution(this.loaded.merge.segments, this.choices);
	}

	private async save(): Promise<void> {
		if (this.saving) return;
		const text = this.finalText();
		if (text === null) {
			new Notice("还有没有选择的冲突：先为每处冲突做选择，或者直接编辑合并结果");
			return;
		}
		this.saving = true;
		this.updateSaveState();
		try {
			const rev = await saveResolution(
				this.ctx,
				this.path,
				text,
				this.loaded!.remoteRevision,
				this.loaded!.localHash,
				this.loaded!.remoteGeneration,
			);
			new Notice(`已保存合并：${this.path}（版本 ${rev}）`);
			this.ctx.onConflictsChanged();
			this.close();
		} catch (e) {
			if (e instanceof ConflictError) {
				// Race Protection：远端在处理期间又变化 → 重新加载最新内容重新 merge
				new Notice("远端在处理期间又发生了变化，已重新加载最新版本，请重新确认合并");
				this.contentEl.setText("重新加载中…");
				await this.reload();
			} else if (e instanceof LocalChangedError) {
				// 本地 CAS（v9）：处理期间本地文件被编辑 → 重新加载，绝不覆盖
				new Notice("本地文件在处理期间被修改，已重新加载，请重新确认合并");
				this.contentEl.setText("重新加载中…");
				await this.reload();
			} else {
				new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
			}
		} finally {
			this.saving = false;
			this.updateSaveState();
		}
	}

	private async keepBoth(): Promise<void> {
		try {
			await keepBothForConflict(this.ctx, this.path);
			this.ctx.onConflictsChanged();
			this.close();
		} catch (e) {
			new Notice(`操作失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
