import { App, Platform } from "obsidian";
import { NotFoundError, RemoteChange, SnapshotFile } from "../api/client";
import { decryptMeta } from "../crypto/crypto";
import { BlockedChange } from "../state/store";
import { sha256Hex } from "../utils/hash";
import { ensureParentFolder } from "../utils/path";
import { requireFileId } from "../utils/validate";
import { evalFailpoint, FP } from "../utils/failpoint";
import { InvalidVaultPathError, pathsCollide, validateAndCanonicalizeVaultPath } from "../utils/vault-path";
import { attemptAutoMerge } from "./auto-merge";
import { keepBothVersions, keepIncomingAside } from "./conflict";
import { SyncContext } from "./context";
import { newOperationId } from "./queue";
import {
	assertMetaGeneration,
	downloadPlain,
	metaEncrypted,
	metaFingerprintOf,
	writeOrReportNonAtomic,
} from "./transfer";

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * 伪名变更解析（v9.3 三期 meta 模式）：change.path 是 32-hex 伪名（=fileId）。
 * 已跟踪 → 反查真实路径；未知伪名 → 轻量取加密元数据解出真实路径。
 * 返回 null 表示该变更无需处理（如从未有过的文件被删除）。
 */
async function resolveMetaChange(
	ctx: SyncContext,
	change: RemoteChange,
): Promise<{ realPath: string; serverPath: string } | "skip" | "blocked" | null> {
	const pseudonym = requireFileId(change.path, `change@${change.sequence}.path`);
	const known = ctx.store.pathByFileId(pseudonym);
	if (known !== undefined) return { realPath: known, serverPath: pseudonym };
	if (change.action === "delete") return "skip"; // 本地从未有过

	// 未知伪名：取元数据解出真实路径（无需下载内容）
	let meta;
	try {
		meta = await ctx.client.getFileMeta(pseudonym);
	} catch (e) {
		if (e instanceof NotFoundError) return "skip"; // 已被后续 change 删除
		throw e;
	}
	if (!meta.metaEnc) throw new Error(`meta 模式下服务器未返回加密元数据：${pseudonym}`);
	const bind = ctx.store.state.bootstrap;
	const keys = await ctx.e2ee.metaKeys();
	const dec = await decryptMeta(keys, meta.metaEnc, bind.remoteVaultId ?? "", pseudonym);
	if (dec === null) throw new Error(`无法解密文件元数据（${pseudonym}）：密钥不匹配或数据被篡改，已停止同步`);
	// §6.12：解密 ≠ 可信。路径要用来写文件系统，先过安全校验
	const safe = requireSafeRemotePath(ctx, dec.meta.path, {
		sequence: change.sequence,
		action: "upsert", // delete 已在上面提前返回
		fileId: pseudonym,
		serverPseudonym: pseudonym,
		revision: change.revision,
		contentHash: change.hash,
		metaGeneration: change.metaGeneration ?? dec.metaGeneration,
	});
	if (safe === null) return "blocked";
	return { realPath: safe, serverPath: pseudonym };
}

/**
 * 远端路径安全校验（v0.13.2 / §6.12）。
 *
 * meta 模式下真实路径来自解密后的元数据：服务器伪造不了，但一台被攻陷或有 bug 的
 * **旧设备**可以把 `../../.ssh/authorized_keys` 之类的字符串加密进去。所以在拿它
 * 去 stat / rename / writeBinary 之前必须校验。
 *
 * 拒绝时登记 blocked 而不是抛错：一条坏路径不该让整轮同步（以及后面所有正常
 * 文件）停摆；记录留在状态里，用户可见、可诊断，修好后自动重试。
 */
function requireSafeRemotePath(
	ctx: SyncContext,
	path: string,
	rec: Omit<BlockedChange, "retryCount" | "at" | "operationId" | "realPath" | "reason">,
): string | null {
	try {
		return validateAndCanonicalizeVaultPath(path);
	} catch (e) {
		if (!(e instanceof InvalidVaultPathError)) throw e;
		// realPath 留空：这条路径本身就是被拒绝的对象，绝不能被当作有效本地路径使用
		ctx.store.setBlockedChange({ ...rec, realPath: "", reason: `远端路径不安全：${e.reason}` });
		ctx.log(`pull: rejected unsafe remote path (${e.reason}, ${e.shape})`);
		ctx.notify(`已拒绝一条不安全的远端路径（${e.reason}），同步继续；请检查其他设备的版本`);
		return null;
	}
}

/**
 * 两个文件交换名称的两阶段收敛（v0.13.2 / 计划书 §6.9）。
 *
 * 远端把 A 改成 B、把 B 改成 A 时，两条改名各自看到「目标已被占用」，
 * 于是双双 blocked——而且永远解不开：谁都在等对方先让位。
 *
 * 正确做法是引入一个临时名：
 *
 *   A → temp  ,  B → A  ,  temp → B
 *
 * 临时名放在插件目录的 swap 命名空间里：不与用户文件冲突、不参与同步，
 * 并且**每一步之前都把意图写进状态并落盘**——中途崩溃时，
 * {@link recoverInterruptedSwaps} 能把它接着做完。
 *
 * 返回 null 表示「这不是一次名字互换」，调用方继续走原来的 blocked 流程。
 */
