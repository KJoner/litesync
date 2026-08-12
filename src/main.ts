import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { ApiClient } from "./api/client";
import { BootstrapWizardModal } from "./bootstrap/bootstrap-modal";
import { ConflictListModal } from "./conflict-ui/conflict-view";
import {
	API_TOKEN_SECRET_ID,
	forgetTrustedDevice,
	loadTrustedVmk,
	persistTrustedDevice,
} from "./crypto/device-trust";
import { EnableE2eeModal, UnlockModal } from "./crypto/e2ee-modals";
import { Keyring } from "./crypto/keyring";
import { ConfirmMetaEncryptionModal } from "./crypto/meta-modals";
import { abortMetadataMigration, enableE2ee, encryptMetadata, upgradeEnvelopes } from "./crypto/migration";
import { HistoryModal } from "./history/history-view";
import { DeviceListModal } from "./pairing/device-list-modal";
import { PasteLinkModal, registerImportHandler } from "./pairing/import-handler";
import { AddDeviceModal } from "./pairing/pairing-modal";
import { DEFAULT_SETTINGS, PluginSettings, SyncSettingTab } from "./settings";
import { ShareManageModal, ShareModal } from "./share/share-modal";
import { StateStore } from "./state/store";
import { SyncContext } from "./sync/context";
import { SyncBlockedError, SyncGate } from "./sync/gate";
import { loadOrCreateSigningKey } from "./crypto/signing-key";
import { LocalCommitter } from "./sync/local-commit";
import { PendingQueue } from "./sync/queue";
import { SyncManager, SyncStatus } from "./sync/sync-manager";
import { IgnoreMatcher } from "./utils/ignore";
import { renderProbeReport, runPlatformProbe } from "./diagnostics/platform-probe";
import { nextFlushDelay, quantizeMtime } from "./utils/timing";
import { VaultKeyDoc } from "./crypto/crypto";

/** vault key 的密钥材料是否发生变化（换库 / 轮换；影响绑定指纹）。 */
function vaultKeyMaterialChanged(before: VaultKeyDoc | null, after: VaultKeyDoc | null): boolean {
	if (before === null && after === null) return false;
	if (before === null || after === null) return true;
	return before.wrappedKey !== after.wrappedKey || before.salt !== after.salt;
}

/** 文件变化后延迟同步，避免连续输入时频繁上传。 */
const DEBOUNCE_MS = 3000;
/** App 回到前台后的同步防抖（避免快速切换 App 触发同步风暴，v6）。 */
const FOREGROUND_DEBOUNCE_MS = 2500;
/** 移动端定时拉取的最小间隔：避免 iPhone 不必要的轮询耗电（v6）。 */
const MOBILE_MIN_INTERVAL_SECONDS = 60;

