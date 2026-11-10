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

const LONG_BODY = 'This project helps teams coordinate work and keep releases predictable. '.repeat(12);

const README_OK = [
  '# Demo',
  '',
  LONG_BODY,
  '',
  '## Install',
  '',
  'npm install',
  '',
  '## Run',
  '',
  'npm start',
  '',
  '## Environment variables',
  '',
  'Copy `.env.example` and fill in the required values.',
  '',
  '## Deploy',
  '',
  'Deploy through the platform pipeline.',
  '',
  '## Rollback',
  '',
  'Roll back to the previous version with `git revert v1.2.3`.',
  '',
].join('\n');

const byRule = (r, rule) => r.findings.filter((f) => f.rule === rule);
const rules = (r) => r.findings.map((f) => f.rule);
const sectionRules = (r) => r.findings.filter((f) => f.rule.startsWith('H1.readme-section-'));

async function writeDockerfile(dir) {
  await writeFile(path.join(dir, 'Dockerfile'), 'FROM node:22\nUSER node\n');
}

async function writeBase(dir, extra = {}) {
  await writeFile(path.join(dir, 'README.md'), extra.readme ?? README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(extra.pkg ?? { scripts: { start: 'node app.js' } }));
  if (extra.app !== false) await writeFile(path.join(dir, 'app.js'), extra.app ?? 'const x = 1;\n');
  if (extra.docker !== false) await writeDockerfile(dir);
}

function replaceSection(readme, title, body) {
  const re = new RegExp(`## ${title}\\n\\n[\\s\\S]*?(?=\\n## |$)`);
  return readme.replace(re, `## ${title}\n\n${body}\n`);
}

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

test('H1 README 过短 → medium；同时缺五段时按中危逐段报', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.md'), '# demo\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'H1.readme-short').length, 1);
  assert.equal(byRule(r, 'H1.readme-no-start-keyword').length, 1);
  assert.equal(byRule(r, 'H1.readme-short')[0].severity, 'medium');
  assert.match(byRule(r, 'H1.readme-short')[0].snippet, /< 400/);
  const missing = sectionRules(r);
  assert.equal(missing.length, 5, '五段都缺时逐段各一条');
  assert.ok(missing.every((f) => f.severity === 'medium'), '缺 ≥3 段判中危');
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

test('H1 README 大小写不敏感：README.RST + 五段齐全 → 不报内容问题', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'README.RST'), README_OK);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  await writeDockerfile(dir);
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, []);
});

test('H1 package.json 无 start/dev/build/test 任一 → medium', async (t) => {
  const dir = await tmp(t);
  await writeBase(dir, { pkg: { name: 'demo', scripts: { lint: 'eslint .' } } });
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(rules(r), ['H1.no-scripts']);
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
  await writeBase(dir, {
    pkg: { scripts: { start: 'node app.mjs' } },
    app: 'const a = process.env.API_KEY;\nconst b = import.meta.env.VITE_TOKEN;\n',
  });
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
  await writeBase(dir, {
    pkg: { scripts: { start: 'node app.ts' } },
    app: 'const a = process.env.API_KEY;\nconst b = process.env.SECRET_TOKEN;\n',
  });
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
  await writeBase(dir, { app: 'const key = process.env.API_KEY;\n' });
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
  await writeBase(dir);
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
  await writeBase(dir);
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, []);
  assert.ok(r.warnings.some((w) => /lockfile/.test(w)));
});

