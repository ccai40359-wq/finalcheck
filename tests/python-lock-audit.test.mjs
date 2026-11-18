// Python 锁文件审计（2026-11-17）的回归测试。
//
// 为什么单独一套：S4 曾把 uv.lock/poetry.lock/Pipfile.lock 判成「生态未接入审计」，
// 而 pyproject.toml 只有版本范围（>=0.3.81）根本不可审计 —— tradingagents 这类纯 uv
// 项目因此永远「无法验收」，明明有 36 个已知漏洞的依赖却报不出来。
//
// 这里锁住四件事：
//   ① 三种锁文件都能零依赖解析出 name+version；不精确/非 PyPI 来源的条目**不许静默跳过**
//   ② OSV 批量：结果形状不对必须整批 fail（绝不返回「0 漏洞」）；失败也绝不能算干净
//   ③ 锁文件路线不再被 pip-audit 是否安装挡住（纯 uv 项目没 pip-audit 也能审）
//   ④ 同一锁文件多个漏洞包的行号必须各自定位（否则跨副本去重会合并成一条，advisory 全丢）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseTomlLock, parsePipfileLock, parsePyLock, parsePyprojectDepNames, isExactVersion,
} from '../src/checks/py-lock-to-requirements.mjs';
import { queryOsvBatch } from '../src/checks/py-osv.mjs';
import { checkDeps } from '../src/checks/deps.mjs';

function fixtureDir(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-s4-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test('uv.lock（TOML）：[[package]] 段抽 name + version；子表里的 name 不算包名', () => {
  const text = [
    'version = 1',
    'revision = 3',
    '',
    '[[package]]',
    'name = "aiohttp"',
    'version = "3.12.13"',
    'source = { registry = "https://pypi.org/simple" }',
    '',
    '[[package]]',
    'name = "anyio"',
    'version = "4.9.0"',
    '',
    '[package.dependencies]',
    'name = "not-a-package-name"',
  ].join('\n');
  const r = parseTomlLock(text);
  assert.deepEqual(r.deps, [
    { name: 'aiohttp', version: '3.12.13' },
    { name: 'anyio', version: '4.9.0' },
  ]);
  assert.ok(!r.deps.some((d) => d.name === 'not-a-package-name'));
  assert.equal(r.skipped.length, 0);
});

test('uv.lock：editable/virtual 自身项目与 git/url 来源不能当 PyPI 包查（否则误报或漏报）', () => {
  const text = [
    '[[package]]',
    'name = "my-app"',
    'version = "0.1.0"',
    'source = { editable = "." }',
    '[[package]]',
    'name = "vendored"',
    'version = "1.0.0"',
    'source = { git = "https://example.com/x.git" }',
    '[[package]]',
    'name = "flask"',
    'version = "3.1.0"',
    'source = { registry = "https://pypi.org/simple" }',
  ].join('\n');
  const r = parseTomlLock(text);
  assert.deepEqual(r.deps, [{ name: 'flask', version: '3.1.0' }]);
  assert.equal(r.skipped.length, 2, 'self 与 git 来源都要记进 skipped');
});

test('poetry.lock：[package.source] 表里的 git/path 依赖进 skipped，不静默吞掉', () => {
  const text = [
    '[[package]]',
    'name = "mylib"',
    'version = "0.2.0"',
    'description = "x"',
    '',
    '[package.source]',
    'type = "git"',
    'url = "https://example.com/mylib.git"',
    '[[package]]',
    'name = "requests"',
    'version = "2.32.4"',
  ].join('\n');
  const r = parseTomlLock(text);
  assert.deepEqual(r.deps, [{ name: 'requests', version: '2.32.4' }]);
  assert.ok(r.skipped.some((s) => s.name === 'mylib' && /PyPI/.test(s.reason)), 'git 来源必须点名说明');
});

test('版本精确性：范围/通配/VCS 都不算锁定（不能拿去查漏洞库）', () => {
  assert.equal(isExactVersion('1.2.3'), true);
  assert.equal(isExactVersion('2.0.0rc1'), true);
  assert.equal(isExactVersion('>=1.0'), false);
  assert.equal(isExactVersion('1.*'), false);
  assert.equal(isExactVersion('===1.2.3'), false);
  assert.equal(isExactVersion(''), false);
});

test('uv.lock：版本写成范围 → 进 skipped 且写清原因（不静默跳过）', () => {
  const r = parsePyLock('uv.lock', ['[[package]]', 'name = "flask"', 'version = ">=3.0"'].join('\n'));
  assert.equal(r.valid, true);
  assert.deepEqual(r.deps, []);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /不是精确锁定值/);
});

