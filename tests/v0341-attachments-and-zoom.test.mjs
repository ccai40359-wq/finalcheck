// 0.34.1 第二批回归测试：
//   ⑤ 附件目录必须可读（用户自己贴的截图点开看大图/右栏预览）—— 但 config.json 仍然拒绝
//   ⑥ 界面缩放：Ctrl/Cmd + `+` / `-` / `0`，档位离散、夹紧 0.5–3.0、失败静默
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPolicy, assertPathAllowed } from '../desktop/src/main/policy.mjs';


function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/* ================= ⑤ 附件目录可读 ================= */

test('0.34.1 ⑤: 附件目录里的截图可读（不再报 Access to a sensitive path is blocked）', (t) => {
  const appdata = tmp(t, 'fc-0341-appdata-');
  const attachDir = path.join(appdata, 'FinalCheck', 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  const shot = path.join(attachDir, '1755804307969-b8a10631a4b8c9a4fc6c59ed8c84131.png');
  fs.writeFileSync(shot, 'x');

  const p = createPolicy({
    projectPath: tmp(t, 'fc-0341-proj-'),
    mode: 'workspace',
    platform: 'win32',
    env: { APPDATA: appdata, USERPROFILE: tmp(t, 'fc-0341-home-') }
  });
  const v = assertPathAllowed(p, shot, { tool: 'artifact:read' });
  assert.equal(v.ok, true, '附件必须可读，实际：' + JSON.stringify(v).slice(0, 200));
});

test('0.34.1 ⑤: config.json / projects.json 仍然按敏感路径拒绝', (t) => {
  const appdata = tmp(t, 'fc-0341-appdata2-');
  const root = path.join(appdata, 'FinalCheck');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), '{"apiKey":"secret"}');
  fs.writeFileSync(path.join(root, 'projects.json'), '{}');

  const p = createPolicy({
    projectPath: tmp(t, 'fc-0341-proj2-'),
    mode: 'workspace',
    platform: 'win32',
    env: { APPDATA: appdata, USERPROFILE: tmp(t, 'fc-0341-home2-') }
  });
  for (const name of ['config.json', 'projects.json']) {
    const v = assertPathAllowed(p, path.join(root, name), { tool: 'read_file' });
    assert.equal(v.ok, false, `${name} 必须仍被拒绝`);
    assert.equal(v.matchedRule, 'sensitive');
  }
});

