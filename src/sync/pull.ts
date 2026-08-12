import { App, Platform } from "obsidian";
import { NotFoundError, RemoteChange, SnapshotFile } from "../api/client";
import { decryptMeta } from "../crypto/crypto";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { requireFileId } from "../utils/validate";
import { attemptAutoMerge } from "./auto-merge";
import { keepBothVersions } from "./conflict";
import { SyncContext } from "./context";
import { downloadPlain, metaEncrypted, writeIfLocalUnchanged } from "./transfer";

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * 伪名变更解析（v9.3 三期 meta 模式）：change.path 是 32-hex 伪名（=fileId）。
 * 已跟踪 → 反查真实路径；未知伪名 → 轻量取加密元数据解出真实路径。
 * 返回 null 表示该变更无需处理（如从未有过的文件被删除）。
 */
async function resolveMetaChange(
	ctx: SyncContext,
	change: RemoteChange,
): Promise<{ realPath: string; serverPath: string } | "skip" | null> {
	const pseudonym = requireFileId(change.path, `change@${change.sequence}.path`);
	const known = ctx.store.pathByFileId(pseudonym);
	if (known !== undefined) return { realPath: known, serverPath: pseudonym };
	if (change.action === "delete") return "skip"; // 本地从未有过

	// 未知伪名：取元数据解出真实路径（无需下载内容）
	let meta;
	try {
		meta = await ctx.client.getFileMeta(pseudonym);
	} catch (e) {
		if (e instanceof NotFoundError) return "skip"; // 已被后续 change 删除
		throw e;
	}
	if (!meta.metaEnc) throw new Error(`meta 模式下服务器未返回加密元数据：${pseudonym}`);
	const bind = ctx.store.state.bootstrap;
	const keys = await ctx.e2ee.metaKeys();
	const dec = await decryptMeta(keys, meta.metaEnc, bind.remoteVaultId ?? "", pseudonym);
	if (dec === null) throw new Error(`无法解密文件元数据（${pseudonym}）：密钥不匹配或数据被篡改，已停止同步`);
	return { realPath: dec.meta.path, serverPath: pseudonym };
}

/**
 * 元数据改名应用（v9.3 三期）：内容未变、metaGeneration 变新 → 本地 rename。
 * 目标已被占用时登记 blocked（不覆盖任何本地内容）。
 */
async function applyMetaRename(ctx: SyncContext, realPath: string, pseudonym: string): Promise<Outcome> {
	const tracked = ctx.store.get(realPath);
	if (!tracked) return "skipped";
	const meta = await ctx.client.getFileMeta(pseudonym);
	const bind = ctx.store.state.bootstrap;
	const keys = await ctx.e2ee.metaKeys();
	const dec = await decryptMeta(keys, meta.metaEnc, bind.remoteVaultId ?? "", pseudonym);
	if (dec === null) throw new Error(`无法解密文件元数据（${pseudonym}）`);
	const newPath = dec.meta.path;
	// 身份字段一律经 store.update/rename 保留（LS-121-C04）：改名不改 fileId、
	// 不改 contentGeneration，也不改服务器伪名
	if (newPath === realPath) {
		ctx.store.update(realPath, { metaGeneration: dec.metaGeneration, serverPseudonym: pseudonym });
		return "skipped";
	}
	const adapter = ctx.app.vault.adapter;
	if (await adapter.stat(newPath)) {
		ctx.store.setBlockedChange(newPath, `远端改名目标已被本地文件占用（原 ${realPath}）`);
		ctx.notify(`远端将 ${realPath} 改名为 ${newPath}，但目标已存在本地文件，已暂缓`);
		return "blocked";
	}
	if (!(await adapter.stat(realPath))) {
		// 本地原文件不在（可能刚被用户移走）：只更新状态键，内容由扫描收敛
		ctx.store.rename(realPath, newPath, { metaGeneration: dec.metaGeneration, serverPseudonym: pseudonym });
		return "applied";
	}
	await ensureParentFolder(adapter, newPath);
	await adapter.rename(realPath, newPath);
	ctx.store.rename(realPath, newPath, { metaGeneration: dec.metaGeneration, serverPseudonym: pseudonym });
	ctx.log(`pull: renamed ${realPath} -> ${newPath} (metaGen ${dec.metaGeneration})`);
	return "applied";
}

