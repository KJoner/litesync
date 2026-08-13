import { MergeResult } from "../merge/model";
import { PendingConflict } from "../state/store";
import { SyncContext } from "../sync/context";

/** Resolver 加载完成的冲突数据。 */
export interface LoadedConflict {
	path: string;
	pending: PendingConflict;
	/** 打开 Resolver 时刻的远端 revision（Save Merge 必须以它为 baseRevision） */
	remoteRevision: number;
	/** 打开 Resolver 时刻远端 HEAD 的 contentGeneration（E2EE；Save Merge 的世代下限） */
	remoteGeneration?: number;
	localText: string;
	/** 打开 Resolver 时刻本地内容的 hash（Save 时本地 CAS 用，v9） */
	localHash: string;
	remoteText: string;
	/** base 版本不可用（已被 GC 等）时为 null，此时整体作为一个冲突段处理 */
	baseText: string | null;
	merge: MergeResult;
}

export function listPendingConflicts(ctx: SyncContext): Array<[string, PendingConflict]> {
	return ctx.store.conflictPaths().map((p) => [p, ctx.store.getConflict(p)!]);
}
