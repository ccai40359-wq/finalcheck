// computer_screenshot target:'window' 主路径切「窗口自身捕获」（0.29.7-beta WF）：
// ① desktopCapturer 窗口 thumbnail（WGC，按 hwnd 匹配源，thumbnailSize=窗口原生物理尺寸）
// → ② winapp ui screenshot -w <hwnd> -o <file> --json（可选增强，运行时探测，缺失即跳过）
// → ③ 现行 screen 捕获（永远兜底；最小化直接走 ③ 并注明）。
// P0 红线：shot.bounds 语义不得改（0.29.4 同款钉）；windowRect 只存独立字段；
// B（遮挡拒绝）行为不得放松——窗口捕获解决「看」，点击遮挡区域仍被拒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  actionPoints, mapWindowPoint, WINDOW_FRAME_OFFSET, WINDOW_NATIVE_TOLERANCE_PX
} from '../desktop/src/main/computer-use-geometry.mjs';
import {
  createWindowCapture, isNativeWindowSize, pickWindowSource, windowSourceId
} from '../desktop/src/main/computer-window-capture.mjs';
import { winappScreenshotCommand, winappCandidatePaths } from '../desktop/src/main/winapp-cli.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const geoSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use-geometry.mjs'), 'utf8');
const cuSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use.mjs'), 'utf8');
const winSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/desktop-input-win.mjs'), 'utf8');
const wcSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-window-capture.mjs'), 'utf8');
const serviceSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-service.mjs'), 'utf8');

// ---- mapWindowPoint 直测（纯函数） ----

// 原生窗口截图：windowRect 在主屏 (100,100) 1200x800，图像 1199x800（certainty B 实测的 1px 舍入）。
const nativeRect = { x: 100, y: 100, width: 1200, height: 800, imageWidth: 1199, imageHeight: 800 };

test('mapWindowPoint: 图内像素按窗口原点映射回屏幕物理坐标（1px 舍入差在 scale 内消化）', () => {
  // 标定常数：图像原点 == GetWindowRect 原点（WGC 帧含 DWM 不可见边框，证据 cert-log.json）
  assert.deepEqual(WINDOW_FRAME_OFFSET, { x: 0, y: 0 });
  assert.equal(WINDOW_NATIVE_TOLERANCE_PX, 2);
  assert.deepEqual(mapWindowPoint(nativeRect, 0, 0), { x: 100, y: 100 });
  // 右下角：图 1199 宽 → 物理 1200 宽，末像素映射到窗口 rect 内最后一位
  assert.deepEqual(mapWindowPoint(nativeRect, 1198, 799), { x: 1299, y: 899 });
  // 中间点近似 1:1（端点对齐公式下 1px 舍入差的漂移 ≤1px，点击无感）
  const mid = mapWindowPoint(nativeRect, 600, 400);
  assert.ok(Math.abs(mid.x - 700) <= 1, `mid.x=${mid.x}`);
  assert.ok(Math.abs(mid.y - 500) <= 1, `mid.y=${mid.y}`);
});

test('mapWindowPoint: 原点偏移与负坐标窗口（窗口在屏幕左侧/顶部之外）', () => {
  const negative = { x: -80, y: -12, width: 960, height: 640, imageWidth: 960, imageHeight: 640 };
  assert.deepEqual(mapWindowPoint(negative, 0, 0), { x: -80, y: -12 });
  assert.deepEqual(mapWindowPoint(negative, 959, 639), { x: 879, y: 627 });
  // 完全 1:1 时中点无漂移
  assert.deepEqual(mapWindowPoint(negative, 480, 320), { x: 400, y: 308 });
});

test('mapWindowPoint: 缺 imageWidth/imageHeight 直接拒绝（不猜映射）', () => {
  for (const bad of [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 100, height: 100, imageWidth: 100 },
    { x: 0, y: 0, width: 100, height: 100, imageHeight: 100 },
    { x: 0, y: 0, width: 100, height: 100, imageWidth: 0, imageHeight: 100 },
    null
  ]) {
    assert.throws(() => mapWindowPoint(bad, 10, 10), TypeError);
  }
});

