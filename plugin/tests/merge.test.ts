// 三方合并引擎单元测试（计划书 Phase 14「Three-Way Merge 必测场景」）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DiffTooLargeError, diffHunks, diffLinesView, splitLines } from "../src/merge/diff";
import { assembleResolution, threeWayMerge } from "../src/merge/three-way";

// ---------- diff 基础 ----------

test("diffHunks: 相同输入无差异", () => {
	assert.deepEqual(diffHunks(["a", "b"], ["a", "b"]), []);
});

test("diffHunks: 单行替换", () => {
	const hunks = diffHunks(["a", "b", "c"], ["a", "X", "c"]);
	assert.deepEqual(hunks, [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
});

test("diffHunks: 插入与删除", () => {
	assert.deepEqual(diffHunks(["a", "c"], ["a", "b", "c"]), [{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
	assert.deepEqual(diffHunks(["a", "b", "c"], ["a", "c"]), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
});

test("diffHunks: 编辑距离超限抛 DiffTooLargeError", () => {
	const a = Array.from({ length: 1500 }, (_, i) => `a${i}`);
	const b = Array.from({ length: 1500 }, (_, i) => `b${i}`);
	assert.throws(() => diffHunks(a, b), DiffTooLargeError);
});

test("diffLinesView: 渲染行级差异", () => {
	const lines = diffLinesView("a\nb\nc", "a\nX\nc");
	assert.deepEqual(
		lines.map((l) => l.type + ":" + l.text),
		["same:a", "del:b", "add:X", "same:c"],
	);
});

// ---------- 测试 1：Local 与 Remote 修改不同位置 → 自动 merge ----------

test("三方合并: 不同位置修改自动合并（计划书 Clean Merge 示例）", () => {
	const r = threeWayMerge({
		base: "A\nB\nC\nD",
		local: "A\nLOCAL\nC\nD",
		remote: "A\nB\nC\nREMOTE",
	});
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "A\nLOCAL\nC\nREMOTE");
	assert.equal(r.conflicts.length, 0);
});

// ---------- 测试 2：两边修改同一行 → conflict ----------

test("三方合并: 同一行修改产生结构化冲突", () => {
	const r = threeWayMerge({
		base: "A\nB\nC",
		local: "A\nLOCAL\nC",
		remote: "A\nREMOTE\nC",
	});
	assert.equal(r.clean, false);
	assert.equal(r.conflicts.length, 1);
	const c = r.conflicts[0];
	assert.equal(c.baseText, "B");
	assert.equal(c.localText, "LOCAL");
	assert.equal(c.remoteText, "REMOTE");
	assert.equal(c.baseStart, 1);
	assert.equal(c.baseEnd, 2);
	// 不允许输出 conflict marker
	assert.ok(!r.mergedText.includes("<<<<<<<"));
});

// ---------- 测试 3：Local 插入，Remote 修改其他位置 → 自动 merge ----------

test("三方合并: 插入与远端他处修改自动合并", () => {
	const r = threeWayMerge({
		base: "A\nB\nC",
		local: "A\nNEW\nB\nC",
		remote: "A\nB\nC2",
	});
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "A\nNEW\nB\nC2");
});

// ---------- 测试 4：两边同一位置插入不同内容 → conflict ----------

test("三方合并: 同一位置插入不同内容产生冲突", () => {
	const r = threeWayMerge({
		base: "A\nB",
		local: "A\nL1\nB",
		remote: "A\nR1\nB",
	});
	assert.equal(r.clean, false);
	assert.equal(r.conflicts.length, 1);
	assert.equal(r.conflicts[0].baseText, "");
	assert.equal(r.conflicts[0].localText, "L1");
	assert.equal(r.conflicts[0].remoteText, "R1");
});

test("三方合并: 同一位置插入相同内容自动合并", () => {
	const r = threeWayMerge({
		base: "A\nB",
		local: "A\nSAME\nB",
		remote: "A\nSAME\nB",
	});
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "A\nSAME\nB");
});

// ---------- 测试 5：一边删除 paragraph，一边修改同一 paragraph → conflict ----------

test("三方合并: 删除与修改同一段落产生冲突", () => {
	const r = threeWayMerge({
		base: "A\nP1\nP2\nZ",
		local: "A\nZ", // 删除整段
		remote: "A\nP1-modified\nP2\nZ", // 修改该段
	});
	assert.equal(r.clean, false);
	assert.equal(r.conflicts.length, 1);
	assert.equal(r.conflicts[0].localText, "");
	assert.ok(r.conflicts[0].remoteText.includes("P1-modified"));
});

// ---------- 其他关键场景 ----------

test("三方合并: 两侧完全相同的修改自动合并", () => {
	const r = threeWayMerge({
		base: "A\nB\nC",
		local: "A\nX\nC",
		remote: "A\nX\nC",
	});
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "A\nX\nC");
});

test("三方合并: 仅一侧修改直接采用", () => {
	const local = threeWayMerge({ base: "A\nB", local: "A\nB2", remote: "A\nB" });
	assert.equal(local.clean, true);
	assert.equal(local.mergedText, "A\nB2");

	const remote = threeWayMerge({ base: "A\nB", local: "A\nB", remote: "A2\nB" });
	assert.equal(remote.clean, true);
	assert.equal(remote.mergedText, "A2\nB");
});

test("三方合并: 一侧删除整段另一侧未动 → 干净删除", () => {
	const r = threeWayMerge({
		base: "A\nB\nC",
		local: "A\nC",
		remote: "A\nB\nC",
	});
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "A\nC");
});

test("三方合并: 相邻行各自修改（不重叠）自动合并", () => {
	const r = threeWayMerge({
		base: "A\nB\nC\nD",
		local: "A\nB-local\nC\nD",
		remote: "A\nB\nC-remote\nD",
	});
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "A\nB-local\nC-remote\nD");
});

