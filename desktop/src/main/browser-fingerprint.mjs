// 0.33.5 内置浏览器「看起来像 Edge」：UA / Client Hints / Accept-Language 全部对齐 Windows 上的 Microsoft Edge。
//
// 为什么（用户反馈）：同一台电脑、同一个网络，自己的 Edge 能登 Reddit，FC 内置浏览器却被 reCAPTCHA 卡住。
// Electron 默认 UA 里带「Electron/33 FinalCheck/x」，Client Hints 的品牌只有 Chromium、没有 Microsoft Edge，
// navigator.plugins 为空（真浏览器有 5 个 PDF 条目）——这些都是风控常用的「这不是正常浏览器」信号。
//
// 原则：**版本号跟内核走，不吹牛**。Edge 的大版本号与 Chromium 一一对应；如果内核是 130 却自称 Edge 142，
// 网站用「142 才有的 API 存不存在」一测就穿帮，比老老实实报 130 更可疑。所以 UA / Sec-CH-UA / userAgentData
// 统一报「Edge <内核版本>」，三处一致。（要报更新的版本，正确做法是升级 Electron 内核。）
//
// 做不到的（如实说明）：谷歌登录页专门拦嵌入式浏览器，靠的不只是 UA；那类站点仍建议用「接我自己的 Edge」。
import os from 'node:os';

/** Windows 版本 → Client Hints 的 platformVersion（Win11 22H2+ = 15.0.0，21H2 = 14.0.0，Win10 = 10.0.0） */
export function windowsPlatformVersion(release = os.release()) {
  const build = Number(String(release || '').split('.')[2]) || 0;
  if (build >= 22621) return '15.0.0';
  if (build >= 22000) return '14.0.0';
  return '10.0.0';
}

/**
 * 系统语言 → 语言列表（不带 q 值：Chromium 自己按顺序补 q=0.9/0.8…，自己再写会变成「zh;q=0.9;q=0.9」）。
 * zh-CN → zh-CN,zh,en,en-US；en-US → en-US,en
 */
export function acceptLanguageFor(locale = '') {
  const loc = String(locale || '').trim() || 'zh-CN';
  const base = loc.split('-')[0];
  if (base === 'en') return loc === 'en' ? 'en' : `${loc},en`;
  return `${loc},${base},en,en-US`;
}

/** Sec-CH-UA 头的写法："Microsoft Edge";v="130", "Not?A_Brand";v="99", "Chromium";v="130" */
export function brandHeader(list = []) {
  return list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

/** 是否是会带 Client Hints 的「安全来源」（https / wss / 本机回环），和 Chromium 的规则一致 */
export function isSecureForHints(url = '') {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
    return (u.protocol === 'http:' || u.protocol === 'ws:') && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname);
  } catch { return false; }
}

/**
 * 给一个请求补 Client Hints 头（纯函数，可单测）。
 * Electron 没实现 Chromium 的 ClientHintsControllerDelegate，**一个 Sec-CH-UA 头都不发**——
 * 页面里 navigator.userAgentData 说自己是浏览器、请求头里却没有提示，本身就是破绽。
 * 规则同 Chrome：安全来源默认带低熵三项；高熵项只在该站点用 Accept-CH 要过之后才带。
 */
export function clientHintHeaders(identity, url, requested = null) {
  if (!isSecureForHints(url)) return {};
  const m = identity.metadata;
  const out = {
    'sec-ch-ua': brandHeader(m.brands),
    'sec-ch-ua-mobile': m.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${m.platform}"`
  };
  const want = requested instanceof Set ? requested : new Set();
  if (want.has('sec-ch-ua-full-version-list')) out['sec-ch-ua-full-version-list'] = brandHeader(m.fullVersionList);
  if (want.has('sec-ch-ua-full-version')) out['sec-ch-ua-full-version'] = `"${m.fullVersion}"`;
  if (want.has('sec-ch-ua-platform-version')) out['sec-ch-ua-platform-version'] = `"${m.platformVersion}"`;
  if (want.has('sec-ch-ua-arch')) out['sec-ch-ua-arch'] = `"${m.architecture}"`;
  if (want.has('sec-ch-ua-bitness')) out['sec-ch-ua-bitness'] = `"${m.bitness}"`;
  if (want.has('sec-ch-ua-model')) out['sec-ch-ua-model'] = `"${m.model}"`;
  if (want.has('sec-ch-ua-wow64')) out['sec-ch-ua-wow64'] = m.wow64 ? '?1' : '?0';
  return out;
}

