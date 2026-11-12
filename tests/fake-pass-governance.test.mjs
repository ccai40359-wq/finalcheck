import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { isGuardName, checkAuthCoverage } from '../src/checks/routes.mjs';
import { scanIpc } from '../src/checks/ipc.mjs';
import { checkAuthz } from '../src/checks/authz.mjs';
import { extractRoutes } from '../src/extract-routes.mjs';
import { audit, conclude, dimensionVerdict, gapKind } from '../src/audit.mjs';
import { renderReport } from '../src/report.mjs';

// 「假通过治理」三件事的回归：
//   1) S1 守卫名按词边界识别（author/sessionStore/loginLimiter/authRoutes 不再算守卫）；
//   2) Electron ipcMain.handle/on 纳入 S7 权限面扫描；
//   3) 无 HTTP 也无 IPC 时记 not-applicable（不封顶），报告仍必须点名未验证。

const LOCK = {
  name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'probe', version: '1.0.0', license: 'UNLICENSED' } },
};
const README = [
  '# Probe project',
  '',
  'Minimal Node.js project used by FinalCheck fake-pass governance tests. To install, run:',
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
].join('\n');

async function tmpDir(t, prefix = 'fc-fake-pass-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }
}

async function makeDesktopProject(t, ipcSource) {
  const dir = await tmpDir(t);
  const files = {
    'package.json': JSON.stringify({
      name: 'probe', version: '1.0.0', private: true, license: 'UNLICENSED',
      scripts: { start: 'node app.js', test: 'node -e "process.exit(0)"' },
    }),
    'package-lock.json': JSON.stringify(LOCK),
    'README.md': README,
    'app.js': "const greeting = 'hello';\nconsole.log(greeting);\n",
    'desktop/src/main/main.mjs': ipcSource,
  };
  await writeFiles(dir, files);
  return dir;
}

const IPC_UNSAFE = [
  "import { ipcMain } from 'electron';",
  "ipcMain.handle('finalcheck:unsafe', async (_e, p) => p);",
  "ipcMain.handle('finalcheck:safe-artifact', async (_e, p) => { assertArtifactPath(p); return p; });",
  "ipcMain.handle('finalcheck:safe-zod', async (_e, payload) => schema.parse(payload));",
].join('\n');

/* ---------- 1. 守卫名识别：词边界，不是裸子串 ---------- */

test('isGuardName: 真守卫名命中（camelCase / 表达式 / 全小写连写）', () => {
  const hits = [
    'requireAuth', 'authMiddleware', 'authenticate', 'authorize', 'checkAuth',
    'verifyToken', 'ensureLoggedIn', 'isLoggedIn', 'isAuthenticated',
    'passport.authenticate', "passport.authenticate('jwt')", 'jwt',
    'requireLogin', 'loginRequired', 'authGuard', 'sessionAuth',
    "require('./auth')", "require('../middleware/auth')", 'checkToken',
  ];
  for (const name of hits) assert.equal(isGuardName(name), true, `${name} 应该算守卫`);
});

test('isGuardName: 作者/存储/限流器/路由表不是守卫（旧裸子串的假阳性）', () => {
  const misses = [
    'author', 'sessionStore', 'loginLimiter', 'authRoutes', 'authenticationRoutes',
    'authorName', 'authController', 'authRouter', 'tokenStore', 'loginPage', 'session',
  ];
  for (const name of misses) assert.equal(isGuardName(name), false, `${name} 不能算守卫`);
  assert.equal(isGuardName(null), false);
  assert.equal(isGuardName(''), false);
});

/* ---------- 2. S1：重新判定守卫，假通过不再判过 ---------- */

test('S1 用 isGuardName 重判 middlewares：author/sessionStore/loginLimiter/authRoutes 都会被报', async () => {
  const r = await checkAuthCoverage({
    routes: [
      { method: 'get', path: '/authors', file: 'routes.js', line: 1, middlewares: ['author'], hasGuard: true },
      { method: 'get', path: '/session-store', file: 'routes.js', line: 2, middlewares: ['sessionStore'], hasGuard: true },
      { method: 'get', path: '/login-attempt', file: 'routes.js', line: 3, middlewares: ['loginLimiter'], hasGuard: true },
      { method: 'get', path: '/route-table', file: 'routes.js', line: 4, middlewares: ['authRoutes'], hasGuard: true },
      { method: 'get', path: '/authentication', file: 'routes.js', line: 5, middlewares: ['authenticationRoutes'], hasGuard: true },
      { method: 'get', path: '/protected-1', file: 'routes.js', line: 6, middlewares: ['requireAuth'], hasGuard: false },
      { method: 'get', path: '/protected-2', file: 'routes.js', line: 7, middlewares: ['authMiddleware'], hasGuard: false },
      { method: 'get', path: '/protected-3', file: 'routes.js', line: 8, middlewares: ['passport.authenticate'], hasGuard: false },
      { method: 'get', path: '/protected-4', file: 'routes.js', line: 9, middlewares: ['sessionAuth'], hasGuard: false },
      { method: 'get', path: '/public', file: 'routes.js', line: 10, middlewares: [], hasGuard: false },
    ],
    publicRoutes: ['/public'],
  });
  assert.equal(r.coverageGap, null);
  assert.deepEqual(r.findings.map((f) => f.snippet).sort(), [
    'GET /authentication', 'GET /authors', 'GET /login-attempt', 'GET /route-table', 'GET /session-store',
  ]);
  assert.ok(r.findings.every((f) => f.rule === 'S1.no-guard' && f.severity === 'high' && f.force === 'card'));
});

