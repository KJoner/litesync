import assert from "node:assert/strict";
import test from "node:test";

import { LocalCommitter, NON_ATOMIC_REASON } from "../src/sync/local-commit";
import { sha256Hex } from "../src/utils/hash";
import { renderProbeReport, runPlatformProbe } from "../src/diagnostics/platform-probe";

// 不可原子替换的平台必须安全退化为 keep-both
//（计划书 §8.8 发布门槛第 11 条；覆盖 INV-03）。
//
// # 为什么这条要用「模拟平台」而不是等真机
//
// 门槛 11 说的是「所有不可原子替换的平台」。哪些平台属于这一类需要实机探测，
// 但**退化行为本身**不需要——它是代码逻辑，可以在任何机器上验证。
// 把这两件事混在一起，结果就是退化路径一直没被测过，
// 而它恰恰只在最糟的平台上才会执行。
//
// # 探测的到底是哪个操作
//
// 安装流程是「先把旧内容挪进 recovery，再把 staging 改名过来」——目标路径在
// 改名那一刻已经是空的。所以要探测的是 rename 到一个空位，**不是**覆盖改名。
//
// 这个区别很要紧：Windows 的 rename 不能覆盖已存在的文件，但先挪走再改名完全
// 正常。按「能否覆盖」探测会把所有 Windows 用户误判成不支持原子替换，于是每次
// 远端更新都退化成冲突副本——一个为安全加的检查反过来毁掉正常平台的同步。
// 下面第二条测试专门钉住这一点。

/** 一个完全没有可用 rename 的内存 adapter（模拟不可原子替换的平台）。 */
function nonAtomicAdapter() {
	const files = new Map<string, ArrayBuffer>();
	const folders = new Set<string>(["", "/"]);
	return {
		files,
		folders,
		async stat(p: string) {
			if (folders.has(p)) return { type: "folder" as const, mtime: 0, size: 0 };
			const f = files.get(p);
			return f ? { type: "file" as const, mtime: 1, size: f.byteLength } : null;
		},
		async readBinary(p: string) {
			const f = files.get(p);
			if (!f) throw new Error(`ENOENT ${p}`);
			return f;
		},
		async writeBinary(p: string, d: ArrayBuffer) {
			files.set(p, d);
		},
		async rename(_from: string, _to: string): Promise<void> {
			// 被模拟的限制：这个平台根本没有可用的 rename
			throw new Error("ENOSYS: rename unavailable on this platform");
		},
		async remove(p: string) {
			files.delete(p);
		},
		async mkdir(p: string) {
			folders.add(p);
		},
		async exists(p: string) {
			return files.has(p) || folders.has(p);
		},
		async list() {
			return { files: [...files.keys()], folders: [...folders] };
		},
	};
}

/** 正常 adapter：rename 可用（对照组）。 */
function atomicAdapter() {
	const a = nonAtomicAdapter();
	a.rename = async (from: string, to: string) => {
		const f = a.files.get(from);
		if (!f) throw new Error(`ENOENT ${from}`);
		a.files.set(to, f);
		a.files.delete(from);
	};
	return a;
}

/**
 * 模拟 Windows：rename 可以改名到空位，但**不能覆盖**已存在的文件。
 * 这类平台必须被判定为**支持**原子安装——安装本来就不覆盖。
 */
function windowsLikeAdapter() {
	const a = nonAtomicAdapter();
	a.rename = async (from: string, to: string) => {
		if (a.files.has(to)) throw new Error("EEXIST: rename cannot overwrite");
		const f = a.files.get(from);
		if (!f) throw new Error(`ENOENT ${from}`);
		a.files.set(to, f);
		a.files.delete(from);
	};
	return a;
}

function committerOn(adapter: ReturnType<typeof nonAtomicAdapter>): LocalCommitter {
	const app = { vault: { adapter } } as never;
	return new LocalCommitter(app, ".litesync", () => {});
}

test("§8.8-11: 没有可用 rename 的平台被判定为不支持原子安装", async () => {
	const c = committerOn(nonAtomicAdapter());
	assert.equal(await c.supportsAtomicReplace(), false);

	// 对照：正常平台必须判定为支持，否则所有人都会退化，功能等于废掉
	const ok = committerOn(atomicAdapter());
	assert.equal(await ok.supportsAtomicReplace(), true);
});

test("§8.8-11: Windows 式 rename（不能覆盖）仍算支持——安装本来就不覆盖", async () => {
	// 安装流程是「先挪走旧内容，再改名到空位」。按「能否覆盖」来探测
	// 会把所有 Windows 用户误判成不支持，于是每次远端更新都退化成冲突副本。
	// 这条测试就是防这个过度收紧
	const c = committerOn(windowsLikeAdapter());
	assert.equal(
		await c.supportsAtomicReplace(),
		true,
		"rename 不能覆盖 ≠ 不能原子安装；误判会让正常平台的同步退化成一堆冲突副本",
	);
});