async function tryResolveNameSwap(
	ctx: SyncContext,
	realPath: string,
	newPath: string,
	pseudonym: string,
	metaGeneration: number,
	fingerprint: string,
): Promise<Outcome | null> {
	const occupant = ctx.store.get(newPath);
	const occupantPseudonym = occupant?.serverPseudonym ?? occupant?.fileId;
	if (!occupant || occupantPseudonym === undefined || occupantPseudonym === pseudonym) return null;

	// 占位者自己的远端目标名是什么？
	let occupantTarget: string;
	let occupantMetaGeneration: number;
	let occupantFingerprint: string;
	try {
		const meta = await ctx.client.getFileMeta(occupantPseudonym);
		const keys = await ctx.e2ee.metaKeys();
		const vaultId = ctx.store.state.bootstrap.remoteVaultId ?? "";
		const dec = await decryptMeta(keys, meta.metaEnc, vaultId, occupantPseudonym);
		if (dec === null) return null;
		occupantTarget = dec.meta.path;
		occupantMetaGeneration = dec.metaGeneration;
		occupantFingerprint = await metaFingerprintOf(meta.metaEnc);
	} catch {
		return null; // 拿不到占位者的状态 → 按普通阻塞处理
	}
	// 只有真正的互换（占位者要搬到我这里）才用临时名破环。
	// 占位者要搬去第三个位置时，让它自己那条 change 先做完更简单也更安全
	if (occupantTarget !== realPath) return null;

	const adapter = ctx.app.vault.adapter;
	const temp = `${ctx.pluginDir()}/swap/${pseudonym}`;

	// 意图先落盘：崩溃后 recoverInterruptedSwaps 靠这条记录把交换做完
	ctx.store.setPendingSwap({ tempPath: temp, fileId: pseudonym, targetPath: newPath, sourcePath: realPath });
	await ctx.store.save();

	try {
		await ensureParentFolder(adapter, temp);
		await adapter.rename(realPath, temp); // A → temp
		// §8.1 注入点：交换只做了一半。此刻崩溃，那份内容只存在于插件目录里，
		// 必须靠 recoverInterruptedSwaps 找回来
		await evalFailpoint(FP.swapAfterFirstStep);
		await ensureParentFolder(adapter, realPath);
		await adapter.rename(newPath, realPath); // B → A
		await ensureParentFolder(adapter, newPath);
		await adapter.rename(temp, newPath); // temp → B
	} catch (e) {
		ctx.log(`swap: 交换 ${realPath} ↔ ${newPath} 失败：${String(e)}（临时副本保留在插件目录，下轮自动续做）`);
		return "blocked";
	}

	ctx.store.clearPendingSwap(temp);
	// 两个对象的状态同时换位。不能顺序调用两次 rename——第一次就会把
	// 对方的状态覆盖掉；先把两份状态取出来，再各自落到新键上。
	// 身份字段（fileId / contentGeneration）原样带走（INV-05）。
	const mine = ctx.store.get(realPath)!;
	const theirs = ctx.store.get(newPath)!;
	ctx.store.markDeleted(realPath);
	ctx.store.markDeleted(newPath);
	ctx.store.replaceWithNewObject(newPath, {
		...mine,
		metaGeneration,
		metaFingerprint: fingerprint,
		serverPseudonym: pseudonym,
	});
	ctx.store.replaceWithNewObject(realPath, {
		...theirs,
		metaGeneration: occupantMetaGeneration,
		metaFingerprint: occupantFingerprint,
		serverPseudonym: occupantPseudonym,
	});
	await ctx.store.save();
	ctx.log(`pull: swapped ${realPath} <-> ${newPath} via ${temp}`);
	return "applied";
}

/**
 * 续做被中断的名字互换（v0.13.2 / §6.9）。
 *
 * 临时文件放在插件目录里，用户看不见也搜索不到——如果崩溃后没人管，
 * 那份内容就等于丢了。每轮同步开始时先把它放回该去的地方。
 */
export async function recoverInterruptedSwaps(ctx: SyncContext): Promise<void> {
	const adapter = ctx.app.vault.adapter;
	for (const swap of ctx.store.pendingSwaps()) {
		if (!(await adapter.stat(swap.tempPath))) {
			ctx.store.clearPendingSwap(swap.tempPath); // 已经搬完了
			continue;
		}
		// 目标还被占着说明第二步（B → A）没做完；此时把临时文件放回原位更安全
		const target = (await adapter.stat(swap.targetPath)) ? null : swap.targetPath;
		if (target === null) {
			// 0.17.0-rc.3：目标被**真实文件**占着可能永远不会空出来（比如大小写探测
			// 中途崩溃、占用者是另一个文件）。原路径空着就放回去——文件回到用户
			// 眼前，改名意图由下一轮 change 重放重新走完整判定
			if (swap.sourcePath !== undefined && !(await adapter.stat(swap.sourcePath))) {
				await ensureParentFolder(adapter, swap.sourcePath);
				await adapter.rename(swap.tempPath, swap.sourcePath);
				ctx.store.clearPendingSwap(swap.tempPath);
				ctx.log(`swap: ${swap.targetPath} 被占用，已把临时副本放回原路径 ${swap.sourcePath}`);
				continue;
			}
			ctx.log(`swap: ${swap.targetPath} 仍被占用，临时副本继续保留（下轮重试）`);
			continue;
		}
		await ensureParentFolder(adapter, target);
		await adapter.rename(swap.tempPath, target);
		ctx.store.clearPendingSwap(swap.tempPath);
		ctx.log(`swap: 已续做中断的交换 → ${target}`);
	}
	await ctx.store.save();
}

/**
 * 把本地文件从 fromPath 搬到 toPath，正确处理「目标 stat 命中的其实是自己」的
 * 大小写 / Unicode 归一化改名（v0.17 / 验收 T3.5）。
 *
 * 在大小写不敏感（或做 Unicode 归一化）的文件系统上，`stat(toPath)` 会命中
 * fromPath 指向的同一个物理文件——把它当「目标被占用」会让纯大小写改名永远
 * blocked。但反过来在大小写敏感的系统上，同名异例的文件确实可能是另一个文件，
 * 直接 rename 会**覆盖**它。两种情况无法只靠 stat 区分，用两步探测消歧：
 * 先把源文件挪到插件目录的临时名（意图先落盘，崩溃后可恢复），再看目标是否
 * 仍然存在——消失了就是同一个文件（安全改名），仍在就是真实占用（挪回去）。
 */
async function renameLocalFile(
	ctx: SyncContext,
	fromPath: string,
	toPath: string,
	fileId: string | undefined,
): Promise<"renamed" | "occupied"> {
	const adapter = ctx.app.vault.adapter;
	const occupied = await adapter.stat(toPath);
	if (!occupied) {
		await ensureParentFolder(adapter, toPath);
		await adapter.rename(fromPath, toPath);
		return "renamed";
	}
	// 目标被一个**已跟踪的其他对象**占着：这是真实占用，不必探测
	if (ctx.store.get(toPath) !== undefined || !pathsCollide(fromPath, toPath)) {
		return "occupied";
	}
	const temp = `${ctx.pluginDir()}/swap/${fileId ?? newOperationId()}`;
	ctx.store.setPendingSwap({ tempPath: temp, fileId: fileId ?? "", targetPath: toPath, sourcePath: fromPath });
	await ctx.store.save();
	await ensureParentFolder(adapter, temp);
	await adapter.rename(fromPath, temp);
	if (await adapter.stat(toPath)) {
		// 目标仍在 → 真实占用（大小写敏感系统上的另一个文件）：原样放回
		await adapter.rename(temp, fromPath);
		ctx.store.clearPendingSwap(temp);
		await ctx.store.save();
		return "occupied";
	}
	// 目标消失了 → stat 命中的就是源文件本身（大小写/归一化改名）：落到新名字
	await ensureParentFolder(adapter, toPath);
	await adapter.rename(temp, toPath);
	ctx.store.clearPendingSwap(temp);
	await ctx.store.save();
	return "renamed";
}

