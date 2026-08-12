import { App, Modal } from "obsidian";

/**
 * 元数据加密迁移确认（v9.3 三期；v0.12.1 改为实验功能确认）。
 *
 * v0.12.1（LS-121-C01）：默认构建不再执行不可逆的明文路径抹除，弹窗必须
 * 如实说明「这一版能做什么、不能做什么、备份里还有什么」，不能让用户以为
 * 点完之后服务器上的明文路径就已经彻底消失。
 */
export class ConfirmMetaEncryptionModal extends Modal {
	constructor(
		app: App,
		private allowIrreversibleErase: boolean,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("加密路径与文件名（实验功能）");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "此操作把服务器上的所有文件路径与文件名替换为随机伪名，真实路径改为端到端加密存储。",
		});

		contentEl.createEl("p", {
			cls: "mod-warning",
			text: "v0.12.x 不适用于你唯一的真实 Vault——请只在测试 Vault 或已完整备份的副本上使用。",
		});

		const ul = contentEl.createEl("ul");
		ul.createEl("li", { text: "迁移前的服务器备份中可能仍然含有明文路径，本操作不会也无法清理它们" });
		ul.createEl("li", { text: "前置：已启用 E2EE、已执行「升级加密信封 LSE1 → LSE3」、无未解决冲突" });
		ul.createEl("li", { text: "所有设备都必须升级到 0.12+，旧版本将无法读取此仓库" });
		ul.createEl("li", { text: "中断后重新执行本命令即可续传" });

		if (this.allowIrreversibleErase) {
			ul.createEl("li", {
				cls: "mod-warning",
				text:
					"你已打开开发者开关「允许不可逆的明文路径抹除」：完成后服务器上的明文路径记录会被抹除，" +
					"届时无法依赖普通回滚恢复真实路径（v0.12.1 服务端仍会在存在明文 tombstone 时拒绝该步骤）",
			});
		} else {
			ul.createEl("li", {
				text:
					"本次不会执行不可逆的明文抹除：迁移停在「已伪名化但未抹除」的可回退状态，" +
					"随时可以在设置中「放弃路径加密迁移」退回 plain。正式抹除请等待 v0.13.0 的隐私 tombstone ledger",
			});
		}

		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: "我已了解，开始伪名化", cls: "mod-warning" }).onclick = () => {
			this.close();
			this.onConfirm();
		};
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
	}
}
