#!/usr/bin/env node
import { statSync } from 'node:fs';
import path from 'node:path';
import { audit, loadConfig } from '../src/audit.mjs';
import { buildBaseline, loadBaseline, matchFindings, normalizePath, normalizeText, saveBaseline } from '../src/baseline.mjs';
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

// 基线新增明细用精简对象：不把整个 finding（含 snippet/修复提示等）塞进 JSON。
function summarizeFinding(f) {
  return {
    checkId: f?.checkId ?? null,
    rule: f?.rule ?? null,
    file: normalizePath(f?.file),
    line: Number.isFinite(Number(f?.line)) ? Number(f?.line) : 0,
    severity: f?.severity ?? null,
    force: f?.force ?? null,
    message: String(f?.message || ''),
  };
}

// fixed 来自基线条目（只有 checkId/rule/file/line/hash），明细字段按缺省给出 null/空串。
function summarizeBaselineEntry(e) {
  return {
    checkId: e?.checkId ?? null,
    rule: e?.rule ?? null,
    file: normalizePath(e?.file),
    line: Number.isFinite(Number(e?.line)) ? Number(e?.line) : 0,
    severity: e?.severity ?? null,
    force: e?.force ?? null,
    message: String(e?.message || ''),
  };
}

const isBlocking = (f) => f.force === 'card' || f.severity === 'high';

