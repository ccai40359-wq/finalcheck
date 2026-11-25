// 0.33.6 多个浏览器子代理并行测网页（真 Electron 验收：scripts/probe-parallel-browser-agents.mjs，6/6）。
// 用户原话：「fc 里子 agent 都能并行打开浏览器网页然后进行各自的操作测试……多个 tab，这样速度快很多」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { AGENT_TOOLS_SCHEMA, SPAWN_AGENT_SCHEMA } from '../desktop/src/main/agent-service.mjs';

test('spawn_agent 模式：type=browser + browser_isolation，并鼓励同一次回复派多个', () => {
  const p = SPAWN_AGENT_SCHEMA.function.parameters.properties;
  assert.ok(p.type.enum.includes('browser'));
  assert.deepEqual(p.browser_isolation.enum, ['shared', 'isolated']);
  assert.match(SPAWN_AGENT_SCHEMA.function.description, /同一次回复里派多个 browser 子代理/);
});

test('spawn_agent 工具：browser 类型把隔离方式传下去；乱填按 shared；非 browser 不带', async () => {
  const calls = [];
  const tools = createAgentTools({ repoRoot: process.cwd(), spawnAgent: async (a) => { calls.push(a); return { ok: true }; } });
  await tools.spawn_agent({ type: 'browser', description: '测登录', prompt: '打开 http://x/login 点登录', browser_isolation: 'isolated' });
  await tools.spawn_agent({ type: 'browser', description: '测购物车', prompt: '打开 http://x/cart', browser_isolation: 'whatever' });
  await tools.spawn_agent({ type: 'explore', description: '查', prompt: '查 foo', browser_isolation: 'isolated' });
  assert.equal(calls[0].type, 'browser');
  assert.equal(calls[0].browserIsolation, 'isolated');
  assert.equal(calls[1].browserIsolation, 'shared');
  assert.equal(calls[2].browserIsolation, undefined);
});

test('浏览器子代理的工具：能开页/点/输入/取证；不能改文件、不能关标签、不能接真 Edge、不能派子代理', () => {
  const src = readFileSync(new URL('../desktop/src/main/ipc/ipc-agent.mjs', import.meta.url), 'utf8');
  const m = src.match(/const SPAWN_BROWSER_TOOLS = (\[[^\]]+\])/);
  assert.ok(m, 'SPAWN_BROWSER_TOOLS 存在');
  const names = JSON.parse(m[1].replace(/'/g, '"'));
  for (const n of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_evaluate', 'browser_console', 'browser_screenshot']) assert.ok(names.includes(n), n);
  for (const n of ['write_file', 'edit_file', 'run_command', 'browser_close', 'browser_connect_real', 'spawn_agent', 'ask_user']) assert.ok(!names.includes(n), n);
  // 每个名字都真有 schema（从全量工具表里挑，不是子代理那张没有 browser_* 的小表）
  const all = AGENT_TOOLS_SCHEMA.map((x) => x.function.name);
  for (const n of names) assert.ok(all.includes(n), `${n} 有 schema`);
  assert.match(src, /schemaPool === 'agent' \? AGENT_TOOLS_SCHEMA_ALL : SUBAGENT_TOOLS_SCHEMA/);
  // 自己的标签作用域 + 结束时释放（标签留给用户）
  assert.match(src, /bu\.forAgent\(sessionId, spawn\.browserAgent\.agent, \{ isolate: spawn\.browserAgent\.isolate \}\)/);
  assert.match(src, /releaseAgent\?\.\(sessionId, id\)/);
  assert.match(src, /浏览器模式已经定好，不用问用户/);
});
