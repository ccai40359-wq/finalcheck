# MXC Windows 沙箱可行性 PoC（FC quality_gate / Q1 / Q2）

- 日期：2026-11-12
- 分支：`poc/mxc-sandbox`（基于 `main 0a4481c`）
- 目的：验证 Microsoft MXC（`microsoft/mxc`）能否在 Windows 上承载 FinalCheck 的 Q1/Q2 命令执行；要求项目只读、临时目录可写、网络默认拒绝、沙箱不可用时 fail closed。
- 结论：**本机 Windows 11 23H2（22631.6199）不可用于 FC 的 Q1/Q2**。MXC 运行时探针会报 `isSupported: true`，但实际落到 `appcontainer-dacl` 兼容层，`node.exe` 在沙箱内无法启动（`0xC0000142`），且非提权会话无法给 `C:\Program Files\nodejs` 加 DACL。官方支持表从 Windows 11 24H2 `26100.9278` 起。

## 1. 环境与结论速览

| 项 | 实测值 |
| --- | --- |
| OS | Windows 11 23H2，build `22631.6199`，x64 |
| 当前会话 | 非提权（`IsInRole(Administrator)=False`，`net session` 拒绝） |
| Node / npm | `v24.14.0` / `11.9.0` |
| WSL2 | 已启用，Ubuntu（node `v22.22.2`，未装 `bwrap`）、docker-desktop，均 Stopped |
| Windows Sandbox | 未启用（`System32\WindowsSandbox.exe` 不存在） |
| MXC SDK | `@microsoft/mxc-sdk@1.0.1`（2026-10-17 发布） |

| 问题 | 结论 |
| --- | --- |
| MXC 在本机可用吗 | 只能跑 `cmd.exe`/`curl.exe` 这类命令；**Node 工作负载不可用**，因此 FC 的 Q1/Q2 不可用 |
| 官方最低 Windows 版本 | 24H2 Process tier `26100.9278`；Session/lifecycle tier `26100.9550`；25H2 `26200.9278`/`26200.9550` |
| 运行时探针可信吗 | 不能只看 `getPlatformSupport().isSupported`；23H2 也返回 true，但 tier 是 `appcontainer-dacl` |
| 是否 fail closed | 是，未观察到回退宿主机执行；但失败可能以**负 exit code**返回，不是抛异常，FC 必须自己判定 |
| 建议 | `< 26100.9278` 直接拒绝启用 MXC；23H2/Win10 优先 WSL2 + bubblewrap；24H2 上用独立 `wxc-exec.exe` 做小范围试点 |

## 2. 官方要求（已核对）

来源：
- MXC README：<https://github.com/microsoft/mxc>
- Windows 版本支持表：<https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md>
- Node SDK：<https://www.npmjs.com/package/@microsoft/mxc-sdk>（README 随包）

### 2.1 Windows 最低 build

| Windows | Process tier | Session tier |
| --- | --- | --- |
| 11 24H2 | `26100.9278` | `26100.9550` |
| 11 25H2 | `26200.9278` | `26200.9550` |
| 11 26H2 | `26300.9550` | `26300.9550` |
| 11 26H1 | `28000.2804` | `28000.3086` |

官方支持表从 24H2 起；23H2 `22631.6199` 不在表内。Codex 文档所称“24H2 `26100.9278+` / 25H2 `26200.9278+`”与 MXC 的 Process tier 门槛一致。

### 2.2 Node SDK

- 包名：`@microsoft/mxc-sdk`，入口 `@microsoft/mxc-sdk/v1`。
- 安装：`npm install @microsoft/mxc-sdk`；本次装到 `1.0.1`，6 个包、约 7 秒。
- Node 要求：`engines >=24.0.0`；Windows native stdio 另要求 Node `24.21.0+`（24 线）或 `26.8.0+`。本机 `24.14.0` 低于 native stdio 门槛，但 `run()` 的捕获输出仍可用（说明该门槛主要影响 native stdio/PTY 路径）。
- 体积：SDK 解包约 103 MB；`node_modules` 实测 171 MB。依赖 `koffi`、`node-pty`、`semver`。
- 单独分发：`bin/x64/wxc-exec.exe` 约 12 MB，**可独立运行**（`--probe` 与执行 `cmd.exe` 均验证通过），不必带整个 SDK。

