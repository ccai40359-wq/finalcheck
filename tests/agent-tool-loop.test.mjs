// 行为层防复读（CC 式）签名回归：动作复读（文字各不相同但每轮重跑完全一样的调用）
// 与文字复读（repetitive 熔断兜的那类）是两条不同的病，这里锁签名计算的三个坑：
// 参数格式抖动（空格/键序）/ 并行调用顺序抖动 / 非 JSON 参数的原文兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallSig } from '../desktop/src/main/agent-service.mjs';

const call = (name, args) => ({ function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

test('tool-loop: 参数空格与键序抖动不影响签名（同参 = 同签名）', () => {
  const a = toolCallSig([call('read_file', '{"path":"src/App.tsx","limit":100}')]);
  const b = toolCallSig([call('read_file', '{"limit": 100, "path": "src/App.tsx"}')]);
  assert.equal(a, b, '键序/空格不同但语义相同的参数必须同签名');
});

test('tool-loop: 参数真不同 → 签名必须不同（换参数=换思路，不拦）', () => {
  const a = toolCallSig([call('read_file', '{"path":"src/App.tsx"}')]);
  const b = toolCallSig([call('read_file', '{"path":"src/pages/Home.tsx"}')]);
  const c = toolCallSig([call('read_file', '{"path":"src/App.tsx","limit":50}')]);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('tool-loop: 并行多调用顺序抖动 → 同签名（每轮并行批内部顺序无关）', () => {
  const a = toolCallSig([call('read_file', '{"path":"a.ts"}'), call('grep_code', '{"pattern":"TODO"}')]);
  const b = toolCallSig([call('grep_code', '{"pattern":"TODO"}'), call('read_file', '{"path":"a.ts"}')]);
  assert.equal(a, b);
});

test('tool-loop: 非 JSON 参数按原文比对（原文相同 = 同签名）', () => {
  const a = toolCallSig([call('run_command', 'dir /b src')]);
  const b = toolCallSig([call('run_command', 'dir /b src')]);
  const c = toolCallSig([call('run_command', 'dir /b dist')]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('tool-loop: 空调用列表 → null 签名（不参与连续计数）', () => {
  assert.equal(toolCallSig([]), null);
  assert.equal(toolCallSig(null), null);
});

test('tool-loop: 工具名相同参数空对象抖动（{} vs {"":undefined 场景不崩）', () => {
  const a = toolCallSig([call('audit_project', '{}')]);
  const b = toolCallSig([call('audit_project', '')]);
  // '' 与 '{}' 都走 canonArgs：'' 原文兜底为 ''，'{}' 解析为 '{}'——两者不同签名是允许的
  // （真实网关要么都传 '{}' 要么都不传，不会混），这里只验证不抛异常且返回字符串。
  assert.equal(typeof a, 'string');
  assert.equal(typeof b, 'string');
});
