import { App, Modal, Notice } from "obsidian";
import { SyncContext } from "../sync/context";
import {
	bootstrapLocalInit,
	bootstrapMerge,
	bootstrapRemoteWins,
	preflight,
	PreflightResult,
} from "./bootstrap-manager";
import { classifyBootstrap } from "./bootstrap-types";

export interface BootstrapWizardHooks {
	/** 打开 E2EE 解锁弹窗（解锁成功后主流程会重新进入向导） */
	openUnlock: () => void;
	/** 接入完成：触发一次普通同步 */
	onDone: () => void;
	/** 向导关闭（无论是否完成）：复位单例标志 */
	onClosed: () => void;
}

/**
 * 新设备接入向导（v8）。
 * 填完 URL + Token ≠ 可以开始同步：必须先在这里明确本地与远端的关系。
 */
export class BootstrapWizardModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private ctx: SyncContext,
		private hooks: BootstrapWizardHooks,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("LiteSync 新设备接入");
		this.contentEl.createDiv({ text: "正在检测远端仓库…", cls: "litesync-history-meta" });
		void this.runPreflight();
	}

	onClose(): void {
		this.hooks.onClosed();
	}

	private async runPreflight(): Promise<void> {
		try {
			const pre = await preflight(this.ctx);
			this.renderChoices(pre);
		} catch (e) {
			const { contentEl } = this;
			contentEl.empty();
			contentEl.createDiv({ text: `无法连接服务器：${e instanceof Error ? e.message : String(e)}` });
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			footer.createEl("button", { text: "重试", cls: "mod-cta" }).onclick = () => {
				contentEl.empty();
				contentEl.createDiv({ text: "正在检测远端仓库…", cls: "litesync-history-meta" });
				void this.runPreflight();
			};
			footer.createEl("button", { text: "稍后再说" }).onclick = () => this.close();
		}
	}

	private renderChoices(pre: PreflightResult): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createDiv({
			cls: "litesync-history-meta",
			text: `远端 ${pre.remoteFiles.length} 个文件 · 本地 ${pre.localPaths.length} 个文件 · 同路径 ${pre.commonCount} 个`,
		});

		// E2EE：先解锁再谈接入（覆盖/合并都需要解密远端内容）
		if (pre.e2eeEnabled && this.ctx.e2ee.needsUnlock) {
			contentEl.createEl("p", { text: "此同步仓库已启用端到端加密，接入前需要先解锁。" });
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			footer.createEl("button", { text: "解锁 E2EE…", cls: "mod-cta" }).onclick = () => {
				this.close();
				this.hooks.openUnlock();
			};
			footer.createEl("button", { text: "稍后再说" }).onclick = () => this.close();
			return;
		}

		const scenario = classifyBootstrap(pre.localPaths.length, pre.remoteFiles.length);
		const progressEl = contentEl.createDiv({ cls: "litesync-history-meta" });

		const run = async (
			btn: HTMLButtonElement,
			label: string,
			fn: () => Promise<void>,
		): Promise<void> => {
			if (this.busy) return;
			this.busy = true;
			for (const b of Array.from(contentEl.querySelectorAll("button"))) b.disabled = true;
			btn.setText(`${label}中…`);
			try {
				await fn();
				this.close();
				this.hooks.onDone();
			} catch (e) {
				this.busy = false;
				for (const b of Array.from(contentEl.querySelectorAll("button"))) b.disabled = false;
				btn.setText(label);
				progressEl.setText(`失败：${e instanceof Error ? e.message : String(e)}（可重试，已完成部分不会重复处理）`);
			}
		};
		const onProgress = (p: { done: number; total: number; current: string }): void => {
			progressEl.setText(`处理中 ${p.done}/${p.total}：${p.current}`);
		};

		switch (scenario) {
			case "both-empty": {
				contentEl.createEl("p", { text: "本地与远端都是空仓库，直接完成初始化即可。" });
				const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
				const btn = footer.createEl("button", { text: "完成初始化", cls: "mod-cta" });
				btn.onclick = () => void run(btn, "初始化", () => bootstrapLocalInit(this.ctx, pre));
				break;
			}
			case "local-only": {
				contentEl.createEl("p", {
					text: `远端是空仓库。将把本设备的 ${pre.localPaths.length} 个文件上传，作为远端的初始内容。`,
				});
				const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
				const btn = footer.createEl("button", { text: "使用本设备初始化远端", cls: "mod-cta" });
				btn.onclick = () => void run(btn, "初始化", () => bootstrapLocalInit(this.ctx, pre));
				break;
			}
			case "remote-only": {
				contentEl.createEl("p", {
					text: `本地是空仓库。将从远端下载全部 ${pre.remoteFiles.length} 个文件。`,
				});
				const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
				const btn = footer.createEl("button", { text: "从远端恢复此设备", cls: "mod-cta" });
				btn.onclick = () =>
					void run(btn, "恢复", async () => {
						await bootstrapRemoteWins(this.ctx, pre, onProgress);
						new Notice(`已从远端恢复 ${pre.remoteFiles.length} 个文件 ✓`);
					});
				break;
			}
			case "both": {
				contentEl.createEl("p", {
					text: `当前 Vault 已包含 ${pre.localPaths.length} 个文件，远端也已有 ${pre.remoteFiles.length} 个文件。请选择接入方式：`,
				});

				const optA = contentEl.createDiv({ cls: "litesync-hunk" });
				optA.createDiv({ cls: "litesync-hunk-label", text: "从远端恢复，替换本地内容（推荐用于新设备）" });
				optA.createDiv({
					cls: "litesync-history-meta",
					text: "本设备上的同步文件将以远端版本为准；本地不同的内容会先进入回收站，不会永久删除。",
				});
				const btnA = optA.createEl("button", { text: "从远端恢复此设备", cls: "mod-cta" });
				btnA.onclick = () =>
					void run(btnA, "恢复", async () => {
						await bootstrapRemoteWins(this.ctx, pre, onProgress);
						new Notice("已从远端恢复此设备 ✓（被替换的本地内容在回收站）");
					});

				const optB = contentEl.createDiv({ cls: "litesync-hunk" });
				optB.createDiv({ cls: "litesync-hunk-label", text: "保留本地内容，与远端合并" });
				optB.createDiv({
					cls: "litesync-history-meta",
					text: "两边数据都不丢：互补文件互相同步；同路径不同内容的 Markdown 进入冲突解决器，其他文件保留两个版本。",
				});
				const btnB = optB.createEl("button", { text: "与远端合并" });
				btnB.onclick = () =>
					void run(btnB, "合并", async () => {
						const r = await bootstrapMerge(this.ctx, pre, onProgress);
						new Notice(
							`合并完成 ✓ 下载 ${r.downloaded}、上传 ${r.uploaded}` +
								(r.conflicts > 0 ? `、${r.conflicts} 个冲突待处理（见状态栏）` : ""),
							10000,
						);
					});
				break;
			}
		}

		contentEl.createDiv({
			cls: "litesync-history-meta",
			text: "接入完成后将自动进入正常增量同步。",
		});
	}
}
