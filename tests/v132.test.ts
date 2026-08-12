// v0.13.2 本地安全提交与多设备收敛验收测试（计划书 §6）。
//
// 覆盖：
//   §6.2  StateStore 保存串行化（并发 save 不丢最后一次修改、写后验证）
//   §6.3  durable operation journal（入队先落盘、失败回滚、幂等键语义）
//   §6.4  完整 BlockedChange（字段齐全、durable 后才推进游标、按原始变更重放）
//   §6.12 解密后的路径安全与跨平台碰撞键
//
// INV: INV-01（本地内容永不被静默覆盖）/ INV-03（远端变更不静默丢弃）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { App } from "obsidian";
import { StateStore } from "../src/state/store";
import { CommitIntegrityError, LocalCommitter } from "../src/sync/local-commit";
import { PendingQueue } from "../src/sync/queue";
import { sha256Hex } from "../src/utils/hash";
import {
	InvalidVaultPathError,
	pathsCollide,
	platformCollisionKey,
	tryCanonicalizeVaultPath,
	validateAndCanonicalizeVaultPath,
} from "../src/utils/vault-path";

function memAdapter() {
	const files = new Map<string, string>();
	return {
		files,
		exists: async (p: string) => files.has(p),
		read: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error("ENOENT");
			return v;
		},
		write: async (p: string, d: string) => void files.set(p, d),
	};
}

function storeOn(adapter: ReturnType<typeof memAdapter>): StateStore {
	return new StateStore(adapter as unknown as ConstructorParameters<typeof StateStore>[0], "state.json");
}

// ---------------------------------------------------------------- §6.12

test("§6.12: 拒绝所有不安全的远端路径形态", () => {
	const rejected: Array<[string, string]> = [
		["", "empty"],
		["/etc/passwd", "absolute"],
		["C:/Users/x/a.md", "drive-letter"],
		["//server/share/a.md", "unc"],
		["a\\b.md", "backslash"],
		["../../.ssh/authorized_keys", "traversal"],
		["a/./b.md", "traversal"],
		["a//b.md", "empty-component"],
		["a/\u0001b.md", "control-char"],
		["a/b\u0000.md", "nul"],
		["notes/CON.md", "windows-reserved"],
		["notes/nul", "windows-reserved"],
		["notes/name ", "trailing-space-or-dot"],
		["notes/trailing.", "trailing-space-or-dot"],
		["folder /a.md", "trailing-space-or-dot"], // 中间目录同样要查
		["x".repeat(600), "too-long"],
		[`notes/${"x".repeat(300)}.md`, "component-too-long"],
	];
	for (const [path, reason] of rejected) {
		assert.throws(
			() => validateAndCanonicalizeVaultPath(path),
			(e: unknown) => e instanceof InvalidVaultPathError && e.reason === reason,
			`应以 ${reason} 拒绝：${JSON.stringify(path)}`,
		);
	}
});

test("§6.12: 正常路径原样通过，只做 NFC 归一（绝不「修复」可疑路径）", () => {
	assert.equal(validateAndCanonicalizeVaultPath("notes/日记/2026-08-12.md"), "notes/日记/2026-08-12.md");
	// NFD 的 é（e + U+0301）归一到 NFC 的单码点
	const nfd = "notes/cafe\u0301.md";
	assert.equal(validateAndCanonicalizeVaultPath(nfd), "notes/café.md");
	assert.notEqual(nfd, "notes/café.md", "输入确实是 NFD，测试才有意义");
	assert.equal(tryCanonicalizeVaultPath("../evil"), null);
});

test("§6.12: 错误消息不泄露可疑路径原文（日志隐私）", () => {
	try {
		validateAndCanonicalizeVaultPath("../../secret-project/薪资.md");
		assert.fail("应当被拒绝");
	} catch (e) {
		assert.ok(e instanceof InvalidVaultPathError);
		assert.ok(!e.message.includes("薪资"), `错误消息不得包含路径内容：${e.message}`);
		assert.ok(!e.message.includes("secret-project"), `错误消息不得包含路径内容：${e.message}`);
		assert.match(e.shape, /段 \/ \d+ 字符$/);
	}
});

