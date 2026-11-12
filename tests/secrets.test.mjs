import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { checkSecrets } from '../src/checks/secrets.mjs';

const execFileAsync = promisify(execFile);

// 运行时拼接：测试源码本身不该长得像一枚真密钥（避免被仓库自己的扫描器/钩子误报）
const LITERAL = 'sk_' + 'live_' + '9f2Kq8LmN3pR7sT1';
const UNQUOTED = 'sk_' + 'amr-' + 'Q7vT0nqo9qlakzzzz';

async function fixture(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-s3-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

// 建一个真实 git 仓库夹具：S3.env-tracked 依赖 git ls-files / check-ignore，纯目录不够。
async function gitFixture(files, { add = [], forceAdd = [] } = {}) {
  const dir = await fixture(files);
  await execFileAsync('git', ['init', '-q', dir]);
  if (add.length) await execFileAsync('git', ['-C', dir, 'add', '--', ...add]);
  if (forceAdd.length) await execFileAsync('git', ['-C', dir, 'add', '-f', '--', ...forceAdd]);
  return dir;
}
const secretRules = (out) => out.findings.filter((f) => /^S3\.(secret|weak)/.test(f.rule));
const forFile = (out, file) => out.findings.filter((f) => f.file === file);

test('S3: JSON 带引号的键名也能命中（apiKey / clientSecret）', async (t) => {
  const dir = await fixture({ 'config.json': `{\n  "apiKey": "${LITERAL}",\n  "clientSecret": "${UNQUOTED}"\n}\n` });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  const hits = forFile(out, 'config.json').filter((f) => f.rule === 'S3.secret-literal');
  assert.equal(hits.length, 2, '两个带引号的 JSON 键都应命中');
  assert.ok(hits.every((f) => f.severity === 'high' && f.force === 'card'), '代码里的密钥是硬卡');
  assert.ok(hits.every((f) => !f.snippet.includes(LITERAL) && !f.snippet.includes(UNQUOTED)), '报告不得回显密钥本体');
});

test('S3: .env 风格无引号赋值与前缀键（DB_PASSWORD / ACCESS_TOKEN）命中', async (t) => {
  const dir = await fixture({
    'deploy.sh': `API_KEY=${UNQUOTED}\nexport DB_PASSWORD=${LITERAL}\n`,
    'docker-compose.yml': `services:\n  app:\n    environment:\n      - ACCESS_TOKEN=${UNQUOTED}\n`,
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.ok(forFile(out, 'deploy.sh').some((f) => f.rule === 'S3.secret-value'), 'API_KEY= 无引号形式应命中');
  assert.equal(forFile(out, 'deploy.sh').filter((f) => f.rule === 'S3.secret-value').length, 2);
  assert.ok(forFile(out, 'docker-compose.yml').some((f) => f.rule === 'S3.secret-value'), 'ACCESS_TOKEN= 应命中');
});

test('S3: 占位符、process.env、i18n 文案与普通单词不误报', async (t) => {
  const dir = await fixture({
    'app.js': [
      'const apiKey = process.env.API_KEY;',
      'const clientSecret = process.env.CLIENT_SECRET;',
      'passwordless = true;',
      'const tokenizer = "abcdefghij";',
      'const secretary = "abcdefghij";',
      'const tokenType = "application/json";',
      // 真仓自查发现的假阳：常量定义里的正则源码 / kebab 键 + 中文文案 / 属性值对
      'const SECRET_KEY = \'(?:api[_-]?key|token)\';',
      'const map = { \'bad-sync-token\': \'令牌不對，找管理員要新的\' };',
      'el.setAttribute(\'autocomplete\', setup ? \'new-password\' : \'current-password\');',
    ].join('\n'),
    'config.json': '{\n  "token": "your-token-here",\n  "secret": "changeme-please"\n}\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(secretRules(out).map((f) => f.rule), []);
});

test('S3: 文档里的示例降为提示级（medium/tip），代码仍是 high/card', async (t) => {
  const dir = await fixture({
    'README.md': `示例：\n\n    "apiKey": "${LITERAL}"\n`,
    'app.js': `const cfg = { "apiKey": "${UNQUOTED}" };\n`,
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  const doc = forFile(out, 'README.md').find((f) => f.rule === 'S3.secret-literal');
  const code = forFile(out, 'app.js').find((f) => f.rule === 'S3.secret-literal');
  assert.ok(doc && code);
  assert.equal(doc.severity, 'medium');
  assert.equal(doc.force, 'tip');
  assert.equal(code.severity, 'high');
  assert.equal(code.force, 'card');
});

test('S3: .env 文件本身不扫（设计边界：密钥就该住在这里）', async (t) => {
  const dir = await fixture({ '.env': `API_KEY=${UNQUOTED}\n` });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(secretRules(out).map((f) => f.rule), []);
});

test('S3: finalcheck:allow 行内豁免仍然有效', async (t) => {
  const dir = await fixture({ 'app.js': `const apiKey = "${LITERAL}"; // finalcheck:allow\n` });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(secretRules(out).map((f) => f.rule), []);
});

test('S3: tracked 的示例/模板/被忽略的 .env 不算已提交密钥，真正的 .env 仍报', async (t) => {
  const dir = await gitFixture({
    '.gitignore': [
      '.env.example*',
      '.env.sample*',
      '.env.template*',
      '.env.local',
      '!.env.example',
      '!.env.sample',
      '',
    ].join('\n'),
    '.env': 'API_KEY=changeme\n',
    '.env.production': 'API_KEY=changeme\n',
    '.env.example': 'API_KEY=your-key-here\n',
    '.env.sample': 'API_KEY=your-key-here\n',
    '.env.dist': 'API_KEY=your-key-here\n',
    '.env.template': 'API_KEY=your-key-here\n',
    '.env.local': 'API_KEY=changeme\n',
  }, {
    add: ['.env', '.env.production', '.env.example', '.env.sample', '.env.dist'],
    forceAdd: ['.env.template', '.env.local'], // 被 .gitignore 命中但仍被 -f 入库
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  const tracked = out.findings.filter((f) => f.rule === 'S3.env-tracked');
  assert.deepEqual(tracked.map((f) => f.file).sort(), ['.env', '.env.production'], '只有真正的 .env / .env.production 算事故');
  assert.ok(tracked.every((f) => f.severity === 'high' && f.force === 'card'), '已提交密钥仍是硬卡');
  for (const file of ['.env.example', '.env.sample', '.env.dist', '.env.template', '.env.local']) {
    assert.ok(!tracked.some((f) => f.file === file), `${file} 不应报 S3.env-tracked`);
  }
});

test('S3: 未被 git 跟踪的 .env 不因 tracked 规则报', async (t) => {
  const dir = await gitFixture({
    '.gitignore': '.env*\n',
    '.env': 'API_KEY=changeme\n',
    '.env.local': 'API_KEY=changeme\n',
    'app.js': 'const answer = 42;\n',
  }, { add: ['.gitignore', 'app.js'] });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await checkSecrets(dir);
  assert.deepEqual(out.findings.filter((f) => f.rule === 'S3.env-tracked').map((f) => f.file), [], 'untracked .env 不应命中 tracked 规则');
  assert.deepEqual(out.findings.filter((f) => f.file === '.env'), [], 'untracked .env 也不该被内容规则扫描');
});
