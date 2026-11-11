import { DIMENSIONS } from './profile.mjs';
import { truncationNotCoveredLine } from './report-caps.mjs';

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

// 「低优先建议」聚合时用的短标签：报告里按规则聚成一行，避免 700+ 条逐条刷屏。
// 未登记的规则统一计入「其他」，--show-low 时仍能看到每一条原文。
const RULE_SUGGESTION_LABEL = {
  'Q4.naming': '命名',
  'Q4.fn-length': '函数过长',
  'Q4.duplicate-string': '重复字符串',
  'Q4.magic-number': '魔法数字',
  'Q4.nesting-depth': '嵌套过深',
  'Q4.comment-density': '注释过少',
  'Q4.ts-any': 'any 类型',
  'Q4.ts-ignore': 'ts-ignore',
  'Q3.unused-export': '未使用导出',
  'Q3.duplicate-block': '重复代码块',
  'Q3.large-file': '超大文件',
  'Q3.import-cycle': '循环依赖',
  'Q5.await-in-loop': '循环内 await',
  'Q5.n-plus-one': 'N+1 查询',
  'Q5.sync-io-hotpath': '热路径同步 IO',
  'Q5.json-deep-clone': 'JSON 深拷贝',
};
const MAX_NAMED_LOW_GROUPS = 8;

const isBlockingFinding = (f) => f.force === 'card' || f.severity === 'high';

// 三层：会卡交付的（card 或 high）→ 需要人工判断的（medium）→ 低优先建议（其余 low）。
// 被上层吸收的条目不会重复出现在下层，保证三层条数相加 = findings 总数。
function splitFindingLayers(findings) {
  const blocking = findings.filter(isBlockingFinding);
  const manual = findings.filter((f) => !isBlockingFinding(f) && f.severity === 'medium');
  const low = findings.filter((f) => !isBlockingFinding(f) && f.severity !== 'medium');
  return { blocking, manual, low };
}

function lowSuggestionSummary(low) {
  const groups = new Map();
  for (const f of low) groups.set(f.rule, (groups.get(f.rule) || 0) + 1);
  const known = [];
  let other = 0;
  for (const [rule, count] of groups) {
    const label = RULE_SUGGESTION_LABEL[rule];
    if (label) known.push([label, count]);
    else other += count;
  }
  known.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = known.slice(0, MAX_NAMED_LOW_GROUPS);
  const omitted = known.slice(MAX_NAMED_LOW_GROUPS).reduce((sum, [, count]) => sum + count, 0);
  const parts = shown.map(([label, count]) => `${label} ${count}`);
  if (omitted + other) parts.push(`其他 ${omitted + other}`);
  return `风格与可读性建议 ${low.length} 条（${parts.join(' / ')}），默认不展开`;
}

function lowSectionHint(count) {
  return `- 展开全文：加 \`--show-low\` 重新运行（共 ${count} 条全部保留在 JSON findings 中，未删除）`;
}

const gapText = (g) => {
  const reason = String(g.reason ?? g.text ?? '');
  return reason.startsWith(`${g.checkId}：`) ? reason : `${g.checkId}：${reason}`;
};

const gapItemsOf = (res) => res.gates.gapItems || [];
const reasonOf = (g) => {
  const reason = String(g.reason ?? g.text ?? '');
  return reason.startsWith(`${g.checkId}：`) ? reason.slice(g.checkId.length + 1) : reason;
};

// N/A 是「结构上不适用」，不是「能力缺失」也不是「待授权」；但必须点名它没验证。
// 维度报告与老格式报告共用这段文案。
function notApplicableLines(res) {
  return gapItemsOf(res)
    .filter((g) => g.kind === 'not-applicable')
    .map((g) => `- ${g.checkId} 不适用：${reasonOf(g)}（该项未验证，需人工确认）`);
}

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
  const naIds = new Set(gapItemsOf(res).filter((g) => g.kind === 'not-applicable').map((g) => g.checkId));
  // N/A 不是「该跑没跑」：从「未跑」列表里摘出来，单独写「不适用」。
  const notRun = planned.filter((id) => !executed.includes(id) && !naIds.has(id));
  const notApplicable = planned.filter((id) => !executed.includes(id) && naIds.has(id));
  const notEnabled = Object.keys(CHECK_TITLE).filter((id) => !planned.includes(id));
  return `本轮覆盖：${executed.join('/') || '无'}`
    + (notRun.length ? `；未跑：${notRun.join('/')}` : '')
    + (notApplicable.length ? `；不适用：${notApplicable.join('/')}` : '')
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
  const notApplicable = gapItems.filter((g) => g.kind === 'not-applicable');
  const unavailable = gapItems.filter((g) => g.kind !== 'unauthorized' && g.kind !== 'not-applicable');
  for (const g of pendingAuth) L.push(`  🟡 待授权：${gapText(g)}`);
  // 结构上不适用不是「覆盖不足」：单独提示，避免桌面项目被误读成没查
  for (const g of notApplicable) L.push(`  ℹ️ 不适用：${gapText(g)}`);
  for (const g of unavailable) L.push(`  ⚠️ 覆盖不足：${gapText(g)}`);
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