function baselineSection(rel, written, matched) {
  const blocking = matched.new.filter(isBlocking).length;
  const lines = [
    '',
    '## Baseline',
    `- 基线：${rel}${written ? '（已写入）' : ''}`,
    `- 新增 ${matched.new.length} 条（卡项/高危 ${blocking} 条）、已修复 ${matched.fixed.length} 条、仍在 ${matched.existing.length} 条`,
  ];
  if (!matched.new.length) {
    lines.push('- 新增明细：无');
    return lines.join('\n');
  }
  lines.push('- 新增明细（最多 20 条：file:line rule message）：');
  for (const f of matched.new.slice(0, 20)) {
    const line = Number.isFinite(Number(f.line)) ? Number(f.line) : 0;
    lines.push(`  - ${normalizePath(f.file)}:${line} ${f.rule || '(无规则)'} ${normalizeText(f.message || f.snippet || '')}`);
  }
  if (matched.new.length > 20) lines.push(`  - 其余 ${matched.new.length - 20} 条见 --json`);
  return lines.join('\n');
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

  // 基线：默认 root/.finalcheck/baseline.json（存在才加载）；--write-baseline 审计后写入/更新。
  const baselineIdx = args.indexOf('--baseline');
  let baselinePath = path.join(root, '.finalcheck', 'baseline.json');
  if (baselineIdx > -1) {
    const value = args[baselineIdx + 1];
    if (!value || value.startsWith('--')) {
      console.error('--baseline 需要文件路径');
      process.exit(2);
    }
    baselinePath = path.resolve(value);
  }
  const writeBaseline = args.includes('--write-baseline');
  const failOnIdx = args.indexOf('--fail-on');
  let failOn = null;
  if (failOnIdx > -1) {
    const value = args[failOnIdx + 1];
    if (value !== 'new') {
      console.error('--fail-on 目前只支持 new');
      process.exit(2);
    }
    failOn = 'new';
  }

  // 11 维计划：--profile 读项目根 finalcheck.profile.json（默认就找，找不到回落 tier）；
  // --sources 覆盖输入面，格式 code / url=<地址> / dynamicAuth / limit=<秒>x<连接>，逗号分隔。
  // 复用 src/profile.mjs 的解析，不引入第二套配置格式。
  const { loadProfile, PROFILE_FILE, normalizeSources } = await import('../src/profile.mjs');
  const profileIdx = args.indexOf('--profile');
  const profilePath = profileIdx > -1 && args[profileIdx + 1] && !args[profileIdx + 1].startsWith('--')
    ? path.resolve(args[profileIdx + 1])
    : path.join(root, PROFILE_FILE);
  let profile = null;
  let profileFromFile = false;
  try {
    if (profilePath === path.join(root, PROFILE_FILE)) {
      profile = await loadProfile(root);
      profileFromFile = profile.source === PROFILE_FILE; // 没有文件时 loadProfile 给的是全 L2 缺省
    } else {
      const { readFile } = await import('node:fs/promises');
      const raw = JSON.parse(await readFile(profilePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('顶层必须是对象');
      const nested = raw.dimensions && typeof raw.dimensions === 'object' ? raw.dimensions : raw;
      profile = { source: profilePath, dimensions: nested, sources: raw.sources || {}, warnings: [] };
      profileFromFile = true;
    }
  } catch (e) {
    console.error('profile 读取失败，回落 tier 计划：' + e.message);
    profile = null;
  }
  const srcIdx = args.indexOf('--sources');
  let sources = null;
  if (srcIdx > -1 && args[srcIdx + 1] && !args[srcIdx + 1].startsWith('--')) {
    const warnings = [];
    const out = { code: false };
    for (const part of String(args[srcIdx + 1]).split(',').map((x) => x.trim()).filter(Boolean)) {
      if (part === 'code') out.code = '.';
      else if (part === 'dynamicAuth') out.dynamicAuth = true;
      else if (part.startsWith('url=')) out.url = part.slice(4);
      else if (part.startsWith('limit=')) {
        const m = /^(\d+)x(\d+)$/.exec(part.slice(6));
        if (m) out.loadLimit = { seconds: Number(m[1]), connections: Number(m[2]) };
        else warnings.push('--sources limit 格式应为 <秒>x<连接>，已忽略');
      } else warnings.push('未知 --sources 项：' + part);
    }
    sources = normalizeSources(out, warnings);
    for (const w of warnings) console.error('INFO ' + w);
  }
  // 没有 profile 文件时，按 --tier 合成 11 维同档（否则会悄悄用全 L2 缺省，--tier L3 被吃掉）
  if (!profileFromFile) {
    const { CORE_DIMENSION_NAMES } = await import('../src/profile.mjs');
    const level = ['L1', 'L2', 'L3'].includes(String(tier || '')) ? tier : 'L2';
    profile = {
      source: 'tier',
      dimensions: Object.fromEntries(CORE_DIMENSION_NAMES.map((n) => [n, level])),
      sources: profile?.sources || {},
      warnings: profile?.warnings || [],
    };
  }
  // 审计本地目录默认就是「有源码」：没显式给 --sources 时按 code 处理，
  // 否则证据等级会全部落成 unverified（明明读了源码却写"未验证"，是假谦虚）。
  const effectiveSources = sources || { code: '.' };
  // 声明了 URL 但没有实测记录时，动态维度只能是 static-only（要实测请在 App 里跑 probe/stress）
  const runtime = null;
  // 夹具目录（**/fixtures/**）默认不进产品结论（故意写坏的样本）；自查检查器时用显式开关纳入
  const includeFixtures = args.includes('--include-fixtures');
  // 报告条数上限默认不截断；--no-caps 强制忽略配置里的 reportCaps（适合要看全量条目时）
  const noCaps = args.includes('--no-caps');
  // 默认只展开「会卡交付的 / 需要人工判断的」，低优先建议按规则折叠；--show-low 逐条展开
  const showLow = args.includes('--show-low');
  const res = await audit(root, { tier, interactive, runTests, profile, sources: effectiveSources, runtime, includeFixtures, noCaps });

  // ---- 审计基线对比（对标 Semgrep/SARIF）----
  // 读取失败/版本不符/entries 损坏 → 空基线（全部算新增）并写 warning，绝不静默当「无基线通过」。
  const baselineRel = normalizePath(path.relative(root, baselinePath)) || normalizePath(baselinePath);
  const loaded = await loadBaseline(baselinePath);
  let baselineData = loaded.data;
  let baselineMatched = null;
  let baselineWritten = false;
  let baselineWriteError = null;
  if (loaded.warning) {
    res.warnings.push(`基线 ${baselineRel}：${loaded.warning}`);
    console.error('WARN 基线 ' + baselineRel + '：' + loaded.warning);
    baselineData = { version: 1, createdAt: null, tier: res.tier.effective, entries: [] };
  }
  if (writeBaseline) {
    const snapshot = buildBaseline(res.findings, { tier: res.tier.effective });
    try {
      await saveBaseline(baselinePath, snapshot);
      baselineData = snapshot;
      baselineWritten = true;
    } catch (e) {
      baselineWriteError = e;
    }
  }
  if (baselineData) baselineMatched = matchFindings(res.findings, baselineData);
  let baselineField = null;
  if (baselineMatched) {
    const newBlocking = baselineMatched.new.filter(isBlocking).length;
    baselineField = {
      file: baselineRel,
      new: baselineMatched.new.map(summarizeFinding),
      fixed: baselineMatched.fixed.map(summarizeBaselineEntry),
      existing: baselineMatched.existing.length,
      counts: {
        new: baselineMatched.new.length,
        newBlocking,
        fixed: baselineMatched.fixed.length,
        existing: baselineMatched.existing.length,
        baseline: baselineData.entries.length,
        matchedByHash: baselineMatched.matchedByHash,
        matchedByKey: baselineMatched.matchedByKey,
        ...(baselineWritten ? { written: true } : {}),
      },
    };
    res.baseline = baselineField;
  }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    let text = renderReport(res, { showLow });
    text += baselineMatched
      ? '\n' + baselineSection(baselineRel, baselineWritten, baselineMatched)
      : '\n\n未启用基线（--baseline/--write-baseline）';
    console.log(text);
  }
  // 退出码：0 过 / 1 拦 / 2 修完再过 / 3 无法验收（能力缺失）/ 4 待授权（缺用户点头，例如未跑测试）
  const EXIT = { '过': 0, '拦': 1, '修完再过': 2, '无法验收': 3, '待授权': 4 };
  process.exitCode = EXIT[res.conclusion.verdict] ?? 1;
  // --fail-on new：只有「相对基线新增的卡项/高危」才把退出码压成 1；没有新增时沿用原 verdict。
  if (failOn === 'new' && baselineField && baselineField.counts.newBlocking > 0) process.exitCode = 1;
  if (baselineWriteError) {
    console.error('基线写入失败：' + baselineWriteError.message);
    process.exitCode = 2;
  }
} else {
  console.log('用法: finalcheck audit <目录> [--tier L1|L2|L3] [--json] [--interactive] [--include-fixtures] [--no-caps] [--show-low]');
  console.log('      --include-fixtures  # 显式把 **/fixtures/** 纳入产品结论（默认豁免）');
  console.log('      --no-caps           # 忽略 finalcheck.config.json 的 reportCaps，报告全量条目（默认就不截断）');
  console.log('      --show-low          # 逐条展开「风格与可读性建议」低优先条目（默认按规则折叠，条数仍写清）');
  console.log('      --baseline <路径>   # 基线文件（默认 <目录>/.finalcheck/baseline.json，存在才生效）');
  console.log('      --write-baseline    # 审计后把本次发现写入/更新基线（之后只报新增与已修复）');
  console.log('      --fail-on new       # 仅当相对基线新增卡项/高危时退出码 1（无新增沿用原结论退出码）');
  console.log('      finalcheck audit <目录> --profile finalcheck.profile.json   # 11 维计划');
  console.log('      finalcheck audit <目录> --sources code,url=https://example.com   # 输入面');
  console.log('      finalcheck scan-download <目录>');
  process.exit(2);
}
