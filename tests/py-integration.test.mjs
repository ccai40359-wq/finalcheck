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
import { dedupeCrossCopies } from '../src/dedupe.mjs';

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
    // Bandit 语义：exit 1 = 发现了问题（JSON 有效）；不能当运行失败
    runner: async () => ({ status: 1, stdout: JSON.stringify(banditJson) }),
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
  // 2026-11-17 新契约：pyproject 没有声明运行时依赖时不封顶结论，但要留一条说明
  assert.equal(r.coverageGap, null, 'requirements 已审计 + pyproject 无依赖声明 → 不封顶结论');
  assert.ok(r.warnings.some((w) => /pyproject\.toml 未声明运行时依赖/.test(w)), '要说明 pyproject 为什么无需审计');
});

test('deps：pip-audit 失败/未产出 JSON → 诚实缺口，不判 0 漏洞', async (t) => {
  const dir = await fixture({ 'requirements.txt': 'flask\n' });
  cleanup(t, dir);
  const r = await checkDeps(dir, { pyAuditRunner: async () => ({ status: 2, stdout: '', stderr: 'network down' }) });
  assert.equal(r.findings.length, 0);
  assert.match(String(r.coverageGap), /pip-audit 失败/);
  assert.match(String(r.coverageGap), /network down/);
});

test('deps：pip-audit JSON 解析（dependencies[].vulns[]）；结构不对的必须抛错', () => {
  const items = interpretPipAuditJson(JSON.stringify({
    dependencies: [{ name: 'django', version: '4.2', vulns: [{ id: 'GHSA-x', aliases: ['CVE-1'], description: 'd' }] }],
  }));
  assert.deepEqual(items.items, [{ name: 'django', version: '4.2', id: 'GHSA-x', description: 'd' }]);
  assert.deepEqual(items.names, ['django']);
  // 2xx/exit-0 的错误载荷（代理拦截页、schema 变化）不能当成「0 漏洞」
  assert.throws(() => interpretPipAuditJson('{"error":"blocked"}', { requireSchema: true }), /dependencies 不是数组/);
});

