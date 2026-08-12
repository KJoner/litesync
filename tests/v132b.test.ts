// v0.13.2 多设备收敛验收测试（计划书 §6.5 / §6.7 / §6.8）。
//
// 覆盖：
//   §6.5 新文件 fileId 预留与持久化（响应丢失后重试不产生第二个对象）
//   §6.7 下载时的 fileId 匹配保护（换身份 = 完整性事件，硬失败并停机）
//   §6.8 认证后的 metaGeneration 规则（回退硬失败 / 幂等重复 / 同世代分叉）
//
// INV: INV-05（对象身份稳定）/ INV-07（信封只升不降）/ INV-09（完整性异常停机）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { DownloadResult } from "../src/api/client";
import {
	createVaultKeyDoc,
	decryptShare,
	encryptShare,
	frameShareContent,
	randomBytes,
	unframeShareContent,
} from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { PendingQueue } from "../src/sync/queue";
import {
	assertMetaGeneration,
	downloadPlain,
	FileIdMismatchError,
	MetaForkError,
	MetaGenerationRollbackError,
	metaFingerprintOf,
	uploadFromPlain,
} from "../src/sync/transfer";

const VAULT_ID = "vault-0123456789ab";

function memAdapter() {
	const files = new Map<string, string>();
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

async function readyStore(adapter = memAdapter()): Promise<StateStore> {
	const store = new StateStore(adapter, "state.json");
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

async function unlockedKeyring(): Promise<Keyring> {
	const { doc, vmk } = await createVaultKeyDoc("pw-132b");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);
	return keyring;
}

// ---------------------------------------------------------------- §6.5

test("§6.5: 新文件的 fileId 在首次上传前就被预留并落盘", async () => {
	const adapter = memAdapter();
	const store = await readyStore(adapter);
	const queue = new PendingQueue();
	queue.onChange = (e) => void (store.state.pendingOps = e);
	queue.persist = () => store.save();
	await queue.add("a.md", "upsert");

	const sent: string[] = [];
	const ctx = {
		store,
		padsSize: () => false,
		reportedMtime: (ms: number) => ms,
		queue,
		e2ee: await unlockedKeyring(),
		gate: new SyncGate(),
		client: {
			upload: async (p: string, _b: number, _h: string, _d: ArrayBuffer, _m: number, _a: string, fileId?: string) => {
				sent.push(fileId ?? "");
				throw new Error("network lost"); // 响应丢失
			},
		},
		log: () => {},
	} as unknown as SyncContext;

	const data = new TextEncoder().encode("hi").buffer as ArrayBuffer;
	await assert.rejects(() => uploadFromPlain(ctx, "a.md", data, 0, 0));
	const reserved = queue.getOp("a.md")?.fileId;
	assert.match(reserved ?? "", /^[0-9a-f]{32}$/, "首次上传前必须已预留 fileId");
	assert.equal(sent[0], reserved);

	// 「重启后重试」：从盘上恢复队列，必须沿用同一个 fileId，
	// 否则服务器上会出现第二个内容相同的对象，此后永久 422
	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	const queue2 = new PendingQueue();
	queue2.restore(store2.state.pendingOps);
	assert.equal(queue2.getOp("a.md")?.fileId, reserved, "重试必须沿用同一 fileId");

	const ctx2 = { ...ctx, store: store2, queue: queue2 } as unknown as SyncContext;
	await assert.rejects(() => uploadFromPlain(ctx2, "a.md", data, 0, 0));
	assert.equal(sent[1], reserved, "第二次尝试仍用同一身份");
});

// ---------------------------------------------------------------- §6.7

/** 构造一个「服务器返回指定 fileId」的下载响应。 */
function downloadOf(data: ArrayBuffer, fileId: string, metaGeneration?: number): DownloadResult {
	return {
		data,
		revision: 2,
		mtime: 0,
		hash: "",
		fileId,
		...(metaGeneration !== undefined ? { metaGeneration: String(metaGeneration) } : {}),
	} as unknown as DownloadResult;
}

test("§6.7: 服务器换掉 fileId → 硬失败、不写本地、不改 tracked、停掉自动同步", async () => {
	const store = await readyStore();
	const gate = new SyncGate();
	store.replaceWithNewObject("a.md", {
		hash: "h",
		serverHash: "s",
		revision: 1,
		mtime: 0,
		size: 1,
		fileId: "a".repeat(32),
		serverPseudonym: "a".repeat(32),
	});

	const ctx = {
		store,
		padsSize: () => false,
		reportedMtime: (ms: number) => ms,
		queue: new PendingQueue(),
		gate,
		e2ee: new Keyring(),
		client: {
			download: async () => downloadOf(new TextEncoder().encode("x").buffer as ArrayBuffer, "b".repeat(32)),
		},
		log: () => {},
	} as unknown as SyncContext;

	await assert.rejects(() => downloadPlain(ctx, "a.md"), FileIdMismatchError);
	assert.equal(store.get("a.md")?.fileId, "a".repeat(32), "tracked 的身份绝不能被改掉");
	const block = gate.sessionBlock();
	assert.equal(block?.reason, "integrity-error", "必须停掉该仓库的自动同步");
});

test("§6.7: 合法的 delete + 重建不会被误判（tracked 已清空，无可比对象）", async () => {
	const store = await readyStore();
	store.replaceWithNewObject("a.md", {
		hash: "h",
		serverHash: "s",
		revision: 1,
		mtime: 0,
		size: 1,
		fileId: "a".repeat(32),
	});
	// 观察到删除 → 本地不再跟踪
	store.markDeleted("a.md");

	const plain = new TextEncoder().encode("x").buffer as ArrayBuffer;
	const ctx = {
		store,
		padsSize: () => false,
		reportedMtime: (ms: number) => ms,
		queue: new PendingQueue(),
		gate: new SyncGate(),
		e2ee: new Keyring(),
		client: { download: async () => downloadOf(plain, "b".repeat(32)) },
		log: () => {},
	} as unknown as SyncContext;

	const dl = await downloadPlain(ctx, "a.md");
	assert.equal(dl.fileId, "b".repeat(32), "重建后的新身份可以正常采纳");
});

// ---------------------------------------------------------------- §6.8

function metaCtx(store: StateStore, gate = new SyncGate()): SyncContext {
	return { store, gate, log: () => {} } as unknown as SyncContext;
}

test("§6.8: 认证后的 metaGeneration 回退 → 硬失败并停机", async () => {
	const store = await readyStore();
	const gate = new SyncGate();
	store.replaceWithNewObject("a.md", {
		hash: "h",
		serverHash: "s",
		revision: 1,
		mtime: 0,
		size: 1,
		metaGeneration: 5,
		metaFingerprint: "fp5",
	});
	assert.throws(
		() => assertMetaGeneration(metaCtx(store, gate), "a.md", 4, "fp4"),
		MetaGenerationRollbackError,
	);
	assert.equal(gate.sessionBlock()?.reason, "integrity-error");
});

test("§6.8: 同世代同指纹 = 幂等重复（正常，不做任何改动）", async () => {
	const store = await readyStore();
	store.replaceWithNewObject("a.md", {
		hash: "h",
		serverHash: "s",
		revision: 1,
		mtime: 0,
		size: 1,
		metaGeneration: 5,
		metaFingerprint: "fp5",
	});
	assert.equal(assertMetaGeneration(metaCtx(store), "a.md", 5, "fp5"), "idempotent");
});

test("§6.8: 同世代不同指纹 = 分叉 → 硬失败并停机", async () => {
	const store = await readyStore();
	const gate = new SyncGate();
	store.replaceWithNewObject("a.md", {
		hash: "h",
		serverHash: "s",
		revision: 1,
		mtime: 0,
		size: 1,
		metaGeneration: 5,
		metaFingerprint: "fp5",
	});
	assert.throws(() => assertMetaGeneration(metaCtx(store, gate), "a.md", 5, "OTHER"), MetaForkError);
	assert.equal(gate.sessionBlock()?.reason, "integrity-error");
});

test("§6.8: 世代前进 → 正常应用", async () => {
	const store = await readyStore();
	store.replaceWithNewObject("a.md", {
		hash: "h",
		serverHash: "s",
		revision: 1,
		mtime: 0,
		size: 1,
		metaGeneration: 5,
		metaFingerprint: "fp5",
	});
	assert.equal(assertMetaGeneration(metaCtx(store), "a.md", 6, "fp6"), "apply");
});

test("§6.8: 指纹取自被认证的密文信封（内容不同 → 指纹必不同）", async () => {
	const a = await metaFingerprintOf("LSM1-envelope-A");
	const b = await metaFingerprintOf("LSM1-envelope-B");
	assert.notEqual(a, b);
	assert.equal(a, await metaFingerprintOf("LSM1-envelope-A"));
	assert.match(a, /^[0-9a-f]{64}$/);
});

test("§6.8: 本地尚无 metaGeneration 时一律按 apply（首次见到该对象）", async () => {
	const store = await readyStore();
	assert.equal(assertMetaGeneration(metaCtx(store), "new.md", 1, "fp1"), "apply");
});

test("§6.8: 旧状态没有指纹时按幂等处理，不误报分叉（升级兼容）", async () => {
	const store = await readyStore();
	store.replaceWithNewObject("a.md", {
		hash: "h",
		serverHash: "s",
		revision: 1,
		mtime: 0,
		size: 1,
		metaGeneration: 5,
	});
	assert.equal(assertMetaGeneration(metaCtx(store), "a.md", 5, "anything"), "idempotent");
});

// ---------------------------------------------------------------- §7.4（v0.13.3）

test("§7.4: 分享显示名随内容一起加密，服务器拿不到真实文件名", async () => {
	const content = new TextEncoder().encode("# 我的日记\n内容").buffer as ArrayBuffer;
	const framed = frameShareContent("2026-08-12 日记.md", content);
	const key = randomBytes(32);
	const payload = await encryptShare(key, framed);

	// 密文里不能以任何可识别的形式出现文件名
	const raw = new TextDecoder("utf-8", { fatal: false }).decode(payload);
	assert.ok(!raw.includes("日记"), "文件名绝不能出现在密文之外");

	const plain = await decryptShare(key, payload);
	assert.ok(plain !== null);
	const out = unframeShareContent(plain!);
	assert.equal(out.name, "2026-08-12 日记.md");
	assert.deepEqual(new Uint8Array(out.content), new Uint8Array(content));
});

test("§7.4: 旧分享（无命名帧）仍能正常查看，整段都是内容", () => {
	const content = new TextEncoder().encode("plain old share").buffer as ArrayBuffer;
	const out = unframeShareContent(content);
	assert.equal(out.name, null, "旧分享没有加密的名字");
	assert.deepEqual(new Uint8Array(out.content), new Uint8Array(content));
});

test("§7.4: 帧头被截断时退化为「无名字」，绝不丢内容", () => {
	// 伪造一个 nameLen 超出实际长度的坏帧
	const bad = new Uint8Array([0x4c, 0x53, 0x4e, 0x31, 0xff, 0xff, 1, 2, 3]);
	const out = unframeShareContent(bad.buffer as ArrayBuffer);
	assert.equal(out.name, null);
	assert.equal(out.content.byteLength, bad.byteLength, "宁可不显示名字，也不能丢掉内容");
});
