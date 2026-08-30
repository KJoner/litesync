// v0.18 回归测试：API Token 重置的设备端恢复路径（v11 设计 §4.6）。
//
// 覆盖：
//   401/TOKEN_REVOKED：撤销类拒绝给出「填新 Token → 测试连接」指引，不再引向
//     「配对」（那条路会强制重跑接入向导做全量对账）；常驻通知在恢复后被主动撤下
//   重置凭证自动补登记：E2EE 已解锁且服务器未登记时上报 HKDF(VMK) 派生值，
//     每会话最多一次；未解锁/已登记时不动
//   派生一致性：resetAuth 由 VMK 决定，与调用次数无关（幂等登记的前提）
//
// INV: INV-10（凭据变化重新绑定；恢复路径保留全部本地状态）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { ApiError } from "../src/api/client";
import { createVaultKeyDoc } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { PendingQueue } from "../src/sync/queue";
import { SyncManager } from "../src/sync/sync-manager";

const VAULT_ID = "vault-0123456789ab";

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
		metaState: "plain",
		completedAt: 0,
	};
	return store;
}

const INFO = {
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
};

interface NoticeRec {
	msg: string;
	duration?: number;
	hidden: boolean;
}

function managerWith(opts: {
	store: StateStore;
	keyring?: Keyring;
	client: Record<string, unknown>;
	notices: NoticeRec[];
}): SyncManager {
	const base: Record<string, unknown> = {
		app: { vault: { adapter: {}, configDir: ".obsidian", getFiles: () => [] } },
		store: opts.store,
		queue: new PendingQueue(),
		gate: new SyncGate(),
		e2ee: opts.keyring ?? new Keyring(),
		client: opts.client,
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => ".obsidian/plugins/litesync",
		padsSize: () => false,
		reportedMtime: (m: number) => m,
		syncObsidian: () => false,
		log: () => {},
		credentials: () => ({ serverUrl: "https://a", apiToken: "t" }),
		refreshE2ee: async () => {},
		onConflictsChanged: () => {},
		notify: (msg: string, duration?: number) => {
			const rec: NoticeRec = { msg, duration, hidden: false };
			opts.notices.push(rec);
			return { hide: () => void (rec.hidden = true) };
		},
	};
	return new SyncManager(base as unknown as SyncContext);
}

test("v18: TOKEN_REVOKED → 指引「填新 Token + 测试连接」，恢复后常驻通知自动撤下", async () => {
	const store = await readyStore();
	let revoked = true;
	const notices: NoticeRec[] = [];
	const mgr = managerWith({
		store,
		notices,
		client: {
			info: async () => {
				if (revoked) {
					throw new ApiError(401, "info failed: HTTP 401", "TOKEN_REVOKED");
				}
				return INFO;
			},
			whoami: async () => ({ tokenType: "device" as const }),
			changes: async () => ({ latestSequence: 0, hasMore: false, changes: [] }),
		},
	});

	await mgr.sync("interval");
	assert.equal(notices.length, 1, "撤销必须弹常驻提示");
	assert.equal(notices[0].duration, 0, "提示必须常驻");
	assert.ok(notices[0].msg.includes("测试连接"), "必须给出「测试连接」恢复指引");
	assert.ok(notices[0].msg.includes("新的 API Token"), "必须指向填新 Token");
	assert.ok(!notices[0].msg.includes("配对"), "不得引向配对（那会强制重跑向导做全量对账）");
	assert.ok(notices[0].msg.includes("不受影响"), "必须说明本地数据无损");

	// 状态面保留（INV-10 的恢复语义：不清游标、不清文件状态）
	store.state.lastSequence = 42;
	revoked = false;
	await mgr.sync("manual");
	assert.equal(notices[0].hidden, true, "恢复后常驻通知必须被主动撤下，而不是等用户点掉");
	assert.equal(store.state.lastSequence, 42, "恢复不得触碰游标");
	mgr.dispose();
});

