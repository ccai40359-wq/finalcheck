// 0.33.1 对齐 Claude Code 的第二批：glob_files / list_dir、web_fetch / web_search、计划模式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { globFiles, listDir, globToRegExp } from '../desktop/src/main/fs-find.mjs';
import {
  isPrivateAddress, checkUrlTarget, htmlToText, webFetch, webSearch,
  parseBingHtml, parseDuckHtml, unwrapBingUrl, searchOrder
} from '../desktop/src/main/web-tools.mjs';
import { createAgentTools, PLAN_MODE_TOOLS } from '../desktop/src/main/agent-tools.mjs';
import { AGENT_TOOLS_SCHEMA, SUBAGENT_TOOLS_SCHEMA } from '../desktop/src/main/agent-service.mjs';
import { createAskUserRegistry } from '../desktop/src/main/ask-user.mjs';
import { evaluateRules, parseRules } from '../desktop/src/main/permission-rules.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// ---------------- 文件查找 ----------------
test('glob：** 跨目录、* 不跨目录、无 / 的模式任意深度、{a,b}；跳过 node_modules；按修改时间新→旧', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-glob-'));
  try {
    await mkdir(path.join(dir, 'src', 'a'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    const files = { 'README.md': 1, 'src/a/old.ts': 2, 'src/a/new.ts': 3, 'src/top.ts': 4, 'src/a/b.json': 5, 'node_modules/x/i.ts': 6, 'package.json': 7 };
    let tsec = 1_700_000_000;
    for (const [f, n] of Object.entries(files)) {
      await writeFile(path.join(dir, f), 'x');
      const when = f === 'src/a/new.ts' ? tsec + 1000 : tsec + n;
      await utimes(path.join(dir, f), when, when);
    }
    const rel = (r) => r.files.map((f) => path.relative(dir, f).replace(/\\/g, '/'));
    const ts = await globFiles({ root: dir, pattern: '**/*.ts' });
    assert.deepEqual(rel(ts), ['src/a/new.ts', 'src/top.ts', 'src/a/old.ts'], '新→旧，且不含 node_modules');
    assert.deepEqual(rel(await globFiles({ root: dir, pattern: 'src/*.ts' })), ['src/top.ts'], '* 不跨目录');
    assert.deepEqual(rel(await globFiles({ root: dir, pattern: '*.md' })), ['README.md']);
    assert.deepEqual(rel(await globFiles({ root: dir, pattern: '**/*.{json,md}' })).sort(), ['README.md', 'package.json', 'src/a/b.json']);
    const capped = await globFiles({ root: dir, pattern: '**/*', max: 2 });
    assert.equal(capped.files.length, 2);
    assert.equal(capped.truncated, true);
    assert.ok((await globFiles({ root: dir, pattern: '' })).error);

    const ls = await listDir({ dir });
    assert.deepEqual(ls.entries.slice(0, 2), ['node_modules/  (通常不用看)', 'src/'], '目录在前');
    assert.ok(ls.entries.some((e) => /^README\.md {2}1B$/.test(e)), '文件带大小');
    assert.ok((await listDir({ dir: path.join(dir, 'nope') })).error.includes('不存在'));
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.ok(globToRegExp('a/**/b.js').test('a/b.js') && globToRegExp('a/**/b.js').test('a/x/y/b.js'));
});

test('工具层：glob_files / list_dir 默认在项目根（不是应用源码目录），子代理和只读子代理都能用', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-glob2-'));
  try {
    await writeFile(path.join(dir, 'hello.txt'), 'x');
    const tools = createAgentTools({ repoRoot: root, projectPath: dir, permissions: {} });
    const g = await tools.glob_files({ pattern: '*.txt' });
    assert.deepEqual(g.files, [path.join(dir, 'hello.txt')]);
    const l = await tools.list_dir({});
    assert.equal(l.path, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const names = AGENT_TOOLS_SCHEMA.map((s) => s.function.name);
  for (const n of ['glob_files', 'list_dir', 'web_fetch', 'web_search']) {
    assert.ok(names.includes(n), `主 agent 有 ${n}`);
    assert.ok(SUBAGENT_TOOLS_SCHEMA.some((s) => s.function.name === n), `工作流子代理有 ${n}`);
  }
  assert.match(read('desktop/src/main/ipc/ipc-agent.mjs'), /SPAWN_READONLY_TOOLS = \['read_file', 'grep_code', 'glob_files', 'list_dir', 'web_fetch', 'web_search'/);
  assert.ok(!names.includes('exit_plan_mode'), 'exit_plan_mode 只在计划模式回合出现');
});

// ---------------- 联网 ----------------
test('地址检查：内网 / 本机 / 链路本地 / 云元数据都拒，公网放行；确认过的主机例外', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
  const lookup = async (h) => (h === 'evil.example' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }]);
  assert.equal((await checkUrlTarget('https://example.com/', { lookup })).ok, true);
  assert.match((await checkUrlTarget('https://evil.example/', { lookup })).error, /内网/);
  assert.match((await checkUrlTarget('http://localhost:3000/', { lookup })).error, /本机/);
  assert.match((await checkUrlTarget('file:///etc/passwd', { lookup })).error, /http/);
  assert.match((await checkUrlTarget('https://u:p@example.com/', { lookup })).error, /用户名/);
  assert.equal((await checkUrlTarget('http://192.168.1.9/', { lookup, allowHost: (h) => h === '192.168.1.9' })).ok, true);
});

const resp = (status, body, headers = {}) => new Response(body, { status, headers });

test('web_fetch：HTML 转可读文本（标题 / 链接绝对化 / 列表 / 代码）、分段续读、重定向到内网被拦', async () => {
  const lookup = async (h) => (h === 'internal.example' ? [{ address: '192.168.0.10' }] : [{ address: '93.184.216.34' }]);
  const html = `<html><head><title>Doc &amp; Guide</title><script>evil()</script><style>x{}</style></head><body>
    <nav>menu</nav><main><h1>Install</h1><p>Run <code>npm i</code> then see <a href="/api">API</a>.</p>
    <ul><li>one</li><li>two</li></ul><pre><code>const a = 1 &lt; 2;</code></pre>${'<p>filler text for paging</p>'.repeat(120)}</main></body></html>`;
  const fetchImpl = async (url) => {
    if (url === 'https://docs.example/start') return resp(302, '', { location: '/guide' });
    if (url === 'https://docs.example/guide') return resp(200, html, { 'content-type': 'text/html; charset=utf-8' });
    if (url === 'https://docs.example/bounce') return resp(301, '', { location: 'http://internal.example/admin' });
    if (url === 'https://docs.example/pic') return resp(200, 'x', { 'content-type': 'image/png' });
    throw new Error('unexpected ' + url);
  };
  const r = await webFetch({ url: 'docs.example/start', fetchImpl, lookup, maxChars: 1000 });
  assert.equal(r.finalUrl, 'https://docs.example/guide');
  assert.equal(r.title, 'Doc & Guide');
  assert.match(r.content, /^# Install/m);
  assert.match(r.content, /\[API\]\(https:\/\/docs\.example\/api\)/);
  assert.match(r.content, /^- one\n- two/m);
  assert.match(r.content, /const a = 1 < 2;/);
  assert.ok(!/evil\(\)|menu/.test(r.content), '去掉脚本 / 有 main 时去掉导航');
  assert.ok(r.nextOffset > 0 && r.totalChars > 1000);
  const r2 = await webFetch({ url: 'https://docs.example/guide', fetchImpl, lookup, offset: r.nextOffset, maxChars: 1000 });
  assert.equal(r2.offset, r.nextOffset);
  assert.match((await webFetch({ url: 'https://docs.example/bounce', fetchImpl, lookup })).error, /内网/, '每一跳都重新检查');
  assert.match((await webFetch({ url: 'https://docs.example/pic', fetchImpl, lookup })).error, /image\/png/);
  assert.match(htmlToText('<p>a&nbsp;b &#x4e2d;&#25991; &ensp;c</p>').text, /^a b 中文 c$/);
});

test('web_search：必应 / DuckDuckGo 结果解析、跳转链接还原、失败回退、站点过滤与去重', async () => {
  const realUrl = 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript';
  const enc = 'a1' + Buffer.from(realUrl).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bing = `<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=${enc}&amp;ntb=1">MDN <strong>JavaScript</strong></a></h2><div class="b_caption"><p>1 天前&ensp;·&ensp;JS 指南</p></div></li>
    <li class="b_algo"><h2><a href="https://spam.example/x">Spam</a></h2><p>junk</p></li>
    <li class="b_algo"><h2><a href="https://developer.mozilla.org/zh-CN/docs/Web/JavaScript">dup</a></h2><p>dup</p></li></ol>`;
  assert.equal(unwrapBingUrl(`https://www.bing.com/ck/a?u=${enc}`), realUrl);
  const rows = parseBingHtml(bing);
  assert.equal(rows[0].url, realUrl);
  assert.equal(rows[0].title, 'MDN JavaScript');
  assert.match(rows[0].snippet, /JS 指南/);
  const ddg = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F&amp;rut=x">Node <b>API</b></a><a class="result__snippet" href="x">Docs here</a>';
  assert.deepEqual(parseDuckHtml(ddg), [{ title: 'Node API', url: 'https://nodejs.org/api/', snippet: 'Docs here' }]);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('bing.com')) return resp(200, bing, { 'content-type': 'text/html' });
    return resp(200, ddg, { 'content-type': 'text/html' });
  };
  const s = await webSearch({ query: 'js', blockedDomains: ['spam.example'], fetchImpl });
  assert.equal(s.engine, 'bing');
  assert.deepEqual(s.results.map((r) => r.url), [realUrl], '过滤屏蔽站点 + 去重');
  const only = await webSearch({ query: 'js', allowedDomains: ['mozilla.org'], fetchImpl });
  assert.match(calls.at(-1), /site%3Amozilla\.org/);
  assert.ok(only.results.every((r) => r.url.includes('mozilla.org')));

  const failingBing = async (url) => (String(url).includes('bing.com') ? resp(503, 'busy') : resp(200, ddg));
  const fb = await webSearch({ query: 'node', fetchImpl: failingBing });
  assert.equal(fb.engine, 'duckduckgo');
  assert.match(fb.note, /bing: HTTP 503/);
  assert.match((await webSearch({ query: 'x', fetchImpl: async () => resp(500, '') })).error, /搜索失败/);
  assert.deepEqual(searchOrder({ provider: 'tavily' }), ['tavily', 'bing']);
  assert.deepEqual(searchOrder({}), ['bing', 'duckduckgo']);
});

