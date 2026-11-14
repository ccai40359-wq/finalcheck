import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { checkSecrets } from '../src/checks/secrets.mjs';
import { checkSecretsHistory } from '../src/checks/secrets-history.mjs';

const execFileAsync = promisify(execFile);

// 所有敏感串都在运行时拼接：测试源码自身不能被仓库扫描器当成真密钥。
const q = (v) => "'" + v + "'";
const s3 = (out) => out.findings.filter((f) => String(f.rule || '').startsWith('S3.'));

async function fixture(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-s3-suppress-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

/* ---------- 1. 包/依赖段 ---------- */

test('S3 抑制：包/依赖段的 workspace/file/link/npm/git+/semver/URL 不报', async (t) => {
  const dep = {
    workspace: 'workspace:' + '*',
    file: 'file:' + '../local-pkg',
    link: 'link:' + '../link-pkg',
    npm: 'npm:' + 'some-pkg@1.2.3',
    git: 'git+' + 'https://github.com/example/pkg.git',
    caret: '^' + '1.2.3',
    gte: '>=' + '1.2.3',
    tilde: '~' + '1.2.3',
    latest: 'latest',
    url: 'https://' + 'example.com/pkg.tgz',
  };
  const pkg = {
    '@deepseek-ai/dsh-token-meter': dep.workspace,
    apiKey: dep.file,
    token: dep.link,
    secret: dep.npm,
    password: dep.git,
    caretToken: dep.caret,
    gteToken: dep.gte,
    tildeToken: dep.tilde,
    latestToken: dep.latest,
    urlToken: dep.url,
  };
  const composer = { 'token-lib': dep.caret };
  const dir = await fixture({
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    'composer.json': JSON.stringify(composer, null, 2) + '\n',
    // workspace:* 在非清单文件里也跳过
    'app.js': JSON.stringify({ token: dep.workspace }) + ';\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(s3(out), [], '包/依赖段值不应产生任何 S3 finding');
});

/* ---------- 2. 环境变量名 / 标识符 / 模板占位 ---------- */

test('S3 抑制：环境变量名、与键名相同的标识符、{{}}/<>/${}/***/xxxx 不报', async (t) => {
  const envValue = 'APPLE' + '_API_KEY';
  const sameName = 'api' + '_secret';
  const template = '{{' + 'tools' + '}}';
  const angle = '<' + 'SECRET_TOKEN' + '>';
  const brace = '${' + 'TOKEN' + '}';
  const stars = '*'.repeat(12);
  const xs = 'x'.repeat(12);
  const dir = await fixture({
    'app.js': [
      'APPLE_API_KEY_ENV = ' + q(envValue),
      'apiSecret = ' + q(sameName),
      'token = ' + q(template),
      'secret = ' + q(angle),
      'apiKey = ' + q(brace),
      'token = ' + q(stars),
      'token = ' + q(xs),
      'token = ' + q('%s'),
      'token = ' + q('{0}'),
    ].join('\n') + '\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(s3(out), [], '标识符/模板占位不应产生任何 S3 finding');
});

/* ---------- 3. 变量插值 ---------- */

test('S3 抑制：$var / ${} / % 格式化 / {{}} / 课程数据 不报', async (t) => {
  const values = {
    dollar: '$' + 'pass_new',
    dollarLong: '$' + 'token_value',
    brace: 'prefix-' + '${' + 'API_TOKEN' + '}',
    percent: 'abc' + '%s' + 'thing',
    mustache: '{{' + 'tools' + '}}',
    label: 'userid' + ':' + '2',
  };
  const dir = await fixture({
    'app.js': [
      'password = ' + q(values.dollar),
      'token = ' + q(values.dollarLong),
      'apiKey = ' + q(values.brace),
      'secret = ' + q(values.percent),
      'authToken = ' + q(values.mustache),
      '$token = ' + q(values.label),
    ].join('\n') + '\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(s3(out), [], '变量插值/课程数据不应产生任何 S3 finding');
});

/* ---------- 4. UI 文案 / 自然语言 ---------- */

test('S3 抑制：含空格、非 ASCII（德语/法语/中文）的 UI 文案不报', async (t) => {
  const german = 'DeepSeek-API-' + 'Schl' + '\u00fc' + 'ssel';
  const sentence = 'Enter' + ' your' + ' password';
  const chinese = '\u5bc6\u7801\u932f\u8aa4';
  const french = 'cl' + '\u00e9' + ' secret';
  const dir = await fixture({
    'app.js': [
      'billingApiKey = ' + q(german),
      'password = ' + q(sentence),
      'token = ' + q(chinese),
      'secret = ' + q(french),
    ].join('\n') + '\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(s3(out), [], 'UI/自然语言文案不应产生任何 S3 finding');
});

/* ---------- 5. 语法高亮 / 枚举 ---------- */

test('S3 抑制：语法高亮点分 token 名、常见枚举名、kebab 单词不报', async (t) => {
  const dotted = 'comment' + '.' + 'doc' + '.' + 'tag';
  const dir = await fixture({
    'mode-java.js': [
      'token : ' + '"' + dotted + '"',
      'apiKey = ' + q('operator'),
      'token = ' + q('text' + '.' + 'html' + '.' + 'basic'),
      'token = ' + q('new' + '-password'),
    ].join('\n') + '\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(s3(out), [], '语法高亮/枚举值不应产生任何 S3 finding');
});

/* ---------- 6. 测试占位词 ---------- */

test('S3 抑制：测试占位词（mySecret/SHOULD_BE_STRIPPED/testtoken123/repository-token/no-call/sk-your-key-here）不报', async (t) => {
  const entries = [
    ['mySecret', 'my' + 'Secret'],
    ['secret', 'SHOULD' + '_BE_STRIPPED'],
    ['token', 'test' + 'token123'],
    ['apiToken', 'repository' + '-token'],
    ['apiKey', 'built' + '-sdk-startup-failure-no-call'],
    ['apiSecret', 'sk' + '-your-key-here'],
  ];
  const dir = await fixture({
    'app.js': entries.map(([k, v]) => k + ' = ' + q(v)).join('\n') + '\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(s3(out), [], '测试占位值不应产生任何 S3 finding');
});

/* ---------- 7. 纯 PEM 头 ---------- */

test('S3 抑制：只有 PEM 头不报，头 + ≥32 位 base64 体才报 S3.private-key', async (t) => {
  const pemHead = '-----BEGIN ' + 'PRIVATE KEY-----';
  const pemBody = 'MIIEow' + 'IBAAKCAQEA' + '7dYq6m3F8kLx2pR9sT4vW1zN5cH6jB0gD8eA7fC';
  const headerOnly = 'const pem = ' + q(pemHead + '\\n') + ';\n';
  const withBody = 'const pem = `' + pemHead + '\n' + pemBody + '\n' + '-----END ' + 'PRIVATE KEY-----`;\n';
  const dir = await fixture({
    'header-only.js': headerOnly,
    'header-with-body.js': withBody,
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  const headerHits = out.findings.filter((f) => f.file === 'header-only.js' && f.rule === 'S3.private-key');
  const bodyHits = out.findings.filter((f) => f.file === 'header-with-body.js' && f.rule === 'S3.private-key');
  assert.equal(headerHits.length, 0, '纯 PEM 头不是私钥');
  assert.equal(bodyHits.length, 1, 'PEM 头 + base64 体应报 1 条 S3.private-key');
});

/* ---------- 真阳保留 ---------- */

test('S3 真阳：ghp_ / dbPassword / AKIA / 其他已知前缀仍 high/card，回显脱敏', async (t) => {
  const gh = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123';
  const db = 'S3cr3t!' + 'Value#2024';
  const aws = 'AKIA' + 'Q3W5E7R9T1Y2U4I6';
  const gho = 'gho_' + 'abcdefghijklmnopqrstuv';
  const xox = 'xoxb-' + '1234567890-abcdefGHIJ';
  const aiza = 'AIza' + 'SyA1234567890abcdefghijklmnopqrstuvwxyz';
  const sk = 'sk-' + 'live-9f2Kq8LmN3pR7sT1';
  const admin = 'Admin' + '_123';
  const dir = await fixture({
    'app.js': [
      JSON.stringify({ apiToken: gh }),
      'const dbPassword = ' + q(db) + ';',
      'const awsKey = ' + q(aws) + ';',
      'const apiKey = ' + q(gho) + ';',
      'const token = ' + q(xox) + ';',
      'const secret = ' + q(aiza) + ';',
      'const password = ' + q(sk) + ';',
      'const adminPassword = ' + q(admin) + ';',
      'API_TOKEN=' + gh,
    ].join('\n') + '\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  const hits = s3(out);
  assert.ok(hits.some((f) => f.rule === 'S3.secret-literal' && f.line === 1), 'JSON 里的 ghp_ 必须命中');
  assert.ok(hits.some((f) => f.rule === 'S3.secret-literal' && f.line === 2), 'dbPassword 硬编码口令必须命中');
  assert.ok(hits.some((f) => f.rule === 'S3.aws-key' && f.line === 3), 'AKIA 必须命中');
  assert.ok(hits.some((f) => f.rule === 'S3.secret-value' && f.line === 9), '无引号密钥前缀规则必须保留');
  assert.ok(hits.every((f) => f.severity === 'high' && f.force === 'card'), '代码里的真阳仍是 high/card');
  for (const value of [gh, db, aws, gho, xox, aiza, sk, admin]) {
    for (const f of hits) {
      assert.ok(!f.snippet.includes(value), `snippet 不得回显原值：${f.snippet}`);
      assert.ok(!f.message.includes(value), `message 不得回显原值：${f.message}`);
    }
  }
});

test('S3 真阳：5 位数字弱口令不再漏报', async (t) => {
  const weak = '1234' + '5';
  const dir = await fixture({
    'app.js': 'const ACCESS_TOKEN_SECRET = ' + '"' + weak + '";\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  const hit = s3(out).find((f) => f.rule === 'S3.weak-default');
  assert.ok(hit, '真正的弱默认口令必须命中');
  assert.equal(hit.severity, 'high');
  assert.equal(hit.force, 'card');
  assert.ok(!hit.snippet.includes(weak), 'snippet 不得回显弱口令原值');
});

/* ---------- git 历史：非浅克隆继续扫，浅克隆直接跳过 ---------- */

const HISTORY_SECRET = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123';
const PEM_HEAD = '-----BEGIN ' + 'PRIVATE KEY-----';

function gitAvailable() {
  try {
    execFile('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function gitInit(dir) {
  await execFileAsync('git', ['init', '-q', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'FinalCheck Test']);
  await execFileAsync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

async function commitAll(dir, message) {
  await execFileAsync('git', ['-C', dir, 'add', '-A']);
  await execFileAsync('git', ['-C', dir, 'commit', '-q', '-m', message]);
}

async function isShallow(dir) {
  const r = await execFileAsync('git', ['-C', dir, 'rev-parse', '--is-shallow-repository']);
  return String(r.stdout || '').trim() === 'true';
}

test('S3 历史：非浅克隆仓的第二个 commit 含真实 key → 命中，且不回显明文', async (t) => {
  if (!gitAvailable()) return t.skip('git 不可用');
  const dir = await fixture({ 'app.js': 'const PORT = 3000;\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await gitInit(dir);
  await commitAll(dir, 'baseline');
  await writeFile(path.join(dir, 'config.js'), 'const apiToken = ' + q(HISTORY_SECRET) + ';\n');
  await commitAll(dir, 'add key');
  assert.equal(await isShallow(dir), false, '测试仓必须不是浅克隆');

  const r = await checkSecretsHistory(dir, { tier: 'L2' });
  const hits = r.findings.filter((f) => f.rule === 'S3.history-secret-literal');
  assert.ok(hits.length >= 1, '第二个 commit 的真实 key 必须命中');
  assert.ok(hits.every((f) => f.file === 'config.js' && f.severity === 'high' && f.force === 'card'));
  for (const f of hits) {
    assert.ok(!f.snippet.includes(HISTORY_SECRET), '历史报告不得回显明文');
    assert.ok(!f.message.includes(HISTORY_SECRET), '历史报告不得回显明文');
  }
  assert.equal(r.coverageGap, null);
});

test('S3 历史：非浅克隆时复用值抑制（占位词/环境变量名/纯 PEM 头都不报）', async (t) => {
  if (!gitAvailable()) return t.skip('git 不可用');
  const envValue = 'APPLE' + '_API_KEY_SECRET';
  const placeholder = 'test' + '-placeholder-value';
  const dir = await fixture({ 'app.js': 'const PORT = 3000;\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await gitInit(dir);
  await commitAll(dir, 'baseline');
  await writeFile(path.join(dir, 'config.js'), [
    'const password = ' + q(placeholder) + ';',
    'const api_key = ' + q(envValue) + ';',
    'const pem = ' + q(PEM_HEAD + '\\n') + ';',
  ].join('\n') + '\n');
  await commitAll(dir, 'suppressed values');
  assert.equal(await isShallow(dir), false);

  const r = await checkSecretsHistory(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, [], '历史规则必须复用工作树的值抑制');
  assert.equal(r.coverageGap, null);
});

test('S3 历史：--depth 1 浅克隆 → 0 命中 + 浅克隆 warning，coverageGap 为 null', async (t) => {
  if (!gitAvailable()) return t.skip('git 不可用');
  const src = await fixture({ 'app.js': 'const PORT = 3000;\n' });
  const parent = await mkdtemp(path.join(os.tmpdir(), 'fc-s3-shallow-'));
  t.after(async () => {
    await rm(src, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  });
  await gitInit(src);
  await commitAll(src, 'baseline');
  await writeFile(path.join(src, 'config.js'), 'const apiToken = ' + q(HISTORY_SECRET) + ';\n');
  await commitAll(src, 'add key');

  const clone = path.join(parent, 'shallow');
  await execFileAsync('git', ['clone', '--depth', '1', '--no-local', pathToFileURL(src).href, clone]);
  assert.equal(await isShallow(clone), true, '--depth 1 必须产生浅克隆');

  const r = await checkSecretsHistory(clone, { tier: 'L2' });
  assert.deepEqual(r.findings, [], '浅克隆不把 HEAD 当历史重复报');
  assert.ok(r.warnings.some((w) => w === '浅克隆：历史规则未运行（需完整 clone）'), '必须给出浅克隆 warning');
  assert.equal(r.coverageGap, null);
});
