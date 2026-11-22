import { App, Modal, Notice, ObsidianProtocolData } from "obsidian";
import { clientPlatform, PLUGIN_VERSION } from "../api/client";
import type PrivateSyncPlugin from "../main";
import { isLoopbackHost, PairingConfig, parsePairUrl } from "./pairing";
import {
	anchorFromConfig,
	clearPendingRedeem,
	describeTrust,
	loadPendingRedeem,
	openLegacyLink,
	openPairingLink,
	PairingLink,
	PendingRedeem,
	REDEEM_REPLAY_WINDOW_MS,
	redeemErrorText,
	redeemPairing,
	RedeemOutcome,
} from "./pairing-v2";

/**
 * obsidian://litesync-import 处理器（v8 新设备导入；0.20 改为「先核对、后兑换」）。
 *
 * 新服务器：取 envelope（不消费）→ 本地解密 → 展示服务器/账号/仓库 → 用户确认 → 兑换
 * （exchangeId 先落盘，断网可续）→ 写配置 → 进入接入向导（解锁 → 首次同步方式）。
 * 旧服务器：只能先确认服务器，再消费 + 注册；界面明说「无法在导入前核对仓库」。
 * 仓库密码从不随链接传输，始终由用户在本设备输入。
 */
export function registerImportHandler(plugin: PrivateSyncPlugin): void {
	plugin.registerObsidianProtocolHandler("litesync-import", (params: ObsidianProtocolData) => {
		void handleImportParams(plugin, params.server, params.id, params.secret);
	});
}

function normalizeServer(server: string): string | null {
	try {
		const u = new URL(server.trim());
		if (u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname))) return u.origin;
		return null;
	} catch {
		return null;
	}
}

/** 设置页「粘贴连接链接」与深链共用的导入入口。 */
export async function handleImportParams(
	plugin: PrivateSyncPlugin,
	server: string | undefined,
	id: string | undefined,
	secretB64url: string | undefined,
): Promise<void> {
	const serverUrl = server ? normalizeServer(server) : null;
	if (!serverUrl || !id || !secretB64url) {
		new Notice("连接链接不完整、已损坏，或不是 https:// 地址。请在网页或原设备上重新生成。");
		return;
	}
	const link: PairingLink = { serverUrl, id, secretB64url };
	const transport = plugin.pairingTransport();
	let opened;
	try {
		opened = await openPairingLink(transport, link);
	} catch (e) {
		new Notice(`无法连接服务器：${e instanceof Error ? e.message : String(e)}`);
		return;
	}
	switch (opened.kind) {
		case "ready":
			if (opened.config.v === 1) {
				if (await confirmV1(plugin.app, serverUrl)) await applyLegacyConfig(plugin, opened.config, null);
				return;
			}
			new ImportConfirmModal(plugin, link, opened.config, opened.expiresAt).open();
			return;
		case "legacy-server":
			await importFromLegacyServer(plugin, link);
			return;
		case "gone":
			// 旧接口发行、新服务器读不到 envelope 的包：消费路径仍可能可用（不存在时同样 404，无副作用）
			if (opened.code === "NOT_FOUND") {
				await importFromLegacyServer(plugin, link);
				return;
			}
			new Notice(redeemErrorText(opened.code));
			return;
		case "invalid":
			new Notice(opened.reason, 10000);
			return;
	}
}

/** 旧服务器：确认服务器 → 消费 → 解密 → 注册（无法事先核对仓库，界面明说）。 */
async function importFromLegacyServer(plugin: PrivateSyncPlugin, link: PairingLink): Promise<void> {
	const ok = await confirmLegacyServer(plugin.app, link.serverUrl);
	if (!ok) return;
	try {
		const r = await openLegacyLink(plugin.pairingTransport(), link);
		if (r.kind === "gone") {
			new Notice("连接链接不存在、已过期或已被使用，请重新生成");
			return;
		}
		if (r.kind === "invalid") {
			new Notice(r.reason, 10000);
			return;
		}
		if (r.config.v === 1) {
			if (await confirmV1(plugin.app, link.serverUrl)) await applyLegacyConfig(plugin, r.config, null);
			return;
		}
		const cred = await plugin
			.pairingTransport()
			.enrollLegacy(link.serverUrl, r.config.enrollmentSecret!, plugin.deviceNameForEnrollment());
		await applyLegacyConfig(plugin, r.config, cred.deviceToken);
	} catch (e) {
		new Notice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
	}
}

/** 写入旧格式配置（v1 长期 Token 或旧服务器上的 v2 注册结果）。 */
async function applyLegacyConfig(plugin: PrivateSyncPlugin, config: PairingConfig, deviceToken: string | null): Promise<void> {
	const token = deviceToken ?? config.apiToken;
	if (!token) {
		new Notice("配对包缺少凭据字段");
		return;
	}
	await plugin.applyPairingConfig(config, token, null);
	new Notice("已导入 LiteSync 配置 ✓ 接下来完成本设备接入");
	plugin.openBootstrapWizard();
}

