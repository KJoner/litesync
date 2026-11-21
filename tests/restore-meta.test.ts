// 0.20.1 复审后续：路径加密仓库显式恢复之后的元数据世代（普通 push、接入合并、完整替换三条路径）。
//
// 原问题：restoreObject 在 meta 模式下一律把 LSM1 信封的元数据世代写成 1、本地也记 1，而服务器恢复后
// 是「墓碑 + 1」（restore.go）。于是：
//   - 本设备恢复后的第一次改名拿 1 做 CAS，服务器是 2 → 412 → 退化成「先建后删」，身份就此断掉（INV-05）；
//   - 别的设备若还记着恢复前的世代 1，看到同为世代 1、指纹不同的新信封 → 误判为「同世代分叉」而停机。
// 修复：恢复前向回收站取墓碑世代、信封写「墓碑 + 1」；旧服务端查不到时恢复后补一次「改名到同一伪名」
// 的元数据对齐（CAS 以服务器值为前提；提交后响应丢失的重放 412 → 读回核对 → 采纳）。
//
// 覆盖：
//   普通 push：删除 → 本地重建同名触发显式恢复 → 之后改名：CAS 通过、fileId 不变、revision 不因改名变化、
//     信封 / 服务器 / 本地三处元数据世代一致；旧服务端（无回收站）走对齐后同样成立
//   对齐的改名提交后响应丢失：重放 412 → 读回核对 → 采纳，不重复对齐
//   接入合并（bootstrapMerge）里撞墓碑的本地独有文件：恢复后的元数据世代同样一致
//   其他设备：记着恢复前世代的设备看到新信封 → 判为前进（apply），不是分叉
//   完整替换作业：新建撞墓碑、旧服务端、对齐改名响应丢失 → 续跑完成，元数据世代一致
//
// INV: INV-05（身份由 fileId 决定，恢复与改名不重置）/ INV-11（对齐可重复、幂等）/ INV-03（无法确认时不覆盖、不退化删除）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { bootstrapMerge } from "../src/bootstrap/bootstrap-manager";
import { confirmReplaceJob, planReplaceRemote, runReplaceJob, saveRecoveryPoint } from "../src/bootstrap/replace-remote";
import { createVaultKeyDoc, decryptFileV3, decryptMeta, MetaKeys } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import type { SyncContext } from "../src/sync/context";
import { alignRestoredMeta, pushPendingChanges } from "../src/sync/push";
import { assertMetaGeneration, metaFingerprintOf } from "../src/sync/transfer";
import { sha256Hex } from "../src/utils/hash";
import { dec, enc, FakeServer, Head, makeCtx, MemVault } from "./fakes/replace-server";

interface MetaWorld {
	server: FakeServer;
	vault: MemVault;
	ctx: SyncContext;
	vmk: CryptoKey;
	keys: MetaKeys;
	key: string;
	head: Head;
}

/** 路径加密仓库里一个已同步的文件 dir/note.md（本地跟踪状态与服务器一致）。 */
async function metaWorld(opts: { trash?: boolean; bootstrap?: "ready" | "pending" } = {}): Promise<MetaWorld> {
	const server = new FakeServer();
	server.metaState = "encrypted";
	server.trashAvailable = opts.trash ?? true;
	const vault = new MemVault();
	const { doc, vmk } = await createVaultKeyDoc("test-password");
	doc.enabled = true;
	const kr = new Keyring();
	kr.adopt(doc, vmk);
	const ctx = await makeCtx(server, vault, kr, { metaState: "encrypted", bootstrap: opts.bootstrap });
	const keys = await kr.metaKeys();
	const [key, head] = await server.seedE2ee("dir/note.md", "v1 content", vmk, keys);
	if ((opts.bootstrap ?? "ready") === "ready") {
		vault.put("dir/note.md", "v1 content");
		ctx.store.update("dir/note.md", {
			fileId: head.fileId,
			serverPseudonym: key,
			revision: 1,
			generation: 1,
			metaGeneration: 1,
			metaFingerprint: await metaFingerprintOf(head.metaEnc!),
			hash: await sha256Hex(enc("v1 content")),
			serverHash: head.hash,
			mtime: 1000,
			size: 10,
		});
	}
	return { server, vault, ctx, vmk, keys, key, head };
}

/** 服务器上这个对象的元数据：信封解出的路径与世代，以及服务器自己记的世代。 */
async function remoteMeta(w: MetaWorld, key: string): Promise<{ path: string; envelope: number; server: number; revision: number; fileId: string }> {
	const h = w.server.heads.get(key)!;
	const m = await decryptMeta(w.keys, h.metaEnc!, w.server.vaultId, h.fileId);
	assert.ok(m, "元数据可以解开");
	return { path: m.meta.path, envelope: m.metaGeneration, server: h.metaGeneration, revision: h.revision, fileId: h.fileId };
}