test("§8.8-11: rename 假装成功但内容没搬过去 → 必须判定为不支持", async () => {
	// 只查「目标存在」查不出这种适配器
	const a = nonAtomicAdapter();
	a.rename = async (_from: string, to: string) => {
		a.files.set(to, new ArrayBuffer(0)); // 建了个空文件就当改名成功
	};
	const c = committerOn(a);
	assert.equal(await c.supportsAtomicReplace(), false, "探测必须校验改名后的内容");
});

test("§8.8-11: 不可原子替换时，覆盖写入被拒且原文件一字未动", async () => {
	const adapter = nonAtomicAdapter();
	const original = new TextEncoder().encode("用户原有的内容").buffer as ArrayBuffer;
	adapter.files.set("note.md", original);

	const c = committerOn(adapter);
	const incoming = new TextEncoder().encode("远端的新内容").buffer as ArrayBuffer;
	const res = await c.commitRemoteChange({
		operationId: "op-1",
		realPath: "note.md",
		expectedLocalHash: await sha256Hex(original),
		incoming,
		incomingHash: await sha256Hex(incoming),
		conflictPolicy: "fail",
	});

	assert.equal(res.status, "rejected", "不得在无原子替换的平台上做覆盖写入");
	assert.ok(
		res.status === "rejected" && (res.reason ?? "").startsWith(NON_ATOMIC_REASON),
		`原因必须可判定（便于与「本地真的被改了」区分），得到：${res.status === "rejected" ? (res.reason ?? "") : ""}`,
	);
	// 最关键的一条：原文件必须一个字节都没变
	assert.deepEqual(
		new Uint8Array(adapter.files.get("note.md")!),
		new Uint8Array(original),
		"被拒之后原文件必须保持原样——半个文件就是用户唯一的那份内容",
	);
});

test("§8.8-11: 新建文件不受影响（它本来就不需要原子替换）", async () => {
	const adapter = nonAtomicAdapter();
	const c = committerOn(adapter);
	const data = new TextEncoder().encode("新文件").buffer as ArrayBuffer;

	const res = await c.commitRemoteChange({
		operationId: "op-2",
		realPath: "new.md",
		expectedLocalHash: null,
		incoming: data,
		incomingHash: await sha256Hex(data),
		conflictPolicy: "fail",
	});

	assert.equal(res.status, "committed", "新建不需要原子替换：写坏了也毁不掉已有内容");
	assert.deepEqual(new Uint8Array(adapter.files.get("new.md")!), new Uint8Array(data));
});

test("§8.8-11: 正常平台上覆盖写入照常成功（退化不能误伤所有人）", async () => {
	const adapter = windowsLikeAdapter();
	const original = new TextEncoder().encode("旧内容").buffer as ArrayBuffer;
	adapter.files.set("note.md", original);

	const c = committerOn(adapter);
	const incoming = new TextEncoder().encode("新内容").buffer as ArrayBuffer;
	const res = await c.commitRemoteChange({
		operationId: "op-3",
		realPath: "note.md",
		expectedLocalHash: await sha256Hex(original),
		incoming,
		incomingHash: await sha256Hex(incoming),
		conflictPolicy: "fail",
	});

	assert.equal(res.status, "committed");
	assert.deepEqual(new Uint8Array(adapter.files.get("note.md")!), new Uint8Array(incoming));
});

test("§8.8-11: 探测只跑一次（每次写入都探测会拖慢移动端）", async () => {
	const adapter = nonAtomicAdapter();
	let renames = 0;
	const inner = adapter.rename;
	adapter.rename = async (a: string, b: string) => {
		renames++;
		return inner(a, b);
	};
	const c = committerOn(adapter);
	await c.supportsAtomicReplace();
	const afterFirst = renames;
	await c.supportsAtomicReplace();
	await c.supportsAtomicReplace();
	assert.equal(renames, afterFirst, "探测结果必须被缓存");
});

// ---------- 平台自检（§8.4 实机矩阵、§8.8 门槛 3） ----------
//
// §8.4 要求在各平台跑一遍路径用例矩阵，但移动端跑不了 Node——那一格长期
// 只能靠推理填。这个自检跑在插件内部、用 Obsidian 自己的 adapter，
// 因此在移动端也能跑。下面验证它的判定逻辑，而不是某台机器的行为。

