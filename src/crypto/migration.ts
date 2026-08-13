/**
 * E2EE 显式迁移（计划书 Phase 12 E2EE Migration）。
 *
 * Enable E2EE → 生成/解锁 Vault Master Key → 重新上传 encrypted current
 * versions → 验证 → 清理明文历史 → 服务器标记 enabled。
 *
 * 红线：
 * - 绝不先删明文再传密文；只有密文下载回验（解密 + hash 一致）后才 purge
 * - 任何失败都可以重新执行（断点续传：已加密的文件跳过重传）
 */
import { ApiError, ConflictError, MigrationValidationError, NotFoundError } from "../api/client";
import { SyncContext } from "../sync/context";
import { requireSyncSafe } from "../sync/gate";
import { e2eeBinding, purgeHistoryOf } from "../sync/transfer";
import { sha256Hex } from "../utils/hash";
import { isFileId, requireFileId, requireKeyEpoch } from "../utils/validate";
import {
	canonicalPathHmac,
	createVaultKeyDoc,
	decryptFile,
	decryptFileV3,
	decryptMeta,
	MetaKeys,
	encryptFile,
	encryptFileV3,
	encryptMeta,
	FileKeyBinding,
	isEncryptedPayload,
	isLegacyEnvelope,
	isLse3Envelope,
	unlockVaultKey,
	VaultKeyDoc,
} from "./crypto";

export interface MigrationProgress {
	total: number;
	done: number;
	current: string;
}

/** 步骤 1（enableE2ee 与空仓启用共用）：获取或创建 vault key 并采纳（支持中断后重新执行）。 */
async function acquireVaultKey(ctx: SyncContext, password: string): Promise<CryptoKey> {
	let doc = await ctx.client.getVaultKey();
	let vmk: CryptoKey;
	if (doc) {
		if (doc.enabled) throw new Error("端到端加密已经启用");
		const key = await unlockVaultKey(doc, password);
		if (!key) throw new Error("密码与服务器上已存在的密钥不匹配（此前的迁移可能被中断，请使用当时的密码）");
		vmk = key;
	} else {
		const created = await createVaultKeyDoc(password);
		doc = created.doc;
		vmk = created.vmk;
		await ctx.client.putVaultKey(doc, false);
	}
	ctx.e2ee.adopt(doc, vmk);
	ctx.store.state.e2ee = doc;
	await ctx.store.save();
	return vmk;
}

/** 最后一步（同上共用）：把 key 文档标记 enabled（CAS，绝不盲目覆盖并发写入）。 */
async function finalizeVaultKeyEnabled(ctx: SyncContext, vmk: CryptoKey): Promise<void> {
	const cur = await ctx.client.getVaultKeyWithFingerprint();
	if (!cur) throw new Error("vault key 文档丢失，请重新启用");
	if (!cur.doc.enabled) {
		const finalDoc: VaultKeyDoc = { ...cur.doc, enabled: true };
		await ctx.client.putVaultKey(finalDoc, true, cur.fingerprint);
		ctx.e2ee.adopt(finalDoc, vmk);
		ctx.store.state.e2ee = finalDoc;
	} else {
		ctx.e2ee.adopt(cur.doc, vmk);
		ctx.store.state.e2ee = cur.doc;
	}
	await ctx.store.save();
}

export async function enableE2ee(
	ctx: SyncContext,
	password: string,
	fullSync: () => Promise<void>,
	onProgress: (p: MigrationProgress) => void,
): Promise<number> {
	requireSyncSafe(ctx, "启用端到端加密");
	if (password.length < 8) throw new Error("密码至少 8 个字符");

	// 1. 获取或创建 vault key（支持中断后重新执行）
	const vmk = await acquireVaultKey(ctx, password);

	// 2. 迁移前必须同步干净：fullSync 等待当前轮 + 所有续轮 + 队列排空（LS-121-C06），
	//    绝不在「只是设置了 runAgain」的状态下开始不可逆迁移
	await fullSync();
	if (ctx.queue.size > 0 || ctx.store.conflictPaths().length > 0) {
		throw new Error("存在未完成的同步或未解决的冲突，请处理后重新启用");
	}

	ctx.gate.beginMigration("端到端加密迁移");
	try {
		return await runE2eeMigration(ctx, vmk, onProgress);
	} finally {
		ctx.gate.endMigration();
	}
}

