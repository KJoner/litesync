// 公开版复审（v12.0.1 public-launch-review）插件反例转正：审查脚本里的 7 条反例原本断言「错误行为确实出现」，
// 这里逐条改写为期望**正确行为**的回归测试（审查包 reproductions/plugin-reproductions.test.ts）。
//
//   PL-01  晚到的解锁结果在 lock + setDoc(B) 之后被装上       → 作废，B 文档下没有 A 的钥匙
//   PL-02  路径加密仓库完整替换的新建不带 metadata            → 新建请求带 LSM1 + canonical HMAC，服务器接受
//   PL-02b 先删后建，新建失败、反向恢复也失败                  → 先建后删；恢复点可解回；反向重建带元数据、身份与世代连续
//   PL-03  integrity-error 下完整替换仍执行写入               → 执行许可挡下，零写入，作业与恢复点可诊断
//   PL-04  预览后本地出现了文件，delete 照删远端               → 暂停（paused_stale），远端不删，零写入
//   PL-05  restore 提交后丢响应，同一作业续跑被误判 stale      → 同一作业续跑拿回首次结果，在其上完成上传
//   PL-06  配对继承的可信锚（head 120）在首次应用之后才采纳     → 接入之前核验被拒，一个文件都不写；空 checkpoint 列表不再放行回退
//          （判据矩阵见 tests/inherited-trust.test.ts）
//
// 内存服务端按真实协议建模（tests/fakes/replace-server.ts；元数据建档要求对照 service.go:508–519）。
// 这不是真实 Go 服务端联调——那部分见 scripts/interop/。
//
// INV: INV-03（不满足前置条件绝不覆盖 / 不删除）/ INV-04（核验未过不推进游标）/ INV-05（身份由 fileId 决定，恢复不重置）/ INV-10（换连接后旧结果不安装）/ INV-11（作业可恢复、可重复、幂等）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import {
	buildReverseJob,
	confirmReplaceJob,
	planReplaceRemote,
	recoveryDir,
	refreshReverseWatermark,
	ReplaceJobError,
	runReplaceJob,
	saveRecoveryPoint,
} from "../src/bootstrap/replace-remote";
import { bootstrapRemoteWins, InheritedTrustRejectedError, preflight } from "../src/bootstrap/bootstrap-manager";
import {
	canonicalPathHmac,
	createVaultKeyDoc,
	decryptFileV3,
	decryptMeta,
	encryptFileV3,
	exportVmkRaw,
	newFileId,
} from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { verifyCheckpointChain } from "../src/sync/checkpoint-sync";
import { sha256Hex } from "../src/utils/hash";
import { dec, enc, FakeServer, makeCtx, MemVault } from "./fakes/replace-server";

async function e2eeCtx(metaState: "plain" | "encrypted") {
	const server = new FakeServer();
	server.metaState = metaState;
	const vault = new MemVault();
	const { doc, vmk } = await createVaultKeyDoc("test-password");
	doc.enabled = true;
	const kr = new Keyring();
	kr.adopt(doc, vmk);
	const ctx = await makeCtx(server, vault, kr, { metaState });
	const keys = await kr.metaKeys();
	return { server, vault, ctx, vmk, keys, kr };
}

const isPseudonym = (p: string): boolean => p === "" || /^[0-9a-f]{32}$/.test(p);

/** a 一致、b 不同、c 只在远端、d 只在本地（明文仓库）。 */
async function preparedPlain() {
	const server = new FakeServer();
	await server.seedAsync("a.md", "same");
	await server.seedAsync("b.md", "remote version");
	await server.seedAsync("c.md", "remote only");
	const vault = new MemVault();
	vault.put("a.md", "same");
	vault.put("b.md", "local version");
	vault.put("d.md", "local only");
	const ctx = await makeCtx(server, vault);
	const job = await planReplaceRemote(ctx, { vaultName: "个人笔记", vaultChoice: "", bootstrapContext: false, now: 1 });
	assert.deepEqual(confirmReplaceJob(job, "个人笔记", 2), { ok: true });
	await saveRecoveryPoint(ctx, job);
	return { server, vault, ctx, job };
}

