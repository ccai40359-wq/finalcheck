import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { checkDeps, discoverLockfiles, discoverLockfileEntries } from '../src/checks/deps.mjs';

// S4 生态覆盖声明：只做 lockfile 发现，不新增扫描器。
// 所有用例都在 mkdtemp 临时目录里构造 lockfile 文本，npm audit 全部用注入的假 runner，不联网。

async function fixture(t, files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-deps-eco-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

const TOOLING = { node: 'node', npmCli: 'npm-cli.js' };

// 多行 lockfile：S4 用依赖行号区分同一文件里的多条漏洞，单行 JSON 会把它们合并。
const LOCK_WITH_DEP = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'probe' },
    'node_modules/lodash': { version: '4.17.21' },
  },
}, null, 2);

const LOCK_ZERO = JSON.stringify({
  name: 'probe', version: '1.0.0', lockfileVersion: 3,
  packages: { '': { name: 'probe', version: '1.0.0' } },
}, null, 2);

const HIGH_RUNNER = async () => ({
  stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: 'high', range: '<4.17.21' } } }),
});

const ZERO_RUNNER = async () => ({ stdout: JSON.stringify({ vulnerabilities: {} }) });

test('S4：单独 go.sum → 发现条目 ecosystem=go/auditable=false，gap 声明 Go 未接入审计', async (t) => {
  const dir = await fixture(t, { 'go.sum': 'example.com/mod v1.0.0 h1:abc=\nexample.com/mod v1.0.0/go.mod h1:def=\n' });
  let auditCalls = 0;
  const r = await checkDeps(dir, {
    tooling: TOOLING,
    auditRunner: async () => { auditCalls++; return { stdout: '{}' }; },
    osvPath: null,
  });

  assert.equal(auditCalls, 0, '非 npm lockfile 不能交给 npm audit');
  assert.deepEqual(r.findings, []);
  assert.match(String(r.coverageGap), /Go/);
  assert.match(String(r.coverageGap), /未接入审计/);
  assert.match(String(r.coverageGap), /go\.sum/);
  assert.equal(r.auditedCount, 0);

  const entry = r.lockfileEntries.find((e) => e.path === 'go.sum');
  assert.ok(entry, '应发现 go.sum');
  assert.equal(entry.ecosystem, 'go');
  assert.equal(entry.auditable, false);
});

test('S4：Python/PHP/Java lockfile 按生态逐条声明（不伪装成 npm 审计）', async (t) => {
  const cases = [
    { file: 'uv.lock', ecosystem: 'python', label: 'Python' },
    { file: 'poetry.lock', ecosystem: 'python', label: 'Python' },
    { file: 'Pipfile.lock', ecosystem: 'python', label: 'Python' },
    { file: 'composer.lock', ecosystem: 'php', label: 'PHP' },
    { file: 'pom.xml', ecosystem: 'java', label: 'Java' },
    { file: 'gradle.lockfile', ecosystem: 'java', label: 'Java' },
  ];
  for (const c of cases) {
    await t.test(c.file, async (t2) => {
      const dir = await fixture(t2, { [c.file]: c.file.endsWith('.lock') ? '{}\n' : '<project/>\n' });
      let auditCalls = 0;
      const r = await checkDeps(dir, {
        tooling: TOOLING,
        auditRunner: async () => { auditCalls++; return { stdout: '{}' }; },
        osvPath: null,
      });
      assert.equal(auditCalls, 0, `${c.file} 不是 npm 生态，不能调用 npm audit`);
      assert.deepEqual(r.findings, []);
      assert.equal(r.coverageGap === null, false, `${c.file} 必须留下覆盖缺口`);
      assert.match(String(r.coverageGap), new RegExp(c.label), `gap 要点名 ${c.label}`);
      assert.match(String(r.coverageGap), /未接入审计/);
      assert.equal(r.auditedCount, 0, '非 npm lockfile 不计入 auditedCount');
      const entry = r.lockfileEntries.find((e) => e.path === c.file);
      assert.ok(entry, `应发现 ${c.file}`);
      assert.equal(entry.ecosystem, c.ecosystem);
      assert.equal(entry.auditable, false);
    });
  }
});

