# LiteSync — Obsidian 私有同步插件（中文文档）

配合 [LiteSync Server](https://github.com/KJoner/litesync-server) 使用的 Obsidian 同步插件。
基于 revision + SHA-256 + change sequence 实现可靠增量同步，
支持三方自动合并、版本历史、端到端加密与加密分享。
桌面与 **iOS / Android 移动端**通用（需要 Obsidian 1.13+）。

## 构建与安装

```bash
cd litesync
npm install
npm run build        # 类型检查 + 打包，产出 main.js
npm test             # 49 个单元测试（合并引擎 / 加密 / 设备信任 / 状态存储等）
npm run test:mobile  # 移动端 CI：Node/Electron 依赖审计 + 构建 + 全部测试
npm run dev          # watch 模式，开发用
```

把以下三个文件复制到 Vault 的插件目录，然后在设置 → 第三方插件中启用：

```text
<你的Vault>/.obsidian/plugins/litesync/
├── main.js
├── manifest.json
└── styles.css
```

> 本仓库开发用：`scripts\dev-deploy.ps1` 一键构建并部署到测试 Vault。

## 配置

- **Server URL**：例如 `https://sync.example.com`（开发环境可用 `http://localhost:8080`）
- **API Token**：与服务器 `OBSYNC_TOKEN` 一致，保存在 Obsidian
  SecretStorage（不进 `data.json`）；点击 **Test Connection** 验证
- **设备名称**：用于冲突文件命名（如 `Project.conflict-MacBook-20260808-001500.md`）
- **自动同步**：文件变化后 3 秒防抖 + 定时拉取（15s/30s/60s/5min/关闭）
- **同步 .obsidian 配置**：默认关闭；开启后 workspace 文件与本插件目录仍永远排除
- **忽略规则**：每行一个 Glob，默认 `.trash/**`、`.DS_Store`、`Thumbs.db`
- **Debug 日志**：在开发者控制台输出同步细节

## 同步行为

一次完整同步：**拉取远端变更 → 扫描本地变化 → 推送队列 → 对齐游标**。

- 状态栏：`✓ Synced` / `↻ Syncing` / `! N Conflicts` / `× Offline` / `🔒 Locked`
- 离线时修改进入待同步队列，本地编辑完全不受影响；恢复后按
  5s → 15s → 30s → 60s → 2min → 5min 退避自动重试
- 远端删除本地文件时移入回收站（system trash），不做永久删除
- 服务器变更日志被裁剪（长期未开机的设备）时自动走 **snapshot 全量对账**
  重建游标，不漏任何删改
- 同步状态（deviceId、lastSequence、hash 缓存、未解决冲突、分享密钥）
  保存在插件目录 `state.json`，与设置分离，永远不会被同步出去

## 移动端（iOS / Android，v0.6）

网络层（`requestUrl`）、加密（Web Crypto）、文件访问（`vault.adapter`）
全部使用跨平台 API，`npm run test:mobile` 强制审计不引入 Node/Electron 依赖。
移动端专属行为：

- **同步时机**：启动 / 文件修改防抖 / 前台定时（最低 60 秒）之外，
  **切回 App 时自动补同步**（visibilitychange + 防抖，iOS 后台定时器会被系统暂停）
- **删除安全**：远端删除 → 移入 vault 内 `.trash`；回收站失败时**保留本地文件**
  并记录待手动删除（绝不永久删除，也不会被重新上传）
- **`.obsidian` 不同步**：无论设置如何，移动端始终不同步 Obsidian 配置目录
  （桌面与移动界面配置差异大，避免互相覆盖）；普通笔记与附件不受影响
- **大文件警告**：>50MB 文件同步时提示内存占用（不跳过，保证一致性）
- **界面**：冲突 Resolver 等在窄屏自动纵向堆叠，按钮满足触控尺寸
- 桌面开发时可用 `this.app.emulateMobile(true)`（开发者控制台）模拟移动界面

## 冲突处理：三方自动合并

两端同时修改同一个 `.md` 文件时：

1. **自动三方合并**：以共同祖先版本（服务器历史）为 Base 做 diff3，
   修改不重叠时自动合并上传（`action=merge`），无需任何弹窗
2. **结构化冲突 → Resolver**：同一区域两边都改时进入 pending conflict
   （暂停该文件自动同步），状态栏 `! N Conflicts`，点击或运行
   `Resolve conflicts`：LOCAL / REMOTE 双栏对比，逐冲突段
   `Use Local / Use Remote / Use Both`，合并结果可直接编辑后 Save Merge；
   保存时远端又变化（409）会重新加载再合并，绝不绕过 revision 校验
3. **keepBoth 兜底永远保留**：二进制、`.canvas`、Base 已被清理、
   引擎任何异常 → 回退「保留两个版本」（`xxx.conflict-设备名-时间戳.md`），
   任何情况下不丢任何一方内容

## 版本历史

- 命令 `File history` 或右键文件 →「LiteSync: 版本历史」
- 每个版本可**对比**（逐行 diff）、**恢复**（旧内容作为新版本上传，
  历史线性可追踪）、**另存副本**（`xxx.rev-N.md`）

## 端到端加密

设置页 → 端到端加密 → **启用端到端加密**：

- 密码经 PBKDF2-SHA256（600k 迭代）派生 KEK，解锁随机 Vault Master Key；
  服务器只保存**加密后的** vault key 副本，密码与明文密钥永不上传
- 文件以 AES-256-GCM 加密（随机 IV + 路径绑定 AAD），服务器只见密文
- 迁移：全部文件重新加密上传 → **下载回验（解密 + hash 一致）后**才清理
  服务器明文历史；中断可重跑（已加密文件自动跳过）
- 新设备：填好地址与 Token 后运行 `Unlock E2EE` 输入密码
- 未解锁时状态栏 `🔒 Locked`，同步暂停，本地编辑不受影响
- ⚠️ **密码丢失 = 服务器数据永远无法解密**；暂不支持关闭 E2EE 或改密码

### 凭据安全：Trusted Device

**E2EE 密码永远不持久化**——记住的是「设备已授权」，不是密码：

- ☑ **信任此设备**：解锁后把 VMK 用随机设备密钥包装保存，之后启动自动解锁
- **拆分包装**：设备密钥存 `data.json`（vault 内），包裹后的 VMK 存
  Obsidian SecretStorage（vault 外）——单独复制任何一份都无法还原密钥
- 服务器密钥轮换后设备信任自动失效（keyId 绑定）
- 设置页提供 **🔒 立即锁定**（本次会话）与 **🗑 忘记此设备**（下次需密码）
- 旧版本升级自动迁移：明文密码/Token 从 `data.json` 抹除
- v0.7.1 起要求 Obsidian 1.13+（`minAppVersion`，声明式设置 API），凭据一律 SecretStorage，
  不再提供 data.json 明文降级

## 分享

右键文件 →「LiteSync: 分享此文件…」：

- 每个分享生成**独立随机 Share Key**，只加密该分享对象（与 VMK 完全无关）
- 服务器只存密文；**Share Key 在链接 `#` 片段中，不会发给服务器**
- 有效期 7/30/90 天/永久；命令「管理分享」可随时**撤销**（不影响原 Vault）
- 对方打开链接后在浏览器本地解密（需 HTTPS）

## 手动多设备验收

1. 两个测试 Vault 指向同一服务器
2. A 新建/修改/删除 → B 跟随；断网双改同一文件 → 自动合并或冲突界面，两份内容都在
3. 大附件（PNG/PDF/10MB）两端 hash 一致
4. 启用 E2EE 后服务器磁盘上只有 `LSE1` 密文

## 新设备接入与配对（v0.8）

**首次接入向导**：填完 Server URL + Token 不再直接开始同步——先进入接入向导，
按「本地 / 远端是否有数据」给出选项：

- **从远端恢复此设备（推荐用于新设备）**：以远端为准；本地不同内容先进回收站，绝不永久删除
- **保留本地内容，与远端合并**：两边数据都不丢——互补文件互相同步，
  同路径不同内容的 Markdown 进冲突解决器（无共同祖先时按整体对比），其他文件保留两个版本
- 远端为空时：用本设备初始化远端

接入完成前所有同步入口都会被拦截（Gate）；接入完成后无缝进入正常增量同步。
服务器返回稳定 `vaultId`，URL 不变但 vaultId 变化（服务器重装/换库）时自动暂停同步并要求重新接入。

**添加新设备（二维码配对）**：设置 → 设备与迁移 → 添加新设备：

1. 原设备本地生成随机配对密钥，把服务器配置（URL + Token + 同步设置）AES-256-GCM 加密后上传
   （服务器只存密文，5 分钟过期、一次性；解密密钥只在链接 `#fragment` 中）
2. 新设备用系统相机扫码 → 落地页 →「在 Obsidian 中打开」→ 确认导入
3. Token 自动进 SecretStorage；**E2EE 密码永不随配对包传输，需手动输入一次**
4. 自动进入接入向导，选「从远端恢复」即完成

也可在设置页手动「导入配对链接」。
