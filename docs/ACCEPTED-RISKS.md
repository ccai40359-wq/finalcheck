# ACCEPTED RISKS — FinalCheck 自查遗留项

记录日期：2026-11-11
复核日期：2027-01-31（到期前重跑 `npm audit`；有可用的 patch/minor 修复就升级，不再延续豁免）

本文件只登记**已确认、当前不修**的风险。修掉的项不在此列。所有条目都写清风险面与不修理由，避免“报告里没有 = 已解决”的假象。

## 1. S4 依赖 CVE（desktop，npm audit）

基线：`cd desktop && npm audit --json` → 14 条（3 high / 11 moderate）。
仓库根 `npm audit` → 0 条。

### 已做的升级

- `electron-builder` `26.18.0` → `26.18.1`（patch，v26 dist-tag 的补丁版）。升级后 audit 仍为 14 条，见下。

### 当前无法在 patch/minor 范围内修复的条目

> 编号列使用 GHSA advisory 标识（npm audit 返回的权威 ID；部分 advisory 同时有 CVE 别名，以链接页面为准）。

| 包 | 当前版本 | 漏洞范围 / 编号 | 级别 | direct | 不修理由 | 风险面 | 复核 |
|---|---|---|---|---|---|---|---|
| `electron` | 33.4.11（33.x 最新） | `<=42.11.15`；GHSA-vmqv-hx8q-j7mg、GHSA-5rqw-r77c-jp79、GHSA-xj5x-m3f3-5x3h、GHSA-r5p7-gp4j-qhrx、GHSA-3c8v-cfp5-9885、GHSA-xwr5-m59h-vwqr、GHSA-532v-xpq5-8h95（high）、GHSA-mwmh-mq4g-g6gr、GHSA-9w97-2464-8783、GHSA-8337-3p73-46f4（high）、GHSA-jjp3-mq3x-295m（high）、GHSA-jfqx-fxh3-c62j、GHSA-4p4r-m79c-wq3v、GHSA-9899-m83m-qhpj、GHSA-8x5q-pvf5-64mp、GHSA-f37v-82c4-4x64、GHSA-f3pv-wv63-48x8、GHSA-9wfr-w7mm-pc7f（high）、GHSA-jm7p-cc5g-qwxx、GHSA-v3j7-r9gq-3gjw（high）、GHSA-m55f-7gqj-fr98、GHSA-5c9j-mhmv-5xgx、GHSA-h7rp-cf8h-j98x（high）、GHSA-x8rc-wpg4-grpf、GHSA-9pf5-hg6p-4pwp、GHSA-pfmc-3mgc-p6fp、GHSA-v64r-4m7r-3mvq、GHSA-v93f-fgjr-hjrj、GHSA-9f4c-93c8-jc8g（high）、GHSA-p2rr-rvmm-c5fp、GHSA-f2r8-jv7c-xqmp、GHSA-ff2p-hmqr-hxm4、GHSA-4f78-qhmw-8j8m、GHSA-hq2x-r82h-9wj4（high）、GHSA-gr2m-v5gq-v685（high）、GHSA-j84w-jfhq-vhvj（high）、GHSA-vv43-5jgx-7qv8、GHSA-9qh4-3jw8-366w（high）、GHSA-fw47-9c62-h3vw、GHSA-2p8c-gr87-2676、GHSA-x562-297c-g43g、GHSA-98mx-cjp9-gchm、GHSA-3qxv-5xgr-q7w9、GHSA-h3v5-h239-pg29、GHSA-997q-gvvc-jwmx、GHSA-jr5w-w6x2-84p9（high） | high | yes | **不升大版本**：`better-sqlite3@12.11.1` 绑定 Electron 33 的 ABI 130；Electron 45 需要重编原生模块并回归全部桌面端路径。33.4.11 已是 33.x 末版，无 33.x 补丁可用。 | 桌面端本地进程、渲染器与 IPC；不对外托管服务。攻击面限于恶意页面/第三方内容触发 Electron 已知缺陷。 | 2027-01-31 |
| `extract-zip` | 2.0.1（最新） | `<=2.0.1`；GHSA-jmr9-qjv8-65gv（high）、GHSA-7pqw-9j4j-h8q3（high） | high | no（经 `@electron/get` / electron-builder 传递） | 该包没有已发布的修复版；npm 给出的修复路径是升级 `electron` 到 45（大版本）。 | 解压安装包/更新包时处理符号链接归档；来源限定为 GitHub Releases 的本项目产物，不接受用户任意 zip。 | 2027-01-31 |
| `vite` | 5.4.21（5.x 最新） | `<=6.4.3`；GHSA-4w7w-66w2-5vf9、GHSA-v6wh-96g9-6wx3、GHSA-698v-4r3x-3vcv、GHSA-r825-w8mm-5pxw、GHSA-587h-7wmj-h5pm（high）、GHSA-9jrq-w75r-8gcw、GHSA-rq7h-c2jc-7f22、GHSA-fx2h-pf6j-xcff | high | yes | 修复在 vite 6.4.4+/7/8；`electron-vite@2.3.0` 当前只兼容 vite 5，升 vite 必带 electron-vite 大版本，超出本次 patch/minor 范围。 | 仅开发期 dev server / `launch-editor`；生产安装包不运行 vite。 | 2027-01-31 |
| `electron-vite` | 2.3.0 | `<=3.0.0`；经 `esbuild` / `vite` | moderate | yes | 修复需 6.0.0 大版本；与 vite 5 / Electron 33 工具链一起升级，风险与收益不匹配。 | 仅构建期；不进入安装包运行时。 | 2027-01-31 |
| `esbuild` | 0.21.5 | `<=0.24.2`；GHSA-67mh-4wv8-2f99 | moderate | no（vite 传递） | 升到 0.25+ 改变 0.x 行为，且需 vite 大版本；本地 dev server 默认只监听本机。 | 开发期 dev server 可被网页探测/读取响应；不暴露公网。 | 2027-01-31 |
| `autocannon` | 7.15.0（7.x 最新） | `2.1.0 - 8.0.0`；经 `hyperid`/`uuid` | moderate | yes | 修复需 9.0.0 大版本（API 变化）；压测是用户显式触发的本地能力。 | 只对用户指定的本机/授权目标做压测；不后台常驻。 | 2027-01-31 |
| `electron-builder` | 26.18.1 | `>=25.1.2`；经 `app-builder-lib`/`dmg-builder` | moderate | yes | 已升到 v26 补丁（26.18.1）；audit 的修复建议是奇怪的 25.1.0 降级，不能采用。 | 仅打包机本地执行；不进入最终用户运行时。 | 2027-01-31 |
| `@electron/universal` | 2.0.3（传递） | `1.5.0 \|\| 2.0.0 - 3.0.3`；经 `minimatch` | moderate | no | 随 electron-builder 传递；独立覆盖 minimatch 有破坏打包链风险。 | 构建期 glob/路径处理；输入为本仓库文件树。 | 2027-01-31 |
| `app-builder-lib` | 26.18.1（传递） | `>=24.13.4-alpha.0`；经 `@electron/universal`/`dmg-builder`/`electron-builder-squirrel-windows`/`minimatch` | moderate | no | 同上，随 electron-builder 升级；无法在不改大版本的情况下消除。 | 构建期。 | 2027-01-31 |
| `dmg-builder` | 26.18.1（传递） | `24.13.4-alpha.0 - 25.0.6 \|\| >=25.1.2`；经 `app-builder-lib` | moderate | no | 同上；Windows 构建不走 dmg 分支（macOS 打包才用）。 | macOS 打包路径；本项目主要发 Windows。 | 2027-01-31 |
| `electron-builder-squirrel-windows` | 26.18.1（传递） | `24.13.4-alpha.0 - 25.0.6 \|\| >=25.1.2`；经 `app-builder-lib` | moderate | no | 同上；Squirrel 分支仅在对应 target 使用。 | Windows Squirrel 打包分支。 | 2027-01-31 |
| `minimatch` | 10.2.6 / 9.0.9（传递，2 处） | `7.0.0 - 11.0.0`；GHSA-g3hv-75wg-m249 | moderate | no | 修复版 11.0.1 是 patch，但当前由 electron-builder 依赖；直接 override 可能改变 glob 语义，先记录。 | 构建期 glob 放大 DoS；输入为本仓库路径。 | 2027-01-31 |
| `uuid` | 8.3.2（传递） | `<11.1.1`；GHSA-w5hq-g745-h8pq | moderate | no | 经 autocannon；修复需升级 autocannon 到 9（大版本）。 | 压测请求 ID 生成；本地。 | 2027-01-31 |
| `hyperid` | 3.3.0（传递） | `<=1.2.0 \|\| 1.3.1 - 3.3.0`；经 `uuid` | moderate | no | 同上。 | 压测请求 ID；本地。 | 2027-01-31 |