test('S4：混合仓 package-lock.json + go.sum → npm 照常审计，Go gap 保留且只数 npm', async (t) => {
  const dir = await fixture(t, {
    'package-lock.json': LOCK_WITH_DEP,
    'go.sum': 'example.com/mod v1.0.0 h1:abc=\n',
  });
  const calls = [];
  const r = await checkDeps(dir, {
    tooling: TOOLING,
    auditRunner: async (cwd) => { calls.push(path.relative(dir, cwd).replace(/\\/g, '/')); return HIGH_RUNNER(); },
    osvPath: null,
  });

  assert.equal(calls.length, 1, 'npm 路径仍要尝试审计');
  assert.equal(r.auditedCount, 1, 'auditedCount 只数 npm lockfile');
  assert.ok(r.findings.some((f) => f.checkId === 'S4' && f.file === 'package-lock.json'
    && f.severity === 'high' && f.force === 'card'), 'npm audit 的 high 照常产出 card');
  assert.match(String(r.coverageGap), /Go/);
  assert.match(String(r.coverageGap), /未接入审计/);
  assert.match(String(r.coverageGap), /go\.sum/);
  assert.ok(r.findings.length > 0 && r.coverageGap !== null, '不能因为发现非 npm lockfile 就判过关/0 漏洞');
  assert.deepEqual(
    r.lockfileEntries.map((e) => [e.path, e.ecosystem, e.auditable]),
    [['go.sum', 'go', false], ['package-lock.json', 'npm', true]],
  );
});

test('S4：纯 npm 零依赖 lockfile → coverageGap=null、findings=[]（保持 verdict 契约）', async (t) => {
  const dir = await fixture(t, { 'package-lock.json': LOCK_ZERO });
  let auditCalls = 0;
  const r = await checkDeps(dir, {
    tooling: TOOLING,
    auditRunner: async () => { auditCalls++; return ZERO_RUNNER(); },
    osvPath: null,
  });

  assert.equal(auditCalls, 0, '零依赖 lockfile 不必访问 registry');
  assert.equal(r.coverageGap, null);
  assert.deepEqual(r.findings, []);
  assert.equal(r.auditedCount, 1);
});

test('S4：npm audit 401/404/坏 JSON/启动失败一律记 gap，不静默 clean', async (t) => {
  const cases = [
    {
      name: '401',
      runner: async () => ({ stdout: JSON.stringify({ error: { code: 'E401', summary: 'Unauthorized' } }) }),
      pattern: /401|Unauthorized/,
      expectedCalls: 1,
    },
    {
      name: '404 回退后仍失败',
      runner: async () => ({
        stdout: JSON.stringify({ message: '404 Not Found - POST /-/npm/v1/security/advisories/bulk - [NOT_IMPLEMENTED]', uri: 'https://mirror.example/-/npm/v1/security/advisories/bulk' }),
      }),
      pattern: /404|NOT_IMPLEMENTED|未实现/,
      expectedCalls: 2,
    },
    {
      name: '坏 JSON',
      runner: async () => ({ stdout: 'not json' }),
      pattern: /输出不是 JSON/,
      expectedCalls: 1,
    },
    {
      name: '启动失败',
      runner: async () => ({ error: new Error('spawn EACCES') }),
      pattern: /启动失败|EACCES/,
      expectedCalls: 1,
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async (t2) => {
      const dir = await fixture(t2, { 'package-lock.json': LOCK_WITH_DEP });
      const calls = [];
      const r = await checkDeps(dir, {
        tooling: TOOLING,
        auditRunner: async (...args) => { calls.push(args); return c.runner(); },
        osvPath: null,
      });
      assert.equal(calls.length, c.expectedCalls);
      assert.deepEqual(r.findings, [], '失败不能产出 clean 结论');
      assert.equal(r.coverageGap === null, false, '失败必须留下 gap');
      assert.match(String(r.coverageGap), c.pattern);
      assert.match(String(r.coverageGap), /不能当成 0 漏洞/);
      assert.equal(r.auditedCount, 0);
    });
  }
});

