// Round2 实测暴露的回归与误报：.key 私钥、Gemfile/Cargo、i18n/codefix、数组路由、
// Rails/Go 框架、H1 库/CLI、S6 无 HTTP。每个用例对应一条真实仓库证据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { checkSecrets } from '../src/checks/secrets.mjs';
import { checkDeps } from '../src/checks/deps.mjs';
import { checkHandover } from '../src/checks/handover.mjs';
import { checkExternal } from '../src/checks/external.mjs';
import { checkInject } from '../src/checks/inject.mjs';
import { extractRoutes } from '../src/extract-routes.mjs';
import { isNonProductPath } from '../src/scope-policy.mjs';

async function fixture(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-r2-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

const cleanup = (t, dir) => t.after(() => rm(dir, { recursive: true, force: true }));
const findRule = (findings, rule) => findings.filter((f) => f.rule === rule);

test('S3：git 跟踪的 server.key 工作树也必须命中私钥（NodeGoat 回归）', async (t) => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\n'
    + 'MIIBOgIBAAJBAK9q0kQm3kE1sV0m8Tq0n7b1k9Q2w4e6r8t0y2u4i6o8p0a2s4d6f8g0h2j4k6m8n0p2q4r6s8t0v2w4x6y8z0A2B4C6D8E0F2G4H6I8J0K2L4M6N8O0P2Q4R6S8T0U2V4W6X8Y0Z\n'
    + '-----END RSA PRIVATE KEY-----\n';
  const dir = await fixture({
    'artifacts/cert/server.key': pem,
    'artifacts/cert/server.crt': '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  });
  cleanup(t, dir);
  const r = await checkSecrets(dir);
  const keys = findRule(r.findings, 'S3.private-key');
  assert.equal(keys.length, 1, 'server.key 必须命中且 crt 不应命中');
  assert.equal(keys[0].file, 'artifacts/cert/server.key');
  assert.equal(keys[0].hard, true);
  assert.ok(!keys[0].snippet.includes('MIIBOgIBAAJBAK'), 'snippet 不回显私钥体');
});

test('S4：Gemfile.lock / Cargo.lock 按 Ruby/Rust 生态记未接入，不再说“未发现任何 lockfile”', async (t) => {
  const dir = await fixture({
    'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n',
    'Cargo.lock': 'version = 3\n',
  });
  cleanup(t, dir);
  const r = await checkDeps(dir);
  assert.equal(r.findings.length, 0);
  assert.match(String(r.coverageGap), /Ruby/);
  assert.match(String(r.coverageGap), /Rust/);
  assert.ok(!/未发现任何可识别 lockfile/.test(String(r.coverageGap)));
  assert.equal(r.auditedCount, 0);
});

test('scope：benchmarking/playgrounds/codefixes/i18n/www/docs 是非产品；src/doc 是产品', () => {
  for (const p of [
    'benchmarking/compare/index.js',
    'playgrounds/sandbox/scripts/download.js',
    'data/static/codefixes/loginAdminChallenge_1.ts',
    'frontend/src/assets/i18n/en.json',
    'www/v10/docs/server/adapters/nextjs.md',
  ]) assert.equal(isNonProductPath(p), true, p);
  for (const p of ['src/doc/render.js', 'src/docs.ts', 'packages/core/src/latest.js', 'src/contest.js']) {
    assert.equal(isNonProductPath(p), false, p);
  }
});

test('routes：app.get([A,B]) 展开成两条路由，不再因数组路径把 S1 记 unavailable', async (t) => {
  const dir = await fixture({
    'app.js': [
      "const express = require('express');",
      'const app = express();',
      "app.get(['/.well-known/security.txt', '/security.txt'], (req, res) => res.end('ok'));",
    ].join('\n'),
  });
  cleanup(t, dir);
  const raw = await extractRoutes(dir);
  const paths = raw.routes.filter((r) => r.method === 'get').map((r) => r.path).sort();
  assert.deepEqual(paths, ['/.well-known/security.txt', '/security.txt']);
});

test('frameworks：Rails / Gin 进入 unsupportedFrameworks，S1/S7/S6 可记 unavailable', async (t) => {
  const rails = await fixture({
    'config/routes.rb': 'Rails.application.routes.draw do\n  get "login" => "sessions#new"\nend\n',
  });
  const gin = await fixture({
    'main.go': 'package main\nimport "github.com/gin-gonic/gin"\nfunc main(){ r := gin.New(); _ = r }\n',
  });
  t.after(() => Promise.all([rm(rails, { recursive: true, force: true }), rm(gin, { recursive: true, force: true })]));
  assert.ok((await extractRoutes(rails)).unsupportedFrameworks?.includes('Rails'));
  assert.ok((await extractRoutes(gin)).unsupportedFrameworks?.includes('Gin'));
});

test('S6：没有 HTTP 信号时是 not-applicable，不是 executed/0 命中', async (t) => {
  const dir = await fixture({ 'README.md': '# CLI tool\n\n## Installation\n\n```sh\nnpm i -g x\n```\n' });
  cleanup(t, dir);
  const r = await checkExternal(dir, { tier: 'L2' });
  assert.equal(r.findings.length, 0);
  assert.equal(r.gapKind, 'not-applicable');
  assert.match(String(r.coverageGap), /不适用/);
});

test('S2：obj.eval() 是插件方法，不算动态代码执行；裸 eval(req.body) 仍命中', async (t) => {
  const dir = await fixture({
    'a.js': [
      'const g = { eval: (x) => x };',
      'g.eval(callback);',
      'function h(req) { return eval(req.body.code); }',
    ].join('\n'),
  });
  cleanup(t, dir);
  const r = await checkInject(dir, { tier: 'L2' });
  const evals = findRule(r.findings, 'S2.eval-dynamic');
  assert.equal(evals.length, 1, '只报裸 eval(req.body)');
  assert.equal(evals[0].line, 3);
});

test('H1：库/CLI 只要求安装/运行，不要求 env/deploy/rollback', async (t) => {
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'lib', version: '1.0.0', license: 'MIT', main: 'index.js' }),
    'README.md': '# lib\n\n## Installation\n\n```sh\nnpm i lib\n```\n\n## Usage\n\n```js\nconst lib = require("lib");\n```\n',
  });
  cleanup(t, dir);
  const r = await checkHandover(dir, { tier: 'L2' });
  const sections = r.findings.filter((f) => f.rule.startsWith('H1.readme-section-'));
  assert.deepEqual(sections.map((f) => f.rule), []);
});

