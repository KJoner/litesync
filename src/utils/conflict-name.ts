/**
 * 生成冲突副本文件名，例如：
 *   Project.md → Project.conflict-MacBook-20260811-001500-x7k2.md
 *
 * v9：追加 4 位随机后缀——同一设备同一秒产生两次同路径冲突时（秒级时间戳
 * 碰撞）绝不能覆盖已有的冲突副本；调用方仍需用存在性循环兜底。
 */
export function conflictPathFor(path: string, deviceName: string, when: Date, salt?: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const hasExt = dot > slash + 1;
	const stem = hasExt ? path.slice(0, dot) : path;
	const ext = hasExt ? path.slice(dot) : "";
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
		`-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
	const device = deviceName.replace(/[\\/:*?"<>|#^[\]]/g, "-") || "device";
	const rand = salt ?? randomSuffix();
	return `${stem}.conflict-${device}-${stamp}-${rand}${ext}`;
}

export function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}
