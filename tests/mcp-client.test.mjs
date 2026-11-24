// 0.33.0 MCP 客户端：配置解析、stdio / Streamable HTTP 两种传输、管理器的增删重启与工具命名。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {
  parseServers, stdioSpawnSpec, sanitizeName, parseSseChunk, toToolResult, McpClient, createMcpManager
} from '../desktop/src/main/mcp-client.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'tests/fixtures/mcp-fixture-server.mjs');
const fixtureServer = (extra = {}) => ({ name: 'fx', transport: 'stdio', command: process.execPath, args: [fixture], env: {}, timeoutMs: 20000, autoApprove: [], ...extra });

test('parseServers：兼容 Claude Code 的 mcpServers 形状，非法项带 error 不抛', () => {
  const s = parseServers({
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } },
    remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } },
    implicit: { url: 'http://127.0.0.1:9/mcp' },
    old: { type: 'sse', url: 'https://example.com/sse' },
    nocmd: { args: [] },
    badurl: { type: 'http', url: 'file:///etc/passwd' },
    'bad name!': { command: 'x' },
    off: { command: 'x', disabled: true, autoApprove: ['a'], timeoutMs: 5000 }
  });
  const by = Object.fromEntries(s.map((x) => [x.name, x]));
  assert.equal(by.github.transport, 'stdio');
  assert.deepEqual(by.github.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(by.remote.transport, 'http');
  assert.equal(by.remote.headers.Authorization, 'Bearer t');
  assert.equal(by.implicit.transport, 'http', '只写 url 默认按 http');
  assert.match(by.old.error, /SSE/);
  assert.match(by.nocmd.error, /command/);
  assert.match(by.badurl.error, /http/);
  assert.match(by['bad name!'].error, /服务器名/);
  assert.equal(by.off.disabled, true);
  assert.deepEqual(by.off.autoApprove, ['a']);
  assert.equal(by.off.timeoutMs, 5000);
  assert.deepEqual(parseServers(null), []);
  assert.deepEqual(parseServers([]), []);
});

