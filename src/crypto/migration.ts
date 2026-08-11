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
import { ConflictError, NotFoundError } from "../api/client";
import { SyncContext } from "../sync/context";
import { e2eeBinding } from "../sync/transfer";
import { sha256Hex } from "../utils/hash";
import {
	createVaultKeyDoc,
	decryptFile,
	decryptFileV3,
	encryptFile,
	encryptFileV3,
	FileKeyBinding,
	isEncryptedPayload,
	isLegacyEnvelope,
	isLse3Envelope,
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

	const info = await ctx.client.info();
	const serverState = info.encryptionState ?? "plaintext";
	let done = 0;
	if (serverState !== "encrypted") {
		// 3. 服务器进入 migrating（v9 状态机）：从这一刻起服务器冻结一切明文写，
		// 其他旧设备无法在迁移期间把明文写回仓库（它们的上传会被 409 拒绝）
		const state = await ctx.client.e2eeTransition("begin");
		// LSE2 绑定材料（v9.2）：迁移产生的密文直接使用新信封
		ctx.store.state.bootstrap.keyEpoch = state.keyEpoch;
		if (!ctx.store.state.bootstrap.remoteVaultId && info.vaultId) {
			ctx.store.state.bootstrap.remoteVaultId = info.vaultId;
		}
		await ctx.store.save();
		const binding = e2eeBinding(ctx);

		// 4. 迁移清单 = 服务器一致性快照（v9）：以服务器为权威，
		// 本地 state 缓存里没有的远端文件同样会被加密，不会有漏网明文
		const snap = await ctx.client.snapshot();
		const paths = snap.files.map((f) => f.path).filter((p) => !ctx.ignores(p));

		// 5. 逐文件迁移：加密上传 → 下载回验 → 清理明文历史
		for (const path of paths) {
			onProgress({ total: paths.length, done, current: path });
			await migratePath(ctx, vmk, path, binding);
			done++;
			if (done % 10 === 0) await ctx.store.save();
		}
		await ctx.store.save();

		// 6. 服务器切换到 encrypted：服务端会再次验证所有 HEAD 均为 LSE1 密文，
		// 有任何明文残留都会拒绝——「标记已加密但仓库里还有明文」不可能发生
		await ctx.client.e2eeTransition("complete");
	}

	// 7. 标记 key 文档 enabled（CAS：携带当前指纹，绝不盲目覆盖并发写入的文档）
	const cur = await ctx.client.getVaultKeyWithFingerprint();
	if (!cur) throw new Error("vault key 文档丢失，请重新启用");
	if (!cur.doc.enabled) {
		const finalDoc: VaultKeyDoc = { ...cur.doc, enabled: true };
		await ctx.client.putVaultKey(finalDoc, true, cur.fingerprint);
		ctx.e2ee.adopt(finalDoc, vmk);
		ctx.store.state.e2ee = finalDoc;
	} else {
		ctx.e2ee.adopt(cur.doc, vmk);
		ctx.store.state.e2ee = cur.doc;
	}
	await ctx.store.save();
	ctx.log(`e2ee: migration complete, ${done} files encrypted`);
	return done;
}

async function migratePath(
	ctx: SyncContext,
	vmk: CryptoKey,
	path: string,
	binding: FileKeyBinding | undefined,
): Promise<void> {
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
		const dec = await decryptAny(vmk, path, raw.data, binding, raw.fileId);
		if (dec === null) throw new Error(`已加密但无法用当前密钥解密: ${path}`);
		ctx.store.set(path, {
			hash: await sha256Hex(dec.plain),
			serverHash,
			revision: raw.revision,
			mtime: tracked?.mtime ?? Date.now(),
			size: dec.plain.byteLength,
			fileId: raw.fileId,
			generation: dec.generation,
		});
		await ctx.client.purgeHistory(path, raw.revision);
		return;
	}

	// 加密（LSE3：fileId 来自服务器为明文时代分配的稳定身份，generation 从 1 开始）
	// binding 不可用时回退 LSE1（升级过渡；正常情况下 begin 之后一定可用）
	const plain = raw.data;
	const plainHash = await sha256Hex(plain);
	let payload: ArrayBuffer;
	let generation: number | undefined;
	if (binding && raw.fileId) {
		generation = 1;
		payload = await encryptFileV3(vmk, { ...binding, fileId: raw.fileId, generation }, plain);
	} else {
		payload = await encryptFile(vmk, path, plain, binding);
	}
	const cipherHash = await sha256Hex(payload);
	const res = await ctx.client.upload(path, raw.revision, cipherHash, payload, raw.mtime, "upsert");

	// 红线：只有密文完整验证（下载回 → 解密 → 明文 hash 一致）后才清理明文
	const check = await ctx.client.download(path);
	if ((await sha256Hex(check.data)) !== cipherHash) {
		throw new Error(`密文回读与上传不一致: ${path}`);
	}
	const dec = await decryptAny(vmk, path, check.data, binding, check.fileId ?? raw.fileId);
	if (dec === null || (await sha256Hex(dec.plain)) !== plainHash) {
		throw new Error(`密文解密验证失败: ${path}`);
	}

	ctx.store.set(path, {
		hash: plainHash,
		serverHash: cipherHash,
		revision: res.revision,
		mtime: tracked?.mtime ?? Date.now(),
		size: plain.byteLength,
		fileId: res.fileId ?? raw.fileId,
		generation,
	});
	await ctx.client.purgeHistory(path, res.revision);
}

