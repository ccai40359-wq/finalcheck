#!/usr/bin/env node
// FinalCheck 交活闸（Claude Code PreToolUse hook）
// stdin = hook 事件 JSON：{ tool_name, tool_input: { command } }
// 拦"交付类"命令：git commit / git push / npm publish 之前先体检，拦=exit 2 阻止
import { audit } from '../../src/audit.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const evt = JSON.parse(raw || '{}');
    const cmd = String(evt?.tool_input?.command || '');
    if (!/\bgit\b[^&|;]*\b(commit|push)\b|npm publish/.test(cmd)) process.exit(0);

    const res = await audit(process.cwd(), { interactive: false, runTests: false }); // hook 60s 超时内必须返回；Q1 留给显式 audit
    if (res.conclusion.verdict === '待授权') {
      // 未跑测试不等于有问题：hook 内跑不了测试，这里放行但必须把「没验什么」说清楚，不许静默通过
      console.error(`[FinalCheck 交活闸] 待授权（未阻断）：${res.conclusion.reason}`);
      for (const p of res.conclusion.pendingAuth || []) console.error(`  - ${p.checkId}：${p.reason}`);
      console.error('  提示：提交前手动跑 finalcheck audit --tier L2 并授权测试，才是真正的验收');
      process.exit(0);
    }
    if (res.conclusion.verdict === '拦' || res.conclusion.verdict === '无法验收') {
      console.error(`[FinalCheck 交活闸] ${res.conclusion.verdict}：${res.conclusion.reason}`);
      const highs = res.findings.filter((f) => f.severity === 'high').slice(0, 3);
      for (const f of highs) console.error(`  - ${f.file}:${f.line} ${f.message}`);
      process.exit(2);
    }
    console.error(`[FinalCheck 交活闸] ${res.conclusion.verdict}：${res.conclusion.reason}`);
    process.exit(0);
  } catch (e) {
    // 闸门自身故障不卡用户：fail-open + 明示
    console.error(`[FinalCheck 交活闸] 闸门异常，放行（${e.message}）`);
    process.exit(0);
  }
});
