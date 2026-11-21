/**
 * 指定仓库配对 v2 的编排逻辑（0.20 / ADR-014，《A-接口与状态约定》§5）。
 *
 * 只含判定与顺序，不碰 DOM、不直接发请求：网络经 {@link PairingTransport} 注入，
 * 秘密暂存经 {@link SecretStore} 注入，因此「GET 不消费」「确认之前不兑换」
 * 「响应丢失用同一个 exchangeId 重试」「仓库对不上绝不写配置」都能在测试里逐条钉住。
 *
 * 导入顺序（新服务器）：
 *   深链/粘贴 → 取 envelope（不消费）→ 本地解密 → 校验（来源一致、能力已知）
 *   → **展示服务器/账号/仓库供核对** → 用户确认 → redeem（exchangeId 先落盘）
 *   → 核对返回的仓库与包内一致 → 写配置 → 解锁 → 首次同步方式与预览
 * 旧服务器（没有 v2 端点）：明示「无法在导入前核对仓库」，确认服务器后走旧的 consume + enroll。
 */
import type { PairingEnvelopeResult, RedeemRequest, RedeemResult } from "../api/client";
import type { SecretStore } from "../crypto/device-trust";
import type { TrustAnchor } from "../sync/freshness";
import { decryptPairingConfig, b64urlDecode, PairingConfig, PairingTrust, isLoopbackHost } from "./pairing";

/** 服务端能力位：/api/v1/info.capabilities 含它时，发行端走 v2。 */
export const SERVER_PAIRING_V2 = "pairing-v2-redeem";

/** 本插件认识的配对包能力；requiredCapabilities 里出现别的 → 拒绝导入并提示升级。 */
export const KNOWN_PAIRING_CAPABILITIES: readonly string[] = ["vault-bound-pairing", "redeem-v2"];

/** 新发行的配对包声明需要的能力。 */
export const ISSUED_CAPABILITIES: readonly string[] = ["vault-bound-pairing", "redeem-v2"];

/** 兑换暂存记录在 SecretStorage 中的键（含一次性注册凭据——属于设备访问凭据，不是解密密钥）。 */
export const PENDING_REDEEM_SECRET_ID = "litesync-pending-redeem";

/** 服务端保留兑换结果的窗口（契约 §5.3：10 分钟）；超过即不再尝试续传。 */
export const REDEEM_REPLAY_WINDOW_MS = 10 * 60 * 1000;

export interface PairingLink {
	serverUrl: string;
	id: string;
	secretB64url: string;
}

/** 网络 I/O（main 侧接 requestUrl；测试用替身）。 */
export interface PairingTransport {
	fetchEnvelope(serverUrl: string, pairId: string): Promise<PairingEnvelopeResult>;
	redeem(serverUrl: string, req: RedeemRequest): Promise<RedeemResult>;
	/** 旧服务器：取走并删除配对密文（失效返回 null） */
	consumeLegacy(serverUrl: string, pairId: string): Promise<string | null>;
	/** 旧服务器：一次性注册凭据换设备凭据 */
	enrollLegacy(serverUrl: string, secret: string, name: string): Promise<{ deviceId: string; deviceToken: string }>;
}

/** 打开链接（未兑换）之后的结果。 */
export type OpenLinkResult =
	/** v2：已解密并校验，等待用户核对确认 */
	| { kind: "ready"; link: PairingLink; config: PairingConfig; expiresAt: number }
	/** 旧服务器：没法在不消费的情况下看到内容，只能先确认服务器 */
	| { kind: "legacy-server"; link: PairingLink }
	| { kind: "gone"; code: string }
	| { kind: "invalid"; reason: string };

function originOf(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) return null;
		return u.origin;
	} catch {
		return null;
	}
}

/** 配对包里出现、但本插件不认识的必需能力。 */
export function unknownCapabilities(config: PairingConfig): string[] {
	return (config.requiredCapabilities ?? []).filter((c) => !KNOWN_PAIRING_CAPABILITIES.includes(c));
}

/**
 * 校验解密后的配对包能否导入。
 *
 * - 包里声明的服务器必须与链接所在服务器同源：配对包经链接 #fragment 里的密钥认证，
 *   服务器改不了它，但一个指向 A 服务器的链接里装着 B 服务器的配置，只可能是拼错或钓鱼；
 * - 不认识的必需能力 → 拒绝（**不得**退回默认仓库或旧的根 Token 包）；
 * - v2 包必须带一次性注册凭据，v1 包（长期 Token）只做受限兼容导入（调用方另行警告）。
 */
