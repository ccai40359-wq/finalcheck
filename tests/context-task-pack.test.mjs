// 步 9 验收（规格 §3.3 第 3 步 / §5.2 行为验收）：
//   · 最后一条 user 消息永不丢
//   · [当前任务包] 置底
//
// 为什么这条最硬：按 token 预算从尾部往前累积时，用户最后那句可能落进被压缩区。
// 规格 §2.3 实测：按条数保留（20/50/100 条）会把 user 消息**全部**挤掉（含 0 条 user）。
// 模型看不到「现在要做什么」，后面的活全白干。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext } from '../desktop/src/main/context.mjs';

const TASK_RE = /【当前任务】/;

test('step9: 最后一条 user 永不丢——被压进 zone 也要补回来', async () => {
  // 造一个「最后一条 user 超大」的场景：按 token 预算它会落进被压缩区
  const messages = [
    { role: 'user', content: '老问题：' + 'A'.repeat(3000) },
    { role: 'assistant', content: '老回答' },
    { role: 'user', content: '老问题2：' + 'B'.repeat(3000) },
    { role: 'assistant', content: '老回答2' },
    { role: 'user', content: '我要你现在做这件事：' + 'C'.repeat(3000) }
  ];
  const out = await assembleContext(messages, {
    budgetChars: 500,
    summarize: async () => 'SUM'
  });
  assert.equal(out.compacted, true);
  const joined = out.messages.map((m) => String(m.content)).join('\n');
  assert.match(joined, /我要你现在做这件事/, '最后一条 user 的内容必须还在');
  assert.match(joined, /当前任务/, '必须有【当前任务】包');
});

test('step9: 任务包置底——永远是最后一条消息', async () => {
  // 内容要足够大才会真触发压缩（否则 compacted=false，不会加任务包）
  const filler = 'x'.repeat(400);
  const messages = [
    { role: 'user', content: 'q1 ' + filler },
    { role: 'assistant', content: 'a1 ' + filler },
    { role: 'user', content: 'q2 ' + filler },
    { role: 'assistant', content: 'a2 ' + filler },
    { role: 'user', content: '最终请求：修 bug ' + filler }
  ];
  const out = await assembleContext(messages, { budgetChars: 600, summarize: async () => 'S' });
  assert.equal(out.compacted, true, '这个规模必须触发压缩');
  const last = out.messages[out.messages.length - 1];
  assert.equal(last.role, 'system');
  assert.match(String(last.content), TASK_RE);
  assert.match(String(last.content), /最终请求：修 bug/, '任务包必须引用最后一条 user 原文');
});

test('step9: 任务包逐字引用用户原话（不许改写）', async () => {
  const userText = '把 src/audit.mjs 第 42 行的 NON_JS_EXTS 加上 .rs（逐字）';
  const messages = [
    { role: 'user', content: 'x'.repeat(2000) },
    { role: 'assistant', content: 'y' },
    { role: 'user', content: userText }
  ];
  const out = await assembleContext(messages, { budgetChars: 300, summarize: async () => 'S' });
  const pack = String(out.messages[out.messages.length - 1].content);
  assert.ok(pack.includes(userText), '用户原话要逐字出现在任务包里');
});

test('step9: 500 条工具结果压缩后，最后一条 user 仍在', async () => {
  // 规格 §5.2 的验收原文：构造 500 条 tool 结果，压缩后最后一条 user 仍在
  const messages = [{ role: 'user', content: '开始任务：验收这个项目' }];
  for (let i = 0; i < 500; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'c' + i, content: 'r' + i + '-' + 'z'.repeat(200) });
  }
  messages.push({ role: 'user', content: '现在总结一下' });
  const out = await assembleContext(messages, { budgetChars: 2000, summarize: async () => 'SUM' });
  const joined = out.messages.map((m) => String(m.content)).join('\n');
  assert.match(joined, /现在总结一下/, '最后一条 user 必须还在');
  assert.equal(out.messages[out.messages.length - 1].role, 'system', '末尾是任务包');
});

test('step9: 没有 user 消息时不生成任务包（不造空包）', async () => {
  const messages = [
    { role: 'assistant', content: 'a'.repeat(1000) },
    { role: 'tool', tool_call_id: 't', content: 'b'.repeat(1000) }
  ];
  const out = await assembleContext(messages, { budgetChars: 100, summarize: async () => 'S' });
  const hasPack = out.messages.some((m) => m.role === 'system' && TASK_RE.test(String(m.content)));
  assert.equal(hasPack, false, '没有 user 时不该出现空任务包');
});

test('step9: 预算内不压缩 → 不注入任务包（不改变正常行为）', async () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你' }
  ];
  const out = await assembleContext(messages, { budgetChars: 100000 });
  assert.equal(out.compacted, false);
  assert.equal(out.messages.length, 2, '预算内原样返回，不加任务包');
  assert.equal(out.messages, messages, '返回同一个数组引用（零改动）');
});
