// Linux / macOS 沙箱后端（对齐 Claude Code）。
//
// Claude Code 的做法（官方文档 + 开源实现 @anthropic-ai/sandbox-runtime）：
//   · Linux/WSL2 → bubblewrap（文件系统隔离）+ socat（把流量中转到宿主代理）
//   · macOS      → Seatbelt（sandbox-exec）
//   · 网络       → bwrap --unshare-net 建一个完全断网的 namespace，
//                 需要联网时走宿主代理，通过 Unix socket bind mount 进沙箱
//   · 不是 Docker —— 官方明确说内置沙箱「不加 Docker 依赖」
//
// 为什么直接用它的包而不是自己拼 bwrap 参数：那份实现处理了一堆自己写必踩的坑
//   · 读拒绝要用 --tmpfs 盖住整个目录，再把允许的子目录 --ro-bind 回来
//     （源码注释里专门提了 /lib → /usr/lib 这类符号链接会被 tmpfs 藏掉）
//   · bwrap 的 argv 长度有上限，超了要把挂载参数写进匿名文件走 --args <fd>
//   · deny 路径不存在时 bwrap 会在宿主上建空文件当挂载点，退出后要清理（带引用计数）
//   · Ubuntu 的 AppArmor 会拦非特权 user namespace，要先探测再决定怎么跑
// 自己从零写，极可能漏掉「读隔离」这一整层。
//
// 网络默认策略（2026-11-20 定案）：
//   CC 是「默认全断 + 域名白名单」。FC 的 agent 要连模型网关、npm、pip、GitHub，
//   照搬会让用户装完就跑不动（每个域名都得手动加）。所以这里默认放行常见开发域名，
//   用户仍可在 config 里改成严格白名单（sandboxStrictNetwork: true → 只认用户填的）。
//
// 与 Windows ACL 沙箱的分工：
//   · Windows：只拦写（读完全不拦，诚实标注）
//   · Linux：读写都能拦（bwrap 的 tmpfs 覆盖能把读也挡住），比 Windows 那套强
//   这是移植带来的实际收益，不是「为了对齐而对齐」。

import path from 'node:path';

const SANDBOX_PKG = '@anthropic-ai/sandbox-runtime';

// 常见开发工具链域名：npm / PyPI / GitHub / Go / Rust / Maven / Docker Hub。
// 白名单里放的是「模型做正常开发时必然要访问的」，不是「所有能访问的」。
// 用户配的模型网关域名由调用方追加（见 buildNetworkConfig）。
export const DEVELOPMENT_DOMAINS = Object.freeze([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'proxy.golang.org',
  'sum.golang.org',
  'crates.io',
  'static.crates.io',
  'repo1.maven.org',
  'repo.maven.apache.org',
  'registry-1.docker.io',
  'auth.docker.io'
]);

// 写默认放行：工作目录、用户 temp、以及常见包管理器缓存
// （不让装依赖就等于不让干活；这些都是可重建的缓存，不是敏感数据）
export const DEFAULT_WRITE_PATHS = Object.freeze(['.', '/tmp', '~/.npm', '~/.cache', '~/.local/share/pnpm']);

// 读默认拒绝：凭据、私钥、云厂商配置。这是与 Windows ACL 沙箱最大的差别 ——
// Windows 那套根本不拦读，`type 项目外文件` 读得出来；Linux 这层能真挡住。
export const DEFAULT_DENY_READ = Object.freeze([
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.docker/config.json',
  '~/.git-credentials',
  '~/.npmrc',
  '~/.config/gcloud',
  '~/.kube',
  // 应用自己的数据目录（会话库里有 API Key）
  '~/.config/FinalCheck',
  '~/Library/Application Support/FinalCheck'
]);

/** 把用户配置的网关域名塞进白名单（只取 host，丢掉协议与路径）。 */
export function hostOfUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    return u.hostname || '';
  } catch { return ''; }
}

/**
 * 构造 SandboxRuntimeConfig。
 * @param {object} o
 * @param {string[]} [o.extraWritePaths] 额外允许写的路径（如 --add-dir）
 * @param {string[]} [o.gatewayUrls] 模型网关地址（自动提取 host 进白名单）
 * @param {boolean} [o.strictNetwork] true = 只认 extraDomains，不自动加开发域名
 * @param {string[]} [o.extraDomains] 用户额外允许的域名
 * @param {boolean} [o.allowNetwork] false = 完全断网（最严格）
 * @returns {object} 可直接传给 SandboxManager.initialize 的 config
 */
export function buildSandboxConfig({
  extraWritePaths = [],
  gatewayUrls = [],
  strictNetwork = false,
  extraDomains = [],
  allowNetwork = true,
  denyRead = true
} = {}) {
  const filesystem = {
    denyRead: denyRead ? [...DEFAULT_DENY_READ] : [],
    allowRead: [],
    allowWrite: [...DEFAULT_WRITE_PATHS, ...(Array.isArray(extraWritePaths) ? extraWritePaths : [])],
    denyWrite: []
  };
  if (!allowNetwork) {
    return { filesystem, network: { allowedDomains: [], deniedDomains: ['*'] } };
  }
  const gatewayHosts = (Array.isArray(gatewayUrls) ? gatewayUrls : []).map(hostOfUrl).filter(Boolean);
  const allowed = [
    ...(strictNetwork ? [] : DEVELOPMENT_DOMAINS),
    ...gatewayHosts,
    ...(Array.isArray(extraDomains) ? extraDomains.map((d) => String(d || '').trim()).filter(Boolean) : [])
  ];
  return {
    filesystem,
    // deniedDomains 留空：允许列表之外的一律拒绝，这是 allow-only 语义（官方默认）
    network: { allowedDomains: [...new Set(allowed)], deniedDomains: [] }
  };
}

