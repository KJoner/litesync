import { App, Notice, Platform, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { isLoopbackUrl } from "./api/client";
import type PrivateSyncPlugin from "./main";

export interface PluginSettings {
	serverUrl: string;
	apiToken: string;
	deviceName: string;
	autoSync: boolean;
	/** 定时 pull 间隔（秒），0 表示关闭定时器 */
	syncIntervalSeconds: number;
	syncObsidian: boolean;
	/** 每行一个 Glob 模式 */
	ignorePatterns: string;
	debug: boolean;
	/**
	 * 信任此设备：解锁后把 VMK 用随机设备密钥包装存入 SecretStorage，
	 * 之后启动自动解锁。E2EE 密码本身永远不持久化。
	 */
	trustDevice: boolean;
	/** 设备密钥（base64，拆分包装的一半；另一半在 SecretStorage） */
	deviceKeyB64: string;
	/**
	 * 实验功能：加密路径与文件名（v0.12.x 仍是 RC，LS-121-C01）。
	 * 关闭时「加密路径与文件名」命令直接拒绝执行。
	 */
	experimentalMetaEncryption: boolean;
	/**
	 * 开发开关：允许执行不可逆的明文路径抹除（meta complete）。
	 *
	 * v0.12.1 默认 **关闭**，且服务端也已拒绝这种 complete——当前实现无法在
	 * 抹除明文的同时保住删除屏障（tombstone 的 path 本身就是明文路径）。
	 * 正式抹除要等 v0.13.0 的隐私 tombstone ledger。
	 */
	allowIrreversibleMetaErase: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	serverUrl: "",
	apiToken: "", // 仅作旧版本 data.json 明文值的迁移来源；迁移后始终为空，真实值在 SecretStorage
	deviceName: "",
	autoSync: true,
	syncIntervalSeconds: 30,
	syncObsidian: false,
	ignorePatterns: ".trash/**\n.DS_Store\nThumbs.db",
	debug: false,
	trustDevice: true,
	deviceKeyB64: "",
	experimentalMetaEncryption: false,
	allowIrreversibleMetaErase: false,
};

/**
 * 设置页（1.13 声明式 API）：设置项可被 Obsidian 的设置搜索索引到。
 * 值的读写经 getControlValue / setControlValue 统一路由——
 * API Token 走 SecretStorage，trustDevice 走 setTrustDevice，其余进 data.json。
 */
export class SyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PrivateSyncPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const plugin = this.plugin;
		return [
			{
				type: "group",
				heading: "服务器",
				items: [
					{
						name: "Server URL",
						desc: createFragment((frag) => {
							frag.appendText("同步服务器地址，例如 https://sync.example.com。还没有服务器？");
							// 指向自建部署指南（插件绝不代替用户下载/运行服务器程序）
							frag.createEl("a", {
								text: "查看部署指南（litesync-server）",
								href: "https://github.com/KJoner/litesync-server",
							});
						}),
						control: { type: "text", key: "serverUrl", placeholder: "https://sync.example.com" },
					},
					{
						name: "API Token",
						desc: "与服务器 OBSYNC_TOKEN 一致（保存在 Obsidian SecretStorage，不进入 data.json）",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.type = "password";
								text
									.setPlaceholder("Token")
									.setValue(plugin.getApiToken())
									.onChange(async (value) => {
										await plugin.setApiToken(value.trim());
									});
							});
						},
					},
					{
						name: "测试连接",
						desc: "验证服务器地址与 Token 是否可用",
						action: (el) => {
							el.addClass("is-disabled");
							void plugin.testConnection().then((msg) => {
								new Notice(msg);
								el.removeClass("is-disabled");
							});
						},
					},
					{
						name: "设备名称",
						desc: "用于冲突文件命名和服务器日志，例如 MacBook",
						control: { type: "text", key: "deviceName", placeholder: "MacBook" },
					},
				],
			},
			{
				type: "group",
				heading: "同步",
				items: [
					{
						name: "自动同步",
						desc: "文件变化后自动同步（含定时拉取远端变更）",
						control: { type: "toggle", key: "autoSync" },
					},
					{
						name: "同步间隔",
						desc: Platform.isMobileApp
							? "定时拉取仅在 App 前台运行，移动端最低 60 秒（切回 App 时会自动补同步）"
							: "定时向服务器拉取其他设备产生的变更",
						control: {
							type: "dropdown",
							key: "syncIntervalSeconds",
							options: {
								"15": "15 秒",
								"30": "30 秒",
								"60": "60 秒",
								"120": "2 分钟",
								"300": "5 分钟",
								"0": "关闭定时同步",
							},
						},
					},
					{
						name: "同步 Obsidian 配置目录",
						desc: Platform.isMobileApp
							? "移动端始终不同步配置目录（桌面与移动配置差异大，避免互相覆盖）"
							: "同步 Obsidian 配置目录（workspace 和本插件目录永远不同步）",
						control: { type: "toggle", key: "syncObsidian" },
					},
					{
						name: "忽略规则",
						desc: "每行一个 Glob 模式；不含 / 的模式按文件名匹配",
						control: { type: "textarea", key: "ignorePatterns", rows: 4 },
					},
					{
						name: "立即同步",
						desc: "手动触发一次完整同步",
						action: () => void plugin.syncNow(),
					},
				],
			},
			{
				type: "group",
				heading: "设备与迁移",
				items: [
					{
						name: "添加新设备",
						desc: "生成一次性加密配对二维码/链接：新设备扫码即可自动导入服务器配置（E2EE 密码仍需手动输入）",
						action: () => plugin.openAddDeviceModal(),
					},
					{
						name: "导入配对链接",
						desc: "粘贴在其他设备上生成的配对链接，导入其服务器配置",
						action: () => plugin.openPasteLinkModal(),
					},
					{
						name: "重新运行接入向导",
						desc: "重新选择本设备与远端仓库的接入方式（从远端恢复 / 合并）",
						action: () => plugin.rerunBootstrapWizard(),
					},
				],
			},
			{
				type: "group",
				heading: "端到端加密 (E2EE)",
				items: [
					{
						name: "状态",
						aliases: ["E2EE", "端到端加密", "加密"],
						render: (setting) => {
							const status = plugin.e2eeStatusText();
							setting.setDesc(status.desc);
							setting.addButton((btn) =>
								btn.setButtonText(status.action).onClick(async () => {
									await plugin.e2eeAction();
									this.update(); // 状态与按钮文案随之刷新
								}),
							);
						},
					},
					{
						name: "信任此设备（保持解锁）",
						desc:
							"解锁后将 Vault Master Key 用随机设备密钥包装存入 Obsidian SecretStorage，" +
							"之后启动自动解锁。E2EE 密码本身永远不会被保存。",
						control: { type: "toggle", key: "trustDevice" },
					},
					{
						name: "忘记此设备",
						desc: "删除本设备保存的密钥包装并锁定；下次必须重新输入 E2EE 密码",
						visible: () => plugin.hasTrustedDevice(),
						action: () => {
							void plugin.forgetThisDevice().then(() => this.update());
						},
					},
				],
			},
			{
				type: "group",
				heading: "实验功能（RC，勿用于唯一真实 Vault）",
				items: [
					{
						name: "加密路径与文件名（实验）",
						desc: createFragment((frag) => {
							frag.appendText(
								"开启后才会出现「加密路径与文件名」命令。v0.12.x 仍是 RC：请只在测试 Vault 或已完整备份的副本上使用。",
							);
							frag.createEl("br");
							frag.appendText("· 迁移前的服务器备份中仍可能含有明文路径；");
							frag.createEl("br");
							frag.appendText("· 迁移完成后无法依赖普通回滚恢复真实路径；");
							frag.createEl("br");
							frag.appendText("· 所有设备都必须升级到 0.12+，旧版本无法读取此仓库。");
						}),
						control: { type: "toggle", key: "experimentalMetaEncryption" },
					},
					{
						name: "允许不可逆的明文路径抹除（开发者）",
						desc:
							"v0.12.1 默认关闭，且服务端同样拒绝执行：当前实现无法在抹除明文路径的同时保住删除屏障。" +
							"迁移会停在「已伪名化但未抹除」的可回退状态，正式抹除请等待 v0.13.0 的隐私 tombstone ledger。",
						visible: () => plugin.settings.experimentalMetaEncryption,
						control: { type: "toggle", key: "allowIrreversibleMetaErase" },
					},
					{
						name: "放弃路径加密迁移",
						desc: "把仓库的元数据状态从 migrating 退回 plain；已伪名化的文件保持可用，不做任何破坏性操作",
						visible: () => plugin.metaMigrationActive(),
						action: () => void plugin.abortMetaMigration(),
					},
				],
			},
			{
				type: "group",
				heading: "调试",
				items: [
					{
						name: "Debug 日志",
						desc: "在开发者控制台输出同步日志",
						control: { type: "toggle", key: "debug" },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === "syncIntervalSeconds") return String(this.plugin.settings.syncIntervalSeconds);
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		switch (key) {
			case "serverUrl": {
				const url = String(value).trim();
				const changed = this.plugin.settings.serverUrl !== url;
				settings[key] = url;
				// 换服务器 = 本地状态未必还属于对面那个仓库（LS-121-C02）：
				// 立即切 unbound，重新完成权威校验前禁止任何写操作
				if (changed) this.plugin.invalidateBinding("Server URL 已变化");
				// 即时提示（v9.2）：非本机的 http:// 会在同步时被硬性拒绝（Token 明文暴露）
				if (/^http:\/\//i.test(url) && !isLoopbackUrl(url)) {
					new Notice("注意：非本机地址必须使用 https://，当前 http:// 配置将无法同步", 8000);
				}
				break;
			}
			case "deviceName":
				settings[key] = String(value).trim();
				break;
			case "syncIntervalSeconds":
				this.plugin.settings.syncIntervalSeconds = parseInt(String(value), 10) || 0;
				break;
			case "trustDevice":
				// 自带保存逻辑（写 SecretStorage / 删除信任），并影响「忘记此设备」的可见性
				await this.plugin.setTrustDevice(value === true);
				this.update();
				return;
			default:
				settings[key] = value;
		}
		await this.plugin.saveSettings();
		this.plugin.applySettings();
	}
}
