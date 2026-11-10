// 工具调用富卡片：trace → 仅「交付物卡」出正文（报告卡 / 探测表 / 压测统计，墨黑金边主题）；
// run_command 等过程类工具一律不出正文卡——过程统一在 ProcessTimeline 时间线里折叠呈现。
import React, { useEffect, useState } from 'react';
import { sevStyle, sevLabel, SEV_ORDER, api } from '../lib/ui.jsx';
import { humanizeToolError, summarizeToolArgs, formatToolArgs } from '../lib/humanize.js';
import { errorCodeLabel } from '../../main/swarm.mjs'; // 纯函数（零依赖）：错误码 → 一句人话，与主进程共用同一份映射
import { RecoverButton } from './RecoverButton.jsx';
import { buildContinueText } from '../lib/continue-prompt.mjs';
import { t } from '../i18n/core.mjs';
import AskUserCard from '../components/AskUserCard.jsx';
import { askUserCardFromTrace } from '../lib/ask-user.mjs';

/** 四色结论横幅（与 AuditPage 一致） */
const VERDICT_STYLE = {
  '过': { cls: 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300', mark: '🟢' },
  '修完再过': { cls: 'bg-amber-500/10 border-amber-500/40 text-amber-300', mark: '🟠' },
  '拦': { cls: 'bg-red-500/10 border-red-500/40 text-red-300', mark: '🔴' },
  '无法验收': { cls: 'bg-neutral-500/10 border-neutral-500/40 text-neutral-300', mark: '⚠️' }
};

/** trace.args 是 JSON 字符串（function.arguments），也可能是对象——都兼容 */
const parseMaybe = (v) => {
  if (typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return v; }
};
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
export const safeJson = (v) => {
  try { return JSON.stringify(parseMaybe(v), null, 2); } catch { return String(v); }
};

/** 正文交付物白名单：只有这些工具的结果出正文卡，其余（run_command 等）过程只进时间线 */
export const BODY_CARD_TOOLS = new Set(['audit_project', 'get_report', 'probe_target', 'stress_target', 'run_workflow']);

function Chevron({ open }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 text-mute transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ToolHeader({ icon, title, subtitle }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="badge shrink-0 bg-gold/15 text-goldSoft border border-gold/35 text-[11px]">{icon} {title}</span>
      {subtitle ? <span className="text-xs text-mute font-mono truncate min-w-0">{subtitle}</span> : null}
    </div>
  );
}

/** 卡片外壳：墨黑 + 金边 */
function ToolShell({ children }) {
  return <div className="mt-2.5 rounded-xl border border-gold/30 bg-[#0d0d10] overflow-hidden animate-[fadeIn_.2s_ease]">{children}</div>;
}

/* 原始文本折叠块：默认收起（金边细线），点开才铺完整栈/JSON。
   label 用中文说明，hint 只放简短元信息（绝不把 JSON 首行铺出来）。 */
function FoldedRaw({ text, label = t('查看详情'), hint = '', maxH = 'max-h-56' }) {
  const [open, setOpen] = useState(false);
  if (text == null || text === '') return null;
  return (
    <div className="mt-1.5 rounded-lg border border-gold/25 bg-[#0b0b0e] overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left text-mute/70 hover:text-goldSoft transition-colors duration-150">
        <Chevron open={open} />
        <span className="text-[11px] shrink-0">{label}</span>
        {hint ? <span className="truncate min-w-0 text-[10px] font-mono text-mute/40">{hint}</span> : null}
      </button>
      {open && (
        <pre className={`border-t border-gold/15 bg-[#0d0d10] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink/75 whitespace-pre-wrap break-all ${maxH} overflow-y-auto animate-[fadeIn_.18s_ease]`}>{String(text)}</pre>
      )}
    </div>
  );
}

/* ---------- 发现列表（severity chips + 可展开 snippet） ---------- */
function ReportFindings({ findings }) {
  const [openIdx, setOpenIdx] = useState(null);
  const sorted = [...(findings || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  if (!sorted.length) return <div className="text-xs text-emerald-400/90 py-1">{t('没有发现，全净')}</div>;
  return (
    <div className="space-y-1.5">
      {sorted.map((f, i) => (
        <div key={i} className="glass-card rounded-xl overflow-hidden hover:border-goldDeep transition-colors duration-200">
          <button className="w-full text-left px-3 py-2 flex items-start gap-2" onClick={() => setOpenIdx(openIdx === i ? null : i)}>
            <span className={`badge mt-0.5 shrink-0 text-[11px] ${sevStyle[f.severity] || sevStyle.low}`}>{t(sevLabel[f.severity] || f.severity)}</span>
            <span className="flex-1 min-w-0 text-xs text-ink/90">
              <span className="font-mono text-goldSoft mr-1.5">{f.checkId}</span>{f.message || f.rule || t('(无描述)')}
              <span className="block text-[11px] text-mute font-mono truncate mt-0.5">{f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : t('位置未知')}</span>
            </span>
            {f.snippet ? <span className="mt-0.5"><Chevron open={openIdx === i} /></span> : null}
          </button>
          {openIdx === i && f.snippet && (
            <pre className="border-t border-edge px-3 py-2 text-[11px] font-mono text-ink/80 overflow-x-auto whitespace-pre-wrap">{f.snippet}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------- 报告卡（audit_project / get_report） ---------- */
export function ReportCard({ args, result }) {
  const [rawOpen, setRawOpen] = useState(false);
  const [open, setOpen] = useState(false); // 默认折叠：只看结论，点开才铺发现列表
  const a = asObj(parseMaybe(args)) || {};
  const r = parseMaybe(result);
  const obj = asObj(r);
  // get_report 返回纯文本报告 → 从文本解析结论行
  const textVerdict = typeof r === 'string' ? (r.match(/结论：(\S+)/) || [])[1] : null;
  const verdict = obj?.verdict ?? (VERDICT_STYLE[textVerdict] ? textVerdict : null);
  const vs = verdict ? VERDICT_STYLE[verdict] : null;
  const textReason = obj?.reason || (typeof r === 'string' ? (r.match(/理由：(.+)/) || [])[1] : '') || '';
  const gates = obj?.gates?.executed || [];
  const findings = obj?.findings || [];
  const countOf = (sev) => findings.filter((f) => f.severity === sev).length;
  const counts = findings.length
    ? [
      countOf('high') ? t('高危 {n}', { n: countOf('high') }) : '',
      countOf('medium') ? t('中危 {n}', { n: countOf('medium') }) : '',
      countOf('low') ? t('提示 {n}', { n: countOf('low') }) : ''
    ].filter(Boolean).join(' · ')
    : '';

  return (
    <ToolShell>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors duration-200">
        <span className="badge shrink-0 bg-gold/15 text-goldSoft border border-gold/35 text-[11px]">{t('🩺 体检报告')}</span>
        <span className="text-xs font-mono text-mute/80 truncate min-w-0">{a.dir || ''}</span>
        {vs && <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${vs.cls}`}>{t(verdict)}</span>}
        {counts ? <span className="shrink-0 text-[10px] text-mute/45">{counts}</span> : null}
        <span className="ml-auto shrink-0"><Chevron open={open} /></span>
      </button>
      {!open && textReason ? <div className="px-4 pb-2.5 -mt-0.5 text-[11px] text-mute/50 truncate">{textReason}</div> : null}
      {open && (
        <>
          {vs && (
            <div className={`mx-4 mt-1 rounded-lg border px-4 py-3 ${vs.cls}`}>
              <div className="flex items-center gap-2.5">
                <span className="text-xl">{vs.mark}</span>
                <div className="min-w-0">
                  <div className="font-bold leading-tight">{t(verdict)}</div>
                  {textReason && <div className="text-xs opacity-90 mt-0.5">{textReason}</div>}
                </div>
              </div>
            </div>
          )}
          {gates.length > 0 && (
            <div className="px-4 mt-2.5 flex flex-wrap gap-1.5">
              {gates.map((g) => <span key={g} className="badge bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[11px]">{g} ✓</span>)}
            </div>
          )}
          {obj ? (
            <div className="px-4 py-3">
              <ReportFindings findings={obj.findings} />
            </div>
          ) : (
            <div className="px-4 py-3">
              <button className="inline-flex items-center gap-1.5 text-xs text-mute hover:text-goldSoft transition-colors duration-200" onClick={() => setRawOpen(!rawOpen)}>
                <Chevron open={rawOpen} /> {t('报告全文')}
              </button>
              {rawOpen && (
                <pre className="mt-2 glass-card rounded-xl p-3 text-[11px] font-mono text-ink/80 whitespace-pre-wrap max-h-72 overflow-y-auto">{String(r)}</pre>
              )}
            </div>
          )}
        </>
      )}
    </ToolShell>
  );
}

/* ---------- 探测表（probe_target） ---------- */
export function ProbeCard({ args, result }) {
  const a = asObj(parseMaybe(args)) || {};
  const r = asObj(parseMaybe(result));
  const rows = (r?.results || []).filter((x) => x.kind === 'unauth-access');
  const cors = (r?.results || []).find((x) => x.kind === 'cors');
  const headers = (r?.results || []).find((x) => x.kind === 'security-headers');
  return (
    <ToolShell>
      <div className="px-4 pt-3">
        <ToolHeader icon="🛡️" title={t('渗透探测')} subtitle={r?.target || a.url || ''} />
      </div>
      <div className="px-4 py-3 space-y-2.5">
        <div className="glass-card rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-mute border-b border-edge">
                <th className="px-3 py-2 font-medium">{t('路径')}</th>
                <th className="px-3 py-2 font-medium">{t('状态码')}</th>
                <th className="px-3 py-2 font-medium">{t('复现')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((row, i) => (
                <tr key={i} className="border-b border-edge/60 last:border-0">
                  <td className="px-3 py-1.5 font-mono">
                    <div>{row.path}</div>
                    {row.note ? <div className="text-[10px] text-mute/70 font-sans mt-0.5">{row.note}</div> : null}
                  </td>
                  <td className="px-3 py-1.5 font-mono">
                    {row.status === null
                      ? <span className="text-mute">{t('不可达')}</span>
                      : <span className={row.status >= 200 && row.status < 400 ? 'text-red-400 font-semibold' : 'text-mute'}>{row.status}</span>}
                  </td>
                  <td className="px-3 py-1.5">{row.reproduced ? '✅' : '❌'}</td>
                </tr>
              )) : (
                <tr><td colSpan={3} className="px-3 py-3 text-center text-mute">{t('未探测到无认证可访问的路径')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {cors && (
          <div className="text-xs">
            <span className="text-mute">{t('CORS：')}</span>
            {cors.error
              ? <span className="text-mute">{t('请求失败（{reason}）', { reason: humanizeToolError(cors.error) })}</span>
              : cors.reflected
                ? <span className="text-red-400 font-medium">{t('存在反射：任意 Origin 被允许（allow-origin: {origin}）', { origin: cors.allowOrigin || '*' })}</span>
                : <span className="text-emerald-400">{cors.allowOrigin
                  ? t('无反射（allow-origin: {origin}）', { origin: cors.allowOrigin })
                  : t('无反射')}</span>}
          </div>
        )}
        {headers && (
          <div className="text-xs flex flex-wrap items-center gap-1.5">
            <span className="text-mute">{t('安全头：')}</span>
            {headers.error
              ? <span className="text-mute">{t('请求失败（{reason}）', { reason: humanizeToolError(headers.error) })}</span>
              : headers.missing?.length
                ? headers.missing.map((h) => <span key={h} className="badge bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[11px] font-mono">{t('缺失 {header}', { header: h })}</span>)
                : <span className="text-emerald-400">{t('齐全')}</span>}
          </div>
        )}
      </div>
    </ToolShell>
  );
}

/* ---------- 压测统计卡（stress_target） ---------- */
function StressStat({ label, value, unit, tone = 'text-ink' }) {
  return (
    <div className="glass-card rounded-xl px-3 py-2.5 hover:border-goldDeep transition-colors duration-200">
      <div className="text-[11px] text-mute mb-0.5">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${tone}`}>
        {value}{unit && <span className="text-[11px] font-normal text-mute ml-1">{unit}</span>}
      </div>
    </div>
  );
}

export function StressCard({ args, result }) {
  const a = asObj(parseMaybe(args)) || {};
  const r = asObj(parseMaybe(result));
  if (!r) return null;
  return (
    <ToolShell>
      <div className="px-4 pt-3">
        <ToolHeader icon="⚡" title={t('压力测试')} subtitle={r.url || a.url || ''} />
      </div>
      <div className="px-4 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StressStat label={t('平均 RPS')} value={r.rpsAvg ?? '—'} unit="req/s" tone="text-goldSoft" />
          <StressStat label={t('p97.5 延迟')} value={r.p97_5LatencyMs ?? r.p95LatencyMs ?? '—'} unit="ms" tone={(r.p97_5LatencyMs ?? 0) > 500 ? 'text-amber-400' : 'text-ink'} />
          <StressStat label={t('错误数')} value={r.errors ?? 0} tone={r.errors ? 'text-red-400' : 'text-emerald-400'} />
          <StressStat label={t('平均吞吐')} value={r.throughputAvgBytes != null ? (r.throughputAvgBytes / 1024).toFixed(1) : '—'} unit="KB/s" />
        </div>
        {r.statusCodes && Object.keys(r.statusCodes).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(r.statusCodes).map(([code, n]) => (
              <span key={code} className={`badge font-mono text-[11px] ${String(code).startsWith('2') || String(code).startsWith('3') ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/10 text-red-400 border border-red-500/30'}`}>
                {code} × {n && typeof n === 'object' ? (n.count ?? 0) : n}
              </span>
            ))}
          </div>
        )}
      </div>
    </ToolShell>
  );
}

/* ---------- 本次用了哪种工作流表示：只显示结论（DAG / DSL + 一句人话），不提供用户选择 ---------- */
function WorkflowModeBadge({ mode, reason }) {
  const label = mode === 'script' ? 'DSL' : mode === 'dag' ? 'DAG' : null;
  const why = String(reason || '').trim();
  if (!label || !why) return null;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="shrink-0 badge font-mono text-[9px] leading-none bg-gold/10 text-goldSoft border border-gold/30">{label}</span>
      <span title={t(why)} className="truncate text-[10px] text-mute/50">{t(why)}</span>
    </span>
  );
}

/* ---------- 工作流实时进度卡（run_workflow 执行中，按快照刷新；仿 ZCode 的工作流实例） ---------- */
const WF_STATUS = {
  pending: { mark: '○', text: '等待中', cls: 'text-mute/45', dot: 'bg-mute/25' },
  running: { mark: '●', text: '运行中', cls: 'text-goldSoft', dot: 'bg-goldSoft animate-pulse' },
  success: { mark: '●', text: '已完成', cls: 'text-jade', dot: 'bg-jade' },
  failed: { mark: '✕', text: '失败', cls: 'text-red-400', dot: 'bg-red-400' },
  cancelled: { mark: '–', text: '已取消', cls: 'text-mute/40', dot: 'bg-mute/30' },
};
// 子代理头像配色（暖色系，不引入蓝紫）
const AGENT_COLORS = ['#c9a227', '#3f9e6e', '#d9884a', '#c76a6a', '#7fb0a3', '#c9b06a', '#a8894b', '#8fa86b'];
// role/name 稳定哈希 → 头像底色（同一角色每次刷新同色）
const agentColorOf = (step) => {
  const s = String(step?.role || step?.name || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
};
// 角色 → emoji；未命中的角色用首字（中文/英文都成立）
const ROLE_GLYPHS = [
  [/audit|审计|体检|检查/i, '🔍'],
  [/review|复核|审查|评审/i, '🧐'],
  [/research|调研|检索|资料/i, '🧭'],
  [/code|编码|开发|实现/i, '⌨️'],
  [/test|测试|验证/i, '🧪'],
  [/write|文档|写作|总结/i, '✍️'],
  [/scan|扫描|探测|probe/i, '🎯'],
  [/stress|压测|负载|性能/i, '⚡'],
  [/plan|规划|设计|方案/i, '🗺️'],
  [/fix|修复|整改/i, '🔧'],
  [/analy|分析|评估/i, '📊'],
  [/deploy|发布|部署/i, '🚀'],
  [/claim|仲裁|核实|校对/i, '⚖️']
];
const agentGlyphOf = (step) => {
  const role = String(step?.role || '');
  const hit = ROLE_GLYPHS.find(([re]) => re.test(role));
  if (hit) return hit[1];
  return (String(step?.role || step?.name || 'A').trim().slice(0, 1) || 'A');
};
const toolsOf = (step) => {
  const n = Number(step?.tools ?? step?.toolCount);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
// 单步耗时：完成后用 ms；运行中用 startedAt 实时估（卡片 500ms tick 会刷新）
const stepMsOf = (step) => {
  const ms = Number(step?.ms);
  if (Number.isFinite(ms) && ms > 0) return ms;
  if (step?.status === 'running' && Number(step?.startedAt)) return Math.max(0, Date.now() - Number(step.startedAt));
  return 0;
};
const fmtWfDur = (ms) => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};

/* swarm 步骤元信息：kind / claims / confirmed 只在字段确实存在时渲染，旧会话/旧步骤完全不显示 */
function SwarmStepMeta({ kind, claims = 0, confirmed = 0, className = '' }) {
  const nClaims = Number(claims) > 0 ? Number(claims) : 0;
  const nConfirmed = Number(confirmed) > 0 ? Number(confirmed) : 0;
  if (!kind && !nClaims && !nConfirmed) return null;
  return (
    <span className={`flex items-center gap-1.5 min-w-0 overflow-hidden leading-none ${className}`}>
      {kind ? <span className="shrink-0 text-[8.5px] text-mute/55 tracking-wide">{String(kind)}</span> : null}
      {nClaims > 0 ? <span className="shrink-0 text-[8.5px] tabular-nums text-mute/50">{t('{n} 条主张', { n: nClaims })}</span> : null}
      {nConfirmed > 0 ? <span className="shrink-0 text-[8.5px] tabular-nums text-goldSoft/70">✓ {nConfirmed}</span> : null}
    </span>
  );
}

function ReusedMark() {
  return (
    <span title={t('来自上次运行，已复用结果')}
      className="shrink-0 text-[9px] leading-none text-goldSoft/70">↺</span>
  );
}

/* 最终结果行没有快照里的 claims/confirmed 计数：优先用顶层 claims（仲裁后的最新 status），
   旧结果没有顶层数组时才回落到步骤自带字段 */
function claimsMetaOf(step, allClaims) {
  if (Array.isArray(allClaims) && step?.id != null) {
    const mine = allClaims.filter((c) => c?.sourceStep === step.id);
    return { claims: mine.length, confirmed: mine.filter((c) => c?.status === 'confirmed').length };
  }
  let claims = 0;
  let confirmed = 0;
  if (typeof step?.claims === 'number') claims = Math.max(0, step.claims);
  else if (Array.isArray(step?.claims)) {
    claims = step.claims.length;
    confirmed = step.claims.filter((c) => c?.status === 'confirmed').length;
  }
  if (typeof step?.confirmed === 'number') confirmed = Math.max(0, step.confirmed);
  else if (Array.isArray(step?.confirmed)) confirmed = step.confirmed.length;
  return { claims, confirmed };
}

/* 完成态 card 没有 phases 快照：从 steps.depends_on 推拓扑层级；
   没有任何依赖声明（旧结果）时全部塞一个阶段，不报错 */
const wid = (v) => String(v);
function topologyPhases(steps) {
  const list = (Array.isArray(steps) ? steps : []).filter((s) => s && s.id != null);
  if (!list.length) return [];
  const ids = [...new Set(list.map((s) => wid(s.id)))];
  const idSet = new Set(ids);
  const hasDeps = list.some((s) => Array.isArray(s.depends_on) && s.depends_on.length > 0);
  if (!hasDeps) return [ids]; // 旧结果没有 depends_on：单阶段
  const deps = new Map(list.map((s) => [
    wid(s.id),
    (Array.isArray(s.depends_on) ? s.depends_on : [])
      .map(wid)
      .filter((d) => idSet.has(d) && d !== wid(s.id))
  ]));
  const done = new Set();
  let remaining = ids.slice();
  const phases = [];
  while (remaining.length) {
    const level = remaining.filter((id) => (deps.get(id) || []).every((d) => done.has(d)));
    if (!level.length) { phases.push(remaining); break; } // 环/脏依赖：剩余塞最后一层，不报错
    phases.push(level);
    level.forEach((id) => done.add(id));
    remaining = remaining.filter((id) => !done.has(id));
  }
  return phases;
}

/* ---------- 工作流阶段轨道（运行卡 / 完成卡共用） ---------- */
const PHASE_STEP_PREVIEW = 4; // 每个阶段默认最多露出 4 个步骤，其余收进 Show more

function PhaseLane({
  phases,
  stepsById,
  allClaims = null,
  running = false,
  onOpenStep = null
}) {
  const scrollRef = React.useRef(null);
  // 展开状态是卡片本地 state（按阶段下标），不持久化：重开/刷新后回到默认 4 行
  const [openPhases, setOpenPhases] = useState(() => new Set());
  const togglePhase = (pi) => setOpenPhases((prev) => {
    const next = new Set(prev);
    if (next.has(pi)) next.delete(pi);
    else next.add(pi);
    return next;
  });
  // 滚轮 → 左右丝滑滑动
  const onWheel = (e) => {
    const el = scrollRef.current;
    if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if (el.scrollWidth > el.clientWidth) { el.scrollLeft += e.deltaY; e.preventDefault(); }
  };
  if (!Array.isArray(phases) || !phases.length) return null;

  return (
    <>
      <div ref={scrollRef} onWheel={onWheel} aria-busy={running || undefined}
        className="overflow-x-auto scroll-smooth mt-2 px-3.5 pb-3 wf-scroll"
        style={{ scrollbarColor: 'rgba(255,255,255,0.14) transparent' }}>
        <div className="flex items-start min-w-max">
          {phases.map((ids, pi) => {
            const list = ids.map((id) => stepsById?.get(id)).filter(Boolean);
            const phDone = list.filter((s) => s.status === 'success').length;
            const phFailed = list.filter((s) => s.status === 'failed').length;
            const phRunning = list.filter((s) => s.status === 'running').length;
            const allDone = list.length > 0 && phDone === list.length;
            const dotCls = phRunning ? 'bg-goldSoft animate-pulse' : phFailed ? 'bg-red-400' : allDone ? 'bg-jade' : 'bg-mute/30';
            const dotTitle = `${t('{done}/{total} 完成', { done: phDone, total: list.length })}${phRunning ? ` · ${t('{n} 运行中', { n: phRunning })}` : ''}${phFailed ? ` · ${t('{n} 失败', { n: phFailed })}` : ''}`;
            // 单步阶段用步名（不会被重复显示）；多步阶段没有声明名，用「阶段 N」而不是拿第一步冒充
            const phaseName = list.length === 1
              ? (list[0]?.name || list[0]?.role || t('阶段 {n}', { n: pi + 1 }))
              : t('阶段 {n}', { n: pi + 1 });
            const isLast = pi === phases.length - 1;
            const nextRunning = !isLast && (phases[pi + 1] || []).some((id) => stepsById?.get(id)?.status === 'running');
            // 阶段内步骤超过 4 行就折叠：只渲染前 4 个 + Show more（本地展开，不持久化）
            const folded = list.length > PHASE_STEP_PREVIEW && !openPhases.has(pi);
            const shown = folded ? list.slice(0, PHASE_STEP_PREVIEW) : list;
            const hidden = list.length - shown.length;
            return (
              <div key={pi} className="relative shrink-0 w-[196px]">
                {/* 阶段头：圆点 + 短名 + 完成数/总数；非末列右侧接细连线 */}
                <div className="relative flex items-center gap-1.5 h-6 min-w-0 pr-4">
                  <span className={`shrink-0 w-2 h-2 rounded-full ${dotCls}`} title={dotTitle} />
                  <span className="truncate min-w-0 text-[11px] text-ink/80" title={phaseName}>{phaseName}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-mute/50">{phDone}/{list.length}</span>
                  {!isLast && (
                    <span aria-hidden className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 flex items-center">
                      <span className={`h-px w-3.5 ${nextRunning ? 'bg-goldSoft/40' : 'bg-white/[0.12]'}`} />
                    </span>
                  )}
                </div>
                {/* 该阶段的子代理芯片：纵向堆叠 */}
                <div className="mt-1.5 space-y-1 pr-4">
                  {shown.map((s) => {
                    const st = WF_STATUS[s.status] || WF_STATUS.pending;
                    const label = s.name || s.role || t('子代理');
                    const tools = toolsOf(s);
                    const ms = stepMsOf(s);
                    const meta = claimsMetaOf(s, allClaims);
                    // 失败芯片：title 第一行先给结构化错误码 + 一句人话（原始栈跟在后面，tooltip 里不挡视线）
                    const errLine = s.status === 'failed' && s.error ? humanizeToolError(s.error) : '';
                    // 结构化错误码（HTTP 429 / NO_TOOLS…）：旧快照/旧结果没有该字段时回落到原有人话首行
                    const code = s.status === 'failed' && s.errorCode ? String(s.errorCode) : '';
                    const codeTip = code ? t('状态：失败（{code} · {label}）', { code, label: t(errorCodeLabel(code)) }) : '';
                    const rawErr = errLine && String(s.error).trim() && String(s.error).trim() !== errLine
                      ? String(s.error).trim().slice(0, 300)
                      : '';
                    const tipParts = codeTip
                      ? [
                          codeTip,
                          ...(errLine ? [errLine] : []),
                          s.name || s.role,
                          s.role ? t('角色：{role}', { role: s.role }) : '',
                          ms ? t('耗时：{duration}', { duration: fmtWfDur(ms) }) : '',
                          tools ? t('工具：{n} 次', { n: tools }) : '',
                          s.reused ? t('来自上次运行，已复用结果') : '',
                          ...(rawErr ? ['', rawErr] : []),
                          t('点击查看它的上下文')
                        ].filter((x) => x !== '')
                      : [
                          errLine || (s.name || s.role),
                          ...(errLine ? [s.name || s.role] : []),
                          s.role ? t('角色：{role}', { role: s.role }) : '',
                          t('状态：{status}', { status: t(st.text) }),
                          ms ? t('耗时：{duration}', { duration: fmtWfDur(ms) }) : '',
                          tools ? t('工具：{n} 次', { n: tools }) : '',
                          s.reused ? t('来自上次运行，已复用结果') : '',
                          ...(rawErr ? ['', rawErr] : []),
                          t('点击查看它的上下文')
                        ].filter((x) => x !== '');
                    const tip = tipParts.join('\n');
                    const inner = (
                      <>
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="w-4 h-4 shrink-0 rounded-full flex items-center justify-center text-[9px] leading-none font-bold text-black/80"
                            style={{ backgroundColor: agentColorOf(s) }}>{agentGlyphOf(s)}</span>
                          {s.reused ? <ReusedMark /> : null}
                          <span className={`truncate min-w-0 flex-1 text-[11px] ${s.status === 'pending' || s.status === 'cancelled' ? 'text-mute/55' : 'text-ink/80'}`}>{label}</span>
                          {s.status === 'success' ? <span className="shrink-0 text-[10px] leading-none text-jade">✓</span>
                            : s.status === 'failed' ? (
                                <>
                                  <span className="shrink-0 text-[10px] leading-none text-red-400">✗</span>
                                  {/* 失败短码角标：HTTP 429 / NO_TOOLS 这种短形式，完整解释在 tooltip 首行 */}
                                  {code ? (
                                    <span className="shrink-0 max-w-[72px] truncate text-[9px] leading-none font-mono text-red-400/90">
                                      {code}
                                    </span>
                                  ) : null}
                                </>
                              )
                              : s.status === 'cancelled' ? <span className="shrink-0 text-[10px] leading-none text-mute/40">–</span>
                                : <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${st.dot}`} title={t(st.text)} />}
                        </span>
                        <SwarmStepMeta kind={s.kind} claims={meta.claims} confirmed={meta.confirmed} className="mt-0.5 pl-[22px]" />
                      </>
                    );
                    return (
                      <button key={s.id} onClick={() => onOpenStep?.(s)} title={tip}
                        className={`w-full text-left rounded-lg px-2 py-1.5 min-w-0 transition-colors hover:bg-white/[0.09] ${s.status === 'running' ? 'bg-gold/[0.10]' : 'bg-white/[0.045]'}`}>
                        {inner}
                      </button>
                    );
                  })}
                  {list.length > PHASE_STEP_PREVIEW ? (
                    <button onClick={() => togglePhase(pi)} aria-expanded={!folded}
                      className="w-full text-left rounded-lg px-2 py-1 text-[10px] text-mute/60 hover:text-goldSoft hover:bg-white/[0.07] transition-colors">
                      {folded
                        ? t('Show more（还有 {n} 个）', { n: hidden })
                        : t('收起')}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function WorkflowLiveCard({ data, sessionId = null, providers = [], onOpenStep = null, onRecover = null }) {
  const [, setTick] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgPos, setCfgPos] = useState(null);
  const [maxConc, setMaxConc] = useState(data?.concurrency || 14);
  const [sel, setSel] = useState(null); // { providerId, model } | null=跟随会话
  const [paused, setPaused] = useState(!!data?.paused);
  const gearRef = React.useRef(null);
  const y = api();

  useEffect(() => {
    if (!data?.running) return undefined;
    const timer = setInterval(() => setTick((x) => x + 1), 500); // 运行中让耗时自己走，不用等下一次快照
    return () => clearInterval(timer);
  }, [data?.running]);
  useEffect(() => { setPaused(!!data?.paused); }, [data?.paused]);
  useEffect(() => { if (data?.concurrency) setMaxConc(data.concurrency); }, [data?.concurrency]);

  if (!data?.steps?.length) return null;
  const byId = new Map(data.steps.map((s) => [s.id, s]));
  const phases = data.phases?.length ? data.phases : [data.steps.map((s) => s.id)];
  const total = data.steps.length;
  const done = data.steps.filter((s) => s.status === 'success').length;
  const failed = data.steps.filter((s) => s.status === 'failed').length;
  const running = data.steps.filter((s) => s.status === 'running').length;
  const elapsed = data.running ? Date.now() - (data.startedAt || Date.now()) : (data.ms || 0);

  // 中断/失败才给「恢复」：运行中（含已暂停）不出现，避免让人误以为还能接上一个正在跑的流程。
  // 实时快照没有 result，就按当前 steps 拼一份最小 result 给 buildContinueText。
  const recoverResult = {
    goal: data.goal,
    stopped: !!data.stopped,
    results: (data.steps || []).map((s) => ({
      name: s.name, ok: s.status === 'success', ms: s.ms, tools: s.tools,
      errorCode: s.errorCode || null, kind: s.kind || null,
    })),
  };
  // 只认「中断/失败」：正常跑完的最后一帧（running:false、全 success）不该闪出一颗恢复键
  const canRecover = !!onRecover && (data.stopped === true || failed > 0);
  const recover = () => {
    if (!onRecover) return;
    onRecover(buildContinueText({ trace: [{ tool: 'run_workflow', result: recoverResult }] }));
  };

  const control = (action, extra = {}) => { y?.workflowControl?.(sessionId, { action, ...extra }); };
  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    control(next ? 'pause' : 'resume');
  };

  return (
    <div className="relative mt-2.5 glass-card rounded-2xl overflow-hidden animate-[fadeIn_.2s_ease]">
      {/* 头部：折叠 + 图标/标题/目标 + 阶段与子代理计数（暂停/停止/设置收进底栏） */}
      <div className="px-3.5 pt-2.5 flex items-center gap-2 min-w-0">
        <button onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
          title={expanded ? t('收起工作流') : t('展开工作流')}
          className="shrink-0 -ml-1 h-6 w-6 rounded-md text-mute/60 hover:text-goldSoft hover:bg-white/[0.07] flex items-center justify-center transition-colors">
          <Chevron open={expanded} />
        </button>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-goldSoft">
          <rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" />
          <path d="M9 6h4a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
        </svg>
        <span className="shrink-0 text-[12px] text-ink/90">{data.running ? (paused ? 'Workflow paused' : 'Workflow running') : 'Workflow completed'}</span>
        {data.goal ? <span className="truncate min-w-0 text-[11px] text-mute/60">{data.goal}</span> : null}
        <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[10px] text-mute/45 tabular-nums">
          <span>{phases.length} phases · {total} agents</span>
          {data.running ? <span className="text-goldSoft/70">· {fmtWfDur(elapsed)}</span> : null}
        </span>
      </div>

      {/* 本次表示方式（只给结论，不给选项） */}
      {data.mode ? (
        <div className="px-3.5 mt-1.5">
          <WorkflowModeBadge mode={data.mode} reason={data.modeReason} />
        </div>
      ) : null}

      {/* 阶段轨道 + 子代理芯片（与完成卡共用 PhaseLane） */}
      {expanded && (
        <PhaseLane phases={phases} stepsById={byId} allClaims={data.claims}
          running={!!data.running} onOpenStep={onOpenStep} />
      )}

      {/* 底栏：进度 / 总耗时 + 暂停继续 / 停止 / 设置（行为与原实现一致） */}
      <div className="px-3.5 pb-2.5 pt-2 flex items-center gap-3 text-[10px] text-mute/40 border-t border-white/[0.06]">
        <span className="tabular-nums">{t('{done}/{total} 完成', { done, total })}</span>
        {running > 0 ? <span className="text-goldSoft/70 tabular-nums">{t('{n} 运行中', { n: running })}</span> : null}
        {failed ? <span className="text-red-400/80">{t('{n} 个失败', { n: failed })}</span> : null}
        <span>{t('并发上限 {n}', { n: data.concurrency ?? 14 })}</span>
        {paused ? <span className="text-goldSoft/80">{t('已暂停 · 不会起新的子代理')}</span> : data.running ? <span className="text-goldDeep/70">{t('实时刷新')}</span> : null}
        <span className="ml-auto shrink-0 tabular-nums text-mute/55">{t('总耗时 {duration}', { duration: fmtWfDur(elapsed) })}</span>
        {canRecover ? (
          <RecoverButton compact onClick={recover}
            title={t('恢复这一轮：复用已完成的步骤，只补没跑完的（ZCode recover）')} />
        ) : null}
        {data.running && (
          <>
            <button onClick={togglePause} title={paused ? t('继续') : t('暂停（不再起新的子代理）')}
              className="shrink-0 h-6 w-6 rounded-md text-mute/70 hover:text-goldSoft hover:bg-white/[0.07] flex items-center justify-center transition-colors">
              {paused
                ? <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                : <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>}
            </button>
            <button onClick={() => control('stop')} title={t('停止工作流')}
              className="shrink-0 h-6 w-6 rounded-md text-mute/70 hover:text-red-300 hover:bg-red-500/10 flex items-center justify-center transition-colors">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="1.5" y="1.5" width="9" height="9" rx="2" /></svg>
            </button>
          </>
        )}
        <button ref={gearRef} onClick={() => {
          if (!cfgOpen) {
            const r = gearRef.current?.getBoundingClientRect();
            if (r) {
              const approxH = 330; // 弹层高度（模型列表 + 并发 + 按钮），底部放不下就向上翻
              const top = r.bottom + 6 + approxH > window.innerHeight
                ? Math.max(8, r.top - approxH - 6)
                : r.bottom + 6;
              setCfgPos({ top: Math.round(top), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
            }
          }
          setCfgOpen((v) => !v);
        }} title={t('工作流设置（子代理模型 / 最大并发）')}
          className={`shrink-0 h-6 w-6 rounded-md flex items-center justify-center transition-colors ${cfgOpen ? 'text-goldSoft bg-white/[0.08]' : 'text-mute/70 hover:text-goldSoft hover:bg-white/[0.07]'}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
          </svg>
        </button>
      </div>

      {/* 工作流设置：子代理模型 + 最大并发（fixed 定位，避免被卡片 overflow-hidden 裁掉） */}
      {cfgOpen && cfgPos && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setCfgOpen(false)} />
          <div className="fixed w-72 glass-pop rounded-2xl p-3 z-[70] animate-[fadeIn_.15s_ease]"
            style={{ top: cfgPos.top, right: cfgPos.right }}>
            <div className="text-[11px] text-ink/85 mb-1.5">Subagent model</div>
            <div className="max-h-40 overflow-y-auto rounded-lg bg-black/25 p-1 space-y-0.5">
              <button onClick={() => setSel(null)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] transition-colors ${sel == null ? 'bg-gold/12 text-goldSoft' : 'text-ink/75 hover:bg-white/5'}`}>
                <span className="truncate">{t('跟随会话模型')}</span>
                {sel == null ? <span className="ml-auto text-jade">✓</span> : null}
              </button>
              {providers.map((p) => (Array.isArray(p.models) ? p.models : [])
                .map((m) => (typeof m === 'string' ? m.trim() : String(m?.id ?? '').trim()))
                .filter(Boolean)
                .map((mid) => {
                  const picked = sel && sel.providerId === p.id && sel.model === mid;
                  return (
                    <button key={p.id + '/' + mid} onClick={() => setSel({ providerId: p.id, model: mid })}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-mono transition-colors ${picked ? 'bg-gold/12 text-goldSoft' : 'text-ink/75 hover:bg-white/5'}`}>
                      <span className="truncate">{p.name}/{mid}</span>
                      {picked ? <span className="ml-auto text-jade">✓</span> : null}
                    </button>
                  );
                }))}
            </div>
            <div className="mt-3 flex items-center justify-between text-[11px] text-ink/85">
              <span>Max concurrency</span>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setMaxConc((v) => Math.max(1, v - 1))} className="h-6 w-6 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-ink/80">−</button>
                <span className="w-6 text-center tabular-nums text-ink">{maxConc}</span>
                <button onClick={() => setMaxConc((v) => Math.min(14, v + 1))} className="h-6 w-6 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-ink/80">+</button>
                <span className="text-[10px] text-mute/40">= default {data.concurrency}</span>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button onClick={() => setCfgOpen(false)} className="text-[11px] text-mute/60 hover:text-ink px-2 py-1">{t('取消')}</button>
              <button onClick={() => {
                control('config', { maxConcurrency: maxConc, providerId: sel?.providerId || '', model: sel?.model || '' });
                setCfgOpen(false);
              }} className="btn-primary px-3 py-1 text-[11px]">Apply</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- 多 agent 工作流完成卡（run_workflow 结果；与运行卡共用 PhaseLane） ---------- */
export function WorkflowCard({ args, result, onOpenStep = null, onRecover = null }) {
  const a = asObj(parseMaybe(args)) || {};
  const r = asObj(parseMaybe(result));
  const [expanded, setExpanded] = useState(true);
  if (!r) return null;
  if (r.error) {
    return (
      <ToolShell>
        <div className="px-4 pt-3"><ToolHeader icon="⧉" title={t('工作流')} subtitle={a.goal || ''} /></div>
        <div className="mx-4 my-3 rounded-lg border border-gold/40 bg-gold/[0.06] px-3.5 py-2.5">
          <div className="flex items-start gap-2.5">
            <span className="shrink-0 mt-px text-[13px] leading-none text-goldSoft">⚠</span>
            <div className="min-w-0 flex-1">
              <div className="text-xs leading-relaxed text-ink/85">{humanizeToolError(r.error)}</div>
              <FoldedRaw text={typeof r.error === 'string' ? r.error : safeJson(r.error)} label={t('查看详情')} hint={t('原始错误 / 调用栈')} />
            </div>
          </div>
        </div>
      </ToolShell>
    );
  }
  const rows = Array.isArray(r.results) ? r.results : [];
  // 拓扑声明优先 args.steps；旧结果 args 缺失时用 result.steps（引擎最终结果里也带 steps）
  const declared = Array.isArray(a.steps) && a.steps.length
    ? a.steps
    : (Array.isArray(r.steps) ? r.steps : []);
  const declaredById = new Map(declared.filter((s) => s && s.id != null).map((s) => [wid(s.id), s]));
  const steps = rows.map((row, i) => {
    const meta = declaredById.get(wid(row?.id)) || {};
    return {
      ...row,
      id: wid(row?.id ?? `__row${i}`),
      name: row?.name || meta.name || t('子代理 {n}', { n: i + 1 }),
      role: row?.role || meta.role || '',
      status: row?.ok ? 'success' : 'failed',
      tools: Number(row?.tools ?? row?.toolCount) || 0,
      depends_on: Array.isArray(row?.depends_on)
        ? row.depends_on
        : (Array.isArray(meta.depends_on) ? meta.depends_on : [])
    };
  });
  const byId = new Map(steps.map((s) => [s.id, s]));
  // 只保留真正有结果的阶段；声明了但没结果的空阶段不占列
  let phases = topologyPhases(declared.length ? declared : steps)
    .map((ids) => ids.map(wid).filter((id) => byId.has(id)))
    .filter((ids) => ids.length);
  // 结果里有、声明里没有的代理补进末阶段，避免历史脏数据丢行
  const covered = new Set(phases.flat());
  const orphans = steps.filter((s) => !covered.has(s.id)).map((s) => s.id);
  if (orphans.length) {
    phases = phases.length
      ? phases.map((ids, i) => (i === phases.length - 1 ? [...ids, ...orphans] : ids))
      : [orphans];
  }
  if (!phases.length) return null;
  const okCount = steps.filter((s) => s.status === 'success').length;
  const failCount = steps.length - okCount;
  const goal = r.goal || a.goal || '';
  const duration = Number.isFinite(Number(r.ms)) && r.ms != null
    ? Number(r.ms)
    : steps.reduce((sum, s) => sum + (Number(s.ms) || 0), 0);
  // 只有「被停止」或真有失败节点时才给恢复键：成功完成的一轮不给（点了只是白白再跑一遍）。
  const canRecover = !!onRecover
    && (r.stopped === true || rows.some((row) => row && row.ok === false));
  const recover = () => {
    if (!onRecover) return;
    onRecover(buildContinueText({ trace: [{ tool: 'run_workflow', result: r }] }));
  };

  return (
    <div className="relative mt-2.5 glass-card rounded-2xl overflow-hidden animate-[fadeIn_.2s_ease]">
      {/* 头部：折叠 + 标题/目标 + 阶段与子代理计数（完成态无暂停/停止/并发/设置） */}
      <div className="px-3.5 pt-2.5 flex items-center gap-2 min-w-0">
        <button onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
          title={expanded ? t('收起工作流') : t('展开工作流')}
          className="shrink-0 -ml-1 h-6 w-6 rounded-md text-mute/60 hover:text-goldSoft hover:bg-white/[0.07] flex items-center justify-center transition-colors">
          <Chevron open={expanded} />
        </button>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-goldSoft">
          <rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" />
          <path d="M9 6h4a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
        </svg>
        <span className="shrink-0 text-[12px] text-ink/90">Workflow completed</span>
        {goal ? <span className="truncate min-w-0 text-[11px] text-mute/60">{goal}</span> : null}
        <span className="ml-auto shrink-0 text-[10px] text-mute/45 tabular-nums">
          {phases.length} phases · {steps.length} agents
        </span>
      </div>
      {/* 本次表示方式（只给结论，不给选项） */}
      {r.mode ? (
        <div className="px-3.5 mt-1.5">
          <WorkflowModeBadge mode={r.mode} reason={r.modeReason} />
        </div>
      ) : null}
      {expanded && (
        <PhaseLane phases={phases} stepsById={byId} allClaims={r.claims} running={false} onOpenStep={onOpenStep} />
      )}
      {/* 底栏：成功/失败聚合 + 总耗时（完成态不出现运行控制） */}
      <div className="px-3.5 pb-2.5 pt-2 flex items-center gap-3 text-[10px] text-mute/40 border-t border-white/[0.06]">
        <span className="tabular-nums">
          {t('{done}/{total} 成功', { done: okCount, total: steps.length })}
          {failCount ? <span className="text-red-400/80"> · {t('{n} 失败', { n: failCount })}</span> : null}
        </span>
        {r.stopped ? <span className="text-goldSoft/70">{t('已停止')}</span> : null}
        {canRecover ? (
          <span className="ml-auto shrink-0">
            <RecoverButton compact onClick={recover}
              title={t('恢复这一轮：复用已完成的步骤，只补没跑完的（ZCode recover）')} />
          </span>
        ) : null}
        <span className={`${canRecover ? '' : 'ml-auto '}shrink-0 tabular-nums text-mute/55`}>{t('总耗时 {duration}', { duration: fmtWfDur(duration) })}</span>
      </div>
    </div>
  );
}

/* ---------- 命令执行不再出正文卡（run_command 过程只进时间线），仅保留时间线展开用的 CommandDetail ---------- */
const CMD_FOLD_LINES = 20;

function CmdOutBlock({ label, text, tone }) {
  const [open, setOpen] = useState(false);
  const lines = String(text || '').replace(/\n+$/, '').split('\n').filter((s, i, arr) => s !== '' || i < arr.length - 1);
  if (!lines.length) return null;
  const over = lines.length > CMD_FOLD_LINES;
  const shown = over && !open ? lines.slice(0, CMD_FOLD_LINES) : lines;
  return (
    <div>
      <div className="text-[11px] text-mute mb-1 font-mono">{t('{label} · {n} 行', { label, n: lines.length })}</div>
      <pre className={`rounded-lg bg-[#111114] border px-3 py-2 text-[11px] font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words ${tone}`}>
        {shown.join('\n')}
      </pre>
      {over && (
        <button onClick={() => setOpen(!open)}
          className="mt-1 text-[11px] text-mute hover:text-goldSoft transition-colors duration-150">
          {open ? t('收起') : t('展开全部 {n} 行', { n: lines.length })}
        </button>
      )}
    </div>
  );
}

/* ---------- 紧凑版命令详情（ProcessTimeline 时间线条目展开面板用） ----------
   命令 mono 金字 + 复制按钮 + 退出码徽标 + stdout/stderr（20 行折叠）。
   result 为空（tool-start 进行中态）时只显示命令，输出等 tool-end 后补全。 */
export function CommandDetail({ args, result }) {
  const [copied, setCopied] = useState(false);
  const r = asObj(parseMaybe(result)) || {};
  const argLines = formatToolArgs('run_command', args);
  const cmdLine = argLines.find((l) => l.label === 'command') || argLines[0] || null;
  // 完整命令原样展示（多行不压平）；解析失败时退回逐行文本的第一行
  const cmd = cmdLine?.value || t('(空命令)');
  const extraLines = argLines.filter((l) => l.label !== 'command');
  const code = r.code;
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = cmd; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* 忽略 */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-start gap-2 rounded-lg bg-[#0d0d10] border border-gold/25 px-3 py-2">
        <span className="shrink-0 select-none font-mono text-xs font-bold text-goldDeep leading-5">$</span>
        <code className="flex-1 min-w-0 font-mono text-xs text-goldSoft whitespace-pre-wrap break-all leading-5">{cmd || t('(空命令)')}</code>
        <button onClick={copy} title={t('复制命令')}
          className="shrink-0 badge font-mono text-[10px] bg-gold/10 text-goldSoft border border-gold/30 hover:bg-gold/20 transition-all duration-150">
          {copied ? t('已复制') : t('复制')}
        </button>
        {r.blocked ? (
          <span className="badge shrink-0 bg-red-500/15 text-red-300 border border-red-500/40 text-[10px] font-medium">{t('被安全策略拦截')}</span>
        ) : code != null ? (
          <span className={`badge shrink-0 font-mono text-[10px] tabular-nums ${code === 0 ? 'bg-jade/15 text-jade border border-jade/40' : 'bg-red-500/10 text-red-400 border border-red-500/40'}`}>
            exit {code}
          </span>
        ) : null}
      </div>
      {extraLines.length ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1 font-mono text-[10px] text-mute/60">
          {extraLines.map((l, i) => (
            <span key={i} className="inline-flex items-baseline gap-1 min-w-0 max-w-full">
              <span className="shrink-0 select-none text-mute/45">{l.label}</span>
              <span className="text-ink/70 break-all">{l.value}</span>
            </span>
          ))}
        </div>
      ) : null}
      {r.blocked ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300 leading-relaxed">
          {t('🚫 被安全策略拦截：命令命中灾难性操作规则，未执行')}
        </div>
      ) : result == null ? (
        <div className="text-[11px] text-goldDeep/90 font-mono animate-pulse">{t('执行中…输出结束后补全')}</div>
      ) : r.truncated ? (
        <CmdOutBlock label={t('输出（截断预览）')} text={r.preview} tone="border-edge text-ink/85" />
      ) : (
        <>
          <CmdOutBlock label="stdout" text={r.stdout} tone="border-edge text-ink/85" />
          {r.stderr ? <CmdOutBlock label="stderr" text={r.stderr} tone="border-red-500/25 text-red-300/90" /> : null}
        </>
      )}
    </div>
  );
}

/* ---------- 紧凑版通用工具详情（非 run_command）：参数逐行铺开 + 折叠结果 ----------
   参数默认全部展示（command/path/url/steps…），不再折叠成「参数已折叠」；
   result 若像 JSON 显示「已折叠（JSON）」+ 切换按钮。 */
export function GenericToolDetail({ name = '', args, result, running }) {
  const argLines = formatToolArgs(name, args);
  const parsedResult = parseMaybe(result);
  const looksJson = (parsedResult !== null && typeof parsedResult === 'object')
    || (typeof result === 'string' && /^\s*[\[{]/.test(result));
  const resultText = result == null ? '' : (typeof result === 'string' ? result : safeJson(result));
  const keyCount = looksJson
    ? ((parsedResult !== null && typeof parsedResult === 'object')
      ? Object.keys(parsedResult).length
      : (resultText.match(/"[A-Za-z_][\w-]*"\s*:/g) || []).length)
    : 0;
  const hint = looksJson
    ? t('{n} 字符 · {m} 个字段', { n: resultText.length, m: keyCount })
    : summarizeToolArgs('', String(resultText));
  return (
    <div className="space-y-2 text-[11px]">
      <div>
        <div className="text-mute mb-1 font-mono">{t('参数')}</div>
        <div className="rounded-lg bg-[#0d0d10] border border-edge px-2.5 py-2 space-y-1.5">
          {argLines.length ? argLines.map((line, i) => (
            <div key={i} className="flex items-start gap-2 min-w-0">
              {line.label ? (
                <span className="shrink-0 select-none font-mono text-[10px] leading-5 text-mute/60">{line.label}</span>
              ) : null}
              <span className="flex-1 min-w-0 font-mono text-ink/85 whitespace-pre-wrap break-all leading-5">{line.value}</span>
            </div>
          )) : <div className="font-mono text-mute/40">{t('无参数')}</div>}
        </div>
      </div>
      {result != null ? (
        <div>
          <div className="text-mute mb-1 font-mono">{t('结果')}</div>
          <FoldedRaw
            text={resultText}
            label={looksJson ? t('已折叠（JSON）') : t('已折叠')}
            hint={hint}
          />
        </div>
      ) : (
        <div className="text-goldDeep/90 font-mono animate-pulse">{running ? t('执行中…') : ''}</div>
      )}
    </div>
  );
}

/** trace 数组 → 正文交付物卡序列：只渲染白名单工具的结果卡（报告/探测表/压测统计），
 *  run_command 等过程类工具一律不出正文卡——其过程细节只在消息顶部 ProcessTimeline 时间线里。 */
export function TraceBlock({ trace, onOpenStep = null, onRecover = null }) {
  if (!trace?.length) return null;
  // ask_user 的问答卡也放在这里：历史加载后从 tool part 还原（answered/cancelled/expired 只读态）
  const cards = trace.filter((t) => BODY_CARD_TOOLS.has(t.tool) || t.tool === 'ask_user');
  if (!cards.length) return null;
  return (
    <div>
      {cards.map((t, i) => {
        if (t.tool === 'ask_user') return <AskUserCard key={i} payload={askUserCardFromTrace(t)} />;
        if (t.tool === 'audit_project' || t.tool === 'get_report') return <ReportCard key={i} args={t.args} result={t.result} />;
        if (t.tool === 'probe_target') return <ProbeCard key={i} args={t.args} result={t.result} />;
        if (t.tool === 'stress_target') return <StressCard key={i} args={t.args} result={t.result} />;
        if (t.tool === 'run_workflow') return <WorkflowCard key={i} args={t.args} result={t.result} onOpenStep={onOpenStep} onRecover={onRecover} />;
        return null;
      })}
    </div>
  );
}
