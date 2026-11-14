import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { audit, conclude } from '../src/audit.mjs';
import { isNonProductPath, applyScopePolicy, detectLanguageGap } from '../src/scope-policy.mjs';

// 非产品路径降级 + 非 JS 语言覆盖缺口。
// 实测教训：express/fastify/deepseek-harness 的高危大多在 tests/examples/docs，
// 这些发现不能计入产品结论；纯 Python/PHP 仓库的 JS-only 检查也不能算「已执行」。

const LOCK = {
  name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'probe', version: '1.0.0', license: 'UNLICENSED' } },
};
const README = [
  '# Probe project',
  '## Installation',
  'Install with npm install.',
  '## Running',
  'Run with npm test.',
  '## Environment',
  'No environment variables required.',
  '## Deployment',
  'Run node app.js on the target machine.',
  '## Rollback',
  'Rollback to the previous version.',
  '',
  'Minimal Node.js project used by FinalCheck scope-policy tests. To install, run the test script:',
  '',
  '```',
  'npm install',
  'npm test',
  '```',
  '',
  'The project deliberately has zero external dependencies, so the dependency audit stays offline.',
  '',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
].join('\n');

const UNGUARDED_ROUTE = [
  "const express = require('express');",
  'const app = express();',
  "app.get('/users/:id', (req, res) => {",
  '  res.json({ id: req.params.id });',
  '});',
  'module.exports = app;',
].join('\n');

const FASTAPI_APP = [
  'from fastapi import FastAPI',
  '',
  'app = FastAPI()',
  '',
  "@app.get('/users/{user_id}')",
  'def read_user(user_id: int):',
  "    return {'id': user_id}",
].join('\n');

async function makeProject(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-scope-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }
  return dir;
}

function finding(overrides = {}) {
  return {
    checkId: 'S1',
    severity: 'high',
    force: 'card',
    file: 'src/app.js',
    line: 1,
    rule: 'S1.no-guard',
    snippet: 'GET /users',
    message: '接口无登录守卫',
    source: 'program',
    ...overrides,
  };
}

/* ---------- 1. 路径矩阵 ---------- */

test('isNonProductPath：目录段与测试文件名的正/反对照', () => {
  const positive = [
    'pkg/test/a.js', 'tests/a.js', '__tests__/a.js', 'spec/a.ts', 'specs/a.js', 'e2e/a.js',
    'examples/a.js', 'example/a.js', 'docs/a.md', 'doc/a.md', 'benchmarks/a.js', 'bench/a.js',
    'foo.test.js', 'foo.test.mjs', 'foo.test.cjs', 'foo.test.ts', 'foo.test.jsx', 'foo.test.tsx',
    'foo.spec.ts', 'foo.e2e.mjs', 'foo-test.js',
  ];
  for (const p of positive) assert.equal(isNonProductPath(p), true, `${p} 应判为非产品路径`);
  const negative = [
    'src/contest.js', 'src/latest.js', 'src/testing/a.js', 'src/specification.js', 'src/doc-utils.js',
    'src/app.js', 'README.md',
  ];
  for (const p of negative) assert.equal(isNonProductPath(p), false, `${p} 不能判为非产品路径`);
  assert.equal(isNonProductPath(null), false);
  assert.equal(isNonProductPath(''), false);
});

