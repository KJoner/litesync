#!/usr/bin/env node
/**
 * 生成 crypto-core 测试向量（v0.20 公开化 / ADR-015）。
 *
 * 向量由**插件真实的加密代码**产出（src/crypto/crypto.ts），只是把随机源换成
 * 固定种子的伪随机流——这样同一份代码每次生成的字节完全相同，向量可以冻结、
 * 入库，并由插件与 LiteSync Web 两边同时验证：
 *
 *   - 插件：tests/crypto-core-vectors.test.ts
 *   - Web：litesync-server/web/test/crypto-core-vectors.test.mjs（使用 vendor 副本）
 *
 * 向量一旦入库就**不再重新生成**：格式是协议的一部分，代码改动让旧向量解不开
 * 就是破坏兼容。只有在明确的信封版本升级时，才新增 crypto-core-v2.json。
 *
 * 用法：node scripts/gen-crypto-vectors.mjs [输出路径]
 */
import esbuild from "esbuild";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? join("test-vectors", "crypto-core-v1.json");

const entry = `
import * as C from "./src/crypto/crypto";

// 固定时钟（keyDoc.createdAt）与固定种子的 xorshift32 —— 只为让向量可复现，绝不是安全随机源
Date.now = () => 1795132800000;
let s = 0x9e3779b9;
globalThis.crypto.getRandomValues = (arr) => {
	const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
	for (let i = 0; i < u8.length; i++) {
		s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
		u8[i] = s & 0xff;
	}
	return arr;
};

const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b) => C.b64encode(new Uint8Array(b));
const enc = new TextEncoder();

const password = "correct horse battery staple · 仓库密码 2026";
const vaultIdentity = "0123456789abcdef0123456789abcdef";
const fileId = "aabbccddeeff00112233445566778899";
const keyEpoch = 1;
const markdown =
	"---\\ntitle: 测试笔记\\ntags: [a, b]\\n---\\n# 标题\\n\\n- [ ] 任务 [[路径/笔记#标题|别名]] ==高亮==\\n" +
	"> [!note] callout\\n\\n\`\`\`js\\nconsole.log(1)\\n\`\`\`\\n%%注释%%\\n$E=mc^2$\\r\\nCRLF 行\\n";
const plain = enc.encode(markdown).buffer;
const binary = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]).buffer;

const { doc, vmk } = await C.createVaultKeyDoc(password);
doc.enabled = true; // Web 初始化直接提交 enabled=true 的文档（ADR-012）
const vmkRaw = await C.exportVmkRaw(vmk);
const metaKeys = await C.deriveMetaKeys(vmkRaw);

const files = [];
for (const [label, data, kind, generation, padded] of [
	["markdown-lse3", plain, "lse3", 1, false],
	["markdown-lse4-padded", plain, "lse4", 2, true],
	["markdown-lse4-unpadded", plain, "lse4", 3, false],
	["binary-lse3", binary, "lse3", 4, false],
]) {
	const binding = { vaultId: vaultIdentity, keyEpoch, fileId, generation };
	const ct = kind === "lse3"
		? await C.encryptFileV3(vmk, binding, data)
		: await C.encryptFileV4(vmk, binding, data, padded);
	files.push({ label, envelope: kind.toUpperCase(), generation, padded, plaintextB64: b64(data), ciphertextB64: b64(ct) });
}

const metaPath = "日记/2026-11-21 周记.md";
const lsm1 = await C.encryptMeta(metaKeys, { vaultId: vaultIdentity, keyEpoch, fileId, metaGeneration: 1 }, { path: metaPath });

const vectors = {
	format: "litesync-crypto-core-vectors",
	version: 1,
	note: "由插件 src/crypto/crypto.ts 以固定种子随机源生成；冻结，不得重新生成（见 scripts/gen-crypto-vectors.mjs）",
	password,
	vmkHex: hex(vmkRaw),
	keyDoc: doc,
	binding: { vaultIdentity, keyEpoch, fileId },
	files,
	meta: [{ fileId, metaGeneration: 1, path: metaPath, lsm1B64: lsm1, canonicalHmacHex: await C.canonicalPathHmac(metaKeys, metaPath) }],
	resetAuthHex: await C.deriveResetAuth(vmkRaw),
};
console.log(JSON.stringify(vectors, null, "\\t"));
`;

const result = await esbuild.build({
	stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
	logLevel: "error",
});
const code = result.outputFiles[0].text;
const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");

// 在子模块里运行并捕获 stdout
const chunks = [];
const origLog = console.log;
console.log = (s) => chunks.push(s);
await import(url);
console.log = origLog;
writeFileSync(out, chunks.join("\n") + "\n");
console.log(`crypto-core vectors -> ${out}`);
