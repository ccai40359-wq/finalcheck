// 模拟客户端用的网关：本机 HTTP 服务，OpenAI 兼容 /chat/completions。三种模式：
//
//  - script：按剧本回复（确定、免费、毫秒级）——进 npm test / CI。
//  - proxy ：转发到真网关并把每次请求/回复原样录下来（cassette）——真模型实测，顺带产出可回放的录像。
//  - replay：按录像依次回放（真实数据 + 确定 + 免费）——把一次真模型跑出来的过程变成回归测试。
//
// 无论哪种模式，每次请求都会记进 requests（apiKey 一律不记），并按「和之前请求的最长公共前缀」
// 估算前缀缓存命中——假网关也能量出「缓存有没有被打断」。
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

/** 请求分类：主 agent / 子代理 / 压缩摘要 / 起标题 */
export function classifyRequest(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const sys = String(msgs.find((m) => m?.role === 'system')?.content ?? '');
  if (body?.stream !== true) return /起标题/.test(sys) ? 'title' : 'summary';
  // 0.27：压缩摘要复用主对话前缀（流式），最后一条 user 消息以「[压缩上下文]」开头
  const last = msgs[msgs.length - 1];
  if (last?.role === 'user' && String(last.content ?? '').startsWith('[压缩上下文]')) return 'summary';
  // 摘要请求（0.27 起也是流式）：没有 system、没有工具定义
  if (!sys && !(Array.isArray(body?.tools) && body.tools.length)) return 'summary';
  if (/^你是 FinalCheck (工作流中的)?子代理/.test(sys)) return 'subagent';
  return 'main';
}

const msgText = (m) => JSON.stringify({ r: m?.role, c: m?.content ?? null, t: m?.tool_calls ?? null, i: m?.tool_call_id ?? null });

/** 与历史请求比，当前 messages 的最长公共前缀（按字符计）；粗略 4 字符 ≈ 1 token */
function prefixChars(prevList, msgs) {
  let best = 0;
  for (const prev of prevList) {
    let chars = 0;
    for (let i = 0; i < Math.min(prev.length, msgs.length); i++) {
      if (prev[i] !== msgs[i]) break;
      chars += prev[i].length;
    }
    if (chars > best) best = chars;
  }
  return best;
}

function sseOf(reply, { model }) {
  const id = 'chatcmpl-sim-' + Math.random().toString(36).slice(2, 10);
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const chunks = [];
  if (reply.reasoning) chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: reply.reasoning } }] });
  const content = String(reply.content ?? '');
  if (content) {
    // 分两块流出：前端 / 主进程按增量拼接的路径要被走到
    const cut = Math.max(1, Math.floor(content.length / 2));
    chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: content.slice(0, cut) } }] });
    if (content.length > cut) chunks.push({ ...base, choices: [{ index: 0, delta: { content: content.slice(cut) } }] });
  }
  const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
  calls.forEach((c, index) => {
    const args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {});
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: c.name, arguments: '' } }] } }] });
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] } }] });
  });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason || (calls.length ? 'tool_calls' : 'stop') }] });
  if (reply.usage) chunks.push({ ...base, choices: [], usage: reply.usage });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function jsonOf(reply, { model }) {
  return JSON.stringify({
    id: 'chatcmpl-sim', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: String(reply.content ?? '') }, finish_reason: 'stop' }],
    ...(reply.usage ? { usage: reply.usage } : {})
  });
}

const readBody = (req) => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', (d) => parts.push(d));
  req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  req.on('error', reject);
});

/**
 * @param {object} o
 * @param {'script'|'proxy'|'replay'} [o.mode]
 * @param {(body:any, ctx:{kind:string, n:number, nOfKind:number, requests:any[]}) => any} [o.respond] script 模式：返回回复对象
 *        { content?, reasoning?, toolCalls?: [{name, args, id?}], usage?, delayMs?, status?, error?, hang? }
 * @param {{ baseUrl: string, apiKey: string }} [o.upstream] proxy 模式的真网关
 * @param {string} [o.cassette] proxy：录像写到这里；replay：从这里读
 * @param {(rec:any) => void} [o.onRequest] 每次请求结束的回调（写日志用）
 */
