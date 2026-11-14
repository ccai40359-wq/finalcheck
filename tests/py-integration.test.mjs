// Python 接入（round4/round3 定案）：Bandit SAST、pip-audit 依赖审计、FastAPI/Flask 路由提取。
// 工具输出均为注入式（runner/tooling/pyAuditRunner），单测不依赖真实安装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { mapBanditResults, runPyBandit } from '../src/checks/py-bandit.mjs';
import { checkDeps, interpretPipAuditJson } from '../src/checks/deps.mjs';
import { extractRoutes } from '../src/extract-routes.mjs';
import { checkAuthCoverage } from '../src/checks/routes.mjs';

async function fixture(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-py-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}
const cleanup = (t, dir) => t.after(() => rm(dir, { recursive: true, force: true }));

test('bandit 映射：B608→S2、B105→S3、B324→S8、B104→O1，同位 FC 发现去重', () => {
  const json = {
    results: [
      { test_id: 'B608', issue_severity: 'HIGH', filename: 'app.py', line_number: 51, issue_text: 'Possible SQL injection', code: "query(f\"SELECT {x}\")\n" },
      { test_id: 'B105', issue_severity: 'MEDIUM', filename: 'config.py', line_number: 8, issue_text: 'Hardcoded password', code: "password = 'hunter2'\n" },
      { test_id: 'B324', issue_severity: 'HIGH', filename: 'hash.py', line_number: 3, issue_text: 'MD5', code: 'hashlib.md5(x)\n' },
      { test_id: 'B104', issue_severity: 'MEDIUM', filename: 'srv.py', line_number: 2, issue_text: 'bind 0.0.0.0', code: "app.run('0.0.0.0')\n" },
    ],
  };
  const findings = mapBanditResults(json, {
    skipExisting: [{ checkId: 'S3', file: 'config.py', line: 8 }],
  });
  assert.deepEqual(findings.map((f) => `${f.checkId}:${f.rule}`).sort(), ['O1:bandit-B104', 'S2:bandit-B608', 'S8:bandit-B324']);
  assert.ok(!findings.some((f) => f.rule === 'bandit-B105'), 'S3 同位已有 FC 发现时去重');
  const sqli = findings.find((f) => f.rule === 'bandit-B608');
  assert.equal(sqli.severity, 'high');
  assert.equal(sqli.force, 'card');
  assert.equal(sqli.file, 'app.py');
  assert.equal(sqli.line, 51);
  assert.ok(!sqli.snippet.includes('SELECT {x}'), '代码片段必须脱敏');
});

test('bandit 运行：runner 注入、非产品路径跳过、L1 只认 S3', async (t) => {
  const dir = await fixture({
    'app.py': "import subprocess\nsubprocess.call('ls ' + user_input, shell=True)\n",
    'tests/helper.py': 'import subprocess\nsubprocess.call("x", shell=True)\n',
  });
  cleanup(t, dir);
  const banditJson = {
    results: [
      { test_id: 'B602', issue_severity: 'HIGH', filename: `${dir.replace(/\\/g, '/')}/app.py`, line_number: 2, issue_text: 'shell=True', code: "subprocess.call('ls '+u, shell=True)\n" },
      { test_id: 'B602', issue_severity: 'HIGH', filename: `${dir.replace(/\\/g, '/')}/tests/helper.py`, line_number: 2, issue_text: 'shell=True', code: 'subprocess.call("x", shell=True)\n' },
    ],
  };
  const r = await runPyBandit(dir, {
    tooling: { pythonBin: 'python' },
    runner: async () => ({ status: 0, stdout: JSON.stringify(banditJson) }),
    tier: 'L2',
  });
  assert.equal(r.ran, true);
  assert.equal(r.findings.length, 1, 'tests/ 下的发现必须被跳过');
  assert.equal(r.findings[0].checkId, 'S2');

  const l1 = await runPyBandit(dir, {
    tooling: { pythonBin: 'python' },
    runner: async () => ({ status: 0, stdout: JSON.stringify({ results: [{ test_id: 'B105', issue_severity: 'HIGH', filename: `${dir.replace(/\\/g, '/')}/app.py`, line_number: 9, issue_text: 'pwd', code: "password='x'\n" }] }) }),
    tier: 'L1',
  });
  assert.ok(l1.findings.every((f) => f.checkId === 'S3' ? f.force === 'card' : f.force === 'tip'), 'L1 只认 S3 硬卡');
});

