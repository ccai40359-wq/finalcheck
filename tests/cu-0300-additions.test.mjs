// 0.30.0 追加项 4/5（用户真机反馈）回归：
// 4. paused 让位后不许退 CU 遮罩——用户回「继续」时模型先跑 run_command/read_file 也不会长时间没遮罩。
// 5. 窗口状态变更（SetWindowPos/ShowWindow/SetForegroundWindow/AppActivate/SwitchToThisWindow/MoveWindow）
//    必须走 computer_*；run_command + 脚本路无条件拒绝（不看 CU 授权），只读诊断放行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as permsMod from '../desktop/src/main/permissions.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cuSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use.mjs'), 'utf8');
const serviceSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-service.mjs'), 'utf8');
const toolsSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-tools.mjs'), 'utf8');

// ---- 追加项 4：paused 保留遮罩 ----

const runActionBody = cuSrc.slice(cuSrc.indexOf('async function runAction'), cuSrc.indexOf('function validateActionArguments'));

test('cu-0300/4: paused 分支只作废截图，不 setCuMode(false)', () => {
  // 真 bug：0.29.3 paused 让位 → 回合收尾 endComputerUseSession 退遮罩 → 回「继续」后长时间无遮罩
  const pausedBranch = runActionBody.slice(runActionBody.indexOf('if (attempted && !recovered)'), runActionBody.indexOf('if (!recovered)'));
  assert.match(pausedBranch, /latestScreenshot = null;/);
  assert.doesNotMatch(pausedBranch, /setCuMode\(false\)/);
  assert.match(pausedBranch, /pauseHold = true;/);
  // 让位文案原样（0.29.3 的 user-active 语义不变）
  assert.match(pausedBranch, /paused: true, deniedBy: 'user-active'/);
});

test('cu-0300/4: 遮罩只在会话真正结束/用户主动中止时退出', () => {
  // 三处真正的退出点：endComputerUseSession（回合收尾 + paused 续期）、revokeApps（撤销授权）、shutdown
  const endBody = cuSrc.slice(cuSrc.indexOf('export function endComputerUseSession'), cuSrc.indexOf('function withDesktopOperation'));
  assert.match(endBody, /if \(pauseHold\) \{ pauseHold = false; return; \}/);
  assert.match(endBody, /setCuMode\(false\)/);
  const revokeBody = cuSrc.slice(cuSrc.indexOf('export function revokeApps'), cuSrc.indexOf('function withPolicy'));
  assert.match(revokeBody, /setCuMode\(false\)/);
  const shutdownBody = cuSrc.slice(cuSrc.indexOf('export function shutdown'));
  assert.match(shutdownBody, /setCuMode\(false\)/);
  // 其余路径不得关遮罩：整文件里 setCuMode(false) 恰好出现在这三处
  const falseCalls = (cuSrc.match(/setCuMode\(false\)/g) || []).length;
  assert.equal(falseCalls, 3, `setCuMode(false) 只能有 3 处（实际 ${falseCalls}）`);
  // 截图失败/授权失败/坐标失败都不许关（capture 失败只是 returning ok:false）
  assert.doesNotMatch(cuSrc.slice(cuSrc.indexOf('export function captureScreen'), cuSrc.indexOf('// 0.29.4')), /setCuMode/);
});

