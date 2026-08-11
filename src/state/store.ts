import { DataAdapter } from "obsidian";
import { BootstrapMode, BootstrapState, PENDING_BOOTSTRAP } from "../bootstrap/bootstrap-types";
import { VaultKeyDoc } from "../crypto/crypto";
import { PendingOp } from "../sync/queue";
import { sha256Hex } from "../utils/hash";
import { encodeUtf8 } from "../utils/text";

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
}

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
}

/** 被本地条件阻塞、必须持续重试的远端变更（v9：skipped 不再静默 ACK）。 */
export interface BlockedChange {
	reason: string;
	at: number;
}

export interface PersistedState {
	deviceId: string;
	lastSequence: number;
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
}

function emptyState(): PersistedState {
	return {
		deviceId: "",
		lastSequence: 0,
		files: {},
		conflicts: {},
		e2ee: null,
		shares: {},
		pendingDeletes: {},
		bootstrap: { ...PENDING_BOOTSTRAP },
		pendingOps: {},
		blockedChanges: {},
	};
}

/** A/B 副本信封：generation 单调递增 + payload 校验和。 */
interface StateEnvelope {
	schemaVersion: 2;
	generation: number;
	checksum: string;
	payload: PersistedState;
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
		if (!this.state.deviceId) {
			this.state.deviceId = crypto.randomUUID();
			await this.save();
		}
	}

	/**
	 * 保存状态：写非活动副本 → 读回校验 → 切换活动槽。
	 * corrupted 停机状态下拒绝写入（同步已被阻断，不允许覆盖现场）。
	 */
	async save(): Promise<void> {
		if (this.corrupted) {
			console.error("[litesync] refusing to save over corrupt state");
			return;
		}
		const target: "a" | "b" = this.activeSlot === "a" ? "b" : "a";
		const payloadJson = JSON.stringify(this.state);
		const env: StateEnvelope = {
			schemaVersion: 2,
			generation: this.generation + 1,
			checksum: await sha256Hex(encodeUtf8(payloadJson)),
			payload: JSON.parse(payloadJson) as PersistedState,
		};
		const p = this.slotPath(target);
		await this.adapter.write(p, JSON.stringify(env));
		// 读回校验：写坏（磁盘满/中断）时保留另一份完好副本并报错
		const check = await this.readEnvelope(target);
		if (check === null || check.generation !== env.generation) {
			throw new Error(`state replica write verification failed (${p})`);
		}
		this.generation = env.generation;
		this.activeSlot = target;
	}

	get(path: string): FileState | undefined {
		return this.state.files[path];
	}

	set(path: string, fs: FileState): void {
		this.state.files[path] = fs;
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

	completeBootstrap(
		mode: BootstrapMode,
		remoteVaultId: string | undefined,
		snapshotSequence: number,
		repoEpoch?: string,
		keyEpoch?: number,
	): void {
		this.state.bootstrap = {
			status: "ready",
			mode,
			remoteVaultId,
			repoEpoch,
			keyEpoch,
			snapshotSequence,
			completedAt: Date.now(),
		};
	}

	/** 重置为待接入（vaultId/repoEpoch 变化 / 用户重跑向导 / 导入新配置时）。 */
	resetBootstrap(): void {
		this.state.bootstrap = { ...PENDING_BOOTSTRAP };
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

	// ---------- 被阻塞的远端变更（v9） ----------

	setBlockedChange(path: string, reason: string): void {
		this.state.blockedChanges[path] = { reason, at: Date.now() };
	}

	clearBlockedChange(path: string): void {
		delete this.state.blockedChanges[path];
	}

	blockedChangePaths(): string[] {
		return Object.keys(this.state.blockedChanges);
	}
}

/** 把任意来源（旧版/新版）的 payload 规整为完整 PersistedState。 */
function normalizeState(raw: Partial<PersistedState>): PersistedState {
	const state: PersistedState = {
		deviceId: typeof raw.deviceId === "string" ? raw.deviceId : "",
		lastSequence: typeof raw.lastSequence === "number" ? raw.lastSequence : 0,
		files: raw.files && typeof raw.files === "object" ? raw.files : {},
		conflicts: raw.conflicts && typeof raw.conflicts === "object" ? raw.conflicts : {},
		e2ee: raw.e2ee && typeof raw.e2ee === "object" ? raw.e2ee : null,
		shares: raw.shares && typeof raw.shares === "object" ? raw.shares : {},
		pendingDeletes: raw.pendingDeletes && typeof raw.pendingDeletes === "object" ? raw.pendingDeletes : {},
		bootstrap:
			raw.bootstrap && typeof raw.bootstrap === "object" ? raw.bootstrap : { ...PENDING_BOOTSTRAP },
		pendingOps: normalizePendingOps(raw.pendingOps),
		blockedChanges: raw.blockedChanges && typeof raw.blockedChanges === "object" ? raw.blockedChanges : {},
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
