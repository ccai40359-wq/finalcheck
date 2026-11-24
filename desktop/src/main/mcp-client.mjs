// MCP 客户端（0.33.0）：让 FinalCheck 接外部 MCP 服务器（GitHub / 数据库 / Figma / 自建工具……）。
//
// 零依赖手写（和 src/mcp/server.mjs 一样），只实现客户端用得到的那一截协议：
//   initialize → notifications/initialized → tools/list（分页）→ tools/call
//   服务端发来的 ping 回 {}；notifications/tools/list_changed 触发重新列工具；
//   取消调用时发 notifications/cancelled。
//
// 两种传输：
//   · stdio：子进程，换行分隔的 JSON-RPC（MCP 规范的 stdio 传输）
//   · http ：Streamable HTTP——每条消息 POST，响应是 application/json 或 text/event-stream；
//            服务端给了 Mcp-Session-Id 就在后续请求里带上
//   （旧的 HTTP+SSE 双端点传输不支持：配置里写 type:"sse" 会给出明确错误）
//
// 配置形状与 Claude Code / Claude Desktop 的 mcpServers 一致（可以直接粘贴过来）：
//   { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { ... } },
//     "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } } }
// FinalCheck 额外认：disabled:true（保留但不启动）、timeoutMs（单次工具调用超时）、
//                   autoApprove:["tool", ...] 或 true（这些工具不弹审批；默认每次都审批）。
//
// 给模型的工具名：mcp__<server>__<tool>（只留 [A-Za-z0-9_-]，最长 64，和 Claude Code 同一约定）。
import { spawn as nodeSpawn } from 'node:child_process';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const INIT_TIMEOUT_MS = 30000;
const LIST_TIMEOUT_MS = 30000;
const DEFAULT_CALL_TIMEOUT_MS = 300000;
const STDERR_TAIL = 4000;
const MAX_TOOLS_PER_SERVER = 200;

// ---------------- 配置 ----------------

const SAFE = /[^A-Za-z0-9_-]/g;
export function sanitizeName(s, max = 64) {
  return String(s || '').replace(SAFE, '_').slice(0, max) || '_';
}

/** 把 config.mcpServers（对象）规范成数组；非法项带 error，不抛 */
export function parseServers(raw) {
  const out = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, def] of Object.entries(raw)) {
    const d = def && typeof def === 'object' ? def : {};
    const type = String(d.type || d.transport || (d.url ? 'http' : 'stdio')).toLowerCase();
    const base = {
      name: String(name).slice(0, 60),
      disabled: d.disabled === true,
      timeoutMs: Number(d.timeoutMs) > 0 ? Math.min(Number(d.timeoutMs), 3600000) : DEFAULT_CALL_TIMEOUT_MS,
      autoApprove: d.autoApprove === true ? true : (Array.isArray(d.autoApprove) ? d.autoApprove.map(String) : [])
    };
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(base.name)) {
      out.push({ ...base, transport: 'invalid', error: '服务器名只能用字母、数字、_ . -' });
    } else if (type === 'stdio') {
      if (!d.command || typeof d.command !== 'string') out.push({ ...base, transport: 'stdio', error: '缺少 command' });
      else out.push({
        ...base, transport: 'stdio', command: d.command,
        args: Array.isArray(d.args) ? d.args.map(String) : [],
        env: d.env && typeof d.env === 'object' ? Object.fromEntries(Object.entries(d.env).map(([k, v]) => [k, String(v)])) : {},
        cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : undefined
      });
    } else if (type === 'http' || type === 'streamable-http' || type === 'streamablehttp') {
      let ok = false;
      try { ok = /^https?:$/.test(new URL(d.url).protocol); } catch { /* 非法 URL */ }
      if (!ok) out.push({ ...base, transport: 'http', error: 'url 必须是 http(s) 地址' });
      else out.push({
        ...base, transport: 'http', url: d.url,
        headers: d.headers && typeof d.headers === 'object' ? Object.fromEntries(Object.entries(d.headers).map(([k, v]) => [k, String(v)])) : {}
      });
    } else if (type === 'sse') {
      out.push({ ...base, transport: 'sse', error: '旧版 SSE 传输暂不支持，请改用 Streamable HTTP（type: "http"）' });
    } else {
      out.push({ ...base, transport: type, error: `未知传输类型：${type}` });
    }
  }
  return out;
}

