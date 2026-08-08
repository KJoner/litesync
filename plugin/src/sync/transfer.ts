/**
 * 传输层加解密封装（计划书 Phase 12）。
 *
 * 同步逻辑只面对明文；本模块负责：
 * - 下载：校验密文 hash → 如为 LSE1 加密格式则解密 → 返回明文 + 双 hash
 * - 上传：E2EE 启用时加密 → 以密文 hash 上传（服务器只见 opaque bytes）
 */
import { DownloadResult, UploadAction } from "../api/client";
import { decryptFile, encryptFile, isEncryptedPayload } from "../crypto/crypto";
import { E2eeLockedError } from "../crypto/keyring";
import { sha256Hex } from "../utils/hash";
import { SyncContext } from "./context";

export interface PlainDownload {
	/** 解密后的明文内容 */
	plain: ArrayBuffer;
	plainHash: string;
	/** 服务器上的内容 hash（未加密时与 plainHash 相同） */
	cipherHash: string;
	revision: number;
	mtime: number;
}

async function decode(ctx: SyncContext, path: string, dl: DownloadResult): Promise<PlainDownload> {
	const cipherHash = await sha256Hex(dl.data);
	if (dl.hash && cipherHash !== dl.hash) {
		throw new Error(`downloaded content hash mismatch for ${path}`);
	}
	let plain = dl.data;
	if (isEncryptedPayload(dl.data)) {
		// 遇到密文但本设备未解锁 → 暂停同步，绝不把密文当明文写入 Vault
		if (!ctx.e2ee.unlocked) throw new E2eeLockedError();
		const dec = await decryptFile(ctx.e2ee.requireKey(), path, dl.data);
		if (dec === null) throw new Error(`无法解密 ${path}（密钥不匹配或数据被篡改）`);
		plain = dec;
	}
	return { plain, plainHash: await sha256Hex(plain), cipherHash, revision: dl.revision, mtime: dl.mtime };
}

/** 下载当前 HEAD 并解密。 */
export async function downloadPlain(ctx: SyncContext, path: string): Promise<PlainDownload> {
	return decode(ctx, path, await ctx.client.download(path));
}

/** 下载历史版本并解密。 */
export async function versionPlain(ctx: SyncContext, path: string, revision: number): Promise<PlainDownload> {
	return decode(ctx, path, await ctx.client.version(path, revision));
}

export interface UploadOutcome {
	revision: number;
	/** 实际上传到服务器的内容 hash（E2EE 下为密文 hash） */
	cipherHash: string;
	sequence: number;
}

/** 上传明文内容（E2EE 启用时自动加密）。 */
export async function uploadFromPlain(
	ctx: SyncContext,
	path: string,
	plain: ArrayBuffer,
	baseRevision: number,
	mtime: number,
	action: UploadAction = "upsert",
): Promise<UploadOutcome> {
	let payload = plain;
	if (ctx.e2ee.enabled) {
		payload = await encryptFile(ctx.e2ee.requireKey(), path, plain);
	}
	const cipherHash = await sha256Hex(payload);
	const res = await ctx.client.upload(path, baseRevision, cipherHash, payload, mtime, action);
	return { revision: res.revision, cipherHash, sequence: res.sequence };
}
