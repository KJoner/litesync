/**
 * Trusted Device（信任此设备，v3.1）。
 *
 * 记住的是「这台设备已被授权」，而不是用户的 E2EE 密码：
 *
 *   Vault Master Key ──(随机设备密钥 AES-GCM 包装)──▶ SecretStorage
 *
 * 拆分包装（split-knowledge）：
 * - 设备密钥（随机 32B）保存在插件 data.json（vault 文件夹内）
 * - 被包裹的 VMK 保存在 Obsidian SecretStorage（应用 local storage，vault 文件夹外）
 * 两处各持一半，单独复制任何一份都无法还原 VMK
 * （例如整个 vault 文件夹被备份/拷贝时，SecretStorage 内容并不随行）。
 *
 * 包装 blob 绑定 vault key 文档标识（keyId）：服务器端密钥轮换后旧信任自动失效。
 */
import type { App } from "obsidian";
import { b64decode, b64encode, exportVmkRaw, randomBytes, VaultKeyDoc } from "./crypto";
import type { Keyring } from "./keyring";

export const VAULT_KEY_SECRET_ID = "litesync-vault-key";
export const API_TOKEN_SECRET_ID = "litesync-api-token";

interface TrustBlob {
	v: 1;
	keyId: string;
	iv: string; // base64
	data: string; // base64（AES-GCM 加密的 VMK）
}

/** vault key 文档的稳定标识（密钥材料变化即失配）。 */
function keyIdOf(doc: VaultKeyDoc): string {
	return doc.wrappedKey.slice(0, 24);
}

function trustAad(keyId: string): Uint8Array {
	return new TextEncoder().encode(`litesync/v1/device-trust:${keyId}`);
}

/** 用设备密钥包装 VMK（纯函数，供测试）。 */
export async function wrapVmkForDevice(
	deviceKeyRaw: Uint8Array,
	vmkRaw: Uint8Array,
	keyId: string,
): Promise<string> {
	const key = await crypto.subtle.importKey("raw", deviceKeyRaw as BufferSource, { name: "AES-GCM" }, false, [
		"encrypt",
	]);
	const iv = randomBytes(12);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: trustAad(keyId) as BufferSource },
			key,
			vmkRaw as BufferSource,
		),
	);
	const blob: TrustBlob = { v: 1, keyId, iv: b64encode(iv), data: b64encode(ct) };
	return JSON.stringify(blob);
}

/** 解开设备包装；密钥不符 / 数据被篡改 / keyId 失配返回 null（纯函数，供测试）。 */
export async function unwrapVmkForDevice(
	deviceKeyRaw: Uint8Array,
	blobJson: string,
	expectedKeyId: string,
): Promise<Uint8Array | null> {
	try {
		const blob = JSON.parse(blobJson) as TrustBlob;
		if (blob.v !== 1 || blob.keyId !== expectedKeyId) return null;
		const key = await crypto.subtle.importKey(
			"raw",
			deviceKeyRaw as BufferSource,
			{ name: "AES-GCM" },
			false,
			["decrypt"],
		);
		const raw = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: b64decode(blob.iv) as BufferSource,
				additionalData: trustAad(blob.keyId) as BufferSource,
			},
			key,
			b64decode(blob.data) as BufferSource,
		);
		return new Uint8Array(raw);
	} catch {
		return null;
	}
}

/**
 * 把当前已解锁的 VMK 持久化为设备信任。
 * 返回应保存到设置中的设备密钥（base64）；keyring 未解锁或无 vault key 文档时返回 null。
 */
export async function persistTrustedDevice(
	app: App,
	existingDeviceKeyB64: string,
	keyring: Keyring,
): Promise<string | null> {
	if (!keyring.doc || !keyring.unlocked) return null;

	const deviceKey = existingDeviceKeyB64 ? b64decode(existingDeviceKeyB64) : randomBytes(32);
	const vmkRaw = await exportVmkRaw(keyring.requireKey());
	try {
		const blob = await wrapVmkForDevice(deviceKey, vmkRaw, keyIdOf(keyring.doc));
		app.secretStorage.setSecret(VAULT_KEY_SECRET_ID, blob);
	} finally {
		vmkRaw.fill(0);
	}
	return b64encode(deviceKey);
}

/** 启动时尝试用设备信任恢复 VMK；失败（未信任/密钥轮换/被篡改）返回 null。 */
export async function loadTrustedVmk(
	app: App,
	deviceKeyB64: string,
	doc: VaultKeyDoc,
): Promise<Uint8Array | null> {
	if (!deviceKeyB64) return null;
	const blob = app.secretStorage.getSecret(VAULT_KEY_SECRET_ID);
	if (!blob) return null;
	return unwrapVmkForDevice(b64decode(deviceKeyB64), blob, keyIdOf(doc));
}

/** 忘记此设备：清空本地保存的设备包装密钥（SecretStorage 无删除接口，写空即失效）。 */
export function forgetTrustedDevice(app: App): void {
	app.secretStorage.setSecret(VAULT_KEY_SECRET_ID, "");
}