### 2.3 ProcessContainer 后端

- MXC 执行器/README 的 Windows 默认后端是 `processcontainer`；另有 `windows_sandbox`、`wslc`、`microvm`、`hyperlight`、`isolation_session`（后几者为实验/可选）。注意 Node SDK v1 构造器源码默认是 `{ type: 'process' }`，调用时必须显式写 `processcontainer`（见 2.4）。
- 隔离层级：`base-container`、`appcontainer-bfs`、`appcontainer-dacl`。
- 受支持的 Process tier 从 24H2 起，依赖 BaseContainer API；若要 `captureDenials` 原生捕获，还需要 PSEC 导出：
  - 原生捕获需要 PSEC create/query/close、兼容的 Learning Mode start、Stop/Close；option-aware start 优先，legacy 只捕获访问事件、不捕获 WFP 网络决策。
  - 请求原生捕获但不可用或不完整时，MXC 在创建容器前以 `backend_unavailable` 失败。
- 23H2 实测 `wxc-exec --probe`：`baseContainerApiPresent=false`、`nativeCaptureAvailable=false`、`bfsCompiledIn=false`、`needsDaclAugmentation=true`，只能回退 `appcontainer-dacl`。
- `appcontainer-dacl` 要求对策略中每个路径有 `WRITE_DAC` 权限，并可能要求提权执行 `wxc-host-prep prepare-system-drive`、`prepare-null-device`；`wxc-host-prep.exe --help` 在本机非提权会话直接报“请求的操作需要提升”。
- WSL 不是必需；`wslc` 只是可选后端。PSec 只在需要 `captureDenials` 时相关，基础命令执行不需要。

### 2.4 策略配置

```js
const request = {
  containment: { type: 'processcontainer' }, // SDK 默认其实是 process，必须显式指定
  filesystem: {
    readonlyPaths: ['D:/project'],
    readwritePaths: ['D:/temp'],
    deniedPaths: [],
  },
  network: { egress: { default: 'deny' } },
  timeoutMs: 30000,
  command: 'cmd.exe /d /s /c "npm test"',
};
```

- `readonlyPaths` / `readwritePaths` / `deniedPaths` 已验证有效。
- `network.egress.default='deny'` 已验证：DNS 与 TCP 均被拒。
- 在 `appcontainer-dacl` 层，`egress.default='allow'` 还需要显式 `processContainer.config.capabilities: ['internetClient']` 才能出网；deny 不需要。
- 不要依赖 SDK 默认 `containment`：源码里默认是 `{ type: 'process' }`，不是 `processcontainer`。

## 3. PoC 与实测结果

所有脚本与依赖都在仓库外：`D:\rcw-geo\.tmp\mxc-poc`（`npm install` 未进仓库）。核心脚本：

- `probe-support.mjs`：`getPlatformSupport()` / `getAvailableBackends()`
- `poc-matrix.mjs`：cmd / node / 路径读写 / 网络矩阵
- `poc-cmd2.mjs`：cmd + curl 的文件系统与网络策略
- `poc-timing.mjs`：不同 `readonlyPaths` 规模的耗时
- `poc-net.mjs`、`poc-nodecheck.mjs`：网络 allow/deny、容器内 node/npm

### 3.1 平台探针

| 调用 | 结果 |
| --- | --- |
| `getPlatformSupport()`（332 ms，首次） | `isSupported: true`；`availableMethods: [processcontainer, hyperlight]`；`isolationTier: appcontainer-dacl`；3 条 DACL 警告 |
| `getAvailableBackends()` | `processcontainer`（tier `appcontainer-dacl`）、`wslc`、`hyperlight` |
| `wxc-exec --probe` | `baseContainerApiPresent:false`、`nativeCaptureAvailable:false`、`bfsCompiledIn:false`、`needsDaclAugmentation:true` |
| `wxc-exec --dry-run` | 校验通过（但 dry-run 通过≠能跑 Node） |