test('applyScopePolicy：指定 check 在非产品路径降为 tip，severity 与其它键不变', () => {
  const files = [
    'pkg/test/a.js', 'tests/a.js', '__tests__/a.js', 'spec/a.ts', 'specs/a.js', 'e2e/a.js',
    'examples/a.js', 'docs/a.md', 'benchmarks/a.js', 'foo.test.js', 'foo.spec.ts', 'foo.e2e.mjs',
  ];
  for (const checkId of ['S1', 'S2', 'S5', 'Q3']) {
    for (const file of files) {
      const before = finding({ checkId, file, severity: 'high', force: 'card', rule: `${checkId}.x` });
      const { findings, downgraded } = applyScopePolicy([before]);
      assert.equal(downgraded, 1, `${checkId}@${file} 应降级`);
      assert.equal(findings[0].force, 'tip');
      assert.equal(findings[0].severity, 'high', 'severity 不能被改写');
      assert.equal(findings[0].scope, 'non-product');
      assert.match(findings[0].message, /（非产品路径：不计入结论）$/);
      assert.equal(findings[0].rule, before.rule, '已有键必须保留');
      assert.equal(findings[0].line, before.line);
      assert.equal(findings[0].snippet, before.snippet);
    }
  }

  for (const file of ['src/contest.js', 'src/latest.js', 'src/testing/a.js', 'src/specification.js', 'src/doc-utils.js']) {
    const before = finding({ file });
    const { findings, downgraded } = applyScopePolicy([before]);
    assert.equal(downgraded, 0, `${file} 不能降级`);
    assert.equal(findings[0].force, 'card');
    assert.equal(findings[0].scope, undefined);
    assert.equal(findings[0].message, before.message);
  }

  // 未列出的 check（H1/C1/O1/D1-D3）与不在降级名单的 check 保持原判定。
  for (const checkId of ['H1', 'C1', 'O1', 'D1', 'D2', 'D3']) {
    const before = finding({ checkId, file: 'docs/README.md', rule: `${checkId}.doc` });
    const { findings, downgraded } = applyScopePolicy([before]);
    assert.equal(downgraded, 0, `${checkId} 不能降级`);
    assert.equal(findings[0].force, 'card');
    assert.equal(findings[0].scope, undefined);
    assert.equal(findings[0].message, before.message);
  }
});

test('applyScopePolicy：S3 除弱默认口令外都在 tests 路径保持 high/card', () => {
  const hard = [
    'S3.aws-key', 'S3.private-key', 'S3.env-tracked', 'S3.untracked-secret-file',
    'S3.history-private-key', 'S3.secret-literal', 'S3.secret-value',
    'S3.history-aws-key', 'S3.history-secret-literal', 'S3.gitleaks:generic-api-key',
  ];
  for (const rule of hard) {
    const before = finding({ checkId: 'S3', rule, file: 'tests/a.js', hard: true });
    const { findings, downgraded } = applyScopePolicy([before]);
    assert.equal(downgraded, 0, `${rule} 是硬规则，不能降级`);
    assert.equal(findings[0].force, 'card');
    assert.equal(findings[0].severity, 'high');
    assert.equal(findings[0].scope, undefined);
  }
  // secrets.mjs 已判定为非真实密钥（测试夹具/占位值）→ hard:false 才允许降级
  const placeholder = finding({ checkId: 'S3', rule: 'S3.secret-literal', file: 'tests/a.js', hard: false });
  const placeholderResult = applyScopePolicy([placeholder]);
  assert.equal(placeholderResult.downgraded, 1);
  assert.equal(placeholderResult.findings[0].force, 'tip');
  assert.equal(placeholderResult.findings[0].scope, 'non-product');
  for (const rule of ['S3.weak-default']) {
    const before = finding({ checkId: 'S3', rule, file: 'tests/a.js' });
    const { findings, downgraded } = applyScopePolicy([before]);
    assert.equal(downgraded, 1, `${rule} 可降级`);
    assert.equal(findings[0].force, 'tip');
    assert.equal(findings[0].severity, 'high');
    assert.equal(findings[0].scope, 'non-product');
  }
});

/* ---------- 2. 语言缺口 ---------- */

