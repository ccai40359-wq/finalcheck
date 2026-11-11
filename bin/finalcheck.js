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
  // 声明了 URL 但没有实测记录时，动态维度只能是 static-only（要实测请在 App 里跑 probe/stress）
  const runtime = null;
  const res = await audit(root, { tier, interactive, runTests, profile, sources, runtime });
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else console.log(renderReport(res));
  // 退出码：0 过 / 1 拦 / 2 修完再过 / 3 无法验收（能力缺失）/ 4 待授权（缺用户点头，例如未跑测试）
  const EXIT = { '过': 0, '拦': 1, '修完再过': 2, '无法验收': 3, '待授权': 4 };
  process.exitCode = EXIT[res.conclusion.verdict] ?? 1;
} else {
  console.log('用法: finalcheck audit <目录> [--tier L1|L2|L3] [--json] [--interactive]');
  console.log('      finalcheck audit <目录> --profile finalcheck.profile.json   # 11 维计划');
  console.log('      finalcheck audit <目录> --sources code,url=https://example.com   # 输入面');
  console.log('      finalcheck scan-download <目录>');
  process.exit(2);
}
