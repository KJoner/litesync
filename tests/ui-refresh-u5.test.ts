// UI 焕新 U5（ui-refresh 04-CC-TASKS U5；审查 UX-06 / UX-07）：Obsidian 原生设置的有效值与去向。
//
// 覆盖：
//   手机上「检查云端更新」只列真正生效的频率（≥ 60 秒）；存着 15 / 30 秒的设备显示实际执行的 60 秒，
//     不改写存储的偏好（桌面仍照原值执行）
//   手机上不显示「同步 Obsidian 配置目录」开关，改为同名的「此设备不支持」说明；桌面照常是开关
//   改名后旧名字仍能在设置搜索里找到（同步间隔 → 检查云端更新，设备列表 → 已连接设备）
//   设备管理去网页的「账号与设备」（<网页>/#/me）：保留自托管子路径；不能用于网页的地址不生成假入口
//
// 冲突解决窗口（中文动作、aria-pressed、已处理 X / N、保存禁用与原因）在真实 Obsidian 宿主里取证，
// 见交付记录 U5；这里不重复搭 DOM。
// INV：不涉及同步不变量（只改界面与说明）；设置项的存储值不变，INV-10 的重新绑定路径不受影响。
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { createFragment: unknown }).createFragment = (fn: (f: unknown) => void) => {
	const node = { appendText: () => {}, createEl: () => node, createDiv: () => node, createSpan: () => node };
	fn(node);
	return node;
};

import { Platform } from "obsidian";
import { deviceManageUrl } from "../src/onboarding";
import { SyncSettingTab } from "../src/settings";

interface Def {
	type?: string;
	name?: string;
	aliases?: string[];
	items?: Def[];
	visible?: boolean | (() => boolean);
	control?: { key: string; type?: string; options?: Record<string, string> };
	render?: unknown;
}

function fakePlugin(syncIntervalSeconds: number) {
	return {
		configured: true,
		bootstrapReady: true,
		settings: {
			syncIntervalSeconds,
			padObjectSizes: false,
			experimentalMetaEncryption: false,
			timingBatchSeconds: 60,
			mtimeGranularitySeconds: 0,
			replaceRemoteEnabled: false,
		},
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
		e2eeStatusText: () => ({ desc: "", action: "" }),
		keyPolicyText: () => "严格会话解锁",
		trustMigrationPending: () => false,
		hasTrustedDevice: () => false,
		metaMigrationActive: () => false,
	};
}

/** 在指定平台下构造设置定义；返回值里的函数也在同一平台下求值。 */
function onPlatform<T>(mobile: boolean, fn: () => T): T {
	const prev = Platform.isMobileApp;
	Platform.isMobileApp = mobile;
	try {
		return fn();
	} finally {
		Platform.isMobileApp = prev;
	}
}

function build(mobile: boolean, interval = 30) {
	return onPlatform(mobile, () => {
		const plugin = fakePlugin(interval);
		const tab = new SyncSettingTab({} as never, plugin as never);
		const flat: Def[] = [];
		const walk = (items: Def[]) => {
			for (const d of items) {
				if (d.items) walk(d.items);
				else flat.push(d);
			}
		};
		walk(tab.getSettingDefinitions() as unknown as Def[]);
		return { tab, plugin, flat };
	});
}

const shown = (d: Def) => (typeof d.visible === "function" ? d.visible() : d.visible !== false);

test("手机：检查云端更新只列生效的频率；存着 30 秒的显示 60 秒，存储值不变", () => {
	const m = build(true, 30);
	const item = m.flat.find((d) => d.control?.key === "syncIntervalSeconds")!;
	assert.equal(item.name, "检查云端更新");
	assert.deepEqual(Object.keys(item.control!.options!).sort(), ["0", "120", "300", "60"]);
	assert.equal(onPlatform(true, () => m.tab.getControlValue("syncIntervalSeconds")), "60", "15 / 30 秒在手机上按 60 秒执行，界面显示实际值");
	assert.equal(m.plugin.settings.syncIntervalSeconds, 30, "只改显示，不改写这台设备存的偏好");

	const off = build(true, 0);
	assert.equal(onPlatform(true, () => off.tab.getControlValue("syncIntervalSeconds")), "0", "关闭定时检查仍显示为关闭");
});

test("桌面：检查云端更新保留 15 / 30 秒，显示存储值", () => {
	const d = build(false, 15);
	const item = d.flat.find((x) => x.control?.key === "syncIntervalSeconds")!;
	assert.ok("15" in item.control!.options! && "30" in item.control!.options!);
	assert.equal(onPlatform(false, () => d.tab.getControlValue("syncIntervalSeconds")), "15");
});

test("配置目录：手机上没有开关，只有「此设备不支持」说明；桌面是开关", () => {
	const phone = onPlatform(true, () => build(true).flat.filter((x) => x.name === "同步 Obsidian 配置目录" && shown(x)));
	assert.equal(phone.length, 1);
	assert.equal(phone[0].control, undefined, "手机上不给一个不起作用的开关");
	assert.equal(typeof phone[0].render, "function");

	const desk = onPlatform(false, () => build(false).flat.filter((x) => x.name === "同步 Obsidian 配置目录" && shown(x)));
	assert.equal(desk.length, 1);
	assert.equal(desk[0].control?.key, "syncObsidian");
});

test("改名后旧名字仍能搜到：同步间隔、设备列表", () => {
	const flat = build(false).flat;
	assert.ok(flat.find((x) => x.name === "检查云端更新")?.aliases?.includes("同步间隔"));
	assert.ok(flat.find((x) => x.name === "已连接设备")?.aliases?.includes("设备列表"));
	assert.ok(!flat.some((x) => x.name === "同步间隔" || x.name === "设备列表"));
});

test("设备管理去网页的「账号与设备」：保留子路径，不能用于网页的地址不生成入口", () => {
	assert.equal(deviceManageUrl("https://sync.example.com"), "https://sync.example.com/#/me");
	assert.equal(deviceManageUrl("https://example.com/litesync/"), "https://example.com/litesync/#/me");
	assert.equal(deviceManageUrl("https://example.com/litesync"), "https://example.com/litesync/#/me");
	assert.equal(deviceManageUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/#/me", "本机调试地址放行");
	assert.equal(deviceManageUrl("http://sync.example.com"), null, "非本机的 http:// 不生成入口");
	assert.equal(deviceManageUrl(""), null);
});
