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
 *      hash 后存进插件目录（不参与同步）——这份恢复点不依赖服务器的历史保留策略；
 *   4. 执行：逐对象带 expected revision 写入；删除一律走 DELETE（tombstone，不清表）；
 *      任一对象 CAS 失败或本地在预览后又被改过 → 整个作业 paused_stale，只能重新预览；
 *   5. 收尾：检查计划水位之后的全部变更都是本作业写的，否则同样 paused_stale；
 *   6. 反向作业：按恢复点把远端（以及跟随远端的本设备）恢复到替换之前，产生新 revision，
 *      不回退任何计数器。
 *
 * fileId / revision / generation / tombstone / repoEpoch 语义全部沿用同步协议，
 * 不新增任何服务端接口。
 */
import { ApiError, ConflictError, NotFoundError, SnapshotFile } from "../api/client";
import { newFileId } from "../crypto/crypto";
import { E2eeLockedError } from "../crypto/keyring";
import { SyncContext } from "../sync/context";
import { resolveSnapshotPaths } from "../sync/pull";
import { restoreObject } from "../sync/push";
import { newOperationId } from "../sync/queue";
import { decodeSnapshot, downloadPlain, uploadFromPlain } from "../sync/transfer";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { ReplaceAction, ReplaceCounts, ReplaceItem, ReplaceJob } from "./replace-types";

export interface ReplaceProgress {
	phase: "plan" | "snapshot" | "run" | "verify";
	done: number;
	total: number;
	current: string;
}
type OnProgress = (p: ReplaceProgress) => void;

/** 执行顺序：先覆盖（最重要的内容先到位），再删除（腾出仅大小写不同的名字），最后新建。 */
const ORDER: Record<ReplaceAction, number> = { update: 0, restore: 1, delete: 2, create: 3, keep: 4 };

export class ReplaceJobError extends Error {
	constructor(
		message: string,
		public code: "remote-empty" | "vault-changed" | "invalid-state" | "snapshot-failed" | "locked" | "conflicts-pending",
	) {
		super(message);
		this.name = "ReplaceJobError";
	}
}

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

/**
 * 计划（dry-run）：只读，不写远端、不动本地文件。
 *
 * 远端为空时抛 remote-empty——那是 local-init 的场景，必须分开命名（SY-03）。
 */
export async function planReplaceRemote(
	ctx: SyncContext,
	opts: { vaultName: string; vaultChoice: string; bootstrapContext: boolean; onProgress?: OnProgress; now?: number },
): Promise<ReplaceJob> {
	if (ctx.e2ee.needsUnlock) throw new E2eeLockedError();
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
			items.push({ ...base, action: "delete" });
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
			metaGeneration = tracked.metaGeneration;
		} else {
			const dl = await downloadPlain(ctx, f.path, sp);
			remotePlainHash = dl.plainHash;
			generation = dl.generation;
			metaGeneration = dl.metaGeneration;
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
			// 断网重试用同一个 fileId + operationId，服务端返回首次结果
			fileId: ctx.e2ee.enabled ? newFileId() : undefined,
			expectedRevision: 0,
			localHash,
			operationId: newOperationId(),
			source: "local",
			status: "pending",
		});
	}
	items.sort((a, b) => ORDER[a.action] - ORDER[b.action] || a.path.localeCompare(b.path));

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

/**
 * 恢复点：把将被覆盖（update）或删除（delete）的每个远端对象的原始字节存进插件目录，
 * 校验与服务器声明的内容 hash 一致；全部成功才标记 snapshotComplete。
 * 已保存的条目跳过（续跑幂等）。反向作业的恢复点是原作业本身，无需另存。
 */
