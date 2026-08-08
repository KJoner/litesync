# Private Sync — Obsidian 私有同步插件

配合 [obsync 服务器](../server/README.md) 使用的 Obsidian 同步插件。
基于 revision + SHA-256 + change sequence 实现可靠的增量同步。

## 构建

```bash
cd plugin
npm install
npm run build    # 类型检查 + 打包，产出 main.js
npm test         # 纯逻辑单元测试（忽略规则 / 冲突命名 / 队列）
npm run dev      # watch 模式，开发用
```

## 安装到 Obsidian

把以下两个文件复制到 Vault 的插件目录：

```text
<你的Vault>/.obsidian/plugins/obsidian-private-sync/
├── main.js
└── manifest.json
```

然后在 Obsidian 设置 → 第三方插件中启用 Private Sync。

## 配置

在插件设置页填写：

- **Server URL**：例如 `https://sync.example.com`（开发环境可用 `http://localhost:8080`）
- **API Token**：与服务器的 `OBSYNC_TOKEN` 一致
- 点击 **Test Connection** 验证

其余选项：

- **设备名称**：用于冲突文件命名（如 `Project.conflict-MacBook-20260808-001500.md`）
- **自动同步**：文件变化后 3 秒防抖同步 + 定时拉取（默认 30 秒）
- **同步 .obsidian 配置**：默认关闭；开启后 workspace 文件和本插件目录仍然永远排除
- **忽略规则**：每行一个 Glob，默认 `.trash/**`、`.DS_Store`、`Thumbs.db`

## 同步行为

一次完整同步：**拉取远端变更 → 扫描本地变化 → 推送队列 → 对齐游标**。

- 状态栏显示 `✓ Synced` / `↻ Syncing` / `! Conflict` / `× Offline`
- 离线时所有修改进入待同步队列，Obsidian 本地编辑完全不受影响；
  网络恢复后按 5s → 15s → 30s → 60s → 2min → 5min 退避自动重试
- 冲突时**永远保留两个版本**：服务器版本写回原路径，本地版本另存为
  `xxx.conflict-设备名-时间戳.md` 并同步到服务器，绝不静默丢弃任何内容
- 远端删除本地文件时移入回收站（system trash），不做永久删除
- 同步状态（deviceId、lastSequence、文件 hash 缓存）保存在本插件目录的
  `state.json`，与设置分离，且永远不会被同步出去

## 手动多设备验收（对应计划书 Phase 7）

1. 准备两个测试 Vault（vault-a、vault-b），都安装本插件并指向同一服务器
2. 在 A 新建 `hello.md` → B 应在下个同步周期收到
3. 在 A 修改、删除文件 → B 跟随
4. 断网状态下在 A、B 同时修改同一文件 → 恢复后应产生 conflict 副本，两份内容都在
5. 上传大附件（PNG/PDF/10MB 二进制）→ 两端 hash 一致
