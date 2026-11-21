import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import server from './fixtures/dynamic-target/app.mjs';
import { createAgentTools, resolveRipgrepPath, GREP_CODE_SCHEMA, TODO_CC_RULES_TEXT } from '../desktop/src/main/agent-tools.mjs';
import { createTodoRegistry } from '../desktop/src/main/todo-list.mjs';
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

test('agent-tools: list_playbooks 返回 52 类摘要（内置 50 + 用户级 computer-use/browser-use）', async () => {
  // 隔离本机 ~/.agents/skills（互通文件夹并入后计数受真机环境影响）：钉的行为只来自 desktop/skills
  process.env.FINALCHECK_COMMON_SKILLS_DIR = path.join(os.tmpdir(), 'fc-test-no-common-' + Date.now());
  const { clearSkillsCache } = await import('../src/playbooks.mjs');
  clearSkillsCache();
  try {
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const r = await tools.list_playbooks({});
  assert.equal(r.total, 52);
  assert.equal(r.categories.length, 52);
  const ssrf = r.categories.find((c) => c.id === '11');
  assert.equal(ssrf.name, 'ssrf');
  assert.ok(ssrf.triggers.includes('URL'));
  assert.ok(ssrf.fileCount >= 2);
  // 用户级技能（desktop/skills）也在注册表里，可按 slug 读取
  const cu = r.categories.find((c) => c.name === 'computer-use');
  assert.ok(cu, 'computer-use 应在 list_playbooks 目录里');
  assert.equal(cu.id, 'computer-use');
  assert.equal(cu.entry, 'SKILL.md');
  } finally {
    delete process.env.FINALCHECK_COMMON_SKILLS_DIR;
    clearSkillsCache();
  }
});

