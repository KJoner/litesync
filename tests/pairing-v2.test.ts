// v0.20 指定仓库配对 v2（ADR-014，验收 PR-01…PR-05 的客户端部分）。
//
// 覆盖：
//   打开链接只读 envelope、绝不消费；旧服务器（无 v2 端点）明确识别为 legacy，而不是悄悄消费
//   导入校验：链接服务器与包内服务器不同源 → 拒绝；不认识的必需能力 → 拒绝（不回落默认仓库）
//   兑换：exchangeId 在发请求之前落盘；网络中断保留并以同一 exchangeId 重试（含「重启」后）；
//     服务端返回的仓库与核对过的不一致 → 不用这份凭据；明确拒绝码清除暂存
//   发行：verified_transfer 只在本机持有与当前 repoEpoch 一致的已验证锚时出现，否则 first_trust；
//     包里没有长期 Token
//   信任锚：接入之前核验（0.20.1 / 复审 PL-06），通过才在接入完成时采纳；仓库身份或 repoEpoch 不吻合 → 停止，
//     暂存保留给用户选择重新配对或显式改为首次信任（不再静默降级）
//
// INV: INV-10（凭据/仓库变化必须重新绑定——导入新连接后本设备回到待接入）/ INV-05（仓库身份以服务端为准）
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PairingEnvelopeResult, RedeemRequest, RedeemResult } from "../src/api/client";
import { completeBootstrap, InheritedTrustRejectedError, PreflightResult } from "../src/bootstrap/bootstrap-manager";
import { CheckpointBody, generateSigningKey, importSigningPrivateKey, SignedCheckpoint, signCheckpoint } from "../src/crypto/checkpoint";
import { verifyInheritedTrust } from "../src/sync/checkpoint-sync";
import type { SecretStore } from "../src/crypto/device-trust";
import { b64urlEncode } from "../src/crypto/crypto";
import { encryptPairingConfig, newPairSecret, PairingConfig } from "../src/pairing/pairing";
import {
	anchorFromConfig,
	buildIssuedConfig,
	describeTrust,
	loadPendingRedeem,
	openLegacyLink,
	openPairingLink,
	PairingLink,
	PairingTransport,
	PENDING_REDEEM_SECRET_ID,
	redeemPairing,
	unknownCapabilities,
	validateConfig,
} from "../src/pairing/pairing-v2";
import { StateStore } from "../src/state/store";
import type { SyncContext } from "../src/sync/context";
import type { TrustAnchor } from "../src/sync/freshness";

const SERVER = "https://sync.example.com";
const VAULT = { vaultId: "u-1a2b3c4d", vaultIdentity: "f".repeat(32), displayName: "个人笔记" };

class MemSecrets implements SecretStore {
	map = new Map<string, string>();
	getSecret(id: string): string | null {
		return this.map.get(id) ?? null;
	}
	setSecret(id: string, value: string): void {
		this.map.set(id, value);
	}
}

function anchor(repoEpoch = "epoch-1"): TrustAnchor {
	return {
		repoEpoch,
		checkpointHash: "c".repeat(64),
		headSequence: 120,
		devicePublicKeys: { "device-old": "PUBKEY" },
		revokedDevices: [],
		updatedAt: 1,
	};
}

function issued(a: TrustAnchor | null = anchor(), epoch: string | undefined = "epoch-1"): PairingConfig {
	return buildIssuedConfig({
		serverUrl: SERVER,
		enrollmentSecret: "e".repeat(64),
		vault: VAULT,
		accountLabel: "示例用户",
		protocolVersion: 6,
		sync: { syncIntervalSeconds: 30, syncObsidian: false, ignorePatterns: ".trash/**" },
		anchor: a,
		currentRepoEpoch: epoch,
	});
}

