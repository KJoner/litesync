/**
 * E2EE 显式迁移（计划书 Phase 12 E2EE Migration）。
 *
 * Enable E2EE → 生成/解锁 Vault Master Key → 重新上传 encrypted current
 * versions → 验证 → 清理明文历史 → 服务器标记 enabled。
 *
 * 红线：
 * - 绝不先删明文再传密文；只有密文下载回验（解密 + hash 一致）后才 purge
 * - 任何失败都可以重新执行（断点续传：已加密的文件跳过重传）
 */
import { NotFoundError } from "../api/client";
import { SyncContext } from "../sync/context";
import { sha256Hex } from "../utils/hash";
import {
	createVaultKeyDoc,
	decryptFile,
	encryptFile,
	isEncryptedPayload,
	unlockVaultKey,
	VaultKeyDoc,
} from "./crypto";

export interface MigrationProgress {
	total: number;
	done: number;
	current: string;
}

export async function enableE2ee(
	ctx: SyncContext,
	password: string,
	fullSync: () => Promise<void>,
	onProgress: (p: MigrationProgress) => void,
): Promise<number> {
	if (password.length < 8) throw new Error("密码至少 8 个字符");

	// 1. 获取或创建 vault key（支持中断后重新执行）
	let doc = await ctx.client.getVaultKey();
	let vmk: CryptoKey;
	if (doc) {
		if (doc.enabled) throw new Error("端到端加密已经启用");
		const key = await unlockVaultKey(doc, password);
		if (!key) throw new Error("密码与服务器上已存在的密钥不匹配（此前的迁移可能被中断，请使用当时的密码）");
		vmk = key;
	} else {
		const created = await createVaultKeyDoc(password);
		doc = created.doc;
		vmk = created.vmk;
		await ctx.client.putVaultKey(doc, false);
	}
	ctx.e2ee.adopt(doc, vmk);
	ctx.store.state.e2ee = doc;
	await ctx.store.save();

	// 2. 迁移前必须同步干净（无待推送变更、无未解决冲突）
	await fullSync();
	if (ctx.queue.size > 0 || ctx.store.conflictPaths().length > 0) {
		throw new Error("存在未完成的同步或未解决的冲突，请处理后重新启用");
	}

	// 3. 逐文件迁移：加密上传 → 下载回验 → 清理明文历史
	const paths = ctx.store.paths().filter((p) => !ctx.ignores(p));
	let done = 0;
	for (const path of paths) {
		onProgress({ total: paths.length, done, current: path });
		await migratePath(ctx, vmk, path);
		done++;
		if (done % 10 === 0) await ctx.store.save();
	}
	await ctx.store.save();

	// 4. 全部验证完成 → 标记 enabled（同一密钥材料，只翻转标志位）
	const finalDoc: VaultKeyDoc = { ...doc, enabled: true };
	await ctx.client.putVaultKey(finalDoc, true);
	ctx.e2ee.adopt(finalDoc, vmk);
	ctx.store.state.e2ee = finalDoc;
	await ctx.store.save();
	ctx.log(`e2ee: migration complete, ${done} files encrypted`);
	return done;
}

async function migratePath(ctx: SyncContext, vmk: CryptoKey, path: string): Promise<void> {
	let raw;
	try {
		raw = await ctx.client.download(path);
	} catch (e) {
		if (e instanceof NotFoundError) {
			ctx.store.delete(path); // 同步后又被删除，跳过
			return;
		}
		throw e;
	}
	const serverHash = await sha256Hex(raw.data);
	if (raw.hash && serverHash !== raw.hash) {
		throw new Error(`服务器内容 hash 校验失败: ${path}`);
	}

	const tracked = ctx.store.get(path);

	// 断点续传：已是密文 → 验证可解密后清理明文历史即可
	if (isEncryptedPayload(raw.data)) {
		const dec = await decryptFile(vmk, path, raw.data);
		if (dec === null) throw new Error(`已加密但无法用当前密钥解密: ${path}`);
		ctx.store.set(path, {
			hash: await sha256Hex(dec),
			serverHash,
			revision: raw.revision,
			mtime: tracked?.mtime ?? Date.now(),
			size: dec.byteLength,
		});
		await ctx.client.purgeHistory(path, raw.revision);
		return;
	}

	// 加密并作为新 revision 上传
	const plain = raw.data;
	const plainHash = await sha256Hex(plain);
	const payload = await encryptFile(vmk, path, plain);
	const cipherHash = await sha256Hex(payload);
	const res = await ctx.client.upload(path, raw.revision, cipherHash, payload, raw.mtime, "upsert");

	// 红线：只有密文完整验证（下载回 → 解密 → 明文 hash 一致）后才清理明文
	const check = await ctx.client.download(path);
	if ((await sha256Hex(check.data)) !== cipherHash) {
		throw new Error(`密文回读与上传不一致: ${path}`);
	}
	const dec = await decryptFile(vmk, path, check.data);
	if (dec === null || (await sha256Hex(dec)) !== plainHash) {
		throw new Error(`密文解密验证失败: ${path}`);
	}

	ctx.store.set(path, {
		hash: plainHash,
		serverHash: cipherHash,
		revision: res.revision,
		mtime: tracked?.mtime ?? Date.now(),
		size: plain.byteLength,
	});
	await ctx.client.purgeHistory(path, res.revision);
}
