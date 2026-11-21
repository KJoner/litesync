/**
 * 「用本地完整替换远端」测试用的内存服务端与内存 Vault（0.20.1 起多个测试文件共用）。
 *
 * 服务端按真实协议建模（对照 litesync-server internal/sync/service.go Upload、restore.go Restore、
 * Delete，只读参考，固定版本 7c30b8a）：
 *   - revision CAS；内容与 HEAD 相同的幂等短路 ①；同一 (fileId, operationId) 返回首次结果 ②；
 *   - LSE3 generation 单调（只看带信封头的载荷）；
 *   - 墓碑挡住普通上传（按寻址名或 canonical 键），冲突里带 fileId / 删除 revision / 删除时世代 / priorHash；
 *   - **元数据加密态**（metaState=encrypted）：寻址名必须是 32 位 hex 伪名；新建（当前没有 live 对象）
 *     必须携带 metaEnc + canonicalHash，且客户端预生成的 fileId 必须等于寻址名——否则 400 META_REQUIRED。
 *     这条检查在墓碑检查**之前**（与真实服务端顺序一致）；
 *   - 显式恢复：meta 态要求 pseudonym == fileId 且带元数据；按 operationId 幂等；墓碑 revision 必须吻合
 *     （412 STALE_REVISION）；内容世代必须严格大于删除时（409）；恢复后 revision+1、metaGeneration=墓碑+1、
 *     HEAD 内容为删除前那一版；对象已 live 时返回当前 revision 而不带 sequence。
 *
 * 故障注入：loseResponseOnWrite = 第 n 次写入（上传 / 删除 / 恢复）在**提交之后**抛网络错误（响应丢失）。
 * requests 记下每个请求，用来断言「零写入」。
 */
import {
	ApiError,
	ConflictError,
	DownloadResult,
	NotFoundError,
	RemoteChange,
	SnapshotFile,
	UploadOk,
} from "../../src/api/client";
import {
	canonicalPathHmac,
	encryptFileV3,
	encryptMeta,
	MetaKeys,
	newFileId,
	parseLse3Header,
} from "../../src/crypto/crypto";
import { Keyring } from "../../src/crypto/keyring";
import { StateStore } from "../../src/state/store";
import type { SyncContext } from "../../src/sync/context";
import { SyncGate } from "../../src/sync/gate";
import { PendingQueue } from "../../src/sync/queue";
import { sha256Hex } from "../../src/utils/hash";
import { platformCollisionKey } from "../../src/utils/vault-path";

export const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
export const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

export interface Head {
	fileId: string;
	revision: number;
	hash: string;
	data: ArrayBuffer;
	deleted: boolean;
	generation: number;
	priorHash?: string;
	metaEnc?: string;
	metaGeneration: number;
	canonical: string;
}

interface Change extends RemoteChange {
	operationId?: string;
	metaGeneration?: number;
}

const isHex32 = (s: string): boolean => /^[0-9a-f]{32}$/.test(s);

export class FakeServer {
	/** 键 = 服务器寻址名（明文态为路径，meta 态为伪名 = fileId） */
	heads = new Map<string, Head>();
	seq = 0;
	changes: Change[] = [];
	ops = new Map<string, UploadOk>();
	writes = 0;
	/** 故障注入：第 n 次写入在**提交之后**抛网络错误（模拟响应丢失） */
	loseResponseOnWrite = -1;
	/** 故障注入：第 n 次写入在**到达服务器之前**失败（什么都没提交） */
	failBeforeWrite = -1;
	vaultId = "a".repeat(32);
	repoEpoch = "epoch-1";
	metaState: "plain" | "encrypted" = "plain";
	/** false = 模拟 0.20 之前的服务端：没有 GET /api/v1/trash（404） */
	trashAvailable = true;
	requests: Array<{ op: string; path: string }> = [];

	private record(path: string, h: Head, action: RemoteChange["action"], operationId?: string): number {
		this.seq++;
		this.changes.push({
			sequence: this.seq,
			path,
			fileId: h.fileId,
			action,
			revision: h.revision,
			hash: h.hash,
			operationId,
			metaGeneration: h.metaGeneration,
		});
		return this.seq;
	}

