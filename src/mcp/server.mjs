// FinalCheck MCP stdio server：JSON-RPC 2.0（按行分隔，不用 Content-Length 头）
// 让任何支持 MCP 的 coding agent（Claude Code / Cline / Goose）都能挂载 FinalCheck 五工具。
// 安全边界（硬性，ACCEPTANCE §7 + DESKTOP-ACCEPTANCE §2）：
//   1. probe_target / stress_target 仅允许 http://localhost | http://127.0.0.1 —— MCP 无用户确认通道，其他 host 一律拒绝；
//   2. 压测强制温和上限 60s / 50 连接，超限拒绝；
//   3. 项目相关工具（文件读写/产物/审计/下载闸/报告）只能操作 --root 指定的目录（默认进程 cwd），
//      绝对路径逃逸、`..`、符号链接逃逸一律拒绝（桌面端仍由 assertPathAllowed + 审批负责，边界不重复加在那里）；
//   4. quality_gate 默认拒绝执行项目命令（MCP 无确认通道）；必须显式 FINALCHECK_MCP_ALLOW_COMMANDS=1 + --root 才放行；
//   5. 工具异常一律返回 isError:true 的工具结果，不许崩进程。
import readline from 'node:readline';
import path from 'node:path';
import { lstat, realpath, stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const engineUrl = (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href;

const PROTOCOL_VERSION = '2024-11-05';
// 版本从 desktop/package.json 读，别再写死（写死会跟发版漂移，MCP 客户端看到的是旧版本）
const SERVER_INFO = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'desktop', 'package.json'), 'utf8'));
    return { name: 'finalcheck', version: String(pkg.version || '0.0.0') };
  } catch {
    return { name: 'finalcheck', version: '0.0.0' };
  }
})();
const STRESS_MAX = { duration: 60, connections: 50 };
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const ALLOW_COMMANDS_ENV = 'FINALCHECK_MCP_ALLOW_COMMANDS';

// quality_gate 默认拒绝文案（测试与文档按这句对齐）
const QUALITY_GATE_DENIED = '拒绝执行：MCP 通道不执行项目命令（没有用户确认通道；quality_gate 会运行 finalcheck.quality.json 里声明的 lint / test / bench）。如确需执行，请设置 FINALCHECK_MCP_ALLOW_COMMANDS=1 并显式传 --root <dir>（目标 dir 必须在该根内）；否则请改用桌面端 quality_gate（执行前有逐次审批）。';
const QUALITY_GATE_NO_EXPLICIT_ROOT = `拒绝执行：已设置 ${ALLOW_COMMANDS_ENV}=1，但启动时没有显式传 --root <dir>。为避免把默认 cwd 误当授权范围，MCP 仍不执行项目命令；请用 --root 指定项目根后重启。`;

/** 解析 --root（同时接受 `--root <dir>` 与 `--root=<dir>`）；默认进程 cwd。explicit 标记是否由用户显式给出。 */
export function parseRootArg(argv = process.argv.slice(2)) {
  let rawRoot = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--root 后必须跟一个已存在的目录路径');
      rawRoot = value;
      i += 1;
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length).trim();
      if (!value) throw new Error('--root= 后必须跟一个已存在的目录路径');
      rawRoot = value;
    }
  }
  return { root: path.resolve(rawRoot ?? process.cwd()), explicit: rawRoot !== null };
}

/** 启动时校验根目录真实存在且是目录（不存在的 --root 直接启动失败，不进入服务循环）。 */
export function assertRootDirectory(root) {
  const abs = path.resolve(root);
  let st;
  try { st = statSync(abs); } catch { throw new Error(`--root 指定的目录不存在：${abs}`); }
  if (!st.isDirectory()) throw new Error(`--root 必须是目录（收到文件路径）：${abs}`);
  return abs;
}

const isOutside = (rel) => rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

function pathBoundaryError(root, inputPath) {
  const err = new Error(
    `拒绝访问：路径越界（${String(inputPath)} 不在允许的根目录 ${root} 内）。MCP 只允许操作 --root 指定的目录（默认进程工作目录）；请把目标放进根目录，或启动时用 --root <dir> 指定项目根。`
  );
  err.code = 'EPATHBOUNDARY';
  return err;
}

/**
 * MCP 路径监狱：把 inputPath 解析到 root 内，并校验真实路径（含符号链接）仍在 root 内。
 * 返回 abs（词法解析结果）；拒绝时抛 EPATHBOUNDARY 错误（由 tools/call 转成 isError 工具结果）。
 */
