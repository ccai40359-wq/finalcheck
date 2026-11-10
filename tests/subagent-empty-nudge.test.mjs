// 子代理「交白卷」加固的回归（用户实测：跑 20-38 次工具后回复为空 → EMPTY_CONTENT + 面板「没有留下交付物」）。
// 锁住四件事：
//  1. 第一次空回复 → 普通催交；第二次空回复 → tool_choice='none' + 证据摘要，仍空才认输（上限 2 次）；
//  2. 连续空两次 → 确定性 salvage：content 非空、包含工具清单 + 疑似发现，errorCode 仍是 EMPTY_CONTENT；
//  3. salavage 正文同步写进 transcript（salvaged 标记），面板不会再判「没有留下交付物」；
//  4. 网关不认 tool_choice='none'（400）→ 去掉字段重试并记 warning，流程不硬失败、正文仍非空。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSubagentTurn, buildEmptyNudgeDigest } from '../desktop/src/main/agent-service.mjs';
import { salvageSubagentContent, SALVAGE_EMPTY_HEADER } from '../desktop/src/main/subagent-salvage.mjs';

const READ_FILE_SCHEMA = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取本机文本文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};

const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

const toolCall = (id, name, args) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }]
});
const emptyReply = (finishReason = 'stop') => ({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
const textReply = (content, finishReason = 'stop') => ({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] });

// 工具结果里故意埋一条 file:line + 漏洞关键词，验证 salvage 的「疑似发现」
const TOOL_RESULT = { ok: true, note: 'src/auth.js:42 unauthorized secret leak in session check' };

function baseArgs(fetchImpl, extra = {}) {
  return {
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '请审查鉴权与会话',
    kind: 'find',
    role: '审查员',
    tools: { read_file: async () => TOOL_RESULT },
    toolsSchema: [READ_FILE_SCHEMA],
    requiresTools: true,
    forceFirstToolChoice: true,
    fetchImpl,
    retryBaseMs: 1,
    ...extra
  };
}

test('subagent-empty: 空一次 → 催交后拿到结论（不再要求只催一次）', async () => {
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sse([toolCall('c1', 'read_file', '{"path":"src/auth.js"}')]);
    if (bodies.length === 2) return sse([emptyReply()]);
    return sse([textReply('已确认发现：src/auth.js:42 会话检查缺失。未完成项：无。')]);
  };
  const result = await runSubagentTurn(baseArgs(fetchImpl));

  assert.equal(bodies.length, 3, `应是 工具轮 + 空回复 + 催交后结论，实际 ${bodies.length} 次请求`);
  assert.equal(bodies[0].tool_choice, 'required', '首轮仍强制工具');
  assert.equal(bodies[1].tool_choice, undefined, '第一次催交不强制 tool_choice');
  assert.ok(
    bodies[2].messages.some((m) => m.role === 'user' && String(m.content).includes('你这一轮没有输出任何正文')),
    '第二次请求必须带上补交提示'
  );
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.match(result.content, /已确认发现/);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.roundsUsed, 3);
  assert.equal(result.toolCount, 1);
});

test('subagent-empty: 连续空两次 → 第二次强制 tool_choice=none + 证据摘要；仍空走 salvage（content 非空）', async () => {
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sse([toolCall('c1', 'read_file', '{"path":"src/auth.js"}')]);
    return sse([emptyReply()]); // 之后每一轮都空
  };
  const result = await runSubagentTurn(baseArgs(fetchImpl));

  // 工具轮 + 2 次催交 + 第 3 次空着收场 = 4 次请求，绝不无限重试
  assert.equal(bodies.length, 4, `上限两次催交，实际 ${bodies.length} 次请求`);
  const secondNudge = bodies[3];
  assert.equal(secondNudge.tool_choice, 'none', '第二次催交必须用 tool_choice=none 强制只输出正文');
  const nudgeText = secondNudge.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
  assert.match(nudgeText, /已确认发现/);
  assert.match(nudgeText, /证据清单/);
  assert.match(nudgeText, /未完成项/);
  assert.match(nudgeText, /src\/auth\.js:42/, '第二次催交要把最近工具结果压成证据摘要附上');

  assert.equal(result.errorCode, 'EMPTY_CONTENT', '空回复的失败原因保留 EMPTY_CONTENT');
  assert.equal(result.salvaged, true);
  assert.equal(result.salvageReason, 'empty');
  assert.ok(result.content && result.content.trim(), '绝不返回空 content');
  assert.ok(result.content.startsWith(SALVAGE_EMPTY_HEADER));
  assert.match(result.content, /已调用工具：1 次/);
  assert.match(result.content, /已用工具清单/);
  assert.match(result.content, /read_file → /);
  assert.match(result.content, /疑似发现/, '工具输出里的 file:line / 漏洞关键词要被摘出来');
  assert.match(result.content, /src\/auth\.js:42/);
  assert.match(result.content, /未完成：未产出最终结论/);
  assert.equal(result.roundsUsed, 4);
  assert.equal(result.finishReason, 'stop');
  assert.ok(result.warnings.some((w) => w.includes('空回复补交 2 次')), `应记录补交失败 warning，实际 ${JSON.stringify(result.warnings)}`);

  // 面板口径：salvage 正文要作为最后一个 assistant 条目落进 transcript，并带 salvaged 标记
  const last = [...result.transcript].reverse().find((m) => m.role === 'assistant' && String(m.content || '').trim());
  assert.ok(last, 'transcript 必须留下可展示的正文');
  assert.equal(last.salvaged, true);
  assert.equal(last.content, result.content);
});

