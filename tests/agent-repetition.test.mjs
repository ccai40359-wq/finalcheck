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
  const stream = new ReadableStream({
    start(c) {
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

test('repetition: 思考流周期复读 → repetitive=true（不是 longThink）', async () => {
  // 同一段 800 字反复刷 40 次（真复读），必须走 repetitive 而不是「想太久」
  const block = '再核对一遍文件清单与构建日志，确认没有遗漏，然后继续下一项。'.repeat(26); // ~800 字
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(thinkChunk(block));
  const out = await run(chunks);
  assert.equal(out.repetitive, true, '真复读必须判 repetitive');
  assert.ok(!out.longThink, '不能归到「想太久」那一类');
});

// ---- 2026-11-20 第二版回归：Claude 审出第一版检测器会误判 ----
// 第一版用「最短 40 字周期 + 出现 4 次就算复读」，结果模型在思考里起草 5 个结构相同的
// JSON / CSS 块就被判成复读（代码块天然同构，只有字段值不同）。这个误判比原来的长度帽更隐蔽：
// 它在正常写页面时触发，提示「你复读了」，连两次就判死——正好打在 0.28 要修的同一个地方。

test('repetition: 思考里起草 5 个结构相同的 JSON 块 → 不算复读（Claude 审出的误判）', async () => {
  // 前置正常推理 + 5 个只有 name 不同的配置块
  let text = '';
  const topics = ['导航', '英雄区', '数据区', '能力清单', '证据矩阵', '页脚', '按钮', '卡片', '表格', '动效'];
  for (let i = 0; text.length < 5000; i++) {
    text += `${topics[i % topics.length]}要考虑第${i}处宽度 ${(i * 37) % 1400}px 时的表现，第${(i * 11) % 900}项留到实现阶段再调。\n`;
  }
  for (let k = 1; k <= 5; k++) {
    text += `{\n  "name": "module-${k}",\n  "enabled": true,\n  "timeout": 3000,\n  "retries": 2\n}\n`;
  }
  const out = await run([thinkChunk(text)]);
  assert.ok(!out.repetitive, '同结构配置块不是复读（只有字段值不同）');
  assert.ok(!out.longThink, '也不该标「想太久」');
});

test('repetition: 思考里起草 5 张结构相同的 CSS 卡片 → 不算复读', async () => {
  let text = '';
  const topics = ['版式', '配色', '动效', '层级', '栅格', '字体'];
  for (let i = 0; text.length < 5000; i++) {
    text += `${topics[i % topics.length]}要确认第${i}处的间距与对比度，第${(i * 13) % 800}项另说。\n`;
  }
  const card = '.card {\n  padding: 20px;\n  border-radius: 12px;\n  background: #1a1a1a;\n  border: 1px solid #333;\n}\n';
  for (let k = 1; k <= 5; k++) text += `第 ${k} 张：\n${card}这张用第${k}种点缀。\n`;
  const out = await run([thinkChunk(text)]);
  assert.ok(!out.repetitive, '同结构 CSS 块不是复读');
});

test('repetition: 同一句短句反复刷 → 仍能抓到（不能因为修误判而漏掉真复读）', async () => {
  // 36 字的句子刷 120 次 = 4320 字。第一版修到「最短周期 200 字」时这条会漏检（修过头了）。
  const sent = '我正在核对文件清单与构建日志，确认没有遗漏，接下来要检查交付物是否齐备。';
  const out = await run([thinkChunk(sent.repeat(120))]);
  assert.equal(out.repetitive, true, '短句反复刷是最典型的复读形态，必须抓到');
});

test('repetition: 相同句子夹着不同内容（A x A x A）→ 不算复读', async () => {
  // 正常写作里同一句话可能反复出现，但不会紧挨着排队——这是「复读」与「反复提及」的分界
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += '我正在核对文件清单与构建日志，确认没有遗漏。'
      + `第${i}次补充：这一处与前面不同，需要单独确认 ${(i * 53) % 700}px 的表现。`;
  }
  const out = await run([thinkChunk(text)]);
  assert.ok(!out.repetitive, '散落出现的相同句子不算复读');
});

// 造「真正互不相同」的长文本：每节都换主题词 + 换数字，不存在可被检测到的重复周期。
// 编造这种夹具很容易踩坑（第一版我用了 `${filler}${i}.` 重复 20 次，周期内完全一样，
// 被自己的检测器判成复读——这本身说明检测器有效）。
const distinctLong = (sections) => {
  const A = ['版式', '配色', '动效', '层级', '栅格', '字体', '间距', '卡片', '按钮', '导航', '页脚', '扫描线', '留白', '描边', '阴影', '渐变', '遮罩', '视差'];
  const B = ['取舍', '平衡', '克制', '索引', '回放', '比对', '校准', '收敛', '分档', '降噪', '复核', '取证'];
  const C = ['把结论落到文件行号', '按同一路径重走一遍', '标出证据等级', '说明命中条件', '记下没有跑到的部分', '区分线索与结论'];
  let t = '';
  for (let i = 0; i < sections; i++) {
    t += `第${(i * 137) % 9973}节讨论${A[i % A.length]}与${B[(i * 3) % B.length]}在${(i * 11) % 4111}px处的具体做法：`
      + `${C[(i * 5) % C.length]}，第${(i * 29) % 8761}项判断引用第${(i * 7) % 5501}段结论但措辞要换，`
      + `第${(i * 17) % 6221}行的证据等级只到B不可冒充A，第${(i * 23) % 7333}处需要再确认一次边界。`;
  }
  return t;
};

test('repetition: 思考流 12 万字互不相同 → 不判死、不标复读（r11 实测误杀）', async () => {
  // r11 实测：12 万字思考里 40/60/80/120 字滑窗最高频片段只出现 1-2 次 = 真的只是想了很久。
  // 旧逻辑（>60k 就当复读判死）会让开放式任务 0 产出，这条是防回归。
  const text = distinctLong(1500); // ~14 万字：超过旧 60k 帽（旧逻辑必误杀），但不到 200k 硬帽
  assert.ok(text.length > 120000, `夹具要超过 12 万字（实际 ${text.length}）`);
  assert.ok(text.length < 200000, `但也不能到 200k 硬帽（实际 ${text.length}）`);
  const out = await run([thinkChunk(text)]);
  assert.equal(out.reasoning.length > 120000, true);
  assert.ok(!out.repetitive, '互不相同的长思考不得判成复读');
  assert.ok(!out.longThink, '不到 200k 硬帽，也不该标「想太久」');
  assert.ok(!out.aborted, '不能被冒充成用户中断');
});

test('repetition: 思考流触及 200k 硬帽但无复读 → longThink（不是 repetitive）', async () => {
  const text = distinctLong(5000); // ~20 万字以上，必然触 200k 硬帽
  assert.ok(text.length > 200000, `夹具要超过 20 万字（实际 ${text.length}）`);
  const out = await run([thinkChunk(text)]);
  assert.equal(out.longThink, true, '触硬帽要标 longThink');
  assert.ok(!out.repetitive, '没有周期复读就不能说它是复读（会诱导模型误报「我之前循环了」）');
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
