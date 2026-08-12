/**
 * 统一本地提交器 LocalCommitter（v0.13.2 / 计划书 §6.1）。
 *
 * 到 v0.12.x 为止，「把远端内容写进 Vault」这件事散落在 pull、bootstrap、
 * remote-wins、auto-merge、keep-both、conflict resolver、history restore 里，
 * 每处各自实现前置检查。只要有一处漏检，用户刚敲下的内容就会被静默覆盖——
 * 而这正是本项目最不能出的一类错（INV-01）。
 *
 * 因此本模块是**唯一**允许覆盖 Vault 中已有文件的地方，标准流程：
 *
 *   1. 内容写进 staging（插件目录下，永不参与同步）
 *   2. 校验内容 hash（网络/解密结果与声明一致）
 *   3. 校验目标路径安全（§6.12）
 *   4. 取该路径的互斥锁（进程内；见下方关于原子性的说明）
 *   5. 重新读取当前本地文件，核对前置条件（expectedLocalHash）
 *   6. 不符合前置条件 → 按 conflictPolicy 转 keep-both / conflict，绝不覆盖
 *   7. 旧目标先移到 recovery（这是「误覆盖」的最后一道兜底）
 *   8. 用平台能提供的最强语义安装 staging
 *   9. 写后重新计算 hash 校验
 *  10. 由调用方持久化 FileState
 *  11. 清理 staging；recovery 按保留期延迟清理
 *
 * 关于原子性的诚实说明：插件内的 mutex **不是**文件系统级 CAS。它挡得住
 * LiteSync 自己的并发路径，挡不住 Obsidian 主程序、其他插件或外部程序同时写盘。
 * 因此第 5 步的「重新读取 + 核对 hash」才是真正的安全依据，mutex 只是减少窗口。
 */

import { App } from "obsidian";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { evalFailpoint, FP } from "../utils/failpoint";
import { InvalidVaultPathError, validateAndCanonicalizeVaultPath } from "../utils/vault-path";

/** 前置条件不满足时的处置方式。 */
export type ConflictPolicy =
	/** 本地已变 → 保留双方（远端进冲突副本或调用方自行处理），绝不覆盖 */
	| "keep-both"
	/** 本地已变 → 直接失败，交给上层的合并流程 */
	| "fail";

export interface CommitRequest {
	/** 幂等键：决定 staging / recovery 文件名，崩溃后可识别归属 */
	operationId: string;
	/** 目标真实路径（未经校验的远端路径也可以传，这里会再验一次） */
	realPath: string;
	/**
	 * 提交前本地文件必须是这个 hash；null 表示「本地必须不存在」。
	 * 这是防静默覆盖的核心前置条件（TOCTOU 保护）。
	 */
	expectedLocalHash: string | null;
	/** 要写入的明文内容 */
	incoming: ArrayBuffer;
	/** 内容的预期 sha256（与 incoming 不符 → 硬失败，绝不落盘） */
	incomingHash: string;
	incomingMtime?: number;
	conflictPolicy: ConflictPolicy;
}

export type CommitStatus =
	/** 已安装到目标路径 */
	| "committed"
	/** 前置条件不满足（本地已被改动）→ 未写入任何内容，调用方转冲突流程 */
	| "precondition-failed"
	/** 目标路径不安全或被文件夹占用 → 未写入，调用方登记 blocked */
	| "rejected";

export interface CommitResult {
	status: CommitStatus;
	/** committed 时为写入后重新读回计算的 hash（必等于 incomingHash） */
	writtenHash?: string;
	/** rejected/precondition-failed 的原因（短语，不含路径内容） */
	reason?: string;
	/** 被换下来的旧内容所在的 recovery 路径（committed 且原文件存在时） */
	recoveryPath?: string;
}

/** 本地提交失败（内容自身不可信时抛出——这类问题不能降级处理）。 */
export class CommitIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommitIntegrityError";
	}
}