test("反例转正 PL-01：解锁 A 进行中 lock() + setDoc(B)，晚到的结果作废——B 文档下不会装上 A 的钥匙", async () => {
	const a = await createVaultKeyDoc("password-A");
	const b = await createVaultKeyDoc("password-B");
	a.doc.enabled = b.doc.enabled = true;
	const kr = new Keyring();
	kr.setDoc(a.doc);
	const pending = kr.unlock("password-A");
	kr.lock();
	kr.setDoc(b.doc);
	assert.equal(await pending, "stale");
	assert.equal(kr.doc, b.doc);
	assert.equal(kr.unlocked, false);
	assert.throws(() => kr.requireKey());
	assert.equal(await kr.unlock("password-B"), "unlocked");
	assert.deepEqual(await exportVmkRaw(kr.requireKey()), await exportVmkRaw(b.vmk));
});

test("反例转正 PL-02：路径加密仓库完整替换的新建请求携带 LSM1 元数据与 canonical HMAC，服务器接受", async () => {
	const { server, vault, ctx, vmk, keys } = await e2eeCtx("encrypted");
	await server.seedE2ee("seed.md", "same", vmk, keys);
	vault.put("seed.md", "same");
	vault.put("new.md", "new private note");
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "v", bootstrapContext: false });
	assert.equal(job.counts.create, 1);
	const create = job.items.find((i) => i.action === "create")!;
	assert.match(create.fileId ?? "", /^[0-9a-f]{32}$/, "计划只预留身份");
	assert.equal(ctx.store.get("new.md"), undefined, "预留 ≠ 已建档：计划阶段不写 FileState");
	confirmReplaceJob(job, "v", 1);
	await saveRecoveryPoint(ctx, job);

	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed");
	const head = server.heads.get(create.fileId!);
	assert.ok(head && !head.deleted, "以伪名（= 预留 fileId）建档成功");
	const plain = await decryptFileV3(vmk, head.data, server.vaultId, create.fileId!, 1);
	assert.equal(dec(plain!.plain), "new private note", "内容逐字节解回");
	const meta = await decryptMeta(keys, head.metaEnc!, server.vaultId, create.fileId!);
	assert.equal(meta?.meta.path, "new.md", "LSM1 里是真实路径");
	assert.equal(head.canonical, `h:${await canonicalPathHmac(keys, "new.md")}`, "canonical HMAC 随建档上传");
	assert.equal(ctx.store.get("new.md")?.fileId, create.fileId, "服务器确认之后才写 FileState");
	assert.ok(server.requests.every((q) => isPseudonym(q.path)), "真实路径从未出现在任何请求里");
});