test("§8.4: 自检测出的是**实际行为**，不是照抄规则的答案", async () => {
	// 造一个大小写不敏感的 adapter：Note.md 与 note.md 指向同一份内容
	const adapter = atomicAdapter();
	const lower = (p: string) => p.toLowerCase();
	adapter.writeBinary = async (p: string, d: ArrayBuffer) => {
		adapter.files.set(lower(p), d);
	};
	adapter.readBinary = async (p: string) => {
		const f = adapter.files.get(lower(p));
		if (!f) throw new Error("ENOENT");
		return f;
	};
	adapter.stat = async (p: string) => {
		if (adapter.folders.has(p)) return { type: "folder" as const, mtime: 0, size: 0 };
		const f = adapter.files.get(lower(p));
		return f ? { type: "file" as const, mtime: 1, size: f.byteLength } : null;
	};
	adapter.remove = async (p: string) => {
		adapter.files.delete(lower(p));
	};

	const app = { vault: { adapter } } as never;
	const rep = await runPlatformProbe(app, ".litesync", "test");
	const caseRow = rep.results.find((r) => r.name.includes("Note.md"));
	assert.ok(caseRow, "必须有大小写用例");
	assert.equal(caseRow.actual, "是", "这个 adapter 大小写不敏感，实测应当是同一个文件");
	// 规则也判碰撞（pathsCollide 会小写化），因此这是安全的
	assert.equal(caseRow.verdict, "safe", "现实碰撞 + 规则也判碰撞 = 安全");
});

// 判定逻辑本身：规则**比现实宽松**才是危险，比现实更严只是多拦一次。
//
// 这条是 iOS 首次实测反馈出来的：原实现用「实测 == 预言」的严格相等，
// 于是 iOS 上大小写敏感（实测不碰撞、规则判碰撞）被标成红色——
// 而那恰恰是最安全的方向。一份大部分是红色的报告等于没有报告：
// 真出问题的那一行会被淹掉。
test("§8.4: 规则比现实更严判为安全，比现实宽松才判为不安全", async () => {
	// 大小写**敏感**的 adapter：Note.md 与 note.md 是两个不同文件（如 iOS）
	const adapter = atomicAdapter();
	const app = { vault: { adapter } } as never;
	const rep = await runPlatformProbe(app, ".litesync", "test");

	const caseRow = rep.results.find((r) => r.name.includes("Note.md"));
	assert.ok(caseRow);
	assert.equal(caseRow.actual, "否", "这个 adapter 大小写敏感");
	assert.equal(caseRow.expected, "是", "规则仍判碰撞（保守）");
	assert.equal(
		caseRow.verdict,
		"safe",
		"规则比现实更严 = 安全。判成不安全会让真正的问题淹没在噪音里",
	);
	assert.equal(rep.hasUnsafe, false, "不该有任何不安全项");
});

test("§8.4: 设备能创建而规则拒绝 → 受限，不是不安全", async () => {
	// iOS 实测：CON.md / AUX.md / NUL.md 都能创建，而我们的规则拒绝它们
	const app = { vault: { adapter: atomicAdapter() } } as never;
	const rep = await runPlatformProbe(app, ".litesync", "test");

	const con = rep.results.find((r) => r.name.includes("CON.md"));
	assert.ok(con, "必须有保留名用例");
	assert.equal(con.actual, "是", "内存 adapter 能创建任意名字");
	assert.equal(con.expected, "否", "规则拒绝 Windows 保留名");
	assert.equal(con.verdict, "limited", "这类文件同步受限，但不丢数据——不是不安全");
	assert.match(con.note ?? "", /不会丢数据/, "必须说清楚不丢数据");
	assert.equal(rep.hasLimited, true);
	assert.equal(rep.hasUnsafe, false);
});

test("§8.4: 自检报告能被渲染成可直接贴出的 Markdown", async () => {
	const app = { vault: { adapter: atomicAdapter() } } as never;
	const rep = await runPlatformProbe(app, ".litesync", "0.17.0");
	const md = renderProbeReport(rep);

	assert.match(md, /# LiteSync 平台兼容性自检/);
	assert.match(md, /\| 用例 \| 本机实测 \| 规则预言 \| 判定 \|/, "必须是表格，便于直接贴出");
	assert.match(md, /0\.17\.0/, "必须带插件版本——不同版本的结论不能混为一谈");
	// 必须如实说明它只证明这一台设备
	assert.match(md, /这一台设备/);
	assert.match(md, /判定的含义/, "必须解释三种判定，否则读报告的人不知道该不该慌");
	assert.ok(rep.results.length >= 7, `用例太少（${rep.results.length}），§8.4 的矩阵没跑全`);
});

test("§8.4: 自检不留下任何残留文件", async () => {
	const adapter = atomicAdapter();
	const app = { vault: { adapter } } as never;
	await runPlatformProbe(app, ".litesync", "test");
	const leftovers = [...adapter.files.keys()].filter((p) => p.includes(".probe"));
	assert.deepEqual(leftovers, [], `自检残留了文件：${leftovers.join(", ")}`);
});
