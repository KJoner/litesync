import { ApiError, protocolError, ServerInfo } from "../api/client";
import { E2eeLockedError } from "../crypto/keyring";
import { BindingFingerprint, computeBinding } from "../state/store";
import { isKeyEpoch } from "../utils/validate";
import { SyncContext, SyncCounters } from "./context";
import { syncGateBlock } from "./gate";
import { ensureSigningKeyRegistered, publishCheckpoint, verifyCheckpointChain } from "./checkpoint-sync";
import { pullRemoteChanges, recoverInterruptedSwaps } from "./pull";
import { pushPendingChanges, PushResult, scanLocalChanges } from "./push";

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
	/**
	 * 本条同步链要不要执行 push（时间混淆，§11.2）。
	 *
	 * 在 sync() 入口按 reason 评估而不是在 runOnce 里：续轮的 reason 是
	 * "follow-up"，无从判断最初是谁触发的；且手动同步撞上进行中的链时只是
	 * 设 runAgain 搭车，豁免必须在入口处记下来，否则会被吞掉。
	 * 任何一轮实际执行过 push 后清零。
	 */
	private pushWanted = false;
	private retryTimer: number | null = null;
	private retryIndex = 0;
	/** 当前正在执行的同步链（含 runAgain 续轮）；fullSync 据此等待真正结束（LS-121-C06） */
	private running: Promise<void> | null = null;
	/** 最近一轮同步的失败原因（fullSync 用它向迁移流程报错，而不是静默成功） */
	private lastError: unknown = null;
	/** 最近一条同步链的累计统计（手动同步的完成提示用；链开始时清零、每成功轮累加） */
	private lastCounters: { pulled: number; pushed: number; conflicts: number } | null = null;
	private protocolWarned = false;
	private stateCorruptWarned = false;
	private credentialChecked = false;
	/** 「凭据被拒」只弹一次常驻通知（验收 T5.2）；恢复后复位 */
	private credentialWarned = false;
	/** 「凭据被拒」的常驻通知句柄：恢复时主动撤下，而不是让用户自己点掉 */
	private credentialNotice: { hide(): void } | null = null;
	/** 本会话是否已确认过重置凭证登记（v0.18）：每会话最多补登记一次 */
	private resetAuthChecked = false;
	/** 服务器最近上报的 keyEpoch（E2EE 一致性防御用；-1 = 尚未获知） */
	private serverKeyEpoch = -1;
	/** 「服务器加密状态自相矛盾」的常驻通知句柄（恢复时撤下） */
	private e2eeMismatchNotice: { hide(): void } | null = null;

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
	 * 会话缓存（credentialChecked）清零，Gate 切到 unbound，
	 * 于是上传、删除、MOVE、历史恢复、分享在重新完成权威校验之前一律被拒。
	 * 绝不允许把针对原服务器建立的本地状态直接用在另一台服务器上。
	 */
	invalidateBinding(reason: string): void {
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
		// 时间混淆（§11.2）：非推迟类 reason 一到就把「要 push」记下来——
		// 即使这次只是搭上进行中的链（runAgain），豁免也不能丢
		if (!(this.ctx.deferPush?.(reason) ?? false)) this.pushWanted = true;
		if (this.syncing) {
			// 同一客户端不允许并发同步；标记结束后补一轮
			this.runAgain = true;
			await this.running;
			return;
		}
		// 新链：错误与统计都只反映本链（被 gate 拦下的链两者皆空——
		// 调用方据此区分「失败」「被拦」「成功」三态）
		this.lastError = null;
		this.lastCounters = null;
		const chain = this.runChain(reason);
		this.running = chain;
		try {
			await chain;
		} finally {
			if (this.running === chain) this.running = null;
		}
	}

	/** 最近一条同步链的失败原因（手动同步的结果提示用）；成功链为 null。 */
	get lastSyncError(): Error | null {
		return this.lastError instanceof Error ? this.lastError : null;
	}

	/** 最近一条同步链的累计统计；链没跑成任何一轮（如被 gate 拦下）时为 null。 */
	get lastSyncCounters(): { pulled: number; pushed: number; conflicts: number } | null {
		return this.lastCounters;
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
			// 服务器加密状态一致性防御（v0.18 实测发现的矛盾形态）：
			// 密钥文档 enabled=true 而仓库 keyEpoch=0（plaintext）。可能是残留的
			// 旧密钥文档，也可能是恶意服务器的降级/混淆尝试——两种都不能信。
			// 照单全收会让本地进入「已加密但没有合法密钥世代」的死局：push 每轮
			// 在加密处失败，用户只看到 Offline。必须显式停机并说清楚原因。
			if (this.ctx.e2ee.enabled && this.serverKeyEpoch === 0) {
				const msg =
					"服务器的加密状态自相矛盾：端到端加密密钥文档已启用，但仓库声称未加密（keyEpoch=0）。\n" +
					"已停止同步，以免写入无法解密的内容。请服务器管理员检查——" +
					"通常是一份残留的旧密钥文档（服务器启动日志会有相应警告）。";
				this.ctx.gate.markProtocolMismatch(msg);
				if (!this.e2eeMismatchNotice) {
					const handle = this.ctx.notify(msg, 0);
					if (handle) this.e2eeMismatchNotice = handle;
				}
				this.ctx.log("sync blocked: e2ee state mismatch (doc enabled, keyEpoch=0)");
				this.onStatus("offline", msg);
				return;
			}
			// 矛盾解除（管理员清理了文档 / 正常启用推进了 keyEpoch）→ 撤下提示
			if (this.e2eeMismatchNotice) {
				this.e2eeMismatchNotice.hide();
				this.e2eeMismatchNotice = null;
			}
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

			// §9.2：首轮把本设备的签名公钥登记上去（服务器只存不用）。
			// 失败不阻断同步——它只影响别的设备能不能验证我签的 checkpoint
			const pub = this.ctx.signingPublicKey?.() ?? "";
			if (pub) {
				await ensureSigningKeyRegistered(this.ctx, pub);
				this.ctx.onSigningKeyRegistered?.();
			}

			// §9：先确认「服务器现在给我看的这套状态，确实是我已知历史的合法延伸」，
			// 再决定要不要按它去改本地文件。反过来等于先动手再检查——
			// 发现问题时已经写下去了
			if (!(await verifyCheckpointChain(this.ctx))) {
				await this.ctx.store.save();
				this.onStatus("offline", "检测到仓库状态异常，已停止自动同步");
				return;
			}

			this.applyingRemote = true;
			// §6.9：上一轮的名字互换可能停在临时名上（进程被杀 / 应用被系统回收）。
			// 那份内容此刻只存在于插件目录里，用户看不见——先把它放回去再做别的
			await recoverInterruptedSwaps(this.ctx);
			const pull1 = await pullRemoteChanges(this.ctx);
			this.applyingRemote = false;

			await scanLocalChanges(this.ctx);
			// 时间混淆（§11.2 / 验收 T4.5）：定时/前台/启动/重试的轮次只拉不推，
			// 上传只发生在窗口发车点或用户显式动作。扫描照常执行（stage 只落盘
			// 不出网）；被推迟的队列由窗口定时器兜底，绝不悬空
			let push: PushResult = { pushed: 0, conflicts: 0 };
			if (this.pushWanted) {
				push = await pushPendingChanges(this.ctx);
				this.pushWanted = false;
			} else if (this.ctx.queue.size > 0) {
				this.ctx.onPushDeferred?.();
			}

			this.applyingRemote = true;
			const pull2 = await pullRemoteChanges(this.ctx);
			this.applyingRemote = false;

			// §9：本设备已经把远端变更全部应用完，此刻算出的对象状态才代表
			// 「这个仓库现在的样子」。中途发布等于替一个自己都没看全的状态背书
			await publishCheckpoint(this.ctx);

			await this.ctx.store.save();

			counters.pulled = pull1.applied + pull2.applied;
			counters.pushed = push.pushed;
			counters.conflicts = pull1.conflicts + push.conflicts + pull2.conflicts;

			this.retryIndex = 0;
			this.lastError = null;
			const prev = this.lastCounters ?? { pulled: 0, pushed: 0, conflicts: 0 };
			this.lastCounters = {
				pulled: prev.pulled + counters.pulled,
				pushed: prev.pushed + counters.pushed,
				conflicts: prev.conflicts + counters.conflicts,
			};
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
			} else if (e instanceof ApiError && e.status === 401) {
				// 凭据被拒（验收 T5.2）：设备被撤销或 Token 失效。这不会自己好起来，
				// 退避重试只是无意义地撞墙；置 gate 停掉手动命令、弹常驻通知
				//（移动端没有状态栏，8 秒的提示等于没有提示），等用户填新 Token。
				// /info 重新成功（「测试连接」或填新 Token 后的下一轮）时自动清除。
				// 文案刻意不提「配对」：配对导入会强制重跑接入向导做一次全量对账，
				// 而这个场景（Token 重置/设备撤销）只需要填新 Token（v11 设计 §4.6）
				const msg = e.is("TOKEN_REVOKED")
					? "本设备的凭据已被撤销（服务器重置了 API Token 或撤销了本设备）。\n" +
						"在设置中填入新的 API Token 后点「测试连接」即可恢复同步——" +
						"本地笔记、历史与加密密钥都不受影响。"
					: "设备凭据已失效：服务器拒绝了本设备的访问。\n" +
						"请在设置中确认 API Token 是否正确（更换后点「测试连接」即可恢复），" +
						"本地数据不受影响。";
				this.ctx.gate.markCredentialRejected(msg);
				if (!this.credentialWarned) {
					this.credentialWarned = true;
					const handle = this.ctx.notify(msg, 0);
					if (handle) this.credentialNotice = handle;
				}
				this.onStatus("offline", msg);
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
			vaultChoice: cfg.vaultChoice,
		});
		if (!this.ctx.store.isBoundTo(want)) {
			const prev = this.ctx.store.binding;
			this.credentialChecked = false;
			this.ctx.gate.markUnbound(prev === null ? "首次绑定" : describeBindingChange(prev, want));
			this.ctx.store.clearBinding();
		}

		// §5.2：仓库状态**每轮**重新校准，不再只在会话首轮读取。
		//
		// repoEpoch / formatEpoch / keyEpoch / metaState / encryptionState /
		// minimumEnvelopeVersion / protocolVersion 都可能在两轮之间变化
		//（服务器从备份恢复、别的设备完成了迁移、密钥轮换）。用会话首轮的判断
		// 继续 pull/push，等于拿着过期的世界观改数据。
		const info = await this.ctx.client.info();
		// /info 成功 = 服务器重新认识我们了：清除「凭据被拒」停机（T5.2 的恢复路径），
		// 并把还挂在屏幕上的常驻通知一并撤下——恢复了却留着警告，等于没恢复
		this.ctx.gate.markCredentialRejected(null);
		this.credentialWarned = false;
		this.credentialNotice?.hide();
		this.credentialNotice = null;
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
		this.serverKeyEpoch = info.keyEpoch ?? 0;
		// 账本归属补写（v0.18）：从旧版本升级上来的账本没有归属标记。
		// 此刻 vaultId 已通过 adoptRepoIdentity 对账（一致），补上标记后
		// 向导 preflight 的换库判定才有可信依据。
		if (!this.ctx.store.state.ledgerVaultId && info.vaultId) {
			this.ctx.store.state.ledgerVaultId = info.vaultId;
		}

		// 重置凭证自动补登记（v0.18 / v11 设计 §3.1）：E2EE 已解锁且服务器尚未
		// 登记时，把 HKDF(VMK) 派生值送上去——「重置 Token 需要 E2EE 密码」这道
		// 服务端关卡越早立起来，Token 泄露时攻击者可抢的窗口越小。异步不阻塞同步。
		if (info.resetAuthConfigured === false && !this.resetAuthChecked) {
			this.resetAuthChecked = true;
			void this.registerResetAuthOnce();
		}

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
				vaultChoice: fresh.vaultChoice,
			}),
		);
		await this.ctx.store.save();
		this.ctx.gate.markBound();
		return true;
	}

	/** 补登记重置凭证：失败只记日志（下个会话再试），绝不打扰用户。 */
	private async registerResetAuthOnce(): Promise<void> {
		try {
			const resetAuth = await this.ctx.e2ee.resetAuth();
			if (!resetAuth) return; // 未启用或未解锁 E2EE：无凭证可登记
			await this.ctx.client.registerResetAuth(resetAuth);
			this.ctx.log("reset-auth registered");
		} catch (e) {
			this.ctx.log(`reset-auth register failed: ${e instanceof Error ? e.message : String(e)}`);
		}
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
			// v0.18 实测缺陷修复：换仓库必须作废整本同步账本，不只是 bootstrap。
			// 只重置 bootstrap 的话，files 里对旧仓库的「已同步」记录会让重新接入
			// 后的扫描空转——本地文件永远不会被推到新仓库，而状态栏显示 synced
			this.ctx.store.resetForNewRepository();
			this.ctx.store.clearBinding();
			await this.ctx.store.save();
			const msg =
				"服务器上的同步仓库已更换（vaultId 变化），已暂停同步并作废旧仓库的同步记录；\n" +
				"本地笔记不受影响。请重新运行接入向导（或点「测试连接」）确认本设备的接入方式";
			this.ctx.notify(msg);
			this.ctx.log(`sync blocked: vaultId changed ${saved} -> ${info.vaultId}`);
			this.onStatus("offline", msg);
			return false;
		}
		// repoEpoch 保护（计划书 §5.6）：服务器从备份恢复后旋转 epoch。
		//
		// **绝不能**用恢复后的快照直接覆盖本地——备份点之后本设备产生的内容
		// 只存在于本地。因此进入显式的灾备恢复流程：留档本地现状 → 重置为待接入
		// → 向导以「安全合并」重新对齐（远端有本地无 → 下载；本地有远端无 → 上传；
		// 双方不同 → 冲突/保留两份），最后建立新 epoch 下的新游标。
		const savedEpoch = this.ctx.store.state.bootstrap.repoEpoch;
		if (savedEpoch && info.repoEpoch && info.repoEpoch !== savedEpoch) {
			this.ctx.store.enterRecovery({
				reason: "repo-epoch-changed",
				previousEpoch: savedEpoch,
				serverEpoch: info.repoEpoch,
				localSequence: this.ctx.store.state.lastSequence,
				localFileCount: this.ctx.store.paths().length,
				at: Date.now(),
			});
			this.ctx.store.resetBootstrap();
			this.ctx.store.clearBinding();
			await this.ctx.store.save();
			const msg =
				"服务器数据已从备份恢复（repoEpoch 变化），已暂停同步。\n" +
				"请重新运行接入向导——它会进入灾备恢复合并：备份点之后本设备的内容全部保留，" +
				"两侧差异走冲突流程，绝不静默丢弃。";
			this.ctx.gate.markRepoEpochMismatch(msg);
			this.ctx.notify(msg);
			this.ctx.log(
				`disaster recovery: repoEpoch ${savedEpoch} -> ${info.repoEpoch}, ` +
					`localSequence=${this.ctx.store.state.lastSequence}`,
			);
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
			if (info.formatEpoch < savedFormat) {
				// 回退 = 服务器可能被换回旧数据，或者有人在冒充它。
				//
				// 这里**必须先判断再采纳**（v0.14.0-RC / §8.6）：以前的写法是先把
				// 服务器给的值写进 bootstrap、清掉游标，再检查是不是回退。
				// 结果是即使随后停机，盘上已经留下了攻击者给的那个旧世代——
				// 用户一旦清除完整性告警，客户端就会用旧格式去寻址。
				// 不采纳、不清游标、直接停机才是安全的顺序。
				const msg = "服务器 formatEpoch 回退，已停止同步等待人工确认";
				this.ctx.log(`formatEpoch rollback ${savedFormat} -> ${info.formatEpoch}, refusing to adopt`);
				this.ctx.notify("服务器的寻址格式世代发生了回退，已停止同步；请检查服务器是否从旧备份恢复");
				this.ctx.gate.markIntegrityError(msg);
				this.onStatus("offline", msg);
				return false;
			}
			this.ctx.store.state.bootstrap.formatEpoch = info.formatEpoch;
			this.ctx.store.state.lastSequence = 0; // 强制下一轮走 snapshot 全量对账
			await this.ctx.store.save();
			this.ctx.notify("服务器已完成路径与文件名加密，本设备将重新对账一次（内容不受影响）");
			this.ctx.log(`formatEpoch changed ${savedFormat} -> ${info.formatEpoch}, forcing snapshot reconcile`);
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
		// 别的设备正在跑元数据迁移：本设备只能读、以及写已伪名化的对象
		//（服务器侧同样冻结，这里只是让 UI 与日志能说清楚为什么慢下来）
		if (info.migrationId && info.migrationOwnerDeviceId !== this.ctx.store.state.deviceId) {
			this.ctx.log(`another device is migrating (${info.migrationId}); writes are restricted`);
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
