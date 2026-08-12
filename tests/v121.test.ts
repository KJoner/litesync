// v0.12.1 止血版验收测试（计划书 §3.3）。
//
// 覆盖：
//   LS-121-C02 设置/身份变化强制重新绑定（换 server URL 后写操作被拒）
//   LS-121-C03 keyEpoch / fileId / generation 集中校验（非法值硬失败）
//   LS-121-C04 FileState 身份字段不再丢失
//   LS-121-C05 meta 模式下 history 使用伪名（真实路径不出现在请求里）
//   LS-121-C06 fullSync 等待所有实际轮次结束
//   LS-121-C07 手动命令共用同步安全 gate（状态损坏时历史恢复被拒）
//
// INV: INV-03 / INV-05 / INV-07 / INV-09 / INV-10
import assert from "node:assert/strict";
import { test } from "node:test";

// SyncManager 使用 window.setTimeout/clearTimeout 做退避重试；Node 下用 globalThis 顶替
(globalThis as unknown as { window: unknown }).window = globalThis;

import { ChangesResponse, ServerInfo } from "../src/api/client";
import { createVaultKeyDoc, encryptFileV3, encryptMeta, deriveMetaKeys, exportVmkRaw } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { computeBinding, StateStore } from "../src/state/store";
import { SyncContext } from "../src/sync/context";
import { requireSyncSafe, SyncBlockedError, SyncGate, syncGateBlock } from "../src/sync/gate";
import { PendingQueue } from "../src/sync/queue";
import { SyncManager } from "../src/sync/sync-manager";
import { historyOf, MetaPathUnresolvedError, serverPathOf } from "../src/sync/transfer";
import { isFileId, isGeneration, isKeyEpoch, ProtocolValueError, requireKeyEpoch } from "../src/utils/validate";

const VAULT_ID = "vault-0123456789ab";
const FILE_ID = "0123456789abcdef0123456789abcdef";

function memAdapter(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	return {
		files,
		exists: async (p: string) => files.has(p),
		read: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error("not found");
			return v;
		},
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
		completedAt: 0,
	};
	return store;
}

// ---------- LS-121-C03：集中式协议值校验 ----------

test("C03: keyEpoch / fileId / generation 的合法区间", () => {
	// keyEpoch ∈ [1, 2^32)：0 与 2^32 都不合法（0 表示未知，不能用于加密）
	assert.equal(isKeyEpoch(1), true);
	assert.equal(isKeyEpoch(0xffff_ffff), true);
	assert.equal(isKeyEpoch(0), false);
	assert.equal(isKeyEpoch(0x1_0000_0000), false);
	assert.equal(isKeyEpoch(-1), false);
	assert.equal(isKeyEpoch(1.5), false);
	assert.equal(isKeyEpoch("1"), false);

	// fileId：小写 32 位十六进制
	assert.equal(isFileId(FILE_ID), true);
	assert.equal(isFileId(FILE_ID.toUpperCase()), false);
	assert.equal(isFileId(FILE_ID.slice(1)), false);
	assert.equal(isFileId("../../etc/passwd"), false);
	assert.equal(isFileId(undefined), false);

	// generation：非负安全整数
	assert.equal(isGeneration(0), true);
	assert.equal(isGeneration(Number.MAX_SAFE_INTEGER), true);
	assert.equal(isGeneration(Number.MAX_SAFE_INTEGER + 2), false);
	assert.equal(isGeneration(-1), false);
});

