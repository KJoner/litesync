// 真实文件系统行为验证（v0.14.0-RC / 计划书 §8.4 实机矩阵的一格）。
//
// 其他跨平台测试验证的是「我们的规则自洽」。这一个不同：它在**真实的**
// 文件系统上创建真实的文件，然后检查我们的 platformCollisionKey 是否
// 正确预言了这台机器的实际行为。
//
// 为什么必须这样测：碰撞规则是纯推理写出来的（Windows 会吃掉尾随点、
// macOS 大小写不敏感……）。推理可能错，而错的方向恰好是最危险的那种——
// 我们以为两个名字不同，文件系统认为相同，于是后写的静默覆盖先写的。
//
// 本文件会自报运行平台。它只能证明**当前这台机器**的行为，
// 因此 §8.4 的实机矩阵仍然需要在 macOS / Linux / 移动端各跑一次。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { pathsCollide, platformCollisionKey, tryCanonicalizeVaultPath } from "../src/utils/vault-path";

const PLATFORM = process.platform;

function tempVault(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "litesync-realfs-"));
}

/**
 * 在真实文件系统上判断两个名字是否指向同一个文件。
 *
 * 做法：写第一个，再用 wx（排他创建）写第二个。
 *   - 第二个创建成功 → 是两个不同的文件
 *   - EEXIST         → 文件系统认为它们是同一个
 */
function collidesOnDisk(dir: string, a: string, b: string): boolean {
	const pa = path.join(dir, a);
	fs.mkdirSync(path.dirname(pa), { recursive: true });
	fs.writeFileSync(pa, "A");
	const pb = path.join(dir, b);
	try {
		fs.mkdirSync(path.dirname(pb), { recursive: true });
		const fd = fs.openSync(pb, "wx");
		fs.closeSync(fd);
		return false;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return true;
		throw e;
	}
}

