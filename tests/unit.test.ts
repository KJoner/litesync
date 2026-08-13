// 插件纯逻辑单元测试（不依赖 Obsidian 运行时）。
// 运行：npm test（esbuild 打包后用 Node 内置 test runner 执行）
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackUrl } from "../src/api/client";
import { PendingOp, PendingQueue } from "../src/sync/queue";
import { conflictPathFor } from "../src/utils/conflict-name";
import { IgnoreMatcher } from "../src/utils/ignore";

test("isLoopbackUrl: 仅本机地址允许 http（v9 P1-15）", () => {
	assert.equal(isLoopbackUrl("http://127.0.0.1:8080"), true);
	assert.equal(isLoopbackUrl("http://127.1.2.3"), true);
	assert.equal(isLoopbackUrl("http://localhost:8080/x"), true);
	assert.equal(isLoopbackUrl("http://[::1]:8080"), true);
	assert.equal(isLoopbackUrl("http://192.168.1.10:8080"), false);
	assert.equal(isLoopbackUrl("http://sync.example.com"), false);
	assert.equal(isLoopbackUrl("https://sync.example.com"), false); // https 与本函数无关，但不是 loopback
});

const PLUGIN_DIR = ".obsidian/plugins/litesync";

test("IgnoreMatcher: 插件自身目录永远排除（data.json 含 Token）", () => {
	const m = new IgnoreMatcher(true, ".obsidian", PLUGIN_DIR, "");
	assert.equal(m.ignores(`${PLUGIN_DIR}/data.json`), true);
	assert.equal(m.ignores(`${PLUGIN_DIR}/state.json`), true);
	assert.equal(m.ignores(PLUGIN_DIR), true);
});

test("IgnoreMatcher: workspace 文件永远排除", () => {
	const m = new IgnoreMatcher(true, ".obsidian", PLUGIN_DIR, "");
	assert.equal(m.ignores(".obsidian/workspace.json"), true);
	assert.equal(m.ignores(".obsidian/workspace-mobile.json"), true);
	assert.equal(m.ignores(".obsidian/app.json"), false); // syncObsidian=true 时其余可同步
});

test("IgnoreMatcher: syncObsidian=false 时整个 .obsidian 排除", () => {
	const m = new IgnoreMatcher(false, ".obsidian", PLUGIN_DIR, "");
	assert.equal(m.ignores(".obsidian/app.json"), true);
	assert.equal(m.ignores(".obsidian/themes/x/theme.css"), true);
	assert.equal(m.ignores("Notes/hello.md"), false);
});

test("IgnoreMatcher: 默认模式匹配", () => {
	const m = new IgnoreMatcher(false, ".obsidian", PLUGIN_DIR, ".trash/**\n.DS_Store\nThumbs.db");
	assert.equal(m.ignores(".trash/old.md"), true);
	assert.equal(m.ignores(".trash/deep/nested.md"), true);
	assert.equal(m.ignores(".DS_Store"), true);
	assert.equal(m.ignores("Notes/.DS_Store"), true); // 无 / 的模式按文件名匹配
	assert.equal(m.ignores("deep/dir/Thumbs.db"), true);
	assert.equal(m.ignores("Notes/hello.md"), false);
	assert.equal(m.ignores("trash-not.md"), false);
});

test("IgnoreMatcher: 用户 Glob 规则", () => {
	const m = new IgnoreMatcher(false, ".obsidian", PLUGIN_DIR, "Private/**\n*.tmp\nDrafts/*.md");
	assert.equal(m.ignores("Private/secret.md"), true);
	assert.equal(m.ignores("Private/a/b/c.md"), true);
	assert.equal(m.ignores("note.tmp"), true);
	assert.equal(m.ignores("sub/dir/x.tmp"), true);
	assert.equal(m.ignores("Drafts/wip.md"), true);
	assert.equal(m.ignores("Drafts/sub/wip.md"), false); // 单个 * 不跨层级
	assert.equal(m.ignores("PrivateNotes/x.md"), false);
});

