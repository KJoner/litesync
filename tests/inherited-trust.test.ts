// 0.20.1 复审 PL-06（批次 R-B / RB-3）：配对继承的可信锚在**首次接入之前**核验（ADR-014 §5.1）。
//
// 原问题：completeBootstrap 在内容落地之后才采纳锚；preflight / 执行器不看继承的 headSequence，
// 比可信锚更旧的快照照样写进本地；身份或 epoch 不符时只记日志就静默降为首次信任；
// 每轮同步的链校验在服务器返回空 checkpoint 列表时直接通过。
//
// 覆盖（verifyInheritedTrust 的每一条判据，以及端到端的「核验之前什么都不写」）：
//   无继承锚 → none；空链（锚检查点不在了）→ 拒绝；旧服务端（无 checkpoint 接口）→ 拒绝；
//   回退水位（服务器 head 低于锚）→ 拒绝且不请求 checkpoint；epoch 变化 / 仓库身份不符 → 拒绝；
//   合法延伸（锚 → cp2 → cp3）→ 通过并前进到 cp3；伪造的锚检查点、断链、未知签名设备、同位置分叉、
//   已签名检查点超出服务器自称的 head → 拒绝；创世锚（发行时没有已签名检查点）→ 只核验之后的链；
//   端到端：被拒时三种执行器都不写本地、不写远端，游标不动、锚不采纳、暂存保留；
//     用户显式改为首次信任之后才按首次信任接入；每轮链校验在空列表下也能判出 head 回退。
//
// INV: INV-03（无法确认安全时不覆盖本地）/ INV-04（核验未过不推进游标）/ INV-09（可信状态被违背时停机）/ INV-10（仓库身份与 epoch 变化必须重新建立信任）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { ApiError } from "../src/api/client";
import {
	bootstrapLocalInit,
	bootstrapMerge,
	bootstrapRemoteWins,
	completeBootstrap,
	discardInheritedTrust,
	InheritedTrustRejectedError,
	preflight,
} from "../src/bootstrap/bootstrap-manager";
import {
	CheckpointBody,
	generateSigningKey,
	importSigningPrivateKey,
	SignedCheckpoint,
	signCheckpoint,
} from "../src/crypto/checkpoint";
import { createVaultKeyDoc, encryptFileV3, newFileId } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import type { SyncContext } from "../src/sync/context";
import { verifyCheckpointChain, verifyInheritedTrust } from "../src/sync/checkpoint-sync";
import { sha256Hex } from "../src/utils/hash";
import { enc, FakeServer, makeCtx, MemVault } from "./fakes/replace-server";

const VAULT = "a".repeat(32);
const EPOCH = "epoch-1";

interface Signer {
	id: string;
	pub: string;
	priv: CryptoKey;
}

async function signer(id: string): Promise<Signer> {
	const k = await generateSigningKey();
	return { id, pub: k.publicKeyB64, priv: await importSigningPrivateKey(k.privateKeyPkcs8B64) };
}

async function cpAt(s: Signer, head: number, prev: string, over: Partial<CheckpointBody> = {}): Promise<SignedCheckpoint> {
	return signCheckpoint(s.priv, {
		version: 1,
		vaultId: VAULT,
		repoEpoch: EPOCH,
		formatEpoch: 1,
		keyEpoch: 1,
		headSequence: head,
		objectsRoot: "0".repeat(64),
		objectCount: 0,
		previousCheckpointHash: prev,
		signingDeviceId: s.id,
		timestamp: head,
		...over,
	});
}

