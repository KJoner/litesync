// v0.13.1 验收矩阵中尚未被其他测试覆盖的两条（计划书 §5.7 第 3、4 项）。
//
//   3. bootstrap 中途断网
//   4. bootstrap 中途进程被杀
//
// 两者的共同红线：接入没有真正完成之前，绝不能把仓库标记为 ready。
// 一旦提前标 ready，重启后插件会跳过接入向导直接开始同步，
// 把「只下载了一半」的本地状态当成权威——那会把没下载到的远端文件
// 当作「本地已删除」推上去，等于用一次中断的接入删掉别人的数据。
//
// INV: INV-03（远端变更不静默丢弃）/ INV-04（接入未完成前不进入常规同步）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { ServerInfo, SnapshotFile } from "../src/api/client";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { bootstrapRemoteWins, PreflightResult } from "../src/bootstrap/bootstrap-manager";
import { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { LocalCommitter } from "../src/sync/local-commit";
import { PendingQueue } from "../src/sync/queue";

const PLUGIN_DIR = ".obsidian/plugins/litesync";

function memAdapter() {
	const files = new Map<string, string>();
	return {
		files,
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	};
}

function memVault() {
	const files = new Map<string, ArrayBuffer>();
	const folders = new Set<string>();
	const adapter = {
		exists: async (p: string) => files.has(p) || folders.has(p),
		mkdir: async (p: string) => void folders.add(p),
		stat: async (p: string) =>
			files.has(p)
				? { type: "file" as const, mtime: 1, size: files.get(p)!.byteLength }
				: folders.has(p)
					? { type: "folder" as const, mtime: 1, size: 0 }
					: null,
		readBinary: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`ENOENT ${p}`);
			return v;
		},
		writeBinary: async (p: string, d: ArrayBuffer) => void files.set(p, d.slice(0)),
		rename: async (from: string, to: string) => {
			const v = files.get(from);
			if (v === undefined) throw new Error(`ENOENT ${from}`);
			if (files.has(to)) throw new Error(`EEXIST ${to}`);
			files.delete(from);
			files.set(to, v);
		},
		remove: async (p: string) => void files.delete(p),
		list: async () => ({ files: [] as string[], folders: [] as string[] }),
	};
	return { files, adapter };
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

const serverInfo: ServerInfo = {
	version: "test",
	latestSequence: 9,
	serverTime: 0,
	protocolVersion: 6,
	minProtocolVersion: 6,
	vaultId: "vault-0123456789ab",
	repoEpoch: "epoch-1",
	keyEpoch: 1,
	formatEpoch: 1,
	minimumEnvelopeVersion: 3,
	schemaVersion: 6,
} as unknown as ServerInfo;

function remoteFile(path: string, revision: number): SnapshotFile {
	return { path, hash: `h-${path}`, size: 3, revision, mtime: 1 } as unknown as SnapshotFile;
}

async function fixture(downloadImpl: (path: string) => Promise<unknown>) {
	const stateAdapter = memAdapter();
	const store = new StateStore(stateAdapter as unknown as ConstructorParameters<typeof StateStore>[0], "state.json");
	await store.load();
	const vault = memVault();
	const app = { vault: { adapter: vault.adapter, configDir: ".obsidian", getFiles: () => [] } };

	const ctx = {
		app,
		store,
		queue: new PendingQueue(),
		gate: new SyncGate(),
		e2ee: new Keyring(),
		committer: new LocalCommitter(app as never, PLUGIN_DIR),
		client: { download: downloadImpl },
		ignores: () => false,
		syncObsidian: () => false,
		padsSize: () => false,
		deviceName: () => "test",
		pluginDir: () => PLUGIN_DIR,
		log: () => {},
		notify: () => {},
	} as unknown as SyncContext;

	const pre: PreflightResult = {
		info: serverInfo,
		snapshotSequence: 9,
		repoEpoch: "epoch-1",
		remoteFiles: [remoteFile("a.md", 1), remoteFile("b.md", 2), remoteFile("c.md", 3)],
		localPaths: [],
		commonCount: 0,
		e2eeEnabled: false,
	};
	return { ctx, store, vault, pre, stateAdapter };
}

test("§5.7-3: bootstrap 中途断网 → 不标 ready，已下载的部分保留", async () => {
	let n = 0;
	const { ctx, store, vault, pre } = await fixture(async (path: string) => {
		if (++n === 2) throw new Error("network error");
		return { data: bytes(`内容-${path}`), revision: 1, mtime: 0, hash: "" };
	});

	await assert.rejects(() => bootstrapRemoteWins(ctx, pre, () => {}), /network error/);

	assert.equal(store.state.bootstrap.status, "pending", "接入未完成，绝不能标记为 ready");
	assert.equal(store.state.lastSequence, 0, "游标不得提前推进（否则会漏掉未处理的远端变更）");
	// 已经下载成功的那份内容留在本地是安全的：重跑接入时会按内容一致直接建档
	assert.equal(vault.files.size >= 1, true);
});

test("§5.7-4: bootstrap 中途进程被杀 → 盘上状态仍是 pending，重启回到向导", async () => {
	let n = 0;
	class ProcessKilled extends Error {}
	const { ctx, store, vault, pre, stateAdapter } = await fixture(async (path: string) => {
		if (++n === 3) throw new ProcessKilled("killed");
		return { data: bytes(`内容-${path}`), revision: 1, mtime: 0, hash: "" };
	});
	// 模拟被杀之前发生过一次状态保存（比如上一轮同步）
	await store.save();

	await assert.rejects(() => bootstrapRemoteWins(ctx, pre, () => {}), ProcessKilled);

	// 「重启」：只看盘上的东西
	const store2 = new StateStore(
		stateAdapter as unknown as ConstructorParameters<typeof StateStore>[0],
		"state.json",
	);
	await store2.load();
	assert.equal(store2.state.bootstrap.status, "pending", "重启后必须回到接入向导");
	assert.equal(store2.state.lastSequence, 0);
	assert.equal(vault.files.size, 2, "已下载的两份内容留在本地，不会被当作『本地删除』推上去");
});

test("§5.7-3/4: 接入成功走完才会标 ready 并锚定游标", async () => {
	const { ctx, store, pre } = await fixture(async (path: string) => ({
		data: bytes(`内容-${path}`),
		revision: 1,
		mtime: 0,
		hash: "",
	}));

	await bootstrapRemoteWins(ctx, pre, () => {});

	assert.equal(store.state.bootstrap.status, "ready");
	assert.equal(store.state.lastSequence, 9, "游标锚定到快照序号");
	assert.equal(store.state.bootstrap.repoEpoch, "epoch-1");
});