export interface PullResult {
	applied: number;
	conflicts: number;
}

/** 服务器 repoEpoch 与本地保存值不一致（灾备恢复后）时抛出，中止本轮同步。 */
export class RepoEpochChangedError extends Error {
	constructor() {
		super("服务器 sequence 世代（repoEpoch）已变化，本设备需要重新接入");
		this.name = "RepoEpochChangedError";
	}
}

/**
 * epoch 防护（v9）：服务器从备份恢复后 repoEpoch 会被旋转，旧游标全部作废。
 * 发现变化：重置 bootstrap → 用户通过接入向导选择「安全合并」重新对齐
 *（本地 post-backup 的新内容全部保留，两侧差异走冲突流程，绝不静默丢弃）。
 */
async function guardRepoEpoch(ctx: SyncContext, serverEpoch: string | undefined): Promise<void> {
	if (!serverEpoch) return;
	const saved = ctx.store.state.bootstrap.repoEpoch;
	if (!saved) {
		// v0.8 升级上来的设备第一次见到 epoch：记录之
		ctx.store.state.bootstrap.repoEpoch = serverEpoch;
		return;
	}
	if (saved !== serverEpoch) {
		ctx.store.resetBootstrap();
		await ctx.store.save();
		ctx.notify(
			"服务器数据已从备份恢复（repoEpoch 变化），自动同步已暂停；\n请重新运行接入向导并选择「安全合并」，本地较新的内容不会丢失",
		);
		throw new RepoEpochChangedError();
	}
}

/**
 * 拉取并应用远端变更。
 * 数据安全红线：每条 change 成功处理之后才推进 lastSequence；
 * 中途失败时已处理部分的游标会被保存，不会漏掉远端修改。
 */
export async function pullRemoteChanges(ctx: SyncContext): Promise<PullResult> {
	const result: PullResult = { applied: 0, conflicts: 0 };
	try {
		await retryBlockedChanges(ctx, result);
		for (;;) {
			const resp = await ctx.client.changes(ctx.store.state.lastSequence, 500);
			await guardRepoEpoch(ctx, resp.repoEpoch);
			if (resp.resyncRequired) {
				// 服务器已裁剪掉旧 changes：走 snapshot 全量对账重建游标（绝不漏删改）
				ctx.log(
					`resync required (cursor ${ctx.store.state.lastSequence} < min ${resp.minSequence ?? 0})`,
				);
				const r = await resyncFromSnapshot(ctx);
				result.applied += r.applied;
				result.conflicts += r.conflicts;
				break;
			}
			// 防御：同一 epoch 内服务器 head 落后于本地游标（正常协议下不应发生）
			// → 不再盲等，走 snapshot 对账把游标锚回真实状态
			if (resp.changes.length === 0 && resp.latestSequence < ctx.store.state.lastSequence) {
				ctx.log(
					`server head ${resp.latestSequence} < cursor ${ctx.store.state.lastSequence}, forcing snapshot reconcile`,
				);
				const r = await resyncFromSnapshot(ctx);
				result.applied += r.applied;
				result.conflicts += r.conflicts;
				break;
			}
			if (resp.changes.length === 0) {
				// 没有新变更；latestSequence 可能因事务回滚出现空洞，直接对齐
				if (resp.latestSequence > ctx.store.state.lastSequence) {
					ctx.store.state.lastSequence = resp.latestSequence;
				}
				break;
			}
			for (const change of resp.changes) {
				const outcome = await applyRemoteChange(ctx, change);
				if (outcome === "applied") result.applied++;
				if (outcome === "conflict") result.conflicts++;
				ctx.store.state.lastSequence = change.sequence;
			}
			if (!resp.hasMore) break;
		}
	} finally {
		await ctx.store.save();
	}
	return result;
}