test("§6.12: 跨平台碰撞键覆盖大小写、NFC/NFD、尾随点与保留名", () => {
	assert.ok(pathsCollide("Notes/A.md", "notes/a.md"), "大小写折叠");
	assert.ok(pathsCollide("notes/café.md", "notes/cafe\u0301.md"), "NFC/NFD");
	assert.ok(pathsCollide("notes/a.md", "notes/a.md."), "Windows 会吃掉尾随句点");
	assert.ok(pathsCollide("notes/a.md", "notes/a.md "), "Windows 会吃掉尾随空格");
	assert.ok(!pathsCollide("notes/a.md", "notes/b.md"));
	// 大小写折叠**始终**执行：同一个 Vault 里可能同时有 Linux 与 macOS 设备
	assert.equal(platformCollisionKey("Notes/A.MD"), platformCollisionKey("notes/a.md"));
});

test("§6.12: StateStore.collidingPath 找出会覆盖已有文件的远端路径", async () => {
	const store = storeOn(memAdapter());
	await store.load();
	store.set("Notes/Alpha.md", { hash: "h", serverHash: "s", revision: 1, mtime: 0, size: 1, fileId: "a".repeat(32) });

	assert.equal(store.collidingPath("notes/alpha.md"), "Notes/Alpha.md", "只差大小写 → 会覆盖");
	assert.equal(store.collidingPath("notes/beta.md"), undefined);
	// 同一个对象自己改大小写不算碰撞（否则永远改不了大小写）
	assert.equal(store.collidingPath("notes/alpha.md", "a".repeat(32)), undefined);
	// 完全相同的路径不算碰撞（那是普通更新）
	assert.equal(store.collidingPath("Notes/Alpha.md"), undefined);
});

// ---------------------------------------------------------------- §6.2

test("§6.2: 并发 save 串行执行，最后一次修改一定落盘", async () => {
	const adapter = memAdapter();
	const store = storeOn(adapter);
	await store.load();

	// 5 次并发保存，每次前先改一点状态
	const saves: Array<Promise<void>> = [];
	for (let i = 1; i <= 5; i++) {
		store.state.lastSequence = i;
		saves.push(store.save());
	}
	await Promise.all(saves);

	const store2 = storeOn(adapter);
	await store2.load();
	assert.equal(store2.state.lastSequence, 5, "并发保存后盘上必须是最后一次的状态");
	assert.equal(store.hasUnsavedChanges, false);
});

test("§6.2: save 期间产生的新修改不会被「已保存」标记吞掉", async () => {
	const adapter = memAdapter();
	const store = storeOn(adapter);
	await store.load();

	store.state.lastSequence = 1;
	const first = store.save();
	// 保存进行中用户又改了状态 —— 这次修改必须要么被这次 save 带上，
	// 要么让 hasUnsavedChanges 保持 true 从而被下一次 save 带上
	store.state.lastSequence = 2;
	const second = store.save();
	await Promise.all([first, second]);

	const store2 = storeOn(adapter);
	await store2.load();
	assert.equal(store2.state.lastSequence, 2);
});

test("§6.2: 写后验证失败 → save 抛错，绝不假装保存成功", async () => {
	const adapter = memAdapter();
	const store = storeOn(adapter);
	await store.load();
	await store.save();

	// 模拟「写下去了但盘上不是我们写的内容」（另一个实例抢写 / 存储损坏）
	const original = adapter.write;
	adapter.write = async (p: string, _d: string) => void adapter.files.set(p, JSON.stringify({ tampered: true }));
	store.state.lastSequence = 99;
	await assert.rejects(() => store.save(), /write verification failed/);
	adapter.write = original;
});

// ---------------------------------------------------------------- §6.3

test("§6.3: 队列条目带完整重试身份（operationId / expected* / localHash）", async () => {
	const q = new PendingQueue();
	await q.add("a.md", "upsert", {
		fileId: "b".repeat(32),
		expectedRevision: 5,
		expectedMetaGeneration: 2,
		expectedContentGeneration: 7,
		localHash: "d".repeat(64),
	});
	const op = q.getOp("a.md")!;
	assert.equal(op.fileId, "b".repeat(32));
	assert.equal(op.expectedRevision, 5);
	assert.equal(op.expectedMetaGeneration, 2);
	assert.equal(op.expectedContentGeneration, 7);
	assert.equal(op.localHash, "d".repeat(64));
	assert.equal(op.status, "queued");
	assert.equal(op.attemptCount, 0);

	// 重试计数与状态进入日志，便于诊断卡住的操作
	q.markAttempt("a.md", "uploading");
	q.markAttempt("a.md", "failed", "CONFLICT");
	assert.equal(q.getOp("a.md")?.attemptCount, 2);
	assert.equal(q.getOp("a.md")?.status, "failed");
	assert.equal(q.getOp("a.md")?.lastError, "CONFLICT");
});

