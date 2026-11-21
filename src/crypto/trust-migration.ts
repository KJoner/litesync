/**
 * 严格会话解锁与旧「信任此设备」迁移（v0.20 / ADR-013）。
 *
 * 0.19 及更早默认 trustDevice=true：解锁后把 VMK 用随机设备密钥包装，
 * 设备密钥进 data.json、包装 blob 进 SecretStorage，下次启动自动解锁。
 * 密码确实没存，但「能在本设备上自动还原 VMK 的材料」被持久化了。
 *
 * 0.20 起新安装默认严格会话解锁。存量设备不能一升级就删材料——对忘了密码的
 * 用户，那可能是世界上唯一还能解开这个仓库的东西。所以必须先**证明**能用密码
 * 恢复**同一把** VMK，再清理：
 *
 *   legacy_trust_found
 *     │ a. 输入密码 → 解开服务端 keyDoc → 与信任材料解出的 VMK 逐字节相同
 *     │ b. 忘记密码 → 用信任材料解出的同一 VMK 以新密码重包装 → CAS 上传
 *     │    → 重新下载 → 用新密码试解 → 逐字节相同
 *     ▼
 *   recovery_proven
 *     │ 队列为空，或待发操作已在 durable journal 中（StateStore 健康）
 *     ▼
 *   pending_writes_handled
 *     │ 先落盘 clearing 标记 → 清 SecretStorage 包装 → 清 deviceKeyB64 → trustDevice=false
 *     ▼
 *   strict_mode
 *
 * 另有 user_kept：用户**显式**选择保留本设备自动解锁（可恢复密钥持久化模式）。
 *
 * 本模块只含逻辑：所有 I/O（服务器、SecretStorage、data.json、队列）经依赖注入，
 * 以便在测试里逐个失败点地验证「任何阶段都不会既删了唯一钥匙又没留恢复路径」。
 */
import { exportVmkRaw, unlockVaultKey, VaultKeyDoc, b64decode, wrapVmkIntoKeyDoc } from "./crypto";
import {
	keyIdOf,
	SecretStore,
	trustBlobKeyId,
	unwrapVmkForDevice,
	VAULT_KEY_SECRET_ID,
	wrapVmkForDevice,
} from "./device-trust";

/** 当前密钥策略版本：2 = 已按 0.20 严格解锁策略处理过本设备的设置。 */
export const KEY_POLICY_VERSION = 2;

export type TrustMigrationState =
	| "legacy_trust_found"
	| "recovery_proven"
	| "pending_writes_handled"
	| "clearing"
	| "strict_mode"
	| "user_kept";

/** 失败原因（机器可读；不含任何秘密）。UI 据此给出下一步，而不是解析文案。 */
export type TrustMigrationError =
	| "wrong-password"
	| "vmk-mismatch"
	| "doc-changed"
	| "material-unreadable"
	| "no-key-doc"
	| "cas-conflict"
	| "verify-failed"
	| "offline"
	| "pending-writes"
	| "state-unhealthy"
	| "invalid-state";

export interface TrustMigrationRecord {
	state: TrustMigrationState;
	/** 检测到旧材料时，信任 blob 绑定的 keyId（keyDoc.wrappedKey 前缀） */
	keyId: string;
	/** 检测时本设备绑定的仓库身份（旧版本未记录时为空，初始化后补齐） */
	vaultIdentity: string;
	detectedAt: number;
	provenAt?: number;
	/** 恢复能力是怎么被证明的；no-usable-material = 旧材料本身已无法解开（没有可保护的东西） */
	method?: "password" | "rewrap" | "no-usable-material";
	handledAt?: number;
	completedAt?: number;
	lastError?: TrustMigrationError;
	/** 一次性说明是否已展示 */
	noticeShown?: boolean;
}

/** 与密钥策略相关的设置字段（PluginSettings 的子集）。 */
export interface TrustSettings {
	trustDevice: boolean;
	deviceKeyB64: string;
	keyPolicyVersion?: number;
	trustMigration?: TrustMigrationRecord | null;
}