test('Express 提取器与 S1 都拒绝只调用 next 的伪守卫', async (t) => {
  const dir = await tmpDir(t);
  await writeFiles(dir, {
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      'const author = (req, res, next) => next();',
      'const sessionStore = (req, res, next) => next();',
      'const loginLimiter = (req, res, next) => next();',
      'const authRoutes = (req, res, next) => next();',
      "app.get('/authors', author, (req, res) => res.send('ok'));",
      "app.get('/session-store', sessionStore, (req, res) => res.send('ok'));",
      "app.get('/login-attempt', loginLimiter, (req, res) => res.send('ok'));",
      "app.get('/route-table', authRoutes, (req, res) => res.send('ok'));",
      'module.exports = app;',
    ].join('\n'),
  });
  const raw = await extractRoutes(dir);
  assert.ok(raw.routes.length >= 4);
  // 已知本地空守卫连提取结果也不标成有保护；S1 仍独立重判。
  assert.ok(raw.routes.every((r) => r.hasGuard === false), '空守卫不能显示成已有保护');
  const r = await checkAuthCoverage(raw);
  assert.deepEqual(r.findings.map((f) => f.snippet).sort(), [
    'GET /authors', 'GET /login-attempt', 'GET /route-table', 'GET /session-store',
  ]);
  assert.equal(r.coverageGap, null);
});

/* ---------- 3. IPC 权限面扫描 ---------- */

test('scanIpc: 3 个 handler 只有无校验的一条报 finding', async (t) => {
  const dir = await makeDesktopProject(t, IPC_UNSAFE);
  const scan = await scanIpc(dir);
  assert.equal(scan.handlers.length, 3);
  assert.equal(scan.findings.length, 1);
  const [f] = scan.findings;
  assert.equal(f.checkId, 'S7');
  assert.equal(f.rule, 'S7.ipc-no-validation');
  assert.equal(f.severity, 'medium');
  assert.equal(f.force, 'check');
  assert.equal(f.source, 'program');
  assert.equal(f.file, 'desktop/src/main/main.mjs');
  assert.ok(f.line >= 1);
  assert.match(f.snippet, /finalcheck:unsafe/);
  assert.match(f.message, /IPC 通道未检出参数\/路径校验/);
  assert.match(f.message, /finalcheck:allow/);
  assert.equal(scan.handlers.find((h) => h.channel === 'finalcheck:safe-artifact').validated, true);
  assert.equal(scan.handlers.find((h) => h.channel === 'finalcheck:safe-zod').validated, true);
  assert.deepEqual(scan.warnings, []);
});

test('scanIpc: typeof 参数检查算校验；ipcMain.on 也纳入权限面', async (t) => {
  const dir = await makeDesktopProject(t, [
    "import { ipcMain } from 'electron';",
    "ipcMain.on('typed', (_e, payload) => { if (typeof payload !== 'object') throw new Error('bad'); });",
    "ipcMain.on('unchecked', (_e, payload) => payload);",
  ].join('\n'));
  const scan = await scanIpc(dir);
  assert.equal(scan.handlers.length, 2);
  assert.equal(scan.findings.length, 1);
  assert.equal(scan.findings[0].rule, 'S7.ipc-no-validation');
  assert.match(scan.findings[0].snippet, /unchecked/);
});

test('scanIpc: handler 是文件内函数引用时可解析；外部变量引用只给 warning 不猜', async (t) => {
  const dir = await makeDesktopProject(t, [
    "import { ipcMain } from 'electron';",
    "ipcMain.handle('local-safe', handlerFn);",
    'function handlerFn(_e, p) { return assertArtifactPath(p); }',
    "ipcMain.handle('external', externalHandler);",
  ].join('\n'));
  const scan = await scanIpc(dir);
  assert.equal(scan.handlers.length, 2);
  assert.equal(scan.handlers.find((h) => h.channel === 'local-safe').validated, true);
  assert.equal(scan.findings.length, 0, '解析不了的引用不能猜成无校验');
  assert.ok(scan.warnings.some((w) => w.includes('external') && w.includes('变量引用 externalHandler')));
});

