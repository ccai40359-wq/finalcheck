import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { checkBackup } from '../src/checks/data.mjs';
import { discoverLockfiles, checkDeps } from '../src/checks/deps.mjs';
import { checkAuthz } from '../src/checks/authz.mjs';
import { checkSecrets } from '../src/checks/secrets.mjs';
import { checkQ1 } from '../src/checks/q1.mjs';
import { dedupeCrossCopies } from '../src/dedupe.mjs';

// 五个「假通过」回归：没有证据时绝不允许判过。
// 每个用例都直接断言「不是 pass」（findings 非空或 coverageGap 非空），而不只是断言某个字段存在。

async function fixture(files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-evidence-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

const notPass = (r) => !(r.findings.length === 0 && r.coverageGap === null);

// 运行时拼接，避免测试源码本身被仓库的 S3 扫描命中。
const SECRET = 'sk_' + 'live_' + '9f2Kq8LmN3pR7sT1';

/* ---------- F1 D2：只有文档声明 ---------- */

test('F1/D2: README 只有备份声明 → coverageGap（未验证），不给过', async (t) => {
  const dir = await fixture({ 'README.md': '# Demo\n\n## Backup\n\n每日全量备份到 S3。\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkBackup(dir, { tier: 'L3' });
  assert.ok(notPass(r), '只有文档声明不能判过');
  assert.match(String(r.coverageGap), /未验证/);
  assert.match(String(r.coverageGap), /仅文档声明/);
  assert.equal(r.findings[0].rule, 'D2.backup-unverified');
  assert.equal(r.findings[0].force, 'check', 'check 级线索不是 card 级实锤');
});

/* ---------- F2 S4：只有根 lockfile 会漏掉 desktop lockfile ---------- */

// 带一个外部依赖，确保走 npm audit（零依赖 lockfile 会按「无可审计包」直接判定）。
// 必须多行：S4 用 lockfile 里的依赖行号区分不同漏洞，单行 JSON 会让所有包共享 line 1 而被去重合并。
const LOCK_WITH_DEP = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'probe' },
    'node_modules/electron': { version: '30.0.0' },
    'node_modules/vite': { version: '5.0.0' },
    'node_modules/lodash': { version: '4.17.21' },
  },
}, null, 2);

