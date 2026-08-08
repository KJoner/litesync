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

把以下三个文件复制到 Vault 的插件目录：

```text
<你的Vault>/.obsidian/plugins/obsidian-private-sync/
├── main.js
├── manifest.json
└── styles.css
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

- 状态栏显示 `✓ Synced` / `↻ Syncing` / `! N Conflicts` / `× Offline`
- 离线时所有修改进入待同步队列，Obsidian 本地编辑完全不受影响；
  网络恢复后按 5s → 15s → 30s → 60s → 2min → 5min 退避自动重试
- 远端删除本地文件时移入回收站（system trash），不做永久删除
- 同步状态（deviceId、lastSequence、文件 hash 缓存、未解决冲突）保存在
  本插件目录的 `state.json`，与设置分离，且永远不会被同步出去

## 冲突处理（v0.2：三方自动合并）

两端同时修改同一个 `.md` 文件时：

1. **自动三方合并**：以双方共同祖先版本（服务器历史）为 Base 做 diff3，
   修改不重叠时自动合并上传（`action=merge`），无需任何弹窗
2. **结构化冲突 → Resolver**：同一区域两边都改时，文件进入 pending conflict
   （暂停该文件的自动推送/拉取），状态栏显示 `! N Conflicts`，点击或运行命令
   `Resolve conflicts` 打开界面：LOCAL / REMOTE 双栏对比，每个冲突段
   `Use Local / Use Remote / Use Both`，合并结果可直接编辑后 Save Merge；
   保存时若远端又发生变化（409），会重新加载最新版本再合并，绝不绕过 revision 校验
3. **keepBoth 兜底永远保留**：二进制文件、`.canvas`、Base 已被服务器清理、
   合并引擎任何异常 → 回退「保留两个版本」（`xxx.conflict-设备名-时间戳.md`），
   任何情况下不丢任何一方内容

## 端到端加密（v0.3）

设置页 → 端到端加密 → **启用端到端加密**：

- 密码经 PBKDF2-SHA256（600k 迭代）派生 KEK，解锁随机生成的 Vault Master Key；
  服务器只保存**加密后的** vault key 副本，密码与明文密钥永不上传
- 文件以 AES-256-GCM 加密（每次随机 IV，路径绑定 AAD），服务器只见密文
- 迁移过程：全部文件重新加密上传 → **下载回验（解密 + hash 一致）后**才清理
  服务器上的明文历史；中断后可重新执行（已加密文件自动跳过）
- 新设备：填好服务器地址与 Token 后运行 `Unlock E2EE` 输入密码即可
- 未解锁时状态栏显示 `🔒 Locked`，同步暂停，本地编辑完全不受影响
- ⚠️ **密码丢失 = 服务器数据永远无法解密**；本版本不支持关闭 E2EE 或改密码

## 凭据安全（v0.3.1：Trusted Device + SecretStorage）

**E2EE 密码永远不持久化**——记住的是「这台设备已被授权」，不是密码：

- ☑ **信任此设备**：解锁后把 Vault Master Key 用随机设备密钥包装保存，
  之后启动自动解锁（体验等同其他软件的"保持登录"）
- **拆分包装**：设备密钥存插件 `data.json`（vault 文件夹内），
  被包裹的 VMK 存 Obsidian SecretStorage（vault 文件夹外的应用存储）——
  两处各持一半，单独复制任何一份（例如整个 vault 被备份）都无法还原密钥
- 服务器端密钥轮换后旧设备信任自动失效（keyId 绑定）
- 设置页提供 **🔒 立即锁定**（本次会话锁定）与 **🗑 忘记此设备**
  （删除本地信任，下次必须重新输入密码）
- **API Token** 同样保存在 SecretStorage，`data.json` 中不再出现明文 Token
- 从旧版本升级：首次启动自动迁移——旧「记住密码」转换为「信任此设备」，
  明文密码与 Token 立即从 `data.json` 抹除
- 需要 Obsidian 1.11.4+（更老版本自动降级：Token 存 data.json、每次启动手动解锁）

## 版本历史（v0.2）

- 命令 `File history` 或右键文件 →「Private Sync: 版本历史」
- 每个版本可 **对比**（与当前内容逐行 diff）、**恢复**（旧内容作为新版本上传，
  历史线性可追踪）、**另存副本**（`xxx.rev-N.md`）

## 手动多设备验收（对应计划书 Phase 7）

1. 准备两个测试 Vault（vault-a、vault-b），都安装本插件并指向同一服务器
2. 在 A 新建 `hello.md` → B 应在下个同步周期收到
3. 在 A 修改、删除文件 → B 跟随
4. 断网状态下在 A、B 同时修改同一文件 → 恢复后应产生 conflict 副本，两份内容都在
5. 上传大附件（PNG/PDF/10MB 二进制）→ 两端 hash 一致
