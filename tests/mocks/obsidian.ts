/**
 * obsidian 模块的最小测试替身（esbuild --alias:obsidian=… 注入）。
 * 只提供被测代码依赖树中实际用到的运行时导出；类型导入在编译期被擦除。
 *
 * 0.20：补上 Modal / Notice / PluginSettingTab / debounce 的空壳——设置页与弹窗模块
 * 因此可以被 import（测试只断言它们产出的定义结构，不渲染 DOM）。
 */
export const Platform = {
	isMobileApp: false,
	isIosApp: false,
	isDesktopApp: true,
};

export function requestUrl(): never {
	throw new Error("requestUrl is not available in unit tests");
}

export type App = unknown;
export type DataAdapter = unknown;

export class Modal {
	contentEl: unknown = {};
	titleEl: unknown = {};
	constructor(public app: unknown) {}
	open(): void {}
	close(): void {}
}

export class Notice {
	constructor(
		public message?: unknown,
		public duration?: number,
	) {}
	hide(): void {}
	setMessage(): void {}
}

export class PluginSettingTab {
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
	update(): void {}
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
	return fn;
}