test('cu-0300/4: 显式 resumeCuMode 导出（外部恢复入口）且 setCuMode 清续期标记', () => {
  assert.match(cuSrc, /export function resumeCuMode\(\) \{/);
  const setBody = cuSrc.slice(cuSrc.indexOf('function setCuMode(active)'), cuSrc.indexOf('export function resumeCuMode'));
  assert.match(setBody, /pauseHold = false;/); // 任何显式切换都清续期，防标记泄漏
});

// ---- 追加项 5：窗口状态变更必须走 computer_* ----

const guidance = serviceSrc.slice(
  serviceSrc.indexOf('const AUTOMATION_GUIDANCE = ['),
  serviceSrc.indexOf("].join('\\n');", serviceSrc.indexOf('const AUTOMATION_GUIDANCE = ['))
);

test('cu-0300/5: AUTOMATION_GUIDANCE 有「窗口操作必须 computer_*」硬规则', () => {
  assert.match(guidance, /窗口激活\/置顶\/移动\/查找窗口这类操作\*\*必须用 computer_\* 工具\*\*/);
  assert.match(guidance, /禁止用 run_command \+ PowerShell\/C# 脚本做窗口操作/);
  // 五个 API 名字都要点名（模型照单执行）
  for (const api of ['SetWindowPos', 'ShowWindow', 'SetForegroundWindow', 'AppActivate', 'SwitchToThisWindow', 'AttachThreadInput']) {
    assert.ok(guidance.includes(api), `guidance 必须点名 ${api}`);
  }
  // 只读诊断明确放行
  assert.match(guidance, /GetWindowText\/EnumWindows\/GetWindowRect\/GetWindowLong\/Get-Process\/IsWindowVisible/);
  // 两处引用（audit/dev）仍在
  const references = serviceSrc.split('\n').filter((l) => l.trim() === 'AUTOMATION_GUIDANCE,').length;
  assert.equal(references, 2);
});

permsMod.setMode('full'); // 审批自动放行，让注入检查成为唯一闸门

function makeTools({ granted = [], command } = {}) {
  const calls = [];
  return {
    calls,
    tools: createAgentTools({
      repoRoot,
      permissions: {
        noteTarget() {},
        commandPrefix: (c) => permsMod.commandPrefix(c),
        consumeGrant: permsMod.consumeGrant,
        sessionAllowed: permsMod.sessionAllowed,
        requestApproval: permsMod.requestApproval
      },
      getDesktopToolsAsync: async () => ({
        computerUse: { grantedApps: () => granted, revokeApps: () => [] },
        browserUse: {}
      })
    })
  };
}

test('cu-0300/5: SetWindowPos 脚本无授权 → 拒绝并 redirect 到 computer_*', async () => {
  const { tools } = makeTools({ granted: [] });
  const r = await tools.run_command({
    command: 'powershell -NoProfile -Command "Add-Type ... SetWindowPos(...)"'
  });
  assert.equal(r.deniedBy, 'policy');
  assert.equal(r.redirect, 'computer_focus_or_window_screenshot');
  assert.match(r.error, /必须用 computer_\*|改用 computer_\*/);
  assert.match(r.error, /SetWindowPos/);
});

test('cu-0300/5: 有 CU 授权也必须拒绝窗口状态变更（不给绕过口）', async () => {
  const { tools } = makeTools({ granted: ['weixin'] });
  const r = await tools.run_command({
    command: 'powershell -NoProfile -Command "Add-Type ... ShowWindow(GetForegroundWindow(), 9)"'
  });
  assert.equal(r.deniedBy, 'policy');
  assert.equal(r.redirect, 'computer_focus_or_window_screenshot');
  assert.match(r.error, /有 CU 授权也一样拒绝/);
});

test('cu-0300/5: AppActivate / SwitchToThisWindow / MoveWindow 同样拦（无授权）', async () => {
  for (const api of ['AppActivate', 'SwitchToThisWindow', 'MoveWindow']) {
    const { tools } = makeTools({ granted: [] });
    const r = await tools.run_command({
      command: `powershell -NoProfile -Command "Add-Type ... ${api}(...)"`
    });
    assert.equal(r.deniedBy, 'policy', `${api} 必须被拒`);
    assert.equal(r.redirect, 'computer_focus_or_window_screenshot');
    assert.ok(r.error.includes(api), `拒绝文案必须点名命中的 API（${api}），实际：${r.error}`);
    assert.match(r.error, /computer_\*/);
  }
});

test('cu-0300/5: --File 引用的脚本里带 SetWindowPos → 也拦（真机绕路形态）', async () => {
  // 真实会话：write_file .tmp_*.ps1 → powershell -File → 循环。命令行干净、关键词在文件里。
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-0300-win-'));
  try {
    const cmdPath = dir.replace(/\\/g, '/');
    fs.writeFileSync(path.join(dir, 'move.ps1'),
      'Add-Type -TypeDefinition @"\nusing System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int hh,uint f);}"@\n[W]::SetWindowPos([IntPtr]::Zero,[IntPtr]::Zero,100,100,800,600,0x0040)\n', 'utf8');
    const { tools } = makeTools({ granted: ['weixin'] });
    const r = await tools.run_command({ command: `powershell -NoProfile -File ${cmdPath}/move.ps1` });
    assert.equal(r.deniedBy, 'policy');
    assert.equal(r.redirect, 'computer_focus_or_window_screenshot');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cu-0300/5: 只读诊断命令一律放行（不误伤排查）', async () => {
  // GetWindowText / EnumWindows / GetWindowRect / Get-Process 是查窗口问题的主力，必须能用
  const readOnly = [
    'powershell -NoProfile -Command "Get-Process | Select-Object Id,MainWindowTitle | Format-Table"',
    'powershell -NoProfile -Command "Add-Type ... GetWindowText($h, $sb, 256)"',
    'powershell -NoProfile -Command "Add-Type ... EnumWindows($cb, 0)"',
    'powershell -NoProfile -Command "Add-Type ... GetWindowRect($h, [ref]$r)"'
  ];
  for (const command of readOnly) {
    const { tools } = makeTools({ granted: [] });
    const r = await tools.run_command({ command });
    assert.notEqual(r.deniedBy, 'policy', `只读诊断不得被拦：${command}`);
  }
});

test('cu-0300/5: 窗口状态组判定只发生在编译/执行上下文（纯 grep 不误伤）', async () => {
  const { tools } = makeTools({ granted: [] });
  const r = await tools.run_command({ command: 'grep -rn "SetWindowPos" desktop/src' });
  assert.notEqual(r.deniedBy, 'policy');
});
