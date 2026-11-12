#!/usr/bin/env node
// FinalCheck 下载闸（Claude Code PreToolUse hook，与交活闸 gate.mjs 并列的第二个 Bash hook）
// stdin = hook 事件 JSON：{ tool_name, tool_input: { command } }
// 拦 npm install / npx（含 sudo/env/shell 包装前缀）：先查 registry 安装脚本（X1）与投毒信号（X3），
// 有高危或存在未验证范围 → exit 2 阻止；registry/下载量查询失败等覆盖缺口按 fail-closed 处理。
import { inspectInstallCommand } from '../../src/download-gate.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const evt = JSON.parse(raw || '{}');
    const cmd = String(evt?.tool_input?.command || '');
    const result = await inspectInstallCommand(cmd, { cwd: evt.cwd || process.cwd() });
    if (!result.applicable) process.exit(0);
    const blockers = result.findings.filter((f) => f.severity === 'high');
    if (blockers.length || result.coverageGap) {
      console.error(`[FinalCheck 下载闸] 安装已拦截：${blockers.length} 条高危信号${result.coverageGap ? '，且有未验证范围' : ''}。请核实后重试。`);
      if (result.coverageGap) console.error(`  未验证：${result.coverageGap}`);
      for (const f of blockers.slice(0, 10)) {
        console.error(`  - ${f.message}`);
        console.error(`    证据：${f.snippet}`);
      }
      if (result.warnings.length) console.error(`  （提示：${result.warnings[0]}）`);
      process.exit(2);
    }
    if (result.warnings.length) console.error(`[FinalCheck 下载闸] ${result.warnings.join('；')}`);
    process.exit(0);
  } catch (e) {
    console.error(`[FinalCheck 下载闸] 检查失败，安装未验证，已拦截（${e.message}）`);
    process.exit(2);
  }
});
