// v0.20「用本地完整替换远端」高级恢复作业（ADR-016，验收 SY-03 / SY-04）。
//
// 内存服务端按真实协议建模（tests/fakes/replace-server.ts，0.20.1 起共用）：revision CAS、墓碑挡住普通上传
// （必须显式 restore）、operationId 幂等（同一键返回首次结果）、LSE3 generation 单调、变更流 sequence、
// 元数据加密态的建档 metadata 要求（service.go:508–519）。
//
// 覆盖：
//   计划只读：dry-run 不产生任何远端写入；新建/覆盖/删除/不变/范围外 计数与实际动作一致
//   空远端 → 拒绝（那是 local-init 的场景，两者分开命名）
//   确认必须原样输入仓库名；恢复点未保存完成不得执行；恢复点逐字节校验
//   执行：删除走 tombstone（历史与身份保留）；中断后续跑不重复写（响应丢失 + 同 operationId）
//   并发保护：远端在预览后被改 / 本地在预览后被改 / 计划水位之后出现外来变更 → paused_stale
//   墓碑路径上的本地独有文件：显式 restore 后上传（身份连续）
//   反向作业：远端恢复到替换之前（新 revision，计数器不回退），本地副本先备份
//   E2EE：create 的 fileId 在计划里固定，断网重试不会换身份
//
// INV: INV-03（不满足前置条件绝不覆盖）/ INV-05（身份由 fileId 决定）/ INV-06（删除事实保留）/ INV-11（作业可恢复、可重复、幂等）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { bootstrapMerge } from "../src/bootstrap/bootstrap-manager";
import {
	buildReverseJob,
	confirmReplaceJob,
	planReplaceRemote,
	recoveryDir,
	refreshReverseWatermark,
	replaceCapabilities,
	ReplaceJobError,
	runReplaceJob,
	saveRecoveryPoint,
} from "../src/bootstrap/replace-remote";
import { createVaultKeyDoc, parseLse3Header } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { sha256Hex } from "../src/utils/hash";
import { dec, enc, FakeServer, makeCtx, MemVault } from "./fakes/replace-server";

/** 典型场景：a 一致、b 不同、c 只在远端、d 只在本地、.trash 下的远端文件不在同步范围。 */
async function scenario() {
	const server = new FakeServer();
	await server.seedAsync("a.md", "same");
	await server.seedAsync("b.md", "remote version");
	await server.seedAsync("c.md", "remote only");
	await server.seedAsync(".trash/old.md", "ignored");
	const vault = new MemVault();
	vault.put("a.md", "same");
	vault.put("b.md", "local version");
	vault.put("d.md", "local only");
	const ctx = await makeCtx(server, vault);
	return { server, vault, ctx };
}

async function prepared(name = "个人笔记") {
	const s = await scenario();
	const job = await planReplaceRemote(s.ctx, { vaultName: name, vaultChoice: "u-1", bootstrapContext: false, now: 1 });
	assert.deepEqual(confirmReplaceJob(job, name, 2), { ok: true });
	await saveRecoveryPoint(s.ctx, job);
	return { ...s, job };
}

// ---------- 计划 ----------

test("SY-04：dry-run 只读——计数与条目一一对应，范围外文件不计入，服务器零写入", async () => {
	const { server, ctx } = await scenario();
	const before = server.seq;
	const job = await planReplaceRemote(ctx, { vaultName: "个人笔记", vaultChoice: "u-1", bootstrapContext: false });
	assert.equal(server.seq, before, "预览不产生任何远端写入");
	assert.deepEqual(job.counts, { create: 1, update: 1, delete: 1, keep: 1, outOfScope: 1 });
	const byPath = Object.fromEntries(job.items.map((it) => [it.path, it.action]));
	assert.deepEqual(byPath, { "a.md": "keep", "b.md": "update", "c.md": "delete", "d.md": "create" });
	assert.equal(job.state, "planned");
	assert.equal(job.plannedHeadSequence, server.seq);
	assert.ok(job.items.every((it) => /^[0-9a-f]{24}$/.test(it.operationId)), "幂等键在计划阶段固定");
	// 执行顺序（0.20.1）：覆盖 → 新建 → 删除——新建失败时远端还没少任何东西；
	// 只有要占用被删对象名字（仅大小写不同）的新建排在删除之后
	assert.deepEqual(job.items.filter((i) => i.action !== "keep").map((i) => i.action), ["update", "create", "delete"]);
});

