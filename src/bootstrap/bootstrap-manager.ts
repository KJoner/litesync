/**
 * Bootstrap 执行器（v8 首次接入）。
 *
 * 三种模式共同的红线：
 * - 任何情况下不永久删除本地文件（覆盖前先进回收站，失败则保留 + pendingDeletes）
 * - 只触碰 LiteSync 同步范围内的文件（忽略规则、插件目录、配置目录照常排除）
 * - 完成后 lastSequence 对齐快照 sequence，无缝进入普通增量同步
 */
import { ConflictError, ServerInfo, SnapshotFile } from "../api/client";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { keepBothVersions } from "../sync/conflict";
import { SyncContext } from "../sync/context";
import { resolveSnapshotPaths, trashLocal } from "../sync/pull";
import { isStaleResurrection } from "../sync/push";
import { downloadPlain, uploadFromPlain } from "../sync/transfer";

export interface PreflightResult {
	info: ServerInfo;
	snapshotSequence: number;
	/** 快照对应的 repoEpoch（v9）：完成接入时与游标一起保存 */
	repoEpoch?: string;
	remoteFiles: SnapshotFile[];
	localPaths: string[];
	commonCount: number;
	/** 远端已启用 E2EE（执行前必须先解锁） */
	e2eeEnabled: boolean;
}

export interface BootstrapProgress {
	done: number;
	total: number;
	current: string;
}

type OnProgress = (p: BootstrapProgress) => void;

/** 接入前探测：远端信息 + 快照 + E2EE 状态 + 本地文件清单。 */
export async function preflight(ctx: SyncContext): Promise<PreflightResult> {
	const info = await ctx.client.info();
	await ctx.refreshE2ee();
	const snap = await ctx.client.snapshot();
	// meta 模式（v9.3 三期）：快照条目是伪名 + 加密元数据。已解锁则立即解出
	// 真实路径；未解锁保留伪名（向导会先走解锁门，执行器再兜底解一次）
	let files = snap.files;
	if (files.some((f) => f.metaEnc) && ctx.e2ee.unlocked) {
		files = await resolveSnapshotPaths(ctx, files);
	}
	const remoteFiles = files.filter((f) => !ctx.ignores(f.path));

	const localPaths: string[] = [];
	for (const file of ctx.app.vault.getFiles()) {
		if (!ctx.ignores(file.path)) localPaths.push(file.path);
	}
	const remoteSet = new Set(remoteFiles.map((f) => f.path));
	const commonCount = localPaths.filter((p) => remoteSet.has(p)).length;

	return {
		info,
		snapshotSequence: snap.sequence,
		repoEpoch: snap.repoEpoch ?? info.repoEpoch,
		remoteFiles,
		localPaths,
		commonCount,
		e2eeEnabled: ctx.e2ee.enabled,
	};
}

/** 执行器兜底：确保快照路径已解密（向导解锁后调用执行器时可能仍持伪名清单）。 */
async function ensureResolvedPre(ctx: SyncContext, pre: PreflightResult): Promise<PreflightResult> {
	if (!pre.remoteFiles.some((f) => f.metaEnc && f.path === f.fileId)) return pre;
	const files = await resolveSnapshotPaths(ctx, pre.remoteFiles);
	const remoteFiles = files.filter((f) => !ctx.ignores(f.path));
	const remoteSet = new Set(remoteFiles.map((f) => f.path));
	return {
		...pre,
		remoteFiles,
		commonCount: pre.localPaths.filter((p) => remoteSet.has(p)).length,
	};
}

function completeBootstrap(ctx: SyncContext, pre: PreflightResult, mode: "remote-wins" | "merge" | "local-init"): void {
	ctx.store.state.lastSequence = pre.snapshotSequence;
	ctx.store.completeBootstrap(mode, pre.info.vaultId, pre.snapshotSequence, pre.repoEpoch, pre.info.keyEpoch);
}

/** 本地初始化远端（远端为空）：标记就绪后由普通同步把本地文件全部推上去。 */
export async function bootstrapLocalInit(ctx: SyncContext, pre: PreflightResult): Promise<void> {
	completeBootstrap(ctx, pre, "local-init");
	await ctx.store.save();
	ctx.log(`bootstrap: local-init (local=${pre.localPaths.length})`);
}