test('Pipfile.lock（JSON）：default + develop 都读；VCS/path/未锁定进 skipped', () => {
  const text = JSON.stringify({
    default: {
      requests: { version: '==2.32.4' },
      flask: { version: '==0.5' },
      'from-git': { git: 'https://example.com/x.git' },
    },
    develop: { pytest: { version: '==8.4.2' }, ruff: { version: '*' } },
  });
  const r = parsePipfileLock(text);
  assert.equal(r.deps.length, 3, 'version="*" 与 git 条目要跳过');
  assert.ok(r.deps.some((d) => d.name === 'requests' && d.version === '2.32.4'), '== 前缀要去掉');
  assert.ok(r.deps.some((d) => d.name === 'pytest' && d.version === '8.4.2'), 'develop 区也要读');
  assert.equal(r.skipped.length, 2, '被跳过的一定要记账');
});

test('合法但没有第三方包的锁文件 ≠ 解析失败（Pipfile 空 default 不该封顶结论）', () => {
  const r = parsePyLock('Pipfile.lock', JSON.stringify({ default: {}, develop: {} }));
  assert.equal(r.valid, true, '合法 JSON 结构 → valid');
  assert.deepEqual(r.deps, []);
  // 坏 JSON 才算解析失败
  const bad = parsePyLock('Pipfile.lock', '{not json');
  assert.equal(bad.valid, false);
  assert.match(bad.error, /不是合法 JSON/);
});