/** 一个只带 store 与可控 checkpoint 接口的上下文。 */
async function trustCtx(opts: {
	anchor: { checkpointHash: string; headSequence: number; keys: Record<string, string>; repoEpoch?: string };
	served?: SignedCheckpoint[];
	conflicting?: SignedCheckpoint[];
	checkpointsError?: unknown;
}) {
	const server = new FakeServer();
	const vault = new MemVault();
	const ctx = await makeCtx(server, vault, new Keyring(), { bootstrap: "pending" });
	ctx.store.state.pendingPairingTrust = {
		vaultIdentity: VAULT,
		anchor: {
			repoEpoch: opts.anchor.repoEpoch ?? EPOCH,
			checkpointHash: opts.anchor.checkpointHash,
			headSequence: opts.anchor.headSequence,
			devicePublicKeys: opts.anchor.keys,
		},
		receivedAt: 7,
	};
	const calls: number[] = [];
	(ctx.client as unknown as { checkpoints: (since: number) => Promise<unknown> }).checkpoints = async (since: number) => {
		calls.push(since);
		if (opts.checkpointsError) throw opts.checkpointsError;
		return { repoEpoch: EPOCH, checkpoints: opts.served ?? [], conflicting: opts.conflicting ?? [], signingKeys: {}, revokedDevices: [] };
	};
	return { ctx, calls };
}

const server130 = { vaultId: VAULT, repoEpoch: EPOCH, headSequence: 130 };

function reason(v: Awaited<ReturnType<typeof verifyInheritedTrust>>): string {
	return v.kind === "rejected" ? v.reason : v.kind;
}

// ---------- 判据 ----------

test("没有继承锚 → none（首次信任 / 新仓库，界面如实说明）", async () => {
	const { ctx } = await trustCtx({ anchor: { checkpointHash: "x", headSequence: 1, keys: {} } });
	ctx.store.state.pendingPairingTrust = null;
	assert.deepEqual(await verifyInheritedTrust(ctx, server130), { kind: "none" });
});

test("空链：服务器上找不到发行设备确认过的锚检查点 → anchor-missing", async () => {
	const old = await signer("device-old");
	const anchorCp = await cpAt(old, 120, "");
	const { ctx, calls } = await trustCtx({ anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys: { "device-old": old.pub } }, served: [] });
	assert.equal(reason(await verifyInheritedTrust(ctx, server130)), "anchor-missing");
	assert.deepEqual(calls, [119], "从锚的前一位开始取（since 是开区间），这样锚本身也在结果里");
});

test("旧服务端（没有签名 checkpoint 接口）→ unsupported-server，不当作「验证通过」", async () => {
	const old = await signer("device-old");
	const anchorCp = await cpAt(old, 120, "");
	const { ctx } = await trustCtx({
		anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys: { "device-old": old.pub } },
		checkpointsError: new ApiError(404, "not found"),
	});
	assert.equal(reason(await verifyInheritedTrust(ctx, server130)), "unsupported-server");
});

test("回退水位：服务器 head 低于继承的检查点 → rollback，而且根本不需要服务器交出 checkpoint", async () => {
	const old = await signer("device-old");
	const anchorCp = await cpAt(old, 120, "");
	const { ctx, calls } = await trustCtx({ anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys: { "device-old": old.pub } }, served: [anchorCp] });
	assert.equal(reason(await verifyInheritedTrust(ctx, { ...server130, headSequence: 1 })), "rollback");
	assert.deepEqual(calls, []);
});

test("epoch 变化 / 仓库身份不符 → 拒绝（锚描述的不是眼前这个仓库世代）", async () => {
	const old = await signer("device-old");
	const anchorCp = await cpAt(old, 120, "");
	const { ctx } = await trustCtx({ anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys: { "device-old": old.pub } }, served: [anchorCp] });
	assert.equal(reason(await verifyInheritedTrust(ctx, { ...server130, repoEpoch: "epoch-2" })), "epoch-mismatch");
	assert.equal(reason(await verifyInheritedTrust(ctx, { ...server130, vaultId: "b".repeat(32) })), "vault-mismatch");
});

test("合法延伸：锚 → cp2 → cp3 全部签名有效、链相连 → 通过，并前进到 cp3", async () => {
	const old = await signer("device-old");
	const anchorCp = await cpAt(old, 120, "");
	const cp2 = await cpAt(old, 125, anchorCp.hash);
	const cp3 = await cpAt(old, 128, cp2.hash);
	const { ctx } = await trustCtx({
		anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys: { "device-old": old.pub } },
		served: [anchorCp, cp2, cp3],
	});
	const v = await verifyInheritedTrust(ctx, server130);
	assert.equal(v.kind, "verified");
	if (v.kind !== "verified") return;
	assert.equal(v.verifiedHead, 128);
	assert.equal(v.extended, 2);
	assert.deepEqual(v.chain, [anchorCp.hash, cp2.hash, cp3.hash]);
	assert.equal(v.receivedAt, 7);
});