test("SY-03：远端在同步范围内为空 → 拒绝，引导使用「用本地初始化空仓库」", async () => {
	const server = new FakeServer();
	await server.seedAsync(".trash/only-ignored.md", "x");
	const vault = new MemVault();
	vault.put("note.md", "hi");
	const ctx = await makeCtx(server, vault);
	await assert.rejects(planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false }), (e: unknown) => {
		return e instanceof ReplaceJobError && e.code === "remote-empty";
	});
});

test("有未解决冲突时拒绝生成预览", async () => {
	const { ctx } = await scenario();
	ctx.store.recordConflict("b.md", { baseRevision: 0, remoteRevision: 1, createdAt: 0 });
	await assert.rejects(planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false }), /冲突/);
});

// ---------- 确认与恢复点 ----------

test("确认必须原样输入仓库名；恢复点未完成不得执行", async () => {
	const { ctx } = await scenario();
	const job = await planReplaceRemote(ctx, { vaultName: "个人笔记", vaultChoice: "", bootstrapContext: false });
	assert.equal(confirmReplaceJob(job, "个人笔", 1).ok, false);
	assert.equal(job.state, "planned");
	assert.equal(confirmReplaceJob(job, " 个人笔记 ", 1).ok, true);
	await assert.rejects(runReplaceJob(ctx, job), /恢复点/);
});

test("恢复点：被覆盖/删除的远端原始字节逐个保存并读回校验；附人可读清单", async () => {
	const { job, vault, ctx } = await prepared();
	assert.equal(job.snapshotComplete, true);
	const dir = recoveryDir(ctx, job.jobId);
	const b = job.items.find((i) => i.path === "b.md")!;
	const c = job.items.find((i) => i.path === "c.md")!;
	assert.equal(dec(vault.files.get(`${dir}/${b.snapshotFile}`)!), "remote version");
	assert.equal(dec(vault.files.get(`${dir}/${c.snapshotFile}`)!), "remote only");
	const manifest = JSON.parse(dec(vault.files.get(`${dir}/manifest.json`)!));
	assert.equal(manifest.items.length, 2);
	assert.ok(dir.startsWith(".obsidian/plugins/litesync/"), "恢复点在插件目录，不参与同步");
});

// ---------- 执行 ----------

test("SY-04：执行后远端与本地同步范围一致；删除留 tombstone；不变的文件一个字节都没写", async () => {
	const { server, job, ctx } = await prepared();
	const aRev = server.heads.get("a.md")!.revision;
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed");
	assert.equal(dec(server.heads.get("b.md")!.data), "local version");
	assert.equal(server.heads.get("c.md")!.deleted, true, "远端独有文件通过 tombstone 删除");
	assert.equal(dec(server.heads.get("d.md")!.data), "local only");
	assert.equal(server.heads.get("a.md")!.revision, aRev);
	// 本地跟踪状态与远端一致，后续普通同步无事可做
	assert.equal(ctx.store.get("b.md")!.revision, server.heads.get("b.md")!.revision);
	assert.equal(ctx.store.get("c.md"), undefined);
	assert.ok(ctx.store.get("d.md")!.fileId);
	assert.equal(ctx.store.state.replaceJob?.state, "completed", "作业状态已落盘");
});

test("中断续跑：提交后响应丢失 → interrupted；续跑用同一 operationId，不产生第二个 revision", async () => {
	const { server, job, ctx } = await prepared();
	server.loseResponseOnWrite = 1; // 第一个写入（b.md 覆盖）提交了，但响应丢了
	await assert.rejects(runReplaceJob(ctx, job), /response lost/);
	assert.equal(job.state, "interrupted");
	assert.equal(server.heads.get("b.md")!.revision, 2, "服务器上已经提交过一次");
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed");
	assert.equal(server.heads.get("b.md")!.revision, 2, "续跑没有再写一次");
});

test("删除的响应丢失：续跑撞上自己的墓碑 → 按结果判定已完成", async () => {
	const { server, job, ctx } = await prepared();
	server.loseResponseOnWrite = 3; // 第三个写入是 c.md 的删除（覆盖 b.md → 新建 d.md → 删除 c.md）
	await assert.rejects(runReplaceJob(ctx, job), /response lost/);
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed");
	assert.equal(server.heads.get("c.md")!.revision, 2, "只有一次删除");
});

