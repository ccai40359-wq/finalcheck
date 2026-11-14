// A1-A4：AI Agent 检查面（P0 主打差异，2026-11-14 定案）。
// 对象是被审项目里「AI agent 相关代码/配置」的四个风险面；纯静态形状判定：
// 不运行被审项目、不发 LLM 请求、不评估消毒质量（只认「无隔离动作的耦合形状」）。
//   A1 tool 权限过宽：入库配置/代码把执行权开到不受限（通配、解释器前缀、bypass 开关）
//   A2 提示注入面：外部内容未隔离直接拼进 LLM prompt 字段
//   A3 沙箱/逃逸面：shell 解释器执行模型生成的命令串；spawn/exec 无限额
//   A4 数据边界：密钥/env 拼进 prompt；完整对话写持久日志
// fail-closed：零痕迹 → not-applicable（三信号都查过才敢说）；有依赖采不到 → unavailable。
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, readRel } from '../walk.mjs';
import { isNonProductPath } from '../scope-policy.mjs';
import { stripComments } from './inject.mjs';

// ── 信号与模式 ────────────────────────────────────────────────────────────

// LLM SDK 依赖（精确名/@scope 前缀）：只做「有 AI 痕迹」的信号，不追版本兼容。
const LLM_SDK_EXACT = new Set(['openai', 'anthropic', 'ai', 'cohere', 'ollama', 'langchain', 'groq-sdk', 'mistral', 'google-genai']);
const LLM_SDK_SCOPE_RE = /^@(?:anthropic-ai|google|langchain|mistralai|ai-sdk|huggingface)\/[\w.-]+$/;

// 已知 agent 配置文件（A1 证据白名单；不猜任意 JSON 里的 permissions 字段）。
const AGENT_CONFIG_RES = [
  { re: /^\.claude\/settings(?:\.[\w.-]+)?\.json$/i, kind: 'claude-settings' },
  { re: /^(?:\.mcp|mcp)\.json$/i, kind: 'mcp' },
  { re: /^\.cursor\/mcp\.json$/i, kind: 'mcp' },
  { re: /^\.codex\/config\.toml$/i, kind: 'codex' },
  { re: /^\.claude\/agents\/[^/]+\.md$/i, kind: 'claude-agent' },
];

