import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkExternal } from '../src/checks/external.mjs';
import { checkData, checkBackup, checkPrivacy } from '../src/checks/data.mjs';
import { checkSecretsHistory } from '../src/checks/secrets-history.mjs';

// 所有夹具都在临时目录里生成；git 历史测试用本地 user.email/user.name，
// 绝不触碰主仓，也不把测试源码里的字面量提交进本仓历史。

const RESULT_KEYS = ['checkId', 'coverageGap', 'findings', 'warnings'].sort();
const FINDING_KEYS = ['checkId', 'file', 'force', 'line', 'message', 'rule', 'severity', 'snippet', 'source'].sort();

async function fixture(files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-extra-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

function assertResult(r, checkId) {
  assert.deepEqual(Object.keys(r).sort(), RESULT_KEYS);
  assert.equal(r.checkId, checkId);
  assert.ok(Array.isArray(r.findings), 'findings 必须是数组');
  assert.ok(Array.isArray(r.warnings), 'warnings 必须是数组');
  assert.ok(r.warnings.every((w) => typeof w === 'string'), 'warnings 必须是字符串');
  for (const f of r.findings) {
    assert.deepEqual(Object.keys(f).sort(), FINDING_KEYS);
    assert.equal(f.checkId, checkId);
    assert.equal(f.source, 'program');
    assert.ok(['high', 'medium', 'low'].includes(f.severity), `非法 severity: ${f.severity}`);
    assert.ok(['card', 'check', 'tip'].includes(f.force), `非法 force: ${f.force}`);
    assert.ok(Number.isInteger(f.line) && f.line >= 0, 'line 必须是非负整数');
  }
}

const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);

/* ---------- S6 外部入口 ---------- */

