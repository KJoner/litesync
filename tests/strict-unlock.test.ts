// v0.20 严格会话解锁与旧「信任此设备」迁移（ADR-013，验收 KY-01 / KY-02）。
//
// 覆盖：
//   策略迁移：新安装默认严格；旧材料完整 → legacy_trust_found（本次运行仍可自动解锁）；
//     半套材料（还原不出 VMK）直接清掉；重复执行幂等
//   分支 a：密码解开服务端 keyDoc，与信任材料解出的 VMK 逐字节相同才算证明；
//     错密码 / 服务端换了另一把 VMK / 离线无缓存 —— 一律停在原状态、材料原样保留
//   分支 b：忘记密码 → 同一把 VMK 以新密码重包装（绝不重新生成）→ CAS → 重新下载试解；
//     文档已被他人更换 / CAS 冲突 / 试解失败 —— 不清理，且本设备安全网（自动解锁材料）不断
//   先证明后清理：证明之前的任何清理调用都被拒；clearing 中途崩溃重入幂等
//   严格模式终态：data.json 与 SecretStorage 中不再有可自动还原 VMK 的材料
//
// INV: INV-11（迁移可恢复、可重复、幂等）/ INV-09（状态不健康不清理）
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	b64encode,
	createVaultKeyDoc,
	decryptFileV3,
	encryptFileV3,
	exportVmkRaw,
	randomBytes,
	unlockVaultKey,
	VaultKeyDoc,
} from "../src/crypto/crypto";
import { keyIdOf, SecretStore, unwrapVmkForDevice, VAULT_KEY_SECRET_ID, wrapVmkForDevice } from "../src/crypto/device-trust";
import {
	advanceAfterProof,
	applyKeyPolicy,
	bytesEqualConstantTime,
	clearLegacyMaterial,
	handlePendingWrites,
	keepLegacyTrust,
	KEY_POLICY_VERSION,
	keyPolicyLabel,
	migrationPending,
	persistenceExplicit,
	proveByPassword,
	proveByRewrap,
	TrustMigrationDeps,
	TrustSettings,
} from "../src/crypto/trust-migration";

const PASSWORD = "correct horse battery";

class MemSecrets implements SecretStore {
	map = new Map<string, string>();
	getSecret(id: string): string | null {
		return this.map.get(id) ?? null;
	}
	setSecret(id: string, value: string): void {
		this.map.set(id, value);
	}
}

function fingerprintOf(doc: VaultKeyDoc): string {
	return JSON.stringify(doc).length + ":" + doc.wrappedKey.slice(0, 16);
}

/** 模拟服务器上的 vault-key 文档（CAS 语义与真实服务端一致：指纹不符 412）。 */
class FakeServer {
	online = true;
	replaced = 0;
	/** 测试注入：下一次 fetch 返回这份（模拟「重新下载拿到的不是刚上传的」） */
	nextFetchOverride: VaultKeyDoc | null = null;
	constructor(public doc: VaultKeyDoc | null) {}
	async fetch(): Promise<{ doc: VaultKeyDoc; fingerprint: string } | null> {
		if (!this.online) throw new Error("network down");
		if (this.nextFetchOverride) {
			const d = this.nextFetchOverride;
			this.nextFetchOverride = null;
			return { doc: d, fingerprint: fingerprintOf(d) };
		}
		return this.doc ? { doc: this.doc, fingerprint: fingerprintOf(this.doc) } : null;
	}
	async replace(doc: VaultKeyDoc, fp: string): Promise<void> {
		if (!this.online) throw new Error("network down");
		if (!this.doc || fingerprintOf(this.doc) !== fp) throw Object.assign(new Error("cas"), { status: 412 });
		this.doc = doc;
		this.replaced++;
	}
}

interface Fixture {
	settings: TrustSettings;
	secrets: MemSecrets;
	server: FakeServer;
	vmkRaw: Uint8Array;
	doc: VaultKeyDoc;
	deps: TrustMigrationDeps;
	saves: number;
	queue: { count: number; durable: boolean };
	replacedDocs: VaultKeyDoc[];
	/** 用原始 VMK 加密的一条密文：重包装后必须仍能用新密码解开的 VMK 解密 */
	sample: { cipher: ArrayBuffer; binding: { vaultId: string; keyEpoch: number; fileId: string; generation: number } };
}

