// 0.20.1 复审 PL-02～PL-05（批次 R-B / RB-2）：「用本地完整替换远端」的执行许可、本地前置条件、
// restore→upload 持久化子状态机，以及路径加密 / 内容加密两种仓库上的全组合（ADR-016 §5.1–§5.3）。
//
// 覆盖：
//   执行许可（PL-03）：预览后 gate 变化 → 确认被拒；续跑时 gate 已阻断 → 零写入、状态可诊断；
//     状态损坏 / repoEpoch / 别的迁移持锁 → 挡停；自己持有的迁移锁 → 放行；作业中锁定 / 换连接 → 之后零写入；
//     接入向导里的作业只豁免 bootstrap-pending 与未绑定，完整性照样挡停；计划与恢复点同样过许可
//   本地前置条件（PL-04）：keep 改动 / 删除、update 改名、create 改动 → 写入之前暂停；执行中途改动 → 停在该条
//   restore→upload（PL-05）：restore 请求前、服务端提交后响应前、客户端结果落盘前、最终上传响应后、
//     最终上传响应丢失——五个故障点各自「重启」（从落盘状态重新加载作业）后续跑：只恢复一次、只上传一次，
//     不重复复活、不丢本地替换内容、自己的 restore 不算外来写入；明文与路径加密两种仓库都跑
//   仅大小写不同的改名：正向（删 Note.md、在 note.md 上恢复同一对象）与反向（删 note.md、在 Note.md 上重建）都完成
//   全组合（路径加密 / 内容加密）：update + delete + create + keep + 新建撞墓碑，执行中响应丢失与请求未达各一次，
//     续跑完成；反向作业中 restore 响应丢失，续跑完成；逐个对象解密核对内容、fileId 与世代
//
// INV: INV-03（前置条件不满足绝不写）/ INV-05（身份由 fileId 决定，恢复与改名不重置）/ INV-09（状态损坏停机）/ INV-10（换连接后不再写）/ INV-11（作业可恢复、可重复、幂等）
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import {
	buildReverseJob,
	confirmReplaceJob,
	confirmReplaceJobChecked,
	planReplaceRemote,
	refreshReverseWatermark,
	REPLACE_LOCK_OWNER,
	ReplaceJobError,
	runReplaceJob,
	saveRecoveryPoint,
} from "../src/bootstrap/replace-remote";
import type { ReplaceJob } from "../src/bootstrap/replace-types";
import { createVaultKeyDoc, decryptFileV3, decryptMeta, MetaKeys, VaultKeyDoc } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import type { SyncContext } from "../src/sync/context";
import { enableFailpoint, FP, resetFailpoints } from "../src/utils/failpoint";
import { dec, FakeServer, Head, makeCtx, MemVault } from "./fakes/replace-server";

afterEach(() => resetFailpoints());

type Mode = "plain" | "content-e2ee" | "path-e2ee";

interface World {
	mode: Mode;
	server: FakeServer;
	vault: MemVault;
	ctx: SyncContext;
	kr: Keyring;
	doc?: VaultKeyDoc;
	vmk?: CryptoKey;
	keys?: MetaKeys;
}

async function world(mode: Mode): Promise<World> {
	const server = new FakeServer();
	server.metaState = mode === "path-e2ee" ? "encrypted" : "plain";
	const vault = new MemVault();
	const kr = new Keyring();
	if (mode === "plain") return { mode, server, vault, kr, ctx: await makeCtx(server, vault, kr) };
	const { doc, vmk } = await createVaultKeyDoc("test-password");
	doc.enabled = true;
	kr.adopt(doc, vmk);
	const ctx = await makeCtx(server, vault, kr, { metaState: server.metaState });
	return { mode, server, vault, kr, ctx, doc, vmk, keys: await kr.metaKeys() };
}

/** 种一个远端对象；返回服务器寻址名与 head。 */
async function seed(w: World, path: string, content: string): Promise<[string, Head]> {
	if (w.mode === "plain") return [path, await w.server.seedAsync(path, content)];
	return w.server.seedE2ee(path, content, w.vmk!, w.keys!);
}

