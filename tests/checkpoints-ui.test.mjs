// 0.33.0 文件检查点回退的界面接线：先出计划再执行、主进程重算计划、运行中拒绝、编辑重发时可选同时恢复（默认不勾）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

test('主进程：plan / restore 两个 IPC；restore 重新计算计划、会话运行中拒绝', () => {
  const b = read('desktop/src/main/backend.mjs');
  assert.match(b, /'finalcheck:checkpoint-plan'/);
  const restore = b.slice(b.indexOf("'finalcheck:checkpoint-restore'"));
  assert.match(restore.slice(0, 600), /state\.activeChats\.has\(sessionId\)/, '运行中的会话不能恢复文件');
  assert.match(restore.slice(0, 600), /applyRewindFiles\(await checkpointPlan\(/, '执行时重新算计划，不信任渲染层的清单');
  const pre = read('desktop/src/preload/index.mjs');
  assert.match(pre, /checkpointPlan:/);
  assert.match(pre, /checkpointRestore:/);
});

test('界面：用户消息上有「恢复文件」入口，先弹计划确认框；运行中不给入口', () => {
  const ml = read('desktop/src/renderer/components/MessageList.jsx');
  assert.match(ml, /onRewindFiles\(keepTurns\)/);
  const app = read('desktop/src/renderer/App.jsx');
  // 0.34.6 打字提速：回调走 latest-ref（msgApi），busy → null 的语义不变（运行中不给入口）
  assert.match(app, /onRewindFiles=\{busy \? null : msgApi\.onRewindFiles\}/);
  assert.match(app, /<RewindFilesDialog state=\{rewindBox\}/);
  const dlg = read('desktop/src/renderer/components/RewindFilesDialog.jsx');
  assert.match(dlg, /disabled=\{loading \|\| applying \|\| actionable === 0\}/, '没有可恢复的文件时确认按钮不可点');
});

test('编辑重发：横幅里「同时恢复文件」默认不勾，勾了才在回退对话前先恢复文件', () => {
  const app = read('desktop/src/renderer/App.jsx');
  const send = app.slice(app.indexOf('editing.restoreFiles && y.checkpointRestore'));
  assert.ok(send.indexOf('checkpointRestore') < send.indexOf('y.sessions.rewind'), '先恢复文件，再回退对话');
  assert.ok(!/restoreFiles: true/.test(app), '不能默认勾选（恢复文件是破坏性操作）');
  const comp = read('desktop/src/renderer/components/Composer.jsx');
  assert.match(comp, /editing\.restorable > 0/);
});
