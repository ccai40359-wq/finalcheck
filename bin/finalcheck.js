#!/usr/bin/env node
import { statSync } from 'node:fs';
import path from 'node:path';
import { audit, loadConfig } from '../src/audit.mjs';
import { renderReport } from '../src/report.mjs';

const args = process.argv.slice(2);
const cmd = args[0];

// 入参目录：规范化 + 必须真实存在且是目录（resolve 已折叠相对段）
function resolveRoot(arg) {
  const root = path.resolve(arg && !arg.startsWith('--') ? arg : '.');
  try {
    if (!statSync(root).isDirectory()) {
      console.error('不是目录: ' + root);
      process.exit(2);
    }
  } catch {
    console.error('目录不存在: ' + root);
    process.exit(2);
  }
  return root;
}

if (cmd === 'scan-download') {
  const root = resolveRoot(args[1]);
  const { scanDownload } = await import('../src/download-gate.mjs');
  const cfg = await loadConfig(root);
  const out = await scanDownload(root, { excludes: cfg.exclude || [] });
  console.log('\n[下载闸体检]', root);
  if (!out.findings.length) console.log('OK: 未发现安装脚本/投毒信号/注入痕迹');
  const SEV = { high: '[HIGH]', medium: '[MED]', low: '[LOW]' };
  for (const f of out.findings) {
    console.log(SEV[f.severity] + ' ' + f.checkId + ' ' + f.message);
    console.log('   证据: ' + f.file + (f.line ? ':' + f.line : '') + '  ' + String(f.snippet || '').slice(0, 100));
  }
  for (const w of out.warnings) console.log('INFO ' + w);
  process.exitCode = out.findings.some((f) => f.severity === 'high') ? 1 : 0;
} else if (cmd === 'audit') {
  const root = resolveRoot(args[1]);
  const tierIdx = args.indexOf('--tier');
  let tier = tierIdx > -1 ? args[tierIdx + 1] : null;
  if (tier && !['L1', 'L2', 'L3'].includes(tier)) {
    console.error('未知档位 ' + tier + '，回落自动定档');
    tier = null;
  }
  const asJson = args.includes('--json');
  const interactive = args.includes('--interactive') || Boolean(process.stdin.isTTY);
  const runTests = !args.includes('--no-tests'); // 审计外部项目必须 --no-tests（§7 禁跑被审代码）
  const res = await audit(root, { tier, interactive, runTests });
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else console.log(renderReport(res));
  // 退出码：0 过 / 1 拦 / 2 修完再过 / 3 无法验收（能力缺失）/ 4 待授权（缺用户点头，例如未跑测试）
  const EXIT = { '过': 0, '拦': 1, '修完再过': 2, '无法验收': 3, '待授权': 4 };
  process.exitCode = EXIT[res.conclusion.verdict] ?? 1;
} else {
  console.log('用法: finalcheck audit <目录> [--tier L1|L2|L3] [--json] [--interactive]');
  console.log('      finalcheck scan-download <目录>');
  process.exit(2);
}