/** 同一配置 → 同一 key；key 变了才重启这个服务器 */
const serverKey = (s) => JSON.stringify([s.transport, s.command, s.args, s.env, s.cwd, s.url, s.headers, s.disabled]);

// ---------------- 传输 ----------------

// Windows 上 npx / uvx 之类是 .cmd：不能直接 spawn，要经 cmd.exe。参数按 cmd 规则引号转义（同 cross-spawn 思路）。
function quoteCmdArg(a) {
  const s = String(a);
  if (s && !/[\s"&|<>^()%!]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}
export function stdioSpawnSpec(command, args, platform = process.platform) {
  if (platform === 'win32' && !/\.(exe|com)$/i.test(command)) {
    const line = [command, ...args].map(quoteCmdArg).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file: command, argv: args, verbatim: false };
}

class StdioTransport {
  constructor(server, { spawnImpl = nodeSpawn } = {}) {
    this.server = server; this.spawnImpl = spawnImpl;
    this.onmessage = null; this.onclose = null;
    this.stderrTail = ''; this.child = null; this.buf = '';
  }
  async start() {
    const { file, argv, verbatim } = stdioSpawnSpec(this.server.command, this.server.args);
    const child = this.spawnImpl(file, argv, {
      cwd: this.server.cwd, env: { ...process.env, ...this.server.env },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: verbatim
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; } // 服务器往 stdout 打日志：跳过
        this.onmessage?.(msg);
      }
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (s) => { this.stderrTail = (this.stderrTail + s).slice(-STDERR_TAIL); });
    await new Promise((resolve, reject) => {
      child.once('error', (e) => reject(new Error(`启动失败：${e.message}`)));
      child.once('spawn', resolve);
    });
    child.on('exit', (code, sig) => this.onclose?.(new Error(`进程退出（code=${code}${sig ? ', signal=' + sig : ''}）${this.stderrTail ? '：' + this.stderrTail.trim().split('\n').slice(-3).join(' | ') : ''}`)));
  }
  async send(msg) {
    if (!this.child || this.child.exitCode !== null) throw new Error('服务器进程已退出');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  async close() {
    const c = this.child; this.child = null;
    if (!c) return;
    try { c.stdin.end(); } catch { /* 已关 */ }
    await new Promise((r) => { const t = setTimeout(() => { try { c.kill(); } catch { /* 已退 */ } r(); }, 1500); c.once('exit', () => { clearTimeout(t); r(); }); });
  }
}

/** 解析 text/event-stream：按空行切事件，取 data: 行拼起来 */
export function parseSseChunk(state, chunk, onEvent) {
  state.buf += chunk;
  let i;
  while ((i = state.buf.search(/\r?\n\r?\n/)) >= 0) {
    const block = state.buf.slice(0, i);
    state.buf = state.buf.slice(i).replace(/^\r?\n\r?\n/, '');
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (data) onEvent(data);
  }
}

class HttpTransport {
  constructor(server, { fetchImpl = fetch } = {}) {
    this.server = server; this.fetchImpl = fetchImpl;
    this.onmessage = null; this.onclose = null;
    this.sessionId = ''; this.protocolVersion = ''; this.stderrTail = '';
    this.inflight = new Set();
  }
  async start() { /* 无连接可建：第一条 POST 就是 initialize */ }
  async send(msg, { signal } = {}) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    this.inflight.add(ac);
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.server.headers };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
      const res = await this.fetchImpl(this.server.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: ac.signal });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (res.status === 202 || res.status === 204) return;
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        if (msg.id !== undefined) this.onmessage?.({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `HTTP ${res.status}${text ? '：' + text : ''}` } });
        return;
      }
      const ct = String(res.headers.get('content-type') || '');
      if (ct.includes('text/event-stream')) {
        const state = { buf: '' };
        const dec = new TextDecoder();
        const reader = res.body.getReader();
        let done = false;
        while (!done) {
          const r = await reader.read();
          if (r.done) break;
          parseSseChunk(state, dec.decode(r.value, { stream: true }), (data) => {
            let m; try { m = JSON.parse(data); } catch { return; }
            for (const one of Array.isArray(m) ? m : [m]) {
              this.onmessage?.(one);
              if (msg.id !== undefined && one?.id === msg.id && ('result' in one || 'error' in one)) done = true;
            }
          });
        }
        try { await reader.cancel(); } catch { /* 已结束 */ }
      } else {
        const text = await res.text();
        if (!text.trim()) return;
        let m; try { m = JSON.parse(text); } catch { throw new Error('服务器返回的不是 JSON'); }
        for (const one of Array.isArray(m) ? m : [m]) this.onmessage?.(one);
      }
    } finally {
      this.inflight.delete(ac);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
  async close() {
    for (const ac of this.inflight) { try { ac.abort(); } catch { /* 忽略 */ } }
    if (this.sessionId) {
      // 规范：客户端可用 DELETE 结束会话；失败无所谓
      try { await this.fetchImpl(this.server.url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId, ...this.server.headers }, signal: AbortSignal.timeout(2000) }); } catch { /* 忽略 */ }
    }
  }
}

