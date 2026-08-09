export type PendingAction = "upsert" | "delete";

/**
 * 待同步变更队列。按路径去重，后到的动作覆盖先到的。
 * 数据安全红线：不允许因为异常清空队列——条目只在对应操作成功后移除。
 */
export class PendingQueue {
	private map = new Map<string, PendingAction>();

	add(path: string, action: PendingAction): void {
		this.map.set(path, action);
	}

	remove(path: string): void {
		this.map.delete(path);
	}

	/** 返回当前快照（不清空）。 */
	entries(): Array<[string, PendingAction]> {
		return [...this.map.entries()];
	}

	get size(): number {
		return this.map.size;
	}
}
