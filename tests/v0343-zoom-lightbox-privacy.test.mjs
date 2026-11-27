// 0.34.3：界面缩放快捷键兜底、大图显示原图、发布物里不夹带任何具体服务器地址。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zoomActionForKey } from '../desktop/src/renderer/lib/zoom-keys.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('缩放快捷键：Ctrl + = / + / - / 0（含小键盘）；没按 Ctrl、带 Alt、别的键都不算', () => {
  const k = (o) => zoomActionForKey({ ctrlKey: true, ...o });
  assert.equal(k({ key: '=', code: 'Equal' }), 'zoom-in');
  assert.equal(k({ key: '+', code: 'Equal' }), 'zoom-in');
  assert.equal(k({ key: 'Process', code: 'Equal' }), 'zoom-in', '中文输入法下 key 是 Process，按物理键位认');
  assert.equal(k({ key: '+', code: 'NumpadAdd' }), 'zoom-in');
  assert.equal(k({ key: '-', code: 'Minus' }), 'zoom-out');
  assert.equal(k({ key: '0', code: 'Digit0' }), 'zoom-reset');
  assert.equal(zoomActionForKey({ key: '=', code: 'Equal' }), null);
  assert.equal(k({ key: '=', code: 'Equal', altKey: true }), null);
  assert.equal(k({ key: 't', code: 'KeyT' }), null);
  assert.equal(zoomActionForKey({ metaKey: true, key: '=', code: 'Equal' }, true), 'zoom-in', 'Mac 用 Cmd');
  assert.equal(zoomActionForKey({ ctrlKey: true, key: '=', code: 'Equal' }, true), null);
});

test('大图：按路径读原图换掉 480px 缩略图；点图在适应窗口 / 原始像素之间切换', () => {
  const src = fs.readFileSync(path.join(root, 'desktop/src/renderer/components/ImageLightbox.jsx'), 'utf8');
  assert.match(src, /artifactRead\?\.\(path\)/, '打开时按路径读原图');
  assert.match(src, /src=\{fullSrc \|\| item\.src\}/, '有原图用原图，没有才用缩略图');
  assert.match(src, /setActual\(true\)/);
  assert.doesNotMatch(src, /max-h-\[86vh\] max-w-\[90vw\]/, '不再按缩略图原尺寸显示（那样又小又糊）');
});

test('手机网页：非 iOS 去掉 maximum-scale，双指缩放可用', () => {
  const src = fs.readFileSync(path.join(root, 'desktop/src/mobile/mobile-shell.mjs'), 'utf8');
  assert.match(src, /if \(!isIOS\)[\s\S]{0,200}maximum-scale/);
});

// 外网访问要用户自己填服务器：代码和安装包里不能写死任何具体的公网地址。
// 只允许本机 / 局域网 / 文档示例地址（RFC 5737）/ 链路本地 / 云元数据这类通用地址。
test('发布物不夹带具体公网 IP：桌面端源码与测试里只有本机 / 局域网 / 文档示例地址', () => {
  const allowed = (ip) => {
    const [a, b, c, d] = ip.split('.').map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return true;       // 不是 IP（版本号之类）
    if (b === 0 && c === 0 && d === 0) return true;           // Chrome/130.0.0.0 这类 UA 版本号，不是主机地址
    return a === 127 || a === 0 || a === 10 || a === 255
      || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
      || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
      || ip === '1.2.3.4' || ip === '1.1.1.1' || ip === '8.8.8.8' || ip === '100.100.100.200';
  };
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'out', 'vendor'].includes(e.name)) walk(p); continue; }
      if (!/\.(m?js|jsx|json|html|css)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g)) {
        if (!allowed(m[0])) bad.push(`${path.relative(root, p)}: ${m[0]}`);
      }
    }
  };
  walk(path.join(root, 'desktop', 'src'));
  for (const f of ['mobile-access.test.mjs', 'mobile-access-projects.test.mjs', 'mobile-tunnel.test.mjs']) {
    const text = fs.readFileSync(path.join(root, 'tests', f), 'utf8');
    for (const m of text.matchAll(/(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])/g)) if (!allowed(m[1])) bad.push(`tests/${f}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('外网访问默认关闭、服务器为空：要用户自己去设置里填', async () => {
  const src = fs.readFileSync(path.join(root, 'desktop/src/main/mobile/mobile-access.mjs'), 'utf8');
  assert.match(src, /const NO_TUNNEL = \{ enabled: false, target: '', remotePort: DEFAULT_PORT, publicUrl: '' \}/);
});
