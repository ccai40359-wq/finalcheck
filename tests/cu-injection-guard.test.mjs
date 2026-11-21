// 0.29.3 回归：run_command 的键鼠注入命令必须经过 CU 权限——否则一条 PowerShell 就绕过
// computer_* 的三层防线（基准 r5/r6 实测会话自写注入脚本绕空安全层，还把微信搞锁死）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
