// 验证「安装包内置完整 Git for Windows」在没有 Git 的机器上真的能用。
// 在本地跑会被已装的 Git 干扰（MSYS 读注册表拿 prefix），所以主要跑在 CI：
// .github/workflows/verify-gitbash.yml 会先删注册表项、再从 PATH 剔除 Git。
//
// 与裁剪版的关键区别：完整 Git 自带全部依赖，不需要逐版本重算 DLL 闭包；
// 而且**能直接用 git 命令**（裁剪版只有 bash，没有 git.exe）。
//
// 2026-11-16 追加：这里必须**通过 resolveShell 解析**，不能直接拼绝对路径。
// 0.19.0 就带着一个 bug 出了包——resolver 拼出 resources\resources\gitbash-full，
// 干净机器上永远找不到内置 bash，回落 cmd。因为本脚本当时直接 spawn 绝对路径，
// 从没走过 resolver，所以 CI 全绿也没抓到。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveShell, shellSpawnSpec } from '../src/main/shell-resolver.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z])/, '$1')), '..', '..');
const gitRoot = path.join(repoRoot, 'desktop', 'resources', 'gitbash-full');
const bashExe = path.join(gitRoot, 'bin', 'bash.exe');
const usrBash = path.join(gitRoot, 'usr', 'bin', 'bash.exe');
const gitExe = path.join(gitRoot, 'cmd', 'git.exe');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('=== 环境 ===');
console.log('gitRoot  :', gitRoot);
console.log('bashExe  :', bashExe);

