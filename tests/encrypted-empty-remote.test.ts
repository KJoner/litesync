// 预发布实测缺陷（2026-11-22，基线 c383e39 起就有）：接入「已加密但还没有文件」的远端仓库时，向导走不下去。
//
// 现象：网页「新建仓库 → 创建并加密」得到的仓库已有密钥文档（encryptionState ≠ plaintext）但 0 个文件。
// 新设备粘贴连接链接 → 解锁成功 → 向导进入 both-empty / local-only，只给「用本地初始化空仓库（设置仓库密码）」→
// 要求再设一个新密码 → enableE2eeOnEmptyRemote 的前置检查（远端必须未初始化）抛错 → 死路。local-only（本地已有
// 笔记、远端加密且空，老 Obsidian 用户最常见的接入）走的是同一个按钮。
//
// 修复：远端已加密且本设备已解锁时，用现有密钥接入——不调用 enableE2ee*、不要求新密码；both-empty 直接完成接入，
// local-only 完成接入后由普通同步以 LSE3 密文上传。远端仍是 plaintext 的空库照旧走「设置仓库密码」（0.19.x 起强制 E2EE）。
// enableE2eeOnEmptyRemote 的前置检查保留：对已加密的远端它仍在任何写操作之前拒绝。
//
// 覆盖：
//   决策矩阵 emptyRemoteInit：明文空库 → 设密码；加密 + 已解锁 + 合法 keyEpoch → 用现有密钥接入；
//     加密状态不完整（keyEpoch 0、说已加密却没有启用的密钥文档、未解锁）→ 停下
//   加密空远端 + 空本地：完成接入，不上传任何东西；正式 binding 的 keyEpoch 是解锁后重新 preflight 的服务器值
//   加密空远端 + 本地有文件：完成接入后的上传是 LSE3 密文、绑定服务器当前 keyEpoch，另一台设备用同一个仓库密码能解开；
//     用旧 keyEpoch 解不开（AAD 绑定）
//   旧路径的前置检查仍在：对加密空远端调用 enableE2eeOnEmptyRemote 在写之前就拒绝，服务器什么都没收到
//
// INV: INV-03（加密状态对不上时停下，不写本地也不写远端）/ INV-07（首次上传就是 LSE3，不回退到更弱的信封）/
//      INV-10（keyEpoch 取解锁后重新 preflight 的值写进正式 binding）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { bootstrapLocalInit, preflight } from "../src/bootstrap/bootstrap-manager";
import { classifyBootstrap, emptyRemoteInit } from "../src/bootstrap/bootstrap-types";
import { createVaultKeyDoc, decryptFileV3, isEncryptedPayload, isLegacyEnvelope } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { enableE2eeOnEmptyRemote } from "../src/crypto/migration";
import { uploadFromPlain } from "../src/sync/transfer";
import { dec, enc, FakeServer, makeCtx, MemVault } from "./fakes/replace-server";

const PASSWORD = "synthetic-vault-password";
/** 服务器当前的 keyEpoch：故意不是 makeCtx 预置在 bootstrap 里的 1，用来证明 binding 取的是新值 */
const KEY_EPOCH = 3;

test("决策：明文空库设密码；加密 + 已解锁 + 合法 keyEpoch 用现有密钥接入；加密状态不完整时停下", () => {
	assert.equal(emptyRemoteInit({ keyDocEnabled: false, encryptionState: "plaintext", unlocked: false }), "set-password");
	assert.equal(emptyRemoteInit({ keyDocEnabled: false, unlocked: false }), "set-password", "缺省按 plaintext");
	assert.equal(emptyRemoteInit({ keyDocEnabled: true, encryptionState: "e2ee", unlocked: true, keyEpoch: 3 }), "join-encrypted");
	assert.equal(emptyRemoteInit({ keyDocEnabled: true, encryptionState: "e2ee", unlocked: true, keyEpoch: 0 }), "blocked", "有文档但 keyEpoch 为 0");
	assert.equal(emptyRemoteInit({ keyDocEnabled: false, encryptionState: "migrating", unlocked: false }), "blocked", "说在加密却没有启用的文档");
	assert.equal(emptyRemoteInit({ keyDocEnabled: true, encryptionState: "e2ee", unlocked: false, keyEpoch: 3 }), "blocked", "没解锁不接入");
});

