/**
 * 传输层加解密封装。
 *
 * 同步逻辑只面对明文；本模块负责：
 * - 下载：校验密文 hash → 解密（LSE1/LSE2 只读兼容，LSE3 为当前格式）→
 *   返回明文 + 双 hash + 身份信息
 * - 上传：E2EE 启用时一律写 LSE3（fileId-AAD + 单调 generation）；
 *   绑定材料缺失时**硬失败**，绝不回退到更弱的信封（协议 v6 / ADR-006 §2.4）
 * - HEAD 下载强制 generation 不回退（恶意服务器无法重放旧版本密文当最新）
 * - meta 模式下真实路径绝不进入任何请求（伪名翻译，LS-121-C05）
 */
import { DownloadResult, UploadAction } from "../api/client";
import {
	canonicalPathHmac,
	decryptFile,
	decryptFileV3,
	encryptFile,
	encryptFileV3,
	encryptMeta,
	FileKeyBinding,
	isEncryptedPayload,
	isLse3Envelope,
	newFileId,
} from "../crypto/crypto";
import { E2eeLockedError } from "../crypto/keyring";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { optionalFileId, optionalGeneration, requireFileId, requireKeyEpoch } from "../utils/validate";
import { SyncContext } from "./context";

/** 元数据加密模式（v9.3 三期）：服务器只见伪名（=fileId），真实路径在 LSM1 里。 */
export function metaEncrypted(ctx: SyncContext): boolean {
	return ctx.store.state.bootstrap.metaState === "encrypted";
}

/**
 * 缺少 LSE3 信封的绑定材料（vaultId + keyEpoch）。
 *
 * v0.12.x 在这种情况下会回退 LSE1——那是自己给自己制造信封降级。
 * 协议 v6 起一律硬失败：先完成一次 /info 对账拿到绑定材料，再重试（ADR-006 §2.4）。
 */
export class EnvelopeBindingMissingError extends Error {
	constructor(public realPath: string) {
		super("缺少 vaultId/keyEpoch 绑定材料，已阻止本次上传（绝不回退到更弱的加密信封）；下一轮同步会自动补齐后重试");
		this.name = "EnvelopeBindingMissingError";
	}
}

/**
 * 无法把真实路径解析为服务器伪名（v0.12.1 / LS-121-C05）。
 *
 * meta-encrypted 仓库里真实路径**绝不允许**出现在 URL、query、Header 或
 * 服务端访问日志中。以前这里会「回退真实路径」，等于在一次网络请求里
 * 把加密掉的目录结构直接泄露给服务器；现在一律硬失败，由调用方转成
 * blocked / keep-both 等不破坏数据的处理。
 */
export class MetaPathUnresolvedError extends Error {
	constructor(public realPath: string) {
		super(
			"元数据加密仓库中该文件还没有已知的服务器伪名，已阻止本次请求" +
				"（绝不把真实路径发给服务器）；下一轮同步会先对账再重试",
		);
		this.name = "MetaPathUnresolvedError";
	}
}

/**
 * 真实路径 → 服务器可见路径（伪名翻译）。
 * meta 模式下必须使用已记录的伪名（= fileId）；未知则硬失败，绝不回退真实路径。
 */
export function serverPathOf(ctx: SyncContext, realPath: string): string {
	if (!metaEncrypted(ctx)) return realPath;
	const tracked = ctx.store.get(realPath);
	const pseudonym = tracked?.serverPseudonym ?? tracked?.fileId;
	if (pseudonym === undefined) throw new MetaPathUnresolvedError(realPath);
	return pseudonym;
}

/** 历史版本列表（meta 模式自动翻译伪名——真实路径绝不进 query，LS-121-C05）。 */
export async function historyOf(ctx: SyncContext, realPath: string, serverPath?: string) {
	return ctx.client.history(serverPath ?? serverPathOf(ctx, realPath));
}

/** 清理历史（meta 模式自动翻译伪名）。 */
export async function purgeHistoryOf(ctx: SyncContext, realPath: string, beforeRevision: number): Promise<number> {
	return ctx.client.purgeHistory(serverPathOf(ctx, realPath), beforeRevision);
}

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
	/** 加密元数据（meta 模式；调用方解出真实路径） */
	metaEnc?: string;
	metaGeneration?: number;
}

/**
 * LSE3 信封的基础绑定材料：vaultId 来自 bootstrap，keyEpoch 来自服务器状态机
 *（协议检查时同步）。任一缺失返回 undefined——协议 v6 起调用方必须**硬失败**
 * 而不是回退到更弱的信封（ADR-006 §2.4）。
 */