	private beforeWrite(): void {
		if (this.writes + 1 === this.failBeforeWrite) {
			this.writes++;
			throw new Error("network: connection reset before the request reached the server");
		}
	}

	private maybeLose(): void {
		this.writes++;
		if (this.writes === this.loseResponseOnWrite) throw new Error("network: response lost");
	}

	/** 写入次数（不含故障注入里「没到服务器」的那次）与写请求列表。 */
	writeRequests(): Array<{ op: string; path: string }> {
		return this.requests.filter((r) => r.op === "upload" || r.op === "remove" || r.op === "restore" || r.op === "rename");
	}

	private findTombstone(path: string, canonical: string): Head | undefined {
		const byName = this.heads.get(path);
		if (byName?.deleted) return byName;
		for (const h of this.heads.values()) if (h.deleted && h.canonical === canonical) return h;
		return undefined;
	}

	/** 明文仓库的种子文件（服务器分配身份）。 */
	async seedAsync(path: string, content: string): Promise<Head> {
		const data = enc(content);
		this.seq++;
		const h: Head = {
			fileId: newFileId(),
			revision: 1,
			hash: await sha256Hex(data),
			data,
			deleted: false,
			generation: 0,
			metaGeneration: 0,
			canonical: platformCollisionKey(path),
		};
		this.heads.set(path, h);
		this.changes.push({ sequence: this.seq, path, fileId: h.fileId, action: "upsert", revision: 1 });
		return h;
	}

	/**
	 * E2EE 仓库的种子文件：LSE3 密文（AAD 绑定 vaultId + keyEpoch + fileId + generation=1）；
	 * meta 态再加 LSM1 元数据与 canonical HMAC，寻址名为伪名。返回 [寻址名, head]。
	 */
	async seedE2ee(path: string, content: string, vmk: CryptoKey, keys: MetaKeys): Promise<[string, Head]> {
		const fileId = newFileId();
		const binding = { vaultId: this.vaultId, keyEpoch: 1, fileId, generation: 1 };
		const data = await encryptFileV3(vmk, binding, enc(content));
		const meta = this.metaState === "encrypted";
		const h: Head = {
			fileId,
			revision: 1,
			hash: await sha256Hex(data),
			data,
			deleted: false,
			generation: 1,
			metaEnc: meta ? await encryptMeta(keys, { ...binding, metaGeneration: 1 }, { path }) : undefined,
			metaGeneration: meta ? 1 : 0,
			canonical: meta ? `h:${await canonicalPathHmac(keys, path)}` : platformCollisionKey(path),
		};
		const key = meta ? fileId : path;
		this.seq++;
		this.heads.set(key, h);
		this.changes.push({ sequence: this.seq, path: key, fileId, action: "upsert", revision: 1 });
		return [key, h];
	}

