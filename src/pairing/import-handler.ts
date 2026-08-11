import { App, Modal, Notice, ObsidianProtocolData } from "obsidian";
import type PrivateSyncPlugin from "../main";
import {
	b64urlDecode,
	consumePairing,
	decryptPairingConfig,
	isLoopbackHost,
	PairingConfig,
	parsePairUrl,
} from "./pairing";

/**
 * obsidian://litesync-import 处理器（v8 新设备导入）。
 * 落地页 / 配对链接 → Obsidian 深链 → 确认 → 消费配对包 → 本地解密 →
 * 写入配置（Token 进 SecretStorage）→ 进入接入向导。E2EE 密码手动输入。
 */
export function registerImportHandler(plugin: PrivateSyncPlugin): void {
	plugin.registerObsidianProtocolHandler("litesync-import", (params: ObsidianProtocolData) => {
		void handleImportParams(plugin, params.server, params.id, params.secret);
	});
}

/** 设置页「导入配对链接」与深链共用的导入入口。 */
export async function handleImportParams(
	plugin: PrivateSyncPlugin,
	server: string | undefined,
	id: string | undefined,
	secretB64url: string | undefined,
): Promise<void> {
	if (!server || !id || !secretB64url || !/^https?:\/\//i.test(server)) {
		new Notice("配对链接不完整或已损坏，请在原设备上重新生成");
		return;
	}
	// 防钓鱼确认：明确告诉用户配置来自哪个服务器，由用户拍板
	const ok = await confirmImport(plugin.app, server);
	if (!ok) return;

	try {
		const ciphertext = await consumePairing(server, id);
		if (ciphertext === null) {
			new Notice("配对包不存在、已过期或已被使用，请在原设备上重新生成");
			return;
		}
		const secret = b64urlDecode(secretB64url);
		const config = await decryptPairingConfig(secret, ciphertext);
		secret.fill(0);
		if (config === null) {
			new Notice("配对包解密失败（密钥不符或数据被篡改）");
			return;
		}
		await applyPairingConfig(plugin, config);
		new Notice("已导入 LiteSync 配置 ✓ 接下来完成本设备接入");
		plugin.openBootstrapWizard();
	} catch (e) {
		new Notice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
	}
}

async function applyPairingConfig(plugin: PrivateSyncPlugin, config: PairingConfig): Promise<void> {
	const url = config.serverUrl.trim().replace(/\/+$/, "");
	// 安全红线（v9）：配对包携带 Token，非 loopback 的 http:// 配置一律拒绝导入
	if (/^http:\/\//i.test(url) && !isLoopbackHost(new URL(url).hostname)) {
		throw new Error("配对配置中的 Server URL 使用了非本机的 http:// 地址，已拒绝导入（Token 会被明文暴露）");
	}
	plugin.settings.serverUrl = url;
	if (typeof config.syncIntervalSeconds === "number") {
		plugin.settings.syncIntervalSeconds = config.syncIntervalSeconds;
	}
	if (typeof config.syncObsidian === "boolean") plugin.settings.syncObsidian = config.syncObsidian;
	if (typeof config.ignorePatterns === "string") plugin.settings.ignorePatterns = config.ignorePatterns;
	await plugin.setApiToken(config.apiToken);
	await plugin.saveSettings();
	plugin.applySettings();
	// 换了服务器 = 新的接入关系：重置为待接入
	plugin.resetBootstrapState();
}

/** 设置页「导入配对链接」：手动粘贴 https://server/p/{id}#secret=… */
export class PasteLinkModal extends Modal {
	constructor(
		app: App,
		private plugin: PrivateSyncPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("导入配对链接");
		const { contentEl } = this;
		contentEl.createEl("p", { text: "粘贴在原设备「添加新设备」中生成的配对链接：" });
		const input = contentEl.createEl("input", {
			type: "text",
			cls: "litesync-modal-input",
			placeholder: "https://sync.example.com/p/…#secret=…",
		});
		const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const submit = (): void => {
			const parsed = parsePairUrl(input.value);
			if (!parsed) {
				errEl.setText("链接格式不正确（需要包含 /p/{id}#secret=… 的完整链接）");
				return;
			}
			this.close();
			void handleImportParams(this.plugin, parsed.serverUrl, parsed.id, parsed.secretB64url);
		};
		footer.createEl("button", { text: "导入", cls: "mod-cta" }).onclick = submit;
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		window.setTimeout(() => input.focus(), 50);
	}
}

function confirmImport(app: App, server: string): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmImportModal(app, server, resolve).open();
	});
}

class ConfirmImportModal extends Modal {
	private decided = false;

	constructor(
		app: App,
		private server: string,
		private resolve: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("导入 LiteSync 配置");
		const { contentEl } = this;
		contentEl.createEl("p", { text: "将从以下服务器导入同步配置（Server URL、API Token 与同步设置）：" });
		contentEl.createEl("p").createEl("strong", { text: this.server });
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text: "只有当这是你自己在其他设备上生成的配对链接时才继续。当前设备的服务器配置将被替换。",
		});
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: "导入", cls: "mod-cta" }).onclick = () => {
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
