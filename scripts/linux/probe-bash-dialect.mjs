// 只验一件事：run_command 在 Linux 上用的是真 bash（不是 dash）。
//
// 为什么值得单独验：run_command 的工具描述承诺「统一一种 shell 语法」，
// 模型会写数组、`$'...'`、进程替换、`[[ ]]`。Ubuntu/Debian 的 /bin/sh 是 dash，
// 这些全报语法错误。测试套件里 grep 不到这一点 —— 只有真机跑才有意义。
//
// 用法（Linux/macOS）：node scripts/linux/probe-bash-dialect.mjs
// 期望输出末行：BASH_ALL_OK
//
// 不带 `[[ x =~ y ]]` 这条：FC 的路径闸会把 `~` 当路径拦掉（既有缺陷，
// 见 LINUX-PORT-028.md），在这里断言只会得到一个与 shell 无关的假失败。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-bash-'));
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

// 每条命令独立，内容写死在数组里（不经过任何外层 shell 展开）。
// 注意：不带 `[[ x =~ y ]]` —— 那个 `~` 会被 FC 的路径闸拦掉（既有缺陷，
// 与 shell 是不是 bash 无关），带进来只会造成假失败。
const CASES = [
  { name: "bash 数组 + [[ ]]", cmd: 'arr=(a b c); if [[ ${#arr[@]} -eq 3 ]]; then echo COUNT_OK; else echo COUNT_FAIL; fi', want: 'COUNT_OK' },
  { name: "bash  $'...' 转义", cmd: "printf '%s' $'a\\tb' | od -c | head -1", want: '\\t' },
  { name: "bash 算术", cmd: 'echo $((3+4))', want: '7' },
  { name: "bash 进程替换", cmd: 'diff <(echo a) <(echo b) && echo SAME || echo DIFF', want: 'DIFF' },
  { name: "bash [[ ]] 字符串比较", cmd: 'if [[ "x" == "x" ]]; then echo IF_OK; fi', want: 'IF_OK' },
  { name: "参数默认值（dash 也有，对照用）", cmd: 'echo ${x:-default}', want: 'default' }
];

let bad = 0;
for (const c of CASES) {
  const r = await tools.run_command({ command: c.cmd });
  const out = String(r.stdout || '');
  const ok = out.includes(c.want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!ok) console.log(`      cmd=${JSON.stringify(c.cmd)}\n      code=${r.code} out=${JSON.stringify(out.slice(0, 120))} err=${JSON.stringify(String(r.stderr || '').slice(0, 120))}`);
}

await fs.rm(dir, { recursive: true, force: true });
console.log(bad === 0 ? 'BASH_ALL_OK' : `FAIL ${bad}`);
if (bad) process.exitCode = 1;
