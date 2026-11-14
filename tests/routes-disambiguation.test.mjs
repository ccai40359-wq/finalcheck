import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractRoutes } from '../src/extract-routes.mjs';
import { checkAuthCoverage, isGuardName } from '../src/checks/routes.mjs';
import { checkAuthz } from '../src/checks/authz.mjs';
import { checkExternal } from '../src/checks/external.mjs';

async function fixture(t, files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-routes-disambiguation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);
const bySnippet = (findings, snippet) => findings.find((f) => f.snippet === snippet);

/* ---------- A. Express 配置 getter 不是路由 ---------- */

test('app.get(env/port/...) 配置 getter 不进路由表，app.get(/env, h) 进', async (t) => {
  const dir = await fixture(t, {
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      'const h = (req, res) => res.end("ok");',
      "app.get('env');",
      "app.get('port');",
      "app.get('host');",
      "app.get('trust proxy');",
      "app.get('/env', h);",
    ].join('\n'),
  });
  const raw = await extractRoutes(dir);
  assert.deepEqual(raw.routes.map((r) => r.path), ['/env']);
  assert.ok(!raw.routes.some((r) => r.path === 'env' || r.path === 'port' || r.path === 'trust proxy'));
});

/* ---------- B. 成员表达式守卫只判最后一段 ---------- */

test('isGuardName：成员表达式的最后一段才算守卫，容器词只否决该段', () => {
  for (const name of ['routes.isLoggedIn', 'router.authMiddleware', 'passport.authenticate(\'jwt\')', "require('./auth')"]) {
    assert.equal(isGuardName(name), true, `${name} 应该算守卫`);
  }
  for (const name of ['authRoutes', 'loginLimiter', 'router.author', 'sessionStore']) {
    assert.equal(isGuardName(name), false, `${name} 不能算守卫`);
  }
});

test('middlewares：routes.isLoggedIn/router.authMiddleware 不报，authRoutes/loginLimiter/router.author 报 high/card', async () => {
  const routes = [
    { method: 'get', path: '/admin/users', file: 'routes.js', line: 1, middlewares: ['routes.isLoggedIn'], hasGuard: false },
    { method: 'get', path: '/orders/:id', file: 'routes.js', line: 2, middlewares: ['router.authMiddleware'], hasGuard: false },
    { method: 'get', path: '/a', file: 'routes.js', line: 3, middlewares: ['authRoutes'], hasGuard: false },
    { method: 'get', path: '/b', file: 'routes.js', line: 4, middlewares: ['loginLimiter'], hasGuard: false },
    { method: 'get', path: '/c', file: 'routes.js', line: 5, middlewares: ['router.author'], hasGuard: false },
  ];
  const r = await checkAuthCoverage({ routes, publicRoutes: [], warnings: [] });
  assert.equal(r.findings.length, 3);
  assert.deepEqual(r.findings.map((f) => f.snippet).sort(), ['GET /a', 'GET /b', 'GET /c']);
  assert.ok(r.findings.every((f) => f.severity === 'high' && f.force === 'card'));
  assert.ok(!bySnippet(r.findings, 'GET /admin/users'));
  assert.ok(!bySnippet(r.findings, 'GET /orders/:id'));
});

/* ---------- C. 公开端点按段降噪，同前缀敏感路径不误降 ---------- */

test('常见公开端点 → medium/check；/docs-internal、/healthcheck-admin、/admin/users、/orders/:id → high/card', async () => {
  const publicPaths = [
    '/health', '/healthz', '/ready', '/readiness', '/live', '/liveness',
    '/ping', '/status', '/version', '/metrics', '/docs', '/openapi', '/swagger',
    '/api-docs', '/login', '/logout', '/register', '/signup', '/auth/token',
  ];
  const sensitivePaths = ['/docs-internal', '/healthcheck-admin', '/admin/users', '/orders/:id'];
  const routes = [...publicPaths, ...sensitivePaths].map((p, i) => ({
    method: 'get', path: p, file: 'routes.js', line: i + 1, middlewares: [], hasGuard: false,
  }));
  const r = await checkAuthCoverage({ routes, publicRoutes: [], warnings: [] });
  for (const p of publicPaths) {
    const f = bySnippet(r.findings, `GET ${p}`);
    assert.ok(f, `${p} 仍应产生 finding`);
    assert.equal(f.severity, 'medium', `${p} 应降为 medium`);
    assert.equal(f.force, 'check', `${p} 应降为 check`);
    assert.match(f.message, /常见公开接口/);
    assert.match(f.message, /publicRoutes/);
  }
  for (const p of sensitivePaths) {
    const f = bySnippet(r.findings, `GET ${p}`);
    assert.ok(f, `${p} 必须报`);
    assert.equal(f.severity, 'high', `${p} 不能被误降`);
    assert.equal(f.force, 'card', `${p} 不能被误降`);
  }
});