async function legacyFixture(): Promise<Fixture> {
	const { doc, vmk } = await createVaultKeyDoc(PASSWORD);
	doc.enabled = true;
	const vmkRaw = await exportVmkRaw(vmk);
	const deviceKey = randomBytes(32);
	const secrets = new MemSecrets();
	secrets.setSecret(VAULT_KEY_SECRET_ID, await wrapVmkForDevice(deviceKey, vmkRaw, keyIdOf(doc)));
	const settings: TrustSettings = { trustDevice: true, deviceKeyB64: b64encode(deviceKey) };
	const binding = { vaultId: "a".repeat(32), keyEpoch: 1, fileId: "f".repeat(32), generation: 1 };
	const cipher = await encryptFileV3(vmk, binding, new TextEncoder().encode("hello").buffer);
	const fx: Fixture = {
		settings,
		secrets,
		server: new FakeServer(doc),
		vmkRaw,
		doc,
		saves: 0,
		queue: { count: 0, durable: true },
		replacedDocs: [],
		sample: { cipher, binding },
		deps: undefined as unknown as TrustMigrationDeps,
	};
	fx.deps = {
		settings,
		saveSettings: async () => {
			fx.saves++;
		},
		secrets,
		fetchKeyDoc: () => fx.server.fetch(),
		replaceKeyDoc: (d, fp) => fx.server.replace(d, fp),
		cachedKeyDoc: () => doc,
		onKeyDocReplaced: async (d) => {
			fx.replacedDocs.push(d);
		},
		pendingWrites: async () => fx.queue,
		now: () => 1_700_000_000_000,
	};
	applyKeyPolicy(settings, secrets, { vaultIdentity: "a".repeat(32), now: 1 });
	return fx;
}

/** 当前 SecretStorage + data.json 里的材料能否还原出原始 VMK（与 loadTrustedVmk 同一判定：按当前服务端文档 keyId）。 */
async function materialRestores(fx: Fixture, doc: VaultKeyDoc): Promise<boolean> {
	const blob = fx.secrets.getSecret(VAULT_KEY_SECRET_ID);
	if (!blob || !fx.settings.deviceKeyB64) return false;
	const raw = await unwrapVmkForDevice(
		Uint8Array.from(atob(fx.settings.deviceKeyB64), (c) => c.charCodeAt(0)),
		blob,
		keyIdOf(doc),
	);
	return raw !== null && bytesEqualConstantTime(raw, fx.vmkRaw);
}

// ---------- 策略迁移 ----------

test("KY-01：新安装默认严格会话解锁，不产生任何迁移记录", () => {
	const s: TrustSettings = { trustDevice: false, deviceKeyB64: "" };
	const changed = applyKeyPolicy(s, new MemSecrets(), { vaultIdentity: "", now: 1 });
	assert.equal(changed, true);
	assert.equal(s.keyPolicyVersion, KEY_POLICY_VERSION);
	assert.equal(s.trustDevice, false);
	assert.equal(s.trustMigration, null);
	assert.equal(migrationPending(s), false);
	assert.match(keyPolicyLabel(s), /严格会话解锁/);
	assert.equal(applyKeyPolicy(s, new MemSecrets(), { vaultIdentity: "", now: 2 }), false, "幂等：第二次不动");
});

test("KY-02：旧材料完整 → legacy_trust_found，本次运行材料原样保留（不打断自动解锁）", async () => {
	const fx = await legacyFixture();
	assert.equal(fx.settings.trustMigration?.state, "legacy_trust_found");
	assert.equal(fx.settings.trustDevice, true, "仍可自动解锁");
	assert.ok(await materialRestores(fx, fx.doc), "材料完好");
	assert.equal(migrationPending(fx.settings), true);
	assert.match(keyPolicyLabel(fx.settings), /旧设备信任待迁移/);
	assert.equal(persistenceExplicit(fx.settings), false, "旧默认开启 ≠ 用户显式选择");
});

