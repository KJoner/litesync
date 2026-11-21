// 0.20.1 Windows 真实 Obsidian 验收（WIN-11，2026-11-21）发现的两个缺陷的回归：
//
//   缺陷 1（替换弹窗）：执行中断后，同一个窗口里的按钮显示「继续执行」，点下去却仍走确认流程——作业已是
//     interrupted，只得到「作业状态不允许确认」、原地卡死；用户只能关掉窗口重开才能从诊断页续跑。
//     修复：已确认过的作业在同一窗口里点「继续执行」按续跑处理（与诊断页一致；执行许可照样逐项复核）。
//   缺陷 3（接入向导里的作业被强杀后续跑）：作业在接入完成前就为完成的条目写下跟踪状态，却没有确立账本归属；
//     重启后向导重新 preflight，把这些记录当成「归属未知的旧账」整本作废，作业完成后的第一轮同步把这些文件当成
//     「本地未跟踪、远端已有」，试图以新身份重新上传（真机实测服务端 422 拒绝）。修复：作业开始写之前确立账本归属。
//   缺陷 2（替换之后的第一轮普通同步）：仅大小写不同的改名项（删 Case.md → 在 case.md 上恢复同一对象 → 上传）
//     完成后，普通拉取按顺序重放这三条自己写出的变更。在大小写不敏感的文件系统上，重放「删除 Case.md」时
//     stat 命中已经改名成 case.md 的同一个文件，被当成「远端删了、本地改了」另存成新文件重新上传，随后把原对象
//     也删掉：本地变成「Case (device-xxx).md」、远端失去原身份（真机实测 seq 13→18）。路径加密仓库里同一回放会把
//     本地文件送进回收站。修复：按 fileId 判定——比已跟踪 revision 更早的变更是重放的旧变更，一律跳过
//     （改名不动 revision，同 revision 的变更照常处理）；删除命中的若是另一个已跟踪文件的大小写别名，也不碰它。
//
// INV: INV-03（前置条件不满足绝不覆盖 / 删除本地内容）/ INV-04（跳过的重放照常确认游标，不卡住拉取）/
//      INV-05（身份由 fileId 决定：仅大小写改名在替换与之后的同步里都保持同一对象）/ INV-11（作业可恢复、可重复、幂等）
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { completeBootstrap, preflight } from "../src/bootstrap/bootstrap-manager";
import { confirmReplaceJob, planReplaceRemote, runReplaceJob, saveRecoveryPoint } from "../src/bootstrap/replace-remote";
import { ReplaceRemoteModal } from "../src/bootstrap/replace-remote-modal";
import type { ReplaceJob } from "../src/bootstrap/replace-types";
import { createVaultKeyDoc, MetaKeys } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import type { SyncContext } from "../src/sync/context";
import { pullRemoteChanges } from "../src/sync/pull";
import { pushPendingChanges, scanLocalChanges } from "../src/sync/push";
import { resetFailpoints } from "../src/utils/failpoint";
import { dec, FakeServer, Head, makeCtx, MemVault } from "./fakes/replace-server";

afterEach(() => resetFailpoints());

// ---------- 最小 DOM 替身：只够驱动 ReplaceRemoteModal 的真实渲染代码 ----------

interface ElOpts {
	text?: string;
	cls?: string;
	type?: string;
	placeholder?: string;
}

