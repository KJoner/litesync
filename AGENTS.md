# AGENTS.md — LiteSync 插件仓库系统说明

面向接手这份代码的人（或 AI 助手）。README 讲**怎么用**，这份讲**怎么改**。

---

## 1. 这是什么

`litesync` = Obsidian 插件（TypeScript，esbuild 打包成单文件 `main.js`）。
它把 Vault 同步到用户自己部署的 [litesync-server](https://github.com/KJoner/litesync-server)。

**双仓结构**（2026-08 起）：

| 仓库 | 内容 | tag 约定 |
|---|---|---|
| `litesync`（本仓） | Obsidian 插件，`manifest.json` 在根目录 | **无 v 前缀**，如 `0.17.0` |
| `litesync-server` | Go 服务端 + Web 端 | **有 v 前缀**，如 `v0.17.1` |

两仓**独立发版**，兼容性由 `/api/v1/info` 的 `protocolVersion` /
`minProtocolVersion` 区间判定（客户端侧常量在 `src/api/client.ts`）。
当前协议 **v6**。

本机路径：插件 `D:\myProject\litesync`，服务端 `D:\myProject\litesync-server`。

## 2. 常用命令

```bash
npm run build        # tsc --noEmit + esbuild → main.js
npm run lint         # eslint-plugin-obsidianmd 推荐规则
npm test             # 全量测试，按 tests/ 目录自动发现
npm run test:mobile  # Node/Electron 依赖审计 + build + test
npm run check:adr    # 每个 ADR 都被它约束的代码引用
npm run check:inv    # 每条 INV 都有测试认领
npm run dev          # watch 模式
scripts\dev-deploy.ps1   # 构建并部署到本机测试 Vault（PowerShell）

# 插件原样代码 × 真实 Go 服务端联调（不进默认 npm test；用法与环境变量写在 run.mjs 开头）
LITESYNC_INTEROP_SERVER_BIN=<obsync 二进制> node scripts/interop/run.mjs   # 结果 JSON 见 LITESYNC_INTEROP_OUT
```

> `npm test` 曾经是一串**手写的文件名**，新增测试文件不会报错，它只是不运行。
> 现已改为按目录发现——加测试文件不需要改 `package.json`，也不会静默漏跑。

## 3. 代码地图

```
src/
├── main.ts              插件入口：命令注册、状态栏、设置装配、生命周期
├── settings.ts          设置页（Obsidian 1.13 声明式 API）+ PluginSettings；状态卡 + 四节（0.20）
├── status-summary.ts    状态卡的纯判定：几行状态 + 唯一主按钮（可测）
├── onboarding.ts        新手入口：「打开网页注册或登录」
├── api/client.ts        HTTP 客户端、协议常量、错误码 → 类型化异常
├── sync/                同步引擎（见下）
├── state/store.ts       StateStore：state.json、FileState 缓存、绑定指纹、信任锚
├── bootstrap/           首次接入：向导、接入模式、空仓对话框；replace-remote*：本地完整替换远端（ADR-016；
│                        执行许可、本地前置条件、restore→upload 子状态机，0.20.1）
├── crypto/              E2EE：信封、密钥环（会话 / 连接上下文代次）、设备信任、元数据迁移、填充、签名；
│                        trust-migration*：严格解锁与旧信任迁移（ADR-013）；unlock-flow：解锁流程（每段异步后核对会话）
├── merge/               三方合并引擎（diff3 + Markdown 分词 + 智能合并）
├── conflict-ui/         冲突解决器界面
├── history/             版本历史界面
├── share/               分享创建界面
├── pairing/             设备配对：二维码、深链导入、设备列表；pairing-v2：先核对后兑换、exchangeId 续传（ADR-014）
├── diagnostics/         平台兼容性自检
└── utils/               路径归一、忽略规则、哈希、时间混淆、失败点注入
```

### `src/sync/` 的分工（改同步逻辑前必读）

| 文件 | 职责 | 红线 |
|---|---|---|
| `sync-manager.ts` | 调度：一轮 = 拉取 → 扫描 → 推送 → 对齐游标；退避 5/15/30/60/120/300s | 一次调用最多续 8 轮，防自激死循环 |
| `gate.ts` | **唯一**的许可来源：任何读写远端或覆盖本地的入口都要先过 `syncGateBlock` | 手动命令与自动同步共用同一套判断，规则不许漂移；迁移锁有所有者，只有持有者（完整替换作业 `replace-remote-job`）的许可能豁免它 |
| `pull.ts` | 拉取远端变更、按 fileId 对账（含改名识别）、快照全量对账 | 明文与 meta 模式都必须按 fileId 认改名；同一 fileId 已跟踪在更高 revision 上 → 更早的变更是重放，跳过（**改名不动 revision**，只能用严格小于）；删除命中另一个已跟踪文件的大小写别名时不碰它 |
| `push.ts` | 扫描本地变化、推送队列 | 改名操作**不得被后续编辑覆盖**（0.17.0-rc.4 的实测事故） |
| `queue.ts` | 待推送操作队列 + 持久化操作日志 | **先落盘再视为已接受**；重试保持同一 operationId / fileId / base |
| `local-commit.ts` | **唯一**允许覆盖 Vault 已有文件的地方（11 步流程） | 前置条件不符 → keep-both / conflict，**绝不覆盖**（INV-03） |
| `transfer.ts` | 上传/下载 + 信封封装解封 | 「基于刚下载的远端内容上传」必须以**认证后的远端世代**为下限 |
| `freshness.ts` | 签名 checkpoint 的信任锚与分叉检测 | 锚只前进、链必须相连、同一 sequence 只能有一份 |
| `checkpoint-sync.ts` | 签名密钥注册、checkpoint 发布与验证；配对继承锚的首次接入核验（`verifyInheritedTrust`） | 签名由**设备**做，服务器永不参与；服务器 head 低于已确认锚即判回退（空 checkpoint 列表不算通过） |
| `conflict.ts` / `auto-merge.ts` | 冲突落地与自动合并 | 任何异常都回退 keep-both，不丢内容 |
| `context.ts` | 各模块共享的依赖包（client / store / crypto / 日志） | — |

## 4. 必须守住的不变量

计划书 §2 定义了 12 条不变量（INV-01…12）。**测试必须在注释里标注自己覆盖
哪些编号**，`npm run check:inv` 会检查。本仓负责的部分：

| 编号 | 内容 | 实现 |
|---|---|---|
| INV-03 | 不覆盖不满足前置条件的内容；无法确认时 keep-both | `sync/local-commit.ts` |
| INV-04 | sequence 只有在应用/持久化冲突/持久化 blocked 后才确认 | `sync/pull.ts` 的 `OutcomeNote` |
| INV-05 | 身份由 fileId 决定，改名/迁移/恢复**不重置** | 全链路 |
| INV-07 | 信封只升不降 | `crypto/crypto.ts` + 服务端双侧拒绝 |
| INV-09 | 状态损坏必须**停机** | `StateStore.corrupted` → SyncManager 硬兜底 |
| INV-10 | URL/Token/vaultId/repoEpoch/formatEpoch 变化必须重新绑定 | 指纹在 `state/store.ts`（`computeBinding`），比较在 `sync/sync-manager.ts`（`ensureBinding`）；世代校验在 `adoptRepoIdentity`。**注意**：重新绑定 ≠ 清状态——Token 变化重绑通过后游标/信任锚/密钥环原样保留（v0.18 重置 Token 的恢复路径靠的就是这个） |
| INV-11 | 迁移可恢复、可重复、幂等 | `crypto/migration.ts` + journal |

服务端负责 INV-01/02/06/08/12（见服务端 AGENTS.md）。

## 5. 协议与数据模型速查

- **身份**：`fileId`（32 位小写 hex）是对象身份，`path` 只是展示名。
  改名 = 一次元数据更新，不产生 tombstone、内容零重传、历史连续。
- **世代**：`revision`（对象级递增）、`contentGeneration`（防内容回放）、
  `metaGeneration`（元数据 CAS）。三者都**单调不减**，客户端与服务端双侧拒绝回退。
- **游标**：`lastSequence` 对齐服务器的 `changes` feed；游标过旧 → 服务器返回
  `resyncRequired` → 走 snapshot 全量对账。
- **绑定指纹**：`serverUrl + token + vaultId + repoEpoch + formatEpoch`。
  任一变化立刻切 unbound，重新完成权威校验前禁止任何写操作。
- **信封**：
  | 版本 | 用途 |
  |---|---|
  | LSE1 / LSE2 | 历史格式，只读兼容 |
  | LSE3 | 当前默认：AAD 绑定 vaultId + keyEpoch + fileId + contentGeneration |
  | LSE4 | 大小混淆（0.17.0）：明文内含 `trueLength` + 零填充，`flags` 进 AAD |
  | LSM1 | 加密元数据（真实路径），meta 模式建档必带 |
  | LSN1 / LSN2 | 分享信封（LSN2 起可携带加密附件） |
- **错误码**：服务端统一返回 `{code, message, retryable, error}`。
  **按 `code` 分支，永远不要解析 `message` 文案。**
  v0.18 新增认证类：`UNAUTHORIZED` / `TOKEN_REVOKED`（凭据曾有效、已被
  重置或撤销——客户端据此给「填新 Token → 测试连接」指引）/
  `RESET_AUTH_MISMATCH`（重置凭证不符）。
  0.20.1 新增 `IDENTITY_UNAVAILABLE`（503 + `Retry-After`，retryable）：账号中心暂时无法确认账号状态且超过宽限，
  对**所有**设备请求统一生效。`client.ts` 的 `request()` 包装在一处把它变成带 code / `retryAfterSeconds` 的 ApiError
  （只看状态码的端点也能识别）；同步按可重试处理——保留队列与游标、重试不早于 Retry-After、**不进**「需要重新连接」，
  状态文案「账号中心暂时无法确认你的登录状态，稍后自动重试；本地修改已保留」。凭据被撤销仍是 401 `TOKEN_REVOKED`
  （置 credential-rejected、常驻提示、不排重试、不换凭据提交）。
- **API Token 重置（v0.18）**：服务端 Token 已落库（哈希），网页/CLI 可
  轮换并连带撤销该用户全部设备。设备端恢复路径 = 填新 Token → 测试连接
  （`main.ts` 的 `testConnection` 会在凭据停机时自动触发同步闭环）。
  E2EE 解锁后 `sync-manager` 自动登记重置凭证
  （`crypto.ts` 的 `deriveResetAuth`，HKDF info `litesync/v1/token-reset-auth`，
  与服务端/Web 三方同源——改任何一处都等于把门锁换掉）。
- **多仓库（v0.19）**：`settings.vaultChoice` 选择目标仓库（空=默认），
  `client.headers()` 以 `X-Vault-ID` 携带；**绑定指纹含第五字段 vaultChoice**
  （改 `computeBinding`/`isBoundTo` 时两处都要动——v0.19 开发中就漏过一次，
  被 `tests/v19-multivault` 抓住）。切换仓库只能走接入向导；向导的选仓库步
  **始终显示**（`vaultPickerVisible`，数量不参与判定——「新建」的唯一入口）。
  **空远端初始化强制 E2EE**（0.19.x）：向导与首次配置对话框都没有明文
  初始化按钮；既有明文仓库不受影响。仓库重命名 `PATCH /api/v1/vaults/{id}`
  只动展示名（设置页「当前仓库」条目）。
- **严格会话解锁（0.20 / ADR-013）**：新安装 `trustDevice=false`；「本设备自动解锁」只在高级区显式开启。
  旧设备的信任材料由 `crypto/trust-migration.ts` 状态机处理——**先证明能用密码恢复同一把 VMK，再清理**；
  `persistTrust` 只在显式开启时执行，迁移未完成时开关与「忘记此设备」一律转交迁移向导。
  重包装上传前先落盘 `pendingRewrapKeyId`：服务器已收新 keyDoc 但响应丢失 / SecretStorage 写失败后，重来能认出自己的文档。
- **密钥会话代次（0.20.1 / 复审 PL-01）**：`Keyring.generation`（锁定、换文档、采纳、换连接、卸载递增）与
  `contextGeneration`（换服务器 / 凭据 / 仓库 / 导入连接递增）。解锁、派生元数据密钥、重置凭证、取回密钥文档、
  显式持久化在**安装前**核对代次，变了就作废（stale），绝不装上旧会话的钥匙；多次解锁按发起顺序安装。
  切库、导入连接、改 Server URL、服务器 vaultId 变化 → `switchContext({lock:true})` 立即锁定；Token 变化只作废进行中
  的任务、保留钥匙（v0.18 恢复路径）。解锁窗口关闭即取消这次解锁。
- **连接链接 v2（0.20 / ADR-014）**：新设备无凭据，靠 `GET /api/v2/pairings/{id}/envelope` 的状态码探测服务端能力
  （401/403/405 = 旧服务端）；兑换前把 `{exchangeId, enrollmentSecret,…}` 存 SecretStorage（`litesync-pending-redeem`），
  断网可续传。配对包信任锚先暂存在 `state.pendingPairingTrust`。0.20.1（复审 PL-06）：接入向导 preflight 在**任何本地
  落地或远端写入之前**核验它（身份、repoEpoch、可信水位、锚检查点仍在且之后的链是合法延伸），不通过 → 停止，
  给「重新配对 / 明确确认后改为首次信任」两条路，**绝不静默降级**；执行器与 completeBootstrap 都断言核验结果。
- **本地完整替换远端（0.20 / ADR-016）**：`bootstrap/replace-remote.ts`，作业存 `state.replaceJob`；
  恢复点写插件目录 `replace-recovery/<jobId>/`（不与 LocalCommitter 按周清理的 `recovery/` 混用）（唯一允许的直接写盘处，带路径校验）；
  未完成的作业在启动时冻结普通同步（gate.beginMigration，所有者 `replace-remote-job`）直到用户续跑或放弃。
  0.20.1（复审 PL-02～05）：**执行入口默认关闭**（设置 `replaceRemoteEnabled`，验收阶段；只读预览、诊断 / 放弃 / 回滚不受限）；
  「预留 fileId」≠「远端已建档」（`uploadFromPlain` 的 `identity`），路径加密建档总带 LSM1 + canonical HMAC；
  执行许可只豁免自己的迁移锁与向导里的 bootstrap 阶段；delete / keep / update / create 各有本地前置条件；
  墓碑上重建是持久化的 restore→upload 子状态机（稳定幂等键）；计划按 vault 文件清单的**确切名字**对齐
  （大小写不敏感的文件系统上 stat 会命中大小写不同的文件）；执行顺序新建先于删除。
- **显式恢复的元数据世代（0.20.1）**：服务器恢复后 `metaGeneration = 墓碑 + 1`。meta 模式下 `restoreObject`（普通 push、
  接入合并）与完整替换作业都让 LSM1 信封写同一个值（先向 `GET /api/v1/trash` 取墓碑世代）；取不到时恢复后补一次
  「改名到同一伪名」的 CAS 对齐（`alignRestoredMeta`；改名的幂等检查在 CAS 之后，重放 412 时读回核对）。
  信封、服务器、本地记账三者不一致的后果是：之后改名 412 退化成先建后删（身份断掉），其他设备误判同世代分叉。
- **多用户（v0.18 服务端）**：对插件透明——用户 Token 映射到自己的
  Vault，`/api/v1/info` 返回该 Vault 的 `vaultId`/epochs。插件不感知租户。

## 6. 平台约束（踩过坑的地方）

- **`Plugin.saveData` 写失败不报错**：Obsidian 的 `vault.writeJson` 里是 `try{…}catch{}`，data.json 只读、磁盘满、
  没权限时 `await saveData()` 照样成功返回。凡是「先落盘意图、再动服务器或清材料」的设置（旧信任迁移的标记与
  `clearing`）一律读回核对——`trust-migration.ts` 的 `saveTrustSettingsVerified`（WIN-12 真机实测：以前 data.json
  只读时照样上传新密钥文档、清掉 SecretStorage 并报成功，磁盘上却仍是待迁移）。
- **路径归一取最严解释**：`Note.md` 与 `note.md` 视为同一文件，NFC/NFD 同名。
  实测证据：**iOS 大小写敏感且做 Unicode 归一，Android 恰好相反**。按本地平台
  判断会让两台设备对「是否撞名」给出相反答案，然后互相覆盖。
- **原子替换靠运行时探测**，不靠假设（`diagnostics/platform-probe.ts`）；
  不可原子替换时退化为「新版本存在旁边」而不是冒险写半个文件。
- **移动端**：只能用跨平台 API（`requestUrl` / Web Crypto / `vault.adapter`），
  `npm run test:mobile` 会审计 Node/Electron 依赖；iOS 后台定时器会被系统暂停，
  因此靠 `visibilitychange` 补同步。
- **CI 跑三平台**（Linux / macOS / Windows），`tests/realfs.test.ts` 在**真实文件
  系统**上取证。移动端那一格跑不进 runner，由用户在真机上运行「平台兼容性自检」。

## 7. 测试组织

`tests/` 目录自动发现，当前 450 条（0.20.1 复审修复 + Windows 真机验收回归 + IDENTITY_UNAVAILABLE 后；0.20.0 时 361）。分类：

- `unit` / `merge` / `smart-merge` / `crypto` / `store` / `device-trust`：基础单元；
- `crashpoint.test.ts`：**崩溃点注入**（`utils/failpoint.ts` 在关键步骤间强制中断）；
- `adversarial.test.ts`：对抗性协议（恶意服务器的每一种伎俩）；
- `crossplatform.test.ts` / `realfs.test.ts` / `nonatomic.test.ts`：文件系统语义；
- `padding.test.ts` / `timing.test.ts`：隐私增强的成本与承诺；
- `v6 / v121 / v131 / v132 / rc3-regressions`：按版本归档的回归；
- `strict-unlock` / `pairing-v2` / `replace-remote` / `settings-layout`：0.20 公开化（严格解锁迁移、连接链接 v2、高级恢复作业、设置页结构）。
- `key-session` / `inherited-trust` / `replace-remote-safety` / `review-reproductions` / `restore-meta`：0.20.1 复审修复（PL-01 密钥会话代次、
  PL-06 继承锚核验、PL-02～05 完整替换的许可 / 前置条件 / 子状态机、审查 7 条反例改写为正确行为断言、
  路径加密下显式恢复后的元数据世代与之后的改名 CAS）。
  完整替换用的内存服务端在 `tests/fakes/replace-server.ts`（多个文件共用），按协议 v6 语义建模（墓碑挡住普通上传、
  operationId 幂等、LSE3 世代单调、**元数据加密态的建档 metadata 要求**、restore 幂等与按名移动）——
  改服务端语义时记得同步改它，否则测试会和真实服务器分叉。
- 真实服务端联调在 `scripts/interop/`（不进默认 npm test）：插件原样代码对固定版本的 Go 服务端跑内容加密 /
  路径加密两种仓库的完整替换、故障注入、重启续跑、反向恢复，逐对象解密核对，输出机器可读 JSON。
- `win-acceptance`：Windows 真实 Obsidian 验收（WIN-11）发现的缺陷回归——替换窗口里中断后的「继续执行」、
  仅大小写改名替换之后第一轮拉取的重放（大小写不敏感文件系统）、接入向导里的作业被强杀后重启时账本归属被误判作废。里面有一个只够驱动替换弹窗的最小 DOM 替身；
  联调 runner 只跑引擎、不跑「作业完成之后的普通同步」，这一段要靠宿主验收或这类测试兜住。

**新修一个 bug 就补一条回归测试，并标注它覆盖的 INV 编号。**

## 8. 发版流程

插件版本号有**四处**，漏一处 CI 会拒：

1. `package.json` 的 `version`
2. `manifest.json` 的 `version`
3. `versions.json`（追加一条 `"<版本>": "1.13.0"`）
4. `src/api/client.ts` 的 `PLUGIN_VERSION`

外加写 `docs/releases/<版本>.md` 发布说明——`release.yml` 会自动取用，
**这个目录会提交**（与 gitignored 的 `docs/开发计划/` 不同）。

然后推一个与 `manifest.json` 完全一致的 tag（**无 v 前缀**）→ CI 自动
lint / build / 出具 provenance / 起草 GitHub Release（草稿，人工点 Publish）。

## 9. 文档位置

| 路径 | 是否入库 | 内容 |
|---|---|---|
| `README.md` / `README.zh.md` | ✅ | 面向用户 |
| `AGENTS.md` / `CLAUDE.md` | ✅ | 面向开发者（本文；`CLAUDE.md` 只有一行 `@AGENTS.md`） |
| `docs/releases/` | ✅ | 各版本发布说明 |
| `docs/开发计划/` | ❌ gitignored | 计划书、ADR、交付说明、验收手册 |

**ADR 在 `docs/开发计划/v10/adr/`**（ADR-001…010），是协议级决策的权威出处；
`npm run check:adr` 保证代码里引用了它们。虽然不入库，改协议前请务必先读。

## 10. 工作约定

- **提交与推送只在用户明确指示时执行**（「提交」「发版」等）。
  提交人 `KJoner <KJoner@users.noreply.github.com>`，提交信息**中文**，
  末行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **验收循环**：用户按 `docs/开发计划/测试说明/LiteSync 验收测试手册.md` 在
  Windows 桌面 + iOS + Web 三端实测，用编号（T2.3、T3.2…）报告失败。
  职责是逐条区分「真 bug / 部署问题 / Obsidian 平台行为 / 设计如此」，
  修复后补回归测试，并**同步更新手册对应条目**。
- **先查部署版本**：出现「查看端行为像旧版」时，先 curl 用户服务器的静态资产
  确认部署的是哪一版——曾有一整轮「缺陷」实为 compose 固定了旧镜像标签。
- **隐私功能的说明文案由参数生成**（见 `utils/timing.ts` 的 `timingDisclosure`）。
  写死的说明是隐私功能里最有害的失真：参数改了而文案没改，等于对用户撒谎。

## 11. 已知的结构性缺口（别当成 bug 修）

- **服务器可以扣住一个你从未见过的文件**：没有本地锚点，也没有「给全了」的
  证明。这是结构性的，不是漏掉的功能。README 里如实写了。
- **时间混淆不隐藏「某个窗口里有没有编辑」**：那需要掩护流量，本项目不做，
  也不暗示自己做了。
- **大小填充只覆盖内容信封**，LSM1 / LSN1 未填充。
- **路径加密仍是 RC**：`complete` 不可逆，且迁移前备份仍含明文路径。
