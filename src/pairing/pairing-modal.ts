import { App, Modal, Notice } from "obsidian";
import qrcode from "qrcode-generator";
import { ApiClient, hasCapability, PLUGIN_PROTOCOL_VERSION } from "../api/client";
import { PluginSettings } from "../settings";
import type { TrustAnchor } from "../sync/freshness";
import { buildPairUrl, encryptPairingConfig, newPairSecret, PairingConfig } from "./pairing";
import { buildIssuedConfig, describeTrust, SERVER_PAIRING_V2 } from "./pairing-v2";

/** 发行端需要的本机信任状态（main 侧提供）。 */
export interface IssuerTrust {
	anchor: TrustAnchor | null;
	repoEpoch: string | undefined;
	bootstrapReady: boolean;
}

/**
 * 「添加新设备」弹窗（v8；v9.2 改为设备凭据流；0.20 指定仓库配对 v2）。
 *
 * 0.20 服务端（声明 pairing-v2-redeem）：为**当前仓库**申请一次性 grant（5 分钟，
 * 服务端以本设备凭据的归属绑定 user + vault），包内附上仓库名、账号与信任方式供
 * 新设备核对；新设备先看后兑换，响应丢失可续。旧服务端：保留原流程。
 * 两条路径都不把根 Token、本机凭据或仓库密码交给新设备。
 */
export class AddDeviceModal extends Modal {
	private pairingId: string | null = null;
	private v2 = false;
	private consumedOrRevoked = false;
	private timer: number | null = null;

	constructor(
		app: App,
		private client: ApiClient,
		private settings: PluginSettings,
		private trust: () => IssuerTrust,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("添加新设备");
		this.contentEl.createDiv({ text: "正在生成连接链接…", cls: "litesync-history-meta" });
		void this.createAndRender();
	}

	onClose(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		// 关闭即撤销未兑换的链接（新设备已兑换时服务器上本就没有了）
		if (this.pairingId && !this.consumedOrRevoked) {
			const id = this.pairingId;
			this.consumedOrRevoked = true;
			const revoke = this.v2 ? this.client.deletePairingV2(id) : this.client.deletePairing(id);
			void revoke.catch(() => undefined);
		}
	}

	private async createAndRender(): Promise<void> {
		const { contentEl } = this;
		try {
			const info = await this.client.info();
			if (hasCapability(info, SERVER_PAIRING_V2)) {
				await this.createV2();
			} else {
				await this.createLegacy();
			}
		} catch (e) {
			contentEl.empty();
			contentEl.createEl("p", {
				text: `生成连接链接失败：${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	/** v2：当前仓库的一次性 grant + 可核对的配对包。 */
	private async createV2(): Promise<void> {
		const vaults = await this.client.listVaults();
		const cur = vaults.find((v) => v.current);
		if (!cur) throw new Error("本设备尚未接入远端仓库，请先完成接入");
		const grant = await this.client.createPairingGrant(cur.id);
		const t = this.trust();
		const config = buildIssuedConfig({
			serverUrl: this.settings.serverUrl,
			enrollmentSecret: grant.enrollmentSecret,
			vault: { ...grant.vault, displayName: grant.vault.displayName || cur.name },
			accountLabel: grant.accountLabel,
			protocolVersion: PLUGIN_PROTOCOL_VERSION,
			sync: {
				syncIntervalSeconds: this.settings.syncIntervalSeconds,
				syncObsidian: this.settings.syncObsidian,
				ignorePatterns: this.settings.ignorePatterns,
			},
			anchor: t.bootstrapReady ? t.anchor : null,
			currentRepoEpoch: t.repoEpoch,
		});
		const secret = newPairSecret();
		const ciphertext = await encryptPairingConfig(secret, config);
		const { pairId, expiresAt } = await this.client.createPairingV2(grant.grantId, ciphertext);
		this.pairingId = pairId;
		this.v2 = true;
		const url = buildPairUrl(this.settings.serverUrl, pairId, secret);
		secret.fill(0);
		this.render(url, config, expiresAt || grant.expiresAt);
	}

	/** 旧服务端（< 0.20）：原有的 enrollment + 配对包流程。 */
	private async createLegacy(): Promise<void> {
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
		const { id, expiresAt } = await this.client.createPairing(ciphertext, 300);
		this.pairingId = id;
		const url = buildPairUrl(this.settings.serverUrl, id, secret);
		secret.fill(0);
		this.render(url, null, expiresAt);
	}

	private render(url: string, v2config: PairingConfig | null, expiresAt: number): void {
		const { contentEl } = this;
		contentEl.empty();
		if (v2config?.selectedVault) {
			const table = contentEl.createDiv({ cls: "litesync-confirm-table" });
			const row = (k: string, v: string): void => {
				table.createDiv({ text: k });
				table.createDiv({ text: v });
			};
			row("仓库", `「${v2config.selectedVault.displayName || "未命名仓库"}」`);
			if (v2config.accountLabel) row("账号", v2config.accountLabel);
			row("信任方式", describeTrust(v2config));
		}
		contentEl.createEl("p", {
			text: "在新设备上用系统相机扫码（或打开链接），按提示在 Obsidian 中核对仓库后连接。",
		});
		this.renderQr(contentEl, url);

		const input = contentEl.createEl("input", { type: "text", value: url, cls: "litesync-modal-input" });
		input.readOnly = true;
		input.onclick = () => input.select();
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: "复制链接", cls: "mod-cta" }).onclick = () => {
			void navigator.clipboard.writeText(url).then(() => new Notice("连接链接已复制"));
		};

		const ttlEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const expiresMs = expiresAt > 0 ? (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) : 0;
		const tick = (): void => {
			if (!expiresMs) {
				ttlEl.setText("链接很快过期、只能使用一次；关闭本窗口即作废。");
				return;
			}
			const left = Math.max(0, Math.round((expiresMs - Date.now()) / 1000));
			ttlEl.setText(
				left > 0
					? `链接 ${Math.floor(left / 60)} 分 ${left % 60} 秒后过期，只能使用一次；关闭本窗口即作废。`
					: "链接已过期：关闭窗口后重新生成。",
			);
		};
		tick();
		this.timer = window.setInterval(tick, 1000);

		contentEl.createDiv({
			cls: "litesync-history-meta",
			text:
				"安全提示：链接里只有一次性注册凭据（配置包已在本机加密，服务器只保存密文）。新设备会得到只能访问这个仓库的专属凭据，" +
				"可单独撤销；仓库密码不会随链接传输，需要在新设备上手动输入。",
		});
		if (!v2config) {
			contentEl.createDiv({
				cls: "litesync-history-meta",
				text: "服务器版本较旧：新设备导入时无法先核对目标仓库。升级服务器后可获得「先核对、后连接」与断网续传。",
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