test('agent-tools: read_playbook 能读到用户级 computer-use 技能正文', async () => {
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const r = await tools.read_playbook({ topic: 'computer-use' });
  assert.ok(!r.error, `computer-use 应可读（实际：${r.error || 'ok'}）`);
  assert.match(r.content, /computer_request_access/, '正文要包含授权规程');
  assert.match(r.content, /screenshot_id/, '正文要包含截图 id 规程');
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

test('agent-tools: run_command 复合命令不会被单段前缀授权免审', async () => {
  const approvals = [];
  const perms = {
    ...fakePermissions(),
    // 「本会话允许 git status」只覆盖这一条单段命令
    sessionAllowed: (tool, pattern) => pattern === 'git status',
    approvalPatternFor: (cmd) => {
      const text = String(cmd || '').trim().replace(/\s+/g, ' ');
      return text.split(/\|\||&&|\||;|&|\r?\n/).map((s) => s.trim()).filter(Boolean).length > 1
        ? text
        : text.split(/\s+/).filter(Boolean).slice(0, 2).join(' ').toLowerCase();
    },
    requestApproval: async (p) => { approvals.push(p); return 'allowed-once'; }
  };
  const tools = createAgentTools({ repoRoot, permissions: perms });
  const r = await tools.run_command({ command: 'echo first && echo second' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /second/);
  assert.equal(approvals.length, 1, '复合命令必须重新过审批，不能命中旧前缀授权');
  assert.match(String(approvals[0].target), /echo first.*echo second/, '审批参数模式保留整条命令');
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
  assert.match(out.error, /被策略闸拒绝/);
  assert.equal(out.deniedBy, 'policy');
  assert.match(out.reason, /项目边界/);

  const insideRead = await tools.read_file({ path: inside });
  assert.match(insideRead.content, /inside-content/);
  assert.equal(insideRead.path, realpathSync.native(inside), '路径经策略规范化后交给 fs-tools');

  const readonly = createPolicy({ projectPath: dir, mode: 'readonly' });
  const roTools = createAgentTools({ repoRoot, permissions: fakePermissions(), policy: readonly, projectPath: dir });
  const roEdit = await roTools.edit_file({ path: inside, old_string: 'inside-content', new_string: 'changed' });
  assert.equal(roEdit.deniedBy, 'policy');
  assert.match(roEdit.reason, /只读模式禁止写入/);
  const roWrite = await roTools.write_file({ path: path.join(dir, 'new.txt'), content: 'x' });
  assert.equal(roWrite.deniedBy, 'policy');
  assert.match(await readFile(inside, 'utf8'), /inside-content/, '只读模式不应改到磁盘');

  const deniedCmd = await tools.run_command({ command: 'shutdown /s /t 0' });
  assert.match(deniedCmd.error, /被策略闸拒绝/);
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
  assert.equal(r.path, realpathSync.native(rewritten));
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

  // 0.26：统一成 nodes 一种写法——空参时告诉模型怎么画图，而不是让它在 steps / script 里二选一
  const r = await tools.run_workflow({ goal: 'g' });
  assert.match(r.error, /没有给 nodes/);
  assert.ok(r.error.includes('depends_on: []'), '提示里要给出空 depends_on 的写法');

  // nodes: [] / steps: [] + script: [] 同样视为「都没给」，不能落到「steps 不能为空」
  const r2 = await tools.run_workflow({ goal: 'g', nodes: [], steps: [], script: [] });
  assert.match(r2.error, /没有给 nodes/);
  assert.equal(calls, 0, '空参不在引擎里猜语义，直接要求模型重选表示');
});

/* ---------- grep_code：专用代码搜索（rg 优先 → findstr 回退） ---------- */

test('agent-tools: resolveRipgrepPath 检测顺序（env 覆盖 → vendor/rg 捆绑 → PATH → null）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-rg-detect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envBackup = process.env.FINALCHECK_RG_PATH;
  const pathBackup = process.env.PATH;
  try {
    // 1) FINALCHECK_RG_PATH 显式覆盖最优先
    const marker = path.join(dir, 'rg-from-env.exe');
    await writeFile(marker, 'fake');
    process.env.FINALCHECK_RG_PATH = marker;
    assert.equal(resolveRipgrepPath({ repoRoot: dir }), path.resolve(marker));

    // 2) 没有 env 时认开发态捆绑 vendor/rg/rg.exe（打包态走 process.resourcesPath/rg，单测环境无 resourcesPath）
    delete process.env.FINALCHECK_RG_PATH;
    const vendored = path.join(dir, 'vendor', 'rg', 'rg.exe');
    await mkdir(path.dirname(vendored), { recursive: true });
    await writeFile(vendored, 'fake');
    assert.equal(resolveRipgrepPath({ repoRoot: dir }), vendored);

    // 3) 全都找不到 → null（grep_code 自动回退 findstr，不报错）
    await rm(path.join(dir, 'vendor'), { recursive: true, force: true });
    process.env.PATH = '';
    assert.equal(resolveRipgrepPath({ repoRoot: dir }), null);
  } finally {
    if (envBackup === undefined) delete process.env.FINALCHECK_RG_PATH;
    else process.env.FINALCHECK_RG_PATH = envBackup;
    if (pathBackup === undefined) delete process.env.PATH;
    else process.env.PATH = pathBackup;
  }
});

test('agent-tools: grep_code 结构化搜索 + glob 过滤 + maxResults 截断', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-grep-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  await writeFile(path.join(dir, 'a.js'), 'const needle = 1;\nother(needle);\n', 'utf8');
  await writeFile(path.join(dir, 'sub', 'b.js'), '// needle here\nrun(needle);\n', 'utf8');
  await writeFile(path.join(dir, 'c.txt'), 'needle in txt\n', 'utf8');

  const tools = createAgentTools({ repoRoot: dir, permissions: fakePermissions() });
  const r = await tools.grep_code({ pattern: 'needle', path: dir });
  assert.ok(['ripgrep', 'findstr (literal-only)'].includes(r.engine));
  assert.equal(r.total, 5);
  assert.equal(r.results.length, 5);
  for (const row of r.results) {
    assert.equal(typeof row.line, 'number');
    assert.ok(row.line >= 1);
    assert.match(row.text, /needle/);
    assert.ok(path.isAbsolute(row.file), 'file 必须是绝对路径');
  }
  assert.deepEqual(r.results.map((x) => path.basename(x.file)).sort(), ['a.js', 'a.js', 'b.js', 'b.js', 'c.txt']);

  // glob 过滤：*.js 排除 c.txt（rg -g 与 findstr 的文件 spec 都按任意深度匹配）
  const g = await tools.grep_code({ pattern: 'needle', path: dir, glob: '*.js' });
  assert.equal(g.total, 4);
  assert.ok(g.results.every((x) => x.file.endsWith('.js')));

  // maxResults 截断：total 仍是收集到的总数，results 只留前 N 条并提示缩小范围
  const tr = await tools.grep_code({ pattern: 'needle', path: dir, maxResults: 2 });
  assert.equal(tr.results.length, 2);
  assert.equal(tr.total, 5);
  assert.equal(tr.truncated, true);
  assert.match(tr.note, /缩小 path 范围/);

  // 不传 path 默认搜 repoRoot
  const dflt = await tools.grep_code({ pattern: 'needle' });
  assert.equal(dflt.total, 5);

  // 缺 pattern 给出可自纠的报错
  const miss = await tools.grep_code({});
  assert.match(miss.error, /pattern 必填/);
});

test('agent-tools: grep_code rg 启动失败时自动回退 findstr（literal-only，不报错）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-grep-fb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a.js'), 'hello world\nconst hel = 1;\n', 'utf8');
  // 坏二进制：检测得到但启动失败 → 必须静默回退 findstr
  const fakeRg = path.join(dir, 'rg.exe');
  await writeFile(fakeRg, 'this is not a real executable', 'utf8');

  const envBackup = process.env.FINALCHECK_RG_PATH;
  process.env.FINALCHECK_RG_PATH = fakeRg;
  try {
    const tools = createAgentTools({ repoRoot: dir, permissions: fakePermissions() });
    const r = await tools.grep_code({ pattern: 'hello', path: dir });
    assert.equal(r.engine, 'findstr (literal-only)');
    assert.equal(r.total, 1);
    assert.match(r.results[0].text, /hello world/);
    assert.match(r.note, /literal-only/);

    // findstr 走 /L 字面量：正则语法不生效（hel.o 不匹配 hello）
    const lit = await tools.grep_code({ pattern: 'hel.o', path: dir });
    assert.equal(lit.engine, 'findstr (literal-only)');
    assert.equal(lit.total, 0);
  } finally {
    if (envBackup === undefined) delete process.env.FINALCHECK_RG_PATH;
    else process.env.FINALCHECK_RG_PATH = envBackup;
  }
});