/** 记录每一次网络调用的传输层替身。 */
class FakeTransport implements PairingTransport {
	calls: string[] = [];
	envelope: PairingEnvelopeResult = { kind: "unsupported" };
	legacyCiphertext: string | null = null;
	redeemQueue: RedeemResult[] = [];
	redeemRequests: RedeemRequest[] = [];
	/** redeem 被调用那一刻，暂存记录是否已经落盘 */
	pendingAtRedeem: Array<string | null> = [];
	constructor(private secrets?: MemSecrets) {}
	async fetchEnvelope(): Promise<PairingEnvelopeResult> {
		this.calls.push("envelope");
		return this.envelope;
	}
	async redeem(_s: string, req: RedeemRequest): Promise<RedeemResult> {
		this.calls.push("redeem");
		this.redeemRequests.push(req);
		this.pendingAtRedeem.push(this.secrets?.getSecret(PENDING_REDEEM_SECRET_ID) ?? null);
		return this.redeemQueue.shift() ?? { kind: "network", message: "down" };
	}
	async consumeLegacy(): Promise<string | null> {
		this.calls.push("consume");
		return this.legacyCiphertext;
	}
	async enrollLegacy(): Promise<{ deviceId: string; deviceToken: string }> {
		this.calls.push("enroll");
		return { deviceId: "d", deviceToken: "t" };
	}
}

async function linkFor(config: PairingConfig, t: FakeTransport): Promise<PairingLink> {
	const secret = newPairSecret();
	const ciphertext = await encryptPairingConfig(secret, config);
	t.envelope = { kind: "ok", ciphertext, expiresAt: Math.floor(Date.now() / 1000) + 300, state: "issued" };
	t.legacyCiphertext = ciphertext;
	return { serverUrl: SERVER, id: "0123456789abcdef0123456789abcdef", secretB64url: b64urlEncode(secret) };
}

const OK: RedeemResult = {
	kind: "ok",
	deviceId: "device-new",
	vaultId: VAULT.vaultId,
	vaultIdentity: VAULT.vaultIdentity,
	scopes: "sync,share,key-admin,pairing",
	deviceCredential: "lsd_REDACTED_TEST",
};

// ---------- 打开链接：不消费 ----------

test("PR-03：打开链接只读 envelope，不消费；解密后可核对仓库与账号", async () => {
	const t = new FakeTransport();
	const link = await linkFor(issued(), t);
	const r = await openPairingLink(t, link);
	assert.equal(r.kind, "ready");
	assert.deepEqual(t.calls, ["envelope"], "没有任何消费或兑换调用");
	if (r.kind !== "ready") return;
	assert.deepEqual(r.config.selectedVault, VAULT);
	assert.equal(r.config.accountLabel, "示例用户");
	// 重复打开（刷新落地页 / 预览扫描）同样不消费
	await openPairingLink(t, link);
	assert.deepEqual(t.calls, ["envelope", "envelope"]);
});

test("旧服务器（v2 端点 401）→ legacy-server，等待用户确认服务器后才消费", async () => {
	const t = new FakeTransport();
	const link = await linkFor(issued(), t);
	t.envelope = { kind: "unsupported" };
	const r = await openPairingLink(t, link);
	assert.equal(r.kind, "legacy-server");
	assert.deepEqual(t.calls, ["envelope"], "确认之前不消费");
	const legacy = await openLegacyLink(t, link);
	assert.equal(legacy.kind, "ready");
	assert.deepEqual(t.calls, ["envelope", "consume"]);
});

test("链接失效：envelope 404/410 → gone，带服务端拒绝码", async () => {
	const t = new FakeTransport();
	t.envelope = { kind: "gone", code: "PAIRING_EXPIRED" };
	const r = await openPairingLink(t, { serverUrl: SERVER, id: "ab", secretB64url: "AA" });
	assert.deepEqual(r, { kind: "gone", code: "PAIRING_EXPIRED" });
});

test("密钥不对（链接被截断/篡改）→ invalid，不兑换", async () => {
	const t = new FakeTransport();
	const link = await linkFor(issued(), t);
	const r = await openPairingLink(t, { ...link, secretB64url: b64urlEncode(newPairSecret()) });
	assert.equal(r.kind, "invalid");
	assert.ok(!t.calls.includes("redeem"));
});

// ---------- 导入校验 ----------

