/**
 * 忽略规则匹配。
 *
 * 永远排除（不受设置影响）：
 * - 本插件自己的目录（data.json 含 API Token，state.json 是设备本地状态）
 * - .obsidian/workspace.json / workspace-mobile.json
 *
 * syncObsidian=false 时整个 .obsidian 目录不同步。
 * 用户模式支持简单 Glob：** 匹配任意层级，* 匹配单层，? 匹配单字符；
 * 不含 "/" 的模式按文件名（任意目录下）匹配。
 */
export class IgnoreMatcher {
	private fullPatterns: RegExp[] = [];
	private basenamePatterns: RegExp[] = [];

	constructor(
		private syncObsidian: boolean,
		private pluginDir: string, // 例如 ".obsidian/plugins/litesync"
		patternsText: string,
	) {
		for (const raw of patternsText.split("\n")) {
			const pattern = raw.trim();
			if (!pattern || pattern.startsWith("#")) continue;
			if (pattern.includes("/")) {
				this.fullPatterns.push(globToRegExp(pattern.replace(/\/+$/, "/**")));
			} else {
				this.basenamePatterns.push(globToRegExp(pattern));
			}
		}
	}

	ignores(path: string): boolean {
		if (path === this.pluginDir || path.startsWith(this.pluginDir + "/")) return true;
		if (path === ".obsidian/workspace.json" || path === ".obsidian/workspace-mobile.json") return true;
		if (!this.syncObsidian && (path === ".obsidian" || path.startsWith(".obsidian/"))) return true;

		for (const re of this.fullPatterns) {
			if (re.test(path)) return true;
		}
		if (this.basenamePatterns.length > 0) {
			const base = path.slice(path.lastIndexOf("/") + 1);
			for (const re of this.basenamePatterns) {
				if (re.test(base)) return true;
			}
		}
		return false;
	}
}

function globToRegExp(glob: string): RegExp {
	let re = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i += 2;
				// 吞掉 "**/" 中的斜杠，使 "a/**/b" 也能匹配 "a/b"
				if (glob[i] === "/") {
					re += "/?";
					i++;
				}
				continue;
			}
			re += "[^/]*";
		} else if (c === "?") {
			re += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
		i++;
	}
	return new RegExp(`^${re}$`);
}
