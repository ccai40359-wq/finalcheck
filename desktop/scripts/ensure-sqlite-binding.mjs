// 安装期准备 better-sqlite3 的预编译二进制（无需 MSVC / electron-rebuild）：
// - Electron 运行时：<pkg>/build/Release/better_sqlite3.node（ABI = 当前 Electron 的 modules）
// - 纯 Node 测试：<pkg>/prebuilds-node/better_sqlite3.node（ABI = 当前 Node 的 modules）
// 优先 npmmirror，失败回退 GitHub releases；已就绪（标记 ABI 一致）时跳过下载。
// 每个下载到的 tar.gz 都必须在解压前通过 SHA256 校验（清单见 sqlite-prebuild-sha256.json）；
// 清单缺失的组合 fail closed（FINALCHECK_SQLITE_ALLOW_UNVERIFIED=1 仅供本地开发临时放行）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const pkgDir = path.join(desktopDir, 'node_modules', 'better-sqlite3');
const require = createRequire(path.join(desktopDir, 'package.json'));

export const MANIFEST_FILE = path.join(scriptDir, 'sqlite-prebuild-sha256.json');
export const ALLOW_UNVERIFIED_ENV = 'FINALCHECK_SQLITE_ALLOW_UNVERIFIED';

const log = (...a) => console.log('[sqlite-binding]', ...a);
const warn = (...a) => console.warn('[sqlite-binding]', ...a);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toLowerCase();
}

export function verifySha256(filePath, expected) {
  const wanted = typeof expected === 'string' ? expected.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(wanted)) {
    throw new Error('无固定 hash，拒绝未验证预编译包（清单缺少该组合或 hash 格式非法）');
  }
  const actual = sha256File(filePath);
  if (actual !== wanted) {
    throw new Error(`SHA256 校验失败：期望 ${wanted}，实际 ${actual}`);
  }
  return true;
}

export function manifestKey({ version, runtime, abi, platform }) {
  return `${version}|${runtime}|${abi}|${platform}`;
}

// 返回 { key, sha256 }；sha256 为 null 表示清单里没有该组合（调用方必须 fail closed）
export function lookupSha256(manifest, { version, runtime, abi, platform }) {
  const key = manifestKey({ version, runtime, abi, platform });
  const raw = manifest && Object.prototype.hasOwnProperty.call(manifest, key) ? manifest[key] : null;
  const sha256 = typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw.trim())
    ? raw.trim().toLowerCase()
    : null;
  return { key, sha256 };
}

// 清单缺失即 fail closed；仅当显式 allowUnverified（本地开发）时返回 sha256=null 并放行
export function resolveExpectedSha256(manifest, combo, { allowUnverified = false } = {}) {
  const { key, sha256 } = lookupSha256(manifest, combo);
  if (sha256) return { key, sha256, allowUnverified: false };
  if (!allowUnverified) {
    throw new Error(
      `无固定 hash，拒绝未验证预编译包：${key}。` +
      '请把上游 tar.gz 的实际 SHA256 加入 desktop/scripts/sqlite-prebuild-sha256.json；' +
      `本地开发可临时设置 ${ALLOW_UNVERIFIED_ENV}=1（默认关闭，会打印警告）`
    );
  }
  return { key, sha256: null, allowUnverified: true };
}

export function loadManifest(file = MANIFEST_FILE) {
  const manifest = readJson(file);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    warn('无法读取 SQLite 预编译包 hash 清单：' + file);
    return {};
  }
  return manifest;
}

function napiGetAbi(version, runtime) {
  try {
    const nodeAbi = require('node-abi');
    return nodeAbi.getAbi(version, runtime);
  } catch (e) {
    warn('node-abi 不可用，无法推导 ABI：' + (e?.message || e));
    return null;
  }
}

function platformPart() {
  const platform = process.platform;
  const arch = process.arch;
  // better-sqlite3 的 Linux prebuild 分 glibc 与 musl，Windows/macOS 直接用平台名
  if (platform === 'linux') {
    try {
      const { isNonGlibcLinuxSync } = require('detect-libc');
      return `${isNonGlibcLinuxSync() ? 'linuxmusl' : 'linux'}-${arch}`;
    } catch { return `linux-${arch}`; }
  }
  return `${platform}-${arch}`;
}

function markerOf(dest) { return dest + '.fc-abi'; }

function isReady(dest, abi) {
  if (!fs.existsSync(dest)) return false;
  const marker = readJson(markerOf(dest));
  return !!marker && String(marker.abi) === String(abi);
}

function writeMarker(dest, abi) {
  fs.writeFileSync(markerOf(dest), JSON.stringify({ abi, at: Date.now() }) + '\n', 'utf8');
}

