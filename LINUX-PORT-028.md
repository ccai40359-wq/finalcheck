# Linux / macOS 移植（对齐 0.28.0）

基线：`aee049c`（release 0.28.0）。分支 `feat/linux-028`。

目标不是「Linux 能跑」，而是**所有机制与 Windows 版一致**，只把 Windows 专属的部分平台化。

## 改了什么

### 1. shell 必须是真 bash，不是 dash

`desktop/src/main/shell-resolver.mjs`

旧实现非 Windows 直接返回 `/bin/sh`。问题：Ubuntu/Debian 的 `/bin/sh` 是 **dash**，只认 POSIX sh。
而 `run_command` 的工具描述承诺「统一一种 shell 语法」，模型会写 `[[ ]]`、数组、`$'...'`、进程替换 —— dash 下全是语法错误。

**同一个提示词在不同平台产出不同行为**，与「一种 shell、一套语法」的设计目标直接矛盾。

现在按顺序解析：`/usr/bin/bash` → `/bin/bash` → `/usr/local/bin/bash` → `/opt/homebrew/bin/bash`，
都找不到才回落 `/bin/sh` 并**记 warning**（fail-visible，不静默降级）。

与 Windows 同口径用 `-c` 而不是 `-lc`：`-lc` 会加载 `/etc/profile` 和用户 profile，实测慢 4-5 倍，会触发命令空闲看门狗误判。

### 2. 路径集中化（XDG）

新增 `desktop/src/main/platform-paths.mjs`：

| 平台 | 配置目录 | 缓存目录 |
|---|---|---|
| Windows | `%APPDATA%\FinalCheck` | `%LOCALAPPDATA%\FinalCheck` |
| Linux | `~/.config/FinalCheck`（尊重 `XDG_CONFIG_HOME`） | `~/.cache/FinalCheck`（尊重 `XDG_CACHE_HOME`） |
| macOS | `~/Library/Application Support/FinalCheck` | `~/Library/Caches/FinalCheck` |

旧实现把 `homedir()/FinalCheck` 在 `hooks.mjs`、`diagnostics.mjs`、`usage-ledger.mjs` 各写了一遍 ——
Linux 改 XDG 时极容易漏一处。现在四个调用方（含 `sandbox.mjs` 的 temp）全部走这里。

⚠️ **必须按平台显式选 path API**（单测抓到的真 bug）：
`path.join` 是「当前运行平台」的实现。Windows 上跑 `appDataDir({platform:'linux'})`
会返回 `\home\u\.config\FinalCheck`（反斜杠）。所以用 `path.win32` / `path.posix` 显式指定，
与 `policy.mjs` 的 `pathApiFor` 同一口径。

### 3. ACL 沙箱在 Linux 上「不存在」≠「拒绝执行」

`desktop/src/main/agent-tools.mjs`

`@deepseek-ai/dsh-sandbox-windows-acl` 只有 Windows 后端。旧逻辑：

```js
if (!sandbox && sandboxOn) return { error: '已拒绝在宿主机执行' };
```

**Linux 用户一旦开启 `aclSandbox`（或设 `FINALCHECK_ACL_SANDBOX=on`），所有命令全部被拒。**

现在区分两种 null：

- **平台没有沙箱后端** → 降级到宿主机执行（应用层三道闸照旧：敏感路径 / 项目边界 / 删除目标）
- **平台有后端但这条命令跑不了** → 仍然拒绝（那是用户明确要求的写保护）

判据是新增的 `platformHasSandbox = sandboxAvailability().available === true`。

### 4. ripgrep 按平台分发

原来 `extraResources` 硬写 `../vendor/rg/rg.exe`。打 Linux 包时它**照样会被塞进去** ——
包里有个 Windows 二进制，能打包成功，但 Linux 上执行不了，`grep_code` 静默降级。
（这种失败模式最难查：打包不报错、启动不报错，只有搜索时悄悄变慢。）

- `desktop/scripts/prepare-rg.mjs`：按目标平台把正确的二进制复制到 `desktop/resources/rg/`，
  非 Windows 补 `chmod 755`（`copyFileSync` 会丢执行位）
- `desktop/scripts/fetch-rg-linux.mjs`：系统 rg 优先，否则下载官方 **14.1.1 musl 静态构建**
  （musl 不依赖 glibc，从 Ubuntu 20.04 到 Alpine 都能跑）
