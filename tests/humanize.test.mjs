// humanize 纯函数单测：错误人话化 / 工具参数摘要 / 裸 JSON 摘除。
// 断言口径：用户可见文案里不出现 JSON 结构碎片，也不出现英文 Error 前缀。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeToolError, summarizeToolArgs, formatToolArgs, stripBareJson } from '../desktop/src/renderer/lib/humanize.js';

const BAD_FRAGMENTS = ['{"', '":', '}]'];
const assertClean = (value) => {
  const s = String(value ?? '');
  for (const frag of BAD_FRAGMENTS) assert.ok(!s.includes(frag), `不应包含 ${frag}：${s}`);
  assert.ok(!/\bError\s*:/.test(s), `不应包含 Error:：${s}`);
};

test('humanizeToolError: JSON 解析错误带位置 → 中文一句话', () => {
  const out = humanizeToolError("Expected ',' or ']' after array element in JSON at position 948 (line 12 column 3)");
  assert.equal(out, '脚本指令的 JSON 格式有误（第 948 字符附近缺逗号或括号）');
  assertClean(out);
});

test('humanizeToolError: JSON 解析错误不带位置 → 省略位置', () => {
  const out = humanizeToolError("Error: Unexpected end of JSON input");
  assert.equal(out, '脚本指令的 JSON 格式有误（缺逗号或括号）');
  assertClean(out);
});

test('humanizeToolError: HTTP 4xx/5xx → 网关状态码 + message 截断', () => {
  const out = humanizeToolError('HTTP 502: upstream connect error');
  assert.equal(out, '网关返回 502：upstream connect error');
  assertClean(out);

  const long = humanizeToolError(`HTTP 500: ${'x'.repeat(200)}`);
  assert.ok(long.startsWith('网关返回 500：'));
  // 「网关返回 500：」前缀之外，message 不超过 60 字
  assert.ok(long.length <= '网关返回 500：'.length + 60);
  assertClean(long);

  const statusOnly = humanizeToolError('Error: request failed with status 404');
  assert.ok(statusOnly.includes('网关返回 404'), statusOnly);
  assertClean(statusOnly);

  const statusCode = humanizeToolError('HTTP status code: 502');
  assert.ok(statusCode.includes('网关返回 502'), statusCode);
  assertClean(statusCode);
});

test('humanizeToolError: 超时 / AbortError → 执行超时', () => {
  assert.equal(humanizeToolError('timeout of 30000ms exceeded'), '执行超时（已中断）');
  assert.equal(humanizeToolError('AbortError: The operation was aborted'), '执行超时（已中断）');
  assert.equal(humanizeToolError('ETIMEDOUT'), '执行超时（已中断）');
});

test('humanizeToolError: ENOENT → 文件不存在', () => {
  assert.equal(humanizeToolError("ENOENT: no such file or directory, open 'D:\\x.js'"), '文件不存在或已被移动');
});

test('humanizeToolError: 栈信息只留第一行', () => {
  const out = humanizeToolError('boom\n    at foo.js:1:1\n    at bar.js:2:2');
  assert.equal(out, 'boom');
  assert.ok(!out.includes('    at '));
});

test('humanizeToolError: 兜底压成一行、去括号、≤120 字', () => {
  const out = humanizeToolError(`{ "bad": [ ${'长文本 '.repeat(60)} ] }`);
  assert.ok(!out.includes('\n'), out);
  assert.ok(!/[{}[\]]/.test(out), out);
  assert.ok(out.length <= 120, `长度 ${out.length}`);
  assertClean(out);
});

test('summarizeToolArgs: 文件类工具 → 路径（可算时才带 +N/-M）', () => {
  assert.equal(summarizeToolArgs('read_file', { path: 'D:/proj/src/app.js' }), 'D:/proj/src/app.js');
  assert.equal(summarizeToolArgs('edit_file', { path: 'D:/proj/src/app.js' }), 'D:/proj/src/app.js');
  assert.equal(summarizeToolArgs('edit_file', { path: 'D:/proj/src/app.js', added: 4, removed: 2 }), 'D:/proj/src/app.js +4/-2');
  assert.equal(summarizeToolArgs('write_file', '{"path":"D:/proj/new.js"}'), 'D:/proj/new.js');
});

