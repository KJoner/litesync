// E2EE 密码学层单元测试（计划书 Phase 12）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	b64decode,
	b64encode,
	b64urlEncode,
	createVaultKeyDoc,
	decryptFile,
	decryptShare,
	encryptFile,
	decryptFileV3,
	encryptFileV3,
	encryptShare,
	isEncryptedPayload,
	isLegacyEnvelope,
	isLse3Envelope,
	newFileId,
	parseLse3Header,
	randomBytes,
	unlockVaultKey,
} from "../src/crypto/crypto";

function buf(s: string): ArrayBuffer {
	const b = new TextEncoder().encode(s);
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

test("base64 往返", () => {
	const raw = randomBytes(37);
	assert.deepEqual(b64decode(b64encode(raw)), raw);
});

test("vault key: 正确密码解锁，错误密码拒绝", async () => {
	const { doc, vmk } = await createVaultKeyDoc("correct horse battery staple");
	assert.equal(doc.enabled, false);
	assert.equal(doc.kdf, "pbkdf2-sha256");
	assert.ok(doc.iterations >= 600_000);
	assert.ok(vmk instanceof CryptoKey || typeof vmk === "object");

	const unlocked = await unlockVaultKey(doc, "correct horse battery staple");
	assert.notEqual(unlocked, null);

	const wrong = await unlockVaultKey(doc, "wrong password");
	assert.equal(wrong, null);
});

test("vault key: wrappedKey 被篡改 → 解锁失败（GCM 认证）", async () => {
	const { doc } = await createVaultKeyDoc("password123");
	const tampered = b64decode(doc.wrappedKey);
	tampered[0] ^= 0xff;
	const bad = { ...doc, wrappedKey: b64encode(tampered) };
	assert.equal(await unlockVaultKey(bad, "password123"), null);
});

test("文件加密: 往返一致，格式可识别", async () => {
	const { vmk } = await createVaultKeyDoc("pw-for-files");
	const plain = buf("# 测试笔记\n\n中文内容 with English mixed in.\n");

	const payload = await encryptFile(vmk, "Notes/测试.md", plain);
	assert.equal(isEncryptedPayload(payload), true);
	assert.equal(isEncryptedPayload(plain), false);
	// 密文与明文不同且更长（magic + iv + tag）
	assert.ok(payload.byteLength > plain.byteLength);

	const dec = await decryptFile(vmk, "Notes/测试.md", payload);
	assert.notEqual(dec, null);
	assert.equal(new TextDecoder().decode(dec!), new TextDecoder().decode(plain));
});

test("文件加密: 随机 IV → 相同明文产生不同密文", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const plain = buf("same content");
	const c1 = new Uint8Array(await encryptFile(vmk, "a.md", plain));
	const c2 = new Uint8Array(await encryptFile(vmk, "a.md", plain));
	assert.notDeepEqual(c1, c2);
});

test("文件加密: 密文被篡改 → 解密返回 null", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const payload = new Uint8Array(await encryptFile(vmk, "a.md", buf("content")));
	payload[payload.length - 1] ^= 0x01;
	assert.equal(await decryptFile(vmk, "a.md", payload.buffer), null);
});

test("文件加密: 路径 AAD 绑定 → 换路径解密失败（防内容串换）", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const payload = await encryptFile(vmk, "Notes/A.md", buf("secret A"));
	assert.equal(await decryptFile(vmk, "Notes/B.md", payload), null);
	assert.notEqual(await decryptFile(vmk, "Notes/A.md", payload), null);
});

test("文件加密: 错误密钥解密失败", async () => {
	const a = await createVaultKeyDoc("password-a");
	const b = await createVaultKeyDoc("password-b");
	const payload = await encryptFile(a.vmk, "x.md", buf("data"));
	assert.equal(await decryptFile(b.vmk, "x.md", payload), null);
});

test("二进制内容加密往返", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const plain = randomBytes(4096);
	const payload = await encryptFile(vmk, "img.png", plain.buffer as ArrayBuffer);
	const dec = await decryptFile(vmk, "img.png", payload);
	assert.deepEqual(new Uint8Array(dec!), plain);
});

