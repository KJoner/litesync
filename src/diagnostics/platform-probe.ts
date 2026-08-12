import { App, Platform } from "obsidian";
import { LocalCommitter } from "../sync/local-commit";
import { pathsCollide, tryCanonicalizeVaultPath } from "../utils/vault-path";

/**
 * 平台兼容性自检（v0.17 / 计划书 §8.4 实机矩阵、§8.8 门槛 3 与 11）。
 *
 * # 为什么需要它
 *
 * §8.4 要求在 Windows / macOS / Linux / 移动端各跑一遍路径用例矩阵。
 * 桌面端可以用 `npm test`（tests/realfs.test.ts 直接操作真实文件系统），
 * **但移动端跑不了 Node**——iOS 与 Android 上没有任何办法执行那套测试。
 *
 * 于是移动端那一格长期只能靠推理填。而推理错的方向恰好是最危险的那种：
 * 我们以为两个名字不同，文件系统认为相同，后写的静默覆盖先写的。
 *
 * 这个自检跑在插件内部、用 Obsidian 自己的 adapter，因此**在移动端也能跑**。
 * 用户执行一次命令，得到一份可以直接贴出来的报告。
 *
 * # 它证明什么、不证明什么
 *
 * 它证明的是**这一台设备**的行为。它不能替代在多台设备上跑——
 * 同为 "Android" 的两台机器，文件系统可能完全不同（内置存储 vs SD 卡 vs
 * 挂载的网络盘）。报告里会带上足以区分这些情况的信息。
 *
 * 所有探测都在插件自己的目录里进行，不碰用户的任何文件。
 *
 * # 关于下面的 eslint-disable
 *
 * 本文件直接调用 adapter.writeBinary，绕过了 LocalCommitter。这是**故意**的，
 * 也是唯一一处合理的例外：这里要测的就是**裸文件系统**的行为，
 * 走 LocalCommitter 只会测出 LocalCommitter 的行为。
 *
 * 例外的安全边界是明确的：所有路径都在 `<pluginDir>/.probe/` 下，
 * 那个目录永不参与同步，也不可能是用户的文件。禁令针对的是「覆盖用户内容」，
 * 而这里一个用户文件都碰不到。
 */
/* eslint-disable no-restricted-syntax -- 见上方说明：只在插件自己的 .probe 目录里操作 */

/**
 * 一条用例的判定。
 *
 * 刻意**不是**「实测是否等于预言」——那个判据是错的，而且错得有害。
 *
 * 规则比现实更严完全安全：只是多拦一次。真正危险的只有一个方向：
 * 规则比现实**宽松**——我们以为两个名字不同、文件系统认为相同，
 * 于是后写的静默覆盖先写的。
 *
 * 用严格相等来判定，会把大量安全情况标成红色。而一份大部分是红色的报告，
 * 等于没有报告：真出问题的那一行会被淹掉。
 */
export type Verdict =
	/** 规则与现实一致，或比现实更严——安全 */
	| "safe"
	/** 这台设备接受、但我们的规则拒绝：这类文件同步会受限，但不丢数据 */
	| "limited"
	/** 规则比现实宽松：可能导致静默覆盖。**这是唯一需要立刻处理的** */
	| "unsafe";

export interface ProbeResult {
	/** 用例名 */
	name: string;
	/** 本机实测结论 */
	actual: string;
	/** 我们的规则预言的结论 */
	expected: string;
	verdict: Verdict;
	/** 说明（safe 之外必填） */
	note?: string;
}

export interface ProbeReport {
	platform: string;
	appVersion: string;
	pluginVersion: string;
	atomicReplace: boolean;
	results: ProbeResult[];
	/** 存在「规则比现实宽松」的用例——唯一需要立刻处理的情况 */
	hasUnsafe: boolean;
	/** 存在能力受限的用例（这类文件同步会受限，但不丢数据） */
	hasLimited: boolean;
}

const PROBE_PREFIX = ".probe";

/**
 * 在真实文件系统上判断两个名字是否指向同一个文件。
 *
 * 方法：写 A、读 B。读得到且内容一致 → 这台机器认为它们是同一个文件。
 */
async function sameFile(app: App, dir: string, a: string, b: string): Promise<boolean> {
	const adapter = app.vault.adapter;
	const pa = `${dir}/${a}`;
	const pb = `${dir}/${b}`;
	const marker = new TextEncoder().encode("probe-a").buffer;
	try {
		await adapter.writeBinary(pa, marker);
		const st = await adapter.stat(pb);
		if (!st) return false;
		const read = await adapter.readBinary(pb);
		return new TextDecoder().decode(read) === "probe-a";
	} catch {
		return false;
	} finally {
		for (const p of [pa, pb]) {
			try {
				if (await adapter.stat(p)) await adapter.remove(p);
			} catch {
				/* 清理失败不影响结论 */
			}
		}
	}
}