// ---------------- 客户端 ----------------

export class McpClient {
  constructor(server, { clientInfo = { name: 'finalcheck', version: '0' }, spawnImpl, fetchImpl, onToolsChanged } = {}) {
    this.server = server;
    this.clientInfo = clientInfo;
    this.state = 'idle'; // idle | connecting | ready | error | closed
    this.error = '';
    this.tools = [];
    this.serverInfo = null;
    this.instructions = '';
    this.seq = 0;
    this.pending = new Map();
    this.onToolsChanged = onToolsChanged;
    this.transport = server.transport === 'http'
      ? new HttpTransport(server, { fetchImpl })
      : new StdioTransport(server, { spawnImpl });
    this.transport.onmessage = (m) => this.#onMessage(m);
    this.transport.onclose = (err) => this.#onClose(err);
  }

  get stderrTail() { return this.transport.stderrTail || ''; }

  #onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(String(m.error.message || 'MCP 错误')), { code: m.error.code, data: m.error.data }));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method && m.id !== undefined) {
      // 服务端 → 客户端的请求：只答 ping；其余（sampling / roots / elicitation）我们没声明能力
      const reply = m.method === 'ping'
        ? { jsonrpc: '2.0', id: m.id, result: {} }
        : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `FinalCheck 不支持 ${m.method}` } };
      this.transport.send(reply).catch(() => {});
      return;
    }
    if (m.method === 'notifications/tools/list_changed' && this.state === 'ready') {
      this.refreshTools().then(() => this.onToolsChanged?.()).catch(() => {});
    }
  }

  #onClose(err) {
    if (this.state === 'closed') return;
    this.state = 'error';
    this.error = String(err?.message || err || '连接已断开');
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(this.error)); }
    this.pending.clear();
    this.onToolsChanged?.();
  }

  request(method, params, { timeoutMs = LIST_TIMEOUT_MS, signal } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)}s）：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); this.pending.delete(id); reject(new Error('已取消')); return; }
        signal.addEventListener('abort', () => {
          if (!this.pending.has(id)) return;
          clearTimeout(timer); this.pending.delete(id);
          this.notify('notifications/cancelled', { requestId: id, reason: 'user cancelled' });
          reject(new Error('已取消'));
        }, { once: true });
      }
      this.transport.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, { signal }).catch((e) => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer); this.pending.delete(id); reject(e);
      });
    });
  }

  notify(method, params) {
    this.transport.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }).catch(() => {});
  }

  async connect() {
    this.state = 'connecting'; this.error = '';
    try {
      await this.transport.start();
      const init = await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.clientInfo
      }, { timeoutMs: INIT_TIMEOUT_MS });
      if (this.transport instanceof HttpTransport) this.transport.protocolVersion = String(init?.protocolVersion || MCP_PROTOCOL_VERSION);
      this.serverInfo = init?.serverInfo || null;
      this.instructions = typeof init?.instructions === 'string' ? init.instructions.slice(0, 4000) : '';
      this.capabilities = init?.capabilities || {};
      this.notify('notifications/initialized');
      await this.refreshTools();
      this.state = 'ready';
    } catch (e) {
      this.state = 'error';
      const tail = this.stderrTail.trim().split('\n').slice(-3).join(' | ');
      this.error = String(e?.message || e) + (tail && !String(e?.message || '').includes(tail) ? `（stderr：${tail.slice(0, 400)}）` : '');
      await this.transport.close().catch(() => {});
      throw new Error(this.error);
    }
  }

  async refreshTools() {
    if (this.capabilities && !this.capabilities.tools) { this.tools = []; return; }
    const all = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      for (const t of Array.isArray(r?.tools) ? r.tools : []) {
        if (t && typeof t.name === 'string') all.push(t);
      }
      cursor = r?.nextCursor;
      if (!cursor || all.length >= MAX_TOOLS_PER_SERVER) break;
    }
    this.tools = all.slice(0, MAX_TOOLS_PER_SERVER);
  }

  async callTool(name, args, { signal } = {}) {
    if (this.state !== 'ready') throw new Error(`MCP 服务器 ${this.server.name} 未就绪：${this.error || this.state}`);
    return this.request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, { timeoutMs: this.server.timeoutMs, signal });
  }

  async close() {
    this.state = 'closed';
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('已关闭')); }
    this.pending.clear();
    await this.transport.close().catch(() => {});
  }
}

