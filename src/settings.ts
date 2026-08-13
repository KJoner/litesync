import { App, Notice, Platform, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { isLoopbackUrl } from "./api/client";
import type PrivateSyncPlugin from "./main";
import {
	DEFAULT_BATCH_SECONDS,
	DEFAULT_MTIME_GRANULARITY_SECONDS,
	timingDisclosure,
} from "./utils/timing";

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
	 * 默认 **关闭**：迁移停在「已伪名化但未抹除」的可回退状态。
	 *
	 * 开启后 complete 会真正覆写数据库、WAL 与 blob 中残留的明文路径，
	 * 并用哨兵扫描验证覆写确实生效（ADR-008 §3.2）——这一步**不可逆**。
	 *
	 * 曾经这个开关是死的：v0.12.1 时服务端一律拒绝，因为当时抹除明文会连带
	 * 毁掉删除屏障（tombstone 的 path 本身就是明文路径）。隐私 tombstone
	 * ledger 在 v0.13.0 落地后这个矛盾消失了，删除屏障在抹除后完整保留。
	 */
	allowIrreversibleMetaErase: boolean;
	/**
	 * 大小混淆（v0.17 / 计划书 §11.1）：把密文填充到桶边界，
	 * 让服务器只看得到大小区间而不是精确字节数。
	 *
	 * 默认关闭。开启后单个对象最坏多占 12.5%，且小于 4KB 的对象一律按 4KB 计——
	 * 替用户默默多花这些空间不是我们该做的决定，所以要他自己开。
	 */
	padObjectSizes: boolean;
	/**
	 * 只对这些路径前缀做填充（每行一个）；留空表示对全部文件生效。
	 *
	 * §11.1 说的是「高敏对象」：多数人只有一小部分笔记值得为它多花空间，
	 * 而全库填充的成本会让人干脆把整个功能关掉。
	 */
	padPathPrefixes: string;
	/**
	 * 时间混淆（v0.17 / 计划书 §11.2）：把上传对齐到窗口网格并加抖动，
	 * 同时量化上报的文件修改时间。
	 *
	 * 默认关闭。开启后同步会被推迟最多一个窗口——这不是「稍微慢一点」：
	 * 跨设备可见延迟与冲突窗口都会随之变长。
	 */
	obfuscateTiming: boolean;
	/** 批处理窗口（秒）。低于 30 秒起不到混淆作用，只是白白延迟。 */
	timingBatchSeconds: number;
	/** 上报 mtime 的量化粒度（秒）；0 表示不量化。 */
	mtimeGranularitySeconds: number;
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
	padObjectSizes: false,
	padPathPrefixes: "",
	obfuscateTiming: false,
	timingBatchSeconds: DEFAULT_BATCH_SECONDS,
	mtimeGranularitySeconds: DEFAULT_MTIME_GRANULARITY_SECONDS,
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
								"开启后才会出现「加密路径与文件名」命令。请只在测试 Vault 或已完整备份的副本上使用。",
							);
							frag.createEl("br");
							frag.appendText("· 迁移前的服务器备份中仍含有明文路径——那既是回滚窗口，也是明文的最后残留处；");
							frag.createEl("br");
							frag.appendText("· 迁移到 verifying 之前随时可以无损放弃；complete 并抹除之后不可回滚；");
							frag.createEl("br");
							frag.appendText("· 所有设备都必须先升级，旧版本读不了伪名寻址的仓库。");
							frag.createEl("br");
							frag.appendText("· 动手前请先在服务器上执行 obsync migration preflight，它会检查有没有设备还没升级。");
						}),
						control: { type: "toggle", key: "experimentalMetaEncryption" },
					},
					{
						name: "允许不可逆的明文路径抹除（开发者）",
						desc:
							"默认关闭。关闭时迁移会停在「已伪名化但未抹除」的**可回退**状态——" +
							"这是绝大多数情况下你想要的。开启后 complete 会真正覆写数据库、WAL 与 blob 中残留的明文路径，" +
							"并用哨兵扫描验证覆写生效；这一步**不可逆**，此后只能依靠迁移前的备份恢复。" +
							"隐私 tombstone ledger 已在 v0.13.0 落地，删除屏障在抹除后仍然完整保留。",
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
				heading: "隐私增强",
				items: [
					{
						name: "混淆文件大小",
						desc: createFragment((frag) => {
							frag.appendText(
								"把密文填充到桶边界，服务器只看得到大小区间而不是精确字节数。" +
									"精确大小本身就是内容：已知文档的字节数命中即确认，同一文件的大小序列画出的是编辑节奏。",
							);
							frag.createEl("br");
							frag.appendText("· 成本：单个对象最坏多占 12.5%；小于 4KB 的对象一律按 4KB 计；");
							frag.createEl("br");
							frag.appendText("· 只影响开启之后新写入的内容，已有文件在下次修改时才会被填充；");
							frag.createEl("br");
							frag.appendText("· 仓库内去重不受影响（填充在密文内部，同样的内容仍得到同样的密文）。");
						}),
						control: { type: "toggle", key: "padObjectSizes" },
					},
					{
						name: "混淆同步时机",
						desc: createFragment((frag) => {
							frag.appendText(
								"把上传对齐到时间窗口并加随机抖动，服务器只能判断编辑发生在哪个窗口里，" +
									"而不是精确到秒。请求节奏本身就是一份打字记录：作息、时区、" +
									"工作日与假期、此刻是否醒着，都能从中推断。",
							);
							frag.createEl("br");
							frag.appendText(
								timingDisclosure(
									plugin.settings.timingBatchSeconds,
									plugin.settings.mtimeGranularitySeconds,
								),
							);
							frag.createEl("br");
							frag.appendText("·「立即同步」命令不受影响，用户显式要求的动作不会被推迟。");
						}),
						control: { type: "toggle", key: "obfuscateTiming" },
					},
					{
						name: "只填充这些路径（每行一个前缀）",
						desc: "留空表示对全部文件生效。多数人只有一小部分笔记值得为它多花空间。",
						visible: () => plugin.settings.padObjectSizes,
						control: { type: "textarea", key: "padPathPrefixes" },
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
