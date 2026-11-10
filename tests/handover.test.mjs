import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { checkHandover } from '../src/checks/handover.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-h1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const README_OK = [
  '# Demo',
  '',
  'This project helps teams coordinate work and keep releases predictable. '.repeat(12),
  '',
  '## Install',
  '',
  'npm install',
  '',
  '## Start',
  '',
  'npm start',
  '',
].join('\n');

const byRule = (r, rule) => r.findings.filter((f) => f.rule === rule);

test('H1 返回契约：形状、force 随档位、source=program', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'app.js'), 'const x = 1;\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(Object.keys(r).sort(), ['checkId', 'coverageGap', 'findings', 'warnings']);
  assert.equal(r.checkId, 'H1');
  assert.equal(r.coverageGap, null);
  const f = byRule(r, 'H1.readme-missing')[0];
  assert.ok(f, 'missing README must be reported');
  assert.deepEqual(Object.keys(f).sort(), ['checkId', 'file', 'force', 'line', 'message', 'rule', 'severity', 'snippet', 'source']);
  assert.equal(f.source, 'program');
  assert.equal(f.severity, 'high');
  assert.equal(f.force, 'card');
  const l1 = await checkHandover(dir, { tier: 'L1' });
  assert.ok(l1.findings.every((x) => x.force === 'tip'), 'L1 only tips');
});

test('H1 无 README → high；项目里已有其它文本文件时不记覆盖缺口', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'app.js'), 'const x = 1;\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  const r = await checkHandover(dir, { tier: 'L2' });
  const hits = byRule(r, 'H1.readme-missing');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'high');
  assert.equal(r.coverageGap, null);
});

test('H1 README 过短 → medium（同时缺启动关键词也各报一条）', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), '# demo\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(r.findings.map((f) => f.rule).sort(), ['H1.readme-no-start-keyword', 'H1.readme-short']);
  assert.ok(r.findings.every((f) => f.severity === 'medium'));
  assert.match(byRule(r, 'H1.readme-short')[0].snippet, /< 400/);
});

test('H1 README 够长但没有 install/run/start/启动 → medium', async (t) => {
  const dir = await tmp(t);
  const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore. '.repeat(10);
  await writeFile(path.join(dir, 'README.md'), `# Notes\n\n${text}\n`);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'H1.readme-no-start-keyword').length, 1);
  assert.equal(byRule(r, 'H1.readme-short').length, 0, 'body must exceed 400 chars');
});

test('H1 README 大小写不敏感：README.RST + 启动关键词 → 不报', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.RST'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, []);
});

test('H1 package.json 无 start/dev/build/test 任一 → medium', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { lint: 'eslint .' } }));
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(r.findings.map((f) => f.rule), ['H1.no-scripts']);
  assert.equal(r.findings[0].severity, 'medium');
});

test('H1 没有 package.json → 只 warning，不臆断（非 Node 项目）', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), README_OK);
  await writeFile(path.join(dir, 'app.js'), 'const x = 1;\n');
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'H1.no-scripts').length, 0);
  assert.ok(r.warnings.some((w) => /package\.json/.test(w)));
});

test('H1 代码用 process.env / import.meta.env 但无样本 → medium，列出前 10 个变量名', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.mjs' } }));
  await writeFile(path.join(dir, 'app.mjs'), 'const a = process.env.API_KEY;\nconst b = import.meta.env.VITE_TOKEN;\n');
  const r = await checkHandover(dir, { tier: 'L2' });
  const hit = byRule(r, 'H1.env-no-sample')[0];
  assert.ok(hit);
  assert.equal(hit.severity, 'medium');
  assert.match(hit.message, /API_KEY/);
  assert.match(hit.message, /VITE_TOKEN/);
  assert.ok(hit.snippet.includes('API_KEY') && hit.snippet.includes('VITE_TOKEN'));
});

test('H1 样本存在但代码变量未列 → medium，列出缺失变量名', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.ts' } }));
  await writeFile(path.join(dir, 'app.ts'), 'const a = process.env.API_KEY;\nconst b = process.env.SECRET_TOKEN;\n');
  await writeFile(path.join(dir, '.env.example'), '# sample\nAPI_KEY=your_key_here\n');
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(r.findings.length, 1);
  const hit = byRule(r, 'H1.env-sample-missing-vars')[0];
  assert.equal(hit.severity, 'medium');
  assert.match(hit.message, /SECRET_TOKEN/);
  assert.equal(byRule(r, 'H1.env-sample-real-value').length, 0, 'placeholder must not look real');
});

test('H1 样本里疑似真实密钥 → high，且报告不回显值', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  await writeFile(path.join(dir, 'app.js'), 'const key = process.env.API_KEY;\n');
  await writeFile(path.join(dir, '.env.example'), [
    'API_KEY=sk-live-abcdef1234567890',
    'APP_NAME=demo',
    'EXTERNAL_TOKEN=your-token-here',
    'AUTH_URL=https://example.com/docs',
    '',
  ].join('\n'));
  const r = await checkHandover(dir, { tier: 'L2' });
  const hits = byRule(r, 'H1.env-sample-real-value');
  assert.equal(hits.length, 1, 'AUTH_URL 不是密钥型 key，不能因 auth 子串误报');
  assert.equal(hits[0].severity, 'high');
  assert.equal(hits[0].snippet, 'API_KEY');
  assert.ok(!JSON.stringify(r).includes('sk-live-abcdef1234567890'), 'secret value must never be echoed');
});

test('H1 样本纯单词密钥值也判 high；占位词/填充值不误报', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  await writeFile(path.join(dir, '.env.example'), [
    'JWT_SECRET=supersecret',
    'PASSWORD=password',
    'SOME_TOKEN=00000000',
    'PUBLIC_KEY=abcdefghijklmnop',
    '',
  ].join('\n'));
  const r = await checkHandover(dir, { tier: 'L2' });
  const hits = byRule(r, 'H1.env-sample-real-value');
  assert.equal(hits.length, 1, '只有 JWT_SECRET 是真嫌疑');
  assert.equal(hits[0].snippet, 'JWT_SECRET');
  assert.ok(!JSON.stringify(r).includes('supersecret'), '值不回显');
});

test('H1 lockfile 缺失只记 warning，不产生 finding（S4 已有覆盖缺口）', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  await writeFile(path.join(dir, 'app.js'), 'const x = 1;\n');
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, []);
  assert.ok(r.warnings.some((w) => /lockfile/.test(w)));
});

test('H1 AGENTS.md / docs 只进 warnings 的 info，不加分不扣分', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  await writeFile(path.join(dir, 'AGENTS.md'), '# handover notes\n');
  await mkdir(path.join(dir, 'docs'));
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, []);
  assert.ok(r.warnings.some((w) => /info.*AGENTS\.md/.test(w)));
  assert.ok(r.warnings.some((w) => /info.*docs\//.test(w)));
});

test('H1 空目录 → coverageGap「H1：无文本文件可查」，不编结论', async (t) => {
  const dir = await tmp(t);
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, []);
  assert.equal(r.coverageGap, 'H1：无文本文件可查');
  assert.ok(r.warnings.every((w) => typeof w === 'string'));
});
