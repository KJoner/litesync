import { Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { ApiClient } from "./api/client";
import { ConflictListModal } from "./conflict-ui/conflict-view";
import { HistoryModal } from "./history/history-view";
import { DEFAULT_SETTINGS, PluginSettings, SyncSettingTab } from "./settings";
import { StateStore } from "./state/store";
import { SyncContext } from "./sync/context";
import { PendingQueue } from "./sync/queue";
import { SyncManager, SyncStatus } from "./sync/sync-manager";
import { IgnoreMatcher } from "./utils/ignore";

/** 文件变化后延迟同步，避免连续输入时频繁上传。 */
const DEBOUNCE_MS = 3000;

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
	private intervalId: number | null = null;
	private lastStatus: SyncStatus = "idle";

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
		this.addRibbonIcon("refresh-cw", "Private Sync: 立即同步", () => void this.syncNow());

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !this.ctx) return;
				menu.addItem((item) =>
					item
						.setTitle("Private Sync: 版本历史")
						.setIcon("history")
						.onClick(() => new HistoryModal(this.ctx!, file.path).open()),
				);
			}),
		);

		// 等待 vault 索引就绪后再初始化，避免启动时的 create 事件风暴
		this.app.workspace.onLayoutReady(() => void this.initialize());
	}

	onunload(): void {
		this.manager?.dispose();
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		void this.store?.save();
	}

	private async initialize(): Promise<void> {
		const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		this.store = new StateStore(this.app.vault.adapter, `${pluginDir}/state.json`);
		await this.store.load();

		this.rebuildIgnoreMatcher();
		this.client = new ApiClient(() => ({
			serverUrl: this.settings.serverUrl,
			apiToken: this.settings.apiToken,
			deviceId: this.store?.state.deviceId ?? "",
		}));

		const ctx: SyncContext = {
			app: this.app,
			client: this.client,
			store: this.store,
			queue: this.queue,
			syncObsidian: () => this.settings.syncObsidian,
			ignores: (path) => this.ignoreMatcher?.ignores(path) ?? false,
			deviceName: () =>
				this.settings.deviceName || `device-${(this.store?.state.deviceId ?? "").slice(0, 8)}`,
			log: (msg) => {
				if (this.settings.debug) console.log(`[private-sync] ${msg}`);
			},
			notify: (msg) => new Notice(msg, 8000),
			onConflictsChanged: () => this.updateStatus(this.lastStatus),
		};
		this.ctx = ctx;
		this.manager = new SyncManager(ctx);
		this.manager.onStatus = (status, detail) => this.updateStatus(status, detail);

		this.registerVaultEvents();
		this.applySettings();

		if (this.settings.autoSync && this.isConfigured()) {
			void this.manager.sync("startup");
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
			this.intervalId = window.setInterval(() => {
				if (this.isConfigured()) void this.manager?.sync("interval");
			}, this.settings.syncIntervalSeconds * 1000);
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
		return this.settings.serverUrl !== "" && this.settings.apiToken !== "";
	}

	private rebuildIgnoreMatcher(): void {
		const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		this.ignoreMatcher = new IgnoreMatcher(
			this.settings.syncObsidian,
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
		let text = {
			idle: "Private Sync",
			syncing: "↻ Syncing",
			synced: "✓ Synced",
			conflict: "! Conflict",
			offline: "× Offline",
		}[status];
		// 有未解决冲突时优先显示计数，点击状态栏打开冲突列表
		const pending = this.store?.conflictPaths().length ?? 0;
		if (pending > 0 && status !== "syncing") {
			text = `! ${pending} Conflict${pending > 1 ? "s" : ""}`;
		}
		this.statusEl.setText(text);
		this.statusEl.setAttribute("aria-label", detail ?? text);
		this.statusEl.style.cursor = pending > 0 ? "pointer" : "default";
		this.statusEl.onclick = pending > 0 && this.ctx ? () => new ConflictListModal(this.ctx!).open() : null;
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<PluginSettings>) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
