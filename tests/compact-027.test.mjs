// 0.27：上下文压缩对齐 Claude Code（compact.mjs）——一次性交接摘要、落库成边界只追加、确定性现场兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  formatSummary, collectUserTexts, renderBoundary, splitByTurns, trimAfterBoundary, lastCoveredCallIdOf,
  restoreSnapshot, compactZone, boundedTranscript, compactInstruction, COMPACT_MARK, BOUNDARY_HEAD, isPinnedSystem
} from '../desktop/src/main/compact.mjs';
import { keepAfterCompactCut } from '../desktop/src/main/compact-cut.mjs';
import { readChatText } from '../desktop/src/main/agent-service.mjs';
import { zoneFromSession } from '../desktop/src/main/ipc/ipc-compact.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('摘要：去掉 <analysis> 草稿，只留 <summary>；没按格式写就原样用', () => {
  assert.equal(formatSummary('<analysis>先想想\n很多</analysis>\n<summary>\n## 1. 主要请求\n修 bug\n</summary>'), '## 1. 主要请求\n修 bug');
  assert.equal(formatSummary('## 当前进度\nx'), '## 当前进度\nx');
  assert.equal(formatSummary('<summary>没写结束标签'), '没写结束标签');
  const ins = compactInstruction({ inTurn: true });
  assert.ok(ins.startsWith(COMPACT_MARK));
  for (const s of ['主要请求与意图', '关键事实与数据', '文件与代码', '错误与修复', '当前工作', '下一步']) assert.ok(ins.includes(s), s);
});

test('用户原话跨多次压缩一字不丢：第二、三次压缩把上一份边界里的原话接着带上', () => {
  let zone = [{ role: 'user', content: '需求一：别动我正在用的桌面端' }, { role: 'assistant', content: '好' }];
  let boundary = renderBoundary({ summary: 's1', userTexts: collectUserTexts(zone) });
  zone = [{ role: 'user', content: boundary }, { role: 'user', content: '需求二：做完就发 0.27' }, { role: 'assistant', content: '好' }];
  boundary = renderBoundary({ summary: 's2', userTexts: collectUserTexts(zone) });
  zone = [{ role: 'user', content: boundary }, { role: 'user', content: '[系统] 提醒' }, { role: 'user', content: '需求三' }];
  const texts = collectUserTexts(zone);
  assert.deepEqual(texts.join('\n---\n').split('\n---\n').map((x) => x.trim()), ['需求一：别动我正在用的桌面端', '需求二：做完就发 0.27', '需求三']);
  assert.ok(!texts.join('').includes('[系统]'), '系统提醒不算用户原话');
  assert.ok(!texts.join('').includes('s1'), '旧摘要不混进原话');
});

test('回合开始压缩按整轮切：本轮用户消息永远保留；system 消息不压（旧格式会话摘要除外）', () => {
  const big = 'x'.repeat(400);
  const msgs = [
    { role: 'system', content: '[此前对话摘要]\n旧的' },
    { role: 'system', content: '【项目记忆】约定' },
    { role: 'user', content: 'q1' }, { role: 'assistant', content: big },
    { role: 'system', content: '【当前工作区】proj' },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3 ' + big }
  ];
  const r = splitByTurns(msgs, { keepTokens: 10, costOf: (m) => Math.ceil(String(m.content).length / 4) });
  assert.deepEqual(r.kept.map((m) => m.content), [msgs[7].content]);
  assert.equal(r.keptUserTurns, 1);
  assert.deepEqual(r.pinned.map((m) => m.content), ['【项目记忆】约定', '【当前工作区】proj']);
  assert.ok(r.zone.some((m) => String(m.content).startsWith('[此前对话摘要]')), '旧摘要进压缩区');
  assert.ok(!isPinnedSystem(msgs[0]) && isPinnedSystem(msgs[1]));
  const r2 = splitByTurns(msgs, { keepTokens: 100000, costOf: () => 1 });
  assert.equal(r2.zone.filter((m) => m.role === 'user').length, 0, '预算够时整段保留');
});

