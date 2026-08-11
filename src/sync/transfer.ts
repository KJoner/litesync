/**
 * 传输层加解密封装（计划书 Phase 12；v9.2 LSE2；v9.3 LSE3）。
 *
 * 同步逻辑只面对明文；本模块负责：
 * - 下载：校验密文 hash → 解密（LSE1/LSE2/LSE3）→ 返回明文 + 双 hash + 身份信息
 * - 上传：E2EE 启用时加密（默认 LSE3：fileId-AAD + 单调 generation）
 * - HEAD 下载强制 generation 不回退（恶意服务器无法重放旧版本密文当最新）
 */
import { DownloadResult, UploadAction } from "../api/client";
import {
	decryptFile,
	decryptFileV3,
	encryptFile,
	encryptFileV3,
	FileKeyBinding,
	isEncryptedPayload,
	isLse3Envelope,
	newFileId,
} from "../crypto/crypto";
import { E2eeLockedError } from "../crypto/keyring";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { SyncContext } from "./context";

export interface PlainDownload {
	/** 解密后的明文内容 */
	plain: ArrayBuffer;
	plainHash: string;
	/** 服务器上的内容 hash（未加密时与 plainHash 相同） */
	cipherHash: string;
	revision: number;
	mtime: number;
	/** 稳定文件身份（0.11.0+，服务器提供；LSE3 解密的 AAD 输入） */
	fileId?: string;
	/** LSE3 信封中的 contentGeneration（AAD 认证后返回；非 LSE3 为 undefined） */
	generation?: number;
}

/**
 * LSE2/LSE3 信封的基础绑定材料（v9.2）：vaultId 来自 bootstrap，keyEpoch 来自
 * 服务器状态机（协议检查时同步）。任一缺失（如 v0.9 升级后的首轮）返回
 * undefined → 加密回退 LSE1，下一轮补齐后自动切 LSE3。
 */
export function e2eeBinding(ctx: SyncContext): FileKeyBinding | undefined {
	const b = ctx.store.state.bootstrap;
	if (b.remoteVaultId && (b.keyEpoch ?? 0) > 0) {
		return { vaultId: b.remoteVaultId, keyEpoch: b.keyEpoch! };
	}
	return undefined;
}

interface DecodeOptions {
	/**
	 * HEAD 下载必须强制 generation 不回退；历史版本下载（本来就是旧 generation）豁免。
	 */
	enforceGeneration: boolean;
}

async function decode(
	ctx: SyncContext,
	path: string,
	dl: DownloadResult,
	opts: DecodeOptions,
): Promise<PlainDownload> {
	const cipherHash = await sha256Hex(dl.data);
	if (dl.hash && cipherHash !== dl.hash) {
		throw new Error(`downloaded content hash mismatch for ${path}`);
	}

	// LSE3（v9.3）：AAD = vaultId + keyEpoch(信封头) + fileId(服务器提供) + generation(信封头)。
	// fileId 造假 → GCM 认证直接失败；generation 经 AAD 认证后做回退检查。
	if (isLse3Envelope(dl.data)) {
		if (!ctx.e2ee.unlocked) throw new E2eeLockedError();
		const bind = e2eeBinding(ctx);
		if (!bind?.vaultId || !dl.fileId) {
			throw new Error(`无法解密 ${path}（缺少 vaultId/fileId 绑定材料）`);
		}
		const dec = await decryptFileV3(ctx.e2ee.requireKey(), dl.data, bind.vaultId, dl.fileId, bind.keyEpoch);
		if (dec === null) throw new Error(`无法解密 ${path}（密钥不匹配、数据被篡改或密钥世代不符）`);
		if (opts.enforceGeneration) {
			const tracked = ctx.store.get(path);
			if (
				tracked?.fileId === dl.fileId &&
				tracked.generation !== undefined &&
				dec.generation < tracked.generation
			) {
				// 回退重放（v9.3 freshness）：服务器返回的 HEAD 比本设备已确认的更旧
				throw new Error(
					`检测到内容回退（${path}：服务器 generation ${dec.generation} < 本地已见 ${tracked.generation}），已停止同步——服务器可能被篡改或从备份恢复而未旋转 epoch`,
				);
			}
		}
		return {
			plain: dec.plain,
			plainHash: await sha256Hex(dec.plain),
			cipherHash,
			revision: dl.revision,
			mtime: dl.mtime,
			fileId: dl.fileId,
			generation: dec.generation,
		};
	}

	let plain = dl.data;
	if (isEncryptedPayload(dl.data)) {
		// 遇到密文但本设备未解锁 → 暂停同步，绝不把密文当明文写入 Vault
		if (!ctx.e2ee.unlocked) throw new E2eeLockedError();
		const dec = await decryptFile(ctx.e2ee.requireKey(), path, dl.data, e2eeBinding(ctx));
		if (dec === null) throw new Error(`无法解密 ${path}（密钥不匹配、数据被篡改或密钥世代不符）`);
		plain = dec;
	} else if (ctx.e2ee.enabled) {
		// 加密降级防护（v9）：E2EE 已启用时服务器绝不应返回明文——
		// 出现即说明有旧客户端明文写入或服务器内容被替换，必须硬失败停止同步，
		// 而不是把可疑明文写进 Vault（迁移完成后所有 HEAD 都已验证为密文）
		throw new Error(`E2EE 已启用但服务器返回了明文内容：${path}（可能存在未升级设备的明文写入，已停止同步）`);
	}
	return {
		plain,
		plainHash: await sha256Hex(plain),
		cipherHash,
		revision: dl.revision,
		mtime: dl.mtime,
		fileId: dl.fileId,
	};
}

