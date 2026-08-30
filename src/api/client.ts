import { Platform, requestUrl } from "obsidian";
import { canonicalCheckpoint, SignedCheckpoint } from "../crypto/checkpoint";
import { VaultKeyDoc } from "../crypto/crypto";

export interface ServerInfo {
	version: string;
	latestSequence: number;
	serverTime: number;
	/** 重置凭证是否已登记（v0.18 服务器）：false 且已解锁 E2EE 时自动补登记 */
	resetAuthConfigured?: boolean;
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
	/** 元数据加密状态机：plain / migrating / verifying / encrypted */
	metaState?: string;
	/**
	 * 寻址格式世代（0.13.0+ / ADR-006）：元数据加密完成时 +1。
	 * 与 repoEpoch（灾备恢复）、keyEpoch（密钥轮换）语义完全不同——
	 * formatEpoch 变化意味着「服务器的寻址方式变了」，客户端必须丢弃游标重新对账。
	 */
	formatEpoch?: number;
	/** 仓库级信封下限（0.13.0+）：低于它的写入会被服务器拒绝 */
	minimumEnvelopeVersion?: number;
	/** 服务端数据模型版本（0.13.0+，6 = fileId 对象模型） */
	schemaVersion?: number;
	/** 进行中的迁移（0.13.0+）：非 owner 设备据此知道自己处于受限写入状态 */
	migrationId?: string;
	migrationOwnerDeviceId?: string;
}

/**
 * 插件实现的同步协议版本（v7 起插件与服务器分仓独立发版）。
 * 破坏性协议变更时递增，与服务器 /api/v1/info 的区间做兼容性判定。
 * v2（0.9.0）：repoEpoch、tombstone 拒绝 base 0、E2EE 状态机、vault-key CAS。
 * v3（0.10.0）：设备级凭据与配对包 v2（enrollment）、LSE2 加密信封。
 * v4（0.11.0）：LSE3 信封（fileId-AAD + contentGeneration 抗回退重放）、E2EE 原子 MOVE。
 * v5（0.12.0）：元数据加密——伪名路径 + LSM1 信封，改名 = 元数据更新。
 * v6（0.13.0）：fileId 为主键的对象模型（ADR-001）——revision 属于对象，
 *   改名与元数据迁移不再产生 tombstone；隐私 tombstone 台账与显式 restore
 *   （ADR-002）；四态迁移状态机（ADR-003）；仓库级 minimumEnvelopeVersion 与
 *   formatEpoch（ADR-006）。逐请求携带协议版本与 formatEpoch。
 */
export const PLUGIN_PROTOCOL_VERSION = 6;

/**
 * 本插件的版本号，随每个请求上报（v0.17 / 计划书 §15 第 3 步）。
 *
 * §15 的第 3 步是「检查设备列表，无旧客户端」——它是**不可逆迁移的前置条件**：
 * 只要还有一台旧客户端连着，它就会用 LSE1 覆盖 LSE3 的 HEAD（ADR-006 威胁 T-2），
 * 或者读不懂伪名寻址。
 *
 * 在此之前服务器根本无从知道每台设备跑的是哪个版本，这一步没法执行。
 * 协议版本号（6）粒度太粗：同一个协议版本下的两个插件版本，
 * 修没修某个已知 bug 是不一样的。
 */
export const PLUGIN_VERSION = "0.19.0-rc.1";

/**
 * 平台紧凑 token（随每个请求上报，运维页 Devices 列表用）。
 * 与 diagnostics 里面向展示的 describePlatform 不同：这里是机器可读的固定值集合
 * （windows|macos|linux|ios|android|unknown），服务器按白名单校验后落库。
 * 判定顺序与 describePlatform 一致：先移动端后桌面端。
 * 字段缺失（如测试替身的最小 Platform mock）时安全地归为 "unknown"。
 */
function detectClientPlatform(): string {
	const p = Platform as Partial<Record<"isIosApp" | "isAndroidApp" | "isMacOS" | "isWin" | "isLinux", boolean>>;
	if (p.isIosApp) return "ios";
	if (p.isAndroidApp) return "android";
	if (p.isMacOS) return "macos";
	if (p.isWin) return "windows";
	if (p.isLinux) return "linux";
	return "unknown";
}

