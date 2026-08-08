import { NotFoundError } from "../api/client";
import { threeWayMerge } from "../merge/three-way";
import { keepBothVersions } from "../sync/conflict";
import { SyncContext } from "../sync/context";
import { sha256Hex } from "../utils/hash";
import { decodeUtf8Strict, encodeUtf8 } from "../utils/text";
import { LoadedConflict } from "./conflict-state";

/**
 * 加载冲突现场：远端当前 HEAD + base 历史版本 + 本地文件，计算三方合并结构。
 * 每次打开（或 409 后重载）都重新获取远端，保证 Save 基于最新 revision。
 */
export async function loadConflict(ctx: SyncContext, path: string): Promise<LoadedConflict> {
	const pending = ctx.store.getConflict(path);
	if (!pending) throw new Error("该文件已不在冲突状态");

	let remote;
	try {
		remote = await ctx.client.download(path);
	} catch (e) {
		if (e instanceof NotFoundError) {
			// 远端文件已被删除：本地内容即最新，解除冲突并按新文件重新上传
			ctx.store.clearConflict(path);
			ctx.store.delete(path);
			ctx.queue.add(path, "upsert");
			await ctx.store.save();
			throw new Error("远端文件已被删除，本地内容将在下次同步时重新上传");
		}
		throw e;
	}
	const remoteHash = await sha256Hex(remote.data);
	if (remote.hash && remoteHash !== remote.hash) throw new Error("远端内容 hash 校验失败");
	const remoteText = decodeUtf8Strict(remote.data);
	if (remoteText === null) throw new Error("远端内容不是 UTF-8 文本");

	const adapter = ctx.app.vault.adapter;
	let localText = "";
	if (await adapter.stat(path)) {
		const t = decodeUtf8Strict(await adapter.readBinary(path));
		if (t === null) throw new Error("本地内容不是 UTF-8 文本");
		localText = t;
	}

	let baseText: string | null = null;
	try {
		const baseDl = await ctx.client.version(path, pending.baseRevision);
		baseText = decodeUtf8Strict(baseDl.data);
	} catch {
		baseText = null; // base 已被 GC → 两方对比模式
	}

	const merge = threeWayMerge({ base: baseText ?? "", local: localText, remote: remoteText });

	// 记录最新远端 revision（Race Protection 的锚点）
	pending.remoteRevision = remote.revision;
	ctx.store.setConflict(path, pending);

	return {
		path,
		pending,
		remoteRevision: remote.revision,
		localText,
		remoteText,
		baseText,
		merge,
	};
}

/**
 * 保存合并结果：以打开 Resolver 时的远端 revision 作为 baseRevision 上传（action=merge）。
 * 期间远端再次变化 → 服务器 409 → 抛 ConflictError，调用方必须重新加载再 merge，
 * 任何 Resolver 都不能绕开 revision 校验。
 */
export async function saveResolution(
	ctx: SyncContext,
	path: string,
	finalText: string,
	remoteRevision: number,
): Promise<number> {
	const data = encodeUtf8(finalText);
	const hash = await sha256Hex(data);
	const res = await ctx.client.upload(path, remoteRevision, hash, data, Date.now(), "merge");

	const adapter = ctx.app.vault.adapter;
	await adapter.writeBinary(path, data);
	const stat = await adapter.stat(path);
	ctx.store.set(path, {
		hash,
		revision: res.revision,
		mtime: stat?.mtime ?? Date.now(),
		size: data.byteLength,
	});
	ctx.store.clearConflict(path);
	await ctx.store.save();
	ctx.log(`resolver: merged ${path} → rev ${res.revision}`);
	return res.revision;
}

/** 放弃合并，退回“保留两个版本”兜底，随后解除冲突状态。 */
export async function keepBothForConflict(ctx: SyncContext, path: string): Promise<void> {
	const adapter = ctx.app.vault.adapter;
	if (await adapter.stat(path)) {
		const localData = await adapter.readBinary(path);
		ctx.store.clearConflict(path);
		await keepBothVersions(ctx, path, localData);
	} else {
		ctx.store.clearConflict(path);
	}
	await ctx.store.save();
}