### 3.2 命令矩阵

| 测试 | 命令（沙箱内） | exit | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 基本命令 | `cmd.exe /c "echo hi"`（仅 work 可写） | 0 | 140–450 ms | stdout `hi`，成功 |
| 读项目 | `cmd.exe /c "type package.json"`（项目只读） | 0 | 48.3 s | 读到 `package.json` |
| 写临时目录 | `cmd.exe /c "echo temp-ok> work\probe.txt"` | 0 | 140 ms | 文件存在，成功 |
| 写项目 | `cmd.exe /c "echo x> project\.mxc-poc-write-probe.txt"` | 1 | 46.9 s | “拒绝访问”，宿主机无文件，只读生效 |
| Node（Program Files） | `C:\Program Files\nodejs\node.exe -e "console.log('mxc-ok')"` | -1073741502 (`0xC0000142`) | 44.5 s | 无 stdout，进程初始化失败 |
| Node（复制到自有目录） | `D:\...\toolchain\node.exe -e "console.log('mxc-ok')"` | -1073741502 | 44.2 s / 105 ms* | stdout 为空，同样失败，排除 Program Files ACL 单一因素 |
| `cmd /c node --version` | PATH 解析 | 1 | 0.8 s | `'node' 不是内部或外部命令` |
| `cmd /c npm --version` | PATH 解析 | 1 | 0.8 s | `'npm' 不是内部或外部命令` |
| `cmd /c where node` | System32 `where.exe` | -1073741502 | 0.5 s | 连 `where.exe` 也初始化失败 |
| 网络拒绝 | `curl https://registry.npmjs.org/` | 28 | 10 s | DNS 解析超时，无文件 |
| 网络允许（无 capability） | 同上，`egress=allow` | 28 | 10 s | TCP 连接超时 |
| 网络允许（带 `internetClient`） | 同上 | 0 | 1.9–5.5 s | HTTP `200 OK` |

\* 不带项目只读路径时 Node 失败只需约 105 ms；带完整项目路径时约 44 s，说明 44 s 来自策略处理而非 Node 本身。

### 3.3 耗时分解

| 策略 | 耗时 |
| --- | --- |
| 仅 `readwritePaths: [work]`，cmd | 430–443 ms |
| 额外只读一个空目录 | 450 ms |
| 额外只读完整仓库（含 `node_modules`） | 48.7 s |
| 同上但 `clearPolicyOnExit:false` | 48.0 s |

同一命令仅因 `readonlyPaths` 从空目录换成完整仓库，耗时从 0.45 s 涨到 48.7 s。实测差异指向 DACL 兼容层对策略路径树的递归处理/清理；未逐文件计时。对 FC 的现实含义：每个 Q1/Q2 命令都可能重复付这笔成本，且项目越大越慢。

### 3.4 ACL 与残留

- 成功读取项目后检查 `icacls`：仓库根、`package.json`、`node_modules` 内文件均只有继承 ACE，未发现 AppContainer SID 或显式 ACE。
- 项目写测试后宿主机无 `.mxc-poc-write-probe.txt`。
- 未测试“运行中被杀/断电”时 ACL 是否完整回滚；这是 DACL 兼容层的真实风险。

### 3.5 失败模式与 fail-closed

- MXC 没有回退到宿主机执行：策略应用失败会抛 `MxcError`；命令失败仍在 AppContainer 内。
- **但 Node 的 `0xC0000142` 是以 `ExecutionResult.exitCode = -1073741502` 返回的，`run()` 不抛异常**。FC 若只看 `exitCode !== 0` 会当成“命令失败”，若只看“是否抛异常”会误判为成功。必须把 `exitCode < 0`（或 `>= 0x80000000`）视为沙箱/后端失败并 fail closed。
- `--dry-run` 在 23H2 通过，但实际 Node 跑不起来；不能拿 dry-run 当可用性闸门。
- `getPlatformSupport().isSupported=true` 在 23H2 也成立；不能只用它做版本闸门。