test('stdioSpawnSpec：Windows 上 npx 这类 .cmd 经 cmd.exe，参数带空格要加引号；.exe 直接起', () => {
  const w = stdioSpawnSpec('npx', ['-y', 'pkg', 'C:/a b/c'], 'win32');
  assert.match(w.file, /cmd(\.exe)?$/i);
  assert.deepEqual(w.argv.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(w.argv[3], '"npx -y pkg "C:/a b/c""');
  assert.equal(w.verbatim, true);
  assert.deepEqual(stdioSpawnSpec('C:/x/node.exe', ['s.mjs'], 'win32'), { file: 'C:/x/node.exe', argv: ['s.mjs'], verbatim: false });
  assert.deepEqual(stdioSpawnSpec('npx', ['a'], 'linux'), { file: 'npx', argv: ['a'], verbatim: false });
});

test('工具名与结果转换', () => {
  assert.equal(sanitizeName('my.tool/v2'), 'my_tool_v2');
  const r = toToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AAA', mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'file:///x', text: 'body' } }] });
  assert.equal(r.ok, true);
  assert.match(r.content, /^a\n\[resource file:\/\/\/x\]\nbody$/);
  assert.deepEqual(r.__images, [{ base64: 'AAA', mime: 'image/png' }]);
  assert.deepEqual(toToolResult({ isError: true, content: [{ type: 'text', text: 'bad' }] }), { error: 'bad' });
  assert.deepEqual(toToolResult({ structuredContent: { n: 1 }, content: [] }), { ok: true, content: '', structured: { n: 1 } });
  const events = [];
  const st = { buf: '' };
  parseSseChunk(st, 'event: message\ndata: {"a":', (d) => events.push(d));
  parseSseChunk(st, '1}\n\ndata: {"b":2}\r\n\r\n', (d) => events.push(d));
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
});

test('stdio：连接、分页列工具、调用、isError、图片、跳过 stdout 日志行、env 透传', async () => {
  const c = new McpClient(fixtureServer({ env: { FIXTURE_TOKEN: 'tok-123' } }));
  try {
    await c.connect();
    assert.equal(c.state, 'ready');
    assert.equal(c.serverInfo.name, 'fixture');
    assert.equal(c.instructions, 'Use echo for testing.');
    assert.deepEqual(c.tools.map((t) => t.name), ['echo', 'boom', 'pic', 'slow', 'grow', 'crash', 'env'], '两页都要拿到');
    assert.deepEqual(toToolResult(await c.callTool('echo', { text: 'hi' })), { ok: true, content: 'echo: hi' });
    assert.deepEqual(toToolResult(await c.callTool('boom', {})), { error: 'it broke' });
    assert.equal(toToolResult(await c.callTool('pic', {})).__images.length, 1);
    assert.equal(toToolResult(await c.callTool('env', {})).content, 'tok-123');
    await assert.rejects(c.callTool('nope', {}), /unknown tool/);
  } finally { await c.close(); }
});

test('stdio：取消（signal）立即返回并通知服务器；list_changed 触发重新列工具', async () => {
  let changed = 0;
  const c = new McpClient(fixtureServer(), { onToolsChanged: () => { changed++; } });
  try {
    await c.connect();
    const ac = new AbortController();
    const t0 = Date.now();
    const p = c.callTool('slow', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(p, /已取消/);
    assert.ok(Date.now() - t0 < 2000, '取消要立刻生效，不能等 5 秒');
    await c.callTool('grow', {});
    for (let i = 0; i < 50 && !c.tools.some((t) => t.name === 'extra.tool'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(c.tools.some((t) => t.name === 'extra.tool'), '收到 list_changed 后应重新拉工具');
    assert.ok(changed >= 1);
  } finally { await c.close(); }
});

test('stdio：服务器崩溃 → 状态 error，错误里带 stderr 末尾；挂起的调用被拒绝', async () => {
  const c = new McpClient(fixtureServer());
  await c.connect();
  await assert.rejects(c.callTool('crash', {}), /进程退出/);
  assert.equal(c.state, 'error');
  assert.match(c.error, /fixture crashed on purpose/);
  await c.close();
});

test('stdio：命令不存在 → 连接失败给出可读错误', async () => {
  const c = new McpClient({ name: 'x', transport: 'stdio', command: 'definitely-not-a-real-binary-fc.exe', args: [], env: {}, timeoutMs: 5000 });
  await assert.rejects(c.connect(), /启动失败|ENOENT/);
  assert.equal(c.state, 'error');
});

test('stdio：能接 FinalCheck 自己的 MCP 服务器（bin/finalcheck-mcp.js）', async () => {
  const c = new McpClient({ name: 'fc', transport: 'stdio', command: process.execPath, args: [path.join(root, 'bin/finalcheck-mcp.js')], env: {}, cwd: root, timeoutMs: 20000 });
  try {
    await c.connect();
    assert.ok(c.tools.length >= 3, `至少有几个工具，实际 ${c.tools.length}`);
    assert.ok(c.tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object'));
  } finally { await c.close(); }
});

// ---- Streamable HTTP ----
function startHttpMcp({ sse = false } = {}) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    seen.push({ method: req.method, session: req.headers['mcp-session-id'] || '', proto: req.headers['mcp-protocol-version'] || '', auth: req.headers.authorization || '', accept: req.headers.accept || '' });
    if (req.method === 'DELETE') { res.statusCode = 204; return res.end(); }
    const m = JSON.parse(body);
    if (m.id === undefined) { res.statusCode = 202; return res.end(); }
    let result;
    if (m.method === 'initialize') { res.setHeader('mcp-session-id', 'sess-1'); result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'h', version: '1' } }; }
    else if (m.method === 'tools/list') result = { tools: [{ name: 'add', description: 'a+b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }] };
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] };
    const msg = JSON.stringify({ jsonrpc: '2.0', id: m.id, result });
    if (sse && m.method === 'tools/call') {
      res.setHeader('content-type', 'text/event-stream');
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
      res.write(`event: message\ndata: ${msg}\n\n`);
      return; // 故意不 end：客户端拿到自己的响应就该收手
    }
    res.setHeader('content-type', 'application/json');
    res.end(msg);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/mcp` })));
}

for (const sse of [false, true]) {
  test(`Streamable HTTP（${sse ? 'SSE 响应' : 'JSON 响应'}）：会话 id、协议版本头、自定义 header 都带上`, async () => {
    const { srv, seen, url } = await startHttpMcp({ sse });
    const c = new McpClient({ name: 'h', transport: 'http', url, headers: { Authorization: 'Bearer abc' }, timeoutMs: 5000 });
    try {
      await c.connect();
      assert.deepEqual(c.tools.map((t) => t.name), ['add']);
      assert.deepEqual(toToolResult(await c.callTool('add', { a: 2, b: 3 })), { ok: true, content: '5' });
      assert.equal(seen[0].session, '', 'initialize 时还没有会话');
      assert.ok(seen.slice(1).every((s) => s.session === 'sess-1'), '之后每个请求都要带 mcp-session-id');
      assert.ok(seen.slice(1).filter((s) => s.method === 'POST').every((s) => s.proto === '2025-06-18'));
      assert.ok(seen.every((s) => s.auth === 'Bearer abc'));
      assert.match(seen[0].accept, /application\/json/);
      assert.match(seen[0].accept, /text\/event-stream/);
    } finally {
      await c.close();
      srv.closeAllConnections?.();
      srv.close();
    }
    assert.ok(seen.some((s) => s.method === 'DELETE' && s.session === 'sess-1'), '关闭时 DELETE 结束会话');
  });
}

test('HTTP：服务器返回 401 → 连接失败带状态码', async () => {
  const srv = http.createServer((req, res) => { res.statusCode = 401; res.end('unauthorized'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = new McpClient({ name: 'h', transport: 'http', url: `http://127.0.0.1:${srv.address().port}/`, headers: {}, timeoutMs: 5000 });
  await assert.rejects(c.connect(), /HTTP 401/);
  srv.close();
});

test('管理器：sync 增删、工具名 mcp__srv__tool、autoApprove、状态、重启', async () => {
  let changes = 0;
  const m = createMcpManager({ onChange: () => { changes++; } });
  try {
    await m.sync({
      fx: { command: process.execPath, args: [fixture], autoApprove: ['echo'] },
      broken: { command: 'definitely-not-a-real-binary-fc.exe' },
      off: { command: process.execPath, args: [fixture], disabled: true },
      bad: { type: 'sse', url: 'https://x' }
    });
    const st = Object.fromEntries(m.status().map((s) => [s.name, s]));
    assert.equal(st.fx.state, 'ready');
    assert.equal(st.fx.tools.length, 7);
    assert.equal(st.broken.state, 'error');
    assert.equal(st.off.state, 'disabled');
    assert.equal(st.bad.state, 'invalid');
    const names = m.schemas().map((s) => s.function.name);
    assert.ok(names.includes('mcp__fx__echo'));
    assert.ok(names.every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n)), names.join(','));
    const echo = m.schemas().find((s) => s.function.name === 'mcp__fx__echo').function;
    assert.match(echo.description, /^\[MCP:fx\] Echo/);
    assert.deepEqual(echo.parameters.required, ['text']);
    assert.equal(m.resolve('mcp__fx__echo').autoApprove, true);
    assert.equal(m.resolve('mcp__fx__boom').autoApprove, false);
    assert.equal(m.resolve('mcp__nope__x'), null);
    assert.match(m.instructions(), /MCP:fx[\s\S]*Use echo/);
    assert.ok(changes > 0);

    // 删掉 fx → 工具消失
    await m.sync({ off: { command: process.execPath, args: [fixture], disabled: true } });
    assert.equal(m.schemas().length, 0);
    assert.deepEqual(m.status().map((s) => s.name), ['off']);

    // 启用 → 启动；restart 能重新连上
    await m.sync({ off: { command: process.execPath, args: [fixture] } });
    assert.equal(m.status()[0].state, 'ready');
    assert.equal(await m.restart('off'), true);
    assert.equal(m.status()[0].state, 'ready');
    assert.equal(m.toolCount(), 7);
  } finally { await m.closeAll(); }
});

test('stdio（Windows）：.cmd 包装的服务器（npx / uvx 同理）经 cmd.exe 能起来，带空格的参数不被拆开', { skip: process.platform !== 'win32' }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc mcp cmd '));
  const cmd = path.join(dir, 'fx-server.cmd');
  await writeFile(cmd, `@"${process.execPath}" %*\r\n`);
  const c = new McpClient({ name: 'w', transport: 'stdio', command: cmd, args: [fixture], env: { FIXTURE_TOKEN: 'a b&c' }, timeoutMs: 20000 });
  try {
    await c.connect();
    assert.equal(c.tools.length, 7);
    assert.equal(toToolResult(await c.callTool('env', {})).content, 'a b&c');
  } finally { await c.close(); await rm(dir, { recursive: true, force: true }); }
});
