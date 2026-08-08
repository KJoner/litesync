import { App } from "obsidian";
import { ApiClient } from "../api/client";
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
}

export interface SyncCounters {
	pulled: number;
	pushed: number;
	conflicts: number;
}