test("IgnoreMatcher: 中文路径", () => {
	const m = new IgnoreMatcher(false, ".obsidian", PLUGIN_DIR, "私密/**");
	assert.equal(m.ignores("私密/日记.md"), true);
	assert.equal(m.ignores("笔记/日常.md"), false);
});

test("conflictPathFor: 常规文件（v9 含防碰撞随机后缀）", () => {
	const when = new Date(2026, 7, 8, 0, 15, 0); // 2026-08-08 00:15:00
	assert.equal(
		conflictPathFor("Project.md", "MacBook", when, "ab12"),
		"Project.conflict-MacBook-20260808-001500-ab12.md",
	);
	// 不传 salt：自动生成 4 位随机后缀
	assert.match(
		conflictPathFor("Project.md", "MacBook", when),
		/^Project\.conflict-MacBook-20260808-001500-[a-z0-9]{4}\.md$/,
	);
});

test("conflictPathFor: 带目录、无扩展名、隐藏文件、非法设备名字符", () => {
	const when = new Date(2026, 7, 8, 12, 30, 45);
	assert.equal(
		conflictPathFor("Notes/深/计划.md", "我的 Mac", when, "zz99"),
		"Notes/深/计划.conflict-我的 Mac-20260808-123045-zz99.md",
	);
	assert.equal(conflictPathFor("README", "PC", when, "zz99"), "README.conflict-PC-20260808-123045-zz99");
	assert.equal(
		conflictPathFor("dir/.hidden", "a/b:c", when, "zz99"),
		"dir/.hidden.conflict-a-b-c-20260808-123045-zz99",
	);
});

test("conflictPathFor: 同一秒两次生成不同名（P1-18 碰撞防护）", () => {
	const when = new Date(2026, 7, 8, 12, 30, 45);
	const seen = new Set<string>();
	for (let i = 0; i < 20; i++) seen.add(conflictPathFor("a.md", "PC", when));
	assert.ok(seen.size > 1, "随机后缀必须使同秒副本名可区分");
});

test("PendingQueue: generation 防 lost wake-up（v9 P1-10）", async () => {
	const q = new PendingQueue();
	await q.add("note.md", "upsert");
	const [[path, op, gen]] = q.entries();
	assert.equal(path, "note.md");
	assert.equal(op.action, "upsert");
	// 上传期间用户又编辑 → 重新入队拿到新 generation
	await q.add("note.md", "upsert");
	// 旧上传完成回调用旧 gen 移除 → 必须无效
	q.remove("note.md", gen);
	assert.equal(q.size, 1, "新入队的条目不能被旧 generation 移除");
	// 用当前 gen 移除 → 生效
	const [[, , gen2]] = q.entries();
	q.remove("note.md", gen2);
	assert.equal(q.size, 0);
});

test("PendingQueue: 持久化镜像与恢复（v9；v9.3 结构化 + 旧格式兼容）", async () => {
	const q = new PendingQueue();
	let mirror: Record<string, PendingOp> = {};
	q.onChange = (e) => {
		mirror = e;
	};
	await q.add("a.md", "upsert");
	await q.add("b.md", "delete");
	await q.addMove("new.md", "old.md");
	assert.deepEqual(Object.keys(mirror).sort(), ["a.md", "b.md", "new.md"]);
	assert.equal(mirror["a.md"].action, "upsert");
	assert.equal(mirror["b.md"].action, "delete");
	assert.equal(mirror["new.md"].action, "move");
	assert.equal(mirror["new.md"].from, "old.md");
	// v0.13.2 §6.3：每条操作都带幂等键与状态，重试时原样沿用
	assert.match(mirror["a.md"].operationId ?? "", /^[0-9a-f]{24}$/);
	assert.equal(mirror["a.md"].status, "queued");
	q.remove("a.md");
	assert.equal(mirror["a.md"], undefined);

	// 重启恢复：结构化 + v9.2 旧字符串格式混合
	const q2 = new PendingQueue();
	q2.restore({
		"b.md": "delete",
		"c.md": { action: "upsert" },
		"new.md": { action: "move", from: "old.md", operationId: "aabbccddeeff001122334455" },
	});
	assert.equal(q2.size, 3);
	assert.equal(q2.getOp("b.md")?.action, "delete");
	assert.equal(q2.getOp("new.md")?.from, "old.md");
	// 重启后必须沿用盘上的 operationId——这正是「响应丢失后重试不产生第二个对象」的依据
	assert.equal(q2.getOp("new.md")?.operationId, "aabbccddeeff001122334455");
	// 旧格式没有 operationId → 补一个，避免重试时缺幂等键
	assert.match(q2.getOp("b.md")?.operationId ?? "", /^[0-9a-f]{24}$/);
});