/**
 * 明文模式的改名应用（协议 v6 / ADR-001 §3.4）。
 *
 * v6 的改名是一次元数据更新：服务器只发一条「新路径 + 同 fileId + hash 未变 +
 * metaGeneration 变新」的 upsert change，**不发 delete**——旧路径没有任何后续
 * 变更来清理它。客户端必须按 fileId 认出这是改名并把本地文件搬过去；
 * 认不出来的话新路径会被当成新文件下载，旧文件成为孤儿，
 * 用户看到「新旧名各一个文件」（验收 T3.2 的失败形态）。
 */
async function applyPlainRename(
	ctx: SyncContext,
	fromPath: string,
	toPath: string,
	change: {
		sequence: number;
		fileId?: string;
		revision?: number;
		hash?: string;
		metaGeneration?: number;
	},
	occupantTargets?: Map<string, string>,
): Promise<Outcome> {
	const tracked = ctx.store.get(fromPath);
	if (!tracked) return "skipped";
	// 陈旧改名（重放的旧 change）：本地已见过更新的元数据世代 → 不往回搬
	if (
		tracked.metaGeneration !== undefined &&
		change.metaGeneration !== undefined &&
		change.metaGeneration < tracked.metaGeneration
	) {
		return "skipped";
	}
	const adapter = ctx.app.vault.adapter;

	if (!(await adapter.stat(fromPath))) {
		// 本地原文件不在（可能刚被用户移走）：只更新状态键，内容由扫描收敛；
		// 用户自己的改名意图（pending move op）跟着换基，随后作为正常改名推送（T3.4）
		ctx.store.applyMetaRenameState(fromPath, toPath, { metaGeneration: change.metaGeneration });
		ctx.queue.rebaseMoveFrom(fromPath, toPath);
		return "applied";
	}

	// §6.9 两个文件交换名称（全量对账场景）：目标被另一个「自己也正要搬走、
	// 且要搬到我这里」的文件占着 → 用临时名破环，与 meta 模式的 swap 同构
	const occupant = ctx.store.get(toPath);
	if (occupant !== undefined && (await adapter.stat(toPath))) {
		const occupantTarget = occupant.fileId !== undefined ? occupantTargets?.get(occupant.fileId) : undefined;
		if (occupantTarget === fromPath) {
			return applyPlainSwap(ctx, fromPath, toPath, change);
		}
	}

	if ((await renameLocalFile(ctx, fromPath, toPath, change.fileId ?? tracked.fileId)) === "occupied") {
		ctx.store.setBlockedChange({
			sequence: change.sequence,
			action: "rename",
			fileId: change.fileId ?? tracked.fileId,
			revision: change.revision ?? tracked.revision,
			contentHash: change.hash ?? tracked.serverHash,
			contentGeneration: tracked.generation,
			metaGeneration: change.metaGeneration,
			realPath: toPath,
			renameFrom: fromPath,
			renameTo: toPath,
			reason: "远端改名目标已被本地文件占用",
		});
		ctx.notify(`远端将 ${fromPath} 改名为 ${toPath}，但目标已存在本地文件，已暂缓`);
		return "blocked";
	}
	ctx.store.applyMetaRenameState(fromPath, toPath, { metaGeneration: change.metaGeneration });
	ctx.queue.rebaseMoveFrom(fromPath, toPath);
	ctx.log(`pull: renamed ${fromPath} -> ${toPath}`);
	return "applied";
}

/** 明文模式的名字互换（A → temp，B → A，temp → B），与 tryResolveNameSwap 同构。 */
async function applyPlainSwap(
	ctx: SyncContext,
	realPath: string,
	newPath: string,
	change: { fileId?: string; metaGeneration?: number },
): Promise<Outcome> {
	const adapter = ctx.app.vault.adapter;
	const temp = `${ctx.pluginDir()}/swap/${change.fileId ?? newOperationId()}`;
	ctx.store.setPendingSwap({ tempPath: temp, fileId: change.fileId ?? "", targetPath: newPath, sourcePath: realPath });
	await ctx.store.save();
	try {
		await ensureParentFolder(adapter, temp);
		await adapter.rename(realPath, temp); // A → temp
		await evalFailpoint(FP.swapAfterFirstStep);
		await ensureParentFolder(adapter, realPath);
		await adapter.rename(newPath, realPath); // B → A
		await ensureParentFolder(adapter, newPath);
		await adapter.rename(temp, newPath); // temp → B
	} catch (e) {
		ctx.log(`swap: 交换 ${realPath} ↔ ${newPath} 失败：${String(e)}（临时副本保留在插件目录，下轮自动续做）`);
		return "blocked";
	}
	ctx.store.clearPendingSwap(temp);
	const mine = ctx.store.get(realPath)!;
	const theirs = ctx.store.get(newPath)!;
	ctx.store.markDeleted(realPath);
	ctx.store.markDeleted(newPath);
	ctx.store.replaceWithNewObject(newPath, { ...mine, metaGeneration: change.metaGeneration });
	ctx.store.replaceWithNewObject(realPath, { ...theirs });
	await ctx.store.save();
	ctx.log(`pull: swapped ${realPath} <-> ${newPath} via ${temp}`);
	return "applied";
}

/**
 * 元数据改名应用（v9.3 三期）：内容未变、metaGeneration 变新 → 本地 rename。
 * 目标已被占用时登记 blocked（不覆盖任何本地内容）。
 */