test('detectLanguageGap：纯非 JS 必报；混合仓非 JS 产品代码 ≥5 才报', () => {
  assert.equal(detectLanguageGap([]), null);
  assert.equal(detectLanguageGap(['README.md', 'finalcheck.config.json']), null);
  assert.equal(detectLanguageGap(['src/app.js', 'main.py']), null, '少量非 JS 脚本不封顶结论');
  assert.equal(detectLanguageGap(['src/app.mjs']), null);
  assert.equal(detectLanguageGap(['src/app.tsx']), null);
  assert.equal(detectLanguageGap(['src/app.mts', 'main.py']), null, 'mts 也是 TS 代码');

  const py = detectLanguageGap(['main.py']);
  assert.deepEqual(py, { nonJsCount: 1, jsCount: 0, exts: ['.py'], checkIds: ['S1', 'S2', 'S7', 'Q3', 'Q4', 'Q5', 'A2', 'A3', 'A4'] });

  const mixed = detectLanguageGap(['main.py', 'models/app.php', 'C:\\proj\\Main.java', 'svc/main.go', 'lib/run.rb']);
  assert.equal(mixed.nonJsCount, 5);
  assert.equal(mixed.jsCount, 0);
  assert.deepEqual(mixed.exts, ['.go', '.java', '.php', '.py', '.rb']);
  assert.deepEqual(mixed.checkIds, ['S1', 'S2', 'S7', 'Q3', 'Q4', 'Q5', 'A2', 'A3', 'A4']);

  const mixedWithFrontend = detectLanguageGap([
    'src/app.ts',
    'backend/a.py', 'backend/b.py', 'backend/c.py', 'backend/d.py', 'backend/e.py',
  ]);
  assert.equal(mixedWithFrontend.nonJsCount, 5);
  assert.equal(mixedWithFrontend.jsCount, 1);
  assert.deepEqual(mixedWithFrontend.exts, ['.py']);
});

/* ---------- 3. 端到端：tests 路由不拦，src 路由 high/card 拦 ---------- */

test('e2e：tests/routes.test.mjs 的未守卫 Express 路由不进入产品结论，结论不为拦', async (t) => {
  const dir = await makeProject(t, {
    'package.json': JSON.stringify({
      name: 'probe', version: '1.0.0', private: true, license: 'UNLICENSED',
      scripts: { start: 'node app.js', test: 'node -e "process.exit(0)"' },
    }),
    'package-lock.json': JSON.stringify(LOCK),
    'README.md': README,
    'app.js': "const greeting = 'hello';\nconsole.log(greeting);\n",
    'tests/routes.test.mjs': UNGUARDED_ROUTE,
  });
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false });

  assert.notEqual(res.conclusion.verdict, '拦');
  const s1 = res.findings.find((f) => f.checkId === 'S1' && f.file === 'tests/routes.test.mjs');
  assert.equal(s1, undefined, '测试文件里的路由不生成产品 S1（extract-routes 跳过非产品路径）');
});

test('e2e：同一路由放 src/app.js 必须 high/card 且结论为拦', async (t) => {
  const dir = await makeProject(t, {
    'package.json': JSON.stringify({
      name: 'probe', version: '1.0.0', private: true, license: 'UNLICENSED',
      scripts: { start: 'node app.js', test: 'node -e "process.exit(0)"' },
    }),
    'package-lock.json': JSON.stringify(LOCK),
    'README.md': README,
    'src/app.js': UNGUARDED_ROUTE,
  });
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true });

  const s1 = res.findings.find((f) => f.checkId === 'S1' && f.file === 'src/app.js');
  assert.ok(s1, 'S1 必须发现 src/app.js 的未守卫路由');
  assert.equal(s1.severity, 'high');
  assert.equal(s1.force, 'card');
  assert.equal(s1.scope, undefined);
  assert.equal(res.conclusion.verdict, '拦', JSON.stringify(res.conclusion));
});

/* ---------- 4. 纯 Python 仓库：语言缺口 ---------- */