/** 模块加载时一次性判定：平台在进程生命周期内不会变，没必要逐请求重算。 */
const CLIENT_PLATFORM = detectClientPlatform();

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
	/** 服务器可见寻址名（明文模式 = 真实路径，meta 模式 = 伪名） */
	path: string;
	/** 稳定身份（0.13.0+）：客户端据此对账，不再依赖 path */
	fileId?: string;
	action: "upsert" | "delete" | "restore";
	revision: number;
	hash?: string;
	/** 内容世代（0.13.0+）：抗回退比较 */
	contentGeneration?: number;
	/** 元数据世代：hash 未变但世代变新 = 仅改名 */
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
	/** 寻址格式世代（0.13.0+）：变化时必须丢弃游标重新对账 */
	formatEpoch?: number;
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
	/** 内容世代与信封版本（0.13.0+）：抗回退比较与信封下限核对 */
	contentGeneration?: number;
	envelopeVersion?: number;
}

export interface UploadOk {
	path: string;
	revision: number;
	hash: string;
	size: number;
	sequence: number;
	/** 稳定文件身份（0.11.0+；LSE3 密文的 AAD 绑定它） */
	fileId?: string;
	contentGeneration?: number;
	metaGeneration?: number;
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
	/** 冲突对象的稳定身份（0.13.0+）：客户端据此走显式 restore 而不是新建 */
	fileId?: string;
	/** tombstone 冲突时删除时的内容世代：restore 必须提交严格大于它的世代 */
	contentGeneration?: number;
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

/** 名下仓库（GET /api/v1/vaults，v0.19 多仓库）。 */
export interface RemoteVault {
	id: string;
	name: string;
	createdAt: number;
	fileCount: number;
	bytesUsed: number;
	updatedAt: number;
	encryptionState: string;
	/** 本次请求的凭据当前指向的仓库 */
	current: boolean;
}

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
	// --- v0.18 认证类（重置 Token / 设备撤销的机器可读通路） ---
	| "UNAUTHORIZED"
	| "TOKEN_REVOKED"
	| "RESET_AUTH_MISMATCH"
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
	| "TOMBSTONE_PURGED"
	| "MIGRATION_LOCKED"
	| "MIGRATION_INCOMPLETE"
	| "MIGRATION_MISMATCH"
	| "MIGRATION_VALIDATION_FAILED"
	| "FORMAT_EPOCH_MISMATCH"
	| "UPGRADE_REQUIRED"
	| "STALE_REVISION"
	| "HASH_MISMATCH"
	| "CONFLICT"
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
		/**
		 * 422 CANONICAL_COLLISION 专用：与本次请求归一化后同名的**现有对象**的
		 * 服务器寻址名（meta 模式为伪名 = fileId，明文模式为真实路径）。
		 * §6.5 靠它去取冲突对象的元数据，判断是同一个逻辑文件还是两端同名新建。
		 */
		public existing?: string,
	) {
		super(message);
		this.name = "ApiError";
	}

	is(code: ServerErrorCode): boolean {
		return this.code === code;
	}
}

/** 迁移状态与 journal 进度（GET /api/v1/meta/status）。 */
export interface MigrationStatus {
	metaState: string;
	migrationId: string;
	ownerDeviceId: string;
	leaseExpiresAt: number;
	cutoffSequence: number;
	targetFormatEpoch: number;
	formatEpoch: number;
	minimumEnvelopeVersion: number;
	journal: Record<string, number>;
	plaintextTombstones: number;
}

/** 仍带明文寻址名的删除记录（迁移期间由 owner 拉取并逐条转换）。 */
export interface PlaintextTombstone {
	fileId: string;
	lastPseudonym: string;
	deletionRevision: number;
}

/** complete 验证器的一条失败项。 */
export interface ValidationFailure {
	check: string;
	code: string;
	count: number;
	example?: string;
}

/**
 * complete 验证失败：携带**完整**清单。
 * 服务端在这种情况下没有改动任何数据，可以修掉问题后原地重试。
 */
