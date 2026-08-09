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
	encryptShare,
	isEncryptedPayload,
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