/** enableE2ee 的迁移主体（在 migration gate 内执行，普通同步会被暂时挡住）。 */
async function runE2eeMigration(
	ctx: SyncContext,
	vmk: CryptoKey,
	onProgress: (p: MigrationProgress) => void,
): Promise<number> {
	const info = await ctx.client.info();
	const serverState = info.encryptionState ?? "plaintext";
	let done = 0;
	if (serverState !== "encrypted") {
		// 3. 服务器进入 migrating（v9 状态机）：从这一刻起服务器冻结一切明文写，
		// 其他旧设备无法在迁移期间把明文写回仓库（它们的上传会被 409 拒绝）
		const state = await ctx.client.e2eeTransition("begin");
		// LSE2/LSE3 绑定材料（v9.2）：迁移产生的密文直接使用新信封。
		// 非法 keyEpoch 立即硬失败（LS-121-C03）——绝不写出解不开的密文
		ctx.store.state.bootstrap.keyEpoch = requireKeyEpoch(state.keyEpoch, "e2ee/begin.keyEpoch");
		if (!ctx.store.state.bootstrap.remoteVaultId && info.vaultId) {
			ctx.store.state.bootstrap.remoteVaultId = info.vaultId;
		}
		await ctx.store.save();
		const binding = e2eeBinding(ctx);

		// 4. 迁移清单 = 服务器一致性快照（v9）：以服务器为权威，
		// 本地 state 缓存里没有的远端文件同样会被加密，不会有漏网明文
		const snap = await ctx.client.snapshot();
		const paths = snap.files.map((f) => f.path).filter((p) => !ctx.ignores(p));

		// 5. 逐文件迁移：加密上传 → 下载回验 → 清理明文历史
		for (const path of paths) {
			onProgress({ total: paths.length, done, current: path });
			await migratePath(ctx, vmk, path, binding);
			done++;
			if (done % 10 === 0) await ctx.store.save();
		}
		await ctx.store.save();

		// 6. 服务器切换到 encrypted：服务端会再次验证所有 HEAD 均为 LSE1 密文，
		// 有任何明文残留都会拒绝——「标记已加密但仓库里还有明文」不可能发生
		await ctx.client.e2eeTransition("complete");
	}

	// 7. 标记 key 文档 enabled（CAS：携带当前指纹，绝不盲目覆盖并发写入的文档）
	await finalizeVaultKeyEnabled(ctx, vmk);
	ctx.log(`e2ee: migration complete, ${done} files encrypted`);
	return done;
}

/**
 * 在**未初始化的空远端**上直接启用 E2EE（首次配置的三选项之一）。
 *
 * 与 {@link enableE2ee} 的区别：此刻 bootstrap 尚未完成（requireSyncSafe 必拦），
 * 服务器上也没有任何文件——没有迁移可做，走「取 key → begin → complete →
 * enabled」即可。之后由调用方完成 local-init 接入，首次上传就是 LSE3 密文，
 * 明文从头到尾不落服务器（对比「先 local-init 再 enableE2ee」的双倍流量 +
 * 明文短暂进服务器 WAL/备份）。
 */
export async function enableE2eeOnEmptyRemote(ctx: SyncContext, password: string): Promise<void> {
	if (ctx.store.corrupted) throw new Error("本地同步状态损坏，无法启用");
	if (password.length < 8) throw new Error("密码至少 8 个字符");
	const info = await ctx.client.info();
	if ((info.latestSequence ?? 0) > 0 || (info.encryptionState ?? "plaintext") !== "plaintext") {
		throw new Error("远端仓库已不是未初始化状态，请改用接入向导");
	}
	const vmk = await acquireVaultKey(ctx, password);
	const state = await ctx.client.e2eeTransition("begin");
	ctx.store.state.bootstrap.keyEpoch = requireKeyEpoch(state.keyEpoch, "e2ee/begin.keyEpoch");
	if (!ctx.store.state.bootstrap.remoteVaultId && info.vaultId) {
		ctx.store.state.bootstrap.remoteVaultId = info.vaultId;
	}
	await ctx.store.save();
	// 快照为空：服务器对 0 个 HEAD 的验证直接放行
	await ctx.client.e2eeTransition("complete");
	await finalizeVaultKeyEnabled(ctx, vmk);
	ctx.log("e2ee: enabled on empty remote (no migration needed)");
}

