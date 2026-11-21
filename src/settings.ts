import { App, debounce, Modal, Notice, Platform, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import type { Setting } from "obsidian";
import { ApiError, isLoopbackUrl } from "./api/client";
import { TokenPromptModal } from "./token-prompt-modal";
import type PrivateSyncPlugin from "./main";
import type { TrustMigrationRecord } from "./crypto/trust-migration";
import { summarizeStatus } from "./status-summary";
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
	/**
	 * 目标仓库选择（v0.19 单用户多仓库）：一个 Token 名下可以有多个远端仓库，
	 * 这里记录本 Obsidian 库绑定的那一个（vault_id；空 = 该用户的默认仓库）。
	 * 只在接入向导里改变——切换仓库 = 重新接入（作废本地同步账本）。
	 */
	vaultChoice: string;
	debug: boolean;
	/**
	 * 可恢复密钥持久化（旧称「信任此设备」）：解锁后把 VMK 用随机设备密钥包装存入
	 * SecretStorage，之后启动自动解锁。仓库密码本身永远不持久化。
	 *
	 * 0.20 起默认**关闭**（严格会话解锁，ADR-013）。旧版本默认开启遗留下来的材料
	 * 由 trustMigration 状态机处理：先证明能用密码恢复同一把 VMK，再清理。
	 */
	trustDevice: boolean;
	/** 设备密钥（base64，拆分包装的一半；另一半在 SecretStorage） */
	deviceKeyB64: string;
	/**
	 * 密钥策略版本（0.20）：缺失 = 旧版本写下的 data.json，加载时执行一次策略迁移。
	 * 刻意**不放进 DEFAULT_SETTINGS**——否则旧设置合并默认值后会被误判为已迁移。
	 */
	keyPolicyVersion?: number;
	/** 旧「信任此设备」的迁移进度（ADR-013 状态机；null = 无需迁移） */
	trustMigration?: TrustMigrationRecord | null;
	/**
	 * 实验功能：加密路径与文件名（v0.12.x 仍是 RC，LS-121-C01）。
	 * 关闭时「加密路径与文件名」命令直接拒绝执行。
	 */
	experimentalMetaEncryption: boolean;
	/**
	 * 「用本地完整替换远端」的执行入口（0.20.1 阶段保护，复审 PL-02～PL-05）。
	 *
	 * 默认**关闭**：这个破坏性作业仍处于验收阶段。关闭时只读差异预览照常可用，
	 * 已经开始的作业照常可以诊断、放弃、回滚（反向作业是恢复方向，不受开关限制）；
	 * 只有「确认执行新作业 / 续跑正向作业」需要用户在高级区显式开启。
	 * 是否恢复默认开放由真实服务端联调与真机验收的结论决定，不在代码里擅自打开。
	 */
	replaceRemoteEnabled: boolean;
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
	vaultChoice: "",
	debug: false,
	// 0.20：新安装默认严格会话解锁（ADR-013）
	trustDevice: false,
	deviceKeyB64: "",
	experimentalMetaEncryption: false,
	// 0.20.1 阶段保护：完整替换远端的执行入口默认关闭（验收阶段）
	replaceRemoteEnabled: false,
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
	/** 状态卡这一项（每次渲染时记下）：插件状态变化时就地重绘它，不碰页面上的其他控件。 */
	private statusCard: Setting | null = null;
	/** 最近一次取设置定义时的页面结构签名（见 shape()）；变了就要整页重绘。 */
	private renderedShape: string | null = null;
	/** 用户正在设置页的输入框里输入时推迟的整页重绘：焦点离开输入框后补上。 */
	private rebuildDeferred = false;
	private stateChangeScheduled = false;

	constructor(
		app: App,
		private plugin: PrivateSyncPlugin,
	) {
		super(app, plugin);
	}

	/** 供 plugin 在弹窗操作成功后调用：重渲染设置页以反映新状态（基类 update 非公开）。 */
	refresh(): void {
		this.update();
	}

	/**
	 * 插件状态变了（同步轮次、连接 / 改连、接入完成、锁定 / 解锁、凭据被拒…）：让打开着的设置页立刻反映。
	 *
	 * 以前只有少数弹窗的成功回调会刷新设置页，「粘贴连接链接 → 兑换 → 接入向导」这条路径一次都没刷新：
	 * 连接早已成功，设置页还显示「尚未连接」，离开再进来才变（iPhone 真机验收反馈）。
	 * 现在 plugin.updateStatus 每次都调用这里——状态变化只有这一个出口，新加的流程不会再漏。
	 *
	 * - 页面结构没变：只就地重绘状态卡，不碰其他控件（正在输入也不受影响）；
	 * - 结构变了（未连接 ↔ 已连接、接入完成、加密状态变化…）：整页重绘；但用户正在设置页的输入框里
	 *   输入时推迟到焦点离开——整页重绘会销毁那个输入框，打断软键盘与中文输入法。
	 * 合并到下一个事件循环再做：同一操作里的连续状态变化只重绘一次，也让调用方先把字段写完。
	 */
	stateChanged(): void {
		if (this.stateChangeScheduled) return;
		this.stateChangeScheduled = true;
		window.setTimeout(() => {
			this.stateChangeScheduled = false;
			this.applyStateChange();
		}, 0);
	}

	private applyStateChange(): void {
		if (this.shape() !== this.renderedShape) {
			if (this.editingInSettings()) {
				this.deferRebuild();
				return;
			}
			// 重新取定义；Obsidian 只在本页正显示时重绘当前页（含「高级」子页面），并保留滚动位置
			this.update();
			return;
		}
		this.refreshStatusCard();
	}

	/**
	 * 决定页面结构的那些状态：哪些设置项可见、各 render 项显示什么。
	 * 只是同步时间、冲突数、同步中这类变化不改结构，状态卡就地重绘就够了。
	 */
	private shape(): string {
		const p = this.plugin;
		return JSON.stringify([
			p.configured,
			p.bootstrapReady,
			p.e2eeStatusText().action,
			p.keyPolicyText(),
			p.trustMigrationPending(),
			p.hasTrustedDevice(),
			p.metaMigrationActive(),
			p.replaceJobNeedsAttention(),
		]);
	}

	/** 焦点是否在设置窗口（含「高级」子页面）的可编辑控件里；向导、解锁窗口里的输入不受设置页重绘影响。 */
	private editingInSettings(): boolean {
		const el = this.containerEl.ownerDocument?.activeElement as HTMLElement | null | undefined;
		if (!el) return false;
		const tag = el.tagName;
		const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
		if (!editable) return false;
		if (this.containerEl.contains(el) || el.closest?.(".mod-settings") != null) return true;
		// 子页面（「高级」）不一定挂在本标签页的容器里：同一个设置窗口里的输入框都算
		const settingsWindow = this.containerEl.closest?.(".modal");
		return settingsWindow != null && settingsWindow.contains(el);
	}

	private deferRebuild(): void {
		if (this.rebuildDeferred) return;
		this.rebuildDeferred = true;
		const doc = this.containerEl.ownerDocument;
		const onFocusOut = (): void => {
			// focusout 时新焦点还没落定：下一轮再看；移到了另一个输入框就继续等
			window.setTimeout(() => {
				if (!this.rebuildDeferred || this.editingInSettings()) return;
				doc.removeEventListener("focusout", onFocusOut, true);
				this.rebuildDeferred = false;
				this.stateChanged();
			}, 0);
		};
		doc.addEventListener("focusout", onFocusOut, true);
	}

	/** 就地重绘状态卡；设置页没显示（或在子页面）时它不在文档里，下次渲染自然是新的。 */
	private refreshStatusCard(): void {
		const card = this.statusCard;
		if (!card || !card.settingEl.isConnected) return;
		card.clear(); // 清掉按钮；说明由 setDesc 整体替换
		this.renderStatusCard(card);
	}

	private renderStatusCard(setting: Setting): void {
		const plugin = this.plugin;
		this.statusCard = setting;
		const summary = summarizeStatus(plugin.statusInput());
		setting.setDesc(
			createFragment((frag) => {
				for (const line of summary.lines) {
					const row = frag.createDiv({ cls: `litesync-status-line is-${line.tone}` });
					row.createSpan({ cls: "litesync-status-label", text: `${line.label}：` });
					row.createSpan({ text: line.value });
				}
			}),
		);
		for (const s of summary.secondary) {
			setting.addButton((btn) => btn.setButtonText(s.label).onClick(() => plugin.runSecondaryAction(s.kind)));
		}
		setting.addButton((btn) =>
			btn
				.setButtonText(summary.primary.label)
				.setCta()
				.setDisabled(summary.primary.label === "同步中…")
				.onClick(() => plugin.runPrimaryAction(summary.primary.kind)),
		);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const plugin = this.plugin;
		const configured = (): boolean => plugin.configured;
		const ready = (): boolean => plugin.configured && plugin.bootstrapReady;
		// 这份定义（与随后的渲染）对应的结构；状态变化时与它比较，决定整页重绘还是只重绘状态卡
		this.renderedShape = this.shape();
		return [
			// ── 首屏状态卡（UI 规格 D06）：已连接仓库 / 设备授权 / 仓库解锁 / 最近同步 / 冲突 + 唯一主按钮 ──
			{
				type: "group",
				cls: "litesync-status-card",
				items: [
					{
						name: "LiteSync",
						aliases: ["状态", "status", "连接", "解锁", "同步"],
						render: (setting) => this.renderStatusCard(setting),
					},
				],
			},
			// ── 1. 连接与仓库 ──
			{
				type: "group",
				heading: "连接与仓库",
				items: [
					{
						name: "粘贴连接链接",
						aliases: ["配对", "导入", "二维码", "pairing", "连接 Obsidian"],
						desc:
							"在 LiteSync 网页的仓库卡片上点「连接 Obsidian」，或在已接入的设备上点「添加新设备」，会得到一个 5 分钟内有效的链接/二维码。" +
							"手机扫码后点「在 Obsidian 中打开」即可；没有反应时复制链接粘贴到这里。",
						visible: () => !configured(),
						action: () => plugin.openPasteLinkModal(),
					},
					{
						name: "打开网页注册或登录",
						aliases: ["注册", "登录", "账号", "官网", "新建仓库"],
						desc: "还没有账号或仓库：在网页上注册、创建一个加密仓库，再回来粘贴它的连接链接。",
						visible: () => !configured(),
						action: () => plugin.openWebsite(),
					},
					{
						name: "当前仓库",
						aliases: ["仓库", "vault", "多仓库", "重命名"],
						visible: configured,
						render: (setting) => {
							setting.setDesc("正在查询当前仓库…");
							setting.addButton((btn) =>
								btn.setButtonText("重命名…").onClick(() => new RenameVaultModal(plugin.app, plugin).open()),
							);
							void (async () => {
								try {
									const vaults = await plugin.listRemoteVaults();
									const cur = vaults.find((v) => v.current);
									if (!cur) {
										setting.setDesc("尚未接入远端仓库（点上方「完成接入」）");
										return;
									}
									plugin.rememberVaultName(cur.name);
									const extra = vaults.length > 1 ? `；名下共 ${vaults.length} 个仓库` : "";
									setting.setDesc(
										`同步到「${cur.name || "默认仓库"}」（远端 ${cur.fileCount} 个文件${extra}）。` +
											"一个 Obsidian 库同一时间只绑定一个远端仓库；切换或新建仓库请重新运行接入向导。",
									);
								} catch {
									setting.setDesc("无法查询（离线，或服务器版本低于 v0.19）");
								}
							})();
						},
					},
					{
						name: "添加新设备",
						aliases: ["配对", "二维码", "新设备"],
						desc: "生成一次性加密连接链接/二维码（只能用一次，很快过期）：新设备导入后先核对仓库，再输入仓库密码。链接里不含仓库密码与长期 Token。",
						visible: configured,
						action: () => plugin.openAddDeviceModal(),
					},
					{
						name: "设备列表",
						aliases: ["设备", "撤销", "devices"],
						desc: "查看已接入这个仓库的设备",
						visible: configured,
						action: () => plugin.openDeviceList(),
					},
					{
						name: "导入另一个连接链接",
						desc: "改连到另一个服务器或仓库：会暂停当前同步并重新走接入向导（本地笔记保留，同步记录作废）",
						visible: configured,
						action: () => plugin.openPasteLinkModal(),
					},
					{
						name: "重新运行接入向导",
						desc: "重新选择目标仓库（切换 / 新建）与首次同步方式",
						visible: configured,
						action: () => plugin.rerunBootstrapWizard(),
					},
				],
			},
			// ── 2. 同步 ──
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
						name: "解决同步冲突",
						desc: "逐个比较本地与远端版本，选择保留哪一份或合并",
						visible: ready,
						action: () => plugin.openConflicts(),
					},
				],
			},
			// ── 3. 加密与设备 ──
			{
				type: "group",
				heading: "加密与设备",
				items: [
					{
						name: "仓库加密",
						aliases: ["E2EE", "端到端加密", "加密", "解锁", "锁定"],
						visible: configured,
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
						name: "密钥保存方式",
						aliases: ["信任此设备", "自动解锁", "严格会话解锁", "迁移"],
						render: (setting) => {
							setting.setDesc(plugin.keyPolicyText());
							if (plugin.trustMigrationPending()) {
								setting.addButton((btn) =>
									btn
										.setButtonText("迁移到严格会话解锁…")
										.setCta()
										.onClick(() => plugin.openTrustMigrationModal()),
								);
							}
						},
					},
					{
						name: "本地文件说明",
						desc:
							"设备授权只用来访问服务器上的密文；仓库解锁才带来解密能力。Obsidian 里已经下载到本地的 Markdown 与附件" +
							"始终按宿主的正常方式以明文保存——锁定 LiteSync 只暂停同步与远端解密，不会加密或隐藏本地文件。",
					},
					{
						name: "设备名称",
						desc: "用于冲突文件命名与设备列表，例如 MacBook",
						control: { type: "text", key: "deviceName", placeholder: "MacBook" },
					},
					{
						name: "忘记此设备",
						desc: "删除本设备保存的自动解锁材料并立即锁定；下次必须重新输入仓库密码",
						visible: () => plugin.hasTrustedDevice() && !plugin.trustMigrationPending(),
						action: () => {
							void plugin.forgetThisDevice().then(() => this.update());
						},
					},
				],
			},
			// ── 4. 高级（子页面：手工连接、密钥持久化、高级恢复、隐私增强、实验功能、调试） ──
			{
				type: "page",
				name: "高级",
				desc: "手工填写服务器与 Token、密钥持久化、高级恢复、隐私增强、实验功能",
				items: [
					{
						type: "group",
						heading: "手动连接",
						items: [
							{
								name: "Server URL",
								desc: createFragment((frag) => {
									frag.appendText(
										"同步服务器地址，例如 https://sync.example.com。一般不需要手填——粘贴连接链接会自动设置。",
									);
									frag.createEl("a", {
										text: "自建服务器部署指南",
										href: "https://github.com/KJoner/litesync-server",
									});
								}),
								control: { type: "text", key: "serverUrl", placeholder: "https://sync.example.com" },
							},
							{
								name: "API Token",
								desc: "账户 API Token（lsk_ 开头）或本设备的设备凭据。保存在 Obsidian SecretStorage，不进入 data.json",
								render: (setting) => {
									setting.addText((text) => {
										text.inputEl.type = "password";
										// 防抖提交（v0.18 / v11 设计 §4.6）：逐字符提交会让定时同步
										// 拿着半截 Token 撞出假 401（一条常驻错误通知），还伴随
										// 每键一次的 SecretStorage 写入与绑定作废抖动。
										// 停顿 800ms 或失焦才算「输完了」。
										const commit = debounce(
											(value: string) => void plugin.setApiToken(value.trim()),
											800,
											true,
										);
										text
											.setPlaceholder("Token")
											.setValue(plugin.getApiToken())
											.onChange((value) => commit(value));
										text.inputEl.addEventListener("blur", () => {
											void plugin.setApiToken(text.inputEl.value.trim());
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
										// null = 已弹出「首次配置」对话框，无需再报消息
										if (msg !== null) new Notice(msg);
										el.removeClass("is-disabled");
									});
								},
							},
						],
					},
					{
						type: "group",
						heading: "密钥持久化",
						items: [
							{
								name: "本设备自动解锁（可恢复密钥持久化）",
								aliases: ["信任此设备", "保持解锁"],
								desc:
									"默认关闭（严格会话解锁）。开启后，解锁时会把仓库主密钥用随机设备密钥包装：一半存插件 data.json，" +
									"另一半存 Obsidian SecretStorage，之后启动自动解锁。仓库密码本身不保存；但拿到本设备完整文件与应用数据的人" +
									"可能因此解开你的笔记。只在你完全掌控的设备上开启。",
								control: { type: "toggle", key: "trustDevice" },
							},
						],
					},
					{
						type: "group",
						heading: "高级恢复",
						items: [
							{
								name: "启用「用本地完整替换远端」（验收阶段）",
								aliases: ["覆盖远端", "本地为准", "完整替换"],
								desc:
									"这个破坏性的高级恢复操作仍处于验收阶段，默认关闭。关闭时只能生成只读差异预览，不能执行；" +
									"已经开始的替换作业仍可在下面诊断、放弃或回滚。开启前请先完整备份本地笔记，并确认其他设备此刻不在同步。",
								control: { type: "toggle", key: "replaceRemoteEnabled" },
							},
							{
								name: "用本地完整替换远端",
								aliases: ["覆盖远端", "本地为准", "恢复"],
								desc:
									"高风险：以本设备的同步范围为准，覆盖远端的不同文件、删除远端多出来的文件（删除留有记录，可从历史恢复）。" +
									"执行前会生成完整的差异预览、保存远端原始版本作为恢复点，并要求输入仓库名确认。" +
									"只想把空仓库初始化成本地内容时，请用接入向导里的「用本地初始化空仓库」。",
								visible: () => ready() && plugin.settings.replaceRemoteEnabled,
								action: () => plugin.openReplaceRemote(),
							},
							{
								name: "预览本地与远端的差异（只读）",
								aliases: ["覆盖远端", "差异预览", "完整替换"],
								desc:
									"按「用本地完整替换远端」的规则生成差异预览：哪些远端文件会被覆盖、删除、新建。只读，不保存、不写入任何东西；" +
									"执行入口处于验收阶段，需要先打开上面的开关。",
								visible: () => ready() && !plugin.settings.replaceRemoteEnabled,
								action: () => plugin.openReplaceRemote(),
							},
							{
								name: "替换作业：诊断、放弃或回滚",
								aliases: ["替换作业", "回滚", "反向作业", "放弃作业"],
								desc:
									"本设备有一个未完成、或已部分完成的「用本地完整替换远端」作业：可以查看进度与暂停原因、放弃它，" +
									"或按恢复点把远端回滚到替换之前——这些恢复操作不受上面开关的限制。",
								visible: () => ready() && !plugin.settings.replaceRemoteEnabled && plugin.replaceJobNeedsAttention(),
								action: () => plugin.openReplaceRemote(),
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
								name: "只填充这些路径（每行一个前缀）",
								desc: "留空表示对全部文件生效。多数人只有一小部分笔记值得为它多花空间。",
								visible: () => plugin.settings.padObjectSizes,
								control: { type: "textarea", key: "padPathPrefixes" },
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
						],
					},
					{
						type: "page",
						name: "实验功能（RC，勿用于唯一真实 Vault）",
						desc: "加密路径与文件名等仍在验证中的能力",
						items: [
							{
								type: "group",
								heading: "加密路径与文件名",
								items: [
									{
										name: "加密路径与文件名（实验）",
										desc: createFragment((frag) => {
											frag.appendText(
												"开启后才会出现「加密路径与文件名」命令。请只在测试 Vault 或已完整备份的副本上使用。",
											);
											frag.createEl("br");
											frag.appendText(
												"· 迁移前的服务器备份中仍含有明文路径——那既是回滚窗口，也是明文的最后残留处；",
											);
											frag.createEl("br");
											frag.appendText("· 迁移到 verifying 之前随时可以无损放弃；complete 并抹除之后不可回滚；");
											frag.createEl("br");
											frag.appendText("· 所有设备都必须先升级，旧版本读不了伪名寻址的仓库。");
											frag.createEl("br");
											frag.appendText(
												"· 动手前请先在服务器上执行 obsync migration preflight，它会检查有没有设备还没升级。",
											);
										}),
										control: { type: "toggle", key: "experimentalMetaEncryption" },
									},
									{
										name: "允许不可逆的明文路径抹除（开发者）",
										desc:
											"默认关闭。关闭时迁移会停在「已伪名化但未抹除」的可回退状态——" +
											"这是绝大多数情况下你想要的。开启后 complete 会真正覆写数据库、WAL 与 blob 中残留的明文路径，" +
											"并用哨兵扫描验证覆写生效；这一步不可逆，此后只能依靠迁移前的备份恢复。",
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
				// 0.20.1（PL-01）：换服务器同时锁定密钥环，作废旧连接上进行中的解锁与取回
				if (changed) this.plugin.onServerUrlChanged();
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

/**
 * 重命名当前仓库（v0.19.x）。只动服务端的展示名——vault_id / 密钥 / 账本 /
 * 绑定指纹一概不变，因此无需重新接入。重命名是用户级 Token 专属操作：
 * 配对导入的设备（持设备凭据）会被服务端拒绝，提示重新填入账户 Token。
 */
class RenameVaultModal extends Modal {
	constructor(
		app: App,
		private plugin: PrivateSyncPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("重命名当前仓库");
		const { contentEl } = this;
		const info = contentEl.createDiv({ text: "正在查询当前仓库…" });
		void (async () => {
			let cur;
			try {
				cur = (await this.plugin.listRemoteVaults()).find((v) => v.current);
			} catch (e) {
				info.setText(`无法查询：${e instanceof Error ? e.message : String(e)}`);
				return;
			}
			if (!cur) {
				info.setText("尚未接入远端仓库。");
				return;
			}
			info.setText(`当前仓库：「${cur.name || "默认仓库"}」。改名只影响各处的显示名，不影响同步、加密与其他设备。`);
			contentEl.createDiv({ text: "新名字（1–64 字符）：" });
			const input = contentEl.createEl("input", { type: "text", cls: "litesync-modal-input", value: cur.name });
			input.setAttribute("autocomplete", "off");
			const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			const btn = footer.createEl("button", { text: "重命名", cls: "mod-cta" });
			const id = cur.id;
			// Token 补填走**独立弹窗**（TokenPromptModal）：密码框绝不与名字框
			// 同弹窗——「文本框 + 密码框」触发 WebKit 登录表单启发式，名字框被
			// 当用户名字段连坐进 iOS 凭据键盘限制（禁第三方输入法）。但两个
			// 弹窗仍叠在同一个网页文档里，iOS 密码管理器填充照样会把条目的
			//「用户名」塞进下层名字框（真机实测：重命名成了密码条目名）——
			// 所以重试**只用被拒那一刻捕获的名字**，Token 弹窗期间名字框
			// readOnly（autofill 跳过只读控件），关闭时恢复捕获值
			const attemptRename = async (name: string): Promise<void> => {
				try {
					await this.plugin.renameRemoteVault(id, name);
					new Notice(`仓库已重命名为「${name}」✓`);
					this.close();
					this.plugin.refreshSettingsTab();
				} catch (e) {
					if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
						errEl.setText("重命名需要账户的 API Token（本设备持有的是配对导入的设备凭据）。");
						input.readOnly = true;
						new TokenPromptModal(
							this.app,
							"重命名需要账户的 API Token（lsk_ 开头）。输入后将保存为本设备的凭据并自动重试。",
							(t) => {
								void this.plugin.setApiToken(t).then(() => attemptRename(name));
							},
							() => {
								input.readOnly = false;
								input.value = name;
							},
						).open();
					} else {
						errEl.setText(`失败：${e instanceof Error ? e.message : String(e)}`);
					}
				}
			};
			const doRename = (): void => {
				const name = input.value.trim();
				if (!name || name.length > 64) {
					errEl.setText("名字需为 1–64 个字符。");
					return;
				}
				void attemptRename(name);
			};
			btn.onclick = doRename;
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					// 回车 = 提交，并先收起软键盘（iOS 软键盘盖住底部按钮）
					input.blur();
					doRename();
				}
			});
			footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		})();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