> 复核动作：到期前重跑 `cd desktop && npm audit --json --registry=https://registry.npmjs.org`。若 Electron 33.x 出现补丁版可升；若项目决定升级 Electron 大版本，必须同步重编 `better-sqlite3` 并跑完整桌面回归，不能只改版本号。

## 2. S3 密钥字面量

- **测试 / 红队脚本 / 文档示例**：21 条经 `.finalcheck/accept.json` 逐条登记（`rule + file + line + 行指纹 + reason + expires=2027-01-01`）。这些是合成值或教学示例，不是真实凭据；到期后自动重新报警。历史提交 `7ffc83b7` 中的同类值也是合成值，**不做历史重写**（重写会改变所有后续提交哈希，风险高于收益）。
- **本机 `desktop/config.json`**：`S3.untracked-secret-file` 仍保留为 check 级提示。该文件被 `.gitignore` 排除，是桌面端 **Settings → Model settings** 写 API key 的既定落盘位置；报告与备份均不回显 key（备份脚本会脱敏为 `[REDACTED]`）。这是“本机明文存储”的已知风险：如果这台机器的用户目录曾被共享/备份到第三方，应由用户自行轮换该网关 key；本次未轮换任何线上 key。
- 真实密钥判定：本次检查到的所有 `sk-*` / PEM 头 / 弱口令均出现在测试、红队临时脚本或规则示例中；未发现产品代码里的真实凭据。

