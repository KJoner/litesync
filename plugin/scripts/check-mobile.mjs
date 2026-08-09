// 移动端兼容审计（v6 计划 Part 23/31）：
// Obsidian 移动端插件不能使用 Node.js / Electron API。
// 本脚本扫描 src/，发现任何 Node/Electron runtime 依赖立即失败（CI 检查）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
	// import ... from "fs" / "node:fs" / require("path") 等
	/(?:from\s+|require\s*\(\s*)["'](?:node:[\w/]+|fs|path|os|crypto|child_process|http|https|net|stream|util|zlib|electron)["']/,
];

const root = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* walk(p);
		else if (name.endsWith(".ts")) yield p;
	}
}

let bad = 0;
for (const file of walk(root)) {
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		for (const re of FORBIDDEN) {
			if (re.test(line)) {
				console.error(`✘ ${file}:${i + 1}: Node/Electron API 依赖（移动端不可用）: ${line.trim()}`);
				bad++;
			}
		}
	});
}

if (bad > 0) {
	console.error(`\ncheck-mobile: 发现 ${bad} 处禁止的 runtime 依赖`);
	process.exit(1);
}
console.log("check-mobile: ✓ src/ 无 Node/Electron runtime 依赖（Web Crypto / requestUrl / DataAdapter only）");
