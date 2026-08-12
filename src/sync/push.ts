import { Platform } from "obsidian";
import { ApiError, ConflictError, NotFoundError } from "../api/client";
import { E2eeLockedError } from "../crypto/keyring";
import { sha256Hex } from "../utils/hash";
import { pathsCollide } from "../utils/vault-path";
import { attemptAutoMerge } from "./auto-merge";
import { keepBothVersions } from "./conflict";
import { SyncContext } from "./context";
import { canonicalPathHmac, decryptMeta, encryptMeta } from "../crypto/crypto";
import { FileState } from "../state/store";
import {
	downloadPlain,
	e2eeBinding,
	metaEncrypted,
	removeRemote,
	serverPathOf,
	metaFingerprintOf,
	uploadFromPlain,
	versionPlain,
	writeIfLocalUnchanged,
} from "./transfer";

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
	// 排队中 move 的旧路径集合（v9.3）：这些路径的「tracked 但文件不在」
	// 由 move 操作处理，扫描不得抢先补 delete（否则退化并丢失原子性）
	const moveFroms = new Set<string>();
	for (const [, op] of ctx.queue.entries()) {
		if (op.action === "move" && op.from) moveFroms.add(op.from);
	}

	// 待手动删除的文件（移动端回收站失败时保留的，v6）：用户已手动删除则清除记录
	for (const path of Object.keys(ctx.store.state.pendingDeletes)) {
		if (!(await ctx.app.vault.adapter.stat(path))) ctx.store.clearPendingDelete(path);
	}

	for (const file of ctx.app.vault.getFiles()) {
		const path = file.path;
		if (ctx.ignores(path) || ctx.store.hasPendingDelete(path)) continue;
		seen.add(path);
		// 已排队的 move（key = 新路径）不被扫描的 upsert 覆盖
		if (ctx.queue.getOp(path)?.action === "move") continue;
		const tracked = ctx.store.get(path);
		if (!tracked || tracked.mtime !== file.stat.mtime || tracked.size !== file.stat.size) {
			ctx.queue.stage(path, { action: "upsert" });
		}
	}

	// vault.getFiles() 不包含配置目录下的隐藏文件，需要单独遍历（目录名以 Vault#configDir 为准）
	if (ctx.syncObsidian()) {
		for (const path of await listHiddenFiles(ctx, ctx.app.vault.configDir)) {
			if (ctx.ignores(path) || ctx.store.hasPendingDelete(path)) continue;
			seen.add(path);
			if (ctx.queue.getOp(path)?.action === "move") continue;
			const stat = await ctx.app.vault.adapter.stat(path);
			if (!stat) continue;
			const tracked = ctx.store.get(path);
			if (!tracked || tracked.mtime !== stat.mtime || tracked.size !== stat.size) {
				ctx.queue.stage(path, { action: "upsert" });
			}
		}
	}

	for (const path of ctx.store.paths()) {
		if (ctx.ignores(path) || seen.has(path) || moveFroms.has(path)) continue;
		ctx.queue.stage(path, { action: "delete" });
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
		for (const [path, op, gen] of ctx.queue.entries()) {
			if (ctx.ignores(path)) {
				ctx.queue.remove(path);
				continue;
			}
			let outcome: Outcome;
			switch (op.action) {
				case "upsert":
					outcome = await pushUpsert(ctx, path);
					break;
				case "delete":
					outcome = await pushDelete(ctx, path);
					break;
				case "move":
					outcome = await pushMove(ctx, path, op.from ?? "");
					break;
			}
			if (outcome === "pushed") result.pushed++;
			if (outcome === "conflict") result.conflicts++;
			// lost wake-up 修复（v9）：只有 generation 未变才移除——
			// 上传期间用户又保存了同一文件时，新入队的条目必须留在队列里
			ctx.queue.remove(path, gen);
		}
	} finally {
		await ctx.store.save();
	}
	return result;
}

