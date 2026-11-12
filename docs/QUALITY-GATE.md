# 质量命令闸（Q2）

FinalCheck 原本只有安全类闸门（S1–S8）和「测试能不能跑」（Q1）。可读性、性能、稳定性这类维度没有量化证据，只能靠 AI 读代码。Q2 把这件事变成**可测量**：由项目自己声明要跑的命令与阈值，引擎执行并记录结果；跑不动就记 `coverageGap`，不冒充「已检查」。

## 怎么开

在项目根放一个 `finalcheck.quality.json`：

```json
{
  "checks": [
    {
      "id": "lint",
      "command": "npx eslint . --max-warnings=0",
      "timeoutMs": 120000,
      "maxMs": 60000
    },
    {
      "id": "types",
      "command": "npx tsc --noEmit",
      "timeoutMs": 180000
    },
    {
      "id": "tests",
      "command": "npm test",
      "timeoutMs": 300000,
      "maxMs": 120000,
      "minPercent": 40
    },
    {
      "id": "bench",
      "command": "node bench/run.mjs",
      "maxMs": 60000,
      "expect": "p95=",
      "optional": true
    }
  ]
}
```

| 字段 | 含义 | 缺省 |
|---|---|---|
| `id` | 这条检查的名字（出现在报告里） | `check1`… |
| `command` | 要执行的命令（shell，Windows 走 cmd） | 必填 |
| `timeoutMs` | 超时，超了算「没结论」，记 `Q2.<id>-timeout` | 180s（上限 600s，下限 3s） |
| `maxMs` | 墙钟阈值；成功但超过 → `Q2.<id>-slow`（中危） | 不检查 |
| `expect` | 正则；命令成功但输出里没匹配 → `Q2.<id>-expect`（中危） | 不检查 |
| `minPercent` | 从输出解析覆盖率（istanbul 表格 / `Statements : x%` / `Lines : x%`），低于则高危 | 不检查 |
| `severity` | 失败时定级：`high` / `medium` / `low` / `tip` | `high` |
| `optional` | 失败只记 warning，不计入结论（例如本机跑不动的 bench） | `false` |

覆盖率建议一类：`command: "npx c8 --reporter=text-summary npm test", minPercent: 40`。

## 怎么跑

- CLI：`npx finalcheck audit . --tier L2 --interactive`（默认 `runTests=true`；外部项目必须加 `--no-tests`，此时 Q2 只记缺口不执行）
- 桌面端：跟助手说「跑一下质量闸 / 这里的 lint/测试/bench 过没过」，助手调用 `quality_gate`，**执行前会在输入框上方弹出授权条**，允许后逐条跑；`audit_project` 本身仍是 `runTests=false`，不会偷偷执行
- MCP：`quality_gate` **默认拒绝执行项目命令**（MCP 无用户确认通道）；确需执行时必须用 `--root <dir>` 显式指定项目根，并设置 `FINALCHECK_MCP_ALLOW_COMMANDS=1`，且 `dir` 必须在该根内

## 判定原则（照旧不越界）

- 每条命令的 exit code、耗时、超时、期望匹配、覆盖率都进报告，能复现
- 没有 `finalcheck.quality.json` → Q2 不进计划，也不会在报告里说「质量没问题」
- 命令输出里的 `KEY=… / token: …` 一类值会被打码后进报告
- Q2 只回答「声明过的命令跑没跑过」，不是代码质量打分器：没声明 lint，就不会有 lint 结论

## 现场示例

| 维度 | 一条最小声明 |
|---|---|
| 可读性 | `eslint . --max-warnings=0`（错误数即失败） |
| 类型/可转接性 | `tsc --noEmit`（类型不兼容会直接失败） |
| 稳定性 | `npm test` + `minPercent` + `maxMs` |
| 性能/延迟 | 自己的 bench 脚本 + `expect: "p95="` + `maxMs` |
