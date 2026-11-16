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
const sysGit = spawnSync('where', ['git'], { encoding: 'utf8', shell: true });
const sysBash = spawnSync('where', ['bash'], { encoding: 'utf8', shell: true });
const hasSysGit = sysGit.status === 0 && String(sysGit.stdout || '').trim() !== '';
const hasSysBash = sysBash.status === 0 && String(sysBash.stdout || '').trim() !== '';
const isCleanMachine = !hasSysGit && !hasSysBash;
if (isCleanMachine) {
  check('系统上没有 git（干净机器）', true);
  check('系统上没有 bash（干净机器）', true);
} else {
  console.log('  SKIP  系统上没有 git/bash（本机装了，属预期；CI 上会断言）');
  console.log(`        实际 git : ${String(sysGit.stdout || '').trim().split('\n')[0]}`);
  console.log(`        实际 bash: ${String(sysBash.stdout || '').trim().split('\n')[0]}`);
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

// 干净机器上才成立：根目录映射到内置包
const rootLine = (out.split('\n').find((l) => l.startsWith('ROOT=')) || '').replace('ROOT=', '').trim();
if (rootLine.toLowerCase().includes('gitbash-full')) {
  check('root: 根目录映射到内置包（干净机器）', true);
} else {
  console.log(`  SKIP  root: 当前是 ${rootLine}（本机装了 Git，mount 表来自系统；CI 上会断言）`);
}

// 完整 Git 的额外能力：git 命令本身可用（裁剪版没有这个）
console.log('\n=== git 本体（完整版才有）===');
const gitVer = spawnSync(gitExe, ['--version'], { encoding: 'utf8', env, timeout: 30000 });
console.log('  ' + String(gitVer.stdout || gitVer.stderr || '').trim().split('\n')[0]);
check('git --version 可用', gitVer.status === 0 && /git version/i.test(String(gitVer.stdout || '')));
console.log(`\n=== 结果：${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
