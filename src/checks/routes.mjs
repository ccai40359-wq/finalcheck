// S1 鉴权覆盖：吃路由提取器输出，逐接口判守卫。白名单=publicRoutes
// 常见天然公开接口：命中则给白名单引导，降噪（2026-11-07 爬虫仓实测 91 条里一大半是这类）
const PUBLIC_HINT = /(login|logout|register|signup|auth\/|ping|health|status|version|metrics|docs|openapi)/i;

export async function checkAuthCoverage(routeResult) {
  const findings = [];
  for (const r of routeResult.routes || []) {
    if (r.method === 'use') continue; // 装配路径不是独立接口
    if ((routeResult.publicRoutes || []).includes(r.path)) continue;
    if (!r.hasGuard) {
      const hint = PUBLIC_HINT.test(r.path) ? '（常见公开接口：确认后登记进 finalcheck.config.json 的 publicRoutes 即可消除）' : '';
      findings.push({ checkId: 'S1', severity: 'high', force: 'card', file: r.file, line: r.line, rule: 'S1.no-guard', snippet: `${r.method.toUpperCase()} ${r.path}`, message: `接口无登录守卫${hint}`, source: 'program' });
    }
  }
  return { checkId: 'S1', findings, coverageGap: routeResult.warnings?.length ? `路由提取警告 ${routeResult.warnings.length} 条` : null };
}