- `extraResources` 改为指向 `resources/rg`

### 5. electron-builder linux 目标

```json
"linux": { "target": ["AppImage", "deb"], "executableName": "finalcheck", "category": "Development" }
"deb": { "depends": ["bash", "git", "ripgrep"] }
```

`deb` 声明 `bash` 依赖是必须的 —— `run_command` 靠它。

脚本：`dist:linux`（AppImage + deb）、`dist:linux:dir`、`fetch:rg:linux`。

## 测试

`tests/linux-port-028.test.mjs`（17 项）+ 重写了 `tests/shell-resolver.test.mjs` 里那条
「非 Windows 走 `/bin/sh`」的断言（那正是要改掉的行为，不是要守住的不变量）。

**全量 1750 项全绿。**

真机冒烟（`.tmp/smoke-linux-028.mjs`，CDP）：主题切换、外观分节、无未捕获错误 —— 全 PASS。


## 沙箱：对齐 Claude Code（bubblewrap，不是 Docker）

Claude Code 在 Linux/WSL2 上的做法（官方文档 + 开源实现 `@anthropic-ai/sandbox-runtime`，Apache-2.0）：

| 组件 | 作用 |
|---|---|
| **bubblewrap** (`bwrap`) | 文件系统隔离 |
| **socat** | 把沙箱内流量经 Unix socket 中转到宿主代理 |
| seccomp（可选） | 额外封堵 Unix domain socket |

**不是 Docker。** 官方明确说内置沙箱「不加 Docker 依赖」；容器/VM 只在无人值守跑的场合才建议上，
因为只有外层边界能同时覆盖 MCP、hooks 和文件工具。

### 为什么直接用它的包，而不是自己拼 bwrap 参数

那份实现处理了一堆自己写必踩的坑（都写在它的源码注释里）：

- 读拒绝要用 `--tmpfs` 盖住整个目录，再把允许的子目录 `--ro-bind` 回来。
  源码专门提了 `/lib → /usr/lib` 这类符号链接：tmpfs 盖在 `/usr` 上之后链接还在，但指向的东西被藏了。
- `bwrap` 的 argv 长度有上限，超了要把挂载参数写进**匿名文件**，走 `--args <fd>`。
- deny 路径不存在时 `bwrap --ro-bind /dev/null <path>` 会在**宿主上建空文件**当挂载点，退出后要清理（带引用计数）。
- Ubuntu 的 AppArmor 会拦非特权 user namespace，要先探测再决定怎么跑。

**自己从零写，极可能漏掉「读隔离」这一整层** —— 而 FC 的 Windows ACL 沙箱恰恰就只拦写、不拦读。

### FC 的实现

`desktop/src/main/sandbox-linux.mjs`：