test("C03: 非法 keyEpoch 绝不被 >>> 0 静默截断，而是硬失败", async () => {
	const { vmk } = await createVaultKeyDoc("pw-c03");
	const raw = await exportVmkRaw(vmk);
	const keys = await deriveMetaKeys(raw);
	raw.fill(0);
	const plain = new TextEncoder().encode("x").buffer as ArrayBuffer;

	// 2^32 在旧实现里会被 `>>> 0` 截断成 0，写出永远解不开的密文
	await assert.rejects(
		() => encryptFileV3(vmk, { vaultId: VAULT_ID, keyEpoch: 0x1_0000_0000, fileId: FILE_ID, generation: 1 }, plain),
		ProtocolValueError,
	);
	await assert.rejects(
		() => encryptMeta(keys, { vaultId: VAULT_ID, keyEpoch: 0, fileId: FILE_ID, metaGeneration: 1 }, { path: "a.md" }),
		ProtocolValueError,
	);
	// 非法 fileId 同样拒绝（AAD 绑定它）
	await assert.rejects(
		() => encryptFileV3(vmk, { vaultId: VAULT_ID, keyEpoch: 1, fileId: "not-hex", generation: 1 }, plain),
		ProtocolValueError,
	);
	assert.throws(() => requireKeyEpoch(undefined, "test"), ProtocolValueError);
});

test("C03: 状态文件里出现非法身份字段 → corrupted 停机，绝不带病继续", async () => {
	const bad = JSON.stringify({
		deviceId: "dev-1",
		lastSequence: 9,
		files: { "a.md": { hash: "h", serverHash: "h", revision: 1, mtime: 1, size: 1, fileId: "NOT-A-FILE-ID" } },
	});
	const store = new StateStore(memAdapter({ "state.json": bad }), "state.json");
	await store.load();
	assert.equal(store.corrupted, true);
	assert.equal(store.paths().length, 0, "停机状态下不得使用任何猜测状态");
});

// ---------- LS-121-C04：FileState 身份字段不丢失 ----------

test("C04: store.update 合并更新——身份字段绝不被半套字段的写入抹掉", async () => {
	const store = await readyStore();
	store.set("a.md", {
		hash: "h1",
		serverHash: "s1",
		revision: 3,
		mtime: 100,
		size: 10,
		fileId: FILE_ID,
		generation: 7,
		metaGeneration: 2,
		serverPseudonym: FILE_ID,
	});

	// 旧代码风格的「只写内容字段」更新
	store.update("a.md", { hash: "h2", serverHash: "s2", revision: 4, mtime: 200, size: 20 });
	const after = store.get("a.md")!;
	assert.equal(after.revision, 4);
	assert.equal(after.fileId, FILE_ID, "fileId 必须保留");
	assert.equal(after.generation, 7, "contentGeneration 必须保留");
	assert.equal(after.metaGeneration, 2, "metaGeneration 必须保留");
	assert.equal(after.serverPseudonym, FILE_ID, "服务器伪名必须保留");

	// 显式传 undefined 表示「本次不掌握该字段」，同样不得清空
	store.update("a.md", { fileId: undefined, generation: undefined });
	assert.equal(store.get("a.md")!.fileId, FILE_ID);
	assert.equal(store.get("a.md")!.generation, 7);

	// 显式给新值才覆盖
	store.update("a.md", { generation: 8 });
	assert.equal(store.get("a.md")!.generation, 8);
});

test("C04: rename 搬运状态时身份完整跟随（改名不改身份，INV-05）", async () => {
	const store = await readyStore();
	store.set("old.md", {
		hash: "h",
		serverHash: "s",
		revision: 5,
		mtime: 1,
		size: 2,
		fileId: FILE_ID,
		generation: 9,
		metaGeneration: 3,
		serverPseudonym: FILE_ID,
	});
	store.rename("old.md", "new.md", { metaGeneration: 4 });

	assert.equal(store.get("old.md"), undefined);
	const moved = store.get("new.md")!;
	assert.equal(moved.fileId, FILE_ID);
	assert.equal(moved.generation, 9, "改名不得重置 contentGeneration");
	assert.equal(moved.metaGeneration, 4);
	assert.equal(moved.serverPseudonym, FILE_ID, "伪名不随本地路径变化");
	assert.equal(moved.revision, 5);
});

