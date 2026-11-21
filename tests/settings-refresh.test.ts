// 设置页跟随插件状态刷新（iPhone 真机验收反馈，2026-11-22）。
//
// 现象：未连接时打开设置页 → 「粘贴连接链接」→ 核对并连接 → 接入向导完成，同步早已开始，
// 设置页仍显示「尚未连接」，离开再进来才变。原因：只有少数弹窗的成功回调会刷新设置页，
// 连接链接兑换与接入向导这条路径一次都没刷新。
//
// 现在 plugin.updateStatus（所有状态变化的唯一出口）每次调用 SyncSettingTab.stateChanged()：
//   页面结构没变 → 只就地重绘状态卡；结构变了（未连接 ↔ 已连接、接入完成、加密状态变化）→ 整页重绘；
//   用户正在设置页的输入框里输入时，整页重绘推迟到焦点离开（不打断软键盘与中文输入法）。
// 这里用最小替身模拟 Obsidian 的渲染（getSettingDefinitions → render 回调）；真实宿主里的整页重绘
// 由 Obsidian 的 update() → refreshCurrentPage 完成（1.13.4 与 1.15.1 源码核对过）。
// INV: —（界面层：如实反映状态，不涉及同步不变量）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

interface FakeFragment {
	texts: string[];
}

(globalThis as unknown as { createFragment: unknown }).createFragment = (fn: (f: unknown) => void): FakeFragment => {
	const texts: string[] = [];
	const node = {
		texts,
		appendText: (t: string) => texts.push(t),
		createEl: (_tag: string, o?: { text?: string }) => {
			if (o?.text) texts.push(o.text);
			return node;
		},
		createDiv: (o?: { text?: string }) => {
			if (o?.text) texts.push(o.text);
			return node;
		},
		createSpan: (o?: { text?: string }) => {
			if (o?.text) texts.push(o.text);
			return node;
		},
	};
	fn(node);
	return node;
};

import { SyncSettingTab } from "../src/settings";
import type { StatusInput } from "../src/status-summary";

interface FakeSetting {
	settingEl: { isConnected: boolean };
	desc: FakeFragment | null;
	buttons: string[];
	clears: number;
	setDesc(d: FakeFragment): FakeSetting;
	addButton(cb: (b: FakeButton) => unknown): FakeSetting;
	clear(): FakeSetting;
}

interface FakeButton {
	label: string;
	setButtonText(t: string): FakeButton;
	setCta(): FakeButton;
	setDisabled(): FakeButton;
	onClick(): FakeButton;
}

function fakeSetting(): FakeSetting {
	const s: FakeSetting = {
		settingEl: { isConnected: true },
		desc: null,
		buttons: [],
		clears: 0,
		setDesc(d) {
			s.desc = d;
			return s;
		},
		addButton(cb) {
			const b: FakeButton = {
				label: "",
				setButtonText(t) {
					b.label = t;
					return b;
				},
				setCta: () => b,
				setDisabled: () => b,
				onClick: () => b,
			};
			cb(b);
			s.buttons.push(b.label);
			return s;
		},
		clear() {
			s.clears++;
			s.buttons = [];
			return s;
		},
	};
	return s;
}

interface State {
	configured: boolean;
	bootstrapReady: boolean;
	e2ee: StatusInput["e2ee"];
	syncing: boolean;
	lastSyncAt: number;
	vaultName: string | null;
	credentialRejected: boolean;
}

interface FakeEl {
	tagName: string;
	isContentEditable?: boolean;
	inSettings: boolean;
	closest(sel: string): unknown;
}