test('H1：README 先教“保存为 main.go”再 go run，不算缺失文件', async (t) => {
  const dir = await fixture({
    'README.md': '# gin demo\n\n## Installation\n\n```sh\ngo get github.com/gin-gonic/gin\n```\n\n## Running\n\n1. Save the code above as `main.go`\n\n```sh\ngo run main.go\n```\n',
  });
  cleanup(t, dir);
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(r.findings.filter((f) => f.rule === 'H1.command-missing-file').length, 0);
});

test('H1：express-generator 生成的 npm start 不算本仓缺失 script', async (t) => {
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'express', version: '1.0.0', license: 'MIT', scripts: { test: 'node test.js' } }),
    'README.md': '# express\n\n## Installation\n\n```sh\nnpm install -g express-generator@4\n```\n\nThen run the generated app:\n\n```sh\nnpm install\nnpm start\n```\n',
  });
  cleanup(t, dir);
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(r.findings.filter((f) => f.rule === 'H1.command-missing-script').length, 0);
});

test('S1：handler/factory 内部检查 authenticatedUsers 也算守卫（juice-shop profile 路由）', async (t) => {
  const dir = await fixture({
    'app.js': [
      "const express = require('express');",
      "const { profileHandler } = require('./profile');",
      'const app = express();',
      "app.get('/profile', profileHandler);",
      "app.get('/open', (req, res) => res.send('open'));",
    ].join('\n'),
    'profile.js': [
      "const { authenticatedUsers } = require('./security');",
      'module.exports.profileHandler = (req, res, next) => {',
      '  const user = authenticatedUsers.get(req.cookies.token);',
      "  if (!user) return next(new Error('blocked'));",
      "  res.send('profile');",
      '};',
    ].join('\n'),
    'security.js': 'module.exports = { authenticatedUsers: new Map() };\n',
  });
  cleanup(t, dir);
  const raw = await extractRoutes(dir);
  const profile = raw.routes.find((r) => r.path === '/profile');
  assert.equal(profile?.hasInternalGuard, true);
  const { checkAuthCoverage } = await import('../src/checks/routes.mjs');
  const s1 = await checkAuthCoverage(raw);
  assert.ok(!s1.findings.some((f) => f.snippet === 'GET /profile'), '内部鉴权的 profile 路由不报无守卫');
  assert.ok(s1.findings.some((f) => f.snippet === 'GET /open'), '无鉴权的 /open 仍报');
});

test('extract-routes：tests/ 里的 test server 不生成产品路由（openai-python 场景）', async (t) => {
  const dir = await fixture({
    'tests/server.test.cjs': [
      "const express = require('express');",
      'const app = express();',
      "app.get('/only-in-test', (req, res) => res.send('test'));",
    ].join('\n'),
  });
  cleanup(t, dir);
  const raw = await extractRoutes(dir);
  assert.deepEqual(raw.routes, []);
});

test('S4：requirements.txt/pyproject.toml 按 Python 生态记未接入', async (t) => {
  const dir = await fixture({
    'requirements.txt': 'Django==4.2\nPyYAML==5.1\n',
    'pyproject.toml': '[project]\nname = "x"\n',
  });
  cleanup(t, dir);
  const r = await checkDeps(dir);
  assert.equal(r.findings.length, 0);
  assert.match(String(r.coverageGap), /Python/);
  assert.ok(!/未发现任何可识别 lockfile/.test(String(r.coverageGap)));
});

test('H1：npm i <pkg> / URL 下载不算缺失本地文件（ollama 场景）', async (t) => {
  const dir = await fixture({
    'README.md': '# tool\n\n## Installation\n\n```sh\nnpm i ollama\ncurl https://example.com/traefik.yaml -o traefik.yaml\n```\n\n## Usage\n\n```sh\nollama run llama3\n```\n',
  });
  cleanup(t, dir);
  const r = await checkHandover(dir, { tier: 'L2' });
  assert.equal(r.findings.filter((f) => f.rule === 'H1.command-missing-file').length, 0);
});

test('S3：i18n UI 文案 LABEL_PASSWORD=Password 不报弱口令', async (t) => {
  const dir = await fixture({
    'frontend/src/assets/i18n/en.json': '{\n  "LABEL_PASSWORD": "Password",\n  "SHOW_PASSWORD_ADVICE": "password"\n}\n',
  });
  cleanup(t, dir);
  const r = await checkSecrets(dir);
  assert.equal(findRule(r.findings, 'S3.weak-default').length, 0);
});

