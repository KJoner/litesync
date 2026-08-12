import { requestUrl } from "obsidian";
import { VaultKeyDoc } from "../crypto/crypto";

export interface ServerInfo {
	version: string;
	latestSequence: number;
	serverTime: number;
	/** 服务器当前协议版本（0.7.0 之前的旧服务器不返回，按 1 处理） */
	protocolVersion?: number;
	/** 服务器仍兼容的最低客户端协议版本 */
	minProtocolVersion?: number;
	/** 同步仓库的稳定标识（0.8.0+）：URL 不变但 vaultId 变化 = 服务器被重装/换库 */
	vaultId?: string;
	/**
	 * sequence 空间的世代（0.9.0+）：服务器从备份恢复后旋转。
	 * epoch 变化时旧游标全部作废，客户端必须进入恢复合并而不是继续增量同步
	 */
	repoEpoch?: string;
	/** 权威全局时钟（0.9.0+）：不再依赖可裁剪的 changes 表 */
	headSequence?: number;
	/** E2EE 状态机（0.9.0+）：plaintext / migrating / encrypted */
	encryptionState?: string;
	keyEpoch?: number;
	/** 元数据加密状态机（0.12.0+）：plain / migrating / encrypted */
	metaState?: string;
}

/**
 * 插件实现的同步协议版本（v7 起插件与服务器分仓独立发版）。
 * 破坏性协议变更时递增，与服务器 /api/v1/info 的区间做兼容性判定。
 * v2（0.9.0）：repoEpoch、tombstone 拒绝 base 0、E2EE 状态机、vault-key CAS。
 * v3（0.10.0）：设备级凭据与配对包 v2（enrollment）、LSE2 加密信封。
 * v4（0.11.0）：LSE3 信封（fileId-AAD + contentGeneration 抗回退重放）、E2EE 原子 MOVE。
 * v5（0.12.0）：元数据加密——伪名路径 + LSM1 信封，改名 = 元数据更新。
 */
export const PLUGIN_PROTOCOL_VERSION = 5;

/** 协议不兼容时返回给用户的提示；兼容返回 null。 */
export function protocolError(info: ServerInfo): string | null {
	const server = info.protocolVersion ?? 1;
	const minClient = info.minProtocolVersion ?? 1;
	if (minClient > PLUGIN_PROTOCOL_VERSION) {
		return `LiteSync 插件需要更新：服务器（${info.version}）要求协议 ≥ ${minClient}，当前插件为 ${PLUGIN_PROTOCOL_VERSION}`;
	}
	if (server < PLUGIN_PROTOCOL_VERSION) {
		return `LiteSync Server 需要更新：插件要求协议 ${PLUGIN_PROTOCOL_VERSION}，服务器（${info.version}）为 ${server}`;
	}
	return null;
}

export interface RemoteChange {
	sequence: number;
	path: string;
	action: "upsert" | "delete";
	revision: number;
	hash?: string;
	/** 元数据世代（0.12.0+）：hash 未变但世代变新 = 仅改名 */
	metaGeneration?: number;
}

export interface ChangesResponse {
	latestSequence: number;
	hasMore: boolean;
	changes: RemoteChange[];
	/** 服务器已裁剪掉本游标之前的 changes：必须走 snapshot 全量对账 */
	resyncRequired?: boolean;
	minSequence?: number;
	/** sequence 世代（0.9.0+）：与本地保存值不一致时必须停止增量同步 */
	repoEpoch?: string;
	headSequence?: number;
}

/** snapshot 文件元数据（全量对账用）。 */
export interface SnapshotFile {
	path: string;
	revision: number;
	hash: string;
	size: number;
	mtime: number;
	/** 稳定文件身份（0.11.0+） */
	fileId?: string;
	/** 加密元数据（0.12.0+，meta 模式）：真实路径在里面 */
	metaEnc?: string;
	metaGeneration?: number;
}

export interface UploadOk {
	path: string;
	revision: number;
	hash: string;
	size: number;
	sequence: number;
	/** 稳定文件身份（0.11.0+；LSE3 密文的 AAD 绑定它） */
	fileId?: string;
}