/**
 * 重试被阻塞的远端变更（v9：skipped 不再等于永久放弃）。
 * 例：远端文件与本地文件夹同名——用户移走文件夹后，这里会把该文件补下载回来，
 * 即使服务器不再产生新的 change。
 */
async function retryBlockedChanges(ctx: SyncContext, result: PullResult): Promise<void> {
	for (const path of ctx.store.blockedChangePaths()) {
		const stat = await ctx.app.vault.adapter.stat(path);
		if (stat?.type === "folder") continue; // 阻塞条件仍在
		const outcome = await applyRemoteChange(ctx, {
			sequence: ctx.store.state.lastSequence,
			path,
			action: "upsert",
			revision: 0,
		});
		if (outcome !== "blocked") ctx.store.clearBlockedChange(path);
		if (outcome === "applied") result.applied++;
		if (outcome === "conflict") result.conflicts++;
	}
}

type Outcome = "applied" | "skipped" | "conflict" | "blocked";

/**
 * snapshot 全量对账：把「快照 vs 本地状态缓存」的差异合成为等价的远端变更，
 * 复用 applyRemoteChange 的全部安全逻辑（冲突/合并/回收站），最后对齐游标。
 */
async function resyncFromSnapshot(ctx: SyncContext): Promise<PullResult> {
	const result: PullResult = { applied: 0, conflicts: 0 };
	const snap = await ctx.client.snapshot();
	await guardRepoEpoch(ctx, snap.repoEpoch);

	// meta 模式（v9.3 三期）：快照条目是伪名 + 加密元数据 → 先解出真实路径
	const files = await resolveSnapshotPaths(ctx, snap.files);
	const snapPaths = new Set(files.map((f) => f.path));

	// 已跟踪但快照中不存在 → 远端已删除
	for (const path of ctx.store.paths()) {
		if (ctx.ignores(path) || snapPaths.has(path)) continue;
		const tracked = ctx.store.get(path);
		const outcome = await applyRemoteChange(ctx, {
			sequence: snap.sequence,
			path: metaEncrypted(ctx) && tracked?.fileId ? tracked.fileId : path,
			action: "delete",
			revision: 0,
		});
		if (outcome === "applied") result.applied++;
		if (outcome === "conflict") result.conflicts++;
	}
	// 快照与本地已知服务器状态不一致 → 远端有更新
	for (const f of files) {
		if (ctx.ignores(f.path)) continue;
		// 离线期间的远端改名：同 fileId 挂在别的本地路径上 → 先做本地 rename
		if (f.fileId && f.serverPseudonym) {
			const existing = ctx.store.pathByFileId(f.fileId);
			if (existing !== undefined && existing !== f.path) {
				const outcome = await applyMetaRename(ctx, existing, f.serverPseudonym);
				if (outcome === "applied") result.applied++;
				if (outcome === "blocked") continue;
			}
		}
		const tracked = ctx.store.get(f.path);
		if (tracked && tracked.serverHash === f.hash) {
			if (tracked.revision !== f.revision || tracked.metaGeneration !== f.metaGeneration) {
				ctx.store.update(f.path, {
					revision: f.revision,
					metaGeneration: f.metaGeneration,
					fileId: f.fileId,
					serverPseudonym: f.serverPseudonym,
				});
			}
			continue;
		}
		const outcome = await applyRemoteChange(ctx, {
			sequence: snap.sequence,
			path: f.serverPseudonym ?? f.path,
			action: "upsert",
			revision: f.revision,
			hash: f.hash,
			metaGeneration: f.metaGeneration,
		});
		if (outcome === "applied") result.applied++;
		if (outcome === "conflict") result.conflicts++;
	}

	ctx.store.state.lastSequence = snap.sequence;
	await ctx.store.save();
	ctx.notify("服务器变更日志已轮转，已通过快照完成全量对账");
	return result;
}

interface ResolvedSnapshotFile extends SnapshotFile {
	/** meta 模式下的服务器伪名（path 已替换为解密出的真实路径） */
	serverPseudonym?: string;
}

