// MCP stdio server 集成测试：每个用例 spawn 真实进程，走按行 JSON-RPC 2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'finalcheck-mcp.js');
const FIVE_TOOLS = ['audit_project', 'download_gate', 'probe_target', 'stress_target', 'get_report'];

// 最小 MCP 客户端：按行收发，响应按到达顺序出队
function startServer() {
  const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
  const queue = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    try { queue.push(JSON.parse(s)); } catch { /* 非 JSON 行不进队列 */ }
  });
  child.stderr.resume(); // stderr 仅诊断，排空防阻塞
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const next = (timeoutMs = 15000) => new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const msg = queue.shift();
      if (msg) return resolve(msg);
      if (Date.now() - start > timeoutMs) return reject(new Error('等待 MCP 响应超时'));
      setTimeout(poll, 20);
    };
    poll();
  });
  const request = async (id, method, params, timeoutMs) => {
    send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    return next(timeoutMs);
  };
  const close = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.stdin.end();
  });
  return { child, send, request, next, close };
}

test('initialize: serverInfo.name=finalcheck 且协议版本 2024-11-05', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    const res = await s.request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.0' } });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.serverInfo.name, 'finalcheck');
    assert.equal(res.result.protocolVersion, '2024-11-05');
    assert.ok(res.result.capabilities && res.result.capabilities.tools, '需声明 tools capability');
  } finally { await s.close(); }
});

test('notifications/initialized 被忽略（不回包，通道继续可用）', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    await s.request(1, 'initialize', {});
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await s.request(2, 'tools/list', undefined, 5000);
    assert.equal(res.id, 2);
    assert.ok(Array.isArray(res.result.tools), '通知不得污染响应队列');
  } finally { await s.close(); }
});

test('tools/list: 十二工具齐全（含文件编辑/产物/方法论库），schema 照抄 TOOLS_SCHEMA', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    const res = await s.request(1, 'tools/list');
    const names = res.result.tools.map((t) => t.name);
    assert.deepEqual([...names].sort(), [...FIVE_TOOLS, 'run_command', 'read_playbook', 'list_playbooks', 'read_file', 'edit_file', 'write_file', 'present_artifact', 'remember_project', 'quality_gate'].sort());
    for (const t of res.result.tools) {
      assert.ok(t.description, t.name + ' 缺 description');
      assert.equal(t.inputSchema?.type, 'object');
      assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === 'object', t.name + ' 缺 properties');
    }
    const probe = res.result.tools.find((t) => t.name === 'stress_target');
    assert.deepEqual(Object.keys(probe.inputSchema.properties), ['url', 'duration', 'connections']);
  } finally { await s.close(); }
});

test('tools/call 方法论库：list_playbooks 40 类 + read_playbook 读入口', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    const r1 = await s.request(1, 'tools/call', { name: 'list_playbooks', arguments: {} }, 18000);
    assert.ok(!r1.result.isError, r1.result?.content?.[0]?.text);
    const list = JSON.parse(r1.result.content[0].text);
    assert.equal(list.total, 40);
    assert.equal(list.categories.length, 40);
    const r2 = await s.request(2, 'tools/call', { name: 'read_playbook', arguments: { topic: 'ssrf' } }, 18000);
    assert.ok(!r2.result.isError, r2.result?.content?.[0]?.text);
    const book = JSON.parse(r2.result.content[0].text);
    assert.equal(book.file, 'SKILL.md');
    assert.match(book.content, /文件路由/);
    // 路径监狱：MCP 侧同样不能越界
    const r3 = await s.request(3, 'tools/call', { name: 'read_playbook', arguments: { topic: 'ssrf', file: '../../package.json' } }, 18000);
    const bad = JSON.parse(r3.result.content[0].text);
    assert.ok(bad.error, '越界文件必须报错');
  } finally { await s.close(); }
});

