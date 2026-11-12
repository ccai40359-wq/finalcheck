import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import server from './fixtures/dynamic-target/app.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy } from '../desktop/src/main/policy.mjs';
import * as permissions from '../desktop/src/main/permissions.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

const waitFor = async (fn, timeout = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function fakePermissions({ allow = true } = {}) {
  return {
    noted: [],
    noteTarget(url) { this.noted.push(url); },
    sessionAllowed: () => allow,
    commandPrefix: (cmd) => String(cmd).split(/\s+/)[0],
    requestApproval: async () => (allow ? 'allowed-once' : 'rejected')
  };
}

test('agent-tools: list_playbooks 返回 40 类摘要', async () => {
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const r = await tools.list_playbooks({});
  assert.equal(r.total, 40);
  assert.equal(r.categories.length, 40);
  const ssrf = r.categories.find((c) => c.id === '11');
  assert.equal(ssrf.name, 'ssrf');
  assert.ok(ssrf.triggers.includes('URL'));
  assert.ok(ssrf.fileCount >= 2);
});

test('agent-tools: read_playbook 走注册表（中文类目也认）', async () => {
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const r = await tools.read_playbook({ topic: '越权' });
  assert.equal(r.name, 'idor');
  assert.match(r.content, /越权|IDOR/);
});

test('agent-tools: probe_target 返回匿名可访问线索与 CORS 反射', async (t) => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const perms = fakePermissions();
  const tools = createAgentTools({ repoRoot, permissions: perms });
  const out = await tools.probe_target({ url: base });
  assert.equal(out.target, base);
  const users = out.results.find((x) => x.path === '/api/users');
  assert.equal(users.reproduced, false);
  assert.equal(users.accessible, true);
  const cors = out.results.find((x) => x.kind === 'cors');
  assert.equal(cors.reflected, true);
  assert.deepEqual(perms.noted, [base]); // 口头确认语义：只记账
});

test('agent-tools: audit_project 跑到实锤并写项目档案', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-tools-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  await writeFile(path.join(dir, 'app.js'), 'const express=require("express"); const app=express(); app.get("/u",(req,res)=>{ db.query("SELECT * FROM users WHERE id = " + req.query.id); });');
  const archived = [];
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions(), recordAudit: async (d, r) => { archived.push({ d, verdict: r.conclusion.verdict }); } });
  const out = await tools.audit_project({ dir, tier: 'L1' });
  assert.ok(typeof out.verdict === 'string' && out.verdict.length > 0);
  assert.ok(out.findings.some((f) => f.checkId === 'S2'), '应抓到 SQL 拼接');
  assert.ok(out.findings.length <= 30);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].d, dir);
});

test('agent-tools: read_file / edit_file 走审批，拒绝时不改文件', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-tools-fs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'code.js');
  await writeFile(file, 'const v = 1;\n');

  const denied = createAgentTools({ repoRoot, permissions: fakePermissions({ allow: false }) });
  const read = await denied.read_file({ path: file });
  assert.match(read.content, /const v = 1/);
  const r1 = await denied.edit_file({ path: file, old_string: 'const v = 1;', new_string: 'const v = 2;' });
  assert.match(r1.error, /拒绝/);
  assert.match(await readFile(file, 'utf8'), /const v = 1;/);

  const approvals = [];
  const perms = {
    ...fakePermissions({ allow: false }),
    sessionAllowed: () => false,
    requestApproval: async (p) => { approvals.push(p); return 'allowed-once'; }
  };
  const allowed = createAgentTools({ repoRoot, permissions: perms });
  const r2 = await allowed.edit_file({ path: file, old_string: 'const v = 1;', new_string: 'const v = 2;' });
  assert.equal(r2.added, 1);
  assert.equal(r2.removed, 1);
  assert.match(await readFile(file, 'utf8'), /const v = 2;/);
  assert.equal(approvals[0].tool, 'edit_file');
  assert.equal(approvals[0].summary, path.resolve(file));
});

