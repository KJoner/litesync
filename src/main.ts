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
import { enableE2ee } from "./crypto/migration";
import { HistoryModal } from "./history/history-view";
import { PasteLinkModal, registerImportHandler } from "./pairing/import-handler";
import { AddDeviceModal } from "./pairing/pairing-modal";
import { DEFAULT_SETTINGS, PluginSettings, SyncSettingTab } from "./settings";
import { ShareManageModal, ShareModal } from "./share/share-modal";
import { StateStore } from "./state/store";
import { SyncContext } from "./sync/context";
import { PendingQueue } from "./sync/queue";
import { SyncManager, SyncStatus } from "./sync/sync-manager";
import { IgnoreMatcher } from "./utils/ignore";

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
		}));

		// 移动端第一阶段不同步 Obsidian 配置目录：桌面与移动配置差异大，避免互相覆盖（v6）
		if (Platform.isMobileApp && this.settings.syncObsidian) {
			new Notice("移动端不同步 Obsidian 配置目录（桌面与移动端的界面配置互不兼容），普通笔记与附件不受影响");
		}

		const ctx: SyncContext = {
			app: this.app,
			client: this.client,
			store: this.store,
			queue: this.queue,
			syncObsidian: () => this.effectiveSyncObsidian(),
			ignores: (path) => this.ignoreMatcher?.ignores(path) ?? false,
			deviceName: () =>
				this.settings.deviceName || `device-${(this.store?.state.deviceId ?? "").slice(0, 8)}`,
			log: (msg) => {
				// 仅在用户显式开启 Debug 时输出；用 debug 级别不污染默认控制台
				if (this.settings.debug) console.debug(`[litesync] ${msg}`);
			},
			notify: (msg) => new Notice(msg, 8000),
			onConflictsChanged: () => this.updateStatus(this.lastStatus),
			e2ee: this.keyring,
			refreshE2ee: async () => {
				const doc = await this.client!.getVaultKey();
				this.keyring.setDoc(doc);
				if (this.store) this.store.state.e2ee = doc;
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
		void this.store?.save();
		this.openBootstrapWizard();
	}

	/** 重置为待接入（导入新配对配置后调用）。 */
	resetBootstrapState(): void {
		this.store?.resetBootstrap();
		void this.store?.save();
	}

	/** 「添加新设备」：生成一次性加密配对包并展示二维码/链接。 */
	openAddDeviceModal(): void {
		if (!this.client || !this.isConfigured()) {
			new Notice("请先在设置中填写 Server URL 和 API Token");
			return;
		}
		new AddDeviceModal(this.app, this.client, this.settings, this.getApiToken()).open();
	}

	/** 「导入配对链接」：手动粘贴其他设备生成的配对链接。 */
	openPasteLinkModal(): void {
		new PasteLinkModal(this.app, this).open();
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
		this.apiTokenValue = value;
		this.app.secretStorage.setSecret(API_TOKEN_SECRET_ID, value);
		if (this.settings.apiToken !== "") {
			this.settings.apiToken = "";
			await this.saveSettings();
		}
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
		const track = (file: TAbstractFile, action: "upsert" | "delete"): void => {
			// pull 应用远端变更产生的事件不入队（随后的扫描兜底覆盖用户同时的编辑）
			if (this.manager?.applyingRemote) return;
			if (this.ignoreMatcher?.ignores(file.path)) return;
			if (file instanceof TFile) {
				this.queue.add(file.path, action);
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
						if (path.startsWith(f.path + "/")) this.queue.add(path, "delete");
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
				// rename = 旧路径 delete + 新路径 upsert（第一版协议，见计划书第 23 节）
				if (f instanceof TFolder) {
					for (const path of this.store?.paths() ?? []) {
						if (path.startsWith(oldPath + "/")) this.queue.add(path, "delete");
					}
					for (const file of this.app.vault.getFiles()) {
						if (file.path.startsWith(f.path + "/") && !this.ignoreMatcher?.ignores(file.path)) {
							this.queue.add(file.path, "upsert");
						}
					}
				} else {
					if (!this.ignoreMatcher?.ignores(oldPath)) this.queue.add(oldPath, "delete");
					if (!this.ignoreMatcher?.ignores(f.path)) this.queue.add(f.path, "upsert");
				}
				this.scheduleDebounced();
			}),
		);
	}

	private scheduleDebounced(): void {
		if (!this.settings.autoSync || !this.isConfigured()) return;
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.manager?.sync("change");
		}, DEBOUNCE_MS);
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
				async () => {
					await this.manager!.sync("pre-migration");
				},
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