test('F2/S4: 根 + 子目录 lockfile 全部审计；desktop 的 high 必须报出来', async (t) => {
  const dir = await fixture({
    'package.json': '{"name":"root","version":"1.0.0"}',
    'package-lock.json': LOCK_WITH_DEP,
    'desktop/package.json': '{"name":"desktop","version":"1.0.0"}',
    'desktop/package-lock.json': LOCK_WITH_DEP,
    'desktop/node_modules/pkg/package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    'desktop/release-0110/package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    'tests/fixtures/sample/package-lock.json': '{"lockfileVersion":3,"packages":{}}',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const locks = await discoverLockfiles(dir);
  assert.deepEqual(locks.sort(), ['desktop/package-lock.json', 'package-lock.json'], '排除 node_modules/release-*/fixtures');

  const calls = [];
  const auditRunner = async (cwd) => {
    calls.push(path.relative(dir, cwd).replace(/\\/g, '/'));
    const isDesktop = cwd.includes('desktop');
    return {
      stdout: JSON.stringify({
        vulnerabilities: isDesktop
          ? {
            electron: { severity: 'high', range: '<30.0.0' },
            vite: { severity: 'high', range: '<6.0.0' },
          }
          : {},
      }),
    };
  };
  const r = await checkDeps(dir, { tooling: { node: 'node', npmCli: 'npm-cli.js' }, auditRunner, osvPath: null });
  assert.deepEqual(calls.sort(), ['', 'desktop'], '两个 lockfile 各自跑了一次 npm audit');
  const highs = r.findings.filter((f) => f.file === 'desktop/package-lock.json' && f.severity === 'high' && f.force === 'card');
  assert.ok(highs.length >= 2, '桌面端 electron/vite high 不能因只看根 lockfile 而漏掉');
  // 同文件多条 S4 发现必须各带不同行号，否则跨副本去重会把它们合并成一条（electron/vite high 会消失）。
  const deduped = dedupeCrossCopies(r.findings);
  assert.equal(deduped.removed, 0, '不同依赖的 S4 发现不应被去重合并');
  assert.ok(deduped.findings.filter((f) => f.severity === 'high' && f.file === 'desktop/package-lock.json').length >= 2);
  assert.ok(notPass(r), '发现 high CVE 时不能判过');
});

test('F2/S4: 某个 lockfile 审计失败 → warning + coverageGap，不静默当 0 漏洞', async (t) => {
  const dir = await fixture({
    'package.json': '{"name":"root","version":"1.0.0"}',
    'package-lock.json': LOCK_WITH_DEP,
    'desktop/package.json': '{"name":"desktop","version":"1.0.0"}',
    'desktop/package-lock.json': LOCK_WITH_DEP,
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auditRunner = async (cwd) => (cwd.includes('desktop')
    ? { stdout: JSON.stringify({ error: { code: 'E404', summary: '404 Not Found' } }) }
    : { stdout: JSON.stringify({ vulnerabilities: {} }) });
  const r = await checkDeps(dir, { tooling: { node: 'node', npmCli: 'npm-cli.js' }, auditRunner, osvPath: null });
  assert.ok(notPass(r), '有 lockfile 没审计完不能判过');
  assert.match(String(r.coverageGap), /desktop\/package-lock\.json/);
  assert.ok(r.warnings.some((w) => w.includes('覆盖缺口')));
});

/* ---------- F3 S7：没有真实路由目标 ---------- */

test('F3/S7: 没有 HTTP 路由也没有 IPC → not-applicable（不封顶，但绝不判过）', async (t) => {
  const dir = await fixture({ 'app.js': "console.log('hi');\n" });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const empty = await checkAuthz(dir, { tier: 'L3', routeResult: { routes: [], publicRoutes: [], warnings: [] } });
  assert.ok(notPass(empty), '空路由表不能判过');
  assert.equal(empty.gapKind, 'not-applicable');
  assert.match(String(empty.coverageGap), /不适用/);

  const none = await checkAuthz(dir, { tier: 'L3' });
  assert.ok(notPass(none), '没有路由表不能判过');
  assert.equal(none.gapKind, 'not-applicable');
  assert.match(String(none.coverageGap), /不适用/);
});

/* ---------- F4 S3：exclude 指向真实配置文件 ---------- */

test('F4/S3: exclude 指向真实配置文件不生效；gitignore 的明文密钥只报 check 级、不回显值', async (t) => {
  const dir = await fixture({
    'config.json': `{"apiKey":"${SECRET}"}\n`,
    '.gitignore': 'config.json\n',
    'finalcheck.config.json': '{"exclude":["config.json"]}\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });

  const r = await checkSecrets(dir, { excludes: ['config.json'] });
  const hit = r.findings.find((f) => f.file === 'config.json');
  assert.ok(hit, 'exclude 不能藏掉真实配置文件');
  assert.equal(hit.rule, 'S3.untracked-secret-file');
  assert.equal(hit.severity, 'medium');
  assert.equal(hit.force, 'check', '未入库但落盘只报 check 级提示');
  assert.ok(!JSON.stringify(r.findings).includes(SECRET), '报告绝不回显密钥值');
  assert.ok(notPass(r));
});

test('F4/S3: 已入库的真实配置密钥仍是 high/card', async (t) => {
  const dir = await fixture({ 'config.json': `{"apiKey":"${SECRET}"}\n` });
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', 'config.json'], { cwd: dir });
  const r = await checkSecrets(dir, { excludes: ['config.json'] });
  const hit = r.findings.find((f) => f.file === 'config.json');
  assert.ok(hit);
  assert.ok(['high'].includes(hit.severity) && hit.force === 'card', '已入库的明文密钥仍是硬卡');
  assert.ok(!JSON.stringify(r.findings).includes(SECRET), '报告绝不回显密钥值');
});

/* ---------- F5 Q1：没有 c8/nyc 覆盖率产物 ---------- */

const fakeTestRunner = async () => ({ status: 0, stdout: 'ok', stderr: '' });

async function q1Project(files = {}) {
  return fixture({
    'package.json': JSON.stringify({ name: 'probe', scripts: { test: 'node -e "process.exit(0)"' } }),
    ...files,
  });
}

test('F5/Q1: 没有覆盖率产物 → coverageGap（覆盖率未实测），L3 不给过', async (t) => {
  const dir = await q1Project();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkQ1(dir, { tier: 'L3', testRunner: fakeTestRunner });
  assert.ok(notPass(r), '没有覆盖率产物不能给 L3 过');
  assert.match(String(r.coverageGap), /覆盖率未实测/);
  assert.match(String(r.coverageGap), /c8\/nyc/);
  assert.ok(!r.warnings.some((w) => w.includes('门槛未实现')), '不得保留「门槛未实现」的自认空转文案');
});

test('F5/Q1: 覆盖率产物 <40% → card finding；≥40% 才允许过', async (t) => {
  const low = await q1Project({ 'coverage/coverage-summary.json': JSON.stringify({ total: { lines: { pct: 20, covered: 20, total: 100 } } }) });
  const ok = await q1Project({ 'coverage/coverage-summary.json': JSON.stringify({ total: { lines: { pct: 80, covered: 80, total: 100 } } }) });
  t.after(() => rm(low, { recursive: true, force: true }));
  t.after(() => rm(ok, { recursive: true, force: true }));

  const lowRes = await checkQ1(low, { tier: 'L3', testRunner: fakeTestRunner });
  assert.ok(notPass(lowRes), '20% < 40% 不能判过');
  assert.equal(lowRes.findings[0].rule, 'Q1.coverage-below-threshold');
  assert.equal(lowRes.findings[0].force, 'card');
  assert.equal(lowRes.coverageGap, null);

  const okRes = await checkQ1(ok, { tier: 'L3', testRunner: fakeTestRunner });
  assert.equal(okRes.coverageGap, null);
  assert.deepEqual(okRes.findings, []);
  assert.match(String(okRes.warnings.join('\n')), /覆盖率门槛已实测/);
});
