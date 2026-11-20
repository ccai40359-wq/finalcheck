// 无界面截图通道回归（2026-11-20）：修的是「纯 Node 下模型拿不到截图 → 盲写 UI」。
// 实测代价：r11 里模型写出的页面 JS 崩了（ro.observe(doc.body)）、无障碍文本没隐藏（数字叠成 1919/4141），
// 而它直到自己另起 python+Playwright 才发现——因为 capture_screenshot 直接回了「只在桌面端可用」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeCaptureBackend, captureBySubprocess, pngSize, resetCaptureBackendProbe } from '../desktop/src/main/capture-headless.mjs';

test('capture-headless: 后端探测返回可解释结果（不是裸布尔）', async () => {
  resetCaptureBackendProbe();
  const r = await probeCaptureBackend();
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) {
    assert.ok(['electron', 'chrome'].includes(r.kind), '后端类型必须是 electron 或 chrome');
    assert.ok(typeof r.bin === 'string' && r.bin.length > 4, '必须给出可执行文件路径');
  } else {
    assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0, '不可用时必须说明原因');
  }
});

test('capture-headless: pngSize 从 IHDR 读尺寸（不依赖图像库）', () => {
  // 造一个最小 4x3 PNG 头（只需要 IHDR 前 24 字节正确）
  const b = Buffer.alloc(26);
  b.writeUInt32BE(0x89504e47, 0);   // PNG 签名
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(3, 16);            // width
  b.writeUInt32BE(4, 20);            // height
  const s = pngSize(b);
  assert.deepEqual(s, { width: 3, height: 4 });
  assert.equal(pngSize(Buffer.from('not a png')), null);
  assert.equal(pngSize(Buffer.alloc(0)), null);
});

test('capture-headless: 真渲染一张本地 HTML（无 Electron 主进程也能出图）', { timeout: 120000 }, async () => {
  resetCaptureBackendProbe();
  const backend = await probeCaptureBackend();
  if (!backend.ok) {
    // 环境确实没有渲染器时不假装通过——把原因打出来让人知道这条没验
    console.log('跳过（本机无渲染后端）：' + backend.reasons.join('；'));
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-cap-test-'));
  const html = path.join(dir, 'page.html');
  const png = path.join(dir, 'out.png');
  // 两个互相重叠的绝对定位色块：能区分「渲染了」和「截了一张空白图」
  await (await import('node:fs/promises')).writeFile(html, `<!doctype html><html><body style="margin:0;background:#0b0a08">
<div style="position:absolute;left:0;top:0;width:200px;height:150px;background:#c9a227"></div>
<div style="position:absolute;left:60px;top:40px;width:120px;height:90px;background:#2f6b4f"></div>
<div style="position:absolute;left:20px;top:170px;color:#f3ecdd;font:16px/1.4 Georgia,serif">FinalCheck capture test</div>
</body></html>`);

  const out = await captureBySubprocess(html, { width: 400, height: 300, waitMs: 500, outDir: dir });
  assert.equal(out.mime, 'image/png');
  // 纯色块 fixture 压缩后很小（实测 ~2.7KB），不能用体积当「非空白」的判据；
  // 改成解 PNG 看关键坐标的像素颜色（机械证明真的渲染了，而不是截了一张黑图）
  assert.ok(out.buf.length > 800, `截图不能小到不可能有内容（实际 ${out.buf.length} 字节）`);
  assert.ok(out.width >= 400 || out.width === null, '宽度应为请求的 400（或无法解析时为 null）');
  const px = await samplePng(out.buf);
  assert.ok(px, '需要能解出 PNG 像素做颜色断言');
  assert.ok(near(px.gold, [201, 162, 39]), `左上角应是金色块 #c9a227（实测 ${px.gold}）`);
  assert.ok(near(px.pine, [47, 107, 79]), `重叠区应是墨绿块 #2f6b4f（实测 ${px.pine}，证明 z 序正确）`);
  assert.ok(!near(px.bg, [201, 162, 39]), '右下角不该被色块覆盖');
  // 写进 outDir 的文件必须真的存在
  const written = await readFile(out.file);
  assert.equal(written.equals(out.buf), true, '落盘内容与返回的 buffer 必须一致');
  await rm(dir, { recursive: true, force: true });
  assert.ok(png.length > 0);
});

// 极简 PNG 解码（只支持本测试用的 8bit RGB/RGBA 非隔行），避免为测试引入图像库
async function samplePng(buf) {
  const zlib = await import('node:zlib');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) return null; // 隔行不支持
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      const v = line[x];
      cur[x] = ft === 0 ? v
        : ft === 1 ? v + a
        : ft === 2 ? v + b
        : ft === 3 ? v + ((a + b) >> 1)
        : ft === 4 ? v + paeth(a, b, c)
        : 0;
    }
  }
  const at = (x, y) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]]; };
  return { gold: at(10, 10), pine: at(100, 60), bg: at(w - 10, h - 10), w, h };
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}
// 色彩管理/抗锯齿会让纯色有几级偏差，用容差而不是精确相等
function near(a, b, tol = 12) {
  return a && a.length === 3 && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}