/** 这台机器能不能创建这个名字的文件。 */
async function canCreate(app: App, dir: string, name: string): Promise<boolean> {
	const adapter = app.vault.adapter;
	const p = `${dir}/${name}`;
	try {
		await adapter.writeBinary(p, new Uint8Array([1]).buffer);
		const ok = (await adapter.stat(p)) !== null;
		await adapter.remove(p);
		return ok;
	} catch {
		try {
			if (await adapter.stat(p)) await adapter.remove(p);
		} catch {
			/* ignore */
		}
		return false;
	}
}

/**
 * 跑一遍 §8.4 的路径用例矩阵，返回报告。
 *
 * committer 传入时会一并探测原子替换能力（§8.8 门槛 11）。
 */
export async function runPlatformProbe(
	app: App,
	pluginDir: string,
	pluginVersion: string,
	committer?: LocalCommitter,
): Promise<ProbeReport> {
	const adapter = app.vault.adapter;
	const dir = `${pluginDir}/${PROBE_PREFIX}`;
	if (!(await adapter.stat(dir))) await adapter.mkdir(dir);

	const results: ProbeResult[] = [];

	/**
	 * 记录一条**碰撞类**用例：文件系统认为两个名字是不是同一个文件。
	 *
	 * 危险方向只有一个：现实碰撞而规则说不碰撞（→ 静默覆盖）。
	 * 反过来（规则更严）只是多拦一次，安全。
	 */
	const recordCollision = (name: string, real: boolean, ruleSaysCollide: boolean): void => {
		const unsafe = real && !ruleSaysCollide;
		results.push({
			name,
			actual: real ? "是" : "否",
			expected: ruleSaysCollide ? "是" : "否",
			verdict: unsafe ? "unsafe" : "safe",
			...(unsafe
				? {
						note:
							"这台设备认为它们是同一个文件，而我们的规则认为不是——" +
							"两个文件会在同步时互相覆盖。**这条必须反馈给开发者。**",
					}
				: real === ruleSaysCollide
					? {}
					: { note: "规则比这台设备更严，只会多拦一次，不会丢数据" }),
		});
	};

	/**
	 * 记录一条**可创建性**用例：这台设备能不能创建这个名字。
	 *
	 * 设备能建而规则拒绝 → 这类文件在跨设备同步时会受限（在拒绝它的那台设备上
	 * 被登记为 blocked 并提示），但不丢数据。
	 * 规则接受而设备建不出来 → 我们会尝试写入并失败，属于操作错误，要报出来。
	 */
	const recordCreatable = (name: string, canCreate: boolean, ruleAccepts: boolean): void => {
		const broken = ruleAccepts && !canCreate;
		const limited = canCreate && !ruleAccepts;
		results.push({
			name,
			actual: canCreate ? "是" : "否",
			expected: ruleAccepts ? "是" : "否",
			verdict: broken ? "unsafe" : limited ? "limited" : "safe",
			...(broken
				? { note: "规则接受这个名字，但这台设备创建不了——写入会失败。**请反馈给开发者。**" }
				: limited
					? {
							note:
								"这台设备能创建，但我们的规则拒绝它（为兼容 Windows）。" +
								"这类文件可以上传，但在 Windows 设备上会被登记为 blocked 并提示，不会丢数据。",
						}
					: {}),
		});
	};

	// --- 大小写 ---
	// 我们的规则：platformCollisionKey 在大小写不敏感的平台上把它们判为碰撞。
	// 这里反过来问文件系统，看两者是否一致
	{
		const actual = await sameFile(app, dir, "Note.md", "note.md");
		const expected = pathsCollide("Note.md", "note.md");
		recordCollision("Note.md 与 note.md 是同一个文件", actual, expected);
	}

	// --- Unicode NFC / NFD ---
	// é 的两种写法：单码点 vs e + 组合重音
	{
		const nfc = "café.md";
		const nfd = "café.md";
		const actual = await sameFile(app, dir, nfc, nfd);
		const expected = pathsCollide(nfc, nfd);
		recordCollision("café.md 的 NFC 与 NFD 写法是同一个文件", actual, expected);
	}

	// --- 尾随点与尾随空格 ---
	for (const [label, name] of [
		["尾随点", "trailing."],
		["尾随空格", "trailing "],
	] as const) {
		const created = await canCreate(app, dir, `${name}md`);
		const canonical = tryCanonicalizeVaultPath(`${name}md`) !== null;
		recordCreatable(`能创建${label}的文件名`, created, canonical);
	}

	// --- Windows 保留名 ---
	for (const name of ["CON", "AUX", "NUL"]) {
		const created = await canCreate(app, dir, `${name}.md`);
		const canonical = tryCanonicalizeVaultPath(`${name}.md`) !== null;
		recordCreatable(`能创建保留名 ${name}.md`, created, canonical);
	}

	// --- 超长组件 ---
	{
		const long = "x".repeat(300) + ".md";
		const created = await canCreate(app, dir, long);
		const canonical = tryCanonicalizeVaultPath(long) !== null;
		recordCreatable("能创建 300 字符的文件名", created, canonical);
	}

	// --- 原子替换（§8.8 门槛 11） ---
	let atomicReplace = true;
	if (committer) {
		atomicReplace = await committer.supportsAtomicReplace();
		results.push({
			name: "支持原子安装（rename 到空位且内容完整）",
			actual: atomicReplace ? "是" : "否",
			expected: "是",
			// 不支持不是「不安全」：这正是门槛 11 设计好的退化路径
			verdict: atomicReplace ? "safe" : "limited",
			...(atomicReplace
				? {}
				: {
						note:
							"本设备不支持原子安装：覆盖类写入会自动退化为「远端版本另存一份」，" +
							"原文件不动。同步仍然可用，但每次远端更新都会产生一个副本。",
					}),
		});
	}

	try {
		if (await adapter.stat(dir)) await adapter.rmdir(dir, true);
	} catch {
		/* 清理失败不影响结论 */
	}

	return {
		platform: describePlatform(),
		appVersion: (app as unknown as { appId?: string }).appId ?? "unknown",
		pluginVersion,
		atomicReplace,
		results,
		hasUnsafe: results.some((r) => r.verdict === "unsafe"),
		hasLimited: results.some((r) => r.verdict === "limited"),
	};
}

