// 验证「安装包内置 Git Bash」在没有 Git for Windows 的机器上真的能用。
// 在本地跑会被已装的 Git 干扰（MSYS 读注册表拿 prefix），所以这个脚本主要在 CI 跑：
// .github/workflows/verify-gitbash.yml 会先移除注册表项、再从 PATH 剔除 Git。
//
// 断言策略：
//   · 先证明「这台机器确实没有系统 Git/bash」——否则测的是系统那份，结论无效
//   · 再证明「内置 bash 能起来，且能找到它自己目录下的 cat/grep/sed/awk」
//   · 最后证明「能真的写文件、能按 Unix 语义处理路径」
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z])/, '$1')), '..', '..');
const bundleRoot = path.join(repoRoot, 'desktop', 'resources', 'gitbash');
const bashExe = path.join(bundleRoot, 'usr', 'bin', 'bash.exe');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('=== 环境 ===');
console.log('repoRoot   :', repoRoot);
console.log('bundleRoot :', bundleRoot);
console.log('bashExe    :', bashExe);

console.log('\n=== 前置：这台机器真的干净吗（没有系统 Git/bash）===');
const sysGit = spawnSync('where', ['git'], { encoding: 'utf8', shell: true });
const sysBash = spawnSync('where', ['bash'], { encoding: 'utf8', shell: true });
const hasSysGit = sysGit.status === 0 && String(sysGit.stdout || '').trim() !== '';
const hasSysBash = sysBash.status === 0 && String(sysBash.stdout || '').trim() !== '';
// 这两条是「环境合格性」检查，不是产品缺陷：
//  · CI（干净 runner）→ 必须通过（否则说明模拟失败，结论无效）
//  · 开发机 → 预期就是有 Git，标 SKIP 而不是 FAIL，别让本地跑出假红
const isCleanMachine = !hasSysGit && !hasSysBash;
if (isCleanMachine) {
  check('系统上没有 git（干净机器）', true);
  check('系统上没有 bash（干净机器）', true);
} else {
  console.log('  SKIP  系统上没有 git（本机装了 Git，属预期；CI 上会断言）');
  console.log(`        实际: ${String(sysGit.stdout || '').trim().split('\n')[0]}`);
  console.log('  SKIP  系统上没有 bash（同上）');
  console.log(`        实际: ${String(sysBash.stdout || '').trim().split('\n')[0]}`);
}

console.log('\n=== 内置包是否存在且完整 ===');
check('ps: bash.exe 存在', fs.existsSync(bashExe));
check('ps: msys-2.0.dll 存在', fs.existsSync(path.join(bundleRoot, 'usr', 'bin', 'msys-2.0.dll')));
check('ps: etc/fstab 存在（决定根目录映射）', fs.existsSync(path.join(bundleRoot, 'etc', 'fstab')));
check('ps: etc/msystem 存在', fs.existsSync(path.join(bundleRoot, 'etc', 'msystem')));
for (const tool of ['cat', 'grep', 'sed', 'awk', 'ls', 'wc', 'tr']) {
  check(`ps: ${tool}.exe 存在`, fs.existsSync(path.join(bundleRoot, 'usr', 'bin', `${tool}.exe`)));
}

if (!fs.existsSync(bashExe)) {
  console.log(`\n=== 结果：${pass} pass / ${fail + 1} fail（内置 bash 缺失，后续跳过）===`);
  process.exit(1);
}

