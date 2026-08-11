/**
 * E2EE 密码学原语（计划书 Phase 12；v9.2 增加 LSE2 信封）。
 *
 * 全部基于 WebCrypto 的成熟 authenticated-encryption 实现，禁止自造算法：
 * - 密码 → PBKDF2-SHA256（600k 迭代）→ KEK
 * - 随机 32 字节 Vault Master Key（VMK），用 KEK 以 AES-256-GCM 包裹后存服务器
 * - 文件加密：AES-256-GCM，每次随机 12 字节 IV
 *
 * 加密文件格式：
 *   LSE1（v1，读取兼容）："LSE1"(4B) | iv(12B) | ct+tag，AAD 只绑定 path
 *   LSE2（v9.2，写入默认）："LSE2"(4B) | keyEpoch(u32 BE) | iv(12B) | ct+tag，
 *     AAD 绑定 vaultId + keyEpoch + path——恶意服务器无法用其他 vault /
 *     其他密钥世代的密文对同一路径做替换重放（同 vault 同 epoch 的
 *     历史版本重放仍需签名 manifest 才能防住，见三阶段计划）
 */

export const KDF_ITERATIONS = 600_000;

const MAGIC = new Uint8Array([0x4c, 0x53, 0x45, 0x31]); // "LSE1"
const MAGIC2 = new Uint8Array([0x4c, 0x53, 0x45, 0x32]); // "LSE2"
const MAGIC3 = new Uint8Array([0x4c, 0x53, 0x45, 0x33]); // "LSE3"
const IV_LEN = 12;
const EPOCH_LEN = 4;
const GEN_LEN = 8;

/** LSE2 的 AAD 绑定材料（vaultId 来自 bootstrap，keyEpoch 来自服务器状态机）。 */
export interface FileKeyBinding {
	vaultId: string;
	keyEpoch: number;
}

/**
 * LSE3（v9.3）的 AAD 绑定材料：路径不再入 AAD——改绑稳定 fileId
 *（E2EE 下改名不再需要重新加密内容），并绑定单调递增的 contentGeneration
 *（恶意服务器无法把同一文件的旧版本密文当 HEAD 重放，客户端按已见 generation 拒绝回退）。
 */
export interface FileKeyBinding3 {
	vaultId: string;
	keyEpoch: number;
	fileId: string;
	generation: number;
}

function fileAadV3(b: FileKeyBinding3): Uint8Array {
	return new TextEncoder().encode(`litesync/v3/file:${b.vaultId}:${b.keyEpoch}:${b.fileId}:${b.generation}`);
}

/** 生成客户端侧的稳定文件身份（16B hex；新文件在加密前就需要确定 id）。 */
export function newFileId(): string {
	const raw = randomBytes(16);
	let out = "";
	for (const b of raw) out += b.toString(16).padStart(2, "0");
	return out;
}

// ---------- 元数据加密（v9.3 三期：LSM1 信封 + canonical HMAC） ----------

const META_MAGIC = new Uint8Array([0x4c, 0x53, 0x4d, 0x31]); // "LSM1"

/** 从 VMK 派生的元数据密钥对：enc 加密路径等元数据，mac 计算同名判定 HMAC。 */
export interface MetaKeys {
	enc: CryptoKey;
	mac: CryptoKey;
}

/**
 * HKDF 从 VMK 原始字节派生元数据密钥（与内容密钥域分离）。
 * 派生是确定性的：任何解锁了 VMK 的设备得到同一组 metaKeys。
 */
export async function deriveMetaKeys(vmkRaw: Uint8Array): Promise<MetaKeys> {
	const master = await crypto.subtle.importKey("raw", vmkRaw as BufferSource, "HKDF", false, ["deriveKey"]);
	const hkdf = (info: string, algo: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
		crypto.subtle.deriveKey(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: new Uint8Array(32) as BufferSource,
				info: new TextEncoder().encode(info) as BufferSource,
			},
			master,
			algo,
			false,
			usages,
		);
	const [enc, mac] = await Promise.all([
		hkdf("litesync/v5/meta-enc", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
		hkdf("litesync/v5/meta-mac", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
	]);
	return { enc, mac };
}

/** 文件元数据明文（LSM1 内容；未来可扩展更多字段）。 */
export interface FileMeta {
	path: string;
}

function metaAad(vaultId: string, keyEpoch: number, fileId: string, metaGeneration: number): Uint8Array {
	return new TextEncoder().encode(`litesync/v5/meta:${vaultId}:${keyEpoch}:${fileId}:${metaGeneration}`);
}

/** LSM1 加密：magic | keyEpoch(u32) | metaGeneration(u64) | iv | ct+tag → base64。 */
export async function encryptMeta(
	keys: MetaKeys,
	binding: { vaultId: string; keyEpoch: number; fileId: string; metaGeneration: number },
	meta: FileMeta,
): Promise<string> {
	const iv = randomBytes(IV_LEN);
	const plain = new TextEncoder().encode(JSON.stringify(meta));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv: iv as BufferSource,
				additionalData: metaAad(binding.vaultId, binding.keyEpoch, binding.fileId, binding.metaGeneration) as BufferSource,
			},
			keys.enc,
			plain,
		),
	);
	const head = META_MAGIC.length + EPOCH_LEN + GEN_LEN;
	const out = new Uint8Array(head + IV_LEN + ct.length);
	out.set(META_MAGIC, 0);
	const view = new DataView(out.buffer);
	view.setUint32(META_MAGIC.length, binding.keyEpoch >>> 0, false);
	view.setBigUint64(META_MAGIC.length + EPOCH_LEN, BigInt(binding.metaGeneration), false);
	out.set(iv, head);
	out.set(ct, head + IV_LEN);
	return b64encode(out);
}

