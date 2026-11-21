/**
 * 「用本地完整替换远端」高级恢复作业（0.20 / ADR-016，验收 SY-04）。
 *
 * 与 local-init 是两件事：local-init 只把本地内容推进一个**空**远端；本作业面对的是
 * 非空远端，要让远端在同步范围内变成本设备的样子——覆盖不同的、删除多出来的、
 * 新建缺少的。它是破坏性操作，所以：
 *
 *   1. 计划（dry-run）：按路径对齐两边，记下每个对象此刻的远端 revision 与内容 hash、
 *      本地明文 hash，以及整个远端的水位 headSequence；每个条目的 operationId 在这里固定；
 *   2. 确认：用户必须原样输入目标仓库名；
 *   3. 恢复点：把将被覆盖/删除的每个远端对象的**原始字节**（E2EE 下即密文）下载、校验
 *      hash、**解密校验**后存进插件目录（不参与同步）——这份恢复点不依赖服务器的历史保留策略；
 *   4. 执行：逐对象带 expected revision 写入；删除一律走 DELETE（tombstone，不清表）；
 *      任一对象 CAS 失败或本地在预览后又被改过 → 整个作业 paused_stale，只能重新预览；
 *   5. 收尾：检查计划水位之后的全部变更都是本作业写的，否则同样 paused_stale；
 *   6. 反向作业：按恢复点把远端（以及跟随远端的本设备）恢复到替换之前，产生新 revision，
 *      不回退任何计数器。
 *
 * 0.20.1（复审 PL-02～PL-05）：
 *   - 「预留 fileId」与「远端对象已建档」分开：新对象（含反向重建）的请求总是带 LSM1 元数据与
 *     canonical HMAC；本地 FileState 只在服务器确认之后才写；
 *   - 执行许可（{@link ReplacePermit}）：只豁免本作业自己持有的迁移锁与接入向导里合法的 bootstrap 阶段，
 *     状态损坏、完整性、协议、凭据、epoch、连接 / 密钥会话变化照样挡停；确认前、续跑时、每个破坏性动作前都复核；
 *   - 每个动作的本地前置条件（delete = 仍不存在，keep = 仍是预览内容，其余 = 仍是预览 hash），
 *     执行前整体预检一次、每个动作前再查一次；
 *   - 墓碑上重建是持久化的 restore→upload 子状态机（{@link RestoreStep}），稳定幂等键，结果可恢复。
 *
 * fileId / revision / generation / tombstone / repoEpoch 语义全部沿用同步协议，
 * 不新增任何服务端写接口。
 */
import { ApiError, ConflictError, NotFoundError, SnapshotFile } from "../api/client";
import { newFileId } from "../crypto/crypto";
import { E2eeLockedError } from "../crypto/keyring";
import { SyncContext } from "../sync/context";
import { GateReason } from "../sync/gate";
import { resolveSnapshotPaths } from "../sync/pull";
import { requestRestore } from "../sync/push";
import { newOperationId } from "../sync/queue";
import { decodeSnapshot, downloadPlain, metaEncrypted, UploadOptions, UploadOutcome, uploadFromPlain } from "../sync/transfer";
import { evalFailpoint, FP } from "../utils/failpoint";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { platformCollisionKey } from "../utils/vault-path";
import { ReplaceCounts, ReplaceItem, ReplaceJob, RestoreStep } from "./replace-types";

export interface ReplaceProgress {
	phase: "plan" | "snapshot" | "run" | "verify";
	done: number;
	total: number;
	current: string;
}
type OnProgress = (p: ReplaceProgress) => void;

/**
 * 执行顺序（0.20.1 调整，复审 PL-02）：
 *   覆盖 → 墓碑重建 → 新建 → 删除 → 「要占用被删对象名字」的重建 / 新建 → 不变。
 *
 * 新建放在删除**之前**：新建失败时远端还没少任何东西（原来先删后建，新建一失败就留下
 * 一个只删不建的远端）。只有与某个待删对象仅大小写 / Unicode 写法不同的新建或重建，
 * 必须等删除先腾出名字（否则服务器按同名碰撞拒绝）。
 */
function orderRank(it: ReplaceItem, deleteKeys: Set<string>): number {
	const freesName = deleteKeys.has(platformCollisionKey(it.path));
	switch (it.action) {
		case "update":
			return 0;
		case "restore":
			return freesName ? 4 : 1;
		case "create":
			return freesName ? 4 : 2;
		case "delete":
			return 3;
		case "keep":
			return 5;
	}
}

function sortItems(items: ReplaceItem[]): void {
	const deleteKeys = new Set(items.filter((i) => i.action === "delete").map((i) => platformCollisionKey(i.path)));
	items.sort((a, b) => orderRank(a, deleteKeys) - orderRank(b, deleteKeys) || a.path.localeCompare(b.path));
}

export type ReplaceJobErrorCode =
	| "remote-empty"
	| "vault-changed"
	| "invalid-state"
	| "snapshot-failed"
	| "locked"
	| "conflicts-pending"
	| "blocked";

export class ReplaceJobError extends Error {
	constructor(
		message: string,
		public code: ReplaceJobErrorCode,
		/** code=blocked 时：被哪一道门挡下 */
		public blockReason?: ReplaceBlockReason,
	) {
		super(message);
		this.name = "ReplaceJobError";
	}
}

// ---------- 执行许可（0.20.1 / 复审 PL-03） ----------

/** 完整替换作业冻结普通同步用的迁移锁所有者：作业许可只豁免这一把。 */
export const REPLACE_LOCK_OWNER = "replace-remote-job";

export type ReplaceBlockReason = GateReason | "context-changed" | "key-session-changed" | "bootstrap-changed";

export interface ReplaceBlock {
	reason: ReplaceBlockReason;
	message: string;
}

/**
 * 作业的执行许可：开始执行（或续跑）时签发，记下当时的连接上下文与密钥会话代次。
 * 不落盘——重启之后必须重新签发（重新核对一遍门与 /info 身份）。
 */
export interface ReplacePermit {
	jobId: string;
	contextGeneration: number;
	keyGeneration: number;
}

/**
 * 作业能不能动手（返回 null = 可以）。
 *
 * 普通同步的 gate 在这里**只有两处**被豁免：本作业自己持有的迁移锁（作业执行期间冻结普通同步
 * 用的就是它），以及接入向导里的作业所处的 bootstrap-pending / 尚未正式绑定阶段（那时权威校验由作业
 * 开始时的 /info 身份核对承担）。状态损坏、完整性、协议、凭据、repoEpoch、别的迁移、密钥锁定一律照常挡停；
 * 给了许可时再核对连接上下文与密钥会话自签发以来没有变过。
 */
