// MCP stdio server 集成测试：每个用例 spawn 真实进程，走按行 JSON-RPC 2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'finalcheck-mcp.js');
const FIVE_TOOLS = ['audit_project', 'download_gate', 'probe_target', 'stress_target', 'get_report'];
const ALLOW_ENV = 'FINALCHECK_MCP_ALLOW_COMMANDS';

// 最小 MCP 客户端：按行收发，响应按到达顺序出队
// root：传给 server 的 --root（路径边界）；不传则用 server 默认 cwd（可用 cwd 覆盖工作目录）
function startServer({ root = null, cwd = null, env = null } = {}) {
  const args = [BIN];
  if (root) args.push('--root', root);
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {})
  });
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

test('tools/list: 十二个有 handler 的工具齐全（含文件编辑/产物/方法论库），schema 照抄 TOOLS_SCHEMA', { timeout: 20000 }, async () => {
  const s = startServer();
  try {
    const res = await s.request(1, 'tools/list');
    const names = res.result.tools.map((t) => t.name);
    // 只广告本通道真的有 handler 的工具：run_command / remember_project / run_workflow
    // 需要桌面端审批或子代理，MCP 没有对应 case，不能广告出去。
    assert.deepEqual([...names].sort(), [...FIVE_TOOLS, 'read_playbook', 'list_playbooks', 'read_file', 'edit_file', 'write_file', 'present_artifact', 'quality_gate'].sort());
    assert.ok(!names.includes('run_command'), 'run_command 没有 MCP handler，不能出现在 tools/list');
    assert.ok(!names.includes('remember_project'), 'remember_project 没有 MCP handler，不能出现在 tools/list');
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

test('tools/call 文件工具：read_file / edit_file / write_file 全链路（root 内）', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-mcp-fs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'code.js');
  await writeFile(file, 'const a = 1;\nconst b = 2;\n');
  const s = startServer({ root: dir });
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
  const s = startServer({ root: REPO_ROOT });
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

// ---- MCP 路径边界与命令授权（--root 路径监狱 + quality_gate 默认拒绝）----

async function toolResult(s, id, name, args, timeoutMs = 18000) {
  const res = await s.request(id, 'tools/call', { name, arguments: args }, timeoutMs);
  const text = res.result.content[0].text;
  return { isError: res.result.isError === true, text, data: () => JSON.parse(text) };
}

const exists = (p) => access(p).then(() => true, () => false);

test('MCP 路径边界：root 内读写成功；../、绝对路径 C:\\Windows\\...、root 外文件全部拒绝', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-mcp-jail-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'fc-mcp-out-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(path.join(root, 'in.txt'), 'inside-ok\n');
  await writeFile(path.join(outside, 'secret.txt'), 'outside-secret\n');
  const outsideFile = path.join(outside, 'secret.txt');
  const relEscape = `..${path.sep}${path.basename(outside)}${path.sep}secret.txt`;
  // Windows 用真实系统路径验证绝对路径逃逸；POSIX 用 /etc/passwd（即使存在也不许读）
  const absEscape = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
  const s = startServer({ root });
  try {
    const insideRead = await toolResult(s, 1, 'read_file', { path: path.join(root, 'in.txt') });
    assert.ok(!insideRead.isError, insideRead.text);
    assert.match(insideRead.data().content, /inside-ok/);
    const insideReadRel = await toolResult(s, 2, 'read_file', { path: 'in.txt' });
    assert.ok(!insideReadRel.isError, insideReadRel.text);
    const insideWrite = await toolResult(s, 3, 'write_file', { path: 'sub.txt', content: 'relative-ok\n' });
    assert.ok(!insideWrite.isError, insideWrite.text);
    assert.equal(insideWrite.data().created, true);
    assert.match(await readFile(path.join(root, 'sub.txt'), 'utf8'), /relative-ok/);

    const readDotDot = await toolResult(s, 4, 'read_file', { path: relEscape });
    assert.equal(readDotDot.isError, true, '必须拒绝 ../ 逃逸');
    assert.match(readDotDot.text, /越界/);

    const readAbsOutside = await toolResult(s, 5, 'read_file', { path: outsideFile });
    assert.equal(readAbsOutside.isError, true, '必须拒绝 root 外绝对路径');
    assert.match(readAbsOutside.text, /越界/);

    const readSystemAbs = await toolResult(s, 6, 'read_file', { path: absEscape });
    assert.equal(readSystemAbs.isError, true, '必须拒绝系统绝对路径');
    assert.match(readSystemAbs.text, /越界/);

    const writeOutside = await toolResult(s, 7, 'write_file', { path: outsideFile, content: 'pwned\n' });
    assert.equal(writeOutside.isError, true, '必须拒绝 root 外写入');
    assert.match(writeOutside.text, /越界/);
    assert.match(await readFile(outsideFile, 'utf8'), /outside-secret/, 'root 外文件不得被改写');

    const editDotDot = await toolResult(s, 8, 'edit_file', { path: relEscape, old_string: 'outside-secret', new_string: 'pwned' });
    assert.equal(editDotDot.isError, true, '必须拒绝 ../ 编辑');
    assert.match(editDotDot.text, /越界/);

    const presentOutside = await toolResult(s, 9, 'present_artifact', { path: outsideFile });
    assert.equal(presentOutside.isError, true, 'present_artifact 必须拒绝 root 外文件');
    assert.match(presentOutside.text, /越界/);

    const auditOutside = await toolResult(s, 10, 'audit_project', { dir: outside });
    assert.equal(auditOutside.isError, true, 'audit_project 必须拒绝 root 外目录');
    assert.match(auditOutside.text, /越界/);

    const downloadOutside = await toolResult(s, 11, 'download_gate', { dir: outside });
    assert.equal(downloadOutside.isError, true, 'download_gate 必须拒绝 root 外目录');
    assert.match(downloadOutside.text, /越界/);

    const reportOutside = await toolResult(s, 12, 'get_report', { dir: outside });
    assert.equal(reportOutside.isError, true, 'get_report 必须拒绝 root 外目录');
    assert.match(reportOutside.text, /越界/);
  } finally { await s.close(); }
});

test('MCP 未传 --root 时默认以进程 cwd 为根', { timeout: 20000 }, async () => {
  const s = startServer({ cwd: REPO_ROOT });
  try {
    const inside = await toolResult(s, 1, 'read_file', { path: path.join(REPO_ROOT, 'package.json') });
    assert.ok(!inside.isError, inside.text);
    const outside = await toolResult(s, 2, 'read_file', { path: path.join(os.tmpdir(), 'fc-mcp-definitely-outside.txt') });
    assert.equal(outside.isError, true, '默认 cwd 之外仍须拒绝');
    assert.match(outside.text, /越界/);
  } finally { await s.close(); }
});

test('MCP 路径边界：符号链接逃逸被拒绝', { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-mcp-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'fc-mcp-link-out-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(path.join(outside, 'secret.txt'), 'outside-secret\n');
  const link = path.join(root, 'link');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('当前平台/权限无法创建符号链接，跳过该用例');
    return;
  }
  const s = startServer({ root });
  try {
    const res = await toolResult(s, 1, 'read_file', { path: path.join('link', 'secret.txt') });
    assert.equal(res.isError, true, '符号链接逃逸必须拒绝');
    assert.match(res.text, /越界/);
  } finally { await s.close(); }
});

test('MCP quality_gate：默认拒绝执行项目命令；env=1 且显式 --root 才允许', { timeout: 40000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-mcp-qgate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'ran.txt');
  await writeFile(path.join(root, 'finalcheck.quality.json'), JSON.stringify({
    checks: [{ id: 'mcp', command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'ran\')"', timeoutMs: 30000 }]
  }), 'utf8');

  // 1) 默认（无 env）：即使项目声明了命令也拒绝，且不执行
  const denied = startServer({ root });
  try {
    const r = await toolResult(denied, 1, 'quality_gate', { dir: root }, 20000);
    assert.equal(r.isError, true, '默认必须拒绝执行项目命令');
    assert.match(r.text, /FINALCHECK_MCP_ALLOW_COMMANDS=1/);
    assert.match(r.text, /--root/);
    assert.equal(await exists(marker), false, '默认拒绝时不得执行项目命令');
  } finally { await denied.close(); }

  // 2) env=1 + 显式 --root：放行并真的执行
  const allowed = startServer({ root, env: { [ALLOW_ENV]: '1' } });
  try {
    const r = await toolResult(allowed, 1, 'quality_gate', { dir: root }, 20000);
    assert.ok(!r.isError, r.text);
    const data = r.data();
    assert.equal(data.runs.length, 1);
    assert.equal(data.runs[0].code, 0);
    assert.equal(await exists(marker), true, '授权后应按声明执行命令');
  } finally { await allowed.close(); }

  // 3) env=1 但 dir 在 root 外：仍然拒绝
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'fc-mcp-qgate-root-'));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  const outsideCall = startServer({ root: otherRoot, env: { [ALLOW_ENV]: '1' } });
  try {
    const r = await toolResult(outsideCall, 1, 'quality_gate', { dir: root }, 20000);
    assert.equal(r.isError, true, 'root 外目录必须拒绝');
    assert.match(r.text, /越界/);
  } finally { await outsideCall.close(); }

  // 4) env=1 但没显式 --root：仍不放行（避免默认 cwd 被当成授权范围）
  await rm(marker, { force: true });
  const implicitRoot = startServer({ env: { [ALLOW_ENV]: '1' } });
  try {
    const r = await toolResult(implicitRoot, 1, 'quality_gate', { dir: root }, 20000);
    assert.equal(r.isError, true, '未显式 --root 时不得执行项目命令');
    assert.match(r.text, /显式传 --root/);
    assert.equal(await exists(marker), false, '默认 cwd 模式不得执行项目命令');
  } finally { await implicitRoot.close(); }
});

test('--root 必须是已存在的目录：不存在时启动失败并给出原因', { timeout: 20000 }, async () => {
  const missing = path.join(os.tmpdir(), `fc-mcp-missing-${Date.now()}`);
  const r = spawnSync(process.execPath, [BIN, '--root', missing], { input: '', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1, '不存在的 --root 必须启动失败');
  assert.match(String(r.stderr), /--root 指定的目录不存在/);
});
