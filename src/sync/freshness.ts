/**
 * Freshness 验证：签名 checkpoint 的信任锚与分叉检测（v0.15.0 / 计划书 §9.3、§9.4）。
 *
 * 这一层要回答的是「服务器给我看的，是不是完整、最新、且和别的设备看到的同一套
 * 仓库状态」。它无法阻止服务器**拒绝服务**（那种情况用户看得见），但能阻止
 * 服务器在装作正常的同时悄悄回退、调包或者对不同设备说不同的话。
 *
 * 核心是三条不变量：
 *
 *   1. **信任锚只能前进**：本地记着「我确认过的最新 checkpoint」，
 *      任何比它更旧的仓库状态一律拒绝——哪怕签名完全有效。
 *   2. **链必须相连**：新 checkpoint 的 previousCheckpointHash 必须能接回
 *      我们已知的链，否则那是另一条历史。
 *   3. **同一位置只能有一份**：同一个 headSequence 上出现两个不同的
 *      checkpoint hash = 服务器对不同设备说了不同的话，立刻停机。
 *
 * 第 1 条是本地状态文件被恢复到旧备份时的最后一道防线：即使本地状态回退了，
 * 只要信任锚还在（它随状态一起回退了……），第 2 条与第 3 条仍然成立。
 * 因此 §9.5 明确要求「状态文件恢复到旧备份后仍能检测服务端回退」——
 * 靠的是链的连续性，而不是本地的绝对位置。
 */

import { SignedCheckpoint, verifyCheckpoint } from "../crypto/checkpoint";

/**
 * 本地信任锚（随状态持久化）。
 *
 * 它是**由用户的其他设备**或配对流程建立起来的，绝不能由服务器单方面写入——
 * 那样服务器只要在新设备接入时给一个自己伪造的锚，整套机制就形同虚设（§9.3）。
 */
export interface TrustAnchor {
	/** 信任建立在哪个 sequence 世代上——repoEpoch 变了必须重建信任链 */
	repoEpoch: string;
	/** 已确认的最新 checkpoint hash */
	checkpointHash: string;
	/** 该 checkpoint 的 headSequence（信任锚只能前进） */
	headSequence: number;
	/** 已知的设备签名公钥：deviceId → base64 SPKI */
	devicePublicKeys: Record<string, string>;
	/** 已被撤销的设备：撤销之后它签的新 checkpoint 一律无效（§9.2） */
	revokedDevices: string[];
	updatedAt: number;
}

export type FreshnessVerdict =
	/** 可以采纳：它是我们已知链的合法延伸（或就是我们已知的那一个） */
	| { ok: true; kind: "extends" | "same"; checkpoint: SignedCheckpoint }
	/** 拒绝，且这是一次完整性事件——必须停机等人工确认 */
	| { ok: false; kind: FreshnessFailure; message: string };

export type FreshnessFailure =
	| "bad-signature"
	| "unknown-signer"
	| "revoked-signer"
	| "wrong-vault"
	| "epoch-mismatch"
	| "rollback"
	| "fork"
	| "broken-chain";

/**
 * 校验服务器给出的 checkpoint 是否可以采纳。
 *
 * `knownChain` 是本地记着的 checkpoint hash 序列（从旧到新，含信任锚）。
 * 它不需要很长——保留最近若干个就够判断「新的这个是不是接在我们见过的东西后面」。
 */