test("反例转正 PL-02b：路径加密仓库先新建后删除；恢复点可解回；反向作业带元数据重建被删对象（身份与世代连续）", async () => {
	const { server, vault, ctx, vmk, keys } = await e2eeCtx("encrypted");
	await server.seedE2ee("seed.md", "same", vmk, keys);
	const [goneKey, goneHead] = await server.seedE2ee("remote-only.md", "old remote private note", vmk, keys);
	vault.put("seed.md", "same");
	vault.put("new.md", "local new private note");
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "v", bootstrapContext: false });
	assert.equal(job.counts.delete, 1);
	assert.equal(job.counts.create, 1);
	assert.deepEqual(
		job.items.filter((i) => i.action !== "keep").map((i) => i.action),
		["create", "delete"],
		"新建在删除之前：新建失败时远端还没少任何东西",
	);
	confirmReplaceJob(job, "v", 1);
	await saveRecoveryPoint(ctx, job);
	const deleted = job.items.find((i) => i.action === "delete")!;
	const recovery = vault.files.get(`${recoveryDir(ctx, job.jobId)}/${deleted.snapshotFile}`)!;
	assert.equal(await sha256Hex(recovery), deleted.snapshotHash, "恢复点密文完整");
	const back = await decryptFileV3(vmk, recovery, server.vaultId, goneHead.fileId, 1);
	assert.equal(dec(back!.plain), "old remote private note", "删除前的密文确实可以解回");
	assert.equal(deleted.snapshotGeneration, 1, "保存恢复点时已解密校验并记下认证过的世代");

	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed");
	assert.equal(server.heads.get(goneKey)!.deleted, true, "远端独有文件走 tombstone");

	const reverse = buildReverseJob(job, 2);
	await refreshReverseWatermark(ctx, reverse);
	confirmReplaceJob(reverse, "v", 3);
	await saveRecoveryPoint(ctx, reverse);
	const rr = await runReplaceJob(ctx, reverse);
	assert.equal(rr.state, "completed", "反向恢复不再被 metadata 前置条件挡住");
	const restored = server.heads.get(goneKey)!;
	assert.equal(restored.deleted, false);
	assert.equal(restored.fileId, goneHead.fileId, "恢复的是原对象（INV-05）");
	const content = await decryptFileV3(vmk, restored.data, server.vaultId, goneHead.fileId, 1);
	assert.equal(dec(content!.plain), "old remote private note", "按恢复点内容重建");
	assert.ok(content!.generation > 1 && restored.generation === content!.generation, "内容世代前进且与服务器记录一致");
	const meta = await decryptMeta(keys, restored.metaEnc!, server.vaultId, goneHead.fileId);
	assert.equal(meta?.meta.path, "remote-only.md");
	assert.equal(meta?.metaGeneration, restored.metaGeneration, "LSM1 信封里的元数据世代与服务器一致（之后的改名 CAS 才对得上）");
	const created = job.items.find((i) => i.action === "create")!;
	assert.equal(server.heads.get(created.fileId!)!.deleted, true, "原作业新建的对象被删除（留 tombstone）");
	assert.ok(server.requests.every((q) => isPseudonym(q.path)), "全程没有真实路径进入请求");
});

test("反例转正 PL-03：完整性停机之后执行完整替换 → 执行许可挡下，零写入，作业与恢复点保持可诊断", async () => {
	const { server, vault, ctx, job } = await preparedPlain();
	ctx.gate.markIntegrityError("verified remote integrity failure");
	await assert.rejects(
		runReplaceJob(ctx, job),
		(e: unknown) => e instanceof ReplaceJobError && e.code === "blocked" && e.blockReason === "integrity-error",
	);
	assert.equal(server.writeRequests().length, 0, "零写入");
	assert.equal(job.state, "confirmed", "作业状态不变，可以诊断后续跑");
	assert.equal(ctx.store.state.replaceJob?.lastBlock?.reason, "integrity-error", "挡停原因已落盘");
	for (const it of job.items.filter((i) => i.snapshotFile)) {
		const raw = vault.files.get(`${recoveryDir(ctx, job.jobId)}/${it.snapshotFile}`)!;
		assert.equal(await sha256Hex(raw), it.snapshotHash, "恢复点完好");
	}
});

test("反例转正 PL-04：预览判为仅远端的 c.md 在执行前出现在本地 → 暂停，不删除远端，零写入", async () => {
	const { server, vault, ctx, job } = await preparedPlain();
	vault.put("c.md", "newly recovered local file, created after preview");
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "paused_stale");
	assert.match(r.reason ?? "", /本地出现了它/);
	assert.equal(server.heads.get("c.md")!.deleted, false, "远端 c.md 原样保留，其他设备不会收到这条删除");
	assert.equal(server.writeRequests().length, 0, "任何远端写入之前就停了");
	assert.equal(dec(vault.files.get("c.md")!), "newly recovered local file, created after preview");
});