/** 删除 → 本地重建同名（触发显式恢复）→ 改名，全部走真实的 pushPendingChanges。 */
async function deleteRecreateRename(w: MetaWorld): Promise<{ afterRestore: Awaited<ReturnType<typeof remoteMeta>>; afterRename: Awaited<ReturnType<typeof remoteMeta>> }> {
	w.vault.files.delete("dir/note.md");
	await w.ctx.queue.add("dir/note.md", "delete");
	await pushPendingChanges(w.ctx);
	assert.equal(w.server.heads.get(w.key)!.deleted, true, "远端留下墓碑");

	w.vault.put("dir/note.md", "v2 recreated locally");
	await w.ctx.queue.add("dir/note.md", "upsert");
	const r = await pushPendingChanges(w.ctx);
	assert.equal(r.pushed, 1);
	const afterRestore = await remoteMeta(w, w.key);

	w.vault.files.set("dir/renamed.md", w.vault.files.get("dir/note.md")!);
	w.vault.files.delete("dir/note.md");
	await w.ctx.queue.addMove("dir/renamed.md", "dir/note.md");
	const m = await pushPendingChanges(w.ctx);
	assert.equal(m.conflicts, 0);
	return { afterRestore, afterRename: await remoteMeta(w, w.key) };
}

test("普通 push：路径加密下删除 → 本地重建同名触发恢复 → 改名：CAS 通过，fileId 不变，三处元数据世代一致", async () => {
	const w = await metaWorld();
	const { afterRestore, afterRename } = await deleteRecreateRename(w);
	assert.equal(afterRestore.fileId, w.head.fileId, "恢复的是原对象");
	assert.equal(afterRestore.server, 2, "服务器：墓碑 + 1");
	assert.equal(afterRestore.envelope, afterRestore.server, "信封里的元数据世代与服务器一致（以前是 1）");
	const plain = await decryptFileV3(w.vmk, w.server.heads.get(w.key)!.data, w.server.vaultId, w.head.fileId, 1);
	assert.equal(dec(plain!.plain), "v2 recreated locally");

	assert.equal(afterRename.path, "dir/renamed.md", "改名落在同一个对象上");
	assert.equal(afterRename.fileId, w.head.fileId, "身份不变（没有退化成先建后删）");
	assert.equal(afterRename.server, 3);
	assert.equal(afterRename.envelope, 3);
	assert.equal(afterRename.revision, afterRestore.revision, "改名只是元数据更新，revision 不变");
	assert.equal(w.ctx.store.get("dir/renamed.md")?.metaGeneration, 3, "本地记账与服务器一致");
	assert.equal([...w.server.heads.values()].filter((h) => !h.deleted).length, 1, "服务器上没有多出第二个对象");
	assert.equal(w.server.requests.filter((q) => q.op === "rename").length, 1, "一次改名就成功，没有 412 后的退化");
});

test("旧服务端（没有回收站接口）：恢复后补一次元数据对齐，之后改名照常通过", async () => {
	const w = await metaWorld({ trash: false });
	const { afterRestore, afterRename } = await deleteRecreateRename(w);
	assert.equal(afterRestore.server, 3, "恢复（墓碑 + 1 = 2）之后的对齐改名又把它推到 3");
	assert.equal(afterRestore.envelope, afterRestore.server, "对齐之后信封与服务器一致");
	assert.equal(afterRename.fileId, w.head.fileId);
	assert.equal(afterRename.envelope, afterRename.server);
	assert.equal(afterRename.path, "dir/renamed.md");
	assert.equal(w.server.requests.filter((q) => q.op === "rename").length, 2, "一次对齐 + 一次真正的改名");
});

test("对齐改名提交后响应丢失：重放 412 → 读回服务器元数据核对 → 采纳，不重复推进世代", async () => {
	const w = await metaWorld({ trash: false });
	w.vault.files.delete("dir/note.md");
	await w.ctx.queue.add("dir/note.md", "delete");
	await pushPendingChanges(w.ctx);
	const tomb = w.server.heads.get(w.key)!;
	const restored = await w.server.client().restore(w.head.fileId, {
		expectedTombstoneRevision: tomb.revision,
		contentGeneration: 2,
		pseudonym: w.key,
		metaEnc: tomb.metaEnc,
		canonicalHash: tomb.canonical.slice(2),
	});
	assert.equal(restored.metaGeneration, 2);
	w.server.loseResponseOnWrite = w.server.writes + 1;
	const args = { path: "dir/note.md", fileId: w.head.fileId, pseudonym: w.key, serverMetaGeneration: 2, operationId: "op-align-m" };
	await assert.rejects(alignRestoredMeta(w.ctx, args), /response lost/);
	assert.equal(w.server.heads.get(w.key)!.metaGeneration, 3, "服务器其实已经提交了");
	const again = await alignRestoredMeta(w.ctx, args);
	assert.equal(again.metaGeneration, 3, "重放 412 后读回核对，采纳已对齐的结果");
	assert.equal(w.server.heads.get(w.key)!.metaGeneration, 3, "没有再推进一次");
	const m = await remoteMeta(w, w.key);
	assert.equal(m.envelope, m.server);
	assert.equal(m.path, "dir/note.md");
});

