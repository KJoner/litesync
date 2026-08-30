import { DataAdapter } from "obsidian";
import { BootstrapMode, BootstrapState, PENDING_BOOTSTRAP, RecoveryState, RepoBinding } from "../bootstrap/bootstrap-types";
import { VaultKeyDoc } from "../crypto/crypto";
import { PendingOp } from "../sync/queue";
import { sha256Hex } from "../utils/hash";
import { encodeUtf8 } from "../utils/text";
import { isFileId, isGeneration } from "../utils/validate";
import { TrustAnchor } from "../sync/freshness";
import { evalFailpoint, FP } from "../utils/failpoint";
import { platformCollisionKey } from "../utils/vault-path";

/**
 * 每个已同步文件的本地状态缓存。
 * E2EE 启用后明文与密文 hash 不同（随机 IV），因此分开记录：
 * - hash：本地明文内容 hash（检测本地修改）
 * - serverHash：服务器上的内容 hash（未加密时与 hash 相同；对齐 changes feed）
 */
export interface FileState {
	hash: string;
	serverHash: string;
	revision: number;
	mtime: number;
	size: number;
	/** 稳定文件身份（v9.3；LSE3 密文的 AAD 绑定它） */
	fileId?: string;
	/**
	 * 该文件已见/已写的最大 contentGeneration（v9.3 抗回退重放）：
	 * HEAD 下载解出的 generation 低于此值 = 恶意服务器把旧版本当最新 → 拒绝
	 */
	generation?: number;
	/** 元数据世代（v9.3 三期，meta 模式）：改名 = 世代 +1 */
	metaGeneration?: number;
	/**
	 * 该 metaGeneration 对应元数据的认证摘要（v0.13.2 / §6.8）。
	 *
	 * 没有它就无法区分「同一份元数据又收到一次」（幂等重复，正常）和
	 * 「同一个世代上出现了两份不同的元数据」（分叉，必须硬失败）。
	 */
	metaFingerprint?: string;
	/**
	 * 服务器可见路径（v0.12.1）：meta 模式下为伪名（=fileId），明文模式为空。
	 * 显式记录后，任何请求都不需要再从真实路径「猜」服务器路径。
	 */
	serverPseudonym?: string;
}

/**
 * FileState 身份字段（v0.12.1 / LS-121-C04）。
 *
 * 这些字段一旦在某次 `store.set()` 中被漏写就等于永久丢失：
 * fileId 丢失 → LSE3 无法解密、meta 模式退回真实路径；
 * generation 丢失 → 抗回退重放检查失效；
 * metaGeneration 丢失 → 改名 CAS 永远失败。
 * 因此所有「更新已有文件」的写入都必须走 {@link StateStore.update}。
 */
export const FILE_IDENTITY_FIELDS = [
	"fileId",
	"generation",
	"metaGeneration",
	"metaFingerprint",
	"serverPseudonym",
] as const;

/** 内容相关字段（v0.13.2 §6.11）：只描述「这份内容是什么」，不含对象身份。 */
export type ContentPatch = Partial<Pick<FileState, "hash" | "serverHash" | "revision" | "mtime" | "size">>;

/** 对象身份字段（v0.13.2 §6.11）：只由服务器的响应决定，业务代码不得自行编造。 */
export type RemoteIdentity = Partial<
	Pick<FileState, "fileId" | "generation" | "metaGeneration" | "metaFingerprint" | "serverPseudonym">
>;

/**
 * 某个路径此刻处于哪一种状态（v0.13.2 §6.11 的类型层区分）。
 *
 * 有了它，业务代码就不需要「先 get，再 getConflict，再查 blocked，再查
 * pendingDelete」——漏查任何一项都会让流程对着错误的前提做决定。
 */
export type ObjectView =
	| { kind: "untracked"; path: string }
	| { kind: "tracked"; path: string; state: FileState }
	| { kind: "conflict"; path: string; state?: FileState; conflict: PendingConflict }
	| { kind: "blocked"; path: string; state?: FileState; blocked: BlockedChange }
	| { kind: "pending-delete"; path: string }
	| { kind: "bootstrap-pending"; path: string; state?: FileState };

/** 未解决冲突的登记信息（计划书 Phase 15：Pending Conflict）。 */
export interface PendingConflict {
	baseRevision: number;
	remoteRevision: number;
	createdAt: number;
}

/** 本设备创建过的分享（Share Key 只存本地，服务器与其他设备都拿不到）。 */
export interface ShareRecord {
	path: string;
	keyB64url: string;
	createdAt: number;
	expiresAt: number;
	/**
	 * 显示名是否已随内容一起加密（v0.13.3 / §7.4）。
	 * 缺失或 false = v0.13.2 及更早创建的分享，真实路径仍留在服务器上；
	 * 管理界面会标出来，提示用户撤销后重建。
	 */
	nameEncrypted?: boolean;
}

/**
 * 被本地条件阻塞、必须持续重试的远端变更（v9：skipped 不再静默 ACK；
 * v0.13.2 / §6.4 起保存**完整的远端变更身份**）。
 *
 * 只记 `{path, reason}` 是不够的：重试时就只能拿真实路径去「合成」一条
 * upsert——那条合成变更的 revision/hash/metaGeneration 全是编造的，会让
 * 冲突判定和改名判定同时失真。这里把原始变更的全部字段留下来，重试时
 * 原样重放，重新走 resolveMetaChange → 路径校验 → 提交。
 */
export interface BlockedChange {
	/** 该变更在服务器 changes 流中的序号（重放时原样使用） */
	sequence: number;
	action: "upsert" | "delete" | "rename";
	fileId?: string;
	/** meta 模式下的服务器寻址名（重试时用它请求服务器，绝不用真实路径） */
	serverPseudonym?: string;
	revision?: number;
	contentHash?: string;
	contentGeneration?: number;
	metaGeneration?: number;
	/** 解密并通过安全校验后的本地路径；路径校验失败时为空串 */
	realPath: string;
	renameFrom?: string;
	renameTo?: string;
	reason: string;
	retryCount: number;
	operationId: string;
	at: number;
}