// ---------------- 结果转换 ----------------

/** MCP CallToolResult → FinalCheck 工具结果（文字进正文；图片走 __images 给模型看；isError → error） */
export function toToolResult(res) {
  const content = Array.isArray(res?.content) ? res.content : [];
  const texts = [];
  const images = [];
  for (const c of content) {
    if (c?.type === 'text') texts.push(String(c.text ?? ''));
    else if (c?.type === 'image' && typeof c.data === 'string') images.push({ base64: c.data, mime: String(c.mimeType || 'image/png') });
    else if (c?.type === 'resource') {
      const r = c.resource || {};
      texts.push(typeof r.text === 'string' ? `[resource ${r.uri || ''}]\n${r.text}` : `[resource ${r.uri || ''} ${r.mimeType || ''}（二进制，未展开）]`);
    } else if (c?.type === 'resource_link') texts.push(`[link] ${c.name || ''} ${c.uri || ''}`.trim());
    else if (c?.type === 'audio') texts.push(`[audio ${c.mimeType || ''}（未展开）]`);
  }
  const text = texts.join('\n');
  const out = res?.isError
    ? { error: text || 'MCP 工具报错（无详情）' }
    : { ok: true, content: text };
  if (res?.structuredContent && typeof res.structuredContent === 'object' && !text) out.structured = res.structuredContent;
  if (images.length) out.__images = images.slice(0, 4);
  return out;
}

// ---------------- 管理器 ----------------

/**
 * 管理一组 MCP 服务器（按配置增删重启），给工具层两样东西：
 *   schemas()   —— OpenAI function 形状的工具定义（名字 mcp__<server>__<tool>）
 *   resolve(n)  —— 工具名 → { server, tool, client, autoApprove }
 */
