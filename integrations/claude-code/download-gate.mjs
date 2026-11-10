#!/usr/bin/env node
// FinalCheck 下载闸（Claude Code PreToolUse hook，与交活闸 gate.mjs 并列的第二个 Bash hook）
// stdin = hook 事件 JSON：{ tool_name, tool_input: { command } }
// 拦 npm install / npx：先查 registry 安装脚本（X1）与投毒信号（X3），有高危 → exit 2 阻止
import { parseInstallCommand, scanSinglePackage } from '../../src/download-gate.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const evt = JSON.parse(raw || '{}');
    const cmd = String(evt?.tool_input?.command || '');
    const names = parseInstallCommand(cmd);
    if (!names.length) process.exit(0); // npm ci / 无包名 install：不在本闸范围

    const blockers = [];
    const warns = [];
    for (const name of names) {
      try {
        const r = await scanSinglePackage(name);
        for (const f of r.findings) if (f.severity === 'high') blockers.push({ name, f });
        warns.push(...r.warnings);
      } catch (e) {
        warns.push(`${name}: ${e.message}`);
      }
    }

    if (blockers.length) {
      console.error(`[FinalCheck 下载闸] 发现 ${blockers.length} 条高危信号，安装已拦截。装前建议人工确认：`);
      for (const { f } of blockers.slice(0, 10)) {
        console.error(`  - ${f.message}`);
        console.error(`    证据：${f.snippet}`);
      }
      if (warns.length) console.error(`  （提示：${warns[0]}）`);
      process.exit(2);
    }
    if (warns.length) console.error(`[FinalCheck 下载闸] 放行，但注意：${warns.join('；')}`);
    process.exit(0);
  } catch (e) {
    // 下载闸自身故障不卡用户：fail-open 放行 + stderr 明示
    console.error(`[FinalCheck 下载闸] 下载闸自身异常，放行（${e.message}）`);
    process.exit(0);
  }
});
