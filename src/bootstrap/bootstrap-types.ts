/**
 * Bootstrap（v8 首次接入）：新设备在开始任何自动同步之前，
 * 必须先通过接入向导明确「本地与远端的关系」。
 */

/**
 * 接入方式。local-init 只用于**空**远端；local-replace（0.20 / ADR-016）是
 * 「用本地完整替换非空远端」的高级恢复作业完成后的接入记录——两者刻意分开命名。
 */
export type BootstrapMode = "remote-wins" | "merge" | "local-init" | "local-replace" | "legacy";

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

/**
 * 选仓库步（v0.19）是否显示。只要服务器支持 vaults 端点且宿主接线了
 * setVaultChoice 就**始终显示**——哪怕名下只有一个仓库：「新建仓库」的唯一
 * 入口在这一步。最初按「≤1 个自动跳过」实现，结果名下只有一个仓库的用户
 * 想把第二个本地库接为新远端仓库时无路可走，向导径直对着默认仓库对账
 * （0.19.0 实测缺口）。跳过只剩两种情况：旧服务器（listVaults 404）、
 * 宿主没接线（防御）。
 */
export function vaultPickerVisible(listSucceeded: boolean, hasSetter: boolean): boolean {
	return listSucceeded && hasSetter;
}

/**
 * 连接链接已经指定、并在兑换前让用户核对过目标仓库时，接入向导跳过选库页（UI 焕新 U5b，P02：
 * 「目标仓库只核对一次」）。只在三者一致时跳过：链接里的仓库 = 设置里当前选的仓库（applyPairingConfig
 * 已写入同一个值）= 服务器报告的「当前」仓库。任何一项对不上就照常显示选库页。
 *
 * 跳过不调用 setVaultChoice（值本来就相同，调用也是空操作）：绑定指纹、切库锁定、PL-06 的 preflight
 * 核验都与显示选库页、按「继续」时完全一样。「新建仓库」仍可从向导里的「选择其他仓库…」或
 * 设置页「重新运行接入向导」进入——vaultPickerVisible 注释里那个缺口不会回来。
 */
export function linkedVaultToSkip<V extends { id: string; current?: boolean }>(
	vaults: V[],
	linkVaultId: string | undefined,
	vaultChoice: string | undefined,
): V | null {
	if (!linkVaultId || vaultChoice !== linkVaultId) return null;
	return vaults.find((v) => v.current === true && v.id === linkVaultId) ?? null;
}

/** 远端空仓库（0 个文件）的初始化方式，见 {@link emptyRemoteInit}。 */
export type EmptyRemoteInit = "set-password" | "join-encrypted" | "blocked";

/**
 * 远端空仓库（0 个文件）怎么初始化（预发布实测缺陷，2026-11-22）。
 *
 * - 远端还是明文（未初始化）→ `set-password`：设置仓库密码（enableE2eeOnEmptyRemote），首次上传即密文——
 *   0.19.x 起新仓库强制 E2EE，这条不变。
 * - 远端已经加密（网页「新建仓库 → 创建并加密」，或另一台设备先启用过），本设备已用这个仓库的密码解锁、
 *   服务器给出合法的 keyEpoch → `join-encrypted`：用现有密钥接入，**不再设新密码**；本地有文件时由接入后的
 *   普通同步以 LSE3 密文（服务器当前的 keyEpoch）上传。
 * - 其余（加密状态与密钥文档对不上：有文档但 keyEpoch 为 0、服务器说已加密却没有启用的密钥文档；或尚未解锁）
 *   → `blocked`：停下说明，不写任何东西。
 *
 * 以前已加密的空远端也只给「设置仓库密码」，必然撞上 enableE2eeOnEmptyRemote 的前置检查（远端必须未初始化）：
 * 用户解锁之后还被要求再设一个新密码，提交后报错，向导走不下去。
 */
export function emptyRemoteInit(s: {
	/** 服务器上有已启用的密钥文档（preflight 的 e2eeEnabled） */
	keyDocEnabled: boolean;
	/** /info 的 encryptionState（缺省按 plaintext） */
	encryptionState?: string;
	unlocked: boolean;
	keyEpoch?: number;
}): EmptyRemoteInit {
	const encrypted = s.keyDocEnabled || (s.encryptionState ?? "plaintext") !== "plaintext";
	if (!encrypted) return "set-password";
	return s.keyDocEnabled && s.unlocked && (s.keyEpoch ?? 0) > 0 ? "join-encrypted" : "blocked";
}