// pygoat 实测回归：主 requirements 15 个漏洞包/299 条 advisory 曾被塌成 1 条——
// 根因是 requirements.txt 行号全落 0，跨副本去重按「同文件同行」合并。修后必须逐包定位行号，
// 且同包多条 advisory 合成一条（行号相同，但 id 全部保留在 snippet/message 里）。
test('deps：pip-audit 同文件多包不塌缩（行号逐包定位）+ 同包多 advisory 合一条', async (t) => {
  const dir = await fixture({
    'requirements.txt': 'Django==4.2\n# pin comment\nPyYAML==5.1\nrequests[security]==2.19.0\n',
  });
  cleanup(t, dir);
  const pipAuditJson = {
    dependencies: [
      { name: 'django', version: '4.2', vulns: [{ id: 'CVE-1' }, { id: 'CVE-2' }] },
      { name: 'pyyaml', version: '5.1', vulns: [{ id: 'CVE-2019-20477' }] },
      { name: 'requests', version: '2.19.0', vulns: [{ id: 'CVE-A' }, { id: 'CVE-B' }, { id: 'CVE-C' }, { id: 'CVE-D' }] },
    ],
  };
  const r = await checkDeps(dir, { pyAuditRunner: async () => ({ status: 1, stdout: JSON.stringify(pipAuditJson) }) });
  const pip = r.findings.filter((f) => f.rule === 'S4.pip-audit');
  assert.equal(pip.length, 3, '三个漏洞包各一条，不再被去重塌缩');
  const byLine = new Map(pip.map((f) => [`${f.file}:${f.line}`, f]));
  assert.ok(byLine.has('requirements.txt:1'), 'django 在第 1 行');
  assert.ok(byLine.has('requirements.txt:3'), 'pyyaml 第 3 行（大小写归一 + 跳过注释行）');
  assert.ok(byLine.has('requirements.txt:4'), 'requests 第 4 行（extras 语法不影响定位）');
  const req = byLine.get('requirements.txt:4');
  assert.match(req.snippet, /等 4 条 advisory/, '同包 4 条 advisory 合成一条并标注总数');
  const deduped = dedupeCrossCopies(r.findings);
  assert.equal(deduped.removed, 0, '不同包的 pip-audit 发现不得被跨副本去重合并');
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

test('py 路由提取：docstring 示例路由与 tests/docs 目录不计入产品鉴权面（fastapi S1 洪泛 1776 根因）', async (t) => {
  const dir = await fixture({
    'app.py': [
      '"""Module doc with tutorial examples inside.',
      '',
      '    @app.get("/items/")',
      '    def read_items():',
      '        return []',
      '',
      '    More prose mentioning @app.post("/demo") too.',
      '"""',
      '',
      '@app.get("/real")',
      'def real():',
      '    return 1',
      '',
      'ONE_LINER = """@app.get("/inline")"""',
      '',
      'TEXT = """',
      '    @app.delete("/gone")',
      '"""',
      '',
      '@app.get("/after-doc")',
      'def after():',
      '    return 2',
      '',
    ].join('\n'),
    'tests/test_x.py': '@app.get("/in-tests")\ndef t():\n    return 1\n',
    'docs_src/tutorial001.py': '@app.get("/in-docs")\ndef d():\n    return 1\n',
  });
  cleanup(t, dir);
  const raw = await extractRoutes(dir);
  const paths = raw.routes.map((r) => r.path);
  assert.ok(paths.includes('/real'), '真实路由保留');
  assert.ok(paths.includes('/after-doc'), 'docstring 结束后的真实路由保留');
  assert.ok(!paths.includes('/items/'), 'docstring 多行示例路由不提取');
  assert.ok(!paths.includes('/demo'), 'docstring 提到的路由不提取');
  assert.ok(!paths.includes('/inline'), '单行 docstring 不提取');
  assert.ok(!paths.includes('/gone'), '闭合 docstring 后恢复正常');
  assert.ok(!paths.includes('/in-tests'), 'tests 目录路由不计入产品面');
  assert.ok(!paths.includes('/in-docs'), 'docs_src 目录路由不计入产品面');
  assert.ok(raw.warnings.some((w) => w.includes('非产品目录')), '跳过数写进 warnings 保持透明');
});

test('py 路由守卫：FastAPI Depends() 写在多行函数签名里必须识别（round11 实测 9/12 误报的根因）', async (t) => {
  const dir = await fixture({
    'routers/a.py': [
      'from fastapi import APIRouter, Depends',
      'router = APIRouter()',
      '',
      '# 典型 FastAPI 写法：守卫在函数签名的参数里，跨多行',
      '@router.post("/generate", response_model=Resp)',
      'async def generate_image(',
      '    payload: ImageGenerateRequest,',
      '    user: User = Depends(current_verified_user),',
      '    session: AsyncSession = Depends(get_async_session),',
      ') -> Resp:',
      '    return await run(payload)',
      '',
      '# 单行签名',
      '@router.get("/account")',
      'async def account(_: None = Depends(require_api_key)):',
      '    return 1',
      '',
      '# 真的无守卫',
      '@router.get("/public")',
      'async def public():',
      '    return 2',
      '',
      '# 依赖名不带 auth/user/token，但有 Depends 关键词',
      '@router.get("/admin")',
      'async def admin(',
      '    u: User = Depends(current_superuser),',
      '):',
      '    return 3',
      '',
    ].join('\n'),
  });
  cleanup(t, dir);
  const raw = await extractRoutes(dir);
  const by = new Map(raw.routes.map((r) => [`${r.method} ${r.path}`, r]));
  assert.equal(by.get('post /generate')?.hasGuard, true, '多行签名里的 Depends(current_verified_user) 必须算守卫');
  assert.equal(by.get('get /account')?.hasGuard, true, '单行签名里的 Depends(require_api_key) 必须算守卫');
  assert.equal(by.get('get /admin')?.hasGuard, true, 'Depends(current_superuser) 必须算守卫');
  assert.equal(by.get('get /public')?.hasGuard, false, '真无守卫的路由仍要报');

  const s1 = await checkAuthCoverage(raw);
  assert.ok(!s1.findings.some((f) => f.snippet === 'POST /generate'), '有 Depends 守卫的不许报');
  assert.ok(!s1.findings.some((f) => f.snippet === 'GET /account'), '单行 Depends 不报');
  assert.ok(s1.findings.some((f) => f.snippet === 'GET /public'), '真裸奔的必须报');
});
