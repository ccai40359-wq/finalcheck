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
"deb": { "depends": ["bash", "git", "ripgrep", "bubblewrap", "socat"] }
```

`deb` 声明 `bash` 依赖是必须的 —— `run_command` 靠它。`bubblewrap` + `socat` 是沙箱硬依赖（真机已验）。
AppImage 没法声明系统依赖：缺了就走 `probeSandbox()` 的 fail-visible 链（明确报「缺什么 + 给 apt 命令」，
不会静默假装有沙箱）。

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

## WSL2 真机验证（2026-11-20，Ubuntu 24.04.4 / Node 22.22.2）

Windows 侧只做了「逻辑验证」，之后在 WSL2 Ubuntu 上真跑，**抓到两个只有真机才暴露的 bug**
（都是「Linux 上功能整个失效」级别）：

### Bug 1：POSIX 绝对路径完全绕过项目边界闸

`policy.mjs` 的 `literalPathsIn()` 只匹配两类路径：Windows 盘符（`C:\...`）和家目录写法
（`~` / `$HOME` / `%USERPROFILE%`）。**纯 POSIX 绝对路径（`/etc/passwd`、`/var/log/x`、
`/home/other/f`）一条都匹配不到**，于是 `checkCommandPaths` 直接 `ok: true` ——
在 Linux 上「项目外的路径整条拒绝」这道闸**等于不存在**（安全降级，不是功能缺失）。

修法：加一条 POSIX 绝对路径正则（词首边界，排除 `//server/share` 与 `/b` 这类单字母开关）；
另外 `resolveCommandPath` 里三处用了**宿主平台**的 `path`（`isAbsolute` / `join` / `resolve`），
改为按 `policy.platform` 选 `path.win32` / `path.posix`。

Linux 真机验证：

| 命令 | 结果 |
|---|---|
| `cat /etc/passwd` | `ok:false path-outside` ✅ |
| `cp /var/log/syslog ...` | `ok:false path-outside` ✅ |
| `rm /home/other/f` | `ok:false path-outside` ✅ |
| `cat ./a.txt`（项目内） | `ok:true` ✅ |
| `cat <项目内>/a.txt` | `ok:true` ✅ |
| `ls /b` | `ok:true`（单字母开关不误拦）✅ |
| `cat ~/.ssh/id_rsa` | `ok:false sensitive-path` ✅ |

### Bug 2：Linux 上 Q1 永远失败 → 所有项目都被判「无法验收」

`src/checks/q1.mjs` 的 `npmTest()` 只认一条路径 ——
`path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', <npm 入口>)`。
Windows 官方安装器下 npm 和 node.exe 装在一起，成立。
**Linux 上 npm 是发行版单独装的**：实际在 `/usr/lib/node_modules/npm/bin/`，
而 node 的 execPath 是 `/usr/bin/node` → 找 `/usr/bin/node_modules/...` → 永远不存在。

后果：Q1 每轮都报「npm 入口未找到」→ 记「覆盖不足」→ `verdict = 无法验收`。
**Linux 上任何项目都过不了验收**，这是最严重的跨平台假红。

修法：`resolveNpmCli()` 按序找 —— ① node 同目录 ② PATH 上的 npm（Linux 是符号链接）
③ `/usr/lib` / `/usr/local/lib` / Homebrew 常见位置。
Linux 真机验证：最小项目 `checkQ1` → `coverageGap: (none)`、`findings: 0`。

### 附带修掉的（移殖一致性，不算独立 bug）

- **`INCOMPATIBLE_HEADS` 是 Windows ACL 专属清单**（受限令牌下 node/npm/grep 拿不到命名管道
  与 cygwin 共享内存）。Linux 的 bwrap 没这个限制 —— 不短路的话这些命令会被判「沙箱不支持」
  而统统落到宿主机，沙箱形同虚设（**静默安全降级**）。现在非 Windows 直接返回 `compatible: true`。
- **`grep_code` 在 Linux 上没有回退**：旧代码「没装 rg」直接报错「当前平台没有 findstr 兜底，
  请安装 ripgrep」。但 grep 是 POSIX 标准工具、系统必然自带 —— 补了 `grepCodeGnuGrep`
  （`-n -H -I -E`，支持正则，比 findstr 的 literal-only 更强）。
- **应用自己的配置目录没被保护**：`policy.mjs` 只认 `%APPDATA%\FinalCheck`。Linux 上配置在
  `~/.config/FinalCheck`（XDG），里面的 `config.json` **存着 API Key** —— agent 一个 read_file
  就能读出来。现在按平台补上 XDG / macOS 路径。