/** 409 响应中携带的服务器当前状态。 */
export interface RemoteFileState {
	path: string;
	revision: number;
	hash: string;
	deleted: boolean;
	/**
	 * tombstone 冲突时删除前最后一个版本的内容 hash（0.9.0+）：
	 * 客户端据此区分「陈旧副本复活」与「同名新内容重建」
	 */
	priorHash?: string;
}

export interface DownloadResult {
	data: ArrayBuffer;
	revision: number;
	hash: string;
	size: number;
	mtime: number;
	/** 稳定文件身份（0.11.0+）；历史版本返回写入当时的身份，旧版本可能为空 */
	fileId?: string;
	/** 加密元数据与其世代（0.12.0+，meta 模式） */
	metaEnc?: string;
	metaGeneration?: number;
}

/** 历史版本元数据（GET /api/v1/history）。 */
export interface VersionEntry {
	revision: number;
	action: "upsert" | "delete" | "restore" | "merge";
	size: number;
	mtime: number;
	hash?: string;
	deviceId?: string;
	createdAt: number;
}

export type UploadAction = "upsert" | "merge" | "restore";

/** 分享元数据（GET /api/v1/shares）。 */
export interface ShareEntry {
	id: string;
	name: string;
	size: number;
	expiresAt: number;
	createdAt: number;
	revoked: boolean;
	expired: boolean;
}

/**
 * 服务器错误码（v0.12.1 / LS-121-S05）：客户端逻辑只允许根据 `code` 分支，
 * 绝不允许再解析 message 文案（文案会随本地化和版本变化）。
 */
export type ServerErrorCode =
	| "INVALID_PATH"
	| "INVALID_HEADER"
	| "INVALID_BODY"
	| "ENVELOPE_TOO_OLD"
	| "PLAINTEXT_REJECTED"
	| "META_REQUIRED"
	| "META_STATE_INVALID"
	| "STALE_META_GENERATION"
	| "CANONICAL_COLLISION"
	| "FILE_ID_CONFLICT"
	| "TOMBSTONE_PLAINTEXT"
	| "MIGRATION_LOCKED"
	| "NOT_FOUND"
	| "TOO_LARGE"
	| "INTERNAL";

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		/** 服务器返回的机器可识别错误码（旧服务器不返回时为 undefined） */
		public code?: string,
		/** 服务器标注该错误是否值得重试 */
		public retryable?: boolean,
	) {
		super(message);
		this.name = "ApiError";
	}

	is(code: ServerErrorCode): boolean {
		return this.code === code;
	}
}

export class ConflictError extends Error {
	constructor(public server: RemoteFileState) {
		super(`revision conflict on ${server.path} (server revision ${server.revision})`);
		this.name = "ConflictError";
	}
}

export class NotFoundError extends Error {
	constructor(
		public deleted = false,
		public revision = 0,
	) {
		super("not found");
		this.name = "NotFoundError";
	}
}

interface ClientConfig {
	serverUrl: string;
	apiToken: string;
	deviceId: string;
}

/**
 * 服务端 API 客户端。使用 Obsidian 的 requestUrl（不受 CORS 限制）。
 * 文件路径经 encodeURIComponent 放入 Header，以支持中文等非 ASCII 文件名。
 */
export class ApiClient {
	constructor(private getConfig: () => ClientConfig) {}

	private base(): string {
		const url = this.getConfig().serverUrl.trim().replace(/\/+$/, "");
		if (!url) throw new ApiError(0, "server URL is not configured");
		// 安全红线（v9）：Token 与内容绝不允许走明文 HTTP 出本机——
		// 仅 loopback（本机调试）放行 http://，其余一律要求 https://
		if (/^http:\/\//i.test(url) && !isLoopbackUrl(url)) {
			throw new ApiError(0, "非本机地址必须使用 https://（当前 Server URL 是 http://，Token 会被明文暴露）");
		}
		return url;
	}

	private headers(extra?: Record<string, string>): Record<string, string> {
		const { apiToken, deviceId } = this.getConfig();
		return {
			Authorization: `Bearer ${apiToken}`,
			"X-Device-ID": deviceId,
			...extra,
		};
	}

