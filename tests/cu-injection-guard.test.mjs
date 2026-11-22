// 0.29.3 回归：run_command 的键鼠注入命令必须经过 CU 权限——否则一条 PowerShell 就绕过
// computer_* 的三层防线（基准 r5/r6 实测会话自写注入脚本绕空安全层，还把微信搞锁死）。
// 0.29.7 补：关键词可能不在命令行而在被引用的脚本文件里（真机实证 powershell -File final_send.ps1，
// 命令行干净、文件里全是 SendInput）——注入闸必须读被引用文件与内联 heredoc 正文再判。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import * as permsMod from '../desktop/src/main/permissions.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
permsMod.setMode('full'); // 审批自动放行，让注入检查成为唯一闸门

function makeTools({ granted = [] } = {}) {
  return createAgentTools({
    repoRoot: ROOT,
    permissions: {
      noteTarget() {},
      commandPrefix: (c) => permsMod.commandPrefix(c),
      consumeGrant: permsMod.consumeGrant,
      sessionAllowed: permsMod.sessionAllowed,
      requestApproval: permsMod.requestApproval,
    },
    getDesktopToolsAsync: async () => ({
      computerUse: { grantedApps: () => granted, revokeApps: () => [] },
      browserUse: {}
    }),
  });
}

test('injection guard: keybd_event/SendInput 命令无 CU 授权时被拒', async () => {
  const tools = makeTools({ granted: [] });
  const r = await tools.run_command({
    command: 'powershell -NoProfile -Command "Add-Type ... SendInput(...)"',
  });
  assert.equal(r.deniedBy, 'policy');
  assert.match(r.error, /三层安全防线|computer_request_access/);
});

test('injection guard: AttachThreadInput 无条件拒绝（有授权也拒）', async () => {
  const tools = makeTools({ granted: ['weixin'] });
  const r = await tools.run_command({
    command: 'powershell -NoProfile -Command "AttachThreadInput(1,2)"',
  });
  assert.equal(r.deniedBy, 'policy');
  assert.match(r.error, /AttachThreadInput/);
});

test('injection guard: 有 CU 授权时放行（命令真实执行）', async () => {
  const tools = makeTools({ granted: ['weixin'] });
  const r = await tools.run_command({
    command: 'powershell -NoProfile -Command "Write-Output SendInput-ok"',
  });
  assert.equal(r.deniedBy, undefined);
  assert.match(String(r.stdout), /SendInput-ok/);
});

test('injection guard: 纯检索关键词不误伤（node -e 无编译上下文）', async () => {
  const tools = makeTools({ granted: [] });
  const r = await tools.run_command({
    command: 'node -e "console.log(\'SendInput check\')"',
  });
  assert.notEqual(r.deniedBy, 'policy');
});

// ---- 0.29.7：脚本文件扫描（真机绕过样例：命令行干净、关键词在文件里）----

function makeScriptDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-inject-'));
  // run_command 走 Git Bash：命令串里的反斜杠路径会被当转义符吃掉，测试统一用正斜杠
  return { dir, cmdPath: dir.replace(/\\/g, '/') };
}

test('injection guard: 命令行干净 + -File 脚本含 SendInput → 无授权拒（真机绕过样例）', async () => {
  const { dir, cmdPath } = makeScriptDir();
  try {
    // ⚠️ 命令串里的路径用字符串拼接保持正斜杠：path.join 会在 win32 混入反斜杠，被 Git Bash 当转义符吃掉
    const script = `${cmdPath}/final_send.ps1`;
    writeFileSync(path.join(dir, 'final_send.ps1'), 'param([string]$t)\n$signature = @"\nusing System;using System.Runtime.InteropServices;\npublic class Win { [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int s); }\n"@\nAdd-Type -TypeDefinition $signature\n[Win]::SendInput(1, $null, 0)\n', 'utf8');
    const tools = makeTools({ granted: [] });
    const r = await tools.run_command({
      command: `powershell -NoProfile -File ${script}`,
    });
    // 命令行里一个注入关键词都没有，闸必须靠读文件内容拦下来
    assert.equal(r.deniedBy, 'policy');
    assert.match(r.error, /三层安全防线|computer_request_access/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injection guard: 脚本文件干净 → 放行（真实执行）', async () => {
  const { dir, cmdPath } = makeScriptDir();
  try {
    const script = `${cmdPath}/clean.ps1`;
    writeFileSync(path.join(dir, 'clean.ps1'), 'Write-Output clean-script-ok\n', 'utf8');
    const tools = makeTools({ granted: [] });
    const r = await tools.run_command({
      command: `powershell -NoProfile -File ${script}`,
    });
    assert.equal(r.deniedBy, undefined);
    assert.match(String(r.stdout), /clean-script-ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injection guard: -File 脚本含 AttachThreadInput → 有 CU 授权也恒拒', async () => {
  const { dir, cmdPath } = makeScriptDir();
  try {
    const script = `${cmdPath}/attach.ps1`;
    writeFileSync(path.join(dir, 'attach.ps1'), '[AttachThreadInput]::Attach(1, 2, $true)\n', 'utf8');
    const tools = makeTools({ granted: ['weixin'] });
    const r = await tools.run_command({
      command: `powershell -NoProfile -File ${script}`,
    });
    assert.equal(r.deniedBy, 'policy');
    assert.match(r.error, /AttachThreadInput/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injection guard: heredoc 内联脚本含注入 → 无授权拒', async () => {
  const tools = makeTools({ granted: [] });
  const r = await tools.run_command({
    command: [
      'python - <<\'PY\'',
      'import ctypes',
      'ctypes.windll.user32.SetCursorPos(10, 10)',
      'PY',
    ].join('\n'),
  });
  assert.equal(r.deniedBy, 'policy');
  assert.match(r.error, /三层安全防线|computer_request_access/);
});

test('injection guard: 引用的脚本不存在 → 放行（不新增失败模式，执行层自然报错）', async () => {
  const tools = makeTools({ granted: [] });
  const missing = path.join(os.tmpdir(), `fc-inject-no-such-${process.pid}-7f3a.ps1`).replace(/\\/g, '/');
  const r = await tools.run_command({
    command: `powershell -NoProfile -File ${missing} Write-Output hi`,
  });
  assert.notEqual(r.deniedBy, 'policy');
});
