/**
 * E2EE 密码学原语（计划书 Phase 12）。
 *
 * 全部基于 WebCrypto 的成熟 authenticated-encryption 实现，禁止自造算法：
 * - 密码 → PBKDF2-SHA256（600k 迭代）→ KEK
 * - 随机 32 字节 Vault Master Key（VMK），用 KEK 以 AES-256-GCM 包裹后存服务器
 * - 文件加密：AES-256-GCM，每次随机 12 字节 IV，路径绑定进 AAD（防内容串换）
 *
 * 加密文件格式（LiteSync Encrypted v1）：
 *   "LSE1"(4B) | iv(12B) | ciphertext+tag
 */

export const KDF_ITERATIONS = 600_000;

const MAGIC = new Uint8Array([0x4c, 0x53, 0x45, 0x31]); // "LSE1"
const IV_LEN = 12;

/** 存服务器 / 本地缓存的 vault key 文档（不含任何明文密钥材料）。 */
export interface VaultKeyDoc {
	version: 1;
	kdf: "pbkdf2-sha256";
	iterations: number;
	salt: string; // base64
	iv: string; // base64（包裹 VMK 用的 IV）
	wrappedKey: string; // base64（AES-GCM 加密的 VMK）
	enabled: boolean;
	createdAt: number;
}

const VMK_AAD = new TextEncoder().encode("litesync/v1/vault-key");

function fileAad(path: string): Uint8Array {
	return new TextEncoder().encode(`litesync/v1/file:${path}`);
}

export function randomBytes(n: number): Uint8Array {
	const b = new Uint8Array(n);
	crypto.getRandomValues(b);
	return b;
}

export function b64encode(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function deriveKek(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function importVmk(raw: Uint8Array): Promise<CryptoKey> {
	// extractable：Trusted Device 需要在解锁状态下导出 VMK 做设备包装
	return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, true, [
		"encrypt",
		"decrypt",
	]);
}

/** 导出 VMK 原始字节（仅用于 Trusted Device 包装，用完必须清零）。 */
export async function exportVmkRaw(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/** 首次启用：生成随机 VMK 并用密码派生的 KEK 包裹。 */
export async function createVaultKeyDoc(
	password: string,
): Promise<{ doc: VaultKeyDoc; vmk: CryptoKey }> {
	const salt = randomBytes(16);
	const iv = randomBytes(IV_LEN);
	const vmkRaw = randomBytes(32);
	const kek = await deriveKek(password, salt, KDF_ITERATIONS);
	const wrapped = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: VMK_AAD as BufferSource },
			kek,
			vmkRaw as BufferSource,
		),
	);
	const vmk = await importVmk(vmkRaw);
	vmkRaw.fill(0);
	return {
		doc: {
			version: 1,
			kdf: "pbkdf2-sha256",
			iterations: KDF_ITERATIONS,
			salt: b64encode(salt),
			iv: b64encode(iv),
			wrappedKey: b64encode(wrapped),
			enabled: false,
			createdAt: Date.now(),
		},
		vmk,
	};
}

/** 用密码解锁 VMK；密码错误或数据被篡改（GCM 认证失败）返回 null。 */
export async function unlockVaultKey(doc: VaultKeyDoc, password: string): Promise<CryptoKey | null> {
	try {
		const kek = await deriveKek(password, b64decode(doc.salt), doc.iterations);
		const vmkRaw = new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: b64decode(doc.iv) as BufferSource,
					additionalData: VMK_AAD as BufferSource,
				},
				kek,
				b64decode(doc.wrappedKey) as BufferSource,
			),
		);
		const key = await importVmk(vmkRaw);
		vmkRaw.fill(0);
		return key;
	} catch {
		return null;
	}
}

// ---------- 分享加密（Phase 17：独立 Share Key，与 Vault Master Key 无关） ----------

const SHARE_MAGIC = new Uint8Array([0x4c, 0x53, 0x53, 0x31]); // "LSS1"
const SHARE_AAD = new TextEncoder().encode("litesync/v1/share");

/** 用独立 Share Key（随机 32B）加密分享内容，格式 "LSS1" | iv | ct+tag。 */
export async function encryptShare(keyRaw: Uint8Array, plaintext: ArrayBuffer): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey("raw", keyRaw as BufferSource, { name: "AES-GCM" }, false, [
		"encrypt",
	]);
	const iv = randomBytes(IV_LEN);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: SHARE_AAD as BufferSource },
			key,
			plaintext,
		),
	);
	const out = new Uint8Array(SHARE_MAGIC.length + IV_LEN + ct.length);
	out.set(SHARE_MAGIC, 0);
	out.set(iv, SHARE_MAGIC.length);
	out.set(ct, SHARE_MAGIC.length + IV_LEN);
	return out.buffer;
}

/** 解密分享内容（Web 查看页同款算法，测试用）；失败返回 null。 */
export async function decryptShare(keyRaw: Uint8Array, payload: ArrayBuffer): Promise<ArrayBuffer | null> {
	const head = new Uint8Array(payload, 0, Math.min(4, payload.byteLength));
	if (payload.byteLength < 4 + IV_LEN + 16 || !SHARE_MAGIC.every((b, i) => head[i] === b)) return null;
	try {
		const key = await crypto.subtle.importKey("raw", keyRaw as BufferSource, { name: "AES-GCM" }, false, [
			"decrypt",
		]);
		const iv = new Uint8Array(payload, SHARE_MAGIC.length, IV_LEN);
		const ct = new Uint8Array(payload, SHARE_MAGIC.length + IV_LEN);
		return await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: SHARE_AAD as BufferSource },
			key,
			ct,
		);
	} catch {
		return null;
	}
}

/** base64url（分享链接 fragment 用）。 */
export function b64urlEncode(bytes: Uint8Array): string {
	return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 判断字节流是否为 LiteSync 加密格式。 */
export function isEncryptedPayload(data: ArrayBuffer): boolean {
	if (data.byteLength < MAGIC.length + IV_LEN + 16) return false;
	const head = new Uint8Array(data, 0, MAGIC.length);
	for (let i = 0; i < MAGIC.length; i++) {
		if (head[i] !== MAGIC[i]) return false;
	}
	return true;
}

/** 加密文件内容（每次随机 IV，路径作为 AAD 绑定）。 */
export async function encryptFile(vmk: CryptoKey, path: string, plaintext: ArrayBuffer): Promise<ArrayBuffer> {
	const iv = randomBytes(IV_LEN);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: fileAad(path) as BufferSource },
			vmk,
			plaintext,
		),
	);
	const out = new Uint8Array(MAGIC.length + IV_LEN + ct.length);
	out.set(MAGIC, 0);
	out.set(iv, MAGIC.length);
	out.set(ct, MAGIC.length + IV_LEN);
	return out.buffer;
}

/** 解密文件内容；密钥不符 / 数据被篡改 / 路径不匹配（AAD 校验失败）返回 null。 */
export async function decryptFile(
	vmk: CryptoKey,
	path: string,
	payload: ArrayBuffer,
): Promise<ArrayBuffer | null> {
	if (!isEncryptedPayload(payload)) return null;
	try {
		const iv = new Uint8Array(payload, MAGIC.length, IV_LEN);
		const ct = new Uint8Array(payload, MAGIC.length + IV_LEN);
		return await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: fileAad(path) as BufferSource },
			vmk,
			ct,
		);
	} catch {
		return null;
	}
}