async function applyMetaRename(
	ctx: SyncContext,
	realPath: string,
	pseudonym: string,
	sequence: number,
): Promise<Outcome> {
	const tracked = ctx.store.get(realPath);
	if (!tracked) return "skipped";
	const meta = await ctx.client.getFileMeta(pseudonym);
	const bind = ctx.store.state.bootstrap;
	const keys = await ctx.e2ee.metaKeys();
	const dec = await decryptMeta(keys, meta.metaEnc, bind.remoteVaultId ?? "", pseudonym);
	if (dec === null) throw new Error(`无法解密文件元数据（${pseudonym}）`);
	// §6.8：判据取**认证后**的 dec.metaGeneration，不是服务器 Header。
	// 回退与同世代分叉都在这里硬失败（会顺带停掉该仓库的自动同步）
	const fingerprint = await metaFingerprintOf(meta.metaEnc);
	if (assertMetaGeneration(ctx, realPath, dec.metaGeneration, fingerprint) === "idempotent") {
		return "skipped"; // 同一份元数据又收到一次：什么都不用做
	}
	// §6.12：解密出来的路径由「某台设备」写入，不是可信输入——先过安全校验，
	// 拒绝的路径绝不落到文件系统上
	const newPath = requireSafeRemotePath(ctx, dec.meta.path, {
		sequence,
		action: "rename",
		fileId: tracked.fileId,
		serverPseudonym: pseudonym,
		metaGeneration: dec.metaGeneration,
		renameFrom: realPath,
	});
	if (newPath === null) return "blocked";
	// 身份字段一律经 store.update/rename 保留（LS-121-C04）：改名不改 fileId、
	// 不改 contentGeneration，也不改服务器伪名
	if (newPath === realPath) {
		ctx.store.applyRemoteIdentity(realPath, {
			metaGeneration: dec.metaGeneration,
			metaFingerprint: fingerprint,
			serverPseudonym: pseudonym,
		});
		return "skipped";
	}
	const adapter = ctx.app.vault.adapter;
	// §6.4：记下完整的改名变更（含 fileId / metaGeneration / 新旧路径），
	// 重试时原样重放，不再靠真实路径合成一条假的 upsert
	const registerBlocked = (): Outcome => {
		ctx.store.setBlockedChange({
			sequence,
			action: "rename",
			fileId: tracked.fileId,
			serverPseudonym: pseudonym,
			revision: tracked.revision,
			contentHash: tracked.serverHash,
			contentGeneration: tracked.generation,
			metaGeneration: dec.metaGeneration,
			realPath,
			renameFrom: realPath,
			renameTo: newPath,
			reason: "远端改名目标已被本地文件占用",
		});
		ctx.notify(`远端将 ${realPath} 改名为 ${newPath}，但目标已存在本地文件，已暂缓`);
		return "blocked";
	};
	// 「目标被占用」必须排除「stat 命中的是自己」：大小写不敏感/归一化的文件系统上，
	// 纯大小写改名的 stat(newPath) 命中的就是 realPath 那个文件（T3.5）——
	// 那不是占用，交给 renameLocalFile 的两步探测消歧
	const occupiedByOther =
		(await adapter.stat(newPath)) !== null &&
		(ctx.store.get(newPath) !== undefined || !pathsCollide(realPath, newPath));
	if (occupiedByOther) {
		// §6.9 两个文件交换名称：目标被占用不一定是死结——占着位子的那个文件
		// 可能自己也正要搬走。先试着用临时名把环解开
		const swapped = await tryResolveNameSwap(ctx, realPath, newPath, pseudonym, dec.metaGeneration, fingerprint);
		if (swapped !== null) return swapped;
		return registerBlocked();
	}
	if (!(await adapter.stat(realPath))) {
		// 本地原文件不在（可能刚被用户移走）：只更新状态键，内容由扫描收敛；
		// 用户自己的改名意图（pending move op）跟着换基，随后作为正常改名推送（T3.4）
		ctx.store.applyMetaRenameState(realPath, newPath, {
			metaGeneration: dec.metaGeneration,
			metaFingerprint: fingerprint,
			serverPseudonym: pseudonym,
		});
		ctx.queue.rebaseMoveFrom(realPath, newPath);
		return "applied";
	}
	if ((await renameLocalFile(ctx, realPath, newPath, tracked.fileId)) === "occupied") {
		return registerBlocked();
	}
	ctx.store.applyMetaRenameState(realPath, newPath, {
		metaGeneration: dec.metaGeneration,
		metaFingerprint: fingerprint,
		serverPseudonym: pseudonym,
	});
	ctx.queue.rebaseMoveFrom(realPath, newPath);
	ctx.log(`pull: renamed ${realPath} -> ${newPath} (metaGen ${dec.metaGeneration})`);
	return "applied";
}

export interface PullResult {
	applied: number;
	conflicts: number;
}

/** 服务器 repoEpoch 与本地保存值不一致（灾备恢复后）时抛出，中止本轮同步。 */
export class RepoEpochChangedError extends Error {
	constructor() {
		super("服务器 sequence 世代（repoEpoch）已变化，本设备需要重新接入");
		this.name = "RepoEpochChangedError";
	}
}

/**
 * epoch 防护（v9）：服务器从备份恢复后 repoEpoch 会被旋转，旧游标全部作废。
 * 发现变化：重置 bootstrap → 用户通过接入向导选择「安全合并」重新对齐
 *（本地 post-backup 的新内容全部保留，两侧差异走冲突流程，绝不静默丢弃）。
 */
async function guardRepoEpoch(ctx: SyncContext, serverEpoch: string | undefined): Promise<void> {
	if (!serverEpoch) return;
	const saved = ctx.store.state.bootstrap.repoEpoch;
	if (!saved) {
		// v0.8 升级上来的设备第一次见到 epoch：记录之
		ctx.store.state.bootstrap.repoEpoch = serverEpoch;
		return;
	}
	if (saved !== serverEpoch) {
		// v0.14.0-RC / §8.5：这里必须与 SyncManager 的 /info 路径做**完全一样**的事。
		//
		// 之前这条路径只重置了 bootstrap：没有留档恢复现场，也没有作废旧游标。
		// 于是「先由 changes 发现 epoch 变化」和「先由 /info 发现」会得到两种
		// 不同的本地状态——而前者恰恰是离线一段时间后重新上线的常见顺序。
		ctx.store.enterRecovery({
			reason: "repo-epoch-changed",
			previousEpoch: saved,
			serverEpoch,
			localSequence: ctx.store.state.lastSequence,
			localFileCount: ctx.store.paths().length,
			at: Date.now(),
		});
		ctx.store.resetBootstrap();
		ctx.store.clearBinding();
		// 旧游标作废：它属于上一个 sequence 世代，在新世代里指向的是完全不同的变更。
		// 留着它比清掉危险得多——只要有任何一条路径把 bootstrap 重新置为 ready
		// 而没有重新锚定游标，同步就会从一个错误的位置继续。
		ctx.store.state.lastSequence = 0;
		await ctx.store.save();
		ctx.notify(
			"服务器数据已从备份恢复（repoEpoch 变化），自动同步已暂停；\n请重新运行接入向导并选择「安全合并」，本地较新的内容不会丢失",
		);
		throw new RepoEpochChangedError();
	}
}

