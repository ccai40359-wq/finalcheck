// 设置 → 手机访问（0.35）：电脑上开一个小网页服务，手机打开就是和电脑同一个 FinalCheck——
// 同一个引擎、同一份会话：手机发的消息电脑上实时出现，反过来也一样；审批 / 提问在一边点了，另一边自动收起。
// 默认只听本机（127.0.0.1），配合你自己的隧道 / Tailscale 用；勾「局域网」才对同一 Wi-Fi 开放。
// 0.34.2：外网访问（FinalCheck 自己维护反向 SSH 隧道 + 验证公网地址）、开机自动启动、手机在线状态、配对二维码。
import React, { useEffect, useState } from 'react';
import { Card, ErrorNote } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';
import { selfOrigin } from '../lib/remote-sync.mjs';
import { inputCls, useMobileState, useNow, Switch, CopyLine, QrCode, DeviceLine, TunnelLine } from './MobileShared.jsx';

function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] text-ink/85">{label}{hint ? <span className="ml-2 text-[11px] text-mute">{hint}</span> : null}</span>
      {children}
    </label>
  );
}

function TunnelCard({ st, m, run, busy }) {
  const tn = st.tunnel || {};
  const [form, setForm] = useState({ target: tn.target || '', remotePort: String(tn.remotePort || 7788), publicUrl: tn.publicUrl || '' });
  // 别处（侧栏面板）改了：表单跟着刷新（只在保存过的值变了时）
  useEffect(() => { setForm({ target: tn.target || '', remotePort: String(tn.remotePort || 7788), publicUrl: tn.publicUrl || '' }); }, [tn.target, tn.remotePort, tn.publicUrl]);
  const dirty = form.target !== (tn.target || '') || form.remotePort !== String(tn.remotePort || 7788) || form.publicUrl !== (tn.publicUrl || '');
  const save = (extra = {}) => run(() => m.set({ tunnel: { target: form.target, remotePort: Number(form.remotePort), publicUrl: form.publicUrl, ...extra } }));
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: k === 'remotePort' ? e.target.value.replace(/\D/g, '').slice(0, 5) : e.target.value }));

  return (
    <Card className="p-5 space-y-4" data-testid="mobile-tunnel-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-ink font-medium">{t('外网访问（SSH 隧道）')}</div>
          <div className="text-xs text-mute mt-0.5 leading-relaxed">
            {t('不在同一个 Wi-Fi 也能用：FinalCheck 自己连到你的服务器，开一条反向隧道，断了自动重连，并定时检查公网地址真的能打开。')}
          </div>
        </div>
        <Switch on={!!tn.enabled} onChange={(enabled) => save({ enabled })} label={t('外网访问')} disabled={busy || (!tn.enabled && !form.target)} />
      </div>
      <TunnelLine st={st} onRetry={() => run(() => m.tunnelRetry())} />
      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <Field label={t('服务器')} hint={t('用户名@地址，或 ~/.ssh/config 里的别名')}>
          <input value={form.target} onChange={set('target')} placeholder="user@203.0.113.5" className={`${inputCls} w-full`} aria-label={t('服务器')} />
        </Field>
        <Field label={t('服务器端口')}>
          <input value={form.remotePort} onChange={set('remotePort')} className={`${inputCls} w-full`} aria-label={t('服务器端口')} />
        </Field>
      </div>
      <Field label={t('公网地址')} hint={t('手机实际打开的地址（配对链接 / 二维码用它）')}>
        <input value={form.publicUrl} onChange={set('publicUrl')} placeholder="https://example.com:8443/fc-mobile" className={`${inputCls} w-full`} aria-label={t('公网地址')} />
      </Field>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy || !dirty} onClick={() => save()}>{t('保存')}</button>
      </div>
      <details className="text-[11.5px] text-mute leading-relaxed">
        <summary className="cursor-pointer hover:text-ink">{t('服务器上要准备什么')}</summary>
        <ul className="list-disc pl-4 mt-1.5 space-y-1">
          <li>{t('这台电脑能免密码 ssh 登录服务器（密钥登录；FinalCheck 不会弹密码框）。')}</li>
          <li>{t('隧道只在服务器的 127.0.0.1:{port} 上开口，公网直接访问不到这个端口。', { port: form.remotePort || 7788 })}</li>
          <li>{t('服务器上的 nginx（或别的反向代理）把公网地址转发到 http://127.0.0.1:{port}，并关掉缓冲（proxy_buffering off），否则实时输出会卡住。', { port: form.remotePort || 7788 })}</li>
          <li>{t('只给这条隧道用的话，建议单独建一个没有 sudo、只允许端口转发的账号。')}</li>
        </ul>
      </details>
    </Card>
  );
}