/**
 * 检查这台机器能不能用沙箱。
 * @returns {{available:boolean, platform:string, reason:string|null, hint?:string}}
 */
export async function probeSandbox() {
  const platform = process.platform;
  if (platform === 'win32') {
    // Windows 走自己的 ACL 后端（sandbox.mjs），不走这里
    return { available: false, platform, reason: 'Windows 使用 ACL 受限令牌后端' };
  }
  let mod;
  try {
    mod = await import(SANDBOX_PKG);
  } catch (e) {
    return {
      available: false,
      platform,
      reason: `未安装 ${SANDBOX_PKG}：${e?.message || e}`,
      hint: '桌面端打包时会带上；从源码跑请执行 npm install'
    };
  }
  try {
    if (!mod.SandboxManager?.isSupportedPlatform?.()) {
      return {
        available: false,
        platform,
        reason: `@anthropic-ai/sandbox-runtime 不支持 ${platform}`,
        hint: 'Linux 需要 bubblewrap + socat；macOS 用内置 sandbox-exec'
      };
    }
  } catch (e) {
    return { available: false, platform, reason: `平台检测失败：${e?.message || e}` };
  }
  // checkDependenciesAsync 会真的去查 bwrap / socat 在不在
  try {
    const dep = await mod.SandboxManager.checkDependenciesAsync?.();
    if (dep && dep.errors && dep.errors.length) {
      return {
        available: false,
        platform,
        reason: dep.errors.join('；'),
        hint: platform === 'linux'
          ? 'Debian/Ubuntu: sudo apt-get install bubblewrap socat；Fedora: sudo dnf install bubblewrap socat'
          : 'macOS 自带 sandbox-exec；缺少 socat 时 brew install socat'
      };
    }
  } catch (e) {
    return { available: false, platform, reason: `依赖检查失败：${e?.message || e}` };
  }
  return { available: true, platform, reason: null };
}

/**
 * 把一条命令包成沙箱化的 shell 字符串。
 * 注意返回的是 **shell 命令字符串**，不是 argv —— 这是这个库的契约：
 * 它把 bwrap 调用（含 mount 绑定、env、socat 中转）拼成一条命令，交给外层 shell 执行。
 *
 * @param {object} o
 * @param {string} o.command 原始命令
 * @param {string} o.cwd 工作目录（沙箱内的工作目录必须与宿主一致，否则相对路径会错位）
 * @param {object} [o.config] buildSandboxConfig 的产物
 * @param {string} [o.shellPath] 用哪个 shell 跑（Linux 必须是真 bash，不是 dash）
 * @param {string} [o.commandId] 违规事件的归属 key
 * @returns {Promise<{command:string}>}
 */
export async function wrapCommand({
  command,
  cwd,
  config,
  shellPath = '/usr/bin/bash',
  commandId = null
} = {}) {
  const mod = await import(SANDBOX_PKG);
  const { SandboxManager } = mod;
  // initialize 是幂等的：同一份配置重复调用会被内部去重；
  // 配置不同会抛 SandboxInitializeConflictError，调用方需要 reset() 后再初始化。
  await SandboxManager.initialize(config ? { ...config, cwd } : { cwd });
  const wrapped = await SandboxManager.wrapWithSandbox(
    String(command || ''),
    shellPath,
    undefined,
    undefined,
    commandId ? { commandId } : undefined
  );
  return { command: wrapped, SandboxManager };
}

/** 释放沙箱（停代理、清理挂载点）。进程退出前调用。 */
export async function releaseSandbox() {
  try {
    const mod = await import(SANDBOX_PKG);
    await mod.SandboxManager.reset?.();
  } catch { /* 未初始化或已释放 */ }
}

/** 从配置文件里取出沙箱相关设置（都在 cfg 上，缺省用安全默认值）。 */
export function linuxSandboxOptionsOf(cfg = {}) {
  const urls = [];
  for (const p of (Array.isArray(cfg?.providers) ? cfg.providers : [])) {
    if (p?.baseUrl) urls.push(p.baseUrl);
  }
  return buildSandboxConfig({
    gatewayUrls: urls,
    strictNetwork: cfg?.sandboxStrictNetwork === true,
    extraDomains: Array.isArray(cfg?.sandboxAllowDomains) ? cfg.sandboxAllowDomains : [],
    allowNetwork: cfg?.sandboxAllowNetwork !== false,
    denyRead: cfg?.sandboxDenyRead !== false,
    extraWritePaths: Array.isArray(cfg?.sandboxAllowWrite) ? cfg.sandboxAllowWrite : []
  });
}

/** 沙箱工作目录：把 cwd 规范成绝对路径（bwrap 的 bind mount 必须用绝对路径）。 */
export const sandboxCwdOf = (cwd, fallback) => path.resolve(String(cwd || fallback || '.'));