test('H1 AGENTS.md / docs 只进 warnings 的 info，不加分不扣分', async (t) => {
  const dir = await tmp(t);
  await writeBase(dir);
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

// ---------- 新增：README 五段 / 回滚可操作性 ----------

test('H1 README 五段齐全 → 不报缺段，回滚有可执行线索', async (t) => {
  const dir = await tmp(t);
  await writeBase(dir);
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(sectionRules(r), []);
  assert.equal(byRule(r, 'H1.readme-rollback-vague').length, 0);
  assert.equal(byRule(r, 'H1.no-deploy-clue').length, 0, 'Dockerfile 是部署线索');
});

test('H1 README 缺三段 → 缺的每段各报 medium', async (t) => {
  const dir = await tmp(t);
  const readme = [
    '# Demo', '', LONG_BODY, '',
    '## Install', '', 'npm install', '',
    '## Run', '', 'npm start', '',
  ].join('\n');
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  const missing = sectionRules(r);
  assert.deepEqual(missing.map((f) => f.rule).sort(), [
    'H1.readme-section-deploy',
    'H1.readme-section-env',
    'H1.readme-section-rollback',
  ]);
  assert.ok(missing.every((f) => f.severity === 'medium'), '缺 ≥3 段判中危');
});

test('H1 README 缺两段 → 提醒级 low', async (t) => {
  const dir = await tmp(t);
  const readme = [
    '# Demo', '', LONG_BODY, '',
    '## Install', '', 'npm install', '',
    '## Run', '', 'npm start', '',
    '## Environment variables', '', 'See `.env.example`.', '',
  ].join('\n');
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  const missing = sectionRules(r);
  assert.deepEqual(missing.map((f) => f.rule).sort(), [
    'H1.readme-section-deploy',
    'H1.readme-section-rollback',
  ]);
  assert.ok(missing.every((f) => f.severity === 'low'), '缺 1–2 段只提醒');
  assert.ok(missing.every((f) => f.force === 'tip'), '提醒级不参与卡闸');
});

test('H1 正文出现 deployment 不构成部署段（负例）', async (t) => {
  const dir = await tmp(t);
  const readme = README_OK.replace(
    '## Deploy\n\nDeploy through the platform pipeline.\n',
    '## Notes\n\nThis project supports deployment to a cloud provider, but this is not a deploy section.\n',
  );
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  const hit = byRule(r, 'H1.readme-section-deploy');
  assert.equal(hit.length, 1, '正文里的 deployment 不能让部署段消失');
  assert.equal(hit[0].severity, 'low');
  assert.equal(byRule(r, 'H1.readme-section-notes').length, 0);
});

test('H1 代码块标题 deploy 也算部署段（标题行规则）', async (t) => {
  const dir = await tmp(t);
  const readme = README_OK.replace(
    '## Deploy\n\nDeploy through the platform pipeline.\n',
    '```deploy\nplatform pipeline\n```\n',
  );
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'H1.readme-section-deploy').length, 0);
});

test('H1 回滚段只有标题 → low 提醒', async (t) => {
  const dir = await tmp(t);
  const readme = replaceSection(README_OK, 'Rollback', '');
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  const hit = byRule(r, 'H1.readme-rollback-vague')[0];
  assert.ok(hit);
  assert.equal(hit.severity, 'low');
  assert.equal(hit.force, 'tip');
  assert.match(hit.message, /回滚/);
});

test('H1 中文五段标题齐全 → 不报缺段', async (t) => {
  const dir = await tmp(t);
  const readme = [
    '# 项目', '', LONG_BODY, '',
    '## 安装', '', 'npm install', '',
    '## 运行', '', 'npm start', '',
    '## 环境变量', '', '见 `.env.example`。', '',
    '## 部署', '', '走平台流水线。', '',
    '## 回滚', '', '回滚到上一版本。', '',
  ].join('\n');
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.deepEqual(sectionRules(r), []);
  assert.equal(byRule(r, 'H1.readme-rollback-vague').length, 0);
});

// ---------- 新增：命令静态可执行性 ----------

test('H1 命令引用缺失本地文件 → medium', async (t) => {
  const dir = await tmp(t);
  const readme = replaceSection(README_OK, 'Deploy', '```bash\ndocker compose -f docker-compose.yml up -d\n```');
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  const hit = byRule(r, 'H1.command-missing-file')[0];
  assert.ok(hit);
  assert.equal(hit.severity, 'medium');
  assert.match(hit.message, /docker-compose\.yml/);
  assert.match(hit.snippet, /docker compose/);
});