/** 迁移仍在进行（界面必须显示「旧设备信任待迁移」，不得宣称严格模式）。 */
export function migrationPending(s: TrustSettings): boolean {
	const st = s.trustMigration?.state;
	return st === "legacy_trust_found" || st === "recovery_proven" || st === "pending_writes_handled" || st === "clearing";
}

/** 用户是否**显式**选择了「可恢复密钥持久化」（区别于旧版本默认开启遗留下来的状态）。 */
export function persistenceExplicit(s: TrustSettings): boolean {
	return s.trustDevice && !migrationPending(s);
}

/**
 * 加载设置时执行一次的策略迁移（keyPolicyVersion < 2）。
 *
 * - 旧材料完整（trustDevice + deviceKeyB64 + 可解析的 SecretStorage blob）→
 *   进入 legacy_trust_found，**本次运行照常自动解锁**，不打断同步；
 * - 旧设置开着 trustDevice 但材料不完整 → 直接改为严格模式：缺了一半的材料
 *   本来就还原不出 VMK，删掉它不会让任何人失去访问；
 * - 新安装 → 什么都不用做（默认已是严格）。
 *
 * 返回是否修改了设置（调用方据此落盘）。
 */
export function applyKeyPolicy(
	settings: TrustSettings,
	secrets: SecretStore,
	opts: { vaultIdentity: string; now: number },
): boolean {
	if ((settings.keyPolicyVersion ?? 0) >= KEY_POLICY_VERSION) return false;
	const blob = secrets.getSecret(VAULT_KEY_SECRET_ID);
	const blobKeyId = trustBlobKeyId(blob);
	const hasMaterial = settings.trustDevice && settings.deviceKeyB64 !== "" && blobKeyId !== null;
	if (hasMaterial) {
		settings.trustMigration = {
			state: "legacy_trust_found",
			keyId: blobKeyId,
			vaultIdentity: opts.vaultIdentity,
			detectedAt: opts.now,
		};
	} else {
		// 半套材料：设备密钥或包装 blob 单独都还原不出 VMK——不是恢复来源，清掉
		if (settings.deviceKeyB64 !== "") settings.deviceKeyB64 = "";
		if (blob) secrets.setSecret(VAULT_KEY_SECRET_ID, "");
		settings.trustDevice = false;
		settings.trustMigration = null;
	}
	settings.keyPolicyVersion = KEY_POLICY_VERSION;
	return true;
}

/** 迁移所需的 I/O（main.ts 组装；测试用内存替身）。 */
export interface TrustMigrationDeps {
	settings: TrustSettings;
	saveSettings(): Promise<void>;
	secrets: SecretStore;
	/** 服务器当前 keyDoc 与 CAS 指纹；离线时抛错；未启用 E2EE 返回 null */
	fetchKeyDoc(): Promise<{ doc: VaultKeyDoc; fingerprint: string } | null>;
	/** CAS 替换 keyDoc（replace=true + X-Expected-Fingerprint）；指纹不符抛 {status:412} */
	replaceKeyDoc(doc: VaultKeyDoc, fingerprint: string): Promise<void>;
	/** 本地缓存的 keyDoc（离线时 a 分支用） */
	cachedKeyDoc(): VaultKeyDoc | null;
	/** 重包装上传成功后：更新本地 keyDoc 缓存与密钥环（保持解锁、作废绑定） */
	onKeyDocReplaced(doc: VaultKeyDoc, vmkRaw: Uint8Array): Promise<void>;
	/** 待推送队列状态：条目数，以及它们是否已在 durable journal 中（StateStore 健康且已落盘） */
	pendingWrites(): Promise<{ count: number; durable: boolean }>;
	/** 尽力排空队列（在线且已解锁时跑一轮完整同步）；失败不抛 */
	drainQueue?(): Promise<void>;
	now(): number;
}

export type StepResult = { ok: true; state: TrustMigrationState } | { ok: false; error: TrustMigrationError };

/** 常量时间比较（长度不同直接 false——长度本身不是秘密）。 */
export function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

