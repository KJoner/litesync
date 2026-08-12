// 灾备恢复与对抗性协议测试（v0.14.0-RC / 计划书 §8.5 · §8.6）。
//
// §8.5 的固定场景：
//   客户端 lastSequence = 5000 → 服务器从备份恢复到 4200 → 旋转 repoEpoch
//   → 服务器产生新 sequence → 客户端重新上线
//
// §8.6 模拟一台恶意（或被攻陷、或从备份恢复却忘了旋转 epoch 的）服务器。
// 在签名 manifest（v0.15）之前，客户端无法阻止所有分叉，但**凡是能靠本地
// 锚点检测到的回退与身份替换，都必须硬失败**。这里逐条验证那些锚点还在。
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { ChangesResponse, DownloadResult, ServerInfo } from "../src/api/client";
import { createVaultKeyDoc, encryptMeta } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { LocalCommitter } from "../src/sync/local-commit";
import { pullRemoteChanges, RepoEpochChangedError } from "../src/sync/pull";
import { PendingQueue } from "../src/sync/queue";
import { SyncManager } from "../src/sync/sync-manager";
import {
	assertMetaGeneration,
	downloadPlain,
	FileIdMismatchError,
	MetaForkError,
	MetaGenerationRollbackError,
} from "../src/sync/transfer";

const VAULT_ID = "vault-0123456789ab";
const PLUGIN_DIR = ".obsidian/plugins/litesync";
const FID = "a".repeat(32);

function memAdapter() {
	const files = new Map<string, string>();
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

function memVault() {
	const files = new Map<string, ArrayBuffer>();
	const adapter = {
		exists: async (p: string) => files.has(p),
		mkdir: async () => {},
		stat: async (p: string) => (files.has(p) ? { type: "file" as const, mtime: 1, size: 1 } : null),
		readBinary: async (p: string) => files.get(p)!,
		writeBinary: async (p: string, d: ArrayBuffer) => void files.set(p, d.slice(0)),
		rename: async (from: string, to: string) => {
			files.set(to, files.get(from)!);
			files.delete(from);
		},
		remove: async (p: string) => void files.delete(p),
		list: async () => ({ files: [] as string[], folders: [] as string[] }),
	};
	return { files, adapter };
}

async function readyStore(over: Partial<StateStore["state"]["bootstrap"]> = {}): Promise<StateStore> {
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
		completedAt: 0,
		...over,
	};
	return store;
}

async function unlockedKeyring(): Promise<Keyring> {
	const { doc, vmk } = await createVaultKeyDoc("pw-adv");
	const k = new Keyring();
	k.adopt({ ...doc, enabled: true }, vmk);
	return k;
}

// ---------------------------------------------------------------- §8.5 灾备恢复

test("§8.5: 服务器从备份恢复并旋转 epoch → 客户端不再使用旧游标，进入恢复流程", async () => {
	const store = await readyStore();
	// 场景：客户端已经同步到 5000
	store.state.lastSequence = 5000;
	store.set("local-only.md", { hash: "h", serverHash: "s", revision: 9, mtime: 1, size: 1 });

	const notices: string[] = [];
	const vault = memVault();
	const ctx = {
		app: { vault: { adapter: vault.adapter } },
		store,
		queue: new PendingQueue(),
		gate: new SyncGate(),
		e2ee: new Keyring(),
		client: {
			// 服务器恢复到 4200，并旋转了 repoEpoch
			changes: async (): Promise<ChangesResponse> => ({
				latestSequence: 4210,
				hasMore: false,
				changes: [],
				repoEpoch: "epoch-2-after-restore",
			}),
		},
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: (m: string) => void notices.push(m),
	} as unknown as SyncContext;

	await assert.rejects(() => pullRemoteChanges(ctx), RepoEpochChangedError);

	// 必须结果 1：检测到 epoch 变化并停止普通同步
	assert.notEqual(store.state.bootstrap.status, "ready", "必须退出 ready，不能继续增量同步");
	// 必须结果 2：不继续使用 cursor 5000
	assert.notEqual(store.state.lastSequence, 5000, "旧游标必须作废");
	// 必须结果 3：不直接用旧服务器状态覆盖本地——本地内容一个都不能少
	assert.equal(store.get("local-only.md")?.revision, 9, "本地独有内容必须保留");
	// 必须结果 4：留下恢复现场，让接入向导走恢复流程而不是普通接入
	assert.notEqual(store.state.recovery, null, "必须建立本地恢复快照记录");
	assert.ok(
		notices.some((n) => n.includes("恢复") || n.includes("合并")),
		`必须明确告知用户要走恢复合并：${notices.join(" / ")}`,
	);
});

