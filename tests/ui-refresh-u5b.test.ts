// UI 焕新 U5b（ui-refresh 04-CC-TASKS U5；06-ACCEPTANCE D 节 P04 / P10）：状态栏与设置的词表。
//
// 覆盖：
//   状态栏中文化，与状态卡同一套词：已同步 / 同步中 / N 个冲突 / 已锁定
//   引擎的 offline 不只是断网：凭据被拒写「需要重新连接」，确定离线才写「离线」，其余写「同步暂停」，
//     原因放进悬停提示（aria-label），不让一个笼统的「离线」把人引去查网络
//   锁定的提示如实说明：只暂停本设备的同步与解密，本机笔记仍可阅读
//   「忘记此设备」改名「清除自动解锁材料并锁定」（它不撤销授权、不断开仓库），旧名留作设置搜索别名；
//     「添加新设备」改名「连接新设备」，旧名同样可搜
//
// INV：不涉及同步不变量（只改界面文字与说明）；状态判定仍来自引擎已有的事实（状态、冲突数、凭据被拒）。
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { createFragment: unknown }).createFragment = (fn: (f: unknown) => void) => {
	const node = { appendText: () => {}, createEl: () => node, createDiv: () => node, createSpan: () => node };
	fn(node);
	return node;
};

import { SyncSettingTab } from "../src/settings";
import { StatusBarInput, statusBarLabel } from "../src/status-summary";

const bar = (over: Partial<StatusBarInput>) =>
	statusBarLabel({ status: "idle", conflicts: 0, credentialRejected: false, online: true, ...over });

test("状态栏：中文，与状态卡同一套词", () => {
	assert.equal(bar({ status: "synced" }).text, "✓ 已同步");
	assert.equal(bar({ status: "syncing" }).text, "↻ 同步中");
	assert.equal(bar({ status: "locked" }).text, "🔒 已锁定");
	assert.equal(bar({ status: "idle" }).text, "LiteSync");
	for (const s of ["synced", "syncing", "locked", "conflict", "offline"] as const) {
		assert.doesNotMatch(bar({ status: s }).text, /Synced|Syncing|Locked|Conflict|Offline/, s);
	}
});

test("状态栏：有未解决冲突时显示计数（同步中 / 已锁定除外），提示里说可以点击查看", () => {
	assert.equal(bar({ status: "synced", conflicts: 2 }).text, "! 2 个冲突");
	assert.match(bar({ status: "synced", conflicts: 2 }).tip, /2 个冲突待处理/);
	assert.equal(bar({ status: "syncing", conflicts: 2 }).text, "↻ 同步中");
	assert.equal(bar({ status: "locked", conflicts: 2 }).text, "🔒 已锁定");
});

test("状态栏：锁定的提示如实说明本机笔记仍可阅读", () => {
	const t = bar({ status: "locked" }).tip;
	assert.match(t, /同步暂停/);
	assert.match(t, /本机笔记仍可阅读/);
});

test("状态栏：offline 按已知事实分开说——需要重新连接 / 离线 / 同步暂停，原因进提示", () => {
	const rejected = bar({ status: "offline", credentialRejected: true, detail: "设备凭据已失效" });
	assert.equal(rejected.text, "× 需要重新连接");
	assert.match(rejected.tip, /设备凭据已失效/);
	assert.equal(bar({ status: "offline", online: false }).text, "× 离线");
	const paused = bar({ status: "offline", detail: "账号中心暂时无法确认你的登录状态，稍后自动重试" });
	assert.equal(paused.text, "× 同步暂停", "联网但同步没成功：不说「离线」");
	assert.match(paused.tip, /^LiteSync：账号中心暂时无法确认/);
});

// ---------- 设置的词表 ----------

interface Def {
	type?: string;
	name?: string;
	desc?: unknown;
	aliases?: string[];
	items?: Def[];
}

function fakePlugin() {
	return {
		configured: true,
		bootstrapReady: true,
		settings: { syncIntervalSeconds: 30, padObjectSizes: false, experimentalMetaEncryption: false, timingBatchSeconds: 60, mtimeGranularitySeconds: 0, replaceRemoteEnabled: false },
		replaceJobNeedsAttention: () => false,
		statusInput: () => ({
			configured: true,
			bootstrapReady: true,
			credentialRejected: false,
			e2ee: "unlocked",
			vaultName: "笔记",
			lastSyncAt: 0,
			conflicts: 0,
			migrationPending: false,
			keyPolicyText: "严格会话解锁",
			syncing: false,
			now: 1,
		}),
		e2eeStatusText: () => ({ desc: "", action: "锁定" }),
		keyPolicyText: () => "严格会话解锁",
		trustMigrationPending: () => false,
		hasTrustedDevice: () => true,
		metaMigrationActive: () => false,
	};
}

function flat(): Def[] {
	const tab = new SyncSettingTab({} as never, fakePlugin() as never);
	const out: Def[] = [];
	const walk = (items: Def[]) => {
		for (const d of items) {
			if (d.items) walk(d.items);
			if (d.name) out.push(d);
		}
	};
	walk(tab.getSettingDefinitions() as unknown as Def[]);
	return out;
}

test("词表：清除自动解锁材料并锁定（旧称忘记此设备）——说明它不撤销授权、不删本机笔记", () => {
	const item = flat().find((d) => d.name === "清除自动解锁材料并锁定");
	assert.ok(item, "按实际行为命名");
	assert.ok(item.aliases?.includes("忘记此设备"), "旧名仍能搜到");
	assert.match(String(item.desc), /不会撤销本设备的同步授权/);
	assert.match(String(item.desc), /不会删除本机笔记/);
	assert.ok(!flat().some((d) => d.name === "忘记此设备"));
});

test("词表：连接新设备（旧称添加新设备）；撤销设备授权在网页里做", () => {
	const add = flat().find((d) => d.name === "连接新设备");
	assert.ok(add?.aliases?.includes("添加新设备"));
	const devices = flat().find((d) => d.name === "已连接设备");
	assert.match(String(devices?.desc), /撤销设备授权在网页里做/);
});