export function replaceBlock(
	ctx: SyncContext,
	job: Pick<ReplaceJob, "bootstrapContext">,
	permit?: ReplacePermit,
): ReplaceBlock | null {
	if (ctx.store.corrupted) {
		return {
			reason: "state-corrupted",
			message: "本地同步状态文件损坏（state-a/state-b.json 均无法读取），已停止一切写入；请从备份恢复状态文件或重新接入",
		};
	}
	if (job.bootstrapContext) {
		if (ctx.store.bootstrapReady) {
			return {
				reason: "bootstrap-changed",
				message: "这个作业是在接入向导里生成的，而本设备此后已经完成了接入：作业不再适用，请重新预览",
			};
		}
	} else if (!ctx.store.bootstrapReady) {
		return { reason: "bootstrap-pending", message: "本设备尚未完成接入，不能执行这个作业" };
	}
	const session = ctx.gate.sessionBlock({ exemptMigrationOwner: REPLACE_LOCK_OWNER, exemptUnbound: job.bootstrapContext });
	if (session !== null) return session;
	if (ctx.e2ee.needsUnlock) return { reason: "key-locked", message: "仓库已锁定：请先解锁，再继续这个作业" };
	if (permit !== undefined) {
		if (permit.contextGeneration !== ctx.e2ee.contextGeneration) {
			return {
				reason: "context-changed",
				message: "作业开始之后服务器、凭据或目标仓库发生了变化：已停止，之后的条目一个都没有写",
			};
		}
		if (ctx.e2ee.enabled && permit.keyGeneration !== ctx.e2ee.generation) {
			return {
				reason: "key-session-changed",
				message: "作业开始之后仓库被锁定或重新解锁：已停止，之后的条目一个都没有写；确认无误后可以继续",
			};
		}
	}
	return null;
}

function blockedError(block: ReplaceBlock): ReplaceJobError {
	return new ReplaceJobError(`已停止，没有写入：${block.message}`, "blocked", block.reason);
}

/** 签发执行许可；当前就被挡住时抛 ReplaceJobError(blocked)。 */
export function openReplacePermit(ctx: SyncContext, job: ReplaceJob): ReplacePermit {
	const block = replaceBlock(ctx, job);
	if (block !== null) throw blockedError(block);
	return { jobId: job.jobId, contextGeneration: ctx.e2ee.contextGeneration, keyGeneration: ctx.e2ee.generation };
}

/** 每个破坏性动作之前调用：被挡住时记下原因（诊断用）并抛出。 */
function requirePermit(ctx: SyncContext, job: ReplaceJob, permit: ReplacePermit): void {
	const block = permit.jobId === job.jobId ? replaceBlock(ctx, job, permit) : { reason: "context-changed" as const, message: "执行许可不属于这个作业" };
	if (block === null) return;
	job.lastBlock = { reason: block.reason, message: block.message, at: Date.now() };
	throw blockedError(block);
}

// ---------- 恢复点与作业持久化 ----------

/**
 * 恢复点目录（插件目录下，被 IgnoreMatcher 无条件排除，永不参与同步）。
 *
 * 刻意不放在 LocalCommitter 的 `recovery/` 里：那个目录按一周保留期自动清理，
 * 而作业恢复点要留到用户自己决定删除为止。
 */
export function recoveryDir(ctx: SyncContext, jobId: string): string {
	return `${ctx.pluginDir()}/replace-recovery/${jobId}`;
}

/** 逐级创建目录（移动端 adapter.mkdir 不保证递归创建父目录）。 */
async function ensureDir(ctx: SyncContext, dir: string): Promise<void> {
	await ensureParentFolder(ctx.app.vault.adapter, `${dir}/.keep`);
}

/**
 * 写恢复点文件。这是本模块**唯一**直接写盘的地方，且只写插件目录下的 recovery/：
 * §6.1 的禁令针对「覆盖用户内容」——用户文件一律经 LocalCommitter，这里一个都碰不到，
 * 运行时再校验一次路径（必须在插件目录的 replace-recovery/ 下），防止将来有人把它误用到用户文件上。
 */
async function writeRecoveryFile(ctx: SyncContext, path: string, data: ArrayBuffer): Promise<void> {
	const root = `${ctx.pluginDir()}/replace-recovery/`;
	if (!path.startsWith(root) || path.includes("..")) throw new Error(`恢复点路径越界：${path}`);
	// eslint-disable-next-line no-restricted-syntax -- 只写插件自己的 replace-recovery/ 目录（见上方说明与路径校验）
	await ctx.app.vault.adapter.writeBinary(path, data);
}

function serverPseudonymOf(f: SnapshotFile): string | undefined {
	return f.metaEnc && f.fileId ? f.fileId : undefined;
}

function emptyCounts(): ReplaceCounts {
	return { create: 0, update: 0, delete: 0, keep: 0, outOfScope: 0 };
}

function countItems(items: ReplaceItem[], outOfScope: number): ReplaceCounts {
	const c = emptyCounts();
	c.outOfScope = outOfScope;
	for (const it of items) {
		if (it.action === "create") c.create++;
		else if (it.action === "update") c.update++;
		else if (it.action === "delete") c.delete++;
		else if (it.action === "keep") c.keep++;
		else if (it.action === "restore") c.create++;
	}
	return c;
}

async function persistJob(ctx: SyncContext, job: ReplaceJob): Promise<void> {
	ctx.store.state.replaceJob = job;
	await ctx.store.save();
}

function jobIdNow(): string {
	return newOperationId().slice(0, 16);
}

// ---------- 计划 ----------

/**
 * 计划（dry-run）：只读，不写远端、不动本地文件。
 *
 * 远端为空时抛 remote-empty——那是 local-init 的场景，必须分开命名（SY-03）。
 * 状态损坏、完整性 / 协议 / 凭据 / epoch 停机时不出预览（同一套作业许可判定）。
 */
