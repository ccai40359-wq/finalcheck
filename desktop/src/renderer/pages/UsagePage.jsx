// Usage stats 页面（仿 ZCode 黑金风格）：统计卡 + Token 活动热力图 + 每日趋势折线 + 模型占比甜甜圈
// 全部图表用内联 SVG / div 手写，不引入图表库。
// 后端契约：window.finalcheck.usageStats({days:7|30})；接口缺失或返回旧/空数据时全部优雅降级。
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Card } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';
import { useLanguage } from '../i18n/index.jsx';
import { startUsagePolling } from '../lib/usage-poll.mjs';

const PALETTE = ['#e3c56b', '#c9a227', '#7aa2ff', '#6fd3c7', '#9b8cff', '#d38f6f', '#c6d36f', '#a9a2ff'];
const OTHERS_COLOR = '#6d685f';
const MAX_MODEL_ROWS = 6;   // 甜甜圈最多 6 个模型，其余合并成 others
const MAX_TREND_LINES = 5;  // 折线最多 5 条模型线

/* ---------------- 格式化 / 日期 ---------------- */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

function fmtTokens(n) {
  const v = num(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(v));
}

function fmtDuration(ms) {
  const v = num(ms);
  if (v <= 0) return '—';
  const sec = Math.round(v / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function dateKeyOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    const d = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : localDateKey(d);
  }
  const s = String(value).trim();
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : localDateKey(d);
}

function recentKeys(count) {
  const n = Math.max(1, Math.min(90, Math.trunc(Number(count)) || 30));
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    out.push(localDateKey(d));
  }
  return out;
}

