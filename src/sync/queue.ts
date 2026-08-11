export type PendingActionType = "upsert" | "delete" | "move";

/** 结构化队列操作（v9.3）：move 携带旧路径；upsert/delete 与从前语义一致。 */
export interface PendingOp {
	action: PendingActionType;
	/** move 专用：改名前的旧路径 */
	from?: string;
}

interface QueueEntry {
	op: PendingOp;
	/** 单调递增的变更代号：上传期间同路径再次入队会拿到新 generation */
	gen: number;
}

/**
 * 待同步变更队列。按路径去重，后到的动作覆盖先到的。
 * 数据安全红线：不允许因为异常清空队列——条目只在对应操作成功后移除。
 *
 * v9 lost wake-up 修复：每个条目带 generation，处理完成后只有在
 * generation 未变时才移除——上传进行中用户又编辑了同一文件时，
 * 新入队的条目绝不会被旧上传的完成回调误删。
 * 队列同时镜像到 store.state.pendingOps（onChange 挂钩），重启不丢。
 *
 * v9.3：move 条目（key = 新路径，from = 旧路径）。被 upsert 覆盖时
 * 旧路径由扫描的 tracked-but-missing 兜底补 delete，安全退化为 delete+upsert。
 */
export class PendingQueue {
	private map = new Map<string, QueueEntry>();
	private genCounter = 0;

	/** 持久化挂钩（main.ts 接到 store.state.pendingOps）。 */
	onChange: ((entries: Record<string, PendingOp>) => void) | null = null;

	private fireChange(): void {
		if (this.onChange) this.onChange(this.toRecord());
	}

	add(path: string, action: "upsert" | "delete"): void {
		this.map.set(path, { op: { action }, gen: ++this.genCounter });
		this.fireChange();
	}

	/** 入队原子改名（v9.3）：key 为新路径。 */
	addMove(toPath: string, fromPath: string): void {
		this.map.set(toPath, { op: { action: "move", from: fromPath }, gen: ++this.genCounter });
		this.fireChange();
	}

	/** 查看某路径当前排队的操作（不存在返回 undefined）。 */
	getOp(path: string): PendingOp | undefined {
		return this.map.get(path)?.op;
	}

	/**
	 * 移除条目。传入 gen 时只有 generation 未变才移除（处理完成路径必须用这个形式）；
	 * 不传 gen 为无条件移除（仅用于「该路径已不再需要同步」的语义，如忽略规则命中）。
	 */
	remove(path: string, gen?: number): void {
		if (gen !== undefined && this.map.get(path)?.gen !== gen) return;
		this.map.delete(path);
		this.fireChange();
	}

	/** 返回当前快照（含 generation，不清空）。 */
	entries(): Array<[string, PendingOp, number]> {
		return [...this.map.entries()].map(([p, e]) => [p, e.op, e.gen]);
	}

	toRecord(): Record<string, PendingOp> {
		const out: Record<string, PendingOp> = {};
		for (const [p, e] of this.map.entries()) out[p] = e.op;
		return out;
	}

	/** 从持久化镜像恢复（插件启动时）；兼容 v9.2 之前的字符串形式。 */
	restore(entries: Record<string, PendingOp | "upsert" | "delete">): void {
		for (const [path, raw] of Object.entries(entries)) {
			if (this.map.has(path)) continue;
			const op: PendingOp = typeof raw === "string" ? { action: raw } : raw;
			if (op.action !== "upsert" && op.action !== "delete" && op.action !== "move") continue;
			this.map.set(path, { op, gen: ++this.genCounter });
		}
		this.fireChange();
	}

	get size(): number {
		return this.map.size;
	}
}
