/**
 * 自动三方合并集成（计划书 Phase 14）。
 *
 * conflict → canThreeWayMerge? → base/local/remote → threeWayMerge()
 *   clean    → 自动上传（action=merge），带 Race Protection（409 → 重新拉取重 merge）
 *   conflict → 登记 pending conflict，交给 Resolver UI
 *   任何异常 → "fallback"，调用方回退 keepBothVersions（最后安全兜底）
 */
import { ConflictError } from "../api/client";
import { threeWayMerge } from "../merge/three-way";
import { FileState } from "../state/store";
import { sha256Hex } from "../utils/hash";
import { decodeUtf8Strict, encodeUtf8 } from "../utils/text";
import { SyncContext } from "./context";

export type AutoMergeOutcome = "merged" | "pending" | "fallback";

/** Race Protection：merge 期间远端又变化时的最大重试次数。 */
const MAX_MERGE_ATTEMPTS = 3;

/** 第一版只对 Markdown 文本启用自动合并；.canvas 与二进制一律不做。 */
function eligibleForTextMerge(path: string): boolean {
	return path.toLowerCase().endsWith(".md");
}

export async function attemptAutoMerge(
	ctx: SyncContext,
	path: string,
	localData: ArrayBuffer,
	tracked: FileState | undefined,
): Promise<AutoMergeOutcome> {
	try {
		if (!eligibleForTextMerge(path)) return "fallback";
		if (!tracked) return "fallback"; // 没有共同祖先（新设备上的未跟踪文件）

		const localText = decodeUtf8Strict(localData);
		if (localText === null) return "fallback"; // 二进制不做 text merge

		// Base = 客户端 tracked revision 对应的服务器历史版本
		let baseText: string;
		try {
			const baseDl = await ctx.client.version(path, tracked.revision);
			const baseHash = await sha256Hex(baseDl.data);
			if (baseDl.hash && baseHash !== baseDl.hash) return "fallback";
			const t = decodeUtf8Strict(baseDl.data);
			if (t === null) return "fallback";
			baseText = t;
		} catch {
			// 历史被 GC / 服务器未开启历史 / 网络异常 → 兜底 keepBoth
			return "fallback";
		}

		for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
			// Remote = 服务器当前 HEAD（每次重试都重新获取，保证基于最新 revision）
			const remote = await ctx.client.download(path);
			const remoteHash = await sha256Hex(remote.data);
			if (remote.hash && remoteHash !== remote.hash) return "fallback";
			const remoteText = decodeUtf8Strict(remote.data);
			if (remoteText === null) return "fallback";

			const result = threeWayMerge({ base: baseText, local: localText, remote: remoteText });
			if (!result.clean) {
				ctx.store.setConflict(path, {
					baseRevision: tracked.revision,
					remoteRevision: remote.revision,
					createdAt: Date.now(),
				});
				ctx.log(`auto-merge: structured conflicts on ${path} (${result.conflicts.length} hunks)`);
				return "pending";
			}

			const mergedData = encodeUtf8(result.mergedText);
			const mergedHash = await sha256Hex(mergedData);
			try {
				// Race Protection：必须以下载到的 remote revision 作为 baseRevision
				const res = await ctx.client.upload(path, remote.revision, mergedHash, mergedData, Date.now(), "merge");
				const adapter = ctx.app.vault.adapter;
				await adapter.writeBinary(path, mergedData);
				const stat = await adapter.stat(path);
				ctx.store.set(path, {
					hash: mergedHash,
					revision: res.revision,
					mtime: stat?.mtime ?? Date.now(),
					size: mergedData.byteLength,
				});
				ctx.notify(`已自动合并: ${path}`);
				ctx.log(`auto-merge: ${path} → rev ${res.revision} (attempt ${attempt + 1})`);
				return "merged";
			} catch (e) {
				if (e instanceof ConflictError) continue; // 远端在合并期间又变了 → 重新 merge
				throw e;
			}
		}
		ctx.log(`auto-merge: gave up after ${MAX_MERGE_ATTEMPTS} attempts on ${path}`);
		return "fallback";
	} catch (e) {
		// 数据安全红线：merge 引擎任何异常都不能丢数据 → 回退 keepBothVersions
		ctx.log(`auto-merge error on ${path}: ${e instanceof Error ? e.message : String(e)}`);
		return "fallback";
	}
}
