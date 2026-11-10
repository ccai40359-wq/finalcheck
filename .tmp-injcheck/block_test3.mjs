// 只读：对比 shell.mjs isBlocked 与 policy.mjs checkCommand 对同一批灾难命令的判定
const { isBlocked } = await import('../desktop/src/main/shell.mjs');
const { checkCommand } = await import('../desktop/src/main/policy.mjs');
const R = ['rm', '-rf'].join(' ');
const cases = [
  R + ' /', R + ' /tmp', R + ' ./', R + ' ./*', R + ' ../', R + ' C:',
  R + ' -- /tmp', R + ' -i /home/u'
];
console.log('cmd | isBlocked(shell.mjs) | checkCommand(policy.mjs)');
for (const c of cases) {
  const p = checkCommand({ mode: 'workspace', projectPath: 'D:/x' }, c);
  console.log(JSON.stringify(c), '|', isBlocked(c), '|', p.ok ? 'ALLOW' : 'BLOCK:' + p.matchedRule);
}
