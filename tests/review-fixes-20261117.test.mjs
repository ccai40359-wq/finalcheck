// fix/zcode-codex-review 分支的回归测试（2026-11-17）。
//
// 每条都对应一个「静默」问题：不报错、界面看不出，只有长会话或特定写法才暴露。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarizeChunked, splitForSummary, groupForMerge, requestSignal } from '../desktop/src/main/summarize-core.mjs';
import { ledgerEntryOf, appendRoundToLedger, traceArgsOf, LEDGER_REL } from '../desktop/src/main/ledger.mjs';
import { editFileTool } from '../src/fs-tools.mjs';

// ───────── 摘要请求 ─────────

test('summarizeChunked：raw=true 时提示词原样发送一次（不包「压缩以下对话」、不切块）', async () => {
  const seen = [];
  const prompt = '## 用户本轮想要什么\n' + 'x'.repeat(50000);
  const out = await summarizeChunked({ text: prompt, raw: true, maxChars: 30000, ask: async (p, m) => { seen.push({ p, m }); return 'ok'; } });
  assert.equal(out, 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].p, prompt, '一个字都不能改');
  assert.equal(seen[0].m.kind, 'raw');
});

test('summarizeChunked：分块摘要后合并，所有分块摘要都进合并输入（旧实现 slice 截掉后半段）', async () => {
  const text = Array.from({ length: 40 }, (_, i) => `[user] 第${i}条 ` + 'y'.repeat(2900)).join('\n');
  const mergeInputs = [];
  let n = 0;
  const ask = async (p, m) => {
    if (m.kind === 'chunk') return `CHUNK-${n++} ` + 'z'.repeat(4000);
    mergeInputs.push(p);
    return 'MERGED-' + mergeInputs.length + ' ' + 'm'.repeat(100);
  };
  const out = await summarizeChunked({ text, ask, maxChars: 30000 });
  assert.match(out, /^MERGED-/);
  const allMerge = mergeInputs.join('\n');
  for (let i = 0; i < n; i++) assert.match(allMerge, new RegExp(`CHUNK-${i} `), `第 ${i} 份分块摘要不能被截掉`);
  assert.ok(mergeInputs.every((p) => p.length <= 30000 + 2000), '每次合并输入都不超上限太多');
});

