import { App, Modal } from "obsidian";

/**
 * 元数据加密迁移确认（v9.3 三期）：明文路径抹除不可逆，必须显式确认。
 */
export class ConfirmMetaEncryptionModal extends Modal {
	constructor(
		app: App,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("加密路径与文件名");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "此操作把服务器上的所有文件路径与文件名替换为随机伪名，真实路径改为端到端加密存储。服务器（及其备份）将再也无法看到你的目录结构与文件名。",
		});
		const ul = contentEl.createEl("ul");
		ul.createEl("li", { text: "不可逆：完成时服务器上的明文路径记录（含历史与变更日志）会被抹除" });
		ul.createEl("li", { text: "前置：已启用 E2EE、已执行「升级加密信封 LSE1 → LSE3」、无未解决冲突" });
		ul.createEl("li", { text: "所有设备都必须升级到 0.12+，旧版本将无法读取此仓库" });
		ul.createEl("li", { text: "强烈建议先完成一次 R2 备份；中断后重新执行本命令即可续传" });
		ul.createEl("li", { text: "旧信封时代的历史版本将随明文路径一并清除（当前内容不受影响）" });

		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: "我已了解，开始加密", cls: "mod-warning" }).onclick = () => {
			this.close();
			this.onConfirm();
		};
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
	}
}
