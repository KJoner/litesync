/**
 * 「用本地完整替换远端」× 真实 Go 服务端联调（0.20.1 / 复审 RB-2，PL-02～PL-05）。
 *
 * 插件原样代码（src/）由 esbuild 打包、在 Node 里运行；obsidian 模块换成 scripts/interop/obsidian-shim.ts
 * （requestUrl 走真实 HTTP，带故障注入与请求记录）。设备的 Vault 与插件状态都写在真实文件系统的临时目录里，
 * 「重启」= 用同一个目录重新加载 StateStore、重新解锁。全部是合成数据。
 *
 * 每个目标（一个全新的服务端实例）跑一种仓库：content-e2ee（内容加密、路径明文）或 path-e2ee（内容 + 路径加密）。
 *   准备：种子设备用插件的「空仓启用 E2EE → local-init → 上传 → (path-e2ee) 路径加密迁移 complete」建出远端 S，
 *         其中一个对象删成墓碑；
 *   A 阶段（首次接入入口）：新设备 R1 在接入向导上下文里执行完整替换 F1（覆盖 / 删除 / 新建 / 不变 / 仅大小写不同的
 *         改名 / 新建撞墓碑），途中注入「响应丢失」「请求未达」「restore 响应丢失」，每次中断都从磁盘重启续跑；
 *         完成接入后做反向作业 V1（同样注入故障），远端回到 S；
 *   B 阶段（已接入入口）：新设备 R2 先 remote-wins 接入，再本地改动后执行 F2 与反向 V2（注入故障）。
 *   每一步之后：用独立的核对客户端拉快照，逐对象下载、**解密**（LSE3 AAD 绑定 fileId）、核对内容、fileId 身份、
 *   revision 与内容世代（解密出的世代必须等于服务器报告的世代且单调前进）；path-e2ee 再解 LSM1 核对真实路径与
 *   元数据世代，并核对全程没有任何请求带着真实路径。恢复点在执行前从磁盘重新读回、逐个解密校验。
 *
 * 边界：绑定校验以 /info 身份核对 + gate.markBound() 模拟（没有跑 SyncManager 的普通同步轮）；
 * 本地文件提交器是最小替身（只用于 R2 的 remote-wins 接入）。这些都不是被测对象。
 *
 * 由 scripts/interop/run.mjs 调用；输入环境变量 LS_INTEROP_TARGETS（JSON 数组）与 LS_INTEROP_OUT（结果 JSON 路径）。
 */
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ApiClient } from "../../src/api/client";
import {
	bootstrapLocalInit,
	bootstrapRemoteWins,
	completeBootstrap,
	preflight,
	PreflightResult,
} from "../../src/bootstrap/bootstrap-manager";
import {
	buildReverseJob,
	confirmReplaceJob,
	planReplaceRemote,
	recoveryDir,
	refreshReverseWatermark,
	runReplaceJob,
	saveRecoveryPoint,
} from "../../src/bootstrap/replace-remote";
import type { ReplaceJob } from "../../src/bootstrap/replace-types";
import { decryptFileV3, decryptMeta, newFileId } from "../../src/crypto/crypto";
import { Keyring } from "../../src/crypto/keyring";
import { enableE2eeOnEmptyRemote, encryptMetadata, upgradeEnvelopes } from "../../src/crypto/migration";
import { StateStore } from "../../src/state/store";
import type { SyncContext } from "../../src/sync/context";
import { SyncGate } from "../../src/sync/gate";
import { PendingQueue } from "../../src/sync/queue";
import { uploadFromPlain } from "../../src/sync/transfer";
import type { InteropFault, InteropRequestLog } from "./obsidian-shim";

type Mode = "content-e2ee" | "path-e2ee";

interface Target {
	mode: Mode;
	url: string;
	token: string;
	workdir: string;
}

interface Check {
	name: string;
	ok: boolean;
	detail?: string;
}

interface ModeReport {
	mode: Mode;
	serverUrl: string;
	serverVersion: string;
	checks: Check[];
	faults: Array<{ phase: string; label: string; kind: string; hits: number }>;
	interruptions: Array<{ phase: string; attempt: number; error: string }>;
	timeline: string[];
	requests: { total: number; writes: number; faults: number };
	error?: string;
}

const PLUGIN_DIR = ".obsidian/plugins/litesync";
const PASSWORD = "联调用的仓库密码 · interop";
const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const sha256 = (b: ArrayBuffer): string => createHash("sha256").update(Buffer.from(b)).digest("hex");
const isPseudonym = (p: string): boolean => /^[0-9a-f]{32}$/.test(p);

function interop(): { faults: InteropFault[]; log: InteropRequestLog[] } {
	const g = globalThis as unknown as { __lsInterop?: { faults: InteropFault[]; log: InteropRequestLog[] } };
	if (!g.__lsInterop) g.__lsInterop = { faults: [], log: [] };
	return g.__lsInterop;
}

