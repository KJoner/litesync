/**
 * 待推送操作队列 + 持久化操作日志（v0.13.2 / 计划书 §6.3）。
 *
 * v0.12.x 的队列只在内存里，靠 `onChange` 把快照镜像到 `state.pendingOps`，
 * 真正落盘要等某次 `store.save()`。于是有一个真实的丢失窗口：
 *
 *   文件事件入队 → 用户立刻退出 Obsidian → 状态还没存过 → 这次修改从未被推送
 *
 * 现在改成「**先落盘、再视为已接受**」：`add()` 返回一个 Promise，
 * 只有它 resolve 之后这条操作才算进了队列。
 *
 * 每条操作还带上足够的信息，让「响应丢失后重试」保持同一身份（§6.3）：
 * 同一个 operationId、同一个 fileId、同一个预期 base——绝不在每次重试时
 * 重新生成身份（那会在服务器上造出重复对象或永久 422）。
 */

export type PendingActionType = "upsert" | "delete" | "move";

/** 操作在日志中的生命周期（计划书 §6.3）。 */
export type PendingStatus =
	| "queued"
	| "uploading"
	| "remote_committed"
	| "local_committed"
	| "acked"
	| "blocked"
	| "conflict"
	| "failed";

export interface PendingOp {
	action: PendingActionType;
	/** move 专用：改名前的旧路径 */
	from?: string;
	/**
	 * 幂等键：网络响应丢失后用同一个 id 重试，服务器返回首次结果而不是产生
	 * 第二个 revision。**绝不**在重试时重新生成。
	 */
	operationId?: string;
	/** 该操作针对的对象身份（新文件在入队时就预生成并持久化，§6.5） */
	fileId?: string;
	/** meta 模式下的服务器寻址名 */
	serverPseudonym?: string;
	/** 入队时刻的预期服务器状态（重试时原样使用，不重新读取） */
	expectedRevision?: number;
	expectedMetaGeneration?: number;
	expectedContentGeneration?: number;
	/** 入队时刻的本地内容 hash（用于判断「排队期间用户又改了」） */
	localHash?: string;
	status?: PendingStatus;
	attemptCount?: number;
	createdAt?: number;
	/** 失败原因（只存错误码/短语，不存路径） */
	lastError?: string;
}

interface QueueEntry {
	op: PendingOp;
	/** 单调递增的变更代号：上传期间同路径再次入队会拿到新 generation */
	gen: number;
}

/** 生成幂等键。 */
export function newOperationId(): string {
	const raw = new Uint8Array(12);
	crypto.getRandomValues(raw);
	let out = "";
	for (const b of raw) out += b.toString(16).padStart(2, "0");
	return out;
}

/**
 * 待同步变更队列。按路径去重，后到的动作覆盖先到的。
 *
 * 数据安全红线：不允许因为异常清空队列——条目只在对应操作成功后移除。
 *
 * v9 lost wake-up 修复：每个条目带 generation，处理完成后只有在
 * generation 未变时才移除——上传进行中用户又编辑了同一文件时，
 * 新入队的条目绝不会被旧上传的完成回调误删。
 *
 * v9.3：move 条目（key = 新路径，from = 旧路径）。被 upsert 覆盖时
 * 旧路径由扫描的 tracked-but-missing 兜底补 delete，安全退化为 delete+upsert。
 *
 * v0.13.2：持久化提前到入队时刻（§6.3）。
 */
export class PendingQueue {
	private map = new Map<string, QueueEntry>();
	private genCounter = 0;

	/** 持久化挂钩（main.ts 接到 store.state.pendingOps）。 */
	onChange: ((entries: Record<string, PendingOp>) => void) | null = null;

	/**
	 * 落盘挂钩（v0.13.2 / §6.3）：由 main.ts 接到 `store.save()`。
	 * `add`/`addMove` 会等待它完成——只有落盘成功，这条操作才算被接受。
	 */
	persist: (() => Promise<void>) | null = null;

