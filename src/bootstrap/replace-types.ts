/**
 * 「用本地完整替换远端」作业的数据模型（0.20 / ADR-016）。
 *
 * 作业持久化在 state.json（与 durable operation journal 同一套 A/B 双副本，ADR-005）：
 * 每完成一个条目就落盘一次，崩溃/断网后按条目续跑，绝不重复写、绝不「做了一半报完成」。
 */

/** 条目动作。restore 只出现在反向作业里：把被删除的远端文件按恢复点内容重建。 */
export type ReplaceAction = "create" | "update" | "delete" | "keep" | "restore";

export type ReplaceItemStatus = "pending" | "done" | "stale";

export interface ReplaceItem {
	/** 真实路径（meta 模式下服务器只见伪名，见 serverPath） */
	path: string;
	action: ReplaceAction;
	fileId?: string;
	/** 服务器可见寻址名（meta 模式为伪名 = fileId；明文模式为空，用 path） */
	serverPath?: string;
	/** 计划时远端的 revision（create 为 0）：执行时作为 CAS 前提 */
	expectedRevision: number;
	/** 计划时远端的内容 hash（E2EE 下为密文 hash） */
	remoteHash?: string;
	/** 计划时本地明文 hash（create/update/keep）：执行前本地又改了 → 预览已过期 */
	localHash?: string;
	/** keep 条目建立 tracked 状态所需的远端身份（计划时下载得到） */
	remoteGeneration?: number;
	remoteMetaGeneration?: number;
	/** 计划阶段固定的幂等键：断点续跑复用，服务端据此返回首次结果 */
	operationId: string;
	/** 恢复点文件名（相对作业恢复目录）：update/delete 条目执行前远端原始字节 */
	snapshotFile?: string;
	snapshotHash?: string;
	/** 内容来源：local = 本地文件；snapshot = 恢复点（反向作业） */
	source: "local" | "snapshot";
	status: ReplaceItemStatus;
	/** 执行成功后服务器给出的 revision（反向作业据此做 CAS） */
	resultRevision?: number;
	/** 条目级失败原因（只存短语，不存路径以外的内容） */
	error?: string;
}

export type ReplaceJobState =
	| "planned"
	| "confirmed"
	| "running"
	| "paused_stale"
	| "interrupted"
	| "completed"
	| "abandoned";

export interface ReplaceCounts {
	create: number;
	update: number;
	delete: number;
	keep: number;
	/** 远端被忽略规则排除的文件数：不在同步范围内，本作业一个都不动 */
	outOfScope: number;
}

export interface ReplaceJob {
	jobId: string;
	kind: "local-replace-remote" | "reverse";
	parentJobId?: string;
	/** 目标仓库（加密绑定身份）与选择器：执行时必须仍是同一个仓库 */
	vaultIdentity: string;
	vaultChoice: string;
	/** 确认时必须原样输入的仓库名 */
	vaultName: string;
	repoEpoch: string;
	/** 计划时的远端水位：执行结束后检查其后有没有不是本作业写入的变更 */
	plannedHeadSequence: number;
	createdAt: number;
	state: ReplaceJobState;
	/** 在接入向导里（bootstrap 仍 pending）生成：完成后以 local-replace 模式完成接入 */
	bootstrapContext: boolean;
	items: ReplaceItem[];
	counts: ReplaceCounts;
	/** 恢复点总字节数与是否已全部保存并校验 */
	snapshotBytes: number;
	snapshotComplete: boolean;
	/** 本作业写入产生的 sequence（水位检查时据此识别「自己的」变更） */
	ownSequences: number[];
	confirmedAt?: number;
	completedAt?: number;
	staleReason?: string;
}