/**
 * 拉取并应用远端变更。
 * 数据安全红线：每条 change 成功处理之后才推进 lastSequence；
 * 中途失败时已处理部分的游标会被保存，不会漏掉远端修改。
 */
export async function pullRemoteChanges(ctx: SyncContext): Promise<PullResult> {
	const result: PullResult = { applied: 0, conflicts: 0 };
	try {
		await retryBlockedChanges(ctx, result);
		for (;;) {
			const resp = await ctx.client.changes(ctx.store.state.lastSequence, 500);
			await guardRepoEpoch(ctx, resp.repoEpoch);
			if (resp.resyncRequired) {
				// 服务器已裁剪掉旧 changes：走 snapshot 全量对账重建游标（绝不漏删改）
				ctx.log(
					`resync required (cursor ${ctx.store.state.lastSequence} < min ${resp.minSequence ?? 0})`,
				);
				const r = await resyncFromSnapshot(ctx);
				result.applied += r.applied;
				result.conflicts += r.conflicts;
				break;
			}
			// 防御：同一 epoch 内服务器 head 落后于本地游标（正常协议下不应发生）
			// → 不再盲等，走 snapshot 对账把游标锚回真实状态
			if (resp.changes.length === 0 && resp.latestSequence < ctx.store.state.lastSequence) {
				ctx.log(
					`server head ${resp.latestSequence} < cursor ${ctx.store.state.lastSequence}, forcing snapshot reconcile`,
				);
				const r = await resyncFromSnapshot(ctx);
				result.applied += r.applied;
				result.conflicts += r.conflicts;
				break;
			}
			if (resp.changes.length === 0) {
				// 没有新变更；latestSequence 可能因事务回滚出现空洞，直接对齐
				if (resp.latestSequence > ctx.store.state.lastSequence) {
					ctx.store.state.lastSequence = resp.latestSequence;
				}
				break;
			}
			for (const change of resp.changes) {
				const note: OutcomeNote = {};
				const outcome = await applyRemoteChange(ctx, change, note);
				// §8.1 注入点：变更已应用、游标尚未推进。此刻崩溃会让这条变更
				// 被重放一次——重放必须是幂等的，绝不能产生第二份内容或假冲突
				await evalFailpoint(FP.cursorBeforeAck);
				if (outcome === "applied") result.applied++;
				if (outcome === "conflict") result.conflicts++;
				// §8.8 第 10 条：先留下处置证据，再确认这个 sequence。
				// 顺序反过来的话，中途崩溃会留下一个「确认了但没人知道为什么」的游标
				ctx.store.recordSequenceEvidence({
					sequence: change.sequence,
					outcome,
					...(outcome === "skipped" ? { reason: note.reason ?? "unspecified" } : {}),
					at: Date.now(),
				});
				if (outcome === "blocked") {
					// §6.4：blocked 记录必须先落盘并通过写后验证，才允许推进游标。
					// 否则这条变更会同时从 changes 流和状态里消失——服务器不会再
					// 发第二次，本地也没有重试线索，该文件永远补不回来。
					await ctx.store.save();
				}
				ctx.store.state.lastSequence = change.sequence;
			}
			if (!resp.hasMore) break;
		}
	} finally {
		await ctx.store.save();
	}
	return result;
}

/**
 * 重试被阻塞的远端变更（v9：skipped 不再等于永久放弃）。
 * 例：远端文件与本地文件夹同名——用户移走文件夹后，这里会把该文件补下载回来，
 * 即使服务器不再产生新的 change。
 */
async function retryBlockedChanges(ctx: SyncContext, result: PullResult): Promise<void> {
	for (const [key, rec] of ctx.store.blockedChanges()) {
		// 阻塞条件仍在（同名文件夹没被移走）→ 不必重试
		if (rec.realPath !== "" && (await ctx.app.vault.adapter.stat(rec.realPath))?.type === "folder") continue;

		let outcome: Outcome;
		if (rec.action === "rename" && rec.serverPseudonym && rec.renameFrom) {
			// 改名重放：重新取元数据、重新校验路径、重新判断目标是否仍被占用
			outcome = await applyMetaRename(ctx, rec.renameFrom, rec.serverPseudonym, rec.sequence);
		} else if (rec.action === "rename" && rec.renameFrom && rec.renameTo) {
			// 明文模式的改名重放（v6）：同样原样重放，不合成假 upsert
			outcome = await applyPlainRename(ctx, rec.renameFrom, rec.renameTo, {
				sequence: rec.sequence,
				fileId: rec.fileId,
				revision: rec.revision,
				hash: rec.contentHash,
				metaGeneration: rec.metaGeneration,
			});
		} else {
			// §6.4：用记录里的原始字段重放这条变更，**不**用真实路径合成一条假的 upsert。
			// serverPseudonym 在时以它寻址（meta 模式下服务器只认伪名）。
			const replayPath = rec.serverPseudonym ?? rec.realPath;
			if (replayPath === "") {
				// 路径被判为不安全的记录：没有可用的寻址名 → 只能等对方设备改正
				continue;
			}
			outcome = await applyRemoteChange(ctx, {
				sequence: rec.sequence,
				path: replayPath,
				action: rec.action === "delete" ? "delete" : "upsert",
				revision: rec.revision ?? 0,
				...(rec.fileId !== undefined ? { fileId: rec.fileId } : {}),
				...(rec.contentHash !== undefined ? { hash: rec.contentHash } : {}),
				...(rec.metaGeneration !== undefined ? { metaGeneration: rec.metaGeneration } : {}),
			});
		}
		// blocked 时 applyRemoteChange/applyMetaRename 会重新登记（retryCount 自增），
		// 这里只负责在不再阻塞时清除
		if (outcome !== "blocked") ctx.store.clearBlockedChange(key);
		if (outcome === "applied") result.applied++;
		if (outcome === "conflict") result.conflicts++;
	}
}

