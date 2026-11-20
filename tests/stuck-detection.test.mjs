// 死磕检测回归（2026-11-20）
// 用户的观察：模型会「像人一样钻入死胡同」——改 5 次代码，每次报的还是同一个错。
// 这和「复读」是两件事：复读是同文字反复出现，死磕是换着法子试但撞同一个错误。
// 现有机制只兜「同参数重复调用」（toolLoopRounds），抓不到这种。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFailureSig } from '../desktop/src/main/agent-service.mjs';

const result = (over) => ({ trace: { tool: 'run_command', args: '', result: { blocked: false, code: 0, stdout: '', stderr: '', ...over } } });

test('死磕检测: 同一个编译错误（只改了行号）→ 同一指纹', () => {
  const a = extractFailureSig([result({ code: 1, stderr: "D:/proj/src/app.js:418\n  el(\"div\", { class: \"value\" }, money(value)));\nSyntaxError: missing ) after argument list" })]);
  const b = extractFailureSig([result({ code: 1, stderr: "D:/proj/src/app.js:422\n  el(\"div\", { class: \"value\" }, money(value)));\nSyntaxError: missing ) after argument list" })]);
  assert.ok(a, '要能提取出指纹');
  assert.equal(a, b, '行号变了但错误相同 → 必须同一指纹（否则永远数不到 5 轮）');
  assert.match(a, /SyntaxError/);
});

test('死磕检测: 同一类错误但路径不同 → 同一指纹', () => {
  const a = extractFailureSig([result({ code: 1, stderr: 'Cannot find module D:/a/b/c.js' })]);
  const b = extractFailureSig([result({ code: 1, stderr: 'Cannot find module /usr/local/x/y.js' })]);
  assert.equal(a, b, '路径归一化后应收敛到同一指纹');
});

test('死磕检测: 不同的错误 → 不同指纹（不能把换了问题当成死磕）', () => {
  const a = extractFailureSig([result({ code: 1, stderr: 'SyntaxError: missing ) after argument list' })]);
  const b = extractFailureSig([result({ code: 1, stderr: 'EADDRINUSE: address already in use :1665' })]);
  assert.notEqual(a, b, '两个不同的根因不能算同一个死磕');
});

test('死磕检测: 工具显式报错也算失败指纹', () => {
  const sig = extractFailureSig([{ trace: { tool: 'read_file', args: '', result: { error: '文件不存在：D:/x/y.md' } } }]);
  assert.ok(sig, '工具报 error 也要算死磕证据');
  assert.match(sig, /err:/);
});

test('死磕检测: 成功的工具结果 → 无指纹（死磕计数应清零）', () => {
  const ok = extractFailureSig([
    result({ code: 0, stdout: 'all good' }),
    result({ code: 0, stdout: '16 passed' })
  ]);
  assert.equal(ok, null, '跑通的轮次不能算死磕');
});

test('死磕检测: 测试失败数进指纹', () => {
  const a = extractFailureSig([result({ code: 1, stdout: '2 failed, 15 passed' })]);
  const b = extractFailureSig([result({ code: 1, stdout: '3 failed, 14 passed' })]);
  assert.ok(a);
  assert.notEqual(a, b, '失败数变了说明进展了，不是死磕');
});

test('死磕检测: 空输入不炸', () => {
  assert.equal(extractFailureSig([]), null);
  assert.equal(extractFailureSig(null), null);
  assert.equal(extractFailureSig([{}]), null);
});
