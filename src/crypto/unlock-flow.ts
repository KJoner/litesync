/**
 * 解锁流程（0.20.1 / 复审 PL-01）。
 *
 * 「点了解锁」到「钥匙装好、开始后续动作」之间有好几段异步：新设备先从服务器取密钥文档、
 * PBKDF2 解包（几百毫秒到数秒，慢设备更久）、显式开启持久化时再包装写入。任何一段期间
 * 用户都可能关掉解锁窗口、锁定、切换仓库、换连接，插件也可能被卸载。
 *
 * 规则：每一段完成后核对「会话还是发起时那一个」，不是就整体作废——钥匙不安装，
 * 文档不写入缓存，后续动作（同步、向导继续）不执行。作废不是错误：界面如实说「已取消，请重新解锁」，
 * 不说「密码错误」。
 *
 * 只含编排，不碰 DOM、不直接发请求，因此「解锁中关闭弹窗」「解锁 A 时切到 B」都能在测试里逐条钉住。
 */
import type { VaultKeyDoc } from "./crypto";
import type { Keyring } from "./keyring";

export interface UnlockFlowDeps {
	keyring: Keyring;
	/** 本设备还没有缓存密钥文档时从服务器取（新设备）；未启用 E2EE 返回 null */
	fetchKeyDoc(): Promise<VaultKeyDoc | null>;
	/** 把取回的文档写进本地缓存并落盘 */
	storeKeyDoc(doc: VaultKeyDoc): Promise<void>;
	/** 钥匙装好之后的动作（用户显式开启持久化时写入本设备材料；严格模式什么都不做） */
	afterUnlocked?(): Promise<void>;
}

export type UnlockFlowFailure = "wrong-password" | "stale" | "no-e2ee" | "offline";

export type UnlockFlowResult = { ok: true } | { ok: false; reason: UnlockFlowFailure; message: string };

export const UNLOCK_STALE_MESSAGE =
	"这次解锁已作废：期间关闭了解锁窗口、锁定、切换了仓库或连接。钥匙没有装入，请重新解锁。";

function stale(): UnlockFlowResult {
	return { ok: false, reason: "stale", message: UNLOCK_STALE_MESSAGE };
}

/**
 * 执行一次解锁。cancelled：调用方的取消信号（解锁窗口已关闭）。
 */
export async function runUnlockFlow(
	deps: UnlockFlowDeps,
	password: string,
	cancelled: () => boolean,
): Promise<UnlockFlowResult> {
	const kr = deps.keyring;
	const context = kr.contextGeneration;
	const changed = (): boolean => cancelled() || kr.isDisposed || kr.contextGeneration !== context;

	if (kr.doc === null) {
		let doc: VaultKeyDoc | null;
		try {
			doc = await deps.fetchKeyDoc();
		} catch (e) {
			if (changed()) return stale();
			return { ok: false, reason: "offline", message: `无法连接服务器：${e instanceof Error ? e.message : String(e)}` };
		}
		// 取回的文档属于发起时的连接：期间换了仓库或连接，就绝不能把它装进来
		if (changed()) return stale();
		if (doc === null) return { ok: false, reason: "no-e2ee", message: "服务器未启用端到端加密" };
		// 另一个流程在此期间已经装好了文档：不覆盖（下面的解锁用当前那一份）
		if (kr.doc === null) {
			kr.setDoc(doc);
			await deps.storeKeyDoc(doc);
			if (changed()) return stale();
		}
	}

	const r = await kr.unlock(password, { cancelled });
	if (r === "stale") return stale();
	if (r === "no-doc") return { ok: false, reason: "no-e2ee", message: "服务器未启用端到端加密" };
	if (r === "wrong-password") return { ok: false, reason: "wrong-password", message: "密码错误" };

	// 钥匙已装好（此后再关窗口不算取消）。之后的动作（显式持久化）要求会话不变；
	// 变了（锁定 / 切库 / 换连接）就不再继续后续流程（同步、向导继续）
	const session = kr.generation;
	await deps.afterUnlocked?.();
	if (kr.generation !== session || kr.isDisposed || kr.contextGeneration !== context) return stale();
	return { ok: true };
}