/** 第 n 个匹配 method + url 片段的请求。 */
function nth(method: string, urlPart: string, n: number): (r: { method: string; url: string }) => boolean {
	let seen = 0;
	return (r) => {
		if (r.method !== method || !r.url.includes(urlPart)) return false;
		seen++;
		return seen === n;
	};
}

// ---------- 设备：真实文件系统上的 Vault 与插件状态 ----------

class FsVault {
	constructor(public root: string) {}
	private abs(p: string): string {
		return join(this.root, ...p.split("/"));
	}
	adapter = {
		stat: async (p: string) => {
			try {
				const { stat } = await import("node:fs/promises");
				const s = await stat(this.abs(p));
				return { type: s.isDirectory() ? "folder" : "file", mtime: Math.floor(s.mtimeMs), ctime: Math.floor(s.ctimeMs), size: s.size };
			} catch {
				return null;
			}
		},
		readBinary: async (p: string): Promise<ArrayBuffer> => {
			const b = await readFile(this.abs(p));
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
		},
		writeBinary: async (p: string, d: ArrayBuffer) => {
			await mkdir(dirname(this.abs(p)), { recursive: true });
			await writeFile(this.abs(p), Buffer.from(d));
		},
		write: async (p: string, d: string) => {
			await mkdir(dirname(this.abs(p)), { recursive: true });
			await writeFile(this.abs(p), d, "utf8");
		},
		read: async (p: string) => readFile(this.abs(p), "utf8"),
		exists: async (p: string) => {
			try {
				await access(this.abs(p));
				return true;
			} catch {
				return false;
			}
		},
		mkdir: async (p: string) => void (await mkdir(this.abs(p), { recursive: true })),
	};
	async put(path: string, data: string | ArrayBuffer): Promise<void> {
		await this.adapter.writeBinary(path, typeof data === "string" ? enc(data) : data);
	}
	async remove(path: string): Promise<void> {
		const { rm } = await import("node:fs/promises");
		await rm(this.abs(path), { force: true });
	}
	async files(): Promise<{ path: string }[]> {
		const out: { path: string }[] = [];
		const walk = async (dir: string, rel: string): Promise<void> => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const r = rel ? `${rel}/${e.name}` : e.name;
				if (r === ".obsidian" || r.startsWith(".obsidian/")) continue;
				if (e.isDirectory()) await walk(join(dir, e.name), r);
				else out.push({ path: r });
			}
		};
		await walk(this.root, "");
		return out;
	}
}

interface Device {
	name: string;
	vault: FsVault;
	store: StateStore;
	kr: Keyring;
	gate: SyncGate;
	ctx: SyncContext;
	client: ApiClient;
	fileList: { path: string }[];
}

async function openDevice(t: Target, name: string, report: ModeReport): Promise<Device> {
	const root = join(t.workdir, t.mode, name);
	await mkdir(root, { recursive: true });
	const vault = new FsVault(root);
	const store = new StateStore(vault.adapter as unknown as ConstructorParameters<typeof StateStore>[0], `${PLUGIN_DIR}/state.json`);
	await store.load();
	const kr = new Keyring();
	const gate = new SyncGate();
	const client = new ApiClient(() => ({
		serverUrl: t.url,
		apiToken: t.token,
		deviceId: store.state.deviceId,
		vaultChoice: "",
		formatEpoch: store.state.bootstrap.formatEpoch ?? 0,
		repoEpoch: store.state.bootstrap.repoEpoch ?? "",
		keyEpoch: store.state.bootstrap.keyEpoch ?? 0,
	}));
	const dev: Device = { name, vault, store, kr, gate, client, ctx: undefined as unknown as SyncContext, fileList: [] };
	dev.ctx = {
		app: { vault: { adapter: vault.adapter, configDir: ".obsidian", getFiles: () => dev.fileList } },
		client,
		store,
		queue: new PendingQueue(),
		gate,
		e2ee: kr,
		// 只用于 R2 的 remote-wins 接入：最小本地提交器（不是被测对象）
		committer: {
			commitRemoteChange: async (req: { realPath: string; incoming: ArrayBuffer }) => {
				await vault.adapter.writeBinary(req.realPath, req.incoming);
				return { status: "committed" };
			},
		},
		ignores: (p: string) => p.startsWith(".obsidian/") || p.startsWith(".trash/"),
		padsSize: () => false,
		reportedMtime: (ms: number) => ms,
		pluginDir: () => PLUGIN_DIR,
		log: (m: string) => report.timeline.push(`[${name}] ${m}`),
		notify: (m: string) => report.timeline.push(`[${name}] 通知：${m}`),
		onConflictsChanged: () => {},
		syncObsidian: () => false,
		deviceName: () => name,
		credentials: () => ({ serverUrl: t.url, apiToken: t.token, vaultChoice: "" }),
		refreshE2ee: async () => {
			const doc = await client.getVaultKey();
			kr.setDoc(doc);
			store.state.e2ee = doc;
		},
	} as unknown as SyncContext;
	return dev;
}

