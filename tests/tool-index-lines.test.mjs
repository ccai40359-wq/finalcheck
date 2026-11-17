// 步 3 验收（规格 §5.2）：工具结果被清理后必须保留「工具名 + 目标 + 大小」，不是零信息量占位符。
//
// 为什么重要：旧占位符 `[旧工具结果已清理：read_file；…]` 只告诉模型"这边被清了"，
// 不说读过什么文件、结果多大。模型因此无法回答"我读过哪些文件"，只能靠重读——
// 这正是那次 808 次工具调用事故的成因之一（规格缺陷 D7）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microcompact, countToolsToClean } from '../desktop/src/main/context.mjs';

function buildConvo(calls) {
  const convo = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' }
  ];
  for (const [i, c] of calls.entries()) {
    convo.push({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c' + i, type: 'function', function: { name: c.name, arguments: c.args } }]
    });
    convo.push({ role: 'tool', tool_call_id: 'c' + i, content: c.body });
  }
  return convo;
}

test('step3: 索引行含工具名 + 目标 + 大小（read_file 显示路径）', () => {
  const convo = buildConvo([
    { name: 'read_file', args: '{"path":"src/audit.mjs"}', body: 'x'.repeat(4000) },
    { name: 'read_file', args: '{"path":"src/b.mjs"}', body: 'y'.repeat(4000) },
    { name: 'read_file', args: '{"path":"src/c.mjs"}', body: 'z'.repeat(4000) }
  ]);
  microcompact(convo, { keepRecentTool: 1 });
  const first = String(convo.filter((m) => m.role === 'tool')[0].content);
  assert.match(first, /^\[索引\]/, '必须是索引行');
  assert.match(first, /read_file/, '必须点名工具');
  assert.match(first, /src\/audit\.mjs/, '必须给出路径');
  assert.match(first, /~\d+ tok/, '必须给出结果大小');
  assert.doesNotMatch(first, /旧工具结果已清理/, '不能退回旧占位符');
});

test('step3: grep_code 的索引行显示 pattern（搜了什么比在哪搜更有用）', () => {
  const convo = buildConvo([
    { name: 'grep_code', args: '{"pattern":"NON_JS_EXTS","path":"src/"}', body: 'x'.repeat(400) },
    { name: 'grep_code', args: '{"pattern":"other","path":"src/"}', body: 'y'.repeat(400) }
  ]);
  microcompact(convo, { keepRecentTool: 1 });
  const first = String(convo.filter((m) => m.role === 'tool')[0].content);
  assert.match(first, /NON_JS_EXTS/, 'grep 的索引行必须显示 pattern');
});

test('step3: run_command 的索引行只留命令名（不泄露参数里的 token）', () => {
  const convo = buildConvo([
    { name: 'run_command', args: '{"command":"curl -H \\"Authorization: Bearer sk-secret123\\" http://x"}', body: 'ok'.repeat(100) },
    { name: 'run_command', args: '{"command":"echo hi"}', body: 'ok'.repeat(100) }
  ]);
  microcompact(convo, { keepRecentTool: 1 });
  const first = String(convo.filter((m) => m.role === 'tool')[0].content);
  assert.match(first, /run_command curl/, '保留命令名');
  assert.doesNotMatch(first, /sk-secret123/, '绝不能把 token 写进索引行');
});

test('step3: 索引行显著小于原正文（真的省 token）', () => {
  const convo = buildConvo([
    { name: 'read_file', args: '{"path":"big.mjs"}', body: 'x'.repeat(20000) },
    { name: 'read_file', args: '{"path":"small.mjs"}', body: 'y'.repeat(100) }
  ]);
  const before = String(convo.filter((m) => m.role === 'tool')[0].content).length;
  microcompact(convo, { keepRecentTool: 1 });
  const after = String(convo.filter((m) => m.role === 'tool')[0].content).length;
  assert.ok(after < 120, `索引行必须很短，实际 ${after}`);
  assert.ok(before / after > 100, `压缩比应 >100x，实际 ${Math.round(before / after)}x`);
});

test('step3: 幂等——跑两次不重复包装索引行', () => {
  const convo = buildConvo([
    { name: 'read_file', args: '{"path":"a"}', body: 'x'.repeat(1000) },
    { name: 'read_file', args: '{"path":"b"}', body: 'y'.repeat(1000) },
    { name: 'read_file', args: '{"path":"c"}', body: 'z'.repeat(1000) }
  ]);
  const first = microcompact(convo, { keepRecentTool: 1 });
  assert.equal(first, true);
  const again = microcompact(convo, { keepRecentTool: 1 });
  assert.equal(again, false, '第二次应无改动（幂等）');
  const line = String(convo.filter((m) => m.role === 'tool')[0].content);
  assert.equal(line.split('[索引]').length - 1, 1, '索引前缀不能出现两次');
});

test('step3: countToolsToClean 与 microcompact 口径一致（都是索引行判定）', () => {
  const convo = buildConvo([
    { name: 'read_file', args: '{"path":"a"}', body: 'x'.repeat(100) },
    { name: 'read_file', args: '{"path":"b"}', body: 'y'.repeat(100) },
    { name: 'read_file', args: '{"path":"c"}', body: 'z'.repeat(100) }
  ]);
  assert.equal(countToolsToClean(convo, { keepRecentTool: 1 }), 2);
  microcompact(convo, { keepRecentTool: 1 });
  assert.equal(countToolsToClean(convo, { keepRecentTool: 1 }), 0, '压完就不该再有待清理项');
});

test('step3: 模型能回答「我读过哪些文件」（索引行可枚举）', () => {
  const convo = buildConvo([
    { name: 'read_file', args: '{"path":"src/scope-policy.mjs"}', body: 'x'.repeat(2000) },
    { name: 'read_file', args: '{"path":"src/walk.mjs"}', body: 'y'.repeat(2000) },
    { name: 'read_file', args: '{"path":"src/audit.mjs"}', body: 'z'.repeat(2000) },
    { name: 'read_file', args: '{"path":"last.mjs"}', body: 'w'.repeat(2000) }
  ]);
  microcompact(convo, { keepRecentTool: 1 });
  const indexLines = convo.filter((m) => m.role === 'tool' && String(m.content).startsWith('[索引]'));
  assert.equal(indexLines.length, 3);
  const joined = indexLines.map((m) => m.content).join('\n');
  // 三个被压的文件名都要能从索引行里读出来
  for (const f of ['scope-policy.mjs', 'walk.mjs', 'audit.mjs']) {
    assert.match(joined, new RegExp(f.replace(/\./g, '\\.')), `索引行必须能读出 ${f}`);
  }
});