function pushLegacyLayer(L, title, items, hint) {
  L.push('');
  L.push(`## ${title}（${items.length} 条${hint}）`);
  if (!items.length) {
    L.push('- 无');
    return;
  }
  for (const f of items) L.push(...legacyFindingBlock(f));
}

function renderLegacyLow(L, low, showLow) {
  L.push('');
  L.push(`## 风格与可读性建议（低优先，共 ${low.length} 条${showLow ? '，已展开' : '，默认不展开'}）`);
  if (!low.length) {
    L.push('- 无');
    return;
  }
  if (showLow) {
    for (const f of low) L.push(...legacyFindingBlock(f));
    return;
  }
  // 折叠只影响默认展示：条数与规则分布必须写清，--show-low 可逐条查看，JSON 里也一条不少
  L.push(`- ${lowSuggestionSummary(low)}`);
  L.push(lowSectionHint(low.length));
}

// 无 profile：按严重度分层输出。默认折叠低优先建议，避免 700+ 条把报告刷成噪声；
// 卡条目/高危永远在最前面且带 file:line，不因折叠而丢失。
function renderLegacyReport(res, { showLow = false } = {}) {
  const L = headerLines(res);
  const findings = sortedFindings(res);
  L.push('');
  L.push(coverageLine(res));
  if (!findings.length) {
    L.push('未发现程序可判定的问题。');
  } else {
    const layers = splitFindingLayers(findings);
    pushLegacyLayer(L, '会卡交付的', layers.blocking, '：force=card 或 severity=high');
    pushLegacyLayer(L, '需要人工判断的', layers.manual, '：medium');
    renderLegacyLow(L, layers.low, showLow);
  }
  // 老格式没有完整的 Not covered 段：reportCaps 截断或结构性 N/A 时补一段
  const naLines = notApplicableLines(res);
  if ((res.reportTruncations && res.reportTruncations.length) || naLines.length) {
    L.push('');
    L.push('## Not covered');
    L.push(...(res.reportTruncations || []).map((tr) => truncationNotCoveredLine(tr)));
    L.push(...naLines);
  }
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
    // N/A 显示「不适用」，不能混进「未跑」（那是该跑没跑的意思）
    const na = notRun.filter((id) => gapItems.some((g) => g.checkId === id && g.kind === 'not-applicable'));
    const pending = notRun.filter((id) => !na.includes(id));
    let covered = checks.length ? checks.join('、') : '无（该档位不要求检查）';
    if (pending.length) covered += `（未跑：${pending.join('、')}）`;
    if (na.length) covered += `（不适用：${na.join('、')}）`;
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

function appendDimensionGroups(L, res, list) {
  const groups = groupFindings(res, list);
  let first = true;
  for (const [name, group] of groups) {
    if (!group.length) continue;
    if (!first) L.push('');
    first = false;
    L.push(`### ${clean(name)}`);
    for (const f of group) L.push(...dimensionFindingBlock(f));
  }
}

function appendDimensionLayer(L, res, title, list, hint) {
  L.push('');
  L.push(`**${title}（${list.length} 条${hint}）**`);
  if (!list.length) {
    L.push('- 无');
    return;
  }
  appendDimensionGroups(L, res, list);
}

// 维度报告与老格式共用同一套三层：维度表在前，Findings 里按「卡交付 → 人工判断 → 低优先折叠」排。
function appendLayeredFindings(L, res, showLow) {
  const findings = sortedFindings(res);
  if (!findings.length) {
    L.push('未发现程序可判定的问题。');
    return;
  }
  const layers = splitFindingLayers(findings);
  appendDimensionLayer(L, res, '会卡交付的', layers.blocking, '：force=card 或 severity=high');
  appendDimensionLayer(L, res, '需要人工判断的', layers.manual, '：medium');
  L.push('');
  L.push(`**风格与可读性建议（低优先，共 ${layers.low.length} 条${showLow ? '，已展开' : '，默认不展开'}）**`);
  if (!layers.low.length) {
    L.push('- 无');
  } else if (showLow) {
    appendDimensionGroups(L, res, layers.low);
  } else {
    L.push(`- ${lowSuggestionSummary(layers.low)}`);
    L.push(lowSectionHint(layers.low.length));
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
  // 显式 reportCaps 真的截断时，未列出的发现也属于「没覆盖」：报告正文必须点名，不能只藏在 warnings
  for (const tr of res.reportTruncations || []) out.push(truncationNotCoveredLine(tr));
  // 结构性不适用：结论不被封顶，但必须在 Not covered 点名「该项未验证」
  out.push(...notApplicableLines(res));
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
  return gapItemsOf(res).map((g) => {
    const label = g.kind === 'unauthorized'
      ? '待授权，未执行'
      : g.kind === 'not-applicable' ? '不适用，未验证' : '能力缺失，未执行';
    return `- ${gapText(g)}（${label}）`;
  });
}

function renderDimensionReport(res, { showLow = false } = {}) {
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
  appendLayeredFindings(L, res, showLow);
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

export function renderReport(res, options = {}) {
  // 触发条件按约定只看 tier.dimensions：有 profile 才换维度视图；
  // options.showLow 只影响默认展示（false=折叠低优先建议），不删除任何 findings。
  if (res.tier && res.tier.dimensions) return renderDimensionReport(res, options);
  return renderLegacyReport(res, options);
}
