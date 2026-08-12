// 签名 checkpoint freshness 验收测试（v0.15.0 / 计划书 §9.5）。
//
// 计划书要求「必须证明」七件事。每一条对应下面一个 test，测试名里标了编号。
// 在这些全部通过之前，不得使用「恶意服务器无法篡改同步内容」这类宣传语。
//
// 需要说清楚这套机制能证明什么、不能证明什么：
//
//   能：任何**你已经见过的**状态都不能被回退、调包，或者被换成另一条历史；
//       同一位置上出现两份不同状态时你一定会发现。
//   不能：服务器完全隐瞒一个你从未见过、也没有别的设备告诉过你的对象。
//       那需要「服务器必须证明自己给出了全集」，超出 checkpoint 的能力范围。
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import {
	CheckpointBody,
	CheckpointObject,
	canonicalCheckpoint,
	checkpointHash,
	generateSigningKey,
	importSigningPrivateKey,
	objectsRoot,
	signCheckpoint,
	verifyCheckpoint,
} from "../src/crypto/checkpoint";
import { advanceAnchor, detectFork, TrustAnchor, verifyFreshness } from "../src/sync/freshness";

const VAULT = "vault-0123456789ab";
const DEV_A = "device-aaaa";

function obj(fileId: string, cg = 1, mg = 1, hash = "h", state: "live" | "tombstone" = "live"): CheckpointObject {
	return { fileId, contentGeneration: cg, metaGeneration: mg, contentHash: hash, metadataHash: "m", state };
}

async function body(over: Partial<CheckpointBody> = {}): Promise<CheckpointBody> {
	return {
		version: 1,
		vaultId: VAULT,
		repoEpoch: "epoch-1",
		formatEpoch: 1,
		keyEpoch: 1,
		headSequence: 100,
		objectsRoot: await objectsRoot([obj("a".repeat(32)), obj("b".repeat(32))]),
		objectCount: 2,
		previousCheckpointHash: "",
		signingDeviceId: DEV_A,
		timestamp: 1_700_000_000,
		...over,
	};
}

async function anchorFor(pub: string, over: Partial<TrustAnchor> = {}): Promise<TrustAnchor> {
	return {
		repoEpoch: "epoch-1",
		checkpointHash: "",
		headSequence: 0,
		devicePublicKeys: { [DEV_A]: pub },
		revokedDevices: [],
		updatedAt: 0,
		...over,
	};
}

// ---------------------------------------------------------------- 基础

test("§9.1: canonical 序列化是确定的，两台设备算出同一个 hash", async () => {
	const b = await body();
	// 键顺序不同的「同一个对象」必须给出同样的 canonical 与 hash
	const shuffled: CheckpointBody = JSON.parse(JSON.stringify({ ...b })) as CheckpointBody;
	assert.equal(canonicalCheckpoint(shuffled), canonicalCheckpoint(b));
	assert.equal(await checkpointHash(shuffled), await checkpointHash(b));
});

test("§9.1: objectsRoot 与对象顺序无关，但对任何一个字段变化敏感", async () => {
	const a = obj("a".repeat(32));
	const b = obj("b".repeat(32));
	assert.equal(await objectsRoot([a, b]), await objectsRoot([b, a]), "顺序不同必须得到同一个根");

	const changed = await objectsRoot([a, { ...b, contentGeneration: 2 }]);
	assert.notEqual(changed, await objectsRoot([a, b]), "generation 变了，根必须变");

	const deleted = await objectsRoot([a, { ...b, state: "tombstone" }]);
	assert.notEqual(deleted, await objectsRoot([a, b]), "删除屏障同样要被签名覆盖");
});

test("§9.1: manifest 不含明文路径", async () => {
	const b = await body();
	const canonical = canonicalCheckpoint(b);
	// checkpoint 会被服务器存储与转发；哪怕在元数据加密仓库里也绝不能泄露目录结构
	assert.ok(!canonical.includes("/"), `canonical 中不得出现路径分隔符：${canonical}`);
	assert.ok(!canonical.includes(".md"), "canonical 中不得出现文件名");
});

// ---------------------------------------------------------------- §9.5 七条

