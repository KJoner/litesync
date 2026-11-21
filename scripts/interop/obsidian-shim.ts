/**
 * 联调用 obsidian 垫片：其余 API 取插件测试替身，requestUrl 换成真实的 Node fetch（二进制安全），
 * 并加上**故障注入**与**请求记录**（scripts/interop/，0.20.1 复审 RB-2）。
 *
 * 故障注入由场景脚本经 globalThis.__lsInterop 设置：
 *   - fail-before   ：请求根本没发出去（连接被重置）——服务器什么都没收到；
 *   - drop-response ：请求照常发出、服务器照常处理，但响应在回来的路上丢了——客户端只看到网络错误。
 * 后者正是幂等续跑要扛住的那种故障：服务器已经提交，客户端不知道。
 */
export * from "../../tests/mocks/obsidian";

export interface InteropFault {
	/** 只在匹配的请求上生效（method + url） */
	match: (req: { method: string; url: string }) => boolean;
	kind: "fail-before" | "drop-response";
	/** 还剩几次（一次性故障为 1） */
	remaining: number;
	/** 已触发次数（报告用） */
	hits: number;
	label: string;
}

export interface InteropRequestLog {
	method: string;
	url: string;
	status: number | "fault";
	/** X-File-Path（已解码）：路径加密仓库里必须只出现伪名 */
	filePath?: string;
	fault?: string;
}

interface InteropGlobal {
	faults: InteropFault[];
	log: InteropRequestLog[];
}

function state(): InteropGlobal {
	const g = globalThis as unknown as { __lsInterop?: InteropGlobal };
	if (!g.__lsInterop) g.__lsInterop = { faults: [], log: [] };
	return g.__lsInterop;
}

export async function requestUrl(p: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}) {
	const s = state();
	const method = p.method ?? "GET";
	const rawPath = p.headers?.["X-File-Path"];
	let filePath = rawPath !== undefined ? decodeURIComponent(rawPath) : undefined;
	// 删除请求把寻址名放在 JSON 请求体里；下载 / 历史放在 ?path= 里——都要记下来做隐私核对
	if (filePath === undefined && typeof p.body === "string") {
		try {
			const b = JSON.parse(p.body) as { path?: unknown };
			if (typeof b.path === "string") filePath = b.path;
		} catch {
			/* not json */
		}
	}
	if (filePath === undefined) {
		const q = new URL(p.url).searchParams.get("path");
		if (q !== null) filePath = q;
	}
	const fault = s.faults.find((f) => f.remaining > 0 && f.match({ method, url: p.url }));
	if (fault?.kind === "fail-before") {
		fault.remaining--;
		fault.hits++;
		s.log.push({ method, url: p.url, status: "fault", filePath, fault: `${fault.label}（请求未发出）` });
		throw new Error(`network: injected failure before the request was sent (${fault.label})`);
	}
	const r = await fetch(p.url, { method, headers: p.headers, body: p.body as BodyInit | undefined });
	const buf = await r.arrayBuffer();
	if (fault?.kind === "drop-response") {
		fault.remaining--;
		fault.hits++;
		s.log.push({ method, url: p.url, status: "fault", filePath, fault: `${fault.label}（服务器已处理 HTTP ${r.status}，响应丢失）` });
		throw new Error(`network: injected response loss after the server processed the request (${fault.label})`);
	}
	s.log.push({ method, url: p.url, status: r.status, filePath });
	const text = new TextDecoder().decode(buf);
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* not json */
	}
	const headers: Record<string, string> = {};
	r.headers.forEach((v, k) => (headers[k] = v));
	if (p.throw !== false && r.status >= 400) throw new Error(`HTTP ${r.status}`);
	return { status: r.status, text, json, headers, arrayBuffer: buf };
}