test('回合内边界：下一轮从库里重建后，裁掉已进摘要的步骤（连同结果），之后的步骤原样', () => {
  const turnZone = [
    { role: 'assistant', content: null, tool_calls: [call('c1', 'read_file', { path: 'a' })] }, { role: 'tool', tool_call_id: 'c1', content: 'A' },
    { role: 'assistant', content: null, tool_calls: [call('c2', 'read_file', { path: 'b' }), call('c3', 'read_file', { path: 'c' })] }
  ];
  assert.equal(lastCoveredCallIdOf(turnZone), 'c3');
  assert.equal(lastCoveredCallIdOf([{ role: 'user', content: 'x' }]), '');
  const rebuilt = [
    { role: 'user', content: `${BOUNDARY_HEAD} ...` },
    { role: 'system', content: '【当前工作区】' },
    { role: 'assistant', content: null, tool_calls: [call('c1', 'read_file', {})] }, { role: 'tool', tool_call_id: 'c1', content: 'A' },
    { role: 'assistant', content: null, tool_calls: [call('c2', 'read_file', {}), call('c3', 'read_file', {})] }, { role: 'tool', tool_call_id: 'c2', content: 'B' }, { role: 'tool', tool_call_id: 'c3', content: 'C' },
    { role: 'assistant', content: null, tool_calls: [call('c4', 'read_file', {})] }, { role: 'tool', tool_call_id: 'c4', content: 'D' },
    { role: 'assistant', content: '完成' }, { role: 'user', content: '下一句' }
  ];
  const t = trimAfterBoundary(rebuilt, 'c3');
  assert.equal(t.trimmed, 5);
  assert.deepEqual(t.messages.map((m) => m.tool_call_id || m.content || m.tool_calls?.[0]?.id), [`${BOUNDARY_HEAD} ...`, '【当前工作区】', 'c4', 'c4', '完成', '下一句']);
  assert.equal(trimAfterBoundary(rebuilt, 'nope').trimmed, 0, '找不到就不裁（宁可重复，不丢）');
  assert.equal(trimAfterBoundary(rebuilt, '').trimmed, 0);
});