test('agent-tools: grep_code 与 read_file 同一道路径闸（项目外拒绝）', async (t) => {
  const inside = await mkdtemp(path.join(os.tmpdir(), 'fc-grep-in-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'fc-grep-out-'));
  t.after(async () => {
    await rm(inside, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(path.join(inside, 'i.js'), 'const needle = 1;\n', 'utf8');
  await writeFile(path.join(outside, 'o.js'), 'const needle = 2;\n', 'utf8');
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    policy: createPolicy({ projectPath: inside }),
    projectPath: inside
  });
  const denied = await tools.grep_code({ pattern: 'needle', path: outside });
  assert.equal(denied.deniedBy, 'policy');
  assert.match(denied.reason, /项目边界/);

  const ok = await tools.grep_code({ pattern: 'needle', path: inside });
  assert.equal(ok.total, 1);
  assert.equal(ok.results[0].file, realpathSync.native(path.join(inside, 'i.js')));
});

/* ---------- todo_write：CC 式规则（同一时间恰好一个 in_progress） ---------- */

test('agent-tools: todo_write CC 规则①——多个 running 自动降回 pending 并提示', async () => {
  const todos = createTodoRegistry();
  const sessionId = 's-cc';
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    todoWrite: (args) => todos.write(sessionId, args)
  });
  const mk = (id, status, extra = {}) => ({ id, task: `任务 ${id}`, acceptance: `${id} 的验收标准`, status, ...extra });

  // 提交 3 个 running：只保留第一个，其余自动降级并在返回里提示
  const r = await tools.todo_write({ items: [mk('s1', 'running'), mk('s2', 'running'), mk('s3', 'pending'), mk('s4', 'running')] });
  assert.equal(r.ok, true);
  const statusOf = (id) => r.items.find((x) => x.id === id)?.status;
  assert.equal(statusOf('s1'), 'running', '第一个 running 保留');
  assert.equal(statusOf('s2'), 'pending', '第二个 running 降回 pending');
  assert.equal(statusOf('s4'), 'pending', '后续 running 降回 pending');
  assert.equal(r.progress.running, 1);
  assert.match(r.note, /同一时间只保留一个进行中/);
  assert.match(r.note, /s2/);
  assert.match(r.note, /s4/);
  // 台账（报告闸读的那份）与返回一致：恰好一个 running
  assert.equal(todos.list(sessionId).filter((x) => x.status === 'running').length, 1);

  // 只有一个 running：不降级、无提示
  const r2 = await tools.todo_write({
    items: [mk('s1', 'done', { evidence: 'a.js:1' }), mk('s2', 'done'), mk('s3', 'done'), mk('s4', 'running')]
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.note, undefined);
  assert.equal(r2.progress.running, 1);

  // 既有 evidence 合并语义不受 CC 规则影响：只改状态不重发 evidence，旧证据保留
  const r3 = await tools.todo_write({ items: [mk('s1', 'done'), mk('s2', 'done'), mk('s3', 'done'), mk('s4', 'done')] });
  assert.equal(r3.items.find((x) => x.id === 's1')?.evidence, 'a.js:1');

  // acceptance 必填语义不被破坏：缺 acceptance 仍然报错拒绝
  const bad = await tools.todo_write({
    items: [{ id: 'x1', task: '任务 x1', status: 'running' }, mk('x2', 'pending'), mk('x3', 'pending')]
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /acceptance/);
});

test('agent-tools: grep_code / todo CC 规则的 schema 待并轨导出', () => {
  assert.equal(GREP_CODE_SCHEMA.type, 'function');
  assert.equal(GREP_CODE_SCHEMA.function.name, 'grep_code');
  assert.deepEqual(GREP_CODE_SCHEMA.function.parameters.required, ['pattern']);
  assert.ok(GREP_CODE_SCHEMA.function.parameters.properties.glob);
  assert.match(GREP_CODE_SCHEMA.function.description, /ripgrep/);
  assert.match(GREP_CODE_SCHEMA.function.description, /findstr/);
  assert.match(GREP_CODE_SCHEMA.function.description, /正斜杠/);
  assert.match(TODO_CC_RULES_TEXT, /恰好一个 in_progress/);
  assert.match(TODO_CC_RULES_TEXT, /禁止标 done/);
  assert.match(TODO_CC_RULES_TEXT, /不要攒批/);
});