// 「前缀覆盖任意参数」的解释器形状（A1 card 依据）：node -e / python -c / sh -c / cmd /c / powershell -Command …
const INTERPRETER_RE = /(?:^|[\s'"(,])(?:(?:\/bin\/)?(?:ba|z)?sh|cmd(?:\.exe)?|powershell|pwsh)\s+[-/]?(?:c\b|Command\b)|(?:^|[\s'"(,])(?:node|python3?|perl|ruby|deno|bun)\s+(?:--eval\b|-[ec]\b|-Command\b)|-Command\s/i;
// 通配授权：单独 `*` 或 `Bash(*)` / `mcp__x__y(*)` 这类「任意参数」。
const WILDCARD_ALLOW_RE = /^(?:\*|\w[\w:-]*\(\s*\*\s*\))$/;
// 单条高危但非任意命令：只降 check。
const RISKY_CMD_RE = /git\s+push\s+(?:--force|-f\b)|docker\s+run|rm\s+-rf|kubectl\s+delete|curl\s|wget\s/i;
// bypass 类开关（A1 check 级）。
const BYPASS_FLAG_RE = /--(?:yolo\b|dangerously-bypass[\w-]*|dangerously-skip-permissions)/;
const BYPASS_MODE_RE = /["']?defaultMode["']?\s*:\s*["']bypassPermissions["']/;

const LLM_CALL_RE = /\b(?:chat\.completions\.create|completions\.create|messages\.create|responses\.create|generateContent|generate_content|embeddings\.create)\b|messages\s*:\s*\[|\.messages\s*=\s*\[/;
const PROMPT_FIELD_RE = /\b(?:content|system|prompt|input|messages)\s*[:=]\s*[`'"]?\s*[`'"]?/;
const ASSIGN_EXTERNAL_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[^\n]*?(?:\bfetch\s*\(|axios(?:\.\w+)*\s*\(|https?\.get\s*\(|readFile(?:Sync)?\s*\(|\.(?:text|json)\s*\(\))/;
// SDK 调用赋值必须有「调用动词」（create/generate）：`messages.map(` 这类普通方法链不算
// （round6 langchainjs 实测：无动词版本把 chat-model 正常 payload 组装全线误报成 A2 card）。
const SDK_CALL_ASSIGN_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w$.]*?(?:chat\.completions|completions|responses|messages)\b[\w.]*?(?:create|generate)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w$.]*?\.generateContent\s*\(/;
// 只认裸调用：`re.exec(text)`、`db.exec(sql)` 这类成员方法（正则/DB）不是子进程执行（照 inject 的 RE_EXEC_BARE 口径）。
const EXEC_CALL_RE = /(?:^|[^\w.$])(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/;
// TS 方法签名/重载声明（`exec(cmd: string, opts): Promise<X> {`）不是运行时调用（round6 agents/ai ≥16 条声明 FP）。
const TS_TYPED_RETURN_RE = /\)\s*:\s*[A-Za-z<][^;]{0,160}?[;{]\s*$/;
// shell 包装器形状：`sh -c ${cmd}`（无引号模板）、spawn('bash',['-c',v])、exec('sh -c '+v)、shell:true。
const SHELL_WRAP_RE = /(?:^|[(,\s'"`])(?:(?:\/bin\/)?(?:ba|z)?sh|cmd(?:\.exe)?|powershell|pwsh)\s+[-/]?(?:c\b|Command\b)|(?:^|[(,\s])(?:(?:\/bin\/)?(?:ba|z)?sh|cmd(?:\.exe)?|powershell|pwsh)['"`]?\s*,\s*(?:\[?\s*)?['"`](?:-\/?c|-Command)\b|\bshell\s*:\s*true\b/;
const SANITIZER_RE = /(?:sanitize|redact|escape|truncate|\.slice\s*\(|\.substring\s*\(|\.substring\(|stripSecret|maskSecret)/i;
const ENV_SECRET_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/;
const ENV_SECRET_NAME_RE = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS\b|CREDENTIAL|API)/i;
const PERSIST_WRITE_RE = /\b(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\s*\(/;
const PERSIST_NAME_RE = /['"`][^'"`]*(?:transcript|conversation|chat[-_]?history|session[-_]?log|messages)[^'"`]*['"`]/i;
const DEBUG_LOG_RE = /\b(?:console|logger)\.\w+\s*\([^)\n]*(?:\bprompt\b|\bmessages\b|completion|\bresponse\b)/i;
// 日志参数剥掉字符串字面量后必须仍有含数据关键词的标识符（userPrompt / theResponse 都算）
const LOG_DATA_ARG_RE = /\b\w*(?:prompt|messages?|completion|response|reply|history|transcript|content)\w*\b/i;
const EXTRACTED_VAR_RE = /\$\{([\w$]+)(?:[.\w()'"[\]]*)?\}/g;
// 函数边界（近似口径）：变量血缘不跨函数，遇声明/块级箭头函数重置追踪。
const FUNC_BOUNDARY_RE = /(?:^|\)\s*)(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$]|\b(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$/;

// snippet 脱敏：源码行里疑似真实凭据的字面量打码（A4 也可能命中含字面量的行）。
function maskSecrets(text) {
  return String(text || '')
    .replace(/\b(?:sk|ghp|gho|ghu|xoxb|xoxp|AKIA)[-_A-Za-z0-9]{8,}/g, '***')
    .replace(/((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*['"])[^'"]{8,}(['"])/gi, '$1***$2');
}

function mkFinding(checkId, rule, { severity, force, hard = undefined, file, line, snippet, message }) {
  return {
    checkId, rule, severity, force,
    ...(hard !== undefined ? { hard } : {}),
    file, line,
    snippet: maskSecrets(String(snippet || '').slice(0, 200)),
    message,
    source: 'program',
  };
}

// ── 扫描上下文（四个检查共用同一套口径） ─────────────────────────────────

async function findAgentConfigFiles(projectDir, excludes) {
  const out = [];
  const excluded = (rel) => excludes.some((x) => { const n = String(x).replace(/\\/g, '/'); return rel === n || rel.startsWith(n + '/'); });
  const SKIP = new Set(['node_modules', '.git', '.finalcheck', 'coverage', 'vendor', 'dist', 'build', 'release', 'out']);
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(projectDir, p).replace(/\\/g, '/');
      if (excluded(rel)) continue;
      if (e.isDirectory()) {
        if (SKIP.has(e.name.toLowerCase())) continue;
        await walk(p, depth + 1);
        continue;
      }
      if (AGENT_CONFIG_RES.some((m) => m.re.test(rel))) {
        const kind = AGENT_CONFIG_RES.find((m) => m.re.test(rel)).kind;
        out.push({ rel, abs: p, kind });
      }
    }
  }
  await walk(projectDir, 0);
  return out;
}

// 逐行剥离注释（跟踪块注释状态）；返回 [{rel, code:[…]}]
async function loadJsSources(projectDir, { excludes, includeFixtures }) {
  const { files, skipped } = await listTextFiles(projectDir, excludes, { codeOnly: true, includeFixtures });
  const out = [];
  for (const abs of files) {
    const rel = path.relative(projectDir, abs).replace(/\\/g, '/');
    if (isNonProductPath(rel)) continue;
    if (/\.d\.ts$/i.test(rel)) continue; // 类型声明文件：形状全是签名/示例，A 系列不扫（round6 ≥16 条声明 FP）
    const { text } = await readRel(projectDir, abs);
    if (!text) continue;
    const lines = [];
    let inBlock = false;
    for (const raw of String(text).split('\n')) {
      const { code, inBlockComment } = stripComments(raw, inBlock);
      lines.push(code);
      inBlock = inBlockComment;
    }
    out.push({ rel, lines });
  }
  return { sources: out, scannedJs: out.length, skippedCount: skipped.length };
}

async function loadSdkDeps(projectDir, excludes, includeFixtures) {
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures, maxDepth: 3 });
  const found = new Set();
  for (const abs of files.filter((f) => path.basename(f) === 'package.json')) {
    let pkg = null;
    try { pkg = JSON.parse(await readFile(abs, 'utf8')); } catch { continue; }
    for (const key of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) {
      if (LLM_SDK_EXACT.has(key) || LLM_SDK_SCOPE_RE.test(key)) found.add(key);
    }
  }
  return [...found].sort();
}

// 通用上下文：JS 源、SDK 依赖、agent 配置文件。四个检查共用（fail-closed 的三信号）。
async function loadContext(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const [js, sdkDeps, configFiles] = await Promise.all([
    loadJsSources(projectDir, { excludes, includeFixtures }),
    loadSdkDeps(projectDir, excludes, includeFixtures),
    findAgentConfigFiles(projectDir, excludes),
  ]);
  const promptSignal = js.sources.some(({ lines }) => lines.some((l) => LLM_CALL_RE.test(l) || PROMPT_FIELD_RE.test(l)));
  return { ...js, sdkDeps, configFiles, promptSignal };
}

// A2/A3/A4 的统一缺口口径：
//  - 无 SDK 依赖且产品源码零 prompt/LLM 痕迹 → not-applicable（三信号都查过）
//  - 有依赖但一个 JS 源都解析不了 → unavailable（依赖名 + 没采到什么写清楚）
//  - 有信号、扫描正常、零命中 → 正常通过 + warning 声明扫描口径（不冒充「确认安全」）
function flowGap(ctx, checkId) {
  if (!ctx.sdkDeps.length && !ctx.promptSignal) {
    return { coverageGap: `${checkId}：未发现 AI/LLM 痕迹（package.json 依赖清单、agent 配置文件、${ctx.scannedJs} 个 JS/TS 产品源文件的 LLM 调用/prompt 构造模式均已查），本项不适用`, gapKind: 'not-applicable' };
  }
  if (ctx.sdkDeps.length && !ctx.scannedJs) {
    return { coverageGap: `${checkId}：检测到 LLM SDK 依赖（${ctx.sdkDeps.join('、')}），但没有可解析的 JS/TS 产品源码，prompt 构造/工具调用面未采到证据`, gapKind: 'unavailable' };
  }
  return null;
}

function passWarning(ctx, checkId) {
  if (!ctx.sdkDeps.length) return null;
  return `${checkId}：检测到 LLM SDK 依赖（${ctx.sdkDeps.join('、')}），零命中基于静态扫描（不运行、不验证注入是否实际成功）`;
}

// ── A1 tool 权限 ─────────────────────────────────────────────────────────

function allowEntryVerdict(entry) {
  const e = String(entry || '').trim().replace(/^["']|["']$/g, '');
  if (!e) return null;
  if (WILDCARD_ALLOW_RE.test(e) || INTERPRETER_RE.test(e)) return { rule: 'A1.permissive-allow', severity: 'high', force: 'card', message: '工具白名单含通配或「解释器 + 任意参数」形状，等价于不受限执行' };
  if (RISKY_CMD_RE.test(e)) return { rule: 'A1.risky-allow', severity: 'medium', force: 'check', message: '白名单含高危命令（非只读）' };
  return null;
}

function scanAllowArray(text, startIdx) {
  // 从 '[' 起取数组文本（最多 20 行），提取引号条目。
  let depth = 0;
  let end = startIdx;
  const max = Math.min(text.length, startIdx + 4000);
  for (let i = startIdx; i < max; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') { depth--; if (!depth) { end = i; break; } }
  }
  return text.slice(startIdx, end + 1).match(/["']([^"']+)["']/g) || [];
}

export async function checkAiToolPerms(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const ctx = await loadContext(projectDir, { excludes, includeFixtures });
  const findings = [];
  const warnings = [];
  // 1) 已知 agent 配置文件（语言无关；入库的权限配置是产品面）
  for (const cfg of ctx.configFiles) {
    const text = await readFile(cfg.abs, 'utf8').catch(() => '');
    if (!text) continue;
    const lineAt = (idx) => text.slice(0, idx).split('\n').length;
    if (cfg.kind === 'claude-settings') {
      const mode = BYPASS_MODE_RE.exec(text);
      if (mode) findings.push(mkFinding('A1', 'A1.bypass-mode', { severity: 'high', force: 'card', hard: true, file: cfg.rel, line: lineAt(mode.index), snippet: mode[0], message: 'agent 配置默认 bypassPermissions：所有工具调用免审批，等价于不受限执行' }));
      const allow = /"allow"\s*:\s*\[/.exec(text);
      if (allow) {
        for (const raw of scanAllowArray(text, allow.index + allow[0].length - 1)) {
          const v = allowEntryVerdict(raw);
          if (v) findings.push(mkFinding('A1', v.rule, { severity: v.severity, force: v.force, hard: v.force === 'card', file: cfg.rel, line: lineAt(allow.index), snippet: raw.trim(), message: v.message }));
        }
      }
    }
    if (cfg.kind === 'codex') {
      const sandbox = /sandbox_mode\s*=\s*"danger-full-access"/.exec(text);
      const never = /approval_policy\s*=\s*"never"/.test(text);
      if (sandbox && never) findings.push(mkFinding('A1', 'A1.no-sandbox', { severity: 'high', force: 'card', hard: true, file: cfg.rel, line: lineAt(sandbox.index), snippet: sandbox[0], message: 'codex 配置 danger-full-access + approval never：无沙箱且免审批' }));
      else if (sandbox) findings.push(mkFinding('A1', 'A1.no-sandbox', { severity: 'medium', force: 'check', file: cfg.rel, line: lineAt(sandbox.index), snippet: sandbox[0], message: 'codex 配置 danger-full-access（审批策略未关闭，需人工确认实际组合）' }));
    }
    if (cfg.kind === 'claude-agent') {
      const tools = /allowed-tools\s*:\s*([^\n]+)/i.exec(text);
      if (tools) {
        for (const entry of tools[1].split(',')) {
          const v = allowEntryVerdict(entry);
          if (v) findings.push(mkFinding('A1', v.rule, { severity: v.severity, force: v.force, hard: false, file: cfg.rel, line: lineAt(tools.index), snippet: entry.trim(), message: v.message }));
        }
      }
    }
    if (cfg.kind === 'mcp') {
      const wrap = /"command"\s*:\s*"(?:sh|bash|cmd|powershell|pwsh)\b[^"]*\s(?:\/c|-c)\b/.exec(text);
      if (wrap) findings.push(mkFinding('A1', 'A1.mcp-shell-wrap', { severity: 'medium', force: 'check', file: cfg.rel, line: lineAt(wrap.index), snippet: wrap[0], message: 'MCP server 经 shell 包装器启动（-c/-Command），server 配置即命令面' }));
    }
  }
  const configHits = findings.length;
  // 2) 代码级：allow 白名单 / bypass 开关（非入库 agent 配置 → 一律 hard:false 可降级）
  for (const { rel, lines } of ctx.sources) {
    const joined = lines.join('\n');
    let m;
    const lineAllow = /\b(?:allowed(?:Tools|_tools|-tools)?|allow)\s*[:=]\s*\[/g;
    while ((m = lineAllow.exec(joined))) {
      for (const raw of scanAllowArray(joined, m.index + m[0].length - 1)) {
        const v = allowEntryVerdict(raw);
        if (v && !['card', 'check'].includes((findings.find((f) => f.file === rel && f.snippet === raw.trim()) || {}).force || '')) {
          findings.push(mkFinding('A1', v.rule, { severity: v.severity, force: v.force, hard: false, file: rel, line: joined.slice(0, m.index).split('\n').length, snippet: raw.trim(), message: v.message }));
        }
      }
    }
    for (let i = 0; i < lines.length; i++) {
      if (BYPASS_FLAG_RE.test(lines[i])) {
        findings.push(mkFinding('A1', 'A1.bypass-flag', { severity: 'medium', force: 'check', hard: false, file: rel, line: i + 1, snippet: lines[i], message: '代码/脚本含 agent 审批绕过开关（yolo / dangerously 类免审批参数）' }));
      }
    }
  }
  // package.json scripts 里的 bypass 开关
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures, maxDepth: 3 });
  for (const abs of files.filter((f) => path.basename(f) === 'package.json')) {
    let pkg = null;
    try { pkg = JSON.parse(await readFile(abs, 'utf8')); } catch { continue; }
    for (const [name, script] of Object.entries(pkg.scripts || {})) {
      if (BYPASS_FLAG_RE.test(String(script))) {
        findings.push(mkFinding('A1', 'A1.bypass-flag', { severity: 'medium', force: 'check', hard: false, file: path.relative(projectDir, abs).replace(/\\/g, '/'), line: 1, snippet: `${name}: ${String(script).slice(0, 120)}`, message: 'npm script 含 agent 审批绕过开关' }));
      }
    }
  }
  // 缺口：三信号全无 → N/A；有 SDK 无配置命中 → 通过但声明口径
  if (!ctx.configFiles.length && !findings.length && !ctx.sdkDeps.length && !ctx.promptSignal) {
    return { checkId: 'A1', findings: [], warnings, coverageGap: 'A1：未发现 agent 工具/权限痕迹（.claude/.codex/.cursor/mcp.json 配置文件、package.json scripts、产品源码的 allowed 白名单与 bypass 开关均已查），本项不适用', gapKind: 'not-applicable' };
  }
  const w = configHits === 0 && !findings.length ? passWarning(ctx, 'A1') : null;
  if (w) warnings.push(w);
  return { checkId: 'A1', findings, warnings, coverageGap: null };
}

// ── A2 提示注入面 ─────────────────────────────────────────────────────────

export async function checkAiPromptInjection(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const ctx = await loadContext(projectDir, { excludes, includeFixtures });
  const gap = flowGap(ctx, 'A2');
  if (gap) return { checkId: 'A2', findings: [], warnings: [], ...gap };
  const findings = [];
  for (const { rel, lines } of ctx.sources) {
    const llmVar = new Set();
    const sanitizedVars = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('finalcheck:allow')) continue;
      if (FUNC_BOUNDARY_RE.test(line)) { llmVar.clear(); sanitizedVars.clear(); }
      // 声明传播：const X = <引用 llmVar 的表达式> → X 也算「模型/外部血缘」；
      // 链上带 sanitizer 形状则记入 sanitizedVars（降 check 用），不带则保持 card 口径。
      const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)/.exec(line);
      if (decl) {
        const srcVar = [...llmVar].find((v) => new RegExp(`(?:[(\\s'"[=+,:]|\\b)${v}\\b`).test(decl[2]));
        if (srcVar) {
          llmVar.add(decl[1]);
          if (SANITIZER_RE.test(decl[2])) sanitizedVars.add(decl[1]);
          continue;
        }
      }
      const assign = ASSIGN_EXTERNAL_RE.exec(line) || SDK_CALL_ASSIGN_RE.exec(line);
      if (assign) { llmVar.add(assign[1]); sanitizedVars.delete(assign[1]); continue; }
      if (!PROMPT_FIELD_RE.test(line) || !LLM_PROMPT_LINE_RE.test(line)) continue;
      const referenced = [...line.matchAll(EXTRACTED_VAR_RE)].map((x) => x[1]).find((v) => llmVar.has(v))
        || [...llmVar].find((v) => new RegExp(`\\+\\s*${v}\\b`).test(line)); // 只认插值与显式拼接，裸提及不算（CSS/type 注解误报源）
      if (!referenced) continue;
      // 链上有消毒动作 → 降 check（不评估消毒质量）
      const between = lines.slice(Math.max(0, i - 12), i).join('\n');
      const sanitized = sanitizedVars.has(referenced) || SANITIZER_RE.test(between) || SANITIZER_RE.test(line);
      findings.push(mkFinding('A2', sanitized ? 'A2.prompt-external-sanitized' : 'A2.prompt-external', {
        severity: 'high', force: sanitized ? 'check' : 'card',
        file: rel, line: i + 1, snippet: line,
        message: sanitized
          ? '外部内容/工具输出拼进 LLM prompt 字段；链上见 truncate/sanitize 形状调用，隔离质量未评估，需人工确认'
          : '外部内容/工具输出未加隔离直接拼进 LLM prompt 字段（同函数窗口内耦合）',
      }));
    }
  }
  const w = !findings.length ? passWarning(ctx, 'A2') : null;
  const warnings = w ? [w] : [];
  return { checkId: 'A2', findings, warnings, coverageGap: null };
}

// prompt 行必须是「真的在喂 LLM」：messages 数组 / prompt 字段 / content 进 SDK 调用。
const LLM_PROMPT_LINE_RE = /\b(?:messages|prompt|system|content|input)\s*[:=]/;

// ── A3 沙箱/逃逸面 ─────────────────────────────────────────────────────────

export async function checkAiSandbox(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const ctx = await loadContext(projectDir, { excludes, includeFixtures });
  const gap = flowGap(ctx, 'A3');
  if (gap) return { checkId: 'A3', findings: [], warnings: [], ...gap };
  const findings = [];
  for (const { rel, lines } of ctx.sources) {
    let llmVar = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('finalcheck:allow')) continue;
      if (FUNC_BOUNDARY_RE.test(line)) llmVar.clear();
      const assign = SDK_CALL_ASSIGN_RE.exec(line) || /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n]*\btool_calls\b/.exec(line);
      if (assign) { llmVar.add(assign[1]); continue; }
      if (!EXEC_CALL_RE.test(line)) continue;
      if (TS_TYPED_RETURN_RE.test(line)) continue; // 类型化签名（带返回注解）不是调用
      // timeout/maxBuffer 可能写在调用对象后几行（round6 实证第 7 行）或前面几行：窗口前后都看
      const window = lines.slice(Math.max(0, i - 3), i + 10).join('\n');
      const modelDriven = [...line.matchAll(EXTRACTED_VAR_RE)].map((x) => x[1]).find((v) => llmVar.has(v))
        || [...llmVar].find((v) => new RegExp(`(?:\\+\\s*|[(\\s'"[])${v}\\b`).test(window));
      if (modelDriven && SHELL_WRAP_RE.test(window)) {
        findings.push(mkFinding('A3', 'A3.shell-llm-cmd', { severity: 'high', force: 'card', file: rel, line: i + 1, snippet: line, message: 'shell 解释器（sh -c/bash -c/shell:true）执行模型生成的命令串：模型输出即命令' }));
        continue;
      }
      // 无限额子进程：命令是变量（非字面量）且 ±3 行没有 timeout/maxBuffer → check
      const firstArg = line.replace(/^[^(']*\(/, '').trim();
      const isLiteral = /^['"`]/.test(firstArg);
      if (!isLiteral && !/\b(?:timeout|maxBuffer|maxBuffer)\b/.test(window) && !modelDriven) {
        findings.push(mkFinding('A3', 'A3.unbounded-spawn', { severity: 'medium', force: 'check', file: rel, line: i + 1, snippet: line, message: 'spawn/exec 命令参数为变量且未见 timeout/maxBuffer 限额（需人工确认命令来源）' }));
      }
    }
  }
  const w = !findings.length ? passWarning(ctx, 'A3') : null;
  const warnings = w ? [w] : [];
  return { checkId: 'A3', findings, warnings, coverageGap: null };
}

// ── A4 数据边界 ───────────────────────────────────────────────────────────

export async function checkAiDataBoundary(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const ctx = await loadContext(projectDir, { excludes, includeFixtures });
  const gap = flowGap(ctx, 'A4');
  if (gap) return { checkId: 'A4', findings: [], warnings: [], ...gap };
  const findings = [];
  for (const { rel, lines } of ctx.sources) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('finalcheck:allow')) continue;
      // 1) env 密钥拼进 prompt 字段（snippet 已打码，不回显值）
      const env = ENV_SECRET_RE.exec(line);
      if (env && ENV_SECRET_NAME_RE.test(env[1]) && PROMPT_FIELD_RE.test(line)) {
        findings.push(mkFinding('A4', 'A4.secret-in-prompt', { severity: 'high', force: 'card', hard: false, file: rel, line: i + 1, snippet: line, message: `环境变量 ${env[1]} 拼进 prompt/消息字段：密钥进入模型上下文（值不回显）` }));
        continue;
      }
      // 2) 完整对话/工具输出写持久文件
      if (PERSIST_WRITE_RE.test(line) && PERSIST_NAME_RE.test(line)) {
        const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
        if (/\b(?:messages|history|conversation|transcript|chat)\b/i.test(window)) {
          findings.push(mkFinding('A4', 'A4.conversation-log', { severity: 'high', force: 'card', hard: false, file: rel, line: i + 1, snippet: line, message: '完整对话/工具输出写入持久文件（脱敏调用未识别）：落盘内容超出产品运行所需' }));
          continue;
        }
      }
      // 3) 调试日志打印 prompt/对话 → check；纯字面量（'Response received'）不是数据边界问题：
      //    整行剥掉字符串字面量后必须仍有含数据关键词的标识符（userPrompt/response 等）。
      if (DEBUG_LOG_RE.test(line)) {
        const argsNoStr = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
        if (LOG_DATA_ARG_RE.test(argsNoStr)) {
          findings.push(mkFinding('A4', 'A4.debug-log', { severity: 'medium', force: 'check', hard: false, file: rel, line: i + 1, snippet: line, message: '日志打印 prompt/对话/模型响应（需人工确认是否含敏感数据）' }));
        }
      }
    }
  }
  const w = !findings.length ? passWarning(ctx, 'A4') : null;
  const warnings = w ? [w] : [];
  return { checkId: 'A4', findings, warnings, coverageGap: null };
}
