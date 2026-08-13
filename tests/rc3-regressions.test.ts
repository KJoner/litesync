// 0.17.0-rc.3 回归测试：验收手册实测发现的缺陷（T2.2 / T2.3 / T3.2 / T3.5）。
//
// 覆盖：
//   T3.2  明文模式按 fileId 检测改名（v6 改名不发 delete——认不出改名 = 旧文件成孤儿）
//   T3.2  rename + edit：先改名再写内容，新旧路径不并存
//   T3.5  纯大小写/归一化改名：目标 stat 命中自己 ≠ 目标被占用（两步探测消歧）
//   resync 全量对账：改名不退化为「trash + 全量重下载」，名字互换可收敛
//   T2.2  restore 后的世代记账：重传内容的 generation 必须在恢复世代之上
//   T2.3  合并保存以刚下载的远端世代为下限（tracked 落后时不再被服务器按回退拒绝）
//
// INV: INV-03（本地内容不被静默覆盖）/ INV-05（对象身份稳定）/ INV-06（删除事实保留）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { ConflictError, DownloadResult, NotFoundError } from "../src/api/client";
import {
	createVaultKeyDoc,
	decryptShare,
	encryptFileV3,
	encryptShare,
	frameShareBundle,
	parseLse3Header,
	randomBytes,
	unframeShareBundle,
} from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { attemptAutoMerge } from "../src/sync/auto-merge";
import { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { LocalCommitter } from "../src/sync/local-commit";
import { pullRemoteChanges } from "../src/sync/pull";
import { pushPendingChanges } from "../src/sync/push";
import { PendingQueue } from "../src/sync/queue";
import { uploadFromPlain } from "../src/sync/transfer";
import { sha256Hex } from "../src/utils/hash";

const VAULT_ID = "vault-0123456789ab";
const PLUGIN_DIR = ".obsidian/plugins/litesync";
const FA = "a".repeat(32);
const FB = "b".repeat(32);

function memAdapter() {
	const files = new Map<string, string>();
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

/** 内存 Vault：rename 对已存在目标抛 EEXIST（贴近真实 adapter 语义）。 */
function memVault() {
	const files = new Map<string, ArrayBuffer>();
	const folders = new Set<string>();
	const adapter = {
		exists: async (p: string) => files.has(p) || folders.has(p),
		mkdir: async (p: string) => void folders.add(p),
		stat: async (p: string) =>
			files.has(p)
				? { type: "file" as const, mtime: 1, size: files.get(p)!.byteLength }
				: folders.has(p)
					? { type: "folder" as const, mtime: 1, size: 0 }
					: null,
		readBinary: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`ENOENT ${p}`);
			return v;
		},
		writeBinary: async (p: string, d: ArrayBuffer) => void files.set(p, d.slice(0)),
		rename: async (from: string, to: string) => {
			const v = files.get(from);
			if (v === undefined) throw new Error(`ENOENT ${from}`);
			files.delete(from);
			files.set(to, v);
		},
		remove: async (p: string) => void files.delete(p),
		list: async () => ({ files: [] as string[], folders: [] as string[] }),
	};
	return { files, adapter };
}

/** 大小写不敏感的内存 Vault（macOS/Windows/Android 语义）：按折叠键寻址，保留原始名。 */
function ciMemVault() {
	const files = new Map<string, { name: string; data: ArrayBuffer }>();
	const key = (p: string) => p.toLowerCase();
	const adapter = {
		exists: async (p: string) => files.has(key(p)),
		mkdir: async () => {},
		stat: async (p: string) => {
			const e = files.get(key(p));
			return e ? { type: "file" as const, mtime: 1, size: e.data.byteLength } : null;
		},
		readBinary: async (p: string) => {
			const e = files.get(key(p));
			if (!e) throw new Error(`ENOENT ${p}`);
			return e.data;
		},
		writeBinary: async (p: string, d: ArrayBuffer) => void files.set(key(p), { name: p, data: d.slice(0) }),
		rename: async (from: string, to: string) => {
			const e = files.get(key(from));
			if (!e) throw new Error(`ENOENT ${from}`);
			files.delete(key(from));
			files.set(key(to), { name: to, data: e.data });
		},
		remove: async (p: string) => void files.delete(key(p)),
		list: async () => ({ files: [] as string[], folders: [] as string[] }),
	};
	return { files, adapter };
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);