/** 快照条目的元数据解密（明文模式原样返回）。 */
export async function resolveSnapshotPaths(
	ctx: SyncContext,
	files: SnapshotFile[],
): Promise<ResolvedSnapshotFile[]> {
	if (!files.some((f) => f.metaEnc)) return files;
	const vaultId = ctx.store.state.bootstrap.remoteVaultId ?? "";
	const keys = await ctx.e2ee.metaKeys();
	const out: ResolvedSnapshotFile[] = [];
	for (const f of files) {
		if (!f.metaEnc || !f.fileId) {
			out.push(f); // 迁移中的混合态：明文路径条目原样处理
			continue;
		}
		const dec = await decryptMeta(keys, f.metaEnc, vaultId, f.fileId);
		if (dec === null) {
			throw new Error(`无法解密文件元数据（${f.fileId}）：密钥不匹配或数据被篡改，已停止同步`);
		}
		out.push({ ...f, path: dec.meta.path, metaGeneration: dec.metaGeneration, serverPseudonym: f.fileId });
	}
	return out;
}

async function applyRemoteChange(ctx: SyncContext, change: RemoteChange): Promise<Outcome> {
	let path = change.path;
	let serverPath: string | undefined;

	// meta 模式（v9.3 三期）：变更携带伪名，先解析出真实路径
	if (metaEncrypted(ctx) && HEX32.test(change.path)) {
		const resolved = await resolveMetaChange(ctx, change);
		if (resolved === "skip" || resolved === null) return "skipped";
		path = resolved.realPath;
		serverPath = resolved.serverPath;

		// 内容未变但元数据世代变新 = 仅改名
		const tracked = ctx.store.get(path);
		if (
			change.action === "upsert" &&
			tracked &&
			change.hash &&
			change.hash === tracked.serverHash &&
			(change.metaGeneration ?? 0) > (tracked.metaGeneration ?? 0)
		) {
			return applyMetaRename(ctx, path, resolved.serverPath);
		}
	}

	if (ctx.ignores(path)) return "skipped";
	// 文件正在冲突处理中：冻结远端应用，避免来回覆盖；Resolver 解决时会重新取远端 HEAD
	if (ctx.store.getConflict(path)) return "skipped";

	const adapter = ctx.app.vault.adapter;
	const stat = await adapter.stat(path);
	if (stat?.type === "folder") {
		// v9：不再静默 ACK——持久化 blocked 记录，每轮同步重试，
		// 用户移走同名文件夹后即使没有新 change 也能补回该文件
		ctx.store.setBlockedChange(path, "远端文件与本地文件夹同名");
		ctx.notify(`已暂缓：远端文件与本地文件夹同名 ${path}\n移走该文件夹后会自动补齐`);
		return "blocked";
	}
	const tracked = ctx.store.get(path);

	if (change.action === "delete") {
		if (!stat) {
			ctx.store.delete(path);
			ctx.store.clearPendingDelete(path);
			return "skipped";
		}
		const localData = await adapter.readBinary(path);
		const localHash = await sha256Hex(localData);
		if (tracked && localHash === tracked.hash) {
			// 本地未修改 → 跟随远端删除（进回收站，保底不丢数据）
			if (await trashLocal(ctx.app, path)) {
				ctx.store.delete(path);
				ctx.log(`pull: deleted ${path}`);
				return "applied";
			}
			// 删除安全（所有平台）：回收站失败时宁可多留一份，绝不永久删除。
			// 记入 pendingDeletes：扫描时跳过（不会被当作新文件重新上传），等用户手动删除
			ctx.store.delete(path);
			ctx.store.setPendingDelete(path);
			ctx.notify(`无法移入回收站，已保留本地文件（不会重新上传）：${path}\n请手动删除`);
			return "applied";
		}
		// 本地有未同步修改 → 保留本地内容，转为新文件重新上传
		ctx.store.delete(path);
		ctx.queue.add(path, "upsert");
		ctx.notify(`远端已删除但本地有修改，已保留本地文件: ${path}`);
		return "conflict";
	}

	// upsert
	// 服务器该内容本设备已知（例如自己刚推送的变更）→ 只推进 revision
	if (tracked && change.hash && change.hash === tracked.serverHash) {
		ctx.store.update(path, { revision: change.revision, serverPseudonym: serverPath });
		return "skipped";
	}

	let localHash: string | null = null;
	let localData: ArrayBuffer | null = null;
	if (stat) {
		const data = await adapter.readBinary(path);
		localData = data;
		localHash = await sha256Hex(data);
	}

	// 本地明文与远端内容一致（明文模式的快速路径）→ 只更新状态
	if (localHash !== null && change.hash && localHash === change.hash) {
		ctx.store.update(path, {
			hash: localHash,
			serverHash: change.hash,
			revision: change.revision,
			mtime: stat?.mtime ?? Date.now(),
			size: stat?.size ?? localData!.byteLength,
			serverPseudonym: serverPath,
		});
		return "skipped";
	}

	const localChanged = stat !== null && (!tracked || localHash !== tracked.hash);

	if (!stat || !localChanged) {
		// 本地不存在，或本地自上次同步后未修改 → 采用远端版本
		let dl;
		try {
			dl = await downloadPlain(ctx, path, serverPath);
		} catch (e) {
			if (e instanceof NotFoundError) return "skipped"; // 已被后续 change 删除
			throw e;
		}
		// 本地 CAS（v9 TOCTOU 修复）：下载是网络等待，期间用户可能恰好编辑了
		// 这个文件（且事件因 applyingRemote 被忽略）——写入前必须确认本地
		// 仍是决策时刻的内容，否则用户刚敲下的新内容会被远端版本静默覆盖
		if (await writeIfLocalUnchanged(ctx, path, dl.plain, localHash, dl.mtime)) {
			const st = await adapter.stat(path);
			ctx.store.update(path, {
				hash: dl.plainHash,
				serverHash: dl.cipherHash,
				revision: dl.revision,
				mtime: st?.mtime ?? Date.now(),
				size: dl.plain.byteLength,
				fileId: dl.fileId,
				generation: dl.generation,
				metaGeneration: dl.metaGeneration ?? change.metaGeneration,
				serverPseudonym: serverPath,
			});
			ctx.log(`pull: downloaded ${path} (rev ${dl.revision})`);
			return "applied";
		}
		// 下载期间本地出现了新内容/被删除 → 绝不覆盖：
		// 重新读取现场，落入下方「双方都改」的合并/兜底流程
		ctx.log(`pull: local changed during download of ${path}, rerouting to merge`);
		const curStat = await adapter.stat(path);
		if (!curStat) return "skipped"; // 下载期间被删除：交给扫描的 delete 流程
		localData = await adapter.readBinary(path);
	}

	// 本地与远端都改了 → 先尝试三方自动合并（仅 Markdown 文本）
	const merged = await attemptAutoMerge(ctx, path, localData!, tracked);
	if (merged === "merged") return "applied";
	if (merged === "pending") {
		ctx.notify(`同步冲突: ${path}\n请运行 "Resolve conflicts" 处理`);
		return "conflict";
	}
	// 无法自动合并（二进制 / 无 Base / 引擎异常）→ 最后安全兜底：保留两个版本
	const kept = await keepBothVersions(ctx, path, localData!);
	return kept === null ? "skipped" : "conflict";
}

/**
 * 删除本地文件时进回收站，任何平台都绝不永久删除（README 承诺）。返回是否成功。
 * 优先 FileManager.trashFile（尊重用户在「删除的文件」中的偏好设置）；
 * 回收站失败一律返回 false，由调用方保留本地文件并登记 pendingDeletes，
 * 提示用户手动删除——宁可多留一份，不可误删。
 */
export async function trashLocal(app: App, path: string): Promise<boolean> {
	const adapter = app.vault.adapter;
	try {
		const af = app.vault.getAbstractFileByPath(path);
		if (af) {
			await app.fileManager.trashFile(af);
			return true;
		}
		// 配置目录等隐藏路径拿不到 TAbstractFile，退回 adapter
		if (!Platform.isMobileApp && (await adapter.trashSystem(path))) return true;
		await adapter.trashLocal(path);
		return true;
	} catch {
		return false;
	}
}