// ---------- LS-121-C05：meta 模式下 history 使用伪名 ----------

test("C05: meta 模式下 history/version 请求携带伪名，真实路径绝不外泄", async () => {
	const store = await readyStore();
	store.state.bootstrap.metaState = "encrypted";
	store.set("笔记/私密/日记.md", {
		hash: "h",
		serverHash: "s",
		revision: 2,
		mtime: 1,
		size: 1,
		fileId: FILE_ID,
		serverPseudonym: FILE_ID,
	});

	const asked: string[] = [];
	const ctx = {
		store,
		client: {
			history: async (p: string) => {
				asked.push(p);
				return [];
			},
		},
	} as unknown as SyncContext;

	await historyOf(ctx, "笔记/私密/日记.md");
	assert.deepEqual(asked, [FILE_ID]);
	assert.equal(
		asked.some((p) => p.includes("笔记") || p.includes("日记")),
		false,
		"真实路径不得进入 URL / query / Header",
	);
});

test("C05: meta 模式下伪名未知时硬失败，绝不回退真实路径", async () => {
	const store = await readyStore();
	store.state.bootstrap.metaState = "encrypted";
	const ctx = { store } as unknown as SyncContext;

	assert.throws(() => serverPathOf(ctx, "尚未跟踪/文件.md"), MetaPathUnresolvedError);

	// 明文模式照常返回真实路径
	store.state.bootstrap.metaState = "plain";
	assert.equal(serverPathOf(ctx, "a.md"), "a.md");
});

// ---------- LS-121-C07：手动命令共用同步安全 gate ----------

function gateCtx(store: StateStore, gate = new SyncGate(), keyring = new Keyring()): SyncContext {
	return { store, gate, e2ee: keyring, log: () => {} } as unknown as SyncContext;
}

test("C07: 状态损坏时手动历史恢复被拒（不得绕过停机保护，INV-09）", async () => {
	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	store.state.bootstrap = { status: "ready", mode: "merge", completedAt: 0 };
	store.corrupted = true;

	const ctx = gateCtx(store);
	assert.throws(() => requireSyncSafe(ctx, "恢复历史版本"), SyncBlockedError);
	assert.equal(syncGateBlock(ctx)!.reason, "state-corrupted");
});

test("C07: 未接入 / 未绑定 / 迁移中 / 已锁定分别被 gate 拦下", async () => {
	// 未接入
	const pending = new StateStore(memAdapter(), "state.json");
	await pending.load();
	assert.equal(syncGateBlock(gateCtx(pending))!.reason, "bootstrap-pending");

	// 未绑定（SyncGate 默认即 unbound，必须先完成权威校验）
	const store = await readyStore();
	const gate = new SyncGate();
	assert.equal(syncGateBlock(gateCtx(store, gate))!.reason, "unbound");

	// 绑定后放行
	gate.markBound();
	assert.equal(syncGateBlock(gateCtx(store, gate)), null);

	// 迁移中
	gate.beginMigration("路径与文件名加密迁移");
	assert.equal(syncGateBlock(gateCtx(store, gate))!.reason, "migration-active");
	gate.endMigration();

	// 完整性错误优先级最高
	gate.markIntegrityError("服务器返回了不匹配的 fileId");
	assert.equal(syncGateBlock(gateCtx(store, gate))!.reason, "integrity-error");
	gate.clearIntegrityError();

	// E2EE 已启用但未解锁
	const { doc } = await createVaultKeyDoc("pw-gate");
	const locked = new Keyring();
	locked.setDoc({ ...doc, enabled: true });
	assert.equal(syncGateBlock(gateCtx(store, gate, locked))!.reason, "key-locked");
});

// ---------- LS-121-C02 / C06：绑定与 fullSync ----------

interface FakeServer {
	info: ServerInfo;
	changesCalls: number;
	beforeChanges?: () => Promise<void>;
}