async function migratePath(
	ctx: SyncContext,
	vmk: CryptoKey,
	path: string,
	binding: FileKeyBinding | undefined,
): Promise<void> {
	let raw;
	try {
		raw = await ctx.client.download(path);
	} catch (e) {
		if (e instanceof NotFoundError) {
			ctx.store.markDeleted(path); // 同步后又被删除，跳过
			return;
		}
		throw e;
	}
	const serverHash = await sha256Hex(raw.data);
	if (raw.hash && serverHash !== raw.hash) {
		throw new Error(`服务器内容 hash 校验失败: ${path}`);
	}

	const tracked = ctx.store.get(path);

	// 断点续传：已是密文 → 验证可解密后清理明文历史即可
	if (isEncryptedPayload(raw.data)) {
		const dec = await decryptAny(vmk, path, raw.data, binding, raw.fileId);
		if (dec === null) throw new Error(`已加密但无法用当前密钥解密: ${path}`);
		ctx.store.update(path, {
			hash: await sha256Hex(dec.plain),
			serverHash,
			revision: raw.revision,
			mtime: tracked?.mtime ?? Date.now(),
			size: dec.plain.byteLength,
			fileId: raw.fileId,
			generation: dec.generation,
		});
		await purgeHistoryOf(ctx, path, raw.revision);
		return;
	}

	// 加密（LSE3：fileId 来自服务器为明文时代分配的稳定身份，generation 从 1 开始）
	// binding 不可用时回退 LSE1（升级过渡；正常情况下 begin 之后一定可用）
	const plain = raw.data;
	const plainHash = await sha256Hex(plain);
	let payload: ArrayBuffer;
	let generation: number | undefined;
	if (binding && raw.fileId) {
		generation = 1;
		payload = await encryptFileV3(vmk, { ...binding, fileId: raw.fileId, generation }, plain);
	} else {
		payload = await encryptFile(vmk, path, plain, binding);
	}
	const cipherHash = await sha256Hex(payload);
	const res = await ctx.client.upload(path, raw.revision, cipherHash, payload, raw.mtime, "upsert");

	// 红线：只有密文完整验证（下载回 → 解密 → 明文 hash 一致）后才清理明文
	const check = await ctx.client.download(path);
	if ((await sha256Hex(check.data)) !== cipherHash) {
		throw new Error(`密文回读与上传不一致: ${path}`);
	}
	const dec = await decryptAny(vmk, path, check.data, binding, check.fileId ?? raw.fileId);
	if (dec === null || (await sha256Hex(dec.plain)) !== plainHash) {
		throw new Error(`密文解密验证失败: ${path}`);
	}

	ctx.store.update(path, {
		hash: plainHash,
		serverHash: cipherHash,
		revision: res.revision,
		mtime: tracked?.mtime ?? Date.now(),
		size: plain.byteLength,
		fileId: res.fileId ?? raw.fileId,
		generation,
	});
	await purgeHistoryOf(ctx, path, res.revision);
}

export interface MetaEncryptionOptions {
	onProgress: (p: MigrationProgress) => void;
	/** 等待同步彻底收敛（SyncManager.fullSync；LS-121-C06） */
	fullSync: () => Promise<void>;
	/**
	 * 是否允许执行不可逆的 complete（明文路径抹除）。
	 *
	 * 默认 **false**（LS-121-C01）：协议 v6 已经能在保住删除屏障的前提下抹除
	 * 明文（tombstone 转隐私格式而不是删除，ADR-002），但抹除本身仍然不可逆，
	 * 且迁移前备份里还留着明文路径。因此仍需显式开关，正式使用前必须完成
	 * 计划书 §十五 的整套升级流程。
	 */
	allowIrreversibleComplete: boolean;
}

