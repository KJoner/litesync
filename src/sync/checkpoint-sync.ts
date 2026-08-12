/**
 * checkpoint 的发布与校验，接进同步轮次（v0.15.0 / 计划书 §9）。
 *
 * 时机很重要：
 *
 *   - **校验放在一轮同步的开头**：先确认「服务器现在给我看的这套状态，
 *     确实是我已知历史的合法延伸」，再决定要不要按它去改本地文件。
 *     反过来（先同步再校验）等于先动手再检查，发现问题时已经写下去了。
 *   - **发布放在一轮同步的结尾**：只有本设备真正把远端变更全部应用完，
 *     它算出来的对象状态才代表「这个仓库此刻的样子」。中途发布等于替
 *     一个自己都没看全的状态签名背书。
 */

import { ApiError } from "../api/client";
import {
	CheckpointObject,
	SignedCheckpoint,
	checkpointHash,
	importSigningPrivateKey,
	objectsRoot,
	signCheckpoint,
} from "../crypto/checkpoint";
import { SyncContext } from "./context";
import { advanceAnchor, verifyFreshness } from "./freshness";

/**
 * 从本地状态算出对象摘要集合。
 *
 * 只包含本设备**确实跟踪着**的对象。因此两台设备只有在都完成一轮完整同步
 * 之后，算出的根才应当相同——这也是为什么发布必须放在同步结束时。
 */
export function localCheckpointObjects(ctx: SyncContext): CheckpointObject[] {
	const out: CheckpointObject[] = [];
	for (const path of ctx.store.paths()) {
		const fs = ctx.store.get(path);
		if (fs?.fileId === undefined) continue; // 还没拿到服务器身份的对象不参与
		out.push({
			fileId: fs.fileId,
			contentGeneration: fs.generation ?? 0,
			metaGeneration: fs.metaGeneration ?? 0,
			contentHash: fs.serverHash,
			metadataHash: fs.metaFingerprint ?? "",
			state: "live",
		});
	}
	return out;
}

/**
 * 校验服务器给出的 checkpoint 链（每轮同步开始时调用）。
 *
 * 返回 false 表示发现了完整性问题并已停机——调用方必须**中止本轮同步**，
 * 不要继续应用任何远端变更。
 *
 * 尚未建立信任锚（新设备还没配对过）时返回 true 并跳过：此时没有任何本地
 * 锚点可比，强行拿服务器给的第一个 manifest 当基准，等于让服务器自己定义
 * 「正确的历史」（§9.3）。信任必须由配对流程建立。
 */
export async function verifyCheckpointChain(ctx: SyncContext): Promise<boolean> {
	const anchor = ctx.store.state.trustAnchor;
	if (anchor === null) return true; // 未建立信任链：freshness 检查此时无从谈起

	let bundle;
	try {
		bundle = await ctx.client.checkpoints(anchor.headSequence);
	} catch (e) {
		// 旧服务器没有这个接口：不把它当成完整性问题（那会让升级路径卡死），
		// 但也不能假装验证过了——降级为「本轮无 freshness 保护」
		if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
			ctx.log("checkpoint: 服务器不支持签名 checkpoint，本轮没有 freshness 保护");
			return true;
		}
		throw e;
	}

	// §9.4：服务器如实交出的分叉证据。它自己不做裁决，我们也不自动选一边
	if (bundle.conflicting.length > 1) {
		const msg =
			`检测到仓库分叉：同一个位置上存在 ${bundle.conflicting.length} 份互不相同的已签名状态。` +
			`服务器可能对不同设备展示了不同的历史，已停止自动同步`;
		ctx.gate.markIntegrityError(msg);
		ctx.notify(msg);
		return false;
	}

	// 服务器报出的撤销清单只作为**补充**：撤销一台设备之后，其他设备可能
	// 还没同步到这个事实，此时服务器的说法能更快地生效。反过来，
	// 服务器把一台好设备谎报为已撤销，最坏后果只是拒绝它签的 checkpoint——
	// 那是安全的方向
	const effective = {
		...anchor,
		revokedDevices: [...new Set([...anchor.revokedDevices, ...bundle.revokedDevices])],
	};

	let chain = ctx.store.state.checkpointChain;
	for (const cp of bundle.checkpoints) {
		const verdict = await verifyFreshness(effective, chain, cp, ctx.store.state.bootstrap.remoteVaultId ?? "");
		if (!verdict.ok) {
			ctx.gate.markIntegrityError(verdict.message);
			ctx.notify(verdict.message);
			ctx.log(`checkpoint: rejected (${verdict.kind})`);
			return false;
		}
		if (verdict.kind === "same") continue;
		const next = advanceAnchor(effective, chain, cp);
		ctx.store.state.trustAnchor = next.anchor;
		ctx.store.state.checkpointChain = next.chain;
		chain = next.chain;
		ctx.log(`checkpoint: adopted ${cp.hash.slice(0, 12)}… (head ${cp.body.headSequence})`);
	}
	return true;
}

/**
 * 发布本设备的 checkpoint（每轮同步成功结束时调用）。
 *
 * 失败一律只记日志：发布不成功不影响同步的正确性，它影响的是**其他设备**
 * 将来能不能验证这一段历史。把它做成硬失败，等于让一个可选的加固特性
 * 有能力阻断同步。
 */
