// 插件纯逻辑单元测试（不依赖 Obsidian 运行时）。
// 运行：npm test（esbuild 打包后用 Node 内置 test runner 执行）
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackUrl } from "../src/api/client";
import { PendingQueue } from "../src/sync/queue";
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

test("PendingQueue: generation 防 lost wake-up（v9 P1-10）", () => {
	const q = new PendingQueue();
	q.add("note.md", "upsert");
	const [[path, action, gen]] = q.entries();
	assert.equal(path, "note.md");
	assert.equal(action, "upsert");
	// 上传期间用户又编辑 → 重新入队拿到新 generation
	q.add("note.md", "upsert");
	// 旧上传完成回调用旧 gen 移除 → 必须无效
	q.remove("note.md", gen);
	assert.equal(q.size, 1, "新入队的条目不能被旧 generation 移除");
	// 用当前 gen 移除 → 生效
	const [[, , gen2]] = q.entries();
	q.remove("note.md", gen2);
	assert.equal(q.size, 0);
});

test("PendingQueue: 持久化镜像与恢复（v9）", () => {
	const q = new PendingQueue();
	let mirror: Record<string, string> = {};
	q.onChange = (e) => {
		mirror = e;
	};
	q.add("a.md", "upsert");
	q.add("b.md", "delete");
	assert.deepEqual(mirror, { "a.md": "upsert", "b.md": "delete" });
	q.remove("a.md");
	assert.deepEqual(mirror, { "b.md": "delete" });

	// 重启恢复
	const q2 = new PendingQueue();
	q2.restore({ "b.md": "delete", "c.md": "upsert" });
	assert.equal(q2.size, 2);
});

test("PendingQueue: 按路径去重，后到动作覆盖", () => {
	const q = new PendingQueue();
	q.add("a.md", "upsert");
	q.add("a.md", "delete");
	q.add("b.md", "upsert");
	assert.equal(q.size, 2);
	const entries = q.toRecord();
	assert.equal(entries["a.md"], "delete");
	assert.equal(entries["b.md"], "upsert");
	// entries() 是快照，不清空队列
	assert.equal(q.size, 2);
	q.remove("a.md");
	assert.equal(q.size, 1);
});
