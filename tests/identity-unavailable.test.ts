// 0.20.1：服务端（ADR-019）在账号中心暂时无法确认账号状态且超过宽限时，对设备请求统一返回
// 503 {code:"IDENTITY_UNAVAILABLE", retryable:true} + Retry-After；凭据被撤销仍是 401 TOKEN_REVOKED。
//
// 覆盖：
//   客户端：任何端点（包括只看状态码的 changes）收到 503 IDENTITY_UNAVAILABLE 都变成带 code、可重试、带 Retry-After 的
//     ApiError，消息是中文用户文案；其他 503 不受影响；Retry-After 的整数秒 / HTTP 日期 / 非法值 / 上限
//   同步：IDENTITY_UNAVAILABLE 按可重试处理——状态文案「账号中心暂时无法确认你的登录状态，稍后自动重试；本地修改已保留」，
//     不进「需要重新连接」（不置 credential-rejected、不弹常驻通知），队列与游标原样保留，重试不早于 Retry-After
//     （比退避短时按退避）；之后 /info 恢复即照常同步
//   TOKEN_REVOKED 对照：队列保留、置 credential-rejected、常驻通知指向「填新 Token → 测试连接」、不排重试、
//     不用任何别的凭据提交（不发生上传）
//   状态卡：retryNotice 只改「最近同步」一行（warn），主按钮仍是「立即同步」；凭据被拒才是「重新连接」
//
// INV: INV-04（失败的一轮不推进游标）/ INV-10（凭据被拒停机、不换凭据；恢复后状态原样保留）
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { __setRequestUrl } from "obsidian";
import { ApiClient, ApiError, IDENTITY_UNAVAILABLE_TEXT, parseRetryAfter } from "../src/api/client";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { summarizeStatus } from "../src/status-summary";
import type { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { PendingQueue } from "../src/sync/queue";
import { SyncManager } from "../src/sync/sync-manager";

afterEach(() => __setRequestUrl(null));

const VAULT_ID = "vault-0123456789ab";

function client(): ApiClient {
	return new ApiClient(() => ({
		serverUrl: "https://sync.example.com",
		apiToken: "device-credential",
		deviceId: "dev-1",
		vaultChoice: "",
		formatEpoch: 1,
		repoEpoch: "epoch-1",
		keyEpoch: 1,
	}));
}

const identityUnavailable = (retryAfter?: string) => async () => ({
	status: 503,
	text: JSON.stringify({ code: "IDENTITY_UNAVAILABLE", message: "暂时无法向身份中心确认账号状态", retryable: true, error: "identity unavailable" }),
	json: null,
	headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
	arrayBuffer: new ArrayBuffer(0),
});

// ---------- 客户端 ----------

test("客户端：只看状态码的端点（changes）收到 503 IDENTITY_UNAVAILABLE → 带 code、可重试、Retry-After、中文文案的 ApiError", async () => {
	__setRequestUrl(identityUnavailable("60"));
	const e = await client()
		.changes(0)
		.then(() => null)
		.catch((x: unknown) => x);
	assert.ok(e instanceof ApiError, String(e));
	assert.equal(e.status, 503);
	assert.equal(e.is("IDENTITY_UNAVAILABLE"), true);
	assert.equal(e.retryable, true);
	assert.equal(e.retryAfterSeconds, 60);
	assert.equal(e.message, IDENTITY_UNAVAILABLE_TEXT);
	assert.equal(IDENTITY_UNAVAILABLE_TEXT, "账号中心暂时无法确认你的登录状态，稍后自动重试；本地修改已保留");
});

test("客户端：/info 的 503 IDENTITY_UNAVAILABLE 同样识别；其他 503（没有这个 code）照旧", async () => {
	__setRequestUrl(identityUnavailable());
	const e1 = await client()
		.info()
		.catch((x: unknown) => x);
	assert.ok(e1 instanceof ApiError && e1.is("IDENTITY_UNAVAILABLE"));
	assert.equal((e1 as ApiError).retryAfterSeconds, undefined, "没有 Retry-After 头就不编一个");
	__setRequestUrl(async () => ({ status: 503, text: "Service Unavailable", json: null, headers: { "Retry-After": "5" }, arrayBuffer: new ArrayBuffer(0) }));
	const e2 = await client()
		.info()
		.catch((x: unknown) => x);
	assert.ok(e2 instanceof ApiError);
	assert.equal((e2 as ApiError).code, undefined);
	assert.equal((e2 as ApiError).is("IDENTITY_UNAVAILABLE"), false);
});

test("Retry-After：整数秒、HTTP 日期、非法值、上限 1 小时", () => {
	assert.equal(parseRetryAfter("60"), 60);
	assert.equal(parseRetryAfter(" 0 "), 0);
	const now = Date.parse("2026-11-21T12:00:00Z");
	assert.equal(parseRetryAfter("Sat, 21 Nov 2026 12:01:30 GMT", now), 90);
	assert.equal(parseRetryAfter("Sat, 21 Nov 2026 11:59:00 GMT", now), 0, "过去的日期 = 立即可以重试");
	assert.equal(parseRetryAfter("soon"), undefined);
	assert.equal(parseRetryAfter(undefined), undefined);
	assert.equal(parseRetryAfter("86400"), 3600, "离谱值封顶，不让一个响应把同步冻住一整天");
});

// ---------- 同步 ----------

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

interface Harness {
	mgr: SyncManager;
	ctx: SyncContext;
	queue: PendingQueue;
	gate: SyncGate;
	notices: Array<{ msg: string; duration?: number }>;
	logs: string[];
	statuses: Array<[string, string | undefined]>;
	uploads: number;
}

function harness(store: StateStore, info: () => Promise<unknown>): Harness {
	const h = { notices: [], logs: [], statuses: [], uploads: 0 } as unknown as Harness;
	h.queue = new PendingQueue();
	h.gate = new SyncGate();
	const ctx = {
		app: { vault: { adapter: {}, configDir: ".obsidian", getFiles: () => [] } },
		store,
		queue: h.queue,
		gate: h.gate,
		e2ee: new Keyring(),
		client: {
			info,
			whoami: async () => ({ tokenType: "device" as const }),
			changes: async () => ({ latestSequence: store.state.lastSequence, hasMore: false, changes: [] }),
			checkpoints: async () => ({ repoEpoch: "epoch-1", checkpoints: [], conflicting: [], signingKeys: {}, revokedDevices: [] }),
			upload: async () => {
				h.uploads++;
				throw new Error("不该上传");
			},
		},
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => ".obsidian/plugins/litesync",
		padsSize: () => false,
		reportedMtime: (m: number) => m,
		syncObsidian: () => false,
		log: (m: string) => void h.logs.push(m),
		credentials: () => ({ serverUrl: "https://a", apiToken: "device-credential" }),
		refreshE2ee: async () => {},
		onConflictsChanged: () => {},
		notify: (msg: string, duration?: number) => {
			h.notices.push({ msg, duration });
			return { hide: () => {} };
		},
	};
	h.ctx = ctx as unknown as SyncContext;
	h.mgr = new SyncManager(h.ctx);
	h.mgr.onStatus = (s: string, d?: string) => void h.statuses.push([s, d]);
	return h;
}

test("同步：503 IDENTITY_UNAVAILABLE → 中文状态文案、不进「需要重新连接」、队列与游标原样、重试不早于 Retry-After；恢复后照常同步", async () => {
	const store = await readyStore();
	store.state.lastSequence = 42;
	let unavailable = true;
	const h = harness(store, async () => {
		if (unavailable) {
			const e = new ApiError(503, IDENTITY_UNAVAILABLE_TEXT, "IDENTITY_UNAVAILABLE", true);
			e.retryAfterSeconds = 60;
			throw e;
		}
		return { ...INFO, latestSequence: 42, headSequence: 42 };
	});
	try {
		h.queue.stage("note.md", { action: "upsert" });
		await h.mgr.sync("interval");
		assert.deepEqual(h.statuses.at(-1), ["offline", IDENTITY_UNAVAILABLE_TEXT]);
		assert.notEqual(h.gate.sessionBlock()?.reason, "credential-rejected", "不是凭据问题：不置 credential-rejected，不进「需要重新连接」");
		assert.deepEqual(h.notices, [], "不弹常驻通知");
		assert.ok(h.logs.includes("retry in 60s"), `重试不早于 Retry-After（实际：${h.logs.filter((l) => l.startsWith("retry")).join(" / ")}）`);
		assert.equal(h.queue.size, 1, "本地修改保留在队列里");
		assert.equal(store.state.lastSequence, 42, "失败的一轮不推进游标（INV-04）");
		assert.equal(h.uploads, 0);
		assert.ok(h.mgr.lastSyncError instanceof ApiError && (h.mgr.lastSyncError as ApiError).is("IDENTITY_UNAVAILABLE"));
		// 恢复：/info 重新可用 → 照常同步，状态面不受影响
		unavailable = false;
		h.queue.remove("note.md");
		await h.mgr.sync("retry");
		assert.equal(h.statuses.at(-1)?.[0], "synced", JSON.stringify(h.statuses.at(-1)) + " / " + h.logs.slice(-3).join(" | "));
		assert.equal(h.mgr.lastSyncError, null);
	} finally {
		h.mgr.dispose();
	}
});

test("同步：Retry-After 比退避短时按退避（只拉长、不缩短）", async () => {
	const store = await readyStore();
	const h = harness(store, async () => {
		const e = new ApiError(503, IDENTITY_UNAVAILABLE_TEXT, "IDENTITY_UNAVAILABLE", true);
		e.retryAfterSeconds = 1;
		throw e;
	});
	try {
		await h.mgr.sync("interval");
		assert.ok(h.logs.includes("retry in 5s"), h.logs.join(" / "));
	} finally {
		h.mgr.dispose();
	}
});

test("对照 TOKEN_REVOKED：队列保留、置 credential-rejected、常驻通知指向「填新 Token → 测试连接」、不排重试、不用任何别的凭据提交", async () => {
	const store = await readyStore();
	store.state.lastSequence = 7;
	const infoCalls: number[] = [];
	const h = harness(store, async () => {
		infoCalls.push(1);
		throw new ApiError(401, "info failed: HTTP 401", "TOKEN_REVOKED");
	});
	try {
		h.queue.stage("draft.md", { action: "upsert" });
		await h.mgr.sync("interval");
		assert.equal(h.gate.sessionBlock()?.reason, "credential-rejected");
		assert.equal(h.notices.length, 1);
		assert.equal(h.notices[0].duration, 0, "常驻");
		assert.match(h.notices[0].msg, /新的 API Token/);
		assert.match(h.notices[0].msg, /测试连接/);
		assert.equal(h.logs.some((l) => l.startsWith("retry in")), false, "撞墙的重试没有意义：不排重试");
		assert.equal(h.queue.size, 1, "待推送的修改保留");
		assert.equal(store.state.lastSequence, 7);
		assert.equal(h.uploads, 0, "不会拿别的凭据把队列提交出去");
		assert.equal(infoCalls.length, 1);
		assert.equal(h.statuses.at(-1)?.[0], "offline");
	} finally {
		h.mgr.dispose();
	}
});

// ---------- 状态卡 ----------

test("状态卡：retryNotice 只改「最近同步」一行（warn），主按钮仍是「立即同步」；凭据被拒才是「重新连接」", () => {
	const base = {
		configured: true,
		bootstrapReady: true,
		credentialRejected: false,
		e2ee: "unlocked" as const,
		vaultName: "QA",
		lastSyncAt: 1_000,
		conflicts: 0,
		migrationPending: false,
		keyPolicyText: "严格会话解锁",
		syncing: false,
		now: 61_000,
	};
	const s = summarizeStatus({ ...base, retryNotice: IDENTITY_UNAVAILABLE_TEXT });
	const last = s.lines.find((l) => l.label === "最近同步")!;
	assert.match(last.value, /^账号中心暂时无法确认你的登录状态，稍后自动重试；本地修改已保留（上次成功：1 分钟前）$/);
	assert.equal(last.tone, "warn");
	assert.deepEqual(s.primary, { kind: "sync-now", label: "立即同步" });
	assert.equal(s.lines.find((l) => l.label === "设备授权")?.value, "已授权");
	assert.deepEqual(summarizeStatus({ ...base, credentialRejected: true }).primary, { kind: "reconnect", label: "重新连接" });
	assert.equal(summarizeStatus(base).lines.find((l) => l.label === "最近同步")?.tone, "muted");
});
