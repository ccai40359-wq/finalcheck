// 0.34.5：提示词（先判断问还是做）、运行环境注入、后台命令日志句柄、窗口探测限额范围、重启后不恢复自动续跑
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSystemPromptParts } from '../desktop/src/main/agent-service.mjs';
import { runCommandWithSignal } from '../desktop/src/main/agent-tools.mjs';
import { runsScriptFile, isProbeCommand } from '../desktop/src/main/cu-workflow-budget.mjs';
import { runtimeEnvNote } from '../desktop/src/main/ipc/ipc-agent.mjs';

const src = (p) => readFileSync(new URL(`../desktop/src/${p}`, import.meta.url), 'utf8');

test('dev 提示词：先判断问还是做、回答长短、重活先问、卡住止损', async () => {
  const dev = (await getSystemPromptParts('dev')).base;
  assert.match(dev, /先判断这条消息要的是什么/);
  assert.match(dev, /做计划就给步骤清单/);
  assert.match(dev, /本会话后面一直有效/);
  assert.match(dev, /回答的长短跟着问题走/);
  assert.match(dev, /重活先打招呼/);
  assert.match(dev, /卡住要止损/);
  assert.match(dev, /浏览别人的网站/);
  assert.ok(!dev.includes('发现必须带证据说话'), '纯知识问答不再强制「证据」小节');
  // 意图判断排在「直接动手做」类规则前面
  assert.ok(dev.indexOf('先判断这条消息要的是什么') < dev.indexOf('单命令短路'));
});

test('运行环境：只到天、带星期和 shell', () => {
  const note = runtimeEnvNote(new Date(2026, 10, 27, 23, 59), 'win32');
  assert.match(note, /2026-11-27（星期五/);
  assert.match(note, /Git Bash/);
  assert.equal(note, runtimeEnvNote(new Date(2026, 10, 27, 0, 1), 'win32'), '同一天文本不变（前缀缓存）');
  assert.match(runtimeEnvNote(new Date(2026, 10, 29), 'linux'), /星期日.*Linux/);
  assert.match(src('main/ipc/ipc-agent.mjs'), /content: runtimeEnvNote\(new Date\(\), process\.platform, gpu\)/); // 0.34.7 带显卡
});

test('后台命令：bash 能写进日志文件（以前 append 句柄让 echo 退出码 1、ls 退出码 2、没有输出）', { skip: process.platform !== 'win32' }, async () => {
  let out = '';
  const exited = new Promise((resolve) => {
    void runCommandWithSignal('echo hi-bg; ls -d .', {
      background: true,
      onDetach: () => ({ taskId: 't', note: '', onData: (s) => { out += s; }, onExit: resolve })
    });
  });
  const code = await exited;
  assert.equal(code, 0);
  assert.match(out, /hi-bg/);
});

test('窗口探测限额：只在本回合做过桌面截图时生效；跑脚本文件不算探测', () => {
  const s = src('main/agent-tools.mjs');
  assert.match(s, /cuWorkflowUsed\.cuActive && isProbeCommand\(cmd\) && !runsScriptFile\(cmd\)/);
  assert.match(s, /cuWorkflowUsed\.cuActive = true;/);
  assert.equal(runsScriptFile('cd /d/x && PYTHONUTF8=1 /d/ComfyUI/python_embeded/python.exe wx_ocr_export.py --hwnd 1'), true);
  assert.equal(runsScriptFile('python -u tools/x.py'), true);
  assert.equal(runsScriptFile('node scripts/a.mjs'), true);
  assert.equal(runsScriptFile('powershell -File probe.ps1'), true);
  assert.equal(runsScriptFile("python - <<'PY'\nimport ctypes"), false);
  assert.equal(runsScriptFile('python -c "import ctypes"'), false);
  assert.equal(runsScriptFile('node -e "x.py"'), false);
  assert.equal(runsScriptFile('Get-Process msedge'), false);
  assert.equal(isProbeCommand('Get-Process msedge'), true);
});

test('重启后恢复排队消息时，丢掉「后台任务已结束」自动续跑', () => {
  assert.match(src('renderer/App.jsx'), /filter\(\(it\) => !it\?\.bgAuto\)/);
});
