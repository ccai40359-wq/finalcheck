// 安装期准备 better-sqlite3 的预编译二进制（无需 MSVC / electron-rebuild）：
// - Electron 运行时：<pkg>/build/Release/better_sqlite3.node（ABI = 当前 Electron 的 modules）
// - 纯 Node 测试：<pkg>/prebuilds-node/better_sqlite3.node（ABI = 当前 Node 的 modules）
// 优先 npmmirror，失败回退 GitHub releases；已就绪（标记 ABI 一致）时跳过下载。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const pkgDir = path.join(desktopDir, 'node_modules', 'better-sqlite3');
const require = createRequire(path.join(desktopDir, 'package.json'));

const log = (...a) => console.log('[sqlite-binding]', ...a);
const warn = (...a) => console.warn('[sqlite-binding]', ...a);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
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
  const fileName = `better-sqlite3-v${pkgVersion}-${runtime}-v${abi}-${platform}.tar.gz`;
  const mirror = (process.env.FINALCHECK_SQLITE_BINARY_HOST || 'https://registry.npmmirror.com/-/binary/better-sqlite3').replace(/\/+$/, '');
  const urls = [
    `${mirror}/v${pkgVersion}/${fileName}`,
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${pkgVersion}/${fileName}`,
  ];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sqlite-'));
  const tgz = path.join(tmpDir, fileName);
  let lastErr = null;
  for (const url of urls) {
    try {
      log('下载 ' + url);
      await download(url, tgz);
      const unpack = path.join(tmpDir, 'unpack');
      fs.mkdirSync(unpack, { recursive: true });
      // Windows 的 GNU tar 会把带盘符的绝对路径当成远程主机（D:），这里用相对路径 + cwd
      execFileSync('tar', ['-xzf', path.basename(tgz), '-C', 'unpack'], { cwd: tmpDir, stdio: 'ignore' });
      const nodeFile = path.join(unpack, 'build', 'Release', 'better_sqlite3.node');
      if (!fs.existsSync(nodeFile)) throw new Error('压缩包内缺少 build/Release/better_sqlite3.node');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(nodeFile, dest);
      writeMarker(dest, abi);
      log('已写入 ' + dest + '（' + runtime + ' ABI ' + abi + '）');
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return true;
    } catch (e) {
      lastErr = e;
      warn('失败：' + (e?.message || e));
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

main().catch((e) => {
  console.error('[sqlite-binding] ' + (e?.message || e));
  process.exit(1);
});