	async info(): Promise<ServerInfo> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/info`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `info failed: HTTP ${res.status}`);
		return res.json as ServerInfo;
	}

	async changes(since: number, limit = 500): Promise<ChangesResponse> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/changes?since=${since}&limit=${limit}`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `changes failed: HTTP ${res.status}`);
		return res.json as ChangesResponse;
	}

	/** 当前所有未删除文件的元数据（changes 被裁剪后的全量对账）。 */
	async snapshot(): Promise<{ sequence: number; files: SnapshotFile[]; repoEpoch?: string }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/snapshot`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `snapshot failed: HTTP ${res.status}`);
		return res.json as { sequence: number; files: SnapshotFile[]; repoEpoch?: string };
	}

	async download(path: string): Promise<DownloadResult> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/file?path=${encodeURIComponent(path)}`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status === 404) {
			const body = tryJson(res.text);
			throw new NotFoundError(body?.deleted === true, num(body?.revision));
		}
		if (res.status !== 200) throw new ApiError(res.status, `download ${path} failed: HTTP ${res.status}`);
		return {
			data: res.arrayBuffer,
			revision: num(header(res.headers, "x-revision")),
			hash: header(res.headers, "x-content-hash") ?? "",
			size: num(header(res.headers, "x-file-size")),
			mtime: num(header(res.headers, "x-file-mtime")),
			fileId: header(res.headers, "x-file-id") || undefined,
			metaEnc: header(res.headers, "x-meta-enc") || undefined,
			metaGeneration: num(header(res.headers, "x-meta-generation")) || undefined,
		};
	}

	async upload(
		path: string,
		baseRevision: number,
		hash: string,
		data: ArrayBuffer,
		mtime: number,
		action: UploadAction = "upsert",
		fileId?: string,
		meta?: { metaEnc: string; canonicalHash: string },
	): Promise<UploadOk> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/file`,
			method: "PUT",
			headers: this.headers({
				"Content-Type": "application/octet-stream",
				"X-File-Path": encodeURIComponent(path),
				"X-Base-Revision": String(baseRevision),
				"X-Content-Hash": hash,
				"X-File-Mtime": String(Math.round(mtime)),
				"X-Action": action,
				...(fileId ? { "X-File-Id": fileId } : {}),
				...(meta ? { "X-Meta-Enc": meta.metaEnc, "X-Canonical-Hash": meta.canonicalHash } : {}),
			}),
			body: data,
			throw: false,
		});
		if (res.status === 409) {
			// 409 既可能是 revision 冲突，也可能是「信封降级被拒」（v0.12.1 S01）等
			// 协议级拒绝——后者没有可用的服务器状态，必须按 ApiError 上抛
			const body = tryJson(res.text);
			if (typeof body?.code === "string" && body.code !== "CONFLICT") {
				throw apiError(409, `upload ${path} failed`, res.text);
			}
			throw new ConflictError(parseConflict(res.text, path));
		}
		if (res.status !== 200) {
			// 422（路径碰撞）等携带说明的错误：把服务器信息带给用户
			throw apiError(res.status, `upload ${path} failed`, res.text);
		}
		return res.json as UploadOk;
	}

	/** 获取文件的历史版本列表（revision 降序）。 */
	async history(path: string): Promise<VersionEntry[]> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/history?path=${encodeURIComponent(path)}`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `history ${path} failed: HTTP ${res.status}`);
		const body = res.json as { versions: VersionEntry[] };
		return body.versions ?? [];
	}

	/** 下载某历史版本的内容。版本不存在或已被 GC 时抛 NotFoundError。 */
	async version(path: string, revision: number): Promise<DownloadResult> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/version?path=${encodeURIComponent(path)}&revision=${revision}`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status === 404) throw new NotFoundError();
		if (res.status !== 200)
			throw new ApiError(res.status, `version ${path}@${revision} failed: HTTP ${res.status}`);
		return {
			data: res.arrayBuffer,
			revision: num(header(res.headers, "x-revision")),
			hash: header(res.headers, "x-content-hash") ?? "",
			size: num(header(res.headers, "x-file-size")),
			mtime: num(header(res.headers, "x-file-mtime")),
			fileId: header(res.headers, "x-file-id") || undefined,
		};
	}

	/** 创建分享（body 是独立 Share Key 加密后的密文；服务器拿不到 key）。 */
	async createShare(name: string, expiresAt: number, payload: ArrayBuffer): Promise<{ id: string }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/share`,
			method: "POST",
			headers: this.headers({
				"Content-Type": "application/octet-stream",
				"X-Share-Name": encodeURIComponent(name),
				"X-Share-Expires": String(expiresAt),
			}),
			body: payload,
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `share create failed: HTTP ${res.status}`);
		return res.json as { id: string };
	}

	async listShares(): Promise<ShareEntry[]> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/shares`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `share list failed: HTTP ${res.status}`);
		return (res.json as { shares: ShareEntry[] }).shares ?? [];
	}

	async revokeShare(id: string): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/share?id=${encodeURIComponent(id)}`,
			method: "DELETE",
			headers: this.headers(),
			throw: false,
		});
		if (res.status === 404) throw new NotFoundError();
		if (res.status !== 200) throw new ApiError(res.status, `share revoke failed: HTTP ${res.status}`);
	}

	// ---------- 设备级凭据（v9.2，协议 v3） ----------

	/** 当前凭据身份：root（.env 根 Token）或 device（设备凭据）。 */
	async whoami(): Promise<{ tokenType: "root" | "device"; deviceId?: string; scopes?: string }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/whoami`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `whoami failed: HTTP ${res.status}`);
		return res.json as { tokenType: "root" | "device"; deviceId?: string; scopes?: string };
	}

	/** 根 Token 直接创建设备凭据（首台设备自注册；token 明文只返回一次）。 */
	async createDevice(name: string): Promise<{ deviceId: string; deviceToken: string }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/devices`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ name }),
			throw: false,
		});
		if (res.status !== 200)
			throw new ApiError(res.status, `device create failed: HTTP ${res.status}${serverErrText(res.text)}`);
		return res.json as { deviceId: string; deviceToken: string };
	}

	/** 生成一次性注册凭据（配对包 v2 携带；secret 只返回一次）。 */
	async createEnrollment(ttlSeconds = 900): Promise<{ id: string; secret: string; expiresAt: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/enrollments`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ ttlSeconds }),
			throw: false,
		});
		if (res.status !== 200)
			throw new ApiError(res.status, `enrollment create failed: HTTP ${res.status}${serverErrText(res.text)}`);
		return res.json as { id: string; secret: string; expiresAt: number };
	}

	/** 设备列表（不含凭据材料）。 */
	async listDevices(): Promise<
		Array<{ id: string; name: string; scopes: string; createdAt: number; lastSeenAt: number; revoked: boolean; current: boolean }>
	> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/devices`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `device list failed: HTTP ${res.status}`);
		return (res.json as { devices: never[] }).devices ?? [];
	}

	/** 创建一次性加密配对包（v8「添加新设备」；服务器只存密文）。 */
	async createPairing(ciphertextB64: string, ttlSeconds = 300): Promise<{ id: string; expiresAt: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/pairing`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ ciphertext: ciphertextB64, ttlSeconds }),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `pairing create failed: HTTP ${res.status}`);
		return res.json as { id: string; expiresAt: number };
	}

	/** 撤销配对包（配对窗口关闭时调用；已消费/不存在也视为成功）。 */
	async deletePairing(id: string): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/pairing/${encodeURIComponent(id)}`,
			method: "DELETE",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `pairing delete failed: HTTP ${res.status}`);
	}

	/** 获取服务器上的加密 vault key 文档；未启用 E2EE 时返回 null。 */
	async getVaultKey(): Promise<VaultKeyDoc | null> {
		return (await this.getVaultKeyWithFingerprint())?.doc ?? null;
	}

	/** 获取 vault key 文档及其 CAS 指纹（replace 时必须原样传回，0.9.0+）。 */
	async getVaultKeyWithFingerprint(): Promise<{ doc: VaultKeyDoc; fingerprint: string } | null> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/vault-key`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status === 404) return null;
		if (res.status !== 200) throw new ApiError(res.status, `vault-key get failed: HTTP ${res.status}`);
		return {
			doc: res.json as VaultKeyDoc,
			fingerprint: header(res.headers, "x-vault-key-fingerprint") ?? "",
		};
	}

	/**
	 * 上传加密 vault key 文档。已存在且未 replace 时服务器返回 409；
	 * replace 必须携带当前文档指纹（CAS），指纹不符服务器返回 412——
	 * 防止并发迁移把别的设备刚写入的 key 文档无条件覆盖掉。
	 */
	async putVaultKey(doc: VaultKeyDoc, replace: boolean, expectedFingerprint = ""): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/vault-key${replace ? "?replace=true" : ""}`,
			method: "PUT",
			headers: this.headers({
				"Content-Type": "application/json",
				...(expectedFingerprint ? { "X-Expected-Fingerprint": expectedFingerprint } : {}),
			}),
			body: JSON.stringify(doc),
			throw: false,
		});
		if (res.status !== 200)
			throw new ApiError(res.status, `vault-key put failed: HTTP ${res.status}${serverErrText(res.text)}`);
	}

	/** E2EE 状态机（0.9.0+）：begin 冻结明文写 / complete 全量验证后启用 / abort 回退。 */
	async e2eeTransition(action: "begin" | "complete" | "abort"): Promise<{ encryptionState: string; keyEpoch: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/e2ee/${action}`,
			method: "POST",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200)
			throw new ApiError(res.status, `e2ee ${action} failed: HTTP ${res.status}${serverErrText(res.text)}`);
		return res.json as { encryptionState: string; keyEpoch: number };
	}

	/** 清理某路径 beforeRevision 之前的历史版本（E2EE 迁移：密文验证后清明文）。 */
	async purgeHistory(path: string, beforeRevision: number): Promise<number> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/history?path=${encodeURIComponent(path)}&beforeRevision=${beforeRevision}`,
			method: "DELETE",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `history purge failed: HTTP ${res.status}`);
		return num((res.json as Record<string, unknown>)?.removed);
	}

	/**
	 * 原子改名（v9.3，明文模式）：服务器单事务完成旧路径 tombstone + 新路径新行。
	 * 409 → ConflictError（远端已变化/目标占用）；其余非 200 → ApiError，
	 * 调用方回退 delete+upsert 语义。
	 */
	async move(
		fromPath: string,
		toPath: string,
		baseRevision: number,
	): Promise<{ revision: number; tombstoneRevision: number; sequence: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/file/move`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ fromPath, toPath, baseRevision }),
			throw: false,
		});
		if (res.status === 409) throw new ConflictError(parseConflict(res.text, fromPath));
		if (res.status !== 200) throw apiError(res.status, `move ${fromPath} -> ${toPath} failed`, res.text);
		return res.json as { revision: number; tombstoneRevision: number; sequence: number };
	}

	// ---------- 元数据加密（v9.3 三期，协议 v5） ----------

	/** 轻量获取文件元数据（改名变更无需下载内容）。 */
	async getFileMeta(
		path: string,
	): Promise<{ path: string; fileId: string; revision: number; metaEnc: string; metaGeneration: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/file/meta?path=${encodeURIComponent(path)}`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status === 404) throw new NotFoundError();
		if (res.status !== 200) throw new ApiError(res.status, `meta get failed: HTTP ${res.status}`);
		return res.json as { path: string; fileId: string; revision: number; metaEnc: string; metaGeneration: number };
	}

	/** 改名 = 元数据更新（metaGeneration CAS；412 = 并发改名需重取）。 */
	async updateFileMeta(
		path: string,
		baseMetaGeneration: number,
		metaEnc: string,
		canonicalHash: string,
	): Promise<{ revision: number; metaGeneration: number; sequence: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/file/meta`,
			method: "PUT",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ path, baseMetaGeneration, metaEnc, canonicalHash }),
			throw: false,
		});
		if (res.status === 409) throw new ConflictError(parseConflict(res.text, path));
		if (res.status !== 200) throw apiError(res.status, "meta update failed", res.text);
		return res.json as { revision: number; metaGeneration: number; sequence: number };
	}

	/** 元数据迁移：单文件真实路径 → 伪名（断点续传安全）。 */
	async migrateFileMeta(
		fromPath: string,
		metaEnc: string,
		canonicalHash: string,
	): Promise<{ fromPath: string; toPath: string; revision: number; sequence: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/migrate`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ fromPath, metaEnc, canonicalHash }),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "meta migrate failed", res.text);
		return res.json as { fromPath: string; toPath: string; revision: number; sequence: number };
	}

	/** 元数据加密状态机；complete 是明文路径抹除的单向点（必须显式确认）。 */
	async metaTransition(action: "begin" | "abort"): Promise<{ metaState: string }>;
	async metaTransition(action: "complete", confirmErase: true): Promise<{ metaState: string }>;
	async metaTransition(action: "begin" | "complete" | "abort", confirmErase?: boolean): Promise<{ metaState: string }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/${action}`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: action === "complete" ? JSON.stringify({ confirmErase: confirmErase === true }) : "{}",
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, `meta ${action} failed`, res.text);
		return res.json as { metaState: string };
	}

	async remove(path: string, baseRevision: number): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/file`,
			method: "DELETE",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ path, baseRevision }),
			throw: false,
		});
		if (res.status === 409) throw new ConflictError(parseConflict(res.text, path));
		if (res.status === 404) throw new NotFoundError();
		if (res.status !== 200) throw new ApiError(res.status, `delete ${path} failed: HTTP ${res.status}`);
	}
}

