import { DataAdapter } from "obsidian";

/** 返回父目录路径；根目录返回 ""。 */
export function parentOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** 确保父目录存在（逐级创建）。 */
export async function ensureParentFolder(adapter: DataAdapter, path: string): Promise<void> {
	const parent = parentOf(path);
	if (!parent) return;
	const parts = parent.split("/");
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		if (!(await adapter.exists(cur))) {
			try {
				await adapter.mkdir(cur);
			} catch (e) {
				// 并发创建时可能已存在，重新检查
				if (!(await adapter.exists(cur))) throw e;
			}
		}
	}
}