- **Playwright 就绪判定看错文件**：`chromium.executablePath()` 只反映**完整浏览器**目录，
  而 `chromium.launch()` 默认用 **headless shell**（分开下载的两份产物）。只装一份时前者
  返回非空、真截图才炸。现在 probe 会 stat 检查文件真实存在；`renderWithPlaywright` 在缺
  headless shell 时**扫描缓存找任意已装 chromium** 兜底。

### 测试结果

| 环境 | 结果 |
|---|---|
| Windows（开发机） | **1765 通过 / 0 失败** |
| Linux（WSL2 Ubuntu 24.04） | **1759 通过 / 0 失败 / 16 条跳过** |

跳过的 16 条全是 Windows 专属机制（ACL 受限令牌沙箱、findstr 回退、Git Bash 解析），
Linux 上本就不适用。

### agent 工具链真机 E2E（WSL2）

除了跑测试，还单独验了「模型真调用工具时能不能用」：

| 能力 | 结果 |
|---|---|
| `run_command` 基本执行（`echo` / `pwd`） | ✅ |
| bash 数组 `arr=(a b c)` + `${#arr[@]}` | ✅ 真 bash，不是 dash |
| bash `$'a\tb'` 转义 | ✅ |
| bash `$((3+4))` 算术 | ✅ |
| bash 进程替换 `diff <(echo a) <(echo b)` | ✅ |
| bash `[[ ]]` 字符串比较 | ✅ |
| 管道 / 重定向 | ✅ |
| 项目外绝对路径 `/etc/passwd` | ✅ 被 `path-outside` 拒 |
| 敏感路径 `~/.ssh` | ✅ 被 `sensitive-path` 拒 |
| 项目内 `read_file` | ✅ |
| 没 rg 时 `grep_code` 回退 | ✅ `grep (GNU)`，支持正则，无 literal-only 限制 |
| 有 rg 时 `grep_code` | ✅ `ripgrep` |

**结论：`run_command` 在 Linux 上真的是 bash 语义（数组/`$'...'`/进程替换全通过）**，
这是「一种 shell、一套语法」这个承诺在 Linux 上成立的关键证据。

### 沙箱真机验证（2026-11-20，bubblewrap 0.9.0 + socat 1.8.0，全 PASS）

`scripts/linux/verify-sandbox.mjs`（入库，可用 `FC_DIAG=1` 看实际包装命令）。两层 15 项：

**A. 内核层（wrapCommand 直连 bwrap）**

| 项 | 结果 |
|---|---|
| `probeSandbox` available | ✅ |
| bwrap 启动、沙箱内命令能跑 | ✅（AppArmor / userns 环境坑没有出现） |
| 白名单内（项目目录）可写 | ✅ |
| 写 `/etc` 被拦（白名单外只读） | ✅ 且宿主上**真的没有**出现探针文件 |
| 写 `~` 被拦（家目录不在写白名单） | ✅ 同样验了宿主无泄漏 |
| denyRead 目录被读隔离（tmpfs 盖住） | ✅ 哨兵文件在沙箱里不可见 —— **这是 Windows ACL 沙箱没有的能力** |
| 沙箱内是真 bash（数组语法） | ✅ |
| `curl example.com` 被拦 | ✅ |
| `curl registry.npmjs.org` 放行（200） | ✅（宿主基线 200，排除 WSL 断网干扰） |

**B. FC 集成层（`run_command` + `aclSandbox`）**

| 项 | 结果 |
|---|---|
| `ensureLinuxSandboxProbe` available | ✅ |
| 命令走沙箱执行、无降级宿主机警告 | ✅ |
| 项目外路径先被应用层闸拦（防御纵深顺序：policy 在 bwrap 前） | ✅ |

### 实际包装命令（FC_DIAG=1 抓到的，机制记录）

```
bwrap --new-session --die-with-parent
  --unshare-net --unshare-pid --unshare-user --cap-drop ALL
  --bind /tmp/claude-http-<hash>.sock /tmp/claude-http-<hash>.sock   # 宿主代理的 unix socket 桥进来
  --ro-bind / /                                   # 全盘只读
  --bind <每条 allowWrite 一条 rw bind>           # 项目目录、/tmp、~/.npm、~/.cache
  --tmpfs ~/.ssh …                                # denyRead 目录 → tmpfs 盖住
  --ro-bind /dev/null <敏感单文件>                # denyRead 单文件（.docker/config.json、.gitconfig…）
  --dev /dev --proc /proc
  -- /usr/bin/bash -c '<桥接脚本 + apply-seccomp + 用户命令>'
```

桥接脚本（沙箱内）：

1. 起两个 socat 桥：`TCP-LISTEN:3128 → UNIX-CONNECT:<socket>`（HTTP）与 `TCP-LISTEN:1080 → …`（SOCKS）。
   **数据路径 = 沙箱进程 → TCP localhost:3128（沙箱内 socat）→ unix socket（跨 namespace，靠 bind mount）→
   宿主代理进程 → 域名白名单判定 → 出网。** 白名单在宿主侧执行，沙箱内根本出不去。
