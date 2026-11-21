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
	verifyCheckpoint,
} from "../crypto/checkpoint";
import { SyncContext } from "./context";
import { advanceAnchor, FreshnessFailure, TrustAnchor, verifyFreshness } from "./freshness";

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
export async function verifyCheckpointChain(ctx: SyncContext, serverHead?: number): Promise<boolean> {
	const anchor = ctx.store.state.trustAnchor;
	if (anchor === null) return true; // 未建立信任链：freshness 检查此时无从谈起

	// 0.20.1（复审 PL-06）：服务器当前的水位比本设备确认过的检查点还低——这本身就是回退证据，
	// 不需要服务器交出任何 checkpoint。以前空列表直接放行，回退到旧备份的服务器因此「验证通过」
	if (serverHead !== undefined && serverHead < anchor.headSequence) {
		const msg =
			`服务器当前的仓库水位（${serverHead}）低于本设备已确认的检查点（${anchor.headSequence}）：` +
			"服务器可能被回退到了旧状态，已停止自动同步";
		ctx.gate.markIntegrityError(msg);
		ctx.notify(msg);
		ctx.log(`checkpoint: rejected (head ${serverHead} < anchor ${anchor.headSequence})`);
		return false;
	}

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

// ---------- 配对继承的可信锚：首次接入之前核验（0.20.1 / 复审 PL-06） ----------

export type InheritedTrustFailure =
	| "vault-mismatch"
	| "epoch-mismatch"
	| "rollback"
	| "anchor-missing"
	| "unsupported-server"
	| FreshnessFailure;

export type InheritedTrustVerdict =
	/** 没有继承锚（首次信任 / 新仓库）：界面如实说明，不宣称已验证 */
	| { kind: "none" }
	/** 通过：接入完成时采纳 anchor + chain（已沿服务器给出的合法延伸前进到 verifiedHead） */
	| { kind: "verified"; anchor: TrustAnchor; chain: string[]; verifiedHead: number; extended: number; receivedAt: number }
	/** 被拒：任何本地落地或远端写入都不得发生；界面给出重新配对 / 显式改为首次信任两个选项 */
	| { kind: "rejected"; reason: InheritedTrustFailure; message: string };

function rejected(reason: InheritedTrustFailure, message: string): InheritedTrustVerdict {
	return { kind: "rejected", reason, message };
}

/**
 * 核验配对包继承的可信锚（PL-06）：在任何本地落地或远端写入**之前**调用（接入向导 preflight）。
 *
 * 配对包宣称「继承发行设备已验证的检查点（headSequence = H）」，就必须真的拿它当判据：
 *   1. 仓库身份：配对包核对过的 vaultIdentity 必须就是服务器现在这个仓库；
 *   2. repoEpoch：锚属于哪个世代——服务器灾备恢复过（epoch 变了），这个锚就描述不了眼前的仓库；
 *   3. 可信水位：服务器的快照与当前 head 都不得低于 H（低了 = 回退到了更旧的状态）；
 *   4. 可验证的后续历史：服务器必须还持有那份锚检查点（签名、身份、位置都对得上），之后给出的每一份
 *      checkpoint 都必须是它的合法延伸（签名有效、设备未撤销、链相连、没有同位置分叉、不回退）；
 *      服务器自己声称的 head 也不得低于它交出的最新已签名检查点。
 * 任何一条不成立都**停止**——不静默降为首次信任。能解密的旧密文不代表最新可信状态：
 * GCM 只证明「这是用这把钥匙加密过的某个版本」，证明不了「这是最新的那个版本」。
 */
export async function verifyInheritedTrust(
	ctx: SyncContext,
	server: { vaultId?: string; repoEpoch?: string; headSequence: number },
): Promise<InheritedTrustVerdict> {
	const pending = ctx.store.state.pendingPairingTrust;
	if (!pending) return { kind: "none" };
	const a = pending.anchor;
	if (!server.vaultId || pending.vaultIdentity !== server.vaultId) {
		return rejected(
			"vault-mismatch",
			"连接链接核对的是另一个仓库，而服务器现在指向的仓库与它不同（仓库被删除重建，或服务器被替换）。继承的检查点无法用于这个仓库。",
		);
	}
	if (!server.repoEpoch || a.repoEpoch !== server.repoEpoch) {
		return rejected(
			"epoch-mismatch",
			"发出连接链接之后，服务器的仓库世代（repoEpoch）变了——通常是从备份做了灾备恢复。继承的检查点描述的是恢复之前的历史，无法证明眼前的状态。",
		);
	}
	if (server.headSequence < a.headSequence) {
		return rejected(
			"rollback",
			`服务器现在给出的仓库状态（位置 ${server.headSequence}）比发行设备已经确认过的检查点（位置 ${a.headSequence}）更旧：` +
				"服务器可能被回退到了旧备份。已停止，本设备一个文件都没有写。",
		);
	}

	let bundle;
	try {
		// since 是开区间：要拿回锚检查点本身，从它前一位开始取
		bundle = await ctx.client.checkpoints(a.checkpointHash ? Math.max(0, a.headSequence - 1) : 0);
	} catch (e) {
		if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
			return rejected(
				"unsupported-server",
				"连接链接宣称继承了已验证的检查点，但这台服务器不提供签名检查点（版本过旧或被替换），无法核验。",
			);
		}
		throw e; // 网络错误：可以重试，不是判决
	}
	if (bundle.repoEpoch && bundle.repoEpoch !== server.repoEpoch) {
		return rejected("epoch-mismatch", "服务器交出的检查点属于另一个仓库世代，无法核验。");
	}
	if (bundle.conflicting.length > 1) {
		return rejected(
			"fork",
			`服务器上同一个位置存在 ${bundle.conflicting.length} 份互不相同的已签名状态：它可能对不同设备展示了不同的历史。`,
		);
	}

	let anchor: TrustAnchor = {
		repoEpoch: a.repoEpoch,
		checkpointHash: a.checkpointHash,
		headSequence: a.headSequence,
		devicePublicKeys: { ...a.devicePublicKeys },
		revokedDevices: [...new Set(bundle.revokedDevices)],
		updatedAt: Date.now(),
	};
	// 创世锚（发行时还没有任何已签名检查点）：第一份 checkpoint 的 previous 是空串
	let chain = [a.checkpointHash];
	let sawAnchor = a.checkpointHash === "";
	let extended = 0;
	for (const cp of bundle.checkpoints) {
		if (cp.hash === a.checkpointHash) {
			// 锚检查点本身：签名、仓库、世代、位置都必须与配对包一致（服务器不能拿别的东西冒名）
			const pub = anchor.devicePublicKeys[cp.body.signingDeviceId];
			const genuine =
				pub !== undefined &&
				!anchor.revokedDevices.includes(cp.body.signingDeviceId) &&
				(await verifyCheckpoint(pub, cp)) &&
				cp.body.vaultId === server.vaultId &&
				cp.body.repoEpoch === a.repoEpoch &&
				cp.body.headSequence === a.headSequence;
			if (!genuine) return rejected("bad-signature", "服务器给出的「发行设备已确认的检查点」与连接链接里的不一致。");
			sawAnchor = true;
			continue;
		}
		const verdict = await verifyFreshness(anchor, chain, cp, server.vaultId);
		if (!verdict.ok) return rejected(verdict.kind, verdict.message);
		if (verdict.kind === "same") continue;
		const next = advanceAnchor(anchor, chain, cp);
		anchor = next.anchor;
		chain = next.chain;
		extended++;
	}
	if (!sawAnchor) {
		return rejected(
			"anchor-missing",
			`服务器上找不到发行设备已经确认过的检查点（位置 ${a.headSequence}）：服务器的历史可能被回退或替换过。`,
		);
	}
	if (anchor.headSequence > server.headSequence) {
		return rejected(
			"rollback",
			`服务器声称的仓库位置（${server.headSequence}）低于它自己保存的已签名检查点（${anchor.headSequence}）：状态被回退了。`,
		);
	}
	return { kind: "verified", anchor, chain, verifiedHead: anchor.headSequence, extended, receivedAt: pending.receivedAt };
}

/** 采纳核验通过的继承锚（接入完成时调用；把本设备自己的签名公钥加进信任集合）。 */
export function adoptVerifiedInheritedTrust(
	ctx: SyncContext,
	verdict: Extract<InheritedTrustVerdict, { kind: "verified" }>,
	ownDeviceId: string,
	ownPublicKey: string,
): void {
	ctx.store.state.trustAnchor = {
		...verdict.anchor,
		devicePublicKeys: { ...verdict.anchor.devicePublicKeys, ...(ownPublicKey ? { [ownDeviceId]: ownPublicKey } : {}) },
		updatedAt: Date.now(),
	};
	ctx.store.state.checkpointChain = [...verdict.chain].slice(-64);
	ctx.log(`checkpoint: 已采纳核验通过的配对继承锚（head ${verdict.verifiedHead}，沿服务器历史前进 ${verdict.extended} 步）`);
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
	// 创世锚（还没有任何已签名检查点）记作 [""]：第一份 checkpoint 的 previous 是空串，要能接上
	ctx.store.state.checkpointChain = [anchor.checkpointHash];
	ctx.log(`checkpoint: 已从配对包建立信任锚（head ${anchor.headSequence}）`);
}
