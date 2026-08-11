import { NotFoundError } from "../api/client";
import { conflictPathFor } from "../utils/conflict-name";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { SyncContext } from "./context";
import { downloadPlain } from "./transfer";

/**
 * 冲突处理核心：保留两个版本，绝不丢弃任何一份内容。
 * - 本地版本另存为 conflict 副本（随后作为新文件推送到服务器）
 * - 服务器版本写回原路径（v9：写回前做本地 CAS，期间的新编辑绝不被覆盖）
 *
 * 返回 conflict 副本路径；服务器文件已不存在时返回 null（本地文件原样保留）。
 */
export async function keepBothVersions(
	ctx: SyncContext,
	path: string,
	localData: ArrayBuffer,
): Promise<string | null> {
	const adapter = ctx.app.vault.adapter;

	// 唯一副本名：随机后缀 + 存在性循环，绝不覆盖已有冲突副本
	let conflictPath = conflictPathFor(path, ctx.deviceName(), new Date());
	for (let i = 0; i < 5 && (await adapter.stat(conflictPath)); i++) {
		conflictPath = conflictPathFor(path, ctx.deviceName(), new Date());
	}

	await ensureParentFolder(adapter, conflictPath);
	await adapter.writeBinary(conflictPath, localData);

	let dl;
	try {
		dl = await downloadPlain(ctx, path);
	} catch (e) {
		if (e instanceof NotFoundError) {
			// 服务器版本已不存在：本地文件仍在原路径，撤销刚创建的副本
			await adapter.remove(conflictPath);
			return null;
		}
		// 下载失败：保留副本没有害处，但不修改原文件
		throw e;
	}

	// 本地 CAS（v9）：下载期间用户又编辑了原文件 → 不写回远端版本，
	// 保留用户当前内容（旧内容已在冲突副本中）；tracked 不更新，
	// 后续扫描会把当前内容按普通冲突流程继续处理
	const localHash = await sha256Hex(localData);
	const stat0 = await adapter.stat(path);
	const currentHash = stat0 ? await sha256Hex(await adapter.readBinary(path)) : null;
	if (currentHash === localHash) {
		await adapter.writeBinary(path, dl.plain, dl.mtime > 0 ? { mtime: dl.mtime } : undefined);
		const stat = await adapter.stat(path);
		ctx.store.set(path, {
			hash: dl.plainHash,
			serverHash: dl.cipherHash,
			revision: dl.revision,
			mtime: stat?.mtime ?? Date.now(),
			size: dl.plain.byteLength,
			fileId: dl.fileId,
			generation: dl.generation,
		});
	} else {
		ctx.log(`keepBoth: local changed during download of ${path}, keeping current content`);
	}

	// 冲突副本作为新文件推送到服务器，让其他设备也能看到
	ctx.queue.add(conflictPath, "upsert");
	ctx.notify(`同步冲突: ${path}\n本地版本已保存为 ${conflictPath}`);
	return conflictPath;
}
