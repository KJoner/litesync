import { deriveMetaKeys, deriveResetAuth, exportVmkRaw, importVmk, MetaKeys, unlockVaultKey, VaultKeyDoc } from "./crypto";

/** 同步遇到密文但密钥未解锁时抛出；同步暂停，本地编辑不受影响。 */
export class E2eeLockedError extends Error {
	constructor() {
		super("仓库已锁定，请先解锁（命令「解锁仓库」）");
		this.name = "E2eeLockedError";
	}
}

/**
 * 密钥会话在异步操作期间变了（锁定 / 换文档 / 换连接 / 卸载 / 取消解锁）：
 * 这次操作基于的钥匙已经不是当前那一把，结果一律作废（0.20.1 / 复审 PL-01）。
 *
 * 继承 E2eeLockedError：调用方现有的「暂停、等待重新解锁、不做退避重试」处理照样适用。
 */
export class KeySessionChangedError extends E2eeLockedError {
	constructor() {
		super();
		this.message = "密钥会话已变化（锁定、切换仓库或连接），本次操作已作废；请重新解锁后再试";
		this.name = "KeySessionChangedError";
	}
}

/** 一次解锁尝试的结果。stale = 期间会话变了，结果没有安装（不是密码错误）。 */
export type UnlockResult = "unlocked" | "wrong-password" | "stale" | "no-doc";

export interface UnlockOptions {
	/** 调用方的取消信号（解锁弹窗被关闭）：返回 true 时结果不安装 */
	cancelled?: () => boolean;
}

/** 依赖注入（测试用）：可控完成顺序的密钥解包函数。 */
export interface KeyringDeps {
	unwrap?: (doc: VaultKeyDoc, password: string) => Promise<CryptoKey | null>;
}

/** 两份文档是否包着同一份密钥材料（wrappedKey + salt）。 */
function sameKeyMaterial(a: VaultKeyDoc | null, b: VaultKeyDoc | null): boolean {
	return a !== null && b !== null && a.wrappedKey === b.wrappedKey && a.salt === b.salt;
}

/**
 * 密钥环：持有 vault key 文档与内存中的已解锁 VMK。
 * 明文 VMK 只存在于不可导出的 CryptoKey 句柄中，永不落盘、永不上传。
 *
 * 0.20.1（复审 PL-01）：两个递增代次，异步结果在安装前都要核对。
 *
 * - **密钥会话代次** `generation`：锁定、密钥材料变化的 setDoc、采纳新钥匙、换连接、卸载时递增。
 *   解锁（PBKDF2 要几百毫秒）与元数据密钥派生完成时，若代次已变 → 结果作废，绝不安装。
 *   否则「锁定」会被晚到的解锁撤销，切库后内存钥匙与当前文档不一致。
 * - **连接上下文代次** `contextGeneration`：服务器 / 凭据 / 目标仓库 / 接入关系变化时递增
 *   （同时递增密钥会话代次）。从服务器取回的东西（密钥文档等）安装前核对它，
 *   旧连接取回的结果一律丢弃。
 *
 * 另外，多次解锁按**发起顺序**安装：后发起的已经安装，先发起的晚到结果作废（不回退）。
 * 严格模式下这里从不持久化任何可自动还原 VMK 的材料——竞态靠代次解决，不靠「存下来再说」。
 */
export class Keyring {
	private vmk: CryptoKey | null = null;
	private currentDoc: VaultKeyDoc | null = null;
	private cachedMetaKeys: MetaKeys | null = null;
	private gen = 0;
	private ctxGen = 0;
	/** 解锁尝试的发起序号与最近一次安装的序号（按发起顺序安装，不回退） */
	private attemptSeq = 0;
	private installedAttempt = 0;
	private disposed = false;
	private readonly unwrap: (doc: VaultKeyDoc, password: string) => Promise<CryptoKey | null>;

	constructor(deps: KeyringDeps = {}) {
		this.unwrap = deps.unwrap ?? unlockVaultKey;
	}

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

	/** 密钥会话代次（见类注释）。 */
	get generation(): number {
		return this.gen;
	}

	/** 连接上下文代次（见类注释）。 */
	get contextGeneration(): number {
		return this.ctxGen;
	}

	/** 已卸载：之后的一切解锁都作废。 */
	get isDisposed(): boolean {
		return this.disposed;
	}

	private dropKey(): void {
		this.vmk = null;
		this.cachedMetaKeys = null;
	}

	/** 更新文档；密钥材料变化时使已解锁的 VMK 失效，并作废进行中的解锁与派生。 */
	setDoc(doc: VaultKeyDoc | null): void {
		const same = sameKeyMaterial(doc, this.currentDoc) || (doc === null && this.currentDoc === null);
		this.currentDoc = doc;
		if (!same) {
			this.gen++;
			this.dropKey();
		}
	}