test("并发保护：预览之后远端被其他设备修改 → paused_stale，对方的内容原样保留", async () => {
	const { server, job, ctx } = await prepared();
	const other = server.client();
	const cur = server.heads.get("b.md")!;
	await other.upload("b.md", cur.revision, await sha256Hex(enc("someone else")), enc("someone else"), 1, "upsert");
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "paused_stale");
	assert.equal(dec(server.heads.get("b.md")!.data), "someone else", "绝不覆盖别人刚写的内容");
	assert.equal(job.items.find((i) => i.path === "c.md")!.status, "pending", "后续条目不再继续");
	await assert.rejects(runReplaceJob(ctx, { ...job, state: "planned" }), /状态/);
});

test("并发保护：本地在预览之后又被改了 → paused_stale（预览不再代表要执行的动作）", async () => {
	const { vault, job, ctx } = await prepared();
	vault.put("b.md", "edited after preview");
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "paused_stale");
	assert.match(r.reason ?? "", /本地文件在预览之后又改动了/);
});

test("水位检查：计划之后出现与本作业无关的外来变更 → paused_stale，要求重新预览", async () => {
	const { server, job, ctx } = await prepared();
	await server.seedAsync("e.md", "created by another device after preview");
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "paused_stale");
	assert.match(r.reason ?? "", /1 条不是本作业写入的变更/);
});

test("墓碑路径上的本地独有文件：显式 restore 后再上传，身份连续（不新造对象）", async () => {
	const server = new FakeServer();
	await server.seedAsync("keep.md", "k");
	const gone = await server.seedAsync("revived.md", "old content");
	await server.client().remove("revived.md", 1);
	const vault = new MemVault();
	vault.put("keep.md", "k");
	vault.put("revived.md", "new local content");
	const ctx = await makeCtx(server, vault);
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false });
	assert.equal(job.items.find((i) => i.path === "revived.md")!.action, "create");
	confirmReplaceJob(job, "v", 1);
	await saveRecoveryPoint(ctx, job);
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed");
	const h = server.heads.get("revived.md")!;
	assert.equal(h.deleted, false);
	assert.equal(h.fileId, gone.fileId, "恢复的是原对象（INV-05），历史连续");
	assert.equal(dec(h.data), "new local content");
});

test("回归（0.20 修复）：安全合并遇到本地独有文件撞远端墓碑 → 显式 restore 后上传，不再死撞 409", async () => {
	const server = new FakeServer();
	const gone = await server.seedAsync("revived.md", "old content");
	await server.client().remove("revived.md", 1);
	const vault = new MemVault();
	vault.put("revived.md", "different new content");
	const ctx = await makeCtx(server, vault);
	ctx.store.state.bootstrap = { status: "pending", remoteVaultId: server.vaultId, repoEpoch: server.repoEpoch, keyEpoch: 1, metaState: "plain" };
	const info = await server.client().info();
	const r = await bootstrapMerge(
		ctx,
		{ info, snapshotSequence: server.seq, repoEpoch: server.repoEpoch, remoteFiles: [], localPaths: ["revived.md"], commonCount: 0, e2eeEnabled: false },
		() => {},
	);
	assert.equal(r.uploaded, 1);
	const h = server.heads.get("revived.md")!;
	assert.equal(h.deleted, false);
	assert.equal(h.fileId, gone.fileId, "恢复原对象，身份与历史连续（INV-05 / INV-06）");
	assert.equal(dec(h.data), "different new content");
});

// ---------- 反向作业 ----------