/**
 * 改名推送（协议 v6 / ADR-001 §3.4）。
 *
 * v5 的 MOVE 是「旧路径 tombstone + 新路径新行」，历史断成两截、身份被换掉、
 * 还留下一条假删除。v6 里身份不依赖 path，改名退化为**一次元数据更新**：
 * revision、contentGeneration、blob 全部不动，**不产生任何 tombstone**。
 *
 * 因此这里也不再需要「E2EE 下必须是 LSE3 才敢 MOVE」那类前提——服务器根本不碰密文。
 * 仍然保留 delete+upsert 回退：改名后内容又被编辑、或服务器拒绝时，宁可退化也不丢内容。
 */
async function pushMove(ctx: SyncContext, toPath: string, fromPath: string): Promise<Outcome> {
	const adapter = ctx.app.vault.adapter;
	const tracked = fromPath ? ctx.store.get(fromPath) : undefined;
	const stat = await adapter.stat(toPath);

	/**
	 * 退化路径（v0.13.2 / §6.10）：**先建后删**，且绝不主动删除远端活对象。
	 *
	 * v0.12.x 这里是「先 delete 旧远端对象，再创建新对象」——一旦第二步失败
	 *（断网、409、体积超限……），服务器上就只剩一个 tombstone，那份内容从
	 * 其他设备的角度看等于被删除了。现在顺序反过来：新路径先推上去（内容有了
	 * 落点），旧路径**不在这里删**，交给正常扫描发出的、完整的 delete 操作。
	 */
	const degrade = async (): Promise<Outcome> => {
		let outcome: Outcome = "skipped";
		if (stat) {
			const u = await pushUpsert(ctx, toPath);
			if (u === "pushed") outcome = "pushed";
			if (u === "conflict") outcome = "conflict";
			// 新内容必须**确实存在于服务器上**才允许继续。
			// 不能只看 outcome：pushUpsert 在「文件超过服务器上限」等情况下返回
			// skipped，那时新内容一个字节都没上去——此时再删旧对象，这份内容
			// 就从所有设备上消失了。以「新路径已被跟踪且有 revision」为判据。
			const landed = (ctx.store.get(toPath)?.revision ?? 0) > 0;
			if (!landed) {
				ctx.log(`move degrade: ${toPath} 未能落到服务器，保留旧对象不删`);
				return outcome;
			}
		}
		if (tracked && !(await adapter.stat(fromPath))) {
			// 旧路径的文件确实已经不在本地了，且新内容已在服务器上
			// → 这才是一次真实、完整、可以安全执行的删除
			const d = await pushDelete(ctx, fromPath);
			if (d === "conflict") outcome = "conflict";
		}
		return outcome;
	};

	// 前提：旧路径已同步、新路径存在、无冲突冻结
	if (!tracked || !stat || ctx.store.getConflict(fromPath) || ctx.store.getConflict(toPath)) {
		return degrade();
	}

	const data = await adapter.readBinary(toPath);
	const hash = await sha256Hex(data);
	// §6.9 rename + edit：改名与编辑同时发生时，**先改名再传内容**。
	// 反过来（先按新路径当新文件上传、再补改名）会造出第二个对象，
	// 也会让「内容写在旧路径上但已记下新 metaGeneration」这种半截状态出现。
	const contentChanged = hash !== tracked.hash;

	const meta = await renameMetadata(ctx, tracked, toPath);
	if (meta === "unavailable") return degrade();

	// meta 模式下服务器可见的寻址名不变（伪名），只更新加密元数据；
	// 明文模式下寻址名就是真实路径
	const serverFrom = metaEncrypted(ctx) ? serverPathOf(ctx, fromPath) : fromPath;
	const serverTo = metaEncrypted(ctx) ? serverFrom : toPath;

	try {
		const out = await ctx.client.rename(serverFrom, serverTo, tracked.metaGeneration ?? 0, meta);
		ctx.store.applyMetaRenameState(fromPath, toPath, {
			mtime: stat.mtime,
			size: stat.size,
			revision: out.revision,
			metaGeneration: out.metaGeneration,
			fileId: out.fileId,
			serverPseudonym: metaEncrypted(ctx) ? out.toPath : undefined,
		});
		ctx.log(`push: renamed ${fromPath} -> ${toPath} (metaGen ${out.metaGeneration})`);
		if (!contentChanged) return "pushed";
		// 改名已落地，现在把新内容推到**同一个对象**上（身份、历史都不断）
		const u = await pushUpsert(ctx, toPath);
		return u === "conflict" ? "conflict" : "pushed";
	} catch (e) {
		if (e instanceof ConflictError || e instanceof NotFoundError) {
			return reconcileFailedRename(ctx, fromPath, toPath, degrade);
		}
		if (e instanceof ApiError && (e.status === 400 || e.status === 404 || e.status === 412 || e.status === 422)) {
			// 并发改名 CAS / 同名占用 / 非法目标
			return reconcileFailedRename(ctx, fromPath, toPath, degrade);
		}
		throw e;
	}
}