export interface MetaEncryptionResult {
	migrated: number;
	/** 转换为隐私格式的删除记录数（**不是**删除数量——tombstone 一条都不丢） */
	convertedTombstones: number;
	total: number;
	/** 结束时仓库的元数据状态：migrating = 已伪名化但尚未抹除明文（可 abort 回退） */
	metaState: string;
	/** 是否执行了不可逆的明文抹除 */
	erased: boolean;
}

/**
 * 元数据加密迁移（协议 v6 / ADR-002 + ADR-003）：把服务器上的明文路径全部替换为
 * 伪名（=fileId）+ LSM1 加密元数据。内容零重新加密（LSE3 已把内容与路径解耦）。
 *
 * 流程：begin → 逐对象伪名化 → tombstone 转隐私格式 → verify → （可选）complete。
 *
 * 红线：
 * - 前置：过同步安全 gate、E2EE 已启用且解锁、fullSync 收敛、无未解决冲突、
 *   仓库信封下限已是 LSE3（否则服务器拒绝 begin，提示先跑「升级加密信封」）
 * - 断点续传：任何一步失败都可重新执行整个命令（服务端 journal 记录进度）
 * - **tombstone 是转换而不是删除**：删除屏障完整保留（INV-06）
 * - verify 与 complete 分离：验证失败时数据一个字节都没动
 * - complete 是明文路径抹除的单向点，默认不执行（LS-121-C01）
 */