export async function planReplaceRemote(
	ctx: SyncContext,
	opts: { vaultName: string; vaultChoice: string; bootstrapContext: boolean; onProgress?: OnProgress; now?: number },
): Promise<ReplaceJob> {
	if (ctx.e2ee.needsUnlock) throw new E2eeLockedError();
	const block = replaceBlock(ctx, { bootstrapContext: opts.bootstrapContext });
	if (block !== null) throw new ReplaceJobError(`无法生成预览：${block.message}`, "blocked", block.reason);
	if (ctx.store.conflictPaths().length > 0) {
		throw new ReplaceJobError("还有未解决的同步冲突：请先处理冲突，再生成替换预览。", "conflicts-pending");
	}
	const info = await ctx.client.info();
	const snap = await ctx.client.snapshot();
	let files = snap.files;
	if (files.some((f) => f.metaEnc)) files = await resolveSnapshotPaths(ctx, files);
	const inScope = files.filter((f) => !ctx.ignores(f.path));
	const outOfScope = files.length - inScope.length;
	if (inScope.length === 0) {
		throw new ReplaceJobError(
			"远端仓库在同步范围内是空的：请使用接入向导的「用本地初始化空仓库」，不需要高级恢复。",
			"remote-empty",
		);
	}

	const adapter = ctx.app.vault.adapter;
	const remoteSet = new Set(inScope.map((f) => f.path));
	const localPaths: string[] = [];
	for (const file of ctx.app.vault.getFiles()) {
		if (!ctx.ignores(file.path)) localPaths.push(file.path);
	}
	const total = inScope.length + localPaths.filter((p) => !remoteSet.has(p)).length;
	let done = 0;
	const items: ReplaceItem[] = [];

	for (const f of inScope) {
		opts.onProgress?.({ phase: "plan", done: ++done, total, current: f.path });
		const sp = serverPseudonymOf(f);
		const base = {
			path: f.path,
			fileId: f.fileId,
			serverPath: sp,
			expectedRevision: f.revision,
			remoteHash: f.hash,
			operationId: newOperationId(),
			source: "local" as const,
			status: "pending" as const,
		};
		const stat = await adapter.stat(f.path);
		if (!stat || stat.type !== "file") {
			// 远端独有 → 删除。快照报告的世代只作反向重建时的下限参考（认证过的世代在保存恢复点时取得）
			items.push({ ...base, action: "delete", remoteGeneration: f.contentGeneration, remoteMetaGeneration: f.metaGeneration });
			continue;
		}
		const localHash = await sha256Hex(await adapter.readBinary(f.path));
		// 已跟踪且服务器上仍是我们见过的那一版：明文 hash 直接用本地记录，省一次下载
		const tracked = ctx.store.get(f.path);
		let remotePlainHash: string;
		let generation: number | undefined;
		let metaGeneration: number | undefined;
		if (tracked && tracked.serverHash === f.hash && tracked.revision === f.revision) {
			remotePlainHash = tracked.hash;
			generation = tracked.generation;
			metaGeneration = tracked.metaGeneration ?? f.metaGeneration;
		} else {
			const dl = await downloadPlain(ctx, f.path, sp);
			remotePlainHash = dl.plainHash;
			generation = dl.generation;
			metaGeneration = f.metaGeneration ?? dl.metaGeneration;
		}
		items.push({
			...base,
			action: localHash === remotePlainHash ? "keep" : "update",
			localHash,
			remoteGeneration: generation,
			remoteMetaGeneration: metaGeneration,
		});
	}
	for (const path of localPaths) {
		if (remoteSet.has(path)) continue;
		opts.onProgress?.({ phase: "plan", done: ++done, total, current: path });
		const localHash = await sha256Hex(await adapter.readBinary(path));
		items.push({
			path,
			action: "create",
			// E2EE 下新对象的身份必须在加密前确定，而且要**跨重试不变**：在计划里固定，
			// 断网重试用同一个 fileId + operationId，服务端返回首次结果。
			// 这只是「预留」：远端还没有这个对象，执行时按建档请求发（meta 模式带 LSM1），
			// 本地 FileState 等服务器确认之后才写（PL-02）
			fileId: ctx.e2ee.enabled ? newFileId() : undefined,
			expectedRevision: 0,
			localHash,
			operationId: newOperationId(),
			source: "local",
			status: "pending",
		});
	}
	sortItems(items);

	return {
		jobId: jobIdNow(),
		kind: "local-replace-remote",
		vaultIdentity: info.vaultId ?? "",
		vaultChoice: opts.vaultChoice,
		vaultName: opts.vaultName,
		repoEpoch: snap.repoEpoch ?? info.repoEpoch ?? "",
		plannedHeadSequence: snap.sequence,
		createdAt: opts.now ?? Date.now(),
		state: "planned",
		bootstrapContext: opts.bootstrapContext,
		items,
		counts: countItems(items, outOfScope),
		snapshotBytes: 0,
		snapshotComplete: false,
		ownSequences: [],
	};
}

/** 确认时要求输入的文字（未命名的默认仓库用固定短语）。 */
export function confirmPhrase(job: ReplaceJob): string {
	return job.vaultName.trim() || "确认替换";
}

/** 确认：原样输入仓库名。只改作业状态，不碰远端。 */
export function confirmReplaceJob(job: ReplaceJob, typed: string, now: number): { ok: true } | { ok: false; reason: string } {
	if (job.state !== "planned") return { ok: false, reason: "作业状态不允许确认" };
	if (typed.trim() !== confirmPhrase(job)) return { ok: false, reason: `请原样输入「${confirmPhrase(job)}」` };
	job.state = "confirmed";
	job.confirmedAt = now;
	return { ok: true };
}

/** 确认前复核执行许可（PL-03）：预览之后才出现的停机（完整性、凭据、换连接……）在这里挡住。 */
export function confirmReplaceJobChecked(
	ctx: SyncContext,
	job: ReplaceJob,
	typed: string,
	now: number,
): { ok: true } | { ok: false; reason: string } {
	const block = replaceBlock(ctx, job);
	if (block !== null) return { ok: false, reason: `无法确认：${block.message}` };
	return confirmReplaceJob(job, typed, now);
}

/**
 * 恢复点：把将被覆盖（update）或删除（delete）的每个远端对象的原始字节存进插件目录，
 * 校验与服务器声明的内容 hash 一致、读回一致，并**解密校验**（E2EE 下 AAD 绑定 fileId，
 * 证明这份密文真的解得回来）；全部成功才标记 snapshotComplete。
 * 已保存的条目重新读回核对 hash（坏了就重下）。反向作业的恢复点是原作业本身，无需另存。
 */
