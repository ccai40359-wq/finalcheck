---
name: fix-a4-redact
description: Use when audit 报 A4.secret-in-prompt / A4.conversation-log / A4.debug-log（密钥进 prompt 或对话/调试日志明文落盘），或用户提到日志脱敏、对话存储、API key 泄进日志时加载。
description_en: Keep secrets out of prompts and logs: env-based client init, redact conversation logs or stop persisting them, scrub debug logs, then re-run the A4 gate.
---

# 数据脱敏 (fix-a4-redact)

A4 的两条污染路径：密钥进了发给 LLM 的消息体、完整对话/请求明文写日志。修法是出口统一过 redact，密钥只走 SDK 配置，日志默认不落盘。

## 适用场景

- `A4.secret-in-prompt`：把 `process.env` / config 里的密钥拼进了发给 LLM 的 prompt（包括错误信息、tool 参数、结构化输出）
- `A4.conversation-log`：完整对话（可能含密钥、用户敏感数据）明文写日志文件或数据库
- `A4.debug-log`：debug 日志打整包请求 / 响应（含 Authorization 头、token、cookie）

## 修复步骤

1. 密钥不进 prompt——client 初始化走 env，模型永远不需要「被告知」自己的 key：
   ```js
   // 改前：密钥作为对话内容传给模型
   const messages = [{ role: 'user', content: `用这个 key 调用 API: ${process.env.API_KEY}` }];
   // 改后：key 只走 SDK 配置层
   const client = new OpenAI({ apiKey: process.env.API_KEY });
   const messages = [{ role: 'user', content: taskDescription }];
   ```
   FastAPI / Python 同理：`OpenAI(api_key=os.environ["API_KEY"])`，prompt 里只放任务描述。
2. 对话日志默认不落盘，开启时必须过 redact：
   ```js
   const SECRET_RE = new RegExp([
     'sk-[A-Za-z0-9_-]{16,}', 'AKIA[0-9A-Z]{16}', 'ghp_[A-Za-z0-9]{36,}',
     'Bearer\\s+[A-Za-z0-9._-]{16,}', 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}',
     '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
   ].join('|'), 'g');
   const redact = (text) => String(text ?? '').replace(SECRET_RE, '[REDACTED]');
   function logTurn(turn) {
     if (process.env.LOG_CONVERSATIONS !== '1') return;   // 默认不落盘
     fs.appendFileSync('conversation.log',
       JSON.stringify({ ...turn, content: redact(turn.content) }) + '\n');
   }
   ```
   Python：写一个 `logging.Filter`，对 `record.msg` 与 args 跑同样的 redact 后再放行。
3. debug 日志改打元数据：模型名、耗时、token 用量、状态码，不打完整 messages / headers / 响应体：
   ```js
   log.info({ model, ms: Date.now() - t0, usage }, 'llm call done');  // 打摘要
   // 删掉：log.debug({ req, res })  ← 整包请求响应
   ```
   确需排查时用临时开关（DEBUG_LLM=1）且输出仍过 redact。
4. 清理已落盘的旧日志：
   ```bash
   grep -rlE "sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY" logs/ *.log 2>/dev/null
   ```
   命中的文件删除或脱敏改写；泄露过的密钥同批次走 01 号密钥轮换技能（撤销旧值）。
5. 自查出口：
   ```bash
   grep -rnE "appendFile|writeFile|fs\.create.*log|console\.log\(.*messages|logger.*req\.headers" src/ --include="*.js"
   ```
   逐条确认要么不打、要么过 redact。

## 验证

- 重跑 `finalcheck audit .` 确认 A4 归零：`A4.secret-in-prompt`、`A4.conversation-log`、`A4.debug-log` 条目全部消失
- 端到端自测：带密钥环境跑一次完整流程，`grep -rE "sk-|AKIA|Bearer" logs/ conversation.log` 应无命中
- 单测：给 redact() 喂含假 key / JWT / 私钥块的字符串，断言输出全为 `[REDACTED]`
- 默认态验证：不设 LOG_CONVERSATIONS 跑一遍，确认没有生成对话日志文件

## 陷阱

- 只在用户可见文案里避免密钥，消息体照样带：错误堆栈、tool 调用参数、结构化输出都可能夹带 key；所有出 prompt / 出日志的内容统一过 redact，不要靠「记得别打印」
- 脱敏正则只写一两种格式：除 sk- / AKIA / ghp 外还有 Bearer 头、JWT（eyJ 开头三段式）、JDBC 连接串密码、私钥块；按项目实际凭证形态补全并加单测
- 日志开关默认开再指望手动关：默认必须不落盘，需要时显式 `LOG_CONVERSATIONS=1`；「先开着回头关」必忘
- 换了新密钥但旧日志里的旧密钥没处理：日志泄露视同密钥泄露，旧值必须轮换作废，只删日志不轮换是半拉子修复
- 脱敏了 content 却漏了 metadata：turn 的 tool_calls、headers、user 字段同样可能带 token；redact 要覆盖整条记录的序列化结果
