// 「更新从哪来」的纯函数层（不联网、不依赖 Node/Electron，tests/ 直测）。
//
// 为什么要这一层：electron-updater 只认 GitHub Release 的 latest.yml，国内访问 GitHub 常常
// 超时，用户就永远收不到新版本提示。官网 finalcheck.cncloud.uk 有 AUTO_SYNC，会把最新 Release
// 镜像到本地并暴露 GET /api/release（JSON）。所以这里只回答「有没有新版本、优先从哪拿」，
// 下载与安装仍然走 electron-updater 原来那条链路，一条都不改。
//
// 红线：官网的 /latest.yml 返回的是 SPA 的 HTML（200 + text/html），绝不能让 electron-updater
// 指向官网——只能读 JSON 接口，再由主进程挑源。
//
// 安全：官网域名写死成常量，不从任何外部输入拼；下载地址必须是 http(s)、必须是官网本身、
// 且不得落在本机 / 环回 / 私有网段 / 链路本地 / 保留地址上（SSRF 兜底）。

export const SITE_HOST = 'finalcheck.cncloud.uk';
export const SITE_ORIGIN = `https://${SITE_HOST}`;
export const SITE_RELEASE_PATH = '/api/release';
export const SITE_RELEASE_URL = `${SITE_ORIGIN}${SITE_RELEASE_PATH}`;

const MAX_VERSION_LEN = 40;

// ---------------- 版本比较 ----------------

// 拆成「数字段数组 + 预发布后缀」：v 前缀、+build 元数据、-beta.1 都单独处理，
// 非数字段（如 "0.33.x" 里的 x）当 0，避免 NaN 一路污染比较结果。
function splitVersion(raw) {
  const text = String(raw ?? '').trim().replace(/^v/i, '');
  if (!text) return null;
  const plus = text.indexOf('+');
  const noBuild = plus >= 0 ? text.slice(0, plus) : text;
  const dash = noBuild.indexOf('-');
  const core = dash >= 0 ? noBuild.slice(0, dash) : noBuild;
  const pre = dash >= 0 ? noBuild.slice(dash + 1) : '';
  const nums = core.split('.').map((seg) => {
    const m = /^\d+/.exec(seg.trim());
    return m ? Number(m[0]) : 0;
  });
  return { nums, pre };
}

