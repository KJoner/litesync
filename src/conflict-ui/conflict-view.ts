import { Modal, Notice } from "obsidian";
import { ConflictError } from "../api/client";
import { assembleResolution } from "../merge/three-way";
import { SyncContext } from "../sync/context";
import { keepBothForConflict, loadConflict, saveResolution } from "./conflict-actions";
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
			item.createEl("button", { text: "处理" });
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
				await saveResolution(this.ctx, this.path, this.loaded.merge.mergedText, this.loaded.remoteRevision);
				new Notice(`冲突已自动消除: ${this.path}`);
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
		localPane.createEl("h4", { text: "Local（本设备）" });
		localPane.createEl("pre", { cls: "litesync-resolver-pre", text: loaded.localText });
		const remotePane = panes.createDiv({ cls: "litesync-resolver-pane" });
		remotePane.createEl("h4", { text: `Remote（服务器 rev ${loaded.remoteRevision}）` });
		remotePane.createEl("pre", { cls: "litesync-resolver-pre", text: loaded.remoteText });

		// 冲突段列表
		const hunksBox = contentEl.createDiv();
		const conflicts = loaded.merge.conflicts;
		const nav = contentEl.createDiv({ cls: "litesync-hunk-buttons" });
		nav.createEl("button", { text: "上一个冲突" }).onclick = () => this.gotoHunk(this.currentHunk - 1);
		nav.createEl("button", { text: "下一个冲突" }).onclick = () => this.gotoHunk(this.currentHunk + 1);
		nav.createSpan({ cls: "litesync-history-meta", text: `共 ${conflicts.length} 处冲突` });

		conflicts.forEach((c, idx) => {
			const box = hunksBox.createDiv({ cls: "litesync-hunk" });
			this.hunkEls.push(box);
			box.createDiv({ cls: "litesync-hunk-label", text: `冲突 #${idx + 1}` });
			if (c.baseText !== "" || c.localText === "" || c.remoteText === "") {
				box.createDiv({ cls: "litesync-hunk-label", text: "BASE:" });
				box.createDiv({ cls: "litesync-hunk-text", text: c.baseText || "（空）" });
			}
			box.createDiv({ cls: "litesync-hunk-label", text: "LOCAL:" });
			box.createDiv({ cls: "litesync-hunk-text litesync-hunk-local", text: c.localText || "（删除该段）" });
			box.createDiv({ cls: "litesync-hunk-label", text: "REMOTE:" });
			box.createDiv({ cls: "litesync-hunk-text litesync-hunk-remote", text: c.remoteText || "（删除该段）" });

			const btns = box.createDiv({ cls: "litesync-hunk-buttons" });
			const bLocal = btns.createEl("button", { text: "Use local" });
			const bRemote = btns.createEl("button", { text: "Use remote" });
			const bBoth = btns.createEl("button", { text: "Use both" });
			const pick = (text: string, chosen: HTMLButtonElement) => {
				this.choices[c.id] = text;
				box.addClass("litesync-hunk-resolved");
				for (const b of [bLocal, bRemote, bBoth]) b.removeClass("litesync-chosen");
				chosen.addClass("litesync-chosen");
				this.refreshMerged();
			};
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
		mergedBox.createEl("h4", { text: "Merged result（可直接编辑）" });
		this.mergedTextarea = mergedBox.createEl("textarea");
		this.mergedTextarea.placeholder = "为每个冲突段选择 Use local / Use remote / Use both，或直接在此编辑最终内容";
		this.mergedTextarea.addEventListener("input", () => {
			this.manualEdit = true;
		});
		this.refreshMerged();

		// 底部操作
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const saveBtn = footer.createEl("button", { text: "Save merge", cls: "mod-cta" });
		saveBtn.onclick = () => void this.save();
		footer.createEl("button", { text: "Keep both（保留两个版本）" }).onclick = () => void this.keepBoth();
		footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
	}

	private gotoHunk(idx: number): void {
		if (this.hunkEls.length === 0) return;
		this.currentHunk = Math.max(0, Math.min(idx, this.hunkEls.length - 1));
		this.hunkEls[this.currentHunk].scrollIntoView({ behavior: "smooth", block: "center" });
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
		const text = this.finalText();
		if (text === null) {
			new Notice("还有未处理的冲突段（或合并结果为空）");
			return;
		}
		try {
			const rev = await saveResolution(this.ctx, this.path, text, this.loaded!.remoteRevision);
			new Notice(`合并完成: ${this.path} → Revision ${rev}`);
			this.ctx.onConflictsChanged();
			this.close();
		} catch (e) {
			if (e instanceof ConflictError) {
				// Race Protection：远端在处理期间又变化 → 重新加载最新内容重新 merge
				new Notice("远端在处理期间又发生了变化，已重新加载最新版本，请重新确认合并");
				this.contentEl.setText("重新加载中…");
				await this.reload();
			} else {
				new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
			}
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