class FakeEl {
	text = "";
	children: FakeEl[] = [];
	onclick: (() => void) | null = null;
	disabled = false;
	value = "";
	attrs: Record<string, string> = {};
	private listeners: Record<string, Array<() => void>> = {};
	constructor(
		public tag = "div",
		o: ElOpts = {},
	) {
		this.text = o.text ?? "";
		if (o.type) this.attrs.type = o.type;
	}
	createEl(tag: string, o: ElOpts = {}): FakeEl {
		const c = new FakeEl(tag, o);
		this.children.push(c);
		return c;
	}
	createDiv(o: ElOpts = {}): FakeEl {
		return this.createEl("div", o);
	}
	createSpan(o: ElOpts = {}): FakeEl {
		return this.createEl("span", o);
	}
	setText(t: string): void {
		this.text = t;
		this.children = [];
	}
	empty(): void {
		this.text = "";
		this.children = [];
	}
	setAttribute(k: string, v: string): void {
		this.attrs[k] = v;
	}
	addEventListener(ev: string, fn: () => void): void {
		(this.listeners[ev] ??= []).push(fn);
	}
	fire(ev: string): void {
		for (const fn of this.listeners[ev] ?? []) fn();
	}
	get innerText(): string {
		return [this.text, ...this.children.map((c) => c.innerText)].filter((s) => s !== "").join("\n");
	}
	all(): FakeEl[] {
		return [this, ...this.children.flatMap((c) => c.all())];
	}
	button(text: string): FakeEl | undefined {
		return this.all().find((e) => e.tag === "button" && e.text === text);
	}
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`等待超时：${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

// ---------- 世界：服务器 + （可选大小写不敏感的）本地库 + 钥匙 ----------

type Mode = "plain" | "path-e2ee";

interface World {
	mode: Mode;
	server: FakeServer;
	vault: MemVault;
	ctx: SyncContext;
	vmk?: CryptoKey;
	keys?: MetaKeys;
	notes: string[];
}

async function world(mode: Mode, opts: { caseInsensitive?: boolean } = {}): Promise<World> {
	const server = new FakeServer();
	server.metaState = mode === "path-e2ee" ? "encrypted" : "plain";
	const vault = new MemVault({ caseInsensitive: opts.caseInsensitive });
	const kr = new Keyring();
	let vmk: CryptoKey | undefined;
	let keys: MetaKeys | undefined;
	if (mode === "path-e2ee") {
		const made = await createVaultKeyDoc("test-password");
		made.doc.enabled = true;
		kr.adopt(made.doc, made.vmk);
		vmk = made.vmk;
		keys = await kr.metaKeys();
	}
	const ctx = await makeCtx(server, vault, kr, { metaState: server.metaState });
	const notes: string[] = [];
	const c = ctx as unknown as {
		notify: (m: string) => void;
		committer: unknown;
		app: { vault: { getAbstractFileByPath?: (p: string) => unknown }; fileManager?: unknown };
	};
	c.notify = (m: string) => void notes.push(m);
	// 与宿主一致的最小落地：远端内容写进本地；回收站 = Obsidian 的库内 .trash（索引按确切名字查找）
	c.committer = {
		commitRemoteChange: async (req: { realPath: string; incoming: ArrayBuffer }) => {
			await vault.adapter.writeBinary(req.realPath, req.incoming);
			return { status: "committed" };
		},
	};
	c.app.vault.getAbstractFileByPath = (p: string) => (vault.files.has(p) ? { path: p } : null);
	c.app.fileManager = {
		trashFile: async (af: { path: string }) => {
			const data = vault.files.get(af.path)!;
			vault.files.delete(af.path);
			vault.files.set(`.trash/${af.path.split("/").pop()}`, data);
		},
	};
	return { mode, server, vault, ctx, vmk, keys, notes };
}

async function seed(w: World, path: string, content: string): Promise<[string, Head]> {
	if (w.mode === "plain") return [path, await w.server.seedAsync(path, content)];
	return w.server.seedE2ee(path, content, w.vmk!, w.keys!);
}

function modalFor(w: World): { modal: ReplaceRemoteModal; content: FakeEl; completed: ReplaceJob[] } {
	const completed: ReplaceJob[] = [];
	const modal = new ReplaceRemoteModal({} as never, w.ctx, {
		bootstrapContext: false,
		executionEnabled: true,
		vaultName: "QA 仓库",
		vaultChoice: "",
		holdSync: () => {},
		releaseSync: () => {},
		onCompleted: async (job) => void completed.push(job),
	});
	const content = new FakeEl();
	(modal as unknown as { contentEl: FakeEl; titleEl: FakeEl }).contentEl = content;
	(modal as unknown as { contentEl: FakeEl; titleEl: FakeEl }).titleEl = new FakeEl();
	return { modal, content, completed };
}

// ---------- 缺陷 1：同一窗口里的「继续执行」 ----------

test("WIN-11 缺陷 1：执行中断后，同一个替换窗口里的「继续执行」是续跑——不再要求确认、不报「作业状态不允许确认」，续跑到完成页", async () => {
	const w = await world("plain");
	await seed(w, "edit.md", "remote v1");
	await seed(w, "gone.md", "remote only");
	w.vault.put("edit.md", "local v2");
	w.vault.put("new.md", "local only");
	const { modal, content, completed } = modalFor(w);
	modal.onOpen();
	content.button("生成差异预览")!.onclick!();
	await until(() => content.innerText.includes("确认要执行，请输入「QA 仓库」"), "差异预览");
	const input = content.all().find((e) => e.tag === "input")!;
	input.value = "QA 仓库";
	input.fire("input");
	const go = content.button("保存恢复点并执行")!;
	assert.equal(go.disabled, false, "输入确认短语后可以执行");
	// 第 2 个写入在到达服务器之前失败（断网）：第 1 个已提交
	w.server.failBeforeWrite = w.server.writes + 2;
	go.onclick!();
	await until(() => content.innerText.includes("执行中断（可稍后继续，已完成的不会重复）"), "执行中断");
	const writesAtBreak = w.server.writeRequests().length;
	const job = w.ctx.store.state.replaceJob!;
	assert.equal(job.state, "interrupted");
	assert.equal(go.text, "继续执行", "按钮变成「继续执行」");
	go.onclick!();
	await until(() => content.innerText.includes("替换完成") || content.innerText.includes("作业状态不允许确认"), "续跑结果");
	assert.doesNotMatch(content.innerText, /作业状态不允许确认/, "同一窗口里的「继续执行」不能再走确认（真机实测卡死于此）");
	assert.match(content.innerText, /替换完成：覆盖 1、删除 1、新建 1/);
	assert.equal(w.ctx.store.state.replaceJob?.state, "completed");
	assert.equal(completed.length, 1, "完成回调只触发一次");
	assert.equal(dec(w.server.heads.get("edit.md")!.data), "local v2");
	assert.equal(dec(w.server.heads.get("new.md")!.data), "local only");
	assert.equal(w.server.heads.get("gone.md")?.deleted, true);
	// 续跑没有重复已完成的写入：中断前提交了 1 个，续跑补完剩下的
	assert.equal(w.server.writeRequests().length - writesAtBreak, job.items.filter((i) => i.action !== "keep").length - 1);
	assert.ok(content.button("生成回滚…"), "完成页照常提供回滚入口");
});

test("WIN-11 缺陷 1（续）：第一次确认仍然必须原样输入确认短语——改动只放行已确认过的作业", async () => {
	const w = await world("plain");
	await seed(w, "a.md", "remote");
	w.vault.put("a.md", "local");
	const { modal, content } = modalFor(w);
	modal.onOpen();
	content.button("生成差异预览")!.onclick!();
	await until(() => content.innerText.includes("确认要执行"), "差异预览");
	const input = content.all().find((e) => e.tag === "input")!;
	input.value = "错的名字";
	input.fire("input");
	const go = content.button("保存恢复点并执行")!;
	assert.equal(go.disabled, true, "短语不对时按钮不可用");
	go.onclick!(); // 绕过 disabled 直接触发：仍由确认流程拦下
	await new Promise((r) => setTimeout(r, 20));
	assert.match(content.innerText, /请原样输入「QA 仓库」/);
	assert.equal(w.ctx.store.state.replaceJob ?? null, null, "没有确认就不落盘作业、不写远端");
	assert.equal(w.server.writeRequests().length, 0);
});

// ---------- 缺陷 2：替换之后的第一轮普通拉取 ----------

for (const mode of ["plain", "path-e2ee"] as const) {
	test(`WIN-11 缺陷 2（${mode}，大小写不敏感的文件系统）：仅大小写改名的替换完成后，第一轮拉取重放「删除 Case.md → 恢复 → 上传」——不动本地文件、不另存、不重新上传，远端仍是同一对象`, async () => {
		const w = await world(mode, { caseInsensitive: true });
		const [origKey, orig] = await seed(w, "Case.md", "大小写改名之前的内容");
		w.vault.put("case.md", "大小写改名之后的内容");
		// 已接入的设备：计划前先同步收敛，游标就在计划水位（向导里完成接入时同样把游标放在计划水位）
		w.ctx.store.state.lastSequence = w.server.seq;
		const job = await planReplaceRemote(w.ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: false });
		assert.deepEqual(confirmReplaceJob(job, "v", 1), { ok: true });
		await saveRecoveryPoint(w.ctx, job);
		const r = await runReplaceJob(w.ctx, job);
		assert.equal(r.state, "completed", r.reason);
		const writesAfterJob = w.server.writeRequests().length;
		const key = mode === "plain" ? "case.md" : origKey;
		const headAfterJob = w.server.heads.get(key)!;
		assert.equal(headAfterJob.fileId, orig.fileId, "前提：作业把同一对象恢复到了新名字上");
		const replay = w.server.changes.filter((c) => c.sequence > job.plannedHeadSequence).map((c) => `${c.action}@${c.revision}`);
		assert.deepEqual(replay, ["delete@2", "restore@3", "upsert@4"], "前提：游标之后正是这三条自己写出的变更");

		const res = await pullRemoteChanges(w.ctx);

		assert.equal(res.conflicts, 0, "重放不产生冲突");
		assert.deepEqual(w.ctx.queue.entries(), [], "没有把 Case.md 当成本地修改排进待推送");
		assert.deepEqual(w.notes.filter((n) => /远端已删除|无法移入回收站/.test(n)), [], "不会提示「远端已删除但本地有修改」");
		assert.deepEqual(w.vault.userFiles().map((f) => f.path), ["case.md"], "本地仍是 case.md，没有被改名、另存或送进回收站");
		assert.equal(dec(await w.vault.adapter.readBinary("case.md")), "大小写改名之后的内容");
		assert.equal(w.ctx.store.get("case.md")?.fileId, orig.fileId, "跟踪状态仍是原对象");
		assert.equal(w.ctx.store.state.lastSequence, w.server.seq, "跳过的重放照常确认游标（INV-04）");
		assert.equal(w.server.writeRequests().length, writesAfterJob, "拉取本身零写入");
		const head = w.server.heads.get(key)!;
		assert.equal(head.deleted, false);
		assert.equal(head.fileId, orig.fileId, "远端仍是同一对象（INV-05）");
		assert.equal(head.revision, headAfterJob.revision, "远端没有被这轮同步再动一次");
	});
}

test("拉取：删除命中的是另一个已跟踪文件的大小写别名（没有 fileId 的旧格式变更）→ 不碰本地文件", async () => {
	const w = await world("plain", { caseInsensitive: true });
	const head = await w.server.seedAsync("case.md", "本地正在用的文件");
	w.vault.put("case.md", "本地正在用的文件");
	w.ctx.store.applyRemoteIdentity("case.md", { fileId: head.fileId, generation: 1, metaGeneration: 1 });
	w.ctx.store.patchContentState("case.md", { hash: head.hash, serverHash: head.hash, revision: 1, mtime: 1, size: 1 });
	w.ctx.store.state.lastSequence = w.server.seq;
	(w.ctx.client as unknown as { changes: (since: number) => Promise<unknown> }).changes = async () => ({
		latestSequence: w.server.seq + 1,
		hasMore: false,
		changes: [{ sequence: w.server.seq + 1, path: "Case.md", action: "delete", revision: 0 }],
	});
	const res = await pullRemoteChanges(w.ctx);
	assert.equal(res.conflicts, 0);
	assert.deepEqual(w.ctx.queue.entries(), []);
	assert.deepEqual(w.vault.userFiles().map((f) => f.path), ["case.md"]);
	assert.equal(w.ctx.store.get("case.md")?.fileId, head.fileId);
});

// ---------- 缺陷 3：接入向导里的作业做了一半被强杀，重启后向导重新 preflight ----------

test("WIN-11 缺陷 3（接入向导上下文，路径加密）：作业做了一半时 Obsidian 被强杀，重启后向导重新 preflight——作业已写下的跟踪状态不能被当成「归属未知的旧账」作废；完成接入后的第一轮同步零写入", async () => {
	const server = new FakeServer();
	server.metaState = "encrypted";
	const vault = new MemVault();
	const made = await createVaultKeyDoc("test-password");
	made.doc.enabled = true;
	const keyring = (): Keyring => {
		const k = new Keyring();
		k.adopt(made.doc, made.vmk);
		return k;
	};
	const kr = keyring();
	const keys = await kr.metaKeys();
	await server.seedE2ee("keep.md", "same", made.vmk, keys);
	await server.seedE2ee("edit.md", "remote v1", made.vmk, keys);
	await server.seedE2ee("gone.md", "remote only", made.vmk, keys);
	vault.put("keep.md", "same");
	vault.put("edit.md", "local v2");
	vault.put("new.md", "local only");
	// 向导：接入尚未完成（bootstrap pending），先 preflight 再出选项
	const ctx = await makeCtx(server, vault, kr, { metaState: "encrypted", bootstrap: "pending" });
	await preflight(ctx);
	const job = await planReplaceRemote(ctx, { vaultName: "v", vaultChoice: "", bootstrapContext: true });
	assert.deepEqual(confirmReplaceJob(job, "v", 1), { ok: true });
	await saveRecoveryPoint(ctx, job);
	// 前两个写入完成，第三个之前「进程被杀」（请求没到服务器）
	server.failBeforeWrite = server.writes + 3;
	await assert.rejects(runReplaceJob(ctx, job));
	const doneBeforeKill = job.items.filter((i) => i.status === "done" && i.action !== "keep").map((i) => i.path);
	assert.ok(doneBeforeKill.length >= 2, `前提：强杀前已完成 ${doneBeforeKill.join("、")}`);
	const trackedBefore = Object.fromEntries(doneBeforeKill.filter((p) => ctx.store.get(p)).map((p) => [p, ctx.store.get(p)!.fileId]));
	assert.ok(Object.keys(trackedBefore).length >= 1, "前提：作业为已完成的条目写下了跟踪状态");

	// 重启：从磁盘重新加载状态；启动时向导重新打开、重新 preflight
	const ctx2 = await makeCtx(server, vault, keyring(), { loadOnly: true, metaState: "encrypted" });
	const pre2 = await preflight(ctx2);
	for (const [p, fid] of Object.entries(trackedBefore)) {
		assert.equal(ctx2.store.get(p)?.fileId, fid, `重启后的 preflight 保留了作业写下的跟踪状态（${p}）`);
	}
	const job2 = ctx2.store.state.replaceJob!;
	const r = await runReplaceJob(ctx2, job2);
	assert.equal(r.state, "completed", r.reason);
	completeBootstrap(ctx2, { ...pre2, info: await ctx2.client.info(), snapshotSequence: job2.plannedHeadSequence, remoteFiles: [], localPaths: [], commonCount: 0 }, "local-replace");
	ctx2.gate.markBound();
	const c2 = ctx2 as unknown as {
		committer: unknown;
		notify: (m: string) => void;
		app: { vault: { getFiles: () => unknown[] } };
	};
	const notes: string[] = [];
	c2.notify = (m: string) => void notes.push(m);
	// 宿主的 TFile 带 stat（扫描按 mtime / size 判断有没有改动）；内存库的 mtime 恒为 1000
	c2.app.vault.getFiles = () =>
		vault.userFiles().map((f) => ({ path: f.path, stat: { mtime: 1000, size: vault.files.get(f.path)!.byteLength } }));
	c2.committer = {
		commitRemoteChange: async (req: { realPath: string; incoming: ArrayBuffer }) => {
			await vault.adapter.writeBinary(req.realPath, req.incoming);
			return { status: "committed" };
		},
	};

	const writesBefore = server.writeRequests().length;
	const pulled = await pullRemoteChanges(ctx2);
	await scanLocalChanges(ctx2);
	await pushPendingChanges(ctx2);
	assert.equal(pulled.conflicts, 0, "没有把作业自己写的内容当成冲突");
	assert.deepEqual(notes.filter((n) => /冲突|已保留本地|两个版本/.test(n)), []);
	assert.equal(server.writeRequests().length, writesBefore, "完成接入后的第一轮同步零写入（不会以新身份重新上传已替换的文件）");
	const live = [...server.heads.values()].filter((h) => !h.deleted);
	assert.equal(live.length, 3, "远端只有 keep / edit / new 三个对象，没有多出来的副本");
});
