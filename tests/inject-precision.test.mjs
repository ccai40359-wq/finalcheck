import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { checkInject } from '../src/checks/inject.mjs';

// 敏感代码字符串运行时拼接，避免测试文件自己成为扫描器样本。
const EXEC = 'ex' + 'ec';
const EXEC_SYNC = EXEC + 'Sync';
const EVAL = 'ev' + 'al';
const NEW_FUNCTION = 'new ' + 'Function';
const REGEXP = 'Reg' + 'Exp';

const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);

async function makeProject(t, files) {
  const dir = await mkdtemp(path.join(tmpdir(), 's2-inject-precision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(files)) {
    await writeFile(path.join(dir, name), Array.isArray(lines) ? lines.join('\n') : lines);
  }
  return dir;
}

test('S2.cmdi: 数据库/驱动/解析器接收者上的 exec 不算命令执行', async (t) => {
  const dir = await makeProject(t, {
    'receivers.js': [
      `db.${EXEC}("CREATE TABLE t (id INTEGER)");`,
      `db.${EXEC}('CREATE TABLE ' + tableName);`,
      `compiler.${EXEC}('x' + user);`,
      `observer.${EXEC}('CREATE TRIGGER trg ' + action);`,
      `sqlite.${EXEC}('PRAGMA journal_mode = ' + mode);`,
      `stmt.${EXEC}('SAVEPOINT ' + name);`,
      `this.db.${EXEC}('ALTER TABLE t ADD COLUMN x ' + columnType);`,
      `const { ${EXEC}: keep } = require('child_process');`, // 不影响本文件的接收者判定
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  assert.equal(byRule(r.findings, 'S2.cmdi').length, 0);
});

test('S2.cmdi: RegExp 接收者与第三方插件 exec 不算命令执行', async (t) => {
  const dir = await makeProject(t, {
    'regex.js': [
      `new ${REGEXP}('a+' + req.query.p).${EXEC}(line);`,
      `/(?:a|b)/.${EXEC}(line + suffix);`,
      `const r = new ${REGEXP}('x'); r.${EXEC}('x' + req.query.p);`,
      `matcher.${EXEC}('y' + input);`,
      `getExec('spawn').${EXEC}('z' + input);`, // 字符串实参里的 spawn 不是接收者
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  assert.equal(byRule(r.findings, 'S2.cmdi').length, 0);
});

test('S2.cmdi: 裸 exec/execSync 与 child_process 别名仍然命中 high/card', async (t) => {
  const dir = await makeProject(t, {
    'cmdi.js': [
      `const { ${EXEC} } = require('child_process');`,
      `const child_process = require('node:child_process');`,
      `const cp = require('node:child_process');`,
      'function ping(host) {',
      `  return ${EXEC}('ping ' + host);`,
      '}',
      'function clean(f) {',
      `  return child_process.${EXEC}('rm ' + req.query.f);`,
      '}',
      'function read(file) {',
      `  return cp.${EXEC}('cat ' + file);`,
      '}',
      'function run(cmd) {',
      `  return ${EXEC_SYNC}('sh -c ' + cmd);`,
      '}',
      `require('child_process').${EXEC}('kill ' + req.query.p);`,
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  const hits = byRule(r.findings, 'S2.cmdi');
  assert.equal(hits.length, 5);
  assert.ok(hits.every((f) => f.severity === 'high' && f.force === 'card'));
});

test('S2: db.exec 的 SQL 拼接只报 sqli，不报 cmdi', async (t) => {
  const dir = await makeProject(t, {
    'sql.js': [
      `function list(req) { return db.${EXEC}('SELECT * FROM t WHERE id=' + req.query.id); }`,
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  const sqli = byRule(r.findings, 'S2.sqli-concat');
  assert.equal(sqli.length, 1);
  assert.ok(sqli[0].severity === 'high' && sqli[0].force === 'card');
  assert.equal(byRule(r.findings, 'S2.cmdi').length, 0);
});

test('S2.sqli: 参数化首参（含别名/参数数组拼接）零命中', async (t) => {
  const dir = await makeProject(t, {
    'parameterized.js': [
      `function find(req) { return db.query('SELECT * FROM t WHERE id = ?', [req.query.id]); }`,
      `function search(req) { return db.query(q, ['%' + req.query.q + '%']); }`,
      `const q = 'SELECT * FROM t WHERE name LIKE ?';`,
      `function like(req) { return db.query('SELECT * FROM t WHERE q LIKE ?', ['%' + req.query.q + '%']); }`,
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  assert.equal(byRule(r.findings, 'S2.sqli-concat').length, 0);
  assert.equal(byRule(r.findings, 'S2.cmdi').length, 0);
});

test('S2.sqli: 无外部输入时保留规则但降为 check 并提示复核', async (t) => {
  const dir = await makeProject(t, {
    'local.js': [
      'function migrate() {',
      '  const localId = 42;',
      `  return db.${EXEC}('UPDATE t SET x = 1 WHERE id=' + localId);`,
      '}',
      'function migrateAssistant(assistant) {',
      `  return db.${EXEC}('UPDATE assistants SET x = 1 WHERE id=' + assistant.id);`,
      '}',
      'function migrateBuilt() {',
      `  return db.query('DELETE FROM t WHERE id=' + buildSql());`,
      '}',
      "function buildSql() { return 'x'; }",
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  const sqli = byRule(r.findings, 'S2.sqli-concat');
  assert.equal(sqli.length, 3);
  assert.ok(sqli.every((f) => f.severity === 'high' && f.force === 'check'));
  assert.ok(sqli.every((f) => f.message.includes('未确认外部输入，需人工复核')));
  assert.equal(byRule(r.findings, 'S2.cmdi').length, 0);
});

test('S2.sqli: 跨行变量追踪到 req 时升级回 high/card', async (t) => {
  const dir = await makeProject(t, {
    'flow.js': [
      'function list() {',
      '  const id = req.query.id;',
      `  return db.${EXEC}('SELECT * FROM t WHERE id=' + id);`,
      '}',
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  const sqli = byRule(r.findings, 'S2.sqli-concat');
  assert.equal(sqli.length, 1);
  assert.ok(sqli[0].severity === 'high' && sqli[0].force === 'card');
});

test('S2.eval-dynamic: 注释/字符串/模板字面量里的 eval 文本不命中', async (t) => {
  const dir = await makeProject(t, {
    'noise.js': [
      `// ${EVAL}(req.query.code)`,
      `const s = '${EVAL}("x" + y)';`,
      `const t = \`${NEW_FUNCTION}("a", "return a")\`;`,
      '/*',
      `  ${EVAL}(req.query.code)`,
      `  /** ${EXEC}('x' + req.query.y) */`,
      '*/',
    ].join('\n'),
    // dsh overview 的误报形态：JSX 文案 "Eval(s)" 与同行的模板插值被拼成一次命中。
    'overview.tsx': [
      `const view = <p>Eval(s) unavailable: {\`\${err.message}\`}</p>;`,
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  assert.equal(byRule(r.findings, 'S2.eval-dynamic').length, 0);
  assert.equal(byRule(r.findings, 'S2.cmdi').length, 0);
});

test('S2.eval-dynamic: 真实 eval/new Function（含直接 req 输入）仍命中 high/card', async (t) => {
  const dir = await makeProject(t, {
    'real.js': [
      'function check(req) {',
      `  return ${EVAL}('x=' + req.query.v);`,
      '}',
      'function compile(req) {',
      `  return ${NEW_FUNCTION}('a', 'return ' + req.query.v);`,
      '}',
      'function legacy(req) {',
      `  return ${EVAL}(req.body.preTax);`,
      '}',
      'function templated(req) {',
      `  return ${EVAL}(\`x=\${req.query.v}\`);`,
      '}',
    ].join('\n'),
  });
  const r = await checkInject(dir, { tier: 'L2' });
  const hits = byRule(r.findings, 'S2.eval-dynamic');
  assert.equal(hits.length, 4);
  assert.ok(hits.every((f) => f.severity === 'high' && f.force === 'card'));
});