/** 解析 Accept-CH 响应头 → 小写的提示名集合 */
export function parseAcceptCh(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.startsWith('sec-ch-ua')));
}

/**
 * 生成一份 Edge 身份。chromeVersion = 内核完整版本（process.versions.chrome，如 130.0.6723.191）。
 * @returns {{ userAgent: string, acceptLanguage: string, metadata: object, major: string }}
 */
export function edgeIdentity({ chromeVersion = process.versions?.chrome || '130.0.0.0', osRelease = os.release(), arch = process.arch, locale = '' } = {}) {
  const full = /^\d+(\.\d+){3}$/.test(String(chromeVersion)) ? String(chromeVersion) : '130.0.0.0';
  const major = full.split('.')[0];
  // 「精简 UA」：Chrome / Edge 自 101 起只报 major.0.0.0，完整版本只在高熵 Client Hints 里给
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`;
  const grease = { brand: 'Not?A_Brand', version: '99' };
  const metadata = {
    brands: [{ brand: 'Microsoft Edge', version: major }, grease, { brand: 'Chromium', version: major }],
    fullVersionList: [{ brand: 'Microsoft Edge', version: full }, { brand: grease.brand, version: '99.0.0.0' }, { brand: 'Chromium', version: full }],
    fullVersion: full,
    platform: 'Windows',
    platformVersion: windowsPlatformVersion(osRelease),
    architecture: arch === 'arm64' ? 'arm' : 'x86',
    model: '',
    mobile: false,
    bitness: arch === 'ia32' ? '32' : '64',
    wow64: false
  };
  let loc = locale;
  if (!loc) { try { loc = Intl.DateTimeFormat().resolvedOptions().locale; } catch { loc = 'zh-CN'; } }
  return { userAgent, acceptLanguage: acceptLanguageFor(loc), metadata, major };
}

const appliedSessions = new WeakSet();

/** 会话级：所有请求头（含 service worker）与 navigator.userAgent 都用 Edge UA，去掉 Electron/FinalCheck 字样 */
export function applyEdgeIdentityToSession(ses, identity = edgeIdentity()) {
  if (!ses || appliedSessions.has(ses)) return false;
  try {
    ses.setUserAgent?.(identity.userAgent, identity.acceptLanguage);
    appliedSessions.add(ses);
  } catch { return false; }
  // 补 Client Hints 请求头（见 clientHintHeaders 的注释）；Accept-CH 按站点记住（同 Chrome，存在内存里）
  const acceptCh = new Map(); // origin → Set
  const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
  try {
    ses.webRequest?.onHeadersReceived?.((details, callback) => {
      try {
        const h = details.responseHeaders || {};
        const key = Object.keys(h).find((k) => k.toLowerCase() === 'accept-ch');
        if (key && details.resourceType === 'mainFrame') acceptCh.set(originOf(details.url), parseAcceptCh(h[key]));
      } catch { /* 忽略 */ }
      callback({});
    });
    ses.webRequest?.onBeforeSendHeaders?.((details, callback) => {
      try {
        const headers = { ...(details.requestHeaders || {}) };
        const has = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
        const extra = clientHintHeaders(identity, details.url, acceptCh.get(originOf(details.url)));
        for (const [k, v] of Object.entries(extra)) if (!has.has(k)) headers[k] = v;
        callback({ requestHeaders: headers });
      } catch { callback({}); }
    });
  } catch { /* 旧版 Electron 没有 webRequest：只有 UA */ }
  return true;
}

/**
 * 页面级：Client Hints（Sec-CH-UA 请求头 + navigator.userAgentData）也报 Microsoft Edge。
 * Electron 没有现成接口，只能走 CDP 的 Emulation.setUserAgentOverride（右栏内嵌宿主本来就用 debugger 发可信点击）。
 * 必须在第一次 loadURL 之前做，否则首个请求的 Sec-CH-UA 还是 Chromium。
 */
export async function applyEdgeIdentityToContents(wc, identity = edgeIdentity()) {
  const dbg = wc?.debugger;
  if (!dbg || wc.isDestroyed?.()) return false;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    await Promise.race([
      dbg.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: identity.userAgent,
        acceptLanguage: identity.acceptLanguage,
        platform: 'Win32',
        userAgentMetadata: identity.metadata
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP 超时')), 2000))
    ]);
    return true;
  } catch { return false; }
}