test("§6.3: 同一逻辑操作重试沿用同一 operationId 与 fileId", async () => {
	const q = new PendingQueue();
	await q.add("a.md", "upsert");
	const first = q.getOp("a.md")!;
	q.rememberIdentity("a.md", { fileId: "e".repeat(32), serverPseudonym: "e".repeat(32) });
	// 上传失败后同一路径再次入队（同一个动作）→ 身份必须原样保留，
	// 否则服务器上会出现第二个对象，或者永久 422
	await q.add("a.md", "upsert");
	const again = q.getOp("a.md")!;
	assert.equal(again.operationId, first.operationId);
	assert.equal(again.fileId, "e".repeat(32));
	assert.equal(again.serverPseudonym, "e".repeat(32));
});

test("§6.3: 重启后从盘上恢复 operationId（响应丢失重试不产生第二个对象）", async () => {
	const adapter = memAdapter();
	const store = storeOn(adapter);
	await store.load();
	const q = new PendingQueue();
	q.onChange = (e) => void (store.state.pendingOps = e);
	q.persist = () => store.save();

	await q.add("a.md", "upsert", { fileId: "f".repeat(32) });
	const opId = q.getOp("a.md")!.operationId;

	// 「进程被杀」：新建 store + queue 从盘上恢复
	const store2 = storeOn(adapter);
	await store2.load();
	const q2 = new PendingQueue();
	q2.restore(store2.state.pendingOps);
	assert.equal(q2.getOp("a.md")?.operationId, opId, "幂等键必须活过重启");
	assert.equal(q2.getOp("a.md")?.fileId, "f".repeat(32), "fileId 必须活过重启");
});

// ---------------------------------------------------------------- §6.4

test("§6.4: BlockedChange 保存重放所需的全部字段", async () => {
	const store = storeOn(memAdapter());
	await store.load();
	const key = store.setBlockedChange({
		sequence: 512,
		action: "rename",
		fileId: "a".repeat(32),
		serverPseudonym: "a".repeat(32),
		revision: 9,
		contentHash: "c".repeat(64),
		contentGeneration: 4,
		metaGeneration: 6,
		realPath: "notes/a.md",
		renameFrom: "notes/a.md",
		renameTo: "notes/b.md",
		reason: "远端改名目标已被本地文件占用",
	});
	const rec = store.getBlockedChange(key)!;
	for (const f of [
		"sequence",
		"action",
		"fileId",
		"serverPseudonym",
		"revision",
		"contentHash",
		"contentGeneration",
		"metaGeneration",
		"realPath",
		"renameFrom",
		"renameTo",
		"reason",
		"retryCount",
		"operationId",
	] as const) {
		assert.ok(rec[f] !== undefined, `§6.4 要求保存字段 ${f}`);
	}
});

test("§6.4: 键取 fileId —— 对象改名后不会留下永不清除的孤儿记录", async () => {
	const store = storeOn(memAdapter());
	await store.load();
	const key = store.setBlockedChange({
		sequence: 1,
		action: "upsert",
		fileId: "a".repeat(32),
		realPath: "old.md",
		reason: "r",
	});
	// 该对象随后被改名：用新路径再次登记，仍然命中同一条记录
	store.setBlockedChange({ sequence: 2, action: "upsert", fileId: "a".repeat(32), realPath: "new.md", reason: "r" });
	assert.equal(store.blockedChanges().length, 1);
	assert.equal(store.getBlockedChange(key)?.realPath, "new.md");
	assert.equal(store.getBlockedChange(key)?.retryCount, 2);
});

test("§6.4: 没有 fileId 的记录退回按路径为键（明文模式）", async () => {
	const store = storeOn(memAdapter());
	await store.load();
	const key = store.setBlockedChange({ sequence: 1, action: "upsert", realPath: "notes/a.md", reason: "r" });
	assert.equal(key, "notes/a.md");
});

// ---------------------------------------------------------------- §6.1

/** 最小内存 Vault：只实现 LocalCommitter 用到的 adapter 面。 */
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
		list: async (dir: string) => ({
			files: [...files.keys()].filter((f) => f.startsWith(dir + "/")),
			folders: [] as string[],
		}),
	};
	return { files, adapter, app: { vault: { adapter } } as unknown as App };
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);

const PLUGIN_DIR = ".obsidian/plugins/litesync";

