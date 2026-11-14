// 复读熔断回归（round8 用户实测）：模型同义复述刷了 20+ 分钟，harness 照单全收，
// 最终靠网关 402 才收场。锁三件事：
// 1) 熔断必须以 repetitive 标志上抛——不能被 catch 误标成「用户中断」（旧代码的死分支）；
// 2) 思考流（reasoning）与工具参数流（tool args）这两块盲区同样要熔断；
// 3) 正常长内容（未触发任何帽）不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeStream } from '../desktop/src/main/agent-service.mjs';

const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

// 先吐 firstChunk，abort 信号一响就把流打断（模拟真实 fetch 被熔断 abort 的路径）
const sseAbortable = (chunks, signal) => {
  let cRef = null;
  const stream = new ReadableStream({
    start(c) {
      cRef = c;
      for (const ch of chunks) c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(ch) + '\n\n'));
      signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const contentChunk = (text) => ({ choices: [{ index: 0, delta: { content: text } }] });
const thinkChunk = (text) => ({ choices: [{ index: 0, delta: { reasoning_content: text } }] });
const tcChunk = (id, name, args) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }]
});

const run = (chunks, ctl = null) => consumeStream(sse(chunks), () => {}, () => {}, ctl);

test('repetition: 尾部 200 字精确重复 ≥4 次 → repetitive=true（不是 aborted）', async () => {
  const block = 'A'.repeat(60) + 'B'.repeat(40) + '构建和测试都已通过，缺 README、.gitignore 和 git 仓库，先核对源码再补交付物。'; // >200 字
  const chunks = [];
  for (let i = 0; i < 6; i++) chunks.push(contentChunk(block));
  const ctl = new AbortController();
  const out = await run(chunks, ctl);
  assert.equal(out.repetitive, true, '必须熔断并带 repetitive 标志');
  assert.ok(!out.aborted, '不能被误标成用户中断（旧代码死分支的根因）');
  assert.deepEqual(out.toolCalls, [], '熔断轮次的工具调用不执行');
});

test('repetition: 熔断 abort 打断流（catch 路径）→ repetitive 标志不丢', async () => {
  const block = 'x'.repeat(120) + '现在检查交付物是否齐备，构建和测试都已通过，还缺 README 和 git 提交。'; // >200 字
  const chunks = [];
  for (let i = 0; i < 8; i++) chunks.push(contentChunk(block)); // 8 次重复，第 400 字检查点就会命中
  const ctl = new AbortController();
  const out = await consumeStream(sseAbortable(chunks, ctl.signal), () => {}, () => {}, ctl);
  assert.equal(out.repetitive, true);
  assert.ok(!out.aborted, 'catch 路径同样不能冒充用户中断');
});

test('repetition: 正文无精确重复但 >20000 字 → 长度帽兜底熔断', async () => {
  // 每段都不同（避开 exact-tail 检测），模拟同义复述的整体膨胀
  const chunks = [];
  for (let i = 0; i < 50; i++) {
    chunks.push(contentChunk(`第${i}步：构建与测试均已通过（第 ${i} 次确认，耗时 ${i}ms），当前缺口是 README、.gitignore 与 git 提交，稍后逐一补齐。` + 'v'.repeat(320 + i)));
  }
  const out = await run(chunks);
  assert.equal(out.repetitive, true);
});

test('repetition: 思考流（reasoning）> 60k → 熔断（content 帽子够不着思考流的盲区）', async () => {
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(thinkChunk('再核对一遍文件清单与构建日志，确认没有遗漏。'.repeat(120)));
  const out = await run(chunks);
  assert.equal(out.repetitive, true);
});

test('repetition: 工具参数流 > 100k → 熔断（Writing read_file… 21m57s 的盲区）', async () => {
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(tcChunk('call_loop', 'read_file', '{"path":"' + 'a'.repeat(3000) + '"}'));
  const out = await run(chunks);
  assert.equal(out.repetitive, true);
  assert.deepEqual(out.toolCalls, []);
});

test('repetition: 正常长内容（18k、无重复）+ 正常工具调用 → 不熔断', async () => {
  const chunks = [];
  for (let i = 0; i < 36; i++) {
    chunks.push(contentChunk(`步骤 ${i}：读取 src/pages/${['Home', 'Benchmark', 'Download', 'Changelog', 'Capabilities'][i % 5]}.tsx 第 ${i * 37} 行附近的实现，确认与规格一致，记录偏差。`));
  }
  chunks.push(tcChunk('call_ok', 'read_file', '{"path":"src/App.tsx"}'));
  const out = await run(chunks);
  assert.ok(!out.repetitive, '正常工作流不允许被误杀');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].function.name, 'read_file');
});