test('deps：requirements.txt 由 pip-audit 审计（runner 注入），pyproject 仍记未接入', async (t) => {
  const dir = await fixture({
    'requirements.txt': 'Django==4.2\nPyYAML==5.1\n',
    'pyproject.toml': '[project]\nname = "x"\n',
  });
  cleanup(t, dir);
  const pipAuditJson = {
    dependencies: [
      { name: 'pyyaml', version: '5.1', vulns: [{ id: 'CVE-2019-20477', description: 'yaml.load vulnerability', fix_versions: ['5.2b1'] }] },
    ],
  };
  const r = await checkDeps(dir, { pyAuditRunner: async () => ({ status: 1, stdout: JSON.stringify(pipAuditJson) }) });
  const pip = r.findings.filter((f) => f.rule === 'S4.pip-audit');
  assert.equal(pip.length, 1);
  assert.equal(pip[0].severity, 'high');
  assert.equal(pip[0].file, 'requirements.txt');
  assert.match(pip[0].message, /CVE-2019-20477/);
  assert.match(String(r.coverageGap), /pyproject\.toml/);
  assert.ok(!/requirements\.txt/.test(String(r.coverageGap).split('未完成审计')[0]), '已审计的 requirements 不进缺口');
  assert.equal(r.pyAuditedCount, 1);
});

test('deps：pip-audit 失败/未产出 JSON → 诚实缺口，不判 0 漏洞', async (t) => {
  const dir = await fixture({ 'requirements.txt': 'flask\n' });
  cleanup(t, dir);
  const r = await checkDeps(dir, { pyAuditRunner: async () => ({ status: 2, stdout: '', stderr: 'network down' }) });
  assert.equal(r.findings.length, 0);
  assert.match(String(r.coverageGap), /pip-audit 失败/);
  assert.match(String(r.coverageGap), /network down/);
});

test('deps：pip-audit JSON 解析（dependencies[].vulns[]）', () => {
  const items = interpretPipAuditJson(JSON.stringify({
    dependencies: [{ name: 'django', version: '4.2', vulns: [{ id: 'GHSA-x', aliases: ['CVE-1'], description: 'd' }] }],
  }));
  assert.deepEqual(items, [{ name: 'django', version: '4.2', id: 'GHSA-x', description: 'd' }]);
});

test('py 路由：FastAPI/Flask 装饰器提取 + 鉴权识别 + 不再标 unsupported', async (t) => {
  const dir = await fixture({
    'main.py': [
      'from fastapi import FastAPI, Depends',
      'app = FastAPI()',
      '',
      "@app.get('/items/{item_id}')",
      'def read_item(item_id: int):',
      "    return {'id': item_id}",
      '',
      '@router.post("/admin/users", dependencies=[Depends(get_current_user)])',
      'def create_user():',
      '    return {}',
    ].join('\n'),
    'views.py': [
      'from flask import Flask',
      'app = Flask(__name__)',
      '',
      '@app.route("/login", methods=["POST"])',
      'def login():',
      '    return {}',
      '',
      '@login_required',
      "@app.route('/me')",
      'def me():',
      '    return {}',
    ].join('\n'),
    'routes.rb': 'Rails.application.routes.draw do\nend\n',
  });
  cleanup(t, dir);
  const raw = await extractRoutes(dir);
  const byPath = new Map(raw.routes.map((r) => [`${r.method} ${r.path}`, r]));
  assert.ok(byPath.get('get /items/{item_id}'), 'FastAPI GET 路由');
  assert.ok(byPath.get('post /admin/users'), 'FastAPI POST + Depends 鉴权');
  assert.ok(byPath.get('post /login'), 'Flask methods=["POST"]');
  assert.ok(byPath.get('get /me'), 'Flask @login_required');
  assert.equal(byPath.get('get /me').hasGuard, true, '@login_required 算守卫');
  assert.equal(byPath.get('post /admin/users').hasGuard, true, 'Depends(get_current_user) 算守卫');
  assert.equal(byPath.get('get /items/{item_id}').hasGuard, false, '无守卫路由保持暴露');
  assert.ok(!raw.unsupportedFrameworks?.includes('FastAPI'), 'FastAPI 已支持，不再标 unsupported');
  assert.ok(raw.unsupportedFrameworks?.includes('Rails'), 'Rails 仍标 unsupported');

  const s1 = await checkAuthCoverage(raw);
  assert.ok(s1.findings.some((f) => f.snippet === 'GET /items/{item_id}'), '无守卫路由必须报');
  assert.ok(!s1.findings.some((f) => f.snippet === 'POST /admin/users'), '有守卫路由不报');
  assert.ok(!s1.findings.some((f) => f.snippet === 'GET /me'), 'login_required 不报');
});