test("伪造的锚检查点（hash 冒名、内容被改）/ 断链 / 未知签名设备 / 同位置分叉 → 一律拒绝", async () => {
	const old = await signer("device-old");
	const stranger = await signer("device-stranger");
	const anchorCp = await cpAt(old, 120, "");
	const keys = { "device-old": old.pub };

	const forged = { ...anchorCp, body: { ...anchorCp.body, objectCount: 99 } };
	let t = await trustCtx({ anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys }, served: [forged] });
	assert.equal(reason(await verifyInheritedTrust(t.ctx, server130)), "bad-signature");

	const broken = await cpAt(old, 126, "0".repeat(64));
	t = await trustCtx({ anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys }, served: [anchorCp, broken] });
	assert.equal(reason(await verifyInheritedTrust(t.ctx, server130)), "broken-chain");

	const unknown = await cpAt(stranger, 126, anchorCp.hash);
	t = await trustCtx({ anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys }, served: [anchorCp, unknown] });
	assert.equal(reason(await verifyInheritedTrust(t.ctx, server130)), "unknown-signer");

	const a = await cpAt(old, 127, anchorCp.hash, { objectsRoot: "a".repeat(64) });
	const b = await cpAt(old, 127, anchorCp.hash, { objectsRoot: "b".repeat(64) });
	t = await trustCtx({ anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys }, served: [anchorCp], conflicting: [a, b] });
	assert.equal(reason(await verifyInheritedTrust(t.ctx, server130)), "fork");
});

test("服务器交出的已签名检查点超出它自称的 head → rollback（状态被回退了）", async () => {
	const old = await signer("device-old");
	const anchorCp = await cpAt(old, 120, "");
	const cp2 = await cpAt(old, 140, anchorCp.hash);
	const { ctx } = await trustCtx({ anchor: { checkpointHash: anchorCp.hash, headSequence: 120, keys: { "device-old": old.pub } }, served: [anchorCp, cp2] });
	assert.equal(reason(await verifyInheritedTrust(ctx, server130)), "rollback");
});

test("创世锚（发行时还没有已签名检查点）：空列表通过；之后的第一份 checkpoint（previous 为空）作为合法延伸被接受", async () => {
	const old = await signer("device-old");
	let t = await trustCtx({ anchor: { checkpointHash: "", headSequence: 0, keys: { "device-old": old.pub } }, served: [] });
	assert.equal((await verifyInheritedTrust(t.ctx, server130)).kind, "verified");
	const first = await cpAt(old, 50, "");
	t = await trustCtx({ anchor: { checkpointHash: "", headSequence: 0, keys: { "device-old": old.pub } }, served: [first] });
	const v = await verifyInheritedTrust(t.ctx, server130);
	assert.equal(v.kind, "verified");
	assert.equal(v.kind === "verified" && v.verifiedHead, 50);
});

// ---------- 端到端：核验之前什么都不写 ----------

