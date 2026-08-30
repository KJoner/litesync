/**
 * Bootstrap 执行器（v8 首次接入）。
 *
 * 三种模式共同的红线：
 * - 任何情况下不永久删除本地文件（覆盖前先进回收站，失败则保留 + pendingDeletes）
 * - 只触碰 LiteSync 同步范围内的文件（忽略规则、插件目录、配置目录照常排除）
 * - 完成后 lastSequence 对齐快照 sequence，无缝进入普通增量同步
 */
import { ConflictError, ServerInfo, SnapshotFile } from "../api/client";
import { sha256Hex } from "../utils/hash";
import { keepBothVersions } from "../sync/conflict";
import { SyncContext } from "../sync/context";
import { resolveSnapshotPaths, trashLocal } from "../sync/pull";
import { isStaleResurrection } from "../sync/push";
import { downloadPlain, uploadFromPlain, writeIfLocalUnchanged } from "../sync/transfer";

export interface PreflightResult {
	info: ServerInfo;
	snapshotSequence: number;
	/** 快照对应的 repoEpoch（v9）：完成接入时与游标一起保存 */
	repoEpoch?: string;
	remoteFiles: SnapshotFile[];
	localPaths: string[];
	commonCount: number;
	/** 远端已启用 E2EE（执行前必须先解锁） */
	e2eeEnabled: boolean;
}

export interface BootstrapProgress {
	done: number;
	total: number;
	current: string;
}

type OnProgress = (p: BootstrapProgress) => void;

/** 接入前探测：远端信息 + 快照 + E2EE 状态 + 本地文件清单。 */
export async function preflight(ctx: SyncContext): Promise<PreflightResult> {
	const info = await ctx.client.info();

	// 换库对账（v0.18 实测缺陷的补口）：向导可能在「bootstrap pending + 已换
	// Token」的状态下直接打开——同步轮里的 vaultId 对账（adoptRepoIdentity）
	// 在 pending 时被 bootstrap gate 拦在更前面，永远没有机会执行。
	// 旧账本属于别的仓库：带着它执行恢复/合并，下载校验会拿旧 fileId 当期望
	// 而必然失败（「服务器返回了不同的文件身份」）；执行 local-init 则会静默
	// 不传任何文件。必须赶在下面覆盖 pending binding **之前**对账并作废。
	//
	// 归属判定用 ledgerVaultId（账本自己的归属标记）而**不是**
	// bootstrap.remoteVaultId——后者每次 preflight 都会被 pending binding
	// 覆盖，一次失败的向导之后它就已经指向新仓库，再比较必然「一致」。
	// 账本非空而归属未知（旧版本升级留下的中间态）同样作废：无法证明这本账
	// 属于眼前这个仓库，就不能拿它当「已同步」的证据。
	if (info.vaultId && ctx.store.paths().length > 0) {
		const owner =
			ctx.store.state.ledgerVaultId ??
			(ctx.store.state.bootstrap.status === "ready" ? ctx.store.state.bootstrap.remoteVaultId : undefined);
		if (owner !== info.vaultId) {
			ctx.log(
				`preflight: ledger belongs to ${owner ? owner.slice(0, 8) + "…" : "an unknown repository"}, ` +
					`server is ${info.vaultId.slice(0, 8)}…; discarding stale ledger`,
			);
			ctx.store.resetForNewRepository();
		}
	}

	// 权威 pending binding（v0.13.1 / 计划书 §5.1）。
	//
	// 一拿到服务器状态就写进 bootstrap（status 仍是 pending）：此后 bootstrap
	// 期间的 LSE3/LSM1 加解密、伪名解析、Merge 上传都用得上正确的绑定材料。
	// 绝不因为「正式接入状态还没写入」而回退到 LSE1、真实路径或无 fileId 上传——
	// 那些回退会在服务器上留下无法解密的内容或泄露的路径。
	ctx.store.setPendingBinding({
		remoteVaultId: info.vaultId,
		repoEpoch: info.repoEpoch,
		keyEpoch: info.keyEpoch,
		metaState: info.metaState,
		formatEpoch: info.formatEpoch,
		minimumEnvelopeVersion: info.minimumEnvelopeVersion,
	});
	await ctx.store.save();

	await ctx.refreshE2ee();
	const snap = await ctx.client.snapshot();
	// meta 模式（v9.3 三期）：快照条目是伪名 + 加密元数据。已解锁则立即解出
	// 真实路径；未解锁保留伪名（向导会先走解锁门，执行器再兜底解一次）
	let files = snap.files;
	if (files.some((f) => f.metaEnc) && ctx.e2ee.unlocked) {
		files = await resolveSnapshotPaths(ctx, files);
	}
	const remoteFiles = files.filter((f) => !ctx.ignores(f.path));

	const localPaths: string[] = [];
	for (const file of ctx.app.vault.getFiles()) {
		if (!ctx.ignores(file.path)) localPaths.push(file.path);
	}
	const remoteSet = new Set(remoteFiles.map((f) => f.path));
	const commonCount = localPaths.filter((p) => remoteSet.has(p)).length;

	return {
		info,
		snapshotSequence: snap.sequence,
		repoEpoch: snap.repoEpoch ?? info.repoEpoch,
		remoteFiles,
		localPaths,
		commonCount,
		e2eeEnabled: ctx.e2ee.enabled,
	};
}

