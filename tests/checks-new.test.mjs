import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInject } from '../src/checks/inject.mjs';
import { checkAuthCoverage } from '../src/checks/routes.mjs';
import { checkAuthz } from '../src/checks/authz.mjs';
import { checkPassword } from '../src/checks/password.mjs';
import { extractRoutes } from '../src/extract-routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => path.join(here, 'fixtures', name);
const srcDir = path.join(here, '..', 'src');
const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);

/* ---------- S2 注入 ---------- */

test('S2 result shape matches the checks contract', async () => {
  const r = await checkInject(fx('inject-sqli'), { tier: 'L2' });
  assert.deepEqual(Object.keys(r).sort(), ['checkId', 'coverageGap', 'findings', 'warnings']);
  assert.equal(r.checkId, 'S2');
  assert.equal(r.coverageGap, null);
  assert.ok(r.findings.length >= 1);
  const f = r.findings[0];
  assert.deepEqual(Object.keys(f).sort(), ['checkId', 'file', 'force', 'line', 'message', 'rule', 'severity', 'snippet', 'source']);
  assert.equal(f.source, 'program');
  assert.ok(r.warnings.every((w) => typeof w === 'string'));
});

test('S2 sqli: concatenated SQL flagged, parameterized control clean', async () => {
  const r = await checkInject(fx('inject-sqli'), { tier: 'L2' });
  const hits = byRule(r.findings, 'S2.sqli-concat');
  assert.equal(hits.length, 2);
  assert.ok(hits.every((f) => f.file === 'bad.js' && f.severity === 'high' && f.force === 'card'));
  assert.deepEqual(hits.map((f) => f.line).sort((a, b) => a - b), [4, 8]);
  assert.ok(r.findings.every((f) => f.file !== 'ok.js'), 'parameterized and allow-exempt lines must not be flagged');
});

test('S2 force follows tier: L1 check, L2/L3 card; severity stays high', async () => {
  const l1 = await checkInject(fx('inject-sqli'), { tier: 'L1' });
  assert.ok(l1.findings.length >= 1 && l1.findings.every((f) => f.force === 'check' && f.severity === 'high'));
  const l2 = await checkInject(fx('inject-sqli'), { tier: 'L2' });
  assert.ok(l2.findings.every((f) => f.force === 'card'));
  const l3 = await checkInject(fx('inject-sqli'), { tier: 'L3' });
  assert.ok(l3.findings.every((f) => f.force === 'card'));
});

test('S2 finalcheck:allow exempts the flagged line', async () => {
  const r = await checkInject(fx('inject-sqli'), { tier: 'L2' });
  assert.ok(!r.findings.some((f) => f.file === 'ok.js' && f.line === 7), 'allow-comment line must be exempt');
});

test('S2 excludes take effect', async () => {
  const r = await checkInject(fx('inject-sqli'), { tier: 'L2', excludes: ['bad.js'] });
  assert.deepEqual(r.findings, []);
});

test('S2 cmdi and eval rules hit exec interpolation and eval/new Function', async () => {
  const r = await checkInject(fx('inject-exec'), { tier: 'L3' });
  assert.equal(byRule(r.findings, 'S2.cmdi').length, 2, 'both shell-command interpolation hits');
  assert.equal(byRule(r.findings, 'S2.eval-dynamic').length, 2, 'eval concat and new Function concat');
  assert.ok(r.findings.every((f) => f.file === 'bad.js' && f.force === 'card' && f.severity === 'high'));
});

test('S2 ssrf rule: outbound call taking req input as URL', async () => {
  const r = await checkInject(fx('inject-ssrf'), { tier: 'L2' });
  assert.equal(byRule(r.findings, 'S2.ssrf').length, 3);
  assert.ok(r.findings.every((f) => f.file === 'bad.js' && f.rule === 'S2.ssrf'));
});

test('S2 path traversal and reflected XSS rules; clean control zero false positives', async () => {
  const r = await checkInject(fx('inject-web'), { tier: 'L2' });
  assert.deepEqual(r.findings.map((f) => f.rule).sort(), ['S2.path-traversal', 'S2.reflected-xss']);
  assert.ok(r.findings.every((f) => f.file === 'bad.js'));
  const clean = await checkInject(fx('inject-web'), { tier: 'L2', excludes: ['bad.js'] });
  assert.deepEqual(clean.findings, [], 'static sendFile and escaped send must not be flagged');
});