/**
 * 一条已自动确认的远端变更留下的处置证据（v0.14.0-RC / 计划书 §8.8 第 10 条）。
 *
 * 发布门槛要求「所有自动确认的 sequence 都有 applied/conflict/blocked 证据」。
 * 没有这个账本，出问题时唯一能说的只有「游标推到了 5000」——
 * 而中间哪些变更真的落地了、哪些被跳过了、为什么跳过，全都无从查起。
 *
 * 有界保存（只留最近若干条）：这是诊断材料，不是需要永久保留的业务数据，
 * 让它无限增长只会把状态文件撑大。
 */
export interface SequenceEvidence {
	sequence: number;
	outcome: "applied" | "conflict" | "blocked" | "skipped";
	/** skipped 的具体原因——「跳过」如果没有原因，就等于没有证据 */
	reason?: string;
	at: number;
}

/** 证据账本的保留条数。够覆盖一次典型的批量同步，又不会让状态文件明显变大。 */
export const SEQUENCE_EVIDENCE_LIMIT = 500;

/**
 * 一次进行到一半的名字互换（v0.13.2 / §6.9）。
 *
 * A ↔ B 的互换必须借道临时名，而临时文件放在插件目录里——用户看不见。
 * 崩溃时如果没有这条记录，那份内容就静静地留在插件目录里等于丢失。
 * 因此意图先落盘、再动文件系统。
 */
export interface PendingSwap {
	/** 临时文件路径（插件目录下的 swap 命名空间） */
	tempPath: string;
	/** 临时文件里装的是哪个对象 */
	fileId: string;
	/** 它最终应该落到哪个真实路径 */
	targetPath: string;
	/**
	 * 它来自哪个真实路径（0.17.0-rc.3）：目标被真实占用、无法前进时，
	 * 恢复流程把它放回原位而不是永远滞留在插件目录里等一个不会空出来的目标
	 */
	sourcePath?: string;
}

/**
 * 本地状态所绑定的服务器与身份指纹（v0.12.1 / LS-121-C02）。
 *
 * server URL、Token、设备身份、vault key 文档任何一项变化，都意味着
 * 「本地这份 state 未必还属于对面那个仓库」——必须重新走一遍权威校验
 * （/info + 凭据 + vaultId/repoEpoch）才允许继续上传、删除、改名。
 * Token 只存不可逆摘要的前 16 位，绝不落盘明文。
 */
export interface BindingFingerprint {
	serverUrl: string;
	tokenDigest: string;
	deviceId: string;
	vaultKeyDigest: string;
	/** 目标仓库选择（v0.19 多仓库；空 = 默认仓库）。切换仓库立即触发重新绑定 */
	vaultChoice: string;
}

export interface PersistedState {
	deviceId: string;
	lastSequence: number;
	/**
	 * 账本归属（v0.18）：files/游标/信任锚这本账属于哪个仓库（vaultId）。
	 * 只在接入完成（completeBootstrap）时写入、只随账本作废（clearSyncLedger）
	 * 而清——与 bootstrap.remoteVaultId 不同，它**不会**被向导 preflight 的
	 * pending binding 覆盖，因此是「这本账是谁的」的唯一可信来源。
	 * 旧版本状态没有此字段（undefined = 归属未知）。
	 */
	ledgerVaultId?: string;
	files: Record<string, FileState>;
	conflicts: Record<string, PendingConflict>;
	/** vault key 文档缓存（只含加密后的密钥材料，可安全落盘） */
	e2ee: VaultKeyDoc | null;
	shares: Record<string, ShareRecord>;
	/**
	 * 待手动删除的路径（移动端删除安全，v6）：
	 * 远端已删除但本地移入回收站失败时，保留本地文件并记录在此——
	 * 扫描时跳过（不会被当作新文件重新上传），用户手动删除后自动清除。
	 */
	pendingDeletes: Record<string, number>;
	/** 首次接入状态（v8）：pending 时所有同步入口被 Gate 拦截，先走接入向导 */
	bootstrap: BootstrapState;
	/** 待推送队列的持久化镜像（v9；v9.3 起结构化，含 move）：重启后未完成的操作不丢 */
	pendingOps: Record<string, PendingOp>;
	/** 被阻塞的远端变更（v9）：如远端文件与本地文件夹同名；每轮同步重试 */
	blockedChanges: Record<string, BlockedChange>;
	/** 进行到一半的名字互换（v0.13.2 §6.9）：键为临时路径 */
	pendingSwaps: Record<string, PendingSwap>;
	/** 最近若干条已确认 sequence 的处置证据（v0.14.0-RC §8.8 第 10 条） */
	sequenceEvidence: SequenceEvidence[];
	/**
	 * 签名 checkpoint 的信任锚（v0.15 / §9.3）。
	 *
	 * null = 尚未建立信任链。此时**没有** freshness 保护——这不是缺陷而是
	 * 事实：新设备没有任何本地锚点，拿服务器给的第一个 manifest 当基准
	 * 等于让服务器自己定义「正确的历史」。信任必须由配对流程建立。
	 */
	trustAnchor: TrustAnchor | null;
	/** 已确认的 checkpoint hash 链（从旧到新，有界保留） */
	checkpointChain: string[];
	/**
	 * 已确认的绑定指纹（v0.12.1）：null = 尚未绑定（unbound），
	 * 任何写操作在重新完成权威校验之前都被 gate 拦截
	 */
	binding: BindingFingerprint | null;
	/**
	 * 灾备恢复记录（v0.13.1 / 计划书 §5.6）：repoEpoch 变化时写入，
	 * 恢复合并完成后清除。存在时接入向导走恢复流程而不是普通接入。
	 */
	recovery: RecoveryState | null;
}