function managerCtx(store: StateStore, server: FakeServer, creds: { serverUrl: string; apiToken: string }) {
	const gate = new SyncGate();
	const queue = new PendingQueue();
	const uploads: string[] = [];
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
		queue,
		gate,
		e2ee: new Keyring(),
		client: {
			info: async () => server.info,
			whoami: async () => ({ tokenType: "device" as const }),
			changes: async (): Promise<ChangesResponse> => {
				server.changesCalls++;
				if (server.beforeChanges) await server.beforeChanges();
				return {
					latestSequence: store.state.lastSequence,
					hasMore: false,
					changes: [],
					repoEpoch: server.info.repoEpoch,
				};
			},
			upload: async (p: string) => {
				uploads.push(p);
				return { path: p, revision: 1, hash: "", size: 0, sequence: 1 };
			},
		},
		credentials: () => creds,
		refreshE2ee: async () => {},
		syncObsidian: () => false,
		padsSize: () => false,
		reportedMtime: (ms: number) => ms,
		ignores: () => false,
		deviceName: () => "test-device",
		log: () => {},
		notify: () => {},
		onConflictsChanged: () => {},
	} as unknown as SyncContext;
	return { ctx, gate, queue, uploads };
}

const serverInfo = (): ServerInfo => ({
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
});

test("C02: 首轮同步完成权威校验后才固定绑定；换 server URL 立即回到 unbound", async () => {
	const store = await readyStore();
	const creds = { serverUrl: "https://a.example.com", apiToken: "token-a" };
	const server: FakeServer = { info: serverInfo(), changesCalls: 0 };
	const { ctx, gate } = managerCtx(store, server, creds);
	const mgr = new SyncManager(ctx);

	// 初始：unbound → 任何手动写操作被拒
	assert.equal(syncGateBlock(ctx)!.reason, "unbound");

	await mgr.sync("first");
	assert.equal(gate.isUnbound, false, "权威校验通过后应完成绑定");
	assert.equal(syncGateBlock(ctx), null);
	assert.ok(store.binding !== null);

	// 换 server URL → 立即 unbound，写操作被拒
	creds.serverUrl = "https://b.example.com";
	mgr.invalidateBinding("Server URL 已变化");
	assert.equal(syncGateBlock(ctx)!.reason, "unbound");
	assert.throws(() => requireSyncSafe(ctx, "上传文件"), SyncBlockedError);

	// 重新完成一轮权威校验后才恢复
	await mgr.sync("rebind");
	assert.equal(syncGateBlock(ctx), null);
	assert.equal(store.binding!.serverUrl, "https://b.example.com");
});

test("C02: Token 变化同样使绑定失效（指纹只存不可逆摘要）", async () => {
	const a = await computeBinding({ serverUrl: "https://x/", apiToken: "tok-1", deviceId: "d", vaultKey: null });
	const b = await computeBinding({ serverUrl: "https://x", apiToken: "tok-2", deviceId: "d", vaultKey: null });
	assert.equal(a.serverUrl, "https://x", "URL 末尾斜杠归一化");
	assert.notEqual(a.tokenDigest, b.tokenDigest);
	assert.equal(a.tokenDigest.includes("tok-1"), false, "绝不落盘明文 Token");
	assert.match(a.tokenDigest, /^[0-9a-f]{16}$/);

	const store = await readyStore();
	store.setBinding(a);
	assert.equal(store.isBoundTo(a), true);
	assert.equal(store.isBoundTo(b), false);
});

test("C02: 服务器返回非法 keyEpoch → 停止同步并记完整性错误（不写出解不开的密文）", async () => {
	const store = await readyStore();
	const server: FakeServer = { info: { ...serverInfo(), keyEpoch: 0x1_0000_0000 }, changesCalls: 0 };
	const { ctx, gate } = managerCtx(store, server, { serverUrl: "https://a", apiToken: "t" });
	const mgr = new SyncManager(ctx);

	await mgr.sync("bad-epoch");
	assert.equal(gate.sessionBlock()!.reason, "integrity-error");
	assert.equal(server.changesCalls, 0, "校验未通过时绝不进入 pull/push");
	assert.equal(store.state.bootstrap.keyEpoch, 1, "非法值不得被采纳");
});