test('现场兜底：最近改过的文件按磁盘上的最新内容带上；项目外的不带；git status；验收单；总量按预算截', async () => {
  const proj = tmp('fc-restore-');
  fs.writeFileSync(path.join(proj, 'a.js'), 'const a = 2; // 改过之后\n');
  fs.writeFileSync(path.join(proj, 'big.txt'), 'y'.repeat(50000));
  const outside = path.join(tmp('fc-outside-'), 'secret.txt');
  fs.writeFileSync(outside, 'SECRET');
  let git = true;
  try { execFileSync('git', ['init', '-q', proj]); } catch { git = false; }
  const zone = [
    { role: 'assistant', content: null, tool_calls: [call('1', 'read_file', { path: outside }), call('2', 'read_file', { path: path.join(proj, 'big.txt') })] },
    { role: 'assistant', content: null, tool_calls: [call('3', 'edit_file', { path: path.join(proj, 'a.js') })] }
  ];
  const r = await restoreSnapshot({ projectPath: proj, zone, todos: [{ content: '修 a.js', status: 'running' }], totalChars: 8000 });
  assert.match(r.text, /const a = 2; \/\/ 改过之后/);
  assert.ok(r.text.indexOf('a.js') < r.text.indexOf('big.txt'), '最近碰过的在前');
  assert.ok(!r.text.includes('SECRET'), '项目外的文件不自动带进上下文');
  assert.match(r.text, /其余用 read_file 按 offset 读/);
  assert.ok(r.text.length < 9500, `按预算截断（${r.text.length}）`);
  assert.match(r.text, /\[running\] 修 a\.js/);
  if (git) assert.match(r.text, /### git status/);
  const kept = [{ role: 'assistant', tool_calls: [call('9', 'read_file', { path: path.join(proj, 'a.js') })] }];
  const r2 = await restoreSnapshot({ projectPath: proj, zone, kept });
  assert.ok(!r2.files.includes(path.join(proj, 'a.js')), '保留区里已有原文的文件不重复带');
});

test('压缩请求链：对话前缀失败 → 转写（一条消息、不分块）→ 本地兜底；完整过程写成文件可供 read_file', async () => {
  const spill = tmp('fc-spill-');
  const zone = [{ role: 'user', content: '帮我修 a.js' }, { role: 'assistant', content: null, tool_calls: [call('1', 'run_command', { command: 'npm test' })] }, { role: 'tool', tool_call_id: '1', content: 'FAIL 很长的输出 ' + 'z'.repeat(3000) }];
  const prompts = [];
  const r = await compactZone({
    zone, spillDir: spill,
    summarizeConvo: async () => { throw new Error('HTTP 400'); },
    summarizeText: async (p) => { prompts.push(p); return '<summary>## 7. 当前工作\n修测试</summary>'; }
  });
  assert.equal(r.via, 'transcript');
  assert.equal(prompts.length, 1, '一次请求，不分块');
  assert.ok(prompts[0].startsWith(COMPACT_MARK) && prompts[0].includes('FAIL 很长的输出'));
  assert.match(r.content, /修测试/);
  assert.match(r.content, /帮我修 a\.js/);
  assert.ok(fs.readFileSync(r.transcriptFile, 'utf8').includes('z'.repeat(3000)), '完整记录不截断');
  assert.ok(r.content.includes(r.transcriptFile.replaceAll('\\', '/')), '边界里写了记录文件路径');
  const r2 = await compactZone({ zone, spillDir: spill, summarizeText: async () => { throw new Error('超时'); } });
  assert.equal(r2.via, 'local');
  assert.match(r2.content, /run_command npm test/);
  assert.match(r2.error, /超时/);
  // 第二次压缩：之前的记录文件接着列出来
  const r3 = await compactZone({ zone: [{ role: 'user', content: r.content }, { role: 'user', content: '再来' }], spillDir: spill, summarizeText: async () => 'x' });
  assert.ok(r3.content.includes(r.transcriptFile.replaceAll('\\', '/')) && r3.content.includes(r3.transcriptFile.replaceAll('\\', '/')));
});

test('转写超长时保头保尾，中间注明省略位置', () => {
  const zone = [{ role: 'user', content: 'HEAD-需求' }, ...Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', content: `step ${i} ` + 'w'.repeat(400) })), { role: 'assistant', content: 'TAIL-进度' }];
  const t = boundedTranscript(zone, 1000, 'D:/spill/compact-1.md');
  assert.match(t, /HEAD-需求/);
  assert.match(t, /TAIL-进度/);
  assert.match(t, /已省略；完整内容在 D:\/spill\/compact-1\.md/);
});

test('切分点对不上原文时（中断回合在前端是进展摘要）按用户消息计数对齐；用户原话不一致就保留全部', () => {
  const db = [{ role: 'user', content: '跑测试', at: 1 }, { role: 'assistant', content: '部分输出', interrupted: true, at: 2 }, { role: 'user', content: '继续', at: 3 }, { role: 'assistant', content: '好了', at: 4 }];
  const wire = [{ role: 'system', content: '记忆' }, { role: 'user', content: '跑测试' }, { role: 'assistant', content: '[上一轮在执行中被中断] …' }, { role: 'user', content: '继续' }, { role: 'assistant', content: '好了' }, { role: 'user', content: '新问题' }];
  const r = keepAfterCompactCut(wire, db, 3); // 覆盖到中断回合为止
  assert.equal(r.matched, true);
  assert.deepEqual(r.kept.map((m) => m.content), ['记忆', '继续', '好了', '新问题']);
  const r2 = keepAfterCompactCut(wire.map((m) => (m.content === '跑测试' ? { ...m, content: '别的话' } : m)), db, 3);
  assert.equal(r2.matched, false);
});

test('读压缩回复：流式 SSE 和普通 JSON 都行', async () => {
  const sse = new Response('data: {"choices":[{"delta":{"content":"<summary>A"}}]}\n\n: ping\n\ndata: {"choices":[{"delta":{"content":"B</summary>"}}]}\n\ndata: [DONE]\n\n');
  assert.equal(await readChatText(sse), '<summary>AB</summary>');
  assert.equal(await readChatText(new Response('{"choices":[{"message":{"content":"C"}}]}')), 'C');
});

test('手动 /compact 的材料：上一份边界 + 之后每一轮的完整工具过程（不再只拼最终回答）', () => {
  const s = {
    summary: `${BOUNDARY_HEAD} 旧边界`, summaryAt: 10,
    messages: [
      { role: 'user', content: '旧的', at: 5 },
      { role: 'user', content: '改 a.js', at: 11 },
      { role: 'assistant', content: '改好了', at: 12, trace: [{ tool: 'edit_file', args: '{"path":"a.js"}', result: { ok: true }, callId: 'e1', round: 0 }] }
    ]
  };
  const { zone, lastAt } = zoneFromSession(s);
  assert.equal(lastAt, 12);
  assert.equal(zone[0].content, `${BOUNDARY_HEAD} 旧边界`);
  assert.deepEqual(zone.map((m) => m.role), ['user', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(zone[2].tool_calls[0].function.name, 'edit_file');
  assert.ok(!zone.some((m) => m.content === '旧的'), '边界之前的不重复进');
});

for (const store of ['json', 'sqlite']) {
  test(`回退到压缩点之前（${store}）：摘要里有被撤回的内容，整份作废；回退在压缩点之后则保留`, async () => {
    const dir = tmp('fc-rw-');
    process.env.FINALCHECK_SESSIONS_DIR = dir;
    process.env.FINALCHECK_SESSION_STORE = store;
    try {
      const sessions = await import('../desktop/src/main/sessions.mjs');
      const s = await sessions.newSession();
      await sessions.appendTurn(s.id, 'q1', { content: 'a1' });
      await new Promise((r) => setTimeout(r, 5));
      await sessions.appendTurn(s.id, 'q2', { content: 'a2' });
      const l = await sessions.loadSession(s.id);
      const q2At = l.messages[2].at;
      await sessions.saveSummary(s.id, `${BOUNDARY_HEAD} x`, { cutAt: q2At + 1, keepFromCallId: 'c9' });
      const l2 = await sessions.loadSession(s.id);
      assert.equal(l2.summaryKeep, 'c9');
      await sessions.appendTurn(s.id, 'q3', { content: 'a3' });
      await sessions.rewindToUserTurn(s.id, 2); // 去掉 q3：在压缩点之后
      assert.ok((await sessions.loadSession(s.id)).summary, '压缩点之后的回退不影响摘要');
      await sessions.rewindToUserTurn(s.id, 1); // 去掉 q2：摘要覆盖了它
      const l3 = await sessions.loadSession(s.id);
      assert.ok(!l3.summary, '摘要作废');
      assert.ok(!l3.summaryKeep);
      sessions.closeAllSessionDatabases?.();
    } finally {
      delete process.env.FINALCHECK_SESSION_STORE;
    }
  });
}