test('subagent-empty: 网关不认 tool_choice=none（400）→ 去掉字段重试 + warning，正文仍非空', async () => {
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (body.tool_choice === 'none') {
      return new Response('{"error":{"message":"tool_choice unsupported"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (bodies.length === 1) return sse([toolCall('c1', 'read_file', '{"path":"src/auth.js"}')]);
    return sse([emptyReply()]);
  };
  const result = await runSubagentTurn(baseArgs(fetchImpl));

  assert.ok(bodies.some((b) => b.tool_choice === 'none'), '必须真的尝试过 tool_choice=none');
  assert.ok(
    result.warnings.some((w) => w.includes('tool_choice')),
    `400 要在 warnings 里记录，实际 ${JSON.stringify(result.warnings)}`
  );
  assert.equal(result.errorCode, 'EMPTY_CONTENT');
  assert.ok(result.content && result.content.trim(), '网关不认 tool_choice 也必须给得出正文');
  assert.match(result.content, /【未完成·无最终结论】/);
});

test('subagent-empty: 网关 500 耗尽重试 → 失败也有正文，且错误码不是 EMPTY_CONTENT', async () => {
  const fetchImpl = async () => new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } });
  const result = await runSubagentTurn(baseArgs(fetchImpl, { requiresTools: false, forceFirstToolChoice: false }));

  assert.ok(result.error, '网关失败必须失败');
  assert.equal(result.errorCode, 'HTTP 500', '不能把「网关挂了」误报成「没有返回内容」');
  assert.ok(result.content && result.content.trim(), '失败也必须留正文（salvage）');
  assert.match(result.content, /【未完成·无最终结论】/);
});

test('subagent-empty: 空回复带 finish_reason=length 也会催交（旧逻辑直接放弃）', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return sse([emptyReply('length')]);
  };
  const result = await runSubagentTurn(baseArgs(fetchImpl, { requiresTools: false, forceFirstToolChoice: false }));

  assert.equal(calls, 3, `length 空回复同样最多催两次，实际 ${calls} 次`);
  assert.equal(result.errorCode, 'EMPTY_CONTENT');
  assert.equal(result.truncated, true);
  assert.ok(result.content && result.content.trim());
});

test('subagent-empty: salvage 全量工具清单（上限 30 条）+ 疑似发现去重', () => {
  const transcript = [];
  for (let i = 0; i < 35; i += 1) {
    transcript.push({ role: 'tool', name: 'read_file', content: `{"path":"f${i}.js","line":"src/f${i}.js:${i + 1}","note":"no issue"}` });
  }
  transcript.push({ role: 'tool', name: 'run_command', content: 'grep -n secret src/auth.js:42 未授权访问' });
  transcript.push({ role: 'tool', name: 'run_command', content: 'grep -n secret src/auth.js:42 未授权访问' }); // 重复行应去重
  const text = salvageSubagentContent({ transcript, reason: 'empty', error: '子代理没有返回内容' });

  assert.match(text, /已调用工具：37 次/);
  assert.match(text, new RegExp(`- read_file → .*f0\\.js`), '清单从最早的工具开始，不只最后 5 条');
  assert.match(text, /…另有 7 次工具调用未展开/, '超过 30 条要注明省略数量');
  const findingLines = text.split('\n').filter((l) => l.startsWith('- run_command → ') && l.includes('未授权'));
  assert.equal(findingLines.length, 1, '疑似发现要按内容去重');
  assert.match(text, /未完成：未产出最终结论/);
});

test('subagent-empty: buildEmptyNudgeDigest 只取工具行首行并限长', () => {
  const digest = buildEmptyNudgeDigest([
    { role: 'user', content: '不要出现' },
    { role: 'tool', content: '{"a":1}\n第二行不要' },
    { role: 'tool', content: '   ' },
    { role: 'tool', content: 'line-3' }
  ]);
  assert.match(digest, /^- \{"a":1\}$/m);
  assert.doesNotMatch(digest, /不要出现/);
  assert.doesNotMatch(digest, /第二行不要/);
  assert.match(digest, /^- line-3$/m);
  assert.ok(digest.length <= 2400);
});
