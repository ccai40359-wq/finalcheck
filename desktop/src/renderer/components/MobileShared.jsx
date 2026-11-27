// 手机访问的共用小部件：设置页「手机访问」和侧栏底部的手机面板共用。
import React, { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';

export const inputCls = 'rounded-lg border border-edge/70 bg-well px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-gold/50';

/** 订阅主进程的手机访问状态（finalcheck:mobile:changed 实时推） */
export function useMobileState() {
  const m = api()?.mobile;
  const [st, setSt] = useState(null);
  useEffect(() => {
    if (!m) return undefined;
    let alive = true;
    m.state().then((s) => { if (alive) setSt(s); }).catch(() => {});
    const off = m.onChanged?.((s) => { if (alive) setSt(s); });
    return () => { alive = false; off?.(); };
  }, [m]);
  return [st, setSt, m];
}

/** 每秒一跳（倒计时 / 「x 秒前」用） */
export function useNow(active = true, every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [active, every]);
  return now;
}

export function Switch({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 ${on ? 'bg-gold/80' : 'bg-edge'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

export function useCopy() {
  const [done, setDone] = useState(false);
  const copy = async (value) => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* 剪贴板不可用就手动选 */ }
  };
  return [done, copy];
}

export function CopyLine({ value, label }) {
  const [done, copy] = useCopy();
  return (
    <div className="flex items-center gap-2 min-w-0">
      <input readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} className={`${inputCls} flex-1 min-w-0`} />
      <button type="button" className="btn-ghost shrink-0 text-[12px]" onClick={() => copy(value)}>{done ? t('已复制') : t('复制')}</button>
    </div>
  );
}

/** 二维码（SVG，白底黑块：手机摄像头在深色主题下也扫得出） */
export function QrCode({ value, size = 184 }) {
  const svg = useMemo(() => {
    if (!value) return null;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(value, 'Byte');
      qr.make();
      const n = qr.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { n, d };
    } catch { return null; }
  }, [value]);
  if (!svg) return null;
  const q = 2; // 安静区（模块数）
  return (
    <div className="rounded-xl bg-white p-2.5 inline-block" data-testid="mobile-qr">
      <svg width={size} height={size} viewBox={`${-q} ${-q} ${svg.n + q * 2} ${svg.n + q * 2}`} shapeRendering="crispEdges" role="img" aria-label={t('配对二维码')}>
        <path d={svg.d} fill="#000" />
      </svg>
    </div>
  );
}

export function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return t('刚刚');
  if (s < 3600) return t('{n} 分钟前', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} 小时前', { n: Math.round(s / 3600) });
  return new Date(ts).toLocaleString();
}

const VIA = { internet: '外网', lan: '局域网', local: '本机' };

/** 「连着哪台手机」：在线（绿点）/ 最近一次（灰点）/ 还没绑定 */
export function DeviceLine({ st, now }) {
  const d = st?.device;
  if (!d) return <div className="text-[12px] text-mute">{t('还没绑定手机')}</div>;
  return (
    <div className="flex items-center gap-2 text-[12px] min-w-0" data-testid="mobile-device">
      <span className={`h-2 w-2 rounded-full shrink-0 ${d.online ? 'bg-emerald-400' : 'bg-mute/40'}`} />
      <span className="text-ink truncate">{d.deviceName || t('手机')}</span>
      <span className="text-mute shrink-0">
        {d.online
          ? `${t('在线')}${d.via ? ` · ${t(VIA[d.via] || d.via)}` : ''}`
          : d.lastSeenAt ? t('离线 · 最近 {when}', { when: ago(d.lastSeenAt, now) }) : t('已绑定 · 本次还没连过')}
      </span>
    </div>
  );
}

const TUNNEL_TEXT = {
  off: ['bg-mute/40', '外网访问已关闭'],
  connecting: ['bg-amber-400', '正在连接服务器…'],
  up: ['bg-emerald-400', '外网已连通'],
  unreachable: ['bg-amber-400', '隧道已连上，但公网地址打不开'],
  error: ['bg-red-400', '隧道断开，正在重连']
};
/** 隧道状态一行：状态点 + 说明 + 出错原因 */
export function TunnelLine({ st, onRetry, compact = false }) {
  const tn = st?.tunnel;
  if (!tn) return null;
  if (!tn.enabled) {
    return compact ? null : <div className="text-[12px] text-mute">{t('外网访问没开：只能在同一个 Wi-Fi / 热点下连')}</div>;
  }
  const [dot, label] = TUNNEL_TEXT[tn.status] || TUNNEL_TEXT.error;
  return (
    <div className="space-y-1" data-testid="mobile-tunnel">
      <div className="flex items-center gap-2 text-[12px]">
        <span className={`h-2 w-2 rounded-full shrink-0 ${dot}`} />
        <span className="text-ink/90">{t(label)}</span>
        {tn.status === 'up' && !tn.verified ? <span className="text-mute">{t('（没填公网地址，没法验证）')}</span> : null}
        {onRetry && (tn.status === 'error' || tn.status === 'unreachable') ? (
          <button type="button" className="ml-auto text-[11px] text-gold hover:underline" onClick={onRetry}>{t('立即重连')}</button>
        ) : null}
      </div>
      {tn.error && tn.status !== 'up' ? <div className="text-[11px] text-amber-300/90 leading-relaxed pl-4">{t(tn.error)}</div> : null}
    </div>
  );
}
