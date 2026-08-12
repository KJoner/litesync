/**
 * 设备 checkpoint 签名密钥的存取（v0.15.0 / 计划书 §9.2）。
 *
 * 与 VMK 分离保存，这是有意的职责切分：
 *
 *   - 签名私钥泄露 → 攻击者能伪造 checkpoint，但读不了任何内容；
 *   - VMK 泄露 → 攻击者能读内容，但伪造不了 checkpoint。
 *
 * 两者放在同一个地方，这层分隔就不存在了。因此签名私钥单独走 SecretStorage
 * 的另一个键，不进 `data.json`，也不与 vault key 文档混在一起。
 *
 * 私钥不做额外包装：SecretStorage 本身就在 vault 文件夹之外，
 * 复制整个 vault 不会带走它。再包一层只会增加「包装密钥存哪」这个新问题。
 */

import type { App } from "obsidian";
import { generateSigningKey } from "./checkpoint";

export const SIGNING_KEY_SECRET_ID = "litesync-signing-key";

interface StoredSigningKey {
	v: 1;
	/** base64 PKCS#8 私钥 */
	privateKey: string;
	/** base64 SPKI 公钥（发布给服务器与其他设备） */
	publicKey: string;
	createdAt: number;
}

/**
 * 取出本设备的签名密钥；不存在则生成并保存。
 *
 * 只在首次调用时生成——密钥换新等于「换一把钥匙，然后重新解释历史」，
 * 那正是这套机制要防的事。需要换密钥时的正确做法是撤销该设备再重新接入。
 */
export async function loadOrCreateSigningKey(
	app: App,
): Promise<{ privateKeyPkcs8B64: string; publicKeyB64: string; created: boolean }> {
	const existing = await readStored(app);
	if (existing !== null) {
		return { privateKeyPkcs8B64: existing.privateKey, publicKeyB64: existing.publicKey, created: false };
	}
	const fresh = await generateSigningKey();
	const stored: StoredSigningKey = {
		v: 1,
		privateKey: fresh.privateKeyPkcs8B64,
		publicKey: fresh.publicKeyB64,
		createdAt: Date.now(),
	};
	app.secretStorage.setSecret(SIGNING_KEY_SECRET_ID, JSON.stringify(stored));
	return { privateKeyPkcs8B64: fresh.privateKeyPkcs8B64, publicKeyB64: fresh.publicKeyB64, created: true };
}

/** 读出已保存的公钥（没有则返回空串）。 */
export async function storedSigningPublicKey(app: App): Promise<string> {
	return (await readStored(app))?.publicKey ?? "";
}

async function readStored(app: App): Promise<StoredSigningKey | null> {
	try {
		const raw = app.secretStorage.getSecret(SIGNING_KEY_SECRET_ID);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as StoredSigningKey;
		if (parsed.v !== 1 || !parsed.privateKey || !parsed.publicKey) return null;
		return parsed;
	} catch {
		// 读不出来就当没有：重新生成一把新的比带着半个坏密钥继续要安全。
		// 代价是这台设备之前签的 checkpoint 会变成「未知签名者」——
		// 用户会看到明确的提示，而不是静默的错误行为
		return null;
	}
}