/** recovery 副本保留时长：一周内用户还能自己找回被换下来的旧内容。 */
const RECOVERY_RETENTION_MS = 7 * 24 * 3600 * 1000;

/**
 * 「本平台不支持原子替换」的可判定标记（计划书 §8.8 门槛 11）。
 *
 * 上层用它把这种情况与「本地文件真的被并发修改了」区分开。两者的正确处置不同，
 * 而且把前者误报成后者会让人以为存在并发编辑，从而怀疑错方向——
 * 在移动端上尤其糟糕，因为那里本来就更难观察发生了什么。
 */
export const NON_ATOMIC_REASON = "PLATFORM_NO_ATOMIC_REPLACE";

export class LocalCommitter {
	private locks = new Map<string, Promise<unknown>>();
	/** 平台是否支持「rename 到不存在的目标」——移动端探测失败则退化 */
	private renameSupported: boolean | null = null;

	constructor(
		private app: App,
		/** 插件目录（<configDir>/plugins/<id>）：staging/recovery 都放这里，永不参与同步 */
		private pluginDir: string,
		private log: (msg: string) => void = () => {},
	) {}

	private get stagingDir(): string {
		return `${this.pluginDir}/staging`;
	}

	private get recoveryDir(): string {
		return `${this.pluginDir}/recovery`;
	}

