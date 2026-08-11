import { App, Modal } from "obsidian";
import { ApiClient } from "../api/client";

/**
 * 设备列表（v9.2）：展示已注册设备与最近活跃时间。
 * 撤销设备是管理操作，必须持根 Token（服务器 .env），设备凭据无权执行——
 * 这里只读展示并给出撤销指引，被盗设备无法通过本界面撤销其他设备。
 */
export class DeviceListModal extends Modal {
	constructor(
		app: App,
		private client: ApiClient,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("已注册设备");
		this.contentEl.setText("加载中…");
		void this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		try {
			const devices = await this.client.listDevices();
			contentEl.empty();
			if (devices.length === 0) {
				contentEl.setText("尚无设备凭据（首轮同步会自动为本设备换发）");
				return;
			}
			const list = contentEl.createDiv({ cls: "litesync-conflict-list" });
			for (const d of devices) {
				const item = list.createDiv({ cls: "litesync-conflict-item" });
				const info = item.createDiv();
				info.createDiv({
					text: `${d.revoked ? "⛔ " : "● "}${d.name || d.id}${d.current ? "（本设备）" : ""}`,
				});
				info.createDiv({
					cls: "litesync-history-meta",
					text:
						`ID ${d.id} · 权限 ${d.scopes}` +
						` · 注册于 ${new Date(d.createdAt * 1000).toLocaleDateString()}` +
						(d.lastSeenAt > 0 ? ` · 最近活跃 ${new Date(d.lastSeenAt * 1000).toLocaleString()}` : "") +
						(d.revoked ? " · 已撤销" : ""),
				});
			}
			contentEl.createDiv({
				cls: "litesync-history-meta",
				text:
					"撤销设备需要服务器根 Token（安全设计：被盗设备不能反过来撤销其他设备）。\n" +
					"在服务器上执行：curl -X DELETE -H \"Authorization: Bearer <根Token>\" " +
					"<ServerURL>/api/v1/devices/<设备ID>",
			});
		} catch (e) {
			contentEl.setText(`加载失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