test('summarizeToolArgs: run_command → 命令首行 ≤80 字', () => {
  assert.equal(summarizeToolArgs('run_command', { command: 'npm run build\n&& npm test' }), 'npm run build');
  const long = summarizeToolArgs('run_command', { command: 'x'.repeat(140) });
  assert.ok(long.length <= 80, `长度 ${long.length}`);
  assert.ok(long.endsWith('…'));
});

test('summarizeToolArgs: audit / quality / probe / stress / review 的人类摘要', () => {
  assert.equal(summarizeToolArgs('audit_project', { dir: 'D:/proj', tier: 'L2' }), 'D:/proj · L2');
  assert.equal(summarizeToolArgs('audit_project', { dir: 'D:/proj' }), 'D:/proj · 默认档位');
  assert.equal(summarizeToolArgs('quality_gate', { dir: 'D:/proj' }), 'D:/proj');
  assert.equal(summarizeToolArgs('probe_target', { url: 'http://127.0.0.1:8080', requests: 12 }), 'http://127.0.0.1:8080 · 12 次');
  assert.equal(summarizeToolArgs('probe_target', { url: 'http://127.0.0.1:8080' }), 'http://127.0.0.1:8080 · 10 次');
  assert.equal(summarizeToolArgs('stress_target', { url: 'http://127.0.0.1:8080', duration: 45, connections: 30 }), 'http://127.0.0.1:8080 · 45s · 30 连接');
  assert.equal(summarizeToolArgs('review_diff', { dir: 'D:/proj', base: 'HEAD~1' }), 'D:/proj · 对比 HEAD~1');
  assert.equal(summarizeToolArgs('review_diff', { dir: 'D:/proj' }), 'D:/proj · 对比 HEAD');
});

test('summarizeToolArgs: 未知工具不铺 JSON 碎片', () => {
  const out = summarizeToolArgs('unknown_tool', { alpha: { nested: 1 }, beta: [1, 2], note: '看一下日志' });
  assert.equal(out, '看一下日志');
  assertClean(out);

  // 坏 JSON 字符串不能原样铺出，也不能折叠成「参数已折叠」
  const broken = summarizeToolArgs('unknown_tool', '{"alpha":1,"beta":');
  assert.ok(!broken.includes('参数已折叠'), broken);
  assert.ok(broken.length <= 160, `长度 ${broken.length}`);
  assertClean(broken);

  // 纯文本入参去掉 Error: 前缀，不留英文异常壳
  assert.equal(summarizeToolArgs('unknown_tool', 'Error: boom'), 'boom');

  assert.equal(summarizeToolArgs('unknown_tool', {}), '无参数');
});

test('summarizeToolArgs: 双重转义 JSON 字符串 → 还原成命令，不再折叠', () => {
  const doubleEscaped = String.raw`{\"command\": \"dir /b D:\\\\x\"}`;
  const out = summarizeToolArgs('run_command', doubleEscaped);
  assert.equal(out, 'dir /b D:\\x');
  assert.ok(!out.includes('参数已折叠'), out);
  assert.ok(!out.includes('\\"'), out);
  assertClean(out);
});

test('formatToolArgs: run_command 保留完整多行命令 + cwd / timeout', () => {
  const cmd = 'cd D:\\x && echo 中文\n第二行';
  const lines = formatToolArgs('run_command', { command: cmd, cwd: 'D:\\x', timeoutMs: 30000 });
  const command = lines.find((l) => l.label === 'command');
  assert.ok(command, '应有 command 行');
  assert.equal(command.value, cmd);
  assert.ok(command.value.includes('\n'), '多行命令不能被压成一行');
  assert.ok(command.value.includes('echo 中文\n第二行'));
  assert.ok(lines.some((l) => l.label === 'cwd' && l.value === 'D:\\x'), '应含 cwd');
  assert.ok(lines.some((l) => l.label === 'timeout' && l.value === '30000ms'), '应含 timeout');
  const joined = lines.map((l) => `${l.label}: ${l.value}`).join('\n');
  assert.ok(!joined.includes('参数已折叠'));
  assert.ok(!joined.includes('\\"'), joined);
});

test('formatToolArgs: read_file 展示 path / offset / limit', () => {
  const lines = formatToolArgs('read_file', { path: 'D:\\a\\b.mjs', offset: 10, limit: 50 });
  const joined = lines.map((l) => `${l.label}: ${l.value}`).join('\n');
  assert.ok(joined.includes('path: D:\\a\\b.mjs'), joined);
  assert.ok(joined.includes('offset: 10'), joined);
  assert.ok(joined.includes('limit: 50'), joined);
  assert.ok(!joined.includes('{"'), joined);
});