test("§8.5: 恢复现场记录了旧游标与旧 epoch（用于事后核对丢了哪一段）", async () => {
	const store = await readyStore();
	store.state.lastSequence = 5000;
	const vault = memVault();
	const ctx = {
		app: { vault: { adapter: vault.adapter } },
		store,
		queue: new PendingQueue(),
		gate: new SyncGate(),
		e2ee: new Keyring(),
		client: {
			changes: async (): Promise<ChangesResponse> => ({
				latestSequence: 4210,
				hasMore: false,
				changes: [],
				repoEpoch: "epoch-2",
			}),
		},
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;

	await assert.rejects(() => pullRemoteChanges(ctx));
	const rec = store.state.recovery;
	assert.ok(rec !== null, "必须留下恢复记录");
	assert.equal(rec.localSequence, 5000, "必须记下作废前的游标");
	assert.equal(rec.previousEpoch, "epoch-1");
	assert.equal(rec.serverEpoch, "epoch-2");
	assert.equal(rec.reason, "repo-epoch-changed");
});

// ---------------------------------------------------------------- §8.6 对抗性

function advCtx(store: StateStore, client: unknown, gate = new SyncGate()) {
	const vault = memVault();
	return {
		app: { vault: { adapter: vault.adapter } },
		store,
		queue: new PendingQueue(),
		gate,
		e2ee: new Keyring(),
		committer: new LocalCommitter({ vault: { adapter: vault.adapter } } as never, PLUGIN_DIR),
		client,
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;
}

const dl = (over: Partial<DownloadResult> = {}): DownloadResult =>
	({
		data: new TextEncoder().encode("x").buffer as ArrayBuffer,
		revision: 2,
		mtime: 0,
		hash: "",
		...over,
	}) as unknown as DownloadResult;

test("§8.6-1: 返回错误 fileId → 硬失败、不写本地、停掉自动同步", async () => {
	const store = await readyStore();
	const gate = new SyncGate();
	store.set("a.md", { hash: "h", serverHash: "s", revision: 1, mtime: 0, size: 1, fileId: FID });
	const ctx = advCtx(store, { download: async () => dl({ fileId: "b".repeat(32) }) }, gate);

	await assert.rejects(() => downloadPlain(ctx, "a.md"), FileIdMismatchError);
	assert.equal(store.get("a.md")?.fileId, FID, "tracked 身份绝不能被换掉");
	assert.equal(gate.sessionBlock()?.reason, "integrity-error");
});

test("§8.6-3: 返回旧 metaGeneration → 硬失败（回退检测）", async () => {
	const store = await readyStore();
	const gate = new SyncGate();
	store.set("a.md", {
		hash: "h", serverHash: "s", revision: 1, mtime: 0, size: 1,
		fileId: FID, metaGeneration: 9, metaFingerprint: "fp9",
	});
	const ctx = advCtx(store, {}, gate);
	assert.throws(() => assertMetaGeneration(ctx, "a.md", 3, "fp3"), MetaGenerationRollbackError);
	assert.equal(gate.sessionBlock()?.reason, "integrity-error");
});

test("§8.6-4: 同 generation 返回不同 metadata → 判定分叉并停机", async () => {
	const store = await readyStore();
	const gate = new SyncGate();
	store.set("a.md", {
		hash: "h", serverHash: "s", revision: 1, mtime: 0, size: 1,
		fileId: FID, metaGeneration: 9, metaFingerprint: "fp-A",
	});
	const ctx = advCtx(store, {}, gate);
	assert.throws(() => assertMetaGeneration(ctx, "a.md", 9, "fp-B"), MetaForkError);
	assert.equal(gate.sessionBlock()?.reason, "integrity-error");
});

test("§8.6-5: Header 里回放旧 metaGeneration 也会被拦（下载路径的廉价前置检查）", async () => {
	const store = await readyStore();
	const gate = new SyncGate();
	store.set("a.md", {
		hash: "h", serverHash: "s", revision: 1, mtime: 0, size: 1,
		fileId: FID, metaGeneration: 9,
	});
	const ctx = advCtx(store, { download: async () => dl({ fileId: FID, metaGeneration: 3 }) }, gate);
	await assert.rejects(() => downloadPlain(ctx, "a.md"), /元数据回退/);
	assert.equal(gate.sessionBlock()?.reason, "integrity-error");
});

test("§8.6-7: 返回路径穿越的元数据 → 拒绝写入本地文件系统", async () => {
	const keyring = await unlockedKeyring();
	const keys = await keyring.metaKeys();
	const store = await readyStore({ metaState: "encrypted" });

	// 一台被攻陷的旧设备可以把任意字符串加密进元数据里——
	// 服务器伪造不了（GCM 挡着），但那台设备可以
	const evil = await encryptMeta(
		keys,
		{ vaultId: VAULT_ID, keyEpoch: 1, fileId: FID, metaGeneration: 1 },
		{ path: "../../.ssh/authorized_keys" },
	);
	const notices: string[] = [];
	const vault = memVault();
	const ctx = {
		app: { vault: { adapter: vault.adapter } },
		store,
		queue: new PendingQueue(),
		gate: new SyncGate(),
		e2ee: keyring,
		client: {
			getFileMeta: async () => ({ metaEnc: evil }),
			changes: async (since: number): Promise<ChangesResponse> =>
				since === 0
					? {
							latestSequence: 1,
							hasMore: false,
							changes: [{ sequence: 1, path: FID, action: "upsert", revision: 1 }],
						}
					: { latestSequence: 1, hasMore: false, changes: [] },
		},
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: (m: string) => void notices.push(m),
	} as unknown as SyncContext;

	await pullRemoteChanges(ctx);

	// 关键：那条路径一个字节都不能落到文件系统上
	assert.equal(vault.files.size, 0, "路径穿越的元数据绝不能写出任何文件");
	assert.ok(
		notices.some((n) => n.includes("不安全")),
		`必须明确告知用户拒绝了一条不安全路径：${notices.join(" / ")}`,
	);
	// 而且要留下可诊断的 blocked 记录，同步不因此整体停摆
	assert.equal(store.blockedChanges().length, 1);
	assert.equal(store.blockedChanges()[0][1].realPath, "", "被拒绝的路径不得被当作有效本地路径");
});

test("§8.6-9: 回放旧 Snapshot（latestSequence 倒退）→ 走全量对账而不是盲目跟随", async () => {
	const store = await readyStore();
	store.state.lastSequence = 500;
	let snapshotCalls = 0;
	const vault = memVault();
	const ctx = {
		app: { vault: { adapter: vault.adapter } },
		store,
		queue: new PendingQueue(),
		gate: new SyncGate(),
		e2ee: new Keyring(),
		client: {
			changes: async (): Promise<ChangesResponse> => ({
				// 服务器声称最新只到 100，比我们已知的 500 还旧
				latestSequence: 100,
				hasMore: false,
				changes: [],
				repoEpoch: "epoch-1",
			}),
			snapshot: async () => {
				snapshotCalls++;
				return { sequence: 100, files: [], repoEpoch: "epoch-1" };
			},
		},
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;

	await pullRemoteChanges(ctx);
	assert.equal(snapshotCalls, 1, "服务器 head 落后于本地游标时必须走 snapshot 对账");
});

test("§8.6-10: 返回缺失 Blob（503 内容损坏）→ 绝不当作删除处理", async () => {
	// 服务器把损坏内容标记为不可服务后返回的是 CONTENT_CORRUPTED，
	// 客户端必须把它与 NotFound 区别对待：前者不能触发本地删除跟随
	const store = await readyStore();
	store.set("a.md", { hash: "h", serverHash: "s", revision: 1, mtime: 0, size: 1, fileId: FID });
	const { ApiError } = await import("../src/api/client");
	const ctx = advCtx(store, {
		download: async () => {
			throw new ApiError(503, "corrupted", "CONTENT_CORRUPTED");
		},
	});
	await assert.rejects(() => downloadPlain(ctx, "a.md"), (e: unknown) => e instanceof ApiError && e.status === 503);
	assert.ok(store.get("a.md") !== undefined, "内容损坏绝不能让本地跟随删除");
});

// ---------------------------------------------------------------- 协议冻结

test("§8.6-2 前置: formatEpoch 回退 → 停机等人工确认，绝不自动采纳", async () => {
	const store = await readyStore();
	store.state.bootstrap.formatEpoch = 3;
	const info: ServerInfo = {
		version: "test",
		latestSequence: 0,
		serverTime: 0,
		protocolVersion: 6,
		minProtocolVersion: 6,
		vaultId: VAULT_ID,
		repoEpoch: "epoch-1",
		keyEpoch: 1,
		formatEpoch: 1, // 倒退
		minimumEnvelopeVersion: 3,
		schemaVersion: 6,
	} as unknown as ServerInfo;

	const vault = memVault();
	const gate = new SyncGate();
	const ctx = {
		app: { vault: { configDir: ".obsidian", getFiles: () => [], adapter: vault.adapter } },
		store,
		queue: new PendingQueue(),
		gate,
		e2ee: new Keyring(),
		client: {
			info: async () => info,
			whoami: async () => ({ tokenType: "device" as const }),
			changes: async (): Promise<ChangesResponse> => ({ latestSequence: 0, hasMore: false, changes: [] }),
		},
		credentials: () => ({ serverUrl: "https://a", apiToken: "t" }),
		refreshE2ee: async () => {},
		syncObsidian: () => false,
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: () => {},
		onConflictsChanged: () => {},
	} as unknown as SyncContext;

	const mgr = new SyncManager(ctx);
	await mgr.sync("format-epoch-rollback");
	assert.equal(store.state.bootstrap.formatEpoch, 3, "绝不采纳倒退的格式世代");
	assert.notEqual(gate.sessionBlock(), null, "必须停机等待人工确认");
	mgr.dispose();
});
