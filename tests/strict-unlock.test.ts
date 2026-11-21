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
//   0.20.1（复审 PL-01 / RB-1）重启恢复：服务端已收下新 keyDoc 但响应丢失、SecretStorage 写失败、
//     data.json 落盘在任一步中断——重启后都能沿用同一把 VMK 继续完成证明；证明之前任何时刻
//     都至少有一条可恢复同一 VMK 的路径（旧材料或「服务端文档 + 已知密码」），绝不靠删材料让测试变绿
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
	saveTrustSettingsVerified,
	trustMigrationErrorText,
	trustSettingsPersisted,
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

// ---------- 0.20.1：重启恢复（服务端已收新文档但响应丢失 / SecretStorage 失败 / 落盘中断） ----------

/** 「服务端文档 + 这个密码」能否解出原始 VMK（严格模式下的恢复路径）。 */
async function serverDocRestores(fx: Fixture, password: string): Promise<boolean> {
	const key = fx.server.doc ? await unlockVaultKey(fx.server.doc, password) : null;
	return key !== null && bytesEqualConstantTime(await exportVmkRaw(key), fx.vmkRaw);
}

/** 旧材料按 blob 自己记录的 keyId 还能不能解出原始 VMK（迁移自己用的就是这个判定）。 */
async function blobRestores(fx: Fixture): Promise<boolean> {
	const blob = fx.secrets.getSecret(VAULT_KEY_SECRET_ID);
	if (!blob || !fx.settings.deviceKeyB64) return false;
	const keyId = (JSON.parse(blob) as { keyId: string }).keyId;
	const raw = await unwrapVmkForDevice(Uint8Array.from(atob(fx.settings.deviceKeyB64), (c) => c.charCodeAt(0)), blob, keyId);
	return raw !== null && bytesEqualConstantTime(raw, fx.vmkRaw);
}

test("重启恢复：服务端已收下新 keyDoc 但响应丢失 → 不卡在 doc-changed，重来（同一个或另一个新密码）沿用同一把 VMK", async () => {
	for (const retryPassword of ["a brand new password", "another new password"]) {
		const fx = await legacyFixture();
		const NEW = "a brand new password";
		let lose = true;
		fx.deps.replaceKeyDoc = async (d, fp) => {
			await fx.server.replace(d, fp); // 服务器提交了
			if (lose) {
				lose = false;
				throw new Error("network: response lost"); // 响应丢了
			}
		};
		assert.deepEqual(await proveByRewrap(fx.deps, NEW), { ok: false, error: "offline" });
		assert.equal(fx.server.replaced, 1, "服务器上已经是新包装的文档");
		assert.equal(fx.settings.trustMigration?.state, "legacy_trust_found", "没有证明就没有任何清理");
		assert.ok(await blobRestores(fx), "旧材料原样保留，仍能解出同一把 VMK");
		assert.ok(await serverDocRestores(fx, NEW), "服务器上的新文档包着的也是同一把 VMK");
		assert.ok(fx.settings.trustMigration?.pendingRewrapKeyId, "上传前已落盘「这次要写哪一份」");

		// 重来：服务器上的文档已不是旧材料绑定的那份，但正是自己上次写的那份 → 在它之上 CAS 重包装
		const r = await proveByRewrap(fx.deps, retryPassword);
		assert.deepEqual(r, { ok: true, state: "recovery_proven" }, `重来用「${retryPassword}」`);
		assert.equal(fx.settings.trustMigration?.pendingRewrapKeyId, undefined, "证明完成后清除标记");
		assert.ok(await serverDocRestores(fx, retryPassword), "最终文档用最后一次的密码解出同一把 VMK");
		const key = await unlockVaultKey(fx.server.doc!, retryPassword);
		const b = fx.sample.binding;
		const plain = await decryptFileV3(key!, fx.sample.cipher, b.vaultId, b.fileId, b.keyEpoch);
		assert.equal(new TextDecoder().decode(plain!.plain), "hello", "迁移之前的密文照常可解");
		assert.deepEqual(await advanceAfterProof(fx.deps), { ok: true, state: "strict_mode" });
	}
});