2. `HTTP(S)_PROXY / ALL_PROXY / GRPC_PROXY` 全指向 `http://srt.<b64user>:<一次性token>@localhost:3128`
   （凭据每次 initialize 轮换）；连 `GIT_SSH_COMMAND`（socat ProxyCommand）、`FTP_PROXY`(socks5h:1080)、
   `DOCKER_*`、`CLOUDSDK_*` 都覆盖了，Java 走 `JAVA_TOOL_OPTIONS -javaagent:…/srt-proxy-agent.jar` ——
   环境变量代理 Java 不认，库自带 agent 补上。
3. 等 `/proc/net/sockstat` 里两个监听都起来（最多 30s），`trap` 退出时杀掉两个 socat。
4. 用户命令最后包在 `apply-seccomp`（库自带，按架构选二进制）里执行，再拦一层（嵌套 userns 等）。

### 安装依赖

```bash
sudo apt-get install -y bubblewrap socat   # deb 安装的用户不需要：depends 已声明
node scripts/linux/verify-sandbox.mjs      # 装完自检
```

### 我引入的一个严重回归（已修）

加 POSIX 绝对路径支持后，`> /dev/null`、`2>/dev/null` 被当成「项目外文件」整条拒绝：

```
echo hi > /dev/null     → path-outside 拒绝
echo hi 2>/dev/null     → path-outside 拒绝
```

这是 bash 里**最常见的写法**（模型也天天写），比「漏拦」更糟 —— 一条命令里只要带
一个 `2>/dev/null` 就全废。修法：`/dev/null`、`/dev/stdout`、`/dev/stdin`、
`/dev/stderr`、`/dev/tty`、`/dev/fd/N` 这类设备文件放行（它们不是「项目外的文件」）。
已补回归测试锁住。

教训：**宽化一个「默认拒绝」的闸，必须同步枚举所有合法例外**，
否则会把日常写法全禁掉。这类回归只有真机跑才会暴露（Windows 上 `> /dev/null`
写法会被 cmd 解释成 `2>nul`，路径闸根本看不到 `/dev/null`）。

### 发现但**未修**的既有缺陷（不是移植引入）

**`~` 词首被误判成路径，导致 `echo ~` 这类命令被拒。**

```
echo ~            → path-outside 拒绝（但 echo ~ 只是打印字符串，不访问文件）
echo a=~b         → path-outside 拒绝（=~ 是 bash 正则运算符，不是家目录）
```

规则本身是对的边界（`cat ~/.bashrc` 在 workspace 模式该拒），
问题在于**无法区分「命令参数里的路径」和「数据里的字面量」**。
Windows 上同样存在（`~` 展开成 `C:\Users\...` 后也是项目外）。

修它需要策略层设计决策（比如：只对「读/写类命令的词」做路径展开，
不对 `echo`/`printf`/`=` 右侧做）。**超出移植范围，留给后续**。
影响面：模型想查家目录路径时会拿到一个明确的拒绝（不是静默失败），
可以改用 `$HOME` 或直接读项目内文件绕过。


### 怎么在 WSL 里复现这套验证

```bash
# 0) 沙箱依赖（真机验证要用；WSL 默认没装）
sudo apt-get install -y bubblewrap socat

# 1) 复制到 WSL 原生盘（跨 /mnt/d 跑 Node 慢，且 git worktree 在 /mnt 下解析不了）
mkdir -p ~/fc && cd /mnt/d/rcw-geo/wt-linux-028 \
  && tar -cf - --exclude=node_modules --exclude=.git . | (cd ~/fc && tar -xf -)

# 2) 装依赖
cd ~/fc/desktop && npm install

# 3) better-sqlite3 的 Node 版预编译（仓库自带清单，含 linux / linuxmusl / arm64）
node scripts/ensure-sqlite-binding.mjs

# 4) 跑全量
cd ~/fc && node --test tests/*.test.mjs

# 5) 沙箱真机自检（15 项；FC_DIAG=1 可看实际 bwrap 包装命令）
node scripts/linux/verify-sandbox.mjs

# 6) 截图兜底（可选）
node desktop/scripts/install-playwright-linux.mjs
```

**踩过的坑**：WSL 里 `npm install` 之后必须**单独跑** `ensure-sqlite-binding.mjs` ——
否则 better-sqlite3 缺原生 `.node`，一路报 `Cannot find module 'better-sqlite3'`，
所有碰会话库的测试全红（看起来像代码 bug，其实是环境没装好）。

## 还没做的（需要 Linux 机器）

