import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import {
	ApiClient,
	ApiError,
	enrollDevice,
	fetchPairingEnvelope,
	IDENTITY_UNAVAILABLE_TEXT,
	isLoopbackUrl,
	protocolError,
	redeemDeviceEnrollment,
	RemoteVault,
} from "./api/client";
import { bootstrapLocalInit, preflight } from "./bootstrap/bootstrap-manager";
import { BootstrapWizardModal } from "./bootstrap/bootstrap-modal";
import { FirstSyncModal } from "./bootstrap/first-sync-modal";
import { ConflictListModal } from "./conflict-ui/conflict-view";
import {
	API_TOKEN_SECRET_ID,
	forgetTrustedDevice,
	loadTrustedVmk,
	persistTrustedDevice,
} from "./crypto/device-trust";
import { EnableE2eeModal, UnlockModal } from "./crypto/e2ee-modals";
import { Keyring } from "./crypto/keyring";
import { runUnlockFlow } from "./crypto/unlock-flow";
import { ConfirmMetaEncryptionModal } from "./crypto/meta-modals";
import {
	abortMetadataMigration,
	enableE2ee,
	enableE2eeOnEmptyRemote,
	encryptMetadata,
	upgradeEnvelopes,
} from "./crypto/migration";
import { HistoryModal } from "./history/history-view";
import { DeviceListModal } from "./pairing/device-list-modal";
import { PasteLinkModal, registerImportHandler, resumePendingRedeem } from "./pairing/import-handler";
import { consumePairing, PairingConfig } from "./pairing/pairing";
import { PairingTransport } from "./pairing/pairing-v2";
import { deviceManageUrl, OpenWebsiteModal, websiteUrl } from "./onboarding";
import { jobUnfinished, REPLACE_LOCK_OWNER } from "./bootstrap/replace-remote";
import { ReplaceRemoteModal } from "./bootstrap/replace-remote-modal";
import { AddDeviceModal } from "./pairing/pairing-modal";
import { DEFAULT_SETTINGS, PluginSettings, SyncSettingTab } from "./settings";
import { ShareManageModal, ShareModal } from "./share/share-modal";
import { PendingPairingTrust, StateStore } from "./state/store";
import { SyncContext } from "./sync/context";
import { SyncBlockedError, SyncGate, syncGateBlock } from "./sync/gate";
import { loadOrCreateSigningKey } from "./crypto/signing-key";
import { LocalCommitter } from "./sync/local-commit";
import { PendingQueue } from "./sync/queue";
import { SyncManager, SyncStatus } from "./sync/sync-manager";
import { IgnoreMatcher } from "./utils/ignore";
import { renderProbeReport, runPlatformProbe } from "./diagnostics/platform-probe";
import { nextFlushDelay, quantizeMtime } from "./utils/timing";
import { importVmk, VaultKeyDoc } from "./crypto/crypto";
import {
	advanceAfterProof,
	applyKeyPolicy,
	clearLegacyMaterial,
	keyPolicyLabel,
	migrationPending,
	persistenceExplicit,
	saveTrustSettingsVerified,
	TrustMigrationDeps,
} from "./crypto/trust-migration";
import { TrustMigrationModal } from "./crypto/trust-migration-modal";
import { PrimaryActionKind, SecondaryActionKind, StatusInput, statusBarLabel } from "./status-summary";

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
	/** 本设备签名公钥（常驻，不随登记清空；采纳配对信任锚时把自己加入信任集合） */
	private signingPublicKeyB64 = "";
	private client: ApiClient | null = null;
	private manager: SyncManager | null = null;
	private ctx: SyncContext | null = null;
	private ignoreMatcher: IgnoreMatcher | null = null;
	private statusEl: HTMLElement | null = null;
	private debounceTimer: number | null = null;
	private foregroundTimer: number | null = null;
	private intervalId: number | null = null;
	private lastStatus: SyncStatus = "idle";
	/** 本次运行最近一次成功同步的时刻（设置页状态卡；不落盘，避免每轮同步写 data.json） */
	private lastSyncAt = 0;
	/** 最近一次查询到的当前仓库名（状态卡；null = 尚未查询） */
	private currentVaultName: string | null = null;
	private keyring = new Keyring();
	/** 同步安全 Gate（v0.12.1）：手动命令与自动同步共用的许可判断 */
	private gate = new SyncGate();
	/** 接入向导单例标志（v8）：避免多个同步入口重复弹窗 */
	private wizardOpen = false;
	/** API Token 运行时值（真实存储在 Obsidian SecretStorage） */
	private apiTokenValue = "";
	/** 设置页实例：弹窗操作（解锁/启用 E2EE、重命名仓库）完成后就地刷新它 */
	private settingTab: SyncSettingTab | null = null;
	/** v3.1 迁移：旧版本明文保存的 E2EE 密码，仅在首次启动时用一次后即抹除 */
	private legacyE2eePassword = "";

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusEl = this.addStatusBarItem();
		this.updateStatus("idle");

		this.settingTab = new SyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
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
			name: "解锁仓库 (Unlock E2EE)",
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
			name: "已连接设备 (List devices)",
			callback: () => {
				if (this.client) this.openDeviceList();
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
		// 插件卸载（PL-01）：锁定并作废一切进行中的解锁与派生——晚到的结果不得在卸载后装上
		this.keyring.dispose();
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
		// 旧信任迁移（ADR-013）：补齐仓库身份；clearing 中途崩溃的先把清理做完
		await this.prepareTrustMigration();
		if (this.keyring.needsUnlock) {
			// ① 可恢复密钥持久化（用户显式开启，或旧版本遗留、迁移完成前照常可用）：
			// 设备密钥 + SecretStorage 中的包装 VMK。严格模式下两者都不存在，这里自然跳过
			if (this.settings.trustDevice && this.settings.deviceKeyB64 && this.keyring.doc) {
				const raw = await loadTrustedVmk(this.app, this.settings.deviceKeyB64, this.keyring.doc);
				if (raw) {
					try {
						await this.keyring.unlockWithRaw(raw);
					} finally {
						raw.fill(0);
					}
				}
			}
			// ② v3.1 迁移：旧版明文密码只用来解锁**本次运行**，随即从磁盘抹除。
			// 0.20 起不再顺手把它转成设备信任——那会凭空制造出可自动解锁的材料
			if (this.keyring.needsUnlock && this.legacyE2eePassword) {
				if ((await this.keyring.unlock(this.legacyE2eePassword)) === "unlocked") {
					new Notice("已从磁盘移除旧版本保存的明文仓库密码。本次运行已解锁，下次启动需要重新输入。");
				}
			}
			this.legacyE2eePassword = "";
		}

		this.rebuildIgnoreMatcher();
		this.client = new ApiClient(() => ({
			vaultChoice: this.settings.vaultChoice,
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
			this.signingPublicKeyB64 = signing.publicKeyB64;
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
			// 时间混淆（§11.2 / 验收 T4.5）：定时/前台/启动/重试的轮次只拉不推——
			// 上传只在窗口发车点（sync("change")）或用户显式动作时发生
			deferPush: (reason) =>
				this.settings.obfuscateTiming && ["interval", "foreground", "startup", "retry"].includes(reason),
			onPushDeferred: () => this.scheduleDebounced(),
			ignores: (path) => this.ignoreMatcher?.ignores(path) ?? false,
			deviceName: () =>
				this.settings.deviceName || `device-${(this.store?.state.deviceId ?? "").slice(0, 8)}`,
			pluginDir: () => pluginDir,
			signingKeyPkcs8: () => this.signingKeyPkcs8,
			signingPublicKey: () => this.pendingSigningPublicKey,
			onSigningKeyRegistered: () => void (this.pendingSigningPublicKey = ""),
			deviceSigningPublicKey: () => this.signingPublicKeyB64,
			log: (msg) => {
				// 仅在用户显式开启 Debug 时输出；用 debug 级别不污染默认控制台
				if (this.settings.debug) console.debug(`[litesync] ${msg}`);
			},
			notify: (msg, durationMs) => new Notice(msg, durationMs ?? 8000),
			onConflictsChanged: () => this.updateStatus(this.lastStatus),
			e2ee: this.keyring,
			credentials: () => ({
				serverUrl: this.settings.serverUrl,
				apiToken: this.getApiToken(),
				vaultChoice: this.settings.vaultChoice,
			}),
			refreshE2ee: async () => {
				const before = this.keyring.doc;
				// 取回的文档属于发起请求时的连接（PL-01）：期间换了服务器 / 凭据 / 仓库就作废，
				// 本轮同步失败、下一轮按新连接重取——绝不把旧仓库的文档装进新连接的密钥环
				const context = this.keyring.contextGeneration;
				const doc = await this.client!.getVaultKey();
				if (context !== this.keyring.contextGeneration) {
					throw new Error("取回密钥文档期间连接发生了变化（换了服务器、凭据或仓库），本轮作废，稍后按新连接重试");
				}
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
		// 上次运行停在「已证明、待清理」的迁移：不需要用户再输入任何东西，自动走完
		void this.resumeTrustMigration();
		// 未完成的「用本地完整替换远端」作业：用户决定续跑或放弃之前，普通同步保持暂停
		const rj = this.store.state.replaceJob;
		if (rj && jobUnfinished(rj) && !rj.bootstrapContext) {
			this.holdReplaceGate();
			new Notice(
				"LiteSync：有一个未完成的「用本地完整替换远端」作业，普通同步已暂停。\n" +
					"打开 设置 → LiteSync → 高级 → 高级恢复，查看进度后继续、放弃或回滚。",
				15000,
			);
		}
		// 上次的设备连接兑换没收到响应（断网/崩溃）：提示用同一个兑换编号继续
		void this.resumePendingRedeem();
	}

	// ---------- 严格会话解锁与旧信任迁移（v0.20 / ADR-013） ----------

	private async prepareTrustMigration(): Promise<void> {
		const tm = this.settings.trustMigration;
		if (!tm) return;
		const vid = this.store?.state.bootstrap.remoteVaultId ?? "";
		if (!tm.vaultIdentity && vid) {
			tm.vaultIdentity = vid;
			await this.saveSettings();
		}
		// clearing 之后崩溃：恢复能力早已证明，先把清理做完（幂等），本次不再自动解锁
		if (tm.state === "clearing") await clearLegacyMaterial(this.trustDeps());
	}

	private async resumeTrustMigration(): Promise<void> {
		const tm = this.settings.trustMigration;
		if (!tm) return;
		if (tm.state === "recovery_proven" || tm.state === "pending_writes_handled") {
			const r = await advanceAfterProof(this.trustDeps());
			if (r.ok && r.state === "strict_mode") new Notice("LiteSync：已完成迁移到严格会话解锁");
			this.refreshSettingsTab();
			return;
		}
		if (tm.state === "legacy_trust_found" && !tm.noticeShown) {
			tm.noticeShown = true;
			await this.saveSettings();
			new Notice(
				"LiteSync：本设备仍在使用旧的「信任此设备」模式（待迁移）。\n" +
					"打开 设置 → LiteSync → 加密与设备，验证仓库密码后即可切换到严格会话解锁。",
				15000,
			);
		}
	}

	/** 迁移逻辑的 I/O 组装（ADR-013）。 */
	trustDeps(): TrustMigrationDeps {
		// 迁移窗口打开期间换了连接（PL-01）：重包装后的新文档不再装进密钥环
		const context = this.keyring.contextGeneration;
		return {
			settings: this.settings,
			// 迁移的每一次落盘都读回核对：宿主的 saveData 写失败时不抛错（WIN-12 真机实测：data.json 只读）
			saveSettings: () =>
				saveTrustSettingsVerified(
					() => this.saveSettings(),
					async () => {
						try {
							const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
							return await this.app.vault.adapter.read(`${dir}/data.json`);
						} catch {
							return null;
						}
					},
					this.settings,
				),
			secrets: this.app.secretStorage,
			fetchKeyDoc: async () => {
				if (!this.client || !this.isConfigured()) throw new Error("not configured");
				return this.client.getVaultKeyWithFingerprint();
			},
			replaceKeyDoc: async (doc, fingerprint) => {
				if (!this.client) throw new Error("not configured");
				await this.client.putVaultKey(doc, true, fingerprint);
			},
			cachedKeyDoc: () => this.store?.state.e2ee ?? this.keyring.doc,
			onKeyDocReplaced: async (doc, vmkRaw) => {
				// 同一把 VMK、新的包装：密钥环保持解锁（setDoc 会因 wrappedKey 变化而锁定），
				// 本地缓存换成新文档；vault key 材料变了 → 绑定必须重新校验（LS-121-C02）
				this.keyring.adopt(doc, await importVmk(vmkRaw), context);
				if (this.store) {
					this.store.state.e2ee = doc;
					await this.store.save();
				}
				this.invalidateBinding("仓库密钥文档已用新密码重新包装");
			},
			pendingWrites: async () => {
				if (!this.store) return { count: this.queue.size, durable: false };
				// 入队即落盘（§6.3）；这里再落一次盘并确认状态文件健康，才算「已在 durable journal 中」
				await this.store.save();
				return { count: this.queue.size, durable: !this.store.corrupted };
			},
			drainQueue: async () => {
				if (!this.manager || !this.bootstrapReady || this.keyring.needsUnlock || this.queue.size === 0) return;
				await this.manager.fullSync("trust-migration");
			},
			now: () => Date.now(),
		};
	}

	openTrustMigrationModal(): void {
		new TrustMigrationModal(this.app, this.trustDeps(), () => this.refreshSettingsTab()).open();
	}

	/** 是否有尚未完成的旧信任迁移（设置页据此显示「旧设备信任待迁移」）。 */
	trustMigrationPending(): boolean {
		return migrationPending(this.settings);
	}

	/** 当前密钥策略的一句话说明。 */
	keyPolicyText(): string {
		return keyPolicyLabel(this.settings);
	}

	/** 解锁/启用弹窗里的策略提示：这次解锁会不会在本设备留下可自动还原密钥的材料。 */
	private unlockNote(): string {
		if (migrationPending(this.settings)) {
			return "本设备仍在使用旧的「信任此设备」模式（待迁移）。迁移入口在 设置 → 加密与设备。";
		}
		if (persistenceExplicit(this.settings)) {
			return "你开启了「本设备自动解锁」：解锁后会在本设备保存可自动还原密钥的材料（可在 设置 → 高级 中关闭）。";
		}
		return "严格会话解锁：只在本次运行有效，锁定、切换仓库或重启 Obsidian 后需要重新输入。";
	}

	/** 用户显式开启了「可恢复密钥持久化」时，在拿到密钥后写入本设备材料。 */
	private async maybePersistTrust(): Promise<void> {
		if (persistenceExplicit(this.settings)) await this.persistTrust();
	}

	// ---------- Bootstrap（首次接入向导，v8） ----------

	get bootstrapReady(): boolean {
		return this.store?.bootstrapReady ?? false;
	}

	/** opts.linkVaultId：刚兑换的连接链接指定并核对过的仓库（向导据此跳过选库页，见 linkedVaultToSkip）。 */
	openBootstrapWizard(opts: { linkVaultId?: string } = {}): void {
		if (this.wizardOpen || !this.ctx) return;
		if (!this.isConfigured()) {
			new Notice("请先在设置中填写 Server URL 和 API Token");
			return;
		}
		this.wizardOpen = true;
		new BootstrapWizardModal(this.app, this.ctx, {
			setVaultChoice: (id) => this.setVaultChoice(id),
			vaultChoice: () => this.settings.vaultChoice,
			linkVaultId: opts.linkVaultId,
			keyNote: () => this.unlockNote(),
			replaceRemoteEnabled: () => this.settings.replaceRemoteEnabled,
			repairPairing: () => this.openPasteLinkModal(),
			afterKeyAvailable: () => this.maybePersistTrust(),
			setApiToken: (t) => this.setApiToken(t),
			openUnlock: (onUnlocked) => this.openUnlockModal(onUnlocked),
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
			new Notice("请先连接仓库");
			return;
		}
		new AddDeviceModal(this.app, this.client, this.settings, () => ({
			anchor: this.store?.state.trustAnchor ?? null,
			repoEpoch: this.store?.state.bootstrap.repoEpoch,
			bootstrapReady: this.bootstrapReady,
		})).open();
	}

	// ---------- 连接链接导入（0.20 / ADR-014） ----------

	/** 配对网络 I/O（新设备此刻没有凭据，全部是公开端点）。 */
	pairingTransport(): PairingTransport {
		return {
			fetchEnvelope: (server, id) => fetchPairingEnvelope(server, id),
			redeem: (server, req) => redeemDeviceEnrollment(server, req),
			consumeLegacy: (server, id) => consumePairing(server, id),
			enrollLegacy: (server, secret, name) => enrollDevice(server, secret, name),
		};
	}

	/** 兑换时上报的设备名（设置里没填时按平台给一个能认出来的默认名）。 */
	deviceNameForEnrollment(): string {
		if (this.settings.deviceName) return this.settings.deviceName;
		if (Platform.isIosApp) return "iPhone / iPad 上的 Obsidian";
		if (Platform.isAndroidApp) return "Android 上的 Obsidian";
		return "桌面 Obsidian";
	}

	/**
	 * 写入导入的连接配置（凭据进 SecretStorage）并把本设备重置为待接入。
	 *
	 * 一个本地 Obsidian 库同一时刻只绑定一个远端仓库：改连 = 作废绑定、暂停原同步，
	 * 旧账本在向导 preflight 发现归属不符时作废（本地笔记一个都不动）。
	 */
	async applyPairingConfig(
		config: PairingConfig,
		credential: string,
		v2: {
			vaultId: string;
			vaultIdentity: string;
			anchor: PendingPairingTrust["anchor"] | null;
		} | null,
	): Promise<void> {
		const url = config.serverUrl.trim().replace(/\/+$/, "");
		// 安全红线（v9）：凭据绝不走明文 HTTP 出本机
		if (/^http:\/\//i.test(url) && !isLoopbackUrl(url)) {
			throw new Error("连接配置中的服务器地址是非本机的 http://，已拒绝导入（凭据会被明文暴露）");
		}
		// 换连接 = 可能换了服务器、账号与仓库（PL-01）：立即锁定并丢弃旧密钥文档，
		// 进行中的解锁一并作废；新仓库的文档由接入向导的 preflight 重新取
		this.keyring.switchContext({ lock: true });
		this.settings.serverUrl = url;
		if (typeof config.syncIntervalSeconds === "number") this.settings.syncIntervalSeconds = config.syncIntervalSeconds;
		if (typeof config.syncObsidian === "boolean") this.settings.syncObsidian = config.syncObsidian;
		if (typeof config.ignorePatterns === "string") this.settings.ignorePatterns = config.ignorePatterns;
		// v2：凭据绑定的仓库就是核对过的那一个；旧包没有仓库信息 → 用账户默认仓库
		this.settings.vaultChoice = v2?.vaultId ?? "";
		this.currentVaultName = config.selectedVault?.displayName ?? null;
		await this.setApiToken(credential);
		await this.saveSettings();
		this.applySettings();
		this.resetBootstrapState();
		if (this.store) {
			this.store.state.pendingPairingTrust =
				v2?.anchor && v2.vaultIdentity
					? { vaultIdentity: v2.vaultIdentity, anchor: v2.anchor, receivedAt: Date.now() }
					: null;
			await this.store.save();
		}
	}

	/** 上次兑换没收到响应：在服务端保留窗口内用同一个兑换编号续传。 */
	private async resumePendingRedeem(): Promise<void> {
		await resumePendingRedeem(this);
	}

	// ---------- 高级恢复：用本地完整替换远端（0.20 / ADR-016） ----------

	/** 作业执行期间（及中断后、用户决定之前）冻结普通同步。 */
	private replaceGateHeld = false;

	private holdReplaceGate(): void {
		if (this.replaceGateHeld) return;
		// 别的迁移（路径加密、信封升级、启用 E2EE）正持有迁移锁：不抢它的锁（PL-03）——
		// 作业的执行许可会因为这把不属于自己的锁而挡停，等那个迁移结束再继续
		if (this.gate.isMigrationActive && this.gate.migrationLockOwner !== REPLACE_LOCK_OWNER) return;
		this.gate.beginMigration("「用本地完整替换远端」作业", REPLACE_LOCK_OWNER);
		this.replaceGateHeld = true;
	}

	private releaseReplaceGate(): void {
		if (!this.replaceGateHeld) return;
		this.gate.endMigration();
		this.replaceGateHeld = false;
	}

	/**
	 * 是否有需要用户处理的替换作业（设置页据此在执行入口关闭时仍显示「诊断、放弃或回滚」）：
	 * 未完成的作业，或已部分/全部完成、可以生成反向作业的正向作业。
	 */
	replaceJobNeedsAttention(): boolean {
		const j = this.store?.state.replaceJob ?? null;
		if (j === null || j.bootstrapContext) return false;
		if (jobUnfinished(j)) return true;
		return j.kind === "local-replace-remote" && j.items.some((i) => i.status === "done");
	}

	/** 设置页 → 高级 → 高级恢复（已接入的设备）。 */
	openReplaceRemote(): void {
		if (!this.ctx || !this.manager || !this.client || !this.bootstrapReady) {
			new Notice("请先完成接入");
			return;
		}
		if (this.keyring.needsUnlock) {
			new Notice("请先解锁仓库");
			this.openUnlockModal();
			return;
		}
		void (async () => {
			let name = this.currentVaultName ?? "";
			try {
				const cur = (await this.client!.listVaults()).find((v) => v.current);
				if (cur) name = cur.name;
			} catch {
				/* 旧服务器没有 vaults 端点：用默认短语确认 */
			}
			new ReplaceRemoteModal(this.app, this.ctx!, {
				bootstrapContext: false,
				// 阶段保护（0.20.1）：关闭时只读预览 + 诊断/放弃/回滚，正向执行不可用
				executionEnabled: this.settings.replaceRemoteEnabled,
				vaultName: name,
				vaultChoice: this.settings.vaultChoice,
				// 先等同步收敛：待推送队列里的本地修改若不先推完，作业的预览与真实状态不一致
				beforePlan: async () => {
					await this.manager!.fullSync("pre-replace");
				},
				// 续跑前先完成一次权威绑定校验（重启后 gate 处于 unbound；作业冻结期间同步轮只做校验、不推拉）
				beforeResume: async () => {
					await this.manager!.sync("replace-resume");
				},
				holdSync: () => this.holdReplaceGate(),
				releaseSync: () => this.releaseReplaceGate(),
				onCompleted: async () => {
					void this.manager?.sync("replace-done");
				},
			}).open();
		})();
	}

	/** 打开网页注册/登录（已知服务器时直接打开，否则先问地址）。 */
	openWebsite(): void {
		const url = websiteUrl(this.settings.serverUrl);
		if (url) {
			window.open(url);
			return;
		}
		new OpenWebsiteModal(this.app, (u) => window.open(u)).open();
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
			new Notice("请先解锁仓库（命令「解锁仓库」）");
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
		// 手动同步必须有一条明确的结果消息（0.19.x 实测反馈：状态栏太隐蔽，
		// 「没反应」分不清是同步成功还是失败）。仅手动触发弹——自动同步照旧安静
		const err = this.manager.lastSyncError;
		if (err) {
			new Notice(`同步失败：${err.message}`, 8000);
			return;
		}
		const block = this.ctx ? syncGateBlock(this.ctx) : null;
		if (block) {
			new Notice(`同步未执行：${block.message}`, 8000);
			return;
		}
		const c = this.manager.lastSyncCounters;
		if (!c) {
			new Notice("同步未执行：请查看状态栏或稍后重试");
			return;
		}
		const detail = c.pulled > 0 || c.pushed > 0 ? `下载 ${c.pulled}、上传 ${c.pushed}` : "已是最新";
		new Notice(
			c.conflicts > 0
				? `同步完成：${detail}，${c.conflicts} 个冲突待处理（命令面板 → 解决同步冲突）`
				: `同步完成 ✓ ${detail}`,
		);
	}

	/** 返回给设置页展示的消息；null 表示已改为弹出「首次配置三选项」对话框。 */
	async testConnection(): Promise<string | null> {
		if (!this.client) return "插件尚未初始化完成，请稍候";
		if (!this.isConfigured()) return "请先填写 Server URL 和 API Token";
		try {
			const info = await this.client.info();
			const perr = protocolError(info);
			if (perr) return perr;
			// 首次配置（0.17.0-rc.3；0.19.x 起强制 E2EE）：远端未初始化且本设备未接入 → 首次配置对话框。
			// 「已启用 E2EE 但 0 个文件」不算未初始化——那是第二台设备接入的形状，
			// 必须走接入向导的解锁门，绝不能在这里提供「添加 E2EE」
			// 配对包带着继承的可信检查点（PL-06）：先进接入向导核验，绝不在核验之前就往服务器写东西
			//（首次配置对话框会立刻启用 E2EE、写入密钥文档）
			if (!this.bootstrapReady && this.store?.state.pendingPairingTrust) {
				this.openBootstrapWizard();
				return null;
			}
			if (
				(info.latestSequence ?? 0) === 0 &&
				(info.encryptionState ?? "plaintext") === "plaintext" &&
				!this.bootstrapReady &&
				this.ctx !== null &&
				this.manager !== null
			) {
				// v0.19 多仓库：名下不止一个仓库时，先让用户在向导里选清楚目标，
				// 再谈初始化——三选项默认作用于当前指向的仓库，多仓库下容易选错对象
				if (await this.hasMultipleVaults()) {
					this.openBootstrapWizard();
					return null;
				}
				new FirstSyncModal(this.app, {
					withE2ee: () => this.openFirstSyncE2eeModal(),
				}).open();
				return null;
			}
			// 闭环（v0.18 / v11 设计 §4.6）：连接验证成功而 gate 还停在「凭据被拒」
			//（Token 重置/设备撤销后刚填入新 Token 的场景）→ 立即触发一轮同步。
			// 同步的 ensureBinding 会重新校验、换发设备凭据、撤下常驻通知——
			// 用户看到「连接成功」的同时状态栏还挂着 Offline，会以为没生效
			if (this.manager && this.gate.sessionBlock()?.reason === "credential-rejected") {
				this.manager.resetRetry();
				void this.manager.sync("manual");
				return `连接成功：服务器版本 ${info.version}，正在恢复同步…`;
			}
			return `连接成功：服务器版本 ${info.version}，latestSequence=${info.latestSequence}`;
		} catch (e) {
			return `连接失败：${e instanceof Error ? e.message : String(e)}`;
		}
	}

	/** local-init 接入并触发首轮同步（远端已非空则转交向导）；由 E2EE 启用回调复用。 */
	private async firstSyncNow(): Promise<void> {
		const pre = await preflight(this.ctx!);
		if (pre.remoteFiles.length > 0) {
			// 竞态兜底：点按钮前另一台设备已初始化了远端 → 绝不盲目 local-init
			new Notice("远端仓库已有内容，转入接入向导");
			this.openBootstrapWizard();
			return;
		}
		await bootstrapLocalInit(this.ctx!, pre);
		this.updateStatus("idle");
		new Notice("已初始化，开始首次同步");
		void this.manager!.sync("bootstrap");
	}

	/** 首次配置「设置 E2EE 并立即同步」：空仓启用（无迁移）→ local-init → 首轮同步即密文。 */
	private openFirstSyncE2eeModal(): void {
		new EnableE2eeModal(
			this.app,
			this.unlockNote(),
			async (password) => {
				await enableE2eeOnEmptyRemote(this.ctx!, password);
				await this.maybePersistTrust();
				// 必须在启用 E2EE 之后重跑 preflight：completeBootstrap 会把 pending binding
				// 里的 keyEpoch 写进正式 binding，用启用前的旧值（0）会产出 AAD 错绑的密文
				await this.firstSyncNow();
				this.refreshSettingsTab();
				return 0;
			},
			{
				note: "远端仓库还是空的：设好密码即刻生效，随后的首次上传就是密文——没有迁移过程，明文不会经过服务器。",
				success: () => "端到端加密已启用，正在进行首次同步（全部内容以密文上传）✓",
			},
		).open();
	}

	/**
	 * 让打开着的设置页立刻反映刚完成的操作（解锁/启用 E2EE、重命名仓库）。
	 * 弹窗是异步交互——设置页按钮点击时的 update() 发生在用户输入之前，
	 * 真正的状态变化要在**成功回调**里主动刷新，否则页面停留在旧状态
	 * 直到用户离开再进来（0.19.x 实测反馈）。
	 */
	refreshSettingsTab(): void {
		this.settingTab?.refresh();
	}

	/** 名下仓库列表（设置页「当前仓库」展示用；client 为 private，经此公开）。 */
	async listRemoteVaults(): Promise<RemoteVault[]> {
		if (!this.client) throw new Error("插件尚未初始化完成");
		return this.client.listVaults();
	}

	/** 重命名仓库（设置页入口；用户级 Token 专属，设备凭据会被服务端拒绝）。 */
	async renameRemoteVault(id: string, name: string): Promise<void> {
		if (!this.client) throw new Error("插件尚未初始化完成");
		await this.client.renameVault(id, name);
	}

	/** 名下是否有多个仓库（v0.19）；旧服务器/查询失败按单仓库处理。 */
	private async hasMultipleVaults(): Promise<boolean> {
		try {
			return ((await this.client?.listVaults()) ?? []).length > 1;
		} catch {
			return false;
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
		if (changed) {
			// 凭据变了（PL-01）：进行中的解锁与密钥文档请求作废；已装好的钥匙保留——
			// v0.18 重置 Token 的恢复路径（填新 Token → 测试连接 → 继续同步）靠它。
			// 真换了账号 / 仓库时，vaultId 对账与密钥文档刷新会锁定
			this.keyring.switchContext({ lock: false });
			this.invalidateBinding("API Token 已变化");
		}
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
	/**
	 * 设置目标仓库（v0.19 多仓库）。只由接入向导调用——切换仓库 = 重新接入，
	 * 账本作废由 vaultId 变化的防线兜底，这里立即作废绑定触发重新校验。
	 */
	async setVaultChoice(vaultId: string): Promise<void> {
		if (this.settings.vaultChoice === vaultId) return;
		// 切库立即锁定（复审 PL-01）：旧仓库的钥匙与密钥文档绝不跟到新仓库，
		// 进行中的解锁、派生与密钥文档请求一并作废；新仓库的文档由向导 preflight 重新取
		this.keyring.switchContext({ lock: true });
		if (this.store) this.store.state.e2ee = null;
		this.settings.vaultChoice = vaultId;
		await this.saveSettings();
		this.invalidateBinding("目标仓库已切换");
	}

	/** 设置页改了 Server URL：换服务器 = 换账号与仓库（PL-01），锁定并作废旧连接上的一切进行中任务。 */
	onServerUrlChanged(): void {
		this.keyring.switchContext({ lock: true });
		this.invalidateBinding("Server URL 已变化");
	}

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
		if (status === "synced" || status === "conflict") this.lastSyncAt = Date.now();
		// 打开着的设置页跟着变（状态卡就地重绘；连接、接入完成这类结构变化整页重绘）。
		// 所有状态变化都经过这里：连接链接兑换、接入向导完成、锁定 / 解锁、凭据被拒、每轮同步
		this.settingTab?.stateChanged();
		if (!this.statusEl) return;
		this.lastStatus = status;
		// 有未解决冲突时优先显示计数，点击状态栏打开冲突列表（文字与状态卡同一套词，UI 焕新 U5b）
		const pending = this.store?.conflictPaths().length ?? 0;
		const { text, tip } = statusBarLabel({
			status,
			conflicts: pending,
			credentialRejected: this.gate.sessionBlock()?.reason === "credential-rejected",
			online: typeof navigator === "undefined" || navigator.onLine !== false,
			detail,
		});
		this.statusEl.setText(text);
		this.statusEl.setAttribute("aria-label", tip);
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

	// ---------- 设置页状态卡（v0.20 / UI 规格 D06） ----------

	/** 是否已填写服务器与凭据（设置页据此切换新手入口与日常入口）。 */
	get configured(): boolean {
		return this.isConfigured();
	}

	/** 状态卡输入：只读快照。 */
	statusInput(): StatusInput {
		return {
			configured: this.isConfigured(),
			bootstrapReady: this.bootstrapReady,
			credentialRejected: this.gate.sessionBlock()?.reason === "credential-rejected",
			e2ee: !this.keyring.enabled ? "disabled" : this.keyring.needsUnlock ? "locked" : "unlocked",
			vaultName: this.currentVaultName,
			lastSyncAt: this.lastSyncAt,
			conflicts: this.store?.conflictPaths().length ?? 0,
			migrationPending: migrationPending(this.settings),
			keyPolicyText: keyPolicyLabel(this.settings),
			syncing: this.manager?.isSyncing ?? false,
			// 账号中心暂时无法确认登录状态（503 IDENTITY_UNAVAILABLE）：状态卡如实告知，主按钮不变、不提示重新连接
			retryNotice: (() => {
				const err = this.manager?.lastSyncError;
				return err instanceof ApiError && err.is("IDENTITY_UNAVAILABLE") ? IDENTITY_UNAVAILABLE_TEXT : null;
			})(),
			now: Date.now(),
		};
	}

	/** 记住当前仓库名（设置页查询到后调用；只在内存里）。 */
	rememberVaultName(name: string): void {
		if (this.currentVaultName === name) return;
		this.currentVaultName = name;
		this.settingTab?.stateChanged(); // 状态卡补上仓库名
	}

	runPrimaryAction(kind: PrimaryActionKind): void {
		switch (kind) {
			case "connect":
			case "reconnect":
				this.openPasteLinkModal();
				return;
			case "finish-setup":
				this.openBootstrapWizard();
				return;
			case "unlock":
				this.openUnlockModal();
				return;
			case "sync-now":
				void this.syncNow().then(() => this.refreshSettingsTab());
				return;
		}
	}

	runSecondaryAction(kind: SecondaryActionKind): void {
		if (kind === "migrate") this.openTrustMigrationModal();
		else if (this.ctx) new ConflictListModal(this.ctx).open();
	}

	/** 打开冲突列表（设置页「同步选项」）。 */
	openConflicts(): void {
		if (this.ctx) new ConflictListModal(this.ctx).open();
	}

	/** 当前笔记的版本历史（设置页「恢复与帮助」；与命令「文件版本历史」相同）。 */
	openActiveFileHistory(): void {
		if (!this.ctx) {
			new Notice("请先连接仓库");
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("先打开一个笔记，再查看它的版本历史（也可以在文件菜单里选「LiteSync: 版本历史」）");
			return;
		}
		new HistoryModal(this.ctx, file.path).open();
	}

	/** 设备列表（设置页「连接与仓库」节）。 */
	openDeviceList(): void {
		// UI 焕新 U5（UX-06）：撤销在网页的「账号与设备」里做（当前服务器的 /#/me，保留子路径），不需要根 Token。
		if (this.client && this.isConfigured()) new DeviceListModal(this.app, this.client, deviceManageUrl(this.settings.serverUrl), (u) => window.open(u)).open();
		else new Notice("请先连接仓库");
	}

	// ---------- E2EE ----------

	/** 设置页的 E2EE 状态与按钮文案。 */
	e2eeStatusText(): { desc: string; action: string } {
		// 刚连接、还没完成接入：本设备还没取到这个仓库的密钥文档，看不出它加没加密（接入向导会处理）
		if (!this.keyring.enabled && !this.bootstrapReady) {
			return { desc: "完成接入时确认这个仓库是否端到端加密（加密仓库需要输入仓库密码）", action: "完成接入…" };
		}
		if (!this.keyring.enabled) {
			return { desc: "未启用：服务器保存明文（仅 HTTPS 传输加密）", action: "启用端到端加密…" };
		}
		if (this.keyring.needsUnlock) {
			return { desc: "已启用 · 🔒 已锁定（同步暂停，待同步的修改保留在本机）", action: "解锁…" };
		}
		return { desc: "已启用 · 🔓 已解锁（本次运行有效）。锁定只暂停本设备的同步与解密，本机笔记仍可阅读", action: "锁定" };
	}

	async e2eeAction(): Promise<void> {
		if (!this.keyring.enabled && !this.bootstrapReady) {
			// 与 e2eeStatusText 一致：没完成接入前不提供「启用端到端加密」（那会被同步许可挡下），交给接入向导
			this.openBootstrapWizard();
			return;
		}
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
		new Notice("已锁定：本设备暂停同步与解密，本机笔记仍可阅读和编辑");
	}

	/**
	 * 打开 E2EE 解锁弹窗。onUnlocked：接入向导传入——解锁成功后原地继续
	 * 向导流程（弹窗叠加、向导不关），代替默认的「重开向导」（那会让用户
	 * 把选仓库和接入方式各走两遍）。
	 */
	openUnlockModal(onUnlocked?: () => void): void {
		new UnlockModal(this.app, this.unlockNote(), async (password, isCancelled) => {
			if (!this.client) return "插件尚未初始化完成";
			const client = this.client;
			// 每段异步完成后核对会话（PL-01）：关窗口、锁定、切库、换连接、卸载 → 整体作废
			const r = await runUnlockFlow(
				{
					keyring: this.keyring,
					// 新设备可能还没有缓存 vault key 文档，先从服务器获取
					fetchKeyDoc: () => client.getVaultKey(),
					storeKeyDoc: async (doc) => {
						if (this.store) {
							this.store.state.e2ee = doc;
							await this.store.save();
						}
					},
					afterUnlocked: () => this.maybePersistTrust(),
				},
				password,
				isCancelled,
			);
			if (!r.ok) return r.message;
			new Notice("仓库已解锁 ✓");
			this.updateStatus("idle");
			this.refreshSettingsTab();
			if (onUnlocked) {
				// 向导内解锁：原地继续向导（接入完成时 onDone 自会触发同步）
				onUnlocked();
			} else if (!this.bootstrapReady) {
				// 向导外解锁且未接入：回到接入向导
				this.openBootstrapWizard();
			} else {
				void this.manager?.sync("unlock");
			}
			return null;
		}).open();
	}

	openEnableModal(): void {
		if (!this.ctx || !this.manager) {
			new Notice("插件尚未初始化完成，请稍候");
			return;
		}
		new EnableE2eeModal(this.app, this.unlockNote(), async (password, onProgress) => {
			const migrated = await enableE2ee(
				this.ctx!,
				password,
				// fullSync：等待当前轮 + 所有续轮 + 队列排空（LS-121-C06）
				() => this.manager!.fullSync("pre-e2ee-migration"),
				onProgress,
			);
			await this.maybePersistTrust();
			this.updateStatus("synced");
			this.refreshSettingsTab();
			return migrated;
		}).open();
	}

	// ---------- Trusted Device ----------

	/** 是否存在可用的设备信任（用于设置页显示「清除自动解锁材料并锁定」）。 */
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

	/**
	 * 开关「可恢复密钥持久化」（高级区，显式选择）：开 → 立即持久化（若已解锁）；关 → 删除本地材料。
	 *
	 * 旧版本遗留的材料尚未证明可恢复时（ADR-013），开关**不能**直接删它——
	 * 对忘了密码的用户那可能是唯一的钥匙。此时改为打开迁移向导，返回 false。
	 */
	async setTrustDevice(value: boolean): Promise<boolean> {
		if (migrationPending(this.settings)) {
			this.openTrustMigrationModal();
			return false;
		}
		this.settings.trustDevice = value;
		if (value) {
			// 显式开启：不再是「旧版本默认留下来的」，迁移记录作废
			this.settings.trustMigration = null;
			await this.saveSettings();
			await this.persistTrust();
		} else {
			forgetTrustedDevice(this.app);
			this.settings.deviceKeyB64 = "";
			await this.saveSettings();
		}
		return true;
	}

	/** 清除自动解锁材料并锁定（旧称「忘记此设备」）：删除设备信任并立即锁定（旧材料未证明可恢复时转交迁移向导）。 */
	async forgetThisDevice(): Promise<void> {
		if (migrationPending(this.settings)) {
			this.openTrustMigrationModal();
			return;
		}
		forgetTrustedDevice(this.app);
		this.settings.trustDevice = false;
		this.settings.deviceKeyB64 = "";
		await this.saveSettings();
		this.keyring.lock();
		this.updateStatus("locked");
		new Notice("已清除本设备的自动解锁材料并锁定；下次需要重新输入仓库密码");
	}

	async loadSettings(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;

		// v3.1 迁移：明文 E2EE 密码绝不再持久化——取出旧值后立即从磁盘抹除
		this.legacyE2eePassword = typeof raw.e2eePassword === "string" ? raw.e2eePassword : "";
		const hadLegacyRemember = raw.rememberE2eePassword === true;
		delete raw.e2eePassword;
		delete raw.rememberE2eePassword;

		this.settings = { ...DEFAULT_SETTINGS, ...raw };
		if (hadLegacyRemember) this.settings.trustDevice = true; // 语义等价迁移（随后由密钥策略处理）

		// 密钥策略迁移（0.20 / ADR-013）：只执行一次。旧材料完整 → 进入待迁移；
		// 不完整（还原不出 VMK）→ 直接严格；新安装 → 什么都不做
		const policyChanged = applyKeyPolicy(this.settings, this.app.secretStorage, {
			vaultIdentity: "",
			now: Date.now(),
		});

		if (this.legacyE2eePassword !== "" || hadLegacyRemember || policyChanged) {
			await this.saveSettings(); // 立刻回写，把明文密码从 data.json 抹掉
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