test("反例转正 PL-05：restore 已提交但响应丢失 → 同一作业续跑拿回首次结果，在其上完成上传（不重开新作业）", async () => {
	const server = new FakeServer();
	await server.seedAsync("seed.md", "same");
	const gone = await server.seedAsync("resurrect.md", "old");
	await server.client().remove("resurrect.md", 1);
	server.writes = 0;
	const vault = new MemVault();
	vault.put("seed.md", "same");
	vault.put("resurrect.md", "replacement");
	const ctx = await makeCtx(server, vault);
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "v", bootstrapContext: false });
	confirmReplaceJob(job, "v", 1);
	await saveRecoveryPoint(ctx, job);
	server.loseResponseOnWrite = 1; // 第一次写入就是 restore：服务器提交了，响应丢了
	await assert.rejects(runReplaceJob(ctx, job), /response lost/);
	assert.equal(job.state, "interrupted");
	const item = job.items.find((i) => i.path === "resurrect.md")!;
	assert.equal(ctx.store.state.replaceJob?.items.find((i) => i.path === "resurrect.md")?.restore?.phase, "requested", "恢复意图已落盘");

	const jobId = job.jobId;
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed", "同一作业续跑完成（不是 paused_stale）");
	assert.equal(job.jobId, jobId, "没有用新作业冒充续跑");
	const h = server.heads.get("resurrect.md")!;
	assert.equal(h.deleted, false);
	assert.equal(dec(h.data), "replacement", "远端是本地替换内容，不是被复活的旧内容");
	assert.equal(h.fileId, gone.fileId, "恢复的是原对象（INV-05）");
	assert.equal(server.changes.filter((c) => c.action === "restore" && c.fileId === gone.fileId).length, 1, "只恢复了一次");
	assert.equal(item.restore?.phase, "restored");
	assert.ok(job.ownSequences.includes(item.restore!.sequence!), "自己的 restore 被认作自己的写入，不是外来变更");
});

test("反例转正 PL-06：继承 head 120、服务器只给 head 1 的可解密旧内容 → 接入之前核验被拒，本地一个文件都不写；空 checkpoint 列表也不再放行", async () => {
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
	(ctx.client as unknown as { checkpoints: () => Promise<unknown> }).checkpoints = async () => ({
		repoEpoch: server.repoEpoch,
		checkpoints: [],
		conflicting: [],
		signingKeys: {},
		revokedDevices: [],
	});
	(ctx as unknown as { committer: unknown }).committer = {
		commitRemoteChange: async (r: { realPath: string; incoming: ArrayBuffer }) => {
			vault.files.set(r.realPath, r.incoming);
			return { status: "committed" };
		},
	};
	const p = await preflight(ctx);
	assert.equal(p.snapshotSequence, 1);
	assert.equal(p.inheritedTrust?.kind === "rejected" && p.inheritedTrust.reason, "rollback", "能解密 ≠ 最新可信状态");
	await assert.rejects(bootstrapRemoteWins(ctx, p, () => {}), InheritedTrustRejectedError);
	assert.equal(vault.files.has("note.md"), false, "旧内容没有写进本地");
	assert.equal(ctx.store.state.lastSequence, 0);
	assert.equal(ctx.store.state.trustAnchor, null);
	assert.ok(ctx.store.state.pendingPairingTrust, "不静默降为首次信任：暂存保留给用户选择");

	// 第二半：已采纳 head 120 的锚、服务器返回空 checkpoint 列表且 head 只有 1 → 判回退
	ctx.store.state.trustAnchor = {
		repoEpoch: server.repoEpoch,
		checkpointHash: "c".repeat(64),
		headSequence: 120,
		devicePublicKeys: { old: "PUB" },
		revokedDevices: [],
		updatedAt: 0,
	};
	assert.equal(await verifyCheckpointChain(ctx, 1), false, "空列表不再等于验证通过");
});