| 项 | 为什么必须在 Linux 上 |
|---|---|
| deb 包真打 + `dpkg -i` 安装实测 | AppImage 已真打+真跑（见下）；deb 首次打挂在元数据缺失（已补 author.email/homepage），重试待跑通 |
| `git` / `bash` 依赖实测 | 声明了 depends，但没在干净 Ubuntu 上验过装完能不能起 |
| UI 截图逐屏核对 | 字体渲染、DPI、窗口装饰在不同发行版差异大（WSL2/WSLg 下已过一轮） |
| `policy.mjs` 的 POSIX 分支 | 路径分隔符、`~` 展开、软链接解析的行为差异 |
| 多尺寸图标 + 字体栈 | 目前只有 `build/icon.png` 一个尺寸；Linux 需要 16/32/48/64/128/256 的多尺寸 |
| Playwright `--with-deps` | 要在干净 Ubuntu 上跑一次，确认系统库装全（libnss3/libatk/libgbm 等） |

## 端到端用户体验验证（2026-11-21，WSL2 + WSLg，9/9 PASS ×2）

**源码运行与打包 AppImage 两条形态各跑一遍完整用户旅程**（`FC_DIAG` 式 CDP 驱动 + 每步截图断言）：

| 步骤 | 结果 |
|---|---|
| 启动 → 中文界面、模型已配置（deepseek-v4.1-flash-eco） | ✅ |
| 发「你好」→ 真模型回复（含工具卡片：Terminal/Read） | ✅ |
| `/` 菜单出现 **/new 新对话** 与 **/resume 选老会话**（新增的立即执行型命令） | ✅ |
| `/new` 立刻清空开新会话 → 再问一句收到回复 | ✅ |
| `/resume` 弹会话选择器（标题/轮数/时间、当前会话高亮）→ 切回老会话旧消息完整 | ✅ |
| `kill -9` 进程重启 → 会话都在、切回内容完整 | ✅ |
| PAGE_ERRORS | 0 |

打包版：`fc-0.28.0.AppImage`（147MB，electron-builder，npmmirror 镜像出包），
`--appimage-extract-and-run`（WSL 缺 libfuse2 的兜底）+ `--no-sandbox` 全流程同 9/9。

### 这轮挖出的环境/工程事实

- **dev 模式数据根是 `desktop/`**（`index.mjs:25`：`path.resolve(__dirname,'..','..')`）——
  放 `~/.config/FinalCheck` 的 config/projects **只有打包版（userData）或 `FINALCHECK_UI_SELFCHECK=1` 才会被读**。
  自检模式就是为此设计的：`FINALCHECK_UI_SELFCHECK=1` → userData 隔离到 `$TMP/fc-ui-selfcheck`（固定目录，可预置）。
- **打包版进程名是 `finalcheck`**（`executableName`），`pkill electron` 杀不到它；残留实例会占单实例锁，新实例静默退出（`gotLock=false` 直接 quit）→ 表现为「CDP 起不来」。
- **Windows 侧 C 盘满（Temp 86G）会造成 wsl.exe 输出中转假象**（空输出 / tr write error），与 WSL 内真实状态无关——排查时先看 `df -h /c`。
- electron-updater 在 Linux 上查 GitHub releases 报 `latest-linux.yml` 404（v0.29.1 没传该资产）→ 非致命噪声，但自动更新对 Linux 包同样是坏的（与 Windows 端已知问题同源）。
- `ensureDefaultProject()` 在启动链两处调用（`index.mjs:224` / `backend.mjs:92`）无并发保护，实测会建出两个同名默认项目（竞态，Windows 上因已有默认项目未现形）。

### /new 与 /resume（对齐 claude CLI 的会话切换）

- `app-helpers.mjs COMMANDS` + `App.jsx chooseSlash`：UI 动作命令**立即执行**（与 /compact /workflow 的「只插入文本」分流）；
- `/resume` 渲染会话选择器浮层（当前项目、按更新时间倒序、Esc/点背景关闭）。

## 已知非阻塞问题

- `sandbox-runner.mjs` 用 `koffi.load('kernel32.dll')` + `AllocConsole`，只能在 Windows 跑。
  它由 `sandbox.mjs` 的 `process.platform !== 'win32'` 挡住，Linux 上根本不会被 spawn —— 不必改。
- `better-sqlite3` 的预编译清单**已经覆盖 Linux**（含 `linuxmusl-x64`、`linux-arm64`），
  `ensure-sqlite-binding.mjs` 也有 glibc/musl 分支 —— 这块不用动。
  但打包时 `npmRebuild: false` 会原样带上当前平台的 `.node`，所以**必须在 Linux 上跑一次 `npm install`**
  才能拿到 Linux 版二进制。
