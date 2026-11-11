import { DIMENSIONS } from './profile.mjs';

const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const SEV_MARK = { high: '🔴 高危', medium: '🟡 中危', low: '🔵 低危' };
const VERDICT_MARK = { '拦': '🔴 拦', '修完再过': '🟠 修完再过', '过': '🟢 过', '无法验收': '⚠️ 无法验收', '待授权': '🟡 待授权' };
const CHECK_TITLE = {
  S1: '鉴权覆盖', S2: '注入类', S3: '密钥与弱默认', S4: '依赖 CVE', S5: '危险配置',
  S6: '外部入口', S7: '越权(IDOR)', S8: '密码与会话', D1: '事务', D2: '备份恢复', D3: '隐私',
  Q1: '测试关', Q2: '质量命令闸',
  H1: '交接就绪', Q3: '可维护性度量', Q4: '可读性度量', Q5: '性能反模式', C1: '许可证合规', O1: '运维就绪',
};
// 「待授权」不是失败，是缺用户点头：下一步必须写清楚要授权什么
const AUTH_STEP = { Q1: 'Q1 需要执行项目测试', Q2: 'Q2 需要执行项目质量命令' };
// 不在任何维度检查清单里的项（目前只有按 finalcheck.quality.json 追加的 Q2）单独成组，不硬塞给某个维度
const OTHER_GROUP = '其他检查';

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

// P1#6：审外部项目时证据是不可信输入，防 ANSI/控制字符重绘终端
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '');
const cell = (s) => clean(s).replace(/\|/g, '\\|');

