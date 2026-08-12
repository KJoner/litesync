/**
 * 一次性加密配对包（v8「添加新设备」）。
 *
 * 安全模型：
 * - 配置包（Server URL + API Token + 同步设置）在原设备本地用随机
 *   pairSecret 做 AES-256-GCM 加密后才上传，服务器只见密文；
 * - pairSecret 只出现在配对链接的 #fragment 中（浏览器不发给服务器）
 *   与 obsidian:// 深链参数中（操作系统本地传递，不经网络）；
 * - 服务器侧 5 分钟过期 + 消费即删（一次性）；
 * - E2EE 密码绝不放进配对包——新设备手动输入一次。
 */
import { requestUrl } from "obsidian";
import { b64decode, b64encode, b64urlEncode, randomBytes } from "../crypto/crypto";

/**
 * 配对包内容。
 * v1（0.8.x，导入兼容）：直接携带根 apiToken；
 * v2（0.10+，创建默认）：只携带一次性 enrollmentSecret——新设备用它公开注册
 * 换取自己的最小权限设备凭据，根 Token 从此不再离开服务器。
 */
export interface PairingConfig {
	v: 1 | 2;
	serverUrl: string;
	/** v1：根 API Token（旧包导入后首轮同步会自动换发设备凭据） */
	apiToken?: string;
	/** v2：一次性设备注册凭据 */
	enrollmentSecret?: string;
	syncIntervalSeconds?: number;
	syncObsidian?: boolean;
	ignorePatterns?: string;
	/**
	 * 可信 checkpoint 锚（v0.15 / 计划书 §9.3）。
	 *
	 * 新设备**不能**只相信服务器给出的第一个 manifest——那等于让服务器
	 * 自己定义「正确的历史」。配对包由已受信设备生成、经加密链接传递，
	 * 因此它携带的锚是可信的：新设备据此拒绝任何早于该锚的状态。
	 *
	 * 配对包本身走的是「密钥只在链接 #fragment 里」的通道，服务器看不到，
	 * 也就改不了这个锚。
	 */
	trustAnchor?: {
		repoEpoch: string;
		checkpointHash: string;
		headSequence: number;
		/** deviceId → base64 SPKI 签名公钥 */
		devicePublicKeys: Record<string, string>;
	};
}

const PAIRING_AAD = "litesync/v1/pairing";

function aadBytes(): Uint8Array {
	return new TextEncoder().encode(PAIRING_AAD);
}

/** 生成 32 字节配对密钥。 */
export function newPairSecret(): Uint8Array {
	return randomBytes(32);
}

/** 加密配对包 → base64(iv|ct+tag)。 */
export async function encryptPairingConfig(secretRaw: Uint8Array, config: PairingConfig): Promise<string> {
	const key = await crypto.subtle.importKey("raw", secretRaw as BufferSource, { name: "AES-GCM" }, false, [
		"encrypt",
	]);
	const iv = randomBytes(12);
	const plain = new TextEncoder().encode(JSON.stringify(config));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: aadBytes() as BufferSource },
			key,
			plain,
		),
	);
	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv, 0);
	out.set(ct, iv.length);
	return b64encode(out);
}

/** 解密配对包；密钥不符 / 数据被篡改 / 格式错误返回 null。 */
export async function decryptPairingConfig(
	secretRaw: Uint8Array,
	ciphertextB64: string,
): Promise<PairingConfig | null> {
	try {
		const raw = b64decode(ciphertextB64);
		if (raw.length < 13) return null;
		const key = await crypto.subtle.importKey("raw", secretRaw as BufferSource, { name: "AES-GCM" }, false, [
			"decrypt",
		]);
		const plain = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: raw.slice(0, 12) as BufferSource,
				additionalData: aadBytes() as BufferSource,
			},
			key,
			raw.slice(12),
		);
		const config = JSON.parse(new TextDecoder().decode(plain)) as PairingConfig;
		if (typeof config.serverUrl !== "string") return null;
		if (config.v === 1 && typeof config.apiToken === "string") return config;
		if (config.v === 2 && typeof config.enrollmentSecret === "string") return config;
		return null;
	} catch {
		return null;
	}
}

/** base64url 解码（配对 secret 经 URL fragment / obsidian:// 参数传输）。 */
export function b64urlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
	return b64decode(b64);
}

/** 生成配对链接：https://server/p/{id}#secret=<b64url>。 */
export function buildPairUrl(serverUrl: string, id: string, secretRaw: Uint8Array): string {
	return `${serverUrl.replace(/\/+$/, "")}/p/${id}#secret=${b64urlEncode(secretRaw)}`;
}

export interface ParsedPairUrl {
	serverUrl: string;
	id: string;
	secretB64url: string;
}

/** 解析配对链接（设置页「导入配对链接」粘贴用）。 */
export function parsePairUrl(url: string): ParsedPairUrl | null {
	try {
		const u = new URL(url.trim());
		// 安全红线（v9）：配对包里有 API Token，非 loopback 地址一律要求 https
		if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) return null;
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		const m = /^\/p\/([0-9a-f]+)$/i.exec(u.pathname);
		if (!m) return null;
		const secret = new URLSearchParams(u.hash.slice(1)).get("secret");
		if (!secret) return null;
		return { serverUrl: u.origin, id: m[1], secretB64url: secret };
	} catch {
		return null;
	}
}

/** 仅本机地址允许 http://（与 ApiClient 同一规则）。 */
export function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	return h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 消费配对包（公开接口：新设备此时还没有 Token）。返回密文；失效返回 null。 */
export async function consumePairing(serverUrl: string, id: string): Promise<string | null> {
	const res = await requestUrl({
		url: `${serverUrl.replace(/\/+$/, "")}/pair/${encodeURIComponent(id)}/consume`,
		method: "POST",
		throw: false,
	});
	if (res.status === 404) return null;
	if (res.status !== 200) throw new Error(`pairing consume failed: HTTP ${res.status}`);
	const body = res.json as { ciphertext?: string };
	return typeof body.ciphertext === "string" ? body.ciphertext : null;
}