/** 已加密、0 个文件的远端（网页「新建仓库 → 创建并加密」的形状）+ 已用仓库密码解锁的新设备。 */
async function encryptedEmptyWorld(localFiles: Record<string, string>) {
	const server = new FakeServer();
	const { doc } = await createVaultKeyDoc(PASSWORD);
	doc.enabled = true;
	const vault = new MemVault();
	for (const [p, c] of Object.entries(localFiles)) vault.put(p, c);
	const keyring = new Keyring();
	keyring.setDoc(doc);
	assert.equal(await keyring.unlock(PASSWORD), "unlocked");
	const ctx = await makeCtx(server, vault, keyring, { bootstrap: "pending" });
	const baseInfo = ctx.client.info.bind(ctx.client);
	(ctx.client as unknown as { info: () => Promise<unknown> }).info = async () => ({
		...(await baseInfo()),
		keyEpoch: KEY_EPOCH,
		encryptionState: "e2ee",
	});
	return { server, vault, ctx, doc };
}

test("加密空远端 + 空本地：解锁后直接完成接入，不上传任何东西；binding 的 keyEpoch 是服务器当前值", async () => {
	const w = await encryptedEmptyWorld({});
	const pre = await preflight(w.ctx);
	assert.equal(classifyBootstrap(pre.localPaths.length, pre.remoteFiles.length), "both-empty");
	assert.equal(
		emptyRemoteInit({ keyDocEnabled: pre.e2eeEnabled, encryptionState: pre.info.encryptionState, unlocked: w.ctx.e2ee.unlocked, keyEpoch: pre.info.keyEpoch }),
		"join-encrypted",
	);
	await bootstrapLocalInit(w.ctx, await preflight(w.ctx));
	const b = w.ctx.store.state.bootstrap;
	assert.equal(b.status, "ready");
	assert.equal(b.keyEpoch, KEY_EPOCH, "不是 makeCtx 预置的旧值 1");
	assert.equal(w.server.writeRequests().length, 0, "没有往远端写任何东西");
});

test("加密空远端 + 本地有文件：首次上传是 LSE3 密文、绑定当前 keyEpoch，另一台设备用仓库密码能解开", async () => {
	const files = { "周会.md": "# 周会\n下周三发布。\n", "dir/附件说明.md": "只在本机写过的笔记\n" };
	const w = await encryptedEmptyWorld(files);
	const pre = await preflight(w.ctx);
	assert.equal(classifyBootstrap(pre.localPaths.length, pre.remoteFiles.length), "local-only");
	await bootstrapLocalInit(w.ctx, await preflight(w.ctx));
	assert.equal(w.ctx.store.state.bootstrap.keyEpoch, KEY_EPOCH);

	// 接入后的普通同步对每个本地文件做的上传（push → uploadFromPlain）
	for (const [p, c] of Object.entries(files)) await uploadFromPlain(w.ctx, p, enc(c), 0, 1000);
	assert.equal(w.server.writeRequests().length, 2);

	const other = new Keyring();
	other.setDoc(w.doc);
	assert.equal(await other.unlock(PASSWORD), "unlocked", "另一台设备用同一个仓库密码解锁");
	for (const [p, c] of Object.entries(files)) {
		const head = w.server.heads.get(p)!;
		assert.ok(isEncryptedPayload(head.data) && !isLegacyEnvelope(head.data), `${p}：服务器上是密文且不是旧信封`);
		assert.equal(dec(head.data.slice(0, 4)), "LSE3", `${p}：LSE3`);
		assert.ok(!dec(head.data).includes(c.trim()), "服务器上看不到明文");
		const opened = await decryptFileV3(other.requireKey(), head.data, w.server.vaultId, head.fileId, KEY_EPOCH);
		assert.ok(opened, `${p}：另一台设备能解开`);
		assert.equal(dec(opened.plain), c);
		assert.equal(await decryptFileV3(other.requireKey(), head.data, w.server.vaultId, head.fileId, 1), null, "AAD 绑定了 keyEpoch：旧值解不开");
	}
});

test("旧路径的前置检查仍在：对加密空远端「设置新密码」在任何写操作之前就被拒绝，服务器与本机密钥都没动", async () => {
	const w = await encryptedEmptyWorld({});
	const before = w.ctx.e2ee.doc;
	await assert.rejects(enableE2eeOnEmptyRemote(w.ctx, "another-new-password"), /远端仓库已不是未初始化状态/);
	assert.equal(w.server.writeRequests().length, 0);
	assert.equal(w.ctx.e2ee.doc, before, "本机的密钥文档没换");
	assert.equal(w.ctx.e2ee.unlocked, true);
});
