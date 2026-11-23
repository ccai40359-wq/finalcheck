// 0.31.2：压缩之后「上下文使用情况」必须跟着变。
//
// 用户实测（2026-11-23，截图证据）：压缩提示写着「约 908451 token → 16411 token」，
// 但输入框上方的 Context 面板一动不动，看起来像压缩根本没生效。
//
// 两条独立成因，这里各钉一条：
//   ① 估算口径错：ipc-system 直接累加前端传来的**全量**历史，而 /compact 之后真正发给模型的是
//      「摘要 + 边界之后的消息」。全量历史里压缩前那 90 万 token 还全在，面板当然不动。
//   ② 实测值没作废：面板优先显示上一次请求的 prompt_tokens（measured）。压缩把它换成了摘要后
//      那个值已经没有意义，但 sessionUsage 里还留着，UI 就一直显示旧的大数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const systemSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/ipc/ipc-system.mjs'), 'utf8');
const compactSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/ipc/ipc-compact.mjs'), 'utf8');
const backendSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/backend.mjs'), 'utf8');
const appSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');

/* ---------------- ① 估算口径必须按压缩边界裁 ---------------- */

// 复刻 ipc-system 的估算口径（CJK 1 字≈1 token、其余 4 字符≈1 token）
const est = (s) => {
  const text = String(s ?? '');
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
};
const contentTokens = (m) => est(m?.content);

test('context stats: 源码必须按 summaryAt 裁掉压缩前历史（否则面板永远显示旧大数）', () => {
  assert.match(systemSrc, /keepAfterCompactCut/,
    'ipc-system 必须用与 agent 同一个 keepAfterCompactCut 裁到「实际会发出去的那部分」');
  assert.match(systemSrc, /const cutAt = Number\(sess\.summaryAt\) \|\| 0;/,
    '裁切必须按会话的 summaryAt（摘要覆盖到的位置）');
  assert.match(systemSrc, /counted = Array\.isArray\(kept\) \? kept : rawMessages;/,
    '裁切结果要真的拿去计数');
  // 反例：不能再出现「直接遍历 payload.messages」的老写法
  assert.ok(!/for \(const m of payload\.messages \|\| \[\]\)/.test(systemSrc),
    '不能再直接累加全量历史（那就是本 bug 的原实现）');
});

test('context stats: 摘要本身必须计入（它就是压缩后要发出去的第一条）', () => {
  assert.match(systemSrc, /metaTokens \+= estTokens\(summaryText\)/,
    '摘要不计入会让压缩后的数字偏小，同样失真');
});

test('context stats: 压缩前后口径对比（复刻真实场景算一遍）', async () => {
  const { keepAfterCompactCut } = await import('../desktop/src/main/compact-cut.mjs');
  // 压缩前：两大段历史 + 本轮输入
  const bigA = { role: 'user', content: 'a'.repeat(40000), at: 1000 };
  const bigB = { role: 'assistant', content: 'b'.repeat(40000), at: 1001 };
  const now = { role: 'user', content: '继续' };
  const dbMessages = [bigA, bigB];
  const wire = [{ role: 'user', content: bigA.content }, { role: 'assistant', content: bigB.content }, now];

  const before = wire.reduce((n, m) => n + contentTokens(m), 0);
  assert.ok(before > 18000, '压缩前的估算应该很大（复刻用户那 90 万 token 的量级）');

  // 压缩后：summaryAt 覆盖前两条，只剩本轮输入 + 摘要
  const { kept } = keepAfterCompactCut(wire, dbMessages, 1002);
  assert.equal(kept.length, 1, '压缩边界之后只剩本轮那条用户消息');
  assert.equal(kept[0].content, '继续');
  const afterBody = kept.reduce((n, m) => n + contentTokens(m), 0);
  const afterTotal = afterBody + est('handoff summary …') // 摘要本身
    + est('system prompt') + est('tools');                // 系统提示与工具 schema（与压缩无关的固定部分）

  // 关键断言：压缩后必须显著小于压缩前（旧实现两者一模一样）
  assert.ok(afterBody < before / 100, `压缩后的历史部分必须大幅下降（before=${before} after=${afterBody}）`);
  assert.ok(afterTotal < before, '含固定开销后仍然必须比压缩前小');
});

/* ---------------- ② 实测值必须作废 ---------------- */

test('compact: 压缩成功后清掉「上一次请求的实测用量」（内存 + 落盘）', () => {
  assert.match(compactSrc, /registerCompactIpc\(\{ ipcMain, getWin, store, sessionProjectPathOf = \(\) => '', sessionUsage = null \}\)|sessionUsage = null/,
    'registerCompactIpc 必须接受 sessionUsage 才能清内存记录');
  assert.match(compactSrc, /const invalidateMeasured = async \(sessionId\) => \{/);
  assert.match(compactSrc, /sessionUsage\?\.delete\?\.\(key\)/, '内存里的实测记录要删（面板优先读它）');
  assert.match(compactSrc, /await sessions\.setSessionUsage\(key, null\)/, '落盘的实测记录也要清，否则重启后又变回旧值');
  assert.match(compactSrc, /await invalidateMeasured\(sessionId\);/, '压缩成功路径必须真的调用');
  assert.match(compactSrc, /invalidateMeasured: true/, '事件里要标明这次压缩作废了实测值');
});

test('compact: 压缩失败/取消时不动作废（旧实测仍然有效）', () => {
  const okPath = compactSrc.slice(compactSrc.indexOf("if (r.via === 'local') throw"), compactSrc.indexOf('} catch (e) {'));
  assert.match(okPath, /await invalidateMeasured\(sessionId\);/);
  const catchPath = compactSrc.slice(compactSrc.indexOf('} catch (e) {'), compactSrc.indexOf('} finally {'));
  assert.ok(!/invalidateMeasured/.test(catchPath), '失败/取消路径不得清实测值');
});

test('源码钉: sessionUsage 已接进 registerCompactIpc（不接就是死代码）', () => {
  assert.match(backendSrc, /registerCompactIpc\(\{ ipcMain, getWin, store, sessionProjectPathOf, sessionUsage: state\.sessionUsage \}\)/);
});

test('context stats: 摘要之前的实测记录一律不采信（不依赖压缩时清记录那条路径）', () => {
  assert.match(systemSrc, /if \(measured && sess\?\.summary\)/,
    '必须有过期判定：摘要存在时，比摘要还早的实测记录不能用');
  assert.match(systemSrc, /if \(cutAt > 0 && at > 0 && at < cutAt\) measured = null;/,
    '判据是 measured.at < summaryAt');
});

/* ---------------- ③ UI 必须立刻重算（不能等 5 分钟轮询） ---------------- */

test('UI: 压缩结束事件触发面板立刻重算', () => {
  const block = appSrc.slice(appSrc.indexOf("if (ev.kind === 'compact-start' || ev.kind === 'compact-end')"), appSrc.indexOf('// 主进程 notice'));
  assert.match(block, /ev\.kind === 'compact-end' && !ev\.cancelled && !ev\.error/,
    '只有成功结束才重算（取消/失败时数字本来就没变）');
  assert.match(block, /y?\??\.contextStats\?\.\(\{/, '必须重新拉一次统计，不能只改本地状态');
  assert.match(block, /\.then\(setCtxStats\)/, '结果要写回面板');
});