test("v18: 通用 401（无 code）文案同样不引向配对", async () => {
	const store = await readyStore();
	const notices: NoticeRec[] = [];
	const mgr = managerWith({
		store,
		notices,
		client: {
			info: async () => {
				throw new ApiError(401, "info failed: HTTP 401");
			},
		},
	});
	await mgr.sync("interval");
	assert.equal(notices.length, 1);
	assert.ok(!notices[0].msg.includes("配对"), notices[0].msg);
	assert.ok(notices[0].msg.includes("测试连接"), "恢复指引统一指向测试连接");
	mgr.dispose();
});

test("v18: 重置凭证自动补登记——解锁且未登记时上报一次；已登记/未解锁不动", async () => {
	const { doc, vmk } = await createVaultKeyDoc("pw-v18");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);

	const registered: string[] = [];
	const mkClient = (configured: boolean) => ({
		info: async () => ({ ...INFO, resetAuthConfigured: configured }),
		whoami: async () => ({ tokenType: "device" as const }),
		changes: async () => ({ latestSequence: 0, hasMore: false, changes: [] }),
		checkpoints: async () => ({ repoEpoch: "epoch-1", checkpoints: [], conflicting: [], signingKeys: {}, revokedDevices: [] }),
		registerResetAuth: async (v: string) => void registered.push(v),
	});

	// 未登记 + 已解锁 → 补登记恰好一次（第二轮被会话标志挡住）
	const store = await readyStore();
	const mgr = managerWith({ store, keyring, notices: [], client: mkClient(false) });
	await mgr.sync("interval");
	await mgr.sync("interval");
	assert.equal(registered.length, 1, "每会话最多补登记一次");
	assert.match(registered[0], /^[0-9a-f]{64}$/, "凭证是 HKDF 派生的 32 字节 hex");
	// 派生值由 VMK 决定：再次派生结果一致（服务端幂等登记的前提）
	assert.equal(await keyring.resetAuth(), registered[0]);
	mgr.dispose();

	// 已登记 → 不动
	const store2 = await readyStore();
	const registered2Before = registered.length;
	const mgr2 = managerWith({ store: store2, keyring, notices: [], client: mkClient(true) });
	await mgr2.sync("interval");
	assert.equal(registered.length, registered2Before, "服务器已登记时不重复上报");
	mgr2.dispose();

	// 未解锁 → resetAuth() 为 null，不上报
	const store3 = await readyStore();
	const locked = new Keyring();
	const before = registered.length;
	const mgr3 = managerWith({ store: store3, keyring: locked, notices: [], client: mkClient(false) });
	await mgr3.sync("interval");
	assert.equal(registered.length, before, "未解锁不得尝试登记");
	assert.equal(await locked.resetAuth(), null);
	mgr3.dispose();
});

test("v18: 服务器加密状态矛盾（文档 enabled + keyEpoch=0）→ 显式停机与可行动提示，恢复后撤下", async () => {
	const { doc, vmk } = await createVaultKeyDoc("pw-mismatch");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);

	const store = await readyStore();
	store.state.bootstrap!.keyEpoch = 0; // 接入时服务器就声称 plaintext（真实事故形态）

	let serverKeyEpoch = 0;
	const notices: NoticeRec[] = [];
	let pushProbe = 0;
	const mgr = managerWith({
		store,
		keyring,
		notices,
		client: {
			info: async () => ({ ...INFO, keyEpoch: serverKeyEpoch, encryptionState: serverKeyEpoch > 0 ? "encrypted" : "plaintext" }),
			whoami: async () => ({ tokenType: "device" as const }),
			changes: async () => {
				pushProbe++; // 走到 pull 说明没被拦住
				return { latestSequence: 0, hasMore: false, changes: [] };
			},
			checkpoints: async () => ({ repoEpoch: "epoch-1", checkpoints: [], conflicting: [], signingKeys: {}, revokedDevices: [] }),
		},
	});

	await mgr.sync("interval");
	assert.equal(pushProbe, 0, "矛盾状态必须在 pull/push 之前停机，而不是让每轮在加密处神秘失败");
	assert.equal(notices.length, 1, "必须给出一条常驻提示");
	assert.equal(notices[0].duration, 0);
	assert.ok(notices[0].msg.includes("自相矛盾") && notices[0].msg.includes("keyEpoch"), notices[0].msg);
	await mgr.sync("interval");
	assert.equal(notices.length, 1, "同一矛盾只提示一次，不轰炸");

	// 服务器修好（正常启用推进了 keyEpoch）→ 恢复同步、提示自动撤下
	serverKeyEpoch = 1;
	await mgr.sync("manual");
	assert.ok(pushProbe > 0, "矛盾解除后同步必须恢复");
	assert.equal(notices[0].hidden, true, "恢复后常驻提示必须被主动撤下");
	mgr.dispose();
});