test('e2e：仅 main.py 的 FastAPI 仓——S1/S7 真解析路由，Q3-Q5 仍 unavailable', async (t) => {
  const dir = await makeProject(t, { 'main.py': FASTAPI_APP });
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false });

  // round4 起 FastAPI 路由提取已支持：S1 真执行并抓到无守卫路由，不再记 N/A 或 unavailable
  const s1 = res.findings.find((f) => f.checkId === 'S1' && f.file === 'main.py');
  assert.ok(s1, 'FastAPI 无守卫路由必须被 S1 抓到');
  assert.ok(res.gates.executed.includes('S1'), 'S1 已真执行');
  assert.equal(res.gates.gapItems.find((g) => g.checkId === 'S1'), undefined, 'S1 不再有语言缺口');

  for (const checkId of ['Q3', 'Q4', 'Q5']) {
    const gap = res.gates.gapItems.find((g) => g.checkId === checkId);
    assert.ok(gap && gap.kind === 'unavailable', `${checkId} 仍记 unavailable（JS-only 检查）`);
    assert.match(gap.reason, /\.py/, `${checkId} 的 reason 必须写实际扩展名`);
    assert.ok(!res.gates.executed.includes(checkId), `${checkId} 不能出现在 executed`);
  }
  // S2：装了 Bandit → 真执行（Python SAST）；没装 → 诚实 unavailable。两种都合格。
  const s2Gap = res.gates.gapItems.find((g) => g.checkId === 'S2');
  assert.ok(
    res.gates.executed.includes('S2') || (s2Gap && s2Gap.kind === 'unavailable'),
    'S2 必须要么真执行（Bandit）要么诚实 unavailable',
  );
  // S7：有路由 → 执行（Python handler 深度有限，check 级或缺口都是诚实态）
  assert.ok(
    res.gates.executed.includes('S7') || res.gates.gapItems.some((g) => g.checkId === 'S7'),
    'S7 必须要么执行要么记缺口',
  );
  assert.equal(res.conclusion.verdict, '无法验收');
});

test('e2e：只有 JS 项目时 S1 的 not-applicable 不被语言缺口误升级', async (t) => {
  const dir = await makeProject(t, {
    'package.json': JSON.stringify({
      name: 'probe', version: '1.0.0', private: true, license: 'UNLICENSED',
      scripts: { start: 'node app.js', test: 'node -e "process.exit(0)"' },
    }),
    'package-lock.json': JSON.stringify(LOCK),
    'README.md': README,
    'app.js': "const greeting = 'hello';\nconsole.log(greeting);\n",
  });
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true });

  const s1 = res.gates.gapItems.find((g) => g.checkId === 'S1');
  assert.ok(s1, '无 HTTP 路由时 S1 应记 N/A');
  assert.equal(s1.kind, 'not-applicable');
  assert.ok(res.notApplicable.some((g) => g.checkId === 'S1'));
  assert.ok(!res.gates.gapItems.some((g) => g.checkId === 'Q3' && g.kind === 'unavailable'));
  assert.equal(res.conclusion.verdict, '过', JSON.stringify(res.conclusion));
});

/* ---------- 5. 结论 reason 同时点名 unavailable 与待授权 ---------- */

test('conclude：S4 unavailable + Q1 unauthorized 时 verdict 仍无法验收并保留 Q1', () => {
  const gaps = [
    { checkId: 'S4', kind: 'unavailable', reason: '未发现任何 lockfile，依赖关未跑' },
    { checkId: 'Q1', kind: 'unauthorized', reason: 'Q1：未授权执行测试' },
  ];
  const res = conclude('L2', [], gaps);
  assert.equal(res.verdict, '无法验收');
  assert.match(res.reason, /另待授权：Q1/);
  assert.match(res.reason, /S4/);
  assert.deepEqual(res.pendingAuth.map((g) => g.checkId), ['Q1']);
});

test('e2e：无 lockfile + 未授权测试，audit reason 同时包含 S4 与 Q1', async (t) => {
  const dir = await makeProject(t, {
    'package.json': JSON.stringify({
      name: 'probe', version: '1.0.0', private: true, license: 'UNLICENSED',
      scripts: { start: 'node app.js', test: 'node -e "process.exit(0)"' },
    }),
    'README.md': README,
    'app.js': "const greeting = 'hello';\nconsole.log(greeting);\n",
  });
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false });

  assert.equal(res.conclusion.verdict, '无法验收');
  assert.ok(res.gates.gapItems.some((g) => g.checkId === 'S4' && g.kind === 'unavailable'));
  assert.ok(res.gates.gapItems.some((g) => g.checkId === 'Q1' && g.kind === 'unauthorized'));
  assert.match(res.conclusion.reason, /S4/);
  assert.match(res.conclusion.reason, /另待授权：Q1/);
  assert.deepEqual(res.conclusion.pendingAuth.map((g) => g.checkId), ['Q1']);
});
