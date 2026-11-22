// 0.30.4：CU 工作流定版（阶段化流程：先窗口后全屏）+ 打字可靠性 + 复合动作
// 重要教训（0.30.4 自己的回归）：完整流程**不能**写进常驻系统提示——880 字的指引让
// 3 万 token 窗口的压缩剧本提前撞线（sim-harness compact 场景红）。现在：
//   常驻提示 = 一行摘要；详情 = desktop/skills/computer-use/SKILL.md（按需加载）。
// 这个文件同时钉住两边，防止有人再把长文塞回常驻提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-service.mjs'), 'utf8');
const input = readFileSync(path.join(repoRoot, 'desktop/src/main/desktop-input-win.mjs'), 'utf8');
const skill = readFileSync(path.join(repoRoot, 'desktop/skills/computer-use/SKILL.md'), 'utf8');
const guidance = src.slice(src.indexOf('const AUTOMATION_GUIDANCE'), src.indexOf("].join('\\n');", src.indexOf('const AUTOMATION_GUIDANCE')));

test('常驻提示：只留一行摘要（先窗口不先全屏 + 复用截图 + 复查一张 + 全屏五种用途）', () => {
  assert.match(guidance, /桌面操作顺序：\*\*先拍目标窗口/, '常驻必须有一行顺序摘要');
  assert.match(guidance, /复用同一 screenshot_id/, '摘要要提复用截图');
  assert.match(guidance, /全屏只在不知道是哪个窗口/, '摘要要提全屏的限定用途');
  assert.match(guidance, /细节见 \/computer-use 技能/, '摘要要指向技能文件');
});

test('常驻提示：不得把整段流程塞回系统提示（防压缩预算回归）', () => {
  // 880 字的五阶段全文若回到常驻提示，3 万 token 窗口会提前撞线
  assert.ok(!guidance.includes('**桌面操作标准流程（按阶段走，别跳步）**'),
    '完整五阶段流程不得写进常驻系统提示（会挤爆小窗口模型的压缩预算）');
  // 粗口径：AUTOMATION_GUIDANCE 总长有上限（当前约 4.5k 字符，留 6k 余量）
  assert.ok(guidance.length < 6000, `AUTOMATION_GUIDANCE 不应超过 6000 字符（实际 ${guidance.length}）——长指引放技能文件`);
});

test('技能文件：五阶段齐全 + 全屏五种用途 + region 配额（详情在这里）', () => {
  assert.match(skill, /## 标准循环（0\.30\.4 五阶段/, '技能文件必须有五阶段');
  assert.match(skill, /1\. \*\*解析目标\*\*/);
  assert.match(skill, /2\. \*\*直接拍目标窗口，不要先全屏\*\*/, '核心改进：窗口优先');
  assert.match(skill, /3\. \*\*连续操作复用同一张截图\*\*/);
  assert.match(skill, /4\. \*\*结果性动作后复查「一次」就够\*\*/);
  assert.match(skill, /5\. \*\*region 配额：一次任务最多 2 次\*\*/);
  assert.match(skill, /看一张就下结论/, '防显微镜模式');
  assert.match(skill, /不要拍 130×28 这种只框几个字的最小块/, '点名反例尺寸');
  for (const k of ['不知道是哪个窗口', '需要理解屏幕相对布局', '目标已最小化', '目标是 FC 自己', '怀疑有非应用窗口干扰']) {
    assert.ok(skill.includes(k), `全屏正当用途必须列出「${k}」`);
  }
});

test('技能文件：打字可靠性 + 粘贴降级为兜底 + 微信 IME 已知限制', () => {
  assert.match(skill, /type` 是\*\*模拟真人逐字符输入\*\*/, '必须强调 type 语义');
  assert.match(skill, /不要\*\*因为一次怀疑就改用剪贴板粘贴/, '粘贴降级为兜底');
  assert.match(skill, /仅在 `type` 真的报错时才用/);
  assert.match(skill, /微信（Qt 自绘）在中文输入法活跃时/, '必须写明微信 IME 已知限制（实测「这」→逗号）');
});

test('技能文件：复合动作序列的边界（首错即停 + 不重跑 + 不含 focus）', () => {
  assert.match(skill, /## 复合动作（computer_sequence/, '技能文件要讲 sequence');
  assert.match(skill, /首错即停/);
  assert.match(skill, /不要重跑整个序列/);
  assert.match(skill, /不含 focus\/drag/);
  assert.match(skill, /上限 8 步/);
});

test('代码：TypeText 每字符必须有延时（C# 显式类型）', () => {
  const body = input.slice(input.indexOf('public static void TypeText'), input.indexOf('public static bool GuardedFocus'));
  assert.match(body, /const int charDelayMs = 15;/, '必须有明确类型 + 明确的字符间隔常量');
  assert.match(body, /System\.Threading\.Thread\.Sleep\(charDelayMs\)/, '循环里必须实际 sleep');
  assert.match(body, /if \(\+\+i < text\.Length\)/, '最后一个字符后不必再等');
});

test('代码：窗口截图已返回 hwnd（省掉单独查进程）', () => {
  // 工具层返回体必须带 hwnd 供模型直接用
  const tools = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-tools.mjs'), 'utf8');
  const captureBody = tools.slice(tools.indexOf('const captureComputerScreenshot'), tools.indexOf('tools.computer_screenshot'));
  assert.ok(captureBody.includes('windowRect'), '窗口截图返回体要带 windowRect');
  assert.ok(captureBody.includes('foreground: r.foreground'), '返回体要带 foreground（内含 hwnd）');
});