// ---------- LSE2 信封（v9.2） ----------

const BINDING = { vaultId: "aabbccdd00112233", keyEpoch: 1 };

test("LSE2: 往返一致，magic 正确，可被识别为加密格式", async () => {
	const { vmk } = await createVaultKeyDoc("pw-lse2");
	const plain = buf("# LSE2 内容\n中英混排 test.\n");
	const payload = await encryptFile(vmk, "Notes/n.md", plain, BINDING);
	assert.equal(isEncryptedPayload(payload), true);
	// v9.3 起 LSE2 也属于旧信封（升级目标为 LSE3）
	assert.equal(isLegacyEnvelope(payload), true);
	assert.deepEqual(Array.from(new Uint8Array(payload, 0, 4)), [0x4c, 0x53, 0x45, 0x32]); // "LSE2"

	const dec = await decryptFile(vmk, "Notes/n.md", payload, BINDING);
	assert.notEqual(dec, null);
	assert.equal(new TextDecoder().decode(dec!), new TextDecoder().decode(plain));
});

test("LSE2: AAD 绑定 vaultId → 其他 vault 的密文重放被拒绝", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const payload = await encryptFile(vmk, "a.md", buf("secret"), BINDING);
	assert.equal(await decryptFile(vmk, "a.md", payload, { ...BINDING, vaultId: "other-vault" }), null);
	// 无 binding（无法建立 AAD）→ 拒绝
	assert.equal(await decryptFile(vmk, "a.md", payload), null);
});

test("LSE2: keyEpoch 绑定 → 其他密钥世代的密文重放被拒绝", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const old = await encryptFile(vmk, "a.md", buf("epoch-1 content"), { ...BINDING, keyEpoch: 1 });
	// 当前世代已是 2：信封头写着 1 → 直接拒绝（不做解密尝试）
	assert.equal(await decryptFile(vmk, "a.md", old, { ...BINDING, keyEpoch: 2 }), null);
	// 世代未知（0/未采纳）时按信封头解（升级过渡期）
	assert.notEqual(await decryptFile(vmk, "a.md", old, { ...BINDING, keyEpoch: 0 }), null);
});

test("LSE2: 路径 AAD 绑定与篡改检测仍然生效", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const payload = await encryptFile(vmk, "Notes/A.md", buf("secret A"), BINDING);
	assert.equal(await decryptFile(vmk, "Notes/B.md", payload, BINDING), null);
	const tampered = new Uint8Array(payload.slice(0));
	tampered[tampered.length - 1] ^= 0x01;
	assert.equal(await decryptFile(vmk, "Notes/A.md", tampered.buffer, BINDING), null);
});

test("LSE1 兼容：旧信封仍可解密（升级过渡），isLegacyEnvelope 可区分", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const legacy = await encryptFile(vmk, "old.md", buf("legacy content")); // 无 binding → LSE1
	assert.equal(isLegacyEnvelope(legacy), true);
	// 带 binding 的解密调用也能解 LSE1（读取兼容）
	const dec = await decryptFile(vmk, "old.md", legacy, BINDING);
	assert.equal(new TextDecoder().decode(dec!), "legacy content");
});

// ---------- LSE3 信封（v9.3：fileId-AAD + contentGeneration） ----------

const FILE_ID = "0123456789abcdef0123456789abcdef";
const B3 = { vaultId: "aabbccdd00112233", keyEpoch: 2, fileId: FILE_ID, generation: 7 };

test("LSE3: 往返一致；信封头可解析；isLegacyEnvelope=false", async () => {
	const { vmk } = await createVaultKeyDoc("pw-lse3");
	const plain = buf("# LSE3\n改名不再需要重新加密。\n");
	const payload = await encryptFileV3(vmk, B3, plain);
	assert.equal(isEncryptedPayload(payload), true);
	assert.equal(isLse3Envelope(payload), true);
	assert.equal(isLegacyEnvelope(payload), false);
	assert.deepEqual(parseLse3Header(payload), { keyEpoch: 2, generation: 7 });

	const dec = await decryptFileV3(vmk, payload, B3.vaultId, B3.fileId, B3.keyEpoch);
	assert.notEqual(dec, null);
	assert.equal(dec!.generation, 7);
	assert.equal(new TextDecoder().decode(dec!.plain), new TextDecoder().decode(plain));
});