	private fireChange(): void {
		if (this.onChange) this.onChange(this.toRecord());
	}

	/**
	 * 入队并**等待落盘**。
	 *
	 * 调用方 await 它之后，这条操作即使立刻断电也不会丢失。
	 * 落盘失败时抛错并把条目回滚出队——绝不留下「内存里有、盘上没有」的假象，
	 * 那会让用户以为改动已被接受。
	 */
	async add(path: string, action: "upsert" | "delete", extra: Partial<PendingOp> = {}): Promise<void> {
		this.stage(path, { action, ...extra });
		await this.flush(path);
	}

	/** 入队原子改名（key 为新路径）并等待落盘。 */
	async addMove(toPath: string, fromPath: string, extra: Partial<PendingOp> = {}): Promise<void> {
		this.stage(toPath, { action: "move", from: fromPath, ...extra });
		await this.flush(toPath);
	}

	/**
	 * 只入内存不等落盘（扫描等批量场景；调用方负责随后统一 `persist()`）。
	 * 用于「本来就要在同一轮同步里立刻处理」的路径——它们不经过退出窗口。
	 */
	stage(path: string, op: PendingOp): void {
		const prev = this.map.get(path)?.op;
		// 幂等键只在「同一个逻辑操作」上复用（§6.3）：动作或改名来源变了就是另一个
		// 操作，必须换新 id，否则服务器会把新操作当成旧操作的重试而返回缓存结果。
		const sameOp = prev !== undefined && prev.action === op.action && prev.from === op.from;
		this.map.set(path, {
			op: {
				operationId: (sameOp ? prev.operationId : undefined) ?? newOperationId(),
				createdAt: prev?.createdAt ?? Date.now(),
				attemptCount: sameOp ? (prev.attemptCount ?? 0) : 0,
				status: "queued",
				// 对象身份与动作无关：同一路径仍指向同一个远端对象，必须保留
				...(prev?.fileId !== undefined ? { fileId: prev.fileId } : {}),
				...(prev?.serverPseudonym !== undefined ? { serverPseudonym: prev.serverPseudonym } : {}),
				...op,
			},
			gen: ++this.genCounter,
		});
		this.fireChange();
	}

	private async flush(path: string): Promise<void> {
		if (!this.persist) return;
		try {
			await this.persist();
		} catch (e) {
			// 落盘失败 → 这条操作不能被当作「已接受」。回滚出队，
			// 让下一轮扫描重新发现该文件（扫描是幂等的兜底路径）
			this.map.delete(path);
			this.fireChange();
			throw e;
		}
	}

	/** 记录一次尝试（重试计数与状态进入日志，便于诊断卡住的操作）。 */
	markAttempt(path: string, status: PendingStatus, lastError?: string): void {
		const entry = this.map.get(path);
		if (!entry) return;
		entry.op.status = status;
		entry.op.attemptCount = (entry.op.attemptCount ?? 0) + 1;
		if (lastError !== undefined) entry.op.lastError = lastError;
		this.fireChange();
	}

	/** 补记该操作的身份信息（首次上传拿到 fileId 后调用，重试即可复用）。 */
	rememberIdentity(path: string, identity: Pick<PendingOp, "fileId" | "serverPseudonym">): void {
		const entry = this.map.get(path);
		if (!entry) return;
		if (identity.fileId !== undefined) entry.op.fileId = identity.fileId;
		if (identity.serverPseudonym !== undefined) entry.op.serverPseudonym = identity.serverPseudonym;
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
			// 重启后沿用原来的 operationId 与 fileId：这正是「响应丢失后重试
			// 不产生第二个对象」所依赖的东西
			this.map.set(path, { op: { operationId: newOperationId(), ...op }, gen: ++this.genCounter });
		}
		this.fireChange();
	}

	get size(): number {
		return this.map.size;
	}
}
