import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRoutes } from '../src/extract-routes.mjs';

const fx = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
const find = (routes, p) => routes.find((r) => r.path === p);

test('result shape matches the export contract', async () => {
  const r = await extractRoutes(fx('no-guard-get'));
  // httpSurface 是新增的常驻字段（exists/hints/mounts）；无 HTTP 信号时为 exists:false
  assert.deepEqual(Object.keys(r).sort(), ['httpSurface', 'publicRoutes', 'routes', 'warnings']);
  const route = r.routes[0];
  assert.deepEqual(Object.keys(route).sort(), ['file', 'hasGuard', 'line', 'method', 'middlewares', 'path']);
  assert.ok(r.warnings.every((w) => typeof w === 'string'));
});

test('unguarded GET: hasGuard=false', async () => {
  const r = await extractRoutes(fx('no-guard-get'));
  const rt = find(r.routes, '/ping');
  assert.ok(rt, 'route /ping should be extracted');
  assert.equal(rt.method, 'get');
  assert.equal(rt.file, 'app.js');
  assert.equal(typeof rt.line, 'number');
  assert.ok(rt.line > 0);
  assert.deepEqual(rt.middlewares, []);
  assert.equal(rt.hasGuard, false);
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(r.publicRoutes, []);
});

test('route with auth middleware: hasGuard=true', async () => {
  const r = await extractRoutes(fx('guarded-get'));
  const rt = find(r.routes, '/me');
  assert.ok(rt);
  assert.deepEqual(rt.middlewares, ['auth']);
  assert.equal(rt.hasGuard, true);
});

test('router.use(path, auth) guards sub-routes via inheritance', async () => {
  const r = await extractRoutes(fx('use-guard-subroute'));
  const guarded = find(r.routes, '/api/users');
  assert.ok(guarded, 'expected /api/users');
  assert.equal(guarded.hasGuard, true);
  assert.ok(guarded.middlewares.includes('auth'));
  const open = find(r.routes, '/open');
  assert.ok(open);
  assert.equal(open.hasGuard, false);
});

test('two-level use prefixes are combined', async () => {
  const r = await extractRoutes(fx('nested-prefix'));
  const rt = find(r.routes, '/v1/users/:id');
  assert.ok(rt, 'expected /v1/users/:id');
  assert.equal(rt.method, 'get');
  assert.equal(rt.file, 'app.js');
  assert.equal(r.warnings.length, 0);
});

test('dynamic :params are preserved verbatim', async () => {
  const r = await extractRoutes(fx('dynamic-param'));
  assert.ok(find(r.routes, '/users/:id/posts/:postId'));
  assert.ok(find(r.routes, '/items/:itemId'));
  assert.equal(r.routes.length, 2);
});

test('async middlewares are named; anonymous inline ones are tolerated', async () => {
  const r = await extractRoutes(fx('async-middleware'));
  assert.deepEqual(find(r.routes, '/settings').middlewares, ['loadUser']);
  assert.deepEqual(find(r.routes, '/profile').middlewares, ['asyncHandler']);
  const inline = find(r.routes, '/data');
  assert.ok(inline, 'inline async arrow middleware must not break extraction');
  assert.equal(inline.hasGuard, false);
  assert.equal(r.routes.length, 3);
});

test('publicRoutes config hit marks route as guarded and is returned', async () => {
  const r = await extractRoutes(fx('public-config'));
  assert.deepEqual(r.publicRoutes, ['/health', '/status']);
  assert.equal(find(r.routes, '/health').hasGuard, true);
  assert.equal(find(r.routes, '/private/things').hasGuard, false);
});

test('middleware array form is flattened into the chain', async () => {
  const r = await extractRoutes(fx('middleware-array'));
  const rt = find(r.routes, '/x');
  assert.deepEqual(rt.middlewares, ['mw1', 'authBearer']);
  assert.equal(rt.hasGuard, true);
  assert.deepEqual(find(r.routes, '/y').middlewares, ['mw1', 'authBearer']);
});

test('write methods are lowercase; app.use() is not a route', async () => {
  const r = await extractRoutes(fx('write-methods'));
  assert.deepEqual(r.routes.map((x) => x.method).sort(), ['delete', 'patch', 'post', 'put']);
  assert.ok(r.routes.every((x) => x.hasGuard === false));
  assert.ok(!r.routes.some((x) => x.path === '/assets'), 'use assembly path must not become a route');
});

test('cross-file require of a sub router keeps prefix and guard', async () => {
  const r = await extractRoutes(fx('cross-file-require'));
  const byId = find(r.routes, '/users/:id');
  assert.ok(byId, 'expected /users/:id');
  assert.equal(byId.file, 'routes/users.js');
  assert.deepEqual(byId.middlewares, ['requireAuth']);
  assert.equal(byId.hasGuard, true);
  const postRoot = find(r.routes, '/users');
  assert.ok(postRoot, 'router.post("/") mounted at /users');
  assert.equal(postRoot.method, 'post');
  assert.equal(postRoot.file, 'routes/users.js');
  const healthz = find(r.routes, '/healthz');
  assert.equal(healthz.file, 'app.js');
  assert.equal(healthz.hasGuard, false);
  assert.equal(r.warnings.length, 0);
});

test('ESM default import mount works across files', async () => {
  const r = await extractRoutes(fx('esm-import-mount'));
  const rt = find(r.routes, '/api/info');
  assert.ok(rt, 'expected /api/info');
  assert.equal(rt.file, 'api.js');
  assert.deepEqual(rt.middlewares, ['verifyToken']);
  assert.equal(rt.hasGuard, true);
});

