/**
 * 设置页首屏状态卡（v0.20 / UI 规格 D06、需求 §10.5）。
 *
 * 只做判定，不碰 DOM：给定当前状态，算出要显示的几行与**唯一**的主按钮。
 * 「设备已授权」与「仓库已解锁」分两行显示——前者是访问密文的凭据，后者是解密
 * 能力，合成一个模糊的「已连接」会让用户以为凭据就是密钥（需求 §5.2）。
 */

export type PrimaryActionKind = "connect" | "reconnect" | "finish-setup" | "unlock" | "sync-now";
export type SecondaryActionKind = "migrate" | "conflicts";
export type Tone = "ok" | "warn" | "error" | "muted";

export interface StatusInput {
	configured: boolean;
	bootstrapReady: boolean;
	/** 服务器拒绝了本设备凭据（被撤销 / Token 已重置） */
	credentialRejected: boolean;
	e2ee: "disabled" | "locked" | "unlocked";
	/** 当前仓库展示名；null = 尚未查询到 */
	vaultName: string | null;
	/** 本次运行最近一次成功同步的时刻（ms）；0 = 尚未同步 */
	lastSyncAt: number;
	conflicts: number;
	migrationPending: boolean;
	keyPolicyText: string;
	syncing: boolean;
	now: number;
	/**
	 * 可自动恢复的同步暂停说明（例如 503 IDENTITY_UNAVAILABLE：账号中心暂时无法确认登录状态）。
	 * 只是告知——不改主按钮、不进「重新连接」；null / 未提供 = 没有
	 */
	retryNotice?: string | null;
	/**
	 * 最近一轮同步没有完成的原因（引擎报 offline 时附带的说明；凭据被拒与账号中心暂不可用另有专门的行）。
	 * null / 未提供 = 没有（UI 焕新 U5b，P04）
	 */
	syncIssue?: string | null;
	/** 自动同步开关（false = 只在手动「立即同步」时同步）；未提供按开启处理 */
	autoSync?: boolean;
	/** 本设备有未完成、需要处理的「用本地完整替换远端」作业 */
	recoveryPending?: boolean;
}

export interface StatusLine {
	label: string;
	value: string;
	tone: Tone;
}

export interface StatusSummary {
	lines: StatusLine[];
	primary: { kind: PrimaryActionKind; label: string };
	secondary: Array<{ kind: SecondaryActionKind; label: string }>;
}

/** 同步引擎报给状态栏的状态（与 sync-manager 的 SyncStatus 相同）。 */
export type BarStatus = "idle" | "syncing" | "synced" | "conflict" | "offline" | "locked";

export interface StatusBarInput {
	status: BarStatus;
	/** 未解决冲突数（有冲突时优先显示计数） */
	conflicts: number;
	/** 服务器拒绝了本设备凭据（被撤销 / Token 已重置） */
	credentialRejected: boolean;
	/** 浏览器报告的联网状态（navigator.onLine；false 才算确定离线） */
	online: boolean;
	/** 同步引擎附带的说明（暂停原因等）；没有就用默认说法 */
	detail?: string;
}

/**
 * 状态栏文字（UI 焕新 U5b，与设置页状态卡同一套词：已同步 / 冲突 / 已锁定 / 需要重新连接）。
 *
 * 引擎的 offline 不只表示断网：凭据被拒、协议不符、仓库状态异常、账号中心暂时不可用都走它。
 * 状态栏只在确定离线时写「离线」，凭据被拒写「需要重新连接」，其余写「同步暂停」——原因在悬停提示里，
 * 不用一个笼统的「离线」误导用户去查网络。只换说法，不改引擎的状态与重试。
 */
export function statusBarLabel(s: StatusBarInput): { text: string; tip: string } {
	const tip = (fallback: string): string => `LiteSync：${s.detail ?? fallback}`;
	if (s.conflicts > 0 && s.status !== "syncing" && s.status !== "locked") {
		return { text: `! ${s.conflicts} 个冲突`, tip: `LiteSync：${s.conflicts} 个冲突待处理，点击查看` };
	}
	switch (s.status) {
		case "syncing":
			return { text: "↻ 同步中", tip: tip("正在同步") };
		case "synced":
			return { text: "✓ 已同步", tip: tip("已同步") };
		case "conflict":
			return { text: "! 有冲突", tip: tip("有冲突待处理") };
		case "locked":
			return { text: "🔒 已锁定", tip: "LiteSync：仓库已锁定，同步暂停；本机笔记仍可阅读和编辑。点击解锁" };
		case "offline":
			if (s.credentialRejected) return { text: "× 需要重新连接", tip: tip("本设备的授权已失效，请重新连接") };
			if (!s.online) return { text: "× 离线", tip: tip("没有网络连接，恢复后自动重试") };
			return { text: "× 同步暂停", tip: tip("同步暂停") };
		default:
			return { text: "LiteSync", tip: s.detail ? tip("") : "LiteSync" };
	}
}