function emptyState(): PersistedState {
	return {
		deviceId: "",
		lastSequence: 0,
		ledgerVaultId: undefined,
		files: {},
		conflicts: {},
		e2ee: null,
		shares: {},
		pendingDeletes: {},
		bootstrap: { ...PENDING_BOOTSTRAP },
		pendingOps: {},
		blockedChanges: {},
		pendingSwaps: {},
		sequenceEvidence: [],
		trustAnchor: null,
		checkpointChain: [],
		binding: null,
		recovery: null,
	};
}

/**
 * A/B 副本信封：generation 单调递增 + payload 校验和 + 写入所有权标记。
 *
 * owner 是每次写入的随机 token（v0.13.2 / §6.2）：读回时必须是我们刚写的那个。
 * 只比 generation 无法区分「我写成功了」和「另一个实例恰好写了同样的 generation」。
 * 旧版本（v0.12.x）写出的信封没有这个字段，读取时按 "" 处理，不影响升级。
 */
interface StateEnvelope {
	schemaVersion: 2;
	generation: number;
	checksum: string;
	owner?: string;
	payload: PersistedState;
}

/** 每次写入的随机所有权标记。 */
function newOwnershipToken(): string {
	const raw = new Uint8Array(8);
	crypto.getRandomValues(raw);
	let out = "";
	for (const b of raw) out += b.toString(16).padStart(2, "0");
	return out;
}

/**
 * 设备本地同步状态（v9 起 A/B 双副本日志）。
 *
 * state.json 记录着游标、每文件 revision、冲突与 E2EE 缓存——它损坏后
 * 「从零开始」等于让本设备把陈旧内容当新文件重新上传（可复活已删文件、
 * 制造大量假冲突）。因此：
 * - 写入走「非活动副本 → 读回校验 → 提升 generation」，任一时刻磁盘上
 *   总有一份完整可用的旧状态；
 * - 加载取 generation 更高的有效副本；两份全部损坏时进入 corrupted 停机，
 *   同步被硬性阻断并提示用户处理，绝不自动 starting fresh。
 */
export class StateStore {
	state: PersistedState = emptyState();

	/** 两份副本都损坏（且无可用旧版 state.json）：同步必须停机等用户处理。 */
	corrupted = false;

	/** 上次成功写入的槽位；save 总是写另一个槽。 */
	private activeSlot: "a" | "b" | null = null;
	private generation = 0;

	/**
	 * 保存串行化（v0.13.2 / §6.2）：任意时刻只有一个保存过程在跑。
	 * dirtyGeneration 每次 save() 递增，savedGeneration 记录已落盘到哪一版——
	 * 两者相等即「盘上的状态就是内存里的状态」。
	 */
	private saveChain: Promise<void> = Promise.resolve();
	private dirtyGeneration = 0;
	private savedGeneration = 0;

	constructor(
		private adapter: DataAdapter,
		private path: string,
	) {}

	private slotPath(slot: "a" | "b"): string {
		return this.path.replace(/\.json$/, `-${slot}.json`);
	}

	private async readEnvelope(slot: "a" | "b"): Promise<StateEnvelope | null> {
		const p = this.slotPath(slot);
		try {
			if (!(await this.adapter.exists(p))) return null;
			const env = JSON.parse(await this.adapter.read(p)) as StateEnvelope;
			if (env.schemaVersion !== 2 || typeof env.generation !== "number" || !env.payload) return null;
			const expect = await sha256Hex(encodeUtf8(JSON.stringify(env.payload)));
			if (env.checksum !== expect) return null;
			if (env.owner === undefined) env.owner = ""; // v0.12.x 写出的旧信封
			return env;
		} catch {
			return null;
		}
	}

	async load(): Promise<void> {
		const [a, b] = [await this.readEnvelope("a"), await this.readEnvelope("b")];
		const anySlotExists =
			(await this.adapter.exists(this.slotPath("a"))) || (await this.adapter.exists(this.slotPath("b")));

		let payload: Partial<PersistedState> | null = null;
		if (a || b) {
			const winner = (a?.generation ?? -1) >= (b?.generation ?? -1) ? a! : b!;
			payload = winner.payload;
			this.generation = winner.generation;
			this.activeSlot = winner === a ? "a" : "b";
		} else if (!anySlotExists) {
			// 旧版单文件 state.json（v0.8 及之前）→ 迁移读入
			try {
				if (await this.adapter.exists(this.path)) {
					payload = JSON.parse(await this.adapter.read(this.path)) as Partial<PersistedState>;
				}
			} catch (e) {
				console.error("[litesync] legacy state.json unreadable", e);
				this.corrupted = true;
				return;
			}
		} else {
			// 副本文件存在但全部损坏：停机保护，绝不 starting fresh
			console.error("[litesync] both state replicas are corrupt; sync halted");
			this.corrupted = true;
			return;
		}

		if (payload) this.state = normalizeState(payload);

		// 身份字段校验（v0.12.1 / LS-121-C03）：这些值只可能由本插件写入，
		// 出现非法格式说明状态文件被外部改写或写坏——继续同步会用错误的 AAD
		// 加密、或让抗回退检查失效，因此按「状态损坏」停机而不是静默修正
		const bad = firstInvalidIdentity(this.state.files);
		if (bad !== null) {
			console.error(`[litesync] state contains an invalid identity field (${bad}); sync halted`);
			this.corrupted = true;
			this.state = emptyState();
			return;
		}

		if (!this.state.deviceId) {
			this.state.deviceId = crypto.randomUUID();
			await this.save();
		}
	}

