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

## 还没做的（需要 Linux 机器）

| 项 | 为什么必须在 Linux 上 |
|---|---|
| 真打 AppImage / deb | electron-builder 的 Linux target 需要 Linux 宿主（或用 Docker） |
| `git` / `bash` 依赖实测 | 声明了 depends，但没在干净 Ubuntu 上验过装完能不能起 |
| UI 截图逐屏核对 | 字体渲染、DPI、窗口装饰在不同发行版差异大 |
| `policy.mjs` 的 POSIX 分支 | 路径分隔符、`~` 展开、软链接解析的行为差异 |
| 多尺寸图标 + 字体栈 | 目前只有 `build/icon.png` 一个尺寸；Linux 需要 16/32/48/64/128/256 的多尺寸 |

## 已知非阻塞问题

- `sandbox-runner.mjs` 用 `koffi.load('kernel32.dll')` + `AllocConsole`，只能在 Windows 跑。
  它由 `sandbox.mjs` 的 `process.platform !== 'win32'` 挡住，Linux 上根本不会被 spawn —— 不必改。
- `better-sqlite3` 的预编译清单**已经覆盖 Linux**（含 `linuxmusl-x64`、`linux-arm64`），
  `ensure-sqlite-binding.mjs` 也有 glibc/musl 分支 —— 这块不用动。
  但打包时 `npmRebuild: false` 会原样带上当前平台的 `.node`，所以**必须在 Linux 上跑一次 `npm install`**
  才能拿到 Linux 版二进制。