export class MigrationValidationError extends Error {
	constructor(public failures: ValidationFailure[]) {
		super(
			`迁移验证未通过（${failures.length} 项）：` +
				failures.map((f) => `${f.check}（${f.code} ×${f.count}）`).join("；"),
		);
		this.name = "MigrationValidationError";
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
	/** 目标仓库（v0.19 多仓库；空 = 默认仓库）。随每个请求以 X-Vault-ID 携带 */
	vaultChoice?: string;
	/**
	 * 客户端当前认为的寻址格式世代（0.13.0+ / ADR-006）。
	 * 逐请求携带；与服务器不符时服务器返回 409 FORMAT_EPOCH_MISMATCH，
	 * 客户端据此丢弃游标重新对账，而不是继续用错误的寻址方式写入。
	 */
	formatEpoch: number;
	/**
	 * 客户端当前认为的 sequence 世代与密钥世代（0.13.1+ / 计划书 §5.3）。
	 * 逐请求携带：服务器可能在两次请求之间从备份恢复或轮换密钥，
	 * 而本设备此刻仍拿着旧判断在写入。
	 */
	repoEpoch: string;
	keyEpoch: number;
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
		const { apiToken, deviceId, formatEpoch, repoEpoch, keyEpoch, vaultChoice } = this.getConfig();
		return {
			Authorization: `Bearer ${apiToken}`,
			// 目标仓库（v0.19）：用户级凭据据此选择仓库（服务端按成员关系硬校验，
			// 非成员 404）；设备凭据已绑定仓库，服务端对它忽略此头
			...(vaultChoice ? { "X-Vault-ID": vaultChoice } : {}),
			"X-Device-ID": deviceId,
			// 逐请求协议与世代校验（协议 v6 / ADR-006 §2.2、计划书 §5.3）：
			// 服务器逐请求比对，不匹配即拒绝写入——绝不让本设备用过时的判断改数据
			"X-LiteSync-Protocol": String(PLUGIN_PROTOCOL_VERSION),
			// 客户端版本（§15 第 3 步）：让「所有设备都升级了吗」成为一个可查的事实，
			// 而不是一句只能靠人挨个问的口头确认
			"X-Client-Version": PLUGIN_VERSION,
			// 客户端平台（运维页 Devices 列表）：让「哪台是丢失的那台手机」
			// 在事故当天一眼可辨，而不是对着一排设备名猜
			"X-Client-Platform": CLIENT_PLATFORM,
			...(formatEpoch > 0 ? { "X-Format-Epoch": String(formatEpoch) } : {}),
			...(repoEpoch ? { "X-Repo-Epoch": repoEpoch } : {}),
			...(keyEpoch > 0 ? { "X-Key-Epoch": String(keyEpoch) } : {}),
			...extra,
		};
	}

	/** 幂等键：响应丢失后用同一个 id 重试，服务器返回首次结果而不是产生第二个 revision。 */
	private opHeader(operationId?: string): Record<string, string> {
		return operationId ? { "X-Operation-Id": operationId } : {};
	}

