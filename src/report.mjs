const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const SEV_MARK = { high: '🔴 高危', medium: '🟡 中危', low: '🔵 低危' };
const VERDICT_MARK = { '拦': '🔴 拦', '修完再过': '🟠 修完再过', '过': '🟢 过', '无法验收': '⚠️ 无法验收', '待授权': '🟡 待授权' };
const CHECK_TITLE = {
  S1: '鉴权覆盖', S2: '注入类', S3: '密钥与弱默认', S4: '依赖 CVE', S5: '危险配置',
  S6: '外部入口', S7: '越权(IDOR)', S8: '密码与会话', D1: '事务', D2: '备份恢复', D3: '隐私',
  Q1: '测试关', Q2: '质量命令闸',
  H1: '交接就绪', Q3: '可维护性度量', C1: '许可证合规', O1: '运维就绪',
};
// 「待授权」不是失败，是缺用户点头：下一步必须写清楚要授权什么
const AUTH_STEP = { Q1: 'Q1 需要执行项目测试', Q2: 'Q2 需要执行项目质量命令' };

const gapText = (g) => {
  const reason = String(g.reason ?? g.text ?? '');
  return reason.startsWith(`${g.checkId}：`) ? reason : `${g.checkId}：${reason}`;
};

function fixPrompt(f) {
  switch (f.rule) {
    case 'S3.aws-key':
    case 'S3.private-key':
    case 'S3.secret-literal':
    case 'S3.env-tracked':
      return '把密钥移入 .env（并确认 .gitignore 含 .env），代码改用 process.env 读取；若该密钥曾提交过 git，视为已泄漏，立即作废并轮换。';
    case 'S3.weak-default':
      return '改用强随机口令（≥16 位）并从环境变量读取，禁止任何默认弱口令。';
    case 'S1.no-guard':
      return `给 ${f.snippet} 挂登录守卫中间件（如 requireAuth）；确属公开接口，登记进 finalcheck.config.json 的 publicRoutes。`;
    case 'S5.cors-wildcard':
      return 'CORS 改为显式域名白名单，禁止 *。';
    case 'S5.no-rate-limit':
      return '接入限流（如 express-rate-limit），至少覆盖登录与全部写接口。';
    case 'S4.cve': {
      const pkg = f.snippet.split(' ')[0];
      return `升级 ${pkg} 到已修复版本（npm audit fix 或手动调整版本号后重装）。`;
    }
    default:
      return '按发现内容修复，并说明修复理由。';
  }
}

export function renderReport(res) {
  const L = [];
  L.push('');
  L.push(`【${VERDICT_MARK[res.conclusion.verdict] || res.conclusion.verdict}】结论：${res.conclusion.verdict}`);
  L.push(`理由：${res.conclusion.reason}`);
  L.push('');
  L.push(`项目：${res.projectDir}`);
  const t = res.tier;
  L.push(`档位：${t.effective}${t.requested ? '（指定）' : `（自动建议 ${t.suggested}${t.conservativeNote ? '，保守加档' : ''}）`}`);
  if (t.signals.length) L.push(`定档信号：${t.signals.join('；')}`);
  L.push(`覆盖：${res.gates.executed.join('、') || '无'}（计划 ${res.gates.planned.join('、')}）`);
  // 未授权与能力缺失分开显示：前者是「等你点头」，后者是「本机跑不了」
  const gapItems = res.gates.gapItems
    || (res.gates.gaps || []).map((g) => ({ checkId: String(g).split('：')[0] || '?', reason: g, kind: 'unavailable' }));
  const pendingAuth = gapItems.filter((g) => g.kind === 'unauthorized');
  for (const g of pendingAuth) L.push(`  🟡 待授权：${gapText(g)}`);
  for (const g of gapItems.filter((x) => x.kind !== 'unauthorized')) L.push(`  ⚠️ 覆盖不足：${gapText(g)}`);
  if (pendingAuth.length) {
    const steps = pendingAuth.map((g) => AUTH_STEP[g.checkId] || `${g.checkId} 需要授权执行`);
    L.push(`下一步：授权后重跑：${steps.join('；')}`);
  }
  // 同类警告聚合刷屏（现场演示教训：跳过提示按文件逐条刷了几十行）
  const wGroups = {};
  for (const w of res.warnings) {
    const key = w.includes('：') ? w.split('：')[0] : w;
    wGroups[key] = (wGroups[key] || 0) + 1;
  }
  for (const [key, n] of Object.entries(wGroups)) L.push(`  ℹ️ ${key}（共 ${n} 条，` + (key.includes('跳过') ? '已排除出扫描范围' : '详见 JSON 输出') + '）');

  const findings = [...res.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  if (!findings.length) {
    // 兜底文案必须由本轮实际计划/执行列表生成：写死「S2/S6-S8 未启用」早已过时（S2/S7/S8 都已启用）
    const executed = res.gates.executed || [];
    const planned = res.gates.planned || [];
    const notRun = planned.filter((id) => !executed.includes(id));
    const notEnabled = Object.keys(CHECK_TITLE).filter((id) => !planned.includes(id));
    L.push('');
    L.push('未发现程序可判定的问题。' + `本轮覆盖：${executed.join('/') || '无'}`
      + (notRun.length ? `；未跑：${notRun.join('/')}` : '')
      + (notEnabled.length ? `；未启用：${notEnabled.join('/')}` : '') + '。');
  }
  const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ''); // P1#6：审外部项目时证据是不可信输入，防 ANSI/控制字符重绘终端
  for (const f of findings) {
    L.push('');
    L.push(`${SEV_MARK[f.severity]}｜${CHECK_TITLE[f.checkId] || f.checkId}（${f.checkId}）｜${clean(f.message)}`);
    L.push(`   证据：${clean(f.file)}${f.line ? ':' + f.line : ''}  ${clean(f.snippet)}`);
    L.push(`   判定来源：${f.rule}（${f.force === 'card' ? '程序判定/实锤' : '提醒级线索'}）`);
    L.push(`   修复提示词（粘回 AI）：${fixPrompt(f)}`);
  }
  L.push('');
  return L.join('\n');
}
