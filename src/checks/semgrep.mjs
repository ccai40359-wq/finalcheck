// Semgrep 接入（2026-11-18）：用 FC 自研规则包（src/semgrep-rules/*.yml）补 Go / Java / PHP 的
// 注入类检测（SQL/命令/代码注入、路径穿越、文件包含、SSRF、开放重定向、XSS、反序列化、XXE）与弱密码哈希。
//
// 只用 Semgrep CE 引擎（LGPL），不用 Registry 规则（其规则许可限制竞品使用）——规则全部自写。
// JS/TS 与 Python 已有 FC 自研规则 + Bandit，这里不重复扫。
// CE 的污点分析只在单个函数内传播：跨函数/跨文件传递的输入不在覆盖范围（报告里如实声明）。
//
// 可选增强，口径与 Trivy 一致：没装/失败只记 warning，原有语言缺口照旧（fail-closed 不变）；
// 真跑成功才按「实际扫过的语言」解除 S2 的语言缺口。
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../run-async.mjs';
import { listTextFiles } from '../walk.mjs';

const RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'semgrep-rules');
// 扩展名 → 规则包。只有仓库里真有这些文件才跑对应规则包
const LANG_RULES = { '.go': 'go.yml', '.java': 'java.yml', '.php': 'php.yml' };
export const SEMGREP_EXTS = new Set(Object.keys(LANG_RULES));
const SEV = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };
// Windows 命令行上限 32767 字符：文件清单分批传（显式文件清单绕开 Semgrep 默认忽略规则——
// 它会按绝对路径里的 tests/ 等目录名整仓跳过，实测项目放在 …/tests/… 下时 0 文件被扫）
const MAX_ARGS_CHARS = 20000;

function candidates() {
  const out = [];
  if (process.env.FINALCHECK_SEMGREP && !/^(off|on)$/i.test(process.env.FINALCHECK_SEMGREP)) out.push(process.env.FINALCHECK_SEMGREP);
  out.push('semgrep');
  const exe = process.platform === 'win32' ? 'semgrep.exe' : 'semgrep';
  const home = os.homedir();
  // pip 装的 semgrep 常不在 GUI 进程的 PATH 里（Electron 从开始菜单启动时没有 conda/用户 Scripts 目录）
  for (const d of ['anaconda3', 'miniconda3', 'Anaconda3', 'Miniconda3']) out.push(path.join(home, d, 'Scripts', exe));
  const pyRoots = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Python'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
  ].filter(Boolean);
  for (const root of pyRoots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) if (/^Python3\d+$/i.test(d)) out.push(path.join(root, d, 'Scripts', exe));
  }
  out.push(path.join(home, '.local', 'bin', 'semgrep'), '/opt/homebrew/bin/semgrep', '/usr/local/bin/semgrep');
  return out;
}

let cached;
/** 找 semgrep：FINALCHECK_SEMGREP（路径）→ PATH → 常见 pip 安装目录。找不到返回 null。 */
export async function resolveSemgrep() {
  if (cached !== undefined) return cached;
  for (const cmd of candidates()) {
    if (cmd !== 'semgrep' && !existsSync(cmd)) continue;
    const r = await runProcess(cmd, ['--version'], { timeoutMs: 60000, env: semgrepEnv() }).catch(() => null);
    const v = r && r.status === 0 ? /(\d+\.\d+\.\d+)/.exec(String(r.stdout)) : null;
    if (v) { cached = { cmd, version: v[1] }; return cached; }
  }
  cached = null;
  return null;
}

// 中文 Windows 默认 GBK：不强制 UTF-8 时 Semgrep 读规则/源码直接 UnicodeDecodeError（实测）
function semgrepEnv() {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0' };
}

/**
 * Semgrep JSON → FC findings。纯函数（测试直接喂 JSON）。
 * @param {object} json Semgrep --json 输出
 * @param {(file:string, line:number) => string} lineText 取源码行（判断 finalcheck:allow、做 snippet）
 */
