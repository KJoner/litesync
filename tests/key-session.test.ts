// 0.20.1 复审 PL-01：密钥环与连接上下文的代次（ADR-013 §5.1，验收 KY-03）。
//
// 审查反例（REPRO PL-01）：unlock(A) 的 PBKDF2 还没算完时 lock() + setDoc(B)，晚到的结果仍被装上——
// 返回 true、doc===B、unlocked===true，实际 VMK 却是 A 的。这里把它改写成正确行为的断言，并补齐：
//   两次解锁逆序完成（后发起的先装好，先发起的晚到结果作废）
//   解锁中关闭弹窗（取消）→ 不安装、不持久化、不报「密码错误」
//   解锁 A 时切到 B（切库立即锁定）→ 晚到的文档与钥匙都不安装
//   派生的元数据密钥晚到 → 不写缓存；重置凭证晚到 → 不返回
//   显式持久化时包装期间被锁定 / 切库 → 不写 SecretStorage
//   卸载之后一切安装作废；同一份材料的 setDoc（每轮同步都会刷新）不误伤进行中的解锁
//   凭据变化（同一仓库）作废进行中的任务但保留已装好的钥匙（v0.18 重置 Token 恢复路径）
//
// 严格模式下从不为绕过竞态而持久化可自动还原 VMK 的材料：这里每个场景都断言 SecretStorage 为空。
//
// INV: INV-10（凭据 / 仓库 / 服务器变化必须重新绑定，旧上下文的异步结果不得安装）/ INV-09（会话不可信时停止，而不是带着错钥匙继续）
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	canonicalPathHmac,
	createVaultKeyDoc,
	deriveMetaKeys,
	exportVmkRaw,
	VaultKeyDoc,
} from "../src/crypto/crypto";
import { persistTrustMaterial, SecretStore, VAULT_KEY_SECRET_ID } from "../src/crypto/device-trust";
import { Keyring, KeySessionChangedError } from "../src/crypto/keyring";
import { runUnlockFlow, UNLOCK_STALE_MESSAGE } from "../src/crypto/unlock-flow";

