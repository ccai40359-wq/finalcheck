#!/usr/bin/env node
// FinalCheck MCP server 启动器：stdio 上的 JSON-RPC 2.0（按行分隔）
// 挂载示例（Claude Code）：claude mcp add finalcheck -- node <repo>/bin/finalcheck-mcp.js
import { runMcpServer } from '../src/mcp/server.mjs';

runMcpServer();