test('agent-tools: present_artifact 登记可预览文件，拒绝不支持的类型', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-tools-present-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const html = path.join(dir, 'index.html');
  await writeFile(html, '<h1>hi</h1>');
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const r = await tools.present_artifact({ path: html, title: 'Demo' });
  assert.equal(r.title, 'Demo');
  assert.equal(r.name, 'index.html');
  const bad = await tools.present_artifact({ path: path.join(dir, 'x.bin') });
  assert.match(bad.error, /文件不存在|不支持/);
});

test('agent-tools: run_command 被拒时给人话错误，允许时真的执行', async () => {
  const denied = createAgentTools({ repoRoot, permissions: fakePermissions({ allow: false }) });
  const r1 = await denied.run_command({ command: 'echo should-not-run' });
  assert.match(r1.error, /拒绝/);

  const allowed = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const r2 = await allowed.run_command({ command: 'echo finalcheck-ok' });
  assert.equal(r2.code, 0);
  assert.match(r2.stdout, /finalcheck-ok/);
  assert.equal(r2.blocked, false);
});

test('agent-tools: run_command 灾难命令仍被 shell 护栏拦截（权限已放行也拦）', async () => {
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const r = await tools.run_command({ command: 'shutdown /s /t 0' });
  assert.equal(r.blocked, true);
  assert.match(r.stderr, /拦截/);
});

/* ---------- A 档：策略沙箱接线 ---------- */

test('agent-tools: policy——项目外读取/只读写入/黑名单命令被拒，正常命令放行', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-policy-in-'));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'fc-policy-out-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });
  const inside = path.join(dir, 'inside.txt');
  const outside = path.join(outsideDir, 'outside.txt');
  await writeFile(inside, 'inside-content\n');
  await writeFile(outside, 'outside-content\n');

  const workspace = createPolicy({ projectPath: dir, mode: 'workspace' });
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions(), policy: workspace, projectPath: dir });

  const out = await tools.read_file({ path: outside });
  assert.match(out.error, /被沙箱拒绝/);
  assert.equal(out.deniedBy, 'policy');
  assert.match(out.reason, /项目边界/);

  const insideRead = await tools.read_file({ path: inside });
  assert.match(insideRead.content, /inside-content/);
  assert.equal(insideRead.path, inside, '路径经策略规范化后交给 fs-tools');

  const readonly = createPolicy({ projectPath: dir, mode: 'readonly' });
  const roTools = createAgentTools({ repoRoot, permissions: fakePermissions(), policy: readonly, projectPath: dir });
  const roEdit = await roTools.edit_file({ path: inside, old_string: 'inside-content', new_string: 'changed' });
  assert.equal(roEdit.deniedBy, 'policy');
  assert.match(roEdit.reason, /只读模式禁止写入/);
  const roWrite = await roTools.write_file({ path: path.join(dir, 'new.txt'), content: 'x' });
  assert.equal(roWrite.deniedBy, 'policy');
  assert.match(await readFile(inside, 'utf8'), /inside-content/, '只读模式不应改到磁盘');

  const deniedCmd = await tools.run_command({ command: 'shutdown /s /t 0' });
  assert.match(deniedCmd.error, /被沙箱拒绝/);
  assert.equal(deniedCmd.deniedBy, 'policy');
  assert.match(deniedCmd.reason, /黑名单/);
  assert.equal(deniedCmd.matchedRule, 'shutdown');

  const deniedCwd = await tools.run_command({ command: 'echo nope', cwd: outsideDir });
  assert.equal(deniedCwd.deniedBy, 'policy');
  assert.match(deniedCwd.reason, /项目边界/);

  const okCmd = await tools.run_command({ command: 'echo sandbox-ok' });
  assert.equal(okCmd.code, 0);
  assert.match(okCmd.stdout, /sandbox-ok/);
});

test('agent-tools: run_command 子进程看不到密钥环境变量（scrubEnv → shell env）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fc-fake-key-for-test-not-real';
  try {
    const tools = createAgentTools({
      repoRoot,
      permissions: fakePermissions(),
      policy: createPolicy({ projectPath: dir }),
      projectPath: dir
    });
    const r = await tools.run_command({ command: 'node -e "console.log(process.env.OPENAI_API_KEY || \'none\')"' });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /none/);
    assert.doesNotMatch(r.stdout, /fc-fake-key-for-test-not-real/);
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  }
});