console.log('\n=== 前置：这台机器真的干净吗（没有系统 Git/bash）===');
// `where bash` 会把 Windows 自带的 WSL bash（C:\Windows\System32\bash.exe）算进来，
// 那不是 Git Bash、也不会被我们用到（脚本用的是内置 bash 的绝对路径）。
// 2026-11-16 修：原来把它当成「不干净」，导致这条前置断言在 CI 上永远走 SKIP 分支、
// 从来没真正断言过。改成只认 Git 提供的 bash。
const whereAll = (name) => {
  const r = spawnSync('where', [name], { encoding: 'utf8', shell: true });
  if (r.status !== 0) return [];
  return String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
};
const sysGit = whereAll('git');
const sysBash = whereAll('bash');
const gitBashPaths = sysBash.filter((p) => /\\Git\\|\/Git\//i.test(p));
const wslBashPaths = sysBash.filter((p) => /system32\\bash|System32\\bash/i.test(p));

// 「干净」= 没有系统 git，且没有 Git 提供的 bash（WSL bash 不算）
const isCleanMachine = sysGit.length === 0 && gitBashPaths.length === 0;
if (isCleanMachine) {
  check('系统上没有 git（干净机器）', true);
  check('系统上没有 Git 提供的 bash（干净机器）', true, '');
  if (wslBashPaths.length) console.log(`  note: 有 WSL bash（${wslBashPaths[0]}），与 Git Bash 无关，不算不干净`);
} else {
  // 本机装了 Git 属于预期（我们先测用户已装那一档），相关断言降级为 SKIP；
  // 但必须打印出到底是哪个路径，避免「静默跳过」。
  console.log('  SKIP  这台机器装了系统 Git，相关断言降级（CI 上会真断言）');
  console.log(`        系统 git : ${sysGit[0] || '(none)'}`);
  console.log(`        系统 bash: ${gitBashPaths[0] || '(no Git bash)'}`);
}

console.log('\n=== 内置包结构 ===');
check('ps: bin/bash.exe 存在', fs.existsSync(bashExe));
check('ps: usr/bin/bash.exe 存在（真实二进制）', fs.existsSync(usrBash));
check('ps: cmd/git.exe 存在', fs.existsSync(gitExe));
// 原生侧目录名随发行变体而变（官方 x64 = mingw64，GitHub runner = ucrt64）
const NATIVE = ['mingw64', 'ucrt64', 'clang64', 'mingw32']
  .map((n) => path.join(gitRoot, n, 'bin', 'git.exe'))
  .find((p) => fs.existsSync(p));
check('ps: 原生 git.exe 存在（mingw64/ucrt64/clang64 之一）', !!NATIVE, NATIVE || '都没找到');
check('ps: usr/bin/cat.exe 存在', fs.existsSync(path.join(gitRoot, 'usr', 'bin', 'cat.exe')));
check('ps: usr/bin/msys-2.0.dll 存在', fs.existsSync(path.join(gitRoot, 'usr', 'bin', 'msys-2.0.dll')));
check('ps: etc/fstab 存在', fs.existsSync(path.join(gitRoot, 'etc', 'fstab')));

if (!fs.existsSync(bashExe)) {
  console.log(`\n=== 结果：${pass} pass / ${fail + 1} fail（内置 bash 缺失，后续跳过）===`);
  process.exit(1);
}

// PATH：Windows 格式、内置 usr/bin + mingw64/bin 前置、剔除所有系统 Git 目录
const stripGit = (p) => String(p || '').split(';')
  .filter((seg) => seg && !/\\Git\\|\/Git\//i.test(seg))
  .join(';');
const env = {
  ...process.env,
  PATH: [
    path.join(gitRoot, 'usr', 'bin'),
    (NATIVE ? path.dirname(NATIVE) : path.join(gitRoot, 'mingw64', 'bin')),
    stripGit(process.env.PATH)
  ].filter(Boolean).join(';'),
  MSYSTEM: 'MINGW64',
  MSYS2_ARG_CONV_EXCL: '*',
  HOME: os.homedir(),
};

// === 关键回归：必须通过 resolveShell 解析，而不是自己拼绝对路径 ===
// 0.19.0 的 bug 在这：resolver 拼出 resources\resources\gitbash-full → 干净机器回落 cmd。
// 传 appRoot = gitRoot 的「resources 目录」（这是打包后 process.resourcesPath 的真实语义）。
console.log('\n=== resolveShell 解析（干净机器必须命中 bundled）===');
const resourcesDir = path.dirname(gitRoot);   // .../resources
// 屏蔽「用户已装 Git」这一档，模拟干净机器
const cleanExists = (p) => {
  const s = String(p);
  if (/Program Files[\\/]Git/i.test(s)) return false;
  try { return fs.existsSync(s); } catch { return false; }
};
const resolved = resolveShell({ platform: 'win32', appRoot: resourcesDir, exists: cleanExists });
check('resolveShell: 干净机器上解析到内置 bash（不是回落 cmd）', resolved.origin === 'bundled',
  `origin=${resolved.origin} file=${resolved.file}`);
check('resolveShell: 解析出的路径没有重复的 resources 段',
  !String(resolved.file).includes(path.join('resources', 'resources')),
  resolved.file);
check('resolveShell: 解析出的文件真实存在', fs.existsSync(String(resolved.file || '')), resolved.file);
check('resolveShell: 用 -c 不加载 profile（避免空闲看门狗误判）',
  Array.isArray(resolved.args('ls')) && resolved.args('ls')[0] === '-c');

const tmp = os.tmpdir();
const script = [
  'echo "BASH_VERSION=$BASH_VERSION"',
  'echo "ROOT=$(cd / && pwd -W 2>/dev/null || pwd)"',
  'echo "CAT_PATH=$(command -v cat)"',
  'echo "GIT_PATH=$(command -v git)"',
  'cat --version | head -1',
  'grep --version | head -1',
  'sed --version | head -1',
  'awk --version 2>&1 | head -1',
  `printf "alpha\\nbeta\\ngamma\\n" > "${tmp}/fc-probe-$$.txt"`,
  `wc -l "${tmp}/fc-probe-$$.txt"`,
  `grep -n "beta" "${tmp}/fc-probe-$$.txt"`,
  `sed "s/beta/BETA/" "${tmp}/fc-probe-$$.txt"`,
  `tr "a-z" "A-Z" < "${tmp}/fc-probe-$$.txt"`,
  `awk '{print NR": "$0}' "${tmp}/fc-probe-$$.txt"`,
  `rm -f "${tmp}/fc-probe-$$.txt"`,
  'echo TOOLS-END',
].join('\n').replace(/\\\$\$/g, '$$');

// 用 shellSpawnSpec 的产物来跑后续所有工具断言：这样测的就是 AI 真正拿到的那份 spec
const spec = shellSpawnSpec(script, {
  platform: 'win32',
  appRoot: resourcesDir,
  exists: cleanExists,
  env: { ...env, PATH: env.PATH },
  cwd: null
});
console.log('  spec.file =', spec.file);
console.log('  spec.origin =', spec.origin);
check('shellSpawnSpec: origin 是 bundled', spec.origin === 'bundled');

console.log('\n=== 内置 bash 执行（核心工具 + 真实读写）===');
const r = spawnSync(spec.file, spec.args, { encoding: 'utf8', env: spec.options.env, timeout: 60000 });
console.log('exit  :', r.status);
console.log('stdout:\n' + (r.stdout || '').trim());
if (r.stderr) console.log('stderr:\n' + (r.stderr || '').trim());

const out = r.stdout || '';
const errOut = String(r.stderr || '') + out;
console.log('\n=== bash / coreutils 断言 ===');
check('boot: bash 起来了', /BASH_VERSION=/.test(out));
check('boot: 无 command not found', !/command not found/.test(errOut));
check('cat 可用', /coreutils|GNU cat|cat \(/i.test(out));
check('grep 可用', /grep/i.test(out));
check('sed 可用', /sed/i.test(out));
check('awk 可用', /GNU Awk|gawk/i.test(out));
check('wc 输出 3', /\b3\b/.test(out));
check('grep -n 命中并带行号', /2:beta/.test(out));
check('sed 替换生效', /BETA/.test(out));
check('tr 转大写', /ALPHA[\r\n]+BETA[\r\n]+GAMMA/.test(out));
check('awk 行号输出', /1: alpha|1:alpha/.test(out));
check('脚本跑到底', /TOOLS-END/.test(out));
check('进程正常退出', r.status === 0, `exit=${r.status}`);

// 干净机器上才成立：根目录映射到内置包。
// 这条是「没被系统 Git 劫持」最硬的证据：MSYS 读注册表 HKLM\SOFTWARE\GitForWindows
// 决定 prefix；若劫持成立，ROOT 会指向 C:\Program Files\Git 而不是内置包。
const rootLine = (out.split('\n').find((l) => l.startsWith('ROOT=')) || '').replace('ROOT=', '').trim();
if (isCleanMachine) {
  check('root: 根目录映射到内置包（干净机器，未被系统 Git 劫持）',
    rootLine.toLowerCase().includes('gitbash-full'), `ROOT=${rootLine}`);
} else {
  console.log(`  SKIP  root: 当前是 ${rootLine}（本机装了 Git，mount 表来自系统；CI 上会断言）`);
}

// PATH 里的 git 必须解析到内置包的原生目录（ucrt64/mingw64），不能是系统 Git。
// 这是「零依赖」的另一半证据：bash 里的 git 命令真的来自我们的包。
const gitPathLine = (out.split('\n').find((l) => l.startsWith('GIT_PATH=')) || '').replace('GIT_PATH=', '').trim();
if (isCleanMachine) {
  const nativeDirRe = /\/(ucrt64|mingw64|clang64|mingw32)\//i;
  check('path: 内置 PATH 里的 git 来自包内原生目录', nativeDirRe.test(gitPathLine),
    `GIT_PATH=${gitPathLine}`);
} else {
  console.log(`  SKIP  path: 当前 GIT_PATH=${gitPathLine}（本机装了 Git，CI 上会断言）`);
}

// 完整 Git 的额外能力：git 命令本身可用（裁剪版没有这个）。
// 这里用 spec.options.env 跑，即与前面 bash 完全相同的环境（含内置 PATH），
// 但入口仍必须是内置包里的 git.exe。
console.log('\n=== git 本体（完整版才有）===');
const gitVer = spawnSync(gitExe, ['--version'], { encoding: 'utf8', env: spec.options.env, timeout: 30000 });
console.log('  ' + String(gitVer.stdout || gitVer.stderr || '').trim().split('\n')[0]);
check('git --version 可用', gitVer.status === 0 && /git version/i.test(String(gitVer.stdout || '')));

// 同一份 env 里，让 bash 自己解析 git（走 PATH，不走绝对路径）——这才是 AI 真正的用法
const gitViaPath = spawnSync(spec.file, ['-c', 'git --version'], { encoding: 'utf8', env: spec.options.env, timeout: 30000 });
console.log('  bash -c "git --version" → ' + String(gitViaPath.stdout || gitViaPath.stderr || '').trim().split('\n')[0]);
check('git 在 bash 里走 PATH 可用（AI 真实用法，不是绝对路径）',
  gitViaPath.status === 0 && /git version/i.test(String(gitViaPath.stdout || '')));
check('git 走 PATH 时也来自包内（不回落系统 Git）',
  isCleanMachine ? !/Program Files[\\/]Git/i.test(String(gitViaPath.stdout)) : true);

console.log(`\n=== 结果：${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
