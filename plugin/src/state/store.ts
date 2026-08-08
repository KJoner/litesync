import { DataAdapter } from "obsidian";
import { VaultKeyDoc } from "../crypto/crypto";

/**
 * 每个已同步文件的本地状态缓存。
 * E2EE 启用后明文与密文 hash 不同（随机 IV），因此分开记录：
 * - hash：本地明文内容 hash（检测本地修改）
 * - serverHash：服务器上的内容 hash（未加密时与 hash 相同；对齐 changes feed）
 */
export interface FileState {
	hash: string;
	serverHash: string;
	revision: number;
	mtime: number;
	size: number;
}

/** 未解决冲突的登记信息（计划书 Phase 15：Pending Conflict）。 */
export interface PendingConflict {
	baseRevision: number;
	remoteRevision: number;
	createdAt: number;
}

/** 本设备创建过的分享（Share Key 只存本地，服务器与其他设备都拿不到）。 */
export interface ShareRecord {
	path: string;
	keyB64url: string;
	createdAt: number;
	expiresAt: number;
}

export interface PersistedState {
	deviceId: string;
	lastSequence: number;
	files: Record<string, FileState>;
	conflicts: Record<string, PendingConflict>;
	/** vault key 文档缓存（只含加密后的密钥材料，可安全落盘） */
	e2ee: VaultKeyDoc | null;
	shares: Record<string, ShareRecord>;
}

/**
 * 设备本地同步状态，保存在插件目录下的 state.json
 * （与 data.json 的设置分离，避免设置文件无限增大）。
 */
export class StateStore {
	state: PersistedState = {
		deviceId: "",
		lastSequence: 0,
		files: {},
		conflicts: {},
		e2ee: null,
		shares: {},
	};

	constructor(
		private adapter: DataAdapter,
		private path: string,
	) {}

	async load(): Promise<void> {
		try {
			if (await this.adapter.exists(this.path)) {
				const raw = JSON.parse(await this.adapter.read(this.path)) as Partial<PersistedState>;
				this.state = {
					deviceId: typeof raw.deviceId === "string" ? raw.deviceId : "",
					lastSequence: typeof raw.lastSequence === "number" ? raw.lastSequence : 0,
					files: raw.files && typeof raw.files === "object" ? raw.files : {},
					conflicts: raw.conflicts && typeof raw.conflicts === "object" ? raw.conflicts : {},
					e2ee: raw.e2ee && typeof raw.e2ee === "object" ? raw.e2ee : null,
					shares: raw.shares && typeof raw.shares === "object" ? raw.shares : {},
				};
				// v0.2 状态升级：当时全部为明文，serverHash 与 hash 相同
				for (const fs of Object.values(this.state.files)) {
					if (!fs.serverHash) fs.serverHash = fs.hash;
				}
			}
		} catch (e) {
			console.error("[private-sync] failed to load state.json, starting fresh", e);
			this.state = { deviceId: "", lastSequence: 0, files: {}, conflicts: {}, e2ee: null, shares: {} };
		}
		if (!this.state.deviceId) {
			this.state.deviceId = crypto.randomUUID();
			await this.save();
		}
	}

	async save(): Promise<void> {
		await this.adapter.write(this.path, JSON.stringify(this.state));
	}

	get(path: string): FileState | undefined {
		return this.state.files[path];
	}

	set(path: string, fs: FileState): void {
		this.state.files[path] = fs;
	}

	delete(path: string): void {
		delete this.state.files[path];
	}

	paths(): string[] {
		return Object.keys(this.state.files);
	}

	getConflict(path: string): PendingConflict | undefined {
		return this.state.conflicts[path];
	}

	setConflict(path: string, c: PendingConflict): void {
		this.state.conflicts[path] = c;
	}

	clearConflict(path: string): void {
		delete this.state.conflicts[path];
	}

	conflictPaths(): string[] {
		return Object.keys(this.state.conflicts);
	}
}
