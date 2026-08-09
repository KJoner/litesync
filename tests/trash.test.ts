// trashLocal 删除安全测试（0.7.2）：
// 任何平台、任何回收站失败路径都绝不调用 adapter.remove() 永久删除——
// 统一返回 false，由调用方保留本地文件并登记 pendingDeletes。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { Platform } from "obsidian";
import { trashLocal } from "../src/sync/pull";

interface FakeOpts {
	hasFile?: boolean; // getAbstractFileByPath 是否返回文件对象
	trashFileFails?: boolean;
	trashSystemResult?: boolean | "throw";
	trashLocalFails?: boolean;
}

/** 构造只实现 trashLocal 所需接口的 App 替身，并记录 remove 调用次数。 */
function fakeApp(opts: FakeOpts): { app: App; removeCalls: () => number } {
	let removeCount = 0;
	const app = {
		vault: {
			getAbstractFileByPath: () => (opts.hasFile ? { path: "n.md" } : null),
			adapter: {
				trashSystem: async () => {
					if (opts.trashSystemResult === "throw") throw new Error("trashSystem failed");
					return opts.trashSystemResult ?? false;
				},
				trashLocal: async () => {
					if (opts.trashLocalFails) throw new Error("trashLocal failed");
				},
				remove: async () => {
					removeCount++;
				},
			},
		},
		fileManager: {
			trashFile: async () => {
				if (opts.trashFileFails) throw new Error("trashFile failed");
			},
		},
	} as unknown as App;
	return { app, removeCalls: () => removeCount };
}

test("trashLocal: trashFile 成功返回 true", async () => {
	const { app, removeCalls } = fakeApp({ hasFile: true });
	assert.equal(await trashLocal(app, "n.md"), true);
	assert.equal(removeCalls(), 0);
});

test("trashLocal: 桌面端 trashFile 失败 → false，绝不调用 adapter.remove", async () => {
	Platform.isMobileApp = false;
	const { app, removeCalls } = fakeApp({ hasFile: true, trashFileFails: true });
	assert.equal(await trashLocal(app, "n.md"), false);
	assert.equal(removeCalls(), 0, "回收站失败后不允许永久删除");
});

test("trashLocal: 隐藏路径 trashSystem 抛错 + trashLocal 失败 → false，不调用 remove", async () => {
	Platform.isMobileApp = false;
	const { app, removeCalls } = fakeApp({
		hasFile: false,
		trashSystemResult: "throw",
		trashLocalFails: true,
	});
	assert.equal(await trashLocal(app, ".obsidian/app.json"), false);
	assert.equal(removeCalls(), 0);
});

test("trashLocal: 隐藏路径 trashSystem 拒绝后 trashLocal 兜底成功 → true", async () => {
	Platform.isMobileApp = false;
	const { app, removeCalls } = fakeApp({ hasFile: false, trashSystemResult: false });
	assert.equal(await trashLocal(app, ".obsidian/app.json"), true);
	assert.equal(removeCalls(), 0);
});

test("trashLocal: 移动端全部回收站失败 → false，不调用 remove", async () => {
	Platform.isMobileApp = true;
	try {
		const { app, removeCalls } = fakeApp({ hasFile: true, trashFileFails: true, trashLocalFails: true });
		assert.equal(await trashLocal(app, "n.md"), false);
		assert.equal(removeCalls(), 0);
	} finally {
		Platform.isMobileApp = false;
	}
});