export async function saveRecoveryPoint(
	ctx: SyncContext,
	job: ReplaceJob,
	onProgress?: OnProgress,
	permit?: ReplacePermit,
): Promise<void> {
	if (job.kind === "reverse") {
		job.snapshotComplete = true;
		await persistJob(ctx, job);
		return;
	}
	if (job.state !== "confirmed" && job.state !== "interrupted") {
		throw new ReplaceJobError("只有确认过的作业才能保存恢复点", "invalid-state");
	}
	const p = permit ?? openReplacePermit(ctx, job);
	requirePermit(ctx, job, p);
	const adapter = ctx.app.vault.adapter;
	const dir = recoveryDir(ctx, job.jobId);
	await ensureDir(ctx, dir);
	const targets = job.items.filter((it) => it.action === "update" || it.action === "delete");
	let done = 0;
	let bytes = 0;
	for (const it of targets) {
		onProgress?.({ phase: "snapshot", done: ++done, total: targets.length, current: it.path });
		if (it.snapshotFile && it.snapshotHash && (await adapter.exists(`${dir}/${it.snapshotFile}`))) {
			const existing = await adapter.readBinary(`${dir}/${it.snapshotFile}`);
			if ((await sha256Hex(existing)) === it.snapshotHash) {
				bytes += existing.byteLength;
				continue;
			}
			// 已保存的恢复点读回对不上：当它不存在，重新下载
		}
		const dl = await ctx.client.download(it.serverPath ?? it.path);
		if (dl.revision !== it.expectedRevision || (it.remoteHash && dl.hash !== it.remoteHash)) {
			throw new ReplaceJobError(`保存恢复点时发现远端已变化（${it.path}），请重新预览`, "snapshot-failed");
		}
		const hash = await sha256Hex(dl.data);
		if (dl.hash && hash !== dl.hash) {
			throw new ReplaceJobError(`保存恢复点时内容校验失败（${it.path}）`, "snapshot-failed");
		}
		// 解密校验：恢复点必须真的解得回来（hash 对不代表密钥、身份绑定都对）
		let decoded;
		try {
			decoded = await decodeSnapshot(ctx, it.path, { ...dl, fileId: dl.fileId ?? it.fileId });
		} catch (e) {
			throw new ReplaceJobError(
				`恢复点无法解密校验（${it.path}）：${e instanceof Error ? e.message : String(e)}`,
				"snapshot-failed",
			);
		}
		const name = `${String(job.items.indexOf(it)).padStart(6, "0")}.bin`;
		await writeRecoveryFile(ctx, `${dir}/${name}`, dl.data);
		// 读回校验：恢复点写坏了等于没有恢复点
		const back = await adapter.readBinary(`${dir}/${name}`);
		if ((await sha256Hex(back)) !== hash) {
			throw new ReplaceJobError(`恢复点写入校验失败（${it.path}）`, "snapshot-failed");
		}
		it.snapshotFile = name;
		it.snapshotHash = hash;
		it.snapshotGeneration = decoded.generation;
		bytes += dl.data.byteLength;
		await persistJob(ctx, job);
	}
	// 人能读的清单：哪怕插件状态丢了，也能照着它手工找回
	const manifest = {
		jobId: job.jobId,
		vaultIdentity: job.vaultIdentity,
		repoEpoch: job.repoEpoch,
		plannedHeadSequence: job.plannedHeadSequence,
		createdAt: job.createdAt,
		note: "执行「用本地完整替换远端」之前远端对象的原始字节（E2EE 仓库为密文）。反向作业据此恢复。",
		items: targets.map((it) => ({
			path: it.path,
			fileId: it.fileId,
			action: it.action,
			revision: it.expectedRevision,
			hash: it.snapshotHash,
			generation: it.snapshotGeneration,
			file: it.snapshotFile,
		})),
	};
	await adapter.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
	job.snapshotBytes = bytes;
	job.snapshotComplete = true;
	await persistJob(ctx, job);
}

// ---------- 执行 ----------

export interface ReplaceRunResult {
	state: ReplaceJob["state"];
	done: number;
	stale: number;
	reason?: string;
}

function markStale(job: ReplaceJob, it: ReplaceItem, reason: string): void {
	it.status = "stale";
	it.error = reason;
	job.state = "paused_stale";
	job.staleReason = `${it.path}：${reason}`;
}

/** 反向作业的明文来源：恢复点字节解码（E2EE 解密 + hash/AAD 校验）。 */
async function snapshotDecoded(
	ctx: SyncContext,
	job: ReplaceJob,
	it: ReplaceItem,
): Promise<{ plain: ArrayBuffer; generation?: number }> {
	const parent = job.parentJobId ?? job.jobId;
	const raw = await ctx.app.vault.adapter.readBinary(`${recoveryDir(ctx, parent)}/${it.snapshotFile}`);
	if (it.snapshotHash && (await sha256Hex(raw)) !== it.snapshotHash) {
		throw new ReplaceJobError(`恢复点文件已损坏（${it.path}）`, "snapshot-failed");
	}
	const dl = await decodeSnapshot(ctx, it.path, {
		data: raw,
		revision: it.expectedRevision,
		hash: it.snapshotHash ?? "",
		size: raw.byteLength,
		mtime: 0,
		fileId: it.fileId,
	});
	return { plain: dl.plain, generation: dl.generation };
}

/** 反向作业：先把本地副本备份进恢复目录（随后的普通同步会让本设备跟随恢复后的远端）。 */
async function backupLocal(ctx: SyncContext, job: ReplaceJob, it: ReplaceItem): Promise<string | null> {
	const adapter = ctx.app.vault.adapter;
	const stat = await adapter.stat(it.path);
	if (!stat || stat.type !== "file") return null;
	const data = await adapter.readBinary(it.path);
	const dir = `${recoveryDir(ctx, job.jobId)}/local-before-reverse`;
	await ensureDir(ctx, dir);
	await writeRecoveryFile(ctx, `${dir}/${String(job.items.indexOf(it)).padStart(6, "0")}.bin`, data);
	return sha256Hex(data);
}

/**
 * 本地前置条件（PL-04）：预览时记下的本地状态现在是否仍然成立。返回 null = 成立，否则为原因。
 *
 * delete：预览时本地**没有**这个文件——现在出现了（新建、恢复、改名而来）就不能删远端；
 * keep：仍是预览时与远端一致的那份内容；update / create：仍是预览时的那份内容。
 * 反向作业（source=snapshot）不以本地为前置条件：本地副本动手前先备份，随后由普通同步跟随远端。
 */
async function localPrecondition(ctx: SyncContext, it: ReplaceItem): Promise<string | null> {
	if (it.source !== "local") return null;
	const adapter = ctx.app.vault.adapter;
	const stat = await adapter.stat(it.path);
	if (it.action === "delete") {
		return stat ? "预览时本地没有这个文件，现在本地出现了它（新建、恢复或改名而来）" : null;
	}
	if (!stat || stat.type !== "file") return "本地文件在预览之后被删除了（或被改名）";
	if (it.localHash === undefined) return null;
	const hash = await sha256Hex(await adapter.readBinary(it.path));
	if (hash === it.localHash) return null;
	return it.action === "keep" ? "本地文件在预览之后又改动了（预览时它与远端一致）" : "本地文件在预览之后又改动了";
}

/** 作业期间（与之后）这个对象在服务端的最新 revision 是不是我们自己写出来的。 */
function isOwnChange(job: ReplaceJob, c: { sequence: number; fileId?: string; path: string; revision: number }): boolean {
	if (job.ownSequences.includes(c.sequence)) return true;
	return job.items.some((it) => {
		const sameObject = (it.fileId !== undefined && it.fileId === c.fileId) || (it.serverPath ?? it.path) === c.path;
		if (!sameObject) return false;
		// 自己的显式恢复（结果已落盘）也是自己的写入，不能被当成外来变更
		if (it.restore?.phase === "restored" && it.restore.revision === c.revision) return true;
		return it.status === "done" && it.resultRevision === c.revision;
	});
}

/**
 * 执行（可续跑）：只处理 pending 条目；每个条目完成就落盘。
 * 网络/服务器错误、执行许可被收回 → interrupted 并抛出；CAS 失败或本地变化 → paused_stale 并返回。
 */