test('S6：公开 webhook/callback 路由同文件无验签 → high/card；有 verify 的控制组零发现', async (t) => {
  const dir = await fixture({
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      "app.post('/webhooks/stripe', (req, res) => { res.send('ok'); });",
      "app.post('/callbacks/github', (req, res) => { res.send('ok'); });",
    ].join('\n'),
    'safe.js': [
      "const express = require('express');",
      'const app = express();',
      "app.post('/webhook/safe', (req, res) => {",
      '  const ok = verifySignature(req);',
      "  res.send(ok ? 'ok' : 'bad');",
      '});',
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkExternal(dir, { tier: 'L2' });
  assertResult(r, 'S6');
  const hits = byRule(r.findings, 'S6.webhook-no-verify');
  assert.equal(hits.length, 2);
  assert.ok(hits.every((f) => f.file === 'app.js' && f.severity === 'high' && f.force === 'card'));
  assert.deepEqual(hits.map((f) => f.snippet).sort(), ['POST /callbacks/github', 'POST /webhooks/stripe']);
  assert.ok(!r.findings.some((f) => f.file === 'safe.js'), '有 verify 关键词的文件不得报');
});

test('S6：publicRoutes 显式声明为公开才报；有守卫且未声明公开的路由不报', async (t) => {
  const dir = await fixture({
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      "app.post('/webhook/protected', requireAuth, (req, res) => { res.send('ok'); });",
      "app.post('/webhook/public', requireAuth, (req, res) => { res.send('ok'); });",
    ].join('\n'),
    'finalcheck.config.json': JSON.stringify({ publicRoutes: ['/webhook/public'] }, null, 2),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkExternal(dir, { tier: 'L2' });
  assertResult(r, 'S6');
  const hits = byRule(r.findings, 'S6.webhook-no-verify');
  assert.equal(hits.length, 1, '仅显式公开的 /webhook/public 命中');
  assert.equal(hits[0].snippet, 'POST /webhook/public');
  assert.ok(!hits.some((f) => f.snippet.includes('protected')));
});

test('S6：finalcheck:allow 豁免命中行；excludes 排除整个路由文件', async (t) => {
  const dir = await fixture({
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      "app.post('/webhook/allowed', (req, res) => { res.send('ok'); }); // finalcheck:allow",
      "app.post('/webhook/open', (req, res) => { res.send('ok'); });",
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkExternal(dir, { tier: 'L2' });
  assertResult(r, 'S6');
  const hits = byRule(r.findings, 'S6.webhook-no-verify');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits.map((f) => f.snippet), ['POST /webhook/open']);
  const excluded = await checkExternal(dir, { tier: 'L2', excludes: ['app.js'] });
  assertResult(excluded, 'S6');
  assert.deepEqual(excluded.findings, []);
  assert.ok(excluded.warnings.some((w) => w.includes('excludes')), '排除后必须说明跳过原因');
});

test('S6：CORS 任意 Origin 且 credentials → high/card；仅 * 或仅 credentials 的控制组不报', async (t) => {
  const dir = await fixture({
    'bad.js': [
      "const cors = require('cors');",
      "app.use(cors({ origin: '*', credentials: true }));",
    ].join('\n'),
    'ok1.js': "app.use(cors({ origin: '*', credentials: false }));\n",
    'ok2.js': "app.use(cors({ origin: 'https://example.com', credentials: true }));\n",
    'README.md': "```js\napp.use(cors({ origin: '*', credentials: true }));\n```\n",
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkExternal(dir, { tier: 'L2' });
  assertResult(r, 'S6');
  const hits = byRule(r.findings, 'S6.cors-wildcard-credentials');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'bad.js');
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].severity, 'high');
  assert.equal(hits[0].force, 'card');
  assert.ok(!r.findings.some((f) => f.file === 'ok1.js' || f.file === 'ok2.js' || f.file === 'README.md'));
});

test('S6：L1 时 webhook/CORS 命中降为 tip（提醒不拦）', async (t) => {
  const dir = await fixture({
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      "app.post('/webhook/raw', (req, res) => { res.send('ok'); });",
      "app.use(cors({ origin: '*', credentials: true }));",
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkExternal(dir, { tier: 'L1' });
  assertResult(r, 'S6');
  assert.ok(r.findings.length >= 1);
  assert.ok(r.findings.every((f) => f.force === 'tip'));
});

test('S6：没有路由上下文 → 不报 webhook，只给 warning', async (t) => {
  const dir = await fixture({ 'random.js': "console.log('hello');\n" });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkExternal(dir, { tier: 'L2' });
  assertResult(r, 'S6');
  assert.deepEqual(r.findings, []);
  assert.ok(r.warnings.some((w) => w.includes('路由上下文')), '必须说明 webhook 检查为何跳过');
});

/* ---------- D1 事务 ---------- */

const D1_BASE = [
  "const express = require('express');",
  'const app = express();',
  'const db = { insert() {}, update() {}, delete() {}, execute() {} };',
];

test('D1：同一处理函数 2 个写库调用且文件无事务关键词 → medium/check', async (t) => {
  const dir = await fixture({
    'app.js': [
      ...D1_BASE,
      "app.post('/orders', async (req, res) => {",
      "  await db.insert('orders', req.body);",
      "  await db.update('stock', { id: req.body.id });",
      '  res.json({ ok: true });',
      '});',
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkData(dir, { tier: 'L2' });
  assertResult(r, 'D1');
  const hits = byRule(r.findings, 'D1.write-possible-no-transaction');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'app.js');
  assert.equal(hits[0].line, 4);
  assert.equal(hits[0].severity, 'medium');
  assert.equal(hits[0].force, 'check');
  assert.equal(hits[0].snippet, 'POST /orders');
  assert.ok(hits[0].message.includes('2 个写库调用'));
  assert.ok(hits[0].message.includes('需人工确认'));
});

test('D1：文件内有 transaction/beginTransaction 关键词 → 零发现', async (t) => {
  const dir = await fixture({
    'app.js': [
      ...D1_BASE,
      "app.post('/orders', async (req, res) => {",
      '  await db.transaction(async () => {',
      "    await db.insert('orders', req.body);",
      "    await db.update('stock', { id: req.body.id });",
      '  });',
      '  res.json({ ok: true });',
      '});',
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkData(dir, { tier: 'L3' });
  assertResult(r, 'D1');
  assert.deepEqual(r.findings, []);
});

test('D1：两个处理函数各 1 次写库 → 零发现（不同请求不合并）', async (t) => {
  const dir = await fixture({
    'app.js': [
      ...D1_BASE,
      "app.post('/a', async (req, res) => { await db.insert('a', req.body); res.end(); });",
      "app.post('/b', async (req, res) => { await db.update('b', req.body); res.end(); });",
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkData(dir, { tier: 'L2' });
  assertResult(r, 'D1');
  assert.deepEqual(r.findings, []);
});

test('D1：db.execute 写语句 + delete 命中；只读 execute 不命中', async (t) => {
  const dirty = await fixture({
    'app.js': [
      ...D1_BASE,
      "app.post('/sync', async (req, res) => {",
      "  await db.execute('UPDATE users SET name = ?');",
      "  await db.delete('sessions', req.body.id);",
      '  res.end();',
      '});',
    ].join('\n'),
  });
  const clean = await fixture({
    'app.js': [
      ...D1_BASE,
      "app.post('/report', async (req, res) => {",
      "  await db.execute('SELECT * FROM users');",
      "  await db.execute('SELECT * FROM orders');",
      '  res.end();',
      '});',
    ].join('\n'),
  });
  t.after(() => rm(dirty, { recursive: true, force: true }));
  t.after(() => rm(clean, { recursive: true, force: true }));
  const r = await checkData(dirty, { tier: 'L2' });
  assertResult(r, 'D1');
  const hits = byRule(r.findings, 'D1.write-possible-no-transaction');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].message.includes('2 个写库调用'));
  const c = await checkData(clean, { tier: 'L2' });
  assertResult(c, 'D1');
  assert.deepEqual(c.findings, [], '只读 execute 不得算作写库');
});

test('D1：finalcheck:allow 与 excludes 生效', async (t) => {
  const dir = await fixture({
    'app.js': [
      ...D1_BASE,
      "app.post('/orders', async (req, res) => { // finalcheck:allow",
      "  await db.insert('orders', req.body);",
      "  await db.update('stock', { id: req.body.id });",
      '  res.end();',
      '});',
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkData(dir, { tier: 'L2' });
  assertResult(r, 'D1');
  assert.deepEqual(r.findings, []);
  const excluded = await checkData(dir, { tier: 'L2', excludes: ['app.js'] });
  assertResult(excluded, 'D1');
  assert.deepEqual(excluded.findings, []);
});

test('D1：L1 命中降为 tip', async (t) => {
  const dir = await fixture({
    'app.js': [
      ...D1_BASE,
      "app.post('/orders', async (req, res) => {",
      "  await db.insert('orders', req.body);",
      "  await db.update('stock', { id: req.body.id });",
      '  res.end();',
      '});',
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkData(dir, { tier: 'L1' });
  assertResult(r, 'D1');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].force, 'tip');
});

/* ---------- D2 备份恢复 ---------- */

test('D2：无任何备份证据 → L3 medium/card；L2 medium/tip', async (t) => {
  const dir = await fixture({ 'app.js': "console.log('hi');\n" });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const l3 = await checkBackup(dir, { tier: 'L3' });
  assertResult(l3, 'D2');
  assert.equal(l3.findings.length, 1);
  assert.equal(l3.findings[0].rule, 'D2.no-backup');
  assert.equal(l3.findings[0].severity, 'medium');
  assert.equal(l3.findings[0].force, 'card');
  const l2 = await checkBackup(dir, { tier: 'L2' });
  assertResult(l2, 'D2');
  assert.equal(l2.findings.length, 1);
  assert.equal(l2.findings[0].force, 'tip');
});

test('D2：README 备份段落视为已有备份 → 零发现', async (t) => {
  const dir = await fixture({
    'README.md': '# Demo\n\n## Backup\n\n每日全量备份到 S3。\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkBackup(dir, { tier: 'L3' });
  assertResult(r, 'D2');
  assert.deepEqual(r.findings, []);
});

test('D2：backup 脚本或 *.sql dump 均视为已有备份 → 零发现', async (t) => {
  const scriptDir = await fixture({ 'scripts/backup.sh': '#!/bin/sh\npg_dump "$DATABASE_URL" > dump.sql\n' });
  const sqlDir = await fixture({ 'db/schema.sql': 'CREATE TABLE orders (id INT);\n' });
  t.after(() => rm(scriptDir, { recursive: true, force: true }));
  t.after(() => rm(sqlDir, { recursive: true, force: true }));
  const a = await checkBackup(scriptDir, { tier: 'L3' });
  assertResult(a, 'D2');
  assert.deepEqual(a.findings, []);
  const b = await checkBackup(sqlDir, { tier: 'L3' });
  assertResult(b, 'D2');
  assert.deepEqual(b.findings, []);
});

test('D2：excludes 排除备份证据后仍报缺失', async (t) => {
  const dir = await fixture({ 'README.md': '# Demo\n\n## Backup\n\n每日备份。\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkBackup(dir, { tier: 'L3', excludes: ['README.md'] });
  assertResult(r, 'D2');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'D2.no-backup');
});

/* ---------- D3 隐私 ---------- */

test('D3：日志直接打印 email/phone 变量 → medium/check；字符串里的词不误报', async (t) => {
  const dir = await fixture({
    'app.js': [
      'function handler(req, res) {',
      "  console.log('email:', user.email);",
      '  logger.info({ phone: req.body.phone });',
      "  console.log('password change ok');",
      "  logger.info('email sent successfully');",
      '}',
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkPrivacy(dir, { tier: 'L2' });
  assertResult(r, 'D3');
  const hits = byRule(r.findings, 'D3.log-sensitive-field');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((f) => f.line).sort((a, b) => a - b), [2, 3]);
  assert.ok(hits.every((f) => f.severity === 'medium' && f.force === 'check'));
  assert.ok(hits.every((f) => f.message.includes('需人工确认')));
  assert.equal(r.findings.filter((f) => f.rule === 'D3.no-retention-policy').length, 0);
});

test('D3：finalcheck:allow 豁免日志行；excludes 排除文件', async (t) => {
  const dir = await fixture({
    'app.js': "console.log('email:', user.email); // finalcheck:allow\n",
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkPrivacy(dir, { tier: 'L2' });
  assertResult(r, 'D3');
  assert.deepEqual(r.findings, []);
  const excluded = await checkPrivacy(dir, { tier: 'L2', excludes: ['app.js'] });
  assertResult(excluded, 'D3');
  assert.deepEqual(excluded.findings, []);
});

test('D3：用户数据落盘但全仓无 retention/delete 词 → low/check「未见数据保留策略」', async (t) => {
  const dir = await fixture({
    'user.js': [
      'const userRepo = { create() {} };',
      'async function saveProfile(req, res) {',
      '  await userRepo.create({ email: req.body.email, phone: req.body.phone });',
      '  res.end();',
      '}',
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkPrivacy(dir, { tier: 'L2' });
  assertResult(r, 'D3');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'D3.no-retention-policy');
  assert.equal(r.findings[0].severity, 'low');
  assert.equal(r.findings[0].force, 'check');
  assert.equal(r.findings[0].file, 'user.js');
  assert.equal(r.findings[0].line, 3);
  assert.ok(r.findings[0].message.includes('未见数据保留策略'));
});

test('D3：有 retention/delete 词即不再报保留策略；无用户数据落盘也不报', async (t) => {
  const withRetention = await fixture({
    'user.js': [
      'const userRepo = { create() {}, deleteMany() {} };',
      'async function saveProfile(req, res) {',
      '  await userRepo.create({ email: req.body.email });',
      '  await userRepo.deleteMany({ expired: true });',
      '}',
    ].join('\n'),
  });
  const noPersist = await fixture({ 'cache.js': "await fs.writeFile('cache.json', data);\n" });
  t.after(() => rm(withRetention, { recursive: true, force: true }));
  t.after(() => rm(noPersist, { recursive: true, force: true }));
  const a = await checkPrivacy(withRetention, { tier: 'L2' });
  assertResult(a, 'D3');
  assert.equal(a.findings.filter((f) => f.rule === 'D3.no-retention-policy').length, 0);
  const b = await checkPrivacy(noPersist, { tier: 'L2' });
  assertResult(b, 'D3');
  assert.deepEqual(b.findings, []);
});

test('D3：L1 命中降为 tip', async (t) => {
  const dir = await fixture({ 'app.js': "console.log(user.email);\n" });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkPrivacy(dir, { tier: 'L1' });
  assertResult(r, 'D3');
  assert.ok(r.findings.length >= 1);
  assert.ok(r.findings.every((f) => f.force === 'tip'));
});

/* ---------- S3 git 历史 ---------- */

// 运行时拼接，测试源码本身不出现完整密钥形态
const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const PEM_HEADER = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const SECRET_VALUE = 'AbCd' + 'Ef0123456789xyz';

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

async function gitRepo(t, files) {
  const dir = await fixture(files);
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'FinalCheck Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

test('S3 历史：无 .git → coverageGap 精确文案，零发现', async (t) => {
  const dir = await fixture({ 'app.js': "console.log('hi');\n" });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkSecretsHistory(dir, { tier: 'L2' });
  assertResult(r, 'S3');
  assert.deepEqual(r.findings, []);
  assert.equal(r.coverageGap, 'S3：无 git 历史，历史密钥未查');
});

test('S3 历史：提交过 AWS Key / PEM / 赋值字面量 → high/card，snippet 不回显明文', async (t) => {
  if (!gitAvailable()) return t.skip('git 不可用');
  const dir = await gitRepo(t, {
    'config.js': [
      'const cfg = { api_key: "' + SECRET_VALUE + '" };',
      "const aws = '" + AWS_KEY + "';",
      "const pem = '" + PEM_HEADER + "';",
    ].join('\n'),
  });
  const r = await checkSecretsHistory(dir, { tier: 'L2' });
  assertResult(r, 'S3');
  assert.deepEqual(r.findings.map((f) => f.rule).sort(), [
    'S3.history-aws-key',
    'S3.history-private-key',
    'S3.history-secret-literal',
  ]);
  assert.ok(r.findings.every((f) => f.severity === 'high' && f.force === 'card' && f.file === 'config.js'));
  assert.deepEqual(r.findings.map((f) => f.line).sort((a, b) => a - b), [1, 2, 3]);
  for (const f of r.findings) {
    const shown = `${f.snippet} ${f.message}`;
    assert.ok(!shown.includes(AWS_KEY), '报告不得回显 AWS Key');
    assert.ok(!shown.includes(SECRET_VALUE), '报告不得回显密钥值');
    assert.ok(!shown.includes(PEM_HEADER), '报告不得回显 PEM 私钥块');
    assert.ok(f.snippet.includes('值已抹除（长度'), `snippet 必须是脱敏摘要：${f.snippet}`);
  }
  assert.equal(r.coverageGap, null);
});

test('S3 历史：干净仓库零发现且 coverageGap 为 null', async (t) => {
  if (!gitAvailable()) return t.skip('git 不可用');
  const dir = await gitRepo(t, { 'app.js': 'const PORT = 3000;\n' });
  const r = await checkSecretsHistory(dir, { tier: 'L2' });
  assertResult(r, 'S3');
  assert.deepEqual(r.findings, []);
  assert.equal(r.coverageGap, null);
});

test('S3 历史：excludes 排除命中文件', async (t) => {
  if (!gitAvailable()) return t.skip('git 不可用');
  const dir = await gitRepo(t, { 'config.js': 'const api_key = "' + SECRET_VALUE + '";\n' });
  const r = await checkSecretsHistory(dir, { tier: 'L2', excludes: ['config.js'] });
  assertResult(r, 'S3');
  assert.deepEqual(r.findings, []);
  assert.equal(r.coverageGap, null);
});

test('S3 历史：git log 失败 → coverageGap 而非抛错', async (t) => {
  if (!gitAvailable()) return t.skip('git 不可用');
  const dir = await fixture({ 'app.js': "console.log('hi');\n" });
  await mkdir(path.join(dir, '.git'), { recursive: true }); // 有 .git 但不是有效仓库
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await checkSecretsHistory(dir, { tier: 'L2' });
  assertResult(r, 'S3');
  assert.deepEqual(r.findings, []);
  assert.notEqual(r.coverageGap, null);
  assert.ok(String(r.coverageGap).includes('历史密钥未查'));
  assert.ok(r.warnings.some((w) => w.includes('git log')));
});
