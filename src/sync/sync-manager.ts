import { protocolError } from "../api/client";
import { E2eeLockedError } from "../crypto/keyring";
import { SyncContext, SyncCounters } from "./context";
import { pullRemoteChanges } from "./pull";
import { pushPendingChanges, scanLocalChanges } from "./push";

export type SyncStatus = "idle" | "syncing" | "synced" | "conflict" | "offline" | "locked";

/** 网络失败的指数退避序列（秒），上限 5 分钟。 */
const RETRY_DELAYS = [5, 15, 30, 60, 120, 300];

/**
 * 同步调度器：串行化同步任务（syncLock）、失败退避重试、状态上报。
 * 完整流程：pull 远端变更 → 扫描本地变化 → push 队列 → 再 pull 一次对齐游标。
 */
export class SyncManager {
	/** pull 应用远端变更时置位，供事件监听器忽略自身写入产生的事件。 */
	applyingRemote = false;

	onStatus: (status: SyncStatus, detail?: string) => void = () => {};

	private syncing = false;
	private runAgain = false;
	private retryTimer: number | null = null;
	private retryIndex = 0;
	/** 协议兼容性检查通过（每次插件加载只检查一次；不兼容时每轮同步都会重新确认） */
	private protocolOk = false;
	private protocolWarned = false;
	private stateCorruptWarned = false;

	constructor(private ctx: SyncContext) {}

	get isSyncing(): boolean {
		return this.syncing;
	}

	/** 手动触发时调用：清零退避计数，立即重试。 */
	resetRetry(): void {
		this.retryIndex = 0;
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	async sync(reason: string): Promise<void> {
		if (this.syncing) {
			// 同一客户端不允许并发同步；标记结束后补一轮
			this.runAgain = true;
			return;
		}
		this.syncing = true;
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.onStatus("syncing");

		const counters: SyncCounters = { pulled: 0, pushed: 0, conflicts: 0 };
		try {
			// 状态损坏停机（v9 P0-6）：A/B 副本全部损坏时绝不「从零开始」同步——
			// 空状态会把陈旧本地文件当新文件上传（复活已删内容、制造假冲突）
			if (this.ctx.store.corrupted) {
				const msg = "本地同步状态文件损坏（两份副本均无法读取），同步已停止；请检查插件目录中的 state-a/state-b.json 或重新接入";
				if (!this.stateCorruptWarned) {
					this.stateCorruptWarned = true;
					this.ctx.notify(msg);
				}
				this.ctx.log(`sync blocked (${reason}): state corrupted`);
				this.onStatus("offline", msg);
				return;
			}
			// Bootstrap Gate 硬保护（v8）：未接入的设备绝不执行任何同步
			//（向导由 main 侧入口负责弹出，这里只兜底阻断）
			if (!this.ctx.store.bootstrapReady) {
				this.ctx.log(`sync blocked (${reason}): bootstrap pending`);
				this.onStatus("idle");
				return;
			}

			// 协议兼容性（v7 分仓后插件与服务器独立发版）：不兼容则拒绝同步，
			// 给出明确的升级指引，而不是让后续请求以奇怪的方式失败
			if (!this.protocolOk) {
				const info = await this.ctx.client.info();
				const err = protocolError(info);
				if (err) {
					if (!this.protocolWarned) {
						this.protocolWarned = true;
						this.ctx.notify(err);
					}
					this.ctx.log(`sync blocked: ${err}`);
					this.onStatus("offline", err);
					return;
				}
				// vaultId 保护（v8）：URL 没变但仓库身份变了（服务器重装/换库/换目标）
				// → 立即停止自动同步，重置为待接入，等用户重新走向导确认
				const saved = this.ctx.store.state.bootstrap.remoteVaultId;
				if (saved && info.vaultId && info.vaultId !== saved) {
					this.ctx.store.resetBootstrap();
					await this.ctx.store.save();
					const msg = "服务器上的同步仓库已更换（vaultId 变化），已暂停同步；请重新运行接入向导确认本设备的接入方式";
					this.ctx.notify(msg);
					this.ctx.log(`sync blocked: vaultId changed ${saved} -> ${info.vaultId}`);
					this.onStatus("offline", msg);
					return;
				}
				// repoEpoch 保护（v9）：服务器从备份恢复后旋转 epoch，旧游标全部作废
				// → 停止增量同步，重新接入（选「安全合并」保留本地 post-backup 内容）
				const savedEpoch = this.ctx.store.state.bootstrap.repoEpoch;
				if (savedEpoch && info.repoEpoch && info.repoEpoch !== savedEpoch) {
					this.ctx.store.resetBootstrap();
					await this.ctx.store.save();
					const msg =
						"服务器数据已从备份恢复（repoEpoch 变化），已暂停同步；请重新运行接入向导并选择「安全合并」，本地较新的内容不会丢失";
					this.ctx.notify(msg);
					this.ctx.log(`sync blocked: repoEpoch changed ${savedEpoch} -> ${info.repoEpoch}`);
					this.onStatus("offline", msg);
					return;
				}
				// v0.8 升级设备第一次见到 epoch：补记录
				if (!savedEpoch && info.repoEpoch && this.ctx.store.bootstrapReady) {
					this.ctx.store.state.bootstrap.repoEpoch = info.repoEpoch;
					await this.ctx.store.save();
				}
				this.protocolOk = true;
			}

			// E2EE：已启用但未解锁 → 暂停同步（本地编辑不受影响），解锁后再继续
			await this.ctx.refreshE2ee();
			if (this.ctx.e2ee.needsUnlock) {
				this.ctx.log("sync paused: E2EE locked");
				this.onStatus("locked");
				return;
			}

			this.applyingRemote = true;
			const pull1 = await pullRemoteChanges(this.ctx);
			this.applyingRemote = false;

			await scanLocalChanges(this.ctx);
			const push = await pushPendingChanges(this.ctx);

			this.applyingRemote = true;
			const pull2 = await pullRemoteChanges(this.ctx);
			this.applyingRemote = false;

			await this.ctx.store.save();

			counters.pulled = pull1.applied + pull2.applied;
			counters.pushed = push.pushed;
			counters.conflicts = pull1.conflicts + push.conflicts + pull2.conflicts;

			this.retryIndex = 0;
			this.ctx.log(
				`sync ok (${reason}): pulled=${counters.pulled} pushed=${counters.pushed} ` +
					`conflicts=${counters.conflicts} lastSequence=${this.ctx.store.state.lastSequence}`,
			);
			this.onStatus(counters.conflicts > 0 ? "conflict" : "synced");
		} catch (e) {
			// 同步失败绝不影响本地编辑；队列与游标保持原状，退避后重试
			this.ctx.log(`sync failed (${reason}): ${e instanceof Error ? e.message : String(e)}`);
			try {
				await this.ctx.store.save();
			} catch {
				/* 保存状态失败时下次同步会重新扫描，不影响数据安全 */
			}
			if (e instanceof E2eeLockedError) {
				// 中途遇到密文但未解锁（如其他设备刚启用 E2EE）→ 等待解锁，不做退避重试
				this.onStatus("locked");
			} else {
				this.onStatus("offline", e instanceof Error ? e.message : String(e));
				this.scheduleRetry();
			}
		} finally {
			this.applyingRemote = false;
			this.syncing = false;
			if (this.runAgain) {
				this.runAgain = false;
				void this.sync("follow-up");
			}
		}
	}

	private scheduleRetry(): void {
		const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
		this.retryIndex++;
		this.ctx.log(`retry in ${delay}s`);
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			void this.sync("retry");
		}, delay * 1000);
	}

	dispose(): void {
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}
}