test("C06: sync() 在同步进行中不再立即返回，fullSync 等待所有续轮结束", async () => {
	const store = await readyStore();
	let release: (() => void) | null = null;
	const firstRound = new Promise<void>((r) => {
		release = r;
	});
	const server: FakeServer = {
		info: serverInfo(),
		changesCalls: 0,
		beforeChanges: async () => {
			if (server.changesCalls === 1) await firstRound;
		},
	};
	const { ctx } = managerCtx(store, server, { serverUrl: "https://a", apiToken: "t" });
	const mgr = new SyncManager(ctx);

	const p1 = mgr.sync("first");
	await Promise.resolve(); // 让第一轮真正开始并停在 beforeChanges

	let secondDone = false;
	const p2 = mgr.sync("second").then(() => {
		secondDone = true;
	});
	for (let i = 0; i < 20; i++) await Promise.resolve();
	assert.equal(secondDone, false, "第二次 sync 不得在同步链结束前返回（旧实现的 bug）");

	release!();
	await Promise.all([p1, p2]);
	assert.equal(secondDone, true);
	// 第一轮 2 次 pull + 续轮 2 次 pull
	assert.equal(server.changesCalls, 4, "runAgain 触发的续轮必须真的执行完");

	// fullSync：同步收敛且队列为空时才返回
	const before = server.changesCalls;
	await mgr.fullSync("full");
	assert.ok(server.changesCalls > before);
	assert.equal(mgr.isSyncing, false);
	assert.equal(ctx.queue.size, 0);
});

// ---------- LS-121-C01：元数据迁移不执行不可逆 complete ----------

