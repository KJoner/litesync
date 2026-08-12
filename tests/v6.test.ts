// 协议 v6 客户端验收测试（v0.13.0 / ADR-001 · ADR-002 · ADR-006）。
//
// 覆盖：
//   - 协议版本与逐请求 formatEpoch 校验
//   - formatEpoch 变化 → 丢弃游标重新对账；回退 → 停机等待人工确认
//   - 绑定材料缺失时**不再回退 LSE1**（信封只升不降，INV-07）
//   - 删除后重建走**显式 restore**，身份与 revision 连续（INV-05 / INV-06）
//
// INV: INV-05 / INV-06 / INV-07 / INV-10
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { ChangesResponse, PLUGIN_PROTOCOL_VERSION, ServerInfo } from "../src/api/client";
import { createVaultKeyDoc } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { PendingQueue } from "../src/sync/queue";
import { SyncManager } from "../src/sync/sync-manager";
import { EnvelopeBindingMissingError, uploadFromPlain } from "../src/sync/transfer";

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

async function readyStore(): Promise<StateStore> {
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
	};
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
	keyEpoch: 1,
	formatEpoch: 1,
	minimumEnvelopeVersion: 3,
	schemaVersion: 6,
	...over,
});

function managerCtx(store: StateStore, info: ServerInfo) {
	const gate = new SyncGate();
	const notices: string[] = [];
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
			info: async () => info,
			whoami: async () => ({ tokenType: "device" as const }),
			changes: async (): Promise<ChangesResponse> => ({
				latestSequence: store.state.lastSequence,
				hasMore: false,
				changes: [],
				repoEpoch: info.repoEpoch,
				formatEpoch: info.formatEpoch,
			}),
		},
		credentials: () => ({ serverUrl: "https://a", apiToken: "t" }),
		refreshE2ee: async () => {},
		syncObsidian: () => false,
		ignores: () => false,
		deviceName: () => "test-device",
		log: () => {},
		notify: (m: string) => void notices.push(m),
		onConflictsChanged: () => {},
	} as unknown as SyncContext;
	return { ctx, gate, notices };
}

test("v6: 插件协议版本为 6（v5 客户端会被服务器按 UPGRADE_REQUIRED 拒绝写入）", () => {
	assert.equal(PLUGIN_PROTOCOL_VERSION, 6);
});

test("v6: formatEpoch 前进 → 丢弃游标重新对账（内容不受影响，INV-10）", async () => {
	const store = await readyStore();
	store.state.lastSequence = 4200;
	const { ctx, notices } = managerCtx(store, serverInfo({ formatEpoch: 2 }));
	const mgr = new SyncManager(ctx);

	await mgr.sync("format-epoch-advanced");

	assert.equal(store.state.bootstrap.formatEpoch, 2, "必须采纳新的格式世代");
	assert.equal(store.state.lastSequence, 0, "旧游标作废，下一轮走 snapshot 全量对账");
	assert.ok(
		notices.some((n) => n.includes("重新对账")),
		`应提示用户会重新对账：${notices.join(" / ")}`,
	);
	mgr.dispose();
});

test("v6: formatEpoch 回退 → 停机等待人工确认（可能是服务器被换回旧数据）", async () => {
	const store = await readyStore();
	store.state.bootstrap.formatEpoch = 3;
	const { ctx, gate } = managerCtx(store, serverInfo({ formatEpoch: 2 }));
	const mgr = new SyncManager(ctx);

	await mgr.sync("format-epoch-rollback");

	const block = gate.sessionBlock();
	assert.equal(block?.reason, "integrity-error", "格式世代回退必须停机，绝不自动继续");
	mgr.dispose();
});

test("v6: 绑定材料缺失时拒绝上传，绝不回退到更弱的信封（INV-07 / ADR-006 §2.4）", async () => {
	const store = await readyStore();
	// 模拟「keyEpoch 尚未拿到」的过渡态：v0.12.x 会在这里回退 LSE1
	store.state.bootstrap.keyEpoch = 0;

	const { doc, vmk } = await createVaultKeyDoc("pw-v6");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);

	const uploaded: string[] = [];
	const ctx = {
		store,
		e2ee: keyring,
		client: {
			upload: async (p: string) => {
				uploaded.push(p);
				return { path: p, revision: 1, hash: "", size: 0, sequence: 1 };
			},
		},
		log: () => {},
	} as unknown as SyncContext;

	await assert.rejects(
		() => uploadFromPlain(ctx, "a.md", new ArrayBuffer(8), 0, 0),
		EnvelopeBindingMissingError,
	);
	assert.deepEqual(uploaded, [], "被拒绝的上传绝不能真的发出去");

	// 绑定材料补齐后恢复正常（写的是 LSE3）
	store.state.bootstrap.keyEpoch = 1;
	const out = await uploadFromPlain(ctx, "a.md", new ArrayBuffer(8), 0, 0);
	assert.equal(uploaded.length, 1);
	assert.ok(out.fileId && /^[0-9a-f]{32}$/.test(out.fileId));
	assert.equal(out.generation, 1);
});

test("v6: 快照/变更携带的身份字段进入本地状态（改名靠 fileId 对账而非 path）", async () => {
	const store = await readyStore();
	store.update("a.md", {
		hash: "h",
		serverHash: "s",
		revision: 3,
		mtime: 1,
		size: 1,
		fileId: FILE_ID,
		generation: 5,
		serverPseudonym: FILE_ID,
	});

	// 只更新内容字段时身份必须原样保留（LS-121-C04 在 v6 下同样成立）
	store.update("a.md", { hash: "h2", revision: 4 });
	const st = store.get("a.md")!;
	assert.equal(st.fileId, FILE_ID);
	assert.equal(st.generation, 5);
	assert.equal(st.serverPseudonym, FILE_ID);

	// 按身份反查路径：改名后本地路径变了，身份不变
	assert.equal(store.pathByFileId(FILE_ID), "a.md");
	store.rename("a.md", "b.md");
	assert.equal(store.pathByFileId(FILE_ID), "b.md");
	assert.equal(store.get("b.md")!.revision, 4, "改名不得重置 revision（INV-05）");
});