/* ---------- D. 空路由表的 not-applicable vs unavailable ---------- */

test('只有普通 app.js、没有任何 HTTP 信号 → S1 not-applicable', async (t) => {
  const dir = await fixture(t, { 'app.js': "console.log('no http surface');\n" });
  const raw = await extractRoutes(dir);
  assert.equal(raw.httpSurface.exists, false, '无 HTTP 信号时 exists=false');
  assert.deepEqual(raw.httpSurface.hints, []);
  const s1 = await checkAuthCoverage(raw);
  assert.equal(s1.gapKind, 'not-applicable');
  assert.match(String(s1.coverageGap), /路由表为空/);
});

test('http.createServer 但无路由表 → S1/S7 unavailable', async (t) => {
  const dir = await fixture(t, {
    'server.js': [
      "import { createServer } from 'node:http';",
      "const server = createServer((req, res) => res.end('ok'));",
      'server.listen(3000);',
    ].join('\n'),
  });
  const raw = await extractRoutes(dir);
  assert.equal(raw.httpSurface.exists, true);
  assert.ok(raw.httpSurface.hints.includes('node:http'));
  const s1 = await checkAuthCoverage(raw);
  assert.equal(s1.gapKind, 'unavailable');
  assert.match(String(s1.coverageGap), /检测到 HTTP 服务\/路由注册/);
  assert.match(String(s1.coverageGap), /未解析出路由表/);
  const s7 = await checkAuthz(dir, { tier: 'L3', routeResult: raw });
  assert.equal(s7.gapKind, 'unavailable');
  assert.match(String(s7.coverageGap), /未覆盖/);
});

test('table.set(route.path 但无路由表 → S1 unavailable', async (t) => {
  const dir = await fixture(t, {
    'registry.js': [
      'const table = new Map();',
      'table.set(route.path, route);',
    ].join('\n'),
  });
  const raw = await extractRoutes(dir);
  assert.equal(raw.httpSurface.exists, true);
  assert.ok(raw.httpSurface.hints.includes('table.set(route.path'));
  const s1 = await checkAuthCoverage(raw);
  assert.equal(s1.gapKind, 'unavailable');
});

test('FastAPI 路由已支持（S1 真跑）；Java Spring 仍 unsupported → S1 unavailable', async (t) => {
  const dir = await fixture(t, {
    'main.py': [
      'from fastapi import FastAPI',
      'app = FastAPI()',
      '@app.get("/items/{item_id}")',
      'def read_item(item_id: int):',
      '    return {"item_id": item_id}',
    ].join('\n'),
    'UserController.java': [
      '@RestController',
      'public class UserController {',
      '  @GetMapping("/users")',
      '  public List<User> users() { return null; }',
      '}',
    ].join('\n'),
  });
  const raw = await extractRoutes(dir);
  // FastAPI 路由已真提取（round4），不再标 unsupported
  assert.ok(raw.routes.some((r) => r.path === '/items/{item_id}'), 'FastAPI 路由必须提取');
  assert.ok(!raw.unsupportedFrameworks?.includes('FastAPI'), 'FastAPI 已支持');
  assert.ok(raw.unsupportedFrameworks?.includes('Spring'), 'Spring 仍 unsupported');
  const s1 = await checkAuthCoverage(raw);
  // Spring 存在 → S1 仍记 unavailable（混合框架，路由表不完整）；但 FastAPI 路由本身已被提取。
  // 注意：routes 非空时 checkAuthCoverage 只回 coverageGap，gapKind 由 audit 的 gapKind(r) 归一化。
  assert.match(String(s1.coverageGap), /Spring/);
  const s7 = await checkAuthz(dir, { tier: 'L3', routeResult: raw });
  // S7：路由文件（.py/.java）无法被 JS AST 解析 → 诚实记缺口（gapKind 或 coverageGap 形态均可）
  assert.ok(s7.gapKind === 'unavailable' || (s7.coverageGap && s7.findings.length === 0), 'S7 必须诚实记缺口');
});

/* ---------- E. NodeGoat 形态：路由模块导出函数并嵌套挂载 ---------- */