test("重启恢复：别的设备在我们之后又换了文档 → 依然是 doc-changed（标记只认自己写的那一份）", async () => {
	const fx = await legacyFixture();
	let lose = true;
	fx.deps.replaceKeyDoc = async (d, fp) => {
		await fx.server.replace(d, fp);
		if (lose) {
			lose = false;
			throw new Error("network: response lost");
		}
	};
	await proveByRewrap(fx.deps, "a brand new password");
	fx.server.doc = (await createVaultKeyDoc("someone else rotated")).doc;
	assert.deepEqual(await proveByRewrap(fx.deps, "x".repeat(10)), { ok: false, error: "doc-changed" });
	assert.ok(await blobRestores(fx), "本设备的旧材料依然完好");
});

test("重启恢复：重绑时 SecretStorage 写失败 → secret-store-failed，什么都不清理；重启后重来完成证明", async () => {
	const fx = await legacyFixture();
	const NEW = "a brand new password";
	let persisted = JSON.stringify(fx.settings);
	fx.deps.saveSettings = async () => {
		persisted = JSON.stringify(fx.settings);
	};
	const realSet = fx.secrets.setSecret.bind(fx.secrets);
	let failSet = true;
	fx.secrets.setSecret = (id: string, v: string) => {
		if (failSet) {
			failSet = false;
			throw new Error("SecretStorage unavailable");
		}
		realSet(id, v);
	};
	assert.deepEqual(await proveByRewrap(fx.deps, NEW), { ok: false, error: "secret-store-failed" });
	assert.equal(fx.settings.trustMigration?.state, "legacy_trust_found");
	assert.ok(await blobRestores(fx), "旧 blob 原样保留");
	assert.ok(await serverDocRestores(fx, NEW), "服务器上的新文档包着同一把 VMK");

	// 「重启」：设置从磁盘重新读，SecretStorage 照旧（它独立于 data.json）
	const reloaded = JSON.parse(persisted) as TrustSettings;
	const deps2: TrustMigrationDeps = { ...fx.deps, settings: reloaded, saveSettings: async () => {} };
	assert.equal(reloaded.trustMigration?.state, "legacy_trust_found");
	assert.deepEqual(await proveByRewrap(deps2, NEW), { ok: true, state: "recovery_proven" });
	assert.ok(await serverDocRestores(fx, NEW));
});

test("重启恢复：重包装途中 data.json 在任一次落盘处中断 → 重启后重来完成证明；中断前后始终留有恢复同一 VMK 的路径", async () => {
	const NEW = "a brand new password";
	const RETRY = "retry password!!";
	for (let crashAt = 1; crashAt <= 3; crashAt++) {
		const fx = await legacyFixture();
		let persisted = JSON.stringify(fx.settings);
		let n = 0;
		fx.deps.saveSettings = async () => {
			n++;
			if (n === crashAt) throw new Error("crash: process killed while saving data.json");
			persisted = JSON.stringify(fx.settings);
		};
		await assert.rejects(proveByRewrap(fx.deps, NEW), /crash/, `第 ${crashAt} 次落盘处中断`);

		const reloaded = JSON.parse(persisted) as TrustSettings;
		assert.notEqual(reloaded.trustMigration?.state, "strict_mode");
		assert.ok(reloaded.deviceKeyB64, "证明之前绝不清理");
		// 恢复路径：旧材料（按 blob 自己的 keyId）始终能解出同一把 VMK
		const fxReloaded = { ...fx, settings: reloaded };
		assert.ok(await blobRestores(fxReloaded), `中断点 ${crashAt}：本设备材料仍可恢复 VMK`);

		const deps2: TrustMigrationDeps = { ...fx.deps, settings: reloaded, saveSettings: async () => {} };
		const r = await proveByRewrap(deps2, RETRY);
		assert.deepEqual(r, { ok: true, state: "recovery_proven" }, `中断点 ${crashAt}：重启后重来成功`);
		assert.ok(await serverDocRestores(fx, RETRY), `中断点 ${crashAt}：最终文档解出同一把 VMK`);
		assert.deepEqual(await advanceAfterProof(deps2), { ok: true, state: "strict_mode" });
		assert.equal(await blobRestores({ ...fx, settings: reloaded }), false, "证明之后才清理");
	}
});

// ---------- WIN-12 真机验收：宿主 saveData 写失败时不抛错（data.json 只读） ----------

/**
 * 模拟宿主：Obsidian 的 Plugin.saveData → vault.writeJson 里 try{…}catch{} 吞掉写入错误。
 * readOnly 时「写」什么都不做也不报错；读回的是磁盘上最后一次真正写进去的内容。
 */
