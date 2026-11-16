// 验证「安装包内置完整 Git for Windows」在没有 Git 的机器上真的能用。
// 在本地跑会被已装的 Git 干扰（MSYS 读注册表拿 prefix），所以主要跑在 CI：
// .github/workflows/verify-gitbash.yml 会先删注册表项、再从 PATH 剔除 Git。
//
// 与裁剪版的关键区别：完整 Git 自带全部依赖，不需要逐版本重算 DLL 闭包；
// 而且**能直接用 git 命令**（裁剪版只有 bash，没有 git.exe）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

console.log('\n=== 内置 bash 执行（核心工具 + 真实读写）===');
const tmp = os.tmpdir();
const script = [
  'echo "BASH_VERSION=$BASH_VERSION"',
  'echo "ROOT=$(cd / && pwd -W 2>/dev/null || pwd)"',
  'echo "CAT_PATH=$(command -v cat)"',
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

const r = spawnSync(bashExe, ['-c', script], { encoding: 'utf8', env, timeout: 60000 });
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
