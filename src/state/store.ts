import { DataAdapter } from "obsidian";
import { BootstrapMode, BootstrapState, PENDING_BOOTSTRAP, RecoveryState, RepoBinding } from "../bootstrap/bootstrap-types";
import { VaultKeyDoc } from "../crypto/crypto";
import { PendingOp } from "../sync/queue";
import { sha256Hex } from "../utils/hash";
import { encodeUtf8 } from "../utils/text";
import { isFileId, isGeneration } from "../utils/validate";

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
export const FILE_IDENTITY_FIELDS = ["fileId", "generation", "metaGeneration", "serverPseudonym"] as const;

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
		files: {},
		conflicts: {},
		e2ee: null,
		shares: {},
		pendingDeletes: {},
		bootstrap: { ...PENDING_BOOTSTRAP },
		pendingOps: {},
		blockedChanges: {},
		binding: null,
		recovery: null,
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

	/**
	 * 全量替换某路径的状态（仅用于「这是一个全新对象」的场景）。
	 * 更新已有对象请一律使用 {@link update}——否则会丢身份字段（LS-121-C04）。
	 */
	set(path: string, fs: FileState): void {
		this.state.files[path] = fs;
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
			b.vaultKeyDigest === fp.vaultKeyDigest
		);
	}

	/** 权威校验通过后固定绑定（只能由 SyncManager 的重新绑定流程调用）。 */
	setBinding(fp: BindingFingerprint): void {
		this.state.binding = { ...fp };
	}

	clearBinding(): void {
		this.state.binding = null;
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
}): Promise<BindingFingerprint> {
	const digest = async (label: string, value: string): Promise<string> =>
		value === "" ? "" : (await sha256Hex(encodeUtf8(`litesync/v1/binding/${label}:${value}`))).slice(0, 16);
	const keyMaterial = input.vaultKey ? `${input.vaultKey.salt}|${input.vaultKey.wrappedKey}` : "";
	return {
		serverUrl: input.serverUrl.trim().replace(/\/+$/, ""),
		tokenDigest: await digest("token", input.apiToken),
		deviceId: input.deviceId,
		vaultKeyDigest: await digest("vault-key", keyMaterial),
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
	return { serverUrl: b.serverUrl, tokenDigest: b.tokenDigest, deviceId: b.deviceId, vaultKeyDigest: b.vaultKeyDigest };
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