export async function resolveWithinRoot(root, inputPath) {
  const rootAbs = path.resolve(root);
  if (typeof inputPath !== 'string' || inputPath.trim() === '') throw new Error('路径参数必填（不能为空）');
  const abs = path.resolve(rootAbs, inputPath);
  // 1) 词法层：绝对路径逃逸与 `..` 逃逸
  if (isOutside(path.relative(rootAbs, abs))) throw pathBoundaryError(rootAbs, inputPath);

  // 2) 符号链接层：root 与 target 都按 realpath 解析后比较；
  //    target 不存在时逐级回退到最近的已存在父目录（不存在的后缀不可能再含符号链接）。
  let realRoot;
  try { realRoot = await realpath(rootAbs); } catch { throw new Error(`根目录不可用：${rootAbs}`); }
  let probe = abs;
  const tail = [];
  for (;;) {
    let realTarget;
    try {
      realTarget = await realpath(probe);
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
      // 悬空符号链接：realpath 给 ENOENT，lstat 能看出来 → 拒绝。
      // 每一层回退都查（末端或中间段是悬空链接都可能把后续写入引到 root 外）。
      let dangling = false;
      try {
        const st = await lstat(probe);
        dangling = st.isSymbolicLink();
      } catch (e2) {
        if (e2?.code !== 'ENOENT' && e2?.code !== 'ENOTDIR') throw e2;
      }
      if (dangling) throw new Error(`拒绝访问：符号链接目标不存在或不可解析（${abs}）`);
      const parent = path.dirname(probe);
      if (parent === probe) throw pathBoundaryError(rootAbs, inputPath);
      tail.unshift(path.basename(probe));
      probe = parent;
      continue;
    }
    const candidate = tail.length ? path.join(realTarget, ...tail) : realTarget;
    if (isOutside(path.relative(realRoot, candidate))) throw pathBoundaryError(rootAbs, inputPath);
    return abs;
  }
}

// 工具 schema 照抄 agent-service 的 TOOLS_SCHEMA（SSOT：桌面与 MCP 两通道共用一份，防漂移）。
// 只广告本通道真的有 handler 的工具：run_workflow / run_command / remember_project 需要桌面端的
// 子代理调用或审批通道，MCP 里没有对应 case，广告出去只会让客户端拿到「未知工具」。
const MCP_HANDLED_TOOLS = new Set([
  'audit_project', 'quality_gate', 'download_gate', 'probe_target', 'stress_target', 'get_report',
  'list_playbooks', 'read_playbook', 'read_file', 'edit_file', 'write_file', 'present_artifact',
]);
async function listTools() {
  const { TOOLS_SCHEMA } = await import(engineUrl('desktop/src/main/agent-service.mjs'));
  return TOOLS_SCHEMA.filter((t) => MCP_HANDLED_TOOLS.has(t.function.name)).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));
}

// MCP 模式无确认通道：动态目标仅放行本机回环（比桌面版更严，桌面版还有 confirmedHosts）
function assertLocalTarget(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error(`拒绝执行：无效 URL "${urlStr}"（仅允许 http://localhost 或 http://127.0.0.1）`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`拒绝执行：仅允许 http/https 协议且目标必须是 localhost 或 127.0.0.1（收到 ${u.protocol}://）`);
  if (!LOCAL_HOSTS.includes(u.hostname)) {
    throw new Error(`拒绝执行：MCP 模式下 probe_target/stress_target 仅允许 http://localhost 或 http://127.0.0.1（无用户确认通道，目标 ${u.hostname} 不在本机白名单）`);
  }
  return u;
}