export async function verifyFreshness(
	anchor: TrustAnchor,
	knownChain: string[],
	cp: SignedCheckpoint,
	vaultId: string,
): Promise<FreshnessVerdict> {
	// 1) 签名与 hash：先确认这份东西确实是某台设备签的，且没被改过一个字节
	const publicKey = anchor.devicePublicKeys[cp.body.signingDeviceId];
	if (publicKey === undefined) {
		return {
			ok: false,
			kind: "unknown-signer",
			message: `checkpoint 由未知设备 ${cp.body.signingDeviceId.slice(0, 8)}… 签名；请先通过配对把该设备加入信任集合`,
		};
	}
	if (anchor.revokedDevices.includes(cp.body.signingDeviceId)) {
		// §9.2：设备撤销之后不得再发布新 checkpoint。
		// 这条必须在签名验证**之前或同时**判断——被撤销设备的私钥仍然是有效私钥，
		// 光验签名是过得去的
		return {
			ok: false,
			kind: "revoked-signer",
			message: `checkpoint 由已撤销的设备 ${cp.body.signingDeviceId.slice(0, 8)}… 签名，已拒绝`,
		};
	}
	if (!(await verifyCheckpoint(publicKey, cp))) {
		return { ok: false, kind: "bad-signature", message: "checkpoint 签名校验失败，已停止同步" };
	}

	// 2) 仓库身份：签名有效不代表它属于**这个**仓库
	if (cp.body.vaultId !== vaultId) {
		return { ok: false, kind: "wrong-vault", message: "checkpoint 属于另一个仓库，已拒绝" };
	}
	if (cp.body.repoEpoch !== anchor.repoEpoch) {
		// 灾备恢复后 repoEpoch 会旋转，此时旧信任链整体作废，需要重建（§9.5 最后一条）
		return {
			ok: false,
			kind: "epoch-mismatch",
			message: "checkpoint 的 repoEpoch 与本地信任锚不符；灾备恢复后需要重新建立信任链",
		};
	}

	// 3) 就是我们已知的那一个：幂等
	if (cp.hash === anchor.checkpointHash) {
		return { ok: true, kind: "same", checkpoint: cp };
	}

	// 4) 回退：签名有效、链也许自洽，但它描述的是比我们确认过的更旧的状态
	if (cp.body.headSequence < anchor.headSequence) {
		return {
			ok: false,
			kind: "rollback",
			message:
				`服务器返回的仓库状态比本设备已确认的更旧` +
				`（head ${cp.body.headSequence} < 已确认 ${anchor.headSequence}），已停止同步`,
		};
	}

	// 5) 同一位置两份不同的 checkpoint = equivocation（§9.4）
	if (cp.body.headSequence === anchor.headSequence) {
		return {
			ok: false,
			kind: "fork",
			message:
				`同一个 head sequence（${cp.body.headSequence}）上出现了两份不同的仓库状态；` +
				`服务器可能对不同设备展示了不同的历史，已停止同步`,
		};
	}

	// 6) 链接：新的必须接在我们见过的某个 checkpoint 后面
	if (!knownChain.includes(cp.body.previousCheckpointHash)) {
		return {
			ok: false,
			kind: "broken-chain",
			message:
				"checkpoint 无法接回本设备已知的历史；这通常意味着服务器上存在另一条并行的历史，已停止同步",
		};
	}

	return { ok: true, kind: "extends", checkpoint: cp };
}

/**
 * 采纳一个已通过校验的 checkpoint，把信任锚往前推。
 *
 * 只在 `verifyFreshness` 返回 `extends` 时调用。返回新的锚与新的链
 *（链有界保留，超出部分丢弃——判断「接不接得上」只需要最近若干个）。
 */
export function advanceAnchor(
	anchor: TrustAnchor,
	knownChain: string[],
	cp: SignedCheckpoint,
	limit = 64,
): { anchor: TrustAnchor; chain: string[] } {
	const chain = [...knownChain, cp.hash];
	return {
		anchor: { ...anchor, checkpointHash: cp.hash, headSequence: cp.body.headSequence, updatedAt: Date.now() },
		chain: chain.slice(-limit),
	};
}

/**
 * 与另一台设备交换 checkpoint hash 之后的分叉判定（§9.4）。
 *
 * 两台设备各自把自己确认过的链发给对方，如果两条链有共同前驱且其中一条是
 * 另一条的前缀，那只是「一台设备比另一台新」；如果在某个位置之后分道扬镳，
 * 那就是服务器对两台设备说了不同的话。
 *
 * 返回分叉点（最后一个共同 hash），null 表示两条链完全无关——
 * 那比分叉更严重，说明它们根本不是同一个仓库的历史。
 */
export function detectFork(mine: string[], theirs: string[]): { forked: boolean; commonAncestor: string | null } {
	let common: string | null = null;
	const n = Math.min(mine.length, theirs.length);
	let i = 0;
	for (; i < n; i++) {
		if (mine[i] !== theirs[i]) break;
		common = mine[i];
	}
	// 走完较短的一条且全程一致 = 一条是另一条的前缀 = 只是进度不同
	const forked = i < n;
	return { forked, commonAncestor: common };
}