export default function MobileAccessSettings() {
  const [st, setSt, m] = useMobileState();
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pair, setPair] = useState(null);
  const now = useNow(true);
  useEffect(() => { if (st && !port) setPort(String(st.port)); }, [st, port]);

  // 手机网页上这一节只读：开关、配对都只能在电脑上做（手机端调不到 finalcheck:mobile:*）
  if (selfOrigin() === 'phone' || !m) {
    return (
      <Card className="p-5">
        <div className="text-sm text-ink font-medium">{t('手机访问')}</div>
        <div className="text-xs text-mute mt-1 leading-relaxed">{t('你正在手机上使用。开关、配对和解除绑定都在电脑上的「设置 → 手机访问」里操作。')}</div>
      </Card>
    );
  }
  if (!st) return null;

  const run = async (fn) => {
    setBusy(true); setError('');
    try {
      const r = await fn();
      if (r && r.ok === false) setError(t(r.error || '操作失败，请重试'));
      if (r?.state) setSt(r.state);
      return r;
    } catch (e) { setError(String(e?.message || e)); return null; } finally { setBusy(false); }
  };
  const toggle = (enabled) => run(() => m.set({ enabled })).then(() => { if (!enabled) setPair(null); });
  const savePort = () => run(() => m.set({ port: Number(port) }));
  const newCode = async () => { const r = await run(() => m.pairCode()); if (r?.ok) setPair(r); };
  const unpair = () => run(() => m.unpair()).then(() => setPair(null));

  // 开关看的是「实际在跑」：测试 / 命令行用 FINALCHECK_MOBILE_PORT 强制打开时设置里没勾也算开着
  const on = st.enabled || st.running;
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0;

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-ink font-medium">{t('手机访问')}</div>
            <div className="text-xs text-mute mt-0.5 leading-relaxed">
              {t('手机浏览器打开后就是这台电脑上的 FinalCheck：同一个引擎、同一份会话，两边实时同步。电脑要开着 FinalCheck。')}
            </div>
          </div>
          <Switch on={on} onChange={toggle} label={t('开启手机访问')} disabled={busy} />
        </div>

        {on ? (
          <div className="space-y-3">
            <div className="text-[12px] text-mute">
              {st.running
                ? <span className="text-emerald-300/90">● {t('运行中：电脑上的手机服务已开（外网能不能连看下面的「外网访问」）')}</span>
                : <span className="text-amber-300/90">● {t('没有启动')}</span>}
              {!st.built ? <span className="ml-2 text-amber-300/90">{t('手机网页还没打包（开发版先跑 node scripts/build-mobile.mjs）')}</span> : null}
            </div>
            {st.localUrl ? (
              <div className="space-y-1">
                <div className="text-[11px] text-mute/80">{t('本机（只有这台电脑自己能打开，用来试）')}</div>
                <CopyLine value={st.localUrl} label={t('本机地址')} />
              </div>
            ) : null}
            {(st.lanUrls || []).map((u) => (
              <div key={u.url} className="space-y-1">
                <div className="text-[11px] text-mute/80">{u.hotspot ? t('电脑热点（手机连的是这台电脑开的热点时用）') : t('局域网：{name}（手机和电脑连同一个 Wi-Fi 时用）', { name: u.name })}</div>
                <CopyLine value={u.url} label={u.name} />
              </div>
            ))}
            {st.tunnel?.enabled && st.tunnel.publicUrl ? (
              <div className="space-y-1">
                <div className="text-[11px] text-mute/80">{t('外网（在哪都能打开，走你的服务器）')}</div>
                <CopyLine value={st.tunnel.publicUrl + '/'} label={t('公网地址')} />
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <label className="flex items-center gap-2 text-[12px] text-ink/85">
                {t('端口')}
                <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} aria-label={t('端口')}
                  className={`${inputCls} w-20`} />
              </label>
              <button type="button" className="btn-ghost text-[12px]" onClick={savePort} disabled={busy || String(st.port) === port}>{t('应用')}</button>
              <label className="flex items-center gap-2 text-[12px] text-ink/85 ml-auto">
                <Switch on={st.lan} onChange={(lan) => run(() => m.set({ lan }))} label={t('局域网访问')} disabled={busy} />
                {t('局域网访问')}
              </label>
            </div>
          </div>
        ) : null}
        {st.autostart != null ? (
          <label className="flex items-center justify-between gap-3 border-t border-lift/[0.06] pt-3 text-[12px] text-ink/85">
            <span>{t('开机自动启动')}<span className="block text-[11px] text-mute">{t('登录 Windows 后自动在托盘里运行，手机随时能连')}</span></span>
            <Switch on={st.autostart} onChange={(v) => run(() => m.autostart(v))} label={t('开机自动启动')} disabled={busy} />
          </label>
        ) : null}
        <ErrorNote>{error || (on && st.error ? t(st.error) : '')}</ErrorNote>
      </Card>

      {st.running ? <TunnelCard st={st} m={m} run={run} busy={busy} /> : null}

      {st.running ? (
        <Card className="p-5 space-y-3">
          <div>
            <div className="text-sm text-ink font-medium">{t('配对手机')}</div>
            {st.device ? <div className="mt-2"><DeviceLine st={st} now={now} /></div> : null}
            <div className="text-xs text-mute mt-1.5 leading-relaxed">
              {st.device
                ? t('绑定于 {time}。同一时间只能绑一台；换手机先解除绑定，或直接用新配对码顶替。', { time: new Date(st.device.pairedAt).toLocaleString() })
                : t('还没绑定手机。点「生成配对码」，用手机扫二维码（或打开链接）。')}
            </div>
          </div>
          {pair && left > 0 ? (
            <div className="flex flex-wrap items-start gap-4" data-testid="mobile-pair">
              {pair.url ? <QrCode value={pair.url} size={148} /> : null}
              <div className="flex-1 min-w-[220px] space-y-2">
                <div className="text-[11px] text-mute">{t('配对码（{s} 秒内有效，用一次就作废）', { s: left })}</div>
                <CopyLine value={pair.code} label={t('配对码')} />
                {pair.url ? <CopyLine value={pair.url} label={t('配对链接')} /> : null}
              </div>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary" onClick={newCode} disabled={busy}>{t('生成配对码')}</button>
            {st.device ? <button type="button" className="btn-ghost text-red-300/90" onClick={unpair} disabled={busy}>{t('解除绑定')}</button> : null}
          </div>
        </Card>
      ) : null}

      <Card className="p-5">
        <div className="text-sm text-ink font-medium">{t('安全说明')}</div>
        <ul className="text-xs text-mute mt-1.5 leading-relaxed list-disc pl-4 space-y-1">
          <li>{t('默认只在本机端口上监听；要在外面用，打开上面的「外网访问」，或用你自己的 Tailscale / 内网穿透指向这个端口（建议 HTTPS）。')}</li>
          <li>{t('配对码 10 分钟有效、只能用一次；配对后手机凭本机签发的凭证访问，解除绑定立即失效。')}</li>
          <li>{t('手机上看不到 API Key；手机端不能开「完全权限」、不能改 Hooks、不能装更新，也不能改这里的手机访问设置。')}</li>
        </ul>
      </Card>
    </div>
  );
}