/** 刷新设备的文件清单（Obsidian 的 vault.getFiles() 是同步的，这里在每次计划前预先扫描）。 */
async function rescan(dev: Device): Promise<void> {
	dev.fileList = await dev.vault.files();
}

/** 「重启」：同一个目录重新加载状态、重新解锁（严格会话解锁：钥匙不落盘，重启后必须再输一次密码）。 */
async function restartDevice(t: Target, dev: Device, report: ModeReport): Promise<Device> {
	const next = await openDevice(t, dev.name, report);
	next.kr.setDoc(next.store.state.e2ee);
	const r = await next.kr.unlock(PASSWORD);
	if (r !== "unlocked") throw new Error(`重启后解锁失败：${r}`);
	if (next.store.bootstrapReady) next.gate.markBound();
	await rescan(next);
	return next;
}

// ---------- 独立核对：逐对象下载、解密、核对 ----------

interface RemoteObject {
	path: string;
	serverPath: string;
	fileId: string;
	revision: number;
	reportedGeneration: number;
	generation: number;
	text: string;
	bytesHash: string;
	metaGeneration?: number;
	reportedMetaGeneration?: number;
}

async function readRemote(t: Target, verifier: Device, vmk: CryptoKey): Promise<Map<string, RemoteObject>> {
	const snap = await verifier.client.snapshot();
	const vaultId = verifier.store.state.bootstrap.remoteVaultId ?? "";
	const keys = t.mode === "path-e2ee" ? await verifier.kr.metaKeys() : undefined;
	const out = new Map<string, RemoteObject>();
	for (const f of snap.files) {
		const fileId = f.fileId ?? "";
		let path = f.path;
		let metaGeneration: number | undefined;
		if (keys && f.metaEnc) {
			const meta = await decryptMeta(keys, f.metaEnc, vaultId, fileId);
			if (!meta) throw new Error(`元数据解不开：${fileId}`);
			path = meta.meta.path;
			metaGeneration = meta.metaGeneration;
		}
		const dl = await verifier.client.download(f.path);
		const dec = await decryptFileV3(vmk, dl.data, vaultId, fileId, verifier.store.state.bootstrap.keyEpoch ?? 1);
		if (!dec) throw new Error(`内容解不开（AAD 绑定 fileId 失败）：${path}`);
		out.set(path, {
			path,
			serverPath: f.path,
			fileId,
			revision: f.revision,
			reportedGeneration: f.contentGeneration ?? 0,
			generation: dec.generation,
			text: new TextDecoder().decode(dec.plain),
			bytesHash: sha256(dec.plain),
			metaGeneration,
			reportedMetaGeneration: f.metaGeneration,
		});
	}
	return out;
}

async function trashIds(verifier: Device): Promise<Set<string>> {
	return new Set((await verifier.client.trash()).map((t) => t.fileId));
}

// ---------- 作业执行（含故障注入与重启续跑） ----------

async function runWithRestarts(
	t: Target,
	devRef: { dev: Device },
	job: ReplaceJob,
	phase: string,
	report: ModeReport,
): Promise<{ state: string; reason?: string; job: ReplaceJob }> {
	let current = job;
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			await rescan(devRef.dev);
			const r = await runReplaceJob(devRef.dev.ctx, current);
			report.timeline.push(`${phase}：第 ${attempt} 次执行结束，状态 ${r.state}${r.reason ? `（${r.reason}）` : ""}`);
			return { state: r.state, reason: r.reason, job: current };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			report.interruptions.push({ phase, attempt, error: msg.slice(0, 300) });
			report.timeline.push(`${phase}：第 ${attempt} 次执行中断（${msg.slice(0, 120)}），从磁盘重启后续跑`);
			devRef.dev = await restartDevice(t, devRef.dev, report);
			const reloaded = devRef.dev.store.state.replaceJob;
			if (!reloaded || reloaded.jobId !== current.jobId) throw new Error(`${phase}：重启后找不到同一个作业`);
			current = reloaded;
		}
	}
	throw new Error(`${phase}：10 次仍未完成`);
}