	/**
	 * 保存状态（v0.13.2 / 计划书 §6.2：串行化）。
	 *
	 * 之前每次 `save()` 都直接开写。同步流程里有大量并发的 `await store.save()`
	 * （pull/push/迁移各自都会存），两次保存可以交错成：
	 *
	 *   A 序列化了旧快照 → B 序列化了新快照 → B 写盘 → A 写盘（覆盖了 B）
	 *
	 * 于是**较早的状态覆盖了较新的状态**，重启后 lastSequence 回退、
	 * 刚建立的身份字段消失。这里改成单条 promise 链：任意时刻只有一个保存过程，
	 * 并且每次保存都在链上重新序列化当前 state——排队期间产生的新变更一定被带上。
	 */
	async save(): Promise<void> {
		if (this.corrupted) {
			console.error("[litesync] refusing to save over corrupt state");
			return;
		}
		this.dirtyGeneration++;
		// 链上排队：前一次保存失败也不能中断后续保存（否则状态永远停在旧版本）
		const chained = this.saveChain.then(
			() => this.persistOnce(),
			() => this.persistOnce(),
		);
		this.saveChain = chained.catch(() => {});
		return chained;
	}

	/**
	 * 实际落盘一次：写非活动副本 → 读回校验（generation + checksum + ownership
	 * token 三项都要对）→ 切换活动槽。
	 *
	 * ownership token 是本次写入的随机标记：读回时它必须是我们刚写的那一个。
	 * 只比对 generation 无法区分「我写成功了」与「另一个进程/另一份插件实例
	 * 恰好写了同样的 generation」——那种情况下两边会互相覆盖而谁都不报错。
	 */
	private async persistOnce(): Promise<void> {
		if (this.corrupted) return;
		const target: "a" | "b" = this.activeSlot === "a" ? "b" : "a";
		// 在链上序列化：排队期间新增的变更一定包含在内（后写的不会被先写的盖掉）
		const snapshotGeneration = this.dirtyGeneration;
		const payloadJson = JSON.stringify(this.state);
		const env: StateEnvelope = {
			schemaVersion: 2,
			generation: this.generation + 1,
			checksum: await sha256Hex(encodeUtf8(payloadJson)),
			owner: newOwnershipToken(),
			payload: JSON.parse(payloadJson) as PersistedState,
		};
		const p = this.slotPath(target);
		await this.adapter.write(p, JSON.stringify(env));
		// §8.1 注入点：非活动槽已写完，但 generation 还没提升。
		// 此刻崩溃时加载器会取 generation 更高的**旧**副本——即回到写入前的状态。
		// 「要么旧状态完整，要么新状态完整」在这里体现为「旧的那份完整」
		await evalFailpoint(FP.stateAfterSlotWrite);

		// 读回校验：写坏（磁盘满/中断）或被别人覆盖时保留另一份完好副本并报错
		const check = await this.readEnvelope(target);
		if (check === null || check.generation !== env.generation) {
			throw new Error(`state replica write verification failed (${p})`);
		}
		if (check.checksum !== env.checksum) {
			throw new Error(`state replica checksum mismatch after write-back (${p})`);
		}
		if (check.owner !== env.owner) {
			throw new Error(
				`state replica was overwritten by another writer (${p})；` +
					`请确认没有第二个 Obsidian 实例打开同一个 Vault`,
			);
		}
		// §8.1 注入点：即将把新槽认定为活动槽。这一步在内存里，但它决定了
		// 下次 save 写哪一个槽——注入失败会让本次 save 报错，调用方据此重试
		await evalFailpoint(FP.stateBeforePointerSwitch);
		this.generation = env.generation;
		this.activeSlot = target;
		this.savedGeneration = snapshotGeneration;
	}

	/** 是否还有尚未落盘的变更（测试与关闭流程用）。 */
	get hasUnsavedChanges(): boolean {
		return this.dirtyGeneration > this.savedGeneration;
	}

	get(path: string): FileState | undefined {
		return this.state.files[path];
	}

	/**
	 * 全量替换某路径的状态（仅用于「这是一个全新对象」的场景）。
	 * 更新已有对象请一律使用 {@link update}——否则会丢身份字段（LS-121-C04）。
	 *
	 * v0.13.2 §6.11：同步业务代码**禁止**直接调用本方法（ESLint 规则强制），
	 * 请改用下方的具名转换 {@link replaceWithNewObject} 等。
	 */
	set(path: string, fs: FileState): void {
		this.state.files[path] = fs;
	}

	// ---------- §6.11 强类型 FileState 转换 ----------
	//
	// 业务代码只应通过这几个具名转换修改 FileState。每个转换对应一个真实发生的
	// 事件，读代码时能直接看出「这里发生了什么」，而不是看到一个 patch 对象后
	// 还要反推它有没有漏字段。

	/**
	 * 内容更新：只改内容相关字段，身份字段一律沿用。
	 * 用于「同一个对象的内容变了」——本地保存、下载远端新版本、合并结果落地。
	 */
	patchContentState(path: string, patch: ContentPatch): FileState {
		return this.update(path, patch);
	}

	/**
	 * 采纳服务器返回的对象身份（上传/下载成功后）。
	 *
	 * 身份字段只允许经这里进入 FileState。注意它**不改内容字段**：
	 * 「服务器确认了身份」和「本地内容变了」是两件事，混在一起写最容易出错。
	 */
	applyRemoteIdentity(path: string, id: RemoteIdentity): FileState {
		return this.update(path, id);
	}

	/**
	 * 元数据改名落地：状态整体搬到新路径，身份不变，metaGeneration 前进。
	 * fileId / contentGeneration 绝不在改名时变化（INV-05）。
	 */
	applyMetaRenameState(from: string, to: string, id: RemoteIdentity & ContentPatch): void {
		this.rename(from, to, id);
	}