// 预发布后缀按 semver 规则比：无后缀 > 有后缀；数字段按数值比、字母段按字典序、数字 < 字母。
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1; // 段数少的更小（1.0.0-beta < 1.0.0-beta.1）
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 语义化版本比较：返回 -1 / 0 / 1。不能用字符串比较（"0.33.10" 会小于 "0.33.9"）。 */
export function compareVersions(a, b) {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const an = va ? va.nums : [];
  const bn = vb ? vb.nums : [];
  const len = Math.max(an.length, bn.length);
  for (let i = 0; i < len; i += 1) {
    const x = an[i] ?? 0;
    const y = bn[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return comparePrerelease(va ? va.pre : '', vb ? vb.pre : '');
}

// ---------------- 字段清洗 ----------------

// 版本号只保留可读部分：去 v 前缀、限长、必须以数字开头。
// 挡掉 undefined / "null" / JSON 片段 / 空串，避免脏值一路传到界面或返回给渲染层。
function cleanVersionText(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim().replace(/^v/i, '');
  if (!text || text.length > MAX_VERSION_LEN) return '';
  if (!/^\d[0-9A-Za-z.+-]*$/.test(text)) return '';
  return text;
}

const cleanText = (raw, maxLen = 200) => {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  return text.slice(0, maxLen);
};

// 文件名只接受裸文件名：带路径分隔符或 .. 的一律丢弃（镜像站不会这么返回，防的是被篡改的响应）
function cleanFileName(raw) {
  const text = cleanText(raw, 160);
  if (!text || /[/\\]/.test(text) || text.includes('..')) return '';
  return text;
}

function cleanSize(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function cleanSha256(raw) {
  const text = cleanText(raw, 80);
  return /^[a-f0-9]{64}$/i.test(text) ? text.toLowerCase() : undefined;
}

function cleanPublishedAt(raw) {
  const text = cleanText(raw, 40);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text : '';
}

// ---------------- 地址白名单 ----------------

const parseIpv4 = (host) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? null : parts;
};

function isBlockedIpv4([a, b]) {
  if (a === 0 || a === 10 || a === 127) return true;                 // 本网络 / 私有 / 环回
  if (a === 169 && b === 254) return true;                            // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;                   // 172.16/12
  if (a === 192 && b === 168) return true;                            // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;                  // 运营商级 NAT 100.64/10
  if (a === 192 && b === 0) return true;                              // 192.0.0/24 保留 + 192.0.2/24 文档
  if (a === 198 && (b === 18 || b === 19)) return true;               // 198.18/15 基准测试
  if (a === 198 && b === 51) return true;                             // 198.51.100/24 文档
  if (a === 203 && b === 0) return true;                              // 203.0.113/24 文档
  if (a >= 224) return true;                                          // 组播 + 保留 + 广播
  return false;
}

function isBlockedIpv6(host) {
  const s = host.toLowerCase();
  if (s === '::' || s === '::1') return true;                          // 未指定 / 环回
  if (s.startsWith('::ffff:')) {                                       // IPv4 映射地址，按 v4 再判一次
    const v4 = parseIpv4(s.slice('::ffff:'.length));
    return v4 ? isBlockedIpv4(v4) : true;
  }
  if (/^f[cd]/.test(s)) return true;                                   // fc00::/7 唯一本地
  if (/^fe[89ab]/.test(s)) return true;                                // fe80::/10 链路本地
  if (/^64:ff9b:/.test(s)) return true;                                // NAT64 翻译前缀
  if (s.startsWith('2001:db8')) return true;                           // 文档地址
  return false;
}

/**
 * 主机名是否禁止访问：本机名、内网后缀、环回 / 私有 / 链路本地 / 保留 IP。
 * 只做静态字符串判断（不解析 DNS）——调用方本就只允许官网这一个固定域名。
 */
export function isBlockedHostname(rawHost) {
  const host = String(rawHost ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain')) return true;
  if (host === 'metadata.google.internal' || host === 'metadata') return true;
  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(v4);
  if (host.includes(':')) return isBlockedIpv6(host);
  return false;
}

/**
 * 把官网返回的下载地址拼成绝对 URL；不合法 / 不在官网域名下就返回空串。
 * 官网返回的是 `/api/download?file=xxx` 这种相对路径，直接用 URL 相对解析到 SITE_ORIGIN。
 */
export function resolveDownloadUrl(raw, origin = SITE_ORIGIN) {
  const text = cleanText(raw, 2000);
  if (!text) return '';
  let url;
  try {
    url = new URL(text, origin);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';            // 地址里带凭据的一律不要
  if (isBlockedHostname(url.hostname)) return '';
  if (url.hostname.toLowerCase() !== SITE_HOST) return ''; // 只认官网域名，不做任意主机下载
  return url.toString();
}

// ---------------- 官网 JSON 解析 ----------------

/**
 * 从官网 GET /api/release 的返回里抽版本信息；任何字段缺失 / 格式不对都返回 null，绝不抛异常
 * （调用方据此静默降级到 GitHub）。
 */
export function parseSiteRelease(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const latest = json.latest;
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) return null;

  const version = cleanVersionText(latest.version);
  if (!version) return null; // 没有可用版本号 = 这条接口结果不可用

  return {
    version,
    fileName: cleanFileName(latest.fileName) || undefined,
    size: cleanSize(latest.size),
    sha256: cleanSha256(latest.sha256),
    downloadUrl: cleanText(latest.downloadUrl, 2000) || undefined,
    title: cleanText(latest.title, 300) || undefined,
    publishedAt: cleanPublishedAt(latest.publishedAt) || undefined
  };
}

// ---------------- 挑源 ----------------

const githubVersionOf = (github) => {
  if (typeof github === 'string') return cleanVersionText(github);
  if (!github || typeof github !== 'object') return '';
  return cleanVersionText(github.version) || cleanVersionText(github.latestVersion);
};

/**
 * 在两个源里挑一个：返回 `{ source: 'site'|'github'|null, version, ... }`。
 *
 * 规则：
 *  1. 只有「比当前版本新」的源才算候选，避免把同版本当成更新提示；
 *  2. 候选里取版本最高的那个；版本相同时一律选官网——官网镜像在国内下得动，GitHub 常常下不动；
 *  3. 官网拿不到（网络失败 / 字段坏了）而 GitHub 有更新 → 用 GitHub；
 *  4. 两边都没有更新（或当前版本读不出来）→ `{ source: null }`。
 *
 * 第 2 条没有写成「只要官网比当前新就选官网」：官网 AUTO_SYNC 允许短暂落后于 GitHub
 * （/api/release 里的 behind > 0），那种情况下把更旧的包推给用户是错的。
 */
export function pickBestSource({ site, github, currentVersion } = {}) {
  const current = cleanVersionText(currentVersion);
  if (!current) return { source: null }; // 读不到当前版本就不判断，宁可不上报也不误报

  const siteVersion = site && typeof site === 'object' ? cleanVersionText(site.version) : '';
  const githubVersion = githubVersionOf(github);

  const siteNewer = siteVersion ? compareVersions(siteVersion, current) > 0 : false;
  const githubNewer = githubVersion ? compareVersions(githubVersion, current) > 0 : false;

  if (!siteNewer && !githubNewer) return { source: null };

  if (siteNewer && (!githubNewer || compareVersions(siteVersion, githubVersion) >= 0)) {
    return {
      source: 'site',
      version: siteVersion,
      downloadUrl: resolveDownloadUrl(site.downloadUrl) || undefined,
      sha256: site.sha256,
      size: site.size,
      fileName: site.fileName,
      title: site.title,
      publishedAt: site.publishedAt
    };
  }

  return { source: 'github', version: githubVersion };
}