function record(deps: TrustMigrationDeps): TrustMigrationRecord | null {
	return deps.settings.trustMigration ?? null;
}

async function fail(deps: TrustMigrationDeps, error: TrustMigrationError): Promise<StepResult> {
	const r = record(deps);
	if (r) {
		r.lastError = error;
		await deps.saveSettings();
	}
	return { ok: false, error };
}

/**
 * 用旧信任材料还原 VMK（按 blob **自己记录**的 keyId 解，而不是当前服务端文档的）。
 *
 * 用 blob 自己的 keyId：信任材料证明的是「本设备持有 VMK X」，与服务器此刻的
 * 文档无关；证明 X 与服务端文档里的是同一把，是下一步比较的事。
 */
async function unwrapLegacy(deps: TrustMigrationDeps): Promise<Uint8Array | null> {
	const r = record(deps);
	if (!r || deps.settings.deviceKeyB64 === "") return null;
	const blob = deps.secrets.getSecret(VAULT_KEY_SECRET_ID);
	if (!blob) return null;
	let deviceKey: Uint8Array;
	try {
		deviceKey = b64decode(deps.settings.deviceKeyB64);
	} catch {
		return null;
	}
	try {
		return await unwrapVmkForDevice(deviceKey, blob, trustBlobKeyId(blob) ?? r.keyId);
	} finally {
		deviceKey.fill(0);
	}
}

/** 旧材料已经解不开（损坏/篡改/只剩一半）：它不是恢复来源，清理不会让任何人失去访问。 */
async function markNoUsableMaterial(deps: TrustMigrationDeps): Promise<StepResult> {
	const r = record(deps)!;
	r.state = "recovery_proven";
	r.method = "no-usable-material";
	r.provenAt = deps.now();
	r.lastError = undefined;
	await deps.saveSettings();
	return { ok: true, state: r.state };
}

/**
 * 分支 a：用户输入仓库密码，证明它能解开服务端 keyDoc 并得到与信任材料**相同**的 VMK。
 * 离线时退而使用本地缓存的 keyDoc（它与服务端一致的前提在下一轮同步的绑定校验里复核）。
 */
export async function proveByPassword(deps: TrustMigrationDeps, password: string): Promise<StepResult> {
	const r = record(deps);
	if (!r || (r.state !== "legacy_trust_found" && r.state !== "recovery_proven")) return fail(deps, "invalid-state");
	const legacy = await unwrapLegacy(deps);
	if (legacy === null) return markNoUsableMaterial(deps);
	try {
		let doc: VaultKeyDoc | null = null;
		try {
			doc = (await deps.fetchKeyDoc())?.doc ?? null;
		} catch {
			doc = deps.cachedKeyDoc();
			if (doc === null) return fail(deps, "offline");
		}
		if (doc === null) return fail(deps, "no-key-doc");
		const key = await unlockVaultKey(doc, password);
		if (key === null) return fail(deps, "wrong-password");
		const pwRaw = await exportVmkRaw(key);
		try {
			if (!bytesEqualConstantTime(pwRaw, legacy)) return fail(deps, "vmk-mismatch");
		} finally {
			pwRaw.fill(0);
		}
		r.state = "recovery_proven";
		r.method = "password";
		r.provenAt = deps.now();
		r.lastError = undefined;
		await deps.saveSettings();
		return { ok: true, state: r.state };
	} finally {
		legacy.fill(0);
	}
}

/**
 * 分支 b：用户忘了仓库密码，但本设备的旧材料还能解开 VMK。
 *
 * 用**同一把** VMK 以新密码重包装：绝不生成新随机 VMK——那会让服务器上全部
 * 已有密文永久不可读。重包装前要求服务端文档仍是旧材料绑定的那一份
 *（keyId 相同）：文档已被换过时，我们无法在没有密码的情况下确认它包着的是不是
 * 同一把 VMK，盲目覆盖可能把别的设备刚轮换的新密钥冲掉。
 *
 * 上传成功后立刻把本设备的旧材料重新绑定到新文档（材料种类不变、仍是同一把 VMK），
 * 保证「试解失败」时用户依然能在本设备上自动解锁——先证明、后清理的顺序不能因为
 * 中途换了文档而被打破。
 */