	/**
	 * 建立一个全新对象的状态（本地新建、或首次见到的远端对象）。
	 * 这是唯一允许**从零构造** FileState 的入口。
	 */
	replaceWithNewObject(path: string, fs: FileState): void {
		this.set(path, fs);
	}

	/**
	 * 不再跟踪该路径（本地或远端删除已完成）。
	 *
	 * 注意：服务器侧的 tombstone 由服务器维护（ADR-002），本地这里只是
	 * 「这台设备不再持有该对象的状态」。
	 */
	markDeleted(path: string): void {
		delete this.state.files[path];
	}

	/** 删除后重建：走服务器的 restore 语义，身份与 revision 连续（INV-06）。 */
	restoreObject(path: string, fs: FileState): void {
		this.set(path, fs);
	}

	/** 登记未解决冲突。 */
	recordConflict(path: string, c: PendingConflict): void {
		this.setConflict(path, c);
	}

	/**
	 * 某路径此刻的状态视图（§6.11 要求的类型层区分）。
	 *
	 * 一个路径可能同时挂着 tracked 状态、冲突登记、blocked 记录、待手动删除标记，
	 * 各处业务代码各查各的很容易漏掉一种。这里按**优先级**给出唯一答案：
	 * 冲突 > 阻塞 > 待手动删除 > 已跟踪 > 未跟踪。
	 */
	viewOf(path: string): ObjectView {
		const state = this.state.files[path];
		const conflict = this.state.conflicts[path];
		if (conflict !== undefined) return { kind: "conflict", path, state, conflict };
		const blockedKey = state?.fileId ?? path;
		const blocked = this.state.blockedChanges[blockedKey] ?? this.state.blockedChanges[path];
		if (blocked !== undefined) return { kind: "blocked", path, state, blocked };
		if (this.state.pendingDeletes[path] !== undefined) return { kind: "pending-delete", path };
		if (this.state.bootstrap.status === "pending") return { kind: "bootstrap-pending", path, state };
		if (state !== undefined) return { kind: "tracked", path, state };
		return { kind: "untracked", path };
	}

	/**
	 * 保身份更新（v0.12.1 / LS-121-C04）。
	 *
	 * 与旧代码里遍地的 `store.set(path, { hash, serverHash, revision, mtime, size })`
	 * 不同：未在 patch 中显式给出（或给出 undefined）的字段一律沿用旧值，
	 * 因此 fileId / generation / metaGeneration / serverPseudonym 不可能被
	 * 「顺手写一半字段」的调用悄悄抹掉。
	 */
	update(path: string, patch: Partial<FileState>): FileState {
		const prev = this.state.files[path];
		const next: FileState = {
			hash: prev?.hash ?? "",
			serverHash: prev?.serverHash ?? "",
			revision: prev?.revision ?? 0,
			mtime: prev?.mtime ?? 0,
			size: prev?.size ?? 0,
			...(prev?.fileId !== undefined ? { fileId: prev.fileId } : {}),
			...(prev?.generation !== undefined ? { generation: prev.generation } : {}),
			...(prev?.metaGeneration !== undefined ? { metaGeneration: prev.metaGeneration } : {}),
			...(prev?.metaFingerprint !== undefined ? { metaFingerprint: prev.metaFingerprint } : {}),
			...(prev?.serverPseudonym !== undefined ? { serverPseudonym: prev.serverPseudonym } : {}),
		};
		for (const [k, v] of Object.entries(patch)) {
			if (v === undefined) continue; // undefined 表示「本次不掌握该字段」，不是「清空」
			(next as unknown as Record<string, unknown>)[k] = v;
		}
		this.state.files[path] = next;
		return next;
	}

	/**
	 * 改名：把状态整体搬到新路径（身份字段全部保留）。
	 * meta 模式下伪名不随路径改变，因此 serverPseudonym/fileId 必须原样带走。
	 */
	rename(from: string, to: string, patch: Partial<FileState> = {}): void {
		const prev = this.state.files[from];
		if (prev === undefined) return;
		delete this.state.files[from];
		this.state.files[to] = { ...prev };
		this.update(to, patch);
	}

	delete(path: string): void {
		delete this.state.files[path];
	}

	paths(): string[] {
		return Object.keys(this.state.files);
	}

	/** 按稳定文件身份反查本地路径（meta 模式伪名解析用）。 */
	pathByFileId(fileId: string): string | undefined {
		for (const [path, fs] of Object.entries(this.state.files)) {
			if (fs.fileId === fileId) return path;
		}
		return undefined;
	}

	/**
	 * 跨平台碰撞检查（v0.13.2 / §6.12）。
	 *
	 * 返回一条已跟踪的、与 `path` 不同但在某个受支持平台上会映射到同一个文件的路径
	 * （大小写折叠、NFC/NFD、尾随点与空格、Windows 保留名）。
	 *
	 * `exceptFileId` 是「这次要落地的那个对象」自己的身份：同一个对象改大小写
	 * 不算碰撞，别的对象撞上来才算。
	 *
	 * 用途：Windows/macOS 上把两个只差大小写的远端文件写到本地，会让后写的那个
	 * 静默覆盖先写的那个——必须在写之前拦住，而不是事后发现内容丢了。
	 */
	collidingPath(path: string, exceptFileId?: string): string | undefined {
		const key = platformCollisionKey(path);
		for (const [p, fs] of Object.entries(this.state.files)) {
			if (p === path) continue;
			if (exceptFileId !== undefined && fs.fileId === exceptFileId) continue;
			if (platformCollisionKey(p) === key) return p;
		}
		return undefined;
	}

	getConflict(path: string): PendingConflict | undefined {
		return this.state.conflicts[path];
	}

	setConflict(path: string, c: PendingConflict): void {
		this.state.conflicts[path] = c;
	}

	clearConflict(path: string): void {
		delete this.state.conflicts[path];
	}

	conflictPaths(): string[] {
		return Object.keys(this.state.conflicts);
	}

