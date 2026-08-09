import { Platform } from "obsidian";
import { ApiError, ConflictError, NotFoundError } from "../api/client";
import { E2eeLockedError } from "../crypto/keyring";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { attemptAutoMerge } from "./auto-merge";
import { keepBothVersions } from "./conflict";
import { SyncContext } from "./context";
import { downloadPlain, uploadFromPlain } from "./transfer";

export interface PushResult {
	pushed: number;
	conflicts: number;
}

/**
 * 扫描本地变化并加入队列：
 * - 新文件 / mtime+size 与缓存不一致的文件 → upsert（实际是否变化由 hash 决定）
 * - 状态缓存中存在但本地已消失的文件 → delete
 *
 * 每次同步都会执行，因此即使 Obsidian 关闭期间的修改（事件丢失）也能被发现。
 */
export async function scanLocalChanges(ctx: SyncContext): Promise<void> {
	const seen = new Set<string>();

	// 待手动删除的文件（移动端回收站失败时保留的，v6）：用户已手动删除则清除记录
	for (const path of Object.keys(ctx.store.state.pendingDeletes)) {
		if (!(await ctx.app.vault.adapter.stat(path))) ctx.store.clearPendingDelete(path);
	}

	for (const file of ctx.app.vault.getFiles()) {
		const path = file.path;
		if (ctx.ignores(path) || ctx.store.hasPendingDelete(path)) continue;
		seen.add(path);
		const tracked = ctx.store.get(path);
		if (!tracked || tracked.mtime !== file.stat.mtime || tracked.size !== file.stat.size) {
			ctx.queue.add(path, "upsert");
		}
	}

	// vault.getFiles() 不包含 .obsidian 下的隐藏文件，需要单独遍历
	if (ctx.syncObsidian()) {
		for (const path of await listHiddenFiles(ctx, ".obsidian")) {
			if (ctx.ignores(path) || ctx.store.hasPendingDelete(path)) continue;
			seen.add(path);
			const stat = await ctx.app.vault.adapter.stat(path);
			if (!stat) continue;
			const tracked = ctx.store.get(path);
			if (!tracked || tracked.mtime !== stat.mtime || tracked.size !== stat.size) {
				ctx.queue.add(path, "upsert");
			}
		}
	}

	for (const path of ctx.store.paths()) {
		if (ctx.ignores(path) || seen.has(path)) continue;
		ctx.queue.add(path, "delete");
	}
}

async function listHiddenFiles(ctx: SyncContext, dir: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (d: string): Promise<void> => {
		if (ctx.ignores(d)) return;
		let listing;
		try {
			listing = await ctx.app.vault.adapter.list(d);
		} catch {
			return;
		}
		out.push(...listing.files);
		for (const sub of listing.folders) await walk(sub);
	};
	await walk(dir);
	return out;
}

/**
 * 推送队列中的待同步变更。
 * 数据安全红线：条目只在处理成功后从队列移除；
 * 网络失败时剩余条目留在队列中，等待下次重试。
 */
export async function pushPendingChanges(ctx: SyncContext): Promise<PushResult> {
	const result: PushResult = { pushed: 0, conflicts: 0 };
	try {
		for (const [path, action] of ctx.queue.entries()) {
			if (ctx.ignores(path)) {
				ctx.queue.remove(path);
				continue;
			}
			const outcome = action === "upsert" ? await pushUpsert(ctx, path) : await pushDelete(ctx, path);
			if (outcome === "pushed") result.pushed++;
			if (outcome === "conflict") result.conflicts++;
			ctx.queue.remove(path);
		}
	} finally {
		await ctx.store.save();
	}
	return result;
}

type Outcome = "pushed" | "skipped" | "conflict";

/** 移动端大文件内存警告阈值（整文件进内存加密上传，见 v6 计划 Part 28）。 */
const MOBILE_LARGE_FILE_WARNING_BYTES = 50 << 20;
const warnedLargeFiles = new Set<string>();

