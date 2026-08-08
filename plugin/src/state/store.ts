import { DataAdapter } from "obsidian";

/** 每个已同步文件的本地状态缓存。 */
export interface FileState {
	hash: string;
	revision: number;
	mtime: number;
	size: number;
}

export interface PersistedState {
	deviceId: string;
	lastSequence: number;
	files: Record<string, FileState>;
}

/**
 * 设备本地同步状态，保存在插件目录下的 state.json
 * （与 data.json 的设置分离，避免设置文件无限增大）。
 */
export class StateStore {
	state: PersistedState = { deviceId: "", lastSequence: 0, files: {} };

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
				};
			}
		} catch (e) {
			console.error("[private-sync] failed to load state.json, starting fresh", e);
			this.state = { deviceId: "", lastSequence: 0, files: {} };
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
}