	/**
	 * 迁移流程中直接采用已解锁的密钥（新的密钥会话：进行中的解锁与派生作废）。
	 *
	 * expectContext：调用方在流程开始时记下的连接上下文代次。流程里有网络往返
	 * （取文档 → 解包 / 生成 → 上传），期间换了服务器、凭据或仓库，就不能把旧连接上
	 * 取回的文档与钥匙装进来。
	 */
	adopt(doc: VaultKeyDoc, vmk: CryptoKey, expectContext?: number): void {
		if (this.disposed) throw new KeySessionChangedError();
		if (expectContext !== undefined && expectContext !== this.ctxGen) throw new KeySessionChangedError();
		this.gen++;
		this.currentDoc = doc;
		this.vmk = vmk;
		this.cachedMetaKeys = null;
	}

	/**
	 * 用密码解锁当前文档。PBKDF2 期间会话一旦变化（锁定、换文档、换连接、卸载、调用方取消，
	 * 或一个更晚发起的解锁已经装好了钥匙），结果作废并返回 stale——钥匙不安装、也不报「密码错误」。
	 */
	async unlock(password: string, opts: UnlockOptions = {}): Promise<UnlockResult> {
		const doc = this.currentDoc;
		if (doc === null) return "no-doc";
		if (this.disposed) return "stale";
		const startGen = this.gen;
		const attempt = ++this.attemptSeq;
		const key = await this.unwrap(doc, password);
		if (
			this.disposed ||
			startGen !== this.gen ||
			!sameKeyMaterial(doc, this.currentDoc) ||
			attempt < this.installedAttempt ||
			opts.cancelled?.() === true
		) {
			return "stale";
		}
		if (key === null) return "wrong-password";
		this.vmk = key;
		this.cachedMetaKeys = null;
		this.installedAttempt = attempt;
		return "unlocked";
	}

	/**
	 * 用可恢复密钥持久化材料还原的原始 VMK 解锁（raw 由调用方负责清零）。
	 * 同样核对代次：导入期间会话变了 → 不安装，返回 false。
	 */
	async unlockWithRaw(raw: Uint8Array): Promise<boolean> {
		if (this.disposed) return false;
		const startGen = this.gen;
		const doc = this.currentDoc;
		const key = await importVmk(raw);
		const sameDoc = doc === null ? this.currentDoc === null : sameKeyMaterial(doc, this.currentDoc);
		if (this.disposed || startGen !== this.gen || !sameDoc) return false;
		this.vmk = key;
		this.cachedMetaKeys = null;
		this.installedAttempt = ++this.attemptSeq;
		return true;
	}

	/** 锁定：丢弃钥匙，并让一切进行中的解锁与派生作废。 */
	lock(): void {
		this.gen++;
		this.dropKey();
	}

	/**
	 * 作废进行中的解锁与派生，但**保留**已安装的钥匙。
	 *
	 * 用于「同一仓库、凭据变了」：v0.18 起重置 Token 后的恢复路径要求钥匙原样保留
	 * （填新 Token → 测试连接 → 继续同步，不必重新输入仓库密码）。真正换了仓库时，
	 * vaultId 对账（adoptRepoIdentity）与密钥文档刷新会再锁定。
	 */
	invalidatePending(): void {
		this.gen++;
	}

	/**
	 * 连接上下文变化（换服务器 / 换凭据 / 切库 / 导入新连接 / 重新接入）。
	 * lock=true 时同时锁定并丢弃缓存的密钥文档——旧仓库的钥匙与文档绝不跟到新仓库。
	 */
	switchContext(opts: { lock: boolean }): void {
		this.ctxGen++;
		this.gen++;
		if (opts.lock) {
			this.dropKey();
			this.currentDoc = null;
		}
	}

	/** 插件卸载：锁定并拒绝之后的一切安装。 */
	dispose(): void {
		this.disposed = true;
		this.ctxGen++;
		this.gen++;
		this.dropKey();
	}

	requireKey(): CryptoKey {
		if (!this.vmk) throw new E2eeLockedError();
		return this.vmk;
	}

	/** 重置凭证（v0.18）：未解锁返回 null（不该为了登记去打扰用户解锁）；派生期间会话变了同样返回 null。 */
	async resetAuth(): Promise<string | null> {
		const vmk = this.vmk;
		if (!vmk) return null;
		const startGen = this.gen;
		const raw = await exportVmkRaw(vmk);
		try {
			const value = await deriveResetAuth(raw);
			return startGen === this.gen && this.vmk === vmk ? value : null;
		} finally {
			raw.fill(0);
		}
	}

	/**
	 * 元数据密钥（v9.3 三期）：HKDF 从 VMK 派生，懒加载缓存。
	 * VMK 原始字节仅在派生瞬间存在，用完立即清零。
	 *
	 * 派生是异步的：期间被锁定或换了钥匙，晚到的派生结果**绝不**写进缓存
	 * （否则锁定后再解锁另一个仓库，会拿着旧仓库的元数据密钥去加解密路径）。
	 */
	async metaKeys(): Promise<MetaKeys> {
		const vmk = this.vmk;
		if (!vmk) throw new E2eeLockedError();
		if (this.cachedMetaKeys) return this.cachedMetaKeys;
		const startGen = this.gen;
		const raw = await exportVmkRaw(vmk);
		let keys: MetaKeys;
		try {
			keys = await deriveMetaKeys(raw);
		} finally {
			raw.fill(0);
		}
		if (startGen !== this.gen || this.vmk !== vmk) throw new KeySessionChangedError();
		this.cachedMetaKeys = keys;
		return keys;
	}
}
