/**
 * Bootstrap（v8 首次接入）：新设备在开始任何自动同步之前，
 * 必须先通过接入向导明确「本地与远端的关系」。
 */

export type BootstrapMode = "remote-wins" | "merge" | "local-init" | "legacy";

export interface BootstrapState {
	/**
	 * pending 时同步入口被 Gate 拦截。
	 *
	 * v0.13.1（计划书 §5.1）起，下面的绑定字段在 **status 仍是 pending 时**
	 * 就会由 preflight 填好：bootstrap 期间的 LSE3/LSM1 加解密、伪名解析、
	 * Merge 上传都要用它们。绝不因为「正式状态还没写入」就回退到 LSE1、
	 * 真实路径或无 fileId 上传。只有全部步骤成功后才原子转为 ready。
	 */
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

/** preflight 从服务器取回的权威仓库状态（计划书 §5.1 的必返字段）。 */
export interface RepoBinding {
	remoteVaultId?: string;
	repoEpoch?: string;
	keyEpoch?: number;
	metaState?: string;
	formatEpoch?: number;
	minimumEnvelopeVersion?: number;
}

/**
 * 灾备恢复记录（计划书 §5.6）：repoEpoch 变化时写入。
 *
 * repoEpoch 变了意味着服务器从备份恢复过——**绝不能**用恢复后的快照直接覆盖本地：
 * 备份点之后本设备产生的内容只存在于本地。这条记录让向导知道自己处在恢复流程里，
 * 并把「恢复前的本地文件清单」留档，便于事后核对没有内容被悄悄丢掉。
 */
export interface RecoveryState {
	reason: "repo-epoch-changed";
	previousEpoch: string;
	serverEpoch: string;
	/** 进入恢复流程时的本地游标（= 备份点之后本设备已知的最后一个 sequence） */
	localSequence: number;
	/** 进入恢复流程时同步范围内的本地文件数 */
	localFileCount: number;
	at: number;
}

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