export async function encryptMetadata(ctx: SyncContext, opts: MetaEncryptionOptions): Promise<MetaEncryptionResult> {
	const { onProgress } = opts;
	requireSyncSafe(ctx, "加密路径与文件名");
	if (!ctx.e2ee.enabled) throw new Error("请先启用端到端加密");
	const bind = e2eeBinding(ctx);
	if (!bind) throw new Error("缺少 vaultId/keyEpoch 绑定材料，请先完成一次正常同步后重试");

	// 0. 迁移前必须同步干净：fullSync 等待当前轮 + 所有续轮 + 队列排空（LS-121-C06）。
	//    必须在 beginMigration **之前**——迁移 gate 一旦置位，普通同步就会被挡下
	await opts.fullSync();
	if (ctx.queue.size > 0 || ctx.store.conflictPaths().length > 0) {
		throw new Error("存在未完成的同步或未解决的冲突，请处理后重试");
	}

	ctx.gate.beginMigration("路径与文件名加密迁移");
	try {
		const keys = await ctx.e2ee.metaKeys();

		// 1. 进入 migrating。服务器要求 encryptionState=encrypted 且信封下限已是 LSE3——
		//    否则伪名化后会留下无法按 fileId 解密的旧信封内容
		let status = await ctx.client.metaTransition("begin");
		adoptMetaState(ctx, status.metaState);
		await ctx.store.save();

		// 2. 逐对象伪名化。v6 的迁移只是一次元数据更新：revision、
		//    contentGeneration、blob 全部不动，**不产生任何 tombstone**
		const snap = await ctx.client.snapshot();
		const pending = snap.files.filter((f) => f.fileId !== f.path);
		let migrated = 0;
		let done = 0;
		for (const f of pending) {
			onProgress({ total: pending.length + status.plaintextTombstones, done: done++, current: f.path });
			const fileId = requireFileId(f.fileId, `snapshot(${f.path}).fileId`);
			const metaEnc = await encryptMeta(
				keys,
				{ vaultId: bind.vaultId, keyEpoch: bind.keyEpoch, fileId, metaGeneration: 1 },
				{ path: f.path },
			);
			const canonicalHash = await canonicalPathHmac(keys, f.path);
			let res;
			try {
				res = await ctx.client.migrateObjectMeta(f.path, metaEnc, canonicalHash);
			} catch (e) {
				// 机器错误码分支（LS-121-S05）：绝不靠 message.includes 判断逻辑
				if (e instanceof ApiError && (e.is("PLAINTEXT_REJECTED") || e.is("ENVELOPE_TOO_OLD"))) {
					throw new Error(`存在旧信封密文（${f.path}），请先执行「升级加密信封 LSE1 → LSE3」后重试`);
				}
				throw e;
			}
			if (ctx.store.get(f.path)) {
				ctx.store.update(f.path, {
					fileId,
					revision: res.revision,
					metaGeneration: res.metaGeneration,
					serverPseudonym: res.toPath,
				});
			}
			migrated++;
			if (migrated % 10 === 0) await ctx.store.save();
		}
		await ctx.store.save();

		// 3. tombstone 转成隐私格式（ADR-002 §3.2）——**转换而不是删除**。
		//    v0.12.0 靠删掉 tombstone 来抹明文，代价是旧设备重新上线会复活已删内容。
		const tombstones = await ctx.client.listPlaintextTombstones();
		let convertedTombstones = 0;
		for (const t of tombstones) {
			onProgress({
				total: pending.length + tombstones.length,
				done: done++,
				current: t.lastPseudonym,
			});
			await ctx.client.migrateTombstone(t.fileId, await canonicalPathHmac(keys, t.lastPseudonym));
			convertedTombstones++;
		}

		// 4. 进入 verifying：此后不再接受迁移写入，只接受验证与 complete。
		//    验证与不可逆擦除彻底分离——验证失败时数据一个字节都没动
		status = await ctx.client.metaTransition("verify");
		adoptMetaState(ctx, status.metaState);
		await ctx.store.save();

		// 5a. **客户端全量回验**（计划书 §5.5）。
		//
		// 服务端验证器只能看到自己的库——它无法证明「这些密文我们真的解得开」。
		// 因此在 complete 之前，客户端必须拿 cutoff 之后的权威 Snapshot，
		// 对**每一个** live 对象亲自解一遍元数据并核对身份与世代。
		// 任一失败就中止：状态停在 verifying，可 abort 也可修好后重跑。
		await verifyMigrationClientSide(ctx, keys, bind, status.cutoffSequence, onProgress);

		// 5b. 服务端 11 项验证器（不改状态）
		const check = await ctx.client.validateMetaMigration();
		if (!check.ok) {
			throw new MigrationValidationError(check.failures);
		}

		const result: MetaEncryptionResult = {
			migrated,
			convertedTombstones,
			total: snap.files.length,
			metaState: status.metaState,
			erased: false,
		};

		// 6. 明文路径抹除（单向点）——默认不执行（LS-121-C01）
		if (!opts.allowIrreversibleComplete) {
			ctx.log(
				`meta encryption: ${migrated} objects + ${convertedTombstones} tombstones migrated, ` +
					`erase skipped (experimental build gate)`,
			);
			return result;
		}
		const final = await ctx.client.metaTransition("complete", true, status.migrationId);
		adoptMetaState(ctx, final.metaState);
		ctx.store.state.bootstrap.formatEpoch = final.formatEpoch;
		// formatEpoch 变了 → 服务器强制全量对账，本地游标作废
		ctx.store.state.lastSequence = 0;
		await ctx.store.save();
		ctx.log(`meta encryption complete: formatEpoch=${final.formatEpoch}, plaintext paths erased`);
		return { ...result, metaState: final.metaState, erased: true };
	} finally {
		ctx.gate.endMigration();
	}
}

/**
 * 客户端全量回验（计划书 §5.5）。
 *
 * 步骤：拉取权威 Snapshot → 逐对象 decryptMeta → 校验 fileId / keyEpoch /
 * metaGeneration → 校验内容信封版本。任一失败抛错，迁移保持可续传。
 *
 * 为什么不能只信服务端 validator：服务器验证的是「字段看起来对不对」，
 * 而这里验证的是「我们手上的密钥真的能解开它」。前者通过、后者失败的仓库
 * 一旦 complete 抹掉明文，就永久读不回来了。
 */