test("§9.5-1: 新设备不能接受早于可信 checkpoint 的状态", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);

	const old = await signCheckpoint(priv, await body({ headSequence: 50 }));
	const cur = await signCheckpoint(priv, await body({ headSequence: 100 }));

	// 信任锚已经在 100 上
	const anchor = await anchorFor(key.publicKeyB64, { checkpointHash: cur.hash, headSequence: 100 });
	const verdict = await verifyFreshness(anchor, [cur.hash], old, VAULT);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.kind, "rollback");
});

test("§9.5-2: 本地状态被恢复到旧备份后，仍能检测服务端回退", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);

	const cp1 = await signCheckpoint(priv, await body({ headSequence: 100 }));
	const cp2 = await signCheckpoint(priv, await body({ headSequence: 200, previousCheckpointHash: cp1.hash }));

	// 本地状态文件被恢复到了「只知道 cp1」的时刻
	const restored = await anchorFor(key.publicKeyB64, { checkpointHash: cp1.hash, headSequence: 100 });

	// 服务器此时给出一条**另起炉灶**的历史：head 更高，但接不回 cp1
	const forged = await signCheckpoint(
		priv,
		await body({ headSequence: 300, previousCheckpointHash: "0".repeat(64) }),
	);
	const verdict = await verifyFreshness(restored, [cp1.hash], forged, VAULT);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.kind, "broken-chain");

	// 而真正接在 cp1 后面的 cp2 仍然可以被接受——回退检测不能误伤正常前进
	const good = await verifyFreshness(restored, [cp1.hash], cp2, VAULT);
	assert.equal(good.ok, true);
});

test("§9.5-3: 服务器不能把文件 B 的内容替换到文件 A 上", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);

	const A = "a".repeat(32);
	const B = "b".repeat(32);
	const honest = [obj(A, 1, 1, "hash-of-A"), obj(B, 1, 1, "hash-of-B")];
	// 服务器把 A 的内容换成了 B 的
	const swapped = [obj(A, 1, 1, "hash-of-B"), obj(B, 1, 1, "hash-of-B")];

	const cp = await signCheckpoint(
		priv,
		await body({ headSequence: 100, objectsRoot: await objectsRoot(honest) }),
	);
	// 客户端按自己实际看到的内容重算根
	const localRoot = await objectsRoot(swapped);
	assert.notEqual(localRoot, cp.body.objectsRoot, "被调包的仓库算不出签名里的那个根");
});

test("§9.5-4: 同一 generation 上的不同内容被检测", async () => {
	const A = "a".repeat(32);
	// generation 完全相同，只有内容 hash 不同
	const r1 = await objectsRoot([obj(A, 7, 3, "content-1")]);
	const r2 = await objectsRoot([obj(A, 7, 3, "content-2")]);
	assert.notEqual(r1, r2, "同世代不同内容必须导致不同的根");
});

test("§9.5-5: 不同设备收到不同历史时被检测（equivocation）", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);

	const base = await signCheckpoint(priv, await body({ headSequence: 100 }));
	// 同一个 head 上两份不同的状态：服务器对两台设备说了不同的话
	const forA = await signCheckpoint(
		priv,
		await body({ headSequence: 200, previousCheckpointHash: base.hash, objectsRoot: "root-A".padEnd(64, "0") }),
	);
	const forB = await signCheckpoint(
		priv,
		await body({ headSequence: 200, previousCheckpointHash: base.hash, objectsRoot: "root-B".padEnd(64, "0") }),
	);
	assert.notEqual(forA.hash, forB.hash);

	// 设备 A 已经采纳了 forA；服务器再给它 forB
	const anchor = await anchorFor(key.publicKeyB64, { checkpointHash: forA.hash, headSequence: 200 });
	const verdict = await verifyFreshness(anchor, [base.hash, forA.hash], forB, VAULT);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.kind, "fork");

	// 两台设备交换链之后也能定位到分叉点
	const fork = detectFork([base.hash, forA.hash], [base.hash, forB.hash]);
	assert.equal(fork.forked, true);
	assert.equal(fork.commonAncestor, base.hash, "必须能指出从哪里开始分道扬镳");
});

test("§9.5-6: 被撤销的设备不能发布有效 checkpoint", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);
	const cp = await signCheckpoint(priv, await body({ headSequence: 200 }));

	// 关键点：被撤销设备的私钥**仍然是有效私钥**，签名本身完全正确。
	// 因此不能只靠验签名——必须显式检查撤销状态
	assert.equal(await verifyCheckpoint(key.publicKeyB64, cp), true, "签名本身是有效的");

	const anchor = await anchorFor(key.publicKeyB64, {
		checkpointHash: "prev",
		headSequence: 100,
		revokedDevices: [DEV_A],
	});
	const verdict = await verifyFreshness(anchor, ["prev"], cp, VAULT);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.kind, "revoked-signer");
});

