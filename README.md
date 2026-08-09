# litesync — Obsidian 私有轻量同步

单用户自建的 Obsidian 同步系统：一个 Go 服务器 + 一个 Obsidian 插件
（桌面 + iOS/Android）+ 一个内嵌的 Web 只读端，端到端加密 + R2 异地备份，
跑在 1 核 256MB 的小 VPS 上绰绰有余。

```text
litesync/
├── server/   # Go + SQLite 同步服务器（obsync，内嵌 Web 端）
├── plugin/   # Obsidian TypeScript 插件（Private Sync）
├── web/      # Web 只读端源码（构建产物内嵌进服务器，部署无需 Node）
├── scripts/  # 一键部署 / 本地开发脚本
└── docs/     # 开发计划（不入库）
```

> ⚠️ **Sync is not Backup** — 同步不能替代备份；请在 Web 端启用内置的
> Cloudflare R2 异地备份（免费 10GB），或自行定期备份服务器 `/data` 目录。

## 功能总览（v0.6）

| 能力 | 说明 |
|---|---|
| 增量同步 | revision + SHA-256 + change sequence；多设备、离线队列、指数退避重试 |
| 冲突处理 | Markdown 自动三方合并（diff3）；重叠冲突进 Resolver 界面逐段解决；任何异常回退「保留两个版本」，绝不丢内容 |
| 版本历史 | 每次修改产生不可变版本（内容寻址去重）；对比 / 恢复 / 另存副本 |
| 端到端加密 | PBKDF2 + AES-256-GCM，密码与主密钥永不离开设备；服务器只见密文 |
| 信任此设备 | 记住设备授权而非密码（拆分包装 + Obsidian SecretStorage） |
| Web 只读端 | Obsidian 风格阅读器：文件树 / Outline / 搜索 / 历史 / Diff，浏览器本地解密；HttpOnly 只读会话 |
| 加密分享 | 每个分享独立密钥，密钥只在链接 `#` 片段中；可过期、可撤销 |
| 资源治理 | 历史/变更日志/分享/孤儿数据全生命周期管理，磁盘有硬上限；单份内容存储 |
| 异地备份 | Restic → Cloudflare R2 灾难备份：一致性快照、6 小时自动、Web 管理页配置；凭据加密存储且永不下发客户端 |
| iOS / 移动端 | 插件全平台通用（Obsidian 1.11.4+）：前台补同步、删除安全（绝不永久删除）、窄屏自适应界面 |

## 快速开始

**服务器一键部署**（在服务器上希望存放代码的目录下执行）：

```bash
bash <(wget -qO- https://raw.githubusercontent.com/KJoner/litesync/master/scripts/litesync-install.sh)
```

自动完成：克隆/更新代码 → 生成 `.env`（随机 Token、自动选空闲端口）与
备份密钥 `backup-config.key` → Docker Compose 构建启动（镜像内含 restic）→
健康检查 → 输出关键配置。
**再次执行同一命令即为升级**（Token、数据与备份密钥完整保留）。
异地备份在部署后到 Web 端 `⚙ → Backup` 配置（无需提前准备 R2）。

生产环境请配 HTTPS 反向代理（Caddy/Nginx → `127.0.0.1:端口`）：
Web 端的 E2EE 解密与安全 Cookie 都依赖 HTTPS。

**插件**（详见 [plugin/README.md](plugin/README.md)）：

```bash
cd plugin && npm install && npm run build
# 把 main.js + manifest.json + styles.css
# 复制到 <Vault>/.obsidian/plugins/obsidian-private-sync/
```

在插件设置里填 Server URL 和 Token → Test Connection → 完成。
需要加密时在设置页启用 E2EE 并设置密码。

**Web 只读端**：浏览器直接访问服务器地址，输入 Token 登录
（E2EE Vault 再输入密码本地解锁）。

## 开发与测试

```bash
cd server && go test ./...     # 服务端：协议 / 安全 / 双设备场景 / 资源治理 / 备份
cd plugin && npm test          # 插件：合并引擎 / 加密 / 设备信任等 49 个用例
cd plugin && npm run test:mobile  # 移动端 CI：Node/Electron 依赖审计 + 构建 + 测试
cd web && npm run build        # 修改 Web 端后重建（产物提交进仓库）
```

本地双 Vault 开发环境：`scripts/dev-server.ps1`（起本地服务器）+
`scripts/dev-deploy.ps1`（构建插件并部署到测试 Vault）。

## 一句话架构

> 一个使用 Go + SQLite + 内容寻址 Blob 存储实现的单用户、低资源、增量式
> Obsidian 私有同步服务器（内嵌 Web 只读端 + Restic→R2 备份旁路），
> 以及一个通过 revision + SHA-256 + change sequence + 三方合并 + 端到端加密
> 实现可靠同步的跨平台（桌面 / iOS / Android）Obsidian TypeScript 插件。