function parseConflict(text: string, path: string): RemoteFileState {
	const body = tryJson(text);
	return {
		path: typeof body?.path === "string" ? body.path : path,
		revision: num(body?.revision),
		hash: typeof body?.hash === "string" ? body.hash : "",
		deleted: body?.deleted === true,
		priorHash: typeof body?.priorHash === "string" ? body.priorHash : undefined,
	};
}

/** 提取服务器错误响应中的说明文字（附加到 ApiError message）。 */
function serverErrText(text: string): string {
	const body = tryJson(text);
	const msg = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : "";
	const extra = typeof body?.existing === "string" ? `（与现有文件冲突：${body.existing}）` : "";
	return msg ? ` — ${msg}${extra}` : "";
}

/** 统一构造带机器错误码的 ApiError（v0.12.1 / LS-121-S05）。 */
function apiError(status: number, prefix: string, text: string): ApiError {
	const body = tryJson(text);
	return new ApiError(
		status,
		`${prefix}: HTTP ${status}${serverErrText(text)}`,
		typeof body?.code === "string" ? body.code : undefined,
		typeof body?.retryable === "boolean" ? body.retryable : undefined,
	);
}

/**
 * 公开设备注册（v9.2）：新设备此时还没有任何凭据，enrollment secret 即认证。
 * 独立函数（不走 ApiClient 的 Authorization header）。
 */
export async function enrollDevice(
	serverUrl: string,
	secret: string,
	name: string,
): Promise<{ deviceId: string; deviceToken: string }> {
	const res = await requestUrl({
		url: `${serverUrl.replace(/\/+$/, "")}/enroll`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ secret, name }),
		throw: false,
	});
	if (res.status === 404) throw new ApiError(404, "注册凭据无效或已过期，请在旧设备上重新生成配对二维码");
	if (res.status !== 200) throw new ApiError(res.status, `device enroll failed: HTTP ${res.status}`);
	return res.json as { deviceId: string; deviceToken: string };
}

/** 仅本机地址允许走 http://（Token 明文传输的唯一豁免场景）。 */
export function isLoopbackUrl(url: string): boolean {
	const m = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(url.trim());
	if (!m) return false;
	const host = m[1].toLowerCase();
	return (
		host === "localhost" ||
		host === "[::1]" ||
		host === "127.0.0.1" ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
	);
}

function tryJson(text: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(text);
		return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function header(headers: Record<string, string>, name: string): string | undefined {
	if (name in headers) return headers[name];
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name) return headers[key];
	}
	return undefined;
}

function num(v: unknown): number {
	const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
	return Number.isFinite(n) ? n : 0;
}