### 3.6 其他观察

- SDK 诊断模块会执行 `whoami /user /fo csv /nh`。在 Git Bash PATH 下会命中 GNU `whoami`，打印 `whoami: extra operand '/user'`。这是诊断命名管道的 SID 探测，失败会回退基础管道名；本次不影响策略与执行，但会污染 stderr/日志。
- 容器内 PATH 不含 `C:\Program Files\nodejs`；即使不改 PATH，用全路径启动 `node.exe` 仍因 `0xC0000142` 失败。
- `npm.cmd` 不能直接作为可执行文件启动（SDK 报 `CreateProcessW 0x80070002`）；Q1 现有的 `node <npm-cli.js>` 方式更合适。
- `wxc-host-prep.exe` 自带 Microsoft 签名（验证通过），但非提权无法运行。

## 4. 判定：23H2 为什么不可用

1. 官方支持表从 24H2 `26100.9278` 起，本机 `22631` 低于门槛。
2. 23H2 缺 BaseContainer API（`baseContainerApiPresent=false`），只能走 `appcontainer-dacl` 兼容层。
3. 该兼容层能跑 `cmd.exe`/`curl.exe`，但 `node.exe` 启动即 `0xC0000142`；复制到自有可写目录后仍失败，说明不是单纯的 Program Files ACL 问题。
4. 要让 Node 可读 `C:\Program Files\nodejs`，需要给该路径 `WRITE_DAC`；本机非提权会话直接报 `ERROR_ACCESS_DENIED (WRITE_DAC not granted)`。
5. MXC 自己建议的修复是提权运行 `wxc-host-prep prepare-system-drive` / `prepare-null-device`；本机无法在非提权会话验证，且这属于改宿主机安全描述符的运维动作。
6. 即使解决 Node，完整项目只读策略每次约 48 s，对 Q1/Q2 不可接受。

因此：**23H2 上不要把 MXC 作为 FC 的默认/唯一沙箱**。如果要支持 23H2，应换后端，而不是给 MXC 打补丁。

## 5. Win11 24H2 最小验证矩阵（待有 24H2 机器时执行）

| # | 检查 | 命令/方法 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 版本闸门 | `[Environment]::OSVersion.Version.Build` | `>=26100.9278`（Session/lifecycle 需 `>=26100.9550`） |
| 2 | 后端探针 | `wxc-exec.exe --probe` | `baseContainerApiPresent=true`、`tier=base-container`、`needsDaclAugmentation=false`；需要捕获时 `nativeCaptureAvailable=true` |
| 3 | 非提权运行 | 普通用户会话执行 #4 | 不出现 `WRITE_DAC` / “需要提升” |
| 4 | Node 冒烟 | `node -e "console.log('mxc-ok')"`，项目只读、临时可写、网络 deny | exit 0，stdout `mxc-ok` |
| 5 | Q1 冒烟 | `node <npm-cli.js> test`（小 fixture） | exit 0，输出被捕获 |
| 6 | Q2 冒烟 | `cmd.exe /d /s /c "npx eslint . --max-warnings=0"` | exit 0，输出被捕获 |
| 7 | 临时写 | `cmd /c "echo ok> temp\probe.txt"` | exit 0，文件存在 |
| 8 | 项目写拒绝 | `cmd /c "echo x> project\probe.txt"` | 非 0，宿主机无文件 |
| 9 | 网络拒绝 | `curl https://registry.npmjs.org/` | 非 0（DNS/TCP 失败），无文件 |
| 10 | 启动耗时 | 首跑/热跑各 3 次 | 单命令额外开销目标 `<2 s`；记录 P50/P95 |
| 11 | 清理 | 跑后 `icacls` + 目录对比 | 无显式 ACE、无残留文件、无容器 profile |
| 12 | fail-closed | 临时改名 `wxc-exec.exe` 再跑 | 明确报错，不执行宿主机命令 |
| 13 | Node 版本 | `node --version` | SDK 路径 `>=24.21.0`（或 26.8+）；CLI 路径可放宽 |