	// ---------- Bootstrap（首次接入，v8） ----------

	get bootstrapReady(): boolean {
		return this.state.bootstrap.status === "ready";
	}

	/**
	 * 写入 pending binding（v0.13.1 / 计划书 §5.1）。
	 *
	 * preflight 一拿到服务器权威状态就调用：此后 bootstrap 期间的 LSE3/LSM1
	 * 加解密、伪名解析、Merge 上传都能用上正确的绑定材料，
	 * **绝不会**因为「正式状态还没写入」而回退到 LSE1 / 真实路径 / 无 fileId 上传。
	 * status 保持 pending——同步入口仍然被 Gate 拦着。
	 */
	setPendingBinding(binding: RepoBinding): void {
		this.state.bootstrap = { ...this.state.bootstrap, ...definedOnly(binding) };
	}

	/**
	 * 接入完成：把 pending binding **原子**转为 active。
	 * 保留 preflight already 写好的绑定字段，只补齐模式与游标并翻转 status。
	 */
	completeBootstrap(
		mode: BootstrapMode,
		remoteVaultId: string | undefined,
		snapshotSequence: number,
		repoEpoch?: string,
		keyEpoch?: number,
	): void {
		this.state.bootstrap = {
			...this.state.bootstrap,
			...definedOnly({ remoteVaultId, repoEpoch, keyEpoch }),
			status: "ready",
			mode,
			snapshotSequence,
			completedAt: Date.now(),
		};
		// 账本归属从此刻确立：接下来积累的 files/游标都属于这个仓库
		if (remoteVaultId) this.state.ledgerVaultId = remoteVaultId;
	}

	// ---------- 灾备恢复（v0.13.1 / 计划书 §5.6） ----------

	get recovery(): RecoveryState | null {
		return this.state.recovery;
	}

	enterRecovery(r: RecoveryState): void {
		this.state.recovery = r;
	}

	clearRecovery(): void {
		this.state.recovery = null;
	}

	/** 重置为待接入（vaultId/repoEpoch 变化 / 用户重跑向导 / 导入新配置时）。 */
	resetBootstrap(): void {
		this.state.bootstrap = { ...PENDING_BOOTSTRAP };
	}

	/**
	 * 换仓库（vaultId 变化）时作废整本同步账本（v0.18 实测缺陷，LS-121-C02）。
	 *
	 * repoEpoch 变化是「同一仓库的灾备恢复」——账本要保留去做恢复合并；
	 * vaultId 变化是「对面根本是另一个仓库」（换库/换账户/服务器重装）——
	 * files 里的 serverHash/revision、游标、队列、信任锚全都是**对旧仓库**的
	 * 陈述，带进新仓库的后果不是错误而是静默：扫描会把「从未上传到这个仓库」
	 * 的文件当成「已同步」，push 空转、状态栏假 synced、远端永远是空的。
	 *
	 * 只清账本，绝不动 Vault 里的用户文件；deviceId（本设备身份）保留。
	 */
	resetForNewRepository(): void {
		this.clearSyncLedger();
		this.state.shares = {};
		this.state.pendingDeletes = {};
		this.state.e2ee = null; // 旧仓库的密钥文档；下一轮 refreshE2ee 拉新仓库的
		this.state.recovery = null;
		this.resetBootstrap();
	}

	/**
	 * 只作废同步账本（files/游标/队列/冲突/信任锚），不动 bootstrap 与密钥。
	 * local-init 对空远端的自愈用（见 bootstrap-manager）：那里 bootstrap 流程
	 * 正在进行，不能整个 reset。
	 */
	clearSyncLedger(): void {
		this.state.ledgerVaultId = undefined;
		this.state.files = {};
		this.state.lastSequence = 0;
		this.state.conflicts = {};
		this.state.pendingOps = {};
		this.state.blockedChanges = {};
		this.state.trustAnchor = null;
		this.state.checkpointChain = [];
	}

	// ---------- 待手动删除（移动端删除安全，v6） ----------

	hasPendingDelete(path: string): boolean {
		return this.state.pendingDeletes[path] !== undefined;
	}

	setPendingDelete(path: string): void {
		this.state.pendingDeletes[path] = Date.now();
	}

	clearPendingDelete(path: string): void {
		delete this.state.pendingDeletes[path];
	}

	// ---------- 绑定指纹（v0.12.1 / LS-121-C02） ----------

	get binding(): BindingFingerprint | null {
		return this.state.binding;
	}

	/** 当前状态是否绑定到给定指纹（任一字段不同 = 必须重新绑定）。 */
	isBoundTo(fp: BindingFingerprint): boolean {
		const b = this.state.binding;
		return (
			b !== null &&
			b.serverUrl === fp.serverUrl &&
			b.tokenDigest === fp.tokenDigest &&
			b.deviceId === fp.deviceId &&
			b.vaultKeyDigest === fp.vaultKeyDigest &&
			b.vaultChoice === fp.vaultChoice
		);
	}

	/** 权威校验通过后固定绑定（只能由 SyncManager 的重新绑定流程调用）。 */
	setBinding(fp: BindingFingerprint): void {
		this.state.binding = { ...fp };
	}

	clearBinding(): void {
		this.state.binding = null;
	}

	// ---------- 被阻塞的远端变更（v9；v0.13.2 §6.4 完整记录） ----------

	/**
	 * 登记/更新一条被阻塞的远端变更，返回它的键。
	 *
	 * 键优先取 fileId：同一个对象改名后真实路径会变，用路径当键会在改名后
	 * 留下一条永远不会被清除的孤儿记录。
	 *
	 * 重复登记同一条时累加 retryCount 并保留原 operationId——它是这次「重放」
	 * 的幂等键，重试必须沿用。
	 */
	setBlockedChange(rec: Omit<BlockedChange, "retryCount" | "at" | "operationId">): string {
		const key = rec.fileId ?? rec.realPath;
		const prev = this.state.blockedChanges[key];
		this.state.blockedChanges[key] = {
			...rec,
			retryCount: (prev?.retryCount ?? 0) + 1,
			operationId: prev?.operationId ?? newOwnershipToken() + newOwnershipToken(),
			at: Date.now(),
		};
		return key;
	}