test("§6.1: 前置条件满足 → 安装成功，旧内容进 recovery（可找回）", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	v.files.set("a.md", bytes("old"));

	const res = await c.commitRemoteChange({
		operationId: "op1",
		realPath: "a.md",
		expectedLocalHash: await sha256Hex(bytes("old")),
		incoming: bytes("new"),
		incomingHash: await sha256Hex(bytes("new")),
		conflictPolicy: "fail",
	});

	assert.equal(res.status, "committed");
	assert.equal(text(v.files.get("a.md")!), "new");
	// 被换下来的旧内容必须还在——「覆盖」在这里始终是可撤销的
	assert.equal(res.recoveryPath, `${PLUGIN_DIR}/recovery/op1`);
	assert.equal(text(v.files.get(res.recoveryPath!)!), "old");
});

test("§6.1: 本地在此期间被改动 → 拒绝写入，用户内容原样保留（INV-01）", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	v.files.set("a.md", bytes("用户刚敲下的内容"));

	const res = await c.commitRemoteChange({
		operationId: "op2",
		realPath: "a.md",
		expectedLocalHash: await sha256Hex(bytes("决策时刻的内容")), // 与盘上不符
		incoming: bytes("远端版本"),
		incomingHash: await sha256Hex(bytes("远端版本")),
		conflictPolicy: "keep-both",
	});

	assert.equal(res.status, "precondition-failed");
	assert.equal(text(v.files.get("a.md")!), "用户刚敲下的内容");
});

test("§6.1: 期望「本地不存在」但文件已出现 → 拒绝（新建路径也不覆盖）", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	v.files.set("a.md", bytes("别人先建的"));

	const res = await c.commitRemoteChange({
		operationId: "op3",
		realPath: "a.md",
		expectedLocalHash: null,
		incoming: bytes("x"),
		incomingHash: await sha256Hex(bytes("x")),
		conflictPolicy: "fail",
	});
	assert.equal(res.status, "precondition-failed");
	assert.equal(text(v.files.get("a.md")!), "别人先建的");
});

test("§6.1: 内容 hash 与声明不符 → 硬失败，绝不落盘", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	await assert.rejects(
		() =>
			c.commitRemoteChange({
				operationId: "op4",
				realPath: "a.md",
				expectedLocalHash: null,
				incoming: bytes("真实内容"),
				incomingHash: "0".repeat(64), // 声明与实际不符
				conflictPolicy: "fail",
			}),
		CommitIntegrityError,
	);
	assert.equal(v.files.has("a.md"), false);
});

test("§6.1: 不安全路径 → rejected，不产生任何文件", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	const res = await c.commitRemoteChange({
		operationId: "op5",
		realPath: "../../.ssh/authorized_keys",
		expectedLocalHash: null,
		incoming: bytes("x"),
		incomingHash: await sha256Hex(bytes("x")),
		conflictPolicy: "fail",
	});
	assert.equal(res.status, "rejected");
	assert.equal(v.files.size, 0);
});

test("§6.1: 目标被文件夹占用 → rejected，不删除文件夹", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	await v.adapter.mkdir("notes");
	const res = await c.commitRemoteChange({
		operationId: "op6",
		realPath: "notes",
		expectedLocalHash: null,
		incoming: bytes("x"),
		incomingHash: await sha256Hex(bytes("x")),
		conflictPolicy: "fail",
	});
	assert.equal(res.status, "rejected");
	assert.match(res.reason ?? "", /文件夹/);
});

test("§6.1: 安装失败 → 旧内容自动从 recovery 还原（不留半个文件）", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	v.files.set("a.md", bytes("old"));

	// 让「安装」这一步的 rename 失败：第 1 次 rename 是把旧内容搬进 recovery
	const realRename = v.adapter.rename;
	let calls = 0;
	v.adapter.rename = async (from: string, to: string) => {
		if (++calls === 2) throw new Error("boom");
		return realRename(from, to);
	};

	await assert.rejects(async () =>
		c.commitRemoteChange({
			operationId: "op7",
			realPath: "a.md",
			expectedLocalHash: await sha256Hex(bytes("old")),
			incoming: bytes("new"),
			incomingHash: await sha256Hex(bytes("new")),
			conflictPolicy: "fail",
		}),
	);
	assert.equal(text(v.files.get("a.md")!), "old", "必须还原到调用前的状态");
});