type Outcome = "applied" | "skipped" | "conflict" | "blocked";

/**
 * snapshot 全量对账：把「快照 vs 本地状态缓存」的差异合成为等价的远端变更，
 * 复用 applyRemoteChange 的全部安全逻辑（冲突/合并/回收站），最后对齐游标。
 */
async function resyncFromSnapshot(ctx: SyncContext): Promise<PullResult> {
	const result: PullResult = { applied: 0, conflicts: 0 };
	const snap = await ctx.client.snapshot();
	await guardRepoEpoch(ctx, snap.repoEpoch);

	// meta 模式（v9.3 三期）：快照条目是伪名 + 加密元数据 → 先解出真实路径
	const files = await resolveSnapshotPaths(ctx, snap.files, snap.sequence);
	const snapPaths = new Set(files.map((f) => f.path));
	// fileId → 快照中的目标路径：改名判定与名字互换破环都靠它
	const snapTargets = new Map<string, string>();
	for (const f of files) {
		if (f.fileId) snapTargets.set(f.fileId, f.path);
	}

	// 已跟踪但快照中不存在 → 远端已删除
	for (const path of ctx.store.paths()) {
		if (ctx.ignores(path) || snapPaths.has(path)) continue;
		const tracked = ctx.store.get(path);
		// 同 fileId 仍在快照的另一条路径下：这是**改名**不是删除——
		// 交给下面的 rename pass 处理，否则会先把文件送进回收站再全量重下载
		if (tracked?.fileId !== undefined && snapTargets.has(tracked.fileId)) continue;
		const outcome = await applyRemoteChange(ctx, {
			sequence: snap.sequence,
			path: metaEncrypted(ctx) && tracked?.fileId ? tracked.fileId : path,
			action: "delete",
			revision: 0,
		});
		if (outcome === "applied") result.applied++;
		if (outcome === "conflict") result.conflicts++;
	}
	// 快照与本地已知服务器状态不一致 → 远端有更新
	for (const f of files) {
		if (ctx.ignores(f.path)) continue;
		// 离线期间的远端改名：同 fileId 挂在别的本地路径上 → 先做本地 rename
		//（meta 模式经加密元数据；明文模式直接按快照路径）
		if (f.fileId) {
			const existing = ctx.store.pathByFileId(f.fileId);
			if (existing !== undefined && existing !== f.path) {
				const outcome = f.serverPseudonym
					? await applyMetaRename(ctx, existing, f.serverPseudonym, snap.sequence)
					: await applyPlainRename(
							ctx,
							existing,
							f.path,
							{
								sequence: snap.sequence,
								fileId: f.fileId,
								revision: f.revision,
								hash: f.hash,
								metaGeneration: f.metaGeneration,
							},
							snapTargets,
						);
				if (outcome === "applied") result.applied++;
				if (outcome === "blocked") continue;
			}
		}
		const tracked = ctx.store.get(f.path);
		if (tracked && tracked.serverHash === f.hash) {
			if (tracked.revision !== f.revision || tracked.metaGeneration !== f.metaGeneration) {
				ctx.store.applyRemoteIdentity(f.path, {
					metaGeneration: f.metaGeneration,
					metaFingerprint: f.metaFingerprint,
					fileId: f.fileId,
					serverPseudonym: f.serverPseudonym,
				});
				ctx.store.patchContentState(f.path, { revision: f.revision });
			}
			continue;
		}
		const outcome = await applyRemoteChange(ctx, {
			sequence: snap.sequence,
			path: f.serverPseudonym ?? f.path,
			action: "upsert",
			revision: f.revision,
			hash: f.hash,
			metaGeneration: f.metaGeneration,
		});
		if (outcome === "applied") result.applied++;
		if (outcome === "conflict") result.conflicts++;
	}

	ctx.store.state.lastSequence = snap.sequence;
	await ctx.store.save();
	ctx.notify("服务器变更日志已轮转，已通过快照完成全量对账");
	return result;
}

interface ResolvedSnapshotFile extends SnapshotFile {
	/** meta 模式下的服务器伪名（path 已替换为解密出的真实路径） */
	serverPseudonym?: string;
	/** 该份元数据的认证摘要（§6.8：同世代分叉判定的依据） */
	metaFingerprint?: string;
}

/** 快照条目的元数据解密（明文模式原样返回）。 */
export async function resolveSnapshotPaths(
	ctx: SyncContext,
	files: SnapshotFile[],
	sequence = 0,
): Promise<ResolvedSnapshotFile[]> {
	if (!files.some((f) => f.metaEnc)) return files;
	const vaultId = ctx.store.state.bootstrap.remoteVaultId ?? "";
	const keys = await ctx.e2ee.metaKeys();
	const out: ResolvedSnapshotFile[] = [];
	for (const f of files) {
		if (!f.metaEnc || !f.fileId) {
			out.push(f); // 迁移中的混合态：明文路径条目原样处理
			continue;
		}
		const dec = await decryptMeta(keys, f.metaEnc, vaultId, f.fileId);
		if (dec === null) {
			throw new Error(`无法解密文件元数据（${f.fileId}）：密钥不匹配或数据被篡改，已停止同步`);
		}
		// §6.12：快照里的路径同样要过安全校验——被拒绝的条目登记 blocked 后跳过，
		// 不让一条坏路径把整次全量对账拖垮
		const safe = requireSafeRemotePath(ctx, dec.meta.path, {
			sequence,
			action: "upsert",
			fileId: f.fileId,
			serverPseudonym: f.fileId,
			revision: f.revision,
			contentHash: f.hash,
			metaGeneration: dec.metaGeneration,
		});
		if (safe === null) continue;
		out.push({
			...f,
			path: safe,
			metaGeneration: dec.metaGeneration,
			metaFingerprint: await metaFingerprintOf(f.metaEnc),
			serverPseudonym: f.fileId,
		});
	}
	return out;
}