- `probeSandbox()`：查包在不在、平台支不支持、`bwrap`/`socat` 装没装，返回**带原因和可执行提示**的结果
- `buildSandboxConfig()`：产出 CC 语义的配置
  - **写：allow-only**（默认工作目录 + `/tmp` + 包管理器缓存）
  - **读：deny-then-allow**（默认拒绝 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.docker/config.json`、`~/.npmrc`、`~/.kube`、
    `~/.config/gcloud`，以及应用自己的数据目录 —— 里面存着 API Key）
  - **网络：allow-only 白名单**
- `wrapCommand()`：调 `SandboxManager.wrapWithSandbox`，返回**shell 命令字符串**

### 一个和 CC 不同的地方：网络默认白名单

CC 是「默认全断 + 手动加域名」。FC 的 agent 要连模型网关、`npm install`、`pip install`、GitHub ——
照搬会让用户装完就跑不动（每个域名都得手动加）。

这里的取舍：
- **默认**放行常见开发域名（npm/PyPI/GitHub/Go/Rust/Maven/Docker Hub，17 个）+ **自动把供应商 `baseUrl` 的 host 加进白名单**
- 用户可配 `sandboxStrictNetwork: true` → 只认自己填的（完全照 CC）
- 用户可配 `sandboxAllowNetwork: false` → 完全断网
- 用户可配 `sandboxAllowDomains` / `sandboxAllowWrite` / `sandboxDenyRead`

### 两个后端的调用契约不同（容易踩）

| | Windows ACL | Linux bwrap |
|---|---|---|
| 返回形状 | `{ file, args }` | `{ command }` |
| 怎么执行 | `spawn(file, args)` | 交给 shell 跑字符串 |
| 异步 | 同步 | **异步**（initialize 要起代理） |
| 隔离能力 | 只拦写 | **读写都拦** |
| 探测时机 | 同步（`require.resolve`） | 异步（要 spawn 查依赖） |

`agent-tools.mjs` 里按 `sandbox.args` / `sandbox.command` 分流；调用点用 `await createSandboxedRun(...)`。

### 沙箱不可用时的行为（Linux）

平台**没有**后端 ≠ 这条命令跑不了。前者降级到宿主机执行（应用层三道闸照旧：
敏感路径 / 项目边界 / 删除目标），后者仍然拒绝。判据是 `platformHasSandbox`。

## Playwright（截图兜底）

Linux 发行版默认**不带 Chrome/Chromium**（Ubuntu 只有 snap 版且路径不稳定，Debian/Alpine 默认没有）。
旧链在 Linux 上大概率直接「没有渲染器」，模型只能盲写 UI。

`desktop/src/main/capture-headless.mjs` 的后端优先级（2026-11-20）：

1. **Electron 二进制**（桌面端进程已在跑，最快）
2. **Playwright**（自带浏览器二进制，纯 Node / CI / CLI 环境兜底）
3. 系统 Chrome / Edge

Playwright 渲染走 `renderWithPlaywright`：`chromium.launch({ args: ['--no-sandbox', ...] })`。
**`--no-sandbox` 是必须的**：bwrap 沙箱里没有 user namespace 权限，Chromium 会以
"No usable sandbox!" 直接退出。这里是宿主侧截图（不是被沙箱化的命令），
真正的隔离由外层 bwrap 负责。

浏览器**不打包**（Chromium 一个就 150MB+，AppImage 会涨到 400MB+）。
由 `desktop/scripts/install-playwright-linux.mjs` 按需装：

```bash
node desktop/scripts/install-playwright-linux.mjs            # 只下浏览器
node desktop/scripts/install-playwright-linux.mjs --with-deps # 连系统库一起（需要 sudo）
```

不可用时的提示文案会给**精确命令**（不是「自己装 puppeteer」）。

## 还没做的（需要 Linux 机器）

| 项 | 为什么必须在 Linux 上 |
|---|---|
| 真打 AppImage / deb | electron-builder 的 Linux target 需要 Linux 宿主（或用 Docker） |
| **bwrap 真机执行** | 本机是 Windows，只验了配置构造与降级链（`.tmp/verify-sandbox-linux-logic.mjs` 全 PASS）；真 bwrap 调用要 `apt install bubblewrap socat` 后验 |
| **网络白名单真机验** | 要在真机上确认 npm install / pip install / 网关请求都通，而 `curl example.com` 被拦 |
| `git` / `bash` 依赖实测 | 声明了 depends，但没在干净 Ubuntu 上验过装完能不能起 |
| UI 截图逐屏核对 | 字体渲染、DPI、窗口装饰在不同发行版差异大 |
| `policy.mjs` 的 POSIX 分支 | 路径分隔符、`~` 展开、软链接解析的行为差异 |
| 多尺寸图标 + 字体栈 | 目前只有 `build/icon.png` 一个尺寸；Linux 需要 16/32/48/64/128/256 的多尺寸 |
| Playwright `--with-deps` | 要在干净 Ubuntu 上跑一次，确认系统库装全（libnss3/libatk/libgbm 等） |

## 已知非阻塞问题

- `sandbox-runner.mjs` 用 `koffi.load('kernel32.dll')` + `AllocConsole`，只能在 Windows 跑。
  它由 `sandbox.mjs` 的 `process.platform !== 'win32'` 挡住，Linux 上根本不会被 spawn —— 不必改。
- `better-sqlite3` 的预编译清单**已经覆盖 Linux**（含 `linuxmusl-x64`、`linux-arm64`），
  `ensure-sqlite-binding.mjs` 也有 glibc/musl 分支 —— 这块不用动。
  但打包时 `npmRebuild: false` 会原样带上当前平台的 `.node`，所以**必须在 Linux 上跑一次 `npm install`**
  才能拿到 Linux 版二进制。
