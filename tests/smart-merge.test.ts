// v0.8.1 智能三方合并测试：frontmatter 字段级 / section / list / token 各层，
// 以及「不确定绝不自作主张」的保守性。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeFrontmatter, parseFmBlocks, splitFrontmatter } from "../src/merge/markdown/frontmatter";
import { tryMergeListBlock } from "../src/merge/markdown/lists";
import { alignSections, splitSections } from "../src/merge/markdown/sections";
import { smartThreeWayMerge } from "../src/merge/smart-merge";
import { tokenize } from "../src/merge/token/tokenize";
import { tokenThreeWayMerge } from "../src/merge/token/three-way-token";

// ---------- tokenize ----------

test("tokenize: 无损（join === 原文），中英混排/emoji/CRLF", () => {
	for (const text of [
		"今天完成了 LiteSync 的同步功能。",
		"hello world_2 你好\r\n- [ ] task 🚀 done",
		"",
		"# 标题\n\n正文 text。",
	]) {
		assert.equal(tokenize(text).join(""), text);
	}
});

test("tokenize: Latin 按词、CJK 按字", () => {
	const tokens = tokenize("sync同步 ok");
	assert.deepEqual(tokens, ["sync", "同", "步", " ", "ok"]);
});

// ---------- token 级三方合并 ----------

test("token merge: 同一行内不重叠修改自动合并（文档示例）", () => {
	const base = "今天完成了 LiteSync 的同步功能。";
	const local = "今天完成了 LiteSync 的同步和冲突功能。";
	const remote = "今天完成了 LiteSync 的同步功能。 #dev";
	assert.equal(tokenThreeWayMerge(base, local, remote), "今天完成了 LiteSync 的同步和冲突功能。 #dev");
});

test("token merge: 同一区域双方改成不同 → null（不自作主张）", () => {
	assert.equal(tokenThreeWayMerge("明天去上海。", "明天下午去上海。", "明天晚上去上海。"), null);
});

// ---------- frontmatter ----------

test("frontmatter: 不同 key 修改 + 数组新增 union（文档示例）", () => {
	const base = "status: todo\ntags:\n  - project\npriority: 1\n";
	const local = "status: doing\ntags:\n  - project\npriority: 1\n";
	const remote = "status: todo\ntags:\n  - project\n  - important\npriority: 1\n";
	assert.equal(mergeFrontmatter(base, local, remote), "status: doing\ntags:\n  - project\n  - important\npriority: 1\n");
});

test("frontmatter: 同 key 双方改成不同 → null（交给行级呈现冲突）", () => {
	assert.equal(mergeFrontmatter("status: todo\n", "status: doing\n", "status: done\n"), null);
});

test("frontmatter: 新增 key 双方各自不同 → 合并；一边删除一边未动 → 删除", () => {
	const base = "a: 1\nb: 2\n";
	const local = "a: 1\nc: 3\n"; // 删 b，加 c
	const remote = "a: 1\nb: 2\nd: 4\n"; // 加 d
	assert.equal(mergeFrontmatter(base, local, remote), "a: 1\nc: 3\nd: 4\n");
});

test("frontmatter: 解析不可靠（重复 key）→ null", () => {
	assert.equal(parseFmBlocks("a: 1\na: 2\n"), null);
});

test("splitFrontmatter: 边界正确且 body 保持原样", () => {
	const doc = "---\ntags:\n  - x\n---\n# 标题\n正文";
	const { fm, body } = splitFrontmatter(doc);
	assert.equal(fm, "tags:\n  - x\n");
	assert.equal(body, "# 标题\n正文");
	assert.deepEqual(splitFrontmatter("no fm"), { fm: null, body: "no fm" });
});

// ---------- list ----------

test("list merge: 双方新增不同 item → union（文档示例：买菜/买咖啡/买牛奶）", () => {
	assert.deepEqual(tryMergeListBlock(["- 买菜"], ["- 买菜", "- 买咖啡"], ["- 买菜", "- 买牛奶"]), [
		"- 买菜",
		"- 买咖啡",
		"- 买牛奶",
	]);
});

test("list merge: task 勾选一方完成、另一方未动 → 自动完成", () => {
	assert.deepEqual(tryMergeListBlock(["- [ ] 写 README"], ["- [x] 写 README"], ["- [ ] 写 README"]), [
		"- [x] 写 README",
	]);
});

