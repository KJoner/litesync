import { App } from "obsidian";
import { NotFoundError, RemoteChange } from "../api/client";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { attemptAutoMerge } from "./auto-merge";
import { keepBothVersions } from "./conflict";
import { SyncContext } from "./context";

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
			return "skipped";
		}
		const localData = await adapter.readBinary(path);
		const localHash = await sha256Hex(localData);
		if (tracked && localHash === tracked.hash) {
			// 本地未修改 → 跟随远端删除（进回收站，保底不丢数据）
			await trashLocal(ctx.app, path);
			ctx.store.delete(path);
			ctx.log(`pull: deleted ${path}`);
			return "applied";
		}
		// 本地有未同步修改 → 保留本地内容，转为新文件重新上传
		ctx.store.delete(path);
		ctx.queue.add(path, "upsert");
		ctx.notify(`远端已删除但本地有修改，已保留本地文件: ${path}`);
		return "conflict";
	}

	// upsert
	let localHash: string | null = null;
	let localData: ArrayBuffer | null = null;
	if (stat) {
		const data = await adapter.readBinary(path);
		localData = data;
		localHash = await sha256Hex(data);
	}

	// 本地内容与远端一致（例如自己刚推送的变更）→ 只更新状态
	if (localHash !== null && change.hash && localHash === change.hash) {
		ctx.store.set(path, {
			hash: localHash,
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
			dl = await ctx.client.download(path);
		} catch (e) {
			if (e instanceof NotFoundError) return "skipped"; // 已被后续 change 删除
			throw e;
		}
		const gotHash = await sha256Hex(dl.data);
		if (dl.hash && gotHash !== dl.hash) {
			throw new Error(`downloaded content hash mismatch for ${path}`);
		}
		await ensureParentFolder(adapter, path);
		await adapter.writeBinary(path, dl.data, dl.mtime > 0 ? { mtime: dl.mtime } : undefined);
		const st = await adapter.stat(path);
		ctx.store.set(path, {
			hash: gotHash,
			revision: dl.revision,
			mtime: st?.mtime ?? Date.now(),
			size: dl.size,
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

/** 删除本地文件时优先进回收站，绝不静默永久删除。 */
async function trashLocal(app: App, path: string): Promise<void> {
	const af = app.vault.getAbstractFileByPath(path);
	if (af) {
		await app.vault.trash(af, true);
		return;
	}
	// .obsidian 等隐藏路径拿不到 TAbstractFile，退回 adapter
	const adapter = app.vault.adapter;
	try {
		if (!(await adapter.trashSystem(path))) {
			await adapter.trashLocal(path);
		}
	} catch {
		await adapter.remove(path);
	}
}