test('0.34.1 ⑤: 附件目录的写仍然受限（只放行读）', (t) => {
  const appdata = tmp(t, 'fc-0341-appdata3-');
  const attachDir = path.join(appdata, 'FinalCheck', 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  const p = createPolicy({
    projectPath: tmp(t, 'fc-0341-proj3-'),
    mode: 'readonly',   // 只读模式：写一律拒（这条与附件放行无关，是 readonly 的职责）
    platform: 'win32',
    env: { APPDATA: appdata, USERPROFILE: tmp(t, 'fc-0341-home3-') }
  });
  const w = assertPathAllowed(p, path.join(attachDir, 'new.png'), { write: true, tool: 'write_file' });
  assert.equal(w.ok, false, 'readonly 模式下写附件目录也要拒');
});

test('0.34.1 ⑤: 会话库（sessions）仍然敏感', (t) => {
  const appdata = tmp(t, 'fc-0341-appdata4-');
  const root = path.join(appdata, 'FinalCheck');
  fs.mkdirSync(root, { recursive: true });
  const db = path.join(root, 'sessions', 'finalcheck.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, 'sqlite');
  const p = createPolicy({
    projectPath: tmp(t, 'fc-0341-proj4-'),
    mode: 'workspace',
    platform: 'win32',
    env: { APPDATA: appdata, USERPROFILE: tmp(t, 'fc-0341-home4-') }
  });
  // 会话库在 FinalCheck 根下（不是 attachments），必须仍被敏感规则挡住
  const v = assertPathAllowed(p, db, { tool: 'read_file' });
  assert.equal(v.ok, false, '会话库不能因为放了 attachments 就一起放开');
});

/* ================= ⑥ 界面缩放 ================= */

test('0.34.1 ⑥: zoom 模块导出齐全且默认 1', async () => {
  const m = await import('../desktop/src/main/zoom.mjs');
  assert.equal(typeof m.installZoomShortcuts, 'function');
  assert.equal(typeof m.stepZoom, 'function');
  assert.equal(typeof m.applyZoom, 'function');
  assert.equal(typeof m.getZoom, 'function');
  assert.equal(m.getZoom(), 1, '默认倍率必须是 1');
});

test('0.34.1 ⑥: 档位离散且夹紧 0.5–3.0', async () => {
  const m = await import('../desktop/src/main/zoom.mjs');
  // 纯 Node 里没有 BrowserWindow，applyZoom 会走 getAllWindows() 拿到空数组 → 只更新内部状态
  assert.equal(m.applyZoom(null, 99), 3, '上限夹到 3');
  assert.equal(m.applyZoom(null, 0.01), 0.5, '下限夹到 0.5');
  assert.equal(m.applyZoom(null, 'abc'), 1, '非法值回落 1');
  // stepZoom(0) = 复位
  assert.equal(m.stepZoom(null, 0), 1);
  // 放大一档：1 → 1.1
  assert.equal(m.stepZoom(null, +1), 1.1);
  // 缩小一档回到 1
  assert.equal(m.stepZoom(null, -1), 1);
});

test('0.34.1 ⑥: 全档位表单调且都在合法范围', async () => {
  const m = await import('../desktop/src/main/zoom.mjs');
  const list = m.zoomLevelList();
  assert.ok(list.length >= 8, '至少 8 档，否则放大太粗');
  for (let i = 1; i < list.length; i++) assert.ok(list[i] > list[i - 1], `档位必须单调递增（${list[i - 1]} → ${list[i]}）`);
  assert.ok(list[0] >= 0.5 && list[list.length - 1] <= 3);
  assert.ok(list.includes(1), '必须有 100%');
});

test('0.34.1 ⑥: 快捷键认 `+` / `=` / 小键盘 / `-` / `0`', () => {
  const src = fs.readFileSync('desktop/src/main/zoom.mjs', 'utf8');
  // 美式键盘 Ctrl+= 才是 +（Shift 被吃），小键盘是 '+'
  assert.match(src, /key === '\+' \|\| key === '='/, '要认 = 号（Shift+加号的实际键值）');
  assert.match(src, /NumpadAdd/, '要认小键盘加号');
  assert.match(src, /NumpadSubtract/, '要认小键盘减号');
  assert.match(src, /Digit0/, '要认 Ctrl+0 复位');
  assert.match(src, /before-input-event/, '用 before-input-event（比渲染层 keydown 可靠）');
  assert.match(src, /preventDefault/, '必须 preventDefault，否则页面会收到原始按键');
});

test('0.34.1 ⑥: 跨平台修饰键（Windows/Linux 用 Ctrl，macOS 用 Cmd）', () => {
  const src = fs.readFileSync('desktop/src/main/zoom.mjs', 'utf8');
  assert.match(src, /process\.platform === 'darwin' \? input\.meta : input\.control/);
});

test('0.34.1 ⑥: index 在建窗前装快捷键，且倍率持久化到 config', () => {
  const idx = fs.readFileSync('desktop/src/main/index.mjs', 'utf8');
  const installAt = idx.indexOf('installZoomShortcuts(');
  assert.ok(installAt > 0, '必须调用 installZoomShortcuts');
  // createWindow 在文件里出现多次（托盘回调里也有一次），要取**最后一次**（whenReady 里的实际建窗）
  const createAt = idx.lastIndexOf('createWindow();');
  assert.ok(installAt < createAt, '必须在 whenReady 的 createWindow 之前装（首扇窗才挂得上钩子）');
  assert.match(idx, /uiZoom/, '要从 config 读回上次的倍率');
  const cfg = fs.readFileSync('desktop/src/main/ipc/config-store.mjs', 'utf8');
  assert.match(cfg, /out\.uiZoom/, 'config 必须归一化 uiZoom 字段');
});