/** 执行器兜底：确保快照路径已解密（向导解锁后调用执行器时可能仍持伪名清单）。 */
async function ensureResolvedPre(ctx: SyncContext, pre: PreflightResult): Promise<PreflightResult> {
	if (!pre.remoteFiles.some((f) => f.metaEnc && f.path === f.fileId)) return pre;
	const files = await resolveSnapshotPaths(ctx, pre.remoteFiles);
	const remoteFiles = files.filter((f) => !ctx.ignores(f.path));
	const remoteSet = new Set(remoteFiles.map((f) => f.path));
	return {
		...pre,
		remoteFiles,
		commonCount: pre.localPaths.filter((p) => remoteSet.has(p)).length,
	};
}

function completeBootstrap(ctx: SyncContext, pre: PreflightResult, mode: "remote-wins" | "merge" | "local-init"): void {
	ctx.store.state.lastSequence = pre.snapshotSequence;
	ctx.store.completeBootstrap(mode, pre.info.vaultId, pre.snapshotSequence, pre.repoEpoch, pre.info.keyEpoch);
}

/** 本地初始化远端（远端为空）：标记就绪后由普通同步把本地文件全部推上去。 */
export async function bootstrapLocalInit(ctx: SyncContext, pre: PreflightResult): Promise<void> {
	// 自愈（v0.18 实测缺陷）：对**空**远端不可能存在「已同步」账本——有即为
	// 换库/换账户的残留（升级前旧版本留下的，或换 Token 后未及重载的旧代码
	// 写下的）。不作废的话，「由普通同步推上去」会因为账本声称「都同步过」
	// 而一个文件都不推：local-init 静默变成空操作，状态栏却显示 synced。
	if (pre.remoteFiles.length === 0 && ctx.store.paths().length > 0) {
		ctx.log(`bootstrap: local-init found stale ledger (${ctx.store.paths().length} entries) against an empty remote — clearing`);
		ctx.store.clearSyncLedger();
	}
	completeBootstrap(ctx, pre, "local-init");
	await ctx.store.save();
	ctx.log(`bootstrap: local-init (local=${pre.localPaths.length})`);
}

/**
 * 从远端恢复此设备（Remote Wins）：远端为准覆盖本地同步范围。
 * 本地不同内容先进回收站；回收站失败保留文件并登记 pendingDeletes。
 */