	client() {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- 闭包里需要服务端实例
		const srv = this;
		return {
			async info() {
				return {
					version: "fake",
					latestSequence: srv.seq,
					headSequence: srv.seq,
					serverTime: 0,
					vaultId: srv.vaultId,
					repoEpoch: srv.repoEpoch,
					keyEpoch: 1,
					formatEpoch: 1,
					protocolVersion: 6,
					minProtocolVersion: 6,
					metaState: srv.metaState,
				};
			},
			async snapshot(): Promise<{ sequence: number; files: SnapshotFile[]; repoEpoch: string }> {
				srv.requests.push({ op: "snapshot", path: "" });
				const files: SnapshotFile[] = [];
				for (const [path, h] of srv.heads) {
					if (h.deleted) continue;
					files.push({
						path,
						revision: h.revision,
						hash: h.hash,
						size: h.data.byteLength,
						mtime: 1,
						fileId: h.fileId,
						metaEnc: h.metaEnc,
						metaGeneration: h.metaEnc ? h.metaGeneration : undefined,
						contentGeneration: h.generation,
					});
				}
				return { sequence: srv.seq, files, repoEpoch: srv.repoEpoch };
			},
			async download(path: string): Promise<DownloadResult> {
				srv.requests.push({ op: "download", path });
				const h = srv.heads.get(path);
				if (!h || h.deleted) throw new NotFoundError(h?.deleted ?? false, h?.revision ?? 0);
				return {
					data: h.data.slice(0),
					revision: h.revision,
					hash: h.hash,
					size: h.data.byteLength,
					mtime: 1,
					fileId: h.fileId,
					metaEnc: h.metaEnc,
					metaGeneration: h.metaEnc ? h.metaGeneration : undefined,
				};
			},
			async upload(
				path: string,
				base: number,
				hash: string,
				data: ArrayBuffer,
				_mtime: number,
				_action: string,
				fileId?: string,
				meta?: { metaEnc: string; canonicalHash: string },
				operationId?: string,
			): Promise<UploadOk> {
				srv.requests.push({ op: "upload", path });
				srv.beforeWrite();
				const header = parseLse3Header(data);
				const gen = header?.generation ?? 0;
				const metaMode = srv.metaState === "encrypted";
				if (metaMode && !isHex32(path)) throw new ApiError(400, "upload: meta required (pseudonym)", "META_REQUIRED");
				const existing = srv.heads.get(path);
				const cur = existing && !existing.deleted ? existing : undefined;
				// service.go:508-519：元数据加密态下新建必须带 metaEnc + canonicalHash，且 fileId 等于寻址名
				if (metaMode && cur === undefined) {
					if (!meta?.metaEnc || !meta?.canonicalHash) {
						throw new ApiError(400, "upload: metadata required", "META_REQUIRED");
					}
					if (fileId !== undefined && fileId !== path) throw new ApiError(400, "upload: pseudonym must equal fileId", "META_REQUIRED");
					fileId = path;
				}
				// 幂等 ①：内容与当前 HEAD 一致
				if (cur && cur.hash === hash) {
					return {
						path,
						revision: cur.revision,
						hash: cur.hash,
						size: data.byteLength,
						sequence: srv.seq,
						fileId: cur.fileId,
						contentGeneration: cur.generation,
						metaGeneration: cur.metaGeneration,
					};
				}
				// 幂等 ②：同一 operationId 返回首次结果
				if (cur && operationId) {
					const prev = srv.ops.get(`${cur.fileId}:${operationId}`);
					if (prev) return prev;
				}
				if (cur && header && cur.generation > 0 && gen <= cur.generation) {
					throw new ConflictError({ path, revision: cur.revision, hash: cur.hash, deleted: false, fileId: cur.fileId });
				}
				const canonical = meta?.canonicalHash ? `h:${meta.canonicalHash}` : cur ? cur.canonical : platformCollisionKey(path);
				let ok: UploadOk;
				if (!cur) {
					// 防复活必须先于 baseRevision 判断（service.go）
					const tomb = srv.findTombstone(path, canonical);
					if (tomb) {
						throw new ConflictError({
							path,
							revision: tomb.revision,
							hash: "",
							deleted: true,
							priorHash: tomb.priorHash,
							fileId: tomb.fileId,
							contentGeneration: tomb.generation,
						});
					}
					if (base !== 0) throw new ConflictError({ path, revision: 0, hash: "", deleted: false });
					for (const [p, h] of srv.heads) {
						if (!h.deleted && h.canonical === canonical) throw new ApiError(422, `collision with ${p}`, "CANONICAL_COLLISION", false, p);
					}
					const id = fileId ?? newFileId();
					for (const h of srv.heads.values()) {
						if (h.fileId === id) throw new ApiError(409, "file id in use", "FILE_ID_CONFLICT");
					}
					const h: Head = {
						fileId: id,
						revision: 1,
						hash,
						data,
						deleted: false,
						generation: gen,
						metaEnc: meta?.metaEnc,
						metaGeneration: meta?.metaEnc ? 1 : 0,
						canonical,
					};
					srv.heads.set(path, h);
					const sequence = srv.record(path, h, "upsert", operationId);
					ok = { path, revision: 1, hash, size: data.byteLength, sequence, fileId: h.fileId, contentGeneration: gen, metaGeneration: h.metaGeneration };
					if (operationId) srv.ops.set(`${h.fileId}:${operationId}`, ok);
				} else {
					if (base !== cur.revision) {
						throw new ConflictError({ path, revision: cur.revision, hash: cur.hash, deleted: false, fileId: cur.fileId });
					}
					cur.revision++;
					cur.hash = hash;
					cur.data = data;
					cur.canonical = canonical;
					if (header) cur.generation = gen;
					const sequence = srv.record(path, cur, "upsert", operationId);
					ok = {
						path,
						revision: cur.revision,
						hash,
						size: data.byteLength,
						sequence,
						fileId: cur.fileId,
						contentGeneration: cur.generation,
						metaGeneration: cur.metaGeneration,
					};
					if (operationId) srv.ops.set(`${cur.fileId}:${operationId}`, ok);
				}
				srv.maybeLose();
				return ok;
			},
			async remove(path: string, base: number) {
				srv.requests.push({ op: "remove", path });
				srv.beforeWrite();
				if (srv.metaState === "encrypted" && !isHex32(path)) throw new ApiError(400, "remove: meta required (pseudonym)", "META_REQUIRED");
				const cur = srv.heads.get(path);
				if (!cur) throw new NotFoundError();
				if (cur.deleted) throw new ConflictError({ path, revision: cur.revision, hash: "", deleted: true, fileId: cur.fileId });
				if (base !== cur.revision) {
					throw new ConflictError({ path, revision: cur.revision, hash: cur.hash, deleted: false, fileId: cur.fileId });
				}
				cur.revision++;
				cur.deleted = true;
				cur.priorHash = cur.hash;
				const sequence = srv.record(path, cur, "delete");
				srv.maybeLose();
				return { revision: cur.revision, sequence };
			},
			async restore(
				fileId: string,
				params: { expectedTombstoneRevision: number; contentGeneration: number; pseudonym: string; metaEnc?: string; canonicalHash?: string },
				operationId?: string,
			) {
				srv.requests.push({ op: "restore", path: params.pseudonym });
				srv.beforeWrite();
				if (srv.metaState === "encrypted") {
					if (params.pseudonym !== fileId) throw new ApiError(400, "restore: pseudonym must equal fileId", "META_REQUIRED");
					if (!params.metaEnc || !params.canonicalHash) throw new ApiError(400, "restore: metadata required", "META_REQUIRED");
				}
				// 幂等：同一 operationId 已提交过 → 返回那次结果
				if (operationId) {
					const prev = srv.changes.find((c) => c.fileId === fileId && c.operationId === operationId);
					if (prev) return { fileId, path: prev.path, revision: prev.revision, metaGeneration: prev.metaGeneration, sequence: prev.sequence };
				}
				let key: string | undefined;
				let h: Head | undefined;
				for (const [k, v] of srv.heads) {
					if (v.fileId === fileId) {
						key = k;
						h = v;
					}
				}
				if (!h || key === undefined) throw new ApiError(404, "restore: unknown fileId", "NOT_FOUND");
				if (!h.deleted) return { fileId, path: key, revision: h.revision, metaGeneration: h.metaGeneration, sequence: 0 };
				if (params.expectedTombstoneRevision !== h.revision) throw new ApiError(412, "restore: stale tombstone revision", "STALE_REVISION");
				if (h.generation > 0 && params.contentGeneration <= h.generation) throw new ApiError(409, "restore: generation conflict", "CONFLICT");
				// 恢复目标名不能与现有 live 对象冲突（restore.go FindCanonicalCollision / GetHeadByPseudonym）
				const canonical = params.canonicalHash ? `h:${params.canonicalHash}` : platformCollisionKey(params.pseudonym);
				for (const [p, o] of srv.heads) {
					if (o !== h && !o.deleted && (o.canonical === canonical || p === params.pseudonym)) {
						throw new ApiError(422, `restore: collision with ${p}`, "CANONICAL_COLLISION", false, p);
					}
				}
				h.deleted = false;
				h.revision++;
				h.generation = params.contentGeneration;
				h.hash = h.priorHash ?? "";
				h.metaGeneration = h.metaGeneration + 1;
				if (params.metaEnc) h.metaEnc = params.metaEnc;
				h.canonical = canonical;
				// 恢复后的寻址名以请求为准（真实服务端 UpsertHead 按 fileId 落新 pseudonym：恢复可以顺带改名）
				if (params.pseudonym !== key) {
					srv.heads.delete(key);
					srv.heads.set(params.pseudonym, h);
					key = params.pseudonym;
				}
				const sequence = srv.record(key, h, "restore", operationId);
				srv.maybeLose();
				return { fileId, path: key, revision: h.revision, metaGeneration: h.metaGeneration, sequence };
			},
			/**
			 * 改名 = 元数据更新（rename.go）：meta 态寻址名不变、必带元数据；CAS 以 metaGeneration 为前提，
			 * **先 CAS 再查幂等键**（与真实服务端一致——提交后响应丢失的重放会 412）；revision 不变，元数据世代 +1。
			 */
			async rename(
				fromPath: string,
				toPath: string,
				baseMetaGeneration: number,
				meta?: { metaEnc: string; canonicalHash: string },
				operationId?: string,
			) {
				srv.requests.push({ op: "rename", path: fromPath });
				srv.beforeWrite();
				const metaMode = srv.metaState === "encrypted";
				if (metaMode) {
					if (fromPath !== toPath) throw new ApiError(400, "rename: pseudonym must not change", "META_REQUIRED");
					if (!meta?.metaEnc || !meta?.canonicalHash) throw new ApiError(400, "rename: metadata required", "META_REQUIRED");
				} else if (meta?.metaEnc) {
					throw new ApiError(409, "rename: metadata in plain state", "ENCRYPTION_STATE");
				}
				const cur = srv.heads.get(fromPath);
				if (!cur || cur.deleted) throw new ApiError(404, "rename: not found", "NOT_FOUND");
				if (cur.metaGeneration !== baseMetaGeneration) {
					throw new ApiError(412, "rename: metadata generation mismatch", "STALE_META_GENERATION");
				}
				if (operationId) {
					const prev = srv.changes.find((c) => c.fileId === cur.fileId && c.operationId === operationId);
					if (prev) return { fileId: cur.fileId, toPath: prev.path, revision: prev.revision, metaGeneration: prev.metaGeneration ?? 0, sequence: prev.sequence };
				}
				const canonical = meta?.canonicalHash ? `h:${meta.canonicalHash}` : platformCollisionKey(toPath);
				for (const [p, o] of srv.heads) {
					if (o !== cur && !o.deleted && o.canonical === canonical) throw new ApiError(422, `rename: collision with ${p}`, "CANONICAL_COLLISION", false, p);
				}
				let key = fromPath;
				if (!metaMode && toPath !== fromPath) {
					const occupied = srv.heads.get(toPath);
					if (occupied && !occupied.deleted) {
						throw new ConflictError({ path: toPath, revision: occupied.revision, hash: occupied.hash, deleted: false, fileId: occupied.fileId });
					}
					srv.heads.delete(fromPath);
					srv.heads.set(toPath, cur);
					key = toPath;
				}
				cur.metaGeneration++;
				if (meta?.metaEnc) cur.metaEnc = meta.metaEnc;
				cur.canonical = canonical;
				const sequence = srv.record(key, cur, "upsert", operationId);
				srv.maybeLose();
				return { fileId: cur.fileId, toPath: key, revision: cur.revision, metaGeneration: cur.metaGeneration, sequence };
			},
			async getFileMeta(path: string) {
				srv.requests.push({ op: "meta", path });
				const h = srv.heads.get(path);
				if (!h || h.deleted) throw new NotFoundError(h?.deleted ?? false, h?.revision ?? 0);
				return { path, fileId: h.fileId, revision: h.revision, metaEnc: h.metaEnc ?? "", metaGeneration: h.metaGeneration };
			},
			async version(): Promise<DownloadResult> {
				throw new NotFoundError(); // 历史已裁剪：按同名新内容处理
			},
			async trash() {
				if (!srv.trashAvailable) throw new ApiError(404, "trash: not found", "NOT_FOUND");
				const out = [];
				for (const [path, h] of srv.heads) {
					if (!h.deleted) continue;
					out.push({
						fileId: h.fileId,
						path,
						deletionRevision: h.revision,
						contentGeneration: h.generation,
						metaGeneration: h.metaGeneration,
						restorable: true,
					});
				}
				return out;
			},
			async changes(since: number) {
				const list = srv.changes.filter((c) => c.sequence > since);
				return { latestSequence: srv.seq, hasMore: false, changes: list };
			},
		};
	}
}