补充验收：
- 用真实仓库跑一次 Q1/Q2，确认大 `node_modules` 不会触发 DACL 递归（BaseContainer 应无此问题）。
- 若 `tier` 仍是 `appcontainer-dacl`，直接判不通过，不要继续。
- 记录 `wxc-exec --probe` 原始 JSON 存档，作为版本证据。

## 6. Win10 / 23H2 备选与代价

| 方案 | 能力 | 代价/风险 |
| --- | --- | --- |
| WSL2 + bubblewrap（MXC Linux 后端或直接 bwrap） | 真实 Linux namespace：`--unshare-net` 网络拒绝、bind 只读挂载；FC 命令可在 WSL 内跑 | 本机 WSL2 已启用但 Ubuntu 未装 `bwrap`、node 为 `v22.22.2`（MXC SDK 要 24）；`/mnt/d` 9p I/O 慢；Windows 路径/换行/权限语义差异；需企业策略允许 WSL。安装 `bubblewrap` + Node 24 后可试点 |
| Codex legacy elevated | 现成路径，能跑 | 需要提权/UAC；边界更弱且不透明；提权进程本身不是“不可信命令”的安全边界；不适合作为默认 |
| Job Object | 进程树 kill、内存/CPU/句柄限制 | 不是文件系统/网络边界；无法单独实现“项目只读 + 网络拒绝”；只能作为资源限制的补充 |
| MXC hyperlight | 微 VM，探针报 `hyperlightAvailable=true` | 实验后端；需要准备 rootfs/虚拟化，体积和启动成本高；本次未测；23H2 上可能是强隔离备选，但不能替代已验证的 24H2 路径 |
| Windows Sandbox | VM 级隔离 | 本机未启用；交互式/重，非 per-command API；不适合 Q1/Q2 |
| 手工 AppContainer + DACL | 与 MXC 兼容层同源 | 需逐路径 `WRITE_DAC`、提权 host prep、ACL 回滚风险；维护成本高 |

排序建议：24H2 MXC BaseContainer > WSL2 + bubblewrap > Codex legacy elevated（仅显式授权）> Job Object（仅补充）> 宿主机直跑（禁止）。

## 7. 对 FinalCheck 的建议

1. **版本闸门写在代码里**：Windows 且 build `< 26100.9278` 时不启用 MXC；`wxc-exec --probe` 的 `tier` 不是 `base-container` 或 `needsDaclAugmentation=true` 时同样拒绝。错误信息要明确，不要静默降级到宿主机。
2. **不要让 `getPlatformSupport().isSupported` 单独当闸门**：23H2 也返回 true。以 `--probe` 的 `baseContainerApiPresent` / `tier` 为准，并加一次真实 Node 冒烟。
3. **优先用独立 `wxc-exec.exe`（12 MB）而不是 SDK 导入**：
   - 避免 FC 的 `engines >=22` 与 SDK `>=24` 冲突；
   - 避免 103 MB 包体和 `koffi`/`node-pty` 原生依赖；
   - 策略 JSON 由 FC 自己构造，便于审计和版本固定。
   - 若要用 SDK 的类型/校验，把 SDK 作为可选依赖，启动时探测，缺失则 fail closed。
