// crypto-core 冻结测试向量（v0.20 公开化 / ADR-015）；覆盖 INV-07（信封格式只升不降：
// 已入库的 LSE3/LSE4/LSM1 字节必须永远可解）。
//
// test-vectors/crypto-core-v1.json 由 scripts/gen-crypto-vectors.mjs 用固定种子随机源
// 从本仓 src/crypto/crypto.ts 生成，然后**冻结**。LiteSync Web 用 vendor 进去的同一份
// 源码跑同一份向量（litesync-server/web/test/crypto-core-vectors.test.mjs）——两边都绿，
// 才说明网页建库/写入产出的密文插件解得开，反之亦然。
//
// 这里走的是正常（真随机）代码路径：只验证「冻结的字节能被解开、篡改会被拒绝」，
// 不依赖生成时的伪随机源。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	b64decode,
	canonicalPathHmac,
	decryptFileV3,
	decryptFileV4,
	decryptMeta,
	deriveMetaKeys,
	deriveResetAuth,
	exportVmkRaw,
	isLse3Envelope,
	isLse4Envelope,
	unlockVaultKey,
	type VaultKeyDoc,
} from "../src/crypto/crypto";

interface Vectors {
	format: string;
	version: number;
	password: string;
	vmkHex: string;
	keyDoc: VaultKeyDoc;
	binding: { vaultIdentity: string; keyEpoch: number; fileId: string };
	files: { label: string; envelope: string; generation: number; padded: boolean; plaintextB64: string; ciphertextB64: string }[];
	meta: { fileId: string; metaGeneration: number; path: string; lsm1B64: string; canonicalHmacHex: string }[];
	resetAuthHex: string;
}

const V = JSON.parse(readFileSync(join(__dirname, "..", "test-vectors", "crypto-core-v1.json"), "utf8")) as Vectors;

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const ab = (b64: string) => {
	const u = b64decode(b64);
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};

test("crypto-core 向量：格式与版本", () => {
	assert.equal(V.format, "litesync-crypto-core-vectors");
	assert.equal(V.version, 1);
	assert.equal(V.keyDoc.version, 1);
	assert.equal(V.keyDoc.kdf, "pbkdf2-sha256");
	assert.equal(V.keyDoc.iterations, 600_000);
	assert.equal(V.keyDoc.enabled, true);
});

test("crypto-core 向量：正确密码解开同一把 VMK，错误密码返回 null", async () => {
	const vmk = await unlockVaultKey(V.keyDoc, V.password);
	assert.ok(vmk, "冻结的 keyDoc 必须能用原密码解锁");
	assert.equal(hex(await exportVmkRaw(vmk)), V.vmkHex);
	assert.equal(await unlockVaultKey(V.keyDoc, V.password + "x"), null);
	// 篡改 wrappedKey 一个字节 → GCM 认证失败
	const wrapped = b64decode(V.keyDoc.wrappedKey);
	wrapped[5] ^= 0x01;
	const tampered = { ...V.keyDoc, wrappedKey: Buffer.from(wrapped).toString("base64") };
	assert.equal(await unlockVaultKey(tampered, V.password), null);
});

test("crypto-core 向量：LSE3 / LSE4（填充与不填充）解密得到原文；绑定错误即拒绝（INV-07）", async () => {
	const vmk = await unlockVaultKey(V.keyDoc, V.password);
	assert.ok(vmk);
	const { vaultIdentity, keyEpoch, fileId } = V.binding;
	for (const f of V.files) {
		const ct = ab(f.ciphertextB64);
		const dec = f.envelope === "LSE3" ? decryptFileV3 : decryptFileV4;
		assert.ok(f.envelope === "LSE3" ? isLse3Envelope(ct) : isLse4Envelope(ct), `${f.label} 信封魔数`);
		const out = await dec(vmk, ct, vaultIdentity, fileId, keyEpoch);
		assert.ok(out, `${f.label} 必须可解`);
		assert.equal(Buffer.from(out.plain).toString("base64"), f.plaintextB64, `${f.label} 明文一致`);
		assert.equal(out.generation, f.generation);
		// AAD 绑定：换仓库身份 / 换 fileId / 换密钥世代都必须解不开
		assert.equal(await dec(vmk, ct, "ffffffffffffffffffffffffffffffff", fileId, keyEpoch), null, `${f.label} 跨仓库重放`);
		assert.equal(await dec(vmk, ct, vaultIdentity, "00000000000000000000000000000000", keyEpoch), null, `${f.label} 换 fileId`);
		assert.equal(await dec(vmk, ct, vaultIdentity, fileId, keyEpoch + 1), null, `${f.label} 换 keyEpoch`);
	}
	// 填充的 LSE4 密文落在桶边界上（服务器只看得到桶大小）
	const padded = V.files.find((f) => f.padded)!;
	assert.ok(b64decode(padded.ciphertextB64).length >= 4096);
});

test("crypto-core 向量：LSM1 路径元数据、canonical HMAC 与重置凭证", async () => {
	const vmk = await unlockVaultKey(V.keyDoc, V.password);
	assert.ok(vmk);
	const raw = await exportVmkRaw(vmk);
	const keys = await deriveMetaKeys(raw);
	for (const m of V.meta) {
		const out = await decryptMeta(keys, m.lsm1B64, V.binding.vaultIdentity, m.fileId);
		assert.ok(out);
		assert.equal(out.meta.path, m.path);
		assert.equal(out.metaGeneration, m.metaGeneration);
		assert.equal(await decryptMeta(keys, m.lsm1B64, V.binding.vaultIdentity, "00000000000000000000000000000000"), null);
		assert.equal(await canonicalPathHmac(keys, m.path), m.canonicalHmacHex);
	}
	assert.equal(await deriveResetAuth(raw), V.resetAuthHex);
	raw.fill(0);
});