test("PendingQueue: 入队先落盘、失败即回滚（v0.13.2 §6.3）", async () => {
	const q = new PendingQueue();
	let fail = false;
	const saved: number[] = [];
	q.persist = async () => {
		if (fail) throw new Error("disk full");
		saved.push(q.size);
	};
	await q.add("a.md", "upsert");
	assert.deepEqual(saved, [1], "add() 必须在返回前完成一次落盘");

	// 落盘失败 → 该操作不能被当作已接受，队列里不能留下假象
	fail = true;
	await assert.rejects(() => q.add("b.md", "upsert"), /disk full/);
	assert.equal(q.size, 1);
	assert.equal(q.getOp("b.md"), undefined);

	// stage() 不落盘（同一轮内处理的批量路径），由调用方统一保存
	fail = false;
	q.stage("c.md", { action: "upsert" });
	assert.equal(saved.length, 1);
	assert.equal(q.size, 2);
});

test("PendingQueue: move 条目不被后续 upsert 覆盖（验收 T3.2/T3.5：身份不重置）", async () => {
	const q = new PendingQueue();
	await q.addMove("new.md", "old.md");
	assert.equal(q.getOp("new.md")?.action, "move");
	const moveId = q.getOp("new.md")?.operationId;
	q.rememberIdentity("new.md", { fileId: "f".repeat(32) });
	const genBefore = [...q.entries()].find(([p]) => p === "new.md")![2];
	// 改名后立即编辑：move 必须保留——覆盖成 upsert 会让新路径被当成 base-0
	// 新对象上传（身份重置、历史从 1 开始）。内容由 pushMove 的 contentChanged
	// 分支「先改名再传内容」处理，编辑不会丢
	await q.add("new.md", "upsert");
	const op = q.getOp("new.md");
	assert.equal(op?.action, "move");
	assert.equal(op?.from, "old.md");
	assert.equal(op?.operationId, moveId, "同一逻辑操作，幂等键不换");
	assert.equal(op?.fileId, "f".repeat(32));
	// lost wake-up 语义：编辑要刷新变更代号，推送完成的回调不会误删这次编辑
	const genAfter = [...q.entries()].find(([p]) => p === "new.md")![2];
	assert.notEqual(genAfter, genBefore, "编辑必须刷新 generation");
	// delete 仍然覆盖 move（文件被删了，改名意图自然作废）
	await q.add("new.md", "delete");
	assert.equal(q.getOp("new.md")?.action, "delete");
});

test("PendingQueue: 按路径去重，后到动作覆盖", async () => {
	const q = new PendingQueue();
	await q.add("a.md", "upsert");
	await q.add("a.md", "delete");
	await q.add("b.md", "upsert");
	assert.equal(q.size, 2);
	const entries = q.toRecord();
	assert.equal(entries["a.md"].action, "delete");
	assert.equal(entries["b.md"].action, "upsert");
	// entries() 是快照，不清空队列
	assert.equal(q.size, 2);
	q.remove("a.md");
	assert.equal(q.size, 1);
});