/** 统一解密：LSE3（需 fileId）与 LSE1/LSE2 兼容。 */
async function decryptAny(
	vmk: CryptoKey,
	path: string,
	payload: ArrayBuffer,
	binding: FileKeyBinding | undefined,
	fileId: string | undefined,
): Promise<{ plain: ArrayBuffer; generation?: number } | null> {
	if (isLse3Envelope(payload)) {
		if (!binding?.vaultId || !fileId) return null;
		return decryptFileV3(vmk, payload, binding.vaultId, fileId, binding.keyEpoch);
	}
	const plain = await decryptFile(vmk, path, payload, binding);
	return plain === null ? null : { plain };
}

/**
 * 信封升级（v9.2 引入；v9.3 起目标格式为 LSE3）：把仓库中仍是 LSE1/LSE2 的
 * 密文重新加密为 LSE3（fileId-AAD + generation 抗回退重放，改名不再需重加密）。
 * 密文 → 密文的替换，无明文暴露窗口；单个文件失败（如并发修改 409）跳过，
 * 重新执行命令即可续传。历史版本保留（旧信封历史仍可解密，作 merge-base 用）。
 */
export async function upgradeEnvelopes(
	ctx: SyncContext,
	onProgress: (p: MigrationProgress) => void,
): Promise<{ upgraded: number; skipped: number; total: number }> {
	if (!ctx.e2ee.enabled) throw new Error("端到端加密未启用，无需升级信封");
	const vmk = ctx.e2ee.requireKey();
	const binding = e2eeBinding(ctx);
	if (!binding) throw new Error("缺少 vaultId/keyEpoch 绑定材料，请先完成一次正常同步后重试");

	const snap = await ctx.client.snapshot();
	const files = snap.files.filter((f) => !ctx.ignores(f.path));
	let upgraded = 0;
	let skipped = 0;
	let done = 0;
	for (const f of files) {
		onProgress({ total: files.length, done: done++, current: f.path });
		let raw;
		try {
			raw = await ctx.client.download(f.path);
		} catch (e) {
			if (e instanceof NotFoundError) continue;
			throw e;
		}
		if (!isLegacyEnvelope(raw.data)) continue; // 已是 LSE3（或明文仓库不应到这）
		const fileId = raw.fileId ?? f.fileId;
		if (!fileId) {
			skipped++;
			continue;
		}
		const plain = await decryptFile(vmk, f.path, raw.data, binding);
		if (plain === null) {
			skipped++;
			ctx.log(`envelope upgrade: cannot decrypt ${f.path}, skipped`);
			continue;
		}
		const tracked = ctx.store.get(f.path);
		const generation = (tracked?.fileId === fileId ? (tracked?.generation ?? 0) : 0) + 1;
		const payload = await encryptFileV3(vmk, { ...binding, fileId, generation }, plain);
		const cipherHash = await sha256Hex(payload);
		try {
			const res = await ctx.client.upload(f.path, raw.revision, cipherHash, payload, raw.mtime, "upsert");
			if (tracked) {
				ctx.store.set(f.path, {
					...tracked,
					serverHash: cipherHash,
					revision: res.revision,
					fileId,
					generation,
				});
			}
			upgraded++;
		} catch (e) {
			if (e instanceof ConflictError) {
				skipped++; // 并发修改：正常同步会以 LSE3 重新上传，无需处理
				continue;
			}
			throw e;
		}
	}
	await ctx.store.save();
	ctx.log(`envelope upgrade: ${upgraded} upgraded, ${skipped} skipped, ${files.length} total`);
	return { upgraded, skipped, total: files.length };
}
