#!/usr/bin/env node
/**
 * 编译并运行 tests/ 下的**全部**测试。
 *
 * 之前 package.json 里是一串手写的文件名。那种写法有一个安静的失败模式：
 * 新增一个测试文件不会有任何报错，它只是**不运行**——而我们恰恰规定
 * 「任务的完成依据是测试」。一份不运行的测试比没有测试更糟，因为它看上去像有。
 *
 * 现在按目录发现。加一个 tests/xxx.test.ts 就自动进入这一轮。
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = "tests";
const OUT_DIR = ".test-build";

const sources = readdirSync(TESTS_DIR)
	.filter((f) => f.endsWith(".test.ts"))
	.sort()
	.map((f) => join(TESTS_DIR, f));

if (sources.length === 0) {
	console.error("tests/ 下没有找到任何 *.test.ts —— 发现逻辑大概坏了");
	process.exit(1);
}

console.log(`发现 ${sources.length} 个测试文件`);

const run = (cmd, args) =>
	execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });

run("npx", [
	"esbuild",
	...sources,
	"--bundle",
	"--platform=node",
	"--format=cjs",
	"--alias:obsidian=./tests/mocks/obsidian.ts",
	`--outdir=${OUT_DIR}`,
]);

const compiled = sources.map((s) => join(OUT_DIR, s.slice(TESTS_DIR.length + 1).replace(/\.ts$/, ".js")));
run("node", ["--test", ...compiled]);