test('mapWindowPoint: 越界图内坐标仍然拒绝（与 mapScreenshotPoint 同一纪律）', () => {
  for (const [x, y] of [[-1, 10], [10, -1], [1199, 10], [10, 800], [Infinity, 5], [5, NaN]]) {
    assert.throws(() => mapWindowPoint(nativeRect, x, y), RangeError);
  }
});

test('actionPoints: 带 windowRect 的快照走窗口映射，不带的原样走旧映射', () => {
  const windowShot = {
    width: 1199, height: 800, bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    windowRect: nativeRect
  };
  assert.deepEqual(actionPoints('left_click', { x: 0, y: 0 }, windowShot), [{ x: 100, y: 100 }]);
  assert.deepEqual(
    actionPoints('drag', { x: 0, y: 0, x2: 1198, y2: 799 }, windowShot),
    [{ x: 100, y: 100 }, { x: 1299, y: 899 }]
  );
  const screenShot = { width: 1560, height: 877, bounds: { x: 0, y: 0, width: 2560, height: 1440 } };
  assert.deepEqual(actionPoints('left_click', { x: 0, y: 0 }, screenShot), [{ x: 0, y: 0 }]);
});

// ---- 捕获链编排层直测（①→②→③ 决策矩阵，依赖注入） ----

function fakeThumbnail(width, height, { empty = false } = {}) {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width, height })
  };
}

function ioFor({ sources, winapp, winappResult, images } = {}) {
  const calls = { getSources: [], winappDetect: 0, winappScreenshot: [] };
  return {
    calls,
    capture: createWindowCapture({
      getSources: async (options) => {
        calls.getSources.push(options);
        return typeof sources === 'function' ? sources(options) : (sources ?? []);
      },
      winappDetect: async () => {
        calls.winappDetect += 1;
        return winapp;
      },
      winappScreenshot: async (exe, hwnd) => {
        calls.winappScreenshot.push({ exe, hwnd });
        return typeof winappResult === 'function' ? winappResult(exe, hwnd) : (winappResult ?? null);
      },
      createImage: (png) => {
        if (!images) return fakeThumbnail(png.length, png.length / 2);
        return images;
      }
    })
  };
}

const rect = { x: 0, y: 0, width: 1200, height: 800 };

test('捕获链 ①：hwnd 命中源且返回原生尺寸 → window-thumbnail（thumbnailSize=窗口原生物理尺寸）', async () => {
  const { capture, calls } = ioFor({
    sources: [{ id: 'window:4321:0', name: 'Notepad', thumbnail: fakeThumbnail(1199, 800) }]
  });
  const r = await capture({ hwnd: 4321, rect });
  assert.equal(r.level, 'window-thumbnail');
  assert.deepEqual(calls.getSources[0].thumbnailSize, { width: 1200, height: 800 });
  assert.deepEqual(calls.getSources[0].types, ['window']);
  assert.equal(calls.winappDetect, 0, '① 命中就不探测 winapp');
  assert.equal(pickWindowSource([{ id: 'window:4321:0' }], 4321).id, 'window:4321:0');
  assert.equal(windowSourceId(4321), 'window:4321:0');
});

test('捕获链回退：① 源缺失/空/被重采样 → ② winapp；winapp 输出合法 → winapp', async () => {
  for (const sources of [
    [], // 源缺失（最小化消失 / not capturable / 自进程窗口被排除）
    [{ id: 'window:4321:0', name: 'Notepad', thumbnail: fakeThumbnail(0, 0, { empty: true }) }],
    [{ id: 'window:4321:0', name: 'Notepad', thumbnail: fakeThumbnail(600, 400) }] // 被重采样 → 拒收
  ]) {
    const { capture, calls } = ioFor({
      sources,
      winapp: { exe: 'C:\\winapp\\winapp.exe' },
      winappResult: () => ({ ok: true, png: Buffer.alloc(1199 * 2) }),
      images: fakeThumbnail(1199, 800)
    });
    const r = await capture({ hwnd: 4321, rect });
    assert.equal(r.level, 'winapp', `sources=${JSON.stringify(sources)}`);
    assert.equal(calls.winappDetect, 1);
    assert.deepEqual(calls.winappScreenshot[0], { exe: 'C:\\winapp\\winapp.exe', hwnd: 4321 });
  }
});

