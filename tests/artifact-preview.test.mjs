// 右侧预览（2026-11-18）：视频流协议、PPT/Word → PDF 转换缓存、Range 解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRange, officeToPdf, findSoffice } from '../desktop/src/main/preview-convert.mjs';
import { handleMediaRequest } from '../desktop/src/main/media-protocol.mjs';

function dir(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'fc-preview-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const url = (abs) => `fc-media://local/${encodeURIComponent(path.resolve(abs))}`;

test('parseRange：常见写法与非法输入', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=2000-', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange(null, 1000), null);
});

test('fc-media：整段 200、Range 206（拖进度条）、非视频 415、敏感路径 403', async (t) => {
  const d = dir(t);
  const mp4 = path.join(d, 'a.mp4');
  writeFileSync(mp4, Buffer.from('0123456789'));
  const full = await handleMediaRequest(new Request(url(mp4)));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(await full.text(), '0123456789');
  const part = await handleMediaRequest(new Request(url(mp4), { headers: { range: 'bytes=2-5' } }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await part.text(), '2345');
  writeFileSync(path.join(d, 'x.txt'), 'x');
  assert.equal((await handleMediaRequest(new Request(url(path.join(d, 'x.txt'))))).status, 415);
  const ssh = path.join(process.env.USERPROFILE || process.env.HOME || d, '.ssh', 'id_rsa.mp4');
  assert.equal((await handleMediaRequest(new Request(url(ssh)))).status, 403);
});

test('officeToPdf：转换一次后命中缓存；没装 LibreOffice / 转换失败给出原因', async (t) => {
  const d = dir(t);
  const pptx = path.join(d, 'deck.pptx');
  writeFileSync(pptx, 'fake');
  const cacheDir = path.join(d, 'cache');
  mkdirSync(cacheDir);
  let calls = 0;
  const runner = async (_cmd, args) => {
    calls++;
    const outdir = args[args.indexOf('--outdir') + 1];
    writeFileSync(path.join(outdir, 'deck.pdf'), '%PDF-1.4');
    return { status: 0 };
  };
  const first = await officeToPdf(pptx, { cacheDir, soffice: 'soffice', runner });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  const again = await officeToPdf(pptx, { cacheDir, soffice: 'soffice', runner });
  assert.equal(again.cached, true);
  assert.equal(calls, 1, '同一文件只转一次');
  assert.deepEqual(await officeToPdf(pptx, { cacheDir, soffice: null }), { ok: false, reason: 'no-libreoffice' });
  writeFileSync(pptx, 'changed-content'); // 改了文件 → 缓存键变 → 重新转换；这次转换失败
  const failed = await officeToPdf(pptx, { cacheDir, soffice: 'soffice', runner: async () => ({ status: 1, stderr: 'boom' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /convert-failed: boom/);
});

test('findSoffice：按平台常见安装位置查找', () => {
  const hit = findSoffice({ env: { FINALCHECK_SOFFICE: 'X:/lo/soffice.exe' }, exists: (p) => p === 'X:/lo/soffice.exe' });
  assert.equal(hit, 'X:/lo/soffice.exe');
  assert.equal(findSoffice({ env: {}, exists: () => false }), null);
});