test("旧设置开着 trustDevice 但材料不完整（还原不出 VMK）→ 直接严格，不留半套材料", () => {
	const secrets = new MemSecrets();
	const s: TrustSettings = { trustDevice: true, deviceKeyB64: b64encode(randomBytes(32)) };
	applyKeyPolicy(s, secrets, { vaultIdentity: "", now: 1 });
	assert.equal(s.trustDevice, false);
	assert.equal(s.deviceKeyB64, "", "只剩设备密钥的一半被清掉");
	assert.equal(s.trustMigration, null);

	const secrets2 = new MemSecrets();
	secrets2.setSecret(VAULT_KEY_SECRET_ID, JSON.stringify({ v: 1, keyId: "x", iv: "", data: "" }));
	const s2: TrustSettings = { trustDevice: true, deviceKeyB64: "" };
	applyKeyPolicy(s2, secrets2, { vaultIdentity: "", now: 1 });
	assert.equal(secrets2.getSecret(VAULT_KEY_SECRET_ID), "", "只剩包装 blob 的一半被清掉");
});

// ---------- 先证明、后清理 ----------

test("证明之前的任何清理调用都被拒绝，材料原样保留", async () => {
	const fx = await legacyFixture();
	const r = await clearLegacyMaterial(fx.deps);
	assert.equal(r.ok, false);
	assert.ok(await materialRestores(fx, fx.doc));
	const r2 = await handlePendingWrites(fx.deps);
	assert.equal(r2.ok, false);
	assert.equal(fx.settings.trustMigration?.state, "legacy_trust_found");
});

// ---------- 分支 a：输入密码 ----------

test("分支 a：正确密码 → recovery_proven → 一路推进到 strict_mode，终态无任何可自动还原的材料", async () => {
	const fx = await legacyFixture();
	const r = await proveByPassword(fx.deps, PASSWORD);
	assert.deepEqual(r, { ok: true, state: "recovery_proven" });
	assert.equal(fx.settings.trustMigration?.method, "password");
	assert.ok(await materialRestores(fx, fx.doc), "证明本身不动材料");

	const done = await advanceAfterProof(fx.deps);
	assert.deepEqual(done, { ok: true, state: "strict_mode" });
	assert.equal(fx.settings.trustDevice, false);
	assert.equal(fx.settings.deviceKeyB64, "");
	assert.ok(!fx.secrets.getSecret(VAULT_KEY_SECRET_ID));
	assert.equal(migrationPending(fx.settings), false);
	// data.json 快照里没有设备密钥；SecretStorage 里没有包装 VMK
	const persisted = JSON.stringify(fx.settings);
	assert.ok(!/"deviceKeyB64":"[^"]+"/.test(persisted));
	assert.equal(await materialRestores(fx, fx.doc), false);
	// 服务端 keyDoc（密码包装的 VMK）必须保留：严格模式靠它重新解锁
	assert.ok(await unlockVaultKey(fx.server.doc!, PASSWORD));
	assert.equal(fx.server.replaced, 0, "分支 a 不改服务端");
});

test("分支 a：错误密码 → 停在原状态，材料不动", async () => {
	const fx = await legacyFixture();
	const r = await proveByPassword(fx.deps, "wrong password!");
	assert.deepEqual(r, { ok: false, error: "wrong-password" });
	assert.equal(fx.settings.trustMigration?.state, "legacy_trust_found");
	assert.equal(fx.settings.trustMigration?.lastError, "wrong-password");
	assert.ok(await materialRestores(fx, fx.doc));
});

test("分支 a：密码能解开服务端文档，但那是另一把 VMK（服务端已轮换）→ vmk-mismatch，不清理", async () => {
	const fx = await legacyFixture();
	const other = await createVaultKeyDoc(PASSWORD); // 同密码、不同 VMK
	fx.server.doc = other.doc;
	const r = await proveByPassword(fx.deps, PASSWORD);
	assert.deepEqual(r, { ok: false, error: "vmk-mismatch" });
	assert.equal(fx.settings.trustMigration?.state, "legacy_trust_found");
	assert.ok(await materialRestores(fx, fx.doc));
});

test("分支 a：离线时可用本地缓存的 keyDoc 完成；离线且无缓存 → offline", async () => {
	const fx = await legacyFixture();
	fx.server.online = false;
	assert.deepEqual(await proveByPassword(fx.deps, PASSWORD), { ok: true, state: "recovery_proven" });

	const fx2 = await legacyFixture();
	fx2.server.online = false;
	fx2.deps.cachedKeyDoc = () => null;
	assert.deepEqual(await proveByPassword(fx2.deps, PASSWORD), { ok: false, error: "offline" });
	assert.ok(await materialRestores(fx2, fx2.doc));
});

