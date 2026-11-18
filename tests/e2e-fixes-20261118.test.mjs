// 真实模型 E2E（2026-11-18，opendesignM / deepseek-v4.1-flash-eco，6 个真实仓库）暴露问题的回归测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractRoutes } from '../src/extract-routes.mjs';
import { checkMybatis } from '../src/checks/mybatis.mjs';
import { mapTrivyResults, trivyCacheFlags } from '../src/checks/trivy.mjs';

function project(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-e2efix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('Express：module.exports = function(){ return router } + app.use(p, require(x)()) 能挂载（dvna）', async (t) => {
  const dir = project(t, {
    'server.js': "var express = require('express')\nvar app = express()\napp.use('/app', require('./routes/app')())\napp.use('/', require('./routes/main')(null))\napp.listen(3000)\n",
    'routes/app.js': "var router = require('express').Router()\nvar auth = require('../auth')\nmodule.exports = function () {\n  router.get('/ping', auth.isAuthenticated, function (req, res) { res.send('ok') })\n  router.get('/redirect', function (req, res) { res.redirect(req.query.url) })\n  return router\n}\n",
    'routes/main.js': "const express = require('express')\nmodule.exports = (passport) => {\n  const r = express.Router()\n  r.post('/login', function (req, res) { res.send('x') })\n  return r\n}\n",
    'auth.js': 'module.exports = { isAuthenticated (req, res, next) { next() } }\n',
  });
  const r = await extractRoutes(dir);
  const got = r.routes.map((x) => `${x.method} ${x.path}`).sort();
  assert.deepEqual(got, ['get /app/ping', 'get /app/redirect', 'post /login']);
  assert.ok(r.routes.find((x) => x.path === '/app/ping').middlewares.some((m) => /isAuthenticated/.test(m)));
});

test('MyBatis：XML 与注解里的 ${} 报出，#{} 与 XML 注释不报（java-sec-code）', async (t) => {
  const dir = project(t, {
    'src/main/resources/mapper/UserMapper.xml': '<?xml version="1.0"?>\n<mapper namespace="x">\n  <!-- 旧写法 ${old} -->\n  <select id="a">\n    select * from users where name like \'%${name}%\'\n  </select>\n  <select id="b">\n    select * from users order by ${order}\n  </select>\n  <select id="c">select * from users where id = #{id}</select>\n</mapper>\n',
    'src/main/java/x/UserMapper.java': 'interface UserMapper {\n  @Select("select * from users where username = \'${username}\'")\n  User a(String username);\n  @Select("select * from users where username = #{username}")\n  User b(String username);\n}\n',
    'pom.xml': '<project><properties><v>${java.version}</v></properties></project>\n',
  });
  const r = await checkMybatis(dir);
  assert.deepEqual(r.findings.map((f) => `${f.file}:${f.line}`).sort(), [
    'src/main/java/x/UserMapper.java:2',
    'src/main/resources/mapper/UserMapper.xml:5',
    'src/main/resources/mapper/UserMapper.xml:8',
  ]);
  assert.match(r.findings.find((f) => f.line === 8).message, /白名单/);
});

test('Trivy：.devcontainer 不报；MEDIUM 加固项是提示，HIGH 才要处理', () => {
  const m = mapTrivyResults({ Results: [
    { Target: '.devcontainer/Dockerfile', Class: 'config', Misconfigurations: [{ ID: 'DS-0002', Severity: 'HIGH', Status: 'FAIL' }] },
    { Target: 'k8s/app.yml', Class: 'config', Misconfigurations: [{ ID: 'KSV-0012', Severity: 'MEDIUM', Status: 'FAIL' }, { ID: 'KSV-0014', Severity: 'HIGH', Status: 'FAIL' }] },
  ] });
  assert.deepEqual(m.o1.map((f) => [f.file, f.rule, f.force]), [['k8s/app.yml', 'O1.trivy-KSV-0012', 'tip'], ['k8s/app.yml', 'O1.trivy-KSV-0014', 'check']]);
});

test('Trivy：本地库 7 天内离线用（不联网更新），过期/没有则让 Trivy 更新', (t) => {
  const dir = project(t, {
    'db/metadata.json': JSON.stringify({ UpdatedAt: '2026-11-15T00:00:00Z' }),
    'policy/content/x.rego': 'package x',
  });
  const fresh = trivyCacheFlags({ cacheDir: dir, now: Date.parse('2026-11-18T00:00:00Z') });
  assert.deepEqual(fresh.flags, ['--skip-db-update', '--skip-check-update']);
  assert.match(fresh.note, /2026-11-15/);
  const stale = trivyCacheFlags({ cacheDir: dir, now: Date.parse('2026-12-30T00:00:00Z') });
  assert.deepEqual(stale.flags, ['--skip-check-update']);
  const none = trivyCacheFlags({ cacheDir: path.join(dir, 'nope') });
  assert.deepEqual(none.flags, []);
});

test('pip-audit 总预算：一个文件超时后，其余 requirements 直接走 OSV，不再逐个等（pygoat 24 分钟）', async (t) => {
  const files = { 'requirements.txt': 'django==3.2.18\r\n# 注释行不是依赖\r\nrequests==2.28.1\r\n' };
  for (let i = 0; i < 5; i++) files[`labs/l${i}/requirements.txt`] = `flask==2.0.${i}\n`;
  const dir = project(t, files);
  let pipCalls = 0;
  const r = await (await import('../src/checks/deps.mjs')).checkDeps(dir, {
    pyAuditRunner: async () => { pipCalls++; return { status: 124, stdout: '' }; },
    osvBatchRunner: async (deps) => ({ ok: true, queried: deps.length, affected: [] }),
  });
  assert.equal(pipCalls, 1, '第一次超时后不该再跑 pip-audit');
  assert.ok(r.warnings.some((w) => /已超时（网络慢），本文件未跑 pip-audit，改用 OSV/.test(w)));
  // CRLF 文件里的整行注释不能被当成「未锁定条目」
  assert.ok(!String(r.coverageGap || '').includes('注释行'), r.coverageGap);
});
