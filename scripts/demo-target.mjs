// 演示靶场启动器：复用 tests/fixtures/dynamic-target 的本地测试应用
// 用途：给 FinalCheck 的渗透探测/压测一个真靶子（无守卫接口 + CORS 全开 + 无安全头）
import server from '../tests/fixtures/dynamic-target/app.mjs';

const PORT = 3210;
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('✅ 演示靶场已就绪：http://localhost:' + PORT);
  console.log('   无守卫接口：GET /api/users（返回用户列表，无需登录）');
  console.log('   CORS 全开 / 无任何安全头 —— 专供探测复现');
  console.log('   停止：Ctrl+C');
  console.log('');
});