/**
 * 改名失败后的收敛（v0.13.2 / 计划书 §6.10）。
 *
 * 失败**不等于**「本地赢，把远端推平」。先去看服务器现在到底是什么状态：
 *
 *  1. 远端已经改成了我们想要的名字（另一台设备抢先做了同样的改名，或者我们的
 *     请求其实成功了只是响应丢了）→ 直接采纳，不再重试；
 *  2. 远端 metaGeneration 前进了但改成了别的名字 → 那是另一台设备的改名，
 *     交给 pull 处理，本地这次操作作罢（绝不覆盖）；
 *  3. 拿不到服务器状态 → 走 create-then-delete 的退化路径。
 *
 * 无论哪一条，都不会主动删除远端那个仍然活着的对象。
 */
async function reconcileFailedRename(
	ctx: SyncContext,
	fromPath: string,
	toPath: string,
	degrade: () => Promise<Outcome>,
): Promise<Outcome> {
	const tracked = ctx.store.get(fromPath);
	if (!tracked || !metaEncrypted(ctx) || !tracked.serverPseudonym) return degrade();

	let remotePath: string;
	let remoteMetaGeneration: number;
	let fingerprint: string;
	try {
		const meta = await ctx.client.getFileMeta(tracked.serverPseudonym);
		const bind = e2eeBinding(ctx);
		const keys = await ctx.e2ee.metaKeys();
		const dec = await decryptMeta(keys, meta.metaEnc, bind?.vaultId ?? "", tracked.serverPseudonym);
		if (dec === null) throw new Error("元数据无法解密");
		remotePath = dec.meta.path;
		remoteMetaGeneration = dec.metaGeneration;
		fingerprint = await metaFingerprintOf(meta.metaEnc);
	} catch (e) {
		if (e instanceof E2eeLockedError) throw e;
		ctx.log(`rename reconcile: 无法读取服务器状态（${String(e)}）→ 退化为先建后删`);
		return degrade();
	}

	if (remotePath === toPath) {
		// 情况 1：远端已是目标名字。本地状态对齐即可，源文件与远端对象都完好
		ctx.store.applyMetaRenameState(fromPath, toPath, {
			metaGeneration: remoteMetaGeneration,
			metaFingerprint: fingerprint,
		});
		ctx.log(`rename reconcile: 远端已改名为 ${toPath}，已采纳`);
		return "skipped";
	}

	if (remoteMetaGeneration > (tracked.metaGeneration ?? 0)) {
		// 情况 2：另一台设备把它改成了别的名字。两个改名都是用户的真实意图，
		// 由 pull 把远端那次改名应用下来，本地这次让位——绝不删除任何一边
		ctx.store.applyRemoteIdentity(fromPath, {
			metaGeneration: remoteMetaGeneration,
			metaFingerprint: fingerprint,
		});
		ctx.notify(`另一台设备已把该文件改名为 ${remotePath}，本次改名未生效；下一轮同步会对齐`);
		return "conflict";
	}

	return degrade();
}

