// FinalCheck MCP stdio server：JSON-RPC 2.0（按行分隔，不用 Content-Length 头）
// 让任何支持 MCP 的 coding agent（Claude Code / Cline / Goose）都能挂载 FinalCheck 五工具。
// 安全边界（硬性，ACCEPTANCE §7 + DESKTOP-ACCEPTANCE §2）：
//   1. probe_target / stress_target 仅允许 http://localhost | http://127.0.0.1 —— MCP 无用户确认通道，其他 host 一律拒绝；
//   2. 压测强制温和上限 60s / 50 连接，超限拒绝；
//   3. 工具异常一律返回 isError:true 的工具结果，不许崩进程。
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const engineUrl = (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href;

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'finalcheck', version: '0.1.0' };
const STRESS_MAX = { duration: 60, connections: 50 };
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

// 工具 schema 照抄 agent-service 的 TOOLS_SCHEMA（SSOT：桌面与 MCP 两通道共用一份，防漂移）
// run_workflow 需要宿主提供子代理调用（桌面端有网关配置），MCP 通道不暴露
const DESKTOP_ONLY_TOOLS = new Set(['run_workflow']);
async function listTools() {
  const { TOOLS_SCHEMA } = await import(engineUrl('desktop/src/main/agent-service.mjs'));
  return TOOLS_SCHEMA.filter((t) => !DESKTOP_ONLY_TOOLS.has(t.function.name)).map((t) => ({
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
async function callTool(name, args = {}) {
  switch (name) {
    case 'audit_project': {
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const r = await audit(args.dir, { tier: args.tier ?? null, interactive: true, runTests: false }); // runTests=false：代理场景禁跑被审项目代码（ACCEPTANCE §7 下载闸边界）
      return { verdict: r.conclusion.verdict, reason: r.conclusion.reason, tier: r.tier, gates: r.gates, findings: r.findings.slice(0, 30) };
    }
    case 'download_gate': {
      const { scanDownload } = await import(engineUrl('src/download-gate.mjs'));
      return scanDownload(args.dir, { excludes: [] });
    }
    case 'quality_gate': {
      // MCP 通道没有确认弹窗（与 run_command 同级：使用者自己配置了这个 MCP server）；按项目声明跑命令
      const { checkQuality } = await import(engineUrl('src/checks/quality.mjs'));
      const r = await checkQuality(args.dir, { tier: args.tier || 'L2', run: true });
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
      const { readFileTool } = await import(engineUrl('src/fs-tools.mjs'));
      return readFileTool({ path: args.path, offset: args.offset, limit: args.limit });
    }
    case 'edit_file': {
      const { editFileTool } = await import(engineUrl('src/fs-tools.mjs'));
      return editFileTool({ path: args.path, old_string: args.old_string, new_string: args.new_string });
    }
    case 'write_file': {
      const { writeFileTool } = await import(engineUrl('src/fs-tools.mjs'));
      return writeFileTool({ path: args.path, content: args.content });
    }
    case 'present_artifact': {
      const { stat } = await import('node:fs/promises');
      const abs = path.resolve(String(args.path || ''));
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
      const { renderReport } = await import(engineUrl('src/report.mjs'));
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const r = await audit(args.dir, { tier: args.tier ?? null, interactive: true, runTests: false });
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

async function dispatch(msg) {
  const { method, params } = msg;
  if (method === 'initialize') {
    return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
  }
  if (method === 'tools/list') {
    return { tools: await listTools() };
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result ?? {}) }] };
    } catch (e) {
      // 工具异常（含安全边界拒绝）→ isError 工具结果，不升级为协议错误，不崩进程
      return { content: [{ type: 'text', text: String(e?.message || e) }], isError: true };
    }
  }
  throw jsonRpcError(-32601, `Method not found: ${method}`);
}

async function onLine(line, output) {
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
    const result = await dispatch(msg);
    output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  } catch (e) {
    const code = e?.code === -32601 ? -32601 : -32603;
    output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message: String(e?.message || e) } }) + '\n');
  }
}

export function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  // 兜底：任何漏网异常写 stderr（诊断通道），绝不崩 stdio 进程
  process.on('uncaughtException', (e) => process.stderr.write('[finalcheck-mcp] uncaught: ' + String(e?.stack || e) + '\n'));
  process.on('unhandledRejection', (e) => process.stderr.write('[finalcheck-mcp] unhandled: ' + String(e?.stack || e) + '\n'));
  const rl = readline.createInterface({ input });
  rl.on('line', (line) => { onLine(line, output).catch((e) => process.stderr.write('[finalcheck-mcp] handler: ' + String(e?.stack || e) + '\n')); });
  rl.on('close', () => process.exit(0)); // 客户端关 stdin → 正常退出
  return rl;
}
