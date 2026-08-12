// v0.13.2 改名收敛验收测试（计划书 §6.9 / §6.10）。
//
// 覆盖：
//   §6.9  rename + edit（先改名再传内容，同一个对象）
//   §6.9  两个文件交换名称（临时名两阶段收敛 + 崩溃续做）
//   §6.10 MOVE 失败绝不先删除远端活对象
//
// INV: INV-02（远端活对象不被隐式删除）/ INV-05（对象身份稳定）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { ApiError } from "../src/api/client";
import { createVaultKeyDoc, encryptMeta } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { recoverInterruptedSwaps } from "../src/sync/pull";
import { PendingQueue } from "../src/sync/queue";

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

/** 内存 Vault（同 §6.1 的替身，但这里还要用到文件夹与 rename 语义）。 */
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
			if (files.has(to)) throw new Error(`EEXIST ${to}`);
			files.delete(from);
			files.set(to, v);
		},
		remove: async (p: string) => void files.delete(p),
		list: async () => ({ files: [] as string[], folders: [] as string[] }),
	};
	return { files, adapter };
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);

async function metaStore(): Promise<StateStore> {
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
		metaState: "encrypted",
		completedAt: 0,
	};
	return store;
}

async function unlockedKeyring(): Promise<Keyring> {
	const { doc, vmk } = await createVaultKeyDoc("pw-132c");
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);
	return keyring;
}

// ---------------------------------------------------------------- §6.9 名字互换