test("三方合并: 保留结尾换行", () => {
	const r = threeWayMerge({
		base: "A\nB\n",
		local: "A2\nB\n",
		remote: "A\nB2\n",
	});
	assert.equal(r.clean, true);
	assert.equal(r.mergedText, "A2\nB2\n");
});

test("三方合并: 空 Base（两侧独立创建不同内容）→ 冲突", () => {
	const r = threeWayMerge({ base: "", local: "local content", remote: "remote content" });
	assert.equal(r.clean, false);
});

test("三方合并: 多个独立冲突区域", () => {
	const r = threeWayMerge({
		base: "A\nB\nC\nD\nE",
		local: "A\nB-l\nC\nD-l\nE",
		remote: "A\nB-r\nC\nD-r\nE",
	});
	assert.equal(r.clean, false);
	assert.equal(r.conflicts.length, 2);
	assert.equal(r.conflicts[0].baseText, "B");
	assert.equal(r.conflicts[1].baseText, "D");
});

test("三方合并: segments 结构完整可重组", () => {
	const r = threeWayMerge({
		base: "A\nB\nC",
		local: "A\nLOCAL\nC",
		remote: "A\nREMOTE\nC",
	});
	// 选 local
	const useLocal = assembleResolution(r.segments, { [r.conflicts[0].id]: r.conflicts[0].localText });
	assert.equal(useLocal, "A\nLOCAL\nC");
	// 选 remote
	const useRemote = assembleResolution(r.segments, { [r.conflicts[0].id]: r.conflicts[0].remoteText });
	assert.equal(useRemote, "A\nREMOTE\nC");
	// Use Both
	const both = assembleResolution(r.segments, {
		[r.conflicts[0].id]: `${r.conflicts[0].localText}\n${r.conflicts[0].remoteText}`,
	});
	assert.equal(both, "A\nLOCAL\nREMOTE\nC");
	// 整段删除（空字符串选择 → 不输出任何行）
	const deleted = assembleResolution(r.segments, { [r.conflicts[0].id]: "" });
	assert.equal(deleted, "A\nC");
	// 未解决 → 抛错
	assert.throws(() => assembleResolution(r.segments, {}));
});

// ---------- 测试 8：Binary 不做 text merge（由 decodeUtf8Strict 判定）----------

test("二进制判定: NUL 字节与非法 UTF-8 拒绝按文本处理", async () => {
	const { decodeUtf8Strict } = await import("../src/utils/text");
	assert.equal(decodeUtf8Strict(new Uint8Array([0x41, 0x00, 0x42]).buffer), null);
	assert.equal(decodeUtf8Strict(new Uint8Array([0xff, 0xfe, 0x80]).buffer), null);
	assert.equal(decodeUtf8Strict(new TextEncoder().encode("正常文本").buffer as ArrayBuffer), "正常文本");
});

test("splitLines/合并大小写往返", () => {
	const text = "第一行\n第二行\n\n第四行";
	assert.equal(splitLines(text).join("\n"), text);
});
