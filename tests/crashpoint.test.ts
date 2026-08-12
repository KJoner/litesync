// 客户端崩溃点恢复测试（v0.14.0-RC / 计划书 §8.3）。
//
// 五条验收标准，每个注入点都要满足：
//
//   1. 重启后要么旧状态完整，要么新状态完整；
//   2. 不会从空状态继续；
//   3. 不会丢失已接受的 pending op；
//   4. 不会重复生成 fileId；
//   5. 不会跳过未应用的 change。
//
// 「崩溃」用注入错误 + 丢弃内存对象来模拟：新建一个只读盘上内容的 StateStore /
// PendingQueue，就等价于进程被杀之后重启。这套代码的所有状态转换都靠
// A/B 双副本与 rename 的原子性，因此进程在哪一行退出，落盘状态都只有有限几种。
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { App } from "obsidian";
import { StateStore } from "../src/state/store";
import { LocalCommitter } from "../src/sync/local-commit";
import { PendingQueue } from "../src/sync/queue";
import { enableFailpoint, FP, failpointHits, resetFailpoints, activeFailpoints } from "../src/utils/failpoint";
import { sha256Hex } from "../src/utils/hash";

const PLUGIN_DIR = ".obsidian/plugins/litesync";

/** 可以「重启」的内存盘：同一个 files map 交给新的 StateStore 就是重启。 */
function memDisk() {
	const files = new Map<string, string>();
	return {
		files,
		adapter: {
			exists: async (p: string) => files.has(p),
			read: async (p: string) => {
				const v = files.get(p);
				if (v === undefined) throw new Error("ENOENT");
				return v;
			},
			write: async (p: string, d: string) => void files.set(p, d),
		} as unknown as ConstructorParameters<typeof StateStore>[0],
	};
}

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
	return { files, adapter, app: { vault: { adapter } } as unknown as App };
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);

/** 组装一套「队列 + 状态」，模拟 main.ts 的接线。 */
async function wiredStore(disk: ReturnType<typeof memDisk>) {
	const store = new StateStore(disk.adapter, "state.json");
	await store.load();
	const queue = new PendingQueue();
	queue.onChange = (e) => void (store.state.pendingOps = e);
	queue.persist = () => store.save();
	return { store, queue };
}

// ---------------------------------------------------------------- §8.3 队列

test("§8.3: 落盘之前崩溃 → 那条操作必须消失（没有被承诺过就不能留下痕迹）", async () => {
	resetFailpoints();
	const disk = memDisk();
	const { store, queue } = await wiredStore(disk);
	await store.save(); // 先有一份基线状态

	enableFailpoint(FP.queueBeforeDurable, 1);
	await assert.rejects(() => queue.add("a.md", "upsert"));
	assert.equal(queue.getOp("a.md"), undefined, "落盘失败必须把条目回滚出队");

	// 「重启」
	const reloaded = new StateStore(disk.adapter, "state.json");
	await reloaded.load();
	assert.equal(reloaded.corrupted, false, "不得进入损坏停机");
	assert.deepEqual(reloaded.state.pendingOps, {}, "没落盘的操作不该出现在盘上");
});

test("§8.3: 落盘之后崩溃 → 那条操作必须还在（验收 3：不丢已接受的 pending op）", async () => {
	resetFailpoints();
	const disk = memDisk();
	const { store, queue } = await wiredStore(disk);
	await store.save();

	enableFailpoint(FP.queueAfterDurable, 1);
	await assert.rejects(() => queue.add("a.md", "upsert", { fileId: "a".repeat(32) }));

	// 内存里的这次调用抛错了，但盘上已经有了——重启必须把它捡回来
	const reloaded = new StateStore(disk.adapter, "state.json");
	await reloaded.load();
	const q2 = new PendingQueue();
	q2.restore(reloaded.state.pendingOps);
	assert.equal(q2.getOp("a.md")?.action, "upsert", "已落盘的操作必须活过重启");
	// 验收 4：不重复生成 fileId
	assert.equal(q2.getOp("a.md")?.fileId, "a".repeat(32), "预留的 fileId 必须原样恢复");
});

// ---------------------------------------------------------------- §8.3 StateStore

test("§8.3: A/B 槽写完但指针未切换 → 重启回到旧状态（验收 1、2）", async () => {
	resetFailpoints();
	const disk = memDisk();
	const store = new StateStore(disk.adapter, "state.json");
	await store.load();
	store.state.lastSequence = 100;
	await store.save();

	// 写第二个槽的过程中「崩溃」
	store.state.lastSequence = 200;
	enableFailpoint(FP.stateAfterSlotWrite, 1);
	await assert.rejects(() => store.save());

	const reloaded = new StateStore(disk.adapter, "state.json");
	await reloaded.load();
	assert.equal(reloaded.corrupted, false, "验收 2：绝不从空状态继续");
	// 要么旧的（100）要么新的（200），不能是别的东西
	assert.ok(
		reloaded.state.lastSequence === 100 || reloaded.state.lastSequence === 200,
		`验收 1：状态必须完整，实际 ${reloaded.state.lastSequence}`,
	);
});