test("PR-05：链接服务器与包内服务器不同源 → 拒绝导入", async () => {
	const cfg = { ...issued(), serverUrl: "https://evil.example.net" };
	const r = validateConfig(cfg, { serverUrl: SERVER, id: "x", secretB64url: "y" });
	assert.equal(r.ok, false);
});

test("PR-05：不认识的必需能力 → 拒绝导入并提示升级（绝不回落默认仓库或旧根 Token）", async () => {
	const cfg = { ...issued(), requiredCapabilities: ["vault-bound-pairing", "redeem-v2", "future-thing"] };
	assert.deepEqual(unknownCapabilities(cfg), ["future-thing"]);
	const r = validateConfig(cfg, { serverUrl: SERVER, id: "x", secretB64url: "y" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /升级/);
});

test("非本机 http:// 的配置一律拒绝", () => {
	const cfg = { ...issued(), serverUrl: "http://sync.example.com" };
	assert.equal(validateConfig(cfg, { serverUrl: "http://sync.example.com", id: "x", secretB64url: "y" }).ok, false);
	const local = { ...issued(), serverUrl: "http://127.0.0.1:8080" };
	assert.equal(validateConfig(local, { serverUrl: "http://127.0.0.1:8080", id: "x", secretB64url: "y" }).ok, true);
});

// ---------- 兑换：先落盘、可续传、核对仓库 ----------

test("PR-04：exchangeId 在发请求之前落盘；断网保留，重试复用同一 exchangeId（含重启后）", async () => {
	const secrets = new MemSecrets();
	const t = new FakeTransport(secrets);
	const link = await linkFor(issued(), t);
	const input = { link, config: issued(), deviceName: "我的手机", platform: "ios", clientVersion: "0.20.0", now: 1000 };

	t.redeemQueue = [{ kind: "network", message: "timeout" }];
	const first = await redeemPairing(t, secrets, input);
	assert.equal(first.kind, "retry");
	assert.ok(t.pendingAtRedeem[0], "发请求时暂存记录已经在 SecretStorage 里");
	const pending = loadPendingRedeem(secrets);
	assert.ok(pending, "断网后暂存记录保留");
	const exchangeId = t.redeemRequests[0].exchangeId;
	assert.match(exchangeId, /^[0-9a-f]{32}$/);
	assert.equal(t.redeemRequests[0].expectedVaultId, VAULT.vaultId);

	// 「重启」：同一个 SecretStorage，新的调用
	t.redeemQueue = [OK];
	const second = await redeemPairing(t, secrets, { ...input, now: 2000 });
	assert.equal(second.kind, "ok");
	assert.equal(t.redeemRequests[1].exchangeId, exchangeId, "同一个 exchangeId，服务端返回同一份结果");
	if (second.kind === "ok") {
		assert.equal(second.vaultId, VAULT.vaultId);
		assert.equal(second.credential, OK.kind === "ok" ? OK.deviceCredential : "");
	}
});

test("服务端返回的仓库与核对过的不一致 → 不使用这份凭据，暂存清除", async () => {
	const secrets = new MemSecrets();
	const t = new FakeTransport(secrets);
	const link = await linkFor(issued(), t);
	t.redeemQueue = [{ ...(OK as Extract<RedeemResult, { kind: "ok" }>), vaultId: "u-someone-else" }];
	const r = await redeemPairing(t, secrets, {
		link,
		config: issued(),
		deviceName: "x",
		platform: "windows",
		clientVersion: "0.20.0",
		now: 1,
	});
	assert.equal(r.kind, "failed");
	if (r.kind === "failed") assert.equal(r.code, "MISMATCH_RESPONSE");
	assert.equal(loadPendingRedeem(secrets), null);
});

test("PR-02：明确拒绝（已用/过期/撤销/仓库不符）→ failed，暂存清除，给出下一步", async () => {
	for (const code of ["PAIRING_USED", "PAIRING_EXPIRED", "PAIRING_REVOKED", "VAULT_MISMATCH"]) {
		const secrets = new MemSecrets();
		const t = new FakeTransport(secrets);
		const link = await linkFor(issued(), t);
		t.redeemQueue = [{ kind: "rejected", status: code === "VAULT_MISMATCH" ? 409 : 410, code }];
		const r = await redeemPairing(t, secrets, {
			link,
			config: issued(),
			deviceName: "x",
			platform: "windows",
			clientVersion: "0.20.0",
			now: 1,
		});
		assert.equal(r.kind, "failed", code);
		if (r.kind === "failed") assert.ok(r.message.length > 0);
		assert.equal(loadPendingRedeem(secrets), null, code);
	}
});

test("不同的链接不会误用上一条的暂存 exchangeId", async () => {
	const secrets = new MemSecrets();
	const t = new FakeTransport(secrets);
	const link = await linkFor(issued(), t);
	t.redeemQueue = [{ kind: "network", message: "down" }];
	await redeemPairing(t, secrets, { link, config: issued(), deviceName: "x", platform: "ios", clientVersion: "v", now: 1 });
	const other = { ...link, id: "ffffffffffffffffffffffffffffffff" };
	t.redeemQueue = [OK];
	await redeemPairing(t, secrets, { link: other, config: issued(), deviceName: "x", platform: "ios", clientVersion: "v", now: 2 });
	assert.notEqual(t.redeemRequests[0].exchangeId, t.redeemRequests[1].exchangeId);
});

// ---------- 发行 ----------

test("发行：本机持有与当前 repoEpoch 一致的已验证锚 → verified_transfer；否则 first_trust", () => {
	const verified = issued(anchor("epoch-1"), "epoch-1");
	assert.equal(verified.trust?.mode, "verified_transfer");
	assert.equal(verified.trust?.checkpointHash, "c".repeat(64));
	assert.match(describeTrust(verified), /已验证/);
	assert.ok(anchorFromConfig(verified));

	const noAnchor = issued(null, "epoch-1");
	assert.deepEqual(noAnchor.trust, { mode: "first_trust" });
	assert.match(describeTrust(noAnchor), /首次信任/);
	assert.equal(anchorFromConfig(noAnchor), null);

	const staleEpoch = issued(anchor("epoch-OLD"), "epoch-2");
	assert.deepEqual(staleEpoch.trust, { mode: "first_trust" }, "锚属于灾备恢复之前的世代 → 不能当已验证");
});

test("发行：包里只有一次性注册凭据，没有长期 Token；声明必需能力与仓库", () => {
	const cfg = issued();
	assert.equal(cfg.v, 2);
	assert.equal(cfg.apiToken, undefined);
	assert.ok(cfg.enrollmentSecret);
	assert.deepEqual(cfg.requiredCapabilities, ["vault-bound-pairing", "redeem-v2"]);
	assert.deepEqual(cfg.selectedVault, VAULT);
	assert.equal(JSON.stringify(cfg).includes("lsk_"), false);
});

test("导入端：残缺的 verified_transfer 锚一律当首次信任", () => {
	const cfg = issued();
	cfg.trust = { mode: "verified_transfer", repoEpoch: "epoch-1" }; // 缺 checkpointHash 等
	assert.equal(anchorFromConfig(cfg), null);
	assert.match(describeTrust(cfg), /首次信任/);
});

// ---------- 信任锚的采纳时机（0.20.1 起：接入之前核验，核验通过才采纳；对不上就停止，不再静默降级） ----------

function memAdapter() {
	const files = new Map<string, string>();
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

/** 发行设备在 head 120 上签过一份 checkpoint；配对包继承的正是它。 */
async function signedAnchor(repoEpoch = "epoch-1") {
	const key = await generateSigningKey();
	const priv = await importSigningPrivateKey(key.privateKeyPkcs8B64);
	const body: CheckpointBody = {
		version: 1,
		vaultId: VAULT.vaultIdentity,
		repoEpoch,
		formatEpoch: 1,
		keyEpoch: 1,
		headSequence: 120,
		objectsRoot: "0".repeat(64),
		objectCount: 0,
		previousCheckpointHash: "",
		signingDeviceId: "device-old",
		timestamp: 1,
	};
	const cp = await signCheckpoint(priv, body);
	return { cp, pub: key.publicKeyB64 };
}

async function ctxWithPending(vaultIdentity: string, epoch: string, served: SignedCheckpoint[], pub: string, hash: string): Promise<SyncContext> {
	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	store.state.deviceId = "device-new";
	store.state.pendingPairingTrust = {
		vaultIdentity,
		anchor: { repoEpoch: epoch, checkpointHash: hash, headSequence: 120, devicePublicKeys: { "device-old": pub } },
		receivedAt: 1,
	};
	return {
		store,
		client: {
			checkpoints: async () => ({ repoEpoch: epoch, checkpoints: served, conflicting: [], signingKeys: {}, revokedDevices: [] }),
		},
		log: () => {},
		deviceSigningPublicKey: () => "MY-PUB",
	} as unknown as SyncContext;
}

function pre(vaultId: string, repoEpoch: string): PreflightResult {
	return {
		info: { version: "t", latestSequence: 130, serverTime: 0, vaultId, repoEpoch, keyEpoch: 1 },
		snapshotSequence: 130,
		repoEpoch,
		remoteFiles: [],
		localPaths: [],
		commonCount: 0,
		e2eeEnabled: true,
	};
}

test("信任锚：接入之前核验通过（仓库身份、repoEpoch、水位、锚检查点签名都对得上）→ 接入完成时采纳，并把本设备加入信任集合", async () => {
	const { cp, pub } = await signedAnchor();
	const ctx = await ctxWithPending(VAULT.vaultIdentity, "epoch-1", [cp], pub, cp.hash);
	const verdict = await verifyInheritedTrust(ctx, { vaultId: VAULT.vaultIdentity, repoEpoch: "epoch-1", headSequence: 130 });
	assert.equal(verdict.kind, "verified");
	completeBootstrap(ctx, { ...pre(VAULT.vaultIdentity, "epoch-1"), inheritedTrust: verdict }, "merge");
	const a = ctx.store.state.trustAnchor;
	assert.ok(a);
	assert.equal(a.headSequence, 120);
	assert.equal(a.devicePublicKeys["device-new"], "MY-PUB");
	assert.equal(ctx.store.state.pendingPairingTrust, null, "用完即清");
});

test("信任锚：仓库身份或 repoEpoch 不吻合 → 停止（不再静默按首次信任完成接入），暂存保留给用户选择", async () => {
	const { cp, pub } = await signedAnchor();
	const ctx = await ctxWithPending(VAULT.vaultIdentity, "epoch-1", [cp], pub, cp.hash);
	const wrongVault = await verifyInheritedTrust(ctx, { vaultId: "0".repeat(32), repoEpoch: "epoch-1", headSequence: 130 });
	assert.equal(wrongVault.kind === "rejected" && wrongVault.reason, "vault-mismatch");
	assert.throws(
		() => completeBootstrap(ctx, { ...pre("0".repeat(32), "epoch-1"), inheritedTrust: wrongVault }, "merge"),
		(e: unknown) => e instanceof InheritedTrustRejectedError && e.reason === "vault-mismatch",
	);
	assert.equal(ctx.store.state.trustAnchor, null);
	assert.ok(ctx.store.state.pendingPairingTrust, "暂存保留：重新配对或用户明确改为首次信任");
	assert.equal(ctx.store.bootstrapReady, false, "接入没有完成");

	const epochChanged = await verifyInheritedTrust(ctx, { vaultId: VAULT.vaultIdentity, repoEpoch: "epoch-2", headSequence: 130 });
	assert.equal(epochChanged.kind === "rejected" && epochChanged.reason, "epoch-mismatch", "灾备恢复之后的世代不能沿用旧锚");

	// 未核验就想完成接入：同样拒绝
	assert.throws(() => completeBootstrap(ctx, pre(VAULT.vaultIdentity, "epoch-1"), "merge"), InheritedTrustRejectedError);
});