// 工具分发（与 desktop/src/main/agent-tools.mjs 同一调用约定）
// ctx = { root, allowCommands, explicitRoot }：root 是 MCP 启动时确定的项目根，项目相关路径一律先过 resolveWithinRoot。
async function callTool(name, args = {}, ctx = {}) {
  const root = ctx.root;
  switch (name) {
    case 'audit_project': {
      const dir = await resolveWithinRoot(root, args.dir);
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const r = await audit(dir, { tier: args.tier ?? null, interactive: true, runTests: false }); // runTests=false：代理场景禁跑被审项目代码（ACCEPTANCE §7 下载闸边界）
      return { verdict: r.conclusion.verdict, reason: r.conclusion.reason, tier: r.tier, gates: r.gates, findings: r.findings.slice(0, 30) };
    }
    case 'download_gate': {
      const dir = await resolveWithinRoot(root, args.dir);
      const { scanDownload } = await import(engineUrl('src/download-gate.mjs'));
      return scanDownload(dir, { excludes: [] });
    }
    case 'quality_gate': {
      // MCP 通道没有确认弹窗：默认拒绝执行项目命令；只有 env=1 且启动时显式 --root 才放行。
      if (!ctx.allowCommands) throw new Error(ctx.envAllowed ? QUALITY_GATE_NO_EXPLICIT_ROOT : QUALITY_GATE_DENIED);
      const dir = await resolveWithinRoot(root, args.dir);
      const { checkQuality } = await import(engineUrl('src/checks/quality.mjs'));
      const r = await checkQuality(dir, { tier: args.tier || 'L2', run: true });
      return { runs: r.runs, findings: r.findings.slice(0, 30), warnings: r.warnings, coverageGap: r.coverageGap };
    }
    case 'list_playbooks': {
      const { loadCatalog, catalogSummary } = await import(engineUrl('src/playbooks.mjs'));
      const catalog = await loadCatalog();
      return { total: catalog.length, categories: catalogSummary(catalog) };
    }
    case 'read_playbook': {
      const { readPlaybook } = await import(engineUrl('src/playbooks.mjs'));
      return readPlaybook({ topic: args.topic, file: args.file, offset: args.offset, limit: args.limit });
    }
    case 'read_file': {
      const abs = await resolveWithinRoot(root, args.path);
      const { readFileTool } = await import(engineUrl('src/fs-tools.mjs'));
      return readFileTool({ path: abs, offset: args.offset, limit: args.limit });
    }
    case 'edit_file': {
      const abs = await resolveWithinRoot(root, args.path);
      const { editFileTool } = await import(engineUrl('src/fs-tools.mjs'));
      return editFileTool({ path: abs, old_string: args.old_string, new_string: args.new_string });
    }
    case 'write_file': {
      const abs = await resolveWithinRoot(root, args.path);
      const { writeFileTool } = await import(engineUrl('src/fs-tools.mjs'));
      return writeFileTool({ path: abs, content: args.content });
    }
    case 'present_artifact': {
      const abs = await resolveWithinRoot(root, args.path);
      const st = await stat(abs);
      if (!st.isFile()) throw new Error('不是文件');
      return { path: abs, name: path.basename(abs), title: args.title || path.basename(abs), size: st.size };
    }
    case 'probe_target': {
      assertLocalTarget(args.url);
      const { probeTarget } = await import(engineUrl('src/dynamic/probe.mjs'));
      return probeTarget(args.url);
    }
    case 'stress_target': {
      assertLocalTarget(args.url);
      const duration = Number(args.duration) || 10;
      const connections = Number(args.connections) || 10;
      if (duration > STRESS_MAX.duration || connections > STRESS_MAX.connections) {
        throw new Error(`超过温和上限（60s / 50 连接）：实际请求 ${duration}s / ${connections} 连接，请分批进行`);
      }
      const { stressTarget } = await import(engineUrl('src/dynamic/stress.mjs'));
      return stressTarget(args.url, { duration, connections });
    }
    case 'get_report': {
      const dir = await resolveWithinRoot(root, args.dir);
      const { renderReport } = await import(engineUrl('src/report.mjs'));
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const r = await audit(dir, { tier: args.tier ?? null, interactive: true, runTests: false });
      return renderReport(r);
    }
    default:
      throw new Error(`未知工具: ${name}（可用：audit_project / download_gate / probe_target / stress_target / get_report / list_playbooks / read_playbook / read_file / edit_file / write_file / present_artifact）`);
  }
}

function jsonRpcError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function dispatch(msg, ctx) {
  const { method, params } = msg;
  if (method === 'initialize') {
    return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
  }
  if (method === 'tools/list') {
    return { tools: await listTools() };
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {}, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? {}) }] };
    } catch (e) {
      // 工具异常（含安全边界拒绝）→ isError 工具结果，不升级为协议错误，不崩进程
      return { content: [{ type: 'text', text: String(e?.message || e) }], isError: true };
    }
  }
  throw jsonRpcError(-32601, `Method not found: ${method}`);
}

async function onLine(line, output, ctx) {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch {
    return output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
  }
  if (!msg || typeof msg.method !== 'string') {
    if (msg && msg.id != null) return output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request: 缺少 method' } }) + '\n');
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notifications/initialized 等通知：一律忽略，不回包
  try {
    const result = await dispatch(msg, ctx);
    output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  } catch (e) {
    const code = e?.code === -32601 ? -32601 : -32603;
    output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message: String(e?.message || e) } }) + '\n');
  }
}

export function runMcpServer({ input = process.stdin, output = process.stdout, root = null, argv = process.argv.slice(2), env = process.env } = {}) {
  // 启动即定根：--root 必须是已存在的目录；否则直接启动失败（不进入服务循环）
  const parsed = root == null ? parseRootArg(argv) : { root: path.resolve(root), explicit: true };
  const activeRoot = assertRootDirectory(parsed.root);
  const ctx = {
    root: activeRoot,
    explicitRoot: parsed.explicit,
    envAllowed: env?.[ALLOW_COMMANDS_ENV] === '1',
    allowCommands: env?.[ALLOW_COMMANDS_ENV] === '1' && parsed.explicit
  };
  // 兜底：任何漏网异常写 stderr（诊断通道），绝不崩 stdio 进程
  process.on('uncaughtException', (e) => process.stderr.write('[finalcheck-mcp] uncaught: ' + String(e?.stack || e) + '\n'));
  process.on('unhandledRejection', (e) => process.stderr.write('[finalcheck-mcp] unhandled: ' + String(e?.stack || e) + '\n'));
  const rl = readline.createInterface({ input });
  rl.on('line', (line) => { onLine(line, output, ctx).catch((e) => process.stderr.write('[finalcheck-mcp] handler: ' + String(e?.stack || e) + '\n')); });
  rl.on('close', () => process.exit(0)); // 客户端关 stdin → 正常退出
  return rl;
}
