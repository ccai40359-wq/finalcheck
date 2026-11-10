import { listTextFiles, readRel } from '../walk.mjs';

// S5 危险配置（CORS *、debug、限流缺失）。L2 起 CORS 一律非 *（reviewer 修正案）
export async function checkConfig(projectDir, tier, { excludes = [] } = {}) {
  const findings = [];
  const { files, skipped } = await listTextFiles(projectDir, excludes);
  const warnings = skipped.length ? [`跳过大文件 ${skipped.length} 个（>512KB 未扫描）`] : [];
  let sawRateLimit = false;
  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    if (/package-lock|yarn\.lock|pnpm-lock/.test(file)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/finalcheck:allow/.test(line)) continue;
      if (tier !== 'L1' && /origin:\s*['"]\*['"]|Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]/.test(line)) {
        findings.push({ checkId: 'S5', severity: 'medium', force: 'card', file, line: i + 1, rule: 'S5.cors-wildcard', snippet: line.trim().slice(0, 120), message: 'CORS 允许任意来源 (*)', source: 'program' });
      }
      if (/express-rate-limit|rateLimit\(|rate-limit/.test(line)) sawRateLimit = true;
      if (/\bDEBUG\b\s*[:=]\s*['"]?true|\bdebug\s*:\s*true\b/i.test(line)) { // P1#9：补矩阵 S5 的 debug 子项
        findings.push({ checkId: 'S5', severity: 'medium', force: 'card', file, line: i + 1, rule: 'S5.debug-on', snippet: line.trim().slice(0, 120), message: 'debug 模式开启', source: 'program' });
      }
    }
  }
  if (tier === 'L3' && !sawRateLimit) {
    findings.push({ checkId: 'S5', severity: 'medium', force: 'card', file: '(全仓搜索)', line: 0, rule: 'S5.no-rate-limit', snippet: '全仓未发现限流引用', message: '未接入限流', source: 'program' });
  }
  return { checkId: 'S5', findings, coverageGap: null, warnings };
}
