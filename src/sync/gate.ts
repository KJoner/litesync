/**
 * 同步安全 Gate（v0.12.1 / LS-121-C07）。
 *
 * 在 v0.12.0 之前，「历史恢复 / 另存版本 / 手动上传 / 分享 / 迁移 /
 * 信封升级」各自零散地检查前置条件（有的只查 E2EE 是否解锁，有的什么都不查），
 * 于是出现了「状态损坏停机时仍然可以手动恢复历史并覆盖本地文件」这类洞。
 *
 * 本模块是这些入口**唯一**的许可来源：任何会读写远端或覆盖本地内容的手动
 * 命令都必须先过 {@link syncGateBlock}。SyncManager 自身的自动同步同样复用
 * 同一套判断，避免两条路径的规则漂移。
 */
import { E2eeLockedError } from "../crypto/keyring";
import { SyncContext } from "./context";

/** 阻断原因（机器可识别；UI 只负责展示 message）。 */
export type GateReason =
	| "state-corrupted"
	| "bootstrap-pending"
	| "unbound"
	| "protocol-mismatch"
	| "repo-epoch-mismatch"
	| "migration-active"
	| "key-locked"
	| "integrity-error";

export interface GateBlock {
	reason: GateReason;
	message: string;
}

/**
 * 会话级安全状态。
 *
 * 这些标志与 state.json 无关（它们描述的是「本次运行时对服务器的信任程度」），
 * 因此进程重启后必须重新走一遍权威校验才会被清除——这正是我们想要的默认值。
 */
export class SyncGate {
	/** 未绑定：server URL / Token / 设备身份 / vault key 文档变化后置位（LS-121-C02） */
	private unbound: string | null = "尚未完成与服务器的绑定校验";
	/** 协议不兼容（/info 判定） */
	private protocol: string | null = null;
	/** repoEpoch 与本地记录不符（灾备恢复） */
	private repoEpoch: string | null = null;
	/** 迁移进行中（元数据加密 / 信封升级 / E2EE 启用）：串行化并阻断其他写入 */
	private migration: string | null = null;
	/** 不可自动恢复的完整性错误（如服务器换掉了 fileId）：需要人工处理 */
	private integrity: string | null = null;

	get isUnbound(): boolean {
		return this.unbound !== null;
	}

	get isMigrationActive(): boolean {
		return this.migration !== null;
	}

	markUnbound(reason: string): void {
		this.unbound = reason;
	}

	/** 只能由完成了 /info + 凭据 + vaultId/repoEpoch 校验的重新绑定流程调用。 */
	markBound(): void {
		this.unbound = null;
	}

	markProtocolMismatch(message: string | null): void {
		this.protocol = message;
	}

	markRepoEpochMismatch(message: string | null): void {
		this.repoEpoch = message;
	}

	markIntegrityError(message: string): void {
		this.integrity = message;
	}

	clearIntegrityError(): void {
		this.integrity = null;
	}

	beginMigration(what: string): void {
		this.migration = what;
	}

	endMigration(): void {
		this.migration = null;
	}

	/** 仅返回会话级阻断项；仓库/密钥状态由 {@link syncGateBlock} 合并判断。 */
	sessionBlock(): GateBlock | null {
		if (this.integrity !== null) return { reason: "integrity-error", message: this.integrity };
		if (this.protocol !== null) return { reason: "protocol-mismatch", message: this.protocol };
		if (this.repoEpoch !== null) return { reason: "repo-epoch-mismatch", message: this.repoEpoch };
		if (this.unbound !== null) {
			return {
				reason: "unbound",
				message: `本设备尚未与当前服务器完成绑定校验（${this.unbound}）；请先执行一次「立即同步」完成校验`,
			};
		}
		if (this.migration !== null) {
			return { reason: "migration-active", message: `正在执行${this.migration}，请等待完成后再操作` };
		}
		return null;
	}
}

/**
 * 完整安全判断：会话状态 + 本地状态文件 + 接入状态 + 密钥状态。
 * 返回 null 表示允许执行。
 */
export function syncGateBlock(ctx: SyncContext): GateBlock | null {
	if (ctx.store.corrupted) {
		return {
			reason: "state-corrupted",
			message:
				"本地同步状态文件损坏（state-a/state-b.json 均无法读取），所有同步与手动操作已停止；" +
				"请从备份恢复状态文件或重新接入，绝不要在此状态下继续写入",
		};
	}
	if (!ctx.store.bootstrapReady) {
		return { reason: "bootstrap-pending", message: "本设备尚未完成接入向导，请先完成接入再执行该操作" };
	}
	const session = ctx.gate.sessionBlock();
	if (session !== null) return session;
	if (ctx.e2ee.needsUnlock) {
		return { reason: "key-locked", message: "端到端加密已锁定，请先解锁（Unlock E2EE）" };
	}
	return null;
}

/** Gate 拒绝：手动命令捕获后直接把 message 展示给用户。 */
export class SyncBlockedError extends Error {
	constructor(
		public reason: GateReason,
		message: string,
	) {
		super(message);
		this.name = "SyncBlockedError";
	}
}

/**
 * 手动命令的统一入口守卫：不满足条件直接抛 {@link SyncBlockedError}。
 * `action` 只用于日志与提示文案。
 */
export function requireSyncSafe(ctx: SyncContext, action: string): void {
	const block = syncGateBlock(ctx);
	if (block === null) return;
	ctx.log(`blocked ${action}: ${block.reason}`);
	if (block.reason === "key-locked") throw new E2eeLockedError();
	throw new SyncBlockedError(block.reason, `无法${action}：${block.message}`);
}
