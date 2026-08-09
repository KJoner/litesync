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
}

/**
 * 插件实现的同步协议版本（v7 起插件与服务器分仓独立发版）。
 * 破坏性协议变更时递增，与服务器 /api/v1/info 的区间做兼容性判定。
 */
export const PLUGIN_PROTOCOL_VERSION = 1;

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
}

export interface ChangesResponse {
	latestSequence: number;
	hasMore: boolean;
	changes: RemoteChange[];
	/** 服务器已裁剪掉本游标之前的 changes：必须走 snapshot 全量对账 */
	resyncRequired?: boolean;
	minSequence?: number;
}

/** snapshot 文件元数据（全量对账用）。 */
export interface SnapshotFile {
	path: string;
	revision: number;
	hash: string;
	size: number;
	mtime: number;
}

export interface UploadOk {
	path: string;
	revision: number;
	hash: string;
	size: number;
	sequence: number;
}

/** 409 响应中携带的服务器当前状态。 */
export interface RemoteFileState {
	path: string;
	revision: number;
	hash: string;
	deleted: boolean;
}

export interface DownloadResult {
	data: ArrayBuffer;
	revision: number;
	hash: string;
	size: number;
	mtime: number;
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

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
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
	async snapshot(): Promise<{ sequence: number; files: SnapshotFile[] }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/snapshot`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `snapshot failed: HTTP ${res.status}`);
		return res.json as { sequence: number; files: SnapshotFile[] };
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
		};
	}

	async upload(
		path: string,
		baseRevision: number,
		hash: string,
		data: ArrayBuffer,
		mtime: number,
		action: UploadAction = "upsert",
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
			}),
			body: data,
			throw: false,
		});
		if (res.status === 409) throw new ConflictError(parseConflict(res.text, path));
		if (res.status !== 200) throw new ApiError(res.status, `upload ${path} failed: HTTP ${res.status}`);
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
		const res = await requestUrl({
			url: `${this.base()}/api/v1/vault-key`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status === 404) return null;
		if (res.status !== 200) throw new ApiError(res.status, `vault-key get failed: HTTP ${res.status}`);
		return res.json as VaultKeyDoc;
	}

	/** 上传加密 vault key 文档。已存在且未 replace 时服务器返回 409。 */
	async putVaultKey(doc: VaultKeyDoc, replace: boolean): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/vault-key${replace ? "?replace=true" : ""}`,
			method: "PUT",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify(doc),
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `vault-key put failed: HTTP ${res.status}`);
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
	};
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
