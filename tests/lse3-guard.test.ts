// v9.3 freshness 防护（decode 层）：HEAD 下载的 generation 不允许回退——
// 恶意服务器把同一文件的旧版本密文当最新 HEAD 重放时，客户端必须硬失败停止同步；
// 历史版本下载（本来就是旧 generation）豁免。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DownloadResult } from "../src/api/client";
import { createVaultKeyDoc, encryptFileV3 } from "../src/crypto/crypto";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import { SyncContext } from "../src/sync/context";
import { downloadPlain, versionPlain } from "../src/sync/transfer";

const VAULT_ID = "aabbccdd00112233";
const FILE_ID = "0123456789abcdef0123456789abcdef";

function memAdapter() {
	const files = new Map<string, string>();
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

test("HEAD 下载 generation 回退 → 硬失败停止同步", async () => {
	// 同一把钥匙：先造 gen 3 的密文，再让 ctx 持同一 vmk
	const { doc, vmk } = await createVaultKeyDoc("pw-guard");
	const old = await encryptFileV3(
		vmk,
		{ vaultId: VAULT_ID, keyEpoch: 1, fileId: FILE_ID, generation: 3 },
		new TextEncoder().encode("old content").buffer as ArrayBuffer,
	);

	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);
	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	store.state.bootstrap = { status: "ready", mode: "merge", remoteVaultId: VAULT_ID, keyEpoch: 1, completedAt: 0 };
	store.set("n.md", { hash: "h", serverHash: "s", revision: 5, mtime: 0, size: 1, fileId: FILE_ID, generation: 5 });
	const dl: DownloadResult = { data: old, revision: 6, hash: "", size: old.byteLength, mtime: 0, fileId: FILE_ID };
	const ctx = {
		store,
		e2ee: keyring,
		client: { download: async () => dl, version: async () => dl },
	} as unknown as SyncContext;

	// HEAD 下载：gen 3 < 已见 5 → 拒绝
	await assert.rejects(() => downloadPlain(ctx, "n.md"), /回退|generation/);

	// 历史版本下载：同一密文豁免检查，正常解出
	const v = await versionPlain(ctx, "n.md", 3);
	assert.equal(new TextDecoder().decode(v.plain), "old content");
	assert.equal(v.generation, 3);

	// generation 前进（gen 6）→ HEAD 正常接受并返回新 generation
	const fresh = await encryptFileV3(
		vmk,
		{ vaultId: VAULT_ID, keyEpoch: 1, fileId: FILE_ID, generation: 6 },
		new TextEncoder().encode("new content").buffer as ArrayBuffer,
	);
	dl.data = fresh;
	const head = await downloadPlain(ctx, "n.md");
	assert.equal(head.generation, 6);
	assert.equal(new TextDecoder().decode(head.plain), "new content");
});

test("TOFU：本地无已见 generation（新设备/新文件）时接受首个值", async () => {
	const { doc, vmk } = await createVaultKeyDoc("pw-tofu");
	const payload = await encryptFileV3(
		vmk,
		{ vaultId: VAULT_ID, keyEpoch: 1, fileId: FILE_ID, generation: 42 },
		new TextEncoder().encode("first sight").buffer as ArrayBuffer,
	);
	const keyring = new Keyring();
	keyring.adopt({ ...doc, enabled: true }, vmk);
	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	store.state.bootstrap = { status: "ready", mode: "merge", remoteVaultId: VAULT_ID, keyEpoch: 1, completedAt: 0 };
	const dl: DownloadResult = { data: payload, revision: 1, hash: "", size: payload.byteLength, mtime: 0, fileId: FILE_ID };
	const ctx = {
		store,
		e2ee: keyring,
		client: { download: async () => dl, version: async () => dl },
	} as unknown as SyncContext;

	const head = await downloadPlain(ctx, "n.md");
	assert.equal(head.generation, 42);
});