/** 恢复点：从磁盘重新读回作业与恢复文件，逐个核对 hash 并解密回删除 / 覆盖之前的内容。 */
async function verifyRecoveryPoint(t: Target, dev: Device, job: ReplaceJob, before: Map<string, RemoteObject>, vmk: CryptoKey, check: (n: string, ok: boolean, d?: string) => void): Promise<void> {
	const reloaded = new StateStore(dev.vault.adapter as unknown as ConstructorParameters<typeof StateStore>[0], `${PLUGIN_DIR}/state.json`);
	await reloaded.load();
	const persisted = reloaded.state.replaceJob;
	check(`[${t.mode}] 恢复点：作业与 snapshotComplete 已落盘（从磁盘重新读回）`, persisted?.jobId === job.jobId && persisted.snapshotComplete === true);
	const vaultId = dev.store.state.bootstrap.remoteVaultId ?? "";
	const targets = (persisted?.items ?? []).filter((i) => i.action === "update" || i.action === "delete");
	let ok = 0;
	for (const it of targets) {
		const raw = await dev.vault.adapter.readBinary(`${recoveryDir(dev.ctx, job.jobId)}/${it.snapshotFile}`);
		const hashOk = sha256(raw) === it.snapshotHash;
		const dec = await decryptFileV3(vmk, raw, vaultId, it.fileId ?? "", dev.store.state.bootstrap.keyEpoch ?? 1);
		const orig = before.get(it.path);
		if (hashOk && dec && orig && sha256(dec.plain) === orig.bytesHash && dec.generation === orig.generation) ok++;
		else check(`[${t.mode}] 恢复点：${it.path} 可解回原内容`, false, `hash=${hashOk} dec=${!!dec}`);
	}
	check(`[${t.mode}] 恢复点：${targets.length} 个将被覆盖 / 删除的对象全部可从磁盘解密回执行前内容（世代一致）`, ok === targets.length && targets.length > 0, `${ok}/${targets.length}`);
	const manifest = JSON.parse(await dev.vault.adapter.read(`${recoveryDir(dev.ctx, job.jobId)}/manifest.json`)) as { items: unknown[] };
	check(`[${t.mode}] 恢复点：人可读清单已写出`, manifest.items.length === targets.length);
}

/** 远端是否正好是 expected（路径集合、内容逐字节）；返回远端对象表。 */
async function expectRemote(
	t: Target,
	verifier: Device,
	vmk: CryptoKey,
	expected: Map<string, ArrayBuffer>,
	label: string,
	check: (n: string, ok: boolean, d?: string) => void,
): Promise<Map<string, RemoteObject>> {
	const remote = await readRemote(t, verifier, vmk);
	const missing = [...expected.keys()].filter((p) => !remote.has(p));
	const extra = [...remote.keys()].filter((p) => !expected.has(p));
	check(`[${t.mode}] ${label}：远端路径集合与预期一致`, missing.length === 0 && extra.length === 0, `缺 ${missing.join(",") || "无"}；多 ${extra.join(",") || "无"}`);
	let same = 0;
	for (const [p, data] of expected) if (remote.get(p)?.bytesHash === sha256(data)) same++;
	check(`[${t.mode}] ${label}：${expected.size} 个对象逐个解密后内容逐字节一致`, same === expected.size, `${same}/${expected.size}`);
	const genOk = [...remote.values()].every((o) => o.generation === o.reportedGeneration);
	check(`[${t.mode}] ${label}：解密出的内容世代（AAD 认证）与服务器报告一致`, genOk);
	if (t.mode === "path-e2ee") {
		const metaOk = [...remote.values()].every((o) => o.metaGeneration === o.reportedMetaGeneration);
		check(`[${t.mode}] ${label}：LSM1 元数据世代与服务器一致`, metaOk, [...remote.values()].filter((o) => o.metaGeneration !== o.reportedMetaGeneration).map((o) => `${o.path}:${o.metaGeneration}/${o.reportedMetaGeneration}`).join(","));
		check(`[${t.mode}] ${label}：服务器寻址名全部是伪名`, [...remote.values()].every((o) => isPseudonym(o.serverPath) && o.serverPath === o.fileId));
	}
	return remote;
}

// ---------- 一个目标（一种仓库）的完整场景 ----------

