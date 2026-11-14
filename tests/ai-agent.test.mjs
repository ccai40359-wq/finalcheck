// A1-A4（AI Agent 检查面）：证据判定 / 误报防线 / fail-closed 缺口 / 引擎接线。
// 测试风格照 py-integration：runner 无依赖、临时 fixture、敏感串运行时拼接防自咬。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { checkAiToolPerms, checkAiPromptInjection, checkAiSandbox, checkAiDataBoundary } from '../src/checks/ai-agent.mjs';
import { applyScopePolicy } from '../src/scope-policy.mjs';
import { audit } from '../src/audit.mjs';

async function fixture(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-ai-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}
const cleanup = (t, dir) => t.after(() => rm(dir, { recursive: true, force: true }));

// 零依赖 lockfile：S4 离线且干净（照 profile.test 的口径），审计测试不被 npm audit 卡住。
const EMPTY_LOCK = JSON.stringify({ name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': {} } }, null, 2);
const PKG_NO_DEPS = JSON.stringify({ name: 'probe', version: '1.0.0', private: true, scripts: { start: 'node server.js' } }, null, 2);

/* ---------- A1 tool 权限 ---------- */

test('A1 正例：入库配置 bypass/通配 = hard card；代码级解释器白名单 = card（可降级）', async (t) => {
  const dir = await fixture({
    '.claude/settings.json': JSON.stringify({ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(*)', 'Bash(git status:*)'] } }),
    'agent.js': [
      'const tools = buildTools({',
      "  allowed: ['node -e', 'git status'],",
      '});',
    ].join('\n'),
  });
  cleanup(t, dir);
  const r = await checkAiToolPerms(dir, { tier: 'L2' });
  const byRule = Object.groupBy(r.findings, (f) => f.rule);
  const bypass = (byRule['A1.bypass-mode'] || [])[0];
  assert.ok(bypass, 'defaultMode bypassPermissions 必须报');
  assert.equal(bypass.hard, true, '入库配置硬卡');
  assert.equal(bypass.severity, 'high');
  const wild = (byRule['A1.permissive-allow'] || []).filter((f) => f.file === '.claude/settings.json');
  assert.ok(wild.length >= 1, 'allow 含 Bash(*) 必须报');
  assert.equal(wild.every((f) => f.hard === true), true, '配置文件里的通配授权也是 hard');
  const code = (byRule['A1.permissive-allow'] || []).find((f) => f.file === 'agent.js');
  assert.ok(code, "代码里 allowed: ['node -e'] 必须报");
  assert.equal(code.hard, false, '代码级形状不是 hard（可被范围策略降级）');
  assert.ok(!r.findings.some((f) => f.snippet.includes('git status')), '只读命令白名单不报');
  assert.equal(r.coverageGap, null);
});

test('A1 反例：只读白名单 + 默认审批模式 → 零发现', async (t) => {
  const dir = await fixture({
    '.claude/settings.json': JSON.stringify({ permissions: { defaultMode: 'default', allow: ['Bash(git status:*)', 'Bash(npm test:*)'] } }),
    'agent.js': "const tools = buildTools({ allowed: ['git status', 'ls', 'pwd'] });\n",
  });
  cleanup(t, dir);
  const r = await checkAiToolPerms(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, [], '只读枚举与 default 模式都不报');
});

test('A1 降级：非产品路径上的 check 级发现被 scope-policy 降为 tip；hard 配置卡永不降', async (t) => {
  const dir = await fixture({
    'examples/demo/package.json': JSON.stringify({ scripts: { probe: 'node tool.js --yolo' } }),
    '.claude/settings.json': JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }),
  });
  cleanup(t, dir);
  const r = await checkAiToolPerms(dir, { tier: 'L2' });
  const scoped = applyScopePolicy(r.findings);
  const flag = scoped.findings.find((f) => f.rule === 'A1.bypass-flag');
  assert.ok(flag, 'examples 里的 bypass 开关仍被检出');
  assert.equal(flag.force, 'tip', '非产品路径降为提示');
  assert.match(flag.message, /非产品路径/);
  const hard = scoped.findings.find((f) => f.rule === 'A1.bypass-mode');
  assert.equal(hard.force, 'card', '入库配置 hard 卡不被范围策略降级');
});

/* ---------- A2 提示注入面 ---------- */

test('A2 正例：外部内容同函数窗口拼进 prompt 字段 → card', async (t) => {
  const dir = await fixture({
    'summarizer.js': [
      "import OpenAI from 'openai';",
      'const client = new OpenAI(process.env.OPENAI_API_KEY);',
      "app.post('/sum', async (req, res) => {",
      '  const page = await fetch(req.query.url);',
      '  const html = await page.text();',
      '  const answer = await client.chat.completions.create({',
      "    model: 'gpt-4',",
      '    messages: [{ role: \'user\', content: `Summarize: ${html}` }],',
      '  });',
      '  res.json(answer);',
      '});',
    ].join('\n'),
    'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
  });
  cleanup(t, dir);
  const r = await checkAiPromptInjection(dir, { tier: 'L2' });
  const hit = r.findings.find((f) => f.rule === 'A2.prompt-external');
  assert.ok(hit, '外部内容未隔离拼进 messages 必须报');
  assert.equal(hit.force, 'card');
  assert.equal(hit.severity, 'high');
  assert.equal(r.coverageGap, null);
});

test('A2 反例：静态 prompt / 无外部源 → 零发现（但保持已执行）', async (t) => {
  const dir = await fixture({
    'static.js': [
      "import OpenAI from 'openai';",
      'const client = new OpenAI(process.env.OPENAI_API_KEY);',
      'const answer = await client.chat.completions.create({',
      '  messages: [{ role: \'user\', content: \'You are a helpful assistant\' }],',
      '});',
    ].join('\n'),
    'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
  });
  cleanup(t, dir);
  const r = await checkAiPromptInjection(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, []);
  assert.equal(r.coverageGap, null, '有 SDK 依赖且扫描正常 → 已执行，不许 N/A');
});

test('A2 消毒降级：链上有 truncate/sanitize 形状 → check + 需人工确认', async (t) => {
  const dir = await fixture({
    'safe.js': [
      "import OpenAI from 'openai';",
      'const client = new OpenAI(process.env.OPENAI_API_KEY);',
      'async function ask(url) {',
      '  const page = await fetch(url);',
      '  const html = await page.text();',
      '  const safe = html.slice(0, 500);',
      '  return client.chat.completions.create({',
      '    messages: [{ role: \'user\', content: `Summarize: ${safe}` }],',
      '  });',
      '}',
    ].join('\n'),
    'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
  });
  cleanup(t, dir);
  const r = await checkAiPromptInjection(dir, { tier: 'L2' });
  const hit = r.findings.find((f) => f.rule === 'A2.prompt-external-sanitized');
  assert.ok(hit, '链上有 slice 消毒形状 → 降 check');
  assert.equal(hit.force, 'check');
  assert.match(hit.message, /需人工确认/);
});

/* ---------- A3 沙箱/逃逸面 ---------- */

test('A3 正例/反例：shell 执行模型命令 = card；字面量命令带限额不报；变量命令无限额 = check', async (t) => {
  const dir = await fixture({
    'runner.js': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'async function run() {',
      '  const result = await openai.chat.completions.create({ messages, tools });',
      '  const cmd = result.choices[0].message.tool_calls[0].function.arguments;',
      '  exec(`sh -c ${cmd}`);',
      '}',
      'async function safe() {',
      "  await spawn('git', ['status'], { timeout: 30000, maxBuffer: 1024 * 1024 });",
      '  const proc = spawn(commandVar);',
      '  return proc;',
      '}',
    ].join('\n'),
    'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
  });
  cleanup(t, dir);
  const r = await checkAiSandbox(dir, { tier: 'L2' });
  const card = r.findings.find((f) => f.rule === 'A3.shell-llm-cmd');
  assert.ok(card, 'shell 解释器执行模型生成的命令串必须报');
  assert.equal(card.force, 'card');
  const bounded = r.findings.find((f) => f.file === 'runner.js' && /spawn\('git'/.test(f.snippet));
  assert.ok(!bounded, '字面量命令 + timeout/maxBuffer 不报');
  const unbounded = r.findings.find((f) => f.rule === 'A3.unbounded-spawn');
  assert.ok(unbounded, '变量命令且无限额 → check');
  assert.equal(unbounded.force, 'check');
});

/* ---------- A4 数据边界 ---------- */

test('A4 正例：env 密钥进 prompt + 完整对话落盘 = card；调试日志 = check；snippet 不回显密钥值', async (t) => {
  const SECRET = 'sk_live_' + '9f2Kq8LmN3pR7sT1';
  const dir = await fixture({
    'chat.js': [
      'async function ask(task) {',
      `  const system = 'Key: ' + process.env.OPENAI_API_KEY + ' Literal: ' + '${SECRET}' + ' Task: ' + task;`,
      '  const reply = await openai.chat.completions.create({',
      '    messages: [{ role: \'user\', content: system }],',
      '  });',
      "  await fs.writeFile('transcripts.json', JSON.stringify(messages));",
      "  console.log('debug prompt:', userPrompt);",
      '  return reply;',
      '}',
    ].join('\n'),
    'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
  });
  cleanup(t, dir);
  const r = await checkAiDataBoundary(dir, { tier: 'L2' });
  const secret = r.findings.find((f) => f.rule === 'A4.secret-in-prompt');
  assert.ok(secret, 'env 密钥拼进 prompt 字段必须报');
  assert.equal(secret.force, 'card');
  assert.equal(secret.hard, false, 'A4 不进 L1 硬卡（密钥入库面归 S3）');
  assert.ok(!JSON.stringify(r.findings).includes(SECRET), '报告绝不回显密钥值');
  const log = r.findings.find((f) => f.rule === 'A4.conversation-log');
  assert.ok(log, '完整对话写 transcripts.json 必须报');
  const dbg = r.findings.find((f) => f.rule === 'A4.debug-log');
  assert.ok(dbg && dbg.force === 'check', '调试日志打印 prompt 是 check 级');
});

/* ---------- fail-closed 缺口 ---------- */

test('缺口：干净无 AI 痕迹 → 四项全 N/A；audit() notApplicable 点名且不封顶', async (t) => {
  const dir = await fixture({
    'package.json': PKG_NO_DEPS,
    'package-lock.json': EMPTY_LOCK,
    'app.js': "const app = express();\napp.get('/', (req, res) => res.send('ok'));\n",
  });
  cleanup(t, dir);
  for (const [i, fn] of [checkAiToolPerms, checkAiPromptInjection, checkAiSandbox, checkAiDataBoundary].entries()) {
    const r = await fn(dir, { tier: 'L2' });
    assert.equal(r.gapKind, 'not-applicable', `检查 ${i + 1} 必须声明 N/A`);
    assert.match(r.coverageGap, /均已查|未发现/);
  }
  const res = await audit(dir, { tier: 'L2', interactive: true });
  for (const id of ['A1', 'A2', 'A3', 'A4']) {
    assert.ok(res.notApplicable.some((g) => g.checkId === id), `${id} 必须进 notApplicable 点名`);
    assert.ok(res.gates.planned.includes(id), `${id} 必须在计划里`);
  }
});

test('缺口：有 SDK 依赖但无 JS 可解析 → A2-A4 unavailable；A1 仍执行并声明口径', async (t) => {
  const dir = await fixture({
    'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
    'README.md': '# only docs\n',
  });
  cleanup(t, dir);
  const a2 = await checkAiPromptInjection(dir, { tier: 'L2' });
  assert.equal(a2.gapKind, 'unavailable');
  assert.match(a2.coverageGap, /openai/);
  assert.match(a2.coverageGap, /未采到/);
  const a1 = await checkAiToolPerms(dir, { tier: 'L2' });
  assert.equal(a1.coverageGap, null, 'A1 语言无关：配置/脚本面照扫');
  assert.ok(a1.warnings.some((w) => /LLM SDK 依赖/.test(w)), 'A1 零命中也要声明扫描口径');
});

test('缺口：纯 Python 仓 → A2-A4 记语言缺口 unavailable，A1 不受影响', async (t) => {
  const dir = await fixture({
    'main.py': 'print("hi")\n',
  });
  cleanup(t, dir);
  const res = await audit(dir, { tier: 'L2', interactive: true });
  for (const id of ['A2', 'A3', 'A4']) {
    const gap = res.gates.gapItems.find((g) => g.checkId === id);
    assert.ok(gap, `${id} 必须有缺口条目`);
    assert.equal(gap.kind, 'unavailable', `${id} 纯 py 仓记 unavailable`);
  }
  const a1 = res.gates.gapItems.find((g) => g.checkId === 'A1');
  assert.ok(!a1 || a1.kind === 'not-applicable', 'A1 语言无关，最多 N/A 不封顶');
});

/* ---------- 引擎接线 ---------- */

test('接线：L2 计划含 A1-A4 且 executed 登记；A1 hard 卡在 L1 判「拦」', async (t) => {
  const dir = await fixture({
    'package.json': PKG_NO_DEPS,
    'package-lock.json': EMPTY_LOCK,
    'app.js': "const app = express();\napp.get('/', (req, res) => res.send('ok'));\n",
    '.claude/settings.json': JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }),
  });
  cleanup(t, dir);
  const l1 = await audit(dir, { tier: 'L1', interactive: true });
  assert.equal(l1.conclusion.verdict, '拦', 'A1 hard 是 L1 底线硬卡');
  assert.match(l1.conclusion.reason, /A1/);
  assert.ok(l1.gates.executed.includes('A1'), 'A1 在 L1 已执行');

  const l2 = await audit(dir, { tier: 'L2', interactive: true });
  for (const id of ['A1', 'A2', 'A3', 'A4']) {
    assert.ok(l2.gates.planned.includes(id), `${id} 进 L2 计划`);
    const executed = l2.gates.executed.includes(id);
    const na = l2.notApplicable.some((g) => g.checkId === id);
    assert.ok(executed || na, `${id} 要么已执行、要么如实点名 N/A（fail-closed）`);
  }
  const high = l2.findings.find((f) => f.checkId === 'A1' && f.rule === 'A1.bypass-mode');
  assert.ok(high, 'L2 下 bypass 配置仍是 card');
});
