// 0.34.2 侧栏底部的「手机」按钮 + 弹出面板：扫码配对、复制链接、看连着哪台手机、外网隧道通不通、开机自启。
// 详细设置（端口 / 局域网 / 隧道服务器）仍在「设置 → 手机访问」。
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/core.mjs';
import { useMobileState, useNow, useCopy, QrCode, DeviceLine, TunnelLine, Switch } from './MobileShared.jsx';

export function IconPhone({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M11 18.5h2" />
    </svg>
  );
}

const KIND = { internet: '外网链接：在哪都能打开', lan: '局域网链接：手机要和电脑连同一个 Wi-Fi', hotspot: '热点链接：手机要连这台电脑开的热点', local: '只有本机地址：手机连不上，去设置里打开局域网或外网访问' };

/** 侧栏按钮：图标颜色就是状态——绿 = 手机在线，金 = 开着等手机，灰 = 没开 */
export function MobileButton({ onOpenSettings }) {
  const [st, setSt, m] = useMobileState();
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  if (!m) return null;
  const online = !!st?.device?.online;
  const on = !!st?.running;
  const tunnelBad = on && st?.tunnel?.enabled && st.tunnel.status !== 'up';
  const color = online ? 'text-emerald-400' : on ? 'text-gold' : 'text-mute';
  const title = online
    ? t('手机已连接：{name}', { name: st.device.deviceName || t('手机') })
    : on ? t('手机访问已开启') : t('手机访问');
  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)} title={title} aria-label={t('手机访问')} data-ui="mobile-button"
        className={`relative shrink-0 rounded-lg p-1.5 transition-colors hover:bg-lift/[0.045] ${open ? 'bg-lift/[0.06]' : ''} ${color}`}>
        <IconPhone />
        {tunnelBad ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400" /> : null}
      </button>
      {/* 挂到 body 上：侧栏有 backdrop-filter，fixed 定位会被它当成容器、被侧栏裁掉 */}
      {open ? createPortal(<MobilePopover anchor={btnRef} st={st} setSt={setSt} m={m} onClose={() => setOpen(false)}
        onOpenSettings={() => { setOpen(false); onOpenSettings?.(); }} />, document.body) : null}
    </>
  );
}

function MobilePopover({ anchor, st, setSt, m, onClose, onOpenSettings }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [pair, setPair] = useState(null);
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, copy] = useCopy();
  const now = useNow(true);

  // 贴着按钮往上弹；窗口变了跟着挪
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPos({ left: Math.max(8, r.left - 8), bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);
  // 点外面 / Esc 关闭
  useEffect(() => {
    const down = (e) => { if (!ref.current?.contains(e.target) && !anchor.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key); };
  }, [anchor, onClose]);

  const run = async (fn) => {
    setBusy(true); setError('');
    try {
      const r = await fn();
      if (r && r.ok === false) setError(t(r.error || '操作失败，请重试'));
      if (r?.state) setSt(r.state);
      return r;
    } catch (e) { setError(String(e?.message || e)); return null; } finally { setBusy(false); }
  };
  const newCode = async () => { const r = await run(() => m.pairCode()); if (r?.ok) setPair(r); };

  // 没绑定手机：一打开就出二维码；已绑定：点「配对新手机」才出（免得每次都生成一个用不上的码）
  const wantQr = !!st?.running && (!st.device || showQr);
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0;
  useEffect(() => {
    if (wantQr && (!pair || left <= 0) && !busy) void newCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantQr, left <= 0]);

  if (!pos || !st) return null;
  const online = !!st.device?.online;
  const statusChip = !st.running
    ? <span className="rounded-full bg-lift/[0.08] px-2 py-0.5 text-[11px] text-mute">{t('未开启')}</span>
    : online
      ? <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] text-emerald-300">● {t('已连接')}</span>
      : <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[11px] text-goldSoft">● {t('等待手机')}</span>;

  return (
    <div ref={ref} role="dialog" aria-label={t('手机远程控制')} data-testid="mobile-panel"
      style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, width: 320, zIndex: 60 }}
      className="rounded-2xl border border-edge/70 bg-pop backdrop-blur-xl shadow-2xl p-4 space-y-3 text-ink">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-lift/[0.06] p-2 text-ink/80"><IconPhone size={16} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="text-[13px] font-medium">{t('手机远程控制')}</span>{statusChip}</div>
          <div className="text-[11.5px] text-mute leading-relaxed mt-0.5">{t('手机扫码或打开链接，就能远程用这台电脑上的 FinalCheck')}</div>
        </div>
      </div>

      {!st.running ? (
        <div className="space-y-2">
          <div className="text-[12px] text-mute">{st.error ? t(st.error) : t('手机访问还没打开。')}</div>
          <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => run(() => m.set({ enabled: true }))}>{t('开启手机访问')}</button>
        </div>
      ) : (
        <>
          <div className="rounded-xl bg-lift/[0.04] p-3 space-y-2">
            <DeviceLine st={st} now={now} />
            <TunnelLine st={st} compact onRetry={() => run(() => m.tunnelRetry())} />
          </div>

          {wantQr ? (
            <div className="flex flex-col items-center gap-2">
              {pair?.url && left > 0 ? <QrCode value={pair.url} size={176} /> : <div className="h-[196px] grid place-items-center text-[12px] text-mute">{t('正在生成配对码…')}</div>}
              <div className="text-[11px] text-mute text-center leading-relaxed">
                {pair?.kind ? t(KIND[pair.kind]) : ''}
                {left > 0 ? <><br />{t('{s} 秒内有效，用一次就作废', { s: left })}</> : null}
              </div>
              <div className="flex w-full gap-2">
                <button type="button" className="btn-ghost flex-1 text-[12px]" disabled={!pair?.url || left <= 0} onClick={() => copy(pair.url)}>{copied ? t('已复制') : t('复制链接')}</button>
                {st.device ? <button type="button" className="btn-ghost text-[12px]" onClick={() => setShowQr(false)}>{t('收起')}</button> : null}
              </div>
              {st.device ? <div className="text-[11px] text-amber-300/85 text-center">{t('新手机配对后会顶掉现在绑定的这台')}</div> : null}
            </div>
          ) : (
            <button type="button" className="btn-ghost w-full text-[12px]" onClick={() => setShowQr(true)}>{t('配对新手机（显示二维码）')}</button>
          )}
        </>
      )}

      {error ? <div className="text-[11.5px] text-red-300/90">{error}</div> : null}

      <div className="border-t border-lift/[0.06] pt-3 space-y-2.5">
        {st.autostart != null ? (
          <label className="flex items-center justify-between gap-3 text-[12px] text-ink/85">
            <span>{t('开机自动启动')}<span className="block text-[11px] text-mute">{t('登录 Windows 后自动在托盘里运行，手机随时能连')}</span></span>
            <Switch on={st.autostart} onChange={(v) => run(() => m.autostart(v))} label={t('开机自动启动')} disabled={busy} />
          </label>
        ) : null}
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost text-[12px]" onClick={onOpenSettings}>{t('更多设置')}</button>
          {st.running ? <button type="button" className="btn-ghost text-[12px] ml-auto text-red-300/90" disabled={busy}
            onClick={() => run(() => m.set({ enabled: false })).then(() => setPair(null))}>{t('停止')}</button> : null}
        </div>
      </div>
    </div>
  );
}
