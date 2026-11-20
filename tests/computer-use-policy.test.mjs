// Computer use 策略回归（2026-11-21）
// 照抄 Claude Code 的三层 tier：浏览器 read / 终端 IDE click / 其它 full，
// 由「前台应用检查」强制执行。这几条测试锁住的是「挡住该挡的」和「该放的放」两个方向。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierForApp, checkActionAllowed, AccessLedger, TIER_CAPS } from '../desktop/src/main/computer-use-policy.mjs';

test('cu-policy: 浏览器类应用 → read tier', () => {
  for (const [proc, title] of [
    ['chrome', 'Google Chrome'],
    ['msedge', 'Microsoft Edge'],
    ['firefox', 'Mozilla Firefox'],
    ['Safari', 'Safari'],
    ['brave', 'Brave Browser'],
    ['360se', '360安全浏览器']
  ]) {
    assert.equal(tierForApp(proc, title), 'read', `${proc} 必须被判为 read`);
  }
});

test('cu-policy: 终端与 IDE → click tier', () => {
  for (const [proc, title] of [
    ['WindowsTerminal', 'Windows Terminal'],
    ['powershell', 'PowerShell'],
    ['cmd', 'Command Prompt'],
    ['Code', 'Visual Studio Code'],
    ['cursor', 'Cursor'],
    ['idea64', 'IntelliJ IDEA'],
    ['node', 'node'],
    ['python', 'python']
  ]) {
    assert.equal(tierForApp(proc, title), 'click', `${proc} 必须被判为 click`);
  }
});

test('cu-policy: 其它应用 → full tier', () => {
  for (const [proc, title] of [
    ['WINWORD', 'Word 文档'],
    ['EXCEL', 'Excel 表格'],
    ['Photoshop', 'Adobe Photoshop'],
    ['vlc', 'VLC media player'],
    ['notepad', '记事本']
  ]) {
    assert.equal(tierForApp(proc, title), 'full', `${proc} 必须被判为 full`);
  }
});

test('cu-policy: read tier 挡掉点击与输入（这是 tier 存在的全部意义）', () => {
  assert.equal(checkActionAllowed('read', 'left_click').ok, false);
  assert.equal(checkActionAllowed('read', 'right_click').ok, false);
  assert.equal(checkActionAllowed('read', 'type').ok, false);
  assert.equal(checkActionAllowed('read', 'key').ok, false);
  assert.equal(checkActionAllowed('read', 'drag').ok, false);
  // 但截图必须允许——否则 read tier 连看都看不了
  assert.equal(checkActionAllowed('read', 'screenshot').ok, true);
  // 拒绝理由要能指导下一步（指向 browser_* 工具）
  const r = checkActionAllowed('read', 'left_click');
  assert.match(r.reason, /browser_/, '拒绝时要点出正确的替代工具');
});

test('cu-policy: click tier 只放左键，挡掉输入/右键/拖拽', () => {
  assert.equal(checkActionAllowed('click', 'left_click').ok, true, '左键必须允许');
  assert.equal(checkActionAllowed('click', 'left_click').ok && checkActionAllowed('click', 'click').ok, true);
  assert.equal(checkActionAllowed('click', 'right_click').ok, false, '右键必须挡（终端里的上下文菜单能做事）');
  assert.equal(checkActionAllowed('click', 'type').ok, false, '输入必须挡');
  assert.equal(checkActionAllowed('click', 'key').ok, false, '按键必须挡');
  assert.equal(checkActionAllowed('click', 'drag').ok, false);
  assert.equal(checkActionAllowed('click', 'scroll').ok, true, '滚动可以（只是浏览内容）');
});

test('cu-policy: full tier 全放', () => {
  for (const a of ['left_click', 'right_click', 'double_click', 'type', 'key', 'drag', 'scroll', 'move']) {
    assert.equal(checkActionAllowed('full', a).ok, true, `${a} 在 full 下应允许`);
  }
});

test('cu-policy: 未知动作默认放行（不因为漏列就误挡）', () => {
  assert.equal(checkActionAllowed('full', 'zoom').ok, true);
  assert.equal(checkActionAllowed('full', 'cursor_position').ok, true);
});

test('cu-policy: AccessLedger 逐应用授权、重启后清空', () => {
  const ledger = new AccessLedger();
  assert.equal(ledger.isGranted('WINWORD'), false, '未授权前不能放行');

  ledger.grant(['WINWORD', 'EXCEL']);
  assert.equal(ledger.isGranted('WINWORD'), true);
  assert.equal(ledger.isGranted('winword'), true, '大小写不敏感');
  assert.equal(ledger.isGranted('EXCEL'), true);
  assert.equal(ledger.isGranted('Photoshop'), false, '没授权的应用仍拒');
  assert.deepEqual(ledger.list().sort(), ['excel', 'winword']);

  ledger.revokeAll();
  assert.equal(ledger.isGranted('WINWORD'), false, '撤销后必须回到未授权');
});

test('cu-policy: TIER_CAPS 三档齐全且互不相同', () => {
  assert.deepEqual(Object.keys(TIER_CAPS).sort(), ['click', 'full', 'read']);
  assert.equal(TIER_CAPS.read.click, false);
  assert.equal(TIER_CAPS.click.click, 'left-only');
  assert.equal(TIER_CAPS.full.click, true);
});