/**
 * 改名要携带的加密元数据。
 * meta 模式必须带（真实路径在密文里）；明文模式一律不带——
 * 服务端在 plain 状态会拒绝任何 metaEnc（状态守卫，LS-121-S03）。
 * 返回 "unavailable" 表示缺少必要材料，调用方退化为 delete+upsert。
 */
async function renameMetadata(
	ctx: SyncContext,
	tracked: FileState,
	toPath: string,
): Promise<{ metaEnc: string; canonicalHash: string } | undefined | "unavailable"> {
	if (!metaEncrypted(ctx)) return undefined;
	const bind = e2eeBinding(ctx);
	if (!bind || !tracked.fileId || tracked.metaGeneration === undefined) return "unavailable";
	const keys = await ctx.e2ee.metaKeys();
	const newGen = tracked.metaGeneration + 1;
	return {
		metaEnc: await encryptMeta(
			keys,
			{ vaultId: bind.vaultId, keyEpoch: bind.keyEpoch, fileId: tracked.fileId, metaGeneration: newGen },
			{ path: toPath },
		),
		canonicalHash: await canonicalPathHmac(keys, toPath),
	};
}

/**
 * 显式恢复一个已删除对象（协议 v6 / ADR-002 §3.6）。
 *
 * 服务器在 tombstone 冲突里告诉我们对象身份、墓碑 revision 与删除时的内容世代；
 * 恢复请求必须原样带回前两者（防复活锚点），并提交严格更新的内容世代（抗回退）。
 * 服务器没给 fileId（旧版本）时返回 null，调用方放弃而不是盲目重建。
 */