	getBlockedChange(key: string): BlockedChange | undefined {
		return this.state.blockedChanges[key];
	}

	clearBlockedChange(key: string): void {
		delete this.state.blockedChanges[key];
	}

	/** 当前所有被阻塞的变更（键 + 记录）。 */
	blockedChanges(): Array<[string, BlockedChange]> {
		return Object.entries(this.state.blockedChanges);
	}

	// ---------- 名字互换的中断恢复（v0.13.2 §6.9） ----------

	setPendingSwap(swap: PendingSwap): void {
		this.state.pendingSwaps[swap.tempPath] = { ...swap };
	}

	clearPendingSwap(tempPath: string): void {
		delete this.state.pendingSwaps[tempPath];
	}

	pendingSwaps(): PendingSwap[] {
		return Object.values(this.state.pendingSwaps);
	}

	// ---------- sequence 处置证据（v0.14.0-RC §8.8 第 10 条） ----------

	/**
	 * 记录一条已确认 sequence 的处置结果。
	 *
	 * 必须在推进游标**之前**调用：先有证据再确认，顺序反过来的话，
	 * 中间崩溃会留下一个「确认了但没人知道为什么」的 sequence。
	 */
	recordSequenceEvidence(e: SequenceEvidence): void {
		this.state.sequenceEvidence.push(e);
		if (this.state.sequenceEvidence.length > SEQUENCE_EVIDENCE_LIMIT) {
			this.state.sequenceEvidence.splice(0, this.state.sequenceEvidence.length - SEQUENCE_EVIDENCE_LIMIT);
		}
	}

	/** 最近的处置证据（诊断用，最新的在最后）。 */
	sequenceEvidence(): SequenceEvidence[] {
		return this.state.sequenceEvidence;
	}
}

/** 把任意来源（旧版/新版）的 payload 规整为完整 PersistedState。 */
function normalizeState(raw: Partial<PersistedState>): PersistedState {
	const state: PersistedState = {
		deviceId: typeof raw.deviceId === "string" ? raw.deviceId : "",
		lastSequence: typeof raw.lastSequence === "number" ? raw.lastSequence : 0,
		ledgerVaultId: typeof raw.ledgerVaultId === "string" ? raw.ledgerVaultId : undefined,
		files: raw.files && typeof raw.files === "object" ? raw.files : {},
		conflicts: raw.conflicts && typeof raw.conflicts === "object" ? raw.conflicts : {},
		e2ee: raw.e2ee && typeof raw.e2ee === "object" ? raw.e2ee : null,
		shares: raw.shares && typeof raw.shares === "object" ? raw.shares : {},
		pendingDeletes: raw.pendingDeletes && typeof raw.pendingDeletes === "object" ? raw.pendingDeletes : {},
		bootstrap:
			raw.bootstrap && typeof raw.bootstrap === "object" ? raw.bootstrap : { ...PENDING_BOOTSTRAP },
		pendingOps: normalizePendingOps(raw.pendingOps),
		blockedChanges: normalizeBlockedChanges(raw.blockedChanges),
		pendingSwaps: normalizePendingSwaps(raw.pendingSwaps),
		sequenceEvidence: Array.isArray(raw.sequenceEvidence) ? raw.sequenceEvidence.slice(-SEQUENCE_EVIDENCE_LIMIT) : [],
		trustAnchor: normalizeTrustAnchor(raw.trustAnchor),
		checkpointChain: Array.isArray(raw.checkpointChain) ? raw.checkpointChain.slice(-64) : [],
		binding: normalizeBinding(raw.binding),
		recovery: raw.recovery && typeof raw.recovery === "object" ? raw.recovery : null,
	};
	// v0.2 状态升级：当时全部为明文，serverHash 与 hash 相同
	for (const fs of Object.values(state.files)) {
		if (!fs.serverHash) fs.serverHash = fs.hash;
	}
	// v0.8 升级：已经在正常同步中的老设备无 bootstrap 字段，
	// 自动视为已接入（绝不能让升级用户突然被向导拦住）
	if (!raw.bootstrap && (state.lastSequence > 0 || Object.keys(state.files).length > 0)) {
		state.bootstrap = { status: "ready", mode: "legacy", completedAt: Date.now() };
	}
	return state;
}

/** 过滤掉 undefined：合并绑定字段时「本次不掌握」不得清空已有值。 */
function definedOnly<T extends object>(o: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		if (v !== undefined) out[k] = v;
	}
	return out as Partial<T>;
}

/**
 * 计算当前配置对应的绑定指纹（v0.12.1 / LS-121-C02）。
 * Token 与 vault key 只取不可逆摘要的前 16 位——足以检测变化，
 * 又不会把凭据材料以任何可用形式写进 state.json。
 */
export async function computeBinding(input: {
	serverUrl: string;
	apiToken: string;
	deviceId: string;
	vaultKey: VaultKeyDoc | null;
	/** 目标仓库选择（v0.19；空 = 默认仓库） */
	vaultChoice?: string;
}): Promise<BindingFingerprint> {
	const digest = async (label: string, value: string): Promise<string> =>
		value === "" ? "" : (await sha256Hex(encodeUtf8(`litesync/v1/binding/${label}:${value}`))).slice(0, 16);
	const keyMaterial = input.vaultKey ? `${input.vaultKey.salt}|${input.vaultKey.wrappedKey}` : "";
	return {
		serverUrl: input.serverUrl.trim().replace(/\/+$/, ""),
		tokenDigest: await digest("token", input.apiToken),
		deviceId: input.deviceId,
		vaultKeyDigest: await digest("vault-key", keyMaterial),
		vaultChoice: input.vaultChoice ?? "",
	};
}