function download(url, destFile, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 120000 }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 6) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, destFile, redirects + 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status} ${url}`));
      }
      const out = fs.createWriteStream(destFile);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时：' + url)));
    req.on('error', reject);
  });
}

async function fetchPrebuild({ pkgVersion, runtime, abi, dest, force = false }) {
  if (!abi) return false;
  if (!force && isReady(dest, abi)) { log('已就绪，跳过：' + dest); return true; }
  const platform = platformPart();
  const combo = { version: pkgVersion, runtime, abi, platform };
  const allowUnverified = process.env[ALLOW_UNVERIFIED_ENV] === '1';
  const { key, sha256: expected } = resolveExpectedSha256(loadManifest(), combo, { allowUnverified });
  if (!expected) {
    warn(`警告：${ALLOW_UNVERIFIED_ENV}=1 已关闭 SHA256 校验（仅限本地开发）：${key}`);
  }
  const fileName = `better-sqlite3-v${pkgVersion}-${runtime}-v${abi}-${platform}.tar.gz`;
  const mirror = (process.env.FINALCHECK_SQLITE_BINARY_HOST || 'https://registry.npmmirror.com/-/binary/better-sqlite3').replace(/\/+$/, '');
  const urls = [
    `${mirror}/v${pkgVersion}/${fileName}`,
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${pkgVersion}/${fileName}`,
  ];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sqlite-'));
  const tgz = path.join(tmpDir, fileName);
  let lastErr = null;
  try {
    for (const [attempt, url] of urls.entries()) {
      try {
        log('下载 ' + url);
        await download(url, tgz);
      } catch (e) {
        // 下载失败（HTTP/网络）按原逻辑回退下一个 URL；每个成功下载的包仍必须校验
        lastErr = e;
        warn('下载失败：' + (e?.message || e));
        fs.rmSync(tgz, { force: true });
        continue;
      }
      if (expected) {
        try {
          verifySha256(tgz, expected);
          log('SHA256 校验通过：' + key);
        } catch (e) {
          // 校验失败立即中止：不解压、不拷贝、不回退到下一个 URL（可能是投毒）
          fs.rmSync(tmpDir, { recursive: true, force: true });
          throw new Error('预编译包校验失败，已中止（未解压/未拷贝）：' + (e?.message || e));
        }
      }
      try {
        const unpack = path.join(tmpDir, `unpack-${attempt}`);
        fs.mkdirSync(unpack, { recursive: true });
        // Windows 的 GNU tar 会把带盘符的绝对路径当成远程主机（D:），这里用相对路径 + cwd
        execFileSync('tar', ['-xzf', path.basename(tgz), '-C', path.basename(unpack)], { cwd: tmpDir, stdio: 'ignore' });
        const nodeFile = path.join(unpack, 'build', 'Release', 'better_sqlite3.node');
        if (!fs.existsSync(nodeFile)) throw new Error('压缩包内缺少 build/Release/better_sqlite3.node');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(nodeFile, dest);
        writeMarker(dest, abi);
        log('已写入 ' + dest + '（' + runtime + ' ABI ' + abi + '）');
        return true;
      } catch (e) {
        lastErr = e;
        warn('解压/写入失败：' + (e?.message || e));
        fs.rmSync(tgz, { force: true });
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  warn('无法获取预编译二进制：' + (lastErr?.message || lastErr));
  return false;
}

async function main() {
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  if (!pkg) throw new Error('未安装 better-sqlite3：' + pkgDir);
  const version = pkg.version;

  // 1) Electron 运行时二进制（默认加载路径）
  const electronPkg = readJson(path.join(desktopDir, 'node_modules', 'electron', 'package.json'));
  if (electronPkg?.version) {
    const abi = napiGetAbi(electronPkg.version, 'electron');
    const dest = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node');
    log(`Electron ${electronPkg.version} → ABI ${abi}`);
    // 强制覆盖：npm 装依赖时 better-sqlite3 的 install 脚本会把 build/Release 写成 Node ABI 二进制
    const ok = await fetchPrebuild({ pkgVersion: version, runtime: 'electron', abi, dest, force: true });
    if (!ok) throw new Error('Electron 33 的 better-sqlite3 二进制准备失败（检查网络后重试 npm run setup:sqlite）');
  } else {
    warn('未找到 electron/package.json（--omit=dev 安装？），跳过 Electron 二进制');
  }

  // 2) 纯 Node 运行时二进制（node --test 用，经 nativeBinding 显式加载）
  const nodeAbi = napiGetAbi(process.versions.node, 'node');
  const nodeDest = path.join(pkgDir, 'prebuilds-node', 'better_sqlite3.node');
  log(`Node ${process.versions.node} → ABI ${nodeAbi}`);
  const nodeOk = await fetchPrebuild({ pkgVersion: version, runtime: 'node', abi: nodeAbi, dest: nodeDest });
  if (!nodeOk && !isReady(nodeDest, nodeAbi)) throw new Error('Node 测试用的 better-sqlite3 二进制准备失败');
}

function isMainModule() {
  try {
    return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMainModule()) {
  main().catch((e) => {
    console.error('[sqlite-binding] ' + (e?.message || e));
    process.exit(1);
  });
}