/* ---------- B 档：hooks 工具层接线 ---------- */

const hookConfig = (events) => ({ enabled: true, events });
const hookReply = (obj) => ({ code: 0, stdout: typeof obj === 'string' ? obj : JSON.stringify(obj), stderr: '' });

test('agent-tools: PreToolUse deny 时工具不执行', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-hook-deny-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'should-not-be-read');
  const seen = [];
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    policy: createPolicy({ projectPath: dir }),
    projectPath: dir,
    sessionId: 's-deny',
    hooksConfig: hookConfig({ PreToolUse: [{ command: 'deny-hook' }] }),
    hooksRunner: async (_cmd, { input }) => {
      seen.push(input);
      return hookReply({ decision: 'deny', message: '测试拦截' });
    }
  });
  const r = await tools.read_file({ path: file });
  assert.equal(r.deniedBy, 'hook');
  assert.match(r.error, /被 hook 拦截：测试拦截/);
  assert.equal(r.content, undefined, 'deny 后不应返回文件内容');
  assert.equal(seen[0].event, 'PreToolUse');
  assert.equal(seen[0].tool, 'read_file');
  assert.equal(seen[0].sessionId, 's-deny');
  assert.equal(seen[0].cwd, dir);
});

test('agent-tools: PreToolUse 返回 args 时按合并后的参数执行', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-hook-args-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'original.txt');
  const rewritten = path.join(dir, 'rewritten.txt');
  await writeFile(original, 'original-content');
  await writeFile(rewritten, 'rewritten-content');
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    policy: createPolicy({ projectPath: dir }),
    projectPath: dir,
    hooksConfig: hookConfig({ PreToolUse: [{ command: 'rewrite-hook' }] }),
    hooksRunner: async () => hookReply({ args: { path: rewritten, limit: 5000 } })
  });
  const r = await tools.read_file({ path: original });
  assert.equal(r.path, rewritten);
  assert.match(r.content, /rewritten-content/);
});

test('agent-tools: PreToolUse ask 对无审批通道的工具明确报错', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-hook-ask-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'x');
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    policy: createPolicy({ projectPath: dir }),
    projectPath: dir,
    hooksConfig: hookConfig({ PreToolUse: [{ command: 'ask-hook' }] }),
    hooksRunner: async () => hookReply({ decision: 'ask', message: '要不要读？' })
  });
  const r = await tools.read_file({ path: file });
  assert.equal(r.deniedBy, 'hook');
  assert.match(r.error, /hook 要求人工确认，但当前工具无审批通道/);
});

test('agent-tools: PreToolUse ask 批准后只弹一次审批条（grant 一次性免审）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-hook-ask-grant-'));
  t.after(async () => {
    permissions.resetLedger();
    await rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'const v = 1;\n', 'utf8');
  permissions.resetLedger();
  const emitted = [];
  permissions.setApprovalEmitter((p) => emitted.push(p));
  const tools = createAgentTools({
    repoRoot,
    permissions,
    policy: createPolicy({ projectPath: dir }),
    projectPath: dir,
    sessionId: 's-ask-grant',
    hooksConfig: hookConfig({ PreToolUse: [{ command: 'ask-hook' }] }),
    hooksRunner: async () => hookReply({ decision: 'ask', message: '要改文件吗？' })
  });
  const pending = tools.edit_file({ path: file, old_string: 'const v = 1;', new_string: 'const v = 2;' });
  await waitFor(() => emitted.length === 1);
  assert.equal(emitted[0].tool, 'edit_file');
  assert.match(emitted[0].summary, /Hook 要求确认/);
  assert.equal(permissions.decide(emitted[0].callId, 'allowed-once'), true);
  const r = await pending;
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.equal(emitted.length, 1, '内部 requestApproval 不应再弹第二次审批条');
  assert.match(await readFile(file, 'utf8'), /const v = 2;/);
});