test('OSV 批量：查询成功时按 results 下标对齐（不会把 A 的漏洞记到 B 身上）', async () => {
  const deps = [
    { name: 'aiohttp', version: '3.12.13' },
    { name: 'anyio', version: '4.9.0' },
    { name: 'certifi', version: '2025.6.15' },
  ];
  const fakeFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(url, 'https://api.osv.dev/v1/querybatch');
    assert.equal(body.queries.length, 3);
    // 请求体必须真的带包名和 PyPI 生态（传错包也会「成功」返回，测试必须自己盯）
    assert.deepEqual(body.queries[1], { package: { name: 'anyio', ecosystem: 'PyPI' }, version: '4.9.0' });
    return {
      ok: true,
      json: async () => ({ results: [{}, { vulns: [{ id: 'GHSA-x' }, { id: 'PYSEC-y' }] }, {}] }),
    };
  };
  const r = await queryOsvBatch(deps, { fetchImpl: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(r.queried, 3);
  assert.equal(r.affected.length, 1);
  assert.equal(r.affected[0].name, 'anyio', '下标对齐：漏洞必须落在 anyio 上');
  assert.deepEqual(r.affected[0].ids, ['GHSA-x', 'PYSEC-y']);
});

test('OSV 批量：results 缺失 / 长度不足 / 元素不是对象 → 整批 ok:false（绝不 0 漏洞）', async () => {
  const cases = [
    { name: 'results 字段缺失', body: { error: 'rate limited' } },
    { name: 'results 是空数组（短于 queries）', body: { results: [] } },
    { name: 'results 少一项', body: { results: [{}, {}] } },
    { name: 'results 元素是 null', body: { results: [null, {}, {}] } },
  ];
  for (const c of cases) {
    const r = await queryOsvBatch(
      [{ name: 'a', version: '1.0' }, { name: 'b', version: '2.0' }, { name: 'c', version: '3.0' }],
      { fetchImpl: async () => ({ ok: true, json: async () => c.body }) },
    );
    assert.equal(r.ok, false, `形状异常必须整批失败：${c.name}`);
    assert.match(r.error, /结构异常/);
  }
});

test('OSV 批量：HTTP 失败 → 诚实 ok:false（绝不能返回 0 漏洞）', async () => {
  const r = await queryOsvBatch([{ name: 'x', version: '1.0' }], {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 503/);
});

test('OSV 批量：网络异常 → 诚实 ok:false', async () => {
  const r = await queryOsvBatch([{ name: 'x', version: '1.0' }], {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOTFOUND/);
});

test('OSV 批量：空输入 → 不冒充「已审计 0 漏洞」', async () => {
  const r = await queryOsvBatch([]);
  assert.equal(r.ok, false);
  assert.match(r.error, /没有可查询的包/);
});

test('S4：uv.lock 走 OSV 出 finding；声明的依赖被覆盖后 pyproject 只写 note', async (t) => {
  const dir = fixtureDir(t, {
    'uv.lock': ['[[package]]', 'name = "flask"', 'version = "0.5"'].join('\n'),
    'pyproject.toml': '[project]\nname = "probe"\ndependencies = ["flask>=3.0"]\n',
  });
  let osvCalls = 0;
  const r = await checkDeps(dir, {
    auditRunner: async () => { throw new Error('uv.lock 不该走 npm audit'); },
    osvPath: null,
    osvBatchRunner: async (deps) => {
      osvCalls++;
      assert.ok(deps.some((d) => d.name === 'flask'), '解析出的包必须传给 OSV');
      return { ok: true, queried: deps.length, affected: [{ name: 'flask', version: '0.5', ids: ['PYSEC-2019-179'] }] };
    },
  });
  assert.equal(osvCalls, 1);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'S4.osv');
  assert.equal(r.findings[0].line, 2, '行号必须定位到 uv.lock 里的 name 行（否则去重会塌缩）');
  assert.equal(r.coverageGap, null, 'pyproject 的 flask 已被 uv.lock 覆盖 → 不封顶结论');
  assert.ok(r.warnings.some((w) => /已被同目录锁定文件审计覆盖/.test(w)));
});

test('P1：纯 uv 项目在没有 pip-audit 的机器上仍然能审（锁文件路线不依赖 pip-audit）', async (t) => {
  const dir = fixtureDir(t, {
    'uv.lock': ['[[package]]', 'name = "flask"', 'version = "3.1.0"'].join('\n'),
  });
  // 不给 pyAuditRunner，也不在 PATH 上装 pip-audit —— 锁文件路线必须照样跑
  const r = await checkDeps(dir, {
    osvPath: null,
    osvBatchRunner: async (deps) => ({ ok: true, queried: deps.length, affected: [] }),
  });
  assert.equal(r.pyAuditedCount, 1, '锁文件必须被审计（不受 pip-audit 缺失影响）');
  assert.equal(r.coverageGap, null);
});

test('S4：OSV 失败 → 必须记缺口（不能当成 0 漏洞）', async (t) => {
  const dir = fixtureDir(t, {
    'uv.lock': ['[[package]]', 'name = "flask"', 'version = "0.5"'].join('\n'),
  });
  const r = await checkDeps(dir, { osvPath: null, osvBatchRunner: async () => ({ ok: false, error: 'HTTP 503' }) });
  assert.ok(r.coverageGap, 'OSV 失败必须记缺口');
  assert.match(String(r.coverageGap), /OSV 查询失败/);
});

test('同一锁文件多个漏洞包：行号各自定位，跨副本去重不会塌缩成一条', async (t) => {
  const dir = fixtureDir(t, {
    'uv.lock': [
      '[[package]]', 'name = "aiohttp"', 'version = "3.9.0"',
      '[[package]]', 'name = "requests"', 'version = "2.19.0"',
    ].join('\n'),
  });
  const r = await checkDeps(dir, {
    osvPath: null,
    osvBatchRunner: async () => ({
      ok: true, queried: 2,
      affected: [
        { name: 'aiohttp', version: '3.9.0', ids: ['GHSA-a'] },
        { name: 'requests', version: '2.19.0', ids: ['CVE-b'] },
      ],
    }),
  });
  assert.equal(r.findings.length, 2);
  assert.notEqual(r.findings[0].line, r.findings[1].line, '不同包必须落在不同行');
  const { dedupeCrossCopies } = await import('../src/dedupe.mjs');
  const d = dedupeCrossCopies(r.findings);
  assert.equal(d.removed, 0, '两个不同漏洞包不能被去重合并');
});

test('P1：pyproject 声明的依赖没被同目录锁定文件覆盖 → 真缺口（dev 依赖不能蒙混）', async (t) => {
  const dir = fixtureDir(t, {
    'pyproject.toml': '[project]\nname = "probe"\ndependencies = ["django>=4.2"]\n',
    'requirements-dev.txt': 'pytest==8.4.2\n',
  });
  const r = await checkDeps(dir, {
    osvPath: null,
    pyAuditRunner: async (abs) => {
      assert.match(abs, /requirements-dev\.txt/);
      return { status: 0, stdout: JSON.stringify({ dependencies: [{ name: 'pytest', version: '8.4.2', vulns: [] }] }) };
    },
  });
  assert.equal(r.pyAuditedCount, 1);
  assert.ok(r.coverageGap, '运行时依赖 django 没被任何锁定文件覆盖 → 必须记缺口');
  assert.match(String(r.coverageGap), /django/);
});

test('pyproject：同目录没有任何依赖文件审计成功 → 真缺口（不是「已审」）', async (t) => {
  const dir = fixtureDir(t, {
    'pyproject.toml': '[project]\nname = "probe"\ndependencies = ["django>=4.2"]\n',
  });
  const r = await checkDeps(dir, { osvPath: null });
  assert.ok(r.coverageGap);
  assert.match(String(r.coverageGap), /django/);
  assert.match(String(r.coverageGap), /同目录没有可审计的锁定文件/);
});

test('requirements 兜底：pip-audit 超时 → 精确锁定条目走 OSV，未锁定的如实点名', async (t) => {
  const dir = fixtureDir(t, {
    'requirements.txt': 'Django==4.2\nPyYAML==5.1\nflask\nhttpx>=0.27\n',
  });
  const r = await checkDeps(dir, {
    osvPath: null,
    // 模拟 pip-audit 超时（无 JSON）
    pyAuditRunner: async () => ({ status: 124, stdout: '', stderr: 'timeout' }),
    osvBatchRunner: async (deps) => {
      assert.deepEqual(deps.map((d) => d.name), ['Django', 'PyYAML'], '只有精确锁定的条目进 OSV');
      return { ok: true, queried: deps.length, affected: [{ name: 'PyYAML', version: '5.1', ids: ['CVE-2019-20477'] }] };
    },
  });
  assert.equal(r.pyAuditedCount, 0, '还有未锁定条目没查 → 只算部分审计，不进「已审计」分子');
  assert.ok(r.findings.some((f) => f.rule === 'S4.osv' && /PyYAML@5\.1/.test(f.snippet)), '兜底必须真出 finding');
  assert.ok(r.warnings.some((w) => /改用 OSV 批量审计了 2 个精确锁定的直接依赖/.test(w)));
  // 未锁定条目没查过 → 必须进缺口点名，不能因为兜底成功就当成全覆盖
  assert.match(String(r.coverageGap), /2 个条目未锁定版本/);
  assert.match(String(r.coverageGap), /flask/);
});

test('requirements 兜底：不适用时说明「先锁版本」，不静默只报 pip-audit 超时', async (t) => {
  const dir = fixtureDir(t, { 'requirements.txt': 'flask\nuvicorn[standard]\n' });
  const r = await checkDeps(dir, {
    osvPath: null,
    pyAuditRunner: async () => ({ status: 124, stdout: '', stderr: 'timeout' }),
    osvBatchRunner: async () => { throw new Error('不该调用'); },
  });
  assert.equal(r.pyAuditedCount, 0);
  assert.ok(r.coverageGap);
  assert.ok(r.warnings.some((w) => /没有精确锁定版本/.test(w)), '要告诉用户怎么自救');
});

test('pyproject 依赖名解析：PEP 621 数组、多行数组、poetry 段、dynamic', () => {
  assert.deepEqual(parsePyprojectDepNames('[project]\ndependencies = ["Flask>=3", "httpx[http2]==0.27"]\n').names, ['flask', 'httpx']);
  assert.deepEqual(parsePyprojectDepNames('[project]\ndependencies = [\n  "requests>=2.0",\n  "uvicorn",\n]\n').names, ['requests', 'uvicorn']);
  assert.deepEqual(parsePyprojectDepNames('[tool.poetry.dependencies]\npython = "^3.11"\nDjango = "^4.2"\n').names, ['django']);
  assert.equal(parsePyprojectDepNames('[project]\ndynamic = ["dependencies"]\n').dynamic, true);
});

// ───────── 2026-11-17 修复回归（fix/zcode-codex-review 分支）─────────

test('pyproject：单引号（TOML 字面串）依赖必须解析出来，不能被当成「没有依赖」', () => {
  const r = parsePyprojectDepNames("[project]\nname = 'probe'\ndependencies = ['django>=4.2', 'requests ; python_version > \"3.8\"']\n");
  assert.equal(r.ok, true);
  assert.deepEqual(r.names, ['django', 'requests']);
  assert.equal(r.projectName, 'probe');
});

test('pyproject：多行数组里混用两种引号 + 行尾注释 + URL 依赖', () => {
  const r = parsePyprojectDepNames([
    '[project]',
    'dependencies = [',
    '  "httpx[http2]>=0.27",  # 带 extras',
    "  'pkg @ https://example.com/pkg.whl',",
    ']',
  ].join('\n'));
  assert.deepEqual(r.names, ['httpx', 'pkg']);
});

test('pyproject：Poetry 1.2+ 的 group 依赖也要算进声明', () => {
  const r = parsePyprojectDepNames('[tool.poetry]\nname = "pp"\n[tool.poetry.group.main.dependencies]\nFlask = "*"\n"zope.interface" = "*"\n');
  assert.deepEqual(r.names, ['flask', 'zope-interface']);
  assert.equal(r.projectName, 'pp');
});

test('pyproject：数组到文件结尾没闭合 → ok:false（不当成「没有依赖」）', () => {
  const r = parsePyprojectDepNames('[project]\ndependencies = ["a",\n');
  assert.equal(r.ok, false);
});

test('S4：单引号 pyproject + 无锁文件 → 必须记缺口（旧实现 fail-open）', async (t) => {
  const dir = fixtureDir(t, { 'pyproject.toml': "[project]\nname = 'probe'\ndependencies = ['django>=4.2']\n" });
  const r = await checkDeps(dir, { osvPath: null });
  assert.ok(r.coverageGap, '声明了 django 却没有任何锁定审计 → 缺口');
  assert.match(String(r.coverageGap), /django/);
});

test('S4：根目录 pyproject 引用自身 extras（probe[dev]）不算缺口', async (t) => {
  const dir = fixtureDir(t, {
    'uv.lock': ['[[package]]', 'name = "flask"', 'version = "3.1.0"'].join('\n'),
    'pyproject.toml': '[project]\nname = "probe"\ndependencies = ["flask>=3.0", "probe[dev]"]\n',
  });
  const r = await checkDeps(dir, { osvPath: null, osvBatchRunner: async (deps) => ({ ok: true, queried: deps.length, affected: [] }) });
  assert.equal(r.coverageGap, null, '自身包不是第三方依赖');
});

test('S4：没装 pip-audit 时 requirements 精确锁定条目走 OSV；-r/-e 条目点名记缺口', async (t) => {
  const dir = fixtureDir(t, {
    'requirements.txt': ['flask==3.1.0 \\', '    --hash=sha256:abc', '-r base.txt', '-e .', 'requests>=2', ''].join('\n'),
  });
  let sent = [];
  const r = await checkDeps(dir, {
    osvPath: null,
    resolvePipAudit: async () => null,
    osvBatchRunner: async (deps) => { sent = deps; return { ok: true, queried: deps.length, affected: [] }; },
  });
  assert.deepEqual(sent.map((d) => `${d.name}@${d.version}`), ['flask@3.1.0']);
  assert.equal(r.pyAuditedCount, 0, '-r/-e/范围条目没查 → 不算整份文件已审计');
  const gap = String(r.coverageGap);
  assert.match(gap, /-r base\.txt/, '-r 引入的文件没查，必须点名');
  assert.match(gap, /-e \./);
  assert.match(gap, /requests>=2/);
  assert.ok(r.warnings.some((w) => /传递依赖未解析/.test(w)), '兜底覆盖面比 pip-audit 小，必须说清');
  assert.ok(!r.warnings.some((w) => /全部条目已覆盖/.test(w)));
});

test('S4：没装 pip-audit 且 requirements 无精确版本 → 缺口（不冒充已审）', async (t) => {
  const dir = fixtureDir(t, { 'requirements.txt': 'flask\n' });
  const r = await checkDeps(dir, {
    osvPath: null,
    resolvePipAudit: async () => null,
    osvBatchRunner: async () => { throw new Error('不该调用'); },
  });
  assert.equal(r.pyAuditedCount, 0);
  assert.match(String(r.coverageGap), /pip-audit 未安装/);
});