export function createMcpManager({ clientInfo, spawnImpl, fetchImpl, log = () => {}, onChange = () => {} } = {}) {
  const entries = new Map(); // name → { key, server, client, connecting: Promise }
  let qnameIndex = new Map();  // mcp__srv__tool → { server, tool }

  const rebuildIndex = () => {
    const idx = new Map();
    for (const { server, client } of entries.values()) {
      if (client?.state !== 'ready') continue;
      for (const t of client.tools) {
        let q = `mcp__${sanitizeName(server.name, 24)}__${sanitizeName(t.name, 64)}`.slice(0, 64);
        for (let n = 2; idx.has(q); n++) q = q.slice(0, 60) + '_' + n;
        idx.set(q, { server: server.name, tool: t.name, def: t });
      }
    }
    qnameIndex = idx;
  };
  const changed = () => { rebuildIndex(); try { onChange(); } catch { /* 观察者失败不影响 */ } };

  async function startOne(server) {
    const client = new McpClient(server, { clientInfo, spawnImpl, fetchImpl, onToolsChanged: changed });
    const entry = { key: serverKey(server), server, client, connecting: null };
    entries.set(server.name, entry);
    entry.connecting = client.connect()
      .then(() => log(`[mcp] ${server.name} 就绪：${client.tools.length} 个工具`))
      .catch((e) => log(`[mcp] ${server.name} 连接失败：${e.message}`))
      .finally(() => { entry.connecting = null; changed(); });
    return entry;
  }

  /** 按配置同步：新增的启动、删掉的关闭、改过的重启；返回等全部连接尝试结束的 Promise */
  async function sync(rawConfig) {
    const servers = parseServers(rawConfig);
    const want = new Map(servers.map((s) => [s.name, s]));
    const jobs = [];
    for (const [name, e] of [...entries]) {
      const next = want.get(name);
      if (!next || serverKey(next) !== e.key || next.error) {
        entries.delete(name);
        jobs.push(e.client?.close());
      } else {
        e.server = next; // timeoutMs / autoApprove 改了不必重启
      }
    }
    await Promise.allSettled(jobs);
    for (const s of servers) {
      if (entries.has(s.name)) continue;
      if (s.error || s.disabled) {
        entries.set(s.name, { key: serverKey(s), server: s, client: null, connecting: null });
        continue;
      }
      startOne(s);
    }
    changed();
    await Promise.allSettled([...entries.values()].map((e) => e.connecting).filter(Boolean));
  }

  async function restart(name) {
    const e = entries.get(name);
    if (!e) return false;
    await e.client?.close();
    entries.delete(name);
    if (e.server.error || e.server.disabled) { entries.set(name, e); return false; }
    const ne = await startOne(e.server);
    await ne.connecting;
    return true;
  }

  function status() {
    return [...entries.values()].map(({ server, client, connecting }) => ({
      name: server.name,
      transport: server.transport,
      target: server.transport === 'http' ? server.url : [server.command, ...(server.args || [])].join(' '),
      state: server.error ? 'invalid' : server.disabled ? 'disabled' : connecting ? 'connecting' : (client?.state || 'idle'),
      error: server.error || client?.error || '',
      serverInfo: client?.serverInfo || null,
      tools: client?.state === 'ready' ? client.tools.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200) })) : []
    }));
  }

  function schemas() {
    const out = [];
    for (const [q, { server, def }] of qnameIndex) {
      const params = def.inputSchema && typeof def.inputSchema === 'object' ? { ...def.inputSchema } : {};
      if (params.type !== 'object') params.type = 'object';
      if (!params.properties || typeof params.properties !== 'object') params.properties = {};
      out.push({
        type: 'function',
        function: {
          name: q,
          description: `[MCP:${server}] ${String(def.description || def.title || def.name).slice(0, 1000)}`,
          parameters: params
        }
      });
    }
    return out;
  }

  function resolve(qname) {
    const hit = qnameIndex.get(qname);
    if (!hit) return null;
    const e = entries.get(hit.server);
    if (!e?.client) return null;
    const aa = e.server.autoApprove;
    return { server: hit.server, tool: hit.tool, client: e.client, autoApprove: aa === true || (Array.isArray(aa) && aa.includes(hit.tool)), annotations: hit.def.annotations || null };
  }

  /** 给系统提示词用：各服务器的 instructions（有才给） */
  function instructions() {
    return [...entries.values()]
      .filter((e) => e.client?.state === 'ready' && e.client.instructions)
      .map((e) => `## MCP:${e.server.name}\n${e.client.instructions}`)
      .join('\n\n');
  }

  async function closeAll() {
    const all = [...entries.values()];
    entries.clear();
    await Promise.allSettled(all.map((e) => e.client?.close()));
    changed();
  }

  return { sync, restart, status, schemas, resolve, instructions, closeAll, toolCount: () => qnameIndex.size };
}