/* ---------- S1 鉴权覆盖 ---------- */

test('S1 empty route table is structurally not-applicable, not a capability gap', async () => {
  const r = await checkAuthCoverage({ routes: [], publicRoutes: [] });
  assert.equal(r.checkId, 'S1');
  assert.deepEqual(r.findings, []);
  assert.equal(r.gapKind, 'not-applicable');
  assert.match(String(r.coverageGap), /路由表为空/);
  assert.match(String(r.coverageGap), /不适用/);
});

test('S1 still flags an unguarded route when the table is non-empty', async () => {
  const r = await checkAuthCoverage({
    routes: [{ method: 'get', path: '/orders/:id', file: 'routes.js', line: 3, hasGuard: false }],
    publicRoutes: [],
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'S1.no-guard');
  assert.equal(r.coverageGap, null);
});

/* ---------- S7 越权 ---------- */

test('S7 target routes without owner filter are flagged for manual confirmation', async () => {
  const routeResult = await extractRoutes(fx('authz-no-owner'));
  const r = await checkAuthz(fx('authz-no-owner'), { tier: 'L2', routeResult });
  assert.equal(r.checkId, 'S7');
  assert.equal(r.findings.length, 4, 'GET/PUT/DELETE /users/:id + POST /users');
  assert.ok(r.findings.every((f) => f.rule === 'S7.no-owner-filter' && f.severity === 'high' && f.force === 'check' && f.source === 'program'));
  assert.deepEqual(r.findings.map((f) => f.snippet).sort(), ['DELETE /users/:id', 'GET /users/:id', 'POST /users', 'PUT /users/:id']);
  assert.ok(r.findings.every((f) => f.file === 'routes/users.js'));
  assert.ok(r.findings.every((f) => f.message.includes('属主过滤未检出') && f.message.includes('finalcheck:allow')));
});

test('S7 finalcheck:allow route is exempted', async () => {
  const routeResult = await extractRoutes(fx('authz-no-owner'));
  const r = await checkAuthz(fx('authz-no-owner'), { tier: 'L2', routeResult });
  assert.ok(!r.findings.some((f) => f.snippet.includes('orders')), 'allow-commented route must be exempt');
});

test('S7 force becomes card at L3', async () => {
  const routeResult = await extractRoutes(fx('authz-no-owner'));
  const r = await checkAuthz(fx('authz-no-owner'), { tier: 'L3', routeResult });
  assert.ok(r.findings.length >= 1 && r.findings.every((f) => f.force === 'card' && f.severity === 'high'));
});

test('S7 owner-filtered fixture yields zero findings and no coverage gap', async () => {
  const routeResult = await extractRoutes(fx('authz-ok'));
  assert.ok(routeResult.routes.length >= 3, 'fixture routes must be extracted');
  const r = await checkAuthz(fx('authz-ok'), { tier: 'L3', routeResult });
  assert.deepEqual(r.findings, []);
  assert.equal(r.coverageGap, null, '真的分析了 ≥1 条目标路由后才可能给过');
});

test('S7 excludes dropping all target route files → coverageGap, not pass', async () => {
  const routeResult = await extractRoutes(fx('authz-no-owner'));
  const r = await checkAuthz(fx('authz-no-owner'), { tier: 'L2', routeResult, excludes: ['routes'] });
  assert.deepEqual(r.findings, []);
  assert.match(String(r.coverageGap), /未验证/);
  assert.match(String(r.coverageGap), /exclude/);
});

test('S7 without routeResult and no IPC → not-applicable, not a capability gap', async () => {
  const r = await checkAuthz(fx('authz-ok'), { tier: 'L2' });
  assert.deepEqual(r.findings, []);
  assert.equal(r.gapKind, 'not-applicable');
  assert.match(String(r.coverageGap), /未发现 HTTP 路由或 IPC 权限面/);
  assert.match(String(r.coverageGap), /不适用/);
});

test('S7 empty route table and no IPC → not-applicable, never a capability gap', async () => {
  const r = await checkAuthz(fx('authz-ok'), { tier: 'L2', routeResult: { routes: [], publicRoutes: [], warnings: [] } });
  assert.deepEqual(r.findings, []);
  assert.equal(r.gapKind, 'not-applicable');
  assert.match(String(r.coverageGap), /不适用/);
});

test('S7 route table without target routes → coverageGap, never pass', async () => {
  const r = await checkAuthz(fx('authz-ok'), {
    tier: 'L2',
    routeResult: { routes: [{ method: 'get', path: '/health', file: 'routes/users.js', line: 3 }], publicRoutes: [], warnings: [] },
  });
  assert.deepEqual(r.findings, []);
  assert.match(String(r.coverageGap), /未发现可分析的目标路由/);
});

/* ---------- S8 密码与会话 ---------- */

test('S8 weak hash / cookie attributes / plaintext compare all hit', async () => {
  const r = await checkPassword(fx('password-md5'), { tier: 'L2' });
  assert.equal(r.checkId, 'S8');
  const weak = byRule(r.findings, 'S8.weak-hash');
  assert.equal(weak.length, 2, 'weak hash in app.js and lib/legacy.js');
  assert.deepEqual(weak.map((f) => f.file).sort(), ['app.js', 'lib/legacy.js']);
  const cookie = byRule(r.findings, 'S8.cookie-no-httponly');
  assert.equal(cookie.length, 1);
  assert.ok(cookie[0].message.includes('secure') && cookie[0].message.includes('sameSite'), 'missing secure/sameSite merged into one message');
  const plain = byRule(r.findings, 'S8.plaintext-compare');
  assert.equal(plain.length, 1);
  assert.ok(plain[0].message.includes('bcrypt'));
  assert.ok(r.findings.every((f) => f.severity === 'high' && f.force === 'check'));
  assert.ok(!r.findings.some((f) => f.snippet.includes('pepper')), 'finalcheck:allow line must be exempt');
});

test('S8 weak hash requires password context in the file', async () => {
  const r = await checkPassword(fx('password-md5'), { tier: 'L2' });
  assert.ok(!r.findings.some((f) => f.file === 'lib/hashutil.js'), 'sha1 without password context must not be flagged');
});

test('S8 force becomes card at L3', async () => {
  const r = await checkPassword(fx('password-md5'), { tier: 'L3' });
  assert.ok(r.findings.length >= 1 && r.findings.every((f) => f.force === 'card' && f.severity === 'high'));
});

test('S8 clean fixture: bcrypt + full cookie attrs zero findings', async () => {
  const r = await checkPassword(fx('password-ok'), { tier: 'L3' });
  assert.deepEqual(r.findings, []);
});

test('S8 excludes take effect', async () => {
  const r = await checkPassword(fx('password-md5'), { tier: 'L2', excludes: ['lib'] });
  assert.ok(r.findings.length >= 1);
  assert.ok(r.findings.every((f) => !f.file.startsWith('lib/')));
});

/* ---------- 自食其力 ---------- */

test('S2/S8 do not self-trigger on the engine source (自食教训)', async () => {
  // src/fixtures 里是“故意带洞”的演示项目，不属于引擎源码 → 自查时排除
  const inj = await checkInject(srcDir, { tier: 'L3', excludes: ['fixtures'] });
  assert.deepEqual(inj.findings, []);
  const pw = await checkPassword(srcDir, { tier: 'L3', excludes: ['fixtures'] });
  assert.deepEqual(pw.findings, []);
});

test('S2: 正则字面量上的 .exec() 不误报为命令注入，真拼接仍报', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 's2-regex-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 真仓自查里自咬的那一行：`\s+` 的加号紧跟引号，被「加号拼接」启发式误判
  await writeFile(path.join(dir, 'a.js'), [
    'const m = /^\\s*resolved\\s+"?(https?:[^"\\s]+)"?/.exec(line);',
    'const q = /x+/i.exec(text);',
  ].join('\n'));
  const clean = await checkInject(dir, { tier: 'L2' });
  assert.deepEqual(clean.findings, []);
  // 阳性对照：同样的「exec + 拼接」在真命令执行上仍要命中
  await writeFile(path.join(dir, 'b.js'), 'execSync("ping " + req.query.host);');
  const dirty = await checkInject(dir, { tier: 'L2' });
  assert.ok(dirty.findings.some((f) => f.rule === 'S2.cmdi'));
});
