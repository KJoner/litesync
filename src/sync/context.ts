import { App } from "obsidian";
import { ApiClient } from "../api/client";
import { Keyring } from "../crypto/keyring";
import { StateStore } from "../state/store";
import { SyncGate } from "./gate";
import { LocalCommitter } from "./local-commit";
import { PendingQueue } from "./queue";

/** 同步流程共享的依赖集合，由 main.ts 组装。 */
export interface SyncContext {
	app: App;
	client: ApiClient;
	store: StateStore;
	queue: PendingQueue;
	/**
	 * 统一本地提交器（v0.13.2 / §6.1）：**唯一**允许覆盖 Vault 中已有文件的入口。
	 * 任何同步路径都不得绕开它直接 writeBinary 到用户文件。
	 */
	committer: LocalCommitter;
	/** 是否需要同步 .obsidian 配置目录 */
	syncObsidian(): boolean;
	ignores(path: string): boolean;
	deviceName(): string;
	/** 插件自己的目录（staging / recovery / swap 都放这里，永不参与同步） */
	pluginDir(): string;
	/**
	 * 本设备 checkpoint 签名私钥（base64 PKCS#8；v0.15 / §9.2）。
	 *
	 * 与 VMK 分离保存：签名私钥泄露只能伪造 checkpoint，读不了任何内容；
	 * VMK 泄露能读内容，但伪造不了 checkpoint。放在一起就没有这层分隔了。
	 * 未生成时返回空串——此时本设备不发布 checkpoint，但仍会校验别人的。
	 */
	signingKeyPkcs8?: () => string;
	/** 本设备待登记的签名公钥（base64 SPKI）；登记成功后由 main 侧清空 */
	signingPublicKey?: () => string;
	/** 登记成功回调（main 侧据此不再重复登记） */
	onSigningKeyRegistered?: () => void;
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