## 3. Q3 超大文件（不强行拆分）

已做的低风险拆分（纯函数、无闭包状态，导出兼容）：

- `src/checks/handover.mjs` 879 → 475 行：命令静态解析抽到 `src/command-parse.mjs`（409 行）。
- `src/extract-routes.mjs` 801 → 759 行：路由路径纯函数抽到 `src/route-path.mjs`（45 行）。

仍超过阈值、暂不拆分的文件：

| 文件 | 行数 | 级别 | 为什么不拆 | 计划 |
|---|---|---|---|---|
| `desktop/src/main/workflow-script.mjs` | 2504 | high | 受限脚本 DSL 的解析/执行/沙箱共享大量闭包状态；拆开会产生跨模块隐式契约。 | 2027-Q2 随 DSL 版本化一起拆 |
| `desktop/src/main/sessions.mjs` | 1921 | high | 会话存储、迁移、恢复、指标写在同一事务边界；拆开容易破坏迁移顺序。 | 2027-Q2 先补迁移契约测试 |
| `desktop/src/main/agent-service.mjs` | 1897 | high | Agent 主循环、工具分发、流式消费、取消/恢复共享运行时状态；强耦合。 | 2027-Q2 先抽纯格式化/分类函数 |
| `desktop/src/main/workflow.mjs` | 1817 | high | DAG 调度、journal、resume、并发控制互相依赖；拆分回归面大。 | 2027-Q2 |
| `desktop/src/renderer/App.jsx` | 1562 | high | 单页 UI 状态与布局耦合；本次要求不改 UI。 | 2027-Q3 先抽纯展示组件 |
| `desktop/src/renderer/pages/SettingsPage.jsx` | 1290 | medium | 设置表单与 IPC 校验耦合；改结构会动 UI。 | 2027-Q3 |
| `desktop/src/renderer/chat/TraceCards.jsx` | 1065 | medium | 轨迹卡片渲染与数据形状耦合。 | 2027-Q3 |
| `desktop/src/main/swarm.mjs` | 974 | medium | 多代理协作/claims 校验与调度状态耦合。 | 2027-Q2 |
| `desktop/src/renderer/pages/UsagePage.jsx` | 804 | medium | 仅略超阈值；改 JSX 会动 UI。 | 2027-Q3 |

**循环依赖**：`desktop/src/main/workflow.mjs` ↔ `workflow-script.mjs` 被 Q3 判为 high。原因：DSL 执行要复用 DAG 引擎的提示词、步骤哈希、复核超时与对抗复核判定；`workflow.mjs` 又需要 `runScriptWorkflow` 作为入口。当前 ESM 活绑定只在调用时取值，测试与生产运行都未出现初始化失败，因此本次不拆。计划 2027-Q2 随 DSL 版本化把纯助手（prompt/hash/verify）抽到 `workflow-core.mjs`，两个入口再各自引用。

## 4. 其他

- **D2 备份**：已补 `scripts/backup.mjs`（可执行、带保留期、配置脱敏），D2 现在有 card 级实锤，不再登记风险。
- **H1 交接**：README 已补安装 / 运行 / 环境变量 / 部署 / 回滚五段，修正目录名与 `npm run dev`，并补 `.env.example`。
- **S4 根目录**：`npm audit` 0 条；无遗留。
