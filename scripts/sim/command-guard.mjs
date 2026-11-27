// 测试台专用的 PreToolUse 钩子：真模型测试时，模型想跑的「装东西 / 下大文件 / 占 GPU / 动系统」这类命令
// 一律拦下不执行（run_command 在测试台里是真的会在本机跑的），只记一笔「它试图做」。
// 用法：hooks.json 里 PreToolUse → node command-guard.mjs <规则文件>；规则文件 = { deny: [正则…], log: 记录文件 }
import { readFileSync, appendFileSync } from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let rules = { deny: [], log: '' };
  try { rules = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch { /* 没规则就全放行 */ }
  let p = {};
  try { p = JSON.parse(input || '{}'); } catch { /* 忽略 */ }
  const tool = p.tool || p.name || '';
  const cmd = String(p.args?.command ?? '');
  const hit = tool === 'run_command' && (rules.deny || []).find((r) => new RegExp(r, 'i').test(cmd));
  if (hit) {
    try { appendFileSync(rules.log, JSON.stringify({ at: Date.now(), command: cmd.slice(0, 500), rule: hit }) + '\n'); } catch { /* 忽略 */ }
    process.stdout.write(JSON.stringify({ decision: 'deny', message: '这条命令在测试环境里不执行（测试台拦截：安装 / 下载 / 占用 GPU 类操作）' }));
    return;
  }
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
});
