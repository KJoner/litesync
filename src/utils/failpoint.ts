/**
 * 测试专用故障注入点（v0.14.0-RC / 计划书 §8.1）。
 *
 * 为什么需要它：客户端的每一次同步都要穿过「入队 → 落盘 → 上传 → 下载 →
 * staging → 安装 → 更新状态 → 推进游标」这一长串步骤，其中任何一步之后
 * 进程被杀（用户退出 Obsidian、系统回收内存、断电），系统都必须落在一个
 * 可恢复的状态上。这些窗口在真实使用中几乎不可能主动复现。
 *
 * # 生产构建的安全性
 *
 * 计划书要求「生产构建不得允许外部任意触发」。这里的做法是：
 *
 * - 注册表是模块级私有变量，只有同一个 bundle 内的代码能写；
 * - **没有任何** UI、设置项、命令面板或网络输入能激活 failpoint；
 * - `enable()` 只在 `tests/` 下被调用。
 *
 * 换句话说：这段代码会进生产包（只有几十字节），但生产运行时永远没有
 * 激活项，`evalFailpoint` 走的是一次 Map 查空的开销。
 *
 * 选择「运行时空表」而不是构建期剔除，是因为后者会让测试跑的是另一份代码——
 * 而我们要验证的恰恰是生产代码在崩溃点上的行为。
 */

/** 注入动作：抛错、或做点别的（比如篡改内容模拟部分写入）。 */
export type FailpointAction = () => void | Promise<void>;

interface Entry {
	action: FailpointAction | null;
	/** remaining < 0 表示一直触发；> 0 时每次触发递减 */
	remaining: number;
	hits: number;
}

const registry = new Map<string, Entry>();

/** 注入失败时抛出的默认错误。 */
export class InjectedFailure extends Error {
	constructor(name: string) {
		super(`failpoint: injected failure at ${name}`);
		this.name = "InjectedFailure";
	}
}

/**
 * 在某个注入点求值。生产运行时永远是一次 Map miss。
 *
 * 调用约定：放在**真实故障可能发生的那个位置**，并且不要吞掉它抛出的错误。
 */
export async function evalFailpoint(name: string): Promise<void> {
	const e = registry.get(name);
	if (e === undefined) return;
	e.hits++;
	if (e.remaining > 0) {
		e.remaining--;
		if (e.remaining === 0) registry.delete(name);
	}
	if (e.action === null) throw new InjectedFailure(name);
	await e.action();
}

/** 激活一个注入点；返回取消函数。times < 0 表示一直生效。 */
export function enableFailpoint(name: string, times = 1, action: FailpointAction | null = null): () => void {
	registry.set(name, { action, remaining: times, hits: 0 });
	return () => void registry.delete(name);
}

/** 某个注入点至今被求值命中的次数（断言「确实走到了那个点」用）。 */
export function failpointHits(name: string): number {
	return registry.get(name)?.hits ?? 0;
}

/** 清空所有注入（测试收尾）。 */
export function resetFailpoints(): void {
	registry.clear();
}

/** 当前激活的注入点数量。生产运行时必须恒为 0。 */
export function activeFailpoints(): number {
	return registry.size;
}

/** 计划书 §8.1 列出的客户端注入点。集中定义，避免各处拼字符串拼错。 */
export const FP = {
	/** pending op 已进内存、尚未落盘 */
	queueBeforeDurable: "queue.before-durable-add",
	/** pending op 已落盘 */
	queueAfterDurable: "queue.after-durable-add",
	/** StateStore 写完某个副本槽、尚未提升 generation */
	stateAfterSlotWrite: "state.after-slot-write",
	/** StateStore 即将切换活动槽 */
	stateBeforePointerSwitch: "state.before-pointer-switch",
	/** 远端内容已下载、尚未提交到本地 */
	pullAfterDownload: "pull.after-download",
	/** 旧内容已移入 recovery、新内容尚未安装 */
	commitAfterRecovery: "local-commit.after-recovery",
	/** staging 即将安装到目标路径 */
	commitBeforeInstall: "local-commit.before-install",
	/** 名字互换：第一步已完成、第二步尚未开始 */
	swapAfterFirstStep: "rename.after-first-step",
	/** 即将推进 lastSequence */
	cursorBeforeAck: "cursor.before-ack",
	/** bootstrap 即将标记完成 */
	bootstrapBeforeComplete: "bootstrap.before-complete",
	/** 迁移即将 complete */
	migrationBeforeComplete: "migration.before-complete",
} as const;