export async function runReplaceJob(
	ctx: SyncContext,
	job: ReplaceJob,
	onProgress?: OnProgress,
	permit?: ReplacePermit,
): Promise<ReplaceRunResult> {
	if (job.state !== "confirmed" && job.state !== "interrupted" && job.state !== "running") {
		throw new ReplaceJobError("作业状态不允许执行", "invalid-state");
	}
	if (!job.snapshotComplete) throw new ReplaceJobError("恢复点尚未保存完成，不能执行", "snapshot-failed");
	if (ctx.e2ee.needsUnlock) throw new E2eeLockedError();
	// 续跑时复核（PL-03）：被挡下不改作业状态（保持可诊断、可续跑），只记原因
	let p: ReplacePermit;
	try {
		p = permit ?? openReplacePermit(ctx, job);
		requirePermit(ctx, job, p);
	} catch (e) {
		if (e instanceof ReplaceJobError && e.code === "blocked") {
			job.lastBlock = { reason: e.blockReason ?? "blocked", message: e.message, at: Date.now() };
			await persistJob(ctx, job);
		}
		throw e;
	}
	const info = await ctx.client.info();
	if ((info.vaultId ?? "") !== job.vaultIdentity || (info.repoEpoch ?? "") !== job.repoEpoch) {
		job.state = "paused_stale";
		job.staleReason = "目标仓库或其世代（repoEpoch）已变化：作业不再适用，请重新预览";
		await persistJob(ctx, job);
		return { state: job.state, done: 0, stale: 0, reason: job.staleReason };
	}

	const pending = job.items.filter((it) => it.status === "pending");
	// 本地前置条件预检（PL-04）：任何远端写入之前，先确认预览时的本地条件一个都没变——
	// 等恢复点的那段时间里用户新建、删除、改名、修改了文件，就停在这里，一个字节都不写
	for (const it of pending) {
		const why = await localPrecondition(ctx, it);
		if (why !== null) {
			// 上次已经在墓碑上恢复、还没来得及上传：远端此刻是删除前的旧版本——如实告诉用户，重新预览会以本地内容覆盖它
			const restored = it.restore?.phase === "restored" ? "（远端已恢复出删除前的版本，重新预览后会以本地内容覆盖它）" : "";
			markStale(job, it, why + restored);
			await persistJob(ctx, job);
			return summarize(job);
		}
	}

	job.state = "running";
	await persistJob(ctx, job);

	let n = 0;
	for (const it of pending) {
		onProgress?.({ phase: "run", done: ++n, total: pending.length, current: it.path });
		try {
			const outcome = await runItem(ctx, job, it, p);
			if (outcome === "stale") {
				await persistJob(ctx, job);
				return summarize(job);
			}
		} catch (e) {
			job.state = "interrupted";
			it.error = e instanceof Error ? e.message.slice(0, 200) : "error";
			await persistJob(ctx, job);
			throw e;
		}
		await persistJob(ctx, job);
	}

	// 水位检查：计划之后的全部变更都必须是本作业自己写的
	onProgress?.({ phase: "verify", done: 0, total: 1, current: "" });
	let since = job.plannedHeadSequence;
	let foreign = 0;
	for (;;) {
		const res = await ctx.client.changes(since, 500);
		if (res.resyncRequired) {
			job.state = "paused_stale";
			job.staleReason = "服务器已裁剪变更记录，无法确认作业期间没有其他写入：请重新预览核对";
			await persistJob(ctx, job);
			return summarize(job);
		}
		for (const c of res.changes) {
			if (!isOwnChange(job, c)) foreign++;
			since = Math.max(since, c.sequence);
		}
		if (!res.hasMore || res.changes.length === 0) break;
	}
	if (foreign > 0) {
		job.state = "paused_stale";
		job.staleReason = `预览之后远端有 ${foreign} 条不是本作业写入的变更（其他设备或网页）：请重新预览，确认后再继续`;
		await persistJob(ctx, job);
		return summarize(job);
	}
	job.state = "completed";
	job.completedAt = Date.now();
	job.lastBlock = undefined;
	await persistJob(ctx, job);
	return summarize(job);
}

function summarize(job: ReplaceJob): ReplaceRunResult {
	return {
		state: job.state,
		done: job.items.filter((it) => it.status === "done").length,
		stale: job.items.filter((it) => it.status === "stale").length,
		reason: job.staleReason,
	};
}

/** 执行一个条目；返回 stale 时作业已标记 paused_stale。 */
async function runItem(ctx: SyncContext, job: ReplaceJob, it: ReplaceItem, permit: ReplacePermit): Promise<"done" | "stale"> {
	switch (it.action) {
		case "keep":
			return runKeep(ctx, job, it);
		case "delete":
			return runDelete(ctx, job, it, permit);
		case "update":
		case "create":
		case "restore":
			return runUpsert(ctx, job, it, permit);
	}
}

/** keep：两边一致——确认本地仍是预览内容，建立（或确认）跟踪状态，不写远端。 */
async function runKeep(ctx: SyncContext, job: ReplaceJob, it: ReplaceItem): Promise<"done" | "stale"> {
	const why = await localPrecondition(ctx, it);
	if (why !== null) {
		markStale(job, it, why);
		return "stale";
	}
	const tracked = ctx.store.get(it.path);
	if (tracked?.fileId !== undefined && it.fileId !== undefined && tracked.fileId !== it.fileId) {
		markStale(job, it, "本地记录的对象身份与预览时不一致");
		return "stale";
	}
	if (!tracked) {
		const stat = await ctx.app.vault.adapter.stat(it.path);
		ctx.store.applyRemoteIdentity(it.path, {
			fileId: it.fileId,
			generation: it.remoteGeneration,
			metaGeneration: it.remoteMetaGeneration,
			serverPseudonym: it.serverPath,
		});
		ctx.store.patchContentState(it.path, {
			hash: it.localHash ?? "",
			serverHash: it.remoteHash ?? "",
			revision: it.expectedRevision,
			mtime: stat?.mtime ?? 0,
			size: stat?.size ?? 0,
		});
	}
	it.status = "done";
	it.resultRevision = it.expectedRevision;
	return "done";
}

