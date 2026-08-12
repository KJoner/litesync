/**
 * 签名 checkpoint（v0.15.0 / 计划书 §9）。
 *
 * 到 v0.14 为止，客户端能挡住的是「针对某个具体对象的篡改」：换 fileId、
 * 回放旧 generation、同世代分叉。挡不住的是两件事——
 *
 *   1. 服务器**隐瞒**一个你从未见过的文件（没有本地锚点可比）；
 *   2. 服务器对设备 A 和设备 B 展示**两套不同的仓库状态**（分叉 / equivocation）。
 *
 * 这两件事的共同点是：单看一次响应完全合法，问题出在「响应之间的一致性」。
 * 因此需要一个由**设备**（而不是服务器）签名、并且互相链接的状态快照：
 * 服务器可以拒绝转发，但无法伪造，也无法在不被发现的情况下让两条链并存。
 *
 * # 为什么用 ECDSA P-256 而不是 Ed25519
 *
 * Ed25519 在 WebCrypto 里是较晚才普及的算法，Obsidian 需要覆盖桌面 Electron、
 * iOS/Android WebView 等多种运行时，其中相当一部分至今没有 Ed25519。
 * 签名算法选错的代价是「部分设备根本无法参与信任链」——那比签名短几十字节
 * 重要得多。P-256 + SHA-256 在所有目标运行时上都可用，Go 侧也是标准库。
 *
 * # manifest 里没有明文路径
 *
 * checkpoint 只包含 hash 与身份状态。它会被服务器存储和转发，因此哪怕在
 * 元数据加密仓库里，它也绝不能泄露目录结构（计划书 §9.1 最后一句）。
 */

import { b64decode, b64encode } from "./crypto";
import { sha256Hex } from "../utils/hash";
import { encodeUtf8 } from "../utils/text";

/** 每个对象在 checkpoint 里的状态摘要（不含任何路径）。 */
export interface CheckpointObject {
	fileId: string;
	contentGeneration: number;
	metaGeneration: number;
	/** 服务器上的内容 hash（E2EE 下是密文 hash） */
	contentHash: string;
	/** 加密元数据的认证摘要；明文模式为空串 */
	metadataHash: string;
	/** live = 存在；tombstone = 已删除（删除屏障同样要被签名覆盖） */
	state: "live" | "tombstone";
}

/** 一次仓库状态快照（签名前的内容）。 */
export interface CheckpointBody {
	version: 1;
	vaultId: string;
	repoEpoch: string;
	formatEpoch: number;
	keyEpoch: number;
	headSequence: number;
	/** 对所有对象状态摘要求出的根 hash（见 objectsRoot） */
	objectsRoot: string;
	/** 对象总数：根 hash 相同但数量不同是不可能的，这里是给人看的诊断信息 */
	objectCount: number;
	/** 上一个 checkpoint 的 hash；创世为空串 */
	previousCheckpointHash: string;
	signingDeviceId: string;
	timestamp: number;
}

/** 签名之后的完整 checkpoint。 */
export interface SignedCheckpoint {
	body: CheckpointBody;
	/** body 的 canonical 形式的 sha256（链接与比对都用它） */
	hash: string;
	/** base64 的 ECDSA P-256/SHA-256 签名 */
	signature: string;
}

/**
 * 对象状态的根 hash。
 *
 * 做法：每个对象压成一行 `fileId:cg:mg:contentHash:metadataHash:state`，
 * 按 fileId 排序后拼接求 sha256。
 *
 * 排序是关键：没有确定的顺序，两台设备对同一个仓库会算出不同的根，
 * 于是每次比对都是「分叉」，这个机制立刻就没用了。
 *
 * 用单根而不是完整对象列表：20 000 个对象的完整列表每次同步都要传输和存储，
 * 而我们真正需要的只是「你我看到的是不是同一套状态」这一个比特。
 * 代价是分叉时无法从根 hash 直接定位到具体对象——那由随后的逐对象比对完成。
 */