test("v18: vaultId 变化（换账户/换库）→ 作废整本同步账本，本地文件保留、deviceId 保留", async () => {
	const store = await readyStore();
	// 旧仓库的完整账本：files/游标/队列/信任锚——全都是「对旧仓库」的陈述
	store.state.lastSequence = 7;
	store.replaceWithNewObject("笔记.md", {
		hash: "h1", serverHash: "h1", revision: 3, mtime: 1, size: 2,
		fileId: "f".repeat(32), metaGeneration: 1,
	});
	store.state.trustAnchor = {
		repoEpoch: "epoch-1", checkpointHash: "c".repeat(64), headSequence: 7,
		devicePublicKeys: {}, revokedDevices: [],
	} as never;
	store.state.checkpointChain = ["c".repeat(64)];
	const deviceId = store.state.deviceId;

	const notices: NoticeRec[] = [];
	const mgr = managerWith({
		store,
		notices,
		client: {
			// 同一 URL、同一 Token，但对面已是另一个仓库（用户2 的新 vault）
			info: async () => ({ ...INFO, vaultId: "another-vault-identity" }),
			whoami: async () => ({ tokenType: "device" as const }),
		},
	});
	await mgr.sync("interval");

	assert.equal(store.state.bootstrap.status, "pending", "必须退回待接入");
	assert.deepEqual(store.state.files, {}, "旧仓库的 files 账本必须清空——残留会让新仓库的扫描空转出假 synced");
	assert.equal(store.state.lastSequence, 0, "游标必须归零");
	assert.equal(store.state.trustAnchor, null, "旧仓库的信任锚必须清");
	assert.deepEqual(store.state.checkpointChain, [], "checkpoint 链必须清");
	assert.equal(store.state.deviceId, deviceId, "设备身份保留");
	assert.equal(notices.length, 1);
	assert.ok(notices[0].msg.includes("已更换") && notices[0].msg.includes("本地笔记不受影响"), notices[0].msg);
	mgr.dispose();
});

test("v18: local-init 自愈——空远端遇到残留账本时作废重扫（存量坏状态的兜底）", async () => {
	const { bootstrapLocalInit } = await import("../src/bootstrap/bootstrap-manager");
	const store = await readyStore();
	// 旧库残留：账本声称两个文件「已同步」（revision/serverHash 是别的仓库的）
	store.replaceWithNewObject("a.md", {
		hash: "h1", serverHash: "s1", revision: 3, mtime: 1, size: 2,
		fileId: "a".repeat(32), metaGeneration: 1,
	});
	store.replaceWithNewObject("b.md", {
		hash: "h2", serverHash: "s2", revision: 5, mtime: 1, size: 2,
		fileId: "b".repeat(32), metaGeneration: 1,
	});
	store.state.lastSequence = 9;

	const ctx = {
		store,
		log: () => {},
	} as unknown as SyncContext;
	await bootstrapLocalInit(ctx, {
		info: { ...INFO, vaultId: "fresh-vault" },
		snapshotSequence: 0,
		repoEpoch: "epoch-1",
		remoteFiles: [], // 空远端
		localPaths: ["a.md", "b.md"],
		commonCount: 0,
		e2eeEnabled: false,
	} as never);

	assert.equal(store.paths().length, 0, "空远端 + 非空账本 = 陈旧残留，必须作废（否则 scan 一个文件都不会推）");
	assert.equal(store.state.lastSequence, 0, "游标必须归零后再由 completeBootstrap 设为 snapshotSequence(0)");
	assert.equal(store.state.bootstrap.status, "ready", "local-init 正常完成");
	assert.equal(store.state.bootstrap.mode, "local-init");
	mgrNoop();
});

function mgrNoop(): void {}