/** delete：删除远端（tombstone）。正向作业先确认本地仍然没有这个文件。 */
async function runDelete(ctx: SyncContext, job: ReplaceJob, it: ReplaceItem, permit: ReplacePermit): Promise<"done" | "stale"> {
	if (it.source === "local") {
		const why = await localPrecondition(ctx, it);
		if (why !== null) {
			markStale(job, it, why);
			return "stale";
		}
	} else {
		await backupLocal(ctx, job, it);
	}
	requirePermit(ctx, job, permit);
	try {
		const r = await ctx.client.remove(it.serverPath ?? it.path, it.expectedRevision);
		it.resultRevision = r.revision;
		if (r.sequence > 0) job.ownSequences.push(r.sequence);
	} catch (e) {
		if (e instanceof ConflictError && e.server.deleted) {
			// 已经是墓碑（上次删除的响应丢了，或别人也删了）：结果与计划一致
			it.resultRevision = e.server.revision;
		} else if (e instanceof NotFoundError) {
			it.resultRevision = it.expectedRevision;
		} else if (e instanceof ConflictError) {
			markStale(job, it, "远端在预览之后被其他设备修改了");
			return "stale";
		} else {
			throw e;
		}
	}
	it.status = "done";
	// 反向作业：本设备的跟踪状态保持在回滚之前，随后的普通同步看到这条删除，
	// 按标准路径把本地副本移入回收站（不永久删除；本地副本另已备份进恢复目录）
	if (it.source !== "snapshot") ctx.store.markDeleted(it.path);
	return "done";
}

function newRestoreStep(
	it: ReplaceItem,
	fileId: string,
	expectedTombstoneRevision: number,
	contentGeneration: number,
	metaGeneration: number,
	priorHash?: string,
): RestoreStep {
	return {
		operationId: `${it.operationId}-r`,
		fileId,
		expectedTombstoneRevision,
		contentGeneration,
		metaGeneration,
		phase: "requested",
		...(priorHash ? { priorHash } : {}),
	};
}

/**
 * 墓碑的世代事实（服务器回收站，0.20 服务端）：删除时的内容世代与元数据世代。
 *
 * 恢复请求的内容世代必须严格大于墓碑的值（服务器据此抗回退）；meta 模式下 LSM1 信封里的元数据世代
 * 要写「墓碑的值 + 1」，与服务器恢复后的值一致，否则之后的改名 CAS 对不上。这些值只用来**抬高**下限，
 * 不用来做任何放行判断。旧服务器没有回收站接口时返回 null，调用方用自己记下的值。
 */
async function tombstoneFacts(
	ctx: SyncContext,
	fileId: string,
): Promise<{ contentGeneration: number; metaGeneration: number } | null> {
	try {
		const t = (await ctx.client.trash()).find((x) => x.fileId === fileId);
		return t === undefined ? null : { contentGeneration: t.contentGeneration, metaGeneration: t.metaGeneration };
	} catch (e) {
		ctx.log(`replace: trash lookup unavailable (${e instanceof Error ? e.message : String(e)})`);
		return null;
	}
}

/**
 * restore→upload 子状态机的第一段（PL-05）：发出（或原样重发）显式恢复请求，并把服务器结果落盘。
 *
 * 意图在调用之前已经落盘（phase=requested）；请求用稳定的 operationId，服务器提交后响应丢失时，
 * 重发拿回的是首次结果。网络 / 服务器错误原样抛出（phase 仍是 requested，续跑重发）；
 * 前置条件不成立（墓碑已变化 / 已清理 / 名字被占）→ paused_stale。
 */
async function performRestore(ctx: SyncContext, job: ReplaceJob, it: ReplaceItem, permit: ReplacePermit): Promise<"ok" | "stale"> {
	const step = it.restore!;
	requirePermit(ctx, job, permit);
	await evalFailpoint(FP.replaceBeforeRestore);
	let res;
	try {
		res = await requestRestore(ctx, {
			path: it.path,
			fileId: step.fileId,
			expectedTombstoneRevision: step.expectedTombstoneRevision,
			contentGeneration: step.contentGeneration,
			metaGeneration: step.metaGeneration,
			operationId: step.operationId,
		});
	} catch (e) {
		if (e instanceof ApiError && [404, 409, 410, 412, 422].includes(e.status)) {
			markStale(
				job,
				it,
				e.is("TOMBSTONE_PURGED")
					? "服务器上的删除记录已被清理，无法按原身份恢复"
					: "远端的删除记录在预览之后发生了变化（被恢复、改写或名字被占用）",
			);
			return "stale";
		}
		throw e;
	}
	if (res.fileId !== step.fileId) {
		markStale(job, it, "服务器恢复的对象身份与请求不符，已停止");
		return "stale";
	}
	// 服务器没有给出这次恢复的 sequence（幂等记录已被裁剪）：先确认对象仍是恢复出来的那份内容，
	// 否则它可能已被别人改过——不能在别人的写入之上盲目覆盖
	if (!(res.sequence > 0) && step.priorHash) {
		const head = await ctx.client.download(it.serverPath ?? (metaEncrypted(ctx) ? step.fileId : it.path));
		if (head.hash !== step.priorHash || head.revision !== res.revision) {
			markStale(job, it, "恢复之后对象已被其他写入改变");
			return "stale";
		}
	}
	// 故障点：服务器结果已到、尚未落盘（模拟此刻进程被杀）
	await evalFailpoint(FP.replaceBeforeRestorePersist);
	step.phase = "restored";
	step.revision = res.revision;
	step.sequence = res.sequence;
	step.serverMetaGeneration = res.metaGeneration;
	if (res.sequence > 0 && !job.ownSequences.includes(res.sequence)) job.ownSequences.push(res.sequence);
	await persistJob(ctx, job);
	return "ok";
}

/** 本次上传的对象身份（PL-02）：远端已建档 / 只是预留，由作业自己的记录决定，不看 FileState 有没有。 */
function uploadIdentity(it: ReplaceItem, tracked: { fileId?: string; generation?: number; metaGeneration?: number } | undefined): UploadOptions["identity"] {
	if (it.restore?.phase === "restored") {
		return {
			fileId: it.restore.fileId,
			remote: "established",
			generation: it.restore.contentGeneration,
			metaGeneration: it.restore.metaGeneration,
		};
	}
	if (it.fileId === undefined) return undefined; // 明文仓库的新建：身份由服务器分配
	if (it.action === "update") {
		const trackedGen = tracked?.fileId === it.fileId ? tracked.generation : undefined;
		return {
			fileId: it.fileId,
			remote: "established",
			generation: Math.max(trackedGen ?? 0, it.remoteGeneration ?? 0),
			metaGeneration: it.remoteMetaGeneration ?? (tracked?.fileId === it.fileId ? tracked.metaGeneration : undefined),
		};
	}
	return { fileId: it.fileId, remote: "reserved" };
}

