// Trusted Device 设备包装单元测试（v3.1）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVaultKeyDoc, exportVmkRaw, importVmk, randomBytes } from "../src/crypto/crypto";
import { unwrapVmkForDevice, wrapVmkForDevice } from "../src/crypto/device-trust";

test("设备包装: 往返一致", async () => {
	const deviceKey = randomBytes(32);
	const vmk = randomBytes(32);
	const blob = await wrapVmkForDevice(deviceKey, vmk, "key-id-1");
	// blob 是 JSON 字符串，不含明文 VMK
	assert.ok(!blob.includes(Buffer.from(vmk).toString("base64")));
	const out = await unwrapVmkForDevice(deviceKey, blob, "key-id-1");
	assert.deepEqual(out, vmk);
});

test("设备包装: 错误设备密钥无法解开", async () => {
	const blob = await wrapVmkForDevice(randomBytes(32), randomBytes(32), "kid");
	assert.equal(await unwrapVmkForDevice(randomBytes(32), blob, "kid"), null);
});

test("设备包装: keyId 失配（服务器密钥轮换）自动失效", async () => {
	const deviceKey = randomBytes(32);
	const blob = await wrapVmkForDevice(deviceKey, randomBytes(32), "old-key-id");
	assert.equal(await unwrapVmkForDevice(deviceKey, blob, "new-key-id"), null);
});

test("设备包装: 数据被篡改 → null", async () => {
	const deviceKey = randomBytes(32);
	const blob = await wrapVmkForDevice(deviceKey, randomBytes(32), "kid");
	const parsed = JSON.parse(blob);
	const bytes = Buffer.from(parsed.data, "base64");
	bytes[0] ^= 0xff;
	parsed.data = bytes.toString("base64");
	assert.equal(await unwrapVmkForDevice(deviceKey, JSON.stringify(parsed), "kid"), null);
	// 非法 JSON 同样安全返回 null
	assert.equal(await unwrapVmkForDevice(deviceKey, "not json", "kid"), null);
});

test("VMK 可导出用于设备包装（extractable 往返）", async () => {
	const { vmk } = await createVaultKeyDoc("password-for-trust");
	const raw = await exportVmkRaw(vmk);
	assert.equal(raw.length, 32);
	// 重新导入后仍是等价密钥：包装/解包能对上
	const key2 = await importVmk(raw);
	const raw2 = await exportVmkRaw(key2);
	assert.deepEqual(raw2, raw);
});