export async function startGateway({ mode = 'script', respond = null, upstream = null, cassette = null, onRequest = null } = {}) {
  const requests = [];
  const seen = []; // 每次请求的 messages 序列化（算前缀缓存用）
  const tape = mode === 'replay' ? JSON.parse(readFileSync(cassette, 'utf8')) : { version: 1, entries: [] };
  let replayAt = 0; // 已回放条数（诊断用）
  const counts = {};
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    let rec = null;
    try {
      if (req.method === 'GET' && /\/models\/?$/.test(req.url || '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'sim-model' }] }));
        return;
      }
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 坏请求照样记 */ }
      const kind = classifyRequest(body);
      counts[kind] = (counts[kind] || 0) + 1;
      const msgs = (Array.isArray(body.messages) ? body.messages : []).map(msgText);
      const totalChars = msgs.reduce((a, s) => a + s.length, 0);
      const cachedChars = prefixChars(seen, msgs);
      seen.push(msgs);
      rec = {
        n: requests.length + 1, key: replayKey(kind, body), kind, at: startedAt, stream: body.stream === true, model: body.model,
        toolChoice: body.tool_choice ?? null, messages: body.messages, tools: Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name) : [],
        estPromptTokens: Math.ceil(totalChars / 4), estCachedTokens: Math.floor(cachedChars / 4)
      };
      requests.push(rec);

      if (mode === 'script') {
        const reply = (await respond?.(body, { kind, n: rec.n, nOfKind: counts[kind], requests })) || defaultReply(kind);
        rec.reply = summarizeReply(reply);
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (reply.hang) { req.on('close', () => {}); return; } // 永不回复：测静默看门狗 / 停止
        if (reply.status && reply.status >= 400) {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: reply.error || 'sim error' } }));
          rec.status = reply.status;
          return;
        }
        const usage = reply.usage === null ? null : (reply.usage || { prompt_tokens: rec.estPromptTokens, completion_tokens: Math.ceil(String(reply.content || '').length / 4) + 8, prompt_tokens_details: { cached_tokens: rec.estCachedTokens } });
        const out = { ...reply, usage };
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end(sseOf(out, { model: body.model }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(jsonOf(out, { model: body.model }));
        }
        rec.status = 200;
        return;
      }

      if (mode === 'replay') {
        // 并行的子代理请求顺序不固定：按「同类 + 同任务」认领录像，认领不到再按同类顺序
        const free = tape.entries.filter((e) => !e.used);
        const entry = free.find((e) => e.kind === kind && e.key === rec.key) || free.find((e) => e.kind === kind) || free[0];
        replayAt++;
        if (entry) entry.used = true;
        if (!entry) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `录像已放完（共 ${tape.entries.length} 条），多出第 ${replayAt} 次请求` } }));
          rec.status = 500;
          return;
        }
        rec.replayOf = entry.n;
        if (entry.kind !== kind) rec.replayMismatch = `录像第 ${entry.n} 条是 ${entry.kind}，这次请求是 ${kind}`;
        res.writeHead(entry.status || 200, { 'content-type': entry.contentType || 'application/json' });
        res.end(entry.body);
        rec.status = entry.status || 200;
        return;
      }

      // proxy：转发到真网关，边转边录
      const url = upstream.baseUrl.replace(/\/+$/, '') + (req.url || '').replace(/^\/v1/, '').replace(/^(?!\/)/, '/');
      const target = /\/chat\/completions/.test(url) ? url : upstream.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const ctl = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
      const up = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + upstream.apiKey },
        body: raw,
        signal: ctl.signal
      });
      const contentType = up.headers.get('content-type') || 'application/json';
      res.writeHead(up.status, { 'content-type': contentType });
      const parts = [];
      if (up.body) {
        for await (const chunk of up.body) {
          const buf = Buffer.from(chunk);
          parts.push(buf);
          res.write(buf);
        }
      }
      res.end();
      const text = Buffer.concat(parts).toString('utf8');
      rec.status = up.status;
      rec.usage = usageFromBody(text);
      rec.reply = replyFromBody(text);
      tape.entries.push({ n: rec.n, kind, key: rec.key, status: up.status, contentType, body: text });
    } catch (e) {
      if (rec) rec.error = String(e?.message || e);
      rec_error(res, e);
    } finally {
      if (rec && !rec.ms) {
        rec.ms = Date.now() - startedAt;
        try { onRequest?.(rec); } catch { /* 日志失败不影响 */ }
      }
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    counts,
    tape,
    saveCassette(file = cassette) { if (file) writeFileSync(file, JSON.stringify(tape, null, 1)); return file; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r()));
    }
  };
}

/** 录像认领键：子代理按它的任务原文区分（并行时顺序不定），其余为空 */
function replayKey(kind, body) {
  if (kind !== 'subagent') return '';
  const u = (Array.isArray(body?.messages) ? body.messages : []).find((m) => m?.role === 'user');
  const s = typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content ?? '');
  return s.slice(0, 200);
}

function rec_error(res, e) {
  try {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'sim gateway: ' + (e?.message || e) } }));
  } catch { /* 连接已断 */ }
}

function defaultReply(kind) {
  if (kind === 'title') return { content: '模拟会话' };
  if (kind === 'summary') return { content: '<analysis>（模拟：先过一遍全过程，这段会被丢掉）</analysis>\n<summary>\n## 1. 主要请求与意图\n（模拟摘要）\n## 7. 当前工作\n进行中\n</summary>' };
  return { content: '（剧本没有为这次请求准备回复）' };
}

function summarizeReply(r) {
  return {
    content: r.content ? String(r.content).slice(0, 400) : undefined,
    toolCalls: Array.isArray(r.toolCalls) ? r.toolCalls.map((c) => ({ name: c.name, args: c.args })) : undefined,
    status: r.status, hang: r.hang || undefined
  };
}

/** 从 SSE / JSON 回复里取 usage（真网关模式统计缓存命中用） */
export function usageFromBody(text) {
  let usage = null;
  const s = String(text || '');
  if (s.startsWith('{')) { try { return JSON.parse(s).usage || null; } catch { return null; } }
  for (const line of s.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try { const j = JSON.parse(d); if (j.usage) usage = j.usage; } catch { /* 半行 */ }
  }
  return usage;
}

/** 从 SSE 回复里还原「模型说了什么、调了哪些工具」（日志用） */
export function replyFromBody(text, { full = false } = {}) {
  const s = String(text || '');
  if (s.startsWith('{')) {
    try { return { content: String(JSON.parse(s).choices?.[0]?.message?.content || '').slice(0, 400) }; } catch { return {}; }
  }
  let content = '';
  const calls = [];
  for (const line of s.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      const delta = JSON.parse(d).choices?.[0]?.delta || {};
      if (delta.content) content += delta.content;
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        calls[i] ||= { name: '', args: '' };
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
    } catch { /* 半行 */ }
  }
  return { content: (full ? content : content.slice(0, 400)) || undefined, toolCalls: calls.filter(Boolean).length ? calls.filter(Boolean).map((c) => ({ name: c.name, args: full ? c.args : c.args.slice(0, 300) })) : undefined };
}