test("§6.9: 两个文件交换名称 → 临时名两阶段收敛，两份内容都在", async () => {
	const store = await metaStore();
	const keyring = await unlockedKeyring();
	const keys = await keyring.metaKeys();
	const vault = memVault();
	vault.files.set("A.md", bytes("内容A"));
	vault.files.set("B.md", bytes("内容B"));

	store.replaceWithNewObject("A.md", {
		hash: "ha", serverHash: "sa", revision: 1, mtime: 1, size: 1,
		fileId: FA, serverPseudonym: FA, metaGeneration: 1,
	});
	store.replaceWithNewObject("B.md", {
		hash: "hb", serverHash: "sb", revision: 1, mtime: 1, size: 1,
		fileId: FB, serverPseudonym: FB, metaGeneration: 1,
	});

	// 远端：A 改名为 B.md，B 改名为 A.md（世代都前进到 2）
	const metaFor = async (fileId: string, path: string): Promise<string> =>
		encryptMeta(keys, { vaultId: VAULT_ID, keyEpoch: 1, fileId, metaGeneration: 2 }, { path });
	const remoteMeta: Record<string, string> = {
		[FA]: await metaFor(FA, "B.md"),
		[FB]: await metaFor(FB, "A.md"),
	};

	const ctx = {
		app: { vault: { adapter: vault.adapter } },
		store,
		queue: new PendingQueue(),
		gate: new SyncGate(),
		e2ee: keyring,
		client: {
			getFileMeta: async (p: string) => ({ metaEnc: remoteMeta[p] }),
			changes: async () => ({ latestSequence: 2, hasMore: false, changes: [] }),
		},
		ignores: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;

	// 直接驱动 pull 的改名路径：applyMetaRename 不是导出的，这里用 changes 流触发
	const { pullRemoteChanges } = await import("../src/sync/pull");
	(ctx.client as unknown as { changes: unknown }).changes = async (since: number) =>
		since === 0
			? {
					latestSequence: 2,
					hasMore: false,
					changes: [
						{ sequence: 1, path: FA, action: "upsert", revision: 1, hash: "sa", metaGeneration: 2 },
						{ sequence: 2, path: FB, action: "upsert", revision: 1, hash: "sb", metaGeneration: 2 },
					],
				}
			: { latestSequence: 2, hasMore: false, changes: [] };

	await pullRemoteChanges(ctx);

	assert.equal(text(vault.files.get("A.md")!), "内容B", "A.md 现在应当是原来 B 的内容");
	assert.equal(text(vault.files.get("B.md")!), "内容A", "B.md 现在应当是原来 A 的内容");
	assert.equal(store.get("B.md")?.fileId, FA, "身份随内容走（INV-05）");
	assert.equal(store.get("A.md")?.fileId, FB);
	assert.deepEqual(store.pendingSwaps(), [], "交换完成后不留临时记录");
	// 临时文件不得残留在插件目录里
	assert.equal([...vault.files.keys()].some((f) => f.startsWith(`${PLUGIN_DIR}/swap/`)), false);
});

test("§6.9: 交换中途崩溃 → 下轮把临时副本放回目标路径", async () => {
	const store = await metaStore();
	const vault = memVault();
	const temp = `${PLUGIN_DIR}/swap/${FA}`;
	// 现场：A 已经被搬到临时名，B → A 还没做完就崩了
	vault.files.set(temp, bytes("内容A"));
	store.setPendingSwap({ tempPath: temp, fileId: FA, targetPath: "B.md" });

	const ctx = {
		app: { vault: { adapter: vault.adapter } },
		store,
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
	} as unknown as SyncContext;

	await recoverInterruptedSwaps(ctx);
	assert.equal(text(vault.files.get("B.md")!), "内容A", "临时副本必须被放回它该去的地方");
	assert.equal(vault.files.has(temp), false);
	assert.deepEqual(store.pendingSwaps(), []);
});

test("§6.9: 目标仍被占用时保留临时副本（绝不覆盖占用者）", async () => {
	const store = await metaStore();
	const vault = memVault();
	const temp = `${PLUGIN_DIR}/swap/${FA}`;
	vault.files.set(temp, bytes("内容A"));
	vault.files.set("B.md", bytes("别人的内容"));
	store.setPendingSwap({ tempPath: temp, fileId: FA, targetPath: "B.md" });

	const ctx = {
		app: { vault: { adapter: vault.adapter } },
		store,
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
	} as unknown as SyncContext;

	await recoverInterruptedSwaps(ctx);
	assert.equal(text(vault.files.get("B.md")!), "别人的内容", "占用者的内容不能被覆盖");
	assert.equal(vault.files.has(temp), true, "临时副本必须留着等下一轮");
	assert.equal(store.pendingSwaps().length, 1);
});

test("§6.9: pendingSwaps 活过重启（崩溃恢复的前提）", async () => {
	const adapter = memAdapter();
	const store = new StateStore(adapter, "state.json");
	await store.load();
	store.setPendingSwap({ tempPath: `${PLUGIN_DIR}/swap/${FA}`, fileId: FA, targetPath: "B.md" });
	await store.save();

	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	assert.deepEqual(store2.pendingSwaps(), [
		{ tempPath: `${PLUGIN_DIR}/swap/${FA}`, fileId: FA, targetPath: "B.md" },
	]);
});

// ---------------------------------------------------------------- §6.10

/**
 * 构造一个「改名接口一律失败」的 push 现场，观察 MOVE 失败时都发生了什么。
 * 关键断言：`remove`（删除远端活对象）绝不能被调用。
 */
async function movePushCtx(renameError: unknown) {
	const store = await metaStore();
	const keyring = await unlockedKeyring();
	const vault = memVault();
	vault.files.set("new.md", bytes("内容"));
	store.replaceWithNewObject("old.md", {
		hash: await (await import("../src/utils/hash")).sha256Hex(bytes("内容")),
		serverHash: "s",
		revision: 3,
		mtime: 1,
		size: 6,
		fileId: FA,
		serverPseudonym: FA,
		metaGeneration: 1,
		generation: 1,
	});

	const calls: string[] = [];
	const queue = new PendingQueue();
	const ctx = {
		app: { vault: { adapter: vault.adapter, getFiles: () => [], configDir: ".obsidian" } },
		store,
		queue,
		gate: new SyncGate(),
		e2ee: keyring,
		client: {
			rename: async () => {
				calls.push("rename");
				throw renameError;
			},
			remove: async () => void calls.push("remove"),
			upload: async (
				p: string,
				_b: number,
				_h: string,
				_d: ArrayBuffer,
				_m: number,
				_a: string,
				fileId?: string,
			) => {
				calls.push(`upload:${p}`);
				return { path: p, revision: 4, hash: "", size: 0, sequence: 5, fileId, metaGeneration: 2 };
			},
			getFileMeta: async () => {
				calls.push("getFileMeta");
				throw new Error("unavailable");
			},
		},
		ignores: () => false,
		syncObsidian: () => false,
		padsSize: () => false,
		reportedMtime: (ms: number) => ms,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;
	return { ctx, calls, store, queue, vault };
}

for (const [label, error] of [
	["422", new ApiError(422, "collision", "CANONICAL_COLLISION")],
	["412", new ApiError(412, "precondition", "STALE_META_GENERATION")],
	["400", new ApiError(400, "bad request", "INVALID_BODY")],
	["404", new ApiError(404, "not found", "NOT_FOUND")],
] as const) {
	test(`§6.10: rename 收到 ${label} 时绝不先删除远端活对象`, async () => {
		const { ctx, calls, queue } = await movePushCtx(error);
		const { pushPendingChanges } = await import("../src/sync/push");
		queue.stage("new.md", { action: "move", from: "old.md" });
		await pushPendingChanges(ctx);

		const removeAt = calls.indexOf("remove");
		const uploadAt = calls.findIndex((c) => c.startsWith("upload:"));
		assert.ok(uploadAt >= 0, `新路径必须先被推上去：${calls.join(",")}`);
		if (removeAt >= 0) {
			assert.ok(removeAt > uploadAt, `删除只能发生在新内容落地之后：${calls.join(",")}`);
		}
	});
}

test("§6.10: 退化时新内容上传失败 → 完全不碰旧对象", async () => {
	const { ctx, calls, queue } = await movePushCtx(new ApiError(400, "bad", "INVALID_BODY"));
	(ctx.client as unknown as { upload: unknown }).upload = async () => {
		calls.push("upload-failed");
		throw new ApiError(413, "too large", "TOO_LARGE");
	};
	const { pushPendingChanges } = await import("../src/sync/push");
	queue.stage("new.md", { action: "move", from: "old.md" });
	await pushPendingChanges(ctx);

	assert.equal(calls.includes("remove"), false, "新内容没落地就删旧对象 = 数据丢失");
});