test("反向作业：远端恢复到替换之前（新 revision，计数器不回退）；本设备的副本先备份", async () => {
	const { server, vault, job, ctx } = await prepared();
	await runReplaceJob(ctx, job);
	const revB = server.heads.get("b.md")!.revision;
	const revC = server.heads.get("c.md")!.revision;

	const rev = buildReverseJob(job, 10);
	assert.equal(rev.kind, "reverse");
	assert.deepEqual(rev.counts, { create: 1, update: 1, delete: 1, keep: 0, outOfScope: 1 });
	await refreshReverseWatermark(ctx, rev);
	assert.equal(confirmReplaceJob(rev, "个人笔记", 11).ok, true);
	await saveRecoveryPoint(ctx, rev);
	const r = await runReplaceJob(ctx, rev);
	assert.equal(r.state, "completed");

	const b = server.heads.get("b.md")!;
	assert.equal(dec(b.data), "remote version", "覆盖被撤回");
	assert.ok(b.revision > revB, "撤回是新 revision，不回退");
	const c = server.heads.get("c.md")!;
	assert.equal(c.deleted, false);
	assert.equal(dec(c.data), "remote only", "被删除的远端文件按恢复点重建");
	assert.ok(c.revision > revC);
	assert.equal(server.heads.get("d.md")!.deleted, true, "原作业新建的远端文件被删除（留 tombstone）");

	// 反向作业只动远端：本地文件原样，备份已写进恢复目录，随后由普通同步跟随远端
	assert.equal(dec(vault.files.get("b.md")!), "local version");
	const backups = [...vault.files.keys()].filter((p) => p.includes(`replace-recovery/${rev.jobId}/local-before-reverse/`));
	assert.equal(backups.length, 2, "b.md 与 d.md 的本地副本已备份");
	assert.equal(ctx.store.get("b.md")!.revision, revB, "跟踪状态停在回滚之前：普通同步会把恢复后的远端拉回本地");
});

// ---------- E2EE ----------

test("E2EE：新建条目的 fileId 在计划里固定；响应丢失后重试沿用同一身份", async () => {
	const server = new FakeServer();
	await server.seedAsync("seed.md", "plain seed is fine for the fake");
	const vault = new MemVault();
	vault.put("seed.md", "plain seed is fine for the fake");
	vault.put("new.md", "secret note");
	const keyring = new Keyring();
	const { doc, vmk } = await createVaultKeyDoc("pw-for-test");
	doc.enabled = true;
	keyring.adopt(doc, vmk);
	const ctx = await makeCtx(server, vault, keyring);
	// 种子文件是明文：E2EE 仓库里出现明文会被 decode 拒绝——测试只让新文件参与，种子在计划前跟踪好
	ctx.store.update("seed.md", { hash: await sha256Hex(enc("plain seed is fine for the fake")), serverHash: server.heads.get("seed.md")!.hash, revision: 1, fileId: server.heads.get("seed.md")!.fileId });
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false });
	const item = job.items.find((i) => i.path === "new.md")!;
	assert.match(item.fileId ?? "", /^[0-9a-f]{32}$/, "计划里已固定 fileId");
	confirmReplaceJob(job, "v", 1);
	await saveRecoveryPoint(ctx, job);
	server.loseResponseOnWrite = 1;
	await assert.rejects(runReplaceJob(ctx, job), /response lost/);
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed");
	const h = server.heads.get("new.md")!;
	assert.equal(h.fileId, item.fileId, "服务器上的对象就是计划时的身份");
	assert.equal(h.revision, 1, "没有第二个对象、没有第二个 revision");
	assert.ok(parseLse3Header(h.data), "上传的是 LSE3 密文");
});

// ---------- 0.20.1 阶段保护 ----------

test("阶段保护：执行入口关闭时只读预览照常、正向执行不可用；未完成作业仍可放弃、已完成部分仍可回滚", async () => {
	const off = replaceCapabilities(null, false);
	assert.deepEqual(off, { preview: true, executeForward: false, resume: false, abandon: false, reverse: false });
	assert.equal(replaceCapabilities(null, true).executeForward, true);

	const { job, ctx } = await prepared();
	// 中断的正向作业：关闭时不能续跑，但能放弃；有已完成条目时能回滚
	job.state = "interrupted";
	job.items[0].status = "done";
	const caps = replaceCapabilities(job, false);
	assert.equal(caps.resume, false, "续跑正向作业需要显式开启");
	assert.equal(caps.abandon, true, "放弃不受开关限制");
	assert.equal(caps.reverse, true, "回滚（恢复方向）不受开关限制");
	assert.equal(replaceCapabilities(job, true).resume, true);

	// 未完成的反向作业：恢复方向，开关关闭也能续跑
	job.items.forEach((i) => (i.status = "done"));
	job.state = "completed";
	const rev = buildReverseJob(job, 5);
	rev.state = "interrupted";
	assert.equal(replaceCapabilities(rev, false).resume, true);
	assert.equal(replaceCapabilities(rev, false).reverse, false, "反向作业自己不再生成反向");
	void ctx;
});