/** 逐对象解密核对：内容（E2EE 下 AAD 绑定 fileId）与 meta 模式下的真实路径。 */
async function readRemote(w: World, key: string): Promise<{ text: string; generation: number; path?: string; head: Head }> {
	const head = w.server.heads.get(key)!;
	if (w.mode === "plain") return { text: dec(head.data), generation: 0, head };
	const plain = await decryptFileV3(w.vmk!, head.data, w.server.vaultId, head.fileId, 1);
	assert.ok(plain, `密文可以用本地钥匙解开（${key}）`);
	let path: string | undefined;
	if (w.mode === "path-e2ee") {
		const meta = await decryptMeta(w.keys!, head.metaEnc!, w.server.vaultId, head.fileId);
		assert.ok(meta, "元数据可以解开");
		assert.equal(meta.metaGeneration, head.metaGeneration, "LSM1 信封里的元数据世代与服务器一致");
		path = meta.meta.path;
	}
	return { text: dec(plain.plain), generation: plain.generation, path, head };
}

/** 「重启」：同一个 Vault（状态文件在里面）重新加载一个 StateStore，钥匙重新解锁。 */
async function restart(w: World): Promise<{ ctx: SyncContext; job: ReplaceJob }> {
	const kr = new Keyring();
	if (w.doc && w.vmk) kr.adopt(w.doc, w.vmk);
	const ctx = await makeCtx(w.server, w.vault, kr, { loadOnly: true, metaState: w.server.metaState });
	const job = ctx.store.state.replaceJob;
	assert.ok(job, "作业已落盘，重启后还在");
	w.ctx = ctx;
	w.kr = kr;
	return { ctx, job };
}

async function plan(w: World, name = "v"): Promise<ReplaceJob> {
	const job = await planReplaceRemote(w.ctx, { vaultName: name, vaultChoice: "", bootstrapContext: false });
	assert.deepEqual(confirmReplaceJob(job, name, 1), { ok: true });
	await saveRecoveryPoint(w.ctx, job);
	return job;
}

/** 典型场景：a 一致、b 不同、c 只在远端、d 只在本地。 */
async function typical(mode: Mode = "plain") {
	const w = await world(mode);
	await seed(w, "a.md", "same");
	await seed(w, "b.md", "remote version");
	await seed(w, "c.md", "remote only");
	w.vault.put("a.md", "same");
	w.vault.put("b.md", "local version");
	w.vault.put("d.md", "local only");
	return w;
}

// ---------- 执行许可（PL-03） ----------

test("许可：预览之后凭据被拒 → 确认被拒，作业停在 planned（预览之后才出现的停机在确认前挡住）", async () => {
	const w = await typical();
	const job = await planReplaceRemote(w.ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false });
	w.ctx.gate.markCredentialRejected("设备凭据已失效");
	const r = confirmReplaceJobChecked(w.ctx, job, "v", 1);
	assert.equal(r.ok, false);
	assert.match(r.ok === false ? r.reason : "", /无法确认/);
	assert.equal(job.state, "planned");
});

test("许可：续跑时 gate 已阻断（协议不兼容）→ 零写入，作业保持 interrupted，原因可诊断", async () => {
	const w = await typical();
	const job = await plan(w);
	w.server.loseResponseOnWrite = 1;
	await assert.rejects(runReplaceJob(w.ctx, job), /response lost/);
	const writes = w.server.writeRequests().length;
	w.ctx.gate.markProtocolMismatch("服务器协议版本过新");
	await assert.rejects(runReplaceJob(w.ctx, job), (e: unknown) => e instanceof ReplaceJobError && e.blockReason === "protocol-mismatch");
	assert.equal(w.server.writeRequests().length, writes, "被挡下之后没有任何新写入");
	assert.equal(job.state, "interrupted");
	assert.equal(job.lastBlock?.reason, "protocol-mismatch");
	w.ctx.gate.markProtocolMismatch(null);
	assert.equal((await runReplaceJob(w.ctx, job)).state, "completed", "问题解除后同一作业续跑完成");
});

