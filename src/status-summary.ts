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

	lines.push({
		label: "仓库解锁",
		value:
			s.e2ee === "disabled"
				? "未启用端到端加密（服务器可读取内容）"
				: s.e2ee === "locked"
					? "已锁定 · 同步暂停，待同步的修改保留在本机"
					: "已解锁",
		tone: s.e2ee === "unlocked" ? "ok" : "warn",
	});

	lines.push({ label: "密钥保存", value: s.keyPolicyText, tone: s.migrationPending ? "warn" : "muted" });

	lines.push({
		label: "最近同步",
		value: s.lastSyncAt > 0 ? relativeTime(s.lastSyncAt, s.now) : "本次运行尚未同步",
		tone: "muted",
	});

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