test("list merge: 一边删除一边修改（勾选）→ null；非列表行 → null", () => {
	assert.equal(tryMergeListBlock(["- [ ] a"], [], ["- [x] a"]), null);
	assert.equal(tryMergeListBlock(["- a"], ["- a", "正文行"], ["- a"]), null);
	// 嵌套（缩进）保守放弃
	assert.equal(tryMergeListBlock(["- a"], ["- a", "  - sub"], ["- a"]), null);
});

// ---------- section ----------

test("sections: fence 内的 # 不算 heading；path 为祖先链", () => {
	const lines = ["# A", "text", "```", "# not heading", "```", "## B", "x"];
	const secs = splitSections(lines);
	assert.deepEqual(
		secs.map((s) => s.path),
		["A", "A / B"],
	);
});

test("sections: 三方结构一致才对齐；结构变化返回 null", () => {
	const base = ["# A", "1", "# B", "2"];
	assert.ok(alignSections(base, ["# A", "1x", "# B", "2"], ["# A", "1", "# B", "2y"]));
	assert.equal(alignSections(base, ["# A", "1", "# C", "2"], base), null);
	assert.equal(alignSections(base, ["# A", "1"], base), null);
});

// ---------- smartThreeWayMerge 集成 ----------

test("smart: frontmatter + 正文不同区域修改 → 全自动合并", () => {
	const base = "---\nstatus: todo\ntags:\n  - project\n---\n# 日志\n\n## 工作\n\n完成 A。\n\n## 生活\n\n跑步。";
	const local = "---\nstatus: doing\ntags:\n  - project\n---\n# 日志\n\n## 工作\n\n完成 A。\n完成 B。\n\n## 生活\n\n跑步。";
	const remote =
		"---\nstatus: todo\ntags:\n  - project\n  - life\n---\n# 日志\n\n## 工作\n\n完成 A。\n\n## 生活\n\n跑步。\n读书。";
	const r = smartThreeWayMerge({ base, local, remote });
	assert.equal(r.clean, true, JSON.stringify(r.conflicts));
	assert.ok(r.mergedText.includes("status: doing"));
	assert.ok(r.mergedText.includes("- life"));
	assert.ok(r.mergedText.includes("完成 B。"));
	assert.ok(r.mergedText.includes("读书。"));
});

test("smart: 行级冲突被 token 层自动解决并计入 stats", () => {
	const base = "开头\n今天完成了 LiteSync 的同步功能。\n结尾";
	const local = "开头\n今天完成了 LiteSync 的同步和冲突功能。\n结尾";
	const remote = "开头\n今天完成了 LiteSync 的同步功能。 #dev\n结尾";
	const r = smartThreeWayMerge({ base, local, remote });
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "开头\n今天完成了 LiteSync 的同步和冲突功能。 #dev\n结尾");
	assert.equal(r.stats?.autoResolved, 1);
});

test("smart: 真语义冲突仍交给用户；delete-edit 附带建议", () => {
	// 同一句双方改成不同 → 冲突（无建议）
	const r1 = smartThreeWayMerge({
		base: "明天去上海。",
		local: "明天下午去上海。",
		remote: "明天晚上去上海。",
	});
	assert.equal(r1.clean, false);
	assert.equal(r1.conflicts.length, 1);
	assert.equal(r1.conflicts[0].suggestedText, undefined);

	// 一边删除整段、一边修改 → 冲突 + 建议保留修改
	const r2 = smartThreeWayMerge({
		base: "第一段\n\n第二段旧内容",
		local: "第一段",
		remote: "第一段\n\n第二段新内容",
	});
	assert.equal(r2.clean, false);
	const c = r2.conflicts[0];
	assert.equal(c.kind, "delete-edit");
	assert.ok(c.suggestedText?.includes("第二段新内容"));
	assert.equal(c.confidence, "medium");
});

test("smart: 与行级引擎行为兼容（单侧修改 clean 合并）", () => {
	const r = smartThreeWayMerge({ base: "a\nb\nc", local: "a\nB\nc", remote: "a\nb\nc" });
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "a\nB\nc");
});

test("smart: 列表冲突块整体自动 union", () => {
	const base = "# 购物\n\n- 买菜";
	const local = "# 购物\n\n- 买菜\n- 买咖啡";
	const remote = "# 购物\n\n- 买菜\n- 买牛奶";
	const r = smartThreeWayMerge({ base, local, remote });
	assert.equal(r.clean, true, JSON.stringify(r.conflicts));
	assert.equal(r.mergedText, "# 购物\n\n- 买菜\n- 买咖啡\n- 买牛奶");
});