test("§6.1: 同一路径的并发提交被串行化（恰好一个成功）", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	v.files.set("a.md", bytes("v0"));
	const h0 = await sha256Hex(bytes("v0"));

	// 两个提交都以 v0 为前置条件：串行化后第二个必然看到已被改写的内容
	const [r1, r2] = await Promise.all([
		c.commitRemoteChange({
			operationId: "c1",
			realPath: "a.md",
			expectedLocalHash: h0,
			incoming: bytes("v1"),
			incomingHash: await sha256Hex(bytes("v1")),
			conflictPolicy: "fail",
		}),
		c.commitRemoteChange({
			operationId: "c2",
			realPath: "a.md",
			expectedLocalHash: h0,
			incoming: bytes("v2"),
			incomingHash: await sha256Hex(bytes("v2")),
			conflictPolicy: "fail",
		}),
	]);
	assert.deepEqual([r1.status, r2.status].sort(), ["committed", "precondition-failed"]);
});

test("§6.1: 锁按跨平台碰撞键取（A.md 与 a.md 共用一把锁）", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	const order: string[] = [];
	await Promise.all([
		c.withPathLock("A.md", async () => {
			order.push("1-in");
			await new Promise((r) => setTimeout(r, 10));
			order.push("1-out");
		}),
		c.withPathLock("a.md", async () => {
			order.push("2-in");
			order.push("2-out");
		}),
	]);
	assert.deepEqual(order, ["1-in", "1-out", "2-in", "2-out"], "同一个文件不得并发提交");
});

test("§6.1: sweep 清理 staging，但按保留期保留 recovery", async () => {
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	v.files.set(`${PLUGIN_DIR}/staging/leftover`, bytes("x"));
	v.files.set(`${PLUGIN_DIR}/recovery/recent`, bytes("y"));

	await c.sweep(2); // 假 mtime 为 1，recovery 仍在一周保留期内
	assert.equal(v.files.has(`${PLUGIN_DIR}/staging/leftover`), false, "staging 一律可丢");
	assert.equal(v.files.has(`${PLUGIN_DIR}/recovery/recent`), true, "用户旧内容必须留够保留期");
});

// ---------------------------------------------------------------- §6.11

test("§6.11: 具名转换保住身份字段", async () => {
	const store = storeOn(memAdapter());
	await store.load();
	store.replaceWithNewObject("a.md", {
		hash: "h0",
		serverHash: "s0",
		revision: 1,
		mtime: 1,
		size: 1,
		fileId: "a".repeat(32),
		generation: 3,
		metaGeneration: 2,
		serverPseudonym: "a".repeat(32),
	});

	// 内容更新不得碰身份
	store.patchContentState("a.md", { hash: "h1", serverHash: "s1", revision: 2, mtime: 2, size: 2 });
	let fs = store.get("a.md")!;
	assert.equal(fs.fileId, "a".repeat(32));
	assert.equal(fs.generation, 3);
	assert.equal(fs.metaGeneration, 2);
	assert.equal(fs.hash, "h1");

	// 身份更新不得碰内容
	store.applyRemoteIdentity("a.md", { generation: 4, metaGeneration: 3 });
	fs = store.get("a.md")!;
	assert.equal(fs.hash, "h1");
	assert.equal(fs.generation, 4);

	// 改名搬状态，fileId 与 contentGeneration 原样带走（INV-05）
	store.applyMetaRenameState("a.md", "b.md", { metaGeneration: 4 });
	assert.equal(store.get("a.md"), undefined);
	fs = store.get("b.md")!;
	assert.equal(fs.fileId, "a".repeat(32));
	assert.equal(fs.generation, 4);
	assert.equal(fs.metaGeneration, 4);
	assert.equal(fs.hash, "h1");
});

test("§6.11: viewOf 给出唯一状态（冲突 > 阻塞 > 待删 > 已跟踪）", async () => {
	const store = storeOn(memAdapter());
	await store.load();
	store.state.bootstrap = { status: "ready", mode: "merge", completedAt: 0 };

	assert.equal(store.viewOf("x.md").kind, "untracked");

	store.replaceWithNewObject("x.md", { hash: "h", serverHash: "s", revision: 1, mtime: 0, size: 0 });
	assert.equal(store.viewOf("x.md").kind, "tracked");

	store.setPendingDelete("x.md");
	assert.equal(store.viewOf("x.md").kind, "pending-delete");

	store.setBlockedChange({ sequence: 1, action: "upsert", realPath: "x.md", reason: "r" });
	assert.equal(store.viewOf("x.md").kind, "blocked");

	store.recordConflict("x.md", { baseRevision: 1, remoteRevision: 2, createdAt: 0 });
	assert.equal(store.viewOf("x.md").kind, "conflict");
});
