// computer_screenshot region 支持（0.29.4 WF1）：两段式「全屏导航 → region 拍原生小块读字」。
// 目标：CU 全屏缩到 1560px 后中文 14px→9px 不可读，region 走原生分辨率零重采样裁剪（1:1 坐标）。
// P0 红线：shot.bounds 必须保持全屏物理 bounds（desktop-input-win.mjs 的
// captureBounds.Matches(PrimaryBounds()) 原生断言依赖它），region 只能存独立字段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  actionPoints, mapScreenshotPoint, matchesImageGeometry, normalizeRegion
} from '../desktop/src/main/computer-use-geometry.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const geoSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use-geometry.mjs'), 'utf8');
const cuSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use.mjs'), 'utf8');
const inputSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/desktop-input-win.mjs'), 'utf8');
const serviceSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-service.mjs'), 'utf8');

// ---- 几何直测 ----

const displayBounds = { x: -2560, y: -144, width: 2560, height: 1440 };
const region = { x: 100, y: 200, width: 400, height: 300 };
const regionShot = { width: 400, height: 300, bounds: displayBounds, region };

test('region: 图像坐标 1:1 映射回屏幕，带显示器原点与 region 偏移', () => {
  assert.deepEqual(mapScreenshotPoint(regionShot, 0, 0), { x: -2460, y: 56 });
  assert.deepEqual(mapScreenshotPoint(regionShot, 399, 299), { x: -2061, y: 355 });
  assert.deepEqual(mapScreenshotPoint(regionShot, 200, 150), { x: -2260, y: 206 });
  // 拖拽两端点同样按 region 偏移映射
  assert.deepEqual(
    actionPoints('drag', { x: 0, y: 0, x2: 399, y2: 299 }, regionShot),
    [{ x: -2460, y: 56 }, { x: -2061, y: 355 }]
  );
});

test('region: 越界坐标仍然拒绝（RangeError），不因 1:1 放宽', () => {
  for (const [x, y] of [[-1, 10], [10, -1], [400, 10], [10, 300], [Infinity, 5], [2, NaN]]) {
    assert.throws(() => mapScreenshotPoint(regionShot, x, y), RangeError);
  }
});

test('region: matchesImageGeometry 改为「图像尺寸 == region 尺寸」，不再套整屏比例', () => {
  assert.equal(matchesImageGeometry({ width: 400, height: 300 }, displayBounds, region), true);
  assert.equal(matchesImageGeometry({ width: 401, height: 300 }, displayBounds, region), false);
  assert.equal(matchesImageGeometry({ width: 399, height: 299 }, displayBounds, region), false);
  // 不传 region 时旧行为逐字段不变（整屏比例校验）
  assert.equal(matchesImageGeometry({ width: 1560, height: 877 }, displayBounds, null), true);
  assert.equal(matchesImageGeometry({ width: 1560, height: 1000 }, displayBounds), false);
});

test('region: 合法参数原样通过（含整屏大小的 region）', () => {
  assert.deepEqual(normalizeRegion({ x: 0, y: 0, width: 2560, height: 1440 }, displayBounds),
    { region: { x: 0, y: 0, width: 2560, height: 1440 } });
  assert.deepEqual(normalizeRegion({ x: 2558, y: 1200, width: 2, height: 240 }, displayBounds),
    { region: { x: 2558, y: 1200, width: 2, height: 240 } });
});

test('region: 非整数 / 负数 / <2 / 超出显示器范围一律报错，不 clamp', () => {
  const rejects = [
    null, 42, 'region', [1, 2, 3, 4],
    { x: 0.5, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 10.5, height: 10 },
    { x: 0, y: 0, width: 10, height: Number.NaN },
    { x: '0', y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 10 }, // 缺 height
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: -2, width: 10, height: 10 },
    { x: 0, y: 0, width: 1, height: 100 },
    { x: 0, y: 0, width: 100, height: 1 },
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 2500, y: 0, width: 61, height: 10 }, // x+width 超右边界
    { x: 0, y: 1400, width: 10, height: 41 }, // y+height 超下边界
    { x: 0, y: 0, width: 2561, height: 10 }
  ];
  for (const bad of rejects) {
    const r = normalizeRegion(bad, displayBounds);
    assert.ok(r.error, `应拒绝 ${JSON.stringify(bad)}`);
    assert.equal(typeof r.error, 'string');
    assert.equal(r.region, undefined, '报错时不得回传 region');
  }
  // 越界报错要给出显示器范围，方便 agent 自纠
  assert.match(normalizeRegion({ x: 0, y: 0, width: 9999, height: 10 }, displayBounds).error, /2560x1440/);
});

// ---- 源码钉（防 P0 陷阱回归）----

test('region: 原生层 captureBounds 断言未被触碰（shot.bounds 仍是全屏物理 bounds）', () => {
  // P0 陷阱：desktop-input-win.mjs 的断言一旦改动，所有动作都会报 screenshot-required
  assert.match(inputSrc, /!guard\.captureBounds\.Matches\(PrimaryBounds\(\)\)/);
  // JS 层 guard 的 captureBounds 仍来自 shot.bounds，而不是 shot.region
  assert.match(cuSrc, /captureBounds: shot\.bounds, virtualScreen: shot\.virtualScreen/);
  // latestScreenshot 里 bounds 仍是全屏 display.bounds，region 是独立字段
  assert.match(cuSrc, /bounds: display\.bounds, foreground, virtualScreen: after\.virtualScreen,/);
  assert.match(cuSrc, /: null,\s*\r?\n\s*region: region \?\? null\s*\r?\n\s*\};/);
});

