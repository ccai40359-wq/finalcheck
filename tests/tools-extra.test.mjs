// 三项 agent 工具增强的验收：review_diff / probe 百分位 / quality repeat
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy } from '../desktop/src/main/policy.mjs';
import { probeTarget } from '../src/dynamic/probe.mjs';
import { QUALITY_FILE, checkQuality, normalizeQualityConfig } from '../src/checks/quality.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const FLIP_CMD = 'node -e "const fs=require(\'fs\');const n=fs.existsSync(\'counter.txt\')?+fs.readFileSync(\'counter.txt\',\'utf8\'):0;fs.writeFileSync(\'counter.txt\',String(n+1));process.exit(n%2===0?0:1)"';

function fakePermissions({ allow = true } = {}) {
  return {
    noted: [],
    noteTarget(url) { this.noted.push(url); },
    sessionAllowed: () => allow,
    commandPrefix: (cmd) => String(cmd).split(/\s+/)[0],
    requestApproval: async () => (allow ? 'allowed-once' : 'rejected')
  };
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function initRepo(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'FinalCheck Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

test('review_diff：二次提交含 exec( 拼接 → 报 command-exec；只读不改工作区', async (t) => {
  const dir = await initRepo(t);
  const file = path.join(dir, 'app.js');
  await writeFile(file, [
    'const db = {};',
    'function load(id) {',
    '  return db.query("SELECT * FROM users WHERE id = " + id);',
    '}',
    ''
  ].join('\n'), 'utf8');
  git(dir, ['add', 'app.js']);
  git(dir, ['commit', '-qm', 'init']);

  await writeFile(file, [
    'const db = {};',
    'function load(id) {',
    '  return runtime.exec("ls " + id);',
    '}',
    ''
  ].join('\n'), 'utf8');
  git(dir, ['add', 'app.js']);
  git(dir, ['commit', '-qm', 'change']);

  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const out = await tools.review_diff({ dir, base: 'HEAD~1' });
  assert.equal(out.base, 'HEAD~1');
  assert.equal(out.truncated, false);
  const changed = out.files.find((f) => f.path === 'app.js');
  assert.ok(changed, '应返回改动文件');
  assert.equal(changed.status, 'M');
  assert.ok(changed.added >= 1 && changed.removed >= 1, '应统计 +N/-M');
  const risk = out.risks.find((r) => r.rule === 'command-exec');
  assert.ok(risk, '新增 exec( 拼接应被标记');
  assert.equal(risk.file, 'app.js');
  assert.ok(risk.line > 0);
  assert.match(risk.snippet, /exec\(/);
  assert.ok(risk.snippet.length <= 120, 'snippet 必须是单行且 ≤120');
  assert.ok(!risk.snippet.includes('\n'));

  // 只读性：审查结束后工作区必须仍然干净
  assert.equal(git(dir, ['status', '--porcelain']), '');
});

test('review_diff：非 git 目录 → 明确 error，不抛异常', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-review-nogit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions() });
  const out = await tools.review_diff({ dir });
  assert.ok(out.error, '非 git 目录应返回 error');
  assert.match(out.error, /git/i);
  assert.deepEqual(out.files, []);
  assert.deepEqual(out.risks, []);
});

test('review_diff：policy 拒绝项目边界外的目录', async (t) => {
  const inside = await initRepo(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'fc-review-out-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const policy = createPolicy({ projectPath: inside, mode: 'workspace' });
  const tools = createAgentTools({ repoRoot, permissions: fakePermissions(), policy, projectPath: inside });
  const out = await tools.review_diff({ dir: outside });
  assert.equal(out.deniedBy, 'policy');
  assert.match(out.error, /被沙箱拒绝/);
});

test('probe 百分位：p50 ≤ p95，firstByteMs 有值；requests 被封顶', async (t) => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const out = await probeTarget(base, { requests: 5 });
  assert.ok(out.latency, '有样本时必须返回 latency');
  assert.equal(typeof out.latency.p50, 'number');
  assert.equal(typeof out.latency.p95, 'number');
  assert.equal(typeof out.latency.firstByteMs, 'number');
  assert.ok(out.latency.p50 <= out.latency.p95, 'p50 应 ≤ p95');
  assert.ok(out.latency.min <= out.latency.max);
  assert.ok(out.latency.firstByteMs >= 0);
  assert.equal(out.results.find((r) => r.kind === 'security-headers').missing.length, 4);

  // 上下限：requests=1 → 3 次；requests=99 → 20 次（只断言不抛错且有样本）
  const low = await probeTarget(base, { requests: 1 });
  assert.ok(low.latency);
  const high = await probeTarget(base, { requests: 99 });
  assert.ok(high.latency);
});

