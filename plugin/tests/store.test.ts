// StateStore 单元测试（v6：pendingDeletes 移动端删除安全）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { StateStore } from "../src/state/store";

/** 内存版 DataAdapter（只实现 StateStore 用到的三个方法）。 */
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
		write: async (p: string, data: string) => {
			files.set(p, data);
		},
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

test("StateStore: pendingDeletes 登记、清除并随 state.json 持久化", async () => {
	const adapter = memAdapter();
	const store = new StateStore(adapter, "state.json");
	await store.load();

	assert.equal(store.hasPendingDelete("a.md"), false);
	store.setPendingDelete("a.md");
	assert.equal(store.hasPendingDelete("a.md"), true);
	await store.save();

	// 重新加载（模拟重启）：记录仍在
	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	assert.equal(store2.hasPendingDelete("a.md"), true);

	store2.clearPendingDelete("a.md");
	assert.equal(store2.hasPendingDelete("a.md"), false);
});

test("StateStore: 旧版 state.json（无 pendingDeletes 字段）正常升级", async () => {
	const legacy = JSON.stringify({
		deviceId: "dev-1",
		lastSequence: 7,
		files: { "n.md": { hash: "h", revision: 1, mtime: 1, size: 1 } },
		conflicts: {},
		e2ee: null,
		shares: {},
	});
	const store = new StateStore(memAdapter({ "state.json": legacy }), "state.json");
	await store.load();
	assert.equal(store.state.deviceId, "dev-1");
	assert.equal(store.hasPendingDelete("n.md"), false);
	// v0.2 升级逻辑仍然生效：serverHash 补齐
	assert.equal(store.get("n.md")?.serverHash, "h");
	store.setPendingDelete("n.md");
	assert.equal(store.hasPendingDelete("n.md"), true);
});