/** LSM1 解密（AAD 由 vaultId + 信封头 + fileId 重建）；失败返回 null。 */
export async function decryptMeta(
	keys: MetaKeys,
	payloadB64: string,
	vaultId: string,
	fileId: string,
): Promise<{ meta: FileMeta; metaGeneration: number; keyEpoch: number } | null> {
	let raw: Uint8Array;
	try {
		raw = b64decode(payloadB64);
	} catch {
		return null;
	}
	const head = META_MAGIC.length + EPOCH_LEN + GEN_LEN;
	if (raw.byteLength < head + IV_LEN + 16) return null;
	for (let i = 0; i < META_MAGIC.length; i++) {
		if (raw[i] !== META_MAGIC[i]) return null;
	}
	const view = new DataView(raw.buffer, raw.byteOffset);
	const keyEpoch = view.getUint32(META_MAGIC.length, false);
	const metaGeneration = Number(view.getBigUint64(META_MAGIC.length + EPOCH_LEN, false));
	try {
		const iv = raw.subarray(head, head + IV_LEN);
		const ct = raw.subarray(head + IV_LEN);
		const plain = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: iv as BufferSource,
				additionalData: metaAad(vaultId, keyEpoch, fileId, metaGeneration) as BufferSource,
			},
			keys.enc,
			ct as BufferSource,
		);
		const meta = JSON.parse(new TextDecoder().decode(plain)) as FileMeta;
		if (typeof meta.path !== "string" || meta.path === "") return null;
		return { meta, metaGeneration, keyEpoch };
	} catch {
		return null;
	}
}

/** canonical 同名判定 HMAC（服务器只见 HMAC，学不到路径内容）。 */
export async function canonicalPathHmac(keys: MetaKeys, path: string): Promise<string> {
	const canonical = path.normalize("NFC").toLowerCase();
	const sig = new Uint8Array(
		await crypto.subtle.sign("HMAC", keys.mac, new TextEncoder().encode(canonical)),
	);
	let out = "";
	for (const b of sig) out += b.toString(16).padStart(2, "0");
	return out;
}

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

function fileAadV2(binding: FileKeyBinding, path: string): Uint8Array {
	return new TextEncoder().encode(`litesync/v2/file:${binding.vaultId}:${binding.keyEpoch}:${path}`);
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

function hasMagic(data: ArrayBuffer, magic: Uint8Array, minTail: number): boolean {
	if (data.byteLength < magic.length + minTail) return false;
	const head = new Uint8Array(data, 0, magic.length);
	for (let i = 0; i < magic.length; i++) {
		if (head[i] !== magic[i]) return false;
	}
	return true;
}

/** 判断字节流是否为 LiteSync 加密格式（LSE1/LSE2/LSE3）。 */
export function isEncryptedPayload(data: ArrayBuffer): boolean {
	return (
		hasMagic(data, MAGIC, IV_LEN + 16) ||
		hasMagic(data, MAGIC2, EPOCH_LEN + IV_LEN + 16) ||
		hasMagic(data, MAGIC3, EPOCH_LEN + GEN_LEN + IV_LEN + 16)
	);
}

/** 是否为旧版信封（LSE1/LSE2，「升级加密信封」命令用；LSE3 为当前格式）。 */
export function isLegacyEnvelope(data: ArrayBuffer): boolean {
	return hasMagic(data, MAGIC, IV_LEN + 16) || hasMagic(data, MAGIC2, EPOCH_LEN + IV_LEN + 16);
}

/** 是否为 LSE3 信封。 */
export function isLse3Envelope(data: ArrayBuffer): boolean {
	return hasMagic(data, MAGIC3, EPOCH_LEN + GEN_LEN + IV_LEN + 16);
}

/** 读取 LSE3 信封头（明文字段；真实性由解密时的 AAD 校验保证）。 */
export function parseLse3Header(data: ArrayBuffer): { keyEpoch: number; generation: number } | null {
	if (!isLse3Envelope(data)) return null;
	const view = new DataView(data);
	return {
		keyEpoch: view.getUint32(MAGIC3.length, false),
		generation: Number(view.getBigUint64(MAGIC3.length + EPOCH_LEN, false)),
	};
}

/** LSE3 加密：magic | keyEpoch(u32) | generation(u64) | iv | ct+tag。 */
export async function encryptFileV3(
	vmk: CryptoKey,
	binding: FileKeyBinding3,
	plaintext: ArrayBuffer,
): Promise<ArrayBuffer> {
	const iv = randomBytes(IV_LEN);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: fileAadV3(binding) as BufferSource },
			vmk,
			plaintext,
		),
	);
	const head = MAGIC3.length + EPOCH_LEN + GEN_LEN;
	const out = new Uint8Array(head + IV_LEN + ct.length);
	out.set(MAGIC3, 0);
	const view = new DataView(out.buffer);
	view.setUint32(MAGIC3.length, binding.keyEpoch >>> 0, false);
	view.setBigUint64(MAGIC3.length + EPOCH_LEN, BigInt(binding.generation), false);
	out.set(iv, head);
	out.set(ct, head + IV_LEN);
	return out.buffer;
}

