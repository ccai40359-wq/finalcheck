// 测试用 MCP 服务器（stdio）：覆盖分页、图片、isError、慢调用 + 取消、list_changed、崩溃。
import readline from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let extra = false;
const cancelled = new Set();
const base = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'boom', description: 'Always fails', inputSchema: { type: 'object' } },
  { name: 'pic', description: 'Returns an image', inputSchema: { type: 'object' } },
  { name: 'slow', description: 'Takes 5s', inputSchema: { type: 'object' } },
  { name: 'grow', description: 'Adds a tool and notifies', inputSchema: { type: 'object' } },
  { name: 'crash', description: 'Exits the process', inputSchema: { type: 'object' } },
  { name: 'env', description: 'Reads FIXTURE_TOKEN', inputSchema: { type: 'object' } }
];
console.error('fixture stderr: started');
process.stdout.write('this line is a log, not JSON\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'notifications/cancelled') { cancelled.add(m.params?.requestId); return; }
  if (m.id === undefined) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1.0.0' }, instructions: 'Use echo for testing.' });
    case 'tools/list': {
      const tools = extra ? [...base, { name: 'extra.tool', description: 'Added later', inputSchema: { type: 'object' } }] : base;
      // 两页：第一页 3 个，第二页其余
      if (!m.params?.cursor) return ok({ tools: tools.slice(0, 3), nextCursor: 'p2' });
      return ok({ tools: tools.slice(3) });
    }
    case 'tools/call': {
      const { name, arguments: a } = m.params || {};
      if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo: ${a?.text}` }] });
      if (name === 'boom') return ok({ isError: true, content: [{ type: 'text', text: 'it broke' }] });
      if (name === 'pic') return ok({ content: [{ type: 'text', text: 'a picture' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] });
      if (name === 'slow') { setTimeout(() => { if (!cancelled.has(m.id)) ok({ content: [{ type: 'text', text: 'slow done' }] }); }, 5000); return; }
      if (name === 'grow') { extra = true; ok({ content: [{ type: 'text', text: 'grown' }] }); send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); return; }
      if (name === 'crash') { console.error('fatal: fixture crashed on purpose'); process.exit(3); }
      if (name === 'env') return ok({ content: [{ type: 'text', text: String(process.env.FIXTURE_TOKEN || '') }] });
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
    case 'ping': return ok({});
    default: return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