class MemSecrets implements SecretStore {
	map = new Map<string, string>();
	getSecret(id: string): string | null {
		return this.map.get(id) ?? null;
	}
	setSecret(id: string, value: string): void {
		this.map.set(id, value);
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

/** 可控完成顺序的解包函数：每次调用排一个待决项，由测试决定何时、以什么结果完成。 */
function controlledUnwrap() {
	const calls: Array<{ doc: VaultKeyDoc; password: string; done: (k: CryptoKey | null) => void }> = [];
	const unwrap = (doc: VaultKeyDoc, password: string): Promise<CryptoKey | null> => {
		const d = deferred<CryptoKey | null>();
		calls.push({ doc, password, done: d.resolve });
		return d.promise;
	};
	return { calls, unwrap };
}

async function rawOf(key: CryptoKey): Promise<string> {
	return Array.from(await exportVmkRaw(key)).join(",");
}

async function twoVaults() {
	const a = await createVaultKeyDoc("password-A");
	const b = await createVaultKeyDoc("password-B");
	a.doc.enabled = b.doc.enabled = true;
	return { a, b };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- 反例转正：REPRO PL-01 ----------

test("PL-01 反例转正：解锁 A 的结果在 lock + setDoc(B) 之后晚到 → 作废，B 文档下没有 A 的钥匙", async () => {
	const { a, b } = await twoVaults();
	const kr = new Keyring();
	kr.setDoc(a.doc);
	const pending = kr.unlock("password-A"); // 真实 PBKDF2：同步的 lock/setDoc 一定先于它完成
	kr.lock();
	kr.setDoc(b.doc);
	assert.equal(await pending, "stale", "晚到的结果作废，不是 true");
	assert.equal(kr.doc, b.doc);
	assert.equal(kr.unlocked, false, "锁定没有被晚到的解锁撤销");
	assert.throws(() => kr.requireKey());
	// 之后用 B 的密码解锁，拿到的是 B 的钥匙
	assert.equal(await kr.unlock("password-B"), "unlocked");
	assert.equal(await rawOf(kr.requireKey()), await rawOf(b.vmk));
});

// ---------- 两次解锁逆序完成 ----------

test("两次解锁逆序完成：后发起的先装好，先发起的晚到结果作废，钥匙不回退", async () => {
	const { a } = await twoVaults();
	const other = await createVaultKeyDoc("irrelevant");
	const { calls, unwrap } = controlledUnwrap();
	const kr = new Keyring({ unwrap });
	kr.setDoc(a.doc);
	const first = kr.unlock("password-A");
	const second = kr.unlock("password-A");
	calls[1].done(a.vmk); // 第二次先完成
	assert.equal(await second, "unlocked");
	calls[0].done(other.vmk); // 第一次晚到（哪怕带着一把不同的钥匙）
	assert.equal(await first, "stale");
	assert.equal(await rawOf(kr.requireKey()), await rawOf(a.vmk), "已装好的钥匙没有被晚到的结果覆盖");
});

test("两次解锁逆序完成（跨仓库）：解锁 A 期间切到 B 并解锁 B，A 晚到 → 作废，当前是 B 的钥匙", async () => {
	const { a, b } = await twoVaults();
	const { calls, unwrap } = controlledUnwrap();
	const kr = new Keyring({ unwrap });
	kr.setDoc(a.doc);
	const unlockA = kr.unlock("password-A");
	kr.switchContext({ lock: true }); // setVaultChoice：切库立即锁定
	kr.setDoc(b.doc);
	const unlockB = kr.unlock("password-B");
	calls[1].done(b.vmk);
	assert.equal(await unlockB, "unlocked");
	calls[0].done(a.vmk);
	assert.equal(await unlockA, "stale");
	assert.equal(kr.doc, b.doc);
	assert.equal(await rawOf(kr.requireKey()), await rawOf(b.vmk));
});

// ---------- 解锁中关闭弹窗 ----------

test("解锁中关闭弹窗：取消的这次解锁不安装钥匙、不持久化、不报「密码错误」", async () => {
	const { a } = await twoVaults();
	const { calls, unwrap } = controlledUnwrap();
	const kr = new Keyring({ unwrap });
	kr.setDoc(a.doc);
	const secrets = new MemSecrets();
	let cancelled = false;
	let persisted = 0;
	const flow = runUnlockFlow(
		{
			keyring: kr,
			fetchKeyDoc: async () => a.doc,
			storeKeyDoc: async () => {},
			afterUnlocked: async () => {
				persisted++;
				await persistTrustMaterial(secrets, "", kr);
			},
		},
		"password-A",
		() => cancelled,
	);
	await tick();
	cancelled = true; // 用户关掉了解锁窗口
	calls[0].done(a.vmk); // PBKDF2 晚到
	const r = await flow;
	assert.equal(r.ok, false);
	assert.equal(r.ok === false && r.reason, "stale");
	assert.equal(r.ok === false && r.message, UNLOCK_STALE_MESSAGE);
	assert.equal(kr.unlocked, false);
	assert.equal(persisted, 0, "后续动作（显式持久化、同步）不执行");
	assert.equal(secrets.getSecret(VAULT_KEY_SECRET_ID), null, "没有为绕过竞态写下任何可自动还原 VMK 的材料");
});

// ---------- 解锁 A 时切 B ----------

test("解锁 A 时切 B（新设备还要先取文档）：取回的 A 文档作废，不装进切换后的密钥环", async () => {
	const { a, b } = await twoVaults();
	const kr = new Keyring();
	const fetchA = deferred<VaultKeyDoc | null>();
	let stored = 0;
	const flow = runUnlockFlow(
		{ keyring: kr, fetchKeyDoc: () => fetchA.promise, storeKeyDoc: async () => void stored++ },
		"password-A",
		() => false,
	);
	await tick();
	kr.switchContext({ lock: true }); // 用户在向导里选了 B
	fetchA.resolve(a.doc); // A 的文档晚到
	const r = await flow;
	assert.equal(r.ok === false && r.reason, "stale");
	assert.equal(kr.doc, null, "旧连接取回的文档没有装进来");
	assert.equal(stored, 0, "也没有写进本地缓存");

	// 之后按 B 的连接重新解锁：一切正常
	const r2 = await runUnlockFlow({ keyring: kr, fetchKeyDoc: async () => b.doc, storeKeyDoc: async () => {} }, "password-B", () => false);
	assert.deepEqual(r2, { ok: true });
	assert.equal(await rawOf(kr.requireKey()), await rawOf(b.vmk));
});

test("解锁流程：错误密码如实返回 wrong-password；严格模式（没有显式持久化）什么都不写", async () => {
	const { a } = await twoVaults();
	const kr = new Keyring();
	kr.setDoc(a.doc);
	const r = await runUnlockFlow({ keyring: kr, fetchKeyDoc: async () => a.doc, storeKeyDoc: async () => {} }, "wrong!!", () => false);
	assert.equal(r.ok === false && r.reason, "wrong-password");
	const ok = await runUnlockFlow({ keyring: kr, fetchKeyDoc: async () => a.doc, storeKeyDoc: async () => {} }, "password-A", () => false);
	assert.deepEqual(ok, { ok: true });
});

// ---------- 派生材料晚到 ----------

test("派生的元数据密钥晚到：锁定后再采纳 B，A 的派生结果作废、不进缓存，此后拿到的是 B 的元数据密钥", async () => {
	const { a, b } = await twoVaults();
	const kr = new Keyring();
	kr.adopt(a.doc, a.vmk);
	const late = kr.metaKeys();
	kr.lock();
	kr.setDoc(b.doc);
	kr.adopt(b.doc, b.vmk);
	await assert.rejects(late, (e: unknown) => e instanceof KeySessionChangedError);
	const now = await kr.metaKeys();
	const refB = await deriveMetaKeys(await exportVmkRaw(b.vmk));
	const refA = await deriveMetaKeys(await exportVmkRaw(a.vmk));
	assert.equal(await canonicalPathHmac(now, "x.md"), await canonicalPathHmac(refB, "x.md"), "缓存里是 B 的派生结果");
	assert.notEqual(await canonicalPathHmac(now, "x.md"), await canonicalPathHmac(refA, "x.md"));
});

test("重置凭证晚到：派生期间被锁定 → 返回 null（不会被登记到切换后的连接上）", async () => {
	const { a } = await twoVaults();
	const kr = new Keyring();
	kr.adopt(a.doc, a.vmk);
	const late = kr.resetAuth();
	kr.lock();
	assert.equal(await late, null);
});

// ---------- 显式持久化与锁定 / 切库的竞态 ----------

test("显式持久化：包装期间被锁定或切库 → 不写 SecretStorage；会话不变时按开始时那份文档的 keyId 写入", async () => {
	const { a, b } = await twoVaults();
	const secrets = new MemSecrets();
	const kr = new Keyring();
	kr.adopt(a.doc, a.vmk);
	const racing = persistTrustMaterial(secrets, "", kr);
	kr.switchContext({ lock: true });
	kr.setDoc(b.doc);
	kr.adopt(b.doc, b.vmk);
	assert.equal(await racing, null);
	assert.equal(secrets.getSecret(VAULT_KEY_SECRET_ID), null, "绝不会把 A 的钥匙包装成 B 的 keyId 存下来");

	const ok = await persistTrustMaterial(secrets, "", kr);
	assert.ok(ok, "会话不变时正常写入（用户显式开启的模式照常工作）");
	const blob = JSON.parse(secrets.getSecret(VAULT_KEY_SECRET_ID)!);
	assert.equal(blob.keyId, b.doc.wrappedKey.slice(0, 24));
});

// ---------- 生命周期 ----------

test("插件卸载：进行中的解锁晚到作废；之后的解锁、采纳一律拒绝", async () => {
	const { a } = await twoVaults();
	const kr = new Keyring();
	kr.setDoc(a.doc);
	const pending = kr.unlock("password-A");
	kr.dispose();
	assert.equal(await pending, "stale");
	assert.equal(kr.unlocked, false);
	assert.equal(await kr.unlock("password-A"), "stale", "卸载之后的解锁一律作废");
	assert.equal(kr.unlocked, false);
	assert.throws(() => kr.adopt(a.doc, a.vmk), KeySessionChangedError);
});

test("采纳钥匙前核对连接上下文：流程期间换了连接 → 拒绝采纳", async () => {
	const { a } = await twoVaults();
	const kr = new Keyring();
	const context = kr.contextGeneration;
	kr.switchContext({ lock: false });
	assert.throws(() => kr.adopt(a.doc, a.vmk, context), KeySessionChangedError);
	assert.equal(kr.unlocked, false);
	kr.adopt(a.doc, a.vmk, kr.contextGeneration);
	assert.equal(kr.unlocked, true);
});

test("同一份密钥材料的 setDoc（每轮同步刷新文档）不误伤进行中的解锁；材料变了才作废", async () => {
	const { a, b } = await twoVaults();
	const kr = new Keyring();
	kr.setDoc(a.doc);
	const gen = kr.generation;
	const pending = kr.unlock("password-A");
	kr.setDoc({ ...a.doc }); // 新对象、同一份材料
	assert.equal(kr.generation, gen);
	assert.equal(await pending, "unlocked");
	kr.setDoc(b.doc);
	assert.equal(kr.unlocked, false, "材料变了 → 锁定");
	assert.ok(kr.generation > gen);
});

test("凭据变化（同一仓库）：作废进行中的解锁，但保留已装好的钥匙（v0.18 重置 Token 恢复路径）", async () => {
	const { a } = await twoVaults();
	const kr = new Keyring();
	kr.setDoc(a.doc);
	assert.equal(await kr.unlock("password-A"), "unlocked");
	const second = kr.unlock("password-A");
	kr.switchContext({ lock: false }); // setApiToken
	assert.equal(await second, "stale", "进行中的任务作废");
	assert.equal(kr.unlocked, true, "已装好的钥匙保留：填新 Token → 测试连接 → 继续同步");
	assert.equal(await rawOf(kr.requireKey()), await rawOf(a.vmk));
});

test("可恢复材料自动解锁（unlockWithRaw）同样核对代次：导入期间被锁定 → 不安装", async () => {
	const { a } = await twoVaults();
	const kr = new Keyring();
	kr.setDoc(a.doc);
	const raw = await exportVmkRaw(a.vmk);
	const pending = kr.unlockWithRaw(raw);
	kr.lock();
	assert.equal(await pending, false);
	assert.equal(kr.unlocked, false);
	assert.equal(await kr.unlockWithRaw(raw), true);
});
