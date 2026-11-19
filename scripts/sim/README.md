# 模拟客户端测试台

不开窗口、不操作电脑，在后台按"真人怎么用 FC"来测试。走的是和桌面端**同一条后端链路**：

```
界面（用代码模拟）──IPC──▶ backend.mjs ──▶ 会话库 / 历史展开 / agent / 子代理 / 工具 / 落库
```

桌面端 `index.mjs` 和测试台都调用 `desktop/src/main/backend.mjs`，所以测到的就是用户在用的那条链路。

所有数据都放在临时目录里（配置、会话库、记忆、落盘文件、APPDATA、HOME 全部隔离），项目是复制出来的副本。**不会读写你正在用的 FinalCheck。** 真模型模式只会**只读**借用你本机配置里的供应商，API key 不会写进任何日志。

## 三层测试

| 层 | 命令 | 测什么 | 用不用模型 | 耗时 |
|---|---|---|---|---|
| 1. 工具层 | `npm run sim:tools` | 每个工具本身对不对，以及**模型实际看到的文本**是什么（长输出落盘、越界拒绝、回滚……） | 不用 | 几秒 |
| 2. 全链路 + 假网关 | `npm run sim` | 按剧本走完整客户端流程：多轮对话、停止后继续、重启后接着聊、子代理、工作流；检查落库、界面事件、前缀缓存是否断开、文件改动 | 不用（剧本回复） | 几秒 |
| 3. 全链路 + 真模型 | `npm run sim:live -- <剧本.json>` | 同一个剧本换成真模型跑，看实际效果、耗时、缓存命中；同时录下一份可回放的录像 | 用 | 分钟级 |

另外还有一个**触发评测**：`npm run sim:trigger`。用真模型跑一组真人会说的话，看模型在该用子代理 / 工作流的时候会不会用、不该用的时候会不会乱用（工具做了 AI 却不用，等于白做）。

第 1、2 层已经接进 `npm test`（`tests/sim-harness.test.mjs`），每次改代码都会自动跑。

## 改完 FC 代码之后（不管是人改的还是 AI 改的）

```bash
npm test
```

```bash
npm run lint && npm run typecheck
```

改了 agent 行为或提示词的话，再跑一次真模型：

```bash
npm run sim:trigger
```

## 日志在哪

每次运行都会在 `.tmp/sim/<名字>-<时间>/` 下生成：

- `run.log`：人读的。每轮用户说了什么、AI 调了哪些工具（参数、耗时、成败）、回答、每条断言是否通过
- `events.jsonl`：机器读的。IPC 调用、界面收到的每个事件
- `requests.jsonl`：每次网关请求的类型（主 agent / 子代理 / 摘要 / 标题）、消息条数、估算 token、缓存命中、回复摘要
- `report.md`：汇总表
- `cassette.json`：真模型模式下的录像，可以用 `--replay` 原样回放
- `requests-full.jsonl`：加 `--dump` 时才有，保存每次请求的完整 messages（用来排查前缀为什么断开）

## 写一个剧本

剧本放在 `scenarios/*.json`，可以参考 `basic-chain.json`。

```json
{
  "name": "my-case",
  "project": { "files": { "src/a.js": "..." } },
  "turns": [
    { "send": "帮我修 a.js", "expect": { "toolsInclude": ["edit_file"], "files": { "src/a.js": { "contains": "a + b" } } } },
    { "send": "跑一下检查", "cancelAfterTool": "run_command", "expect": { "cancelled": true } },
    { "restart": true },
    { "send": "继续", "expect": { "requestIncludes": "node --check" } },
    { "compact": true, "expect": { "summaryRequests": 1, "dbSummaryContains": ["帮我修 a.js"] } }
  ],
  "mock": {
    "replies": [ { "content": "…", "toolCalls": [ { "name": "read_file", "args": { "path": "{{project}}/src/a.js" } } ] } ],
    "subagentReplies": [ { "match": "src/a", "content": "…" } ]
  }
}
```

- `project`：`files` 是现场写出来的文件；也可以用 `copyFrom` 复制一个已有的目录（会排除 node_modules / .git）
- `mock.replies`：按顺序给主 agent 用。加了 `match`（正则）的那条，只在最后一条用户消息匹配时才用
- `mock.subagentReplies`：给子代理用，`match` 匹配的是子代理收到的任务原文
- `{"compact": true}`：模拟用户发 `/compact`（手动压缩），可检查 `summaryRequests`、`dbSummaryContains`、`summaryRequestIncludes`
- `providerExtra`：供应商额外字段，比如把 `contextWindow` 压小来触发自动压缩（见 `compact.json`）
- `{{project}}`：会被替换成临时项目的路径
- 没有 `mock` 的剧本只能用 `--live` 跑真模型

`expect` 能检查的内容：

- **报错 / 停止**：`error`（报错要匹配的正则）、`cancelled`
- **回答**：`answerMatches`、`answerNotMatches`
- **工具调用**：`toolsInclude`、`toolsExclude`、`firstTool`、`minTools`、`maxTools`
- **次数和耗时**：`maxRequests`、`maxMs`
- **上下文**：
  - `requestIncludes`：本轮第一次请求里有没有这段内容（检查跨轮记忆）
  - `lastMainIncludes` / `lastMainExcludes`：主 agent 最后一次请求里有没有某段内容（检查子代理报告进来了、原文没有漏进来）
- **缓存前缀**：`prefixStable`（本轮内前缀没有断开）、`prefixBreaksMax`（本轮最多断几次，压缩那一轮会断一次）、`firstCacheRatioMin`（本轮第一次请求有多少命中了之前的前缀，检查跨轮 / 重启后上下文是否一致）
- **压缩**：`summaryRequests`（本轮摘要请求次数）、`summaryCacheHit`（摘要请求复用了对话前缀）、`dbSummary`（压缩边界已落库：`contains` / `notContains` / `trim`）
- **子代理**：`subagentRequestsMin`、`parallelSubagents`（子代理是否真的并行跑）
- **界面事件**：`eventsInclude`
- **文件**：`files`（`contains` / `notContains` / `exists`）
- **会话库**：`dbMessages`（消息条数）、`dbLastTraceMin`（最后一条回答至少带几步工具记录）
- **工作流**：`workflow`（工作流是否跑成功）

## 工具层套件

套件放在 `tool-suites/*.json`，每一步写成 `{ tool, args, expect }`。

`args` 里可以用两个占位符：

- `{{project}}`：临时项目的路径
- `{{lastSpill}}`：上一次超长结果的落盘文件路径

单独试一个工具：

```bash
node scripts/sim/tools.mjs --project D:/some/repo --tool grep_code --args "{\"pattern\":\"TODO\"}"
```