test('捕获链回退：② 也不可用（winapp 缺失 / 调用失败 / 输出空或尺寸不符）→ null（调用方走 ③ screen）', async () => {
  const cases = [
    { winapp: null, winappResult: null }, // 缺失（本机实测：winget/npm 都没装）
    { winapp: { exe: 'C:\\w\\winapp.exe' }, winappResult: () => ({ ok: false }) },
    { winapp: { exe: 'C:\\w\\winapp.exe' }, winappResult: () => { throw new Error('boom'); } },
    { winapp: { exe: 'C:\\w\\winapp.exe' }, winappResult: () => ({ ok: true, png: Buffer.alloc(0) }) },
    { winapp: { exe: 'C:\\w\\winapp.exe' }, winappResult: () => ({ ok: true, png: Buffer.alloc(64) }), images: fakeThumbnail(600, 400) }
  ];
  for (const c of cases) {
    const { capture, calls } = ioFor({ sources: [], ...c });
    const r = await capture({ hwnd: 4321, rect });
    assert.equal(r, null, `winapp=${JSON.stringify(c.winapp)}`);
    assert.equal(calls.winappDetect, 1, '① 失败必须探测 ②');
  }
});

test('捕获链：getSources 抛错不致命，落 ②→③（screen 永远兜底，绝不抛错）', async () => {
  const { capture, calls } = ioFor({
    sources: () => { throw new Error('desktopCapturer gone'); },
    winapp: { exe: 'C:\\winapp\\winapp.exe' },
    winappResult: () => ({ ok: true, png: Buffer.alloc(8) }),
    images: fakeThumbnail(1199, 800)
  });
  const r = await capture({ hwnd: 4321, rect });
  assert.equal(r.level, 'winapp');
  assert.equal(calls.getSources.length, 1);
});

test('isNativeWindowSize: ±1px 容差内算原生（certainty B 实测），超出容差拒收', () => {
  assert.equal(isNativeWindowSize({ width: 1199, height: 800 }, rect), true);
  assert.equal(isNativeWindowSize({ width: 1202, height: 802 }, rect), true); // 容差边界（±2px）
  assert.equal(isNativeWindowSize({ width: 1203, height: 800 }, rect), false);
  assert.equal(isNativeWindowSize({ width: 1197, height: 800 }, rect), false);
  assert.equal(isNativeWindowSize(null, rect), false);
  assert.equal(isNativeWindowSize({ width: NaN, height: 800 }, rect), false);
});

test('winapp 命令组装与候选路径（可选增强，绝不硬依赖）', () => {
  assert.deepEqual(
    winappScreenshotCommand('C:\\winapp\\winapp.exe', 12345, 'D:\\tmp\\out.png'),
    { file: 'C:\\winapp\\winapp.exe', args: ['ui', 'screenshot', '-w', '12345', '-o', 'D:\\tmp\\out.png', '--json'] }
  );
  assert.ok(winappCandidatePaths().every((p) => p.toLowerCase().includes('winapp')));
});

// ---- 源码钉 ----

test('钉：shot.bounds 语义未改（全屏物理 bounds），windowRect 是独立字段', () => {
  // 0.29.4 P0 钉继续成立
  assert.match(cuSrc, /captureBounds: shot\.bounds, virtualScreen: shot\.virtualScreen/);
  assert.match(cuSrc, /bounds: display\.bounds, foreground, virtualScreen: after\.virtualScreen,/);
  // 窗口 rect 只进独立字段（带 imageWidth/imageHeight 供 mapWindowPoint），绝不进 bounds
  assert.match(cuSrc, /windowRect: \{ x: rect\.x, y: rect\.y, width: rect\.width, height: rect\.height, imageWidth: width, imageHeight: height \}/);
  assert.match(cuSrc, /windowRect: null,/);
  // 窗口坐标映射走 mapWindowPoint（windowRect 分支），全屏/region 仍走 mapScreenshotPoint
  assert.match(geoSrc, /snapshot\?\.windowRect\s*\r?\n\s*\? \(x, y\) => mapWindowPoint\(snapshot\.windowRect, x, y\)/);
});