test("旧材料本身已解不开（被篡改）→ 不是恢复来源，按 no-usable-material 允许清理", async () => {
	const fx = await legacyFixture();
	fx.settings.deviceKeyB64 = b64encode(randomBytes(32)); // 设备密钥对不上 → 解不开
	const r = await proveByPassword(fx.deps, "irrelevant");
	assert.deepEqual(r, { ok: true, state: "recovery_proven" });
	assert.equal(fx.settings.trustMigration?.method, "no-usable-material");
});

// ---------- 分支 b：忘记密码，用同一 VMK 设新密码 ----------

test("分支 b：同一把 VMK 以新密码重包装——旧密文仍可解，旧密码失效，VMK 从未重新生成", async () => {
	const fx = await legacyFixture();
	const NEW = "a brand new password";
	const r = await proveByRewrap(fx.deps, NEW);
	assert.deepEqual(r, { ok: true, state: "recovery_proven" });
	assert.equal(fx.settings.trustMigration?.method, "rewrap");
	assert.equal(fx.server.replaced, 1);
	const serverDoc = fx.server.doc!;
	assert.notEqual(serverDoc.wrappedKey, fx.doc.wrappedKey, "包装已更换");
	assert.notEqual(serverDoc.salt, fx.doc.salt, "新盐");
	assert.equal(serverDoc.createdAt, fx.doc.createdAt, "VMK 的创建时间沿用（不是新 VMK）");

	const key = await unlockVaultKey(serverDoc, NEW);
	assert.ok(key, "新密码能解开");
	assert.ok(bytesEqualConstantTime(await exportVmkRaw(key), fx.vmkRaw), "得到的是同一把 VMK");
	const b = fx.sample.binding;
	const dec = await decryptFileV3(key, fx.sample.cipher, b.vaultId, b.fileId, b.keyEpoch);
	assert.equal(new TextDecoder().decode(dec!.plain), "hello", "重包装之前写下的密文照常可解");
	assert.equal(await unlockVaultKey(serverDoc, PASSWORD), null, "旧密码不再能解开新文档");

	// 安全网：材料已按新文档的 keyId 重绑，证明完成前本设备仍能自动解锁
	assert.ok(await materialRestores(fx, serverDoc));
	assert.equal(fx.replacedDocs.length, 1, "本地缓存与密钥环收到新文档");
});

test("分支 b：服务端文档已被他人更换（keyId 不符）→ doc-changed，不上传任何东西", async () => {
	const fx = await legacyFixture();
	const other = await createVaultKeyDoc("someone else's");
	fx.server.doc = other.doc;
	const r = await proveByRewrap(fx.deps, "new password!!");
	assert.deepEqual(r, { ok: false, error: "doc-changed" });
	assert.equal(fx.server.replaced, 0);
	assert.ok(await materialRestores(fx, fx.doc));
});

test("分支 b：CAS 冲突 → cas-conflict，服务端与本地材料都不变", async () => {
	const fx = await legacyFixture();
	fx.deps.replaceKeyDoc = async () => {
		throw Object.assign(new Error("precondition failed"), { status: 412 });
	};
	const r = await proveByRewrap(fx.deps, "new password!!");
	assert.deepEqual(r, { ok: false, error: "cas-conflict" });
	assert.equal(fx.server.doc, fx.doc);
	assert.ok(await materialRestores(fx, fx.doc));
	assert.equal(fx.settings.trustMigration?.state, "legacy_trust_found");
});

test("分支 b：上传后重新下载试解失败 → verify-failed，不进入清理，安全网仍可用", async () => {
	const fx = await legacyFixture();
	const decoy = await createVaultKeyDoc("decoy password");
	// 第一次 fetch（取当前文档）正常；第二次（试解）被换成另一份
	let calls = 0;
	const realFetch = fx.deps.fetchKeyDoc;
	fx.deps.fetchKeyDoc = async () => {
		calls++;
		if (calls === 2) return { doc: decoy.doc, fingerprint: "x" };
		return realFetch();
	};
	const r = await proveByRewrap(fx.deps, "new password!!");
	assert.deepEqual(r, { ok: false, error: "verify-failed" });
	assert.equal(fx.settings.trustMigration?.state, "legacy_trust_found");
	assert.ok(await materialRestores(fx, fx.server.doc!), "材料已重绑到上传成功的那份文档，仍能自动解锁");
	assert.equal((await clearLegacyMaterial(fx.deps)).ok, false, "未证明不得清理");
});