test('NodeGoat 形态（routes(app) 嵌套挂载）→ httpSurface.exists=true，S1/S7 unavailable', async (t) => {
  const dir = await fixture(t, {
    'app.js': [
      "const express = require('express');",
      "const routes = require('./routes');",
      'const app = express();',
      'require(\'./routes\')(app, {});',
    ].join('\n'),
    'routes/index.js': [
      'module.exports = (app, db) => {',
      '  app.get(\'/allocations/:userId\', (req, res) => res.json([]));',
      '};',
    ].join('\n'),
  });
  const raw = await extractRoutes(dir);
  assert.equal(raw.routes.length, 0, '该形态当前不解析路由表');
  assert.equal(raw.httpSurface.exists, true);
  assert.ok(raw.httpSurface.mounts.some((m) => m.includes("require('./routes')")));
  const s1 = await checkAuthCoverage(raw);
  assert.equal(s1.gapKind, 'unavailable', '不得再记 not-applicable');
  assert.match(String(s1.coverageGap), /未解析出路由表/);
  const s7 = await checkAuthz(dir, { tier: 'L3', routeResult: raw });
  assert.equal(s7.gapKind, 'unavailable', 'S7 不得再记 not-applicable');
});

/* ---------- F. S6 CORS 同块才报 ---------- */

test('S6 跨代码块 origin:* / credentials:true 不报；同一对象块内才报', async (t) => {
  const baseApp = [
    "const express = require('express');",
    'const app = express();',
    "app.get('/items/:id', (req, res) => res.json({ ok: true }));",
  ].join('\n');

  const crossDir = await fixture(t, {
    'app.js': baseApp,
    'cors-cross.js': [
      "const corsOptions = { origin: '*' };",
      'app.use(cors({ credentials: true }));',
    ].join('\n'),
  });
  const cross = await checkExternal(crossDir, { tier: 'L2' });
  assert.deepEqual(byRule(cross.findings, 'S6.cors-wildcard-credentials'), [], '跨块拼凑不得报');

  const sameDir = await fixture(t, {
    'app.js': baseApp,
    'cors-same.js': [
      'app.use(cors({',
      "  origin: '*',",
      '  credentials: true,',
      '}));',
    ].join('\n'),
  });
  const same = await checkExternal(sameDir, { tier: 'L2' });
  const hits = byRule(same.findings, 'S6.cors-wildcard-credentials');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'cors-same.js');
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].severity, 'high');
  assert.equal(hits[0].force, 'card');
});

test('S6 路由表为空但 HTTP 面存在 → coverageGap unavailable', async (t) => {
  const dir = await fixture(t, {
    'server.js': [
      "import { createServer } from 'node:http';",
      "const server = createServer((req, res) => res.end('ok'));",
    ].join('\n'),
  });
  const r = await checkExternal(dir, { tier: 'L3' });
  assert.ok(r.coverageGap, '不能只给 warning');
  assert.equal(r.gapKind, 'unavailable');
  assert.match(String(r.coverageGap), /webhook/);
  assert.match(String(r.coverageGap), /未覆盖/);
});

test('S6 不把带 routes.isLoggedIn 的 webhook 当公开入口', async (t) => {
  const dir = await fixture(t, {
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      'const routes = { isLoggedIn: (req, res, next) => next() };',
      "app.post('/webhook/stripe', routes.isLoggedIn, (req, res) => res.send('ok'));",
    ].join('\n'),
  });
  const raw = await extractRoutes(dir);
  const route = raw.routes.find((r) => r.path === '/webhook/stripe');
  assert.ok(route, 'route should be extracted');
  assert.deepEqual(route.middlewares, ['routes.isLoggedIn']);
  const s6 = await checkExternal(dir, { tier: 'L3' });
  assert.deepEqual(byRule(s6.findings, 'S6.webhook-no-verify'), []);
  const s1 = await checkAuthCoverage(raw);
  assert.deepEqual(s1.findings, [], 'routes.isLoggedIn 应算守卫');
});

/* ---------- G. 降噪不吞真问题 ---------- */

test('真实 Express app.get(/items/:id, handler) 无守卫 → 仍 high/card', async (t) => {
  const dir = await fixture(t, {
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      "app.get('/items/:id', (req, res) => res.json({ ok: true }));",
    ].join('\n'),
  });
  const raw = await extractRoutes(dir);
  const route = raw.routes.find((r) => r.path === '/items/:id');
  assert.ok(route);
  const s1 = await checkAuthCoverage(raw);
  const hit = bySnippet(s1.findings, 'GET /items/:id');
  assert.ok(hit, 'true unguarded route must still be flagged');
  assert.equal(hit.severity, 'high');
  assert.equal(hit.force, 'card');
  const s7 = await checkAuthz(dir, { tier: 'L2', routeResult: raw });
  assert.ok(s7.findings.some((f) => f.rule === 'S7.no-owner-filter' && f.snippet === 'GET /items/:id'));
});