export async function objectsRoot(objects: CheckpointObject[]): Promise<string> {
	const lines = objects
		.map(
			(o) =>
				`${o.fileId}:${o.contentGeneration}:${o.metaGeneration}:${o.contentHash}:${o.metadataHash}:${o.state}`,
		)
		.sort();
	return sha256Hex(encodeUtf8(lines.join("\n")));
}

/**
 * checkpoint body 的 canonical 序列化。
 *
 * 字段顺序写死，不依赖 `JSON.stringify` 对键顺序的实现细节——
 * 两台设备算出不同的字节就会得出不同的 hash，那等于随机报告分叉。
 */
export function canonicalCheckpoint(b: CheckpointBody): string {
	return [
		`v=${b.version}`,
		`vault=${b.vaultId}`,
		`repoEpoch=${b.repoEpoch}`,
		`formatEpoch=${b.formatEpoch}`,
		`keyEpoch=${b.keyEpoch}`,
		`head=${b.headSequence}`,
		`root=${b.objectsRoot}`,
		`count=${b.objectCount}`,
		`prev=${b.previousCheckpointHash}`,
		`device=${b.signingDeviceId}`,
		`ts=${b.timestamp}`,
	].join("\n");
}

export async function checkpointHash(b: CheckpointBody): Promise<string> {
	return sha256Hex(encodeUtf8(canonicalCheckpoint(b)));
}

const SIGN_ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

/** 设备签名密钥对（私钥不可导出——它只能用来签名，不能被复制走）。 */
export interface SigningKeyPair {
	privateKey: CryptoKey;
	/** base64 的 SPKI 公钥，进设备注册信息 */
	publicKeyB64: string;
}

/**
 * 生成设备签名密钥。
 *
 * 私钥标记为**可导出**，因为它需要被包装后存进 SecretStorage 才能活过重启。
 * 与 VMK 分离（§9.2）：签名密钥泄露只能伪造 checkpoint，读不了任何内容；
 * VMK 泄露能读内容，但伪造不了 checkpoint。两者放在一起就没有这层分隔了。
 */
export async function generateSigningKey(): Promise<SigningKeyPair & { privateKeyPkcs8B64: string }> {
	const pair = await crypto.subtle.generateKey(SIGN_ALG, true, ["sign", "verify"]);
	const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	return {
		privateKey: pair.privateKey,
		publicKeyB64: b64encode(spki),
		privateKeyPkcs8B64: b64encode(pkcs8),
	};
}

export async function importSigningPrivateKey(pkcs8B64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("pkcs8", b64decode(pkcs8B64) as BufferSource, SIGN_ALG, false, ["sign"]);
}

export async function importSigningPublicKey(spkiB64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("spki", b64decode(spkiB64) as BufferSource, SIGN_ALG, false, ["verify"]);
}

/** 用设备私钥签一个 checkpoint。 */
export async function signCheckpoint(privateKey: CryptoKey, body: CheckpointBody): Promise<SignedCheckpoint> {
	const canonical = encodeUtf8(canonicalCheckpoint(body)) as BufferSource;
	const sig = new Uint8Array(await crypto.subtle.sign(SIGN_PARAMS, privateKey, canonical));
	return { body, hash: await checkpointHash(body), signature: b64encode(sig) };
}

/**
 * 验证签名与 hash。
 *
 * 两者都要验：只验签名的话，攻击者可以把 body 换成另一个已被签过的
 * checkpoint 的 body 并保留其 hash 字段，让上层的链接检查用错哈希。
 */
export async function verifyCheckpoint(publicKeySpkiB64: string, cp: SignedCheckpoint): Promise<boolean> {
	if ((await checkpointHash(cp.body)) !== cp.hash) return false;
	try {
		const key = await importSigningPublicKey(publicKeySpkiB64);
		return await crypto.subtle.verify(
			SIGN_PARAMS,
			key,
			b64decode(cp.signature) as BufferSource,
			encodeUtf8(canonicalCheckpoint(cp.body)),
		);
	} catch {
		return false;
	}
}
