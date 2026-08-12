// 跨平台路径用例（v0.14.0-RC / 计划书 §8.4 的可自动化部分）。
//
// §8.4 要求的实机矩阵（Windows / macOS / Linux / 移动端 / 网络盘）必须在真机上跑，
// 这里覆盖的是其中**与平台无关、可以在单元测试里确定的那一半**：
// 路径规则本身、跨平台碰撞判定、以及「同一份规则在所有平台上给出同样答案」。
//
// 这样划分的理由：如果碰撞判定依赖当前运行平台的行为，那么同一个 Vault 里的
// Windows 设备和 Linux 设备会对「这两个名字算不算同一个文件」得出不同结论，
// 从而互相覆盖。因此规则必须是**平台无关的**，也就必然可以在这里测。
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { StateStore } from "../src/state/store";
import {
	InvalidVaultPathError,
	pathsCollide,
	platformCollisionKey,
	validateAndCanonicalizeVaultPath,
} from "../src/utils/vault-path";

function memAdapter() {
	const files = new Map<string, string>();
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

// §8.4 列出的路径用例表。每一行都写清「为什么这条会出问题」。
const CASES: Array<{
	name: string;
	a: string;
	b: string;
	collide: boolean;
	why: string;
}> = [
	{
		name: "Note.md / note.md",
		a: "Note.md",
		b: "note.md",
		collide: true,
		why: "Windows 与 macOS 默认大小写不敏感：两个都下载会互相覆盖",
	},
	{
		name: "é 的 NFC / NFD",
		a: "café.md",
		b: "café.md",
		collide: true,
		why: "macOS 存 NFD、其他平台存 NFC；字节不同但指向同一个文件",
	},
	{
		name: "尾随点",
		a: "note.md",
		b: "note.md.",
		collide: true,
		why: "Windows 创建时会静默去掉尾随点",
	},
	{
		name: "尾随空格",
		a: "note.md",
		b: "note.md ",
		collide: true,
		why: "Windows 创建时会静默去掉尾随空格",
	},
	{
		name: "目录大小写",
		a: "Notes/a.md",
		b: "notes/a.md",
		collide: true,
		why: "目录名同样受大小写折叠影响",
	},
	{
		name: "普通不同名",
		a: "a.md",
		b: "b.md",
		collide: false,
		why: "对照组：正常的不同文件不能被误判为碰撞",
	},
	{
		name: "同名不同目录",
		a: "x/a.md",
		b: "y/a.md",
		collide: false,
		why: "对照组：目录不同就不是同一个文件",
	},
];

test("§8.4: 跨平台碰撞判定表", () => {
	for (const c of CASES) {
		assert.equal(pathsCollide(c.a, c.b), c.collide, `${c.name}：${c.why}`);
	}
});

test("§8.4: 碰撞键与运行平台无关（Linux 与 macOS 设备必须得出同样结论）", () => {
	// 如果这里用了 process.platform 之类的判断，同一个 Vault 里的两台不同系统
	// 的设备就会对「算不算重名」有分歧，从而互相覆盖对方的文件
	for (const c of CASES.filter((x) => x.collide)) {
		assert.equal(
			platformCollisionKey(c.a),
			platformCollisionKey(c.b),
			`${c.name}：碰撞键必须一致，否则不同平台的设备会打架`,
		);
	}
});

test("§8.4: Windows 保留名一律拒绝（CON / AUX / NUL 及带扩展名形式）", () => {
	for (const name of ["CON", "AUX", "NUL", "PRN", "COM1", "LPT1", "con.md", "nul.txt", "notes/AUX.md"]) {
		assert.throws(
			() => validateAndCanonicalizeVaultPath(name),
			(e: unknown) => e instanceof InvalidVaultPathError && e.reason === "windows-reserved",
			`${name} 在 Windows 上根本无法创建，必须在写盘之前就拒绝`,
		);
	}
	// 但含有保留名作为**子串**的正常文件名不能被误伤
	for (const ok of ["console.md", "connection.md", "auxiliary.md", "nullable.md"]) {
		assert.doesNotThrow(() => validateAndCanonicalizeVaultPath(ok), `${ok} 是正常文件名`);
	}
});

test("§8.4: 超长路径与超长组件被拒绝（而不是等文件系统报错）", () => {
	assert.throws(
		() => validateAndCanonicalizeVaultPath("x".repeat(600)),
		(e: unknown) => e instanceof InvalidVaultPathError && e.reason === "too-long",
	);
	assert.throws(
		() => validateAndCanonicalizeVaultPath(`dir/${"y".repeat(300)}.md`),
		(e: unknown) => e instanceof InvalidVaultPathError && e.reason === "component-too-long",
	);
	// 中文文件名占 3 字节/字：按**字节**算才和文件系统一致
	assert.throws(
		() => validateAndCanonicalizeVaultPath(`${"中".repeat(90)}.md`),
		(e: unknown) => e instanceof InvalidVaultPathError && e.reason === "component-too-long",
		"组件长度必须按字节算——按字符算会让中文名在真实文件系统上失败",
	);
	assert.doesNotThrow(() => validateAndCanonicalizeVaultPath(`${"中".repeat(50)}.md`));
});

test("§8.4: NFD 输入统一归一为 NFC（同一个文件在所有设备上得到同一个键）", () => {
	const nfd = "notes/café/résumé.md";
	const out = validateAndCanonicalizeVaultPath(nfd);
	assert.equal(out, out.normalize("NFC"));
	assert.notEqual(out, nfd, "输入确实是 NFD，测试才有意义");
});

test("§8.4: 大小写改名不被自己的碰撞检查挡住", async () => {
	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	const fid = "a".repeat(32);
	store.replaceWithNewObject("Notes/Alpha.md", {
		hash: "h", serverHash: "s", revision: 1, mtime: 0, size: 1, fileId: fid,
	});
	// 同一个对象改自己的大小写：不是碰撞
	assert.equal(store.collidingPath("notes/alpha.md", fid), undefined);
	// 另一个对象想占这个名字：是碰撞
	assert.equal(store.collidingPath("notes/alpha.md", "b".repeat(32)), "Notes/Alpha.md");
});

test("§8.4: 目录与文件同名由 blocked 流程处理（不在路径规则里拒绝）", () => {
	// "notes" 既可能是目录也可能是文件——这不是路径**规则**问题，
	// 而是运行期的占用问题，由 LocalCommitter 的 rejected + blocked 记录处理。
	// 这里确认路径规则本身不会误拒一个合法的无扩展名文件
	assert.doesNotThrow(() => validateAndCanonicalizeVaultPath("notes"));
	assert.doesNotThrow(() => validateAndCanonicalizeVaultPath("a/b/c"));
});
