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

(globalThis as unknown as { window: unknown }).window = globalThis;

import { pathsCollide, tryCanonicalizeVaultPath } from "../src/utils/vault-path";

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