async function verifyMigrationClientSide(
	ctx: SyncContext,
	keys: MetaKeys,
	bind: FileKeyBinding,
	cutoffSequence: number,
	onProgress: (p: MigrationProgress) => void,
): Promise<void> {
	const snap = await ctx.client.snapshot();
	if (snap.sequence < cutoffSequence) {
		throw new Error(
			`服务器快照（sequence ${snap.sequence}）早于迁移起点（${cutoffSequence}），已中止——` +
				`请重试，不要在这种状态下抹除明文路径`,
		);
	}
	const failures: string[] = [];
	let done = 0;
	for (const f of snap.files) {
		onProgress({ total: snap.files.length, done: done++, current: `验证 ${f.fileId ?? "?"}` });

		if (!isFileId(f.fileId)) {
			failures.push(`非法 fileId：${String(f.fileId).slice(0, 12)}`);
			continue;
		}
		if (f.path !== f.fileId) {
			failures.push(`${f.fileId.slice(0, 8)}：服务器仍以非伪名寻址`);
			continue;
		}
		if (!f.metaEnc) {
			failures.push(`${f.fileId.slice(0, 8)}：缺少加密元数据`);
			continue;
		}
		const dec = await decryptMeta(keys, f.metaEnc, bind.vaultId, f.fileId);
		if (dec === null) {
			// 这正是服务端验证器看不到的那一类失败
			failures.push(`${f.fileId.slice(0, 8)}：本设备无法解密其元数据`);
			continue;
		}
		if (dec.keyEpoch !== bind.keyEpoch) {
			failures.push(`${f.fileId.slice(0, 8)}：元数据密钥世代为 ${dec.keyEpoch}，当前为 ${bind.keyEpoch}`);
		}
		if (f.metaGeneration !== undefined && dec.metaGeneration !== f.metaGeneration) {
			failures.push(
				`${f.fileId.slice(0, 8)}：metaGeneration 不一致（密文内 ${dec.metaGeneration} vs 服务器 ${f.metaGeneration}）`,
			);
		}
		if (f.envelopeVersion !== undefined && f.envelopeVersion < 3) {
			failures.push(`${f.fileId.slice(0, 8)}：内容仍是旧信封（LSE${f.envelopeVersion || "?"}）`);
		}
		if (failures.length >= 20) break; // 够用来定位问题了，不必刷屏
	}
	if (failures.length > 0) {
		throw new Error(
			`迁移回验未通过（${failures.length} 项），已中止且未做任何抹除；迁移可继续或放弃。` +
				`前几项：${failures.slice(0, 10).join("；")}`,
		);
	}
	ctx.log(`client-side migration verification passed: ${snap.files.length} objects`);
}

/** 采纳服务器返回的元数据状态（同时刷新 gate 相关判断依据）。 */
function adoptMetaState(ctx: SyncContext, metaState: string): void {
	ctx.store.state.bootstrap.metaState = metaState;
}

/** 放弃元数据迁移：回到 plain（已伪名化的行保持可用，无破坏性操作）。 */
export async function abortMetadataMigration(ctx: SyncContext): Promise<string> {
	requireSyncSafe(ctx, "放弃路径加密迁移");
	const st = await ctx.client.metaTransition("abort");
	adoptMetaState(ctx, st.metaState);
	await ctx.store.save();
	ctx.log(`meta migration aborted, metaState=${st.metaState}`);
	return st.metaState;
}

/** 统一解密：LSE3（需 fileId）与 LSE1/LSE2 兼容。 */
async function decryptAny(
	vmk: CryptoKey,
	path: string,
	payload: ArrayBuffer,
	binding: FileKeyBinding | undefined,
	fileId: string | undefined,
): Promise<{ plain: ArrayBuffer; generation?: number } | null> {
	if (isLse3Envelope(payload)) {
		if (!binding?.vaultId || !fileId) return null;
		return decryptFileV3(vmk, payload, binding.vaultId, fileId, binding.keyEpoch);
	}
	const plain = await decryptFile(vmk, path, payload, binding);
	return plain === null ? null : { plain };
}