/** update / create / restore：写入内容；路径上是墓碑时走持久化的 restore→upload 子状态机。 */
async function runUpsert(ctx: SyncContext, job: ReplaceJob, it: ReplaceItem, permit: ReplacePermit): Promise<"done" | "stale"> {
	const adapter = ctx.app.vault.adapter;
	// 1. 内容来源与本地前置条件
	let data: ArrayBuffer;
	let mtime = Date.now();
	let contentGeneration: number | undefined;
	if (it.source === "local") {
		const stat = await adapter.stat(it.path);
		if (!stat || stat.type !== "file") {
			markStale(job, it, "本地文件在预览之后被删除了（或被改名）");
			return "stale";
		}
		data = await adapter.readBinary(it.path);
		if ((await sha256Hex(data)) !== it.localHash) {
			markStale(job, it, "本地文件在预览之后又改动了");
			return "stale";
		}
		mtime = stat.mtime;
	} else {
		const snap = await snapshotDecoded(ctx, job, it);
		data = snap.plain;
		contentGeneration = snap.generation;
		await backupLocal(ctx, job, it);
	}
	const reverse = it.source === "snapshot";

	// 2. 身份核对：本地记录的对象与预览时的不是同一个 → 不写（写了 AAD 也会错绑）
	const tracked = ctx.store.get(it.path);
	if (!reverse && it.action === "update" && tracked?.fileId !== undefined && it.fileId !== undefined && tracked.fileId !== it.fileId) {
		markStale(job, it, "本地记录的对象身份与预览时不一致，请重新预览");
		return "stale";
	}

	// 3. 反向作业的墓碑重建：身份与墓碑 revision 都已知 → 直接显式恢复（不先撞一次上传）。意图先落盘
	let tombstoneRevision = it.expectedRevision;
	if (it.restore === undefined && it.tombstoneOf !== undefined) {
		// 墓碑是本反向作业刚删出来的（仅大小写不同的改名回滚）：以那次删除的结果为锚点
		const src = job.items.find((x) => x.operationId === it.tombstoneOf);
		if (src === undefined || src.status !== "done" || src.resultRevision === undefined) {
			markStale(job, it, "要恢复的对象还没有被本作业重新删除，无法按原名重建");
			return "stale";
		}
		tombstoneRevision = src.resultRevision;
	}
	if (it.restore === undefined && it.action === "restore" && it.fileId !== undefined && tombstoneRevision > 0) {
		const facts = await tombstoneFacts(ctx, it.fileId);
		const floor = Math.max(contentGeneration ?? 0, it.snapshotGeneration ?? 0, it.remoteGeneration ?? 0, facts?.contentGeneration ?? 0);
		const metaGen = facts?.metaGeneration ?? it.remoteMetaGeneration ?? 0;
		it.restore = newRestoreStep(it, it.fileId, tombstoneRevision, floor + 1, metaGen + 1, it.tombstoneOf ? undefined : it.snapshotHash);
		await persistJob(ctx, job);
	}

	let out: UploadOutcome | undefined;
	let base = it.expectedRevision;
	for (let round = 0; out === undefined; round++) {
		if (round > 2) throw new Error(`内部错误：${it.path} 的恢复与上传没有收敛`);
		if (it.restore !== undefined && it.restore.phase === "requested") {
			const r = await performRestore(ctx, job, it, permit);
			if (r === "stale") return "stale";
		}
		requirePermit(ctx, job, permit);
		base = it.restore?.phase === "restored" ? (it.restore.revision ?? it.expectedRevision) : it.expectedRevision;
		try {
			out = await uploadFromPlain(ctx, it.path, data, base, mtime, "upsert", {
				operationId: it.operationId,
				generationFloor: it.restore?.phase === "restored" ? it.restore.contentGeneration : it.remoteGeneration,
				identity: uploadIdentity(it, tracked),
			});
		} catch (e) {
			if (e instanceof ConflictError && e.server.deleted && it.restore === undefined) {
				// 路径上是墓碑：create（本地独有、远端曾删除）与反向 restore 都要求重建；
				// 反向 restore 还要求墓碑仍是原作业删除时留下的那一个
				const allowed =
					it.action === "create" ||
					(it.action === "restore" && (it.expectedRevision === 0 || e.server.revision === it.expectedRevision));
				if (!allowed) {
					markStale(job, it, "远端在预览之后被删除了");
					return "stale";
				}
				if (!e.server.fileId) {
					markStale(job, it, "服务器没有提供被删除对象的身份，无法恢复");
					return "stale";
				}
				// 协议 v6（ADR-002 §3.6）：先显式恢复（身份与 revision 连续），再在恢复出的 revision 上传。
				// 恢复的是墓碑那个对象（INV-05）：身份从此是它的 fileId，计划里预留的那个作废
				const facts = await tombstoneFacts(ctx, e.server.fileId);
				const floor = Math.max(
					e.server.contentGeneration ?? 0,
					contentGeneration ?? 0,
					it.remoteGeneration ?? 0,
					facts?.contentGeneration ?? 0,
				);
				const metaGen = facts?.metaGeneration ?? (it.fileId === e.server.fileId ? it.remoteMetaGeneration : undefined) ?? 0;
				it.restore = newRestoreStep(it, e.server.fileId, e.server.revision, floor + 1, metaGen + 1, e.server.priorHash);
				it.fileId = e.server.fileId;
				if (metaEncrypted(ctx)) it.serverPath = e.server.fileId;
				await persistJob(ctx, job); // 意图先落盘，再发恢复请求
				continue;
			}
			if (e instanceof ConflictError) {
				markStale(job, it, e.server.deleted ? "远端在预览之后被删除了" : "远端在预览之后被其他设备修改了");
				return "stale";
			}
			if (e instanceof ApiError && e.is("CANONICAL_COLLISION")) {
				markStale(job, it, "与远端一个仅大小写或 Unicode 写法不同的文件同名");
				return "stale";
			}
			throw e;
		}
	}

	// 4. 结果。故障点：最终上传的响应已到、条目结果尚未落盘（模拟此刻进程被杀）
	await evalFailpoint(FP.replaceAfterUpload);
	// 只有真产生了新 revision 才是「自己的」变更（内容与 HEAD 相同的幂等短路返回的是仓库水位，不是本次写入）
	if (out.revision > base && !job.ownSequences.includes(out.sequence)) job.ownSequences.push(out.sequence);
	it.fileId = out.fileId ?? it.fileId;
	if (out.serverPseudonym) it.serverPath = out.serverPseudonym;
	it.resultRevision = out.revision;
	// 明文仓库的上传没有信封世代，但显式恢复已经把服务器上的内容世代推到了 restore.contentGeneration
	it.resultGeneration = Math.max(out.generation ?? 0, it.restore?.contentGeneration ?? 0) || undefined;
	it.resultMetaGeneration = out.metaGeneration;
	it.status = "done";
	if (reverse) {
		// 反向作业只恢复远端：本设备的跟踪状态保持在「回滚之前」，让随后的普通同步把
		// 恢复后的远端经标准 pull 路径带回本地（INV-03 的全部保护照常生效，本地副本已备份）
		return "done";
	}
	ctx.store.applyRemoteIdentity(it.path, {
		fileId: out.fileId,
		generation: out.generation,
		metaGeneration: out.metaGeneration,
		serverPseudonym: out.serverPseudonym,
	});
	const st = await adapter.stat(it.path);
	ctx.store.patchContentState(it.path, {
		hash: it.localHash ?? (await sha256Hex(data)),
		serverHash: out.cipherHash,
		revision: out.revision,
		mtime: st?.mtime ?? mtime,
		size: data.byteLength,
	});
	return "done";
}

