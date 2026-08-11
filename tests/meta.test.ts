// v9.3 三期：元数据加密（LSM1 信封 + metaKey 派生 + canonical HMAC）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canonicalPathHmac,
	createVaultKeyDoc,
	decryptMeta,
	deriveMetaKeys,
	encryptMeta,
	exportVmkRaw,
} from "../src/crypto/crypto";

const FILE_ID = "0123456789abcdef0123456789abcdef";
const BIND = { vaultId: "aabbccdd00112233", keyEpoch: 1, fileId: FILE_ID, metaGeneration: 3 };

async function keys() {
	const { vmk } = await createVaultKeyDoc("meta-test-password");
	const raw = await exportVmkRaw(vmk);
	const k = await deriveMetaKeys(raw);
	raw.fill(0);
	return { k, vmk };
}

test("LSM1: 元数据往返一致（中文路径），metaGeneration 经 AAD 认证返回", async () => {
	const { k } = await keys();
	const enc = await encryptMeta(k, BIND, { path: "笔记/深度工作/第 3 章.md" });
	assert.equal(typeof enc, "string"); // base64

	const dec = await decryptMeta(k, enc, BIND.vaultId, BIND.fileId);
	assert.notEqual(dec, null);
	assert.equal(dec!.meta.path, "笔记/深度工作/第 3 章.md");
	assert.equal(dec!.metaGeneration, 3);
	assert.equal(dec!.keyEpoch, 1);
});

test("LSM1: AAD 绑定 fileId/vaultId → 换绑重放被拒绝", async () => {
	const { k } = await keys();
	const enc = await encryptMeta(k, BIND, { path: "secret/location.md" });
	// 换 fileId（把 A 的元数据挂到 B 上）→ 拒绝
	assert.equal(await decryptMeta(k, enc, BIND.vaultId, "ffff56789abcdef0123456789abcdef0"), null);
	// 换 vault → 拒绝
	assert.equal(await decryptMeta(k, enc, "other-vault", BIND.fileId), null);
});

test("LSM1: 密钥派生确定性（同 VMK → 同 metaKeys）；不同 VMK 互不可解", async () => {
	const { vmk } = await createVaultKeyDoc("pw-a");
	const raw1 = await exportVmkRaw(vmk);
	const k1 = await deriveMetaKeys(raw1);
	const k1b = await deriveMetaKeys(raw1);
	raw1.fill(0);

	const enc = await encryptMeta(k1, BIND, { path: "a.md" });
	// 同 VMK 再派生一次 → 可解（跨设备一致性）
	assert.notEqual(await decryptMeta(k1b, enc, BIND.vaultId, BIND.fileId), null);

	// 不同 VMK → 不可解
	const { k: k2 } = await keys();
	assert.equal(await decryptMeta(k2, enc, BIND.vaultId, BIND.fileId), null);
});

test("canonical HMAC: 大小写/NFC 归一化后一致；不同路径不同；密钥隔离", async () => {
	const { k } = await keys();
	const a = await canonicalPathHmac(k, "Notes/Café.md");
	const b = await canonicalPathHmac(k, "notes/café.md"); // 大小写不同
	const c = await canonicalPathHmac(k, "notes/café.md"); // NFD
	assert.equal(a, b);
	assert.equal(a, c);
	assert.match(a, /^[0-9a-f]{64}$/);

	const other = await canonicalPathHmac(k, "notes/other.md");
	assert.notEqual(a, other);

	// 不同 vault 的 metaKeys 对同一路径产生不同 HMAC（跨租户不可关联）
	const { k: k2 } = await keys();
	assert.notEqual(a, await canonicalPathHmac(k2, "Notes/Café.md"));
});

test("LSM1: 篡改与垃圾输入拒绝", async () => {
	const { k } = await keys();
	const enc = await encryptMeta(k, BIND, { path: "x.md" });
	const raw = Buffer.from(enc, "base64");
	raw[raw.length - 1] ^= 0x01;
	assert.equal(await decryptMeta(k, raw.toString("base64"), BIND.vaultId, BIND.fileId), null);
	assert.equal(await decryptMeta(k, "not-base64!!!", BIND.vaultId, BIND.fileId), null);
	assert.equal(await decryptMeta(k, "AAAA", BIND.vaultId, BIND.fileId), null);
});