async function pushUpsert(ctx: SyncContext, path: string): Promise<Outcome> {
	// 文件处于 unresolved conflict：不继续自动 Push（计划书 Pending Conflict 规则）
	if (ctx.store.getConflict(path)) return "skipped";
	const adapter = ctx.app.vault.adapter;
	const stat = await adapter.stat(path);
	if (!stat || stat.type === "folder") return "skipped"; // 入队后又被删除，交给 delete 流程

	const data = await adapter.readBinary(path);
	// 只警告不跳过：静默跳过会破坏同步一致性
	if (Platform.isMobileApp && data.byteLength > MOBILE_LARGE_FILE_WARNING_BYTES && !warnedLargeFiles.has(path)) {
		warnedLargeFiles.add(path);
		ctx.notify(`⚠ 大文件在移动端同步可能占用较多内存：${path}（${Math.round(data.byteLength / (1 << 20))} MB）`);
	}
	const hash = await sha256Hex(data);
	const tracked = ctx.store.get(path);
	if (tracked && tracked.hash === hash) {
		// 内容没变（例如只是 mtime 变化），刷新缓存即可
		ctx.store.set(path, { ...tracked, mtime: stat.mtime, size: stat.size });
		return "skipped";
	}

	const baseRevision = tracked?.revision ?? 0;
	try {
		const out = await uploadFromPlain(ctx, path, data, baseRevision, stat.mtime);
		ctx.store.set(path, {
			hash,
			serverHash: out.cipherHash,
			revision: out.revision,
			mtime: stat.mtime,
			size: stat.size,
		});
		ctx.log(`push: uploaded ${path} (rev ${out.revision})`);
		return "pushed";
	} catch (e) {
		if (e instanceof ConflictError) {
			const server = e.server;
			if (server.deleted) {
				// 服务器上是删除墓碑 → 基于墓碑 revision 重新创建
				const out = await uploadFromPlain(ctx, path, data, server.revision, stat.mtime);
				ctx.store.set(path, {
					hash,
					serverHash: out.cipherHash,
					revision: out.revision,
					mtime: stat.mtime,
					size: stat.size,
				});
				return "pushed";
			}
			if (!ctx.e2ee.enabled && server.hash === hash) {
				// 明文模式：服务器已有相同内容（重试或他端相同修改）→ 采纳服务器 revision
				ctx.store.set(path, {
					hash,
					serverHash: server.hash,
					revision: server.revision,
					mtime: stat.mtime,
					size: stat.size,
				});
				return "skipped";
			}
			// E2EE 下密文 hash 不可比 → 下载解密后按明文比较（覆盖重试/两端相同修改，含二进制）
			try {
				const dl = await downloadPlain(ctx, path);
				if (dl.plainHash === hash) {
					ctx.store.set(path, {
						hash,
						serverHash: dl.cipherHash,
						revision: dl.revision,
						mtime: stat.mtime,
						size: stat.size,
					});
					return "skipped";
				}
			} catch (dlErr) {
				if (dlErr instanceof E2eeLockedError) throw dlErr;
				// 下载失败不阻塞冲突处理，继续走合并/兜底
			}
			// 真实冲突 → 先尝试三方自动合并（仅 Markdown 文本）
			const merged = await attemptAutoMerge(ctx, path, data, tracked);
			if (merged === "merged") return "pushed";
			if (merged === "pending") {
				ctx.notify(`同步冲突: ${path}\n请运行 "Resolve conflicts" 处理`);
				return "conflict";
			}
			// 无法自动合并 → 最后安全兜底：保留两个版本
			const kept = await keepBothVersions(ctx, path, data);
			return kept === null ? "skipped" : "conflict";
		}
		if (e instanceof ApiError && e.status === 413) {
			ctx.notify(`Skipped large file（超过服务器大小限制）: ${path}`);
			return "skipped";
		}
		throw e;
	}
}

async function pushDelete(ctx: SyncContext, path: string): Promise<Outcome> {
	if (ctx.store.getConflict(path)) return "skipped"; // 冲突处理中不做自动删除
	const tracked = ctx.store.get(path);
	if (!tracked) return "skipped"; // 从未同步过，服务器上不存在

	const adapter = ctx.app.vault.adapter;
	if (await adapter.stat(path)) return "skipped"; // 文件又回来了（如撤销删除），交给 upsert 流程

	try {
		await ctx.client.remove(path, tracked.revision);
		ctx.store.delete(path);
		ctx.log(`push: deleted ${path}`);
		return "pushed";
	} catch (e) {
		if (e instanceof NotFoundError) {
			ctx.store.delete(path);
			return "skipped";
		}
		if (e instanceof ConflictError) {
			if (e.server.deleted) {
				ctx.store.delete(path);
				return "skipped";
			}
			// 本地删除后服务器又有了新版本 → 数据安全优先：恢复服务器版本，不执行删除
			const dl = await downloadPlain(ctx, path);
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
			ctx.notify(`该文件在其他设备上已更新，已恢复: ${path}`);
			return "conflict";
		}
		throw e;
	}
}
