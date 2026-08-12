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

// ---------- v9：A/B 双副本日志（P0-6） ----------

test("StateStore: 保存写入 A/B 副本并交替，加载取最高 generation", async () => {
	const adapter = memAdapter();
	const files = (adapter as unknown as { files: Map<string, string> }).files;
	const store = new StateStore(adapter, "state.json");
	await store.load(); // 生成 deviceId → 第一次 save

	store.state.lastSequence = 1;
	await store.save();
	store.state.lastSequence = 2;
	await store.save();
	assert.ok(files.has("state-a.json") && files.has("state-b.json"), "两份副本都应存在");

	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	assert.equal(store2.state.lastSequence, 2, "加载应取最新 generation 的副本");
});

test("StateStore: 单份副本损坏 → 回退另一份，不丢状态", async () => {
	const adapter = memAdapter();
	const files = (adapter as unknown as { files: Map<string, string> }).files;
	const store = new StateStore(adapter, "state.json");
	await store.load();
	store.state.lastSequence = 41;
	await store.save();
	store.state.lastSequence = 42;
	await store.save();

	// 找到 generation 更高的那份，将其截断损坏
	const parse = (s: string | undefined) => (s ? (JSON.parse(s) as { generation: number }) : { generation: -1 });
	const newer = parse(files.get("state-a.json")).generation > parse(files.get("state-b.json")).generation ? "state-a.json" : "state-b.json";
	files.set(newer, files.get(newer)!.slice(0, 30));

	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	assert.equal(store2.corrupted, false);
	assert.equal(store2.state.lastSequence, 41, "应回退到未损坏的旧副本");
});

test("StateStore: checksum 不符（内容被篡改/写坏）视为损坏副本", async () => {
	const adapter = memAdapter();
	const files = (adapter as unknown as { files: Map<string, string> }).files;
	const store = new StateStore(adapter, "state.json");
	await store.load();
	store.state.lastSequence = 10;
	await store.save();
	store.state.lastSequence = 11;
	await store.save();

	const parse = (s: string) => JSON.parse(s) as { generation: number; payload: { lastSequence: number } };
	const newer = parse(files.get("state-a.json")!).generation > parse(files.get("state-b.json")!).generation ? "state-a.json" : "state-b.json";
	const env = JSON.parse(files.get(newer)!) as { payload: { lastSequence: number } };
	env.payload.lastSequence = 99999; // 篡改 payload 但不更新 checksum
	files.set(newer, JSON.stringify(env));

	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	assert.equal(store2.state.lastSequence, 10, "checksum 不符的副本必须被拒绝");
});

test("StateStore: 两份副本全部损坏 → corrupted 停机，绝不 starting fresh", async () => {
	const adapter = memAdapter();
	const files = (adapter as unknown as { files: Map<string, string> }).files;
	const store = new StateStore(adapter, "state.json");
	await store.load();
	store.state.lastSequence = 5;
	await store.save();
	store.state.lastSequence = 6;
	await store.save();

	files.set("state-a.json", "{broken");
	files.set("state-b.json", "");

	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	assert.equal(store2.corrupted, true, "全部损坏必须进入停机保护");
	assert.equal(store2.state.lastSequence, 0, "停机状态下不得使用任何猜测状态");
	// 停机状态下拒绝覆盖现场
	await store2.save();
	assert.equal(files.get("state-a.json"), "{broken", "corrupted 下 save 必须是 no-op");
});

test("StateStore: v9.2 旧字符串 pendingOps 规整为结构化 op（v9.3）", async () => {
	const legacy = JSON.stringify({
		deviceId: "dev-x",
		lastSequence: 1,
		files: {},
		pendingOps: { "a.md": "upsert", "b.md": "delete", "bad.md": "unknown" },
	});
	const store = new StateStore(memAdapter({ "state.json": legacy }), "state.json");
	await store.load();
	assert.deepEqual(store.state.pendingOps, {
		"a.md": { action: "upsert" },
		"b.md": { action: "delete" },
	});
});

