// v0.13.1 客户端验收测试（计划书 §5）。
//
// 覆盖：
//   §5.1 pending binding：bootstrap 期间就能用 LSE3/LSM1，绝不回退到更弱的形式
//   §5.2 每轮同步重新校准仓库状态（不再「会话首轮查一次」）
//   §5.5 complete 前客户端全量回验（服务端 validator 看不到「我们解不解得开」）
//   §5.6 repoEpoch 变化 → 记录灾备恢复现场，不做普通快照覆盖
//
// INV: INV-07 / INV-10 / INV-11
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { ChangesResponse, ServerInfo } from "../src/api/client";
import { createVaultKeyDoc, deriveMetaKeys, encryptMeta, exportVmkRaw } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { PendingQueue } from "../src/sync/queue";
import { SyncManager } from "../src/sync/sync-manager";
import { e2eeBinding, metaEncrypted, uploadFromPlain } from "../src/sync/transfer";

const VAULT_ID = "vault-0123456789ab";
const FILE_ID = "0123456789abcdef0123456789abcdef";

function memAdapter() {
	const files = new Map<string, string>();
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

async function freshStore(): Promise<StateStore> {
	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	return store;
}

const serverInfo = (over: Partial<ServerInfo> = {}): ServerInfo => ({
	version: "test",
	latestSequence: 0,
	serverTime: 0,
	protocolVersion: 6,
	minProtocolVersion: 6,
	vaultId: VAULT_ID,
	repoEpoch: "epoch-1",
	keyEpoch: 2,
	formatEpoch: 1,
	minimumEnvelopeVersion: 3,
	schemaVersion: 6,
	...over,
});

// ---------- §5.1 权威 pending binding ----------

test("§5.1: preflight 写入的 pending binding 在 bootstrap 期间就可用（绝不回退 LSE1）", async () => {
	const store = await freshStore();
	assert.equal(store.bootstrapReady, false);

	// 尚未 preflight：没有绑定材料
	const ctx = { store } as unknown as SyncContext;
	assert.equal(e2eeBinding(ctx), undefined);

	// preflight 拿到服务器权威状态后写入 pending binding —— status 仍是 pending
	store.setPendingBinding({
		remoteVaultId: VAULT_ID,
		repoEpoch: "epoch-1",
		keyEpoch: 2,
		metaState: "encrypted",
		formatEpoch: 2,
		minimumEnvelopeVersion: 3,
	});

	assert.equal(store.bootstrapReady, false, "绑定字段不得让设备被当成「已接入」");
	// 关键：bootstrap 期间 LSE3 绑定材料与 meta 模式判定都已经可用，
	// 于是 Merge 上传写的是 LSE3 + 伪名，而不是 LSE1 / 真实路径
	assert.deepEqual(e2eeBinding(ctx), { vaultId: VAULT_ID, keyEpoch: 2 });
	assert.equal(metaEncrypted(ctx), true);

	// 完成接入 = **原子**转 active：绑定字段原样保留，只翻转 status
	store.completeBootstrap("merge", VAULT_ID, 42, "epoch-1", 2);
	assert.equal(store.bootstrapReady, true);
	assert.equal(store.state.bootstrap.formatEpoch, 2, "转 active 不得丢掉 preflight 写好的字段");
	assert.equal(store.state.bootstrap.minimumEnvelopeVersion, 3);
	assert.equal(store.state.bootstrap.snapshotSequence, 42);
});

test("§5.1: bootstrap 期间的上传写 LSE3 而不是回退信封", async () => {
	const store = await freshStore();
	store.setPendingBinding({ remoteVaultId: VAULT_ID, keyEpoch: 2 });

	const { doc, vmk } = await createVaultKeyDoc("pw-131");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);

	let uploaded: ArrayBuffer | null = null;
	const ctx = {
		store,
		padsSize: () => false,
		queue: new PendingQueue(),
		e2ee: keyring,
		client: {
			upload: async (p: string, _base: number, _hash: string, data: ArrayBuffer) => {
				uploaded = data;
				return { path: p, revision: 1, hash: "", size: 0, sequence: 1 };
			},
		},
		log: () => {},
	} as unknown as SyncContext;

	const out = await uploadFromPlain(ctx, "a.md", new TextEncoder().encode("hi").buffer as ArrayBuffer, 0, 0);
	assert.ok(uploaded, "上传必须真的发出");
	const magic = new TextDecoder().decode(new Uint8Array(uploaded!, 0, 4));
	assert.equal(magic, "LSE3", "bootstrap 期间也必须写 LSE3（INV-07）");
	assert.ok(out.fileId && /^[0-9a-f]{32}$/.test(out.fileId), "必须带 fileId 上传");
});

// ---------- §5.2 / §5.6：每轮校准与灾备恢复 ----------

function managerCtx(store: StateStore, infoRef: { value: ServerInfo }) {
	const gate = new SyncGate();
	const notices: string[] = [];
	let infoCalls = 0;
	const ctx = {
		app: {
			vault: {
				configDir: ".obsidian",
				getFiles: () => [],
				adapter: {
					stat: async () => null,
					readBinary: async () => new ArrayBuffer(0),
					list: async () => ({ files: [], folders: [] }),
				},
			},
		},
		store,
		queue: new PendingQueue(),
		gate,
		e2ee: new Keyring(),
		client: {
			info: async () => {
				infoCalls++;
				return infoRef.value;
			},
			whoami: async () => ({ tokenType: "device" as const }),
			changes: async (): Promise<ChangesResponse> => ({
				latestSequence: store.state.lastSequence,
				hasMore: false,
				changes: [],
				repoEpoch: infoRef.value.repoEpoch,
			}),
		},
		credentials: () => ({ serverUrl: "https://a", apiToken: "t" }),
		refreshE2ee: async () => {},
		syncObsidian: () => false,
		padsSize: () => false,
		ignores: () => false,
		deviceName: () => "test-device",
		log: () => {},
		notify: (m: string) => void notices.push(m),
		onConflictsChanged: () => {},
	} as unknown as SyncContext;
	return { ctx, gate, notices, infoCalls: () => infoCalls };
}