export default class PrivateSyncPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };

	private store: StateStore | null = null;
	private queue = new PendingQueue();
	private committer!: LocalCommitter;
	/** 本设备 checkpoint 签名私钥（base64 PKCS#8，v0.15 §9.2）；未生成时为空串 */
	private signingKeyPkcs8 = "";
	/** 待登记到服务器的签名公钥（登记成功后清空） */
	private pendingSigningPublicKey = "";
	private client: ApiClient | null = null;
	private manager: SyncManager | null = null;
	private ctx: SyncContext | null = null;
	private ignoreMatcher: IgnoreMatcher | null = null;
	private statusEl: HTMLElement | null = null;
	private debounceTimer: number | null = null;
	private foregroundTimer: number | null = null;
	private intervalId: number | null = null;
	private lastStatus: SyncStatus = "idle";
	private keyring = new Keyring();
	/** 同步安全 Gate（v0.12.1）：手动命令与自动同步共用的许可判断 */
	private gate = new SyncGate();
	/** 接入向导单例标志（v8）：避免多个同步入口重复弹窗 */
	private wizardOpen = false;
	/** API Token 运行时值（真实存储在 Obsidian SecretStorage） */
	private apiTokenValue = "";
	/** v3.1 迁移：旧版本明文保存的 E2EE 密码，仅在首次启动时用一次后即抹除 */
	private legacyE2eePassword = "";

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusEl = this.addStatusBarItem();
		this.updateStatus("idle");

		this.addSettingTab(new SyncSettingTab(this.app, this));
		this.addCommand({
			id: "sync-now",
			name: "立即同步 (Sync now)",
			callback: () => void this.syncNow(),
		});
		this.addCommand({
			id: "file-history",
			name: "文件版本历史 (File history)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.ctx) return false;
				if (!checking) new HistoryModal(this.ctx, file.path).open();
				return true;
			},
		});
		this.addCommand({
			id: "resolve-conflicts",
			name: "解决同步冲突 (Resolve conflicts)",
			callback: () => {
				if (this.ctx) new ConflictListModal(this.ctx).open();
			},
		});
		this.addCommand({
			id: "unlock-e2ee",
			name: "解锁端到端加密 (Unlock E2EE)",
			callback: () => this.openUnlockModal(),
		});
		this.addCommand({
			id: "manage-shares",
			name: "管理分享 (Manage shares)",
			callback: () => {
				if (this.ctx) new ShareManageModal(this.ctx, this.settings.serverUrl).open();
			},
		});
		this.addCommand({
			id: "list-devices",
			name: "设备列表 (List devices)",
			callback: () => {
				if (this.client) new DeviceListModal(this.app, this.client).open();
			},
		});
		this.addCommand({
			id: "upgrade-envelopes",
			name: "升级加密信封 LSE1 → LSE3 (Upgrade encryption envelopes)",
			callback: () => void this.runEnvelopeUpgrade(),
		});
		this.addCommand({
			id: "encrypt-metadata",
			name: "加密路径与文件名 (Encrypt file paths and names)",
			callback: () => this.confirmMetaEncryption(),
		});
		this.addCommand({
			id: "platform-probe",
			name: "平台兼容性自检 (Platform compatibility probe)",
			callback: () => void this.runPlatformProbe(),
		});
		this.addRibbonIcon("refresh-cw", "LiteSync: 立即同步", () => void this.syncNow());

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !this.ctx) return;
				menu.addItem((item) =>
					item
						.setTitle("LiteSync: 版本历史")
						.setIcon("history")
						.onClick(() => new HistoryModal(this.ctx!, file.path).open()),
				);
				menu.addItem((item) =>
					item
						.setTitle("LiteSync: 分享此文件…")
						.setIcon("share-2")
						.onClick(() => new ShareModal(this.ctx!, this.settings.serverUrl, file.path).open()),
				);
			}),
		);

		// obsidian://litesync-import：扫码/配对链接导入配置（v8）
		registerImportHandler(this);

		// 等待 vault 索引就绪后再初始化，避免启动时的 create 事件风暴
		this.app.workspace.onLayoutReady(() => void this.initialize());
	}

	onunload(): void {
		this.manager?.dispose();
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		if (this.foregroundTimer !== null) window.clearTimeout(this.foregroundTimer);
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		void this.store?.save();
	}

	private async initialize(): Promise<void> {
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		this.store = new StateStore(this.app.vault.adapter, `${pluginDir}/state.json`);
		await this.store.load();
		// 状态损坏停机（v9）：不初始化同步，提示用户处理（SyncManager 侧另有硬性兜底）
		if (this.store.corrupted) {
			new Notice(
				"LiteSync：本地同步状态文件损坏（state-a/state-b.json 均无法读取），同步已停止。\n请勿删除这两个文件，可从备份恢复或联系支持渠道处理",
				0,
			);
		}
		// 队列持久化（v9 P1-10）：镜像到 state.pendingOps，重启后未完成的上传/删除不丢
		this.queue.onChange = (entries) => {
			if (this.store) this.store.state.pendingOps = entries;
		};
		// §6.3：入队 → 落盘 → 才算被接受。串行化的 save 保证排队期间
		// 新增的条目一定被带上（§6.2）
		this.queue.persist = async () => {
			await this.store?.save();
		};
		this.queue.restore(this.store.state.pendingOps);

		// API Token：读取 SecretStorage（旧版 data.json 明文值迁入后抹除）
		await this.loadOrMigrateApiToken();

		// E2EE：加载缓存的 vault key 文档
		this.keyring.setDoc(this.store.state.e2ee);
		if (this.keyring.needsUnlock) {
			// ① Trusted Device 自动解锁（设备密钥 + SecretStorage 中的包装 VMK）
			if (this.settings.trustDevice && this.settings.deviceKeyB64 && this.keyring.doc) {
				const raw = await loadTrustedVmk(this.app, this.settings.deviceKeyB64, this.keyring.doc);
				if (raw) {
					await this.keyring.unlockWithRaw(raw);
					raw.fill(0);
				}
			}
			// ② v3.1 迁移：旧版明文密码解锁一次 → 转为 Trusted Device → 从磁盘抹除
			if (this.keyring.needsUnlock && this.legacyE2eePassword) {
				if (await this.keyring.unlock(this.legacyE2eePassword)) {
					this.settings.trustDevice = true;
					await this.persistTrust();
					new Notice("已把旧的「记住密码」迁移为「信任此设备」，明文密码已从磁盘移除");
				}
			}
			this.legacyE2eePassword = "";
		}

		this.rebuildIgnoreMatcher();
		this.client = new ApiClient(() => ({
			serverUrl: this.settings.serverUrl,
			apiToken: this.getApiToken(),
			deviceId: this.store?.state.deviceId ?? "",
			// 逐请求携带（协议 v6 / ADR-006）：与服务器不符时服务器直接拒绝写入，
			// 而不是让我们用过时的寻址方式把数据写坏
			formatEpoch: this.store?.state.bootstrap.formatEpoch ?? 0,
			repoEpoch: this.store?.state.bootstrap.repoEpoch ?? "",
			keyEpoch: this.store?.state.bootstrap.keyEpoch ?? 0,
		}));

		// 移动端第一阶段不同步 Obsidian 配置目录：桌面与移动配置差异大，避免互相覆盖（v6）
		if (Platform.isMobileApp && this.settings.syncObsidian) {
			new Notice("移动端不同步 Obsidian 配置目录（桌面与移动端的界面配置互不兼容），普通笔记与附件不受影响");
		}

		// §9.2：本设备的 checkpoint 签名密钥。生成失败不阻断同步——
		// 那只意味着本设备不发布 checkpoint，仍然会校验别人发布的
		try {
			const signing = await loadOrCreateSigningKey(this.app);
			this.signingKeyPkcs8 = signing.privateKeyPkcs8B64;
			this.pendingSigningPublicKey = signing.publicKeyB64;
		} catch (e) {
			console.debug("[litesync] signing key unavailable", e);
		}

		// §6.1：唯一的本地写入口。staging/recovery 都放在插件目录下，
		// 那里被 IgnoreMatcher 无条件排除，永远不会被当成用户笔记同步出去
		this.committer = new LocalCommitter(this.app, pluginDir, (m) => {
			if (this.settings.debug) console.debug(`[litesync] ${m}`);
		});
		void this.committer.sweep(Date.now());

		const ctx: SyncContext = {
			app: this.app,
			client: this.client,
			store: this.store,
			queue: this.queue,
			committer: this.committer,
			gate: this.gate,
			syncObsidian: () => this.effectiveSyncObsidian(),
			padsSize: (path) => this.padsSize(path),
			reportedMtime: (ms) => this.reportedMtime(ms),
			ignores: (path) => this.ignoreMatcher?.ignores(path) ?? false,
			deviceName: () =>
				this.settings.deviceName || `device-${(this.store?.state.deviceId ?? "").slice(0, 8)}`,
			pluginDir: () => pluginDir,
			signingKeyPkcs8: () => this.signingKeyPkcs8,
			signingPublicKey: () => this.pendingSigningPublicKey,
			onSigningKeyRegistered: () => void (this.pendingSigningPublicKey = ""),
			log: (msg) => {
				// 仅在用户显式开启 Debug 时输出；用 debug 级别不污染默认控制台
				if (this.settings.debug) console.debug(`[litesync] ${msg}`);
			},
			notify: (msg) => new Notice(msg, 8000),
			onConflictsChanged: () => this.updateStatus(this.lastStatus),
			e2ee: this.keyring,
			credentials: () => ({ serverUrl: this.settings.serverUrl, apiToken: this.getApiToken() }),
			refreshE2ee: async () => {
				const before = this.keyring.doc;
				const doc = await this.client!.getVaultKey();
				this.keyring.setDoc(doc);
				if (this.store) this.store.state.e2ee = doc;
				// vault key 文档被替换（密钥轮换 / 换库）→ 本地绑定作废（LS-121-C02）
				if (vaultKeyMaterialChanged(before, doc)) {
					this.manager?.invalidateBinding("端到端加密密钥文档已变化");
				}
			},
			// v9.2：根 Token → 设备凭据自动换发（SyncManager 协议检查时调用）
			updateApiToken: async (token) => {
				await this.setApiToken(token);
			},
		};
		this.ctx = ctx;
		this.manager = new SyncManager(ctx);
		this.manager.onStatus = (status, detail) => this.updateStatus(status, detail);

		this.registerVaultEvents();
		this.registerForegroundSync();
		this.applySettings();

		// Bootstrap Gate（v8）：填完 URL + Token ≠ 可以开始同步。
		// 未接入时先进向导；接入完成后才允许任何自动同步
		if (this.isConfigured()) {
			if (!this.store.bootstrapReady) {
				this.openBootstrapWizard();
			} else if (this.settings.autoSync) {
				void this.manager.sync("startup");
			}
		}
	}

	// ---------- Bootstrap（首次接入向导，v8） ----------

	get bootstrapReady(): boolean {
		return this.store?.bootstrapReady ?? false;
	}

	openBootstrapWizard(): void {
		if (this.wizardOpen || !this.ctx) return;
		if (!this.isConfigured()) {
			new Notice("请先在设置中填写 Server URL 和 API Token");
			return;
		}
		this.wizardOpen = true;
		new BootstrapWizardModal(this.app, this.ctx, {
			openUnlock: () => this.openUnlockModal(),
			onDone: () => {
				this.updateStatus("idle");
				void this.manager?.sync("bootstrap");
			},
			onClosed: () => {
				this.wizardOpen = false;
			},
		}).open();
	}

	/** 重新运行接入向导（设置页入口；会把本设备重置为待接入）。 */
	rerunBootstrapWizard(): void {
		this.store?.resetBootstrap();
		this.invalidateBinding("重新运行接入向导");
		void this.store?.save();
		this.openBootstrapWizard();
	}

	/** 重置为待接入（导入新配对配置后调用）。 */
	resetBootstrapState(): void {
		this.store?.resetBootstrap();
		this.invalidateBinding("导入了新的服务器配置");
		void this.store?.save();
	}

	/** 「添加新设备」：生成一次性加密配对包并展示二维码/链接。 */
	openAddDeviceModal(): void {
		if (!this.client || !this.isConfigured()) {
			new Notice("请先在设置中填写 Server URL 和 API Token");
			return;
		}
		new AddDeviceModal(this.app, this.client, this.settings).open();
	}

	/** 「导入配对链接」：手动粘贴其他设备生成的配对链接。 */
	openPasteLinkModal(): void {
		new PasteLinkModal(this.app, this).open();
	}

	/** 元数据迁移是否停在 migrating（设置页据此显示「放弃迁移」入口）。 */
	metaMigrationActive(): boolean {
		return this.store?.state.bootstrap.metaState === "migrating";
	}

	/** 放弃元数据迁移：退回 plain（无破坏性操作）。 */
	async abortMetaMigration(): Promise<void> {
		if (!this.ctx) return;
		try {
			const state = await abortMetadataMigration(this.ctx);
			new Notice(`已放弃路径加密迁移，仓库元数据状态：${state}`);
		} catch (e) {
			new Notice(`放弃迁移失败：${e instanceof Error ? e.message : String(e)}`, 10000);
		}
	}

	/**
	 * 「加密路径与文件名」（v9.3 三期）：确认后执行元数据加密迁移。
	 *
	 * v0.12.1（LS-121-C01）：默认构建里这条命令处于关闭状态，必须在设置页
	 * 显式打开「实验功能」；即便打开，不可逆的明文抹除仍需另一个开发者开关。
	 */
	private confirmMetaEncryption(): void {
		if (!this.ctx) return;
		if (!this.settings.experimentalMetaEncryption) {
			new Notice(
				"「加密路径与文件名」在 v0.12.x 仍是实验功能，默认关闭。\n" +
					"如需在测试 Vault 上试用，请到设置 → 实验功能中开启（切勿用于唯一的真实 Vault）",
				12000,
			);
			return;
		}
		if (!this.keyring.enabled) {
			new Notice("请先启用端到端加密");
			return;
		}
		if (!this.keyring.unlocked) {
			new Notice("请先解锁端到端加密（Unlock E2EE）");
			return;
		}
		if (this.store?.state.bootstrap.metaState === "encrypted") {
			new Notice("路径与文件名已经是加密状态");
			return;
		}
		new ConfirmMetaEncryptionModal(this.app, this.settings.allowIrreversibleMetaErase, () => {
			void this.runMetaEncryption();
		}).open();
	}

	private async runMetaEncryption(): Promise<void> {
		if (!this.ctx || !this.manager) return;
		const progress = new Notice("正在加密路径与文件名…", 0);
		try {
			const r = await encryptMetadata(this.ctx, {
				onProgress: (p) => {
					progress.setMessage(`加密元数据 ${p.done}/${p.total}：${p.current}`);
				},
				fullSync: () => this.manager!.fullSync("pre-meta-migration"),
				allowIrreversibleComplete: this.settings.allowIrreversibleMetaErase,
			});
			progress.hide();
			new Notice(
				r.erased
					? `元数据加密完成：${r.migrated} 个文件的路径已伪名化，服务器上的明文路径已抹除。\n其他设备下次同步会自动对账（需 0.12+ 并解锁 E2EE）`
					: `已伪名化 ${r.migrated} 个文件的路径（仓库状态：${r.metaState}）。\n` +
							`v0.12.1 不执行不可逆的明文抹除：服务器上仍保留旧的明文路径记录（tombstone/历史），` +
							`正式抹除请等待 v0.13.0 的隐私 tombstone ledger。\n随时可在设置中「放弃路径加密迁移」退回 plain。`,
				15000,
			);
		} catch (e) {
			progress.hide();
			new Notice(`元数据加密失败（可重新执行续传）：${e instanceof Error ? e.message : String(e)}`, 10000);
		}
	}

	/** 「升级加密信封」（v9.2；v9.3 起目标为 LSE3）：把旧信封密文重新加密。 */
	private async runEnvelopeUpgrade(): Promise<void> {
		if (!this.ctx) return;
		if (!this.keyring.enabled) {
			new Notice("端到端加密未启用，无需升级信封");
			return;
		}
		const progress = new Notice("正在升级加密信封…", 0);
		try {
			// 迁移类操作同样先等同步收敛（LS-121-C06），再由 upgradeEnvelopes 内部过 gate
			await this.manager?.fullSync("pre-envelope-upgrade");
			const r = await upgradeEnvelopes(this.ctx, (p) => {
				progress.setMessage(`升级加密信封 ${p.done}/${p.total}：${p.current}`);
			});
			progress.hide();
			new Notice(
				r.upgraded > 0
					? `加密信封升级完成：${r.upgraded} 个文件已升级到 LSE3${r.skipped ? `，${r.skipped} 个跳过（可重新执行续传）` : ""}`
					: "所有文件已经是 LSE3 信封，无需升级",
			);
		} catch (e) {
			progress.hide();
			new Notice(
				e instanceof SyncBlockedError
					? e.message
					: `信封升级失败：${e instanceof Error ? e.message : String(e)}`,
				10000,
			);
		}
	}

	/**
	 * App 回到前台时同步（v6 移动端策略）：iOS 会暂停后台 App 的定时器，
	 * hidden → visible 是移动端最可靠的补同步时机；带防抖避免快速切换风暴。
	 */
	private registerForegroundSync(): void {
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState !== "visible") return;
			if (!this.settings.autoSync || !this.isConfigured() || !this.bootstrapReady) return;
			if (this.foregroundTimer !== null) window.clearTimeout(this.foregroundTimer);
			this.foregroundTimer = window.setTimeout(() => {
				this.foregroundTimer = null;
				void this.manager?.sync("foreground");
			}, FOREGROUND_DEBOUNCE_MS);
		});
	}

	/** 移动端第一阶段不同步 .obsidian，无论设置如何（v6 计划 Part 27）。 */
	effectiveSyncObsidian(): boolean {
		return this.settings.syncObsidian && !Platform.isMobileApp;
	}

	/**
	 * 这个路径要不要做大小填充（v0.17 / 计划书 §11.1）。
	 *
	 * 前缀匹配走规范化后的 vault 路径：设置里写 "Private/" 就只覆盖那一棵子树，
	 * 不会因为大小写或反斜杠差异漏掉——那种漏掉最糟，
	 * 用户以为开了，实际没开，而且没有任何提示。
	 */
	padsSize(path: string): boolean {
		if (!this.settings.padObjectSizes) return false;
		const prefixes = this.settings.padPathPrefixes
			.split("\n")
			.map((p) => p.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase())
			.filter((p) => p.length > 0);
		if (prefixes.length === 0) return true;
		const target = path.replace(/\\/g, "/").toLowerCase();
		return prefixes.some((p) => target === p || target.startsWith(p.endsWith("/") ? p : p + "/"));
	}

	/**
	 * 平台兼容性自检（计划书 §8.4 实机矩阵、§8.8 门槛 3 与 11）。
	 *
	 * §8.4 要求在各平台跑一遍路径用例矩阵。桌面端可以用 `npm test`
	 *（tests/realfs.test.ts 直接操作真实文件系统），**但移动端跑不了 Node**。
	 * 于是移动端那一格长期只能靠推理填——而推理错的方向恰好最危险：
	 * 我们以为两个名字不同，文件系统认为相同，后写的静默覆盖先写的。
	 *
	 * 这个命令跑在插件内部、用 Obsidian 自己的 adapter，因此在移动端也能跑。
	 * 结果写成一篇笔记，用户可以直接读、直接贴出来。
	 */
	async runPlatformProbe(): Promise<void> {
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		new Notice("LiteSync：正在自检平台兼容性…");
		try {
			const rep = await runPlatformProbe(this.app, pluginDir, this.manifest.version, this.committer);
			const md = renderProbeReport(rep);
			// 文件名带到秒：每次自检都是一次**新建**，绝不覆盖上一份报告。
			// 既避开了「覆盖用户文件」这条禁令，也顺带保留了历次自检的记录——
			// 换了设备或系统升级之后，能看出结论有没有变
			const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
			const path = `LiteSync 平台自检 ${stamp}.md`;
			await this.app.vault.create(path, md);
			const unsafe = rep.results.filter((r) => r.verdict === "unsafe").length;
			const limited = rep.results.filter((r) => r.verdict === "limited").length;
			new Notice(
				unsafe > 0
					? `自检完成：发现 ${unsafe} 处**不安全**，请把「${path}」反馈给开发者`
					: limited > 0
						? `自检完成：无不安全项，${limited} 处受限，已写入「${path}」`
						: `自检完成：未发现问题，已写入「${path}」`,
			);
		} catch (e) {
			new Notice(`平台自检失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** 设置变化后重建忽略规则和定时器。 */
	applySettings(): void {
		this.rebuildIgnoreMatcher();

		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.settings.autoSync && this.settings.syncIntervalSeconds > 0) {
			// 移动端最低 60 秒：定时器只在 App 前台运行，补同步靠 foreground sync
			const seconds = Platform.isMobileApp
				? Math.max(MOBILE_MIN_INTERVAL_SECONDS, this.settings.syncIntervalSeconds)
				: this.settings.syncIntervalSeconds;
			this.intervalId = window.setInterval(() => {
				// Bootstrap Gate：自动入口在未接入时静默跳过（向导只由启动/手动触发弹出）
				if (this.isConfigured() && this.bootstrapReady) void this.manager?.sync("interval");
			}, seconds * 1000);
			this.registerInterval(this.intervalId);
		}
	}

	async syncNow(): Promise<void> {
		if (!this.isConfigured()) {
			new Notice("请先在设置中填写 Server URL 和 API Token");
			return;
		}
		if (!this.manager) {
			new Notice("插件尚未初始化完成，请稍候");
			return;
		}
		// Bootstrap Gate：未接入时手动同步先走向导
		if (!this.bootstrapReady) {
			this.openBootstrapWizard();
			return;
		}
		this.manager.resetRetry();
		await this.manager.sync("manual");
	}

	async testConnection(): Promise<string> {
		if (!this.client) return "插件尚未初始化完成，请稍候";
		if (!this.isConfigured()) return "请先填写 Server URL 和 API Token";
		try {
			const info = await this.client.info();
			return `连接成功：服务器版本 ${info.version}，latestSequence=${info.latestSequence}`;
		} catch (e) {
			return `连接失败：${e instanceof Error ? e.message : String(e)}`;
		}
	}

	private isConfigured(): boolean {
		return this.settings.serverUrl !== "" && this.getApiToken() !== "";
	}

	// ---------- API Token（SecretStorage required） ----------

	getApiToken(): string {
		return this.apiTokenValue;
	}

	async setApiToken(value: string): Promise<void> {
		const changed = this.apiTokenValue !== value;
		this.apiTokenValue = value;
		this.app.secretStorage.setSecret(API_TOKEN_SECRET_ID, value);
		if (changed) this.invalidateBinding("API Token 已变化");
		if (this.settings.apiToken !== "") {
			this.settings.apiToken = "";
			await this.saveSettings();
		}
	}

	/**
	 * 立即作废绑定（v0.12.1 / LS-121-C02）。
	 *
	 * server URL、Token、设备身份、vault key 文档任一变化时调用：会话缓存清零、
	 * 状态切 unbound，上传/删除/MOVE/历史恢复/分享在重新完成权威校验前全部被拒。
	 */
	invalidateBinding(reason: string): void {
		this.gate.markUnbound(reason);
		this.manager?.invalidateBinding(reason);
		this.store?.clearBinding();
		this.updateStatus("idle", `${reason}——需要重新校验服务器后才能继续同步`);
	}

	/** 启动时读取 Token；data.json 中的旧版明文值迁移进 SecretStorage 并抹除。 */
	private async loadOrMigrateApiToken(): Promise<void> {
		const stored = this.app.secretStorage.getSecret(API_TOKEN_SECRET_ID);
		if (stored) {
			this.apiTokenValue = stored;
			if (this.settings.apiToken !== "") {
				this.settings.apiToken = "";
				await this.saveSettings();
			}
		} else if (this.settings.apiToken) {
			this.app.secretStorage.setSecret(API_TOKEN_SECRET_ID, this.settings.apiToken);
			this.apiTokenValue = this.settings.apiToken;
			this.settings.apiToken = "";
			await this.saveSettings();
			new Notice("API Token 已迁移到 Obsidian SecretStorage");
		}
	}

	private rebuildIgnoreMatcher(): void {
		const configDir = this.app.vault.configDir;
		const pluginDir = this.manifest.dir ?? `${configDir}/plugins/${this.manifest.id}`;
		this.ignoreMatcher = new IgnoreMatcher(
			this.effectiveSyncObsidian(),
			configDir,
			pluginDir,
			this.settings.ignorePatterns,
		);
	}

	private registerVaultEvents(): void {
		// 队列落盘失败不能静默：用户会以为这次修改已经被接受
		const enqueue = (p: Promise<void>): void => {
			void p.catch((e: unknown) => {
				new Notice(`LiteSync：无法记录待同步变更（${e instanceof Error ? e.message : String(e)}）`, 8000);
			});
		};
		const track = (file: TAbstractFile, action: "upsert" | "delete"): void => {
			// pull 应用远端变更产生的事件不入队（随后的扫描兜底覆盖用户同时的编辑）
			if (this.manager?.applyingRemote) return;
			if (this.ignoreMatcher?.ignores(file.path)) return;
			if (file instanceof TFile) {
				// §6.3：入队即落盘——此后即使立刻退出 Obsidian，这次修改也不会丢
				enqueue(this.queue.add(file.path, action));
				this.scheduleDebounced();
			}
		};

		this.registerEvent(this.app.vault.on("create", (f) => track(f, "upsert")));
		this.registerEvent(this.app.vault.on("modify", (f) => track(f, "upsert")));

		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (this.manager?.applyingRemote) return;
				if (f instanceof TFolder) {
					// 文件夹删除：把状态缓存中该目录下的所有文件标记为删除
					for (const path of this.store?.paths() ?? []) {
						if (path.startsWith(f.path + "/")) enqueue(this.queue.add(path, "delete"));
					}
					this.scheduleDebounced();
					return;
				}
				track(f, "delete");
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (this.manager?.applyingRemote) return;
				// v9.3：旧路径已 tracked → 原子 MOVE。E2EE 下要求 tracked 为 LSE3
				//（generation 已知；LSE3 的 AAD 绑 fileId 不绑路径，改名无需重新加密），
				// 其余（LSE1/LSE2 密文 / 未同步过）维持 delete+upsert
				const canMove = (from: string): boolean => {
					const t = this.store?.get(from);
					if (!t) return false;
					return !this.keyring.enabled || (t.generation !== undefined && !!t.fileId);
				};
				if (f instanceof TFolder) {
					for (const path of this.store?.paths() ?? []) {
						if (!path.startsWith(oldPath + "/")) continue;
						const newPath = f.path + "/" + path.slice(oldPath.length + 1);
						if (!this.ignoreMatcher?.ignores(newPath) && canMove(path)) {
							enqueue(this.queue.addMove(newPath, path));
						} else {
							enqueue(this.queue.add(path, "delete"));
						}
					}
					for (const file of this.app.vault.getFiles()) {
						if (!file.path.startsWith(f.path + "/") || this.ignoreMatcher?.ignores(file.path)) continue;
						if (this.queue.getOp(file.path)?.action === "move") continue; // 不覆盖已排队的 move
						enqueue(this.queue.add(file.path, "upsert"));
					}
				} else {
					const ignoredOld = this.ignoreMatcher?.ignores(oldPath) ?? false;
					const ignoredNew = this.ignoreMatcher?.ignores(f.path) ?? false;
					if (!ignoredOld && !ignoredNew && canMove(oldPath)) {
						enqueue(this.queue.addMove(f.path, oldPath));
					} else {
						if (!ignoredOld) enqueue(this.queue.add(oldPath, "delete"));
						if (!ignoredNew) enqueue(this.queue.add(f.path, "upsert"));
					}
				}
				this.scheduleDebounced();
			}),
		);
	}

	private scheduleDebounced(): void {
		if (!this.settings.autoSync || !this.isConfigured()) return;
		// 时间混淆（§11.2）：对齐到窗口网格再加抖动，让上传时刻与编辑时刻脱钩。
		//
		// 已经排上队的发车点**不重置**——每来一次编辑就往后推的话，
		// 发车时刻会紧跟「最后一次编辑」，混淆就白做了。这与普通防抖相反：
		// 防抖要的是「等你停下来」，这里要的恰恰是「和你停没停无关」。
		if (this.settings.obfuscateTiming) {
			if (this.debounceTimer !== null) return;
			const delay = nextFlushDelay(Date.now(), this.settings.timingBatchSeconds);
			this.debounceTimer = window.setTimeout(() => {
				this.debounceTimer = null;
				void this.manager?.sync("change");
			}, delay);
			return;
		}
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.manager?.sync("change");
		}, DEBOUNCE_MS);
	}

	/**
	 * 上报给服务器的 mtime（§11.2）。
	 *
	 * 文件修改时间是**永久存储**的精确时间戳，比请求时间更值得担心——
	 * 请求日志会轮转，数据库不会。本地状态里仍然保存真实 mtime，
	 * 量化只发生在出网的那一刻。
	 */
	reportedMtime(mtimeMs: number): number {
		if (!this.settings.obfuscateTiming) return mtimeMs;
		return quantizeMtime(mtimeMs, this.settings.mtimeGranularitySeconds);
	}

	private updateStatus(status: SyncStatus, detail?: string): void {
		if (!this.statusEl) return;
		this.lastStatus = status;
		const texts: Record<SyncStatus, string> = {
			idle: "LiteSync",
			syncing: "↻ Syncing",
			synced: "✓ Synced",
			conflict: "! Conflict",
			offline: "× Offline",
			locked: "🔒 Locked",
		};
		let text = texts[status];
		// 有未解决冲突时优先显示计数，点击状态栏打开冲突列表
		const pending = this.store?.conflictPaths().length ?? 0;
		if (pending > 0 && status !== "syncing" && status !== "locked") {
			text = `! ${pending} Conflict${pending > 1 ? "s" : ""}`;
		}
		this.statusEl.setText(text);
		this.statusEl.setAttribute("aria-label", detail ?? text);
		const clickable = pending > 0 || status === "locked";
		this.statusEl.toggleClass("litesync-status-clickable", clickable);
		this.statusEl.onclick = !clickable
			? null
			: status === "locked"
				? () => this.openUnlockModal()
				: this.ctx
					? () => new ConflictListModal(this.ctx!).open()
					: null;
	}

	// ---------- E2EE ----------

	/** 设置页的 E2EE 状态与按钮文案。 */
	e2eeStatusText(): { desc: string; action: string } {
		if (!this.keyring.enabled) {
			return { desc: "未启用：服务器保存明文（仅 HTTPS 传输加密）", action: "启用端到端加密…" };
		}
		if (this.keyring.needsUnlock) {
			return { desc: "已启用 · 🔒 未解锁（同步已暂停）", action: "解锁…" };
		}
		return { desc: "已启用 · 🔓 已解锁", action: "锁定本设备" };
	}

	async e2eeAction(): Promise<void> {
		if (!this.keyring.enabled) {
			this.openEnableModal();
			return;
		}
		if (this.keyring.needsUnlock) {
			this.openUnlockModal();
			return;
		}
		this.keyring.lock();
		this.updateStatus("locked");
		new Notice("已锁定，本设备同步暂停");
	}

	openUnlockModal(): void {
		new UnlockModal(this.app, this.settings.trustDevice, async (password, trustDevice) => {
			// 新设备可能还没有缓存 vault key 文档，先从服务器获取
			if (!this.keyring.doc) {
				if (!this.client) return "插件尚未初始化完成";
				try {
					const doc = await this.client.getVaultKey();
					if (!doc) return "服务器未启用端到端加密";
					this.keyring.setDoc(doc);
					if (this.store) {
						this.store.state.e2ee = doc;
						await this.store.save();
					}
				} catch (e) {
					return `无法连接服务器：${e instanceof Error ? e.message : String(e)}`;
				}
			}
			if (!(await this.keyring.unlock(password))) return "密码错误";
			await this.setTrustDevice(trustDevice);
			new Notice("E2EE 已解锁 ✓");
			this.updateStatus("idle");
			// 未接入的设备解锁后回到接入向导；已接入的正常同步
			if (!this.bootstrapReady) this.openBootstrapWizard();
			else void this.manager?.sync("unlock");
			return null;
		}).open();
	}

	openEnableModal(): void {
		if (!this.ctx || !this.manager) {
			new Notice("插件尚未初始化完成，请稍候");
			return;
		}
		new EnableE2eeModal(this.app, this.settings.trustDevice, async (password, trustDevice, onProgress) => {
			const migrated = await enableE2ee(
				this.ctx!,
				password,
				// fullSync：等待当前轮 + 所有续轮 + 队列排空（LS-121-C06）
				() => this.manager!.fullSync("pre-e2ee-migration"),
				onProgress,
			);
			await this.setTrustDevice(trustDevice);
			this.updateStatus("synced");
			return migrated;
		}).open();
	}

	// ---------- Trusted Device ----------

	/** 是否存在可用的设备信任（用于设置页显示「忘记此设备」）。 */
	hasTrustedDevice(): boolean {
		return this.settings.trustDevice && this.settings.deviceKeyB64 !== "";
	}

	/** 把当前已解锁的 VMK 持久化为设备信任。 */
	private async persistTrust(): Promise<void> {
		if (!this.keyring.unlocked) return;
		const deviceKeyB64 = await persistTrustedDevice(this.app, this.settings.deviceKeyB64, this.keyring);
		if (deviceKeyB64 === null) return; // 无 vault key 文档（前置条件不满足），静默跳过
		if (this.settings.deviceKeyB64 !== deviceKeyB64) {
			this.settings.deviceKeyB64 = deviceKeyB64;
		}
		await this.saveSettings();
	}

	/** 开关「信任此设备」：开 → 立即持久化（若已解锁）；关 → 删除本地信任。 */
	async setTrustDevice(value: boolean): Promise<void> {
		this.settings.trustDevice = value;
		if (value) {
			await this.saveSettings();
			await this.persistTrust();
		} else {
			forgetTrustedDevice(this.app);
			this.settings.deviceKeyB64 = "";
			await this.saveSettings();
		}
	}

	/** 忘记此设备：删除设备信任并立即锁定。 */
	async forgetThisDevice(): Promise<void> {
		forgetTrustedDevice(this.app);
		this.settings.trustDevice = false;
		this.settings.deviceKeyB64 = "";
		await this.saveSettings();
		this.keyring.lock();
		this.updateStatus("locked");
		new Notice("已忘记此设备并锁定；下次需要重新输入 E2EE 密码");
	}

	async loadSettings(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;

		// v3.1 迁移：明文 E2EE 密码绝不再持久化——取出旧值后立即从磁盘抹除
		this.legacyE2eePassword = typeof raw.e2eePassword === "string" ? raw.e2eePassword : "";
		const hadLegacyRemember = raw.rememberE2eePassword === true;
		delete raw.e2eePassword;
		delete raw.rememberE2eePassword;

		this.settings = { ...DEFAULT_SETTINGS, ...raw };
		if (hadLegacyRemember) this.settings.trustDevice = true; // 语义等价迁移

		if (this.legacyE2eePassword !== "" || hadLegacyRemember) {
			await this.saveSettings(); // 立刻回写，把明文密码从 data.json 抹掉
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