/** 兑换成功后写配置并进入向导。 */
async function finishRedeem(plugin: PrivateSyncPlugin, outcome: Extract<RedeemOutcome, { kind: "ok" }>): Promise<void> {
	await plugin.applyPairingConfig(outcome.config, outcome.credential, {
		vaultId: outcome.vaultId,
		vaultIdentity: outcome.vaultIdentity ?? outcome.config.selectedVault?.vaultIdentity ?? "",
		anchor: anchorFromConfig(outcome.config),
	});
	clearPendingRedeem(plugin.app.secretStorage);
	new Notice("设备已连接 ✓ 接下来输入仓库密码并选择首次同步方式");
	plugin.openBootstrapWizard();
}

function minutesLeft(expiresAt: number, now: number): string {
	if (!expiresAt) return "很快过期";
	const ms = (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) - now;
	if (ms <= 0) return "已过期";
	const m = Math.ceil(ms / 60000);
	return `约 ${m} 分钟内有效`;
}

/** 导入核对：服务器 / 账号 / 仓库 / 信任方式；确认之前什么都不消费、不写入。 */
class ImportConfirmModal extends Modal {
	private busy = false;

	constructor(
		private plugin: PrivateSyncPlugin,
		private link: PairingLink,
		private config: PairingConfig,
		private expiresAt: number,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.setText("核对连接信息");
		const { contentEl } = this;
		const vault = this.config.selectedVault;
		contentEl.createEl("p", { text: "请确认这是你要连接的仓库：" });
		const table = contentEl.createDiv({ cls: "litesync-confirm-table" });
		const row = (k: string, v: string): void => {
			table.createDiv({ text: k });
			table.createDiv({ text: v });
		};
		row("服务器", this.link.serverUrl);
		row("账号", this.config.accountLabel || "（未提供）");
		row("仓库", vault ? `「${vault.displayName || "未命名仓库"}」（${vault.vaultId}）` : "（未提供）");
		row("信任方式", describeTrust(this.config));
		row("有效期", minutesLeft(this.expiresAt, Date.now()));

		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text:
				"确认后，服务器会为本设备签发只能访问这个仓库的专属凭据；链接里没有仓库密码与长期 Token，" +
				"下一步需要你在本设备输入这个仓库的密码。只在这是你自己刚生成的链接时继续。",
		});
		if (this.plugin.configured) {
			contentEl.createEl("p", {
				cls: "litesync-history-meta",
				text:
					"本 Obsidian 库当前已连接到一个仓库：继续会暂停原来的同步并改连到上面这个仓库" +
					"（本地笔记保留，旧的同步记录作废，随后重新选择首次同步方式）。",
			});
		}
		const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "确认并连接", cls: "mod-cta" });
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		btn.onclick = () => void this.redeem(btn, errEl);
	}

	private async redeem(btn: HTMLButtonElement, errEl: HTMLElement): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		btn.disabled = true;
		btn.setText("连接中…");
		try {
			const outcome = await redeemPairing(this.plugin.pairingTransport(), this.plugin.app.secretStorage, {
				link: this.link,
				config: this.config,
				deviceName: this.plugin.deviceNameForEnrollment(),
				platform: clientPlatform(),
				clientVersion: PLUGIN_VERSION,
				now: Date.now(),
			});
			if (outcome.kind === "ok") {
				this.close();
				await finishRedeem(this.plugin, outcome);
				return;
			}
			if (outcome.kind === "retry") {
				errEl.setText(
					`网络中断（${outcome.message}）。可以重试：会使用同一个兑换编号，服务器若已签发凭据会原样返回，不会重复创建设备。`,
				);
				btn.setText("重试");
				return;
			}
			errEl.setText(outcome.message);
			btn.setText("确认并连接");
		} catch (e) {
			errEl.setText(`连接失败：${e instanceof Error ? e.message : String(e)}`);
			btn.setText("重试");
		} finally {
			this.busy = false;
			btn.disabled = false;
		}
	}
}

/**
 * 启动时发现上次兑换没收到响应（断网/崩溃）：在服务端保留窗口内用同一个 exchangeId 续传，
 * 拿回同一份凭据；超过窗口就作废并提示重新生成。
 */
export async function resumePendingRedeem(plugin: PrivateSyncPlugin): Promise<void> {
	const pending = loadPendingRedeem(plugin.app.secretStorage);
	if (!pending) return;
	if (Date.now() - pending.startedAt > REDEEM_REPLAY_WINDOW_MS) {
		clearPendingRedeem(plugin.app.secretStorage);
		new Notice("上次未完成的设备连接已超过 10 分钟，已作废。请在网页或原设备上重新生成连接链接。", 10000);
		return;
	}
	new ResumeRedeemModal(plugin, pending).open();
}

class ResumeRedeemModal extends Modal {
	private busy = false;

