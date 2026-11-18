// Semgrep 接入（2026-11-18）：映射、关闭/失败/规则加载失败的 fail-closed 口径、显式文件清单，
// 以及 audit 层按语言逐个解除 S2 缺口。全部用注入 runner，不真跑 Semgrep。
// 规则包本身的准确率由 `node scripts/bench-py.mjs ../polyglot/<name>` 基准衡量（需本机装 semgrep）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mapSemgrepResults, runSemgrep } from '../src/checks/semgrep.mjs';
import { audit } from '../src/audit.mjs';
import { isNonProductPath } from '../src/scope-policy.mjs';
import { checkPassword } from '../src/checks/password.mjs';

function project(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-semgrep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const GO_SRC = 'package main\n\nfunc h() {\n\tdb.Query("SELECT " + id)\n\tdb.Query("x" + y) // finalcheck:allow\n}\n';
const hit = (file, line, id, fcCheck = 'S2', severity = 'ERROR') => ({
  check_id: `src.semgrep-rules.${id}`, path: file, start: { line },
  extra: { severity, message: `${id} msg`, metadata: { fc_check: fcCheck, fc_kind: id } },
});

test('mapSemgrepResults：规则名/检查项/严重度映射，同规则同行去重，finalcheck:allow 跳过', () => {
  const lines = GO_SRC.split('\n');
  const json = { results: [hit('main.go', 4, 'go-sqli'), hit('main.go', 4, 'go-sqli'), hit('main.go', 5, 'go-sqli'), hit('./main.go', 4, 'go-weak-password-hash', 'S8', 'WARNING')] };
  const out = mapSemgrepResults(json, (f, l) => lines[l - 1] || '');
  assert.deepEqual(out.map((f) => [f.rule, f.file, f.line, f.severity, f.force]), [
    ['S2.sg-go-sqli', 'main.go', 4, 'high', 'card'],
    ['S8.sg-go-weak-password-hash', 'main.go', 4, 'medium', 'card'],
  ]);
  assert.match(out[0].snippet, /db\.Query/);
});

test('runSemgrep：没有 Go/Java/PHP 文件时不跑也不记缺口', async (t) => {
  const dir = project(t, { 'index.js': 'console.log(1)\n', 'app.py': 'print(1)\n' });
  let called = false;
  const r = await runSemgrep(dir, { runner: async () => { called = true; return { status: 0, stdout: '{"results":[]}' }; } });
  assert.equal(called, false);
  assert.equal(r.ran, false);
  assert.deepEqual(r.warnings, []);
});

test('runSemgrep：显式传相对文件清单 + 只加载对应语言规则包；排除目录不进清单', async (t) => {
  const dir = project(t, { 'main.go': GO_SRC, 'web/Index.php': '<?php echo 1;\n', 'vendor/lib/x.go': 'package x\n', 'gen/skip.go': 'package g\n' });
  let seen;
  const r = await runSemgrep(dir, {
    excludes: ['gen'],
    runner: async (_d, args) => { seen = args; return { status: 0, stdout: JSON.stringify({ results: [hit('main.go', 4, 'go-sqli')], errors: [] }) }; },
  });
  assert.equal(r.ran, true);
  assert.deepEqual([...r.coveredExts], ['.go', '.php']);
  const configs = seen.filter((a, i) => seen[i - 1] === '--config').map((p) => path.basename(p));
  assert.deepEqual(configs, ['go.yml', 'php.yml']);
  assert.ok(seen.includes('main.go') && seen.includes('web/Index.php'));
  assert.ok(!seen.some((a) => /vendor|gen\//.test(a)), 'vendor 与 excludes 不该传给 Semgrep');
  assert.ok(seen.includes('--no-git-ignore') && seen.includes('--metrics=off'));
  assert.equal(r.findings.length, 1);
});

test('runSemgrep：关闭 / 运行失败 / 规则加载失败都按没跑算，并说明原因', async (t) => {
  const dir = project(t, { 'main.go': GO_SRC });
  const prev = process.env.FINALCHECK_SEMGREP;
  process.env.FINALCHECK_SEMGREP = 'off';
  t.after(() => { if (prev === undefined) delete process.env.FINALCHECK_SEMGREP; else process.env.FINALCHECK_SEMGREP = prev; });
  const off = await runSemgrep(dir);
  assert.equal(off.ran, false);
  assert.match(off.warnings[0], /已关闭.*go/);

  const failed = await runSemgrep(dir, { runner: async () => ({ status: 2, stdout: '', stderr: 'UnicodeDecodeError: gbk' }) });
  assert.equal(failed.ran, false);
  assert.match(failed.warnings[0], /运行失败（UnicodeDecodeError: gbk）/);

  const ruleErr = await runSemgrep(dir, { runner: async () => ({ status: 0, stdout: JSON.stringify({ results: [hit('main.go', 4, 'go-sqli')], errors: [{ type: 'Rule parse error', message: 'Invalid pattern for Go' }] }) }) });
  assert.equal(ruleErr.ran, false, '规则加载失败时结果不可信，不能部分采用');
  assert.match(ruleErr.warnings[0], /规则加载失败/);

  const parseErr = await runSemgrep(dir, { runner: async () => ({ status: 0, stdout: JSON.stringify({ results: [], errors: [{ type: 'Syntax error', path: 'main.go' }] }) }) });
  assert.equal(parseErr.ran, true);
  assert.ok(parseErr.warnings.some((w) => /1 个文件解析失败/.test(w)));
});

test('audit：Semgrep 跑成 → Go 仓 S2 语言缺口解除并带出发现；没跑 → 缺口保留', async (t) => {
  const files = {};
  for (let i = 0; i < 6; i++) files[`svc/h${i}.go`] = `package svc\n\nfunc H${i}() {}\n`;
  files['svc/h0.go'] = GO_SRC;
  const dir = project(t, files);
  const gapS2 = (r) => r.gates.gapItems.some((g) => g.checkId === 'S2' && g.kind === 'unavailable');

  const ran = await audit(dir, { tier: 'L2', trivyRunner: async () => ({ status: 0, stdout: '{"Results":[]}' }), semgrepRunner: async () => ({ status: 0, stdout: JSON.stringify({ results: [hit('svc/h0.go', 4, 'go-sqli')], errors: [] }) }) });
  assert.ok(ran.findings.some((f) => f.rule === 'S2.sg-go-sqli'));
  assert.ok(ran.warnings.some((w) => /S2 的语言缺口已由 .*Semgrep/.test(w)));
  assert.equal(gapS2(ran), false, 'Semgrep 覆盖了 .go，S2 不该再有语言缺口');

  const notRan = await audit(dir, { tier: 'L2', trivyRunner: async () => ({ status: 0, stdout: '{"Results":[]}' }), semgrepRunner: async () => ({ status: 1, stdout: '' }) });
  assert.equal(gapS2(notRan), true, 'Semgrep 失败时 S2 语言缺口必须保留');
});

test('audit：仓库同时有 .go 和 .rb，Semgrep 只覆盖 .go → S2 缺口保留（不拿一门语言冒充全部）', async (t) => {
  const files = {};
  for (let i = 0; i < 4; i++) files[`svc/h${i}.go`] = `package svc\n\nfunc H${i}() {}\n`;
  for (let i = 0; i < 4; i++) files[`lib/r${i}.rb`] = `def r${i}; end\n`;
  const dir = project(t, files);
  const r = await audit(dir, { tier: 'L2', trivyRunner: async () => ({ status: 0, stdout: '{"Results":[]}' }), semgrepRunner: async () => ({ status: 0, stdout: '{"results":[],"errors":[]}' }) });
  assert.ok(r.gates.gapItems.some((g) => g.checkId === 'S2' && g.kind === 'unavailable'));
});

test('scope-policy：JVM 包名里的 example/test 不算非产品目录，src/test/java 仍算', () => {
  assert.equal(isNonProductPath('src/main/java/com/example/shop/OrderController.java'), false);
  assert.equal(isNonProductPath('app/src/main/kotlin/com/example/demo/Api.kt'), false);
  assert.equal(isNonProductPath('src/main/java/org/acme/test/Fixture.java'), false);
  assert.equal(isNonProductPath('src/test/java/com/example/shop/OrderControllerTest.java'), true);
  assert.equal(isNonProductPath('examples/src/main/java/com/acme/Demo.java'), true);
});

test('S8 弱哈希：口令上下文要在调用附近；注释与 YAML 规则文本不算', async (t) => {
  const dir = project(t, {
    'login.php': `<?php\n$password = $_POST['password'];\n$h = md5($password);\n${'\n'.repeat(10)}$etag = md5(file_get_contents('style.css'));\n`,
    'notes.mjs': "// 以前用 md5(password) 存口令，已改 bcrypt\nexport const x = 1;\n",
    'rules.yml': "password-rules:\n  - pattern: md5($P)\n",
  });
  const r = await checkPassword(dir, { tier: 'L2' });
  const hits = r.findings.filter((f) => f.rule === 'S8.weak-hash').map((f) => `${f.file}:${f.line}`);
  assert.deepEqual(hits, ['login.php:3']);
});