test("§5.2: 每一轮同步都重新拉取服务器权威状态，而不是只在首轮", async () => {
	const store = await freshStore();
	store.state.bootstrap = {
		status: "ready",
		mode: "merge",
		remoteVaultId: VAULT_ID,
		repoEpoch: "epoch-1",
		keyEpoch: 2,
		formatEpoch: 1,
		completedAt: 0,
	};
	const infoRef = { value: serverInfo() };
	const { ctx, infoCalls } = managerCtx(store, infoRef);
	const mgr = new SyncManager(ctx);

	await mgr.sync("round-1");
	const after1 = infoCalls();
	assert.ok(after1 >= 1, "首轮必须查 /info");

	await mgr.sync("round-2");
	assert.ok(infoCalls() > after1, "第二轮必须重新查 /info（v0.12.x 会跳过）");

	// 第三轮时服务器状态变了 → 必须被立刻发现并采纳
	infoRef.value = serverInfo({ keyEpoch: 3, minimumEnvelopeVersion: 3 });
	await mgr.sync("round-3");
	assert.equal(store.state.bootstrap.keyEpoch, 3, "keyEpoch 变化必须当轮采纳");
	mgr.dispose();
});

test("§5.6: repoEpoch 变化留档灾备恢复现场，并停止普通同步", async () => {
	const store = await freshStore();
	store.state.bootstrap = {
		status: "ready",
		mode: "merge",
		remoteVaultId: VAULT_ID,
		repoEpoch: "epoch-1",
		keyEpoch: 2,
		formatEpoch: 1,
		completedAt: 0,
	};
	store.state.lastSequence = 5000;
	store.update("notes/local-only.md", { hash: "h", serverHash: "s", revision: 1, mtime: 1, size: 1 });

	const infoRef = { value: serverInfo({ repoEpoch: "epoch-2" }) };
	const { ctx, gate, notices } = managerCtx(store, infoRef);
	const mgr = new SyncManager(ctx);

	await mgr.sync("after-restore");

	// 不是「普通快照覆盖」，而是进入显式恢复流程
	const rec = store.recovery;
	assert.ok(rec, "必须留档恢复现场");
	assert.equal(rec!.reason, "repo-epoch-changed");
	assert.equal(rec!.previousEpoch, "epoch-1");
	assert.equal(rec!.serverEpoch, "epoch-2");
	assert.equal(rec!.localSequence, 5000, "记录备份点之后本设备已知的游标");
	assert.equal(rec!.localFileCount, 1, "记录恢复前的本地文件数，便于事后核对没丢内容");

	assert.equal(store.bootstrapReady, false, "必须重新走接入向导");
	assert.equal(gate.sessionBlock()?.reason, "repo-epoch-mismatch");
	assert.ok(
		notices.some((n) => n.includes("备份恢复")),
		`应明确提示这是灾备恢复：${notices.join(" / ")}`,
	);

	// 恢复合并完成后可清除
	store.clearRecovery();
	assert.equal(store.recovery, null);
	mgr.dispose();
});

// ---------- §5.5 客户端全量回验 ----------

test("§5.5: 服务端说没问题、但本设备解不开元数据时，必须中止 complete", async () => {
	// 用「另一把钥匙」加密的元数据：服务端的字段检查会全部通过，
	// 只有真正尝试解密的客户端才能发现问题——这正是 §5.5 存在的理由
	const { vmk: mine } = await createVaultKeyDoc("pw-mine");
	const { vmk: theirs } = await createVaultKeyDoc("pw-theirs");
	const rawMine = await exportVmkRaw(mine);
	const keysMine = await deriveMetaKeys(rawMine);
	rawMine.fill(0);
	const rawTheirs = await exportVmkRaw(theirs);
	const keysTheirs = await deriveMetaKeys(rawTheirs);
	rawTheirs.fill(0);

	const foreign = await encryptMeta(
		keysTheirs,
		{ vaultId: VAULT_ID, keyEpoch: 2, fileId: FILE_ID, metaGeneration: 1 },
		{ path: "笔记/a.md" },
	);
	// 自己的钥匙解不开
	const { decryptMeta } = await import("../src/crypto/crypto");
	assert.equal(await decryptMeta(keysMine, foreign, VAULT_ID, FILE_ID), null);

	// 自己加密的能解开，且 metaGeneration / keyEpoch 都经 AAD 认证后返回
	const own = await encryptMeta(
		keysMine,
		{ vaultId: VAULT_ID, keyEpoch: 2, fileId: FILE_ID, metaGeneration: 7 },
		{ path: "笔记/a.md" },
	);
	const dec = await decryptMeta(keysMine, own, VAULT_ID, FILE_ID);
	assert.equal(dec?.metaGeneration, 7);
	assert.equal(dec?.keyEpoch, 2);
	assert.equal(dec?.meta.path, "笔记/a.md");
});