export async function bootstrapRemoteWins(
	ctx: SyncContext,
	pre: PreflightResult,
	onProgress: OnProgress,
): Promise<void> {
	pre = await ensureResolvedPre(ctx, pre);
	const adapter = ctx.app.vault.adapter;
	const remoteSet = new Set(pre.remoteFiles.map((f) => f.path));
	const total = pre.remoteFiles.length + pre.localPaths.filter((p) => !remoteSet.has(p)).length;
	let done = 0;

	let blocked = 0;
	for (const f of pre.remoteFiles) {
		onProgress({ done: ++done, total, current: f.path });
		const dl = await downloadPlain(ctx, f.path, serverPseudonymOf(f));
		const stat = await adapter.stat(f.path);
		if (stat) {
			const localData = await adapter.readBinary(f.path);
			const localHash = await sha256Hex(localData);
			if (localHash === dl.plainHash) {
				// 内容一致：直接建立 tracked 状态，不动文件
				ctx.store.update(f.path, {
					hash: localHash,
					serverHash: dl.cipherHash,
					revision: dl.revision,
					mtime: stat.mtime,
					size: stat.size,
					fileId: dl.fileId,
					generation: dl.generation,
					metaGeneration: dl.metaGeneration,
					serverPseudonym: serverPseudonymOf(f),
				});
				continue;
			}
			// 本地内容不同：先进回收站再写远端版本（绝不永久删除）。
			// P0-3 修复：回收站失败时绝不覆盖——本地这份可能是该内容的唯一副本，
			// 保留原文件并登记 blocked，普通同步的冲突流程接手（本地新内容不会丢）
			if (!(await trashLocal(ctx.app, f.path))) {
				blocked++;
				ctx.store.setBlockedChange({
				sequence: f.revision,
				action: "upsert",
				fileId: f.fileId,
				serverPseudonym: serverPseudonymOf(f),
				revision: f.revision,
				contentHash: f.hash,
				metaGeneration: f.metaGeneration,
				realPath: f.path,
				reason: "bootstrap remote-wins：回收站不可用，未覆盖本地内容",
			});
				ctx.notify(`无法移入回收站，已保留本地内容（未被远端覆盖）：${f.path}`);
				continue;
			}
		}
		// §6.1：remote-wins 也必须走统一提交器。此刻本地文件已进回收站（或本来就不存在），
		// 因此前置条件是「本地不存在」——若在这个空隙里又出现了文件，绝不覆盖
		if (!(await writeIfLocalUnchanged(ctx, f.path, dl.plain, null, dl.mtime))) {
			blocked++;
			ctx.store.setBlockedChange({
				sequence: f.revision,
				action: "upsert",
				fileId: f.fileId,
				serverPseudonym: serverPseudonymOf(f),
				revision: f.revision,
				contentHash: f.hash,
				metaGeneration: f.metaGeneration,
				realPath: f.path,
				reason: "bootstrap remote-wins：写入前本地又出现了文件，未覆盖",
			});
			ctx.notify(`已保留本地新出现的文件（未被远端覆盖）：${f.path}`);
			continue;
		}
		const st = await adapter.stat(f.path);
		ctx.store.update(f.path, {
			hash: dl.plainHash,
			serverHash: dl.cipherHash,
			revision: dl.revision,
			mtime: st?.mtime ?? Date.now(),
			size: dl.plain.byteLength,
			fileId: dl.fileId,
			generation: dl.generation,
			metaGeneration: dl.metaGeneration,
			serverPseudonym: serverPseudonymOf(f),
		});
	}

	// 本地多余的同步范围文件：远端没有 → 进回收站；失败保留 + pendingDeletes
	for (const path of pre.localPaths) {
		if (remoteSet.has(path)) continue;
		onProgress({ done: ++done, total, current: path });
		if (await trashLocal(ctx.app, path)) {
			ctx.store.markDeleted(path);
		} else {
			ctx.store.markDeleted(path);
			ctx.store.setPendingDelete(path);
			ctx.notify(`无法移入回收站，已保留本地文件（不会重新上传）：${path}\n请手动删除`);
		}
	}

	completeBootstrap(ctx, pre, "remote-wins");
	await ctx.store.save();
	ctx.log(`bootstrap: remote-wins (remote=${pre.remoteFiles.length}, blocked=${blocked})`);
}

export interface MergeResult {
	downloaded: number;
	uploaded: number;
	conflicts: number;
}

/**
 * 首次安全合并：保证两边数据都不丢，而不是强行自动融合。
 * - 远端有本地无 → 下载；本地有远端无 → 上传
 * - 双方一致 → 直接建立 tracked 状态
 * - 双方不同：Markdown → 登记 Initial Merge Conflict（Resolver 处理，无 Base 整体对比）；
 *   二进制等 → keepBothVersions 保留两个版本
 */