test('probe 百分位：全部请求失败 → latency=null，不抛异常', async () => {
  const out = await probeTarget('http://127.0.0.1:1', { requests: 3 });
  assert.equal(out.latency, null);
  assert.ok(out.results.some((r) => r.kind === 'security-headers' && r.error));
});

test('quality repeat：交替 exit 0/1 → flaky 判定 + 每次 exit/ms 记录', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-quality-flaky-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, QUALITY_FILE), JSON.stringify({
    checks: [{ id: 'flip', command: FLIP_CMD, timeoutMs: 60000, repeat: 4 }]
  }), 'utf8');

  const r = await checkQuality(dir, { tier: 'L2' });
  assert.equal(r.runs.length, 1);
  const run = r.runs[0];
  assert.deepEqual(run.attempts.map((a) => a.code), [0, 1, 0, 1]);
  assert.ok(run.attempts.every((a) => typeof a.ms === 'number' && a.ms >= 0));
  assert.deepEqual(run.flaky, { failures: 2, total: 4 });
  assert.equal(run.isFlaky, true);
  const finding = r.findings.find((f) => f.rule === 'Q2.flip-flaky');
  assert.ok(finding, '抖动应产出 finding');
  assert.equal(finding.severity, 'medium');
  assert.match(finding.snippet, /2\/4/);
});

test('quality repeat：全失败不算 flaky，仍按失败判定', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-quality-allfail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, QUALITY_FILE), JSON.stringify({
    checks: [{ id: 'bad', command: 'node always-fail.mjs', repeat: 3 }]
  }), 'utf8');
  const r = await checkQuality(dir, {
    tier: 'L2',
    runner: async () => ({ code: 1, ms: 12, out: '', err: 'boom' })
  });
  const run = r.runs[0];
  assert.deepEqual(run.flaky, { failures: 3, total: 3 });
  assert.equal(run.isFlaky, false);
  assert.equal(r.findings[0].rule, 'Q2.bad-failed');
});

test('quality repeat：repeat=1 输出字段与旧版一致（无 attempts/flaky）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-quality-repeat1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, QUALITY_FILE), JSON.stringify({
    checks: [{ id: 'once', command: FLIP_CMD, repeat: 3 }]
  }), 'utf8');

  // 入参 repeat 覆盖配置里的 repeat=3 → 只执行 1 次，且不加新字段
  const r = await checkQuality(dir, { tier: 'L2', repeat: 1 });
  const run = r.runs[0];
  assert.deepEqual(
    Object.keys(run).sort(),
    ['code', 'command', 'id', 'maxMs', 'ms', 'timedOut'].sort(),
    'repeat=1 不得出现 attempts/flaky/isFlaky'
  );
  assert.equal(run.code, 0);
  assert.equal(await readFile(path.join(dir, 'counter.txt'), 'utf8'), '1');
});

test('quality repeat：配置归一化 clamp 1–5（顶层兜底、单条优先）', () => {
  const [a, b] = normalizeQualityConfig({ repeat: 9, checks: [{ command: 'x' }, { command: 'y', repeat: 0 }] });
  assert.equal(a.repeat, 5, '顶层 repeat 超上限收到 5');
  assert.equal(b.repeat, 1, '单条 repeat=0 收到 1');
  assert.equal(normalizeQualityConfig({ checks: [{ command: 'z' }] })[0].repeat, 1);
  assert.equal(normalizeQualityConfig({ checks: [{ command: 'z', repeat: 2.9 }] })[0].repeat, 2);
});