test('unparsable files fail open with warnings, valid routes still extracted', async () => {
  const r = await extractRoutes(fx('unparseable'));
  assert.ok(find(r.routes, '/ok'), 'valid file still yields routes');
  assert.ok(r.warnings.length >= 1);
  assert.ok(r.warnings.some((w) => w.includes('broken.js')));
});

test('non-Express files are pre-screened out without warnings', async () => {
  const r = await extractRoutes(fx('express-prescreen'));
  assert.ok(find(r.routes, '/ok'), 'express app still yields routes');
  assert.equal(r.warnings.length, 0, 'broken non-Express file must not warn');
});

test('parse error in an Express-referencing file still warns', async () => {
  const r = await extractRoutes(fx('unparseable'));
  assert.ok(r.warnings.some((w) => w.includes('parse error') && w.includes('broken.js')), 'express parse failure is not swallowed');
});

test('module.exports = { router } is followed via destructured require', async () => {
  const r = await extractRoutes(fx('export-object-form'));
  const rt = find(r.routes, '/admin/dashboard');
  assert.ok(rt, 'expected /admin/dashboard');
  assert.equal(rt.file, 'routes/admin.js');
  assert.deepEqual(rt.middlewares, ['ensureLoggedIn']);
  assert.equal(rt.hasGuard, true);
});

test('missing project dir fails open without throwing', async () => {
  const r = await extractRoutes(fx('does-not-exist'));
  assert.deepEqual(r.routes, []);
  assert.deepEqual(r.publicRoutes, []);
  assert.ok(r.warnings.length >= 1);
});

test('router.route() chain yields one route per method', async () => {
  const r = await extractRoutes(fx('route-chain'));
  const getRoute = find(r.routes, '/items');
  assert.ok(getRoute, 'expected GET /items from route chain');
  assert.equal(getRoute.method, 'get');
  assert.deepEqual(getRoute.middlewares, ['auth']);
  assert.equal(getRoute.hasGuard, true);
  const postRoute = r.routes.find((x) => x.path === '/items' && x.method === 'post');
  assert.ok(postRoute, 'expected POST /items from route chain');
  assert.equal(postRoute.hasGuard, false);
  const putRoute = find(r.routes, '/things/:id');
  assert.ok(putRoute, 'expected PUT /things/:id from route chain');
  assert.equal(putRoute.method, 'put');
  assert.equal(r.warnings.length, 0, 'no route-chain warnings expected');
  assert.ok(!r.warnings.some((w) => w.includes('route()')));
});

test('TypeScript files parse and factory routers mount', async () => {
  const r = await extractRoutes(fx('ts-mount'));
  const ping = find(r.routes, '/api/ping');
  assert.ok(ping, 'expected /api/ping from TS factory router');
  assert.equal(ping.file, 'routes/health.ts');
  assert.equal(ping.hasGuard, false);
  const status = find(r.routes, '/api/status');
  assert.ok(status);
  assert.deepEqual(status.middlewares, ['sessionGuard']);
  assert.equal(status.hasGuard, true);
  assert.ok(!r.warnings.some((w) => w.includes('unexpected analysis failure')), 'no walker crash on TS');
});

test('TS .js-suffix import resolves to the .ts file', async () => {
  const r = await extractRoutes(fx('js-to-ts-import'));
  const rt = find(r.routes, '/lib/data');
  assert.ok(rt, 'expected /lib/data via "./lib/routes.js" -> routes.ts');
  assert.equal(rt.file, 'lib/routes.ts');
  assert.deepEqual(rt.middlewares, ['requireAuth']);
  assert.equal(rt.hasGuard, true);
  assert.ok(!r.warnings.some((w) => w.includes('cannot resolve')), 'no unresolvable-import warning');
  assert.equal(r.warnings.length, 0);
});

test('export default router + pathless app.use(router) mounts', async () => {
  const r = await extractRoutes(fx('export-default-mount'));
  const rt = find(r.routes, '/alive');
  assert.ok(rt, 'expected /alive');
  assert.equal(rt.file, 'api.js');
  assert.equal(rt.hasGuard, false);
  assert.ok(!r.warnings.some((w) => w.includes('never mounted')), 'no never-mounted warning');
  assert.equal(r.warnings.length, 0);
});

test('router factory function mounted via call expression', async () => {
  const r = await extractRoutes(fx('factory-mount'));
  const byId = find(r.routes, '/users/:id');
  assert.ok(byId, 'expected /users/:id from factory router');
  assert.equal(byId.file, 'routes/users.js');
  assert.deepEqual(byId.middlewares, ['requireAuth']);
  assert.equal(byId.hasGuard, true);
  const postRoot = find(r.routes, '/users');
  assert.ok(postRoot, 'expected POST /users from factory router');
  assert.equal(postRoot.method, 'post');
  assert.equal(postRoot.hasGuard, false);
  assert.ok(!r.warnings.some((w) => w.includes('never mounted')), 'no never-mounted warning');
  assert.equal(r.warnings.length, 0);
});

test('Playwright-style page.route(glob, handler) is not flagged or extracted', async () => {
  const r = await extractRoutes(fx('route-chain'));
  assert.ok(r.routes.every((x) => !x.path.includes('*')), 'glob mocks must not become routes');
});

