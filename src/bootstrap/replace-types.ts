/**
 * 「用本地完整替换远端」作业的数据模型（0.20 / ADR-016）。
 *
 * 作业持久化在 state.json（与 durable operation journal 同一套 A/B 双副本，ADR-005）：
 * 每完成一个条目就落盘一次，崩溃/断网后按条目续跑，绝不重复写、绝不「做了一半报完成」。
 */

/** 条目动作。restore 只出现在反向作业里：把被删除的远端文件按恢复点内容重建。 */
export type ReplaceAction = "create" | "update" | "delete" | "keep" | "restore";

export type ReplaceItemStatus = "pending" | "done" | "stale";

/**
 * 墓碑上重建的 restore→upload 子状态机（0.20.1 / 复审 PL-05）。
 *
 * 显式恢复与随后的内容上传是两次请求。只在内存里记「恢复过了」的话，恢复请求提交成功、
 * 响应却丢了，同一作业重试时会从原始 expectedRevision 重新上传、撞上已恢复为 live 的对象，
 * 被判成「远端被别人改了」而永远停住。所以每一步都先落盘：
 *
 *   requested ──（服务器结果落盘）──▶ restored ──（最终上传结果落盘）──▶ 条目 done
 *
 * requested：意图（稳定 operationId、墓碑 revision、恢复用的内容世代）已持久化，请求可能已发出、
 * 结果未知——续跑时**原样重发**，服务端按 operationId 返回首次结果；restored：服务器给出的
 * revision / sequence 已持久化，续跑直接在它之上用同一个上传 operationId 上传。
 */
export interface RestoreStep {
	/** 恢复请求的幂等键（计划阶段的 operationId + "-r"，重试不变） */
	operationId: string;
	/** 被恢复对象的身份（墓碑的 fileId；本地新建撞上同名墓碑时取代计划里预留的 fileId） */
	fileId: string;
	/** 防复活锚点：墓碑的删除 revision */
	expectedTombstoneRevision: number;
	/** 恢复写入的内容世代：请求前固定，重试不变 */
	contentGeneration: number;
	/** meta 模式：LSM1 信封里的元数据世代（= 墓碑的值 + 1，与服务器恢复后的值一致） */
	metaGeneration: number;
	/** 删除前最后一版的内容 hash（服务器恢复出的 HEAD 应当就是它；幂等记录被裁剪时据此核对） */
	priorHash?: string;
	phase: "requested" | "restored";
	/** 服务器给出的恢复结果（restored 之后才有） */
	revision?: number;
	sequence?: number;
	serverMetaGeneration?: number;
}

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
	/**
	 * 计划时的远端世代：keep/update 为经认证的内容世代（下载解密得到或本地已确认）；
	 * delete 为快照报告的值（只作恢复时的下限参考）。remoteMetaGeneration 同理
	 */
	remoteGeneration?: number;
	remoteMetaGeneration?: number;
	/** 恢复点里那份密文经 AAD 认证后的内容世代（保存恢复点时解密校验得到；反向重建的世代下限） */
	snapshotGeneration?: number;
	/** 墓碑上重建的子状态机（见 RestoreStep） */
	restore?: RestoreStep;
	/**
	 * 反向作业：这个重建条目要恢复的墓碑由同一反向作业里的另一个删除条目产生（那个条目的 operationId）。
	 * 出现在「仅大小写不同的改名」：原作业删掉 Note.md、又在 note.md 上恢复了同一个对象；回滚时先删 note.md，
	 * 再以那次删除的结果 revision 作为防复活锚点，在 Note.md 上重建。
	 */
	tombstoneOf?: string;
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
	/** 执行成功后这份内容的世代 / 元数据世代（反向作业覆盖时的世代下限与记账依据） */
	resultGeneration?: number;
	resultMetaGeneration?: number;
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
	/**
	 * 最近一次被执行许可挡下的原因（0.20.1 / PL-03；诊断用，不改变作业状态）：
	 * 状态损坏、完整性、协议、凭据、epoch、连接或密钥会话变化等。
	 */
	lastBlock?: { reason: string; message: string; at: number };
}
