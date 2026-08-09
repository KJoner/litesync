/** 二进制/文本判定与 UTF-8 编解码。数据安全红线：二进制文件不能按文本处理。 */

/** 严格按 UTF-8 解码；含 NUL 字节或非法序列（二进制文件）时返回 null。 */
export function decodeUtf8Strict(data: ArrayBuffer): string | null {
	const bytes = new Uint8Array(data);
	const probe = Math.min(bytes.length, 8192);
	for (let i = 0; i < probe; i++) {
		if (bytes[i] === 0) return null;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		return null;
	}
}

export function encodeUtf8(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
