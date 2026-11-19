// 2026-11-19：对齐 Claude Code 的上下文管理——保护前缀缓存（成批折叠）、到线由模型写交接摘要、用户原话原样保留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';
import { microcompact, INDEX_COLLAPSE_TO } from '../desktop/src/main/context.mjs';
import { modelFullCompact } from '../desktop/src/main/in-turn-compact.mjs';

const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

// 相邻两次请求之间，上一次已发送的消息有没有被改动（被改 = 网关前缀缓存从该处失效）
function prefixBreaks(bodies) {
  let breaks = 0;
  for (let k = 1; k < bodies.length; k++) {
    const a = bodies[k - 1].messages;
    const b = bodies[k].messages;
    for (let i = 0; i < a.length; i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) { breaks++; break; }
    }
  }
  return breaks;
}

test('成批折叠：超过速度上限后不是每步都改动前面的消息（前缀缓存大部分步命中）', async () => {
  const ROUNDS = 60;
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    calls++;
    if (calls <= ROUNDS) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `r${calls}`, function: { name: 'big', arguments: JSON.stringify({ n: calls }) } }] } }] }]);
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  const task = '把宣传片第三幕的转场改顺，保持 45 秒总时长';
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock/v1', apiKey: 'k', model: 'm', contextWindow: 1000000, inTurnTokenCap: 8000 },
    messages: [{ role: 'user', content: task }],
    tools: { big: async ({ n }) => ({ n, content: 'x'.repeat(1000) }) },
    fetchImpl,
    systemPrompt: 'sys',
  });
  assert.match(out.answer, /完成/);
  const breaks = prefixBreaks(bodies);
  const lastMsgs = bodies.at(-1).messages;
  assert.ok(lastMsgs.some((m) => m.role === 'tool' && String(m.content).startsWith('[索引]')), '确实发生过折叠');
  assert.ok(breaks >= 1, '至少折叠过一次');
  assert.ok(breaks <= ROUNDS / 4, `前缀被改动的次数应远少于步数（实际 ${breaks}/${ROUNDS}）`);
  assert.ok(lastMsgs.some((m) => m.role === 'user' && m.content === task), '用户任务原样保留');
});

test('索引行上限成批收口：收口一次后，再新增调用不会改写最前面的计数行', () => {
  const list = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const add = (i) => {
    list.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'f' + i }) } }] });
    list.push({ role: 'tool', tool_call_id: 'c' + i, content: 'y'.repeat(400) });
  };
  for (let i = 0; i < 320; i++) add(i);
  microcompact(list, { keepRecentTool: 5 });
  const details = list.filter((m) => m.role === 'tool' && String(m.content).startsWith('[索引]') && !String(m.content).includes('⋯'));
  assert.ok(details.length <= INDEX_COLLAPSE_TO, `收口后明细不超过 ${INDEX_COLLAPSE_TO}（实际 ${details.length}）`);
  const snapshot = JSON.stringify(list.slice(0, 300));
  for (let i = 320; i < 330; i++) { add(i); microcompact(list, { keepRecentTool: 5 }); }
  assert.equal(JSON.stringify(list.slice(0, 300)), snapshot, '之后 10 步都没有改写前部消息');
});

