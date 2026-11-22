import { App, Modal, Setting } from "obsidian";
import { ApiClient } from "../api/client";

/**
 * 已连接设备（v9.2；UI 焕新 U5，审查 UX-06）：展示已连接的设备与最近活动。
 *
 * 撤销在网页里做：LiteSync 网页「账号与设备 › 已授权的设备」（`/#/me`）用账号会话撤销本人的设备，
 * 不需要服务器根 Token。设备凭据本身仍然无权撤销其他设备（被盗设备不能反过来撤销别人）——这里只读，
 * 并把用户带到能做这件事的地方。网页地址由当前服务器地址得出（保留自托管的子路径）。
 */
export class DeviceListModal extends Modal {
	constructor(
		app: App,
		private client: ApiClient,
		/** 网页设备页（`<服务器>/#/me`）；服务器地址不能用于网页时为 null。 */
		private manageUrl: string | null,
		private openUrl: (url: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("已连接设备");
		this.contentEl.setText("加载中…");
		void this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		try {
			const devices = await this.client.listDevices();
			contentEl.empty();
			if (devices.length === 0) {
				contentEl.createEl("p", { text: "还没有设备凭据（第一次同步会自动为本设备换发）。" });
			} else {
				const list = contentEl.createDiv({ cls: "litesync-device-list" });
				for (const d of devices) {
					const item = list.createDiv({ cls: "litesync-device-item" });
					item.createDiv({
						cls: "litesync-device-name",
						text: `${d.name || "未命名设备"}${d.current ? "（本设备）" : ""}${d.revoked ? " · 已撤销" : ""}`,
					});
					item.createDiv({
						cls: "litesync-history-meta",
						text: `连接于 ${new Date(d.createdAt * 1000).toLocaleDateString()}` + (d.lastSeenAt > 0 ? ` · 最近活动 ${new Date(d.lastSeenAt * 1000).toLocaleString()}` : ""),
					});
					// Identifiers and scopes are for troubleshooting, not for the person deciding.
					const tech = item.createEl("details", { cls: "litesync-device-tech" });
					tech.createEl("summary", { text: "技术详情" });
					tech.createDiv({ cls: "litesync-history-meta", text: `设备 ID ${d.id} · 权限 ${d.scopes}` });
				}
			}
			this.renderManage(contentEl);
		} catch (e) {
			contentEl.setText(`加载失败：${e instanceof Error ? e.message : String(e)}`);
			this.renderManage(contentEl);
		}
	}

	private renderManage(el: HTMLElement): void {
		const box = el.createDiv({ cls: "litesync-device-manage" });
		new Setting(box)
			.setName("撤销设备在网页里做")
			.setDesc("登录 LiteSync 网页 →「账号与设备」→「已授权的设备」。被撤销的设备下一次联网就失去同步授权；它已经下载的文件不会被远程删除。")
			.addButton((b) => {
				b.setButtonText("在网页管理设备").setCta();
				if (!this.manageUrl) b.setDisabled(true);
				b.onClick(() => this.manageUrl && this.openUrl(this.manageUrl));
			});
		if (this.manageUrl) {
			// The address itself, selectable: when the browser does not open, it can be copied.
			const url = box.createEl("p", { cls: "litesync-history-meta litesync-selectable", text: this.manageUrl });
			url.setAttr("title", "打不开时可以复制这个地址到浏览器");
		} else {
			box.createEl("p", { cls: "litesync-history-meta", text: "当前服务器地址不能用于网页（需要 https://，本机调试地址除外）。请在设置里检查服务器地址。" });
		}
	}
}