/** 「x 分钟前」式的相对时间（只用于展示）。 */
export function relativeTime(at: number, now: number): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return "刚刚";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} 分钟前`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} 小时前`;
	return new Date(at).toLocaleString();
}

/** 主按钮只有一个：按「最先挡住同步的那件事」决定。 */
export function primaryAction(s: StatusInput): { kind: PrimaryActionKind; label: string } {
	if (!s.configured) return { kind: "connect", label: "连接仓库" };
	if (s.credentialRejected) return { kind: "reconnect", label: "重新连接" };
	if (!s.bootstrapReady) return { kind: "finish-setup", label: "完成接入" };
	if (s.e2ee === "locked") return { kind: "unlock", label: "解锁仓库" };
	return { kind: "sync-now", label: s.syncing ? "同步中…" : "立即同步" };
}

export function summarizeStatus(s: StatusInput): StatusSummary {
	const lines: StatusLine[] = [];

	lines.push({
		label: "仓库",
		value: !s.configured
			? "尚未连接"
			: !s.bootstrapReady
				? "服务器已配置，等待完成接入"
				: s.vaultName === null
					? "已连接"
					: `已连接「${s.vaultName || "默认仓库"}」`,
		tone: !s.configured ? "muted" : s.bootstrapReady ? "ok" : "warn",
	});

	lines.push({
		label: "设备授权",
		value: !s.configured ? "未授权" : s.credentialRejected ? "已失效（凭据被撤销或已更换），请重新连接" : "已授权",
		tone: !s.configured ? "muted" : s.credentialRejected ? "error" : "ok",
	});

	// 刚连接、还没完成接入时本设备还没取到这个仓库的密钥文档：看不出它加没加密，如实说「接入时确认」。
	// 以前这里显示「未启用端到端加密（服务器可读取内容）」——对一个加密仓库是错的，也会吓到人（iPhone 真机验收）
	const e2eeUnknown = !s.bootstrapReady && s.e2ee === "disabled";
	lines.push({
		label: "仓库解锁",
		value: e2eeUnknown
			? s.configured
				? "完成接入时确认（加密仓库需要输入仓库密码）"
				: "连接仓库后显示"
			: s.e2ee === "disabled"
				? "未启用端到端加密（服务器可读取内容）"
				: s.e2ee === "locked"
					? "已锁定 · 同步暂停，待同步的修改保留在本机"
					: "已解锁",
		tone: e2eeUnknown ? "muted" : s.e2ee === "unlocked" ? "ok" : "warn",
	});

	lines.push({ label: "密钥保存", value: s.keyPolicyText, tone: s.migrationPending ? "warn" : "muted" });

	const lastOk = s.lastSyncAt > 0 ? `（上次成功：${relativeTime(s.lastSyncAt, s.now)}）` : "";
	lines.push({
		label: "最近同步",
		value: s.retryNotice
			? s.retryNotice + lastOk
			: s.syncIssue
				? `未完成：${s.syncIssue}${lastOk}`
				: s.lastSyncAt > 0
					? relativeTime(s.lastSyncAt, s.now)
					: "本次运行尚未同步",
		tone: s.retryNotice || s.syncIssue ? "warn" : "muted",
	});
	// 自动同步关了要说出来：否则「最近同步：2 小时前」看起来像是坏了
	if (s.autoSync === false) {
		lines.push({ label: "自动同步", value: "已关闭，只在手动「立即同步」时同步", tone: "muted" });
	}
	if (s.recoveryPending) {
		lines.push({
			label: "待恢复",
			value: "有一个未完成的「用本地完整替换远端」作业：在「高级与诊断 › 高级恢复」里继续、放弃或回滚",
			tone: "warn",
		});
	}

	lines.push({
		label: "冲突",
		value: s.conflicts > 0 ? `${s.conflicts} 个待处理` : "无",
		tone: s.conflicts > 0 ? "warn" : "muted",
	});

	const secondary: StatusSummary["secondary"] = [];
	if (s.migrationPending) secondary.push({ kind: "migrate", label: "完成密钥迁移" });
	if (s.conflicts > 0) secondary.push({ kind: "conflicts", label: "处理冲突" });

	return { lines, primary: primaryAction(s), secondary };
}
