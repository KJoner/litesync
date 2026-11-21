// v0.20 设置页重整与首屏状态卡（UI 规格 D06、需求 §10.5，验收 UI-04 的结构部分）。
//
// 覆盖：
//   首屏状态卡：「设备授权」与「仓库解锁」分两行；主按钮只有一个，按最先挡住同步的事决定
//   四节结构：连接与仓库 / 同步 / 加密与设备 / 高级（子页面）
//   新手入口：未连接时显示「粘贴连接链接」「打开网页注册或登录」；手工 Server URL / API Token 只在高级里
//   密钥持久化开关只在高级里；实验功能折叠为高级下的子页面
//
// 真实 Obsidian 宿主中的渲染、主题、移动端无横向溢出须真机检查（手册 T5.25），这里只钉结构。
// INV: INV-10（凭据入口集中在高级区的手动连接里，改动即触发重新绑定的路径不变）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { createFragment: unknown }).createFragment = (fn: (f: unknown) => void) => {
	const node = {
		appendText: () => {},
		createEl: () => node,
		createDiv: () => node,
		createSpan: () => node,
	};
	fn(node);
	return node;
};

import { SyncSettingTab } from "../src/settings";
import { primaryAction, StatusInput, summarizeStatus } from "../src/status-summary";

function input(over: Partial<StatusInput> = {}): StatusInput {
	return {
		configured: true,
		bootstrapReady: true,
		credentialRejected: false,
		e2ee: "unlocked",
		vaultName: "个人笔记",
		lastSyncAt: 0,
		conflicts: 0,
		migrationPending: false,
		keyPolicyText: "严格会话解锁",
		syncing: false,
		now: 1_000_000,
		...over,
	};
}

test("主按钮只有一个：连接 → 重新连接 → 完成接入 → 解锁 → 立即同步", () => {
	assert.equal(primaryAction(input({ configured: false })).kind, "connect");
	assert.equal(primaryAction(input({ credentialRejected: true, e2ee: "locked" })).kind, "reconnect");
	assert.equal(primaryAction(input({ bootstrapReady: false, e2ee: "locked" })).kind, "finish-setup");
	assert.equal(primaryAction(input({ e2ee: "locked" })).kind, "unlock");
	assert.equal(primaryAction(input()).kind, "sync-now");
	assert.equal(primaryAction(input({ syncing: true })).label, "同步中…");
});

test("状态卡：设备授权与仓库解锁分两行显示，锁定时说明待同步修改保留在本机", () => {
	const s = summarizeStatus(input({ e2ee: "locked", conflicts: 2, migrationPending: true, keyPolicyText: "旧设备信任待迁移" }));
	const labels = s.lines.map((l) => l.label);
	assert.deepEqual(labels, ["仓库", "设备授权", "仓库解锁", "密钥保存", "最近同步", "冲突"]);
	const unlock = s.lines.find((l) => l.label === "仓库解锁")!;
	assert.match(unlock.value, /已锁定/);
	assert.match(unlock.value, /待同步的修改保留在本机/);
	assert.equal(s.lines.find((l) => l.label === "设备授权")!.value, "已授权");
	assert.deepEqual(
		s.secondary.map((x) => x.kind),
		["migrate", "conflicts"],
	);
	// 不只靠颜色：每一行都有文字
	assert.ok(s.lines.every((l) => l.value.length > 0));
});

test("状态卡：凭据被拒时设备授权显示失效并给出下一步；未启用 E2EE 如实说明", () => {
	const s = summarizeStatus(input({ credentialRejected: true, e2ee: "disabled" }));
	assert.match(s.lines.find((l) => l.label === "设备授权")!.value, /已失效/);
	assert.match(s.lines.find((l) => l.label === "仓库解锁")!.value, /未启用端到端加密/);
	assert.equal(s.primary.label, "重新连接");
});

interface Def {
	type?: string;
	heading?: string;
	name?: string;
	items?: Def[];
	visible?: boolean | (() => boolean);
	control?: { key: string };
	cls?: string;
}

function fakePlugin(configured: boolean) {
	return {
		configured,
		bootstrapReady: configured,
		settings: { padObjectSizes: false, experimentalMetaEncryption: false, timingBatchSeconds: 60, mtimeGranularitySeconds: 0 },
		statusInput: () => input({ configured, bootstrapReady: configured }),
		e2eeStatusText: () => ({ desc: "", action: "" }),
		keyPolicyText: () => "严格会话解锁",
		trustMigrationPending: () => false,
		hasTrustedDevice: () => false,
		metaMigrationActive: () => false,
	};
}

function defs(configured: boolean): Def[] {
	const tab = new SyncSettingTab({} as never, fakePlugin(configured) as never);
	return tab.getSettingDefinitions() as unknown as Def[];
}

function visible(d: Def): boolean {
	return typeof d.visible === "function" ? d.visible() : d.visible !== false;
}

/** 递归收集某层级下所有设置项（含子页面）。 */
function all(items: Def[], inPage = false, acc: Array<Def & { inPage: boolean }> = []): Array<Def & { inPage: boolean }> {
	for (const d of items) {
		if (d.items) all(d.items, inPage || d.type === "page", acc);
		else acc.push({ ...d, inPage });
	}
	return acc;
}

test("四节结构：状态卡在首位，随后 连接与仓库 / 同步 / 加密与设备，最后是「高级」子页面", () => {
	const d = defs(true);
	assert.equal(d[0].cls, "litesync-status-card");
	assert.deepEqual(
		d.slice(1).map((x) => x.heading ?? `${x.type}:${x.name}`),
		["连接与仓库", "同步", "加密与设备", "page:高级"],
	);
});

test("手工 Server URL / API Token、密钥持久化开关、实验功能都只在高级子页面里", () => {
	const items = all(defs(false));
	const byName = (n: string) => items.find((i) => i.name === n);
	assert.equal(byName("Server URL")?.inPage, true);
	assert.equal(byName("API Token")?.inPage, true);
	assert.equal(byName("测试连接")?.inPage, true);
	const trust = items.find((i) => i.control?.key === "trustDevice");
	assert.equal(trust?.inPage, true, "「本设备自动解锁」是高级区的显式选择");
	assert.equal(items.find((i) => i.control?.key === "experimentalMetaEncryption")?.inPage, true);
	// 首屏（非子页面）没有任何凭据输入
	assert.ok(!items.some((i) => !i.inPage && (i.name === "Server URL" || i.name === "API Token")));
});

test("新手入口：未连接时首屏显示粘贴连接链接与打开网页；连接后换成日常入口", () => {
	const fresh = all(defs(false)).filter((i) => !i.inPage && visible(i)).map((i) => i.name);
	assert.ok(fresh.includes("粘贴连接链接"));
	assert.ok(fresh.includes("打开网页注册或登录"));
	assert.ok(!fresh.includes("添加新设备"));

	const bound = all(defs(true)).filter((i) => !i.inPage && visible(i)).map((i) => i.name);
	assert.ok(!bound.includes("粘贴连接链接"));
	assert.ok(bound.includes("当前仓库"));
	assert.ok(bound.includes("添加新设备"));
	assert.ok(bound.includes("密钥保存方式"));
	assert.ok(bound.includes("本地文件说明"), "如实说明 Obsidian 本地文件仍是明文");
});