test('H1 命令引用不存在的 npm script → medium', async (t) => {
  const dir = await tmp(t);
  const readme = replaceSection(README_OK, 'Run', '```bash\nnpm run release\n```');
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  const hit = byRule(r, 'H1.command-missing-script')[0];
  assert.ok(hit);
  assert.equal(hit.severity, 'medium');
  assert.match(hit.message, /release/);
  assert.match(hit.snippet, /npm run release/);
});

test('H1 cd 子目录后的 npm script 按子目录 package.json 校验（monorepo 不误报）', async (t) => {
  const dir = await tmp(t);
  const readme = replaceSection(README_OK, 'Run', '```bash\ncd app && npm run build\n```');
  await writeBase(dir, { readme });
  await mkdir(path.join(dir, 'app'));
  await writeFile(path.join(dir, 'app', 'package.json'), JSON.stringify({ scripts: { build: 'node build.js' } }));
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'H1.command-missing-script').length, 0);
  assert.equal(byRule(r, 'H1.command-missing-file').length, 0);
});

test('H1 无法静态验证的命令 → force level=check + 需人工执行验证', async (t) => {
  const dir = await tmp(t);
  const readme = replaceSection(README_OK, 'Run', '```bash\nnpm start\n```');
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  const hit = byRule(r, 'H1.command-manual-check')[0];
  assert.ok(hit);
  assert.equal(hit.force, 'check');
  assert.equal(hit.severity, 'low');
  assert.match(hit.message, /需人工执行验证/);
  assert.match(hit.message, /不会代替你运行/);
});

test('H1 cp .env.example .env 不把 .env 目标误报为缺失（负例）', async (t) => {
  const dir = await tmp(t);
  const readme = replaceSection(README_OK, 'Run', '```bash\ncp .env.example .env\n```');
  await writeBase(dir, { readme });
  await writeFile(path.join(dir, '.env.example'), 'API_KEY=your_key\n');
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'H1.command-missing-file').length, 0);
});

test('H1 构建产物 dist/ 不存在不判缺失（负例）', async (t) => {
  const dir = await tmp(t);
  const readme = replaceSection(README_OK, 'Run', '```bash\nnode dist/server.js\n```');
  await writeBase(dir, { readme });
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'H1.command-missing-file').length, 0);
});

// ---------- 新增：环境变量双向 diff / 部署线索 ----------

test('H1 env 双向 diff：代码缺声明 + 声明未使用，且不回显值', async (t) => {
  const dir = await tmp(t);
  const readme = replaceSection(README_OK, 'Environment variables', [
    '```bash',
    'API_KEY=your_key',
    'OLD_TOKEN=old-value-123456',
    '```',
  ].join('\n'));
  await writeBase(dir, {
    readme,
    app: 'const a = process.env.API_KEY;\nconst b = process.env.MISSING_SECRET;\n',
  });
  await writeFile(path.join(dir, '.env.example'), 'API_KEY=your_key\n');
  const r = await checkHandover(dir, { tier: 'L2' });
  const missing = byRule(r, 'H1.env-sample-missing-vars')[0];
  assert.ok(missing);
  assert.match(missing.message, /MISSING_SECRET/);
  const unused = byRule(r, 'H1.env-declared-unused-vars')[0];
  assert.ok(unused);
  assert.equal(unused.severity, 'low');
  assert.match(unused.snippet, /OLD_TOKEN/);
  assert.ok(!JSON.stringify(r).includes('old-value-123456'), '只比对变量名，永不回显值');
});

test('H1 无部署线索 → low 提醒不知道怎么上线', async (t) => {
  const dir = await tmp(t);
  await writeBase(dir, { docker: false });
  const r = await checkHandover(dir, { tier: 'L2' });
  const hit = byRule(r, 'H1.no-deploy-clue')[0];
  assert.ok(hit);
  assert.equal(hit.severity, 'low');
  assert.equal(hit.force, 'tip');
  assert.match(hit.message, /上线/);
});

test('H1 有 CI 配置 → 不报无部署线索', async (t) => {
  const dir = await tmp(t);
  await writeBase(dir, { docker: false });
  await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'H1.no-deploy-clue').length, 0);
});
