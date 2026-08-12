/**
 * Bootstrap（v8 首次接入）：新设备在开始任何自动同步之前，
 * 必须先通过接入向导明确「本地与远端的关系」。
 */

export type BootstrapMode = "remote-wins" | "merge" | "local-init" | "legacy";

export interface BootstrapState {
	status: "pending" | "ready";
	/** 完成接入时服务器的 vaultId；同一 URL 上 vaultId 变化 = 服务器被重装/换库 */
	remoteVaultId?: string;
	/**
	 * 完成接入时服务器的 repoEpoch（v9）：服务器从备份恢复后会旋转 epoch，
	 * 客户端发现变化即停止增量同步进入恢复合并（本地新内容绝不丢）
	 */
	repoEpoch?: string;
	/** E2EE 密钥世代（v9.2）：LSE2/LSE3 信封的 AAD 绑定材料，随 /info 同步 */
	keyEpoch?: number;
	/** 元数据加密状态：plain / migrating / verifying / encrypted，随 /info 同步 */
	metaState?: string;
	/**
	 * 寻址格式世代（v0.13.0 / ADR-006）：元数据加密完成时服务器 +1。
	 * 与 repoEpoch（灾备恢复 → 恢复合并）语义不同：formatEpoch 变化意味着
	 * 「寻址方式变了」，客户端必须丢弃游标走 snapshot 全量对账。
	 */
	formatEpoch?: number;
	/** 仓库级信封下限（v0.13.0）：低于它的写入会被服务器拒绝，客户端也不再产出 */
	minimumEnvelopeVersion?: number;
	mode?: BootstrapMode;
	snapshotSequence?: number;
	completedAt?: number;
}

export const PENDING_BOOTSTRAP: BootstrapState = { status: "pending" };

/** 接入场景分类（纯函数，供向导选择界面与测试）。 */
export type BootstrapScenario =
	| "both-empty" // 本地空 + 远端空 → 直接初始化
	| "local-only" // 本地有 + 远端空 → 用本设备初始化远端
	| "remote-only" // 本地空 + 远端有 → 从远端恢复（无需询问）
	| "both"; // 双方都有 → 必须让用户选择

export function classifyBootstrap(localCount: number, remoteCount: number): BootstrapScenario {
	if (localCount === 0 && remoteCount === 0) return "both-empty";
	if (remoteCount === 0) return "local-only";
	if (localCount === 0) return "remote-only";
	return "both";
}
