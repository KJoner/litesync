#!/usr/bin/env node
/**
 * 插件 × 真实 Go 服务端联调 runner（0.20.1 / 复审 RB-2）：「用本地完整替换远端」在内容加密与路径加密
 * 两种仓库上的完整演练（故障注入、重启续跑、反向恢复、逐文件解密核对）。**不进默认 npm test。**
 *
 * 用法（在插件仓库根目录，已 npm ci）：
 *
 *   # 方式一：给出服务端二进制，runner 为每种仓库各起一个全新实例（临时数据目录，跑完删除）
 *   LITESYNC_INTEROP_SERVER_BIN=/path/to/obsync node scripts/interop/run.mjs
 *   # Windows PowerShell：
 *   #   $env:LITESYNC_INTEROP_SERVER_BIN = 'C:\path\to\obsync.exe'; node scripts/interop/run.mjs
 *
 *   # 方式二：连到两个已经起好的**全新空**实例（例如 docker compose 起的测试实例）
 *   LITESYNC_INTEROP_URL_CONTENT=http://127.0.0.1:39111 \
 *   LITESYNC_INTEROP_URL_PATH=http://127.0.0.1:39112 \
 *   LITESYNC_INTEROP_TOKEN=<两个实例的 OBSYNC_TOKEN> node scripts/interop/run.mjs
 *
 * 服务端二进制的构建（固定版本，不碰正在开发的工作区）：
 *   git -C <litesync-server> worktree add --detach <临时目录>/server-base <SHA>
 *   (cd <临时目录>/server-base && go build -o <临时目录>/obsync ./cmd/obsync)
 *   …跑完后 git -C <litesync-server> worktree remove <临时目录>/server-base
 *
 * 可选环境变量：
 *   LITESYNC_INTEROP_PORT      第一个端口（默认 39110；方式一占用 PORT 与 PORT+1，只监听 127.0.0.1）
 *   LITESYNC_INTEROP_OUT       结果 JSON 路径（默认 <工作目录>/interop-result.json）
 *   LITESYNC_INTEROP_WORKDIR   临时目录根（默认在系统临时目录下新建）
 *   LITESYNC_INTEROP_MODES     只跑其中几种：content-e2ee,path-e2ee
 *   LITESYNC_INTEROP_KEEP=1    保留数据目录与服务端日志（排查用；默认跑完删除）
 *
 * 输出：机器可读 JSON——summary.passed / failed / total，每种仓库的 checks、faults（每个注入点是否触发）、
 * interruptions（每次中断的阶段与错误）、timeline、请求计数；退出码 0 = 全部通过。只用合成数据。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const env = process.env;
const ALL_MODES = ["content-e2ee", "path-e2ee"];
const modes = (env.LITESYNC_INTEROP_MODES ?? ALL_MODES.join(",")).split(",").map((m) => m.trim()).filter((m) => ALL_MODES.includes(m));
const work = env.LITESYNC_INTEROP_WORKDIR
	? (mkdirSync(env.LITESYNC_INTEROP_WORKDIR, { recursive: true }), mkdtempSync(join(env.LITESYNC_INTEROP_WORKDIR, "run-")))
	: mkdtempSync(join(tmpdir(), "litesync-interop-"));
const out = env.LITESYNC_INTEROP_OUT ? resolve(env.LITESYNC_INTEROP_OUT) : join(work, "interop-result.json");
const keep = env.LITESYNC_INTEROP_KEEP === "1";
const basePort = Number(env.LITESYNC_INTEROP_PORT ?? 39110);

function gitSha() {
	try {
		const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
		return dirty ? `${sha}+dirty` : sha;
	} catch {
		return "";
	}
}

async function waitReady(url, token, child, logPath) {
	const until = Date.now() + 30_000;
	for (;;) {
		if (child && child.exitCode !== null) throw new Error(`服务端进程已退出（${child.exitCode}），日志：${logPath}`);
		try {
			const r = await fetch(`${url}/api/v1/info`, { headers: { Authorization: `Bearer ${token}` } });
			if (r.status === 200) return (await r.json()).version;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > until) throw new Error(`服务端 30 秒内没有就绪：${url}（日志：${logPath ?? "外部实例"}）`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

const servers = [];
let exitCode = 1;
try {
	// 1. 打包场景脚本：插件原样源码 + obsidian 垫片（真实 HTTP + 故障注入）
	const bundle = join(work, "replace-remote.interop.cjs");
	await esbuild.build({
		entryPoints: [join(here, "replace-remote.interop.ts")],
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node20",
		outfile: bundle,
		alias: { obsidian: join(here, "obsidian-shim.ts") },
		logLevel: "warning",
	});

	// 2. 目标实例
	const targets = [];
	let serverDesc = "";
	if (env.LITESYNC_INTEROP_SERVER_BIN) {
		const bin = resolve(env.LITESYNC_INTEROP_SERVER_BIN);
		if (!existsSync(bin)) throw new Error(`找不到服务端二进制：${bin}`);
		serverDesc = `${bin} (sha256 ${createHash("sha256").update(readFileSync(bin)).digest("hex")})`;
		for (const [i, mode] of modes.entries()) {
			const port = basePort + i;
			const token = randomBytes(24).toString("hex");
			const dataDir = join(work, `server-${mode}`);
			mkdirSync(dataDir, { recursive: true });
			const logPath = join(work, `server-${mode}.log`);
			const fd = openSync(logPath, "w");
			const child = spawn(bin, [], {
				env: {
					...env,
					OBSYNC_TOKEN: token,
					OBSYNC_LISTEN: `127.0.0.1:${port}`,
					OBSYNC_DATA_DIR: dataDir,
					OBSYNC_MAINTENANCE_HOURS: "0",
					OBSYNC_MAIL_PROVIDER: "log",
				},
				stdio: ["ignore", fd, fd],
			});
			servers.push({ child, fd });
			const url = `http://127.0.0.1:${port}`;
			const version = await waitReady(url, token, child, logPath);
			console.log(`服务端就绪：${mode} → ${url}（${version}）`);
			targets.push({ mode, url, token, workdir: join(work, "devices") });
		}
	} else if (env.LITESYNC_INTEROP_URL_CONTENT || env.LITESYNC_INTEROP_URL_PATH) {
		const token = env.LITESYNC_INTEROP_TOKEN ?? "";
		if (!token) throw new Error("URL 模式需要 LITESYNC_INTEROP_TOKEN");
		const urls = { "content-e2ee": env.LITESYNC_INTEROP_URL_CONTENT, "path-e2ee": env.LITESYNC_INTEROP_URL_PATH };
		serverDesc = "external";
		for (const mode of modes) {
			const url = urls[mode];
			if (!url) continue;
			await waitReady(url.replace(/\/+$/, ""), token, null, null);
			targets.push({ mode, url: url.replace(/\/+$/, ""), token, workdir: join(work, "devices") });
		}
	} else {
		throw new Error("请设置 LITESYNC_INTEROP_SERVER_BIN（或 LITESYNC_INTEROP_URL_CONTENT / _PATH + LITESYNC_INTEROP_TOKEN），见本文件开头");
	}

	// 3. 跑场景
	const r = spawnSync(process.execPath, [bundle], {
		stdio: "inherit",
		env: {
			...env,
			LS_INTEROP_TARGETS: JSON.stringify(targets),
			LS_INTEROP_OUT: out,
			LS_INTEROP_PLUGIN_SHA: gitSha(),
			LS_INTEROP_SERVER_DESC: serverDesc,
		},
	});
	exitCode = r.status ?? 2;
	console.log(`\n结果：${out}${keep ? `\n工作目录（保留）：${work}` : ""}`);
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	exitCode = 2;
} finally {
	for (const s of servers) {
		try {
			s.child.kill();
		} catch {
			/* 已退出 */
		}
		try {
			closeSync(s.fd);
		} catch {
			/* 已关闭 */
		}
	}
	if (!keep) {
		// 等服务端进程退出、释放数据目录句柄后再删（Windows 上文件被占用时删不掉）
		await new Promise((r) => setTimeout(r, 800));
		for (const entry of ["devices", ...modes.map((m) => `server-${m}`), "replace-remote.interop.cjs"]) {
			try {
				rmSync(join(work, entry), { recursive: true, force: true });
			} catch {
				/* 尽力清理 */
			}
		}
	}
}
process.exit(exitCode);