export function validateConfig(config: PairingConfig, link: PairingLink): { ok: true } | { ok: false; reason: string } {
	const declared = originOf(config.serverUrl);
	const actual = originOf(link.serverUrl);
	if (declared === null) return { ok: false, reason: "配置包中的服务器地址无效或不是 https://" };
	if (actual === null || declared !== actual) {
		return { ok: false, reason: `链接所在服务器（${link.serverUrl}）与配置包声明的服务器（${config.serverUrl}）不一致，已拒绝导入` };
	}
	const unknown = unknownCapabilities(config);
	if (unknown.length > 0) {
		return { ok: false, reason: `这个连接链接需要更新版本的 LiteSync 插件（未知能力：${unknown.join("、")}）。请先升级插件。` };
	}
	if (config.v === 2 && !config.enrollmentSecret) return { ok: false, reason: "配置包缺少一次性注册凭据" };
	if (config.v === 1 && !config.apiToken) return { ok: false, reason: "配置包缺少凭据字段" };
	if (config.selectedVault && (typeof config.selectedVault.vaultId !== "string" || !config.selectedVault.vaultId)) {
		return { ok: false, reason: "配置包中的目标仓库信息不完整" };
	}
	return { ok: true };
}

/** 信任锚是否完整可用（verified_transfer 要求全部字段）。 */
export function completeAnchor(t: PairingTrust | undefined): t is Required<Pick<PairingTrust, "mode" | "repoEpoch" | "checkpointHash" | "headSequence" | "devicePublicKeys">> & PairingTrust {
	return (
		t !== undefined &&
		t.mode === "verified_transfer" &&
		typeof t.repoEpoch === "string" &&
		t.repoEpoch !== "" &&
		typeof t.checkpointHash === "string" &&
		typeof t.headSequence === "number" &&
		t.headSequence >= 0 &&
		typeof t.devicePublicKeys === "object" &&
		t.devicePublicKeys !== null &&
		Object.keys(t.devicePublicKeys).length > 0
	);
}

/**
 * 给用户看的信任方式说明（不把「首次信任」包装成「已验证」）。
 *
 * 0.20.1（复审 PL-06）：只承诺实现做得到的事——接入**之前**核对服务器状态不早于继承的检查点、
 * 检查点链能接上；核对不通过就停止。发行时还没有任何已签名检查点（创世锚）的，不宣称能察觉回退。
 */
export function describeTrust(config: PairingConfig): string {
	const t = config.trust;
	if (completeAnchor(t)) {
		if (!t.checkpointHash) {
			return "继承发行设备的签名设备名单（发行时还没有已签名的检查点）：之后发布的检查点会逐一核对，但无法证明服务器没有回退到发行之前的状态";
		}
		return (
			`继承发行设备已验证的检查点（位置 ${t.headSequence}）：接入之前会核对服务器给出的仓库状态不早于它、检查点链能接上；` +
			"核对不通过会停止接入并提示重新配对"
		);
	}
	if (t?.mode === "new_vault_genesis") return "新仓库：本设备将从这个仓库的第一个状态开始建立信任";
	return "首次信任：本设备没有继承任何已验证的检查点，将信任服务器当前提供的仓库状态";
}

/** 打开配对链接：只读 envelope，**不消费**。 */
export async function openPairingLink(t: PairingTransport, link: PairingLink): Promise<OpenLinkResult> {
	const env = await t.fetchEnvelope(link.serverUrl, link.id);
	if (env.kind === "unsupported") return { kind: "legacy-server", link };
	if (env.kind === "gone") return { kind: "gone", code: env.code };
	const config = await decryptWithLink(link, env.ciphertext);
	if (config === null) return { kind: "invalid", reason: "连接链接解密失败（链接不完整，或数据被篡改）" };
	const v = validateConfig(config, link);
	if (!v.ok) return { kind: "invalid", reason: v.reason };
	return { kind: "ready", link, config, expiresAt: env.expiresAt };
}

