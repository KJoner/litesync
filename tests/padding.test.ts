import assert from "node:assert/strict";
import test from "node:test";

import {
	createVaultKeyDoc,
	decryptFileV3,
	decryptFileV4,
	encryptFileV3,
	encryptFileV4,
	isLse3Envelope,
	isLse4Envelope,
	LSE4_FLAG_PADDED,
	newFileId,
	parseLse4Header,
} from "../src/crypto/crypto";
import {
	bucketSize,
	frame,
	FRAME_HEADER_LEN,
	MIN_BUCKET,
	paddingOverhead,
	unframe,
} from "../src/crypto/padding";

// 大小混淆（v0.17 / 计划书 §11.1）。
//
// 要证明的是三件事：桶把精确大小压成了区间、填充在密文里面（服务器看不到也改不了）、
// 以及旧信封仍然读得出来。第三件最容易被忽略——一个隐私增强如果顺手让存量数据
// 读不出来了，那就不是增强。

const VAULT_ID = "vault-pad";

test("§11.1: 桶把精确大小压成区间，且最坏开销不超过 12.5%", () => {
	// 下限：所有小对象落到同一个观测值。一个 200 字节的笔记和一个 3KB 的笔记
	// 在服务器眼里必须一模一样
	for (const n of [0, 1, 200, 1024, 4095, 4096]) {
		assert.equal(bucketSize(n), MIN_BUCKET, `${n} 应当落到下限桶`);
	}

	// 单调不减：桶不能随着输入变大而变小
	let prev = 0;
	for (let n = 1; n < 1 << 22; n = Math.ceil(n * 1.07) + 1) {
		const b = bucketSize(n);
		assert.ok(b >= n, `桶 ${b} 必须不小于输入 ${n}`);
		assert.ok(b >= prev, `桶必须单调不减（${prev} → ${b}）`);
		prev = b;
	}

	// 开销上界：这是这套方案能不能被接受的关键数字，必须钉死
	for (let n = MIN_BUCKET + 1; n < 1 << 24; n = Math.ceil(n * 1.013) + 1) {
		const overhead = bucketSize(n) / n - 1;
		assert.ok(overhead <= 0.125 + 1e-9, `${n} 字节的开销 ${overhead} 超过 12.5%`);
	}
});

test("§11.1: 同一个桶覆盖足够宽的区间（混淆确实发生了）", () => {
	// 1MB 附近的桶宽应当是 128KB：十几万种精确大小被压成同一个观测值
	const b = bucketSize(1_100_000);
	let lo = 1_100_000;
	while (lo > MIN_BUCKET && bucketSize(lo - 1) === b) lo--;
	assert.ok(b - lo > 100_000, `1MB 附近的桶只覆盖了 ${b - lo} 字节，混淆太弱`);
});

test("§11.1: 帧能无损还原任意内容，包括空文件与全零内容", () => {
	for (const bytes of [
		new Uint8Array(0),
		new Uint8Array([0, 0, 0, 0, 0]),
		new TextEncoder().encode("普通笔记内容"),
		new Uint8Array(70_000).fill(0xab),
	]) {
		for (const padded of [false, true]) {
			const framed = frame(bytes.buffer as ArrayBuffer, padded);
			if (padded) {
				assert.equal(framed.byteLength, bucketSize(bytes.byteLength + FRAME_HEADER_LEN));
			}
			const back = unframe(framed);
			assert.ok(back !== null, "帧必须能还原");
			assert.deepEqual(new Uint8Array(back), bytes, "还原后必须逐字节相同");
		}
	}
});

test("§11.1: 全零内容不会被误当成填充截断", () => {
	// 这是这类实现最经典的 bug：用「末尾的零」判断填充边界，
	// 于是一个以零结尾的二进制附件会被截短。真实长度必须显式记录
	const bytes = new Uint8Array(5000); // 全零
	const framed = frame(bytes.buffer as ArrayBuffer, true);
	const back = unframe(framed);
	assert.ok(back !== null);
	assert.equal(back.byteLength, 5000, "全零内容的长度必须原样保留");
});

test("§11.1: 损坏的帧返回 null 而不是抛异常", () => {
	assert.equal(unframe(new Uint8Array(3).buffer as ArrayBuffer), null, "太短的帧");
	// 长度字段声称的比实际长
	const bad = new Uint8Array(FRAME_HEADER_LEN + 4);
	new DataView(bad.buffer).setBigUint64(0, 999n, false);
	assert.equal(unframe(bad.buffer as ArrayBuffer), null, "长度越界的帧");
});

