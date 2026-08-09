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
			// 协议兼容性（v7 分仓后插件与服务器独立发版）：不兼容则拒绝同步，
			// 给出明确的升级指引，而不是让后续请求以奇怪的方式失败
			if (!this.protocolOk) {
				const err = protocolError(await this.ctx.client.info());
				if (err) {
					if (!this.protocolWarned) {
						this.protocolWarned = true;
						this.ctx.notify(err);
					}
					this.ctx.log(`sync blocked: ${err}`);
					this.onStatus("offline", err);
					return;
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