function longConvo(task) {
  const list = [{ role: 'system', content: 'sys' }, { role: 'user', content: task }];
  for (let i = 0; i < 20; i++) {
    list.push({ role: 'assistant', content: `第 ${i} 步`, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.ts` }) } }] });
    list.push({ role: 'tool', tool_call_id: 'c' + i, content: 'z'.repeat(300) });
  }
  return list;
}

test('modelFullCompact：模型写交接摘要，用户原话一字不差保留，最近消息原样、不从孤立 tool 开头', async () => {
  const task = '做一个 45 秒的产品宣传片：开头 3 秒 logo 渐显，中段三个卖点各 10 秒，结尾放二维码和官网地址，配色用品牌蓝 #1A4DFF，不要用任何真人照片。' + '补充要求。'.repeat(40);
  const list = longConvo(task);
  let prompt = '';
  const r = await modelFullCompact(list, { summarize: async (p) => { prompt = p; return '## 用户要求\n45 秒宣传片\n## 当前进度\n在做第三幕'; } });
  assert.equal(r.mode, 'model');
  assert.match(prompt, /交接摘要/);
  assert.match(prompt, /src\/f3\.ts/, '过程记录里带上了调用目标');
  const summary = list[1].content;
  assert.ok(summary.startsWith('[历史摘要]'));
  assert.ok(summary.includes(task), '用户原话完整保留（旧做法只留前 60 字）');
  assert.match(summary, /在做第三幕/);
  assert.notEqual(list[2].role, 'tool', '保留区不能从孤立的 tool 消息开头');
  assert.ok(list.length <= 1 + 1 + 9);

  // 第二次压缩：第一次保留的用户原话要接着带上
  for (let i = 20; i < 40; i++) {
    list.push({ role: 'assistant', content: `第 ${i} 步`, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    list.push({ role: 'tool', tool_call_id: 'c' + i, content: 'z'.repeat(300) });
  }
  await modelFullCompact(list, { summarize: async () => '## 当前进度\n在做结尾' });
  assert.ok(list[1].content.includes(task), '多次压缩后用户原话仍在');
  assert.match(list[1].content, /在做结尾/);
});

test('modelFullCompact：模型摘要失败 → 回落本地摘要并报告原因，不阻断', async () => {
  const list = longConvo('做个视频');
  const r = await modelFullCompact(list, { summarize: async () => { throw new Error('网关 502'); } });
  assert.equal(r.mode, 'local');
  assert.match(r.error, /502/);
  assert.ok(String(list[1].content).startsWith('[历史摘要]'));
});

// 不重复的长正文（避免触发复读检测）
const longText = (seed) => Array.from({ length: 260 }, (_, i) => `第${seed}-${i}条：${((i + 1) * 7919 * (seed + 3)) % 100003}`).join('，');

test('回合内：折完工具结果仍贴着上限（正文太长）→ 调用模型写交接摘要', async () => {
  let calls = 0;
  const prompts = [];
  const bodies = [];
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    calls++;
    if (calls <= 14) return sse([{ choices: [{ delta: { content: '我的分析：' + longText(calls) } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: `r${calls}`, function: { name: 'noop', arguments: JSON.stringify({ step: calls }) } }] } }] }]);
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  const task = '把 PPT 第 5 页的图表换成柱状图';
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock/v1', apiKey: 'k', model: 'm', contextWindow: 1000000, inTurnTokenCap: 8000 },
    messages: [{ role: 'user', content: task }],
    tools: { noop: async () => ({ ok: true }) },
    fetchImpl,
    systemPrompt: 'sys',
    summarize: async (p) => { prompts.push(p); return '## 当前进度\n已改到第 5 页'; },
  });
  assert.match(out.answer, /完成/);
  assert.ok(prompts.length >= 1, '调用了模型摘要');
  const last = bodies.at(-1).messages;
  const sum = last.find((m) => m.role === 'user' && String(m.content).startsWith('[历史摘要]'));
  assert.ok(sum, '有交接摘要');
  assert.ok(sum.content.includes(task), '用户原话在摘要里原样保留');
  assert.match(sum.content, /已改到第 5 页/);
});

// ───────── 2026-11-19 真实事故回归：图片 base64 被当成文字估 token → 每隔几步就失忆
test('估算：图片按固定成本计，不把 base64 当文字（一张 40 万字符的截图不能估成 10 万 token）', async () => {
  const { estimateMessagesTokens, IMAGE_TOKEN_ESTIMATE } = await import('../desktop/src/main/context.mjs');
  const big = 'A'.repeat(400000);
  const msg = { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } }, { type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } }] };
  const tok = estimateMessagesTokens([msg]);
  assert.ok(tok <= 2 * IMAGE_TOKEN_ESTIMATE + 20, `两张图估算应约 ${2 * IMAGE_TOKEN_ESTIMATE}（实际 ${tok}）`);
});

test('视觉迭代长回合：频繁看大图也不触发折叠/摘要，模型不会每隔几步失忆', async () => {
  const ROUNDS = 40;
  const bodies = [];
  let calls = 0;
  let summaries = 0;
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    calls++;
    if (calls <= ROUNDS) {
      const name = calls % 2 ? 'view_image' : 'noop';
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `r${calls}`, function: { name, arguments: JSON.stringify({ step: calls }) } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  const shot = 'B'.repeat(450000); // 一张真实截图的 base64 量级
  const task = '把宣传片第 2 幕的字幕溢出修掉';
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock/v1', apiKey: 'k', model: 'm', contextWindow: 1000000, vision: true },
    messages: [{ role: 'user', content: task }],
    tools: {
      view_image: async ({ step }) => ({ ok: true, __images: [{ mime: 'image/png', base64: shot, label: `f${step}.png` }, { mime: 'image/png', base64: shot, label: `g${step}.png` }] }),
      noop: async ({ step }) => ({ ok: true, step }),
    },
    fetchImpl,
    systemPrompt: 'sys',
    summarize: async () => { summaries++; return '摘要'; },
  });
  assert.match(out.answer, /完成/);
  assert.equal(summaries, 0, '不应触发模型摘要');
  const last = bodies.at(-1).messages;
  assert.ok(!last.some((m) => m.role === 'tool' && String(m.content).startsWith('[索引]')), '不应折叠工具结果');
  assert.ok(last.some((m) => m.role === 'user' && m.content === task), '用户任务原样在');
  assert.ok(last.filter((m) => m.role === 'tool').length === ROUNDS, '全部工具结果原文保留');
});

test('兜底：速度上限触发的模型摘要之间至少隔 20 次请求', async () => {
  let calls = 0;
  let summaries = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls <= 30) return sse([{ choices: [{ delta: { content: longText(calls) } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: `r${calls}`, function: { name: 'noop', arguments: JSON.stringify({ s: calls }) } }] } }] }]);
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  await runAgentTurn({
    config: { baseUrl: 'https://mock/v1', apiKey: 'k', model: 'm', contextWindow: 1000000, inTurnTokenCap: 3000 },
    messages: [{ role: 'user', content: 't' }],
    tools: { noop: async () => ({ ok: true }) },
    fetchImpl,
    systemPrompt: 'sys',
    summarize: async () => { summaries++; return '## 当前进度\nx'; },
  });
  assert.ok(summaries >= 1 && summaries <= 2, `30 次请求里摘要最多 2 次（实际 ${summaries}）`);
});