test('scanIpc: 跳过 out/dist/release*/node_modules 里的打包副本', async (t) => {
  const dir = await tmpDir(t);
  const handler = "ipcMain.handle('dup', async (_e, p) => p);";
  await writeFiles(dir, {
    'desktop/src/main/main.mjs': "import { ipcMain } from 'electron';\nipcMain.handle('real', async (_e, p) => p);\n",
    'desktop/out/main/index.js': handler,
    'desktop/dist/main/index.js': handler,
    'desktop/release-0110/resources/app/main.mjs': handler,
    'node_modules/pkg/main.js': handler,
  });
  const scan = await scanIpc(dir);
  assert.equal(scan.handlers.length, 1, '只有 desktop/src/main 的真实注册被算进权限面');
  assert.equal(scan.handlers[0].channel, 'real');
  assert.equal(scan.findings.length, 1);
});

test('scanIpc: 非 Electron 项目零 findings（不算 gap）', async (t) => {
  const dir = await tmpDir(t);
  await writeFiles(dir, { 'app.js': "console.log('hello');\n" });
  const scan = await scanIpc(dir);
  assert.deepEqual(scan.handlers, []);
  assert.deepEqual(scan.findings, []);
  assert.deepEqual(scan.warnings, []);
});

/* ---------- 4. S7 判定顺序：HTTP → IPC → not-applicable ---------- */

test('S7 无 HTTP 但有 IPC handler：跑 IPC 检查，coverageGap=null', async (t) => {
  const dir = await makeDesktopProject(t, IPC_UNSAFE);
  const r = await checkAuthz(dir, { tier: 'L3', routeResult: { routes: [], publicRoutes: [], warnings: [] } });
  assert.equal(r.coverageGap, null, '有 IPC 权限面就不是「没查」');
  assert.equal(r.gapKind, undefined);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'S7.ipc-no-validation');
  assert.equal(r.findings[0].force, 'check', 'v1 不做 card');
});

test('S7 有 HTTP 路由但没有目标路由时，仍会补查 IPC 权限面', async (t) => {
  const dir = await makeDesktopProject(t, IPC_UNSAFE);
  const r = await checkAuthz(dir, {
    tier: 'L3',
    routeResult: { routes: [{ method: 'get', path: '/health', file: 'app.js', line: 1 }], publicRoutes: [], warnings: [] },
  });
  assert.equal(r.coverageGap, null);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'S7.ipc-no-validation');
});

test('S7 无 HTTP 且有 IPC 但全部有校验：coverageGap=null 且零 findings', async (t) => {
  const dir = await makeDesktopProject(t, [
    "import { ipcMain } from 'electron';",
    "ipcMain.handle('safe', async (_e, p) => { assertArtifactPath(p); return p; });",
  ].join('\n'));
  const r = await checkAuthz(dir, { tier: 'L3', routeResult: { routes: [], publicRoutes: [], warnings: [] } });
  assert.equal(r.coverageGap, null);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.warnings, []);
});

test('S7 两者都没有 → gapKind not-applicable，文案点名不适用', async (t) => {
  const dir = await tmpDir(t);
  await writeFiles(dir, { 'app.js': 'console.log(1);\n' });
  const r = await checkAuthz(dir, { tier: 'L3', routeResult: { routes: [], publicRoutes: [], warnings: [] } });
  assert.equal(r.gapKind, 'not-applicable');
  assert.match(String(r.coverageGap), /未发现 HTTP 路由或 IPC 权限面/);
  assert.match(String(r.coverageGap), /不适用/);
  assert.deepEqual(r.findings, []);
});

test('S1 无 HTTP 路由 → gapKind not-applicable（IPC 由 S7 覆盖）', async () => {
  const r = await checkAuthCoverage({ routes: [], publicRoutes: [] });
  assert.equal(r.gapKind, 'not-applicable');
  assert.match(String(r.coverageGap), /S1 鉴权覆盖不适用/);
  assert.match(String(r.coverageGap), /S7/);
});

/* ---------- 5. 结论引擎：N/A 不封顶、不算待授权 ---------- */

test('gapKind 接受 not-applicable；conclude 只有 N/A 时按 findings 判，不再无法验收', () => {
  const na = [{ checkId: 'S7', kind: 'not-applicable', reason: '没有 HTTP 路由也没有 IPC' }];
  assert.equal(gapKind({ checkId: 'S7', gapKind: 'not-applicable', coverageGap: 'x' }), 'not-applicable');
  assert.equal(conclude('L3', [], na).verdict, '过');
  assert.equal(conclude('L2', [], na).verdict, '过');
  assert.equal(conclude('L2', [{ checkId: 'S3', severity: 'high', force: 'card' }], na).verdict, '拦');
  const pending = [{ checkId: 'Q1', kind: 'unauthorized', reason: '未授权执行测试' }];
  assert.equal(conclude('L2', [], [...na, ...pending]).verdict, '待授权');
  assert.equal(conclude('L2', [], [...na, ...pending]).pendingAuth.length, 1, 'N/A 不能混进待授权清单');
});

