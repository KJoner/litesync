import { App } from "obsidian";
import { ApiClient } from "../api/client";
import { Keyring } from "../crypto/keyring";
import { StateStore } from "../state/store";
import { SyncGate } from "./gate";
import { PendingQueue } from "./queue";

/** 同步流程共享的依赖集合，由 main.ts 组装。 */
export interface SyncContext {
	app: App;
	client: ApiClient;
	store: StateStore;
	queue: PendingQueue;
	/** 是否需要同步 .obsidian 配置目录 */
	syncObsidian(): boolean;
	ignores(path: string): boolean;
	deviceName(): string;
	log(msg: string): void;
	notify(msg: string): void;
	/** pending conflicts 集合变化后调用（刷新状态栏等） */
	onConflictsChanged(): void;
	/**
	 * 同步安全 Gate（v0.12.1）：所有手动命令与自动同步共用的许可判断。
	 * 会话级的 unbound / protocol / repoEpoch / migration / integrity 标志都在这里。
	 */
	gate: SyncGate;
	/** E2EE 密钥环（文档 + 内存中的已解锁 VMK） */
	e2ee: Keyring;
	/**
	 * 当前生效的服务器地址与凭据（v0.12.1 / LS-121-C02）：
	 * 用于计算绑定指纹——任一变化都必须重新走权威校验后才允许写入。
	 */
	credentials(): { serverUrl: string; apiToken: string };
	/** 从服务器刷新 vault key 状态（每次同步开始时调用） */
	refreshE2ee(): Promise<void>;
	/** 更换 API 凭据（v9.2 根 Token → 设备凭据自动换发；写入 SecretStorage） */
	updateApiToken?: (token: string) => Promise<void>;
}

export interface SyncCounters {
	pulled: number;
	pushed: number;
	conflicts: number;
}