test("许可：状态损坏 / repoEpoch 不符 / 别的迁移持锁 → 预览、恢复点、执行一律挡停；自己的迁移锁放行", async () => {
	const w = await typical();
	const job = await planReplaceRemote(w.ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false });
	confirmReplaceJob(job, "v", 1);

	w.ctx.store.corrupted = true;
	await assert.rejects(planReplaceRemote(w.ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false }), /状态文件损坏/);
	await assert.rejects(saveRecoveryPoint(w.ctx, job), (e: unknown) => e instanceof ReplaceJobError && e.blockReason === "state-corrupted");
	w.ctx.store.corrupted = false;

	w.ctx.gate.markRepoEpochMismatch("服务器数据已从备份恢复");
	await assert.rejects(saveRecoveryPoint(w.ctx, job), (e: unknown) => e instanceof ReplaceJobError && e.blockReason === "repo-epoch-mismatch");
	w.ctx.gate.markRepoEpochMismatch(null);

	w.ctx.gate.beginMigration("路径与文件名加密迁移");
	await assert.rejects(saveRecoveryPoint(w.ctx, job), (e: unknown) => e instanceof ReplaceJobError && e.blockReason === "migration-active");
	w.ctx.gate.endMigration();

	w.ctx.gate.beginMigration("「用本地完整替换远端」作业", REPLACE_LOCK_OWNER);
	await saveRecoveryPoint(w.ctx, job);
	assert.equal((await runReplaceJob(w.ctx, job)).state, "completed", "作业自己持有的迁移锁被豁免");
	assert.equal(w.server.writeRequests().length, 3);
});

test("许可：作业中用户锁定仓库 → 之后的条目零写入；重新解锁、重新签发许可后续跑完成", async () => {
	const w = await typical("content-e2ee");
	const job = await plan(w);
	const client = w.ctx.client as unknown as { upload: (...a: unknown[]) => Promise<unknown> };
	const realUpload = client.upload.bind(client);
	let n = 0;
	client.upload = async (...a: unknown[]) => {
		const r = await realUpload(...a);
		if (++n === 1) w.kr.lock(); // 第一个写入完成后用户点了「锁定」
		return r;
	};
	await assert.rejects(runReplaceJob(w.ctx, job), (e: unknown) => e instanceof ReplaceJobError && e.blockReason === "key-locked");
	assert.equal(w.server.writeRequests().length, 1, "锁定之后一个字节都没再写");
	assert.equal(job.state, "interrupted");
	w.kr.adopt(w.doc!, w.vmk!);
	assert.equal((await runReplaceJob(w.ctx, job)).state, "completed");
});

test("许可：作业中换了连接（服务器 / 凭据 / 仓库）→ 之后的条目零写入", async () => {
	const w = await typical();
	const job = await plan(w);
	const client = w.ctx.client as unknown as { upload: (...a: unknown[]) => Promise<unknown> };
	const realUpload = client.upload.bind(client);
	client.upload = async (...a: unknown[]) => {
		const r = await realUpload(...a);
		w.kr.switchContext({ lock: false }); // 用户改了 Token
		return r;
	};
	await assert.rejects(runReplaceJob(w.ctx, job), (e: unknown) => e instanceof ReplaceJobError && e.blockReason === "context-changed");
	assert.equal(w.server.writeRequests().length, 1);
	assert.equal(job.state, "interrupted");
	assert.equal(job.lastBlock?.reason, "context-changed");
});