4. **命令包装**：Q2 的 `spawn(command, {shell:true})` 语义在 MXC 里要显式包成 `cmd.exe /d /s /c "<command>"`；否则 `process.commandLine` 不经过 shell，管道/重定向/`&&` 行为会变。Q1 继续用 `node <npm-cli.js> test`，不要走 `npm.cmd`。
5. **策略最小化**：`readonlyPaths: [project, nodeDir]`、`readwritePaths: [temp]`、`network.egress.default='deny'`；不要加 `clearPolicyOnExit:false`（DACL 层会留下 ACL 改动）。
6. **失败判定**：`exitCode < 0` 或 `>= 0x80000000` 一律视为沙箱/后端失败；`timedOut`、`warnings`、`stderr` 中的 AppContainer/DACL 错误也要上报为 coverage gap，不能记成“命令失败/测试失败”。
7. **23H2/Win10 策略**：默认拒绝 MXC；优先 WSL2 + bubblewrap。legacy elevated 只在用户明确授权、且接受“提权进程不是沙箱边界”的前提下作为临时方案。Job Object 只能叠加资源限制，不能冒充文件/网络隔离。
8. **24H2 试点范围**：先在一个小仓库跑 Q1/Q2，记录首跑/热跑 P50/P95、ACL 残留、网络拒绝、Node 版本；通过后再扩到真实项目。不要直接全量 `npm test`。

## 8. 复现要点

```bash
# 仓库外
mkdir -p D:/rcw-geo/.tmp/mxc-poc && cd D:/rcw-geo/.tmp/mxc-poc
npm install @microsoft/mxc-sdk@1.0.1

# 平台探针
node probe-support.mjs

# 直接 CLI（不需要 SDK 导入）
node_modules/@microsoft/mxc-sdk/bin/x64/wxc-exec.exe --probe
```

最小 SDK 片段：

```js
import { run, getPlatformSupport } from '@microsoft/mxc-sdk/v1';

console.log(getPlatformSupport());

const res = await run({
  containment: { type: 'processcontainer' },
  filesystem: {
    readonlyPaths: ['D:/rcw-geo/yanshou'],
    readwritePaths: ['D:/rcw-geo/.tmp/mxc-poc/work'],
  },
  network: { egress: { default: 'deny' } },
  timeoutMs: 30000,
  command: 'node -e "console.log(\'mxc-ok\')"',
});
console.log(res.exitCode, res.stdout, res.stderr);
```

独立 CLI（`wxc-exec.exe`）的配置形状（`version` 为 SDK 1.0.1 的 contract `1.0.0`，升级前先固定并回归）：

```json
{
  "version": "1.0.0",
  "containerId": "fc-q2-<run-id>",
  "containment": "processcontainer",
  "lifecycle": { "destroyOnExit": true, "preservePolicy": false },
  "process": {
    "commandLine": "cmd.exe /d /s /c \"npm test\"",
    "timeout": 30000
  },
  "filesystem": {
    "readonlyPaths": ["D:/project", "C:/Program Files/nodejs"],
    "readwritePaths": ["D:/temp"],
    "deniedPaths": []
  },
  "network": { "egress": { "default": "deny" } },
  "processContainer": { "leastPrivilege": false, "capabilities": [] }
}
```

调用：`wxc-exec.exe --config policy.json`，或 `--config-base64 <base64>` 避免落地临时文件。

注意：该 JSON 已用 `--dry-run` 校验通过（验证时把 `C:/Program Files/nodejs` 换成项目路径）。在 24H2 `base-container` 层应可保留 `nodeDir`；在 23H2 `appcontainer-dacl` 层，`C:/Program Files/nodejs` 会因 `WRITE_DAC` 被拒，这正是本机不可用的原因之一。

## 9. 未验证/遗留风险

- 未在 24H2 实机验证；第 5 节是验收矩阵，不是结论。
- 未提权运行 `wxc-host-prep prepare-system-drive` / `prepare-null-device`；因此“提权后 23H2 能否跑 Node”未知，不作为可行方案。
- 未测试 `hyperlight`、`wslc`、Windows Sandbox 后端。
- 未测试运行中断（kill/断电）后的 ACL 回滚；DACL 兼容层存在把显式 ACE 留在项目上的风险。
- 未跑 FC 全量测试；未修改 `package.json`/lock/生产代码。
