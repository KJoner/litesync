import { App } from "obsidian";
import { ApiClient } from "../api/client";
import { Keyring } from "../crypto/keyring";
import { StateStore } from "../state/store";
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
	/** E2EE 密钥环（文档 + 内存中的已解锁 VMK） */
	e2ee: Keyring;
	/** 从服务器刷新 vault key 状态（每次同步开始时调用） */
	refreshE2ee(): Promise<void>;
}

export interface SyncCounters {
	pulled: number;
	pushed: number;
	conflicts: number;
}
