/**
 * 自动三方合并集成（计划书 Phase 14）。
 *
 * conflict → canThreeWayMerge? → base/local/remote → threeWayMerge()
 *   clean    → 自动上传（action=merge），带 Race Protection（409 → 重新拉取重 merge）
 *   conflict → 登记 pending conflict，交给 Resolver UI
 *   任何异常 → "fallback"，调用方回退 keepBothVersions（最后安全兜底）
 *
 * E2EE：base/remote 经 transfer 层解密，合并在明文上进行，上传自动重新加密。
 */
import { ConflictError } from "../api/client";
import { E2eeLockedError } from "../crypto/keyring";
import { threeWayMerge } from "../merge/three-way";
import { FileState } from "../state/store";
import { sha256Hex } from "../utils/hash";
import { decodeUtf8Strict, encodeUtf8 } from "../utils/text";
import { SyncContext } from "./context";
import { downloadPlain, uploadFromPlain, versionPlain } from "./transfer";

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
		const localHash = await sha256Hex(localData);

		// Base = 客户端 tracked revision 对应的服务器历史版本（解密后明文）
		let baseText: string;
		try {
			const base = await versionPlain(ctx, path, tracked.revision);
			const t = decodeUtf8Strict(base.plain);
			if (t === null) return "fallback";
			baseText = t;
		} catch (e) {
			if (e instanceof E2eeLockedError) throw e;
			// 历史被 GC / 服务器未开启历史 / 网络异常 → 兜底 keepBoth
			return "fallback";
		}

		for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
			// Remote = 服务器当前 HEAD（每次重试都重新获取，保证基于最新 revision）
			const remote = await downloadPlain(ctx, path);
			const remoteText = decodeUtf8Strict(remote.plain);
			if (remoteText === null) return "fallback";

			// 两端内容其实一致（如重试 / 相同修改）→ 直接采纳远端 revision
			if (remote.plainHash === localHash) {
				const stat = await ctx.app.vault.adapter.stat(path);
				ctx.store.set(path, {
					hash: localHash,
					serverHash: remote.cipherHash,
					revision: remote.revision,
					mtime: stat?.mtime ?? Date.now(),
					size: localData.byteLength,
				});
				return "merged";
			}

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
				const out = await uploadFromPlain(ctx, path, mergedData, remote.revision, Date.now(), "merge");
				const adapter = ctx.app.vault.adapter;
				await adapter.writeBinary(path, mergedData);
				const stat = await adapter.stat(path);
				ctx.store.set(path, {
					hash: mergedHash,
					serverHash: out.cipherHash,
					revision: out.revision,
					mtime: stat?.mtime ?? Date.now(),
					size: mergedData.byteLength,
				});
				ctx.notify(`已自动合并: ${path}`);
				ctx.log(`auto-merge: ${path} → rev ${out.revision} (attempt ${attempt + 1})`);
				return "merged";
			} catch (e) {
				if (e instanceof ConflictError) continue; // 远端在合并期间又变了 → 重新 merge
				throw e;
			}
		}
		ctx.log(`auto-merge: gave up after ${MAX_MERGE_ATTEMPTS} attempts on ${path}`);
		return "fallback";
	} catch (e) {
		// 锁定状态必须向上传播暂停同步，而不是产生 conflict 副本
		if (e instanceof E2eeLockedError) throw e;
		// 数据安全红线：merge 引擎任何异常都不能丢数据 → 回退 keepBothVersions
		ctx.log(`auto-merge error on ${path}: ${e instanceof Error ? e.message : String(e)}`);
		return "fallback";
	}
}