test("许可：接入向导里的作业只豁免 bootstrap-pending 与未绑定；完整性照样挡停；接入状态变了也挡停", async () => {
	const server = new FakeServer();
	await server.seedAsync("a.md", "remote");
	const vault = new MemVault();
	vault.put("a.md", "local");
	const ctx = await makeCtx(server, vault, new Keyring(), { bootstrap: "pending" });
	assert.equal(ctx.gate.isUnbound, true, "向导期间尚未正式绑定");
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: true });
	confirmReplaceJob(job, "v", 1);
	ctx.gate.markIntegrityError("服务器换掉了 fileId");
	await assert.rejects(saveRecoveryPoint(ctx, job), (e: unknown) => e instanceof ReplaceJobError && e.blockReason === "integrity-error");
	ctx.gate.clearIntegrityError();
	await saveRecoveryPoint(ctx, job);
	ctx.store.state.bootstrap.status = "ready";
	await assert.rejects(runReplaceJob(ctx, job), (e: unknown) => e instanceof ReplaceJobError && e.blockReason === "bootstrap-changed");
	ctx.store.state.bootstrap.status = "pending";
	assert.equal((await runReplaceJob(ctx, job)).state, "completed");
	assert.equal(dec(server.heads.get("a.md")!.data), "local");
});

// ---------- 本地前置条件（PL-04） ----------

for (const [name, mutate, expect] of [
	["keep 条目在预览之后被改动", (v: MemVault) => v.put("a.md", "changed"), /预览时它与远端一致/],
	["keep 条目在预览之后被删除", (v: MemVault) => void v.files.delete("a.md"), /被删除了/],
	["update 条目被改名（旧路径不在了）", (v: MemVault) => {
		v.files.set("b-renamed.md", v.files.get("b.md")!);
		v.files.delete("b.md");
	}, /被删除了（或被改名）/],
	["create 条目在预览之后被改动", (v: MemVault) => v.put("d.md", "edited again"), /又改动了/],
] as const) {
	test(`前置条件：${name} → 写入之前暂停，要求重新预览，零写入`, async () => {
		const w = await typical();
		const job = await plan(w);
		mutate(w.vault);
		const r = await runReplaceJob(w.ctx, job);
		assert.equal(r.state, "paused_stale");
		assert.match(r.reason ?? "", expect);
		assert.equal(w.server.writeRequests().length, 0);
	});
}

test("前置条件：执行中途改动了一个还没轮到的文件 → 停在那一条；之前完成的保留，之后的不写", async () => {
	const w = await typical();
	const job = await plan(w);
	const client = w.ctx.client as unknown as { upload: (...a: unknown[]) => Promise<unknown> };
	const realUpload = client.upload.bind(client);
	let n = 0;
	client.upload = async (...a: unknown[]) => {
		const r = await realUpload(...a);
		if (++n === 1) w.vault.put("d.md", "edited while the job ran"); // b.md 覆盖完，d.md 还没轮到
		return r;
	};
	const r = await runReplaceJob(w.ctx, job);
	assert.equal(r.state, "paused_stale");
	assert.equal(job.items.find((i) => i.path === "b.md")!.status, "done");
	assert.equal(job.items.find((i) => i.path === "d.md")!.status, "stale");
	assert.equal(w.server.heads.get("c.md")!.deleted, false, "排在后面的删除没有执行");
	assert.equal(w.server.writeRequests().length, 1);
});

// ---------- restore→upload 持久化子状态机（PL-05） ----------

const FAULTS = [
	"restore 请求前（意图已落盘）",
	"服务端提交 restore 后、响应前",
	"restore 结果到达、客户端落盘前",
	"最终上传响应到达、条目落盘前",
	"最终上传提交后、响应丢失",
] as const;

