/**
 * 生成冲突副本文件名，例如：
 *   Project.md → Project.conflict-MacBook-20260808-001500.md
 */
export function conflictPathFor(path: string, deviceName: string, when: Date): string {
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
	return `${stem}.conflict-${device}-${stamp}${ext}`;
}