function sortedFindings(res) {
  return [...res.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

function coverageLine(res) {
  const executed = res.gates.executed || [];
  const planned = res.gates.planned || [];
  const notRun = planned.filter((id) => !executed.includes(id));
  const notEnabled = Object.keys(CHECK_TITLE).filter((id) => !planned.includes(id));
  return `本轮覆盖：${executed.join('/') || '无'}`
    + (notRun.length ? `；未跑：${notRun.join('/')}` : '')
    + (notEnabled.length ? `；未启用：${notEnabled.join('/')}` : '') + '。';
}

// 报告头（结论/项目/档位/覆盖/缺口/警告）：旧输出与新输出共用，逐字保持一致。
function headerLines(res) {
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
  return L;
}

function legacyFindingBlock(f) {
  return [
    '',
    `${SEV_MARK[f.severity]}｜${CHECK_TITLE[f.checkId] || f.checkId}（${f.checkId}）｜${clean(f.message)}`,
    `   证据：${clean(f.file)}${f.line ? ':' + f.line : ''}  ${clean(f.snippet)}`,
    `   判定来源：${f.rule}（${f.force === 'card' ? '程序判定/实锤' : '提醒级线索'}）`,
    `   修复提示词（粘回 AI）：${fixPrompt(f)}`,
  ];
}

// 无 profile：保持原有按检查项输出，逐字不变（现有调用方与 780 测试依赖此格式）
function renderLegacyReport(res) {
  const L = headerLines(res);
  const findings = sortedFindings(res);
  L.push('');
  L.push(coverageLine(res));
  if (!findings.length) L.push('未发现程序可判定的问题。');
  for (const f of findings) L.push(...legacyFindingBlock(f));
  L.push('');
  return L.join('\n');
}

// ---------- 维度模式（有 profile：res.tier.dimensions 存在） ----------

function dimensionChecks(name, level) {
  return DIMENSIONS[name]?.[level]?.checks || [];
}

function evidenceOf(res, name) {
  const ev = res.evidence && res.evidence[name];
  return ev && ev.level ? ev : { level: 'unverified', reason: '未验证（未提供证据矩阵）' };
}

function dimensionTable(res, dims) {
  const executed = new Set(res.gates.executed || []);
  const gapItems = res.gates.gapItems || [];
  const rows = [
    '| 维度 | 档位 | 结论 | 证据等级 | 覆盖的检查项 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [name, d] of Object.entries(dims)) {
    const checks = dimensionChecks(name, d.level);
    const ev = evidenceOf(res, name);
    const notRun = checks.filter((id) => !executed.has(id) && gapItems.some((g) => g.checkId === id));
    let covered = checks.length ? checks.join('、') : '无（该档位不要求检查）';
    if (notRun.length) covered += `（未跑：${notRun.join('、')}）`;
    // 动态维度必须能一眼看出「实测过」还是「只是声明了授权」
    const dynamicNote = ev.dynamic
      ? (ev.dynamic.measured
        ? `实测：probe ${ev.dynamic.probe.count} 次 / stress ${ev.dynamic.stress.count} 次`
        : (ev.dynamic.declared ? '仅声明，本轮未实测' : '未授权，无实测'))
      : null;
    const evText = dynamicNote ? `${ev.level}（${dynamicNote}）` : ev.level;
    rows.push(`| ${cell(name)} | ${cell(d.level)} | ${cell(d.verdict)} | ${cell(evText)} | ${cell(covered)} |`);
  }
  return rows;
}

// 每个 checkId 归到「第一个包含它的维度」；Q2 这类不属于任何维度的检查进「其他检查」。
function groupFindings(res, findings) {
  const dims = res.tier.dimensions;
  const names = Object.keys(dims);
  const groups = new Map(names.map((name) => [name, []]));
  groups.set(OTHER_GROUP, []);
  for (const f of findings) {
    const owner = names.find((name) => dimensionChecks(name, dims[name].level).includes(f.checkId)) || OTHER_GROUP;
    groups.get(owner).push(f);
  }
  return groups;
}

function dimensionFindingBlock(f) {
  return [
    '',
    `${SEV_MARK[f.severity]}｜${clean(f.message)}`,
    `   证据：${clean(f.file)}${f.line ? ':' + f.line : ''}  ${clean(f.snippet)}`,
    `   判定来源：${f.rule}（${f.checkId}；${f.force === 'card' ? '程序判定/实锤' : '提醒级线索'}）`,
    `   修复提示词（粘回 AI）：${fixPrompt(f)}`,
  ];
}

function appendGroupedFindings(L, res) {
  const findings = sortedFindings(res);
  if (!findings.length) {
    L.push('未发现程序可判定的问题。');
    return;
  }
  const groups = groupFindings(res, findings);
  let first = true;
  for (const [name, list] of groups) {
    if (!list.length) continue;
    if (!first) L.push('');
    first = false;
    L.push(`### ${clean(name)}`);
    for (const f of list) L.push(...dimensionFindingBlock(f));
  }
}

function verifiedLines(res, dims) {
  const out = [];
  for (const [name, d] of Object.entries(dims)) {
    if (d.verdict !== '过') continue;
    const checks = dimensionChecks(name, d.level);
    const ev = evidenceOf(res, name);
    out.push(`- ${name}（${d.level}，证据 ${ev.level}）：检查 ${checks.length ? checks.join('、') : '无'} 已执行，未发现卡条目`);
  }
  return out;
}

// 「无法验收」必须带原因：维度缺口优先，其次证据面原因；证据等级 not-covered/unverified 的维度也一并点名。
function notCoveredLines(res, dims) {
  const out = [];
  const gapItems = res.gates.gapItems || [];
  for (const [name, d] of Object.entries(dims)) {
    const ev = evidenceOf(res, name);
    if (ev.level === 'not-covered' || ev.level === 'unverified') {
      out.push(`- 维度「${name}」证据等级 ${ev.level}：${ev.reason}`);
    }
    if (ev.dynamic && ev.dynamic.declared && !ev.dynamic.measured) {
      out.push(`- 维度「${name}」声明了动态授权，但本轮没有 probe/stress 记录，按 static-only 计（实测后才能升 full）`);
    }
    if (d.verdict === '无法验收') {
      const checks = dimensionChecks(name, d.level);
      const own = gapItems.filter((g) => g.dimension === name || checks.includes(g.checkId));
      // 缺口标签可能已带维度名（如「成本：该维度尚未接入检查」），避免写成「成本：成本：…」
      const raw = own.length ? own.map(gapText).join('；') : ev.reason;
      const reason = raw.startsWith(`${name}：`) ? raw.slice(name.length + 1) : raw;
      out.push(`- 维度「${name}」无法验收：${reason}`);
    }
  }
  return out;
}

function skippedLines(res) {
  const gapItems = res.gates.gapItems || [];
  return gapItems.map((g) => `- ${gapText(g)}（${g.kind === 'unauthorized' ? '待授权，未执行' : '能力缺失，未执行'}）`);
}

function renderDimensionReport(res) {
  const dims = res.tier.dimensions;
  const L = ['## Conclusion'];
  L.push(...headerLines(res));
  L.push('');
  L.push('维度结论表：');
  L.push(...dimensionTable(res, dims));
  L.push('');
  L.push(coverageLine(res));
  L.push('');
  L.push('## Findings');
  appendGroupedFindings(L, res);
  L.push('');
  L.push('## Verified');
  const verified = verifiedLines(res, dims);
  L.push(...(verified.length ? verified : ['None（没有维度达到「过」）']));
  L.push('');
  L.push('## Not covered');
  const notCovered = notCoveredLines(res, dims);
  L.push(...(notCovered.length ? notCovered : ['None（所有维度均已有证据）']));
  L.push('');
  L.push('## Skipped');
  const skipped = skippedLines(res);
  L.push(...(skipped.length ? skipped : ['None']));
  L.push('');
  return L.join('\n');
}

export function renderReport(res) {
  // 触发条件按约定只看 tier.dimensions：有 profile 才换维度视图，老调用方输出逐字不变。
  if (res.tier && res.tier.dimensions) return renderDimensionReport(res);
  return renderLegacyReport(res);
}
