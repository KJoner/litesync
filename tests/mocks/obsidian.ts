/**
 * obsidian 模块的最小测试替身（esbuild --alias:obsidian=… 注入）。
 * 只提供被测代码依赖树中实际用到的运行时导出；类型导入在编译期被擦除。
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