test('tools/call 文件工具：read_file / edit_file / write_file 全链路', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-mcp-fs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'code.js');
  await writeFile(file, 'const a = 1;\nconst b = 2;\n');
  const s = startServer();
  try {
    const r1 = await s.request(1, 'tools/call', { name: 'read_file', arguments: { path: file } }, 18000);
    const read = JSON.parse(r1.result.content[0].text);
    assert.match(read.content, /const b = 2/);
    const r2 = await s.request(2, 'tools/call', { name: 'edit_file', arguments: { path: file, old_string: 'const b = 2;', new_string: 'const b = 3;' } }, 18000);
    const edit = JSON.parse(r2.result.content[0].text);
    assert.equal(edit.added, 1);
    assert.equal(edit.removed, 1);
    assert.match(await readFile(file, 'utf8'), /const b = 3/);
    const r3 = await s.request(3, 'tools/call', { name: 'write_file', arguments: { path: path.join(dir, 'new.txt'), content: 'hi\n' } }, 18000);
    const write = JSON.parse(r3.result.content[0].text);
    assert.equal(write.created, true);
    assert.equal(write.added, 1);
    assert.match(await readFile(path.join(dir, 'new.txt'), 'utf8'), /hi/);
    const r4 = await s.request(4, 'tools/call', { name: 'present_artifact', arguments: { path: path.join(dir, 'new.txt'), title: 'New' } }, 18000);
    const present = JSON.parse(r4.result.content[0].text);
    assert.equal(present.title, 'New');
    assert.equal(present.name, 'new.txt');
  } finally { await s.close(); }
});

test('tools/call audit_project: 仓库根自审返回 verdict', { timeout: 40000 }, async () => {
  const s = startServer();
  try {
    // S4 现在按全部 workspace lockfile 各跑一次 npm audit（根 + desktop），离线回退官方源时
    // 单次审计可达数秒；并行跑整个测试套件时 18s 不够，放宽到 35s（只影响测试等待，不放宽判定）。
    const res = await s.request(1, 'tools/call', { name: 'audit_project', arguments: { dir: REPO_ROOT } }, 35000);
    assert.ok(!res.result.isError, 'audit_project 不应报错: ' + res.result?.content?.[0]?.text);
    const parsed = JSON.parse(res.result.content[0].text);
    assert.ok('verdict' in parsed, '结果需含 verdict: ' + res.result.content[0].text.slice(0, 200));
    assert.ok(['过', '修完再过', '拦', '无法验收', '待授权'].includes(parsed.verdict), '结论四态+封顶+待授权: ' + parsed.verdict);
    assert.ok(Array.isArray(parsed.findings));
  } finally { await s.close(); }
});

test('tools/call probe_target: 非 localhost 目标一律拒绝且文本含 localhost', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    const res = await s.request(1, 'tools/call', { name: 'probe_target', arguments: { url: 'http://evil.com' } }, 18000);
    assert.equal(res.result.isError, true, '越界目标必须 isError');
    const text = res.result.content[0].text;
    assert.ok(text.includes('localhost'), '拒绝文本需说明仅允许 localhost，实际: ' + text);
  } finally { await s.close(); }
});

test('tools/call stress_target: 超温和上限（60s/50 连接）被拒绝', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    const res = await s.request(1, 'tools/call', { name: 'stress_target', arguments: { url: 'http://127.0.0.1:9', duration: 300, connections: 500 } }, 18000);
    assert.equal(res.result.isError, true);
    const text = res.result.content[0].text;
    assert.ok(text.includes('60s') && text.includes('50 连接'), '拒绝文本需点明上限 60s/50 连接，实际: ' + text);
  } finally { await s.close(); }
});

test('tools/call 未知工具: 返回 isError 结果，进程不崩', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    const res = await s.request(1, 'tools/call', { name: 'no_such_tool', arguments: {} }, 18000);
    assert.equal(res.result.isError, true);
    assert.ok(res.result.content[0].text.includes('未知工具'));
    // 进程仍在：后续请求还有响应
    const res2 = await s.request(2, 'initialize', {});
    assert.equal(res2.result.serverInfo.name, 'finalcheck');
  } finally { await s.close(); }
});

test('未知方法: JSON-RPC error -32601', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    const res = await s.request(1, 'no/such/method');
    assert.equal(res.id, 1);
    assert.equal(res.error.code, -32601);
    assert.ok(res.error.message.includes('no/such/method'));
  } finally { await s.close(); }
});