/**
 * 内存 Vault：用户文件 + 插件目录（恢复点写在这里）。
 * caseInsensitive：模拟 Windows / macOS 的文件系统——stat / 读写不区分大小写，文件清单里是确切的名字。
 */
export class MemVault {
	files = new Map<string, ArrayBuffer>();
	dirs = new Set<string>();
	constructor(private opts: { caseInsensitive?: boolean } = {}) {}
	private key(p: string): string | undefined {
		if (this.files.has(p)) return p;
		if (!this.opts.caseInsensitive) return undefined;
		const lower = p.toLowerCase();
		return [...this.files.keys()].find((k) => k.toLowerCase() === lower);
	}
	adapter = {
		stat: async (p: string) => {
			const k = this.key(p);
			return k !== undefined ? { type: "file", mtime: 1000, size: this.files.get(k)!.byteLength } : null;
		},
		readBinary: async (p: string) => {
			const k = this.key(p);
			const d = k !== undefined ? this.files.get(k) : undefined;
			if (!d) throw new Error(`no such file ${p}`);
			return d.slice(0);
		},
		writeBinary: async (p: string, d: ArrayBuffer) => void this.files.set(this.key(p) ?? p, d.slice(0)),
		write: async (p: string, d: string) => void this.files.set(this.key(p) ?? p, enc(d)),
		exists: async (p: string) => this.key(p) !== undefined || this.dirs.has(p),
		mkdir: async (p: string) => void this.dirs.add(p),
		read: async (p: string) => dec(this.files.get(this.key(p) ?? p)!),
	};
	put(path: string, content: string): void {
		this.files.set(path, enc(content));
	}
	userFiles(): { path: string }[] {
		return [...this.files.keys()].filter((p) => !p.startsWith(".obsidian/") && !p.startsWith("state:")).map((path) => ({ path }));
	}
}