for (const mode of ["plain", "path-e2ee"] as const) {
	for (const fault of FAULTS) {
		test(`restore→upload（${mode}）：故障点「${fault}」→ 重启后续跑：只恢复一次、只上传一次，内容是本地替换内容`, async () => {
			const w = await world(mode);
			await seed(w, "seed.md", "same");
			const [goneKey, gone] = await seed(w, "resurrect.md", "old");
			await w.server.client().remove(goneKey, 1);
			w.server.writes = 0;
			w.vault.put("seed.md", "same");
			w.vault.put("resurrect.md", "replacement");
			const job = await plan(w);
			const writesBefore = w.server.writes;
			if (fault === FAULTS[0]) enableFailpoint(FP.replaceBeforeRestore, 1);
			if (fault === FAULTS[1]) w.server.loseResponseOnWrite = writesBefore + 1; // 第一次写入就是 restore
			if (fault === FAULTS[2]) enableFailpoint(FP.replaceBeforeRestorePersist, 1);
			if (fault === FAULTS[3]) enableFailpoint(FP.replaceAfterUpload, 1);
			if (fault === FAULTS[4]) w.server.loseResponseOnWrite = writesBefore + 2; // restore 之后的那次上传
			await assert.rejects(runReplaceJob(w.ctx, job));
			w.server.loseResponseOnWrite = -1;

			const { ctx, job: again } = await restart(w);
			assert.equal(again.jobId, job.jobId, "续跑的是同一个作业");
			assert.equal(again.state, "interrupted");
			const r = await runReplaceJob(ctx, again);
			assert.equal(r.state, "completed", `续跑完成（${r.reason ?? ""}）`);

			const key = mode === "plain" ? "resurrect.md" : gone.fileId;
			const remote = await readRemote(w, key);
			assert.equal(remote.text, "replacement", "不是被复活的旧内容");
			assert.equal(remote.head.fileId, gone.fileId, "恢复的是原对象（INV-05）");
			if (mode === "path-e2ee") assert.equal(remote.path, "resurrect.md");
			const restores = w.server.changes.filter((c) => c.action === "restore" && c.fileId === gone.fileId);
			assert.equal(restores.length, 1, "没有重复复活");
			const uploadsAfter = w.server.changes.filter(
				(c) => c.action === "upsert" && c.fileId === gone.fileId && c.sequence > restores[0].sequence,
			);
			assert.equal(uploadsAfter.length, 1, "最终上传只产生一个 revision");
			assert.equal(remote.head.revision, restores[0].revision + 1);
			if (mode === "path-e2ee") assert.ok(remote.generation > 1, "内容世代前进");
		});
	}
}

// ---------- 仅大小写不同的改名 ----------

for (const mode of ["plain", "path-e2ee"] as const) {
	test(`仅大小写不同的改名（${mode}）：正向删 Note.md、在 note.md 上恢复同一对象；反向删 note.md、在 Note.md 上重建`, async () => {
		const w = await world(mode);
		const [origKey, orig] = await seed(w, "Note.md", "original");
		w.vault.put("note.md", "renamed locally");
		const job = await plan(w);
		assert.deepEqual(job.items.map((i) => `${i.action}:${i.path}`), ["delete:Note.md", "create:note.md"], "要占用被删对象名字的新建排在删除之后");
		const r = await runReplaceJob(w.ctx, job);
		assert.equal(r.state, "completed", r.reason);
		const live = [...w.server.heads.entries()].filter(([, h]) => !h.deleted);
		assert.equal(live.length, 1);
		const [liveKey, liveHead] = live[0];
		assert.equal(liveHead.fileId, orig.fileId, "改名不换身份（INV-05）");
		const now = await readRemote(w, liveKey);
		assert.equal(now.text, "renamed locally");
		if (mode === "path-e2ee") assert.equal(now.path, "note.md");
		else assert.equal(liveKey, "note.md");

		const rev = buildReverseJob(job, 5);
		await refreshReverseWatermark(w.ctx, rev);
		confirmReplaceJob(rev, "v", 6);
		await saveRecoveryPoint(w.ctx, rev);
		const rr = await runReplaceJob(w.ctx, rev);
		assert.equal(rr.state, "completed", rr.reason);
		const back = [...w.server.heads.entries()].filter(([, h]) => !h.deleted);
		assert.equal(back.length, 1);
		assert.equal(back[0][1].fileId, orig.fileId);
		const restored = await readRemote(w, back[0][0]);
		assert.equal(restored.text, "original", "回到替换之前的内容");
		if (mode === "path-e2ee") assert.equal(restored.path, "Note.md");
		else assert.equal(back[0][0], "Note.md");
		void origKey;
	});
}

