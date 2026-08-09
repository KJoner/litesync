import { App, Platform } from "obsidian";
import { NotFoundError, RemoteChange } from "../api/client";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { attemptAutoMerge } from "./auto-merge";
import { keepBothVersions } from "./conflict";
import { SyncContext } from "./context";
import { downloadPlain } from "./transfer";

export interface PullResult {
	applied: number;
	conflicts: number;
}

/**
 * 拉取并应用远端变更。
 * 数据安全红线：每条 change 成功处理之后才推进 lastSequence；
 * 中途失败时已处理部分的游标会被保存，不会漏掉远端修改。
 */
export async function pullRemoteChanges(ctx: SyncContext): Promise<PullResult> {
	const result: PullResult = { applied: 0, conflicts: 0 };
	try {
		for (;;) {
			const resp = await ctx.client.changes(ctx.store.state.lastSequence, 500);
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

type Outcome = "applied" | "skipped" | "conflict";

/**
 * snapshot 全量对账：把「快照 vs 本地状态缓存」的差异合成为等价的远端变更，
 * 复用 applyRemoteChange 的全部安全逻辑（冲突/合并/回收站），最后对齐游标。
 */
async function resyncFromSnapshot(ctx: SyncContext): Promise<PullResult> {
	const result: PullResult = { applied: 0, conflicts: 0 };
	const snap = await ctx.client.snapshot();
	const snapPaths = new Set(snap.files.map((f) => f.path));

	// 已跟踪但快照中不存在 → 远端已删除
	for (const path of ctx.store.paths()) {
		if (ctx.ignores(path) || snapPaths.has(path)) continue;
		const outcome = await applyRemoteChange(ctx, {
			sequence: snap.sequence,
			path,
			action: "delete",
			revision: 0,
		});
		if (outcome === "applied") result.applied++;
		if (outcome === "conflict") result.conflicts++;
	}
	// 快照与本地已知服务器状态不一致 → 远端有更新
	for (const f of snap.files) {
		if (ctx.ignores(f.path)) continue;
		const tracked = ctx.store.get(f.path);
		if (tracked && tracked.serverHash === f.hash) {
			if (tracked.revision !== f.revision) {
				ctx.store.set(f.path, { ...tracked, revision: f.revision });
			}
			continue;
		}
		const outcome = await applyRemoteChange(ctx, {
			sequence: snap.sequence,
			path: f.path,
			action: "upsert",
			revision: f.revision,
			hash: f.hash,
		});
		if (outcome === "applied") result.applied++;
		if (outcome === "conflict") result.conflicts++;
	}

	ctx.store.state.lastSequence = snap.sequence;
	await ctx.store.save();
	ctx.notify("服务器变更日志已轮转，已通过快照完成全量对账");
	return result;
}

async function applyRemoteChange(ctx: SyncContext, change: RemoteChange): Promise<Outcome> {
	const path = change.path;
	if (ctx.ignores(path)) return "skipped";
	// 文件正在冲突处理中：冻结远端应用，避免来回覆盖；Resolver 解决时会重新取远端 HEAD
	if (ctx.store.getConflict(path)) return "skipped";

	const adapter = ctx.app.vault.adapter;
	const stat = await adapter.stat(path);
	if (stat?.type === "folder") {
		ctx.notify(`跳过：远端文件与本地文件夹同名 ${path}`);
		return "skipped";
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
		ctx.store.set(path, { ...tracked, revision: change.revision });
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
		ctx.store.set(path, {
			hash: localHash,
			serverHash: change.hash,
			revision: change.revision,
			mtime: stat?.mtime ?? Date.now(),
			size: stat?.size ?? localData!.byteLength,
		});
		return "skipped";
	}

	const localChanged = stat !== null && (!tracked || localHash !== tracked.hash);

	if (!stat || !localChanged) {
		// 本地不存在，或本地自上次同步后未修改 → 直接采用远端版本
		let dl;
		try {
			dl = await downloadPlain(ctx, path);
		} catch (e) {
			if (e instanceof NotFoundError) return "skipped"; // 已被后续 change 删除
			throw e;
		}
		await ensureParentFolder(adapter, path);
		await adapter.writeBinary(path, dl.plain, dl.mtime > 0 ? { mtime: dl.mtime } : undefined);
		const st = await adapter.stat(path);
		ctx.store.set(path, {
			hash: dl.plainHash,
			serverHash: dl.cipherHash,
			revision: dl.revision,
			mtime: st?.mtime ?? Date.now(),
			size: dl.plain.byteLength,
		});
		ctx.log(`pull: downloaded ${path} (rev ${dl.revision})`);
		return "applied";
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