// ---------- 反向作业 ----------

/**
 * 反向作业（回滚演练）：把原作业已完成的条目逐个反过来。
 *
 * - 原作业覆盖了远端 → 按恢复点内容写回（CAS 前提 = 原作业写出的 revision）；
 * - 原作业新建了远端文件 → 删除它；
 * - 原作业删除了远端文件 → 在墓碑上按恢复点内容重建（显式 restore，身份与历史连续）。
 * 反向作业只改远端；本设备由随后的普通同步跟随恢复后的远端（经 pull 的标准保护），
 * 被替换掉的本地副本事先备份进恢复目录。
 */
export function buildReverseJob(job: ReplaceJob, now: number): ReplaceJob {
	if (job.kind !== "local-replace-remote") throw new ReplaceJobError("只能为原作业生成反向作业", "invalid-state");
	const items: ReplaceItem[] = [];
	// 仅大小写不同的改名：原作业删掉 Note.md，又在 note.md 上恢复了**同一个对象**。回滚时这两条要串起来
	const deletedIds = new Set(
		job.items.filter((i) => i.action === "delete" && i.status === "done" && i.fileId !== undefined).map((i) => i.fileId),
	);
	const reDeleted = new Map<string, { operationId: string; resultGeneration?: number; resultMetaGeneration?: number }>();
	for (const it of job.items) {
		if (it.status !== "done" || it.action === "keep") continue;
		const common = {
			path: it.path,
			fileId: it.fileId,
			serverPath: it.serverPath,
			operationId: newOperationId(),
			status: "pending" as const,
			snapshotFile: it.snapshotFile,
			snapshotHash: it.snapshotHash,
			snapshotGeneration: it.snapshotGeneration,
		};
		if (it.action === "update") {
			items.push({
				...common,
				action: "update",
				source: "snapshot",
				expectedRevision: it.resultRevision ?? 0,
				// 写回时的世代下限：原作业写出的那一版
				remoteGeneration: it.resultGeneration,
				remoteMetaGeneration: it.resultMetaGeneration ?? it.remoteMetaGeneration,
			});
		} else if (it.action === "create" || it.action === "restore") {
			const rd: ReplaceItem = {
				...common,
				action: "delete",
				source: "snapshot",
				expectedRevision: it.resultRevision ?? 0,
				snapshotFile: undefined,
			};
			items.push(rd);
			if (it.fileId !== undefined && deletedIds.has(it.fileId)) {
				reDeleted.set(it.fileId, {
					operationId: rd.operationId,
					resultGeneration: it.resultGeneration,
					resultMetaGeneration: it.resultMetaGeneration,
				});
			}
		} else if (it.action === "delete") {
			items.push({
				...common,
				action: "restore",
				source: "snapshot",
				// 墓碑的删除 revision（原作业的删除结果）是恢复的防复活锚点
				expectedRevision: it.resultRevision ?? 0,
				remoteGeneration: it.remoteGeneration,
				remoteMetaGeneration: it.remoteMetaGeneration,
			});
		}
	}
	for (const rr of items) {
		const link = rr.action === "restore" && rr.fileId !== undefined ? reDeleted.get(rr.fileId) : undefined;
		if (link === undefined) continue;
		// 墓碑由本作业里那个删除条目产生：执行时取它的结果 revision；世代下限是原作业写出的那一版
		rr.tombstoneOf = link.operationId;
		rr.expectedRevision = 0;
		rr.remoteGeneration = Math.max(rr.remoteGeneration ?? 0, link.resultGeneration ?? 0);
		rr.remoteMetaGeneration = link.resultMetaGeneration ?? rr.remoteMetaGeneration;
	}
	sortItems(items);
	return {
		...job,
		jobId: jobIdNow(),
		kind: "reverse",
		parentJobId: job.jobId,
		createdAt: now,
		state: "planned",
		items,
		counts: countItems(items, job.counts.outOfScope),
		snapshotBytes: 0,
		snapshotComplete: false,
		ownSequences: [],
		confirmedAt: undefined,
		completedAt: undefined,
		staleReason: undefined,
		lastBlock: undefined,
		plannedHeadSequence: job.plannedHeadSequence,
	};
}

/** 反向作业执行前，把计划水位更新到「现在」：原作业自己的写入不算外来变更。 */
export async function refreshReverseWatermark(ctx: SyncContext, job: ReplaceJob): Promise<void> {
	const info = await ctx.client.info();
	job.plannedHeadSequence = info.headSequence ?? info.latestSequence;
	job.repoEpoch = info.repoEpoch ?? job.repoEpoch;
}

/** 作业是否处于「未完成，需要用户决定续跑或放弃」的状态（启动时据此冻结普通同步）。 */
export function jobUnfinished(job: ReplaceJob | null): boolean {
	return job !== null && (job.state === "confirmed" || job.state === "running" || job.state === "interrupted");
}

/** 阶段保护下界面可以提供的操作（0.20.1；见 settings.replaceRemoteEnabled）。 */
export interface ReplaceCapabilities {
	/** 生成差异预览：只读，任何时候都可用 */
	preview: true;
	/** 确认并执行一个新的正向作业（把本地推上去） */
	executeForward: boolean;
	/** 续跑当前未完成的作业 */
	resume: boolean;
	/** 放弃当前未完成的作业 */
	abandon: boolean;
	/** 为已完成部分生成并执行反向作业（回滚到替换之前） */
	reverse: boolean;
}

/**
 * 阶段保护（0.20.1）：执行入口关闭 ≠ 功能静默失效。
 *
 * - 只读预览始终可用；
 * - 已经开始的作业始终可以诊断、放弃，已完成的部分始终可以回滚——反向作业是恢复方向，
 *   把它也关掉等于让用户卡在半途；
 * - 只有正向执行（确认新作业、续跑正向作业）需要用户在高级区显式开启。
 */
export function replaceCapabilities(job: ReplaceJob | null, executionEnabled: boolean): ReplaceCapabilities {
	if (job === null) return { preview: true, executeForward: executionEnabled, resume: false, abandon: false, reverse: false };
	const unfinished = jobUnfinished(job);
	return {
		preview: true,
		executeForward: executionEnabled,
		resume: unfinished && (job.kind === "reverse" || executionEnabled),
		abandon: unfinished,
		reverse: job.kind === "local-replace-remote" && job.items.some((i) => i.status === "done"),
	};
}

/** 放弃作业：不回滚已完成条目（给出反向作业入口），只是不再继续。 */
export async function abandonReplaceJob(ctx: SyncContext, job: ReplaceJob): Promise<void> {
	job.state = "abandoned";
	await persistJob(ctx, job);
}