/**
 * skipped 的可审计原因（v0.14.0-RC / §8.8 第 10 条）。
 *
 * 「跳过」如果没有原因，就等于没有证据：事后没人能分辨
 * 「这条变更本来就不需要处理」和「我们漏掉了一条变更」。
 */
export interface OutcomeNote {
	reason?: string;
}

function skip(note: OutcomeNote | undefined, reason: string): Outcome {
	if (note) note.reason = reason;
	return "skipped";
}

async function applyRemoteChange(
	ctx: SyncContext,
	change: RemoteChange,
	note?: OutcomeNote,
): Promise<Outcome> {
	let path = change.path;
	let serverPath: string | undefined;

	// meta 模式（v9.3 三期）：变更携带伪名，先解析出真实路径
	if (metaEncrypted(ctx) && HEX32.test(change.path)) {
		const resolved = await resolveMetaChange(ctx, change);
		if (resolved === "blocked") return "blocked"; // 路径不安全，记录已登记
		if (resolved === "skip" || resolved === null) return skip(note, "meta-change-not-applicable");
		path = resolved.realPath;
		serverPath = resolved.serverPath;

		// 元数据世代变新 = 带着改名。§6.9：rename+edit 必须**先改名再写内容**——
		// 反过来会把内容写回旧路径、还顺手记下新 metaGeneration，改名信号从此被吞掉
		const tracked = ctx.store.get(path);
		if (change.action === "upsert" && tracked && (change.metaGeneration ?? 0) > (tracked.metaGeneration ?? 0)) {
			const renameOnly = change.hash !== undefined && change.hash === tracked.serverHash;
			const ren = await applyMetaRename(ctx, path, resolved.serverPath, change.sequence);
			if (renameOnly || ren === "blocked") return ren;
			// 改名已落地（或状态已对齐），内容继续在新路径上应用
			path = ctx.store.pathByFileId(resolved.serverPath) ?? path;
		}
	} else {
		// 明文模式：路径直接来自服务器，同样不是可信输入（§6.12）
		const safe = requireSafeRemotePath(ctx, path, {
			sequence: change.sequence,
			action: change.action === "delete" ? "delete" : "upsert",
			fileId: change.fileId,
			revision: change.revision,
			contentHash: change.hash,
			metaGeneration: change.metaGeneration,
		});
		if (safe === null) return "blocked";
		path = safe;

		// v6 改名检测（验收 T3.2）：同一 fileId 已跟踪在另一条本地路径上 →
		// 这条 change 是改名（可能还带着编辑），先把本地文件搬过去，
		// 绝不能当成新文件下载——那会把旧文件留成孤儿（新旧名各一）
		if (change.action !== "delete" && change.fileId !== undefined) {
			const existing = ctx.store.pathByFileId(change.fileId);
			if (existing !== undefined && existing !== path) {
				const existingState = ctx.store.get(existing);
				if (existingState?.serverPseudonym === change.path) {
					// 伪名化回声（验收 T6.4）：元数据迁移期间产生的 change 的 path 是
					// 伪名（= 该对象已记录的 serverPseudonym）。abort 后 metaState 回到
					// plain，这些 change 回放进明文分支——它们**不是改名**，绝不能把
					// 真实文件改名成 32-hex；按真实本地路径应用内容、按伪名寻址服务器
					path = existing;
					serverPath = change.path;
				} else {
					const ren = await applyPlainRename(ctx, existing, path, change);
					if (ren === "blocked") return "blocked";
					// 陈旧改名（重放的旧 change）：文件的现名比这条 change 更新，
					// 绝不能落到下面的内容应用——那会按旧名字重新造出一个文件
					if (ren === "skipped") return skip(note, "stale-rename-change");
					const moved = ctx.store.get(path);
					// 纯改名（内容未变）：改名即全部；rename+edit 继续在新路径上应用内容
					if (change.hash !== undefined && change.hash === moved?.serverHash) {
						if (moved) ctx.store.update(path, { revision: change.revision });
						return ren;
					}
				}
			}
		}
	}

	if (ctx.ignores(path)) return skip(note, "ignored-by-rules");
	// 文件正在冲突处理中：冻结远端应用，避免来回覆盖；Resolver 解决时会重新取远端 HEAD
	if (ctx.store.getConflict(path)) return skip(note, "frozen-by-pending-conflict");

	// §6.12：跨平台碰撞。两个只差大小写（或差在 NFC/NFD、尾随点）的远端对象，
	// 在 Windows/macOS 上会落到同一个本地文件——后写的那个静默覆盖先写的那个。
	// 必须在写之前拦住：登记 blocked，两份内容都留在服务器上。
	// 删除不拦：删除不会造成覆盖，而拦下来反而会让本地留着不该留的文件。
	if (change.action !== "delete") {
		const collides = ctx.store.collidingPath(path, serverPath ?? change.fileId ?? ctx.store.get(path)?.fileId);
		if (collides !== undefined) {
			ctx.store.setBlockedChange({
				sequence: change.sequence,
				action: "upsert",
				fileId: serverPath,
				serverPseudonym: serverPath,
				revision: change.revision,
				contentHash: change.hash,
				metaGeneration: change.metaGeneration,
				realPath: path,
				reason: `与已有文件在本平台上重名（${collides}）`,
			});
			ctx.notify(`已暂缓：${path} 与本地已有的 ${collides} 在本平台上是同一个文件名\n请在任一设备上改名后自动恢复`);
			return "blocked";
		}
	}

	const adapter = ctx.app.vault.adapter;
	const stat = await adapter.stat(path);
	if (stat?.type === "folder") {
		// v9：不再静默 ACK——持久化 blocked 记录，每轮同步重试，
		// 用户移走同名文件夹后即使没有新 change 也能补回该文件
		// v0.13.2 §6.4：记录带上完整身份，重试时重放的是原始变更本身
		ctx.store.setBlockedChange({
			sequence: change.sequence,
			action: change.action === "delete" ? "delete" : "upsert",
			fileId: serverPath ?? ctx.store.get(path)?.fileId,
			serverPseudonym: serverPath,
			revision: change.revision,
			contentHash: change.hash,
			metaGeneration: change.metaGeneration,
			realPath: path,
			reason: "远端文件与本地文件夹同名",
		});
		ctx.notify(`已暂缓：远端文件与本地文件夹同名 ${path}\n移走该文件夹后会自动补齐`);
		return "blocked";
	}
	const tracked = ctx.store.get(path);

	if (change.action === "delete") {
		if (!stat) {
			ctx.store.markDeleted(path);
			ctx.store.clearPendingDelete(path);
			return skip(note, "delete-of-untracked-file");
		}
		const localData = await adapter.readBinary(path);
		const localHash = await sha256Hex(localData);
		if (tracked && localHash === tracked.hash) {
			// 本地未修改 → 跟随远端删除（进回收站，保底不丢数据）
			if (await trashLocal(ctx.app, path)) {
				ctx.store.markDeleted(path);
				ctx.log(`pull: deleted ${path}`);
				return "applied";
			}
			// 删除安全（所有平台）：回收站失败时宁可多留一份，绝不永久删除。
			// 记入 pendingDeletes：扫描时跳过（不会被当作新文件重新上传），等用户手动删除
			ctx.store.markDeleted(path);
			ctx.store.setPendingDelete(path);
			ctx.notify(`无法移入回收站，已保留本地文件（不会重新上传）：${path}\n请手动删除`);
			return "applied";
		}
		// 本地有未同步修改 → 保留本地内容，转为新文件重新上传
		ctx.store.markDeleted(path);
		ctx.queue.stage(path, { action: "upsert" });
		ctx.notify(`远端已删除但本地有修改，已保留本地文件: ${path}`);
		return "conflict";
	}

	// upsert
	// 服务器该内容本设备已知（例如自己刚推送的变更）→ 只推进 revision
	if (tracked && change.hash && change.hash === tracked.serverHash) {
		ctx.store.update(path, { revision: change.revision, serverPseudonym: serverPath });
		return skip(note, "content-already-known");
	}

	let localHash: string | null = null;
	let localData: ArrayBuffer | null = null;
	if (stat) {
		const data = await adapter.readBinary(path);
		localData = data;
		localHash = await sha256Hex(data);
	}

	// 本地明文与远端内容一致（明文模式的快速路径）→ 只更新状态
	if (localHash !== null && change.hash && localHash === change.hash) {
		ctx.store.update(path, {
			hash: localHash,
			serverHash: change.hash,
			revision: change.revision,
			mtime: stat?.mtime ?? Date.now(),
			size: stat?.size ?? localData!.byteLength,
			serverPseudonym: serverPath,
		});
		return skip(note, "local-content-already-identical");
	}

	const localChanged = stat !== null && (!tracked || localHash !== tracked.hash);

	if (!stat || !localChanged) {
		// 本地不存在，或本地自上次同步后未修改 → 采用远端版本
		let dl;
		try {
			dl = await downloadPlain(ctx, path, serverPath);
		} catch (e) {
			if (e instanceof NotFoundError) return skip(note, "deleted-by-later-change");
			throw e;
		}
		// 本地 CAS（v9 TOCTOU 修复）：下载是网络等待，期间用户可能恰好编辑了
		// 这个文件（且事件因 applyingRemote 被忽略）——写入前必须确认本地
		// 仍是决策时刻的内容，否则用户刚敲下的新内容会被远端版本静默覆盖
		const wrote = await writeOrReportNonAtomic(ctx, path, dl.plain, localHash, dl.mtime);
		if (wrote === "non-atomic") {
			// §8.8 门槛 11：本平台不能原子替换 → 直接退化为保留双方版本。
			// 不走下面的「本地变了 → 合并」流程：本地根本没变，
			// 走那条路会得出错误的诊断，还会白白再下载一次 base
			const kept = await keepIncomingAside(ctx, path, dl.plain);
			if (kept === null) return skip(note, "non-atomic-keep-both-failed");
			ctx.notify(
				`${path}：本设备不支持原子替换，已把远端版本另存为 ${kept}，` +
					`原文件保持不变。请手动核对后合并。`,
			);
			return "conflict";
		}
		if (wrote === "written") {
			const st = await adapter.stat(path);
			ctx.store.update(path, {
				hash: dl.plainHash,
				serverHash: dl.cipherHash,
				revision: dl.revision,
				mtime: st?.mtime ?? Date.now(),
				size: dl.plain.byteLength,
				fileId: dl.fileId,
				generation: dl.generation,
				metaGeneration: dl.metaGeneration ?? change.metaGeneration,
				serverPseudonym: serverPath,
			});
			ctx.log(`pull: downloaded ${path} (rev ${dl.revision})`);
			return "applied";
		}
		// 下载期间本地出现了新内容/被删除 → 绝不覆盖：
		// 重新读取现场，落入下方「双方都改」的合并/兜底流程
		ctx.log(`pull: local changed during download of ${path}, rerouting to merge`);
		const curStat = await adapter.stat(path);
		if (!curStat) return skip(note, "removed-locally-during-download");
		localData = await adapter.readBinary(path);
	}

	// 本地与远端都改了 → 先尝试三方自动合并（仅 Markdown 文本）
	const merged = await attemptAutoMerge(ctx, path, localData!, tracked);
	if (merged === "merged") return "applied";
	if (merged === "pending") {
		ctx.notify(`同步冲突: ${path}\n请运行 "Resolve conflicts" 处理`);
		return "conflict";
	}
	// 无法自动合并（二进制 / 无 Base / 引擎异常）→ 最后安全兜底：保留两个版本
	const kept = await keepBothVersions(ctx, path, localData!);
	return kept === null ? "skipped" : "conflict";
}

/**
 * 删除本地文件时进回收站，任何平台都绝不永久删除（README 承诺）。返回是否成功。
 * 优先 FileManager.trashFile（尊重用户在「删除的文件」中的偏好设置）；
 * 回收站失败一律返回 false，由调用方保留本地文件并登记 pendingDeletes，
 * 提示用户手动删除——宁可多留一份，不可误删。
 */
export async function trashLocal(app: App, path: string): Promise<boolean> {
	const adapter = app.vault.adapter;
	try {
		const af = app.vault.getAbstractFileByPath(path);
		if (af) {
			await app.fileManager.trashFile(af);
			return true;
		}
		// 配置目录等隐藏路径拿不到 TAbstractFile，退回 adapter
		if (!Platform.isMobileApp && (await adapter.trashSystem(path))) return true;
		await adapter.trashLocal(path);
		return true;
	} catch {
		return false;
	}
}