test('工具层：web_fetch 不抓本机；权限规则能按网址 / 搜索词拒绝联网工具', async () => {
  const tools = createAgentTools({ repoRoot: root, permissions: {}, webFetchImpl: async () => { throw new Error('不该发出请求'); } });
  assert.match((await tools.web_fetch({ url: 'http://127.0.0.1:9/' })).error, /本机/);
  const rules = parseRules({ deny: ['web_fetch(https://*.bank.example/*)', 'web_search(*password*)'] });
  assert.equal(evaluateRules(rules, 'web_fetch', { url: 'https://www.bank.example/login' }).decision, 'deny');
  assert.equal(evaluateRules(rules, 'web_search', { query: 'dump password list' }).decision, 'deny');
  assert.equal(evaluateRules(rules, 'web_fetch', { url: 'https://example.com/' }).decision, null);
});

// ---------------- 计划模式 ----------------
test('计划模式：批准前只放只读工具（工具层兜底）；交计划走 exit；批准后写工具解锁；计划阶段子代理只能调查', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-plan-'));
  try {
    const state = { active: true };
    const exits = [];
    let spawned = null;
    const tools = createAgentTools({
      repoRoot: root, projectPath: dir,
      permissions: { requestApproval: async () => 'allowed-once', sessionAllowed: () => false },
      spawnAgent: async (a) => { spawned = a; return { ok: true }; },
      planMode: { isActive: () => state.active, exit: async (plan) => { exits.push(plan); state.active = false; return { approved: true }; } }
    });
    const target = path.join(dir, 'a.txt');
    const denied = await tools.write_file({ path: target, content: 'x' });
    assert.equal(denied.deniedBy, 'plan-mode');
    assert.match(denied.error, /exit_plan_mode/);
    assert.equal((await tools.run_command({ command: 'echo hi' })).deniedBy, 'plan-mode');
    assert.ok(!(await tools.list_dir({})).error, '只读工具照常用');
    await tools.spawn_agent({ prompt: '查一下', type: 'general' });
    assert.equal(spawned.type, 'explore', '计划阶段的子代理强制只读');
    assert.match((await tools.exit_plan_mode({ plan: 'short' })).error, /plan 必填/);
    const ok = await tools.exit_plan_mode({ plan: '## 计划\n1. 改 a.txt\n2. 跑测试验证' });
    assert.equal(ok.approved, true);
    assert.equal(exits.length, 1);
    const written = await tools.write_file({ path: target, content: 'x' });
    assert.ok(!written.error, JSON.stringify(written));
    assert.match((await tools.exit_plan_mode({ plan: '再交一次计划，应该被拒绝的那种' })).error, /不在计划模式/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  for (const n of ['write_file', 'edit_file', 'run_command', 'browser_navigate', 'computer_action', 'run_workflow', 'remember_project']) {
    assert.ok(!PLAN_MODE_TOOLS.has(n), `${n} 不能出现在计划模式白名单`);
  }
});

test('计划审批卡：kind=plan 透传给界面，且不占 ask_user 每回合 3 次的额度', async () => {
  const sent = [];
  const reg = createAskUserRegistry({ emit: (p) => { sent.push(p); queueMicrotask(() => reg.answer({ callId: p.callId, answer: '好' })); }, maxPerTurn: 1 });
  reg.beginTurn('s');
  await reg.ask({ question: 'q1', sessionId: 's' });
  assert.match((await reg.ask({ question: 'q2', sessionId: 's' })).error, /上限/);
  const plan = await reg.ask({ question: '## plan', kind: 'plan', sessionId: 's' });
  assert.equal(plan.answer, '好');
  assert.equal(sent.at(-1).kind, 'plan');
  assert.ok(!('kind' in sent[0]));
});

test('计划模式接线：渲染层传 planMode、无人值守不进计划模式、schema 原地换成完整工具表、界面有开关和审批卡', () => {
  const ia = read('desktop/src/main/ipc/ipc-agent.mjs');
  assert.match(ia, /const planMode = opts\?\.planMode === true && !unattended;/);
  assert.match(ia, /turnSchema\.splice\(0, turnSchema\.length, \.\.\.fullSchema\(\)\)/);
  assert.match(ia, /toolsSchema: turnSchema,/);
  assert.match(ia, /planMode: planGate,/);
  const app = read('desktop/src/renderer/App.jsx');
  assert.match(app, /planMode: !!planModesRef\.current\[sid\]/);
  assert.match(app, /ev\.kind === 'plan-mode'/);
  assert.match(read('desktop/src/renderer/components/Composer.jsx'), /e\.key === 'Tab' && e\.shiftKey && onTogglePlan/);
  assert.match(read('desktop/src/renderer/components/AskUserCard.jsx'), /data\.kind === 'plan'/);
  assert.match(read('desktop/src/renderer/chat/TraceCards.jsx'), /entry\.tool === 'exit_plan_mode'/);
});
