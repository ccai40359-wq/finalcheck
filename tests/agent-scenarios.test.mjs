import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import server from './fixtures/dynamic-target/app.mjs';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function sse(chunks) {
  const body = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const sseText = (text) => sse([{ choices: [{ delta: { content: text } }] }]);
const sseTool = (name, args, id = 'c1') => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }]);

function fakePermissions() {
  return {
    noteTarget() {},
    sessionAllowed: () => true,
    commandPrefix: (cmd) => String(cmd).split(/\s+/)[0],
    requestApproval: async () => 'allowed-once'
  };
}

test('agent 全链路：读 SSRF 方法论 → 探测真靶子 → 带证据作答', async (t) => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const bodies = [];
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sseTool('read_playbook', { topic: 'ssrf' });
    if (bodies.length === 2) return sseTool('probe_target', { url: base }, 'c2');
    return sseText('结论：**/api/users 无认证可读（已复现）**，另外 CORS 反射 `*`、缺安全头。');
  };
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: `目标 ${base} 是我授权的本机测试站，帮我看看` }],
    tools,
    fetchImpl: mockFetch
  });

  // 系统提示里必须有 40 类目录（模型不用猜类目名）
  const system = bodies[0].messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /方法论库（40 类/);
  assert.match(system.content, /11 SSRF/);
  assert.match(system.content, /list_playbooks/);
  // 工具 schema 齐全（含分页参数）
  const names = bodies[0].tools.map((x) => x.function.name);
  for (const n of ['list_playbooks', 'read_playbook', 'probe_target', 'run_command']) assert.ok(names.includes(n), n);
  const rp = bodies[0].tools.find((x) => x.function.name === 'read_playbook');
  assert.ok(rp.function.parameters.properties.offset);
  assert.ok(rp.function.parameters.properties.file);

  // 工具真的执行了，结果回填给模型
  assert.deepEqual(out.trace.map((x) => x.tool), ['read_playbook', 'probe_target']);
  assert.match(out.trace[0].result.content, /文件路由/);
  const toolMsgs1 = bodies[1].messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs1[0].content, /SKILL\.md/);
  const toolMsgs2 = bodies[2].messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs2[1].content, /cors/);
  assert.match(toolMsgs2[1].content, /reflected/);
  // 最终回答引用复现证据
  assert.match(out.answer, /已复现/);
});

test('agent 结果过长：头+尾进上下文，全文落盘到 spill', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-spill-'));
  const prev = process.env.FINALCHECK_SPILL_DIR;
  process.env.FINALCHECK_SPILL_DIR = dir;
  t.after(async () => {
    if (prev == null) delete process.env.FINALCHECK_SPILL_DIR; else process.env.FINALCHECK_SPILL_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const bodies = [];
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sseTool('big_tool', {});
    return sseText('收到');
  };
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: '跑个大输出' }],
    tools: { big_tool: async () => ({ blob: 'x'.repeat(60000) }) },
    fetchImpl: mockFetch
  });
  assert.equal(out.trace[0].result.truncated, true);
  assert.ok(out.trace[0].result.spillFile);
  const spilled = await readFile(out.trace[0].result.spillFile, 'utf8');
  assert.ok(spilled.length > 60000);
  const toolMsg = bodies[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /结果过长/);
  assert.match(toolMsg.content, /完整输出/);
  assert.ok(toolMsg.content.length < 20000, '模型侧只拿头尾，不整块喂');
});

test('agent 全链路：read_file → edit_file 改代码并回填 +N/-M', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-agent-edit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.js');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, 'const port = 3000;\n');
  const bodies = [];
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sseTool('read_file', { path: file });
    if (bodies.length === 2) return sseTool('edit_file', { path: file, old_string: 'const port = 3000;', new_string: 'const port = process.env.PORT || 3000;' }, 'c2');
    return sseText('已把端口改成环境变量，文件已更新。');
  };
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: '把端口改成环境变量' }],
    tools: createAgentTools({ repoRoot, permissions: fakePermissions() }),
    fetchImpl: mockFetch
  });
  assert.deepEqual(out.trace.map((x) => x.tool), ['read_file', 'edit_file']);
  assert.equal(out.trace[1].result.added, 1);
  assert.equal(out.trace[1].result.removed, 1);
  assert.match(await readFile(file, 'utf8'), /process\.env\.PORT/);
  const toolMsgs = bodies[2].messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs[1].content, /"added":1/);
});

test('agent 容错：未知工具 / 坏 JSON 参数都不炸循环', async () => {
  const bodies = [];
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sseTool('ghost_tool', {});
    if (bodies.length === 2) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'read_playbook', arguments: '{bad json' } }] } }] }]);
    return sseText('都处理完了');
  };
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: '测试容错' }],
    tools,
    fetchImpl: mockFetch
  });
  assert.match(out.trace[0].result.error, /未知工具/);
  assert.ok(out.trace[1].result.error);
  assert.equal(out.answer, '都处理完了');
});