	constructor(
		private plugin: PrivateSyncPlugin,
		private pending: PendingRedeem,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.setText("继续完成设备连接");
		const { contentEl } = this;
		const vault = this.pending.config.selectedVault;
		contentEl.createEl("p", {
			text:
				`上次连接${vault ? `「${vault.displayName || vault.vaultId}」` : "仓库"}时没有收到服务器的响应。` +
				"服务器可能已经为本设备签发了凭据：用同一个兑换编号继续即可取回，不会重复创建设备。",
		});
		const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "继续", cls: "mod-cta" });
		footer.createEl("button", { text: "放弃" }).onclick = () => {
			clearPendingRedeem(this.plugin.app.secretStorage);
			this.close();
		};
		btn.onclick = () => {
			if (this.busy) return;
			this.busy = true;
			btn.disabled = true;
			void (async () => {
				try {
					const link: PairingLink = { serverUrl: this.pending.serverUrl, id: this.pending.pairId, secretB64url: "" };
					const outcome = await redeemPairing(this.plugin.pairingTransport(), this.plugin.app.secretStorage, {
						link,
						config: this.pending.config,
						deviceName: this.pending.deviceName,
						platform: clientPlatform(),
						clientVersion: PLUGIN_VERSION,
						now: Date.now(),
					});
					if (outcome.kind === "ok") {
						this.close();
						await finishRedeem(this.plugin, outcome);
						return;
					}
					errEl.setText(outcome.kind === "retry" ? `仍然无法连接服务器（${outcome.message}），稍后再试。` : outcome.message);
					if (outcome.kind === "failed") btn.remove();
				} finally {
					this.busy = false;
					btn.disabled = false;
				}
			})();
		};
	}
}

/** 设置页「粘贴连接链接」：手动粘贴 https://server/p/{id}#secret=… */
export class PasteLinkModal extends Modal {
	constructor(
		app: App,
		private plugin: PrivateSyncPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("粘贴连接链接");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "粘贴在 LiteSync 网页「连接 Obsidian」或另一台设备「连接新设备」中得到的连接链接：",
		});
		const input = contentEl.createEl("input", {
			type: "text",
			cls: "litesync-modal-input",
			placeholder: "https://sync.example.com/p/…#secret=…",
		});
		input.setAttribute("autocomplete", "off");
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text:
				"手机上：用系统相机扫码打开网页，再点「在 Obsidian 中打开」。点了没有反应时，确认已在 Obsidian 设置 → 第三方插件 中" +
				"安装并启用 LiteSync，或者复制完整链接粘贴到这里。链接很快过期且只能用一次，过期请重新生成。",
		});
		const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const submit = (): void => {
			const parsed = parsePairUrl(input.value);
			if (!parsed) {
				errEl.setText("链接格式不正确（需要包含 /p/{id}#secret=… 的完整 https:// 链接）");
				return;
			}
			this.close();
			void handleImportParams(this.plugin, parsed.serverUrl, parsed.id, parsed.secretB64url);
		};
		footer.createEl("button", { text: "继续", cls: "mod-cta" }).onclick = submit;
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				input.blur();
				submit();
			}
		});
		window.setTimeout(() => input.focus(), 50);
	}
}

function confirmLegacyServer(app: App, server: string): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmChoiceModal(
			app,
			"导入 LiteSync 配置",
			[
				"将从以下服务器导入同步配置：",
				server,
				"这台服务器的版本较旧：无法在导入之前展示和核对目标仓库，链接会在你点「导入」时被使用掉。" +
					"只有当这是你自己刚生成的链接时才继续。当前设备的服务器配置将被替换。",
			],
			"导入",
			resolve,
		).open();
	});
}

function confirmV1(app: App, server: string): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmChoiceModal(
			app,
			"旧版配对包（受限兼容导入）",
			[
				`这是旧版本插件生成的配对包，里面含有来自 ${server} 的长期账户 Token。`,
				"新版本不再生成这种包：长期 Token 一旦随链接泄露就一直有效。只在你确认链接来自你自己的设备、且未被转发过时继续；" +
					"导入后首轮同步会自动换成本设备专属凭据。建议改用网页或新版插件重新生成连接链接。",
			],
			"我了解风险，导入",
			resolve,
		).open();
	});
}

class ConfirmChoiceModal extends Modal {
	private decided = false;

	constructor(
		app: App,
		private title: string,
		private paragraphs: string[],
		private okText: string,
		private resolve: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		const { contentEl } = this;
		this.paragraphs.forEach((p, i) => {
			const el = contentEl.createEl("p", i === 0 ? {} : { cls: i === 1 ? "" : "litesync-history-meta" });
			if (i === 1) el.createEl("strong", { text: p });
			else el.setText(p);
		});
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: this.okText, cls: "mod-cta" }).onclick = () => {
			this.decided = true;
			this.close();
			this.resolve(true);
		};
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
	}

	onClose(): void {
		if (!this.decided) this.resolve(false);
	}
}