test('钉：screen 捕获永远兜底（③），最小化直接走 ③，窗口链失败也走 ③', () => {
  assert.match(cuSrc, /types: \['screen'\],/);
  assert.match(cuSrc, /const captureWindowImage = createWindowCapture\(/);
  // 最小化：不进 ①，直接 ③ 并注明
  assert.match(cuSrc, /if \(target\.iconic !== true\)/);
  assert.match(cuSrc, /目标已最小化，窗口捕获不可用，已回退全屏。/);
  // ①② 失败：fallbackNote 兜底文案
  assert.match(cuSrc, /窗口捕获不可用（窗口源未找到\/被重采样，或 winapp 缺失\/失败），已回退全屏。/);
  assert.match(cuSrc, /return captureScreenFrame\(\{\s*\r?\n\s*maxWidth: 1560, region: null,/);
  // 编排层把 winapp 定位成可选：探测不到 → null（绝不硬依赖）
  assert.match(wcSrc, /winappDetect/);
  assert.match(cuSrc, /import \{ detectWinapp, winappScreenshotCommand, parseWinappScreenshotJson \} from '\.\/winapp-cli\.mjs';/);
});

test('钉：遮挡拒绝（0.29.7 B）未放松——windowAtPoint + occludedBy 校验链原样保留', () => {
  assert.match(cuSrc, /await input\.windowAtPoint\(point\.x, point\.y\)/);
  assert.match(cuSrc, /occludedBy\(top, foreground\)/);
  assert.match(cuSrc, /目标被「\$\{blocker\}」遮挡/);
  // winapp 不参与遮挡判定：occludedBy 逻辑只在 geometry 层
  assert.match(geoSrc, /export function occludedBy/);
});

test('钉：WindowInfo 增加 iconic（最小化判定），注入层其余断言未触碰', () => {
  assert.match(winSrc, /public bool iconic \{ get; set; \}/);
  assert.match(winSrc, /iconic = IsIconic\(h\)/);
  // 0.29.4/0.29.7 的原生断言原样
  assert.match(winSrc, /!guard\.captureBounds\.Matches\(PrimaryBounds\(\)\)/);
  assert.match(winSrc, /public static Window PointOwner\(int x, int y\)/);
});

test('钉：computer_screenshot schema 暴露 hwnd；AUTOMATION_GUIDANCE 新增遮挡教条', () => {
  const schemaLine = serviceSrc.split('\n').find((l) => l.includes("name: 'computer_screenshot'"));
  assert.match(schemaLine, /hwnd: \{ type: 'integer'/);
  assert.match(schemaLine, /hwnd 缺省=当前前台窗口/);
  const guidance = serviceSrc.slice(
    serviceSrc.indexOf('const AUTOMATION_GUIDANCE = ['),
    serviceSrc.indexOf("].join('\\n');", serviceSrc.indexOf('const AUTOMATION_GUIDANCE = ['))
  );
  assert.match(guidance, /target:"window"/);
  assert.match(guidance, /拍得到被遮挡的内容/);
  assert.match(guidance, /点击落在遮挡者上会被拒绝/);
  // 两处引用（audit/dev）仍指向同一 const
  const references = serviceSrc.split('\n').filter((l) => l.trim() === 'AUTOMATION_GUIDANCE,').length;
  assert.equal(references, 2);
});

// ---- 契约：hwnd 转发与返回体扩展（仿 automation-tools-contract 的 mock 引擎） ----

const foreground = { process: 'NOTEPAD', title: 'Scratch', tier: 'full', tierLabel: '可操作', granted: true };
const image = Buffer.from('fake image bytes');

function toolsFor(engines) {
  return createAgentTools({ repoRoot, getDesktopToolsAsync: async () => engines });
}

test('contract: target=window 传 hwnd 时转发 hwnd；返回体带 windowRect/windowSource 与遮挡提示', async () => {
  const calls = [];
  const windowShot = {
    ok: true, width: 1199, height: 800, buf: image, mime: 'image/png', foreground,
    screenshotId: 'shot-window', canAct: true,
    windowSource: 'window-thumbnail',
    windowRect: { x: 100, y: 100, width: 1200, height: 800 },
    note: '已用窗口自身捕获（WGC 窗口 thumbnail）看清全貌；被遮挡区域的点击仍会被拒绝（遮挡校验），需要用户移开遮挡窗或调整布局。'
  };
  const tools = toolsFor({ computerUse: {
    async captureScreen(options) { calls.push(options); return windowShot; }
  } });

  const r = await tools.computer_screenshot({ target: 'window', hwnd: 4321 });
  assert.deepEqual(calls[0], { target: 'window', windowTitle: '', hwnd: 4321 });
  assert.equal(r.ok, true);
  assert.equal(r.screenshot_id, 'shot-window');
  assert.deepEqual(r.windowRect, { x: 100, y: 100, width: 1200, height: 800 });
  assert.equal(r.windowSource, 'window-thumbnail');
  assert.match(r.note, /窗口自身捕获/);
  assert.match(r.note, /被遮挡区域的点击仍会被拒绝/);
  assert.match(r.note, /按窗口原点映射回屏幕/);
});

test('contract: 不传 hwnd 的 window 调用转发形状不变；screen 调用响应带 windowSource=screen', async () => {
  const calls = [];
  const tools = toolsFor({ computerUse: {
    async captureScreen(options) {
      calls.push(options);
      if (options.target === 'window') {
        return { ok: true, width: 100, height: 50, buf: image, mime: 'image/png', foreground, screenshotId: 'obs', canAct: false, windowSource: 'screen', windowRect: null, note: '目标已最小化，窗口捕获不可用，已回退全屏。' };
      }
      return { ok: true, width: 1560, height: 877, buf: image, mime: 'image/jpeg', foreground, screenshotId: 'shot-full', canAct: true, windowSource: 'screen', windowRect: null };
    }
  } });

  await tools.computer_screenshot({ target: 'window', window_title: 'Scratch' });
  assert.deepEqual(calls[0], { target: 'window', windowTitle: 'Scratch' });

  const screen = await tools.computer_screenshot({});
  assert.equal(screen.windowSource, 'screen');
  assert.equal(screen.windowRect, null);
  assert.match(screen.note, /全屏图的 screenshot_id/);

  const fallback = await tools.computer_screenshot({ target: 'window' });
  assert.equal(fallback.windowSource, 'screen');
  assert.match(fallback.note, /目标已最小化/);
  assert.equal(fallback.screenshot_id, null, 'observation-only 不得给 screenshot_id');
});

// 0.29.10：winapp ②级参数真值回归（0.29.8 写成 --hwnd/--out，v0.8.0 不认→②级必失败）
test('winapp CLI 参数钉：screenshot 必须用 -w/--window 与 -o/--output（不得回到 --hwnd/--out）', async () => {
  const { winappScreenshotCommand, parseWinappScreenshotJson } = await import('../desktop/src/main/winapp-cli.mjs');
  const cmd = winappScreenshotCommand('C:/fake/winapp.exe', 2230588, 'C:/tmp/out.png');
  assert.equal(cmd.file, 'C:/fake/winapp.exe');
  assert.deepEqual(cmd.args, ['ui', 'screenshot', '-w', '2230588', '-o', 'C:/tmp/out.png', '--json']);
  assert.ok(!cmd.args.includes('--hwnd'), '不得使用不存在的 --hwnd 参数');
  assert.ok(!cmd.args.includes('--out'), '不得使用不存在的 --out 参数');
});

test('parseWinappScreenshotJson：正常 JSON 取尺寸；脏输出/空/缺字段 → null', async () => {
  const { parseWinappScreenshotJson } = await import('../desktop/src/main/winapp-cli.mjs');
  assert.deepEqual(parseWinappScreenshotJson('{"FilePath":"a.png","Width":1200,"Height":800}'),
    { filePath: 'a.png', width: 1200, height: 800 });
  assert.equal(parseWinappScreenshotJson('warning: something\n'), null, '非 JSON 不抛错、返回 null');
  assert.equal(parseWinappScreenshotJson(''), null);
  assert.equal(parseWinappScreenshotJson('{"Width":0,"Height":0}'), null, '零尺寸视为无效');
  assert.equal(parseWinappScreenshotJson('{"FilePath":"a.png"}'), null, '缺尺寸视为无效');
});