test('agent-tools: PostToolUse 钩子失败 fail-open，不影响工具结果', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-hook-post-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    policy: createPolicy({ projectPath: dir }),
    projectPath: dir,
    hooksConfig: hookConfig({ PostToolUse: [{ command: 'broken-hook' }] }),
    hooksRunner: async () => ({ code: 1, stdout: '', stderr: 'hook crashed' })
  });
  const r = await tools.run_command({ command: 'echo post-hook-ok' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /post-hook-ok/);
});

test('agent-tools: 工具失败时触发 PostToolUseFailure（失败事件也 fail-open）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-hook-fail-'));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'fc-hook-fail-out-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });
  const outside = path.join(outsideDir, 'x.txt');
  await writeFile(outside, 'x');
  const events = [];
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    policy: createPolicy({ projectPath: dir }),
    projectPath: dir,
    hooksConfig: hookConfig({
      PostToolUse: [{ command: 'post-hook' }],
      PostToolUseFailure: [{ command: 'failure-hook' }]
    }),
    hooksRunner: async (_cmd, { input }) => {
      events.push(input.event);
      return hookReply({ message: 'logged' });
    }
  });
  const r = await tools.read_file({ path: outside });
  assert.equal(r.deniedBy, 'policy', '策略拒绝结果保持不变');
  assert.ok(events.includes('PostToolUseFailure'), '失败事件应被触发');
  assert.ok(!events.includes('PostToolUse'), '失败时不应触发成功事件');
});

test('agent-tools: quality_gate 没配置时拒绝，有配置时审批后按声明执行', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-qgate-'));
  try {
    const tools = createAgentTools({ repoRoot, permissions: fakePermissions(), projectPath: dir });
    const miss = await tools.quality_gate({ dir });
    assert.match(miss.error, /finalcheck\.quality\.json/);

    await writeFile(path.join(dir, 'finalcheck.quality.json'), JSON.stringify({
      checks: [{ id: 'ok', command: 'node -e "process.exit(0)"', maxMs: 60000 }]
    }), 'utf8');
    const ok = await tools.quality_gate({ dir });
    assert.equal(ok.findings.length, 0);
    assert.equal(ok.coverageGap, null);

    const denied = createAgentTools({ repoRoot, permissions: fakePermissions({ allow: false }), projectPath: dir });
    const no = await denied.quality_gate({ dir });
    assert.match(no.error, /拒绝/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run_workflow 透传 script 模式：不强制 steps=[]，steps 模式仍可用', async () => {
  const calls = [];
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    runWorkflow: async (payload) => { calls.push(payload); return { results: [] }; }
  });

  const script = [{ op: 'gate', id: 'g1', tool: 'audit_project', args: { dir: '.' } }];
  const r1 = await tools.run_workflow({ goal: 'g', script });
  assert.ok(r1);
  assert.equal(calls[0].script.length, 1);
  assert.equal(calls[0].steps, undefined, 'script 模式不得给 steps 兜底成 []');

  // 模型把 script 传成 JSON 字符串也要能解析
  await tools.run_workflow({ goal: 'g', script: JSON.stringify(script) });
  assert.equal(calls[1].script.length, 1);

  // steps 模式不受影响
  await tools.run_workflow({ goal: 'g', steps: [{ id: 'a', prompt: 'x' }] });
  assert.equal(calls[2].steps.length, 1);
  assert.equal(calls[2].script, undefined);
});

test('run_workflow 空参：返回可执行的自纠错提示，不调用引擎', async () => {
  let calls = 0;
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    runWorkflow: async () => { calls += 1; return { results: [] }; }
  });

  const r = await tools.run_workflow({ goal: 'g' });
  assert.match(r.error, /先判断任务形状/);
  assert.match(r.error, /不要问用户用哪种/);

  // steps: [] + script: [] 同样视为「都没给」，不能落到「steps 不能为空」
  const r2 = await tools.run_workflow({ goal: 'g', steps: [], script: [] });
  assert.match(r2.error, /先判断任务形状/);
  assert.equal(calls, 0, '空参不在引擎里猜语义，直接要求模型重选表示');
});