export async function proveByRewrap(deps: TrustMigrationDeps, newPassword: string): Promise<StepResult> {
	const r = record(deps);
	if (!r || r.state !== "legacy_trust_found") return fail(deps, "invalid-state");
	const legacy = await unwrapLegacy(deps);
	if (legacy === null) return fail(deps, "material-unreadable");
	try {
		let current: { doc: VaultKeyDoc; fingerprint: string } | null;
		try {
			current = await deps.fetchKeyDoc();
		} catch {
			return fail(deps, "offline");
		}
		if (current === null) return fail(deps, "no-key-doc");
		const blobKeyId = trustBlobKeyId(deps.secrets.getSecret(VAULT_KEY_SECRET_ID)) ?? r.keyId;
		if (keyIdOf(current.doc) !== blobKeyId) return fail(deps, "doc-changed");

		const next = await wrapVmkIntoKeyDoc(newPassword, legacy, current.doc);
		try {
			await deps.replaceKeyDoc(next, current.fingerprint);
		} catch (e) {
			const status = (e as { status?: number } | null)?.status;
			if (status === 412 || status === 409) return fail(deps, "cas-conflict");
			return fail(deps, "offline");
		}
		// 服务端文档已换：旧材料按新 keyId 重绑（同一把 VMK、同一个设备密钥），安全网不断
		const deviceKey = b64decode(deps.settings.deviceKeyB64);
		try {
			deps.secrets.setSecret(VAULT_KEY_SECRET_ID, await wrapVmkForDevice(deviceKey, legacy, keyIdOf(next)));
		} finally {
			deviceKey.fill(0);
		}
		r.keyId = keyIdOf(next);
		await deps.onKeyDocReplaced(next, legacy);
		await deps.saveSettings();

		// 重新下载并用新密码试解：证明的是「服务器上现在这份」，不是「我刚算出来的那份」
		let fetched: { doc: VaultKeyDoc; fingerprint: string } | null;
		try {
			fetched = await deps.fetchKeyDoc();
		} catch {
			return fail(deps, "offline");
		}
		if (fetched === null) return fail(deps, "verify-failed");
		const key = await unlockVaultKey(fetched.doc, newPassword);
		if (key === null) return fail(deps, "verify-failed");
		const raw = await exportVmkRaw(key);
		try {
			if (!bytesEqualConstantTime(raw, legacy)) return fail(deps, "verify-failed");
		} finally {
			raw.fill(0);
		}
		r.state = "recovery_proven";
		r.method = "rewrap";
		r.provenAt = deps.now();
		r.lastError = undefined;
		await deps.saveSettings();
		return { ok: true, state: r.state };
	} finally {
		legacy.fill(0);
	}
}

/** recovery_proven → pending_writes_handled：未同步的修改要么已推完，要么已在 durable journal 里。 */
export async function handlePendingWrites(deps: TrustMigrationDeps): Promise<StepResult> {
	const r = record(deps);
	if (!r || r.state !== "recovery_proven") return fail(deps, "invalid-state");
	try {
		await deps.drainQueue?.();
	} catch {
		/* 尽力而为：离线或锁定时队列留在 journal 里同样安全 */
	}
	const pw = await deps.pendingWrites();
	if (pw.count > 0 && !pw.durable) return fail(deps, "pending-writes");
	r.state = "pending_writes_handled";
	r.handledAt = deps.now();
	r.lastError = undefined;
	await deps.saveSettings();
	return { ok: true, state: r.state };
}

/**
 * pending_writes_handled / clearing → strict_mode。
 *
 * 先把 clearing 落盘再动材料：崩溃在清理途中，重启看到 clearing 会再清一遍（幂等），
 * 不会出现「材料删了一半、状态却说还没开始」的分叉。
 */
