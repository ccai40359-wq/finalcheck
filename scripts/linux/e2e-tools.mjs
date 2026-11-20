// Linux 真机 E2E：验证 agent 工具链在 Linux 上真的能用（不只是测试绿）。
// 重点验三件事：
//   1. run_command 走的是真 bash（不是 dash）—— [[ ]]、数组、$'...' 必须能跑
//   2. 项目外路径被边界闸拒绝（这是 WSL 真机才暴露的那个 bug）
//   3. grep_code 在没装 rg 时回退到 GNU grep
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log(ok ? `  PASS ${label}` : `  FAIL ${label} ${detail}`);
  if (!ok) fails.push(label);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-linux-e2e-'));
await fs.writeFile(path.join(dir, 'a.js'), [
  'export const x = 1;',
  'const needle = "hello";',
  ''
].join('\n'));

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const { createAgentTools } = await import(path.join(ROOT, 'desktop/src/main/agent-tools.mjs'));
const { createPolicy } = await import(path.join(ROOT, 'desktop/src/main/policy.mjs'));

const tools = createAgentTools({
  repoRoot: dir,
  projectPath: dir,
  policy: createPolicy({ projectPath: dir, mode: 'workspace' }),
  permissions: { requestApproval: async () => 'allowed-once' },
  recordAudit: async () => {}
});

// ① 真 bash 语法：[[ ]] + 数组 + $'...'
//
// ⚠️ 构造陷阱（2026-11-20 踩过两次）：不要在 JS 模板字符串里写 `${#arr[@]}` ——
// `$${...}` 会变成 `$` + 插值，丢花括号，得 `$#arr[@]`（bash 报 value too great for base）。
// 用纯字符拼接保证逐字节正确。
// 不带 `[[ x =~ y ]]`：那个 `~` 会被 FC 路径闸拦掉（既有缺陷，与 shell 无关）。
const D = String.fromCharCode(36);   // '$'
const L = String.fromCharCode(123);  // '{'
const R = String.fromCharCode(125);  // '}'
const H = String.fromCharCode(35);   // '#'
const BS = String.fromCharCode(92);  // '\'
const arrLen = D + L + H + 'arr[@]' + R;         // ${#arr[@]}
const escapedTab = D + "'tab" + BS + "there'";   // $'tab\there'
const bashScript = [
  'arr=(a b c)',
  `if [[ ${arrLen} -eq 3 ]]; then echo COUNT_OK; else echo COUNT_FAIL; fi`,
  `printf '%s' ${escapedTab} > /dev/null && echo ESCAPE_OK`,
  'echo $((3+4)) | grep -q 7 && echo ARITH_OK'
].join('\n');
const r1 = await tools.run_command({ command: bashScript });
if (process.env.FC_DIAG === '1') {
  console.log('[diag] bashScript =', JSON.stringify(bashScript));
  console.log('[diag] code =', r1.code, '| out =', JSON.stringify(String(r1.stdout || '')), '| err =', JSON.stringify(String(r1.stderr || '').slice(0, 200)));
}
const out1 = String(r1.stdout || '');
check(out1.includes('COUNT_OK'), 'bash 数组 + [[ ]] 可用（不是 dash）', JSON.stringify(out1.slice(0, 80)));
check(out1.includes('ESCAPE_OK'), "bash $'...' 转义可用", JSON.stringify(out1.slice(0, 80)));
check(out1.includes('ARITH_OK'), 'bash 算术可用', JSON.stringify(out1.slice(0, 80)));

// ② 管道 / 重定向 / 退出码
const r2 = await tools.run_command({ command: 'echo hi | tr a-z A-Z; echo "exit=$?"' });
check(String(r2.stdout || '').includes('HI'), '管道可用');

// ③ 项目外路径必须被拒（WSL 真机暴露的 bug 1）
const r3 = await tools.run_command({ command: 'cat /etc/passwd' });
check(!!r3.deniedBy, '项目外路径被边界闸拒绝', String(r3.deniedBy || 'none'));

// ④ 敏感路径必须被拒
const r4 = await tools.run_command({ command: 'cat ~/.ssh/id_rsa' });
check(!!r4.deniedBy, '敏感路径被拒绝', String(r4.deniedBy || 'none'));

// ⑤ 项目内正常读写
const r5 = await tools.read_file({ path: path.join(dir, 'a.js') });
check(!r5.error && String(r5.content || '').includes('needle'), '项目内 read_file 正常');

// ⑥ grep_code 回退（把 rg 指到目录，强制走 grep）
process.env.FINALCHECK_RG_PATH = dir;
const g1 = await tools.grep_code({ pattern: 'needle', path: dir });
check(/grep/i.test(String(g1.engine || '')), `没 rg 时回退 GNU grep（engine=${g1.engine}）`);
check(g1.total >= 1, 'grep 命中至少 1 行', String(g1.total));
// GNU grep 支持正则，不该出现 literal-only 提示
check(!/literal-only/i.test(String(g1.note || '')), 'GNU grep 不该标 literal-only');
delete process.env.FINALCHECK_RG_PATH;

// ⑦ 恢复 rg 后走 ripgrep
const g2 = await tools.grep_code({ pattern: 'needle', path: dir });
check(/ripgrep/i.test(String(g2.engine || '')), `有 rg 时走 ripgrep（engine=${g2.engine}）`);

await fs.rm(dir, { recursive: true, force: true });

console.log(`\n===== ${fails.length === 0 ? 'PASS' : 'FAIL ' + fails.length} =====`);
if (fails.length) process.exitCode = 1;