function hostDisk(fx: Fixture): { readOnly: boolean; persisted: string; disk(): Record<string, unknown> } {
	const h = {
		readOnly: false,
		persisted: JSON.stringify(fx.settings, undefined, 2),
		disk: () => JSON.parse(h.persisted) as Record<string, unknown>,
	};
	fx.deps.saveSettings = () =>
		saveTrustSettingsVerified(
			async () => {
				fx.saves++;
				if (!h.readOnly) h.persisted = JSON.stringify(fx.settings, undefined, 2);
			},
			async () => h.persisted,
			fx.settings,
		);
	return h;
}

test("WIN-12 第 5 步：data.json 只读（宿主静默吞掉写入错误）→ 重包装的意图标记写不进去 → 停在上传之前：服务器文档不变、旧材料完好；恢复可写后重试完成", async () => {
	const fx = await legacyFixture();
	const disk = hostDisk(fx);
	const NEW = "a new password after read-only";
	disk.readOnly = true;
	const r = await proveByRewrap(fx.deps, NEW);
	assert.deepEqual(r, { ok: false, error: "settings-write-failed" });
	assert.equal(fx.server.replaced, 0, "意图标记没落盘就不上传新密钥文档（真机实测：以前照样上传、还报了成功）");
	assert.equal(keyIdOf(fx.server.doc!), keyIdOf(fx.doc));
	assert.ok(await materialRestores(fx, fx.doc), "旧材料完好，仍可自动解锁");
	assert.equal(fx.settings.trustMigration?.pendingRewrapKeyId, undefined, "内存里的意图标记也退回了");
	assert.equal((disk.disk().trustMigration as { state: string }).state, "legacy_trust_found");
	assert.match(trustMigrationErrorText("settings-write-failed"), /data.json.*写不进去/);
	// 处理好（去掉只读）之后重试：完成
	disk.readOnly = false;
	const r2 = await proveByRewrap(fx.deps, NEW);
	assert.equal(r2.ok, true, JSON.stringify(r2));
	assert.equal((await advanceAfterProof(fx.deps)).ok, true);
	assert.equal(fx.server.replaced, 1);
	assert.equal((disk.disk().trustMigration as { state: string }).state, "strict_mode", "磁盘上是严格模式");
	assert.equal(disk.disk().deviceKeyB64, "");
	assert.ok((await unlockVaultKey(fx.server.doc!, NEW)) !== null, "新密码能解开服务器上的文档");
});

test("WIN-12 第 5 步（续）：清理阶段「clearing」写不进去 → SecretStorage 里的材料一个字都不动，内存状态退回；可写后重试照常清理", async () => {
	const fx = await legacyFixture();
	const disk = hostDisk(fx);
	assert.equal((await proveByPassword(fx.deps, PASSWORD)).ok, true);
	assert.equal((await handlePendingWrites(fx.deps)).ok, true);
	assert.equal(fx.settings.trustMigration?.state, "pending_writes_handled");
	disk.readOnly = true;
	assert.deepEqual(await clearLegacyMaterial(fx.deps), { ok: false, error: "settings-write-failed" });
	assert.ok(fx.secrets.getSecret(VAULT_KEY_SECRET_ID), "SecretStorage 里的旧材料没被清掉");
	assert.notEqual(fx.settings.deviceKeyB64, "");
	assert.equal(fx.settings.trustMigration?.state, "pending_writes_handled", "内存状态退回，重试不会跳过落盘直接清理");
	// 同一次运行里再点一次：仍然先落盘 clearing（仍只读 → 仍停住）
	assert.deepEqual(await advanceAfterProof(fx.deps), { ok: false, error: "settings-write-failed" });
	assert.ok(fx.secrets.getSecret(VAULT_KEY_SECRET_ID));
	disk.readOnly = false;
	assert.equal((await advanceAfterProof(fx.deps)).ok, true);
	assert.equal(fx.secrets.getSecret(VAULT_KEY_SECRET_ID), "");
	assert.equal((disk.disk().trustMigration as { state: string }).state, "strict_mode");
});

test("读回核对只比迁移相关的三项：设置页同时改了别的字段不算失败；读不回来 / 不是 JSON 算失败", () => {
	const s: TrustSettings = { trustDevice: false, deviceKeyB64: "", trustMigration: null };
	assert.equal(trustSettingsPersisted(s, JSON.stringify({ ...s, autoSync: false, deviceName: "x" })), true);
	assert.equal(trustSettingsPersisted(s, JSON.stringify({ ...s, trustDevice: true })), false);
	assert.equal(trustSettingsPersisted(s, null), false);
	assert.equal(trustSettingsPersisted(s, "{not json"), false);
});