test("StateStore: 旧版单文件 state.json 迁移到 A/B 副本", async () => {
	const legacy = JSON.stringify({ deviceId: "dev-9", lastSequence: 33, files: {}, conflicts: {}, e2ee: null, shares: {} });
	const adapter = memAdapter({ "state.json": legacy });
	const files = (adapter as unknown as { files: Map<string, string> }).files;
	const store = new StateStore(adapter, "state.json");
	await store.load();
	assert.equal(store.state.lastSequence, 33);
	await store.save();
	assert.ok(files.has("state-a.json") || files.has("state-b.json"), "保存后应产生 A/B 副本");

	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	assert.equal(store2.state.lastSequence, 33);
	assert.equal(store2.state.deviceId, "dev-9");
});

test("StateStore: pendingOps / blockedChanges 持久化（v9）", async () => {
	const adapter = memAdapter();
	const store = new StateStore(adapter, "state.json");
	await store.load();
	store.state.pendingOps = { "a.md": { action: "upsert" }, "n.md": { action: "move", from: "o.md" } };
	// v0.13.2 §6.4：完整记录，键取 fileId（改名后仍指向同一个对象）
	const key = store.setBlockedChange({
		sequence: 41,
		action: "upsert",
		fileId: "a".repeat(32),
		serverPseudonym: "a".repeat(32),
		revision: 7,
		contentHash: "c".repeat(64),
		metaGeneration: 3,
		realPath: "dir.md",
		reason: "远端文件与本地文件夹同名",
	});
	assert.equal(key, "a".repeat(32));
	await store.save();

	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	assert.deepEqual(store2.state.pendingOps, {
		"a.md": { action: "upsert" },
		"n.md": { action: "move", from: "o.md" },
	});
	const rec = store2.getBlockedChange(key);
	// 重试要能原样重放这条变更 → 全部字段必须活过一次落盘/加载
	assert.equal(rec?.sequence, 41);
	assert.equal(rec?.action, "upsert");
	assert.equal(rec?.serverPseudonym, "a".repeat(32));
	assert.equal(rec?.revision, 7);
	assert.equal(rec?.contentHash, "c".repeat(64));
	assert.equal(rec?.metaGeneration, 3);
	assert.equal(rec?.realPath, "dir.md");
	assert.equal(rec?.retryCount, 1);
	assert.ok((rec?.operationId ?? "").length > 0);

	// 再次登记同一条：retryCount 自增，operationId（重放幂等键）保持不变
	store2.setBlockedChange({ sequence: 41, action: "upsert", fileId: "a".repeat(32), realPath: "dir.md", reason: "x" });
	assert.equal(store2.getBlockedChange(key)?.retryCount, 2);
	assert.equal(store2.getBlockedChange(key)?.operationId, rec?.operationId);

	store2.clearBlockedChange(key);
	assert.deepEqual(store2.blockedChanges(), []);
});

test("StateStore: 旧版 blockedChanges 升级为完整记录（v0.13.2 §6.4）", async () => {
	const adapter = memAdapter();
	// v9~v0.13.1 的盘上形态：以真实路径为键，只有 {reason, at}
	await adapter.write(
		"state.json.a",
		JSON.stringify({
			schemaVersion: 2,
			generation: 1,
			checksum: "",
			payload: { blockedChanges: { "dir.md": { reason: "远端文件与本地文件夹同名", at: 123 } } },
		}),
	);
	const store = new StateStore(adapter, "state.json");
	await store.load();
	// 校验和不匹配 → 该副本无效，落到空状态（不能把损坏数据当合法输入）
	assert.deepEqual(store.blockedChanges(), []);

	// 直接走规整路径验证升级语义
	const store2 = new StateStore(adapter, "state.json");
	await store2.load();
	store2.state.blockedChanges = { "dir.md": { reason: "旧记录", at: 123 } as never };
	await store2.save();
	const store3 = new StateStore(adapter, "state.json");
	await store3.load();
	const rec = store3.getBlockedChange("dir.md");
	assert.equal(rec?.realPath, "dir.md", "缺 realPath 时用键补齐");
	assert.equal(rec?.action, "upsert");
	assert.equal(rec?.sequence, 0);
	assert.equal(rec?.retryCount, 0);
});