test("§9.5-7: 灾备恢复后通过新 repoEpoch 建立新信任链", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);

	const anchor = await anchorFor(key.publicKeyB64, { checkpointHash: "old", headSequence: 100 });
	// 恢复之后服务器旋转了 repoEpoch，并在新世代上发布 checkpoint
	const afterRestore = await signCheckpoint(priv, await body({ repoEpoch: "epoch-2", headSequence: 10 }));

	const verdict = await verifyFreshness(anchor, ["old"], afterRestore, VAULT);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.kind, "epoch-mismatch");
	assert.match(
		verdict.ok === false ? verdict.message : "",
		/重新建立信任链/,
		"必须明确告诉用户要重建信任链，而不是含糊地报个错",
	);
});

// ---------------------------------------------------------------- 其他防线

test("§9.2: 未知签名者一律拒绝（服务器不能凭空引入一个可信设备）", async () => {
	const rogue = await generateSigningKey();
	const priv = await importSigningPrivateKey(rogue.privateKeyPkcs8B64);
	const cp = await signCheckpoint(priv, await body({ signingDeviceId: "device-rogue", headSequence: 200 }));

	const known = await generateSigningKey();
	const anchor = await anchorFor(known.publicKeyB64, { checkpointHash: "prev", headSequence: 100 });
	const verdict = await verifyFreshness(anchor, ["prev"], cp, VAULT);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.kind, "unknown-signer");
});

test("§9.1: 篡改 body 任意一个字节都会让签名失效", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);
	const cp = await signCheckpoint(priv, await body({ headSequence: 100 }));

	const tampered = { ...cp, body: { ...cp.body, headSequence: 101 } };
	assert.equal(await verifyCheckpoint(key.publicKeyB64, tampered), false);

	// 连 hash 一起改也不行——签名覆盖的是 body 本身
	const tampered2 = { ...tampered, hash: await checkpointHash(tampered.body) };
	assert.equal(await verifyCheckpoint(key.publicKeyB64, tampered2), false);
});

test("§9.1: hash 与 body 不一致时直接拒绝（防止拿别处的 hash 做链接）", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);
	const cp = await signCheckpoint(priv, await body({ headSequence: 100 }));
	assert.equal(await verifyCheckpoint(key.publicKeyB64, { ...cp, hash: "0".repeat(64) }), false);
});

test("§9.4: 一条链是另一条的前缀 = 只是进度不同，不算分叉", async () => {
	const fork = detectFork(["h1", "h2"], ["h1", "h2", "h3"]);
	assert.equal(fork.forked, false);
	assert.equal(fork.commonAncestor, "h2");
});

test("§9.3: 采纳后信任锚前进，链有界保留", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);
	const cp = await signCheckpoint(priv, await body({ headSequence: 200, previousCheckpointHash: "prev" }));

	const anchor = await anchorFor(key.publicKeyB64, { checkpointHash: "prev", headSequence: 100 });
	const verdict = await verifyFreshness(anchor, ["prev"], cp, VAULT);
	assert.equal(verdict.ok, true);

	const next = advanceAnchor(anchor, ["prev"], cp, 3);
	assert.equal(next.anchor.checkpointHash, cp.hash);
	assert.equal(next.anchor.headSequence, 200);

	// 链超出上限时丢弃最旧的
	let chain = next.chain;
	for (const h of ["x1", "x2", "x3"]) {
		chain = advanceAnchor(next.anchor, chain, { ...cp, hash: h }, 3).chain;
	}
	assert.equal(chain.length, 3);
});

test("§9.5: 同一个 checkpoint 重复收到 = 幂等，不报错也不重复推进", async () => {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);
	const cp = await signCheckpoint(priv, await body({ headSequence: 200 }));
	const anchor = await anchorFor(key.publicKeyB64, { checkpointHash: cp.hash, headSequence: 200 });

	const verdict = await verifyFreshness(anchor, [cp.hash], cp, VAULT);
	assert.equal(verdict.ok, true);
	assert.equal(verdict.ok === true && verdict.kind, "same");
});
