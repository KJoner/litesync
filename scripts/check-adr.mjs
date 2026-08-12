#!/usr/bin/env node
/**
 * 审计 ADR 是否写全了计划书 §14 要求的八个部分。
 *
 * §14 说「ADR 必须写出：威胁模型、不变量、状态机、失败语义、迁移方式、
 * 回滚方式、被放弃的替代方案、测试方法」。这句话写在计划书里不会自己生效——
 * 本次审计就发现 6 份 ADR 各缺 1–3 项，其中最常缺的是**回滚方式**。
 *
 * 缺回滚方式不是格式问题。一份没写回滚的 ADR，意味着做这个决定的时候
 * 没人想过「如果错了怎么办」；而这些决定里有好几个是不可逆的。
 *
 * docs/开发计划/ 不进版本库（本地文档），所以找不到目录时**跳过**而不是失败。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ADR_DIR = join("docs", "开发计划", "v10", "adr");

/** §14 要求的八个部分。值是可接受的标题关键词（同义写法）。 */
const REQUIRED = {
	威胁模型: ["威胁模型"],
	不变量: ["不变量"],
	状态机: ["状态机"],
	失败语义: ["失败语义"],
	迁移方式: ["迁移"],
	回滚方式: ["回滚"],
	被放弃的替代方案: ["替代方案"],
	测试方法: ["测试"],
};

if (!existsSync(ADR_DIR)) {
	console.log(`跳过：找不到 ${ADR_DIR}（开发文档不进版本库）`);
	process.exit(0);
}

const files = readdirSync(ADR_DIR)
	.filter((f) => f.startsWith("ADR-") && f.endsWith(".md"))
	.sort();

if (files.length === 0) {
	console.error(`${ADR_DIR} 下没有找到任何 ADR`);
	process.exit(1);
}

let failed = 0;
for (const file of files) {
	const text = readFileSync(join(ADR_DIR, file), "utf8");
	const headings = text.split("\n").filter((l) => /^#{1,4}\s/.test(l));
	const missing = Object.entries(REQUIRED)
		.filter(([, kws]) => !kws.some((kw) => headings.some((h) => h.includes(kw))))
		.map(([name]) => name);

	if (missing.length > 0) {
		failed++;
		console.error(`✗ ${file}\n    缺少：${missing.join("、")}`);
	} else {
		console.log(`✓ ${file}`);
	}
}

console.log(`\n${files.length} 份 ADR，${failed} 份不完整`);
if (failed > 0) {
	console.error("计划书 §14 要求每份 ADR 写出全部八个部分。");
	process.exit(1);
}