/**
 * LSE3 解密。AAD 由 vaultId + 信封头 keyEpoch/generation + 服务器提供的 fileId
 * 重建——fileId 造假会直接导致 GCM 认证失败，无需额外信任服务器。
 * expectedKeyEpoch > 0 时校验信封世代一致（拒绝跨密钥世代重放）。
 * 成功返回 { plain, generation }（generation 已经过 AAD 认证，调用方据此做回退检查）。
 */
export async function decryptFileV3(
	vmk: CryptoKey,
	payload: ArrayBuffer,
	vaultId: string,
	fileId: string,
	expectedKeyEpoch: number,
): Promise<{ plain: ArrayBuffer; generation: number } | null> {
	const header = parseLse3Header(payload);
	if (header === null || !vaultId || !fileId) return null;
	if (expectedKeyEpoch > 0 && header.keyEpoch !== expectedKeyEpoch) return null;
	try {
		const head = MAGIC3.length + EPOCH_LEN + GEN_LEN;
		const iv = new Uint8Array(payload, head, IV_LEN);
		const ct = new Uint8Array(payload, head + IV_LEN);
		const plain = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: iv as BufferSource,
				additionalData: fileAadV3({
					vaultId,
					keyEpoch: header.keyEpoch,
					fileId,
					generation: header.generation,
				}) as BufferSource,
			},
			vmk,
			ct,
		);
		return { plain, generation: header.generation };
	} catch {
		return null;
	}
}

/**
 * 加密文件内容（每次随机 IV）。
 * 提供 binding 时输出 LSE2（AAD 绑定 vaultId+keyEpoch+path）；
 * 不提供时输出兼容的 LSE1（仅路径绑定；用于 binding 尚不可知的过渡场景）。
 */
export async function encryptFile(
	vmk: CryptoKey,
	path: string,
	plaintext: ArrayBuffer,
	binding?: FileKeyBinding,
): Promise<ArrayBuffer> {
	const iv = randomBytes(IV_LEN);
	if (!binding) {
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
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: fileAadV2(binding, path) as BufferSource },
			vmk,
			plaintext,
		),
	);
	const out = new Uint8Array(MAGIC2.length + EPOCH_LEN + IV_LEN + ct.length);
	out.set(MAGIC2, 0);
	new DataView(out.buffer).setUint32(MAGIC2.length, binding.keyEpoch >>> 0, false);
	out.set(iv, MAGIC2.length + EPOCH_LEN);
	out.set(ct, MAGIC2.length + EPOCH_LEN + IV_LEN);
	return out.buffer;
}

/**
 * 解密文件内容；密钥不符 / 数据被篡改 / AAD 不匹配返回 null。
 * LSE2 要求 binding（vaultId 必需；binding.keyEpoch > 0 时还校验信封内的
 * epoch 与之一致，拒绝其他密钥世代的密文重放）。
 */
export async function decryptFile(
	vmk: CryptoKey,
	path: string,
	payload: ArrayBuffer,
	binding?: FileKeyBinding,
): Promise<ArrayBuffer | null> {
	if (hasMagic(payload, MAGIC2, EPOCH_LEN + IV_LEN + 16)) {
		if (!binding?.vaultId) return null; // 无法建立 AAD → 拒绝
		const envelopeEpoch = new DataView(payload).getUint32(MAGIC2.length, false);
		if (binding.keyEpoch > 0 && envelopeEpoch !== binding.keyEpoch) return null;
		try {
			const iv = new Uint8Array(payload, MAGIC2.length + EPOCH_LEN, IV_LEN);
			const ct = new Uint8Array(payload, MAGIC2.length + EPOCH_LEN + IV_LEN);
			return await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: iv as BufferSource,
					additionalData: fileAadV2({ vaultId: binding.vaultId, keyEpoch: envelopeEpoch }, path) as BufferSource,
				},
				vmk,
				ct,
			);
		} catch {
			return null;
		}
	}
	if (!hasMagic(payload, MAGIC, IV_LEN + 16)) return null;
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