test("C01: 默认构建只做伪名化，绝不调用 complete（明文抹除）", async () => {
	const store = await readyStore();
	const { doc, vmk } = await createVaultKeyDoc("pw-c01");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);

	const gate = new SyncGate();
	gate.markBound();
	const transitions: string[] = [];
	const migrated: string[] = [];
	const convertedTombstones: string[] = [];
	let migratedMetaEnc = "";
	let fullSyncCalls = 0;
	let gateWasActiveDuringFullSync = false;

	const status = (metaState: string) => ({
		metaState,
		migrationId: "mig-1",
		ownerDeviceId: "dev",
		leaseExpiresAt: 0,
		cutoffSequence: 3,
		targetFormatEpoch: 2,
		formatEpoch: 1,
		minimumEnvelopeVersion: 3,
		journal: { pending: 0 },
		plaintextTombstones: 1,
	});

	const ctx = {
		store,
		gate,
		e2ee: keyring,
		queue: new PendingQueue(),
		client: {
			metaTransition: async (action: string) => {
				transitions.push(action);
				return status(action === "begin" ? "migrating" : action === "verify" ? "verifying" : "plain");
			},
			// 迁移前是真实路径；伪名化之后快照返回伪名 + 加密元数据，
			// 客户端全量回验（计划书 §5.5）会亲自解一遍
			snapshot: async () => ({
				sequence: 3,
				files: [
					migrated.length === 0
						? { path: "笔记/a.md", revision: 1, hash: "h", size: 1, mtime: 0, fileId: FILE_ID }
						: {
								path: FILE_ID,
								revision: 1,
								hash: "h",
								size: 1,
								mtime: 0,
								fileId: FILE_ID,
								metaEnc: migratedMetaEnc,
								metaGeneration: 1,
								envelopeVersion: 3,
							},
				],
			}),
			migrateObjectMeta: async (from: string, metaEnc: string) => {
				migrated.push(from);
				migratedMetaEnc = metaEnc;
				return { fileId: FILE_ID, fromPath: from, toPath: FILE_ID, revision: 1, metaGeneration: 1 };
			},
			listPlaintextTombstones: async () => [
				{ fileId: "ffffffffffffffffffffffffffffffff", lastPseudonym: "已删除/旧笔记.md", deletionRevision: 4 },
			],
			migrateTombstone: async (fileId: string) => {
				convertedTombstones.push(fileId);
			},
			validateMetaMigration: async () => ({ ok: true, failures: [] }),
		},
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;

	const { encryptMetadata } = await import("../src/crypto/migration");
	const r = await encryptMetadata(ctx, {
		onProgress: () => {},
		fullSync: async () => {
			fullSyncCalls++;
			// 顺序回归：迁移 gate 必须在 fullSync **之后**才置位，
			// 否则普通同步会被自己挡下，fullSync 永远等不到收敛
			gateWasActiveDuringFullSync = gate.isMigrationActive;
		},
		allowIrreversibleComplete: false,
	});

	assert.equal(fullSyncCalls, 1);
	assert.equal(gateWasActiveDuringFullSync, false, "beginMigration 不得早于 fullSync");
	assert.deepEqual(migrated, ["笔记/a.md"]);
	// tombstone 是**转换**而不是删除：删除屏障必须完整保留（INV-06 / ADR-002）
	assert.deepEqual(convertedTombstones, ["ffffffffffffffffffffffffffffffff"]);
	assert.equal(r.convertedTombstones, 1);
	// 走到 verifying 就停：默认构建绝不调用不可逆的 complete
	assert.deepEqual(transitions, ["begin", "verify"]);
	assert.equal(r.erased, false);
	assert.equal(r.metaState, "verifying", "停在可 abort 回退的状态");
	assert.equal(gate.isMigrationActive, false, "迁移结束后必须释放 gate");

	// 身份与伪名已记录，且 fileId 未被重置（INV-05）
	assert.equal(store.get("笔记/a.md"), undefined, "本地未跟踪该文件时不创建状态");
});

test("C01: 迁移过程抛错时同样释放迁移 gate（不会把插件卡在 migration-active）", async () => {
	const store = await readyStore();
	const { doc, vmk } = await createVaultKeyDoc("pw-c01b");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);
	const gate = new SyncGate();
	gate.markBound();

	const ctx = {
		store,
		gate,
		e2ee: keyring,
		queue: new PendingQueue(),
		client: {
			metaTransition: async () => ({
				metaState: "migrating",
				migrationId: "mig-2",
				ownerDeviceId: "dev",
				leaseExpiresAt: 0,
				cutoffSequence: 0,
				targetFormatEpoch: 2,
				formatEpoch: 1,
				minimumEnvelopeVersion: 3,
				journal: {},
				plaintextTombstones: 0,
			}),
			snapshot: async () => {
				throw new Error("snapshot failed");
			},
		},
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;

	const { encryptMetadata } = await import("../src/crypto/migration");
	await assert.rejects(
		() =>
			encryptMetadata(ctx, {
				onProgress: () => {},
				fullSync: async () => {},
				allowIrreversibleComplete: false,
			}),
		/snapshot failed/,
	);
	assert.equal(gate.isMigrationActive, false);
	assert.equal(syncGateBlock(ctx), null, "失败后普通同步必须能继续");
});

test("C06: 同步轮失败时 fullSync 必须抛错，绝不让迁移当作已收敛继续", async () => {
	const store = await readyStore();
	const server: FakeServer = {
		info: serverInfo(),
		changesCalls: 0,
		beforeChanges: async () => {
			throw new Error("network down");
		},
	};
	const { ctx } = managerCtx(store, server, { serverUrl: "https://a", apiToken: "t" });
	const mgr = new SyncManager(ctx);

	await assert.rejects(() => mgr.fullSync("pre-migration"), /network down/);
	mgr.dispose();
});
