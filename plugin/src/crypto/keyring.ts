import { unlockVaultKey, VaultKeyDoc } from "./crypto";

/** 同步遇到密文但密钥未解锁时抛出；同步暂停，本地编辑不受影响。 */
export class E2eeLockedError extends Error {
	constructor() {
		super("端到端加密已启用，请先解锁（Unlock E2EE）");
		this.name = "E2eeLockedError";
	}
}

/**
 * 密钥环：持有 vault key 文档与内存中的已解锁 VMK。
 * 明文 VMK 只存在于不可导出的 CryptoKey 句柄中，永不落盘、永不上传。
 */
export class Keyring {
	private vmk: CryptoKey | null = null;
	private currentDoc: VaultKeyDoc | null = null;

	get doc(): VaultKeyDoc | null {
		return this.currentDoc;
	}

	get enabled(): boolean {
		return this.currentDoc?.enabled === true;
	}

	get unlocked(): boolean {
		return this.vmk !== null;
	}

	get needsUnlock(): boolean {
		return this.enabled && !this.unlocked;
	}

	/** 更新文档；密钥材料变化时使已解锁的 VMK 失效。 */
	setDoc(doc: VaultKeyDoc | null): void {
		const sameKeyMaterial =
			doc !== null &&
			this.currentDoc !== null &&
			doc.wrappedKey === this.currentDoc.wrappedKey &&
			doc.salt === this.currentDoc.salt;
		this.currentDoc = doc;
		if (!sameKeyMaterial) this.vmk = null;
	}

	/** 迁移流程中直接采用已解锁的密钥。 */
	adopt(doc: VaultKeyDoc, vmk: CryptoKey): void {
		this.currentDoc = doc;
		this.vmk = vmk;
	}

	async unlock(password: string): Promise<boolean> {
		if (!this.currentDoc) return false;
		const key = await unlockVaultKey(this.currentDoc, password);
		if (!key) return false;
		this.vmk = key;
		return true;
	}

	lock(): void {
		this.vmk = null;
	}

	requireKey(): CryptoKey {
		if (!this.vmk) throw new E2eeLockedError();
		return this.vmk;
	}
}
