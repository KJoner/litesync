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

export interface ProbeResult {
	/** 用例名 */
	name: string;
	/** 本机实测结论 */
	actual: string;
	/** 我们的规则预言的结论 */
	expected: string;
	/** 实测与预言是否一致。false 表示我们的假设在这台设备上是错的 */
	agrees: boolean;
	/** 不一致时的说明 */
	note?: string;
}

export interface ProbeReport {
	platform: string;
	appVersion: string;
	pluginVersion: string;
	atomicReplace: boolean;
	results: ProbeResult[];
	/** 存在实测与预言不一致的用例 */
	hasDisagreement: boolean;
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
	const record = (name: string, actual: boolean, expected: boolean, note?: string): void => {
		results.push({
			name,
			actual: actual ? "是" : "否",
			expected: expected ? "是" : "否",
			agrees: actual === expected,
			...(note !== undefined ? { note } : {}),
		});
	};

	// --- 大小写 ---
	// 我们的规则：platformCollisionKey 在大小写不敏感的平台上把它们判为碰撞。
	// 这里反过来问文件系统，看两者是否一致
	{
		const actual = await sameFile(app, dir, "Note.md", "note.md");
		const expected = pathsCollide("Note.md", "note.md");
		record(
			"Note.md 与 note.md 是同一个文件",
			actual,
			expected,
			actual !== expected
				? "我们的碰撞规则与这台设备的实际行为不一致——" +
					"若实测为「是」而规则为「否」，两个文件会在同步时互相覆盖"
				: undefined,
		);
	}

	// --- Unicode NFC / NFD ---
	// é 的两种写法：单码点 vs e + 组合重音
	{
		const nfc = "café.md";
		const nfd = "café.md";
		const actual = await sameFile(app, dir, nfc, nfd);
		const expected = pathsCollide(nfc, nfd);
		record(
			"café.md 的 NFC 与 NFD 写法是同一个文件",
			actual,
			expected,
			actual !== expected
				? "macOS/APFS 会把文件名归一化；若规则没跟上，同一个笔记会被当成两个"
				: undefined,
		);
	}

	// --- 尾随点与尾随空格 ---
	for (const [label, name] of [
		["尾随点", "trailing."],
		["尾随空格", "trailing "],
	] as const) {
		const created = await canCreate(app, dir, `${name}md`);
		const canonical = tryCanonicalizeVaultPath(`${name}md`) !== null;
		record(
			`能创建${label}的文件名`,
			created,
			canonical,
			created !== canonical
				? "我们的路径规则与这台设备的接受范围不一致；规则更严不会丢数据，更松会写失败"
				: undefined,
		);
	}

	// --- Windows 保留名 ---
	for (const name of ["CON", "AUX", "NUL"]) {
		const created = await canCreate(app, dir, `${name}.md`);
		const canonical = tryCanonicalizeVaultPath(`${name}.md`) !== null;
		record(
			`能创建保留名 ${name}.md`,
			created,
			canonical,
			created && !canonical
				? "这台设备接受该名字，但我们的规则拒绝它——只会导致这类文件不同步，不会丢数据"
				: undefined,
		);
	}

	// --- 超长组件 ---
	{
		const long = "x".repeat(300) + ".md";
		const created = await canCreate(app, dir, long);
		const canonical = tryCanonicalizeVaultPath(long) !== null;
		record("能创建 300 字符的文件名", created, canonical);
	}

	// --- 原子替换（§8.8 门槛 11） ---
	let atomicReplace = true;
	if (committer) {
		atomicReplace = await committer.supportsAtomicReplace();
		results.push({
			name: "支持原子安装（rename 到空位且内容完整）",
			actual: atomicReplace ? "是" : "否",
			expected: "是",
			agrees: atomicReplace,
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
		hasDisagreement: results.some((r) => !r.agrees),
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
		rep.hasDisagreement
			? "> ⚠️ **存在实测与规则不一致的用例**（下表 `一致` 列为「否」）。" +
				"请把这份报告反馈给开发者——这意味着某条跨平台假设在这台设备上是错的。"
			: "> 全部用例的实测行为与规则预言一致。",
		"",
		"| 用例 | 本机实测 | 规则预言 | 一致 |",
		"| --- | --- | --- | --- |",
	];
	for (const r of rep.results) {
		lines.push(`| ${r.name} | ${r.actual} | ${r.expected} | ${r.agrees ? "✓" : "**否**"} |`);
	}
	const notes = rep.results.filter((r) => r.note);
	if (notes.length > 0) {
		lines.push("", "## 说明", "");
		for (const r of notes) lines.push(`- **${r.name}**：${r.note}`);
	}
	lines.push(
		"",
		"---",
		"",
		"这份报告只证明**这一台设备**的行为。同为 Android 的两台机器，",
		"文件系统可能完全不同（内置存储 / SD 卡 / 挂载的网络盘），结论不能互相套用。",
	);
	return lines.join("\n");
}

/* eslint-enable no-restricted-syntax -- 例外范围到此结束 */