test('formatToolArgs: 未知工具逐标量拆行，不铺 JSON', () => {
  const lines = formatToolArgs('未知工具', { foo: 'bar', n: 2 });
  const joined = lines.map((l) => `${l.label}: ${l.value}`).join('\n');
  assert.ok(joined.includes('foo: bar'), joined);
  assert.ok(joined.includes('n: 2'), joined);
  assert.ok(!joined.includes('{"'), joined);
  assert.ok(!joined.includes('":'), joined);
  assert.ok(!joined.includes('}]'), joined);
});

test('formatToolArgs: run_workflow 只列 goal 与步骤名/依赖，不铺整段 JSON', () => {
  const lines = formatToolArgs('run_workflow', {
    goal: '体检并复核',
    steps: [
      { id: 'a', name: '静态扫描', depends_on: [] },
      { id: 'b', name: '人工复核', depends_on: ['a'] }
    ]
  });
  const joined = lines.map((l) => `${l.label}: ${l.value}`).join('\n');
  assert.ok(joined.includes('goal: 体检并复核'), joined);
  assert.ok(joined.includes('- 静态扫描'), joined);
  assert.ok(joined.includes('- 人工复核（依赖 a）'), joined);
  assert.ok(!joined.includes('{"'), joined);
});

test('formatToolArgs: 所有输出不含「参数已折叠」与转义引号', () => {
  const inputs = [
    ['run_command', String.raw`{\"command\": \"dir /b D:\\\\x\"}`],
    ['run_command', { command: 'npm run build\n&& npm test', cwd: 'D:\\proj' }],
    ['read_file', { path: 'D:\\a\\b.mjs', offset: 10, limit: 50 }],
    ['未知工具', { foo: 'bar', n: 2 }],
    ['未知工具', '{"alpha":1,"beta":'],
    ['', null]
  ];
  for (const [name, args] of inputs) {
    const joined = formatToolArgs(name, args).map((l) => `${l.label}: ${l.value}`).join('\n');
    assert.ok(!joined.includes('参数已折叠'), `${name} 出现折叠文案：${joined}`);
    assert.ok(!joined.includes('\\"'), `${name} 出现转义引号：${joined}`);
    assertClean(joined);
  }
});

test('stripBareJson: 摘走 ≥120 字符且 ≥3 个 key 的裸 JSON', () => {
  const bare = `{"a":1,"b":{"c":2},"d":"${'x'.repeat(120)}"}`;
  const input = `前面是正常说明。\n\n${bare}\n\n后面是结论。`;
  const { text, removed } = stripBareJson(input);
  assert.equal(removed.length, 1);
  assert.equal(removed[0], bare);
  assert.ok(text.includes('前面是正常说明'));
  assert.ok(text.includes('后面是结论'));
  assert.ok(!text.includes('{"'));
  assert.ok(!text.includes('":'));
  assert.ok(!text.includes('}]'));
});

test('stripBareJson: 短 JSON / 围栏 JSON / 行内代码不摘', () => {
  const small = '{"a":1,"b":2,"c":3}';
  assert.equal(stripBareJson(`说明 ${small} 结束`).removed.length, 0);

  const bare = `{"a":1,"b":{"c":2},"d":"${'x'.repeat(120)}"}`;
  const fenced = `看代码：\n\`\`\`json\n${bare}\n\`\`\`\n结束`;
  const fencedResult = stripBareJson(fenced);
  assert.equal(fencedResult.removed.length, 0);
  assert.equal(fencedResult.text, fenced);

  const inline = `看这里 \`${bare}\` 就行`;
  assert.equal(stripBareJson(inline).removed.length, 0);
});

test('stripBareJson: 多个裸 JSON 全部摘走，正文保持段落', () => {
  const bare = `{"a":1,"b":{"c":2},"d":"${'x'.repeat(120)}"}`;
  const input = `${bare}\n\n中间文字。\n\n${bare}`;
  const { text, removed } = stripBareJson(input);
  assert.equal(removed.length, 2);
  assert.equal(text, '中间文字。');
});

test('stripBareJson: 非字符串输入安全返回', () => {
  assert.deepEqual(stripBareJson(null), { text: '', removed: [] });
  assert.deepEqual(stripBareJson(undefined), { text: '', removed: [] });
  assert.deepEqual(stripBareJson(42), { text: '42', removed: [] });
});
