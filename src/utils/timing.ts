/**
 * 时间混淆（v0.17 / 计划书 §11.2）。
 *
 * # 请求节奏就是编辑节奏
 *
 * 当前默认是「改完 3 秒后上传」。对服务器来说，这几乎是一份实时的打字记录：
 * 每次保存对应一个请求，请求的时间戳序列直接画出你什么时候在写、写多久、
 * 什么时候停下来。内容加密了，这条侧信道没有。
 *
 * 由此能推断的东西比直觉上多：作息、时区、工作日与假期、
 * 「这个人此刻醒着」、多设备之间谁在用哪一台。
 *
 * # 做什么
 *
 * 1. **对齐到网格再加抖动**：上传发生在 `floor(now/W)*W + jitter`，
 *    观察者只能知道这次编辑落在哪个窗口里，不知道在窗口里的哪个位置。
 * 2. **量化 mtime**：文件修改时间是**永久存储**的精确时间戳，
 *    比请求时间更糟——请求日志会轮转，数据库不会。
 *
 * # 做不到什么（必须说清楚）
 *
 * 这套办法降低的是**分辨率**，不是可观测性本身。它并不隐藏
 * 「你在这个窗口里到底有没有编辑」——那需要持续发送掩护流量，
 * 而掩护流量会让存储与流量成倍增长，换来的保护又远不如用户以为的那么强
 *（一旦停机、离线或电量耗尽，掩护就断了，反而暴露）。所以本项目不做掩护流量，
 * 也不暗示自己做了。
 *
 * # 代价
 *
 * 开启后同步会被延迟最多一个窗口。这不是「稍微慢一点」：
 * 跨设备可见延迟变长，两台设备同时编辑同一文件时冲突窗口也随之变长。
 * 因此默认关闭，且「立即同步」命令永远绕开延迟——用户显式要求的动作
 * 不该被隐私设置拖住。
 */

/** 默认批处理窗口（秒）：5 分钟。 */
export const DEFAULT_BATCH_SECONDS = 300;

/** 默认 mtime 量化粒度（秒）：1 小时。 */
export const DEFAULT_MTIME_GRANULARITY_SECONDS = 3600;

/** 窗口下限：小于这个值起不到混淆作用，只是白白延迟。 */
export const MIN_BATCH_SECONDS = 30;

/**
 * 把 mtime 向下取整到粒度边界。
 *
 * 向下而不是就近取整：就近取整会让一半的时间戳落到**未来**，
 * 而「修改时间在未来」会让各种排序、增量判断和用户界面表现得莫名其妙。
 *
 * granularitySec <= 0 表示不量化，原样返回。
 */
export function quantizeMtime(mtimeMs: number, granularitySec: number): number {
	if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return mtimeMs;
	if (granularitySec <= 0) return mtimeMs;
	const g = granularitySec * 1000;
	return Math.floor(mtimeMs / g) * g;
}

/**
 * 距离下一个「网格 + 抖动」发车点还有多少毫秒。
 *
 * 关键是抖动要落在**下一个**窗口内部，而不是「从现在起等一个随机时间」。
 * 后者的期望发车时刻仍然随编辑时刻线性移动——观察者取几次平均就能把
 * 编辑时刻还原出来，混淆等于没做。
 *
 * @param nowMs 当前时刻
 * @param windowSec 窗口长度（秒）
 * @param random 返回 [0,1) 的随机数（测试注入用）
 */
export function nextFlushDelay(nowMs: number, windowSec: number, random: () => number = Math.random): number {
	const w = Math.max(MIN_BATCH_SECONDS, windowSec) * 1000;
	// 下一个窗口的起点
	const nextBoundary = (Math.floor(nowMs / w) + 1) * w;
	// 在该窗口内均匀取一点作为发车时刻
	const fire = nextBoundary + Math.floor(random() * w);
	return fire - nowMs;
}

/**
 * 描述开启时间混淆后的实际效果，供设置页原样展示。
 *
 * 之所以让代码生成这句话而不是在 UI 里手写：数字改了而说明没改，
 * 是隐私功能里最常见也最有害的一种失真。
 */
export function timingDisclosure(windowSec: number, mtimeGranularitySec: number): string {
	const w = Math.max(MIN_BATCH_SECONDS, windowSec);
	const mins = Math.round((w / 60) * 10) / 10;
	const hrs = Math.round((mtimeGranularitySec / 3600) * 10) / 10;
	return (
		`上传将被推迟平均约 ${mins} 分钟（最多约 ${mins * 2} 分钟），` +
		`服务器只能判断编辑发生在哪个 ${mins} 分钟窗口里；` +
		`文件修改时间按 ${hrs} 小时取整后再上报。` +
		`代价：跨设备可见延迟与冲突窗口都会变长。` +
		`本功能不隐藏「你在某个窗口里有没有编辑」——那需要持续的掩护流量，本插件不做。`
	);
}
