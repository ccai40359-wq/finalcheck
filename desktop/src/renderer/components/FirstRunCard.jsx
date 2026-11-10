// 首次使用向导：没有可用供应商时显示一张卡片，填 Base URL / Key / 模型即可开始。
// 组件自带表单局部状态（与拆分前一致），配置的保存/跳过由 App 的回调编排。
import React, { useState } from 'react';
import { t } from '../i18n/core.mjs';

export default function FirstRunCard({ y, cfg, onSaved, onSkip }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [name, setName] = useState('My Provider');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testRes, setTestRes] = useState(null);
  const [err, setErr] = useState('');
  const canSubmit = !!(baseUrl.trim() && apiKey.trim() && model.trim());

  const test = async () => {
    if (!canSubmit || testing) return;
    if (!y?.testProvider) { setTestRes({ ok: false, reason: t('当前版本没有 testProvider IPC') }); return; }
    setTesting(true);
    setTestRes(null);
    try {
      const r = await y.testProvider({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() });
      setTestRes(r && typeof r === 'object' ? r : { ok: false, reason: t('测试接口没有返回结果') });
    } catch (e) {
      setTestRes({ ok: false, reason: e?.message || String(e) });
    } finally { setTesting(false); }
  };

  const save = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setErr('');
    try {
      if (!y?.setConfig) throw new Error(t('当前版本不能写入配置（请在 Electron 中运行）'));
      const cur = (await y.getConfig?.()) || cfg || {};
      const providers = Array.isArray(cur.providers) ? [...cur.providers] : [];
      const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const provider = {
        id,
        name: name.trim() || 'My Provider',
        baseUrl: baseUrl.trim(),
        apiFormat: 'chat-completions',
        apiKey: apiKey.trim(),
        models: [model.trim()],
        contextWindow: 1000000,
        enabled: true
      };
      const next = { ...cur, providers: [...providers, provider], activeProviderId: id, activeModel: model.trim() };
      await y.setConfig(next);
      onSaved?.(next, provider);
    } catch (e) {
      setErr(t('保存失败：{reason}', { reason: e?.message || t('请检查配置是否可写') }));
    } finally { setSaving(false); }
  };

  return (
    <div className="glass-card max-w-3xl mx-auto rounded-2xl border border-gold/30 px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 h-9 w-9 rounded-xl bg-gold/10 border border-gold/35 flex items-center justify-center text-goldSoft shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-[0.18em] uppercase text-goldDeep">{t('首次使用')}</span>
            <span className="h-px flex-1 bg-gold/20" />
          </div>
          <div className="mt-1 font-kai text-base text-goldSoft tracking-wider">{t('连接 OpenAI 兼容网关')}</div>
          <p className="mt-1 text-[11px] text-mute leading-relaxed">
            {t('FinalCheck 需要连接一个 OpenAI 兼容网关（Base URL + API Key + 模型名）才能对话、跑体检和工作流。Key 只存本机 config.json。')}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="sm:col-span-2 block">
          <span className="mb-1 block text-[11px] text-mute">Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={saving}
            placeholder="https://api.example.com/v1" autoFocus
            className="input font-mono" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-mute">API Key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={saving}
            placeholder="sk-…" autoComplete="new-password" className="input font-mono" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-mute">{t('模型名')}</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} disabled={saving}
            placeholder="glm-4.6 / deepseek-v4.1-flash"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
            className="input font-mono" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[11px] text-mute">{t('供应商名称')} <span className="text-mute/45">{t('（可选）')}</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={saving}
            placeholder="My Provider" className="input" />
        </label>
      </div>

      {testRes && (testRes.ok ? (
        <div className="mt-3 rounded-xl border border-jade/40 bg-jade/10 px-3.5 py-2.5 text-[11px] text-jade">
          {t('已连通 · 模型已回复')}
          {testRes.reply ? <span className="ml-2 text-ink/75">{t('“{reply}”', { reply: String(testRes.reply).slice(0, 120) })}</span> : null}
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-[11px] text-red-300">
          {t('连接失败：{reason}', { reason: testRes.reason || t('未知原因') })}
          {testRes.hint ? <span className="mt-1 block text-mute">{testRes.hint}</span> : null}
        </div>
      ))}
      {err && <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-[11px] text-red-300">{err}</div>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={test} disabled={!canSubmit || testing || saving} className="btn-ghost text-xs px-3 py-1.5">
          {testing ? t('测试中…') : t('测试连接')}
        </button>
        <button onClick={save} disabled={!canSubmit || saving || testing} className="btn-primary text-xs px-3.5 py-1.5">
          {saving ? t('保存中…') : t('保存并开始')}
        </button>
        <button onClick={onSkip} disabled={saving} className="ml-auto text-[11px] text-mute/55 hover:text-ink transition-colors px-2 py-1">
          {t('稍后配置')}
        </button>
      </div>
    </div>
  );
}
