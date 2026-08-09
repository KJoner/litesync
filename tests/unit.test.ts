// 插件纯逻辑单元测试（不依赖 Obsidian 运行时）。
// 运行：npm test（esbuild 打包后用 Node 内置 test runner 执行）
import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingQueue } from "../src/sync/queue";
import { conflictPathFor } from "../src/utils/conflict-name";
import { IgnoreMatcher } from "../src/utils/ignore";

const PLUGIN_DIR = ".obsidian/plugins/litesync";

test("IgnoreMatcher: 插件自身目录永远排除（data.json 含 Token）", () => {
	const m = new IgnoreMatcher(true, PLUGIN_DIR, "");
	assert.equal(m.ignores(`${PLUGIN_DIR}/data.json`), true);
	assert.equal(m.ignores(`${PLUGIN_DIR}/state.json`), true);
	assert.equal(m.ignores(PLUGIN_DIR), true);
});

test("IgnoreMatcher: workspace 文件永远排除", () => {
	const m = new IgnoreMatcher(true, PLUGIN_DIR, "");
	assert.equal(m.ignores(".obsidian/workspace.json"), true);
	assert.equal(m.ignores(".obsidian/workspace-mobile.json"), true);
	assert.equal(m.ignores(".obsidian/app.json"), false); // syncObsidian=true 时其余可同步
});

test("IgnoreMatcher: syncObsidian=false 时整个 .obsidian 排除", () => {
	const m = new IgnoreMatcher(false, PLUGIN_DIR, "");
	assert.equal(m.ignores(".obsidian/app.json"), true);
	assert.equal(m.ignores(".obsidian/themes/x/theme.css"), true);
	assert.equal(m.ignores("Notes/hello.md"), false);
});

test("IgnoreMatcher: 默认模式匹配", () => {
	const m = new IgnoreMatcher(false, PLUGIN_DIR, ".trash/**\n.DS_Store\nThumbs.db");
	assert.equal(m.ignores(".trash/old.md"), true);
	assert.equal(m.ignores(".trash/deep/nested.md"), true);
	assert.equal(m.ignores(".DS_Store"), true);
	assert.equal(m.ignores("Notes/.DS_Store"), true); // 无 / 的模式按文件名匹配
	assert.equal(m.ignores("deep/dir/Thumbs.db"), true);
	assert.equal(m.ignores("Notes/hello.md"), false);
	assert.equal(m.ignores("trash-not.md"), false);
});

test("IgnoreMatcher: 用户 Glob 规则", () => {
	const m = new IgnoreMatcher(false, PLUGIN_DIR, "Private/**\n*.tmp\nDrafts/*.md");
	assert.equal(m.ignores("Private/secret.md"), true);
	assert.equal(m.ignores("Private/a/b/c.md"), true);
	assert.equal(m.ignores("note.tmp"), true);
	assert.equal(m.ignores("sub/dir/x.tmp"), true);
	assert.equal(m.ignores("Drafts/wip.md"), true);
	assert.equal(m.ignores("Drafts/sub/wip.md"), false); // 单个 * 不跨层级
	assert.equal(m.ignores("PrivateNotes/x.md"), false);
});

test("IgnoreMatcher: 中文路径", () => {
	const m = new IgnoreMatcher(false, PLUGIN_DIR, "私密/**");
	assert.equal(m.ignores("私密/日记.md"), true);
	assert.equal(m.ignores("笔记/日常.md"), false);
});

test("conflictPathFor: 常规文件", () => {
	const when = new Date(2026, 7, 8, 0, 15, 0); // 2026-08-08 00:15:00
	assert.equal(
		conflictPathFor("Project.md", "MacBook", when),
		"Project.conflict-MacBook-20260808-001500.md",
	);
});

test("conflictPathFor: 带目录、无扩展名、隐藏文件、非法设备名字符", () => {
	const when = new Date(2026, 7, 8, 12, 30, 45);
	assert.equal(
		conflictPathFor("Notes/深/计划.md", "我的 Mac", when),
		"Notes/深/计划.conflict-我的 Mac-20260808-123045.md",
	);
	assert.equal(conflictPathFor("README", "PC", when), "README.conflict-PC-20260808-123045");
	assert.equal(
		conflictPathFor("dir/.hidden", "a/b:c", when),
		"dir/.hidden.conflict-a-b-c-20260808-123045",
	);
});

test("PendingQueue: 按路径去重，后到动作覆盖", () => {
	const q = new PendingQueue();
	q.add("a.md", "upsert");
	q.add("a.md", "delete");
	q.add("b.md", "upsert");
	assert.equal(q.size, 2);
	const entries = new Map(q.entries());
	assert.equal(entries.get("a.md"), "delete");
	assert.equal(entries.get("b.md"), "upsert");
	// entries() 是快照，不清空队列
	assert.equal(q.size, 2);
	q.remove("a.md");
	assert.equal(q.size, 1);
});
