import { App, Modal, Notice } from "obsidian";
import qrcode from "qrcode-generator";
import { ApiClient } from "../api/client";
import { PluginSettings } from "../settings";
import { buildPairUrl, encryptPairingConfig, newPairSecret, PairingConfig } from "./pairing";

/**
 * 「添加新设备」弹窗（v8；v9.2 改为设备凭据流）：
 * 生成一次性加密配对包并展示二维码/链接。配对包只携带一次性注册凭据
 *（enrollmentSecret）——新设备用它换取自己的最小权限设备凭据，
 * 根 Token 与本机凭据都不会传给新设备；E2EE 密码始终手动输入。
 */
export class AddDeviceModal extends Modal {
	private pairingId: string | null = null;
	private consumedOrRevoked = false;

	constructor(
		app: App,
		private client: ApiClient,
		private settings: PluginSettings,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("添加新设备");
		this.contentEl.createDiv({ text: "正在生成配对包…", cls: "litesync-history-meta" });
		void this.createAndRender();
	}

	onClose(): void {
		// 配对窗口关闭即撤销未消费的配对包（新设备已消费时服务器上本就没有了）
		if (this.pairingId && !this.consumedOrRevoked) {
			const id = this.pairingId;
			this.consumedOrRevoked = true;
			void this.client.deletePairing(id).catch(() => undefined);
		}
	}

	private async createAndRender(): Promise<void> {
		const { contentEl } = this;
		try {
			const secret = newPairSecret();
			// 一次性注册凭据（15 分钟，比配对包稍长；两者都是一次性）
			const enrollment = await this.client.createEnrollment(900);
			const config: PairingConfig = {
				v: 2,
				serverUrl: this.settings.serverUrl,
				enrollmentSecret: enrollment.secret,
				syncIntervalSeconds: this.settings.syncIntervalSeconds,
				syncObsidian: this.settings.syncObsidian,
				ignorePatterns: this.settings.ignorePatterns,
			};
			const ciphertext = await encryptPairingConfig(secret, config);
			const { id } = await this.client.createPairing(ciphertext, 300);
			this.pairingId = id;
			const url = buildPairUrl(this.settings.serverUrl, id, secret);
			secret.fill(0);

			contentEl.empty();
			contentEl.createEl("p", {
				text: "在新设备上用系统相机扫码（或打开链接），按提示在 Obsidian 中导入配置。",
			});
			this.renderQr(contentEl, url);

			const input = contentEl.createEl("input", { type: "text", value: url, cls: "litesync-modal-input" });
			input.readOnly = true;
			input.onclick = () => input.select();
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			footer.createEl("button", { text: "复制链接", cls: "mod-cta" }).onclick = () => {
				void navigator.clipboard.writeText(url).then(() => new Notice("配对链接已复制"));
			};

			contentEl.createDiv({
				cls: "litesync-history-meta",
				text: "链接 5 分钟内有效、只能使用一次；配置包已在本机加密，服务器只保存密文。关闭本窗口即作废。",
			});
			contentEl.createDiv({
				cls: "litesync-history-meta",
				text: "安全提示：配对包只含一次性注册凭据，新设备会获得自己的专属凭据（可单独撤销）；E2EE 密码不会随配对包传输，需要在新设备上手动输入一次。",
			});
		} catch (e) {
			contentEl.empty();
			contentEl.createEl("p", {
				text: `生成配对包失败：${e instanceof Error ? e.message : String(e)}（服务器需要 0.8.0+）`,
			});
		}
	}

	/** 用 canvas 绘制二维码（无 innerHTML，无外部资源）。 */
	private renderQr(parent: HTMLElement, text: string): void {
		const qr = qrcode(0, "M");
		qr.addData(text);
		qr.make();
		const modules = qr.getModuleCount();
		const scale = 4;
		const margin = 4 * scale;
		const size = modules * scale + margin * 2;

		const wrap = parent.createDiv({ cls: "litesync-qr-wrap" });
		const canvas = wrap.createEl("canvas", { cls: "litesync-qr" });
		canvas.width = size;
		canvas.height = size;
		const g = canvas.getContext("2d");
		if (!g) return;
		g.fillStyle = "#ffffff";
		g.fillRect(0, 0, size, size);
		g.fillStyle = "#000000";
		for (let r = 0; r < modules; r++) {
			for (let c = 0; c < modules; c++) {
				if (qr.isDark(r, c)) {
					g.fillRect(margin + c * scale, margin + r * scale, scale, scale);
				}
			}
		}
	}
}