/** 状态文件适配器：写进 MemVault 的 state: 前缀下——「重启」= 用同一个 MemVault 再 new 一个 StateStore。 */
export function stateAdapter(vault: MemVault): ConstructorParameters<typeof StateStore>[0] {
	return {
		exists: async (p: string) => vault.files.has(`state:${p}`),
		read: async (p: string) => dec(vault.files.get(`state:${p}`)!),
		write: async (p: string, d: string) => void vault.files.set(`state:${p}`, enc(d)),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

export async function makeCtx(
	server: FakeServer,
	vault: MemVault,
	keyring = new Keyring(),
	opts: { metaState?: "plain" | "encrypted"; bootstrap?: "ready" | "pending"; loadOnly?: boolean } = {},
): Promise<SyncContext> {
	const store = new StateStore(stateAdapter(vault), "state.json");
	await store.load();
	if (!opts.loadOnly) {
		store.state.bootstrap = {
			status: opts.bootstrap ?? "ready",
			mode: "merge",
			remoteVaultId: server.vaultId,
			repoEpoch: server.repoEpoch,
			keyEpoch: 1,
			formatEpoch: 1,
			minimumEnvelopeVersion: 3,
			metaState: opts.metaState ?? server.metaState,
			completedAt: 0,
		};
	}
	const gate = new SyncGate();
	// 已接入的设备在作业之前做过一次 fullSync：绑定校验已完成
	if ((opts.bootstrap ?? "ready") === "ready") gate.markBound();
	return {
		app: { vault: { adapter: vault.adapter, configDir: ".obsidian", getFiles: () => vault.userFiles() } },
		client: server.client(),
		store,
		queue: new PendingQueue(),
		gate,
		e2ee: keyring,
		ignores: (p: string) => p.startsWith(".trash/") || p.startsWith(".obsidian/") || p.startsWith("state:"),
		padsSize: () => false,
		reportedMtime: (ms: number) => ms,
		pluginDir: () => ".obsidian/plugins/litesync",
		log: () => {},
		notify: () => {},
		onConflictsChanged: () => {},
		syncObsidian: () => false,
		deviceName: () => "test",
		credentials: () => ({ serverUrl: "https://s", apiToken: "t", vaultChoice: "" }),
		refreshE2ee: async () => {},
	} as unknown as SyncContext;
}