/**
 * 返回第一个非法身份字段的描述（全部合法返回 null）。
 * 只检查「已存在」的可选字段：升级上来的老状态没有这些字段是正常的。
 */
function firstInvalidIdentity(files: Record<string, FileState>): string | null {
	for (const [path, fs] of Object.entries(files)) {
		if (fs.fileId !== undefined && !isFileId(fs.fileId)) return `${path}.fileId`;
		if (fs.generation !== undefined && !isGeneration(fs.generation)) return `${path}.generation`;
		if (fs.metaGeneration !== undefined && !isGeneration(fs.metaGeneration)) return `${path}.metaGeneration`;
		if (fs.serverPseudonym !== undefined && !isFileId(fs.serverPseudonym)) return `${path}.serverPseudonym`;
	}
	return null;
}

/**
 * 绑定指纹规整（v0.12.1）：字段不全 = 视为未绑定。
 * 从 v0.12.0 及更早版本升级上来的设备天然没有这个字段——它们会在下一轮
 * 同步的权威校验（/info + 凭据 + vaultId/repoEpoch）通过后自动补记录。
 */
function normalizeBinding(raw: unknown): BindingFingerprint | null {
	if (!raw || typeof raw !== "object") return null;
	const b = raw as Partial<BindingFingerprint>;
	if (
		typeof b.serverUrl !== "string" ||
		typeof b.tokenDigest !== "string" ||
		typeof b.deviceId !== "string" ||
		typeof b.vaultKeyDigest !== "string"
	) {
		return null;
	}
	// v0.19 新增字段缺失（旧状态）→ 视为未绑定，触发一次无损的重新校验
	if (typeof b.vaultChoice !== "string") return null;
	return {
		serverUrl: b.serverUrl,
		tokenDigest: b.tokenDigest,
		deviceId: b.deviceId,
		vaultKeyDigest: b.vaultKeyDigest,
		vaultChoice: b.vaultChoice,
	};
}

/**
 * blockedChanges 规整（v0.13.2 §6.4）：v9~v0.13.1 的记录只有 `{reason, at}` 且以
 * 真实路径为键。升级时把它们补成完整记录——缺的身份字段留空，
 * 第一次重试会重新解析（宁可多做一次解析，也不凭空编造 revision/hash）。
 */
function normalizeBlockedChanges(raw: unknown): Record<string, BlockedChange> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, BlockedChange> = {};
	for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== "object") continue;
		const b = v as Partial<BlockedChange>;
		const action = b.action === "delete" || b.action === "rename" ? b.action : "upsert";
		out[key] = {
			sequence: typeof b.sequence === "number" ? b.sequence : 0,
			action,
			realPath: typeof b.realPath === "string" ? b.realPath : key,
			reason: typeof b.reason === "string" ? b.reason : "（升级前登记，原因未记录）",
			retryCount: typeof b.retryCount === "number" ? b.retryCount : 0,
			operationId: typeof b.operationId === "string" ? b.operationId : "",
			at: typeof b.at === "number" ? b.at : Date.now(),
			...definedOnly({
				fileId: b.fileId,
				serverPseudonym: b.serverPseudonym,
				revision: b.revision,
				contentHash: b.contentHash,
				contentGeneration: b.contentGeneration,
				metaGeneration: b.metaGeneration,
				renameFrom: b.renameFrom,
				renameTo: b.renameTo,
			}),
		};
	}
	return out;
}

/**
 * 信任锚规整（v0.15 §9.3）：字段不全一律丢弃回 null。
 *
 * 宁可「没有信任链」也不要「半个信任链」：一个缺了公钥集合的锚会让
 * 所有 checkpoint 都被判成 unknown-signer，用户只会看到同步莫名其妙地停了。
 */
function normalizeTrustAnchor(raw: unknown): TrustAnchor | null {
	if (!raw || typeof raw !== "object") return null;
	const a = raw as Partial<TrustAnchor>;
	if (typeof a.repoEpoch !== "string" || typeof a.checkpointHash !== "string") return null;
	if (typeof a.headSequence !== "number") return null;
	if (!a.devicePublicKeys || typeof a.devicePublicKeys !== "object") return null;
	return {
		repoEpoch: a.repoEpoch,
		checkpointHash: a.checkpointHash,
		headSequence: a.headSequence,
		devicePublicKeys: a.devicePublicKeys,
		revokedDevices: Array.isArray(a.revokedDevices) ? a.revokedDevices : [],
		updatedAt: typeof a.updatedAt === "number" ? a.updatedAt : 0,
	};
}

/** pendingSwaps 规整：字段不全的记录一律丢弃（宁可不做，也不能搬错文件）。 */
function normalizePendingSwaps(raw: unknown): Record<string, PendingSwap> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, PendingSwap> = {};
	for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== "object") continue;
		const s = v as Partial<PendingSwap>;
		if (typeof s.tempPath !== "string" || typeof s.fileId !== "string" || typeof s.targetPath !== "string") {
			continue;
		}
		out[key] = { tempPath: s.tempPath, fileId: s.fileId, targetPath: s.targetPath };
	}
	return out;
}

/** pendingOps 规整：兼容 v9.2 之前的字符串形式（"upsert"/"delete"）。 */
function normalizePendingOps(raw: unknown): Record<string, PendingOp> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, PendingOp> = {};
	for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
		if (v === "upsert" || v === "delete") {
			out[path] = { action: v };
		} else if (v && typeof v === "object" && "action" in v) {
			const op = v as PendingOp;
			if (op.action === "upsert" || op.action === "delete" || op.action === "move") out[path] = op;
		}
	}
	return out;
}
