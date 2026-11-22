// 0.30.4 CU 工作流硬配额（引擎侧约束，不靠提示词）
// 真机实证：换用 flash 类模型后，长上下文里的软提示被稀释——一轮任务拍 33 张图
// （含 6 次全屏、22 次 130×28 极小块 region）、跑 21 次 run_command 查窗口。
// 按用户原则「效率优先、token 不是约束」把纪律挪进工具层：超配额直接拒绝并给替代动作。
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../desktop/src/main/cu-workflow-budget.mjs');

test('默认配额：2 次全屏 / 2 次 region / 1 次窗口探测（可用 env 覆盖）', () => {
  assert.deepEqual(mod.workflowBudgetFromEnv({}), { screenShots: 2, regions: 2, probes: 1 });
  assert.deepEqual(mod.workflowBudgetFromEnv({ FC_CU_SCREEN_SHOTS: '0', FC_CU_REGIONS: '5', FC_CU_PROBES: '3' }),
    { screenShots: 0, regions: 5, probes: 3 });
  // 非法值回落到默认
  assert.equal(mod.workflowBudgetFromEnv({ FC_CU_REGIONS: 'abc' }).regions, 2);
  assert.equal(mod.workflowBudgetFromEnv({ FC_CU_REGIONS: '-1' }).regions, 2);
});

test('region 配额：用完即拒，错误信息要求改用整窗截图看整行', () => {
  const budget = { screenShots: 2, regions: 2, probes: 1 };
  assert.equal(mod.checkScreenshotBudget({ kind: 'region', used: { regions: 0 }, budget }).allowed, true);
  assert.equal(mod.checkScreenshotBudget({ kind: 'region', used: { regions: 1 }, budget }).allowed, true);
  const denied = mod.checkScreenshotBudget({ kind: 'region', used: { regions: 2 }, budget });
  assert.equal(denied.allowed, false);
  assert.equal(denied.deniedBy, 'workflow-budget');
  assert.match(denied.error, /2\/2/);
  assert.match(denied.error, /整窗截图看整段内容/, '必须给替代动作');
  assert.match(denied.error, /不要拆成多个小块逐字核对/, '必须点名禁止 microscopic 行为');
});

test('全屏配额：用完即拒，错误信息指向 target:"window" 并列出全屏五种正当用途', () => {
  const budget = { screenShots: 2, regions: 2, probes: 1 };
  assert.equal(mod.checkScreenshotBudget({ kind: 'screen', used: { screenShots: 1 }, budget }).allowed, true);
  const denied = mod.checkScreenshotBudget({ kind: 'screen', used: { screenShots: 2 }, budget });
  assert.equal(denied.allowed, false);
  assert.equal(denied.deniedBy, 'workflow-budget');
  assert.match(denied.error, /target:"window"/, '必须指向推荐路径');
  assert.match(denied.error, /不知道是哪个窗口/, '必须提示全屏的正当用途');
});

test('窗口截图不设上限（推荐路径永远放行）', () => {
  const budget = { screenShots: 0, regions: 0, probes: 0 }; // 极端：全屏/region 配额都是 0
  const r = mod.checkScreenshotBudget({ kind: 'window', used: { screenShots: 99, regions: 99 }, budget });
  assert.equal(r.allowed, true, '窗口截图是推荐路径，不受配额限制');
});

test('窗口探测配额：用完即拒，提示用截图返回的 hwnd', () => {
  const budget = { screenShots: 2, regions: 2, probes: 1 };
  assert.equal(mod.checkProbeBudget({ used: { probes: 0 }, budget }).allowed, true);
  const denied = mod.checkProbeBudget({ used: { probes: 1 }, budget });
  assert.equal(denied.allowed, false);
  assert.equal(denied.deniedBy, 'workflow-budget');
  assert.match(denied.error, /已经包含 hwnd/, '必须说明截图已返回 hwnd');
  assert.match(denied.error, /不要再单独查进程/);
});

test('探测命令识别：只认查窗口的只读诊断，不误伤正常 run_command', () => {
  assert.equal(mod.isProbeCommand('Get-Process Weixin | Select Id,MainWindowHandle'), true);
  assert.equal(mod.isProbeCommand('tasklist /FI "IMAGENAME eq Weixin.exe"'), true);
  assert.equal(mod.isProbeCommand('Add-Type -Namespace W -Name U -MemberDefinition "[DllImport]..."'), true);
  assert.equal(mod.isProbeCommand('npm test'), false, '普通命令不算探测');
  assert.equal(mod.isProbeCommand('ls -la'), false);
  assert.equal(mod.isProbeCommand('curl http://127.0.0.1:8199/'), false);
});