test("大小写不敏感的文件系统（Windows / macOS）：本地 case.md 对远端 Case.md——计划按确切名字对齐，仍是「删 + 在新名字上恢复同一对象」", async () => {
	const server = new FakeServer();
	const orig = await server.seedAsync("Case.md", "original");
	const vault = new MemVault({ caseInsensitive: true });
	vault.put("case.md", "renamed locally");
	assert.ok(await vault.adapter.stat("Case.md"), "前提：stat 找得到大小写不同的本地文件");
	const ctx = await makeCtx(server, vault);
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false });
	assert.deepEqual(job.items.map((i) => `${i.action}:${i.path}`), ["delete:Case.md", "create:case.md"], "不会误判成覆盖 Case.md 再多建一个 case.md");
	confirmReplaceJob(job, "v", 1);
	await saveRecoveryPoint(ctx, job);
	const r = await runReplaceJob(ctx, job);
	assert.equal(r.state, "completed", r.reason);
	assert.equal(server.heads.get("case.md")?.fileId, orig.fileId);
	assert.equal(dec(server.heads.get("case.md")!.data), "renamed locally");
});

test("接入向导里的正向作业完成接入之后，回滚是普通（已接入）作业——不会被「接入状态已变」挡死", async () => {
	const server = new FakeServer();
	await server.seedAsync("a.md", "remote");
	const vault = new MemVault();
	vault.put("a.md", "local");
	const ctx = await makeCtx(server, vault, new Keyring(), { bootstrap: "pending" });
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: true });
	confirmReplaceJob(job, "v", 1);
	await saveRecoveryPoint(ctx, job);
	assert.equal((await runReplaceJob(ctx, job)).state, "completed");
	ctx.store.state.bootstrap.status = "ready"; // 向导以 local-replace 完成了接入
	ctx.gate.markBound();
	const inherited = buildReverseJob(job, 2);
	assert.equal(inherited.bootstrapContext, true, "不传参数时沿用原作业（向导里放弃后回滚的情形）");
	const rev = buildReverseJob(job, 2, { bootstrapContext: !ctx.store.bootstrapReady });
	assert.equal(rev.bootstrapContext, false);
	await refreshReverseWatermark(ctx, rev);
	confirmReplaceJob(rev, "v", 3);
	await saveRecoveryPoint(ctx, rev);
	assert.equal((await runReplaceJob(ctx, rev)).state, "completed");
	assert.equal(dec(server.heads.get("a.md")!.data), "remote");
});

// ---------- 全组合（路径加密 / 内容加密） ----------

