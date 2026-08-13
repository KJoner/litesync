import { App, Modal, Notice } from "obsidian";

/**
 * 首次配置三选项（0.17.0-rc.3）。
 *
 * 第一台设备填好 Server URL + Token 后点「测试连接」，若远端仓库尚未初始化
 *（latestSequence=0 且未启用 E2EE），不再只弹一条成功消息，而是当场给出下一步：
 *
 *   关闭                    —— 什么都不做（稍后可从命令面板 / 向导继续）
 *   立即同步                —— local-init 接入并开始首轮同步
 *   添加 E2EE 并立即同步     —— 先设 E2EE 密码（空仓启用，无迁移），
 *                              再 local-init；首次上传即密文，明文不落服务器
 */
export interface FirstSyncChoices {
	/** local-init 接入 + 触发首轮同步；远端已非空时内部转交接入向导 */
	syncNow: () => Promise<void>;
	/** 打开 E2EE 设密码弹窗（其回调里完成空仓启用 + local-init） */
	withE2ee: () => void;
}

export class FirstSyncModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private choices: FirstSyncChoices,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("连接成功：远端仓库尚未初始化");
		const { contentEl } = this;
		contentEl.createEl("p", { text: "服务器工作正常，上面还没有任何内容。现在就把本地 Vault 初始化到远端吗？" });
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text:
				"「立即同步」：直接初始化并开始同步（内容以服务器可读的形式存储，传输走 HTTPS）。\n" +
				"「添加 E2EE 并立即同步」：先设置端到端加密密码再初始化——首次上传就是密文，" +
				"服务器从头到尾见不到明文。之后也可以随时在设置页启用 E2EE。",
		});

		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: "关闭" }).onclick = () => this.close();
		footer.createEl("button", { text: "添加 E2EE 并立即同步" }).onclick = () => {
			// 先关自己再开设密码弹窗（项目内 Modal 接力的通用模式）
			this.close();
			this.choices.withE2ee();
		};
		const syncBtn = footer.createEl("button", { text: "立即同步", cls: "mod-cta" });
		syncBtn.onclick = async () => {
			if (this.busy) return;
			this.busy = true;
			syncBtn.disabled = true;
			syncBtn.setText("初始化中…");
			try {
				await this.choices.syncNow();
				this.close();
			} catch (e) {
				new Notice(`初始化失败：${e instanceof Error ? e.message : String(e)}`);
				this.busy = false;
				syncBtn.disabled = false;
				syncBtn.setText("立即同步");
			}
		};
	}
}