export async function bootstrapMerge(
	ctx: SyncContext,
	pre: PreflightResult,
	onProgress: OnProgress,
): Promise<MergeResult> {
	pre = await ensureResolvedPre(ctx, pre);
	const adapter = ctx.app.vault.adapter;
	const remoteSet = new Set(pre.remoteFiles.map((f) => f.path));
	const localOnly = pre.localPaths.filter((p) => !remoteSet.has(p));
	const total = pre.remoteFiles.length + localOnly.length;
	const result: MergeResult = { downloaded: 0, uploaded: 0, conflicts: 0 };
	let done = 0;

	for (const f of pre.remoteFiles) {
		onProgress({ done: ++done, total, current: f.path });
		const stat = await adapter.stat(f.path);
		if (!stat) {
			const dl = await downloadPlain(ctx, f.path, serverPseudonymOf(f));
			// §6.1：本地此刻不存在该文件才写（下载期间用户新建了同名文件 → 不覆盖，
			// 留给下一轮普通同步按冲突处理）
			if (!(await writeIfLocalUnchanged(ctx, f.path, dl.plain, null, dl.mtime))) continue;
			const st = await adapter.stat(f.path);
			ctx.store.update(f.path, {
				hash: dl.plainHash,
				serverHash: dl.cipherHash,
				revision: dl.revision,
				mtime: st?.mtime ?? Date.now(),
				size: dl.plain.byteLength,
				fileId: dl.fileId,
				generation: dl.generation,
				metaGeneration: dl.metaGeneration,
				serverPseudonym: serverPseudonymOf(f),
			});
			result.downloaded++;
			continue;
		}
		const localData = await adapter.readBinary(f.path);
		const localHash = await sha256Hex(localData);
		const dl = await downloadPlain(ctx, f.path, serverPseudonymOf(f));
		if (localHash === dl.plainHash) {
			ctx.store.update(f.path, {
				hash: localHash,
				serverHash: dl.cipherHash,
				revision: dl.revision,
				mtime: stat.mtime,
				size: stat.size,
				fileId: dl.fileId,
				generation: dl.generation,
				metaGeneration: dl.metaGeneration,
				serverPseudonym: serverPseudonymOf(f),
			});
			continue;
		}
		// 双方都有但内容不同：首次接入没有共同祖先（Base）
		if (isMarkdownLike(f.path)) {
			// 交给 Resolver（无 Base 时按“本地 vs 远端”整体对比）；期间该文件冻结同步
			ctx.store.recordConflict(f.path, { baseRevision: 0, remoteRevision: dl.revision, createdAt: Date.now() });
			ctx.onConflictsChanged();
			result.conflicts++;
		} else {
			// 二进制/Canvas 等：保留两个版本兜底
			await keepBothVersions(ctx, f.path, localData);
			result.conflicts++;
		}
	}

	for (const path of localOnly) {
		onProgress({ done: ++done, total, current: path });
		const stat = await adapter.stat(path);
		if (!stat) continue;
		const data = await adapter.readBinary(path);
		const hash = await sha256Hex(data);
		let out;
		try {
			out = await uploadFromPlain(ctx, path, data, 0, stat.mtime);
		} catch (e) {
			// v9 tombstone 防复活：该路径在服务器上是删除墓碑。
			// 陈旧副本（内容与删除前一致）→ 不上传、登记 pendingDelete；
			// 同名新内容 → 基于墓碑 revision 显式重建
			if (e instanceof ConflictError && e.server.deleted) {
				if (await isStaleResurrection(ctx, path, hash, e.server)) {
					ctx.store.setPendingDelete(path);
					ctx.notify(`检测到已删除文件的陈旧副本，不会重新上传：${path}`);
					continue;
				}
				out = await uploadFromPlain(ctx, path, data, e.server.revision, stat.mtime);
			} else {
				throw e;
			}
		}
		ctx.store.update(path, {
			hash,
			serverHash: out.cipherHash,
			revision: out.revision,
			mtime: stat.mtime,
			size: stat.size,
			fileId: out.fileId,
			generation: out.generation,
			metaGeneration: out.metaGeneration,
			serverPseudonym: out.serverPseudonym,
		});
		result.uploaded++;
	}

	// 上传会推进服务器 sequence：合并后的基线取「接入时快照」，
	// 随后的普通同步会拉到自己刚上传的 change 并按 serverHash 快速对齐
	completeBootstrap(ctx, pre, "merge");
	await ctx.store.save();
	ctx.log(
		`bootstrap: merge (down=${result.downloaded} up=${result.uploaded} conflicts=${result.conflicts})`,
	);
	return result;
}

/** meta 模式下条目的服务器伪名（解密后 path 为真实路径，伪名在 fileId）。 */
function serverPseudonymOf(f: SnapshotFile): string | undefined {
	return f.metaEnc && f.fileId ? f.fileId : undefined;
}

/** 与三方合并引擎一致的“可文本合并”判定：仅 Markdown / 纯文本。 */
function isMarkdownLike(path: string): boolean {
	const p = path.toLowerCase();
	return p.endsWith(".md") || p.endsWith(".txt");
}
