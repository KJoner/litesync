// v8 Bootstrap + 配对测试：场景分类、状态迁移、配对包加解密与链接解析。
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBootstrap } from "../src/bootstrap/bootstrap-types";
import {
	b64urlDecode,
	buildPairUrl,
	decryptPairingConfig,
	encryptPairingConfig,
	newPairSecret,
	PairingConfig,
	parsePairUrl,
} from "../src/pairing/pairing";
import { StateStore } from "../src/state/store";

function memAdapter(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error("not found");
			return v;
		},
		write: async (p: string, data: string) => {
			files.set(p, data);
		},
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

test("classifyBootstrap: 四象限场景矩阵", () => {
	assert.equal(classifyBootstrap(0, 0), "both-empty");
	assert.equal(classifyBootstrap(5, 0), "local-only");
	assert.equal(classifyBootstrap(0, 7), "remote-only");
	assert.equal(classifyBootstrap(5, 7), "both");
});

test("StateStore: 全新设备 bootstrap 为 pending，完成/重置往返", async () => {
	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	assert.equal(store.bootstrapReady, false);

	store.completeBootstrap("remote-wins", "vault-abc", 42);
	assert.equal(store.bootstrapReady, true);
	assert.equal(store.state.bootstrap.remoteVaultId, "vault-abc");
	assert.equal(store.state.bootstrap.snapshotSequence, 42);
	await store.save();

	const store2 = new StateStore(memAdapter(), "state.json");
	// 不共享 adapter：模拟全新加载仍是 pending
	await store2.load();
	assert.equal(store2.bootstrapReady, false);

	store.resetBootstrap();
	assert.equal(store.bootstrapReady, false);
});

test("StateStore: v0.8 之前的老设备（已在同步中）自动视为已接入", async () => {
	const legacy = JSON.stringify({
		deviceId: "dev-1",
		lastSequence: 99,
		files: { "n.md": { hash: "h", serverHash: "h", revision: 3, mtime: 1, size: 1 } },
		conflicts: {},
		e2ee: null,
		shares: {},
	});
	const store = new StateStore(memAdapter({ "state.json": legacy }), "state.json");
	await store.load();
	assert.equal(store.bootstrapReady, true, "升级用户绝不能被向导拦住");
	assert.equal(store.state.bootstrap.mode, "legacy");
});

test("StateStore: 老版本但从未同步过（空 state）仍需接入", async () => {
	const empty = JSON.stringify({ deviceId: "dev-2", lastSequence: 0, files: {} });
	const store = new StateStore(memAdapter({ "state.json": empty }), "state.json");
	await store.load();
	assert.equal(store.bootstrapReady, false);
});

test("pairing: 配对包加解密往返；错误密钥与篡改均失败", async () => {
	const config: PairingConfig = {
		v: 1,
		serverUrl: "https://sync.example.com",
		apiToken: "token-0123456789abcdef",
		syncIntervalSeconds: 60,
		syncObsidian: false,
		ignorePatterns: ".trash/**",
	};
	const secret = newPairSecret();
	const ct = await encryptPairingConfig(secret, config);
	assert.ok(!ct.includes("token-0123456789abcdef"), "密文不能包含明文 Token");

	const back = await decryptPairingConfig(secret, ct);
	assert.deepEqual(back, config);

	const wrong = newPairSecret();
	assert.equal(await decryptPairingConfig(wrong, ct), null);

	const tampered = ct.slice(0, -6) + (ct.endsWith("A") ? "BBBBBB" : "AAAAAA");
	assert.equal(await decryptPairingConfig(secret, tampered), null);
});

test("pairing: 配对链接构造/解析往返；secret 只在 fragment", () => {
	const secret = newPairSecret();
	const id = "0123456789abcdef0123456789abcdef";
	const url = buildPairUrl("https://sync.example.com/", id, secret);
	assert.ok(url.startsWith("https://sync.example.com/p/" + id + "#secret="), url);

	const parsed = parsePairUrl(url);
	assert.ok(parsed);
	assert.equal(parsed.serverUrl, "https://sync.example.com");
	assert.equal(parsed.id, id);
	assert.deepEqual(Array.from(b64urlDecode(parsed.secretB64url)), Array.from(secret));

	// 无 secret / 非配对路径 / 垃圾输入
	assert.equal(parsePairUrl("https://sync.example.com/p/" + id), null);
	assert.equal(parsePairUrl("https://sync.example.com/share/xyz#secret=aa"), null);
	assert.equal(parsePairUrl("not a url"), null);

	// v9 P1-15：配对包含 Token，非 loopback 的 http:// 一律拒绝；loopback 放行（本机调试）
	assert.equal(parsePairUrl("http://sync.example.com/p/" + id + "#secret=aa"), null);
	assert.equal(parsePairUrl("http://192.168.1.10:8080/p/" + id + "#secret=aa"), null);
	assert.ok(parsePairUrl("http://127.0.0.1:8080/p/" + id + "#secret=aa"));
	assert.ok(parsePairUrl("http://localhost:8080/p/" + id + "#secret=aa"));
});