/**
 * 信封升级（v9.2 引入；v9.3 起目标格式为 LSE3）：把仓库中仍是 LSE1/LSE2 的
 * 密文重新加密为 LSE3（fileId-AAD + generation 抗回退重放，改名不再需重加密）。
 * 密文 → 密文的替换，无明文暴露窗口；单个文件失败（如并发修改 409）跳过，
 * 重新执行命令即可续传。历史版本保留（旧信封历史仍可解密，作 merge-base 用）。
 */
export async function upgradeEnvelopes(
	ctx: SyncContext,
	onProgress: (p: MigrationProgress) => void,
): Promise<{ upgraded: number; skipped: number; total: number }> {
	requireSyncSafe(ctx, "升级加密信封");
	if (!ctx.e2ee.enabled) throw new Error("端到端加密未启用，无需升级信封");
	const vmk = ctx.e2ee.requireKey();
	const binding = e2eeBinding(ctx);
	if (!binding) throw new Error("缺少 vaultId/keyEpoch 绑定材料，请先完成一次正常同步后重试");

	ctx.gate.beginMigration("加密信封升级");
	try {
		return await runEnvelopeUpgrade(ctx, vmk, binding, onProgress);
	} finally {
		ctx.gate.endMigration();
	}
}

async function runEnvelopeUpgrade(
	ctx: SyncContext,
	vmk: CryptoKey,
	binding: FileKeyBinding,
	onProgress: (p: MigrationProgress) => void,
): Promise<{ upgraded: number; skipped: number; total: number }> {
	const snap = await ctx.client.snapshot();
	const files = snap.files.filter((f) => !ctx.ignores(f.path));
	let upgraded = 0;
	let skipped = 0;
	let done = 0;
	for (const f of files) {
		onProgress({ total: files.length, done: done++, current: f.path });
		let raw;
		try {
			raw = await ctx.client.download(f.path);
		} catch (e) {
			if (e instanceof NotFoundError) continue;
			throw e;
		}
		if (!isLegacyEnvelope(raw.data)) continue; // 已是 LSE3（或明文仓库不应到这）
		const fileId = raw.fileId ?? f.fileId;
		if (!fileId) {
			skipped++;
			continue;
		}
		const plain = await decryptFile(vmk, f.path, raw.data, binding);
		if (plain === null) {
			skipped++;
			ctx.log(`envelope upgrade: cannot decrypt ${f.path}, skipped`);
			continue;
		}
		const tracked = ctx.store.get(f.path);
		const generation = (tracked?.fileId === fileId ? (tracked?.generation ?? 0) : 0) + 1;
		const payload = await encryptFileV3(vmk, { ...binding, fileId, generation }, plain);
		const cipherHash = await sha256Hex(payload);
		try {
			const res = await ctx.client.upload(f.path, raw.revision, cipherHash, payload, raw.mtime, "upsert");
			if (tracked) {
				ctx.store.update(f.path, {
					serverHash: cipherHash,
					revision: res.revision,
					fileId,
					generation,
				});
			}
			upgraded++;
		} catch (e) {
			if (e instanceof ConflictError) {
				skipped++; // 并发修改：正常同步会以 LSE3 重新上传，无需处理
				continue;
			}
			throw e;
		}
	}
	await ctx.store.save();

	// 全部升级完成后请服务器提升仓库级信封下限（ADR-006 §2.1）。
	// 提升之后**任何**写入路径——包括新建与删除后重建——都不再接受旧信封，
	// 这正是 v0.12.1 的单对象检查挡不住的那些窗口。
	if (skipped === 0) {
		try {
			const st = await ctx.client.completeEnvelopeUpgrade();
			ctx.store.state.bootstrap.minimumEnvelopeVersion = st.minimumEnvelopeVersion;
			await ctx.store.save();
			ctx.log(`envelope floor raised to ${st.minimumEnvelopeVersion}`);
		} catch (e) {
			// 仍有旧信封内容（例如历史版本对应的 HEAD 尚未刷新）→ 保持现状，
			// 下次重跑本命令时再提升；绝不因此让已完成的升级白做
			ctx.log(`envelope floor not raised yet: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	ctx.log(`envelope upgrade: ${upgraded} upgraded, ${skipped} skipped, ${files.length} total`);
	return { upgraded, skipped, total: files.length };
}