function setup() {
	const state: State = {
		configured: false,
		bootstrapReady: false,
		e2ee: "disabled",
		syncing: false,
		lastSyncAt: 0,
		vaultName: null,
		credentialRejected: false,
	};
	const plugin = {
		get configured() {
			return state.configured;
		},
		get bootstrapReady() {
			return state.bootstrapReady;
		},
		settings: {
			padObjectSizes: false,
			experimentalMetaEncryption: false,
			timingBatchSeconds: 60,
			mtimeGranularitySeconds: 0,
			replaceRemoteEnabled: false,
		},
		replaceJobNeedsAttention: () => false,
		statusInput: (): StatusInput => ({
			configured: state.configured,
			bootstrapReady: state.bootstrapReady,
			credentialRejected: state.credentialRejected,
			e2ee: state.e2ee,
			vaultName: state.vaultName,
			lastSyncAt: state.lastSyncAt,
			conflicts: 0,
			migrationPending: false,
			keyPolicyText: "严格会话解锁",
			syncing: state.syncing,
			now: Date.now(),
		}),
		e2eeStatusText: () => ({
			desc: "",
			action: state.e2ee === "disabled" ? "启用端到端加密…" : state.e2ee === "locked" ? "解锁…" : "锁定",
		}),
		keyPolicyText: () => "严格会话解锁",
		trustMigrationPending: () => false,
		hasTrustedDevice: () => false,
		metaMigrationActive: () => false,
		runPrimaryAction: () => {},
		runSecondaryAction: () => {},
	};

	const focusListeners: Array<() => void> = [];
	const doc = {
		activeElement: null as FakeEl | null,
		addEventListener: (type: string, fn: () => void) => {
			if (type === "focusout") focusListeners.push(fn);
		},
		removeEventListener: (type: string, fn: () => void) => {
			const i = focusListeners.indexOf(fn);
			if (type === "focusout" && i >= 0) focusListeners.splice(i, 1);
		},
	};
	const containerEl = { ownerDocument: doc, contains: (el: FakeEl) => el.inSettings, closest: () => null };

	const tab = new SyncSettingTab({} as never, plugin as never);
	(tab as unknown as { containerEl: unknown }).containerEl = containerEl;

	// 模拟 Obsidian 渲染设置页：取定义 → 为每一项新建 Setting 并调用 render
	let card = fakeSetting();
	const display = (): void => {
		const defs = tab.getSettingDefinitions() as unknown as Array<{ items: Array<{ render: (s: unknown) => void }> }>;
		card = fakeSetting();
		defs[0].items[0].render(card);
	};
	let rebuilds = 0;
	// 真实宿主：update() 重新取定义并重绘当前页（tab 正显示时）
	(tab as unknown as { update: () => void }).update = () => {
		rebuilds++;
		display();
	};
	display();

	return {
		state,
		tab,
		doc,
		focusListeners,
		card: () => card,
		rebuilds: () => rebuilds,
		lines: () => card.desc?.texts.join("") ?? "",
	};
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("未连接时打开设置页 → 连接链接兑换成功 → 接入完成：不用离开再进入，设置页每一步都跟上", async () => {
	const t = setup();
	assert.match(t.lines(), /尚未连接/);
	assert.deepEqual(t.card().buttons, ["连接仓库"]);

	// finishRedeem → applyPairingConfig → resetBootstrapState → invalidateBinding → updateStatus
	t.state.configured = true;
	t.state.e2ee = "locked";
	t.tab.stateChanged();
	await tick();
	assert.equal(t.rebuilds(), 1, "未连接 → 已连接是结构变化：整页重绘（「粘贴连接链接」等新手入口要换成日常入口）");
	assert.match(t.lines(), /服务器已配置，等待完成接入/);
	assert.match(t.lines(), /设备授权：已授权/);
	assert.deepEqual(t.card().buttons, ["完成接入"]);

	// 向导里解锁 + 选首次同步方式 → onDone → updateStatus("idle")
	t.state.bootstrapReady = true;
	t.state.e2ee = "unlocked";
	t.tab.stateChanged();
	await tick();
	assert.equal(t.rebuilds(), 2);
	assert.match(t.lines(), /仓库：已连接/);
	assert.match(t.lines(), /仓库解锁：已解锁/);
	assert.deepEqual(t.card().buttons, ["立即同步"]);
});

test("刚连接、还没完成接入：「仓库解锁」如实写接入时确认，不说「服务器可读取内容」（还没取到密钥文档）", async () => {
	const t = setup();
	assert.match(t.lines(), /仓库解锁：连接仓库后显示/, "还没连接：不评价一个不存在的仓库");
	t.state.configured = true; // 真实宿主：换连接时密钥环被清空，e2ee 读作 disabled，直到向导取回密钥文档
	t.tab.stateChanged();
	await tick();
	assert.match(t.lines(), /仓库解锁：完成接入时确认/);
	assert.doesNotMatch(t.lines(), /服务器可读取内容/);

	// 接入完成后仍是 disabled 才是真的明文仓库：照实说
	t.state.bootstrapReady = true;
	t.tab.stateChanged();
	await tick();
	assert.match(t.lines(), /未启用端到端加密（服务器可读取内容）/);
});

test("只是同步状态变化（同步中 / 同步完成 / 仓库名查到）：就地重绘状态卡，不整页重绘", async () => {
	const t = setup();
	t.state.configured = true;
	t.state.bootstrapReady = true;
	t.state.e2ee = "unlocked";
	t.tab.stateChanged();
	await tick();
	const before = t.rebuilds();
	const card = t.card();

	t.state.syncing = true;
	t.tab.stateChanged();
	await tick();
	assert.equal(t.rebuilds(), before, "同步轮次不改页面结构");
	assert.equal(t.card(), card, "还是同一个状态卡元素（就地重绘）");
	assert.deepEqual(card.buttons, ["同步中…"]);

	t.state.syncing = false;
	t.state.lastSyncAt = Date.now();
	t.state.vaultName = "个人笔记";
	t.tab.stateChanged();
	await tick();
	assert.equal(t.rebuilds(), before);
	assert.match(t.lines(), /最近同步：刚刚/);
	assert.match(t.lines(), /已连接「个人笔记」/);
	assert.deepEqual(card.buttons, ["立即同步"]);
});

test("凭据被撤销（网页上删除了这台设备）：状态卡立刻显示失效并给出「重新连接」", async () => {
	const t = setup();
	t.state.configured = true;
	t.state.bootstrapReady = true;
	t.state.e2ee = "unlocked";
	t.tab.stateChanged();
	await tick();

	t.state.credentialRejected = true; // 401 TOKEN_REVOKED → gate credential-rejected → onStatus("offline")
	t.tab.stateChanged();
	await tick();
	assert.match(t.lines(), /设备授权：已失效/);
	assert.deepEqual(t.card().buttons, ["重新连接"]);
});

test("同一操作里的连续状态变化合并成一次重绘", async () => {
	const t = setup();
	t.state.configured = true;
	for (let i = 0; i < 5; i++) t.tab.stateChanged();
	await tick();
	assert.equal(t.rebuilds(), 1);
	const card = t.card();
	t.state.syncing = true;
	for (let i = 0; i < 5; i++) t.tab.stateChanged();
	await tick();
	assert.equal(card.clears, 1);
});

test("正在设置页输入框里输入：结构变化推迟到焦点离开，不销毁正在输入的输入框", async () => {
	const t = setup();
	const input: FakeEl = { tagName: "INPUT", inSettings: true, closest: () => null };
	t.doc.activeElement = input;

	t.state.configured = true; // 例如在「高级」里粘贴 Token
	t.tab.stateChanged();
	await tick();
	assert.equal(t.rebuilds(), 0, "输入中不整页重绘");
	assert.equal(t.focusListeners.length, 1, "等焦点离开");

	// 焦点移到设置页里的另一个输入框（子页面里的也算）：继续等
	t.doc.activeElement = { tagName: "TEXTAREA", inSettings: false, closest: (s) => (s === ".mod-settings" ? {} : null) };
	for (const fn of [...t.focusListeners]) fn();
	await tick();
	assert.equal(t.rebuilds(), 0);

	// 焦点离开输入框：补上整页重绘
	t.doc.activeElement = null;
	for (const fn of [...t.focusListeners]) fn();
	await tick();
	await tick();
	assert.equal(t.rebuilds(), 1);
	assert.equal(t.focusListeners.length, 0, "推迟的监听用完即撤");
	assert.match(t.lines(), /服务器已配置，等待完成接入/);
});

test("向导 / 解锁窗口里的输入框有焦点时照常重绘设置页（那些输入框不在设置页里，不受影响）", async () => {
	const t = setup();
	t.doc.activeElement = { tagName: "INPUT", inSettings: false, closest: () => null };
	t.state.configured = true;
	t.tab.stateChanged();
	await tick();
	assert.equal(t.rebuilds(), 1);
});

test("设置页没显示时不就地重绘（状态卡不在文档里；下次打开时 Obsidian 会重新渲染）", async () => {
	const t = setup();
	t.state.configured = true;
	t.state.bootstrapReady = true;
	t.tab.stateChanged();
	await tick();
	const card = t.card();
	card.settingEl.isConnected = false; // 关掉了设置窗口
	t.state.syncing = true;
	t.tab.stateChanged();
	await tick();
	assert.equal(card.clears, 0);
});