/**
 * 从远端恢复此设备（Remote Wins）：远端为准覆盖本地同步范围。
 * 本地不同内容先进回收站；回收站失败保留文件并登记 pendingDeletes。
 */
export async function bootstrapRemoteWins(
	ctx: SyncContext,
	pre: PreflightResult,
	onProgress: OnProgress,
): Promise<void> {
	pre = await ensureResolvedPre(ctx, pre);
	const adapter = ctx.app.vault.adapter;
	const remoteSet = new Set(pre.remoteFiles.map((f) => f.path));
	const total = pre.remoteFiles.length + pre.localPaths.filter((p) => !remoteSet.has(p)).length;
	let done = 0;

	let blocked = 0;
	for (const f of pre.remoteFiles) {
		onProgress({ done: ++done, total, current: f.path });
		const dl = await downloadPlain(ctx, f.path, serverPseudonymOf(f));
		const stat = await adapter.stat(f.path);
		if (stat) {
			const localData = await adapter.readBinary(f.path);
			const localHash = await sha256Hex(localData);
			if (localHash === dl.plainHash) {
				// 内容一致：直接建立 tracked 状态，不动文件
				ctx.store.set(f.path, {
					hash: localHash,
					serverHash: dl.cipherHash,
					revision: dl.revision,
					mtime: stat.mtime,
					size: stat.size,
					fileId: dl.fileId,
					generation: dl.generation,
				});
				continue;
			}
			// 本地内容不同：先进回收站再写远端版本（绝不永久删除）。
			// P0-3 修复：回收站失败时绝不覆盖——本地这份可能是该内容的唯一副本，
			// 保留原文件并登记 blocked，普通同步的冲突流程接手（本地新内容不会丢）
			if (!(await trashLocal(ctx.app, f.path))) {
				blocked++;
				ctx.store.setBlockedChange(f.path, "bootstrap remote-wins：回收站不可用，未覆盖本地内容");
				ctx.notify(`无法移入回收站，已保留本地内容（未被远端覆盖）：${f.path}`);
				continue;
			}
		}
		await ensureParentFolder(adapter, f.path);
		await adapter.writeBinary(f.path, dl.plain, dl.mtime > 0 ? { mtime: dl.mtime } : undefined);
		const st = await adapter.stat(f.path);
		ctx.store.set(f.path, {
			hash: dl.plainHash,
			serverHash: dl.cipherHash,
			revision: dl.revision,
			mtime: st?.mtime ?? Date.now(),
			size: dl.plain.byteLength,
			fileId: dl.fileId,
			generation: dl.generation,
		});
	}

	// 本地多余的同步范围文件：远端没有 → 进回收站；失败保留 + pendingDeletes
	for (const path of pre.localPaths) {
		if (remoteSet.has(path)) continue;
		onProgress({ done: ++done, total, current: path });
		if (await trashLocal(ctx.app, path)) {
			ctx.store.delete(path);
		} else {
			ctx.store.delete(path);
			ctx.store.setPendingDelete(path);
			ctx.notify(`无法移入回收站，已保留本地文件（不会重新上传）：${path}\n请手动删除`);
		}
	}

	completeBootstrap(ctx, pre, "remote-wins");
	await ctx.store.save();
	ctx.log(`bootstrap: remote-wins (remote=${pre.remoteFiles.length}, blocked=${blocked})`);
}

export interface MergeResult {
	downloaded: number;
	uploaded: number;
	conflicts: number;
}

/**
 * 首次安全合并：保证两边数据都不丢，而不是强行自动融合。
 * - 远端有本地无 → 下载；本地有远端无 → 上传
 * - 双方一致 → 直接建立 tracked 状态
 * - 双方不同：Markdown → 登记 Initial Merge Conflict（Resolver 处理，无 Base 整体对比）；
 *   二进制等 → keepBothVersions 保留两个版本
 */