async function runTarget(t: Target): Promise<ModeReport> {
	const report: ModeReport = {
		mode: t.mode,
		serverUrl: t.url,
		serverVersion: "",
		checks: [],
		faults: [],
		interruptions: [],
		timeline: [],
		requests: { total: 0, writes: 0, faults: 0 },
	};
	const check = (name: string, ok: boolean, detail?: string): void => {
		report.checks.push({ name, ok, ...(detail ? { detail } : {}) });
		console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	};
	const g = interop();
	const logStart = g.log.length;
	const addFaults = (phase: string, faults: InteropFault[]): void => {
		for (const f of faults) {
			g.faults.push(f);
			report.faults.push({ phase, label: f.label, kind: f.kind, hits: 0 });
		}
	};
	const settleFaults = (): void => {
		for (const r of report.faults) {
			const f = g.faults.find((x) => x.label === r.label);
			if (f) r.hits = f.hits;
		}
		// 每个阶段结束就清空：没触发的故障不能漏到下一阶段去（「所有故障都确实触发过」单独核对）
		g.faults = [];
	};

	try {
		// ---------- 准备远端 S ----------
		let seeder = await openDevice(t, "seeder", report);
		const info0 = await seeder.client.info();
		report.serverVersion = info0.version;
		check(`[${t.mode}] 服务端是全新的空仓库`, (info0.latestSequence ?? 0) === 0 && (info0.encryptionState ?? "plaintext") === "plaintext", `version=${info0.version}`);
		await enableE2eeOnEmptyRemote(seeder.ctx, PASSWORD);
		await rescan(seeder);
		const preS = await preflight(seeder.ctx);
		await bootstrapLocalInit(seeder.ctx, preS);
		seeder.gate.markBound();
		const vmk = seeder.kr.requireKey();
		const blob = randomBytes(8192);
		const seedFiles: Array<[string, ArrayBuffer]> = [
			["keep.md", enc("两边一致的笔记\n")],
			["edit.md", enc("远端版本 v1\n")],
			["dir/remote-only.md", enc("只在远端的私密笔记\n")],
			["attach/blob.bin", blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer],
			["Case.md", enc("大小写改名之前的内容\n")],
			["tomb.md", enc("很久以前删掉的笔记\n")],
		];
		for (const [path, data] of seedFiles) {
			await seeder.vault.put(path, data);
			const out = await uploadFromPlain(seeder.ctx, path, data, 0, Date.now(), "upsert", { identity: { fileId: newFileId(), remote: "reserved" } });
			seeder.store.applyRemoteIdentity(path, { fileId: out.fileId, generation: out.generation, metaGeneration: out.metaGeneration, serverPseudonym: out.serverPseudonym });
			seeder.store.patchContentState(path, { hash: sha256(data), serverHash: out.cipherHash, revision: out.revision, mtime: Date.now(), size: data.byteLength });
		}
		const tombState = seeder.store.get("tomb.md")!;
		await seeder.client.remove("tomb.md", tombState.revision);
		seeder.store.markDeleted("tomb.md");
		await seeder.vault.remove("tomb.md");
		await seeder.store.save();
		if (t.mode === "path-e2ee") {
			const migrate = () =>
				encryptMetadata(seeder.ctx, { onProgress: () => {}, fullSync: async () => {}, allowIrreversibleComplete: true });
			let r;
			try {
				r = await migrate();
			} catch (e) {
				// 仓库信封下限还没提到 LSE3：先跑插件自己的「升级加密信封」，再迁移
				report.timeline.push(`路径加密迁移首次失败（${e instanceof Error ? e.message : String(e)}），先升级信封`);
				await upgradeEnvelopes(seeder.ctx, () => {});
				r = await migrate();
			}
			check(`[${t.mode}] 准备：路径加密迁移完成（不可逆抹除已执行）`, r.erased === true && r.metaState === "encrypted", `metaState=${r.metaState}`);
		}
		const infoS = await seeder.client.info();
		// 隐私核对窗口从这里开始：路径加密之前的种子上传本来就带明文路径
		const logAfterSeed = g.log.length;
		const seqAfterSeed = infoS.headSequence ?? infoS.latestSequence;
		check(`[${t.mode}] 准备：仓库状态`, t.mode === "path-e2ee" ? infoS.metaState === "encrypted" : infoS.metaState === "plain", `metaState=${infoS.metaState} formatEpoch=${infoS.formatEpoch}`);
		seeder = await restartDevice(t, seeder, report);
		seeder.store.state.bootstrap.metaState = infoS.metaState ?? "plain";
		seeder.store.state.bootstrap.formatEpoch = infoS.formatEpoch;
		const S = await readRemote(t, seeder, vmk);
		const tombId = (await trashIds(seeder)).size > 0 ? [...(await trashIds(seeder))][0] : "";
		check(`[${t.mode}] 准备：远端 S 有 5 个 live 对象、1 个墓碑`, S.size === 5 && tombId !== "", `live=${S.size}`);
		const seedExpected = new Map<string, ArrayBuffer>(seedFiles.filter(([p]) => p !== "tomb.md"));

		// ---------- A 阶段：首次接入入口（接入向导上下文） ----------
		const L1 = new Map<string, ArrayBuffer>([
			["keep.md", enc("两边一致的笔记\n")],
			["edit.md", enc("本地版本 v2\n")],
			["attach/blob.bin", enc("本地改过的二进制附件")],
			["case.md", enc("大小写改名之后的内容\n")],
			["tomb.md", enc("本地重新写的同名笔记\n")],
			["new/local-only.md", enc("本地新建的笔记\n")],
		]);
		const r1ref = { dev: await openDevice(t, "replacer-1", report) };
		for (const [p, d] of L1) await r1ref.dev.vault.put(p, d);
		await r1ref.dev.ctx.refreshE2ee();
		check(`[${t.mode}] A：新设备用仓库密码解锁`, (await r1ref.dev.kr.unlock(PASSWORD)) === "unlocked");
		await rescan(r1ref.dev);
		const preA: PreflightResult = await preflight(r1ref.dev.ctx);
		check(`[${t.mode}] A：preflight（继承锚：无）`, preA.inheritedTrust?.kind === "none" && preA.remoteFiles.length === 5);
		await rescan(r1ref.dev);
		const F1 = await planReplaceRemote(r1ref.dev.ctx, { vaultName: "", vaultChoice: "", bootstrapContext: true });
		check(
			`[${t.mode}] A：预览计数（覆盖 2 / 删除 2 / 新建 3 / 不变 1）`,
			F1.counts.update === 2 && F1.counts.delete === 2 && F1.counts.create === 3 && F1.counts.keep === 1,
			JSON.stringify(F1.counts),
		);
		const order = F1.items.filter((i) => i.action !== "keep").map((i) => `${i.action}:${i.path}`);
		check(`[${t.mode}] A：执行顺序——新建先于删除，占用被删名字的新建排在删除之后`, order.indexOf("create:new/local-only.md") < order.indexOf("delete:dir/remote-only.md") && order.indexOf("delete:Case.md") < order.indexOf("create:case.md"), order.join(" → "));
		check(`[${t.mode}] A：计划只预留身份，不写 FileState`, F1.items.filter((i) => i.action === "create").every((i) => r1ref.dev.store.get(i.path) === undefined));
		confirmReplaceJob(F1, "确认替换", Date.now());
		await saveRecoveryPoint(r1ref.dev.ctx, F1);
		await verifyRecoveryPoint(t, r1ref.dev, F1, S, vmk, check);
		const reserved = new Map(F1.items.filter((i) => i.action === "create").map((i) => [i.path, i.fileId]));
		addFaults("A/F1", [
			{ label: "F1：第 2 次上传响应丢失", kind: "drop-response", match: nth("PUT", "/api/v1/file", 2), remaining: 1, hits: 0 },
			{ label: "F1：第 1 次删除请求未到服务器", kind: "fail-before", match: nth("DELETE", "/api/v1/file", 1), remaining: 1, hits: 0 },
			{ label: "F1：第 1 次显式恢复响应丢失", kind: "drop-response", match: nth("POST", "/restore", 1), remaining: 1, hits: 0 },
		]);
		const a = await runWithRestarts(t, r1ref, F1, "A/F1", report);
		settleFaults();
		check(`[${t.mode}] A：F1 完成（经过 ${report.interruptions.filter((x) => x.phase === "A/F1").length} 次中断与重启续跑）`, a.state === "completed", a.reason);
		completeBootstrap(
			r1ref.dev.ctx,
			{ info: await r1ref.dev.client.info(), snapshotSequence: a.job.plannedHeadSequence, repoEpoch: a.job.repoEpoch, remoteFiles: [], localPaths: [], commonCount: 0, e2eeEnabled: true, inheritedTrust: preA.inheritedTrust },
			"local-replace",
		);
		await r1ref.dev.store.save();
		const afterF1 = await expectRemote(t, seeder, vmk, L1, "A：F1 之后远端 = 本地", check);
		check(`[${t.mode}] A：覆盖 / 不变的对象身份不变`, ["keep.md", "edit.md", "attach/blob.bin"].every((p) => afterF1.get(p)?.fileId === S.get(p)?.fileId));
		check(`[${t.mode}] A：覆盖的对象世代前进、只多一个 revision（重试被幂等吸收）`, ["edit.md", "attach/blob.bin"].every((p) => (afterF1.get(p)?.generation ?? 0) > (S.get(p)?.generation ?? 0) && afterF1.get(p)?.revision === (S.get(p)?.revision ?? 0) + 1));
		check(`[${t.mode}] A：新建对象就是计划里预留的身份`, afterF1.get("new/local-only.md")?.fileId === reserved.get("new/local-only.md"));
		check(`[${t.mode}] A：新建撞墓碑 → 恢复的是墓碑那个对象`, afterF1.get("tomb.md")?.fileId === tombId);
		check(`[${t.mode}] A：仅大小写不同的改名 → 同一对象换名`, afterF1.get("case.md")?.fileId === S.get("Case.md")?.fileId);
		const trashA = await trashIds(seeder);
		check(`[${t.mode}] A：远端独有文件走墓碑（可恢复）`, trashA.has(S.get("dir/remote-only.md")?.fileId ?? "-"));
		const restorePosts = g.log.slice(logAfterSeed).filter((x) => x.method === "POST" && x.url.includes("/restore")).length;
		const feed = await seeder.client.changes(seqAfterSeed, 500);
		const restoreChanges = (id: string): number => feed.changes.filter((c) => c.action === "restore" && c.fileId === id).length;
		check(
			`[${t.mode}] A：显式恢复幂等——墓碑与大小写改名对象各只被恢复一次（共发出 ${restorePosts} 次恢复请求，含响应丢失后的重发）`,
			restoreChanges(tombId) === 1 && restoreChanges(S.get("Case.md")?.fileId ?? "-") === 1 && restorePosts >= 3,
		);
		const editUpserts = feed.changes.filter((c) => c.action === "upsert" && c.fileId === S.get("edit.md")?.fileId).length;
		check(`[${t.mode}] A：响应丢失的那次覆盖只提交了一次`, editUpserts === 1, `upsert ${editUpserts} 次`);

		// 反向作业 V1（本设备已接入：普通作业）
		const V1 = buildReverseJob(a.job, Date.now(), { bootstrapContext: !r1ref.dev.store.bootstrapReady });
		r1ref.dev.gate.markBound();
		await refreshReverseWatermark(r1ref.dev.ctx, V1);
		confirmReplaceJob(V1, "确认替换", Date.now());
		await saveRecoveryPoint(r1ref.dev.ctx, V1);
		addFaults("A/V1", [
			{ label: "V1：第 1 次显式恢复响应丢失", kind: "drop-response", match: nth("POST", "/restore", 1), remaining: 1, hits: 0 },
			{ label: "V1：第 2 次上传请求未到服务器", kind: "fail-before", match: nth("PUT", "/api/v1/file", 2), remaining: 1, hits: 0 },
		]);
		const v1 = await runWithRestarts(t, r1ref, V1, "A/V1", report);
		settleFaults();
		check(`[${t.mode}] A：反向作业 V1 完成`, v1.state === "completed", v1.reason);
		const afterV1 = await expectRemote(t, seeder, vmk, seedExpected, "A：V1 之后远端回到 S", check);
		check(`[${t.mode}] A：回滚后每个对象仍是原身份`, [...seedExpected.keys()].every((p) => afterV1.get(p)?.fileId === S.get(p)?.fileId));
		check(`[${t.mode}] A：回滚是新 revision、世代继续前进（不回退任何计数器）`, ["edit.md", "attach/blob.bin", "dir/remote-only.md", "Case.md"].every((p) => (afterV1.get(p)?.revision ?? 0) > (afterF1.get(p)?.revision ?? S.get(p)?.revision ?? 0) && (afterV1.get(p)?.generation ?? 0) > (S.get(p)?.generation ?? 0)));
		const trashV1 = await trashIds(seeder);
		check(`[${t.mode}] A：原作业新建的、复活的对象回到删除状态`, trashV1.has(reserved.get("new/local-only.md") ?? "-") && trashV1.has(tombId));

		// ---------- B 阶段：已接入入口 ----------
		const r2ref = { dev: await openDevice(t, "replacer-2", report) };
		await r2ref.dev.ctx.refreshE2ee();
		await r2ref.dev.kr.unlock(PASSWORD);
		await rescan(r2ref.dev);
		const preB = await preflight(r2ref.dev.ctx);
		await bootstrapRemoteWins(r2ref.dev.ctx, preB, () => {});
		r2ref.dev.gate.markBound();
		check(`[${t.mode}] B：新设备 remote-wins 接入`, r2ref.dev.store.bootstrapReady && (await r2ref.dev.vault.files()).length === 5);
		const L2 = new Map(seedExpected);
		L2.set("edit.md", enc("R2 本地版本 v3\n"));
		L2.delete("keep.md");
		L2.set("r2-new.md", enc("R2 新建的笔记\n"));
		await r2ref.dev.vault.put("edit.md", L2.get("edit.md")!);
		await r2ref.dev.vault.remove("keep.md");
		await r2ref.dev.vault.put("r2-new.md", L2.get("r2-new.md")!);
		await rescan(r2ref.dev);
		const before2 = await readRemote(t, seeder, vmk);
		const F2 = await planReplaceRemote(r2ref.dev.ctx, { vaultName: "", vaultChoice: "", bootstrapContext: false });
		check(`[${t.mode}] B：预览计数（覆盖 1 / 删除 1 / 新建 1 / 不变 3）`, F2.counts.update === 1 && F2.counts.delete === 1 && F2.counts.create === 1 && F2.counts.keep === 3, JSON.stringify(F2.counts));
		confirmReplaceJob(F2, "确认替换", Date.now());
		await saveRecoveryPoint(r2ref.dev.ctx, F2);
		await verifyRecoveryPoint(t, r2ref.dev, F2, before2, vmk, check);
		const logBeforeF2 = g.log.length;
		addFaults("B/F2", [
			{ label: "F2：第 1 次删除响应丢失", kind: "drop-response", match: nth("DELETE", "/api/v1/file", 1), remaining: 1, hits: 0 },
			{ label: "F2：第 1 次上传响应丢失", kind: "drop-response", match: nth("PUT", "/api/v1/file", 1), remaining: 1, hits: 0 },
		]);
		const b = await runWithRestarts(t, r2ref, F2, "B/F2", report);
		settleFaults();
		check(`[${t.mode}] B：F2 完成`, b.state === "completed", b.reason);
		const afterF2 = await expectRemote(t, seeder, vmk, L2, "B：F2 之后远端 = 本地", check);
		check(`[${t.mode}] B：覆盖只多一个 revision、世代前进`, afterF2.get("edit.md")?.revision === (before2.get("edit.md")?.revision ?? 0) + 1 && (afterF2.get("edit.md")?.generation ?? 0) > (before2.get("edit.md")?.generation ?? 0));
		const deletes2 = g.log.slice(logBeforeF2).filter((x) => x.method === "DELETE").length;
		check(`[${t.mode}] B：删除响应丢失后重试被墓碑吸收（不报错、不重复删除）`, deletes2 >= 2 && (await trashIds(seeder)).has(before2.get("keep.md")?.fileId ?? "-"));

		const V2 = buildReverseJob(b.job, Date.now(), { bootstrapContext: false });
		await refreshReverseWatermark(r2ref.dev.ctx, V2);
		confirmReplaceJob(V2, "确认替换", Date.now());
		await saveRecoveryPoint(r2ref.dev.ctx, V2);
		addFaults("B/V2", [
			{ label: "V2：第 1 次显式恢复响应丢失", kind: "drop-response", match: nth("POST", "/restore", 1), remaining: 1, hits: 0 },
			{ label: "V2：第 1 次上传请求未到服务器", kind: "fail-before", match: nth("PUT", "/api/v1/file", 1), remaining: 1, hits: 0 },
		]);
		const v2 = await runWithRestarts(t, r2ref, V2, "B/V2", report);
		settleFaults();
		check(`[${t.mode}] B：反向作业 V2 完成`, v2.state === "completed", v2.reason);
		const afterV2 = await expectRemote(t, seeder, vmk, seedExpected, "B：V2 之后远端回到 S", check);
		check(`[${t.mode}] B：被删的 keep.md 按原身份恢复`, afterV2.get("keep.md")?.fileId === S.get("keep.md")?.fileId);
		check(`[${t.mode}] B：所有故障都确实触发过`, report.faults.every((f) => f.hits === 1), report.faults.filter((f) => f.hits !== 1).map((f) => f.label).join("、"));

		// ---------- 隐私：路径加密仓库全程没有真实路径进入请求 ----------
		const mine = g.log.slice(logStart);
		if (t.mode === "path-e2ee") {
			const after = g.log.slice(logAfterSeed);
			const leaked = after.filter((x) => x.filePath !== undefined && !isPseudonym(x.filePath));
			check(`[${t.mode}] 隐私：路径加密之后所有请求的寻址名都是伪名（${after.length} 个请求）`, leaked.length === 0, leaked.slice(0, 3).map((x) => `${x.method} ${x.filePath}`).join("；"));
		}
		report.requests = {
			total: mine.length,
			writes: mine.filter((x) => x.method !== "GET").length,
			faults: mine.filter((x) => x.status === "fault").length,
		};
	} catch (e) {
		report.error = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
		check(`[${t.mode}] 场景未抛出异常`, false, e instanceof Error ? e.message : String(e));
	}
	return report;
}