test("分支 b：离线 → offline（重包装必须在线），材料不动", async () => {
	const fx = await legacyFixture();
	fx.server.online = false;
	assert.deepEqual(await proveByRewrap(fx.deps, "new password!!"), { ok: false, error: "offline" });
	assert.ok(await materialRestores(fx, fx.doc));
});

// ---------- 待同步修改与清理 ----------

test("待推送队列未确认持久化 → pending-writes，不清理；持久化后放行", async () => {
	const fx = await legacyFixture();
	await proveByPassword(fx.deps, PASSWORD);
	fx.queue = { count: 3, durable: false };
	assert.deepEqual(await advanceAfterProof(fx.deps), { ok: false, error: "pending-writes" });
	assert.ok(await materialRestores(fx, fx.doc));
	fx.queue = { count: 3, durable: true };
	assert.deepEqual(await advanceAfterProof(fx.deps), { ok: true, state: "strict_mode" });
});

test("drainQueue 抛错不影响判定（离线时队列留在 journal 里同样安全）", async () => {
	const fx = await legacyFixture();
	await proveByPassword(fx.deps, PASSWORD);
	fx.deps.drainQueue = async () => {
		throw new Error("offline");
	};
	fx.queue = { count: 2, durable: true };
	assert.deepEqual(await handlePendingWrites(fx.deps), { ok: true, state: "pending_writes_handled" });
});

test("clearing 中途崩溃：标记已落盘，重启重入幂等完成", async () => {
	const fx = await legacyFixture();
	await proveByPassword(fx.deps, PASSWORD);
	await handlePendingWrites(fx.deps);
	// data.json 只反映「最后一次成功落盘」：第一次保存（写 clearing 标记）成功，
	// 第二次（写 strict_mode）时进程崩溃——内存里的修改随进程一起消失
	let persisted = JSON.stringify(fx.settings);
	let n = 0;
	fx.deps.saveSettings = async () => {
		n++;
		if (n === 2) throw new Error("crash");
		persisted = JSON.stringify(fx.settings);
	};
	await assert.rejects(clearLegacyMaterial(fx.deps));

	// 「重启」：从磁盘重新加载设置
	const reloaded = JSON.parse(persisted) as TrustSettings;
	assert.equal(reloaded.trustMigration?.state, "clearing", "崩溃前 clearing 已落盘");
	const deps2: TrustMigrationDeps = { ...fx.deps, settings: reloaded, saveSettings: async () => {} };
	assert.deepEqual(await clearLegacyMaterial(deps2), { ok: true, state: "strict_mode" });
	assert.equal(reloaded.deviceKeyB64, "", "重入把磁盘上残留的设备密钥也清掉");
	assert.equal(reloaded.trustDevice, false);
	assert.ok(!fx.secrets.getSecret(VAULT_KEY_SECRET_ID));
	assert.deepEqual(await clearLegacyMaterial(deps2), { ok: false, error: "invalid-state" }, "终态再清是非法转换");
});

test("用户显式保留自动解锁 → user_kept（可恢复密钥持久化模式），材料保留", async () => {
	const fx = await legacyFixture();
	assert.deepEqual(await keepLegacyTrust(fx.deps), { ok: true, state: "user_kept" });
	assert.equal(persistenceExplicit(fx.settings), true);
	assert.equal(migrationPending(fx.settings), false);
	assert.match(keyPolicyLabel(fx.settings), /你选择了可恢复密钥持久化/);
	assert.ok(await materialRestores(fx, fx.doc));
});

test("常量时间比较：长度不同直接不等；内容逐字节比较", () => {
	assert.equal(bytesEqualConstantTime(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
	assert.equal(bytesEqualConstantTime(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
	assert.equal(bytesEqualConstantTime(new Uint8Array([1]), new Uint8Array([1, 2])), false);
});
