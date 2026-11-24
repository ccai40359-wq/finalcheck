// 设置 → 运行时 → 联网搜索（0.33.1）：web_search 用哪个后端。
// 默认「自动」= 必应网页结果（国内外都能连、不要密钥），失败回退 DuckDuckGo；
// 想要更稳定 / 更干净的结果可以换 Tavily、Brave（填 API Key）或自建 SearXNG（填地址）。
import React, { useEffect, useState } from 'react';
import { api, Card, ErrorNote } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';

const PROVIDERS = [
  { v: 'auto', label: '自动（必应，失败回退 DuckDuckGo）', key: false, url: false },
  { v: 'bing', label: '必应', key: false, url: false },
  { v: 'duckduckgo', label: 'DuckDuckGo', key: false, url: false },
  { v: 'tavily', label: 'Tavily（API）', key: true, url: false },
  { v: 'brave', label: 'Brave Search（API）', key: true, url: false },
  { v: 'searxng', label: 'SearXNG（自建实例）', key: false, url: true }
];

export default function WebSearchSettings() {
  const y = api();
  const [ws, setWs] = useState({ provider: 'auto', apiKey: '', url: '' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    y?.getConfig?.().then((c) => {
      if (!alive) return;
      const w = c?.webSearch || {};
      setWs({ provider: w.provider || 'auto', apiKey: w.apiKey || '', url: w.url || '' });
    }).catch(() => {});
    return () => { alive = false; };
  }, [y]);

  const p = PROVIDERS.find((x) => x.v === ws.provider) || PROVIDERS[0];
  const set = (patch) => { setWs((s) => ({ ...s, ...patch })); setDirty(true); setSaved(false); };
  const missing = (p.key && !ws.apiKey.trim()) || (p.url && !/^https?:\/\//.test(ws.url.trim()));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const c = await y.getConfig();
      const next = { provider: ws.provider, ...(p.key ? { apiKey: ws.apiKey.trim() } : {}), ...(p.url ? { url: ws.url.trim() } : {}) };
      await y.setConfig({ ...c, webSearch: next });
      setDirty(false); setSaved(true);
    } catch (e) { setError(String(e?.message || e)); }
    setSaving(false);
  };

  return (
    <Card className="p-5 space-y-3">
      <div>
        <div className="text-sm text-ink font-medium">{t('联网搜索')}</div>
        <div className="text-xs text-mute mt-0.5 leading-relaxed">{t('AI 用 web_search 查资料时走哪个搜索引擎。搜索词会发给所选的服务；网页抓取（web_fetch）不受这里影响。')}</div>
      </div>
      <select value={ws.provider} onChange={(e) => set({ provider: e.target.value })} aria-label={t('搜索服务')}
        className="w-full rounded-lg border border-edge/70 bg-well px-3 py-2 text-[12px] text-ink outline-none focus:border-gold/50">
        {PROVIDERS.map((x) => <option key={x.v} value={x.v}>{t(x.label)}</option>)}
      </select>
      {p.key && (
        <input type="password" value={ws.apiKey} onChange={(e) => set({ apiKey: e.target.value })} spellCheck={false} autoComplete="off"
          placeholder="API Key" aria-label="API Key"
          className="w-full rounded-lg border border-edge/70 bg-well px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-gold/50" />
      )}
      {p.url && (
        <input value={ws.url} onChange={(e) => set({ url: e.target.value })} spellCheck={false}
          placeholder="https://searx.example.com" aria-label={t('实例地址')}
          className="w-full rounded-lg border border-edge/70 bg-well px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-gold/50" />
      )}
      <ErrorNote>{error}</ErrorNote>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary" onClick={save} disabled={!y?.setConfig || saving || !dirty || missing}>
          {saving ? t('保存中…') : t('保存')}
        </button>
        {missing && <span className="text-[11px] text-amber-300/90">{p.key ? t('这个服务需要填 API Key') : t('填 SearXNG 实例地址（http / https 开头）')}</span>}
        {saved && !dirty && <span className="text-[11px] text-mute/70">{t('已保存，下一条消息起生效')}</span>}
      </div>
    </Card>
  );
}
