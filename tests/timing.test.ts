import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_BATCH_SECONDS,
	DEFAULT_MTIME_GRANULARITY_SECONDS,
	MIN_BATCH_SECONDS,
	nextFlushDelay,
	quantizeMtime,
	timingDisclosure,
} from "../src/utils/timing";
import { Keyring } from "../src/crypto/keyring";
import { StateStore } from "../src/state/store";
import type { SyncContext } from "../src/sync/context";
import { SyncGate } from "../src/sync/gate";
import { PendingQueue } from "../src/sync/queue";
import { uploadFromPlain } from "../src/sync/transfer";

async function freshStore(): Promise<StateStore> {
	const files = new Map<string, string>();
	const adapter = {
		read: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error("ENOENT");
			return v;
		},
		write: async (p: string, d: string) => void files.set(p, d),
		exists: async (p: string) => files.has(p),
		remove: async (p: string) => void files.delete(p),
	};
	const store = new StateStore(adapter as never, "state.json");
	await store.load();
	return store;
}

// 时间混淆（v0.17 / 计划书 §11.2）。
//
// 这一组要证明的是「发车时刻与编辑时刻脱钩」这一条核心性质。
// 它很容易被实现成「从现在起等一个随机时间」——那样期望发车时刻仍然随
// 编辑时刻线性移动，观察者取几次平均就能把编辑时刻还原出来，混淆等于没做。

test("§11.2: mtime 向下取整到粒度边界，且不产生未来时间", () => {
	const g = 3600;
	// 同一小时内的任意时刻必须落到同一个值
	const base = Date.UTC(2026, 7, 12, 14, 0, 0);
	for (const offset of [0, 1, 60_000, 1_800_000, 3_599_999]) {
		assert.equal(quantizeMtime(base + offset, g), base, `偏移 ${offset} 应当落到同一小时`);
	}
	// 向下而不是就近：就近取整会让一半的时间戳落到未来，
	// 而「修改时间在未来」会让排序、增量判断和界面都表现得莫名其妙
	for (const t of [base + 1, base + 3_599_999, base + 1_800_001]) {
		assert.ok(quantizeMtime(t, g) <= t, `量化结果 ${quantizeMtime(t, g)} 不得超过原值 ${t}`);
	}
});

test("§11.2: 粒度为 0 或非法输入时原样返回", () => {
	assert.equal(quantizeMtime(1_700_000_000_000, 0), 1_700_000_000_000);
	assert.equal(quantizeMtime(1_700_000_000_000, -1), 1_700_000_000_000);
	assert.equal(quantizeMtime(0, 3600), 0);
	assert.equal(quantizeMtime(-5, 3600), -5);
});

test("§11.2: 发车时刻落在下一个窗口内，与编辑时刻无关", () => {
	const w = 300; // 5 分钟
	const wMs = w * 1000;

	// 在同一个窗口里的不同时刻发起编辑，发车时刻的**可能范围**必须完全一致。
	// 这正是「脱钩」的定义：观察者看到发车时刻，推不出编辑时刻在窗口里的位置
	const windowStart = Math.floor(Date.now() / wMs) * wMs;
	const nextStart = windowStart + wMs;

	for (const r of [0, 0.25, 0.5, 0.999]) {
		const fireTimes = new Set<number>();
		for (const offsetInWindow of [0, 1000, 60_000, wMs - 1]) {
			const now = windowStart + offsetInWindow;
			const delay = nextFlushDelay(now, w, () => r);
			fireTimes.add(now + delay);
		}
		assert.equal(
			fireTimes.size,
			1,
			`随机数固定为 ${r} 时，同一窗口内任何编辑时刻都必须得到同一个发车时刻`,
		);
		const fire = [...fireTimes][0];
		assert.ok(fire >= nextStart, "发车必须在下一个窗口开始之后");
		assert.ok(fire < nextStart + wMs, "发车必须在下一个窗口结束之前");
	}
});

test("§11.2: 抖动覆盖整个窗口（不是永远在窗口开头发车）", () => {
	const w = 300;
	const now = 1_700_000_000_000;
	const early = now + nextFlushDelay(now, w, () => 0);
	const late = now + nextFlushDelay(now, w, () => 0.999);
	assert.ok(late - early > w * 1000 * 0.9, `抖动只覆盖了 ${late - early}ms，远小于窗口`);
});