test('splitForSummary：优先在换行处切，拼回去与原文一致', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line-${i} ` + 'a'.repeat(500)).join('\n');
  const chunks = splitForSummary(text, 5000);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.slice(0, -1).every((c) => c.endsWith('\n')));
});

test('groupForMerge：单份超长也独占一组，不截断', () => {
  const g = groupForMerge(['a'.repeat(50000), 'b', 'c'], 30000);
  assert.equal(g[0][0].length, 50000);
  assert.deepEqual(g.slice(1).flat(), ['b', 'c']);
});

test('requestSignal：每个请求单独计时；外部取消对它生效', async () => {
  const outer = new AbortController();
  const a = requestSignal(outer.signal, 60000);
  const b = requestSignal(outer.signal, 1000);
  assert.equal(a.signal.aborted, false);
  outer.abort();
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, true);
  assert.equal(a.timedOut(), false, '是取消，不是超时');
  a.done(); b.done();
  const c = requestSignal(null, 1000);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(c.signal.aborted, true);
  assert.equal(c.timedOut(), true);
  c.done();
});

// ───────── 程序账本 ─────────

test('账本：trace 的 args 是 JSON 字符串时也能记账（旧实现生产环境账本几乎为空）', () => {
  assert.deepEqual(traceArgsOf({ args: '{"path":"src/a.mjs"}' }), { path: 'src/a.mjs' });
  assert.deepEqual(traceArgsOf({ args: 'not json' }), {});
  const read = ledgerEntryOf({ tool: 'read_file', args: '{"path":"src/a.mjs"}', result: { totalLines: 10 } });
  assert.equal(read?.kind, 'read');
  assert.match(read.text, /src\/a\.mjs（10 行）/);
  const edit = ledgerEntryOf({ tool: 'edit_file', args: '{"path":"src/b.mjs"}', result: { line: 42 } });
  assert.match(edit.text, /src\/b\.mjs:42/);
  const err = ledgerEntryOf({ tool: 'run_command', args: '{"command":"npm test --silent"}', result: { code: 2, stderr: 'boom' } });
  assert.match(err.text, /npm test 退出码 2：boom/);
});

test('账本：同一轮重试不重复记账；并发写入不出现两个「第 N 轮」', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r1 = { id: 'run-1', at: '2026-11-17 19:00', title: '修 bug', lines: [{ kind: 'edit', text: 'a.mjs:1 改' }] };
  await appendRoundToLedger({ projectRoot: dir, round: r1 });
  const again = await appendRoundToLedger({ projectRoot: dir, round: r1 });
  assert.equal(again.skipped, true, '同一轮重试必须跳过');
  await Promise.all([
    appendRoundToLedger({ projectRoot: dir, round: { id: 'run-2', title: 'A', lines: [{ kind: 'read', text: 'x' }] } }),
    appendRoundToLedger({ projectRoot: dir, round: { id: 'run-3', title: 'B', lines: [{ kind: 'read', text: 'y' }] } }),
  ]);
  const text = readFileSync(path.join(dir, LEDGER_REL), 'utf8');
  const heads = text.match(/^## 第 \d+ 轮/gm);
  assert.deepEqual(heads, ['## 第 1 轮', '## 第 2 轮', '## 第 3 轮']);
});

// ───────── edit_file 返回真实行号 ─────────

test('edit_file：返回改动起始行（账本行号的来源，不靠估算）', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'a.txt');
  writeFileSync(f, 'one\ntwo\nthree\nfour\n');
  const r = await editFileTool({ path: f, old_string: 'three', new_string: 'THREE' });
  assert.equal(r.error, undefined);
  assert.equal(r.line, 3);
});

// ───────── 第二轮：Codex 隔离分支里查出、本分支还没修的三处 ─────────

test('/compact 后：前端历史不带 at 也能裁掉已被摘要覆盖的消息（旧实现全部保留）', async () => {
  const { keepAfterCompactCut } = await import('../desktop/src/main/compact-cut.mjs');
  const db = [
    { role: 'user', content: '读 a.js', at: 100 },
    { role: 'assistant', content: 'a.js 有 3 个函数', at: 110 },
    { role: 'user', content: '继续', at: 120 },
    { role: 'assistant', content: '改好了', at: 130 },
    { role: 'user', content: '新问题', at: 300 },
    { role: 'assistant', content: '新回答', at: 310 },
  ];
  // 前端只发 role/content；开头还有一条注入的 system（项目档案），最后是本轮用户消息
  const wire = [{ role: 'system', content: '已知项目档案：x' }, ...db.map(({ role, content }) => ({ role, content })), { role: 'user', content: '继续' }];
  const { kept, matched } = keepAfterCompactCut(wire, db, 131);
  assert.equal(matched, true);
  assert.deepEqual(kept.map((m) => m.content), ['已知项目档案：x', '新问题', '新回答', '继续']);
});

test('/compact 后：对不上时保留全部（只会重复，不会丢消息）', async () => {
  const { keepAfterCompactCut } = await import('../desktop/src/main/compact-cut.mjs');
  const db = [{ role: 'user', content: '旧', at: 1 }, { role: 'assistant', content: '旧答', at: 2 }];
  const wire = [{ role: 'user', content: '完全不同' }, { role: 'assistant', content: '别的' }, { role: 'user', content: '本轮' }];
  const { kept, matched } = keepAfterCompactCut(wire, db, 3);
  assert.equal(matched, false);
  assert.equal(kept.length, 3);
});

test('.gitignore 不含 ripgrep 无法解析的 glob（`{*` 会让仓库内 rg 整体 exit 2）', () => {
  const lines = readFileSync(path.join(import.meta.dirname, '..', '.gitignore'), 'utf8').split(/\r?\n/);
  for (const l of lines) {
    if (!l || l.startsWith('#')) continue;
    const opens = (l.match(/(?<!\[)\{/g) || []).length;
    const closes = (l.match(/\}/g) || []).length;
    assert.equal(opens, closes, `未闭合的 { ：${l}`);
  }
});

test('pip-audit：exit 2 但吐了 JSON / 依赖被 skip → 漏洞照报，但不计入已审计', async () => {
  const { checkDeps } = await import('../src/checks/deps.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-pipaudit-'));
  try {
    writeFileSync(path.join(dir, 'requirements.txt'), 'Django==4.2\nlocalpkg==1.0\n');
    const json = { dependencies: [
      { name: 'django', version: '4.2', vulns: [{ id: 'PYSEC-1', description: 'x' }] },
      { name: 'localpkg', skip_reason: 'Dependency not found on PyPI' },
    ] };
    const skipped = await checkDeps(dir, { osvPath: null, pyAuditRunner: async () => ({ status: 1, stdout: JSON.stringify(json) }) });
    assert.equal(skipped.pyAuditedCount, 0, '有依赖被跳过 → 这个文件不算审计完成');
    assert.match(String(skipped.coverageGap), /跳过/);
    assert.ok(skipped.findings.some((f) => f.rule === 'S4.pip-audit'), '部分结果里的漏洞仍要报');

    const crashed = await checkDeps(dir, { osvPath: null, pyAuditRunner: async () => ({ status: 2, stdout: JSON.stringify({ dependencies: [] }) }) });
    assert.equal(crashed.pyAuditedCount, 0, 'exit 2 不能当 0 漏洞');
    assert.match(String(crashed.coverageGap), /异常退出/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Bandit：errors 非空 / exit 2 → ran=false + coverageGap，已确认的发现仍返回', async () => {
  const { runPyBandit } = await import('../src/checks/py-bandit.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-bandit-'));
  try {
    writeFileSync(path.join(dir, 'app.py'), "import subprocess\nsubprocess.call('ls ' + x, shell=True)\n");
    const result = { test_id: 'B602', issue_severity: 'HIGH', filename: `${dir.replace(/\\/g, '/')}/app.py`, line_number: 2, issue_text: 'shell=True', code: 'x\n' };
    const partial = await runPyBandit(dir, { tooling: { pythonBin: 'python' }, runner: async () => ({ status: 1, stdout: JSON.stringify({ results: [result], errors: [{ filename: 'b.py', reason: 'syntax error' }] }) }) });
    assert.equal(partial.ran, false);
    assert.match(String(partial.coverageGap), /errors 非空/);
    assert.equal(partial.findings.length, 1);
    const crashed = await runPyBandit(dir, { tooling: { pythonBin: 'python' }, runner: async () => ({ status: 2, stdout: JSON.stringify({ results: [], errors: [] }) }) });
    assert.equal(crashed.ran, false);
    assert.match(String(crashed.coverageGap), /exit 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('edit_file：CRLF 文件 + 模型给的 \n 换行 old_string 也能改，写回保持 CRLF', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-crlf-'));
  try {
    const f = path.join(dir, 'a.py');
    writeFileSync(f, 'class A:\r\n    def x(self):\r\n        return 1\r\n');
    const r = await editFileTool({ path: f, old_string: '    def x(self):\n        return 1', new_string: '    # note\n    def x(self):\n        return 2' });
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.line, 2);
    assert.equal(readFileSync(f, 'utf8'), 'class A:\r\n    # note\r\n    def x(self):\r\n        return 2\r\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('账本：失败的 edit_file 记成错误而不是「改」；grep 记关键词和范围', () => {
  const failed = ledgerEntryOf({ tool: 'edit_file', args: JSON.stringify({ path: 'D:/p/a.py', old_string: 'x', new_string: 'y' }), result: { error: '未找到 old_string：必须与文件内容完全一致', path: 'D:/p/a.py' } });
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /改 D:\/p\/a\.py 失败：未找到 old_string/);
  const ok = ledgerEntryOf({ tool: 'edit_file', args: JSON.stringify({ path: 'D:/p/a.py' }), result: { line: 345 } });
  assert.equal(ok.kind, 'edit');
  assert.match(ok.text, /a\.py:345 改/);
  const g = ledgerEntryOf({ tool: 'grep_code', args: JSON.stringify({ pattern: 'def ', path: 'D:/p/a.py' }), result: { results: [1, 2, 3] } });
  assert.equal(g.text, 'grep "def " @ D:/p/a.py（命中 3 处）');
});

test('命令路径闸：字符串里的 "\r\n" / "\t" 不是路径，不能当项目外路径拒绝；真路径照拒', async () => {
  const { createPolicy, checkCommandPaths } = await import('../desktop/src/main/policy.mjs');
  // 2026-11-20 Linux 移植：原来写死 'C:/projA'。
  // POSIX 上 'C:/projB/x.txt' 不是绝对路径 → 第 220 行的「真路径照拒」断言在 Linux 上假红。
  // 项目根按平台取绝对路径；转义序列那三条与平台无关，保持原样。
  const onWin = process.platform === 'win32';
  const root = onWin ? 'C:/projA' : '/tmp/projA';
  const outsidePath = onWin ? 'C:/projB/x.txt' : '/tmp/projB/x.txt';
  const p = createPolicy({ projectPath: root, mode: 'workspace' });
  for (const cmd of [
    'python -c "import sys; sys.stdout.write(\'a\' + \'\r\n\')"',
    'python - <<\'PY\'\ndata = data.replace("\n", "\r\n")\nPY',
    "printf '\t'",
  ]) {
    assert.equal(checkCommandPaths(p, cmd, root).ok, true, cmd);
  }
  assert.equal(checkCommandPaths(p, `cat "${outsidePath}"`, root).ok, false);
});