function describePlatform(): string {
	const parts: string[] = [];
	if (Platform.isIosApp) parts.push("iOS");
	else if (Platform.isAndroidApp) parts.push("Android");
	else if (Platform.isMacOS) parts.push("macOS");
	else if (Platform.isWin) parts.push("Windows");
	else if (Platform.isLinux) parts.push("Linux");
	else parts.push("unknown");
	parts.push(Platform.isMobileApp ? "mobile" : "desktop");
	return parts.join(" / ");
}

/** 把报告渲染成可以直接贴出来的 Markdown。 */
export function renderProbeReport(rep: ProbeReport): string {
	const lines: string[] = [
		"# LiteSync 平台兼容性自检",
		"",
		`- 平台：**${rep.platform}**`,
		`- 插件版本：${rep.pluginVersion}`,
		`- 支持原子安装：**${rep.atomicReplace ? "是" : "否"}**`,
		"",
		rep.hasUnsafe
			? "> ⚠️ **发现规则比这台设备的实际行为宽松的用例**（下表判定为「不安全」）。" +
				"这可能导致两个文件在同步时互相覆盖——**请把这份报告反馈给开发者。**"
			: rep.hasLimited
				? "> 未发现不安全项。有若干「受限」项：这类文件在部分设备上不会同步，但不会丢数据。"
				: "> 未发现任何问题：规则在这台设备上或与现实一致，或比现实更严。",
		"",
		"| 用例 | 本机实测 | 规则预言 | 判定 |",
		"| --- | --- | --- | --- |",
	];
	const label: Record<Verdict, string> = {
		safe: "✓ 安全",
		limited: "△ 受限",
		unsafe: "**✗ 不安全**",
	};
	for (const r of rep.results) {
		lines.push(`| ${r.name} | ${r.actual} | ${r.expected} | ${label[r.verdict]} |`);
	}
	const notes = rep.results.filter((r) => r.note);
	if (notes.length > 0) {
		lines.push("", "## 说明", "");
		for (const r of notes) lines.push(`- **${r.name}**：${r.note}`);
	}
	lines.push(
		"",
		"### 判定的含义",
		"",
		"- **安全**：规则与这台设备一致，或比它更严（更严只是多拦一次）。",
		"- **受限**：这台设备接受某个名字而规则拒绝它。这类文件在拒绝它的设备上会被",
		"  登记为 blocked 并提示，**不会丢数据**。",
		"- **不安全**：规则比现实宽松——这台设备认为两个名字是同一个文件而规则认为不是，",
		"  可能导致静默覆盖。只有这一类需要立刻处理。",
		"",
		"---",
		"",
		"这份报告只证明**这一台设备**的行为。同为 Android 的两台机器，",
		"文件系统可能完全不同（内置存储 / SD 卡 / 挂载的网络盘），结论不能互相套用。",
	);
	return lines.join("\n");
}

/* eslint-enable no-restricted-syntax -- 例外范围到此结束 */