test("§11.1: LSE4 往返正确，且服务器只看得到桶大小", async () => {
	const { vmk } = await createVaultKeyDoc("pw-pad");
	const fileId = newFileId();
	const binding = { vaultId: VAULT_ID, keyEpoch: 1, fileId, generation: 1 };

	// 两份大小差很多、但落在同一个桶里的内容
	const small = new Uint8Array(300).fill(1);
	const large = new Uint8Array(3800).fill(2);
	assert.equal(bucketSize(small.byteLength + FRAME_HEADER_LEN), bucketSize(large.byteLength + FRAME_HEADER_LEN));

	const a = await encryptFileV4(vmk, binding, small.buffer as ArrayBuffer, true);
	const b = await encryptFileV4(vmk, binding, large.buffer as ArrayBuffer, true);
	assert.equal(a.byteLength, b.byteLength, "同桶的两份内容在服务器眼里必须一样大");

	// 而且确实还原得回来
	const da = await decryptFileV4(vmk, a, VAULT_ID, fileId, 1);
	const dbb = await decryptFileV4(vmk, b, VAULT_ID, fileId, 1);
	assert.ok(da && dbb);
	assert.deepEqual(new Uint8Array(da.plain), small);
	assert.deepEqual(new Uint8Array(dbb.plain), large);
	assert.equal(da.generation, 1);
});

test("§11.1: padded 标志位经过 AAD 认证，服务器改不了", async () => {
	const { vmk } = await createVaultKeyDoc("pw-pad");
	const fileId = newFileId();
	const binding = { vaultId: VAULT_ID, keyEpoch: 1, fileId, generation: 3 };
	const payload = await encryptFileV4(vmk, binding, new TextEncoder().encode("secret").buffer as ArrayBuffer, true);

	const header = parseLse4Header(payload);
	assert.ok(header);
	assert.equal(header.flags & LSE4_FLAG_PADDED, LSE4_FLAG_PADDED, "应当标记为已填充");

	// 恶意服务器把 padded 位抹掉，想让客户端把填充当内容
	const tampered = payload.slice(0);
	new Uint8Array(tampered)[4] = 0;
	assert.equal(
		await decryptFileV4(vmk, tampered, VAULT_ID, fileId, 1),
		null,
		"改动 flags 必须导致认证失败",
	);
});

test("§11.1: LSE3 与 LSE4 的 AAD 空间不相交（换版本号骗不过认证）", async () => {
	const { vmk } = await createVaultKeyDoc("pw-pad");
	const fileId = newFileId();
	const binding = { vaultId: VAULT_ID, keyEpoch: 1, fileId, generation: 1 };
	const plain = new TextEncoder().encode("同一份内容").buffer as ArrayBuffer;

	const v3 = await encryptFileV3(vmk, binding, plain);
	const v4 = await encryptFileV4(vmk, binding, plain, false);

	assert.ok(isLse3Envelope(v3) && !isLse4Envelope(v3));
	assert.ok(isLse4Envelope(v4) && !isLse3Envelope(v4));
	// 拿 v4 的解密器读 v3 密文（反之亦然）必须失败，而不是读出乱码
	assert.equal(await decryptFileV4(vmk, v3, VAULT_ID, fileId, 1), null);
	assert.equal(await decryptFileV3(vmk, v4, VAULT_ID, fileId, 1), null);
});

test("§11.1: 开启填充不影响存量 LSE3 的可读性", async () => {
	const { vmk } = await createVaultKeyDoc("pw-pad");
	const fileId = newFileId();
	const binding = { vaultId: VAULT_ID, keyEpoch: 1, fileId, generation: 7 };
	const plain = new TextEncoder().encode("迁移前就写好的内容").buffer as ArrayBuffer;

	const legacy = await encryptFileV3(vmk, binding, plain);
	const dec = await decryptFileV3(vmk, legacy, VAULT_ID, fileId, 1);
	assert.ok(dec, "存量 LSE3 必须仍然读得出来——隐私增强不能让老数据失效");
	assert.deepEqual(new Uint8Array(dec.plain), new Uint8Array(plain));
	assert.equal(dec.generation, 7);
});

test("§11.1: 成本估算与文档口径一致", () => {
	// 设置页写的是「最坏 12.5%」和「小于 4KB 按 4KB 计」，这两句必须为真
	assert.ok(paddingOverhead(1_000_000) <= 0.125 + 1e-9);
	assert.equal(bucketSize(200 + FRAME_HEADER_LEN), 4096);
	// 一个 200 字节的笔记确实会占 4KB —— 说明书里承诺的成本
	assert.ok(paddingOverhead(200) > 19, "小文件的相对开销很大，这一点必须如实说明");
});