async function decryptWithLink(link: PairingLink, ciphertext: string): Promise<PairingConfig | null> {
	let secret: Uint8Array;
	try {
		secret = b64urlDecode(link.secretB64url);
	} catch {
		return null;
	}
	try {
		return await decryptPairingConfig(secret, ciphertext);
	} finally {
		secret.fill(0);
	}
}

/** 旧服务器路径：消费 → 解密 → 校验（调用方此前已让用户确认服务器）。 */
export async function openLegacyLink(
	t: PairingTransport,
	link: PairingLink,
): Promise<{ kind: "ready"; config: PairingConfig } | { kind: "gone" } | { kind: "invalid"; reason: string }> {
	const ciphertext = await t.consumeLegacy(link.serverUrl, link.id);
	if (ciphertext === null) return { kind: "gone" };
	const config = await decryptWithLink(link, ciphertext);
	if (config === null) return { kind: "invalid", reason: "配对包解密失败（密钥不符或数据被篡改）" };
	const v = validateConfig(config, link);
	if (!v.ok) return { kind: "invalid", reason: v.reason };
	return { kind: "ready", config };
}

/** 兑换暂存记录：redeem 前落盘，成功或明确失败后清除。 */
export interface PendingRedeem {
	serverUrl: string;
	pairId: string;
	exchangeId: string;
	startedAt: number;
	deviceName: string;
	config: PairingConfig;
}

export function loadPendingRedeem(secrets: SecretStore): PendingRedeem | null {
	const raw = secrets.getSecret(PENDING_REDEEM_SECRET_ID);
	if (!raw) return null;
	try {
		const p = JSON.parse(raw) as PendingRedeem;
		if (typeof p.exchangeId !== "string" || typeof p.serverUrl !== "string" || !p.config) return null;
		return p;
	} catch {
		return null;
	}
}

export function clearPendingRedeem(secrets: SecretStore): void {
	secrets.setSecret(PENDING_REDEEM_SECRET_ID, "");
}

/** 16 字节随机 hex（客户端生成的兑换编号）。 */
export function newExchangeId(): string {
	const raw = new Uint8Array(16);
	crypto.getRandomValues(raw);
	let out = "";
	for (const b of raw) out += b.toString(16).padStart(2, "0");
	return out;
}

export type RedeemOutcome =
	| {
			kind: "ok";
			credential: string;
			deviceId: string;
			vaultId: string;
			vaultIdentity?: string;
			config: PairingConfig;
	  }
	/** 网络中断：暂存记录保留，可用同一个 exchangeId 重试（含重启后） */
	| { kind: "retry"; message: string }
	/** 明确失败：暂存记录已清除；message 给用户 */
	| { kind: "failed"; code: string; message: string };

/** 服务端拒绝码 → 用户能看懂的下一步。 */
export function redeemErrorText(code: string): string {
	switch (code) {
		case "PAIRING_EXPIRED":
			return "连接链接已过期。请在网页或原设备上重新生成。";
		case "PAIRING_USED":
			return "这个连接链接已经被使用过了（每个链接只能连接一台设备）。请重新生成。";
		case "PAIRING_REVOKED":
			return "这个连接链接已被发行者撤销。请重新生成。";
		case "VAULT_MISMATCH":
			return "连接链接与目标仓库不一致，已停止（链接没有被消耗）。请重新生成。";
		case "ACCOUNT_DISABLED":
			return "该账号已被停用，无法连接新设备。";
		case "CLIENT_UPGRADE_REQUIRED":
			return "服务器要求更新版本的 LiteSync 插件。";
		case "MISMATCH_RESPONSE":
			return "服务器返回的仓库与连接链接里的不一致，已拒绝使用这份凭据（没有写入任何配置）。";
		case "MALFORMED_RESPONSE":
			return "服务器的响应格式不正确，已停止。";
		default:
			return "连接链接无效或已失效。请重新生成。";
	}
}

/**
 * 兑换（v2）：exchangeId 在发请求**之前**落盘，响应丢失后同一个 exchangeId 重试，
 * 服务端返回同一份结果（同一 deviceId），不会多建设备，也不会卡在「已消费却没拿到凭据」。
 *
 * 返回的仓库必须与配对包里核对过的一致——不一致说明服务器把 grant 绑到了别处，
 * 这份凭据一个字节都不用。
 */