export async function clearLegacyMaterial(deps: TrustMigrationDeps): Promise<StepResult> {
	const r = record(deps);
	if (!r || (r.state !== "pending_writes_handled" && r.state !== "clearing")) return fail(deps, "invalid-state");
	if (r.state !== "clearing") {
		r.state = "clearing";
		await deps.saveSettings();
	}
	deps.secrets.setSecret(VAULT_KEY_SECRET_ID, "");
	deps.settings.deviceKeyB64 = "";
	deps.settings.trustDevice = false;
	if (deps.secrets.getSecret(VAULT_KEY_SECRET_ID)) return fail(deps, "state-unhealthy");
	r.state = "strict_mode";
	r.completedAt = deps.now();
	r.lastError = undefined;
	await deps.saveSettings();
	return { ok: true, state: r.state };
}

/** 从当前状态把不需要用户输入的步骤一路推到底（证明之后的两步）。 */
export async function advanceAfterProof(deps: TrustMigrationDeps): Promise<StepResult> {
	let r = record(deps);
	if (r?.state === "recovery_proven") {
		const step = await handlePendingWrites(deps);
		if (!step.ok) return step;
		r = record(deps);
	}
	if (r?.state === "pending_writes_handled" || r?.state === "clearing") return clearLegacyMaterial(deps);
	return r ? { ok: true, state: r.state } : { ok: false, error: "invalid-state" };
}

/** 用户显式选择保留本设备自动解锁（可恢复密钥持久化模式）。 */
export async function keepLegacyTrust(deps: TrustMigrationDeps): Promise<StepResult> {
	const r = record(deps);
	if (!r || r.state !== "legacy_trust_found") return fail(deps, "invalid-state");
	r.state = "user_kept";
	r.lastError = undefined;
	await deps.saveSettings();
	return { ok: true, state: r.state };
}

/** 给界面的一句话状态（「设备已授权」与「仓库已解锁」由调用方另外显示）。 */
export function keyPolicyLabel(s: TrustSettings): string {
	if (migrationPending(s)) return "旧设备信任待迁移：本设备仍保存着可自动解锁的密钥材料";
	if (s.trustDevice) return "本设备自动解锁（你选择了可恢复密钥持久化）";
	return "严格会话解锁：密码只在本次运行中使用，重启或锁定后需要重新输入";
}

/** 失败原因 → 用户能看懂的下一步。 */
export function trustMigrationErrorText(e: TrustMigrationError): string {
	switch (e) {
		case "wrong-password":
			return "密码不正确。可以重试；如果确实忘了，请改用「忘记密码？在本设备上设置新密码」。";
		case "vmk-mismatch":
			return "这个密码能解开服务器上的仓库密钥，但它与本设备保存的不是同一把——服务器上的仓库密钥已经更换过。迁移已停止，本设备的旧材料保持不变。";
		case "doc-changed":
			return "服务器上的仓库密钥文档已被更换，无法在没有密码的情况下确认它与本设备保存的是同一把密钥。请改用当前的仓库密码验证，或在另一台已解锁的设备上操作。";
		case "material-unreadable":
			return "本设备保存的旧信任材料已无法解开，不能用它来设置新密码。请用仓库密码验证。";
		case "no-key-doc":
			return "服务器上没有这个仓库的加密密钥文档（仓库未启用端到端加密？）。";
		case "cas-conflict":
			return "上传新密钥文档时发现服务器上的文档刚被别的设备更换，已停止，没有覆盖任何内容。请重新打开迁移再试。";
		case "verify-failed":
			return "新密钥文档已上传，但重新下载后无法用新密码解开同一把密钥。本设备的旧材料保持可用，请重试或联系支持。";
		case "offline":
			return "无法连接服务器。用密码验证可以离线完成（需要本地缓存的密钥文档）；设置新密码必须在线。";
		case "pending-writes":
			return "还有未确认保存的待同步修改，暂不清理旧材料。请先同步一次。";
		case "state-unhealthy":
			return "清理旧材料后校验失败（SecretStorage 中仍有数据），请重启 Obsidian 后重试。";
		case "invalid-state":
			return "迁移状态不允许这一步，请重新打开迁移窗口。";
	}
}