export function mapSemgrepResults(json, lineText = () => '') {
  const findings = [];
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    const meta = r.extra?.metadata || {};
    const checkId = /^S\d$/.test(String(meta.fc_check || '')) ? meta.fc_check : 'S2';
    const ruleId = String(r.check_id || '').split('.').pop();
    const file = String(r.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const line = Number(r.start?.line) || 0;
    const text = lineText(file, line);
    if (/finalcheck:allow/.test(text)) continue;
    findings.push({
      checkId,
      severity: SEV[String(r.extra?.severity || '').toUpperCase()] || 'medium',
      force: 'card',
      file, line,
      rule: `${checkId}.sg-${ruleId}`,
      snippet: String(text || '').trim().slice(0, 120),
      message: String(r.extra?.message || ruleId).slice(0, 300),
      source: 'program',
    });
  }
  // 同一条规则在同一行只留一条（一个 sink 的多个污点参数会各报一次）
  const seen = new Set();
  return findings.filter((f) => { const k = `${f.rule}|${f.file}|${f.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function chunk(files) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const f of files) {
    if (cur.length && len + f.length + 3 > MAX_ARGS_CHARS) { out.push(cur); cur = []; len = 0; }
    cur.push(f);
    len += f.length + 3;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 跑 FC 自研规则包。
 * @returns {Promise<{ran:boolean, findings:Array, coveredExts:Set<string>, warnings:string[], version?:string, scannedFiles?:number}>}
 */
export async function runSemgrep(projectDir, { excludes = [], includeFixtures = false, tooling = null, runner = null, timeoutMs = 600000 } = {}) {
  const empty = { ran: false, findings: [], coveredExts: new Set(), warnings: [] };
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures });
  const rel = files
    .map((f) => path.relative(projectDir, f).replace(/\\/g, '/'))
    .filter((f) => SEMGREP_EXTS.has(path.extname(f).toLowerCase()));
  if (!rel.length) return empty; // 没有 Go/Java/PHP 源码：无事可做，也不算缺口
  const exts = [...new Set(rel.map((f) => path.extname(f).toLowerCase()))].sort();
  const label = exts.map((e) => e.slice(1)).join('/');
  if (!runner && String(process.env.FINALCHECK_SEMGREP || '').toLowerCase() === 'off') {
    empty.warnings.push(`Semgrep 已关闭（FINALCHECK_SEMGREP=off）：${label} 源码的注入类检测本轮未执行`);
    return empty;
  }
  const tool = runner ? { cmd: 'semgrep', version: 'injected' } : (tooling || await resolveSemgrep());
  if (!tool) {
    empty.warnings.push(`Semgrep 未安装：${label} 源码（${rel.length} 个文件）的注入类检测未执行（安装：pip install semgrep）`);
    return empty;
  }
  const configs = exts.flatMap((e) => ['--config', path.join(RULES_DIR, LANG_RULES[e])]);
  const base = ['scan', '--json', '--quiet', '--metrics=off', '--disable-version-check', '--no-git-ignore', ...configs];
  const results = [];
  const errors = [];
  for (const part of chunk(rel)) {
    const args = [...base, ...part];
    let run;
    try {
      run = runner ? await runner(projectDir, args) : await runProcess(tool.cmd, args, { cwd: projectDir, timeoutMs, env: semgrepEnv(), maxOut: 64 * 1024 * 1024 });
    } catch (e) { run = { status: null, error: e }; }
    // 退出码：0 = 无发现，1 = 有发现（老版本 --error 时），其余为错误
    const out = String(run?.stdout || '').trim();
    if (!run || (run.status !== 0 && run.status !== 1) || !out.startsWith('{')) {
      const why = run?.status === 124 || run?.timedOut ? '超时' : String(run?.error?.message || run?.stderr || '无输出').trim().split('\n').pop().slice(0, 160);
      empty.warnings.push(`Semgrep 运行失败（${why}）：${label} 源码的注入类检测本轮未执行`);
      return empty;
    }
    let json;
    try { json = JSON.parse(out); } catch (e) {
      empty.warnings.push(`Semgrep 输出无法解析（${e.message}）：本轮结果不采用`);
      return empty;
    }
    // 规则本身解析失败 = 引擎/规则不兼容：结果不可信，整体按没跑算
    const ruleErr = (json.errors || []).find((e) => /rule|config/i.test(String(e.type || '')) || /Rule parse error/i.test(String(e.message || '')));
    if (ruleErr) {
      empty.warnings.push(`Semgrep 规则加载失败（${String(ruleErr.message || ruleErr.type).split('\n')[0].slice(0, 160)}）：${label} 注入类检测本轮未执行`);
      return empty;
    }
    results.push(...(json.results || []));
    errors.push(...(json.errors || []));
  }
  const cache = new Map();
  for (const f of new Set(results.map((r) => String(r.path || '').replace(/\\/g, '/')))) {
    const text = await readFile(path.join(projectDir, f), 'utf8').catch(() => '');
    cache.set(f.replace(/^\.\//, ''), text.split(/\r?\n/));
  }
  const findings = mapSemgrepResults({ results }, (file, line) => (cache.get(file) || [])[line - 1] || '');
  const warnings = [`Semgrep ${tool.version}（FC 自研规则，${label}）：扫描 ${rel.length} 个文件，发现 ${findings.length} 条；污点分析限单个函数内`];
  // 个别文件解析失败：其余照常采用，但要点名（不能让读者以为全扫到了）
  const parseFails = [...new Set(errors.filter((e) => /Syntax|Parse|Lexical/i.test(String(e.type || ''))).map((e) => String(e.path || e.spans?.[0]?.file || '?')))];
  if (parseFails.length) warnings.push(`Semgrep：${parseFails.length} 个文件解析失败未覆盖（${parseFails.slice(0, 3).join('、')}${parseFails.length > 3 ? '…' : ''}）`);
  return { ran: true, findings, coveredExts: new Set(exts), warnings, version: tool.version, scannedFiles: rel.length };
}
