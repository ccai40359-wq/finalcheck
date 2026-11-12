#!/usr/bin/env node
// FinalCheck MCP server 启动器：stdio 上的 JSON-RPC 2.0（按行分隔）
// 挂载示例（Claude Code）：claude mcp add finalcheck -- node <repo>/bin/finalcheck-mcp.js --root <项目根>
// --root 决定所有项目相关工具的路径边界（默认进程 cwd）；quality_gate 还需显式 FINALCHECK_MCP_ALLOW_COMMANDS=1。
import { runMcpServer } from '../src/mcp/server.mjs';

try {
  runMcpServer();
} catch (e) {
  // 启动参数错误（如 --root 不存在）直接失败：不进入服务循环，避免客户端拿到一个“半可用”的 server
  process.stderr.write('[finalcheck-mcp] 启动失败：' + String(e?.message || e) + '\n');
  process.exit(1);
}
