import { protocolError, ServerInfo } from "../api/client";
import { E2eeLockedError } from "../crypto/keyring";
import { BindingFingerprint, computeBinding } from "../state/store";
import { isKeyEpoch } from "../utils/validate";
import { SyncContext, SyncCounters } from "./context";
import { syncGateBlock } from "./gate";
import { pullRemoteChanges } from "./pull";
import { pushPendingChanges, scanLocalChanges } from "./push";

export type SyncStatus = "idle" | "syncing" | "synced" | "conflict" | "offline" | "locked";

/** 网络失败的指数退避序列（秒），上限 5 分钟。 */
const RETRY_DELAYS = [5, 15, 30, 60, 120, 300];

/** 一次 sync() 调用最多连带执行的续轮数（防止 runAgain 自激成死循环）。 */
const MAX_FOLLOW_UPS = 8;

/** fullSync 等待收敛的最大轮数：超过即视为无法收敛并向调用方报错。 */
const MAX_FULL_SYNC_ROUNDS = 6;

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
	/** 当前正在执行的同步链（含 runAgain 续轮）；fullSync 据此等待真正结束（LS-121-C06） */
	private running: Promise<void> | null = null;
	/** 最近一轮同步的失败原因（fullSync 用它向迁移流程报错，而不是静默成功） */
	private lastError: unknown = null;
	/** 协议兼容性检查通过（重新绑定时清零） */
	private protocolOk = false;
	private protocolWarned = false;
	private stateCorruptWarned = false;
	private credentialChecked = false;

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

	/**
	 * 作废当前绑定（v0.12.1 / LS-121-C02）。
	 *
	 * server URL、Token、设备身份、vault key 文档任一变化时由 main.ts 调用：
	 * 会话缓存（protocolOk / credentialChecked）全部清零，Gate 切到 unbound，
	 * 于是上传、删除、MOVE、历史恢复、分享在重新完成权威校验之前一律被拒。
	 * 绝不允许把针对原服务器建立的本地状态直接用在另一台服务器上。
	 */
	invalidateBinding(reason: string): void {
		this.protocolOk = false;
		this.credentialChecked = false;
		this.ctx.gate.markUnbound(reason);
		this.ctx.gate.markProtocolMismatch(null);
		this.ctx.log(`binding invalidated: ${reason}`);
	}

	/**
	 * 触发一轮同步。
	 *
	 * 返回的 Promise 在**整条同步链**（含因 runAgain 追加的续轮）结束后才 resolve；
	 * 已经在同步中时返回正在执行的那条链，调用方 await 它即可获得「至少包含我这次
	 * 请求」的完成语义（LS-121-C06）。
	 */
	async sync(reason: string): Promise<void> {
		if (this.syncing) {
			// 同一客户端不允许并发同步；标记结束后补一轮
			this.runAgain = true;
			await this.running;
			return;
		}
		const chain = this.runChain(reason);
		this.running = chain;
		try {
			await chain;
		} finally {
			if (this.running === chain) this.running = null;
		}
	}

	/**
	 * 等待同步彻底收敛（迁移等不可逆流程的前置）。
	 *
	 * 「设置了 runAgain 就返回」曾让 enableE2ee 在队列还没推完时进入迁移，
	 * 于是迁移清单与真实内容不一致。这里要求：同步链结束、没有待续轮、
	 * 待推送队列为空、且最近一轮没有失败——任何一项不满足都继续或报错。
	 */
	async fullSync(reason = "full-sync"): Promise<void> {
		this.lastError = null; // 只对本次 fullSync 期间的失败负责，不被上一次的陈旧错误干扰
		for (let round = 0; round < MAX_FULL_SYNC_ROUNDS; round++) {
			await this.sync(reason);
			const failure = this.lastError;
			if (failure instanceof Error) throw failure;
			// 同步轮可能因 gate（未绑定 / 状态损坏 / 未解锁 / 迁移中）提前返回而
			// 什么都没做——此时队列恰好为空并不代表「已收敛」，必须显式报错，
			// 绝不能让调用方（迁移流程）把「被拦下」当成「同步干净」
			const block = syncGateBlock(this.ctx);
			if (block !== null) throw new Error(`同步未能完成：${block.message}`);
			if (!this.syncing && !this.runAgain && this.ctx.queue.size === 0) return;
		}
		throw new Error(
			`同步未能在 ${MAX_FULL_SYNC_ROUNDS} 轮内收敛（仍有 ${this.ctx.queue.size} 项待推送），已中止本次操作`,
		);
	}

	/** 执行一轮同步及其所有续轮。 */
	private async runChain(reason: string): Promise<void> {
		let current = reason;
		for (let i = 0; i <= MAX_FOLLOW_UPS; i++) {
			await this.runOnce(current);
			if (!this.runAgain) return;
			this.runAgain = false;
			current = "follow-up";
		}
		this.ctx.log(`sync chain stopped after ${MAX_FOLLOW_UPS} follow-ups`);
	}

	private async runOnce(reason: string): Promise<void> {
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
				const msg =
					"本地同步状态文件损坏（两份副本均无法读取），同步已停止；请检查插件目录中的 state-a/state-b.json 或重新接入";
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

			// 绑定与协议校验（v0.12.1 / LS-121-C02）：设置或身份变化后必须重做
			if (!(await this.ensureBinding())) return;

			// 迁移进行中：不并发跑普通同步（迁移流程自己会调用 fullSync）
			if (this.ctx.gate.isMigrationActive) {
				this.ctx.log(`sync skipped (${reason}): migration active`);
				this.onStatus("idle");
				return;
			}

			// E2EE：已启用但未解锁 → 暂停同步（本地编辑不受影响），解锁后再继续
			await this.ctx.refreshE2ee();
			if (this.ctx.e2ee.needsUnlock) {
				this.ctx.log("sync paused: E2EE locked");
				this.onStatus("locked");
				return;
			}

			// 统一 Gate 兜底：自动同步与手动命令使用同一套许可判断（LS-121-C07）
			const block = syncGateBlock(this.ctx);
			if (block !== null) {
				this.ctx.log(`sync blocked (${reason}): ${block.reason}`);
				this.onStatus(block.reason === "key-locked" ? "locked" : "offline", block.message);
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
			this.lastError = null;
			this.ctx.log(
				`sync ok (${reason}): pulled=${counters.pulled} pushed=${counters.pushed} ` +
					`conflicts=${counters.conflicts} lastSequence=${this.ctx.store.state.lastSequence}`,
			);
			this.onStatus(counters.conflicts > 0 ? "conflict" : "synced");
		} catch (e) {
			// 同步失败绝不影响本地编辑；队列与游标保持原状，退避后重试
			const failure = e instanceof Error ? e : new Error(String(e));
			this.lastError = failure;
			this.ctx.log(`sync failed (${reason}): ${failure.message}`);
			try {
				await this.ctx.store.save();
			} catch {
				/* 保存状态失败时下次同步会重新扫描，不影响数据安全 */
			}
			if (e instanceof E2eeLockedError) {
				// 中途遇到密文但未解锁（如其他设备刚启用 E2EE）→ 等待解锁，不做退避重试
				this.onStatus("locked");
			} else {
				this.onStatus("offline", failure.message);
				this.scheduleRetry();
			}
		} finally {
			this.applyingRemote = false;
			this.syncing = false;
		}
	}

	/**
	 * 权威绑定校验（LS-121-C02）。
	 *
	 * 每轮同步都会比对「本地状态所绑定的指纹」与「当前配置的指纹」。
	 * 不一致（换了服务器 / 换了 Token / 换了设备身份 / vault key 文档被替换）时
	 * 必须重新执行 /info + 凭据 + vaultId/repoEpoch/keyEpoch 校验，通过后才
	 * 固定新绑定并解除 unbound。返回 false 表示本轮同步必须停止。
	 */
	private async ensureBinding(): Promise<boolean> {
		const cfg = this.ctx.credentials();
		const want = await computeBinding({
			serverUrl: cfg.serverUrl,
			apiToken: cfg.apiToken,
			deviceId: this.ctx.store.state.deviceId,
			vaultKey: this.ctx.e2ee.doc,
		});
		if (!this.ctx.store.isBoundTo(want)) {
			const prev = this.ctx.store.binding;
			this.protocolOk = false;
			this.credentialChecked = false;
			this.ctx.gate.markUnbound(prev === null ? "首次绑定" : describeBindingChange(prev, want));
			this.ctx.store.clearBinding();
		}

		if (this.protocolOk && !this.ctx.gate.isUnbound) return true;

		const info = await this.ctx.client.info();
		const err = protocolError(info);
		if (err) {
			this.ctx.gate.markProtocolMismatch(err);
			if (!this.protocolWarned) {
				this.protocolWarned = true;
				this.ctx.notify(err);
			}
			this.ctx.log(`sync blocked: ${err}`);
			this.onStatus("offline", err);
			return false;
		}
		this.ctx.gate.markProtocolMismatch(null);
		this.protocolWarned = false;

		if (!(await this.adoptRepoIdentity(info))) return false;

		// 设备级凭据（v9.2）：仍在用根 Token 时自动换发本设备专属凭据，
		// 根 Token 从此不再存在于任何设备（丢失设备可单独撤销）
		await this.ensureDeviceCredential();

		// 权威校验全部通过 → 固定绑定（Token 换发后指纹会变，这里重算一次）
		const fresh = this.ctx.credentials();
		this.ctx.store.setBinding(
			await computeBinding({
				serverUrl: fresh.serverUrl,
				apiToken: fresh.apiToken,
				deviceId: this.ctx.store.state.deviceId,
				vaultKey: this.ctx.e2ee.doc,
			}),
		);
		await this.ctx.store.save();
		this.ctx.gate.markBound();
		this.protocolOk = true;
		return true;
	}

	/**
	 * 校验并采纳服务器仓库身份（vaultId / repoEpoch / keyEpoch / metaState）。
	 * 返回 false 表示本轮同步必须停止（仓库身份变了，需要重新接入）。
	 */
	private async adoptRepoIdentity(info: ServerInfo): Promise<boolean> {
		// vaultId 保护（v8）：URL 没变但仓库身份变了（服务器重装/换库/换目标）
		// → 立即停止自动同步，重置为待接入，等用户重新走向导确认
		const saved = this.ctx.store.state.bootstrap.remoteVaultId;
		if (saved && info.vaultId && info.vaultId !== saved) {
			this.ctx.store.resetBootstrap();
			this.ctx.store.clearBinding();
			await this.ctx.store.save();
			const msg = "服务器上的同步仓库已更换（vaultId 变化），已暂停同步；请重新运行接入向导确认本设备的接入方式";
			this.ctx.notify(msg);
			this.ctx.log(`sync blocked: vaultId changed ${saved} -> ${info.vaultId}`);
			this.onStatus("offline", msg);
			return false;
		}
		// repoEpoch 保护（v9）：服务器从备份恢复后旋转 epoch，旧游标全部作废
		// → 停止增量同步，重新接入（选「安全合并」保留本地 post-backup 内容）
		const savedEpoch = this.ctx.store.state.bootstrap.repoEpoch;
		if (savedEpoch && info.repoEpoch && info.repoEpoch !== savedEpoch) {
			this.ctx.store.resetBootstrap();
			this.ctx.store.clearBinding();
			await this.ctx.store.save();
			const msg =
				"服务器数据已从备份恢复（repoEpoch 变化），已暂停同步；请重新运行接入向导并选择「安全合并」，本地较新的内容不会丢失";
			this.ctx.gate.markRepoEpochMismatch(msg);
			this.ctx.notify(msg);
			this.ctx.log(`sync blocked: repoEpoch changed ${savedEpoch} -> ${info.repoEpoch}`);
			this.onStatus("offline", msg);
			return false;
		}
		this.ctx.gate.markRepoEpochMismatch(null);

		// formatEpoch 保护（v0.13.0 / ADR-006）：服务器完成元数据加密后寻址格式变了。
		// 与 repoEpoch（灾备恢复 → 恢复合并，保留本地新内容）语义不同——
		// 这里不需要合并，只需要**丢弃游标重新对账**：对象身份没变，
		// 变的只是服务器怎么称呼它们。
		const savedFormat = this.ctx.store.state.bootstrap.formatEpoch;
		if (info.formatEpoch !== undefined && savedFormat !== undefined && info.formatEpoch !== savedFormat) {
			this.ctx.store.state.bootstrap.formatEpoch = info.formatEpoch;
			this.ctx.store.state.lastSequence = 0; // 强制下一轮走 snapshot 全量对账
			await this.ctx.store.save();
			this.ctx.notify(
				info.formatEpoch > savedFormat
					? "服务器已完成路径与文件名加密，本设备将重新对账一次（内容不受影响）"
					: "服务器的寻址格式世代发生了回退，已停止同步；请检查服务器是否从旧备份恢复",
			);
			this.ctx.log(`formatEpoch changed ${savedFormat} -> ${info.formatEpoch}, forcing snapshot reconcile`);
			if (info.formatEpoch < savedFormat) {
				// 回退 = 服务器可能被换回旧数据：不自动继续
				const msg = "服务器 formatEpoch 回退，已停止同步等待人工确认";
				this.ctx.gate.markIntegrityError(msg);
				this.onStatus("offline", msg);
				return false;
			}
		}

		// v0.8 升级设备第一次见到 epoch / vaultId：补记录（首见即固定身份）
		let adopted = false;
		if (!savedEpoch && info.repoEpoch && this.ctx.store.bootstrapReady) {
			this.ctx.store.state.bootstrap.repoEpoch = info.repoEpoch;
			adopted = true;
		}
		if (!saved && info.vaultId && this.ctx.store.bootstrapReady) {
			this.ctx.store.state.bootstrap.remoteVaultId = info.vaultId;
			adopted = true;
		}
		// E2EE 密钥世代（v9.2）：LSE2/LSE3 信封的 AAD 绑定材料，跟随服务器状态机。
		// 非法值绝不采纳（LS-121-C03）：被截断的 keyEpoch 会产出永远解不开的密文
		if (info.keyEpoch !== undefined && info.keyEpoch !== 0) {
			if (!isKeyEpoch(info.keyEpoch)) {
				const msg = `服务器返回的 keyEpoch 非法（${String(info.keyEpoch)}），已停止同步以免写出无法解密的内容`;
				this.ctx.gate.markIntegrityError(msg);
				this.ctx.notify(msg);
				this.onStatus("offline", msg);
				return false;
			}
			if (this.ctx.store.state.bootstrap.keyEpoch !== info.keyEpoch) {
				this.ctx.store.state.bootstrap.keyEpoch = info.keyEpoch;
				adopted = true;
			}
		}
		// 元数据加密状态：encrypted 后所有服务器路径都是伪名
		if (info.metaState !== undefined && this.ctx.store.state.bootstrap.metaState !== info.metaState) {
			this.ctx.store.state.bootstrap.metaState = info.metaState;
			adopted = true;
		}
		// 首见 formatEpoch / 仓库信封下限（v0.13.0）：记录之，用于逐请求校验与
		// 「不再产出低于下限的信封」判断
		if (info.formatEpoch !== undefined && this.ctx.store.state.bootstrap.formatEpoch !== info.formatEpoch) {
			this.ctx.store.state.bootstrap.formatEpoch = info.formatEpoch;
			adopted = true;
		}
		if (
			info.minimumEnvelopeVersion !== undefined &&
			this.ctx.store.state.bootstrap.minimumEnvelopeVersion !== info.minimumEnvelopeVersion
		) {
			this.ctx.store.state.bootstrap.minimumEnvelopeVersion = info.minimumEnvelopeVersion;
			adopted = true;
		}
		if (adopted) await this.ctx.store.save();
		return true;
	}

	/** 根 Token → 设备凭据自动换发（失败不阻塞同步，下次会话重试）。 */
	private async ensureDeviceCredential(): Promise<void> {
		if (this.credentialChecked || !this.ctx.updateApiToken) return;
		this.credentialChecked = true;
		try {
			const who = await this.ctx.client.whoami();
			if (who.tokenType !== "root") return;
			const cred = await this.ctx.client.createDevice(this.ctx.deviceName());
			await this.ctx.updateApiToken(cred.deviceToken);
			this.ctx.notify("已为本设备换发专属同步凭据（根 Token 不再保存在设备上，可在服务器上单独撤销本设备）");
			this.ctx.log(`device credential issued: ${cred.deviceId}`);
		} catch (e) {
			this.credentialChecked = false; // 网络失败等：下次协议检查重试
			this.ctx.log(`device credential exchange failed: ${e instanceof Error ? e.message : String(e)}`);
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

/** 绑定变化原因（只描述「哪一项变了」，绝不打印凭据本身）。 */
function describeBindingChange(prev: BindingFingerprint, next: BindingFingerprint): string {
	if (prev.serverUrl !== next.serverUrl) return "Server URL 已变化";
	if (prev.tokenDigest !== next.tokenDigest) return "API Token 已变化";
	if (prev.deviceId !== next.deviceId) return "设备身份已变化";
	if (prev.vaultKeyDigest !== next.vaultKeyDigest) return "端到端加密密钥文档已变化";
	return "绑定信息已变化";
}