async function restoreObject(
	ctx: SyncContext,
	path: string,
	server: { revision: number; fileId?: string; contentGeneration?: number },
): Promise<{ fileId: string; revision: number } | null> {
	if (!server.fileId) return null;
	const tracked = ctx.store.get(path);
	const nextGen = Math.max(server.contentGeneration ?? 0, tracked?.generation ?? 0) + 1;

	let meta: { metaEnc: string; canonicalHash: string } | undefined;
	let pseudonym = path;
	if (metaEncrypted(ctx)) {
		const bind = e2eeBinding(ctx);
		if (!bind) return null;
		const keys = await ctx.e2ee.metaKeys();
		pseudonym = server.fileId;
		meta = {
			metaEnc: await encryptMeta(
				keys,
				{ vaultId: bind.vaultId, keyEpoch: bind.keyEpoch, fileId: server.fileId, metaGeneration: 1 },
				{ path },
			),
			canonicalHash: await canonicalPathHmac(keys, path),
		};
	}
	const out = await ctx.client.restore(server.fileId, {
		expectedTombstoneRevision: server.revision,
		contentGeneration: nextGen,
		pseudonym,
		metaEnc: meta?.metaEnc,
		canonicalHash: meta?.canonicalHash,
	});
	ctx.store.update(path, {
		fileId: out.fileId,
		revision: out.revision,
		serverPseudonym: metaEncrypted(ctx) ? out.path : undefined,
	});
	return { fileId: out.fileId, revision: out.revision };
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
		ctx.store.update(path, { mtime: stat.mtime, size: stat.size });
		return "skipped";
	}

	const baseRevision = tracked?.revision ?? 0;
	try {
		const out = await uploadFromPlain(ctx, path, data, baseRevision, stat.mtime);
		ctx.store.update(path, {
			hash,
			serverHash: out.cipherHash,
			revision: out.revision,
			mtime: stat.mtime,
			size: stat.size,
			fileId: out.fileId,
			generation: out.generation,
			metaGeneration: out.metaGeneration,
			serverPseudonym: out.serverPseudonym,
		});
		ctx.log(`push: uploaded ${path} (rev ${out.revision})`);
		return "pushed";
	} catch (e) {
		if (e instanceof ConflictError) {
			const server = e.server;
			if (server.deleted) {
				// tombstone 复活防护（v9）：曾同步过（tracked 存在）是 edit-vs-delete，
				// 数据安全优先保留本地；从未跟踪（base 0）则必须先排除「陈旧副本回传」
				if (!tracked) {
					const stale = await isStaleResurrection(ctx, path, hash, server);
					if (stale) {
						ctx.store.setPendingDelete(path);
						ctx.notify(
							`检测到已删除文件的陈旧副本，不会重新上传：${path}\n` +
								`（该内容在其他设备上已被删除；如确需恢复请修改后再保存，或手动删除本地文件）`,
						);
						return "skipped";
					}
				}
				// v6：重建必须走**显式恢复**（ADR-002 §3.6）。
				// 普通上传再也无法穿透墓碑——服务器分不清「用户真想恢复」与
				// 「陈旧设备把三个月前的副本传了回来」，所以要求客户端明说。
				// 恢复后 revision 连续、fileId 不变、删除前的历史全部仍可达。
				const restored = await restoreObject(ctx, path, server);
				if (restored === null) {
					ctx.notify(`无法恢复已删除的文件（服务器未提供对象身份）：${path}`);
					return "skipped";
				}
				const out = await uploadFromPlain(ctx, path, data, restored.revision, stat.mtime);
				ctx.store.update(path, {
					hash,
					serverHash: out.cipherHash,
					revision: out.revision,
					mtime: stat.mtime,
					size: stat.size,
					fileId: out.fileId ?? restored.fileId,
					generation: out.generation,
					metaGeneration: out.metaGeneration,
					serverPseudonym: out.serverPseudonym,
				});
				ctx.log(`push: restored + uploaded ${path} (rev ${out.revision})`);
				return "pushed";
			}
			if (!ctx.e2ee.enabled && server.hash === hash) {
				// 明文模式：服务器已有相同内容（重试或他端相同修改）→ 采纳服务器 revision
				ctx.store.update(path, {
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
					ctx.store.update(path, {
						hash,
						serverHash: dl.cipherHash,
						revision: dl.revision,
						mtime: stat.mtime,
						size: stat.size,
						fileId: dl.fileId,
						generation: dl.generation,
						metaGeneration: dl.metaGeneration,
					});
					return "skipped";
				}
			} catch (dlErr) {
				if (dlErr instanceof E2eeLockedError) throw dlErr;
				// 下载失败（含 meta 模式伪名未知的 fail-closed）不阻塞冲突处理，
				// 继续走合并/兜底；真实路径绝不会因此被发给服务器（LS-121-C05）
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
		if (e instanceof ApiError && e.is("CANONICAL_COLLISION")) {
			return resolveCanonicalCollision(ctx, path, data, hash, e);
		}
		throw e;
	}
}

/**
 * 422 canonical collision 收敛（v0.13.2 / 计划书 §6.5）。
 *
 * 触发场景只有两类，处理方式完全不同，绝不能一概而论：
 *
 *  A. **两台设备离线创建了同一个路径**——服务器上已经有一个别的 fileId 占着这个
 *     归一化名字。此时如果两边内容相同，直接采纳既有对象的身份即可（这也是
 *     「上传成功但响应丢失、且身份没能持久化」的收敛路径）；内容不同则保留双方。
 *
 *  B. **跨平台重名**——本地这个名字与服务器上另一个不同的真实路径在归一化后
 *     相同（大小写、NFC/NFD、尾随点）。两个都是有效文件，谁也不该被丢掉。
 *
 * 无论走哪条分支，这次操作都必须**有结论**：计划书明确要求「不得让该操作永久
 * 阻塞后续队列」。因此这里不会把同一个必然再次 422 的请求原样重排。
 */
async function resolveCanonicalCollision(
	ctx: SyncContext,
	path: string,
	data: ArrayBuffer,
	localHash: string,
	err: ApiError,
): Promise<Outcome> {
	const existing = err.existing;
	if (!existing) {
		// 旧服务器没告诉我们是谁占着这个名字 → 无法判断，保留双方（本地内容不丢）
		ctx.notify(`服务器上已存在同名文件，本地版本已另存: ${path}`);
		const kept = await keepBothVersions(ctx, path, data);
		return kept === null ? "skipped" : "conflict";
	}

	// 第 4 步：取冲突对象的元数据，解出它的真实路径
	let existingPath = existing;
	if (metaEncrypted(ctx)) {
		try {
			const meta = await ctx.client.getFileMeta(existing);
			const bind = e2eeBinding(ctx);
			const keys = await ctx.e2ee.metaKeys();
			const dec = await decryptMeta(keys, meta.metaEnc, bind?.vaultId ?? "", existing);
			if (dec === null) throw new Error("元数据无法解密");
			existingPath = dec.meta.path;
		} catch (metaErr) {
			if (metaErr instanceof E2eeLockedError) throw metaErr;
			ctx.log(`collision: 无法解析既有对象的真实路径（${existing}）：${String(metaErr)}`);
			const kept = await keepBothVersions(ctx, path, data);
			return kept === null ? "skipped" : "conflict";
		}
	}

	// 第 5 步：分类
	if (existingPath === path) {
		// A：同一个逻辑路径。先看内容是否已经一致（等价于「我其实已经传上去了」）
		let remote;
		try {
			remote = await downloadPlain(ctx, path, existing);
		} catch (dlErr) {
			if (dlErr instanceof E2eeLockedError) throw dlErr;
			remote = null;
		}
		if (remote !== null && remote.plainHash === localHash) {
			// 采纳既有对象的身份：此后重试都会走「已跟踪」分支，422 不再出现
			ctx.store.applyRemoteIdentity(path, {
				fileId: remote.fileId,
				generation: remote.generation,
				metaGeneration: remote.metaGeneration,
				serverPseudonym: metaEncrypted(ctx) ? existing : undefined,
			});
			ctx.store.patchContentState(path, {
				hash: localHash,
				serverHash: remote.cipherHash,
				revision: remote.revision,
			});
			ctx.log(`collision: adopted existing object for ${path} (rev ${remote.revision})`);
			return "skipped";
		}
		// 内容不同：两台设备各自新建了同名文件 → 保留双方（本地进冲突副本，
		// 远端版本写回原路径），随后按普通冲突流程收敛
		const kept = await keepBothVersions(ctx, path, data);
		ctx.notify(`另一台设备已创建同名文件: ${path}\n本地版本已另存为副本`);
		return kept === null ? "skipped" : "conflict";
	}

	// B：跨平台重名。两个不同的真实路径在本平台上会指向同一个文件——
	// 本地这个必须换个名字，否则它永远传不上去，而且下载回来还会互相覆盖
	const renamed = await renameLocalAsideForCollision(ctx, path, existingPath);
	ctx.notify(
		`文件名 ${path} 与已同步的 ${existingPath} 在部分系统上会被视为同一个文件；\n` +
			(renamed === null ? "请手动改名后再同步" : `本地已改名为 ${renamed} 以便两份都能保留`),
	);
	return "conflict";
}

/**
 * 把与远端重名的本地文件改成一个不碰撞的名字（§6.5 第 6 步的 keep-both 形态）。
 * 返回新路径；找不到可用名字时返回 null（此时保持原样，交给用户处理）。
 */
async function renameLocalAsideForCollision(
	ctx: SyncContext,
	path: string,
	existingPath: string,
): Promise<string | null> {
	const adapter = ctx.app.vault.adapter;
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	const hasExt = dot > slash + 1;
	const stem = hasExt ? path.slice(0, dot) : path;
	const ext = hasExt ? path.slice(dot) : "";
	for (let i = 1; i <= 20; i++) {
		const candidate = `${stem} (${ctx.deviceName()}${i === 1 ? "" : ` ${i}`})${ext}`;
		if (await adapter.stat(candidate)) continue;
		if (pathsCollide(candidate, existingPath)) continue;
		try {
			await adapter.rename(path, candidate);
		} catch {
			return null;
		}
		// 身份整体搬到新路径：这仍然是同一份本地内容，只是换了个不碰撞的名字
		ctx.store.applyMetaRenameState(path, candidate, {});
		ctx.queue.stage(candidate, { action: "upsert" });
		return candidate;
	}
	return null;
}

/**
 * 判断「base 0 上传撞上 tombstone」是否为陈旧副本复活（P0-5）。
 * - 明文模式：服务器 409 携带删除前内容 hash（priorHash），直接比对；
 * - E2EE：密文 hash 不可比 → 下载删除前的历史版本解密后按明文比对；
 * - 历史已被裁剪无从判断时按「同名新内容」放行（宁可多同步，不静默丢内容）。
 */
export async function isStaleResurrection(
	ctx: SyncContext,
	path: string,
	plainHash: string,
	server: { revision: number; priorHash?: string },
): Promise<boolean> {
	if (!ctx.e2ee.enabled) return server.priorHash !== undefined && server.priorHash === plainHash;
	try {
		// tombstone revision = N，删除前最后一个内容版本 = N-1
		const prior = await versionPlain(ctx, path, server.revision - 1);
		return prior.plainHash === plainHash;
	} catch (e) {
		if (e instanceof E2eeLockedError) throw e;
		return false; // 历史不可用：无法证明是陈旧副本 → 按新内容处理
	}
}

async function pushDelete(ctx: SyncContext, path: string): Promise<Outcome> {
	if (ctx.store.getConflict(path)) return "skipped"; // 冲突处理中不做自动删除
	const tracked = ctx.store.get(path);
	if (!tracked) return "skipped"; // 从未同步过，服务器上不存在

	const adapter = ctx.app.vault.adapter;
	if (await adapter.stat(path)) return "skipped"; // 文件又回来了（如撤销删除），交给 upsert 流程

	try {
		await removeRemote(ctx, path, tracked.revision);
		ctx.store.markDeleted(path);
		ctx.log(`push: deleted ${path}`);
		return "pushed";
	} catch (e) {
		if (e instanceof NotFoundError) {
			ctx.store.markDeleted(path);
			return "skipped";
		}
		if (e instanceof ConflictError) {
			if (e.server.deleted) {
				ctx.store.markDeleted(path);
				return "skipped";
			}
			// 本地删除后服务器又有了新版本 → 数据安全优先：恢复服务器版本，不执行删除
			const dl = await downloadPlain(ctx, path);
			// §6.1：本地文件此刻应当不存在（正是因为它被删掉才走到这里）。
			// 若用户在这期间又建了同名文件，绝不覆盖——留给下一轮按冲突处理
			if (!(await writeIfLocalUnchanged(ctx, path, dl.plain, null, dl.mtime))) {
				ctx.notify(`该文件在其他设备上已更新，但本地又出现了同名文件，已暂缓恢复: ${path}`);
				return "conflict";
			}
			const st = await adapter.stat(path);
			ctx.store.update(path, {
				hash: dl.plainHash,
				serverHash: dl.cipherHash,
				revision: dl.revision,
				mtime: st?.mtime ?? Date.now(),
				size: dl.plain.byteLength,
				fileId: dl.fileId,
				generation: dl.generation,
				metaGeneration: dl.metaGeneration,
			});
			ctx.notify(`该文件在其他设备上已更新，已恢复: ${path}`);
			return "conflict";
		}
		throw e;
	}
}
