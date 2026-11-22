// v0.20 设置页重整与首屏状态卡（UI 规格 D06、需求 §10.5，验收 UI-04 的结构部分）。
//
// 覆盖：
//   首屏状态卡：「设备授权」与「仓库解锁」分两行；主按钮只有一个，按最先挡住同步的事决定
//   概览 + 任务子页（UI 焕新 U5b）：状态卡 /（未连接时）开始使用 / 连接与设备、同步选项、仓库密码与锁定、
//     恢复与帮助、高级与诊断五个原生子页；未连接时只显示用得上的子页
//   新手入口：未连接时首页显示「粘贴连接链接」「打开网页注册或登录」；手工 Server URL / API Token 只在高级与诊断里
//   密钥持久化开关只在高级里；实验功能折叠为高级下的子页面
//   0.20.1 阶段保护：「用本地完整替换远端」执行入口默认关闭（高级区显式开关、注明验收阶段）；
//     关闭时只读预览与未完成作业的诊断 / 放弃 / 回滚入口照常可见，不是静默失效
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

import { DEFAULT_SETTINGS, SyncSettingTab } from "../src/settings";
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

function fakePlugin(configured: boolean, opts: { replaceEnabled?: boolean; jobAttention?: boolean } = {}) {
	return {
		configured,
		bootstrapReady: configured,
		settings: {
			padObjectSizes: false,
			experimentalMetaEncryption: false,
			timingBatchSeconds: 60,
			mtimeGranularitySeconds: 0,
			replaceRemoteEnabled: opts.replaceEnabled ?? false,
		},
		replaceJobNeedsAttention: () => opts.jobAttention ?? false,
		statusInput: () => input({ configured, bootstrapReady: configured }),
		e2eeStatusText: () => ({ desc: "", action: "" }),
		keyPolicyText: () => "严格会话解锁",
		trustMigrationPending: () => false,
		hasTrustedDevice: () => false,
		metaMigrationActive: () => false,
	};
}

function defs(configured: boolean, opts: { replaceEnabled?: boolean; jobAttention?: boolean } = {}): Def[] {
	const tab = new SyncSettingTab({} as never, fakePlugin(configured, opts) as never);
	return tab.getSettingDefinitions() as unknown as Def[];
}

function visible(d: Def): boolean {
	return typeof d.visible === "function" ? d.visible() : d.visible !== false;
}

/** 递归收集**看得见**的设置项：跳过不可见的分组与子页（及其下的一切）。 */
function shown(items: Def[], inPage = false, acc: Array<Def & { inPage: boolean }> = []): Array<Def & { inPage: boolean }> {
	for (const d of items) {
		if (!visible(d)) continue;
		if (d.items) shown(d.items, inPage || d.type === "page", acc);
		else acc.push({ ...d, inPage });
	}
	return acc;
}

/** 递归收集某层级下所有设置项（含子页面）。 */
function all(items: Def[], inPage = false, acc: Array<Def & { inPage: boolean }> = []): Array<Def & { inPage: boolean }> {
	for (const d of items) {
		if (d.items) all(d.items, inPage || d.type === "page", acc);
		else acc.push({ ...d, inPage });
	}
	return acc;
}

test("首页是概览 + 任务子页：状态卡在首位，未连接时有「开始使用」，随后五个原生子页", () => {
	const d = defs(true);
	assert.equal(d[0].cls, "litesync-status-card");
	assert.equal(d[1].heading, "开始使用");
	assert.equal(visible(d[1]), false, "已连接时不再显示开始使用");
	assert.deepEqual(
		(d[2].items ?? []).map((x) => `${x.type}:${x.name}`),
		["page:连接与设备", "page:同步选项", "page:仓库密码与锁定", "page:恢复与帮助", "page:高级与诊断"],
	);
	const fresh = defs(false);
	assert.equal(visible(fresh[1]), true);
	assert.deepEqual(
		(fresh[2].items ?? []).filter(visible).map((x) => x.name),
		["同步选项", "恢复与帮助", "高级与诊断"],
		"未连接：没有内容的子页（连接与设备、仓库密码与锁定）不显示",
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

test("新手入口：未连接时首页显示粘贴连接链接与打开网页；连接后它们收起，日常入口在子页里", () => {
	const freshTop = shown(defs(false)).filter((i) => !i.inPage).map((i) => i.name);
	assert.deepEqual(freshTop, ["LiteSync", "粘贴连接链接", "打开网页注册或登录"], "首页只有状态卡与两个入口");
	assert.ok(!shown(defs(false)).some((i) => i.name === "连接新设备"), "未连接时看不到连接新设备");

	const bound = shown(defs(true));
	assert.deepEqual(bound.filter((i) => !i.inPage).map((i) => i.name), ["LiteSync"], "已连接：首页只剩状态卡与子页入口");
	const inPages = bound.filter((i) => i.inPage).map((i) => i.name);
	for (const n of ["当前仓库", "连接新设备", "已连接设备", "密钥保存方式", "检查云端更新"]) assert.ok(inPages.includes(n), n);
	assert.ok(inPages.includes("本地文件说明"), "如实说明 Obsidian 本地文件仍是明文");
});

// ---------- 0.20.1 阶段保护：用本地完整替换远端 ----------

test("阶段保护：完整替换远端的执行入口默认关闭，开关只在高级区，文案注明处于验收阶段", () => {
	assert.equal(DEFAULT_SETTINGS.replaceRemoteEnabled, false, "新安装与升级后都默认关闭");
	const items = all(defs(true));
	const toggle = items.find((i) => i.control?.key === "replaceRemoteEnabled");
	assert.ok(toggle, "有一个显式开关");
	assert.equal(toggle?.inPage, true, "开关在「高级」子页面里");
	assert.match(toggle?.name ?? "", /验收阶段/);
	const visibleNames = items.filter((i) => visible(i)).map((i) => i.name);
	assert.ok(!visibleNames.includes("用本地完整替换远端"), "默认看不到执行入口");
	assert.ok(visibleNames.includes("预览本地与远端的差异（只读）"), "只读预览保留");
	assert.ok(!visibleNames.includes("替换作业：诊断、放弃或回滚"), "没有作业时不出现恢复入口");
});

test("阶段保护：关闭时未完成/部分完成的作业仍有诊断、放弃、回滚入口；开启后才出现执行入口", () => {
	const attention = all(defs(true, { jobAttention: true })).filter((i) => visible(i)).map((i) => i.name);
	assert.ok(attention.includes("替换作业：诊断、放弃或回滚"), "关闭开关不能把半途的作业变成无人可管");
	assert.ok(!attention.includes("用本地完整替换远端"));

	const enabled = all(defs(true, { replaceEnabled: true })).filter((i) => visible(i)).map((i) => i.name);
	assert.ok(enabled.includes("用本地完整替换远端"), "显式开启后出现执行入口");
	assert.ok(!enabled.includes("预览本地与远端的差异（只读）"));

	const fresh = all(defs(false)).filter((i) => visible(i)).map((i) => i.name);
	assert.ok(!fresh.includes("预览本地与远端的差异（只读）"), "未接入的设备不显示");
});
