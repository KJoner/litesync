#!/usr/bin/env node
/**
 * 检查 INV-01 … INV-12 是否都有测试标注自己覆盖了它。
 *
 * 计划书 §2 结尾写着：「所有自动化测试都应标注自己覆盖了哪些 INV 编号。」
 * 这句话如果没人检查，标注就会停在最早那几个文件里——本次检查正是这么发现
 * 有几条不变量一个标注都没有的。
 *
 * 判据刻意宽松：只要某个 INV 编号出现在测试文件里就算被覆盖。目的不是精确
 * 度量覆盖率（那做不到），而是让「加了一条不变量却没有任何测试提到它」
 * 这件事无法悄悄发生。
 *
 * 客户端只负责客户端侧的不变量；服务端侧由 litesync-server 的
 * TestInvariantsAreAnnotated 检查。两边各查各的，避免一个仓库替另一个背书。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 本仓库（客户端）负责证明的不变量。 */
const CLIENT_OWNED = {
	"INV-03": "客户端不得覆盖不满足本地前置条件的内容；无法确认安全时必须 keep-both",
	"INV-04": "远端 sequence 只有在成功应用、持久化冲突或持久化 blocked operation 后才能确认",
	"INV-05": "文件身份由稳定 fileId 决定；改名、迁移、恢复历史不得重置身份/revision/generation",
	"INV-07": "加密信封只允许升级，不允许降级",
	"INV-09": "客户端状态损坏时必须停止同步，不得自动从空状态继续运行",
	"INV-10": "server URL / Token / vaultId / repoEpoch / formatEpoch 任一改变都必须重新绑定",
	"INV-11": "所有迁移必须可恢复、可重复、幂等；验证失败不得进入 irreversible complete",
};

const TESTS_DIR = "tests";
if (!existsSync(TESTS_DIR)) {
	console.error(`找不到 ${TESTS_DIR}`);
	process.exit(1);
}

const corpus = readdirSync(TESTS_DIR)
	.filter((f) => f.endsWith(".test.ts"))
	.map((f) => readFileSync(join(TESTS_DIR, f), "utf8"))
	.join("\n");

let missing = 0;
for (const [inv, desc] of Object.entries(CLIENT_OWNED)) {
	const hits = corpus.split(inv).length - 1;
	if (hits === 0) {
		missing++;
		console.error(`✗ ${inv} 没有任何测试标注覆盖\n    ${desc}`);
	} else {
		console.log(`✓ ${inv}  (${hits} 处标注)`);
	}
}

console.log(`\n客户端负责 ${Object.keys(CLIENT_OWNED).length} 条不变量，${missing} 条无标注`);
if (missing > 0) {
	console.error(
		"计划书 §2：「所有自动化测试都应标注自己覆盖了哪些 INV 编号。」\n" +
			"请在覆盖该不变量的测试里写上编号——没有标注的不变量，等于没人在守它。",
	);
	process.exit(1);
}