export async function redeemPairing(
	t: PairingTransport,
	secrets: SecretStore,
	input: { link: PairingLink; config: PairingConfig; deviceName: string; platform: string; clientVersion: string; now: number },
): Promise<RedeemOutcome> {
	const { link, config } = input;
	const secret = config.enrollmentSecret;
	const expectedVaultId = config.selectedVault?.vaultId ?? "";
	if (!secret) return { kind: "failed", code: "INVALID", message: "配置包缺少一次性注册凭据" };

	const prior = loadPendingRedeem(secrets);
	const resumable = prior !== null && prior.pairId === link.id && prior.serverUrl === link.serverUrl;
	const pending: PendingRedeem = resumable
		? prior
		: {
				serverUrl: link.serverUrl,
				pairId: link.id,
				exchangeId: newExchangeId(),
				startedAt: input.now,
				deviceName: input.deviceName,
				config,
			};
	if (!resumable) secrets.setSecret(PENDING_REDEEM_SECRET_ID, JSON.stringify(pending));

	const r = await t.redeem(link.serverUrl, {
		enrollmentSecret: secret,
		exchangeId: pending.exchangeId,
		expectedVaultId,
		device: { name: pending.deviceName, platform: input.platform, clientVersion: input.clientVersion },
	});
	if (r.kind === "network") return { kind: "retry", message: r.message };
	if (r.kind === "rejected") {
		clearPendingRedeem(secrets);
		return { kind: "failed", code: r.code, message: redeemErrorText(r.code) };
	}
	const sel = config.selectedVault;
	if (sel && (r.vaultId !== sel.vaultId || (sel.vaultIdentity && r.vaultIdentity && r.vaultIdentity !== sel.vaultIdentity))) {
		clearPendingRedeem(secrets);
		return { kind: "failed", code: "MISMATCH_RESPONSE", message: redeemErrorText("MISMATCH_RESPONSE") };
	}
	return {
		kind: "ok",
		credential: r.deviceCredential,
		deviceId: r.deviceId,
		vaultId: r.vaultId,
		vaultIdentity: r.vaultIdentity,
		config,
	};
}

/** 发行端：组装 v2 配对包（0.20）。信任锚只在本机持有**已验证**的锚时才携带。 */
export function buildIssuedConfig(input: {
	serverUrl: string;
	enrollmentSecret: string;
	vault: { vaultId: string; vaultIdentity?: string; displayName: string };
	accountLabel: string;
	protocolVersion: number;
	sync: { syncIntervalSeconds: number; syncObsidian: boolean; ignorePatterns: string };
	anchor: TrustAnchor | null;
	currentRepoEpoch: string | undefined;
}): PairingConfig {
	const a = input.anchor;
	const verified =
		a !== null &&
		!!input.currentRepoEpoch &&
		a.repoEpoch === input.currentRepoEpoch &&
		Object.keys(a.devicePublicKeys).length > 0;
	return {
		v: 2,
		serverUrl: input.serverUrl,
		enrollmentSecret: input.enrollmentSecret,
		syncIntervalSeconds: input.sync.syncIntervalSeconds,
		syncObsidian: input.sync.syncObsidian,
		ignorePatterns: input.sync.ignorePatterns,
		selectedVault: { ...input.vault },
		accountLabel: input.accountLabel,
		protocolVersion: input.protocolVersion,
		requiredCapabilities: [...ISSUED_CAPABILITIES],
		trust: verified
			? {
					mode: "verified_transfer",
					repoEpoch: a.repoEpoch,
					checkpointHash: a.checkpointHash,
					headSequence: a.headSequence,
					devicePublicKeys: { ...a.devicePublicKeys },
				}
			: { mode: "first_trust" },
	};
}

/** 导入端：从 verified_transfer 包里取出可暂存的锚（不完整一律当首次信任）。 */
export function anchorFromConfig(
	config: PairingConfig,
): { repoEpoch: string; checkpointHash: string; headSequence: number; devicePublicKeys: Record<string, string> } | null {
	const t = config.trust;
	if (!completeAnchor(t)) return null;
	return {
		repoEpoch: t.repoEpoch,
		checkpointHash: t.checkpointHash,
		headSequence: t.headSequence,
		devicePublicKeys: { ...t.devicePublicKeys },
	};
}