export async function saveRecoveryPoint(ctx: SyncContext, job: ReplaceJob, onProgress?: OnProgress): Promise<void> {
	if (job.kind === "reverse") {
		job.snapshotComplete = true;
		await persistJob(ctx, job);
		return;
	}
	if (job.state !== "confirmed" && job.state !== "interrupted") {
		throw new ReplaceJobError("只有确认过的作业才能保存恢复点", "invalid-state");
	}
	const adapter = ctx.app.vault.adapter;
	const dir = recoveryDir(ctx, job.jobId);
	await ensureDir(ctx, dir);
	const targets = job.items.filter((it) => it.action === "update" || it.action === "delete");
	let done = 0;
	let bytes = 0;
	for (const it of targets) {
		onProgress?.({ phase: "snapshot", done: ++done, total: targets.length, current: it.path });
		if (it.snapshotFile && it.snapshotHash && (await adapter.exists(`${dir}/${it.snapshotFile}`))) {
			bytes += (await adapter.readBinary(`${dir}/${it.snapshotFile}`)).byteLength;
			continue;
		}
		const dl = await ctx.client.download(it.serverPath ?? it.path);
		if (dl.revision !== it.expectedRevision || (it.remoteHash && dl.hash !== it.remoteHash)) {
			throw new ReplaceJobError(`保存恢复点时发现远端已变化（${it.path}），请重新预览`, "snapshot-failed");
		}
		const hash = await sha256Hex(dl.data);
		if (dl.hash && hash !== dl.hash) {
			throw new ReplaceJobError(`保存恢复点时内容校验失败（${it.path}）`, "snapshot-failed");
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
			file: it.snapshotFile,
		})),
	};
	await adapter.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
	job.snapshotBytes = bytes;
	job.snapshotComplete = true;
	await persistJob(ctx, job);
}

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
async function snapshotPlain(ctx: SyncContext, job: ReplaceJob, it: ReplaceItem): Promise<ArrayBuffer> {
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
	return dl.plain;
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

/** 作业期间（与之后）这个对象在服务端的最新 revision 是不是我们自己写出来的。 */
function isOwnChange(job: ReplaceJob, c: { sequence: number; fileId?: string; path: string; revision: number }): boolean {
	if (job.ownSequences.includes(c.sequence)) return true;
	return job.items.some(
		(it) =>
			it.status === "done" &&
			it.resultRevision === c.revision &&
			((it.fileId !== undefined && it.fileId === c.fileId) || (it.serverPath ?? it.path) === c.path),
	);
}

/**
 * 执行（可续跑）：只处理 pending 条目；每个条目完成就落盘。
 * 网络/服务器错误 → interrupted 并抛出；CAS 失败或本地变化 → paused_stale 并返回。
 */
export async function runReplaceJob(ctx: SyncContext, job: ReplaceJob, onProgress?: OnProgress): Promise<ReplaceRunResult> {
	if (job.state !== "confirmed" && job.state !== "interrupted" && job.state !== "running") {
		throw new ReplaceJobError("作业状态不允许执行", "invalid-state");
	}
	if (!job.snapshotComplete) throw new ReplaceJobError("恢复点尚未保存完成，不能执行", "snapshot-failed");
	if (ctx.e2ee.needsUnlock) throw new E2eeLockedError();
	const info = await ctx.client.info();
	if ((info.vaultId ?? "") !== job.vaultIdentity || (info.repoEpoch ?? "") !== job.repoEpoch) {
		job.state = "paused_stale";
		job.staleReason = "目标仓库或其世代（repoEpoch）已变化：作业不再适用，请重新预览";
		await persistJob(ctx, job);
		return { state: job.state, done: 0, stale: 0, reason: job.staleReason };
	}
	job.state = "running";
	await persistJob(ctx, job);

	const pending = job.items.filter((it) => it.status === "pending");
	let n = 0;
	for (const it of pending) {
		onProgress?.({ phase: "run", done: ++n, total: pending.length, current: it.path });
		try {
			const outcome = await runItem(ctx, job, it);
			if (outcome === "stale") {
				await persistJob(ctx, job);
				return summarize(job);
			}
		} catch (e) {
			if (e instanceof ReplaceJobError) throw e;
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
async function runItem(ctx: SyncContext, job: ReplaceJob, it: ReplaceItem): Promise<"done" | "stale"> {
	const adapter = ctx.app.vault.adapter;
	switch (it.action) {
		case "keep": {
			// 两边一致：建立（或确认）跟踪状态，不写远端
			const stat = await adapter.stat(it.path);
			if (stat && !ctx.store.get(it.path)) {
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
					mtime: stat.mtime,
					size: stat.size,
				});
			}
			it.status = "done";
			it.resultRevision = it.expectedRevision;
			return "done";
		}
		case "update":
		case "create":
		case "restore": {
			let data: ArrayBuffer;
			let mtime = Date.now();
			if (it.source === "local") {
				const stat = await adapter.stat(it.path);
				if (!stat || stat.type !== "file") {
					markStale(job, it, "本地文件在预览之后被删除了");
					return "stale";
				}
				data = await adapter.readBinary(it.path);
				if ((await sha256Hex(data)) !== it.localHash) {
					markStale(job, it, "本地文件在预览之后又改动了");
					return "stale";
				}
				mtime = stat.mtime;
			} else {
				data = await snapshotPlain(ctx, job, it);
				await backupLocal(ctx, job, it);
			}
			const reverse = it.source === "snapshot";
			if (it.fileId && !ctx.store.get(it.path)) {
				// 采纳（计划时确定的）对象身份：update 用远端对象的 fileId，create 用计划里固定的
				// 新 fileId。否则同一路径上会出现第二个身份（FILE_ID_CONFLICT），或重试换身份
				ctx.store.applyRemoteIdentity(it.path, {
					fileId: it.fileId,
					generation: it.remoteGeneration,
					metaGeneration: it.remoteMetaGeneration,
					serverPseudonym: it.serverPath,
				});
			}
			let base = it.expectedRevision;
			let out;
			try {
				out = await uploadFromPlain(ctx, it.path, data, base, mtime, "upsert", {
					operationId: it.operationId,
					generationFloor: it.remoteGeneration,
				});
			} catch (e) {
				if (e instanceof ConflictError && e.server.deleted) {
					// 路径上是墓碑：create（本地独有、远端曾删除）与反向 restore 都要求重建；
					// 反向 restore 还要求墓碑仍是原作业删除时留下的那一个
					const allowed =
						it.action === "create" ||
						(it.action === "restore" && (it.expectedRevision === 0 || e.server.revision === it.expectedRevision));
					if (!allowed) {
						markStale(job, it, "远端在预览之后被删除了");
						return "stale";
					}
					// 协议 v6（ADR-002 §3.6）：先显式恢复（身份与 revision 连续），再在恢复出的 revision 上传
					const restored = await restoreObject(ctx, it.path, e.server, `${it.operationId}-r`);
					if (restored === null) {
						markStale(job, it, "服务器没有提供被删除对象的身份，无法恢复");
						return "stale";
					}
					if (restored.sequence > 0) job.ownSequences.push(restored.sequence);
					base = restored.revision;
					out = await uploadFromPlain(ctx, it.path, data, base, mtime, "upsert", {
						operationId: it.operationId,
					});
				} else if (e instanceof ConflictError) {
					markStale(job, it, "远端在预览之后被其他设备修改了");
					return "stale";
				} else if (e instanceof ApiError && e.is("CANONICAL_COLLISION")) {
					markStale(job, it, "与远端一个仅大小写或 Unicode 写法不同的文件同名");
					return "stale";
				} else {
					throw e;
				}
			}
			job.ownSequences.push(out.sequence);
			it.fileId = out.fileId ?? it.fileId;
			it.resultRevision = out.revision;
			it.status = "done";
			if (reverse) {
				// 反向作业只恢复远端：本设备的跟踪状态保持在「回滚之前」，让随后的普通同步把
				// 恢复后的远端经标准 pull 路径带回本地（INV-03 的全部保护照常生效，本地副本已备份）。
				// restoreObject 顺手写进的身份记账在这里撤回，状态与回滚前完全一致
				if (it.action === "restore") ctx.store.markDeleted(it.path);
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
		case "delete": {
			if (it.source === "snapshot") await backupLocal(ctx, job, it);
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
	}
}

/**
 * 反向作业（回滚演练）：把原作业已完成的条目逐个反过来。
 *
 * - 原作业覆盖了远端 → 按恢复点内容写回（CAS 前提 = 原作业写出的 revision）；
 * - 原作业新建了远端文件 → 删除它；
 * - 原作业删除了远端文件 → 在墓碑上按恢复点内容重建。
 * 反向作业只改远端；本设备由随后的普通同步跟随恢复后的远端（经 pull 的标准保护），
 * 被替换掉的本地副本事先备份进恢复目录。
 */
export function buildReverseJob(job: ReplaceJob, now: number): ReplaceJob {
	if (job.kind !== "local-replace-remote") throw new ReplaceJobError("只能为原作业生成反向作业", "invalid-state");
	const items: ReplaceItem[] = [];
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
			remoteGeneration: undefined,
		};
		if (it.action === "update") {
			items.push({ ...common, action: "update", source: "snapshot", expectedRevision: it.resultRevision ?? 0 });
		} else if (it.action === "create") {
			items.push({ ...common, action: "delete", source: "snapshot", expectedRevision: it.resultRevision ?? 0, snapshotFile: undefined });
		} else if (it.action === "delete") {
			items.push({ ...common, action: "restore", source: "snapshot", expectedRevision: it.resultRevision ?? 0 });
		}
	}
	items.sort((a, b) => ORDER[a.action] - ORDER[b.action] || a.path.localeCompare(b.path));
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

/** 放弃作业：不回滚已完成条目（给出反向作业入口），只是不再继续。 */
export async function abandonReplaceJob(ctx: SyncContext, job: ReplaceJob): Promise<void> {
	job.state = "abandoned";
	await persistJob(ctx, job);
}