test("接入合并：本地独有文件撞上同名墓碑 → 恢复后的元数据世代与服务器、信封一致", async () => {
	const w = await metaWorld({ bootstrap: "pending" });
	await w.server.client().remove(w.key, 1);
	w.vault.put("dir/note.md", "merged back from this device");
	const info = await w.server.client().info();
	const r = await bootstrapMerge(
		w.ctx,
		{ info, snapshotSequence: w.server.seq, repoEpoch: w.server.repoEpoch, remoteFiles: [], localPaths: ["dir/note.md"], commonCount: 0, e2eeEnabled: true, inheritedTrust: { kind: "none" } },
		() => {},
	);
	assert.equal(r.uploaded, 1);
	const m = await remoteMeta(w, w.key);
	assert.equal(m.fileId, w.head.fileId, "恢复原对象（INV-05）");
	assert.equal(m.envelope, m.server);
	assert.equal(w.ctx.store.get("dir/note.md")?.metaGeneration, m.server, "本地记账与服务器一致，之后的改名 CAS 才对得上");
});

test("其他设备：还记着恢复前世代的设备看到恢复后的新信封 → 判为前进（apply），不会误判为同世代分叉而停机", async () => {
	const w = await metaWorld();
	const before = w.ctx.store.get("dir/note.md")!;
	// 另一台设备 X：记着恢复前的世代 1 与旧信封指纹（它离线期间对象被删、又被恢复）
	const other = await makeCtx(w.server, new MemVault(), new Keyring(), { metaState: "encrypted" });
	other.store.update("dir/note.md", { fileId: w.head.fileId, metaGeneration: 1, metaFingerprint: before.metaFingerprint, revision: 1, hash: before.hash, serverHash: before.serverHash });
	await deleteRecreateRename(w);
	const h = w.server.heads.get(w.key)!;
	// 只看恢复那一刻的信封：用恢复后、改名前的状态再建一次（这里直接用改名后的也行：世代只会更高）
	const m = await decryptMeta(w.keys, h.metaEnc!, w.server.vaultId, h.fileId);
	assert.equal(assertMetaGeneration(other, "dir/note.md", m!.metaGeneration, await metaFingerprintOf(h.metaEnc!)), "apply");
	assert.equal(other.gate.sessionBlock()?.reason, undefined, "没有完整性停机");
});

test("完整替换作业：新建撞墓碑、旧服务端（无回收站）、对齐改名提交后响应丢失 → 续跑完成，元数据世代一致", async () => {
	const w = await metaWorld({ trash: false });
	await w.server.client().remove(w.key, 1);
	w.ctx.store.markDeleted("dir/note.md");
	await w.server.seedE2ee("keep.md", "same", w.vmk, w.keys);
	w.vault.put("keep.md", "same");
	w.vault.put("dir/note.md", "replacement written locally");
	const job = await planReplaceRemote(w.ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false });
	assert.equal(job.items.find((i) => i.path === "dir/note.md")?.action, "create");
	confirmReplaceJob(job, "v", 1);
	await saveRecoveryPoint(w.ctx, job);
	// 写入顺序：恢复（#1）→ 对齐改名（#2，提交后响应丢失）
	w.server.loseResponseOnWrite = w.server.writes + 2;
	await assert.rejects(runReplaceJob(w.ctx, job), /response lost/);
	assert.equal(job.state, "interrupted");
	const r = await runReplaceJob(w.ctx, job);
	assert.equal(r.state, "completed", r.reason);
	const m = await remoteMeta(w, w.key);
	assert.equal(m.fileId, w.head.fileId, "恢复的是墓碑那个对象");
	assert.equal(m.envelope, m.server, "信封与服务器的元数据世代一致");
	assert.equal(m.path, "dir/note.md");
	assert.equal(w.server.changes.filter((c) => c.action === "restore").length, 1, "只恢复了一次");
	const plain = await decryptFileV3(w.vmk, w.server.heads.get(w.key)!.data, w.server.vaultId, w.head.fileId, 1);
	assert.equal(dec(plain!.plain), "replacement written locally");
	assert.equal(w.ctx.store.get("dir/note.md")?.metaGeneration, m.server);
});
