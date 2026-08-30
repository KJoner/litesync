import { App, Modal } from "obsidian";

/**
 * 首次配置对话框（0.17.0-rc.3 引入时为三选项；0.19.x 起新仓库**强制 E2EE**，
 * 明文的「立即同步」已移除）。
 *
 * 第一台设备填好 Server URL + Token 后点「测试连接」，若远端仓库尚未初始化
 *（latestSequence=0 且未启用 E2EE），不再只弹一条成功消息，而是当场给出下一步：
 *
 *   关闭                    —— 什么都不做（稍后可从命令面板 / 向导继续）
 *   设置 E2EE 并立即同步     —— 先设 E2EE 密码（空仓启用，无迁移），
 *                              再 local-init；首次上传即密文，明文不落服务器
 */
export interface FirstSyncChoices {
	/** 打开 E2EE 设密码弹窗（其回调里完成空仓启用 + local-init） */
	withE2ee: () => void;
}

export class FirstSyncModal extends Modal {
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
				"初始化需要先设置端到端加密（E2EE）密码——首次上传就是密文，" +
				"服务器从头到尾见不到明文。密码丢失数据无法找回，请妥善保管。",
		});

		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: "关闭" }).onclick = () => this.close();
		footer.createEl("button", { text: "设置 E2EE 并立即同步", cls: "mod-cta" }).onclick = () => {
			// 先关自己再开设密码弹窗（项目内 Modal 接力的通用模式）
			this.close();
			this.choices.withE2ee();
		};
	}
}