	async info(): Promise<ServerInfo> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/info`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		// v0.18：解析响应体，让 401 携带机器可读 code（UNAUTHORIZED / TOKEN_REVOKED）——
		// 「Token 被重置/设备被撤销」与「网络抽风」在 UI 上必须是两种说法
		if (res.status !== 200) throw apiError(res.status, "info failed", res.text);
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
		operationId?: string,
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
				...this.opHeader(operationId),
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

	/**
	 * 创建分享（body 是独立 Share Key 加密后的密文；服务器拿不到 key）。
	 *
	 * v0.13.3 §7.4：**不再发送 `X-Share-Name`**。显示名已经打进密文帧里，
	 * 由查看页解密后展示；服务器侧只保留一个随机标签。以前把真实路径放进
	 * Header，等于让「用户分享了哪个文件」出现在服务端日志与数据库里。
	 */
	async createShare(expiresAt: number, payload: ArrayBuffer): Promise<{ id: string }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/share`,
			method: "POST",
			headers: this.headers({
				"Content-Type": "application/octet-stream",
				"X-Share-Expires": String(expiresAt),
			}),
			body: payload,
			throw: false,
		});
		if (res.status !== 200) throw new ApiError(res.status, `share create failed: HTTP ${res.status}`);
		return res.json as { id: string };
	}

	/**
	 * 拉取 checkpoint 链（v0.15 / §9）。
	 *
	 * 服务器只是转发者：它给出的 signingKeys 与 revokedDevices 仅用于**识别**，
	 * 绝不用于授信——信任集合由配对流程建立（§9.3）。
	 */
	async checkpoints(since: number): Promise<{
		repoEpoch: string;
		checkpoints: SignedCheckpoint[];
		conflicting: SignedCheckpoint[];
		signingKeys: Record<string, string>;
		revokedDevices: string[];
	}> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/checkpoints?since=${since}`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "checkpoints failed", res.text);
		const body = res.json as {
			repoEpoch: string;
			checkpoints: RawCheckpoint[];
			conflicting: RawCheckpoint[];
			signingKeys: Record<string, string>;
			revokedDevices: string[];
		};
		return {
			repoEpoch: body.repoEpoch,
			checkpoints: (body.checkpoints ?? []).map(parseCheckpoint),
			conflicting: (body.conflicting ?? []).map(parseCheckpoint),
			signingKeys: body.signingKeys ?? {},
			revokedDevices: body.revokedDevices ?? [],
		};
	}

	/** 发布本设备签名的 checkpoint。 */
	async publishCheckpoint(cp: SignedCheckpoint): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/checkpoint`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				hash: cp.hash,
				repoEpoch: cp.body.repoEpoch,
				headSequence: cp.body.headSequence,
				previousHash: cp.body.previousCheckpointHash,
				body: canonicalCheckpoint(cp.body),
				signature: cp.signature,
			}),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "publish checkpoint failed", res.text);
	}

	/** 名下仓库列表（v0.19 多仓库；设备凭据也可调——只列自己主人的）。 */
	async listVaults(): Promise<RemoteVault[]> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/vaults`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "list vaults failed", res.text);
		return ((res.json as { vaults?: RemoteVault[] }).vaults ?? []);
	}

	/** 新建仓库（v0.19；用户级 Token 专属，设备凭据会被拒）。 */
	async createVault(name: string): Promise<string> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/vaults`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ name }),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "create vault failed", res.text);
		return (res.json as { id: string }).id;
	}

	/** 重命名仓库（v0.19.x；用户级 Token 专属，只动展示名——身份/密钥/账本不受影响）。 */
	async renameVault(id: string, name: string): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/vaults/${encodeURIComponent(id)}`,
			method: "PATCH",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ name }),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "rename vault failed", res.text);
	}

	/**
	 * 登记重置凭证（v0.18 / v11 设计 §3.1）：resetKey = HKDF(VMK, "litesync/v1/token-reset-auth")。
	 * 服务端存 SHA-256——之后「重置 API Token」必须提交这个值，只拿到 Token 的
	 * 攻击者派生不出它。幂等；服务端已登记不同值时返回 409（RESET_AUTH_MISMATCH），
	 * 调用方按 code 分支决定是否提示。
	 */
	async registerResetAuth(resetAuth: string): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/vault/reset-auth`,
			method: "PUT",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ resetAuth }),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "register reset auth failed", res.text);
	}

	/** 登记本设备的 checkpoint 签名公钥（首次接入时一次）。 */
	async registerSigningKey(publicKeyB64: string): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/device/signing-key`,
			method: "PUT",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ publicKey: publicKeyB64 }),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "register signing key failed", res.text);
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
	 * 改名（协议 v6 / ADR-001 §3.4）：一次元数据更新。
	 *
	 * 服务器只改 pseudonym / canonical HMAC / metaGeneration——内容 blob、
	 * revision、contentGeneration 全部不动，**不产生任何 tombstone**。
	 * 412 = metaGeneration CAS 失败（并发改名，重取后重试）；
	 * 409 = 目标被 live 对象占用。目标名上只有 tombstone 时改名**放行**
	 *（0.17 实测修正）：那不是复活，删除事实按 fileId 保留——以前的 409
	 * 会把客户端逼进 delete+upsert 退化，历史嫁接到死对象身上。
	 */
	async rename(
		fromPath: string,
		toPath: string,
		baseMetaGeneration: number,
		meta?: { metaEnc: string; canonicalHash: string },
		operationId?: string,
	): Promise<{ fileId: string; toPath: string; revision: number; metaGeneration: number; sequence: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/file/rename`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json", ...this.opHeader(operationId) }),
			body: JSON.stringify({
				fromPath,
				toPath,
				baseMetaGeneration,
				metaEnc: meta?.metaEnc ?? "",
				canonicalHash: meta?.canonicalHash ?? "",
			}),
			throw: false,
		});
		if (res.status === 409) throw new ConflictError(parseConflict(res.text, toPath));
		if (res.status !== 200) throw apiError(res.status, `rename ${fromPath} -> ${toPath} failed`, res.text);
		return res.json as { fileId: string; toPath: string; revision: number; metaGeneration: number; sequence: number };
	}

	/**
	 * 显式恢复已删除对象（协议 v6 / ADR-002 §3.6）。
	 *
	 * v5 里「删除后重建」是拿 tombstone revision 做普通 upsert 穿透墓碑，
	 * 服务器分不清「用户真想恢复」与「陈旧设备把三个月前的副本传了回来」。
	 * v6 把它变成显式操作：恢复后 revision 连续、fileId 不变、历史全部仍可达。
	 * 随后再用返回的 revision 作为 baseRevision 上传新内容。
	 */
	async restore(
		fileId: string,
		params: {
			expectedTombstoneRevision: number;
			contentGeneration: number;
			pseudonym: string;
			metaEnc?: string;
			canonicalHash?: string;
		},
		operationId?: string,
	): Promise<{ fileId: string; path: string; revision: number; metaGeneration?: number; sequence: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/files/${encodeURIComponent(fileId)}/restore`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json", ...this.opHeader(operationId) }),
			body: JSON.stringify({
				expectedTombstoneRevision: params.expectedTombstoneRevision,
				contentGeneration: params.contentGeneration,
				pseudonym: params.pseudonym,
				metaEnc: params.metaEnc ?? "",
				canonicalHash: params.canonicalHash ?? "",
			}),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, `restore ${fileId} failed`, res.text);
		return res.json as { fileId: string; path: string; revision: number; metaGeneration?: number; sequence: number };
	}

	/** 信封升级完成：服务器验证全部 HEAD 为 LSE3 后把仓库下限提升到 3（ADR-006）。 */
	async completeEnvelopeUpgrade(): Promise<{ minimumEnvelopeVersion: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/envelope/complete`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: "{}",
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "envelope upgrade complete failed", res.text);
		return res.json as { minimumEnvelopeVersion: number };
	}

	// ---------- 元数据加密（协议 v6，ADR-003） ----------

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

	/** 续租迁移（计划书 §5.4）：owner 在长迁移中周期调用。 */
	async renewMigrationLease(): Promise<MigrationStatus> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/renew`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: "{}",
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "meta renew failed", res.text);
		return res.json as MigrationStatus;
	}

	/** 显式接管租约已过期的迁移（绝不自动发生，计划书 §5.4）。 */
	async takeoverMigration(migrationId: string): Promise<MigrationStatus> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/takeover`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ migrationId }),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "meta takeover failed", res.text);
		return res.json as MigrationStatus;
	}

	/** 迁移进度与状态（journal 汇总）。 */
	async metaStatus(): Promise<MigrationStatus> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/status`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "meta status failed", res.text);
		return res.json as MigrationStatus;
	}

	/** 单对象伪名化（幂等，断点续传安全）。 */
	async migrateObjectMeta(
		fromPath: string,
		metaEnc: string,
		canonicalHash: string,
	): Promise<{ fileId: string; fromPath: string; toPath: string; revision: number; metaGeneration: number }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/migrate`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ fromPath, metaEnc, canonicalHash }),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "meta migrate failed", res.text);
		return res.json as { fileId: string; fromPath: string; toPath: string; revision: number; metaGeneration: number };
	}

	/** 列出仍带明文寻址名的删除记录（迁移 owner 专用）。 */
	async listPlaintextTombstones(): Promise<PlaintextTombstone[]> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/tombstones`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "meta tombstones failed", res.text);
		return (res.json as { tombstones: PlaintextTombstone[] }).tombstones ?? [];
	}

	/**
	 * 把一条 tombstone 转成隐私格式（ADR-002 §3.2）。
	 * 明文寻址名换成 fileId、归一化路径换成客户端 HMAC——**删除屏障完整保留**，
	 * 这正是 v0.12.0「删掉 tombstone 抹明文」造成静默复活的正解。
	 */
	async migrateTombstone(fileId: string, canonicalHash: string): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/migrate-tombstone`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ fileId, canonicalHash }),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "tombstone migrate failed", res.text);
	}

	/** 预检：只跑服务端验证器，不改状态。 */
	async validateMetaMigration(): Promise<{ ok: boolean; failures: ValidationFailure[] }> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/validate`,
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200) throw apiError(res.status, "meta validate failed", res.text);
		const body = res.json as { ok: boolean; failures: ValidationFailure[] };
		return { ok: body.ok, failures: body.failures ?? [] };
	}

	/**
	 * 元数据迁移状态机（协议 v6 / ADR-003）。
	 *
	 *   begin    plain → migrating
	 *   verify   migrating → verifying（journal 必须清空；此后只接受验证与 complete）
	 *   complete verifying → encrypted（跑 11 项验证器 → 擦除，单向，必须显式确认）
	 *   abort    migrating/verifying → plain（无破坏性操作）
	 */
	async metaTransition(action: "begin" | "verify" | "abort"): Promise<MigrationStatus>;
	async metaTransition(action: "complete", confirmErase: true, migrationId?: string): Promise<MigrationStatus>;
	async metaTransition(
		action: "begin" | "verify" | "complete" | "abort",
		confirmErase?: boolean,
		migrationId?: string,
	): Promise<MigrationStatus> {
		const res = await requestUrl({
			url: `${this.base()}/api/v1/meta/${action}`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body:
				action === "complete"
					? JSON.stringify({ confirmErase: confirmErase === true, migrationId: migrationId ?? "" })
					: "{}",
			throw: false,
		});
		if (res.status !== 200) throw metaTransitionError(res.status, action, res.text);
		return res.json as MigrationStatus;
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
		fileId: typeof body?.fileId === "string" ? body.fileId : undefined,
		contentGeneration: typeof body?.contentGeneration === "number" ? body.contentGeneration : undefined,
	};
}

/** 提取服务器错误响应中的说明文字（附加到 ApiError message）。 */
function serverErrText(text: string): string {
	const body = tryJson(text);
	const msg = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : "";
	const extra = typeof body?.existing === "string" ? `（与现有文件冲突：${body.existing}）` : "";
	return msg ? ` — ${msg}${extra}` : "";
}

/** meta 状态机错误：验证失败时抽出完整清单，其余按普通 ApiError 处理。 */
function metaTransitionError(status: number, action: string, text: string): Error {
	const body = tryJson(text);
	if (body?.code === "MIGRATION_VALIDATION_FAILED" && Array.isArray(body.failures)) {
		return new MigrationValidationError(body.failures as ValidationFailure[]);
	}
	return apiError(status, `meta ${action} failed`, text);
}

/** 统一构造带机器错误码的 ApiError（v0.12.1 / LS-121-S05）。 */
function apiError(status: number, prefix: string, text: string): ApiError {
	const body = tryJson(text);
	return new ApiError(
		status,
		`${prefix}: HTTP ${status}${serverErrText(text)}`,
		typeof body?.code === "string" ? body.code : undefined,
		typeof body?.retryable === "boolean" ? body.retryable : undefined,
		typeof body?.existing === "string" ? body.existing : undefined,
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


/** 服务器返回的 checkpoint 原始形态（body 是 canonical 原文）。 */
interface RawCheckpoint {
	hash: string;
	repoEpoch: string;
	headSequence: number;
	previousHash: string;
	signingDeviceId: string;
	body: string;
	signature: string;
}

/**
 * 把 canonical 原文解析回结构（v0.15）。
 *
 * 解析出来的 body 会被重新 canonical 化用于验签，因此只要解析与序列化互为逆运算，
 * 服务器就无法通过「改一个它以为无关紧要的字段」蒙混过关——任何差异都会让
 * 重新算出的 canonical 与被签名的原文不同，验签直接失败。
 */
function parseCheckpoint(raw: RawCheckpoint): SignedCheckpoint {
	const kv = new Map<string, string>();
	for (const line of raw.body.split(/\r?\n/)) {
		const i = line.indexOf("=");
		if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1));
	}
	const num = (k: string): number => Number(kv.get(k) ?? 0);
	return {
		hash: raw.hash,
		signature: raw.signature,
		body: {
			version: 1,
			vaultId: kv.get("vault") ?? "",
			repoEpoch: kv.get("repoEpoch") ?? "",
			formatEpoch: num("formatEpoch"),
			keyEpoch: num("keyEpoch"),
			headSequence: num("head"),
			objectsRoot: kv.get("root") ?? "",
			objectCount: num("count"),
			previousCheckpointHash: kv.get("prev") ?? "",
			signingDeviceId: kv.get("device") ?? "",
			timestamp: num("ts"),
		},
	};
}
