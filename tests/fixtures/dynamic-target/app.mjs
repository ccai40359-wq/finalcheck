// 动态测试靶子：故意无守卫 + CORS 全开 + 无安全头。零依赖 node:http，listen(0) 随机端口
import http from 'node:http';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = (req.url || '/').split('?')[0];
  if (url === '/') {
    res.setHeader('content-type', 'text/html');
    res.end('<html>target</html>'); // 无任何安全头
  } else if (url === '/api/users') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ id: 1, name: 'a' }, { id: 2, name: 'b' }])); // 无守卫
  } else if (url === '/api/healthz') {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  } else if (url === '/api/fail') {
    res.statusCode = 500;
    res.end('boom'); // 压测错误统计用：4xx/5xx 必须计入 errors
  } else {
    res.statusCode = 404;
    res.end('nf');
  }
});

export default server;