const shortDate = (key) => {
  const [, m, d] = String(key || '').split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : String(key || '');
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 悬停卡头部用英文短日期（Nov 9），与 ZCode 浮层一致
const dayLabel = (key) => {
  const [, m, d] = String(key || '').split('-');
  const mi = Number(m);
  const di = Number(d);
  return mi >= 1 && mi <= 12 && di ? `${MONTH_ABBR[mi - 1]} ${di}` : String(key || '');
};

// 悬停卡数值比图表轴更细：371.2M 而不是 371M
function fmtTokensFine(v) {
  const n = num(v);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/* ---------------- 数据归一化 ---------------- */
function tokenValue(v) {
  if (v && typeof v === 'object') return num(v.tokens ?? v.total);
  return num(v);
}

export function normalizeUsageStats(raw, windowDays) {
  const rec = raw && typeof raw === 'object' ? raw : {};
  const byDate = new Map();
  for (const d of Array.isArray(rec.days) ? rec.days : []) {
    const key = dateKeyOf(d?.date ?? d?.day ?? d?.dayKey);
    if (!key) continue;
    const byModel = {};
    if (d?.byModel && typeof d.byModel === 'object') {
      for (const [model, v] of Object.entries(d.byModel)) byModel[String(model)] = tokenValue(v);
    }
    const total = num(d?.total) || sum(Object.values(byModel));
    const prev = byDate.get(key);
    if (prev) {
      prev.total += total;
      for (const [model, v] of Object.entries(byModel)) prev.byModel[model] = (prev.byModel[model] || 0) + v;
    } else {
      byDate.set(key, { total, byModel });
    }
  }

  const series = recentKeys(windowDays).map((date) => {
    const hit = byDate.get(date);
    return { date, total: hit?.total || 0, byModel: hit?.byModel || {} };
  });

  // 模型总量：优先用后端 models（全历史，含 share）；缺失时退回窗口内 byModel 聚合
  const windowModelTotals = new Map();
  for (const day of series) {
    for (const [model, v] of Object.entries(day.byModel)) {
      windowModelTotals.set(model, (windowModelTotals.get(model) || 0) + num(v));
    }
  }

  let modelRows = [];
  const providedModels = Array.isArray(rec.models) ? rec.models : [];
  if (providedModels.length) {
    modelRows = providedModels.map((m) => ({
      model: String(m?.model ?? m?.name ?? 'unknown'),
      tokens: tokenValue(m?.tokens),
      share: num(m?.share)
    })).filter((m) => m.tokens > 0);
  }
  if (!modelRows.length && windowModelTotals.size) {
    modelRows = [...windowModelTotals.entries()]
      .map(([model, tokens]) => ({ model, tokens, share: 0 }))
      .filter((m) => m.tokens > 0);
  }
  modelRows.sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));

  const windowTotal = sum(series.map((s) => s.total));
  const providedTotal = numOrNull(rec.totalTokens);
  const totalTokens = providedTotal != null ? providedTotal : (windowTotal || sum(modelRows.map((m) => m.tokens)));
  const peakTokens = numOrNull(rec.peakTokens) ?? Math.max(0, ...series.map((s) => s.total));

  // streak：后端有就直用；旧数据缺字段时按窗口估算
  const { currentFallback, longestFallback } = streakOf(series);
  const currentStreakDays = numOrNull(rec.currentStreakDays) ?? currentFallback;
  const longestStreakDays = numOrNull(rec.longestStreakDays) ?? longestFallback;
  const longestSessionMs = num(rec.longestSessionMs);

  // 甜甜圈：最多 6 个模型，其余合并成 others
  const modelTotal = sum(modelRows.map((m) => m.tokens)) || totalTokens;
  let slices = modelRows.slice(0, MAX_MODEL_ROWS);
  const restTokens = sum(modelRows.slice(MAX_MODEL_ROWS).map((m) => m.tokens));
  if (restTokens > 0) slices = [...slices, { model: 'others', tokens: restTokens, share: 0, others: true }];
  slices = slices.map((s) => ({
    ...s,
    share: modelTotal > 0 ? (s.tokens / modelTotal) * 100 : num(s.share) * (num(s.share) > 1 ? 1 : 100)
  }));

  // 趋势：窗口内按模型总量取前 5；没有明细但有总量时退回一条「all models」线
  const trendTotals = [...windowModelTotals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  let trendModels = trendTotals.slice(0, MAX_TREND_LINES).map(([model], i) => ({
    model, color: PALETTE[i % PALETTE.length], all: false
  }));
  if (!trendModels.length && windowTotal > 0) {
    trendModels = [{ model: 'all models', color: PALETTE[0], all: true }];
  }

  const activeDays = series.filter((s) => s.total > 0).length;
  const bestDay = series.reduce((best, s) => (s.total > (best?.total || 0) ? s : best), null);
  const avgDaily = activeDays > 0 ? windowTotal / activeDays : 0;

  return {
    raw: rec,
    series,
    totalTokens,
    peakTokens,
    currentStreakDays,
    longestStreakDays,
    longestSessionMs,
    modelRows,
    slices,
    modelTotal,
    trendModels,
    windowTotal,
    activeDays,
    bestDay,
    avgDaily,
    empty: totalTokens <= 0 && windowTotal <= 0 && !modelRows.length
  };
}

function streakOf(series) {
  let longest = 0;
  let run = 0;
  for (const s of series) {
    if (s.total > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else run = 0;
  }
  let i = series.length - 1;
  if (i >= 0 && series[i].total <= 0) i -= 1; // 今天还没用：以昨天为最后一天算当前连续
  let current = 0;
  while (i >= 0 && series[i].total > 0) {
    current += 1;
    i -= 1;
  }
  return { currentFallback: current, longestFallback: longest };
}

/* ---------------- 图表组件 ---------------- */
function StatCard({ label, value, sub, accent = false }) {
  return (
    <div className="glass-card rounded-2xl px-4 py-3.5 min-w-0">
      <div className="text-[10px] tracking-[0.14em] uppercase text-mute/55 truncate">{label}</div>
      <div className={`mt-1.5 text-[22px] leading-7 font-mono tabular-nums truncate ${accent ? 'text-goldSoft' : 'text-ink/90'}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[10px] text-mute/45 truncate">{sub}</div> : null}
    </div>
  );
}

function TokenHeatmap({ series }) {
  const [tip, setTip] = useState(null);
  const max = Math.max(0, ...series.map((s) => s.total));
  const cols = Math.min(7, Math.max(1, series.length));
  const cell = series.length <= 7 ? 34 : 26;
  const gap = series.length <= 7 ? 8 : 6;

  const levelOf = (v) => {
    if (v <= 0 || max <= 0) return 0;
    const r = v / max;
    if (r >= 0.75) return 4;
    if (r >= 0.5) return 3;
    if (r >= 0.25) return 2;
    return 1;
  };
  const alpha = [0, 0.18, 0.36, 0.58, 0.86];

  const showTip = (e, day) => {
    const el = e.currentTarget;
    const x = el.offsetLeft + el.offsetWidth / 2;
    const above = el.offsetTop > 32;
    setTip({
      x,
      y: above ? el.offsetTop - 30 : el.offsetTop + el.offsetHeight + 8,
      text: `${day.date} · ${fmtTokens(day.total)} tokens`
    });
  };

  return (
    <div className="relative inline-block" onMouseLeave={() => setTip(null)}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gap }}>
        {series.map((day) => {
          const lv = levelOf(day.total);
          return (
            <div
              key={day.date}
              title={`${day.date} · ${fmtTokens(day.total)} tokens`}
              onMouseEnter={(e) => showTip(e, day)}
              className="rounded-[6px] border border-white/[0.05] transition-[background-color,box-shadow] duration-200 hover:border-gold/40"
              style={{
                width: cell,
                height: cell,
                backgroundColor: lv === 0 ? 'rgba(255,255,255,0.045)' : `rgba(201,162,39,${alpha[lv]})`,
                boxShadow: lv === 4 ? 'inset 0 0 0 1px rgba(227,197,107,0.35)' : undefined
              }}
            />
          );
        })}
      </div>
      {tip && (
        <div className="glass-pop pointer-events-none absolute z-20 -translate-x-1/2 whitespace-nowrap rounded-lg px-2 py-1 text-[10px] text-ink/90"
          style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-mute/40">
        <span>{series[0]?.date || ''}</span>
        <span className="text-mute/25">→</span>
        <span>{series.length ? t('今天') : ''}</span>
      </div>
    </div>
  );
}

function HeatLegend() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-mute/40 select-none">
      <span>{t('少')}</span>
      <span className="h-3 w-3 rounded-[3px] bg-white/[0.05] border border-white/[0.05]" />
      <span className="h-3 w-3 rounded-[3px]" style={{ backgroundColor: 'rgba(201,162,39,0.18)' }} />
      <span className="h-3 w-3 rounded-[3px]" style={{ backgroundColor: 'rgba(201,162,39,0.36)' }} />
      <span className="h-3 w-3 rounded-[3px]" style={{ backgroundColor: 'rgba(201,162,39,0.58)' }} />
      <span className="h-3 w-3 rounded-[3px]" style={{ backgroundColor: 'rgba(201,162,39,0.86)' }} />
      <span>{t('多')}</span>
    </div>
  );
}

function TrendChart({ series, models }) {
  const W = 900;
  const H = 260;
  const PL = 54;
  const PR = 14;
  const PT = 14;
  const PB = 32;
  const innerW = W - PL - PR;
  const innerH = H - PT - PB;
  const n = series.length;
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const cardRef = useRef(null);
  const lastClientRef = useRef(null);
  const [hover, setHover] = useState(null); // { i, gx, py, cw, ch }
  const [cardSize, setCardSize] = useState({ w: 0, h: 0 });

  const valueOf = (day, m) => num(m.all ? day.total : day.byModel[m.model]);
  const maxValue = Math.max(1, ...series.map((day) => Math.max(...models.map((m) => valueOf(day, m)), 0)));
  const xAt = (i) => PL + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const yAt = (v) => PT + innerH - (v / maxValue) * innerH;

  const ticks = n <= 7 ? series.map((_, i) => i) : [...new Set([
    0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((n - 1) * 3 / 4), n - 1
  ])];

  // 指针 clientX/Y → viewBox 坐标：getBoundingClientRect + preserveAspectRatio letterbox 换算，
  // 不写死像素，容器 resize 后仍对齐。
  const locate = (clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scale = Math.min(rect.width / W, rect.height / H);
    const offX = (rect.width - W * scale) / 2;
    const offY = (rect.height - H * scale) / 2;
    return {
      rect,
      scale,
      offX,
      vx: (clientX - rect.left - offX) / scale,
      vy: (clientY - rect.top - offY) / scale
    };
  };

  // 吸附到最近一天；只在绘图区内生效（离开即隐藏，含触摸 pointercancel/lostpointercapture）
  const updateFromClient = useCallback((clientX, clientY) => {
    const wrap = wrapRef.current;
    const loc = locate(clientX, clientY);
    if (!wrap || !loc) return;
    if (loc.vx < PL || loc.vx > W - PR || loc.vy < 0 || loc.vy > H) { setHover(null); return; }
    const i = n <= 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((loc.vx - PL) / innerW) * (n - 1))));
    const wrapRect = wrap.getBoundingClientRect();
    setHover({
      i,
      gx: loc.rect.left - wrapRect.left + loc.offX + xAt(i) * loc.scale, // 参考线在容器内的像素 x
      py: clientY - wrapRect.top,
      cw: wrapRect.width,
      ch: wrapRect.height
    });
  }, [n, innerW]);

  const onPointerMove = (e) => {
    lastClientRef.current = { x: e.clientX, y: e.clientY };
    updateFromClient(e.clientX, e.clientY);
  };
  const onPointerLeave = () => {
    lastClientRef.current = null;
    setHover(null);
  };

  // 窗口 / 容器尺寸变化后按最后一次指针位置重算，避免浮层与线错位
  useEffect(() => {
    const onResize = () => {
      if (lastClientRef.current) updateFromClient(lastClientRef.current.x, lastClientRef.current.y);
    };
    window.addEventListener('resize', onResize);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && wrapRef.current) {
      ro = new ResizeObserver(onResize);
      ro.observe(wrapRef.current);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
    };
  }, [updateFromClient]);

  // 数据窗口切换（7/30 天）或刷新后，旧 index 可能不再对应同一天
  useEffect(() => { setHover(null); }, [series, models]);

  // 浮层尺寸实测：宽度用于左右翻转判定，高度用于垂直夹取
  useLayoutEffect(() => {
    if (!hover || !cardRef.current) return;
    const w = cardRef.current.offsetWidth;
    const h = cardRef.current.offsetHeight;
    if (Math.abs(w - cardSize.w) > 0.5 || Math.abs(h - cardSize.h) > 0.5) setCardSize({ w, h });
  }, [hover, cardSize.w, cardSize.h]);

  const hoverDay = hover && hover.i < n ? series[hover.i] : null;
  const rows = hoverDay
    ? models
      .map((m) => ({ model: m.model, color: m.color, value: valueOf(hoverDay, m) }))
      .sort((a, b) => b.value - a.value || a.model.localeCompare(b.model))
    : [];
  const rowsShown = rows.length > 6 ? rows.slice(0, 5) : rows;
  const rowsOverflow = rows.length > 6;

  const gap = 12;
  const cardW = cardSize.w || 172;
  const cardH = cardSize.h || 20 + rowsShown.length * 16 + (rowsOverflow ? 14 : 0);
  let cardLeft = hover ? hover.gx + gap : 0; // 默认参考线右侧
  let cardTop = 0;
  if (hover) {
    if (cardLeft + cardW > hover.cw - 4) cardLeft = hover.gx - gap - cardW; // 靠近右边界翻到参考线左侧
    cardLeft = Math.max(4, Math.min(cardLeft, Math.max(4, hover.cw - cardW - 4)));
    cardTop = Math.max(4, Math.min(hover.py - cardH / 2, hover.ch - cardH - 4)); // 垂直方向不溢出容器
  }

  return (
    <div
      ref={wrapRef}
      className="relative"
      role="group"
      aria-label={t('Daily token trend 图表，悬停或用手指拖动可查看每日各模型用量')}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerLeave}
    >
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-[260px] block" role="img" aria-label={t('每日 Token 趋势')}
        style={{ touchAction: 'none' }}>
        {[0, 0.5, 1].map((r) => {
          const y = PT + innerH - r * innerH;
          return (
            <g key={r}>
              <line x1={PL} x2={W - PR} y1={y} y2={y}
                stroke={r === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.055)'} strokeDasharray={r === 0 ? '' : '4 6'} />
              <text x={PL - 8} y={y + 3.5} textAnchor="end" fontSize="10" fill="rgba(154,147,138,0.55)" fontFamily="monospace">
                {fmtTokens(maxValue * r)}
              </text>
            </g>
          );
        })}
        {ticks.map((i) => (
          <text key={i} x={xAt(i)} y={H - 10} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            fontSize="10" fill="rgba(154,147,138,0.5)" fontFamily="monospace">
            {shortDate(series[i]?.date)}
          </text>
        ))}
        {hover && hoverDay && (
          <line x1={xAt(hover.i)} x2={xAt(hover.i)} y1={PT} y2={PT + innerH}
            stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
        )}
        {models.map((m) => {
          const pts = series.map((day, i) => ({ x: xAt(i), y: yAt(valueOf(day, m)), v: valueOf(day, m), date: day.date }));
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
          const last = pts[pts.length - 1];
          return (
            <g key={m.model}>
              <path d={d} fill="none" stroke={m.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
              {pts.map((p) => (
                <circle key={p.date} cx={p.x} cy={p.y} r={n <= 10 ? 2.6 : 1.7} fill={'#0a0a0c'} stroke={m.color} strokeWidth="1.6">
                  <title>{`${p.date} · ${m.model} · ${fmtTokens(p.v)} tokens`}</title>
                </circle>
              ))}
              {last ? <circle cx={last.x} cy={last.y} r="3.2" fill={m.color} /> : null}
            </g>
          );
        })}
        {hover && hoverDay && models.map((m) => (
          <circle key={`hv-${m.model}`} cx={xAt(hover.i)} cy={yAt(valueOf(hoverDay, m))} r="3.6"
            fill="#0a0a0c" stroke={m.color} strokeWidth="1.6" />
        ))}
      </svg>
      {hover && hoverDay && (
        <div ref={cardRef} data-testid="trend-tooltip"
          className="pointer-events-none absolute z-20 rounded-xl px-2.5 py-2 text-[11px]"
          style={{
            left: cardLeft,
            top: cardTop,
            width: 'max-content',
            backgroundColor: 'rgba(20,20,24,0.88)',
            border: '1px solid rgba(255,255,255,0.10)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 18px 48px rgba(0,0,0,0.55)',
            backdropFilter: 'blur(14px) saturate(160%)',
            WebkitBackdropFilter: 'blur(14px) saturate(160%)'
          }}>
          <div className="whitespace-nowrap font-mono tabular-nums text-[11px] leading-none text-ink/90">
            {dayLabel(hoverDay.date)} · {fmtTokensFine(hoverDay.total)} tokens
          </div>
          <div className="mt-1.5 space-y-1">
            {rowsShown.map((r) => (
              <div key={r.model} className="flex items-center gap-1.5 leading-none">
                <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                <span className="truncate max-w-[132px] text-[11px] text-mute/75" title={r.model}>{r.model}</span>
                <span className="ml-auto pl-4 text-right font-mono tabular-nums text-[11px] text-ink/85">{fmtTokensFine(r.value)}</span>
              </div>
            ))}
            {rowsOverflow ? <div className="text-center text-[11px] leading-none text-mute/45">…</div> : null}
          </div>
        </div>
      )}
    </div>
  );
}

/* 甜甜圈：极坐标 + 内外圆弧 path（带 evenodd 的整圆环兜底） */
function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function donutSlice(cx, cy, rOut, rIn, start, end) {
  const large = end - start > 180 ? 1 : 0;
  const [x1, y1] = polar(cx, cy, rOut, start);
  const [x2, y2] = polar(cx, cy, rOut, end);
  const [x3, y3] = polar(cx, cy, rIn, end);
  const [x4, y4] = polar(cx, cy, rIn, start);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rOut} ${rOut} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} `
    + `L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${rIn} ${rIn} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
}

function fullDonut(cx, cy, rOut, rIn) {
  return `M ${cx} ${cy - rOut} A ${rOut} ${rOut} 0 1 1 ${cx} ${cy + rOut} A ${rOut} ${rOut} 0 1 1 ${cx} ${cy - rOut} Z `
    + `M ${cx} ${cy - rIn} A ${rIn} ${rIn} 0 1 0 ${cx} ${cy + rIn} A ${rIn} ${rIn} 0 1 0 ${cx} ${cy - rIn} Z`;
}

function ModelDonut({ slices, total }) {
  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const rOut = 74;
  const rIn = 52;
  let acc = 0;
  const full = slices.length === 1 && slices[0].share >= 99.99;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" role="img" aria-label={t('模型用量')}>
      {slices.map((s, i) => {
        const angle = Math.max(0, (s.tokens / (sum(slices.map((x) => x.tokens)) || 1)) * 360);
        const start = acc;
        acc += angle;
        const color = s.others ? OTHERS_COLOR : PALETTE[i % PALETTE.length];
        const gap = slices.length > 1 ? Math.min(1.6, angle / 4) : 0;
        const d = full ? fullDonut(cx, cy, rOut, rIn) : donutSlice(cx, cy, rOut, rIn, start + gap, start + angle - gap);
        return (
          <path key={s.model + i} d={d} fill={color} fillRule="evenodd" opacity="0.95">
            <title>{`${s.model} · ${s.share.toFixed(1)}% · ${fmtTokens(s.tokens)} tokens`}</title>
          </path>
        );
      })}
      <text x={cx} y={cy - 6} textAnchor="middle" fontSize="10" letterSpacing="1.4" fill="rgba(154,147,138,0.55)" fontFamily="monospace">TOTAL</text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize="18" fill="#e3c56b" fontFamily="monospace">{fmtTokens(total)}</text>
      <text x={cx} y={cy + 27} textAnchor="middle" fontSize="8.5" fill="rgba(154,147,138,0.4)" fontFamily="monospace">tokens</text>
    </svg>
  );
}

/* ---------------- 页面 ---------------- */
export default function UsagePage({ running = false }) {
  useLanguage(); // 切换语言后本页跟着重渲染（t() 读的是模块级语言状态）
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [diagMsg, setDiagMsg] = useState(null); // { key, vars? }：渲染时取译文
  const reqRef = useRef(0);

  const load = useCallback(async (windowDays, { silent = false } = {}) => {
    const y = api();
    const seq = ++reqRef.current;
    if (!y?.usageStats) {
      setUnsupported(true);
      setStats(null);
      setLoading(false);
      return;
    }
    setUnsupported(false);
    // 自动轮询走静默刷新：不闪 loading、不禁用按钮，只换数字
    if (!silent) setLoading(true);
    if (!silent) setErr('');
    try {
      const r = await y.usageStats({ days: windowDays });
      if (seq !== reqRef.current) return;
      setStats(r && typeof r === 'object' ? r : null);
    } catch (e) {
      if (seq !== reqRef.current) return;
      if (silent) return; // 自动刷新失败保持上一屏数字，不把页面打成错误态
      setErr(e?.message || String(e));
      setStats(null);
    } finally {
      if (seq === reqRef.current && !silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  // 回合进行中：每 5 秒静默刷新一次，数字跟着涨；回合结束（running=false）自动停，不常驻轮询。
  useEffect(() => startUsagePolling({
    running,
    unsupported,
    tick: () => { load(days, { silent: true }); }
  }), [running, unsupported, days, load]);

  // 诊断包导出（配置脱敏由主进程做）；接口缺失时只提示，不影响页面
  const exportDiagnostics = async () => {
    const y = api();
    if (exporting) return;
    if (!y?.exportDiagnostics) { setDiagMsg({ key: '当前版本不支持导出诊断' }); return; }
    setExporting(true);
    setDiagMsg(null);
    try {
      const r = await y.exportDiagnostics();
      if (r?.canceled) setDiagMsg({ key: '已取消' });
      else if (r?.ok && r?.path) setDiagMsg({ key: '已导出：{path}', vars: { path: r.path } });
      else setDiagMsg({ key: r?.error || '导出失败' });
    } catch (e) {
      setDiagMsg({ key: '导出失败：{msg}', vars: { msg: e?.message || String(e) } });
    } finally { setExporting(false); }
  };

  const view = useMemo(() => normalizeUsageStats(stats, days), [stats, days]);
  const hasWindow = view.windowTotal > 0;         // 窗口内有逐日数据（热力图/折线）
  const hasAny = !view.empty;                     // 全历史有记录（甜甜圈/统计卡）
  const loadingEmpty = loading && !stats;         // 首屏还在读数据，别闪「没有记录」
  const statValue = (v) => (loadingEmpty ? '—' : v);
  const streakDays = (n) => (n === 1 ? t('1 天') : t('{n} 天', { n }));
  const diagText = diagMsg ? t(diagMsg.key, diagMsg.vars) : '';
  const formatShare = (s) => {
    if (Number.isFinite(s)) return `${s.toFixed(1)}%`;
    return '—';
  };

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="usage-page">
      {/* 页头：与设置页其他分节一致（大标题 + 副标题 + 右侧操作） */}
      <div className="shrink-0 px-8 pt-6 pb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-kai text-[22px] leading-tight text-goldSoft">{t('用量统计')}</h1>
          <p className="text-[12px] text-mute mt-1.5 leading-relaxed">{t('本机 token 活动、每日趋势与模型占比。')}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={exportDiagnostics} disabled={exporting}
            className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-50">
            {exporting ? t('导出中…') : t('导出诊断')}
          </button>
          <button onClick={() => load(days)} disabled={loading}
            className="btn-ghost text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-50">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={loading ? 'fc-spin' : ''}>
              <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" />
            </svg>
            {loading ? t('刷新中…') : t('刷新')}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-5 space-y-4">
          {err && (
            <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-2.5 text-xs text-red-300">
              {t('读取用量失败：{msg}', { msg: err })}
            </div>
          )}

          {/* 5 张统计卡 */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label={t('总 tokens')} value={statValue(fmtTokens(view.totalTokens))} sub={t('全部历史')} accent />
            <StatCard label={t('单日峰值')} value={statValue(fmtTokens(view.peakTokens))} sub={t('单日最高')} />
            <StatCard label={t('最长会话')} value={statValue(fmtDuration(view.longestSessionMs))} sub={t('单次会话时长')} />
            <StatCard label={t('当前连续')} value={statValue(streakDays(view.currentStreakDays))} sub={t('当前连续使用')} />
            <StatCard label={t('最长连续')} value={statValue(streakDays(view.longestStreakDays))} sub={t('历史最长连续')} />
          </div>

          {/* Token 活动热力图 */}
          <Card className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm text-ink font-medium">{t('Token 活动')}</div>
                <div className="mt-0.5 text-[11px] text-mute/60">{t('最近 {days} 天，每格一天，颜色越深用量越高', { days })}</div>
              </div>
              <HeatLegend />
            </div>
            {loadingEmpty ? (
              <div className="mt-6 mb-2 text-center text-xs text-mute/45">{t('正在读取用量…')}</div>
            ) : hasWindow ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-6">
                <TokenHeatmap series={view.series} />
                <div className="flex items-center gap-8 text-right">
                  <div>
                    <div className="text-[10px] text-mute/45">{t('活跃天数')}</div>
                    <div className="mt-0.5 font-mono text-sm text-ink/85 tabular-nums">{view.activeDays} / {days}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-mute/45">{t('最高单日')}</div>
                    <div className="mt-0.5 font-mono text-sm text-goldSoft tabular-nums">{fmtTokens(view.bestDay?.total || 0)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-mute/45">{t('日均（活跃日）')}</div>
                    <div className="mt-0.5 font-mono text-sm text-ink/85 tabular-nums">{fmtTokens(view.avgDaily)}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-6 mb-2 text-center text-sm text-mute/70">{t('最近 {days} 天还没有用量记录，跑一次对话就会有了', { days })}</div>
            )}
          </Card>

          {/* 每日趋势折线 */}
          <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-ink font-medium">{t('每日 Token 趋势')}</div>
                <div className="mt-0.5 text-[11px] text-mute/60">{t('按模型分色，X 轴日期，Y 轴 token')}</div>
              </div>
              <div className="flex items-center gap-1 rounded-full bg-white/[0.04] p-0.5">
                {[7, 30].map((d) => (
                  <button key={d} onClick={() => setDays(d)}
                    className={`rounded-full px-3 py-1 text-[11px] transition-colors duration-200 ${
                      days === d ? 'bg-gold/15 text-goldSoft shadow-[inset_0_0_0_1px_rgba(201,162,39,0.35)]' : 'text-mute/60 hover:text-ink'}`}>
                    {t('最近 {d} 天', { d })}
                  </button>
                ))}
              </div>
            </div>
            {loadingEmpty ? (
              <div className="h-[220px] flex items-center justify-center text-xs text-mute/45">{t('正在读取用量…')}</div>
            ) : hasWindow ? (
              <>
                <TrendChart series={view.series} models={view.trendModels} />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 pt-1">
                  {view.trendModels.map((m) => (
                    <span key={m.model} className="inline-flex items-center gap-1.5 text-[11px] text-mute/70 min-w-0">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                      <span className="truncate max-w-[220px]" title={m.model}>{m.model}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-sm text-mute/60">
                {t('还没有用量记录，跑一次对话就会有了')}
              </div>
            )}
          </Card>

          {/* 模型占比 */}
          <Card className="p-4">
            <div className="text-sm text-ink font-medium">{t('模型用量')}</div>
            <div className="mt-0.5 text-[11px] text-mute/60">{t('模型 token 占比，最多列 6 个，其余归入 others')}</div>
            {loadingEmpty ? (
              <div className="py-10 text-center text-xs text-mute/45">{t('正在读取用量…')}</div>
            ) : hasAny && view.slices.length ? (
              <div className="mt-3 flex flex-col sm:flex-row items-center gap-6">
                <ModelDonut slices={view.slices} total={view.modelTotal || view.totalTokens} />
                <div className="w-full min-w-0 flex-1 space-y-2">
                  {view.slices.map((s, i) => (
                    <div key={s.model + i} className="flex items-center gap-2 text-[11px]">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: s.others ? OTHERS_COLOR : PALETTE[i % PALETTE.length] }} />
                      <span className="min-w-0 flex-1 truncate text-ink/80" title={s.model}>{s.model}</span>
                      <span className="w-14 text-right font-mono tabular-nums text-mute/60">{formatShare(s.share)}</span>
                      <span className="w-16 text-right font-mono tabular-nums text-ink/75">{fmtTokens(s.tokens)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="py-10 text-center text-sm text-mute/60">{t('还没有用量记录，跑一次对话就会有了')}</div>
            )}
          </Card>

          {unsupported && !loading && (
            <div className="text-center text-[11px] text-mute/40">{t('当前版本未提供 usageStats 接口（后端接入后自动生效）')}</div>
          )}

          {/* 导出/刷新状态提示（按钮已移到页头右侧） */}
          {diagMsg && (
            <div className="flex items-center justify-end pb-3">
              <span className="min-w-0 truncate text-[11px] text-mute/55" title={diagText}>{diagText}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