async function main(): Promise<void> {
	(globalThis as unknown as { window: unknown }).window = globalThis;
	const targets = JSON.parse(process.env.LS_INTEROP_TARGETS ?? "[]") as Target[];
	const out = process.env.LS_INTEROP_OUT ?? "";
	if (targets.length === 0 || !out) throw new Error("缺少 LS_INTEROP_TARGETS / LS_INTEROP_OUT（请用 scripts/interop/run.mjs 启动）");
	const started = new Date().toISOString();
	const modes: ModeReport[] = [];
	for (const t of targets) modes.push(await runTarget(t));
	const all = modes.flatMap((m) => m.checks);
	const result = {
		runner: "litesync scripts/interop replace-remote",
		startedAt: started,
		finishedAt: new Date().toISOString(),
		pluginCommit: process.env.LS_INTEROP_PLUGIN_SHA ?? "",
		server: process.env.LS_INTEROP_SERVER_DESC ?? "",
		node: process.version,
		summary: { passed: all.filter((c) => c.ok).length, failed: all.filter((c) => !c.ok).length, total: all.length },
		modes,
	};
	await writeFile(out, JSON.stringify(result, null, 2), "utf8");
	console.log(`\n${result.summary.passed}/${result.summary.total} 项通过 → ${out}`);
	process.exit(result.summary.failed === 0 ? 0 : 1);
}

void main().catch((e) => {
	console.error(e);
	process.exit(2);
});