	/**
	 * 取某个路径的互斥锁并执行。
	 *
	 * 同一路径的提交严格串行；不同路径并发。锁按碰撞键取——在 Windows/macOS 上
	 * `A.md` 与 `a.md` 是同一个文件，必须共享同一把锁。
	 */
	async withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const key = path.normalize("NFC").toLowerCase();
		const prev = this.locks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		this.locks.set(key, prev.then(() => gate));
		await prev.catch(() => {});
		try {
			return await fn();
		} finally {
			release();
			// 只有当前持有者才清理，避免把后来者的锁抹掉
			if (this.locks.get(key) === gate) this.locks.delete(key);
		}
	}

	/**
	 * 提交一次远端内容到本地 Vault。
	 *
	 * **不**更新 FileState——身份字段的写入由调用方通过 store 的强类型转换完成
	 * （§6.11），提交器只负责「安全地把字节放到正确的位置」。
	 */
	async commitRemoteChange(req: CommitRequest): Promise<CommitResult> {
		// 步骤 2：先验内容自身。hash 不符说明解密结果或网络内容不可信，
		// 这种情况不能降级为冲突——直接硬失败
		const actual = await sha256Hex(req.incoming);
		if (actual !== req.incomingHash) {
			throw new CommitIntegrityError(
				`待写入内容的 hash 与声明不符（期望 ${req.incomingHash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已拒绝写入本地`,
			);
		}

		// 步骤 4：路径安全
		let path: string;
		try {
			path = validateAndCanonicalizeVaultPath(req.realPath);
		} catch (e) {
			if (!(e instanceof InvalidVaultPathError)) throw e;
			return { status: "rejected", reason: `路径不安全：${e.reason}` };
		}

		return this.withPathLock(path, () => this.commitLocked(req, path));
	}

	private async commitLocked(req: CommitRequest, path: string): Promise<CommitResult> {
		const adapter = this.app.vault.adapter;

		// 步骤 6：锁内重新读取当前本地内容（决策必须基于「此刻」的盘上状态）
		const stat = await adapter.stat(path);
		if (stat?.type === "folder") {
			return { status: "rejected", reason: "目标路径被本地文件夹占用" };
		}
		const currentHash = stat ? await sha256Hex(await adapter.readBinary(path)) : null;

		// 步骤 7/8：前置条件
		if (currentHash !== req.expectedLocalHash) {
			this.log(`commit: precondition failed for ${path} (policy=${req.conflictPolicy})`);
			return {
				status: "precondition-failed",
				reason: currentHash === null ? "本地文件已被删除" : "本地文件在此期间被修改",
			};
		}

		// 移动端若没有可靠的 rename 原语，直接覆盖会在中途断电时留下半个文件。
		// 计划书 §6.1 要求此时不得直接覆盖 —— 交回调用方走 keep-both。
		if (!(await this.canInstallAtomically()) && currentHash !== null) {
			// 交回调用方走 keep-both（§8.8 门槛 11）。reason 用一个可判定的前缀，
			// 让上层能把它与「本地真的被改了」区分开——那两种情况的正确处置不同，
			// 而且把前者误报成后者会让人以为有并发编辑，从而怀疑错方向
			return {
				status: "rejected",
				reason: `${NON_ATOMIC_REASON}：本平台不提供可靠的 rename，无法原子安装`,
			};
		}

		// 步骤 1：写 staging（失败也不会碰到目标文件）
		const staging = `${this.stagingDir}/${req.operationId}`;
		await ensureParentFolder(adapter, staging);
		await adapter.writeBinary(staging, req.incoming);

		// 步骤 9：旧内容先搬到 recovery——这一步让「覆盖」变成可撤销的
		let recoveryPath: string | undefined;
		if (currentHash !== null) {
			recoveryPath = `${this.recoveryDir}/${req.operationId}`;
			await ensureParentFolder(adapter, recoveryPath);
			try {
				await adapter.rename(path, recoveryPath);
			} catch (e) {
				await this.discard(staging);
				throw new CommitIntegrityError(`无法把旧内容移入恢复区，已放弃本次写入：${String(e)}`);
			}
		}

		// §8.1 注入点：旧内容已进 recovery、新内容尚未安装。
		// 这是唯一一个「目标路径上什么都没有」的瞬间——崩溃后必须能从
		// recovery 找回旧内容，绝不能变成「文件凭空消失」
		await evalFailpoint(FP.commitAfterRecovery);

		// 步骤 10：安装
		try {
			await ensureParentFolder(adapter, path);
			await evalFailpoint(FP.commitBeforeInstall);
			if (currentHash === null && !(await this.canInstallAtomically())) {
				// 平台没有可用的 rename，但这是**新建**：目标路径上什么都没有，
				// 直接写不会毁掉任何已有内容。写坏了最坏是留下半个新文件，
				// 而它本来就不存在——用户没有损失。
				//
				// 不这么做的话，没有 rename 的平台连新文件都收不到，
				// 那不是「安全退化为 keep-both」，是同步彻底不工作。
				await adapter.writeBinary(path, req.incoming);
				await this.discard(staging);
			} else {
				await adapter.rename(staging, path);
			}
		} catch (e) {
			// 安装失败 → 把旧内容搬回去，恢复到调用前的状态
			if (recoveryPath !== undefined) {
				try {
					await adapter.rename(recoveryPath, path);
				} catch {
					this.log(`commit: FAILED to restore ${path} from recovery — 旧内容仍在 ${recoveryPath}`);
					throw new CommitIntegrityError(
						`写入失败且未能自动还原；旧内容已保留在插件目录的 recovery 中（${req.operationId}）`,
					);
				}
			}
			await this.discard(staging);
			throw e;
		}

		// 步骤 11：写后重新读回校验（磁盘满/截断会在这里被抓到）
		const after = await adapter.readBinary(path);
		const writtenHash = await sha256Hex(after);
		if (writtenHash !== req.incomingHash) {
			throw new CommitIntegrityError(`写入后读回校验失败（${path}），请检查磁盘空间`);
		}
		if (req.incomingMtime !== undefined && req.incomingMtime > 0) {
			// mtime 只是尽力而为：设不上不影响正确性（hash 才是判据）
			try {
				await adapter.writeBinary(path, after, { mtime: req.incomingMtime });
			} catch {
				/* 忽略 */
			}
		}

		return { status: "committed", writtenHash, ...(recoveryPath !== undefined ? { recoveryPath } : {}) };
	}

	/**
	 * 探测本平台能否用 rename 安装（只探测一次）。
	 *
	 * # 探测的是「改名到一个空位」，因为安装做的就是这件事
	 *
	 * 安装流程是「先把旧内容挪进 recovery，再把 staging 改名过来」——
	 * 目标路径在改名那一刻已经是空的。所以这里要探测的是
	 * `rename(A → 不存在的 B)`，而**不是**「改名覆盖已存在的文件」。
	 *
	 * 这个区别很要紧：Windows 的 rename 不能覆盖已存在的文件，
	 * 但先挪走再改名完全正常。按「能否覆盖」来探测会把所有 Windows 用户
	 * 误判成不支持原子替换，于是每一次远端更新都退化成冲突副本——
	 * 一个为了安全而加的检查，反过来把正常平台的同步毁掉。
	 *
	 * 探测同时校验改名后的**内容**，而不只是「目标存在」：一个把 rename
	 * 实现成「创建空文件」的适配器，只查存在性是查不出来的。
	 *
	 * 桌面端不再跳过探测（v0.17 改）：以前直接假定桌面可用，于是这条路径
	 * 在桌面上从来没被真正跑过——而网络盘、同步盘挂载的 Vault 就在桌面上。
	 * 一次探测的代价是三个小文件操作，只在每个会话里发生一次。
	 */
	private async canInstallAtomically(): Promise<boolean> {
		if (this.renameSupported !== null) return this.renameSupported;
		const adapter = this.app.vault.adapter;
		const probeA = `${this.stagingDir}/.probe-a`;
		const probeB = `${this.stagingDir}/.probe-b`;
		const marker = new Uint8Array([0xa5]).buffer;
		try {
			await ensureParentFolder(adapter, probeA);
			await this.discard(probeB); // 上次残留会让下面变成「覆盖」，那不是我们要测的
			await adapter.writeBinary(probeA, marker);
			await adapter.rename(probeA, probeB);
			const after = await adapter.readBinary(probeB);
			this.renameSupported = after.byteLength === 1 && new Uint8Array(after)[0] === 0xa5;
		} catch {
			this.renameSupported = false;
		}
		await this.discard(probeA);
		await this.discard(probeB);
		if (!this.renameSupported) {
			this.log(
				"commit: 本平台不支持可靠的 rename。" +
					"覆盖类写入将退化为保留双方版本——绝不做非原子覆盖：" +
					"中途断电会留下半个文件，而那半个文件就是用户唯一的那份内容",
			);
		}
		return this.renameSupported;
	}

	/**
	 * 本平台是否支持原子替换（供 UI 与诊断使用；会触发一次探测）。
	 *
	 * 计划书 §8.8 门槛 11 要求「所有不可原子替换的平台都安全退化为 keep-both」。
	 * 把这个判断暴露出来，是为了让「退化有没有发生」是可观测的，
	 * 而不是只能从一堆冲突副本里反推。
	 */
	async supportsAtomicReplace(): Promise<boolean> {
		return this.canInstallAtomically();
	}

	private async discard(path: string): Promise<void> {
		try {
			if (await this.app.vault.adapter.stat(path)) await this.app.vault.adapter.remove(path);
		} catch {
			/* staging 残留不影响正确性，由 sweep 清理 */
		}
	}

	/**
	 * 清理过期的 staging 与 recovery（启动时调用一次）。
	 *
	 * staging 里的东西一律可丢（那是还没安装成功的副本）；
	 * recovery 里是**被换下来的用户旧内容**，必须按保留期留够时间。
	 */
	async sweep(now: number): Promise<void> {
		const adapter = this.app.vault.adapter;
		for (const [dir, retention] of [
			[this.stagingDir, 0],
			[this.recoveryDir, RECOVERY_RETENTION_MS],
		] as const) {
			let listing;
			try {
				listing = await adapter.list(dir);
			} catch {
				continue; // 目录不存在
			}
			for (const f of listing.files) {
				const st = await adapter.stat(f);
				if (st && now - st.mtime < retention) continue;
				await this.discard(f);
			}
		}
	}
}