export async function publishCheckpoint(ctx: SyncContext): Promise<void> {
	const anchor = ctx.store.state.trustAnchor;
	const pkcs8 = ctx.signingKeyPkcs8?.();
	if (anchor === null || !pkcs8) return; // 未建立信任链或未生成签名密钥

	const b = ctx.store.state.bootstrap;
	const head = ctx.store.state.lastSequence;
	// 已经在这个位置发布过（或更新）了，不重复发
	if (head <= anchor.headSequence) return;

	try {
		const objects = localCheckpointObjects(ctx);
		const body = {
			version: 1 as const,
			vaultId: b.remoteVaultId ?? "",
			repoEpoch: b.repoEpoch ?? "",
			formatEpoch: b.formatEpoch ?? 1,
			keyEpoch: b.keyEpoch ?? 0,
			headSequence: head,
			objectsRoot: await objectsRoot(objects),
			objectCount: objects.length,
			previousCheckpointHash: anchor.checkpointHash,
			signingDeviceId: ctx.store.state.deviceId,
			timestamp: Date.now(),
		};
		const priv = await importSigningPrivateKey(pkcs8);
		const signed: SignedCheckpoint = await signCheckpoint(priv, body);
		await ctx.client.publishCheckpoint(signed);

		// 自己发布的自然也是自己确认的：把锚推到这里
		ctx.store.state.trustAnchor = {
			...anchor,
			checkpointHash: signed.hash,
			headSequence: head,
			updatedAt: Date.now(),
		};
		ctx.store.state.checkpointChain = [...ctx.store.state.checkpointChain, signed.hash].slice(-64);
		ctx.log(`checkpoint: published ${signed.hash.slice(0, 12)}… (head ${head}, ${objects.length} objects)`);
	} catch (e) {
		ctx.log(`checkpoint: publish failed (${e instanceof Error ? e.message : String(e)})`);
	}
}

/** 供诊断：本地此刻算出的根（与最近一次采纳的 checkpoint 对比）。 */
export async function localRootNow(ctx: SyncContext): Promise<{ root: string; count: number; hash: string }> {
	const objects = localCheckpointObjects(ctx);
	const root = await objectsRoot(objects);
	const b = ctx.store.state.bootstrap;
    const hash = await checkpointHash({
		version: 1,
		vaultId: b.remoteVaultId ?? "",
		repoEpoch: b.repoEpoch ?? "",
		formatEpoch: b.formatEpoch ?? 1,
		keyEpoch: b.keyEpoch ?? 0,
		headSequence: ctx.store.state.lastSequence,
		objectsRoot: root,
		objectCount: objects.length,
		previousCheckpointHash: ctx.store.state.trustAnchor?.checkpointHash ?? "",
		signingDeviceId: ctx.store.state.deviceId,
		timestamp: 0,
	});
	return { root, count: objects.length, hash };
}

/**
 * 首次接入时登记签名公钥，并在合适的时候建立创世信任锚（v0.15 / §9.2、§9.3）。
 *
 * 关于「谁有资格自建信任锚」：
 *
 *   - **第一台设备**可以。它面对的是一个空仓库，没有别人可问，
 *     它自己就是这条信任链的起点。
 *   - **后续设备**不可以。它们必须从配对包拿到锚（§9.3）——否则
 *     「相信服务器给的第一个 manifest」就成了整条链的地基，
 *     而那正是这套机制要消除的前提。
 *
 * 判据用 bootstrap 模式：`local-init` 意味着接入时远端是空的。
 */
export async function ensureSigningKeyRegistered(ctx: SyncContext, publicKeyB64: string): Promise<void> {
	if (!publicKeyB64) return;
	try {
		await ctx.client.registerSigningKey(publicKeyB64);
	} catch (e) {
		// 登记失败不阻断同步：它只影响「别的设备能不能验证我签的 checkpoint」
		ctx.log(`checkpoint: register signing key failed (${e instanceof Error ? e.message : String(e)})`);
		return;
	}

	if (ctx.store.state.trustAnchor !== null) return;
	if (ctx.store.state.bootstrap.mode !== "local-init") {
		ctx.log("checkpoint: 未建立信任链（本设备不是第一台设备，需要通过配对获得可信锚）");
		return;
	}
	ctx.store.state.trustAnchor = {
		repoEpoch: ctx.store.state.bootstrap.repoEpoch ?? "",
		checkpointHash: "",
		headSequence: 0,
		devicePublicKeys: { [ctx.store.state.deviceId]: publicKeyB64 },
		revokedDevices: [],
		updatedAt: Date.now(),
	};
	ctx.store.state.checkpointChain = [];
	ctx.log("checkpoint: 已建立创世信任锚（本设备是该仓库的第一台设备）");
}

/**
 * 从配对包携带的可信锚建立本地信任链（§9.3）。
 *
 * 配对包由已受信设备生成、经加密链接传递，服务器看不到也改不了里面的内容——
 * 因此这个锚是可信的。新设备据此拒绝任何早于它的仓库状态。
 */
export function adoptTrustAnchorFromPairing(
	ctx: SyncContext,
	anchor: { repoEpoch: string; checkpointHash: string; headSequence: number; devicePublicKeys: Record<string, string> },
	ownDeviceId: string,
	ownPublicKey: string,
): void {
	ctx.store.state.trustAnchor = {
		repoEpoch: anchor.repoEpoch,
		checkpointHash: anchor.checkpointHash,
		headSequence: anchor.headSequence,
		// 把自己也加进去：本设备随后发布的 checkpoint 要能被自己验证
		devicePublicKeys: { ...anchor.devicePublicKeys, ...(ownPublicKey ? { [ownDeviceId]: ownPublicKey } : {}) },
		revokedDevices: [],
		updatedAt: Date.now(),
	};
	ctx.store.state.checkpointChain = anchor.checkpointHash ? [anchor.checkpointHash] : [];
	ctx.log(`checkpoint: 已从配对包建立信任锚（head ${anchor.headSequence}）`);
}