export async function bootstrapMerge(
	ctx: SyncContext,
	pre: PreflightResult,
	onProgress: OnProgress,
): Promise<MergeResult> {
	pre = await ensureResolvedPre(ctx, pre);
	const adapter = ctx.app.vault.adapter;
	const remoteSet = new Set(pre.remoteFiles.map((f) => f.path));
	const localOnly = pre.localPaths.filter((p) => !remoteSet.has(p));
	const total = pre.remoteFiles.length + localOnly.length;
	const result: MergeResult = { downloaded: 0, uploaded: 0, conflicts: 0 };
	let done = 0;

	for (const f of pre.remoteFiles) {
		onProgress({ done: ++done, total, current: f.path });
		const stat = await adapter.stat(f.path);
		if (!stat) {
			const dl = await downloadPlain(ctx, f.path, serverPseudonymOf(f));
			await ensureParentFolder(adapter, f.path);
			await adapter.writeBinary(f.path, dl.plain, dl.mtime > 0 ? { mtime: dl.mtime } : undefined);
			const st = await adapter.stat(f.path);
			ctx.store.set(f.path, {
				hash: dl.plainHash,
				serverHash: dl.cipherHash,
				revision: dl.revision,
				mtime: st?.mtime ?? Date.now(),
				size: dl.plain.byteLength,
				fileId: dl.fileId,
				generation: dl.generation,
			});
			result.downloaded++;
			continue;
		}
		const localData = await adapter.readBinary(f.path);
		const localHash = await sha256Hex(localData);
		const dl = await downloadPlain(ctx, f.path, serverPseudonymOf(f));
		if (localHash === dl.plainHash) {
			ctx.store.set(f.path, {
				hash: localHash,
				serverHash: dl.cipherHash,
				revision: dl.revision,
				mtime: stat.mtime,
				size: stat.size,
				fileId: dl.fileId,
				generation: dl.generation,
			});
			continue;
		}
		// 双方都有但内容不同：首次接入没有共同祖先（Base）
		if (isMarkdownLike(f.path)) {
			// 交给 Resolver（无 Base 时按“本地 vs 远端”整体对比）；期间该文件冻结同步
			ctx.store.setConflict(f.path, { baseRevision: 0, remoteRevision: dl.revision, createdAt: Date.now() });
			ctx.onConflictsChanged();
			result.conflicts++;
		} else {
			// 二进制/Canvas 等：保留两个版本兜底
			await keepBothVersions(ctx, f.path, localData);
			result.conflicts++;
		}
	}

	for (const path of localOnly) {
		onProgress({ done: ++done, total, current: path });
		const stat = await adapter.stat(path);
		if (!stat) continue;
		const data = await adapter.readBinary(path);
		const hash = await sha256Hex(data);
		let out;
		try {
			out = await uploadFromPlain(ctx, path, data, 0, stat.mtime);
		} catch (e) {
			// v9 tombstone 防复活：该路径在服务器上是删除墓碑。
			// 陈旧副本（内容与删除前一致）→ 不上传、登记 pendingDelete；
			// 同名新内容 → 基于墓碑 revision 显式重建
			if (e instanceof ConflictError && e.server.deleted) {
				if (await isStaleResurrection(ctx, path, hash, e.server)) {
					ctx.store.setPendingDelete(path);
					ctx.notify(`检测到已删除文件的陈旧副本，不会重新上传：${path}`);
					continue;
				}
				out = await uploadFromPlain(ctx, path, data, e.server.revision, stat.mtime);
			} else {
				throw e;
			}
		}
		ctx.store.set(path, {
			hash,
			serverHash: out.cipherHash,
			revision: out.revision,
			mtime: stat.mtime,
			size: stat.size,
			fileId: out.fileId,
			generation: out.generation,
		});
		result.uploaded++;
	}

	// 上传会推进服务器 sequence：合并后的基线取「接入时快照」，
	// 随后的普通同步会拉到自己刚上传的 change 并按 serverHash 快速对齐
	completeBootstrap(ctx, pre, "merge");
	await ctx.store.save();
	ctx.log(
		`bootstrap: merge (down=${result.downloaded} up=${result.uploaded} conflicts=${result.conflicts})`,
	);
	return result;
}

/** meta 模式下条目的服务器伪名（解密后 path 为真实路径，伪名在 fileId）。 */
function serverPseudonymOf(f: SnapshotFile): string | undefined {
	return f.metaEnc && f.fileId ? f.fileId : undefined;
}

/** 与三方合并引擎一致的“可文本合并”判定：仅 Markdown / 纯文本。 */
function isMarkdownLike(path: string): boolean {
	const p = path.toLowerCase();
	return p.endsWith(".md") || p.endsWith(".txt");
}