test('dimensionVerdict 忽略 N/A：其余都过 → 过；有卡项仍按 findings 判', () => {
  const na = [{ checkId: 'S7', kind: 'not-applicable', reason: '不适用' }];
  const dim = { implemented: true, checks: ['S7'], level: 'L2' };
  assert.equal(dimensionVerdict(dim, [], na), '过');
  const dimRisk = { implemented: true, checks: ['S3', 'S7'], level: 'L2' };
  assert.equal(dimensionVerdict(dimRisk, [{ checkId: 'S3', severity: 'high', force: 'card' }], na), '拦');
  const dimAuth = { implemented: true, checks: ['Q1', 'S7'], level: 'L2' };
  assert.equal(dimensionVerdict(dimAuth, [], [...na, { checkId: 'Q1', kind: 'unauthorized', reason: '未授权' }]), '待授权');
});

test('check 级中/高危是「需人工确认」，维度不能写成「过」', () => {
  const dim = { implemented: true, checks: ['S7'], level: 'L2' };
  assert.equal(dimensionVerdict(dim, [{ checkId: 'S7', severity: 'medium', force: 'check' }], []), '修完再过');
  assert.equal(dimensionVerdict(dim, [{ checkId: 'S7', severity: 'high', force: 'check' }], []), '修完再过');
  assert.equal(dimensionVerdict(dim, [{ checkId: 'S7', severity: 'low', force: 'check' }], []), '过');
});

/* ---------- 6. audit + 报告文本 ---------- */

test('audit 桌面项目：S1 记 N/A，S7 跑 IPC，结论不再被「无法验收」封顶', async (t) => {
  const dir = await makeDesktopProject(t, IPC_UNSAFE);
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true, sources: { code: '.' } });
  assert.notEqual(res.conclusion.verdict, '无法验收', 'N/A 不是能力缺失，不能封顶结论');
  assert.ok(res.notApplicable.some((g) => g.checkId === 'S1'), 'notApplicable 必须列出 S1');
  assert.ok(!res.notApplicable.some((g) => g.checkId === 'S7'), 'S7 有 IPC 可查，不该是 N/A');
  assert.ok(res.findings.some((f) => f.rule === 'S7.ipc-no-validation'));
  assert.equal(res.tier.dimensions.安全性.verdict === '无法验收', false);

  const text = renderReport(res);
  const safetyRow = text.split('\n').find((l) => l.startsWith('| 安全性 |'));
  assert.ok(safetyRow, '报告必须有安全性维度行');
  assert.match(safetyRow, /不适用：S1/, 'N/A 在维度表里显示「不适用」，不能写「未跑」');
  assert.doesNotMatch(safetyRow, /未跑：S1/);
  const notCovered = text.slice(text.indexOf('## Not covered'), text.indexOf('## Skipped'));
  assert.match(notCovered, /- S1 不适用：.*（该项未验证，需人工确认）/);
  const skipped = text.slice(text.indexOf('## Skipped'));
  assert.match(skipped, /S1：.*（不适用，未验证）/);
  assert.doesNotMatch(skipped, /S1：.*能力缺失/);
});

test('旧格式报告（无 profile）：N/A 进 Not covered，不再写成覆盖不足', async () => {
  const res = {
    projectDir: 'D:/demo/desktop',
    tier: { requested: 'L2', suggested: 'L2', effective: 'L2', signals: [], conservativeNote: null },
    gates: {
      planned: ['S1', 'S3'],
      executed: ['S3'],
      gaps: ['S1：只有桌面 IPC，没有 HTTP 路由'],
      gapItems: [{ checkId: 'S1', kind: 'not-applicable', reason: '只有桌面 IPC，没有 HTTP 路由' }],
    },
    findings: [],
    conclusion: { verdict: '过', reason: 'L2 全部卡条目通过' },
    warnings: [],
    notApplicable: [{ checkId: 'S1', reason: '只有桌面 IPC，没有 HTTP 路由' }],
  };
  const text = renderReport(res);
  assert.match(text, /本轮覆盖：S3；不适用：S1/);
  assert.doesNotMatch(text, /未跑：S1/);
  assert.match(text, /ℹ️ 不适用：S1：只有桌面 IPC，没有 HTTP 路由/);
  assert.doesNotMatch(text, /⚠️ 覆盖不足：S1/);
  const notCovered = text.slice(text.indexOf('## Not covered'));
  assert.match(notCovered, /- S1 不适用：只有桌面 IPC，没有 HTTP 路由（该项未验证，需人工确认）/);
});