test("v18: 向导 preflight 的换库对账——pending 状态换 Token 后打开向导，旧账本同样被作废", async () => {
	const { preflight } = await import("../src/bootstrap/bootstrap-manager");
	const store = await readyStore();
	// 事故形态（实测第三回）：上一次失败的向导已把 remoteVaultId **覆盖成
	// 新仓库的值**（preflight 的 pending binding），单纯比较它必然「一致」；
	// 账本（旧仓库的 fileId，下载校验的「期望」就从这来）却原样残留，
	// 且没有归属标记（旧版本状态）——必须按「无主账本」作废
	store.state.bootstrap.status = "pending";
	store.state.bootstrap.remoteVaultId = "user2-vault-identity"; // 已被上次 preflight 覆盖
	store.state.ledgerVaultId = undefined;
	store.replaceWithNewObject("2026年8月29日测试.md", {
		hash: "h1", serverHash: "s1", revision: 2, mtime: 1, size: 2,
		fileId: "ba539437".padEnd(32, "0"), metaGeneration: 1,
	});
	store.state.lastSequence = 23;

	const ctx = {
		store,
		log: () => {},
		ignores: () => false,
		refreshE2ee: async () => {},
		e2ee: new Keyring(),
		app: { vault: { getFiles: () => [{ path: "2026年8月29日测试.md" }] } },
		client: {
			info: async () => ({ ...INFO, vaultId: "user2-vault-identity" }),
			snapshot: async () => ({
				sequence: 5,
				repoEpoch: "epoch-1",
				files: [{ path: "2026年8月29日测试.md", revision: 1, hash: "x", size: 1, mtime: 1, fileId: "fab2cb0e".padEnd(32, "0") }],
			}),
		},
	} as unknown as SyncContext;

	const pre = await preflight(ctx);
	assert.equal(store.paths().length, 0, "旧仓库的账本必须在向导入口作废——否则恢复/合并的下载校验拿旧 fileId 当期望必然失败");
	assert.equal(store.state.lastSequence, 0, "旧游标必须归零");
	assert.equal(store.state.bootstrap.remoteVaultId, "user2-vault-identity", "pending binding 应指向新仓库");
	assert.equal(pre.remoteFiles.length, 1);
	assert.equal(pre.commonCount, 1);
});

test("v18: 账本归属标记——接入完成时写入，同库重跑向导不误清，换库即便 remoteVaultId 被覆盖也能识别", async () => {
	const { preflight, bootstrapLocalInit } = await import("../src/bootstrap/bootstrap-manager");
	const store = await readyStore();
	const mkCtx = (vaultId: string, remote: unknown[]) =>
		({
			store,
			log: () => {},
			ignores: () => false,
			refreshE2ee: async () => {},
			e2ee: new Keyring(),
			app: { vault: { getFiles: () => [{ path: "a.md" }] } },
			client: {
				info: async () => ({ ...INFO, vaultId }),
				snapshot: async () => ({ sequence: 0, repoEpoch: "epoch-1", files: remote }),
			},
		}) as unknown as SyncContext;

	// 接入完成 → 归属确立
	await bootstrapLocalInit(mkCtx("vault-one", []), {
		info: { ...INFO, vaultId: "vault-one" }, snapshotSequence: 0, repoEpoch: "epoch-1",
		remoteFiles: [], localPaths: ["a.md"], commonCount: 0, e2eeEnabled: false,
	} as never);
	assert.equal(store.state.ledgerVaultId, "vault-one", "接入完成时必须写入账本归属");

	// 积累一条账
	store.replaceWithNewObject("a.md", {
		hash: "h", serverHash: "h", revision: 1, mtime: 1, size: 1,
		fileId: "c".repeat(32), metaGeneration: 1,
	});

	// 同库重跑向导：preflight 不得误清（归属一致）
	await preflight(mkCtx("vault-one", []));
	assert.equal(store.paths().length, 1, "同库重跑向导不得作废账本");
	assert.equal(store.state.ledgerVaultId, "vault-one");

	// 换库（哪怕 remoteVaultId 已被上一步 preflight 覆盖）：作废
	await preflight(mkCtx("vault-two", []));
	assert.equal(store.paths().length, 0, "归属标记不随 pending binding 被覆盖，换库必被识别");
	assert.equal(store.state.ledgerVaultId, undefined, "作废后归属一并清除");
});