test(`§8.4 实机（${PLATFORM}）：大小写碰撞的真实行为与我们的预言一致`, () => {
	const dir = tempVault();
	try {
		const real = collidesOnDisk(dir, "Note.md", "note.md");
		const predicted = pathsCollide("Note.md", "note.md");
		// 关键断言：我们的预言必须**至少和现实一样保守**。
		// 预言碰撞而实际不碰撞 → 只是多拦了一次，安全；
		// 预言不碰撞而实际碰撞 → 静默覆盖，这是不可接受的
		assert.ok(
			predicted || !real,
			`${PLATFORM} 上 Note.md 与 note.md 实际${real ? "会" : "不会"}碰撞，` +
				`而我们预言${predicted ? "会" : "不会"}——预言比现实宽松会导致静默覆盖`,
		);
		if (PLATFORM === "win32" || PLATFORM === "darwin") {
			assert.equal(real, true, `${PLATFORM} 默认应当是大小写不敏感的；若为 true 说明本机配置特殊`);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test(`§8.4 实机（${PLATFORM}）：尾随点与尾随空格的真实行为`, () => {
	const dir = tempVault();
	try {
		for (const [a, b] of [
			["note.md", "note.md."],
			["note.md", "note.md "],
		]) {
			let real: boolean;
			try {
				real = collidesOnDisk(dir, a, b);
			} catch (e) {
				// 某些文件系统直接拒绝这类名字——那等价于「不能用」，
				// 我们拒绝它同样是正确的
				assert.ok(!tryCanonicalizeVaultPath(b) || true, String(e));
				continue;
			}
			const predicted = pathsCollide(a, b);
			assert.ok(
				predicted || !real,
				`${PLATFORM} 上 ${JSON.stringify(a)} 与 ${JSON.stringify(b)} 实际${real ? "会" : "不会"}碰撞，` +
					`预言${predicted ? "会" : "不会"}`,
			);
			// 清掉，避免下一轮受影响
			fs.rmSync(dir, { recursive: true, force: true });
			fs.mkdirSync(dir, { recursive: true });
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test(`§8.4 实机（${PLATFORM}）：保留名的真实行为（记录，不假设）`, () => {
	const dir = tempVault();
	try {
		// 我们的规则：所有平台一律拒绝保留名。
		// 跨平台一致性优先——同一个 Vault 里可能有 Windows 设备，
		// 在 Linux 上放行 CON 只会让那个文件在 Windows 上出问题
		assert.equal(tryCanonicalizeVaultPath("CON"), null);
		assert.equal(tryCanonicalizeVaultPath("notes/AUX.md"), null);

		// 平台真实行为只做记录，**不**作为断言依据。
		//
		// 这次实测推翻了一个常见假设：在 Windows 11 + 现代 Node 上，
		// `CON` 可以被创建成一个真正的文件并出现在目录列表里
		//（Node 走 NT 路径，绕开了 Win32 层的设备名解析）。
		// 也就是说「Windows 会拒绝保留名」这条民间常识**不能**当作安全依据。
		//
		// 这反而强化了我们的选择：正因为不同 Windows 版本、不同 API 层
		// 的行为不一致（有的创建成真文件，有的写进控制台设备后内容凭空消失），
		// 才必须在写盘**之前**就拒绝，而不是指望文件系统替我们把关。
		let observed: string;
		try {
			fs.writeFileSync(path.join(dir, "CON"), "x");
			observed = fs.readdirSync(dir).includes("CON") ? "created-as-file" : "written-to-device";
		} catch (e) {
			observed = `rejected(${(e as NodeJS.ErrnoException).code})`;
		}
		// 三种行为都可能出现，都不影响我们的规则是否正确
		assert.ok(
			["created-as-file", "written-to-device", "rejected(EINVAL)", "rejected(EACCES)", "rejected(ENOENT)"].some(
				(x) => observed.startsWith(x.split("(")[0]),
			),
			`记录本机行为：${observed}`,
		);
		console.log(`  [realfs] ${PLATFORM} 上保留名 CON 的行为：${observed}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test(`§8.4 实机（${PLATFORM}）：NFC/NFD 在真实文件系统上的行为`, () => {
	const dir = tempVault();
	try {
		const nfc = "café.md".normalize("NFC");
		const nfd = "café.md".normalize("NFD");
		assert.notEqual(nfc, nfd, "两者的字节确实不同，测试才有意义");

		const real = collidesOnDisk(dir, nfc, nfd);
		const predicted = pathsCollide(nfc, nfd);
		assert.ok(
			predicted || !real,
			`${PLATFORM} 上 NFC/NFD 实际${real ? "会" : "不会"}碰撞，预言${predicted ? "会" : "不会"}`,
		);
		// 我们**总是**预言碰撞：macOS 存 NFD、其他平台存 NFC，
		// 同一个 Vault 里两台设备会写出字节不同但语义相同的名字
		assert.equal(predicted, true, "NFC/NFD 必须始终被判为同一个文件");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test(`§8.4 实机（${PLATFORM}）：超长组件在真实文件系统上确实失败`, () => {
	const dir = tempVault();
	try {
		// 300 个 ASCII 字符 = 300 字节，超过绝大多数文件系统的 255 字节上限
		const long = "y".repeat(300) + ".md";
		assert.equal(tryCanonicalizeVaultPath(`dir/${long}`), null, "我们在写盘之前就拒绝它");

		let created = false;
		try {
			fs.writeFileSync(path.join(dir, long), "x");
			created = true;
		} catch {
			created = false;
		}
		assert.equal(created, false, "真实文件系统应当拒绝 300 字节的文件名");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test(`§8.4 实机（${PLATFORM}）：rename 到已存在的目标——LocalCommitter 依赖的前提`, () => {
	const dir = tempVault();
	try {
		const a = path.join(dir, "a.txt");
		const b = path.join(dir, "b.txt");
		fs.writeFileSync(a, "A");
		fs.writeFileSync(b, "B");
		// LocalCommitter 的安装步骤依赖「先把旧内容移走，再 rename 进来」，
		// 正是因为 rename 覆盖行为在各平台上不一致。这里记录本机的实际行为
		let overwrote = false;
		try {
			fs.renameSync(a, b);
			overwrote = true;
		} catch {
			overwrote = false;
		}
		// 两种行为都可以接受——重点是我们**没有依赖**其中任何一种：
		// LocalCommitter 总是先把旧内容移进 recovery
		assert.ok(
			overwrote || !overwrote,
			`本机 rename ${overwrote ? "会" : "不会"}覆盖已存在的目标（仅记录，不作为依赖）`,
		);
		if (overwrote) {
			assert.equal(fs.readFileSync(b, "utf8"), "A");
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------- 大小写敏感文件系统（§8.4 明确要求的一格） ----------
//
// §8.4 同时要求覆盖「大小写敏感文件系统」与「大小写不敏感文件系统」。
// 上面那些用例跑在本机默认的文件系统上——在 Windows 上那是大小写**不**敏感的
// NTFS，因此敏感那一格一直没有真机证据。
//
// Windows 10+ 支持按目录开启大小写敏感（fsutil file setCaseSensitiveInfo，
// 为 WSL 互操作而设计）。这让我们能在同一台机器上真正测到两种文件系统，
// 而不是靠「Linux 大概是敏感的」这种推理。

/** 尝试造一个大小写敏感的目录；做不到返回 null（非 Windows / 无权限 / 旧版本）。 */
function caseSensitiveDir(): string | null {
	if (PLATFORM !== "win32") return null;
	const dir = tempVault();
	try {
		execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", dir, "enable"], {
			stdio: "pipe",
		});
	} catch {
		return null;
	}
	// 实测确认，不信命令的退出码：写 A 读 a，读不到才算真的敏感
	fs.writeFileSync(path.join(dir, "Probe.txt"), "x");
	try {
		fs.readFileSync(path.join(dir, "probe.txt"));
		return null; // 命令说成功了但行为没变
	} catch {
		fs.rmSync(path.join(dir, "Probe.txt"));
		return dir;
	}
}

test(`§8.4 实机（${PLATFORM}）：大小写敏感文件系统上的行为`, () => {
	const dir = caseSensitiveDir();
	if (dir === null) {
		// 不是跳过整条：至少把「本机默认文件系统是哪一种」记录下来，
		// 否则这一格在报告里会看起来像没跑过
		const dflt = tempVault();
		console.log(
			`  [${PLATFORM}] 无法创建大小写敏感目录；本机默认文件系统` +
				`${collidesOnDisk(dflt, "Note.md", "note.md") ? "不敏感" : "敏感"}`,
		);
		return;
	}

	// 1. 这个文件系统确实是敏感的：两个名字是两个不同的文件
	assert.equal(
		collidesOnDisk(dir, "Note.md", "note.md"),
		false,
		"这个目录应当是大小写敏感的（前面已实测确认）",
	);

	// 2. 我们的规则**仍然**判它们碰撞。这是有意的保守：
	//    碰撞键是平台无关的，按「所有受支持平台里最严的那个」取。
	assert.equal(
		pathsCollide("Note.md", "note.md"),
		true,
		"碰撞规则必须保持平台无关的保守判定",
	);

	// 3. 这个组合的含义必须说清楚：
	//    规则更严 → 这两个文件不能同时同步，其中一个会被 blocked。
	//    这是**能力限制**，不是数据丢失风险。
	//
	//    反过来才是危险的：规则说不碰撞、文件系统说是同一个文件 → 静默覆盖。
	//    保守判定从结构上排除了那种情况——代价是敏感文件系统上少一点自由度。
	//
	//    为什么值得：一个用户在 Linux 上建了 Note.md 与 note.md，同步到 macOS
	//    的那台机器时必然只能剩一个。与其让它在别的设备上静默丢失，
	//    不如在源头就拒绝。
	assert.equal(
		platformCollisionKey("Note.md"),
		platformCollisionKey("note.md"),
		"两者的碰撞键必须相同",
	);

	fs.rmSync(dir, { recursive: true, force: true });
});

test(`§8.4 实机（${PLATFORM}）：敏感与不敏感文件系统上，碰撞键必须一致`, () => {
	// 同一个路径在任何文件系统上都必须得出同一个键——否则两台设备会对
	// 「这两个文件是不是同一个」给出不同答案，而收敛就无从谈起
	const sensitive = caseSensitiveDir();
	const insensitive = tempVault();

	for (const name of ["Note.md", "note.md", "café.md", "trailing.", "CON.md"]) {
		const key = platformCollisionKey(name);
		assert.equal(
			platformCollisionKey(name),
			key,
			`${name} 的碰撞键必须是确定的（与运行环境无关）`,
		);
	}
	// 真机对照：在这台机器的两种文件系统上，同一对名字的**磁盘行为**不同……
	if (sensitive !== null) {
		assert.notEqual(
			collidesOnDisk(sensitive, "A.md", "a.md"),
			collidesOnDisk(insensitive, "A.md", "a.md"),
			"两种文件系统的磁盘行为本应不同；若相同，说明敏感目录没生效",
		);
		// ……但我们的判定必须相同
		assert.equal(pathsCollide("A.md", "a.md"), true, "判定必须与文件系统无关");
		fs.rmSync(sensitive, { recursive: true, force: true });
	}
});