/** 下载当前 HEAD 并解密（强制 generation 不回退）。 */
export async function downloadPlain(ctx: SyncContext, path: string): Promise<PlainDownload> {
	return decode(ctx, path, await ctx.client.download(path), { enforceGeneration: true });
}

/** 下载历史版本并解密（历史本来就是旧 generation，不做回退检查）。 */
export async function versionPlain(ctx: SyncContext, path: string, revision: number): Promise<PlainDownload> {
	return decode(ctx, path, await ctx.client.version(path, revision), { enforceGeneration: false });
}

/**
 * 本地 Compare-And-Swap 写入（v9 TOCTOU 修复）：目标文件自决策时刻起未变
 *（hash 一致，或决策时与当前都不存在）才写入远端内容；
 * 否则返回 false，调用方必须转入冲突处理，绝不覆盖用户刚写下的内容。
 */
export async function writeIfLocalUnchanged(
	ctx: SyncContext,
	path: string,
	data: ArrayBuffer,
	expectedLocalHash: string | null,
	mtime?: number,
): Promise<boolean> {
	const adapter = ctx.app.vault.adapter;
	const stat = await adapter.stat(path);
	const currentHash = stat ? await sha256Hex(await adapter.readBinary(path)) : null;
	if (currentHash !== expectedLocalHash) return false;
	await ensureParentFolder(adapter, path);
	await adapter.writeBinary(path, data, mtime !== undefined && mtime > 0 ? { mtime } : undefined);
	return true;
}

export interface UploadOutcome {
	revision: number;
	/** 实际上传到服务器的内容 hash（E2EE 下为密文 hash） */
	cipherHash: string;
	sequence: number;
	/** 稳定文件身份（服务器确认值；E2EE 新文件为客户端预生成） */
	fileId?: string;
	/** 本次写入的 contentGeneration（仅 LSE3；成功后必须记入 FileState） */
	generation?: number;
}

/** 上传明文内容（E2EE 启用时自动加密，默认 LSE3）。 */
export async function uploadFromPlain(
	ctx: SyncContext,
	path: string,
	plain: ArrayBuffer,
	baseRevision: number,
	mtime: number,
	action: UploadAction = "upsert",
): Promise<UploadOutcome> {
	let payload = plain;
	let sendFileId: string | undefined;
	let generation: number | undefined;

	if (ctx.e2ee.enabled) {
		const bind = e2eeBinding(ctx);
		if (bind) {
			const tracked = ctx.store.get(path);
			// 新文件：id 必须在加密前确定 → 客户端预生成，随上传头交给服务器
			const fileId = tracked?.fileId ?? newFileId();
			generation = (tracked?.fileId === fileId ? (tracked?.generation ?? 0) : 0) + 1;
			payload = await encryptFileV3(
				ctx.e2ee.requireKey(),
				{ vaultId: bind.vaultId, keyEpoch: bind.keyEpoch, fileId, generation },
				plain,
			);
			sendFileId = fileId;
		} else {
			// 绑定材料未就绪（升级过渡首轮）：回退 LSE1，下一轮自动切 LSE3
			payload = await encryptFile(ctx.e2ee.requireKey(), path, plain);
		}
	}
	const cipherHash = await sha256Hex(payload);
	const res = await ctx.client.upload(path, baseRevision, cipherHash, payload, mtime, action, sendFileId);
	return {
		revision: res.revision,
		cipherHash,
		sequence: res.sequence,
		fileId: res.fileId ?? sendFileId,
		generation,
	};
}