test('region: 捕获路径按原生分辨率取帧并零重采样裁剪', () => {
  assert.match(cuSrc, /normalizeRegion\(region, display\.bounds\)/);
  assert.match(cuSrc, /const requestedSize = region\s*\r?\n\s*\? \{ width: display\.bounds\.width, height: display\.bounds\.height \}/);
  assert.match(cuSrc, /image\.crop\(\{ x: region\.x, y: region\.y, width: region\.width, height: region\.height \}\)/);
  // 取不到原生帧必须报错而不是静默缩放（重采样会破坏 1:1 映射）
  assert.match(cuSrc, /无法按原生分辨率取帧/);
  // region 只支持全屏：window 目标 + region 直接拒绝
  assert.match(cuSrc, /region 只支持全屏截图/);
  // region 校验失败不 clamp：错误原样返回
  assert.match(geoSrc, /只校验不 clamp|绝不悄悄改参数|不能为负数/);
});

test('region: AUTOMATION_GUIDANCE 含三条新教条关键词（audit 与 dev 共用同一 const）', () => {
  const guidance = serviceSrc.slice(
    serviceSrc.indexOf('const AUTOMATION_GUIDANCE = ['),
    serviceSrc.indexOf("].join('\\n');", serviceSrc.indexOf('const AUTOMATION_GUIDANCE = ['))
  );
  assert.ok(guidance.length > 0, 'AUTOMATION_GUIDANCE 常量必须存在');
  // 教条 1：提交/发送/保存优先点大按钮，Enter/快捷键只是兜底
  assert.match(guidance, /Enter\/Ctrl\+Enter/);
  assert.match(guidance, /快捷键只是兜底/);
  // 教条 2：键盘动作前确认焦点在目标控件
  assert.match(guidance, /焦点在目标控件/);
  assert.match(guidance, /按错.*不报错|按错了也不报错/);
  // 教条 3：region 两段式用法
  assert.match(guidance, /先全屏定位大概位置/);
  assert.match(guidance, /region 拍/);
  // 两处引用（audit/dev 的 SYSTEM_BASE 与 SYSTEM_DEV_BASE）仍指向同一 const
  const references = serviceSrc.split('\n').filter((l) => l.trim() === 'AUTOMATION_GUIDANCE,').length;
  assert.equal(references, 2, 'AUTOMATION_GUIDANCE 必须仍被 audit/dev 两处引用');
});

test('region: computer_screenshot schema 暴露 region 参数', () => {
  assert.match(serviceSrc, /name: 'computer_screenshot'/);
  const schemaLine = serviceSrc.split('\n').find((l) => l.includes("name: 'computer_screenshot'"));
  assert.match(schemaLine, /region: \{ type: 'object'/);
  assert.match(schemaLine, /物理像素整数/);
  assert.match(schemaLine, /required: \['x', 'y', 'width', 'height'\]/);
});

// ---- 契约：region 转发（仿 automation-tools-contract 的 mock 引擎）----

const foreground = { process: 'NOTEPAD', title: 'Scratch', tier: 'full', tierLabel: '可操作', granted: true };
const image = Buffer.from('fake image bytes');

function toolsFor(engines) {
  return createAgentTools({ repoRoot, getDesktopToolsAsync: async () => engines });
}

test('contract: computer_screenshot 传 region 时转发给 captureScreen，并透传区域元数据', async () => {
  const calls = [];
  const regionShot = {
    ok: true, width: 400, height: 300, buf: image, mime: 'image/png', foreground,
    screenshotId: 'shot-region', canAct: true, scale: 1,
    region: { x: 100, y: 200, width: 400, height: 300 }
  };
  const tools = toolsFor({ computerUse: {
    async captureScreen(options) { calls.push(options); return regionShot; }
  } });

  const r = await tools.computer_screenshot({ region: { x: 100, y: 200, width: 400, height: 300 } });
  assert.deepEqual(calls[0], { target: 'screen', windowTitle: '', region: { x: 100, y: 200, width: 400, height: 300 } });
  assert.equal(r.ok, true);
  assert.equal(r.screenshot_id, 'shot-region');
  assert.equal(r.canAct, true);
  assert.deepEqual(r.region, { x: 100, y: 200, width: 400, height: 300 });
  assert.match(r.note, /原生分辨率/);
  assert.match(r.note, /1:1/);
  assert.equal(r.__images[0].base64, image.toString('base64'));
});

test('contract: 不带 region 的调用保持 0.29.3 转发形状（options 无 region 键）', async () => {
  const calls = [];
  const tools = toolsFor({ computerUse: {
    async captureScreen(options) {
      calls.push(options);
      return { ok: true, width: 1560, height: 877, buf: image, mime: 'image/jpeg', foreground, screenshotId: 'shot-full', canAct: true };
    }
  } });

  const r = await tools.computer_screenshot({});
  assert.deepEqual(calls[0], { target: 'screen', windowTitle: '' });
  assert.equal(r.region, null);
  assert.equal(r.screenshot_id, 'shot-full');
  assert.match(r.note, /全屏图的 screenshot_id/);

  await tools.computer_screenshot({ target: 'window', window_title: 'Scratch' });
  assert.deepEqual(calls[1], { target: 'window', windowTitle: 'Scratch' });
});

test('contract: region 校验错误原样透传给模型（不 clamp 不吞错）', async () => {
  const calls = [];
  const tools = toolsFor({ computerUse: {
    async captureScreen(options) { calls.push(options); return { ok: false, error: 'region.x 必须是整数（物理像素），收到 0.5。' }; }
  } });

  const r = await tools.computer_screenshot({ region: { x: 0.5, y: 0, width: 10, height: 10 } });
  assert.deepEqual(calls[0], { target: 'screen', windowTitle: '', region: { x: 0.5, y: 0, width: 10, height: 10 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /必须是整数/);
});