async function plainStore(): Promise<StateStore> {
	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	store.state.bootstrap = {
		status: "ready",
		mode: "merge",
		remoteVaultId: VAULT_ID,
		repoEpoch: "epoch-1",
		keyEpoch: 1,
		formatEpoch: 1,
		minimumEnvelopeVersion: 3,
		metaState: "plain",
		completedAt: 0,
	};
	return store;
}

async function unlockedKeyring(): Promise<Keyring> {
	const { doc, vmk } = await createVaultKeyDoc("pw-rc3");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);
	return keyring;
}

interface CtxParts {
	store: StateStore;
	vault: ReturnType<typeof memVault> | ReturnType<typeof ciMemVault>;
	client: unknown;
	keyring?: Keyring;
	queue?: PendingQueue;
}

function ctxOf(parts: CtxParts): SyncContext {
	return {
		app: { vault: { adapter: parts.vault.adapter } },
		store: parts.store,
		queue: parts.queue ?? new PendingQueue(),
		gate: new SyncGate(),
		e2ee: parts.keyring ?? new Keyring(),
		committer: new LocalCommitter({ vault: { adapter: parts.vault.adapter } } as never, PLUGIN_DIR),
		client: parts.client,
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		padsSize: () => false,
		reportedMtime: (m: number) => m,
		syncObsidian: () => false,
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;
}

// ---------------------------------------------------------------- T3.2 明文改名

test("T3.2: 明文模式纯改名 → 本地 rename，不下载、不留孤儿", async () => {
	const store = await plainStore();
	const vault = memVault();
	vault.files.set("sync-a.md", bytes("内容"));
	store.replaceWithNewObject("sync-a.md", {
		hash: "h1", serverHash: "s1", revision: 1, mtime: 1, size: 2, fileId: FA, metaGeneration: 1,
	});

	let downloads = 0;
	const ctx = ctxOf({
		store,
		vault,
		client: {
			changes: async (since: number) => ({
				latestSequence: 2,
				hasMore: false,
				changes:
					since === 0
						? [{ sequence: 2, path: "sync-renamed.md", fileId: FA, action: "upsert", revision: 1, hash: "s1", metaGeneration: 2 }]
						: [],
			}),
			download: async () => {
				downloads++;
				throw new Error("纯改名不应产生任何下载");
			},
		},
	});

	const r = await pullRemoteChanges(ctx);
	assert.equal(r.applied, 1);
	assert.equal(downloads, 0, "纯改名（hash 未变）绝不下载内容");
	assert.ok(vault.files.has("sync-renamed.md"), "本地文件应改名");
	assert.ok(!vault.files.has("sync-a.md"), "旧路径不得残留（T3.2 的失败形态就是新旧名各一）");
	const moved = store.get("sync-renamed.md");
	assert.equal(moved?.fileId, FA, "身份不变（INV-05）");
	assert.equal(moved?.metaGeneration, 2);
	assert.equal(store.get("sync-a.md"), undefined);
	assert.equal(store.state.lastSequence, 2);
});

test("T3.2: rename + edit → 先改名再写内容，最终只有新路径一份新内容", async () => {
	const store = await plainStore();
	const vault = memVault();
	const oldData = bytes("旧内容");
	vault.files.set("sync-a.md", oldData);
	store.replaceWithNewObject("sync-a.md", {
		hash: await sha256Hex(oldData), serverHash: "s1", revision: 1, mtime: 1, size: oldData.byteLength,
		fileId: FA, metaGeneration: 1,
	});

	const newData = bytes("新内容");
	const ctx = ctxOf({
		store,
		vault,
		client: {
			changes: async (since: number) => ({
				latestSequence: 3,
				hasMore: false,
				changes:
					since === 0
						? [{ sequence: 3, path: "sync-renamed.md", fileId: FA, action: "upsert", revision: 2, hash: "s2", metaGeneration: 2 }]
						: [],
			}),
			download: async (p: string): Promise<DownloadResult> => {
				assert.equal(p, "sync-renamed.md", "内容必须按新路径下载");
				return { data: newData, revision: 2, hash: "", size: newData.byteLength, mtime: 5, fileId: FA };
			},
		},
	});

	const r = await pullRemoteChanges(ctx);
	assert.equal(r.applied, 1);
	assert.ok(!vault.files.has("sync-a.md"), "旧路径不得残留");
	assert.equal(text(vault.files.get("sync-renamed.md")!), "新内容", "新路径承载新内容");
	assert.equal(store.get("sync-renamed.md")?.fileId, FA, "同一个对象（历史连续）");
});

test("T3.5: 大小写不敏感平台上的纯大小写改名 → 两步探测后改名成功，不被当成占用", async () => {
	const store = await plainStore();
	const vault = ciMemVault();
	vault.files.set("note.md", { name: "note.md", data: bytes("x") });
	store.replaceWithNewObject("note.md", {
		hash: "h", serverHash: "s1", revision: 1, mtime: 1, size: 1, fileId: FA, metaGeneration: 1,
	});

	const ctx = ctxOf({
		store,
		vault,
		client: {
			changes: async (since: number) => ({
				latestSequence: 2,
				hasMore: false,
				changes:
					since === 0
						? [{ sequence: 2, path: "Note.md", fileId: FA, action: "upsert", revision: 1, hash: "s1", metaGeneration: 2 }]
						: [],
			}),
			download: async () => {
				throw new Error("纯改名不应下载");
			},
		},
	});

	const r = await pullRemoteChanges(ctx);
	assert.equal(r.applied, 1, "大小写改名必须成功，不得 blocked");
	assert.equal(vault.files.get("note.md")?.name, "Note.md", "落盘名字应更新为新大小写");
	assert.equal(store.get("Note.md")?.fileId, FA);
	assert.equal(store.get("note.md"), undefined);
	assert.equal([...store.blockedChanges()].length, 0);
	assert.equal(store.pendingSwaps().length, 0, "探测用的临时记录必须清理干净");
});

test("T3.5 反面: 大小写敏感平台上目标确是另一个文件 → blocked，两份内容都不动", async () => {
	const store = await plainStore();
	const vault = memVault(); // 精确匹配 = 大小写敏感
	vault.files.set("note.md", bytes("tracked 内容"));
	vault.files.set("Note.md", bytes("另一个本地文件"));
	store.replaceWithNewObject("note.md", {
		hash: "h", serverHash: "s1", revision: 1, mtime: 1, size: 1, fileId: FA, metaGeneration: 1,
	});

	const ctx = ctxOf({
		store,
		vault,
		client: {
			changes: async (since: number) => ({
				latestSequence: 2,
				hasMore: false,
				changes:
					since === 0
						? [{ sequence: 2, path: "Note.md", fileId: FA, action: "upsert", revision: 1, hash: "s1", metaGeneration: 2 }]
						: [],
			}),
			download: async () => {
				throw new Error("blocked 场景不应下载");
			},
		},
	});

	await pullRemoteChanges(ctx);
	assert.equal(text(vault.files.get("note.md")!), "tracked 内容", "源文件原样保留");
	assert.equal(text(vault.files.get("Note.md")!), "另一个本地文件", "占用者绝不被覆盖");
	assert.ok([...store.blockedChanges()].length >= 1, "登记 blocked 等待用户处理");
});

test("T3.2: 重放的陈旧改名（旧 metaGeneration）→ 跳过，不把文件改回旧名字", async () => {
	const store = await plainStore();
	const vault = memVault();
	vault.files.set("new-name.md", bytes("x"));
	store.replaceWithNewObject("new-name.md", {
		hash: "h", serverHash: "s1", revision: 3, mtime: 1, size: 1, fileId: FA, metaGeneration: 3,
	});

	const ctx = ctxOf({
		store,
		vault,
		client: {
			changes: async (since: number) => ({
				latestSequence: 9,
				hasMore: false,
				changes:
					since === 0
						? [{ sequence: 9, path: "old-name.md", fileId: FA, action: "upsert", revision: 2, hash: "s1", metaGeneration: 2 }]
						: [],
			}),
			download: async () => {
				throw new Error("陈旧改名不应产生下载");
			},
		},
	});

	await pullRemoteChanges(ctx);
	assert.ok(vault.files.has("new-name.md"), "现名保留");
	assert.ok(!vault.files.has("old-name.md"), "绝不按旧名字造出文件");
	assert.equal(store.get("new-name.md")?.metaGeneration, 3, "世代不倒退");
});

test("T3.4: 并发改名成不同名字 → 本地改名意图换基后作为正常改名推送（同一身份、无删除、无新对象）", async () => {
	const store = await plainStore();
	const vault = memVault();
	// 本机离线期间把 race.md 改成 race-d2.md：文件已在新名下，move op 排队中
	const content = bytes("内容");
	vault.files.set("race-d2.md", content);
	store.replaceWithNewObject("race.md", {
		hash: await sha256Hex(content), serverHash: "s1", revision: 1, mtime: 1, size: content.byteLength,
		fileId: FA, metaGeneration: 1,
	});
	const queue = new PendingQueue();
	queue.stage("race-d2.md", { action: "move", from: "race.md" });

	const renames: Array<{ from: string; to: string; base: number }> = [];
	const ctx = ctxOf({
		store,
		vault,
		queue,
		client: {
			// 对端抢先把 race.md 改成了 race-d1.md（metaGen 2）
			changes: async (since: number) => ({
				latestSequence: 2,
				hasMore: false,
				changes:
					since === 0
						? [{ sequence: 2, path: "race-d1.md", fileId: FA, action: "upsert", revision: 1, hash: "s1", metaGeneration: 2 }]
						: [],
			}),
			download: async () => {
				throw new Error("不应产生任何下载");
			},
			upload: async () => {
				throw new Error("绝不允许把改名退化成新建对象（那会在服务器上多出一份内容）");
			},
			remove: async () => {
				throw new Error("绝不允许删除远端活对象（§6.10）");
			},
			rename: async (from: string, to: string, base: number) => {
				renames.push({ from, to, base });
				return { fileId: FA, toPath: to, revision: 1, metaGeneration: base + 1, sequence: 3 };
			},
		},
	});

	// 同步顺序与 SyncManager 一致：先 pull（应用对端改名并换基），再 push（推送本地改名）
	await pullRemoteChanges(ctx);
	assert.equal(queue.getOp("race-d2.md")?.from, "race-d1.md", "move op 的 from 必须换基到对端的新名字");
	const r = await pushPendingChanges(ctx);
	assert.equal(r.pushed, 1);
	assert.deepEqual(renames, [{ from: "race-d1.md", to: "race-d2.md", base: 2 }], "以对端改名后的世代做 CAS 改名");
	const tracked = store.get("race-d2.md");
	assert.equal(tracked?.fileId, FA, "同一身份（INV-05），不是新对象");
	assert.equal(tracked?.metaGeneration, 3);
	assert.equal(store.get("race.md"), undefined);
	assert.equal(store.get("race-d1.md"), undefined);
});

// ---------------------------------------------------------------- resync 对账

test("resync: 改名走本地 rename，不退化为 trash + 全量重下载", async () => {
	const store = await plainStore();
	store.state.lastSequence = 1;
	const vault = memVault();
	vault.files.set("a.md", bytes("内容"));
	store.replaceWithNewObject("a.md", {
		hash: "h", serverHash: "s1", revision: 1, mtime: 1, size: 2, fileId: FA, metaGeneration: 1,
	});

	let downloads = 0;
	const ctx = ctxOf({
		store,
		vault,
		client: {
			changes: async () => ({ latestSequence: 10, hasMore: false, changes: [], resyncRequired: true, minSequence: 8 }),
			snapshot: async () => ({
				sequence: 10,
				files: [{ path: "b.md", revision: 1, hash: "s1", size: 2, mtime: 1, fileId: FA, metaGeneration: 2 }],
			}),
			download: async () => {
				downloads++;
				throw new Error("内容未变的改名不应重下载");
			},
		},
	});

	await pullRemoteChanges(ctx);
	assert.equal(downloads, 0, "不重下载");
	assert.ok(vault.files.has("b.md"), "本地文件按快照改名");
	assert.ok(!vault.files.has("a.md"));
	assert.equal(store.get("b.md")?.fileId, FA);
	assert.equal(store.state.lastSequence, 10);
});

test("resync: 两个文件互换名字 → 临时名破环收敛，两份内容都在且各归其位", async () => {
	const store = await plainStore();
	store.state.lastSequence = 1;
	const vault = memVault();
	vault.files.set("x.md", bytes("内容X"));
	vault.files.set("y.md", bytes("内容Y"));
	store.replaceWithNewObject("x.md", {
		hash: "hx", serverHash: "sx", revision: 1, mtime: 1, size: 3, fileId: FA, metaGeneration: 1,
	});
	store.replaceWithNewObject("y.md", {
		hash: "hy", serverHash: "sy", revision: 1, mtime: 1, size: 3, fileId: FB, metaGeneration: 1,
	});

	const ctx = ctxOf({
		store,
		vault,
		client: {
			changes: async () => ({ latestSequence: 12, hasMore: false, changes: [], resyncRequired: true }),
			snapshot: async () => ({
				sequence: 12,
				files: [
					// 服务器上已互换：x.md 现在是原 y 的对象，y.md 是原 x 的对象
					{ path: "x.md", revision: 1, hash: "sy", size: 3, mtime: 1, fileId: FB, metaGeneration: 2 },
					{ path: "y.md", revision: 1, hash: "sx", size: 3, mtime: 1, fileId: FA, metaGeneration: 2 },
				],
			}),
			download: async () => {
				throw new Error("互换（内容未变）不应下载");
			},
		},
	});

	await pullRemoteChanges(ctx);
	assert.equal(text(vault.files.get("x.md")!), "内容Y", "x.md 应承载原 y 的内容");
	assert.equal(text(vault.files.get("y.md")!), "内容X", "y.md 应承载原 x 的内容");
	assert.equal(store.get("x.md")?.fileId, FB, "身份跟着内容走（INV-05）");
	assert.equal(store.get("y.md")?.fileId, FA);
	assert.equal(store.pendingSwaps().length, 0, "临时交换记录清理干净");
});

test("T6.4: 元数据迁移 abort 后回放的伪名化 change 不是改名——真实文件绝不被改名成 32-hex", async () => {
	const store = await plainStore(); // abort 之后 metaState 回到 plain
	const vault = memVault();
	const content = bytes("真实内容");
	vault.files.set("真实笔记.md", content);
	// 迁移期间 migratePath 已把 serverPseudonym 记进 tracked，游标停在迁移前
	store.replaceWithNewObject("真实笔记.md", {
		hash: await sha256Hex(content), serverHash: "s1", revision: 1, mtime: 1, size: content.byteLength,
		fileId: FA, serverPseudonym: FA, metaGeneration: 1,
	});

	const ctx = ctxOf({
		store,
		vault,
		client: {
			// 迁移期间产生的伪名化 change（path = fileId，hash 未变，metaGen 相同）
			changes: async (since: number) => ({
				latestSequence: 5,
				hasMore: false,
				changes:
					since === 0
						? [{ sequence: 5, path: FA, fileId: FA, action: "upsert", revision: 2, hash: "s1", metaGeneration: 1 }]
						: [],
			}),
			download: async () => {
				throw new Error("hash 未变的回声不应下载");
			},
		},
	});

	await pullRemoteChanges(ctx);
	assert.ok(vault.files.has("真实笔记.md"), "真实文件必须留在原路径");
	assert.ok(!vault.files.has(FA), "绝不能出现 32-hex 名字的文件（T6.4 abort 无损）");
	const tracked = store.get("真实笔记.md");
	assert.equal(tracked?.revision, 2, "revision 照常推进（这是同一对象的普通变更）");
	assert.equal(tracked?.serverPseudonym, FA);
	assert.equal(store.get(FA), undefined);
	assert.equal(store.state.lastSequence, 5);
});

// ---------------------------------------------------------------- T2.2 restore 记账

test("T2.2: 删除后重建（E2EE）→ restore 后重传的 generation 必须越过恢复世代，不产生冲突副本", async () => {
	const store = await plainStore();
	const keyring = await unlockedKeyring();
	const vault = memVault();
	const data = bytes("重建的新内容");
	vault.files.set("re.md", data);

	const queue = new PendingQueue();
	let restoreGen = 0;
	const uploads: Array<{ baseRevision: number; generation: number }> = [];
	const ctx = ctxOf({
		store,
		vault,
		keyring,
		queue,
		client: {
			upload: async (_p: string, baseRevision: number, hash: string, payload: ArrayBuffer) => {
				const gen = parseLse3Header(payload)!.generation;
				uploads.push({ baseRevision, generation: gen });
				if (uploads.length === 1) {
					// 服务器：该名字上有 tombstone（删除时内容世代 5）
					throw new ConflictError({
						path: "re.md", revision: 7, hash: "", deleted: true,
						priorHash: "prior", fileId: FA, contentGeneration: 5,
					});
				}
				return { path: "re.md", revision: 9, hash, size: payload.byteLength, sequence: 12, fileId: FA };
			},
			version: async () => {
				throw new NotFoundError(); // 历史已裁剪：按同名新内容处理
			},
			restore: async (fileId: string, params: { expectedTombstoneRevision: number; contentGeneration: number }) => {
				assert.equal(fileId, FA);
				assert.equal(params.expectedTombstoneRevision, 7, "防复活锚点必须原样带回");
				restoreGen = params.contentGeneration;
				assert.ok(restoreGen > 5, "恢复世代必须严格大于删除时的世代");
				return { fileId: FA, path: "re.md", revision: 8, metaGeneration: 4, sequence: 11 };
			},
		},
	});

	queue.stage("re.md", { action: "upsert" });
	const r = await pushPendingChanges(ctx);
	assert.equal(r.pushed, 1);
	assert.equal(r.conflicts, 0, "重建绝不应产生冲突（T2.2 的失败形态）");
	assert.equal(uploads.length, 2, "第一次撞墓碑，restore 后第二次成功");
	assert.equal(uploads[1].baseRevision, 8, "以恢复后的 revision 为基线");
	assert.ok(uploads[1].generation > restoreGen, `重传世代（${uploads[1].generation}）必须越过恢复世代（${restoreGen}）`);
	const tracked = store.get("re.md");
	assert.equal(tracked?.generation, uploads[1].generation, "世代必须记账");
	assert.equal(tracked?.metaGeneration, 4, "恢复后的元数据世代必须记账（否则下次改名 412）");
});

// ---------------------------------------------------------------- T2.3 世代下限

test("T2.3: 自动合并（E2EE）——远端世代领先 tracked 时，合并上传以远端世代为下限", async () => {
	const store = await plainStore();
	const keyring = await unlockedKeyring();
	const vault = memVault();

	const baseText = "line1\nline2\nline3\n";
	const remoteText = "line1\nline2\nline3\nREMOTE\n";
	const localText = "LOCAL\nline1\nline2\nline3\n";
	const localData = bytes(localText);
	vault.files.set("m.md", localData);

	// 本机离线期间对端把 generation 推到 9；tracked 还停在 2
	const key = keyring.requireKey();
	const baseEnv = await encryptFileV3(key, { vaultId: VAULT_ID, keyEpoch: 1, fileId: FA, generation: 2 }, bytes(baseText));
	const remoteEnv = await encryptFileV3(key, { vaultId: VAULT_ID, keyEpoch: 1, fileId: FA, generation: 9 }, bytes(remoteText));
	store.replaceWithNewObject("m.md", {
		hash: await sha256Hex(bytes(baseText)), serverHash: "sb", revision: 2, mtime: 1,
		size: baseText.length, fileId: FA, generation: 2,
	});

	let uploadedGen = 0;
	let uploadedBase = 0;
	const ctx = ctxOf({
		store,
		vault,
		keyring,
		client: {
			version: async (): Promise<DownloadResult> => ({
				data: baseEnv, revision: 2, hash: "", size: baseEnv.byteLength, mtime: 1, fileId: FA,
			}),
			download: async (): Promise<DownloadResult> => ({
				data: remoteEnv, revision: 4, hash: "", size: remoteEnv.byteLength, mtime: 1, fileId: FA,
			}),
			upload: async (_p: string, baseRevision: number, hash: string, payload: ArrayBuffer) => {
				uploadedBase = baseRevision;
				uploadedGen = parseLse3Header(payload)!.generation;
				return { path: "m.md", revision: 5, hash, size: payload.byteLength, sequence: 20, fileId: FA };
			},
		},
	});

	const outcome = await attemptAutoMerge(ctx, "m.md", localData, store.get("m.md"));
	assert.equal(outcome, "merged", "干净合并必须成功，而不是反复 409 后落到冲突副本");
	assert.equal(uploadedBase, 4, "以刚下载的远端 revision 为基线");
	assert.equal(uploadedGen, 10, "世代必须越过远端当前值（9 + 1），而不是 tracked+1=3");
	assert.equal(store.get("m.md")?.generation, 10);
	assert.equal(text(vault.files.get("m.md")!), "LOCAL\nline1\nline2\nline3\nREMOTE\n", "合并结果落盘");
});

test("T2.3: uploadFromPlain 的 generationFloor 取「已知世代与下限的较大者 + 1」", async () => {
	const store = await plainStore();
	const keyring = await unlockedKeyring();
	const vault = memVault();
	store.replaceWithNewObject("g.md", {
		hash: "h", serverHash: "s", revision: 1, mtime: 1, size: 1, fileId: FA, generation: 1,
	});

	let gen = 0;
	const ctx = ctxOf({
		store,
		vault,
		keyring,
		client: {
			upload: async (_p: string, _b: number, hash: string, payload: ArrayBuffer) => {
				gen = parseLse3Header(payload)!.generation;
				return { path: "g.md", revision: 2, hash, size: payload.byteLength, sequence: 1, fileId: FA };
			},
		},
	});

	await uploadFromPlain(ctx, "g.md", bytes("x"), 1, 1, "merge", { generationFloor: 5 });
	assert.equal(gen, 6, "max(tracked=1, floor=5) + 1");
	await uploadFromPlain(ctx, "g.md", bytes("y"), 1, 1, "merge", { generationFloor: 0 });
	assert.equal(gen, 2, "下限为 0 时退回 tracked+1 的旧语义");
});

// ---------------------------------------------------------------- T2.4 分享附件帧

test("T2.4: LSN2 分享帧——名字/正文/附件（含中文与空格路径）精确往返", async () => {
	const content = bytes("# 标题\n![[图 片.png]]\n正文");
	const framed = frameShareBundle("我的 笔记.md", content, [
		{ path: "assets/图 片.png", data: bytes("PNGDATA-1") },
		{ path: "b.webp", data: bytes("WEBP-二号") },
	]);
	assert.equal(text(framed.slice(0, 4)), "LSN2");
	const out = unframeShareBundle(framed);
	assert.equal(out.name, "我的 笔记.md");
	assert.equal(text(out.content), text(content));
	assert.equal(out.attachments.length, 2);
	assert.equal(out.attachments[0].path, "assets/图 片.png");
	assert.equal(text(out.attachments[0].data), "PNGDATA-1");
	assert.equal(out.attachments[1].path, "b.webp");
	assert.equal(text(out.attachments[1].data), "WEBP-二号");

	// 加密往返：查看端拿到的就是这一帧
	const key = randomBytes(32);
	const sealed = await encryptShare(key, framed);
	const opened = await decryptShare(key, sealed);
	assert.ok(opened !== null);
	assert.equal(unframeShareBundle(opened!).attachments.length, 2);
});

test("T2.4: 无附件退回 LSN1（旧查看端可读）；LSN1/裸内容/截断 LSN2 均安全退化", () => {
	const content = bytes("正文");
	const lsn1 = frameShareBundle("plain.md", content, []);
	assert.equal(text(lsn1.slice(0, 4)), "LSN1", "没有附件时不该升格式");
	const back = unframeShareBundle(lsn1);
	assert.equal(back.name, "plain.md");
	assert.equal(back.attachments.length, 0);
	assert.equal(text(back.content), "正文");

	const raw = unframeShareBundle(bytes("裸内容，三代之前的分享"));
	assert.equal(raw.name, null);
	assert.equal(text(raw.content), "裸内容，三代之前的分享");

	// 截断的 LSN2：绝不丢内容，最多丢名字/附件结构
	const truncated = frameShareBundle("n.md", content, [{ path: "a.png", data: bytes("DATA") }]).slice(0, 12);
	const deg = unframeShareBundle(truncated);
	assert.ok(deg.content.byteLength > 0 || deg.attachments.length === 0, "解析失败必须退化而不是抛出");
});