for (const mode of ["path-e2ee", "content-e2ee"] as const) {
	test(`全组合（${mode}）：覆盖 + 删除 + 新建 + 不变 + 新建撞墓碑，部分失败后续跑；反向作业 restore 丢响应后续跑；逐个解密核对`, async () => {
		const w = await world(mode);
		const [aKey] = await seed(w, "keep.md", "same");
		const [bKey, b] = await seed(w, "edit.md", "remote edit v1");
		const [cKey, c] = await seed(w, "dir/remote-only.md", "remote only private");
		const [tKey, t] = await seed(w, "tomb.md", "deleted long ago");
		await w.server.client().remove(tKey, 1);
		w.server.writes = 0;
		w.vault.put("keep.md", "same");
		w.vault.put("edit.md", "local edit v2");
		w.vault.put("new/local-only.md", "brand new");
		w.vault.put("tomb.md", "recreated locally");
		const job = await plan(w);
		assert.deepEqual(job.counts, { create: 2, update: 1, delete: 1, keep: 1, outOfScope: 0 });

		// 第 2 个写入响应丢失、第 3 个写入根本没到服务器：两次中断，同一作业两次续跑
		w.server.loseResponseOnWrite = 2;
		await assert.rejects(runReplaceJob(w.ctx, job), /response lost/);
		w.server.failBeforeWrite = w.server.writes + 1;
		await assert.rejects(runReplaceJob(w.ctx, job), /connection reset/);
		const { ctx, job: again } = await restart(w);
		const r = await runReplaceJob(ctx, again);
		assert.equal(r.state, "completed", r.reason);

		const kept = await readRemote(w, aKey);
		assert.equal(kept.text, "same");
		assert.equal(kept.head.revision, 1, "不变的文件一个字节都没写");
		const edited = await readRemote(w, bKey);
		assert.equal(edited.text, "local edit v2");
		assert.equal(edited.head.fileId, b.fileId);
		assert.equal(edited.head.revision, 2, "覆盖只产生一个 revision（响应丢失后的重试被幂等吸收）");
		assert.ok(edited.generation >= 2);
		assert.equal(w.server.heads.get(cKey)!.deleted, true);
		const createdItem = again.items.find((i) => i.path === "new/local-only.md")!;
		const createdKey = mode === "path-e2ee" ? createdItem.fileId! : "new/local-only.md";
		const created = await readRemote(w, createdKey);
		assert.equal(created.text, "brand new");
		assert.equal(created.head.fileId, createdItem.fileId, "新对象就是计划里预留的身份");
		if (mode === "path-e2ee") assert.equal(created.path, "new/local-only.md");
		const revived = await readRemote(w, tKey);
		assert.equal(revived.text, "recreated locally");
		assert.equal(revived.head.fileId, t.fileId, "撞墓碑的新建恢复的是原对象");
		if (mode === "path-e2ee") assert.equal(revived.path, "tomb.md");
		assert.equal(ctx.store.get("new/local-only.md")?.fileId, createdItem.fileId);
		assert.equal(ctx.store.get("dir/remote-only.md"), undefined);

		// 反向作业：restore（被删的 dir/remote-only.md）响应丢失
		const rev = buildReverseJob(again, 10);
		await refreshReverseWatermark(ctx, rev);
		confirmReplaceJob(rev, "v", 11);
		await saveRecoveryPoint(ctx, rev);
		const restoreIndex = rev.items.findIndex((i) => i.action === "restore");
		assert.ok(restoreIndex >= 0);
		w.server.loseResponseOnWrite = w.server.writes + 1 + rev.items.slice(0, restoreIndex).length;
		await assert.rejects(runReplaceJob(ctx, rev), /response lost/);
		const { ctx: ctx2, job: rev2 } = await restart(w);
		assert.equal(rev2.kind, "reverse");
		const rr = await runReplaceJob(ctx2, rev2);
		assert.equal(rr.state, "completed", rr.reason);

		const editBack = await readRemote(w, bKey);
		assert.equal(editBack.text, "remote edit v1", "覆盖被撤回");
		assert.ok(editBack.head.revision > 2, "撤回是新 revision，不回退");
		assert.ok(editBack.generation > edited.generation, "内容世代继续前进");
		const onlyBack = await readRemote(w, cKey);
		assert.equal(onlyBack.text, "remote only private", "被删的远端文件按恢复点重建");
		assert.equal(onlyBack.head.fileId, c.fileId);
		if (mode === "path-e2ee") assert.equal(onlyBack.path, "dir/remote-only.md");
		assert.equal(w.server.changes.filter((x) => x.action === "restore" && x.fileId === c.fileId).length, 1, "只恢复了一次");
		assert.equal(w.server.heads.get(createdKey)!.deleted, true, "原作业新建的被删除");
		assert.equal(w.server.heads.get(tKey)!.deleted, true, "原作业复活的墓碑对象回到删除状态");
		if (mode === "path-e2ee") {
			assert.ok(w.server.requests.every((q) => q.path === "" || /^[0-9a-f]{32}$/.test(q.path)), "全程没有真实路径进入请求");
		}
	});
}