export function e2eeBinding(ctx: SyncContext): FileKeyBinding | undefined {
	const b = ctx.store.state.bootstrap;
	if (!b.remoteVaultId || b.keyEpoch === undefined || b.keyEpoch === 0) return undefined;
	// 出现了 keyEpoch 但值非法：绝不 `>>> 0` 截断、也绝不当作「未就绪」
	// 静默回退 LSE1（那等于信封降级）——直接硬失败（LS-121-C03）
	return { vaultId: b.remoteVaultId, keyEpoch: requireKeyEpoch(b.keyEpoch, "bootstrap.keyEpoch") };
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
	// 服务器提供的身份/世代字段集中校验（LS-121-C03）：非法值立刻硬失败，
	// 绝不带着被截断的 fileId/metaGeneration 继续解密或更新本地状态
	const fileId = optionalFileId(dl.fileId, `download(${path}).X-File-Id`);
	const metaGeneration = optionalGeneration(dl.metaGeneration, `download(${path}).X-Meta-Generation`);

	// LSE3（v9.3）：AAD = vaultId + keyEpoch(信封头) + fileId(服务器提供) + generation(信封头)。
	// fileId 造假 → GCM 认证直接失败；generation 经 AAD 认证后做回退检查。
	if (isLse3Envelope(dl.data)) {
		if (!ctx.e2ee.unlocked) throw new E2eeLockedError();
		const bind = e2eeBinding(ctx);
		if (!bind?.vaultId || fileId === undefined) {
			throw new Error(`无法解密 ${path}（缺少 vaultId/fileId 绑定材料）`);
		}
		const dec = await decryptFileV3(ctx.e2ee.requireKey(), dl.data, bind.vaultId, fileId, bind.keyEpoch);
		if (dec === null) throw new Error(`无法解密 ${path}（密钥不匹配、数据被篡改或密钥世代不符）`);
		if (opts.enforceGeneration) {
			const tracked = ctx.store.get(path);
			if (
				tracked?.fileId === fileId &&
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
			fileId,
			generation: dec.generation,
			metaEnc: dl.metaEnc,
			metaGeneration,
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
		fileId,
		metaEnc: dl.metaEnc,
		metaGeneration,
	};
}

/**
 * 下载当前 HEAD 并解密（强制 generation 不回退）。
 * path 为本地真实路径；meta 模式下自动翻译为伪名（serverPath 可显式覆盖，
 * bootstrap 等 tracked 尚不存在的场景用）。
 */
export async function downloadPlain(ctx: SyncContext, path: string, serverPath?: string): Promise<PlainDownload> {
	const sp = serverPath ?? serverPathOf(ctx, path);
	return decode(ctx, path, await ctx.client.download(sp), { enforceGeneration: true });
}

/** 下载历史版本并解密（历史本来就是旧 generation，不做回退检查）。 */
export async function versionPlain(
	ctx: SyncContext,
	path: string,
	revision: number,
	serverPath?: string,
): Promise<PlainDownload> {
	const sp = serverPath ?? serverPathOf(ctx, path);
	return decode(ctx, path, await ctx.client.version(sp, revision), { enforceGeneration: false });
}

/** 远端删除（meta 模式自动翻译伪名）。 */
export async function removeRemote(ctx: SyncContext, path: string, baseRevision: number): Promise<void> {
	await ctx.client.remove(serverPathOf(ctx, path), baseRevision);
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
	/** 元数据世代（meta 模式建档为 1；成功后记入 FileState） */
	metaGeneration?: number;
	/** 本次实际使用的服务器可见路径（meta 模式为伪名，明文模式为空） */
	serverPseudonym?: string;
}

/** 上传明文内容（E2EE 启用时自动加密，默认 LSE3；meta 模式自动伪名 + 挂元数据）。 */
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
	let serverPath = path;
	let meta: { metaEnc: string; canonicalHash: string } | undefined;
	let metaGeneration: number | undefined;

	if (ctx.e2ee.enabled) {
		const bind = e2eeBinding(ctx);
		if (!bind) {
			// 协议 v6 / ADR-006 §2.4：绑定材料缺失时**不再回退 LSE1**。
			// 回退等于自己制造一次信封降级——服务器的仓库级下限也会拒绝它。
			// 正确做法是先完成一次 /info 对账拿到 vaultId + keyEpoch。
			throw new EnvelopeBindingMissingError(path);
		}
		{
			const tracked = ctx.store.get(path);
			// 新文件：id 必须在加密前确定 → 客户端预生成，随上传头交给服务器。
			// 已跟踪文件沿用原身份，但先校验一遍——被改坏的 fileId 会让这份
			// 密文的 AAD 与将来重建的 AAD 不一致，永久无法解密（LS-121-C03）
			const fileId =
				tracked?.fileId === undefined ? newFileId() : requireFileId(tracked.fileId, `upload(${path}).fileId`);
			generation = (tracked?.fileId === fileId ? (tracked?.generation ?? 0) : 0) + 1;
			payload = await encryptFileV3(
				ctx.e2ee.requireKey(),
				{ vaultId: bind.vaultId, keyEpoch: bind.keyEpoch, fileId, generation },
				plain,
			);
			sendFileId = fileId;

			// 元数据加密模式（v9.3 三期）：服务器只见伪名；建档随带 LSM1 元数据
			if (metaEncrypted(ctx)) {
				serverPath = fileId;
				if (!tracked) {
					const keys = await ctx.e2ee.metaKeys();
					metaGeneration = 1;
					meta = {
						metaEnc: await encryptMeta(
							keys,
							{ vaultId: bind.vaultId, keyEpoch: bind.keyEpoch, fileId, metaGeneration },
							{ path },
						),
						canonicalHash: await canonicalPathHmac(keys, path),
					};
				} else {
					metaGeneration = tracked.metaGeneration;
				}
			}
		}
	}
	const cipherHash = await sha256Hex(payload);
	const res = await ctx.client.upload(serverPath, baseRevision, cipherHash, payload, mtime, action, sendFileId, meta);
	// 服务器回报的身份必须合法；E2EE 下还必须与本地用于加密的 fileId 完全一致，
	// 否则这份密文将来会因 AAD 不符而无法解密（LS-121-C03）
	const confirmed = optionalFileId(res.fileId, `upload(${path}).fileId`) ?? sendFileId;
	if (sendFileId !== undefined && confirmed !== sendFileId) {
		throw new Error(
			`服务器返回的 fileId 与本次加密使用的身份不一致（${path}），已停止同步以免写入无法解密的内容`,
		);
	}
	return {
		revision: res.revision,
		cipherHash,
		sequence: res.sequence,
		fileId: confirmed,
		generation,
		metaGeneration,
		serverPseudonym: metaEncrypted(ctx) ? serverPath : undefined,
	};
}