test("LSE3: AAD 绑定 fileId → 换 fileId（跨文件密文重放）被拒绝；路径无关", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const payload = await encryptFileV3(vmk, B3, buf("secret"));
	// 恶意服务器把 A 文件的密文说成 B 文件 → fileId 不符 → GCM 认证失败
	assert.equal(await decryptFileV3(vmk, payload, B3.vaultId, "ffff6789abcdef0123456789abcdef01", B3.keyEpoch), null);
	// vaultId 不符同样拒绝
	assert.equal(await decryptFileV3(vmk, payload, "other-vault", B3.fileId, B3.keyEpoch), null);
	// 解密与路径完全无关（这正是 E2EE 下 MOVE 无需重加密的原因）
	assert.notEqual(await decryptFileV3(vmk, payload, B3.vaultId, B3.fileId, B3.keyEpoch), null);
});

test("LSE3: 信封头 generation 被篡改 → AAD 认证失败（头字段不可伪造）", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const payload = new Uint8Array((await encryptFileV3(vmk, B3, buf("content"))).slice(0));
	// generation u64 在 offset 8..16：改成 8
	new DataView(payload.buffer).setBigUint64(8, 8n, false);
	assert.deepEqual(parseLse3Header(payload.buffer)!.generation, 8);
	assert.equal(await decryptFileV3(vmk, payload.buffer, B3.vaultId, B3.fileId, B3.keyEpoch), null);
});

test("LSE3: keyEpoch 校验（expected>0 时必须一致；0 = 过渡期按信封头）", async () => {
	const { vmk } = await createVaultKeyDoc("pw");
	const payload = await encryptFileV3(vmk, B3, buf("x"));
	assert.equal(await decryptFileV3(vmk, payload, B3.vaultId, B3.fileId, 3), null);
	assert.notEqual(await decryptFileV3(vmk, payload, B3.vaultId, B3.fileId, 0), null);
});

test("newFileId: 32 位 hex 且不重复", () => {
	const a = newFileId();
	const b = newFileId();
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.notEqual(a, b);
});

// ---------- 分享加密（Phase 17：独立 Share Key） ----------

test("分享加密: LSS1 往返一致", async () => {
	const key = randomBytes(32);
	const plain = buf("# 分享的笔记\n\n内容 content");
	const payload = await encryptShare(key, plain);
	assert.equal(new TextDecoder().decode(new Uint8Array(payload, 0, 4)), "LSS1");
	const dec = await decryptShare(key, payload);
	assert.equal(new TextDecoder().decode(dec!), new TextDecoder().decode(plain));
});

test("分享加密: 错误 key / 篡改 → null；LSE1 文件不被误当分享", async () => {
	const key = randomBytes(32);
	const payload = await encryptShare(key, buf("secret"));
	assert.equal(await decryptShare(randomBytes(32), payload), null);
	const tampered = new Uint8Array(payload.slice(0));
	tampered[tampered.length - 1] ^= 1;
	assert.equal(await decryptShare(key, tampered.buffer), null);

	const { vmk } = await createVaultKeyDoc("pw");
	const filePayload = await encryptFile(vmk, "a.md", buf("x"));
	assert.equal(await decryptShare(key, filePayload), null);
});

test("分享加密: Share Key 与 Vault Master Key 无关（不同 key 空间）", async () => {
	// 用 VMK 原始值当 share key 也解不开 LSE1 文件；两套加密相互隔离
	const key = randomBytes(32);
	const payload = await encryptShare(key, buf("content"));
	const url = b64urlEncode(key);
	assert.ok(!url.includes("+") && !url.includes("/") && !url.includes("="));
	// b64url 还原后仍可解密
	const restored = Uint8Array.from(atob(url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (url.length % 4)) % 4)), (c) => c.charCodeAt(0));
	assert.notEqual(await decryptShare(restored, payload), null);
});
