import { App, Modal, Notice, Platform } from "obsidian";
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
	/**
	 * 逐处处理（UI 焕新 U5b，UX-08）：多于一处冲突时一次只显示一处，用「上一处 / 下一处」切换；
	 * 「显示全部冲突」回到上下堆叠的视图。只换显示方式，选择与合并结果不受影响。
	 */
	private focusMode = true;
	private positionEl: HTMLElement | null = null;
	private prevBtn: HTMLButtonElement | null = null;
	private nextBtn: HTMLButtonElement | null = null;
	private modeBtn: HTMLButtonElement | null = null;
	/** 已保存 / 已保留两个文件 / 冲突已自动消除：关闭时不再确认。 */
	private resolved = false;
	/** 用户在确认框里选了「放弃并关闭」。 */
	private discardConfirmed = false;
	/**
	 * 保存时远端或本机又变了（重新加载后对比换成最新内容）：用户刚才手工编辑的合并结果留在这里，
	 * 让他对照后决定是否沿用——绝不静默套用到新的对比上，也不随重新加载丢掉。
	 */
	private previousManualText: string | null = null;

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
				this.resolved = true;
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

		// 手机（或很窄的窗口）：全文对照改成「本机 / 云端 / 结果」三个标签，冲突段放在最上面先处理
		const phone = Platform.isPhone || (contentEl.ownerDocument.defaultView?.matchMedia?.("(max-width: 600px)").matches ?? false);
		const conflicts = loaded.merge.conflicts;

		// 本机 / 云端全文（桌面双栏）
		const panes = createDiv({ cls: "litesync-resolver-panes" });
		const localPane = panes.createDiv({ cls: "litesync-resolver-pane" });
		localPane.createEl("h4", { text: "本机（此设备）" });
		localPane.createEl("pre", { cls: "litesync-resolver-pre", text: loaded.localText });
		const remotePane = panes.createDiv({ cls: "litesync-resolver-pane" });
		remotePane.createEl("h4", { text: `云端（版本 ${loaded.remoteRevision}）` });
		remotePane.createEl("pre", { cls: "litesync-resolver-pre", text: loaded.remoteText });

		// 冲突段：导航在上（第 i / N 处 · 已处理 X / N），下面是当前这一处
		const nav = createDiv({ cls: "litesync-hunk-nav" });
		const hunksBox = createDiv({ cls: "litesync-hunks" });
		this.prevBtn = nav.createEl("button", { text: "上一处" });
		this.prevBtn.onclick = () => this.gotoHunk(this.currentHunk - 1);
		this.nextBtn = nav.createEl("button", { text: "下一处" });
		this.nextBtn.onclick = () => this.gotoHunk(this.currentHunk + 1);
		this.positionEl = nav.createSpan({ cls: "litesync-hunk-position" });
		this.progressEl = nav.createSpan({ cls: "litesync-hunk-progress" });
		this.progressEl.setAttr("role", "status");
		this.progressTotal = conflicts.length;
		const autoResolved = loaded.merge.stats?.autoResolved ?? 0;
		if (autoResolved > 0) nav.createSpan({ cls: "litesync-history-meta", text: `另有 ${autoResolved} 处已自动合并` });
		this.focusMode = conflicts.length > 1;
		this.modeBtn = null;
		if (conflicts.length > 1) {
			this.modeBtn = nav.createEl("button", { cls: "litesync-hunk-mode" });
			this.modeBtn.onclick = () => {
				this.focusMode = !this.focusMode;
				this.applyHunkVisibility();
			};
		}
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
		const mergedBox = createDiv({ cls: "litesync-resolver-merged" });
		mergedBox.createEl("h4", { text: "合并结果（可以直接编辑）" });
		this.mergedTextarea = mergedBox.createEl("textarea");
		this.mergedTextarea.placeholder = "为每处冲突选择「保留本机段落 / 保留云端段落 / 依次保留两段」，或者直接在这里编辑最终内容";
		this.mergedTextarea.addEventListener("input", () => {
			this.manualEdit = true;
			this.updateSaveState();
		});

		// 保存时远端 / 本机又变了：刚才手工编辑的结果保留在这里，由用户决定是否沿用
		const previousBox = this.previousManualText !== null ? this.renderPreviousManual() : null;

		if (phone) {
			// 手机：先逐处处理，再在「本机 / 云端 / 结果」之间切换着看全文
			if (previousBox) contentEl.appendChild(previousBox);
			contentEl.appendChild(nav);
			contentEl.appendChild(hunksBox);
			this.renderTabs(contentEl, [
				{ label: "本机", panel: localPane },
				{ label: "云端", panel: remotePane },
				{ label: "结果", panel: mergedBox },
			]);
		} else {
			contentEl.appendChild(panes);
			if (previousBox) contentEl.appendChild(previousBox);
			contentEl.appendChild(nav);
			contentEl.appendChild(hunksBox);
			contentEl.appendChild(mergedBox);
		}
		this.refreshMerged();
		this.refreshProgress();
		this.applyHunkVisibility();

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
		this.applyHunkVisibility();
		if (!this.focusMode) this.hunkEls[this.currentHunk].scrollIntoView({ behavior: "smooth", block: "center" });
	}

	/** 逐处：只显示当前这一处（hidden 让其余几处也不进读屏与 Tab 顺序）；全部：都显示。 */
	private applyHunkVisibility(): void {
		const n = this.hunkEls.length;
		this.hunkEls.forEach((el, i) => {
			el.hidden = this.focusMode && i !== this.currentHunk;
		});
		if (this.positionEl) this.positionEl.setText(n > 1 ? `第 ${this.currentHunk + 1} / ${n} 处` : "");
		if (this.prevBtn) this.prevBtn.disabled = n <= 1 || this.currentHunk === 0;
		if (this.nextBtn) this.nextBtn.disabled = n <= 1 || this.currentHunk === n - 1;
		if (this.modeBtn) {
			this.modeBtn.setText(this.focusMode ? "显示全部冲突" : "逐处查看");
			this.modeBtn.setAttr("aria-pressed", this.focusMode ? "false" : "true");
		}
	}

	/**
	 * 手机上的「本机 / 云端 / 结果」标签：只切换显示，不重建内容——合并结果里的手工编辑、
	 * 光标与撤销历史都留在同一个 textarea 里。左右方向键在标签之间移动（WAI-ARIA 标签页模式）。
	 */
	private renderTabs(parent: HTMLElement, tabs: Array<{ label: string; panel: HTMLElement }>): void {
		const id = `litesync-resolver-${++tabSeq}`;
		const bar = parent.createDiv({ cls: "litesync-resolver-tabs", attr: { role: "tablist", "aria-label": "对照" } });
		const panels = parent.createDiv({ cls: "litesync-resolver-tabpanels" });
		const buttons: HTMLButtonElement[] = [];
		const select = (i: number, focus: boolean): void => {
			tabs.forEach((t, k) => {
				const on = k === i;
				buttons[k].setAttr("aria-selected", on ? "true" : "false");
				buttons[k].tabIndex = on ? 0 : -1;
				buttons[k].toggleClass("is-active", on);
				t.panel.hidden = !on;
			});
			if (focus) buttons[i].focus();
		};
		tabs.forEach((t, i) => {
			const btn = bar.createEl("button", {
				text: t.label,
				cls: "litesync-resolver-tab",
				attr: { role: "tab", id: `${id}-tab-${i}`, "aria-controls": `${id}-panel-${i}` },
			});
			btn.onclick = () => select(i, false);
			btn.addEventListener("keydown", (e) => {
				if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
					e.preventDefault();
					select((i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length, true);
				}
			});
			buttons.push(btn);
			t.panel.addClass("litesync-resolver-tabpanel");
			t.panel.setAttrs({ role: "tabpanel", id: `${id}-panel-${i}`, "aria-labelledby": `${id}-tab-${i}` });
			panels.appendChild(t.panel);
		});
		// 默认看「结果」：选完每一处之后要保存的就是它
		select(tabs.length - 1, false);
	}

	/** 上一次保存时远端 / 本机变了：把用户刚才手工编辑的合并结果原样留给他（只读），可以一键沿用。 */
	private renderPreviousManual(): HTMLElement {
		const box = createDiv({ cls: "litesync-resolver-previous" });
		box.createEl("h4", { text: "你刚才编辑的合并结果" });
		box.createDiv({
			cls: "litesync-history-meta",
			text: "保存前远端或本机又有了变化，上面的对比已经换成最新内容。你刚才的编辑保留在这里：可以对照后直接沿用，或者只复制需要的部分。",
		});
		const prev = box.createEl("textarea", { cls: "litesync-resolver-previous-text" });
		prev.value = this.previousManualText ?? "";
		prev.readOnly = true;
		const btn = box.createEl("button", { text: "用它作为合并结果" });
		btn.onclick = () => {
			if (!this.mergedTextarea || this.previousManualText === null) return;
			this.mergedTextarea.value = this.previousManualText;
			this.manualEdit = true;
			this.updateSaveState();
		};
		return box;
	}

	/** 有没有关掉就会丢的东西：段落选择、手工编辑，或上一次保留下来的手工结果。 */
	private hasUnsavedWork(): boolean {
		return Object.keys(this.choices).length > 0 || this.manualEdit || this.previousManualText !== null;
	}

	/**
	 * 关闭（Esc、右上角 ×、点遮罩、「取消」都走这里）：有没保存的选择或手工编辑时先确认，
	 * 默认按钮是「继续处理」。冲突本身无论如何都保留，之后可以再处理。
	 */
	close(): void {
		if (this.resolved || this.discardConfirmed || !this.hasUnsavedWork()) {
			super.close();
			return;
		}
		new DiscardChoicesModal(this.app, () => {
			this.discardConfirmed = true;
			this.close();
		}).open();
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
			this.previousManualText = null;
			this.resolved = true;
			this.close();
		} catch (e) {
			if (e instanceof ConflictError || e instanceof LocalChangedError) {
				// 重新加载会换成最新的对比、清空选择；手工编辑的结果先留下来（见 renderPreviousManual），不丢
				if (this.manualEdit && this.mergedTextarea) this.previousManualText = this.mergedTextarea.value;
			}
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
			this.resolved = true;
			this.close();
		} catch (e) {
			new Notice(`操作失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

let tabSeq = 0;

/** 关闭冲突窗口前的确认：默认「继续处理」；「放弃并关闭」只丢这次的选择，冲突本身保留。 */
class DiscardChoicesModal extends Modal {
	constructor(
		app: App,
		private onDiscard: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("放弃这次的处理？");
		this.contentEl.createEl("p", {
			text: "关闭后，这次做的选择和对合并结果的编辑都会丢失。冲突本身会保留，之后可以再处理。",
		});
		const footer = this.contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const keep = footer.createEl("button", { text: "继续处理", cls: "mod-cta" });
		keep.onclick = () => this.close();
		footer.createEl("button", { text: "放弃并关闭", cls: "mod-warning" }).onclick = () => {
			this.close();
			this.onDiscard();
		};
		window.setTimeout(() => keep.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