test("§11.2: 窗口下限被强制，避免「开了但没混淆」", () => {
	const now = 1_700_000_000_000;
	// 要一个 1 秒的窗口 → 实际按下限走
	const delay = nextFlushDelay(now, 1, () => 0);
	assert.ok(delay > 0, "延迟必须为正");
	assert.ok(
		delay <= MIN_BATCH_SECONDS * 1000,
		`过小的窗口必须被抬到下限（${MIN_BATCH_SECONDS}s），否则用户以为开了混淆其实没有`,
	);
});

test("§11.2: 延迟始终为正（不会算出「立刻发车」而绕过混淆）", () => {
	const w = 120;
	for (let i = 0; i < 500; i++) {
		const now = 1_700_000_000_000 + i * 977;
		const delay = nextFlushDelay(now, w, Math.random);
		assert.ok(delay > 0, `第 ${i} 次得到非正延迟 ${delay}`);
	}
});

test("§11.2: 说明文案由参数生成，数字改了说明也跟着改", () => {
	const a = timingDisclosure(300, 3600);
	assert.match(a, /5 分钟/, "应当反映实际窗口");
	assert.match(a, /1 小时/, "应当反映实际 mtime 粒度");

	const b = timingDisclosure(900, 86400);
	assert.match(b, /15 分钟/);
	assert.match(b, /24 小时/);
	assert.notEqual(a, b, "参数不同，说明必须不同——写死的说明是隐私功能里最有害的失真");

	// 必须如实说明做不到的部分
	for (const text of [a, b]) {
		assert.match(text, /不隐藏/, "必须说明它不隐藏「有没有编辑」");
		assert.match(text, /掩护流量/, "必须说明没有掩护流量");
		assert.match(text, /冲突窗口/, "必须说明代价");
	}
});

test("§11.2: 默认值是合理的（窗口不小于下限，粒度为正）", () => {
	assert.ok(DEFAULT_BATCH_SECONDS >= MIN_BATCH_SECONDS);
	assert.ok(DEFAULT_MTIME_GRANULARITY_SECONDS > 0);
	// 默认窗口不该长到让人无法接受同步延迟
	assert.ok(DEFAULT_BATCH_SECONDS <= 600, "默认窗口超过 10 分钟会让人干脆关掉这个功能");
});

// ---------- 上传路径上的实际生效 ----------

test("§11.2: 上传时上报量化后的 mtime，本地状态保留真实值", async () => {
	const store = await freshStore();
	const queue = new PendingQueue();
	queue.onChange = () => {};
	queue.persist = async () => {};

	const realMtime = Date.UTC(2026, 7, 12, 14, 37, 21);
	let sentMtime = -1;
	const ctx = {
		store,
		queue,
		padsSize: () => false,
		// 与开启混淆时 main.ts 的行为一致：按小时量化
		reportedMtime: (ms: number) => quantizeMtime(ms, 3600),
		gate: new SyncGate(),
		e2ee: new Keyring(),
		client: {
			upload: async (p: string, _b: number, _h: string, _d: ArrayBuffer, m: number) => {
				sentMtime = m;
				return { path: p, revision: 1, hash: "", size: 0, sequence: 1 };
			},
		},
		log: () => {},
	} as unknown as SyncContext;

	await uploadFromPlain(ctx, "a.md", new TextEncoder().encode("hi").buffer as ArrayBuffer, 0, realMtime);

	assert.notEqual(sentMtime, realMtime, "上报的 mtime 不该是精确值");
	assert.equal(sentMtime, quantizeMtime(realMtime, 3600), "上报的必须是量化值");
	assert.ok(sentMtime <= realMtime, "量化后不得落到未来");
});

test("§11.2: 关闭混淆时上报原始 mtime（默认不改变行为）", async () => {
	const store = await freshStore();
	const queue = new PendingQueue();
	queue.onChange = () => {};
	queue.persist = async () => {};

	const realMtime = Date.UTC(2026, 7, 12, 14, 37, 21);
	let sentMtime = -1;
	const ctx = {
		store,
		queue,
		padsSize: () => false,
		reportedMtime: (ms: number) => ms, // 混淆关闭
		gate: new SyncGate(),
		e2ee: new Keyring(),
		client: {
			upload: async (p: string, _b: number, _h: string, _d: ArrayBuffer, m: number) => {
				sentMtime = m;
				return { path: p, revision: 1, hash: "", size: 0, sequence: 1 };
			},
		},
		log: () => {},
	} as unknown as SyncContext;

	await uploadFromPlain(ctx, "a.md", new TextEncoder().encode("hi").buffer as ArrayBuffer, 0, realMtime);
	assert.equal(sentMtime, realMtime, "默认行为必须一字不变");
});
