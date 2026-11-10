// SPA 兜底靶子（复现真站自查的假阳）：
//   任何未知路径都回 200 + 同一份 index.html（Vite/Next/CRA dev server 的默认行为）
//   /debug 是真的调试页（与首页不同的 HTML）——必须仍被判定为「可未授权访问」
//   /api/admin 401、/api/orders 302 —— 都不算复现
import http from 'node:http';

const shell = '<!doctype html><html><head><meta charset="utf-8"><title>app</title></head><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>';
const debug = '<!doctype html><html><body><h1>Debug</h1><pre>ENV=dev\nX-Debug: on\nstack: at handler (/srv/app.js:42:7)</pre></body></html>';

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/admin') { res.statusCode = 401; res.end('no'); return; }
  if (url === '/api/orders') { res.statusCode = 302; res.setHeader('location', '/login'); res.end(); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(url === '/debug' ? debug : shell);
});

export default server;