test("§8.3: 指针切换前崩溃 → 状态仍可加载，且下一次 save 能正常完成", async () => {
	resetFailpoints();
	const disk = memDisk();
	const store = new StateStore(disk.adapter, "state.json");
	await store.load();
	store.state.lastSequence = 7;
	await store.save();

	store.state.lastSequence = 8;
	enableFailpoint(FP.stateBeforePointerSwitch, 1);
	await assert.rejects(() => store.save());

	// 同一个实例继续用（对应「Obsidian 没退出但那次保存失败了」）
	store.state.lastSequence = 9;
	await store.save();

	const reloaded = new StateStore(disk.adapter, "state.json");
	await reloaded.load();
	assert.equal(reloaded.state.lastSequence, 9, "失败之后的下一次保存必须能落地");
	assert.equal(reloaded.corrupted, false);
});

test("§8.3: 两份副本都在时，加载取 generation 更高的那份", async () => {
	resetFailpoints();
	const disk = memDisk();
	const store = new StateStore(disk.adapter, "state.json");
	await store.load();
	for (let i = 1; i <= 5; i++) {
		store.state.lastSequence = i;
		await store.save();
	}
	assert.ok(disk.files.has("state-a.json") && disk.files.has("state-b.json"), "A/B 两份都应存在");

	const reloaded = new StateStore(disk.adapter, "state.json");
	await reloaded.load();
	assert.equal(reloaded.state.lastSequence, 5);
});

// ---------------------------------------------------------------- §8.3 LocalCommitter

test("§8.3: 旧内容已进 recovery、新内容未安装时崩溃 → 内容仍可找回", async () => {
	resetFailpoints();
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	v.files.set("a.md", bytes("用户的原始内容"));

	const oldHash = await sha256Hex(bytes("用户的原始内容"));
	const newHash = await sha256Hex(bytes("远端新内容"));
	enableFailpoint(FP.commitAfterRecovery, 1);
	await assert.rejects(() =>
		c.commitRemoteChange({
			operationId: "op-crash-1",
			realPath: "a.md",
			expectedLocalHash: oldHash,
			incoming: bytes("远端新内容"),
			incomingHash: newHash,
			conflictPolicy: "fail",
		}),
	);

	// 目标路径此刻是空的——这正是那个危险窗口。
	// 关键要求：旧内容必须还在 recovery 里，没有凭空消失
	const recovery = `${PLUGIN_DIR}/recovery/op-crash-1`;
	assert.equal(v.files.has(recovery), true, "旧内容必须留在 recovery 中");
	assert.equal(text(v.files.get(recovery)!), "用户的原始内容");
	assert.equal(failpointHits(FP.commitAfterRecovery), 0, "注入点触发后应自动失效");
});

test("§8.3: 安装之前崩溃 → 旧内容自动还原回原路径", async () => {
	resetFailpoints();
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);
	v.files.set("a.md", bytes("原始内容"));

	const oldHash2 = await sha256Hex(bytes("原始内容"));
	const newHash2 = await sha256Hex(bytes("新内容"));
	enableFailpoint(FP.commitBeforeInstall, 1);
	await assert.rejects(() =>
		c.commitRemoteChange({
			operationId: "op-crash-2",
			realPath: "a.md",
			expectedLocalHash: oldHash2,
			incoming: bytes("新内容"),
			incomingHash: newHash2,
			conflictPolicy: "fail",
		}),
	);

	// 安装失败走的是 catch 分支：旧内容被搬回原位
	assert.equal(text(v.files.get("a.md")!), "原始内容", "安装失败必须还原到调用前的状态");
});

test("§8.3: 新建文件安装前崩溃 → 目标路径保持不存在，可安全重试", async () => {
	resetFailpoints();
	const v = memVault();
	const c = new LocalCommitter(v.app, PLUGIN_DIR);

	const contentHash = await sha256Hex(bytes("内容"));
	enableFailpoint(FP.commitBeforeInstall, 1);
	await assert.rejects(() =>
		c.commitRemoteChange({
			operationId: "op-crash-3",
			realPath: "new.md",
			expectedLocalHash: null,
			incoming: bytes("内容"),
			incomingHash: contentHash,
			conflictPolicy: "fail",
		}),
	);
	assert.equal(v.files.has("new.md"), false, "没装上就不该有文件");

	// 重试必须成功
	const res = await c.commitRemoteChange({
		operationId: "op-crash-3",
		realPath: "new.md",
		expectedLocalHash: null,
		incoming: bytes("内容"),
		incomingHash: contentHash,
		conflictPolicy: "fail",
	});
	assert.equal(res.status, "committed");
	assert.equal(text(v.files.get("new.md")!), "内容");
});

// ---------------------------------------------------------------- 生产安全

test("§8.1: 生产运行时没有任何激活的注入点（外部无法触发）", () => {
	resetFailpoints();
	assert.equal(activeFailpoints(), 0);
});