test('S4：pnpm/yarn 仍算 npm 生态并尝试审计，失败按现有方式记失败', async (t) => {
  for (const file of ['pnpm-lock.yaml', 'yarn.lock']) {
    await t.test(file, async (t2) => {
      const dir = await fixture(t2, { [file]: 'lockfileVersion: 9\n' });
      const calls = [];
      const r = await checkDeps(dir, {
        tooling: TOOLING,
        auditRunner: async () => {
          calls.push(1);
          return { stdout: JSON.stringify({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile' } }) };
        },
        osvPath: null,
      });
      assert.equal(calls.length, 1);
      assert.equal(r.lockfileEntries[0].ecosystem, 'npm');
      assert.equal(r.lockfileEntries[0].auditable, true);
      assert.equal(r.auditedCount, 0);
      assert.match(String(r.coverageGap), /npm audit 失败/);
      assert.match(String(r.coverageGap), /existing lockfile|ENOLOCK/);
      assert.doesNotMatch(String(r.coverageGap), /未接入审计/, 'pnpm/yarn 已尝试审计，不能归为非 npm 生态缺口');
    });
  }
});

test('S4：只发现非 npm lockfile 时，即使没有 Node/npm 也只声明生态缺口', async (t) => {
  const dir = await fixture(t, { 'go.sum': 'example.com/mod v1.0.0 h1:abc=\n', 'composer.lock': '{}\n' });
  const r = await checkDeps(dir, { tooling: { node: null, npmCli: null }, osvPath: null });
  assert.deepEqual(r.findings, []);
  assert.match(String(r.coverageGap), /Go/);
  assert.match(String(r.coverageGap), /PHP/);
  assert.doesNotMatch(String(r.coverageGap), /未找到 Node\.js\/npm/);
});

test('S4：多生态缺口逐条列出，文案含各生态名', async (t) => {
  const dir = await fixture(t, {
    'go.sum': 'example.com/mod v1.0.0 h1:abc=\n',
    'uv.lock': 'version = 1\n',
    'composer.lock': '{}\n',
    'pom.xml': '<project/>\n',
  });
  const r = await checkDeps(dir, { tooling: TOOLING, auditRunner: async () => ({ stdout: '{}' }), osvPath: null });
  const gap = String(r.coverageGap);
  for (const label of ['Go', 'Python', 'PHP', 'Java']) {
    assert.match(gap, new RegExp(`\\b${label}\\b`));
  }
  assert.equal((gap.match(/未接入审计/g) || []).length, 4, '按生态逐条说明，不合并成一句');
  assert.equal(r.auditedCount, 0);
});

test('S4：lockfile 发现顺序稳定、根优先、不重复，排除 node_modules/release/fixtures', async (t) => {
  const dir = await fixture(t, {
    'package-lock.json': LOCK_ZERO,
    'go.sum': 'example.com/mod v1.0.0 h1:abc=\n',
    'composer.lock': '{}\n',
    'desktop/package-lock.json': LOCK_ZERO,
    'desktop/go.sum': 'example.com/mod v1.0.0 h1:abc=\n',
    'node_modules/x/go.sum': 'ignored\n',
    'release-0110/package-lock.json': LOCK_ZERO,
    'tests/fixtures/go.sum': 'ignored\n',
  });

  const expected = ['composer.lock', 'go.sum', 'package-lock.json', 'desktop/go.sum', 'desktop/package-lock.json'];
  const entries = await discoverLockfileEntries(dir);
  assert.deepEqual(entries.map((e) => e.path), expected);
  assert.deepEqual(await discoverLockfileEntries(dir), entries, '重复调用顺序必须一致');

  const again = await discoverLockfiles(dir);
  assert.deepEqual(again, expected, '旧接口仍返回稳定路径字符串');
  assert.deepEqual((await discoverLockfiles(dir, { withMeta: true })), entries);

  assert.equal(new Set(entries.map((e) => e.path)).size, entries.length, '同一 lockfile 不能重复列出');
  const root = entries.findIndex((e) => e.path === 'package-lock.json');
  const nested = entries.findIndex((e) => e.path === 'desktop/package-lock.json');
  assert.ok(root >= 0 && root < nested, '根 lockfile 优先级不变');
});
