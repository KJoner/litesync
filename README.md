# litesync — Obsidian 私有轻量同步

单用户自建的 Obsidian 同步系统：

```text
litesync/
├── server/   # Go + SQLite 同步服务器（obsync）
├── plugin/   # Obsidian TypeScript 插件（Private Sync）
└── docs/     # 开发计划
```

> ⚠️ **Sync is not Backup** — 同步不能替代备份，请定期备份服务器的 `/data` 目录。

## 一句话架构

> 一个使用 Go + SQLite + 本地文件系统实现的单用户、低资源、增量式 Obsidian
> 私有同步服务器，以及一个通过 revision + SHA-256 + change sequence
> 实现可靠同步的 Obsidian TypeScript 插件。

## 快速开始

服务器一键部署（在服务器上希望存放代码的目录下执行）：

```bash
bash <(wget -qO- https://raw.githubusercontent.com/KJoner/litesync/master/scripts/litesync-install.sh)
```

自动完成：克隆/更新代码 → 生成 `.env`（随机 Token、自动选择空闲端口）→
Docker Compose 构建并启动 → 健康检查 → 输出关键配置信息。
再次执行同一命令即可**更新到最新版本**（Token 与数据完整保留）。

手动部署（详见 [server/README.md](server/README.md)）：

```bash
cd server
cp .env.example .env   # 填入 openssl rand -hex 32 生成的 token
docker compose up -d
```

插件（详见 [plugin/README.md](plugin/README.md)）：

```bash
cd plugin
npm install && npm run build
# 把 main.js + manifest.json 复制到 <Vault>/.obsidian/plugins/obsidian-private-sync/
```

在 Obsidian 插件设置中填入 Server URL 和 Token，点击 Test Connection，完成。

## 测试

```bash
cd server && go test ./...   # 服务端：协议、安全、双设备场景
cd plugin && npm test        # 插件：纯逻辑单元测试
```