async function staleServerWorld() {
	const server = new FakeServer();
	const vault = new MemVault();
	const { doc, vmk } = await createVaultKeyDoc("password");
	doc.enabled = true;
	const kr = new Keyring();
	kr.adopt(doc, vmk);
	const ctx = await makeCtx(server, vault, kr, { bootstrap: "pending" });
	const id = newFileId();
	const raw = await encryptFileV3(vmk, { vaultId: server.vaultId, keyEpoch: 1, fileId: id, generation: 1 }, enc("stale content"));
	server.seq = 1;
	server.heads.set("note.md", { fileId: id, revision: 1, data: raw, hash: await sha256Hex(raw), deleted: false, generation: 1, metaGeneration: 0, canonical: "note.md" });
	ctx.store.state.pendingPairingTrust = {
		vaultIdentity: server.vaultId,
		anchor: { repoEpoch: server.repoEpoch, checkpointHash: "c".repeat(64), headSequence: 120, devicePublicKeys: { old: "PUB" } },
		receivedAt: 1,
	};
	let checks = 0;
	(ctx.client as unknown as { checkpoints: () => Promise<unknown> }).checkpoints = async () => {
		checks++;
		return { repoEpoch: server.repoEpoch, checkpoints: [], conflicting: [], signingKeys: {}, revokedDevices: [] };
	};
	let commits = 0;
	(ctx as unknown as { committer: unknown }).committer = {
		commitRemoteChange: async (r: { realPath: string; incoming: ArrayBuffer }) => {
			commits++;
			vault.files.set(r.realPath, r.incoming);
			return { status: "committed" };
		},
	};
	return { server, vault, ctx, checks: () => checks, commits: () => commits };
}

test("端到端：继承 head 120、服务器只有 head 1 → preflight 判 rollback；三种执行器都不写本地也不写远端，游标与锚都不动", async () => {
	const w = await staleServerWorld();
	const p = await preflight(w.ctx);
	assert.equal(p.inheritedTrust?.kind, "rejected");
	assert.equal(p.inheritedTrust?.kind === "rejected" && p.inheritedTrust.reason, "rollback");
	await assert.rejects(bootstrapRemoteWins(w.ctx, p, () => {}), InheritedTrustRejectedError);
	await assert.rejects(bootstrapMerge(w.ctx, p, () => {}), InheritedTrustRejectedError);
	await assert.rejects(bootstrapLocalInit(w.ctx, p), InheritedTrustRejectedError);
	assert.throws(() => completeBootstrap(w.ctx, p, "merge"), InheritedTrustRejectedError);
	assert.equal(w.vault.files.has("note.md"), false, "旧内容没有写进本地");
	assert.equal(w.commits(), 0);
	assert.equal(w.server.writeRequests().length, 0, "也没有往远端写");
	assert.equal(w.ctx.store.state.lastSequence, 0, "游标没有推进到旧快照");
	assert.equal(w.ctx.store.state.trustAnchor, null);
	assert.equal(w.ctx.store.bootstrapReady, false);
	assert.ok(w.ctx.store.state.pendingPairingTrust, "暂存保留，等用户选择");
});

test("端到端：用户明确选择「改为首次信任」之后，才按首次信任接入（显式降级，不是静默降级）", async () => {
	const w = await staleServerWorld();
	await discardInheritedTrust(w.ctx);
	const p = await preflight(w.ctx);
	assert.deepEqual(p.inheritedTrust, { kind: "none" });
	await bootstrapRemoteWins(w.ctx, p, () => {});
	assert.ok(w.vault.files.has("note.md"));
	assert.equal(w.ctx.store.state.trustAnchor, null, "首次信任：没有继承锚");
	assert.equal(w.ctx.store.bootstrapReady, true);
});

test("每轮同步的链校验：已确认 head 120、服务器 head 回到 1 → 即使 checkpoint 列表为空也判回退并停机", async () => {
	const w = await staleServerWorld();
	w.ctx.store.state.trustAnchor = {
		repoEpoch: w.server.repoEpoch,
		checkpointHash: "c".repeat(64),
		headSequence: 120,
		devicePublicKeys: { old: "PUB" },
		revokedDevices: [],
		updatedAt: 0,
	};
	assert.equal(await verifyCheckpointChain(w.ctx as SyncContext, 1), false);
	assert.equal(w.ctx.gate.sessionBlock()?.reason, "integrity-error");
	assert.equal(w.checks(), 0, "回退本身就是证据，不需要先问服务器要 checkpoint");
	// 服务器水位不低于锚、列表为空：只是没有新检查点，照常通过
	w.ctx.gate.clearIntegrityError();
	assert.equal(await verifyCheckpointChain(w.ctx as SyncContext, 130), true);
});