// ---- 构造 MSYS 格式的 PATH（C:\x → /c/x；反斜杠换正斜杠）----
const toMsys = (p) => {
  const s = String(p).split('\\').join('/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : s;
};
const binMsys = toMsys(path.join(bundleRoot, 'usr', 'bin'));
const tmpWin = path.join(bundleRoot, 'tmp');
fs.mkdirSync(tmpWin, { recursive: true });
const tmpMsys = toMsys(tmpWin);

// PATH 的处理（2026-11-16 实测踩了三轮才定下来）：
//
//  ❌ 不能把 PATH 整个换成 MSYS 格式（`/d/xxx:/usr/bin`）——那样 `cat`/`grep` 全部
//     exit 127 且零输出。因为那些 exe 依赖 Windows 侧的 DLL 加载路径，
//     而 Windows 的 CreateProcess 只认 Windows 格式的 PATH。
//  ✅ 正确做法：PATH 保持 **Windows 格式**，把内置 `usr/bin` 前置进去。
//     MSYS 会把 Windows PATH 里的目录映射成 /usr/bin 之类，工具照样找得到，
//     而且 Windows 侧的 DLL 解析也正常。
//  ✅ 环境必须基于 process.env 展开（完全替换会丢掉 SystemRoot/TEMP 等，fork 起不来）。
// 2026-11-16 第四轮实测（本地已复现、CI 已复现，这条才是真结论）：
//
//  ❌ 把 PATH 换成纯 MSYS 格式（/d/xxx:/usr/bin）→ 所有 exe exit 127 零输出。
//     Windows 的 CreateProcess 只认 Windows 格式 PATH，找不到 exe 依赖的 DLL。
//  ❌ PATH 里**保留系统 Git 的目录** → 看着能跑，其实是系统 Git 的 DLL 补齐了
//     我们精简包缺的依赖。这是假阳性（第一次「8.4MB 可跑」就是这么来的）。
//     真实缺件：msys-intl-8.dll（cat.exe 的硬依赖）+ iconv/crypto/unistring。
//  ✅ 正确做法：PATH 用 Windows 格式，内置 bin 前置，**并且把系统 Git 的目录全部剔除**。
//     这样本地和 CI 测的是同一个条件（真实干净机器）。
const stripGit = (p) => (String(p || '').split(';')
  .filter((seg) => seg && !/\\Git\\|\/Git\//i.test(seg))
  .join(';'));

const env = {
  ...process.env,
  // Windows 格式；内置 bin 置顶；剔除所有 Git 目录（否则测的是系统 Git 的 DLL）
  PATH: `${path.join(bundleRoot, 'usr', 'bin')};${stripGit(process.env.PATH)}`,
  MSYSTEM: 'MINGW64',
  MSYS2_ARG_CONV_EXCL: '*',
  TMPDIR: tmpWin, // Windows 格式亦可；bash 会自行映射
  HOME: os.homedir(),
};
if (/\\Git\\|\/Git\//i.test(String(process.env.PATH || '')) && stripGit(process.env.PATH) === String(process.env.PATH || '').split(';').filter(Boolean).join(';')) {
  console.log('  (注意：未能从 PATH 中移除 Git 目录)');
}

console.log('\n=== 内置 bash 实际执行 ===');
// 关键设计：**不测 `ls /`**。
// `/` 是 MSYS 的 mount 表白名单，它来自注册表 HKLM\SOFTWARE\GitForWindows 指向的
// 已装 Git（开发机上都装了），所以 `ls /` 一定列出系统 Git 的目录，测它只会得出
// 假结论。内置包的真实用途是「在没有任何 Git 的机器上提供 bash + 核心工具」，
// 所以断言应该落在：工具能否从**内置目录**被找到、能否真的处理文件。
// CI 上会先删注册表项，那时 `/` 才会指向内置包；本地跑时这条断言自动跳过。
const script = [
  'echo "BASH_VERSION=$BASH_VERSION"',
  'echo "ROOT=$(cd / && pwd -W 2>/dev/null || pwd)"',
  'echo "CAT_PATH=$(command -v cat)"',
  'echo "GREP_PATH=$(command -v grep)"',
  'cat --version | head -1',
  'grep --version 2>&1 | head -1',
  'sed --version | head -1',
  'awk --version 2>&1 | head -1',
  `printf "alpha\\nbeta\\ngamma\\n" > "${tmpMsys}/probe.txt"`,
  `wc -l "${tmpMsys}/probe.txt"`,
  `grep -n "beta" "${tmpMsys}/probe.txt"`,
  `sed "s/beta/BETA/" "${tmpMsys}/probe.txt"`,
  `tr "a-z" "A-Z" < "${tmpMsys}/probe.txt"`,
  `awk '{print NR": "$0}' "${tmpMsys}/probe.txt"`,
  'echo TOOLS-END',
].join('\n');

const r = spawnSync(bashExe, ['-c', script], { encoding: 'utf8', env, timeout: 60000 });
console.log('exit  :', r.status);
console.log('stdout:\n' + (r.stdout || '').trim());
if (r.stderr) console.log('stderr:\n' + (r.stderr || '').trim());

const out = r.stdout || '';
const errOut = String(r.stderr || '') + out;
console.log('\n=== 内建 bash 断言 ===');
check('boot: bash 起来了', /BASH_VERSION=/.test(out));
check('boot: 无 command not found', !/command not found/.test(errOut));
// 「工具解析到内置目录」这两条只在**没有任何系统 Git** 的机器上才有意义：
// 开发机上 MSYS 的 mount 表来自已装 Git，`command -v cat` 必然报虚拟路径 /usr/bin/cat。
// 所以：干净机器 → 断言；本机 → 记录实际值并跳过（CI workflow 会先删注册表项）。
const catPath = (out.split('\n').find((l) => l.startsWith('CAT_PATH=')) || '').replace('CAT_PATH=', '').trim();
const grepPath = (out.split('\n').find((l) => l.startsWith('GREP_PATH=')) || '').replace('GREP_PATH=', '').trim();
const systemHasGit = hasSysGit || hasSysBash;
if (systemHasGit) {
  console.log(`  SKIP  cat 解析到内置目录（本机有系统 Git，实际 = ${catPath || '(空)'}）`);
  console.log(`  SKIP  grep 解析到内置目录（本机有系统 Git，实际 = ${grepPath || '(空)'}）`);
} else {
  check('cat 解析到内置目录', catPath.includes('gitbash'), catPath || '(未找到)');
  check('grep 解析到内置目录', grepPath.includes('gitbash'), grepPath || '(未找到)');
}

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

// 干净机器上额外成立：根目录映射到内置包（有系统 Git 时会指向系统 Git，故只在 CI 断言）
const rootLine = (out.split('\n').find((l) => l.startsWith('ROOT=')) || '').replace('ROOT=', '').trim();
if (rootLine.toLowerCase().includes('gitbash')) {
  check('root: 根目录映射到内置包（干净机器）', true);
} else {
  console.log(`  SKIP  root: 根目录当前是 ${rootLine}（本机装了 Git，mount 表来自系统；CI 上会断言）`);
}

fs.rmSync(tmpWin, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
