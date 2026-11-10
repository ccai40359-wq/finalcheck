// 模型设置页（Cherry Studio 式）：左列供应商列表 + 右列编辑详情
// 配置 schema v2：{ providers: [{ id, name, baseUrl, apiFormat, apiKey, models, enabled }], activeProviderId }
// models 兼容 string[] 与混合对象数组：{ id, contextWindow?, maxOutputTokens?, vision? }
import React, { useEffect, useId, useRef, useState } from 'react';
import { api, Card, ErrorNote } from '../lib/ui.jsx';
import { initialUpdateState, reduceUpdateEvent, describeUpdate } from '../lib/updater-state.mjs';
import UsagePage from './UsagePage.jsx';

const API_FORMATS = [
  { value: 'chat-completions', label: 'chat-completions（OpenAI 兼容）' },
  { value: 'openai-responses', label: 'openai-responses（暂未支持对话）' }
];
// 策略沙箱（与 permissionMode 审批模式独立，Full access 下也生效）
const SANDBOX_MODES = [
  { value: 'workspace', label: 'workspace', desc: '仅项目目录内可写（默认）' },
  { value: 'readonly', label: 'readonly', desc: '全只读，拒绝写入' },
  { value: 'off', label: 'off', desc: '放开项目边界，敏感路径仍拒绝' }
];
const DEFAULT_TOOL_CONCURRENCY = 8;
const SECTIONS = ['models', 'runtime', 'usage', 'about'];
const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ---- 每模型上下文窗口：解析 / 徽标 / 智能识别 / 表单校验（纯函数，供页面与自测复用） ---- */
export const DEFAULT_CONTEXT_WINDOW = 1000000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

const asPositiveInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

// 单条模型（字符串或对象）→ 显示视图：窗口/输出/vision 按 model > provider > 默认 解析
export function modelEntryView(entry, provider) {
  const p = provider && typeof provider === 'object' ? provider : {};
  const providerWindow = asPositiveInt(p.contextWindow);
  const providerMaxOut = asPositiveInt(p.maxOutputTokens);
  const providerVision = p.vision === true;
  if (typeof entry === 'string') {
    return {
      id: entry.trim(),
      window: providerWindow ?? null,
      windowSource: providerWindow != null ? 'provider' : 'default',
      maxOutputTokens: providerMaxOut ?? null,
      maxOutputTokensSource: providerMaxOut != null ? 'provider' : 'default',
      vision: providerVision,
      visionSource: providerVision ? 'provider' : 'default',
      ownContextWindow: null,
      ownMaxOutputTokens: null,
      ownVision: null,
      legacy: true
    };
  }
  const o = entry && typeof entry === 'object' ? entry : {};
  const ownWindow = asPositiveInt(o.contextWindow);
  const ownMaxOut = asPositiveInt(o.maxOutputTokens);
  const ownVision = typeof o.vision === 'boolean' ? o.vision : null;
  return {
    id: typeof o.id === 'string' ? o.id.trim() : '',
    window: ownWindow ?? providerWindow ?? null,
    windowSource: ownWindow != null ? 'model' : (providerWindow != null ? 'provider' : 'default'),
    maxOutputTokens: ownMaxOut ?? providerMaxOut ?? null,
    maxOutputTokensSource: ownMaxOut != null ? 'model' : (providerMaxOut != null ? 'provider' : 'default'),
    vision: ownVision ?? providerVision,
    visionSource: ownVision != null ? 'model' : (providerVision ? 'provider' : 'default'),
    ownContextWindow: ownWindow,
    ownMaxOutputTokens: ownMaxOut,
    ownVision,
    legacy: false
  };
}

// 徽标文案：1000000 → 1M，200000 → 200K，128000 → 128K，未配置 → 默认
export function formatWindowBadge(n) {
  const v = asPositiveInt(n);
  if (v == null) return '默认';
  if (v >= 1000000) {
    const m = v / 1000000;
    return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (v >= 1000) {
    const k = Math.round(v / 1000);
    return k >= 1000 ? '1M' : `${k}K`;
  }
  return String(v);
}

// Smart configuration：按模型名里的 128k / 200k / 1m 等推导窗口（前后须有分隔符，避免 gpt-4o 误判）
export function detectSmartWindow(modelId) {
  const s = String(modelId || '').trim();
  const m = s.match(/(?:^|[^A-Za-z0-9])(\d+(?:\.\d+)?)\s*([kKmM])(?=$|[^A-Za-z0-9])/);
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1000000 : 1000));
  return n > 0 ? n : null;
}

// 表单数字：空 = 继承；只接受正整数（拒绝 NaN/负数/小数/科学计数法）
export function parseTokenCountInput(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, value: null, error: '需为大于 0 的整数（token 数）' };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, value: null, error: '需为大于 0 的整数（token 数）' };
  return { ok: true, value: n };
}

export function validateModelForm({ id, contextWindow, maxOutputTokens, otherIds = [] }) {
  const errors = {};
  const modelId = String(id == null ? '' : id).trim();
  if (!modelId) errors.id = '请填写 Model ID';
  else if ((otherIds || []).some((x) => String(x || '').trim() === modelId)) errors.id = '该模型 ID 已存在';
  const ctx = parseTokenCountInput(contextWindow);
  if (!ctx.ok) errors.contextWindow = `Context window ${ctx.error}`;
  const out = parseTokenCountInput(maxOutputTokens);
  if (!out.ok) errors.maxOutputTokens = `Max output tokens ${out.error}`;
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    id: modelId,
    contextWindow: ctx.value,
    maxOutputTokens: out.value
  };
}

// 保存形状：{ id, contextWindow?, maxOutputTokens?, vision? }；空/非法字段不写，保持继承供应商
export function buildModelObject({ id, contextWindow, maxOutputTokens, vision, forceVisionFalse }) {
  const out = { id: String(id || '').trim() };
  const cw = asPositiveInt(contextWindow);
  if (cw != null) out.contextWindow = cw;
  const mo = asPositiveInt(maxOutputTokens);
  if (mo != null) out.maxOutputTokens = mo;
  if (vision === true) out.vision = true;
  else if (forceVisionFalse) out.vision = false;
  return out;
}

// 整份 models 写回对象形状；非法/空条目丢弃，未知字段不保留
export function toModelObjects(models) {
  return (Array.isArray(models) ? models : []).flatMap((entry) => {
    if (typeof entry === 'string') {
      const id = entry.trim();
      return id ? [{ id }] : [];
    }
    if (!entry || typeof entry !== 'object') return [];
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) return [];
    const out = { id };
    const cw = asPositiveInt(entry.contextWindow);
    if (cw != null) out.contextWindow = cw;
    const mo = asPositiveInt(entry.maxOutputTokens);
    if (mo != null) out.maxOutputTokens = mo;
    if (typeof entry.vision === 'boolean') out.vision = entry.vision;
    return [out];
  });
}

export default function SettingsPage({ onBack, initialSection = 'models' }) {
  const y = api();
  const [providers, setProviders] = useState([]);   // 草稿（保存前仅在本地）
  const [activeId, setActiveId] = useState(null);   // 对话使用的供应商（activeProviderId）
  const [selectedId, setSelectedId] = useState(null); // 右侧正在编辑的供应商
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');
  const [modelDialog, setModelDialog] = useState(null); // { isNew, index, entry }
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState(null);     // { ok, reason, hint, count, models }
  const [baseCfg, setBaseCfg] = useState({});       // 保留 permissionMode / activeModel / thinkingEffort 等字段
  const [sandboxMode, setSandboxMode] = useState('workspace');
  const [toolConc, setToolConc] = useState(DEFAULT_TOOL_CONCURRENCY);
  const [section, setSection] = useState(() => (SECTIONS.includes(initialSection) ? initialSection : 'models')); // 设置页内分节：models / runtime / usage / about（仿 ZCode 左侧分组导航）
  const [update, setUpdate] = useState(initialUpdateState); // 更新状态机（纯函数见 lib/updater-state.mjs）
  const [appVersion, setAppVersion] = useState('');
  const modelTriggerRef = useRef(null); // 打开模型弹窗的按钮，关闭弹窗后焦点回到这里

  // App 通过 initialSection 指定落点（如 page='usage'）；同一组件内切换分节不卸载草稿
  useEffect(() => {
    if (!SECTIONS.includes(initialSection)) return;
    setSection((prev) => (prev === initialSection ? prev : initialSection));
  }, [initialSection]);

  useEffect(() => {
    if (!y) return;
    y.getConfig()
      .then((c) => {
        const list = Array.isArray(c?.providers) ? c.providers : [];
        setBaseCfg(c || {});
        setProviders(list.map((p) => ({ ...p, models: [...(p.models || [])] })));
        setActiveId(c?.activeProviderId ?? null);
        setSandboxMode(SANDBOX_MODES.some((m) => m.value === c?.sandboxMode) ? c.sandboxMode : 'workspace');
        const conc = Number(c?.toolConcurrency);
        setToolConc(Number.isFinite(conc) && conc > 0 ? Math.min(16, Math.max(1, Math.trunc(conc))) : DEFAULT_TOOL_CONCURRENCY);
        setSelectedId(list[0]?.id ?? null);
        setLoaded(true);
      })
      .catch((e) => { setErr('读取配置失败：' + e.message); setLoaded(true); });
  }, [y]);

  // ---- 关于 / 更新：当前版本 + 订阅主进程更新事件（卸载时取消订阅） ----
  useEffect(() => {
    if (!y) return undefined;
    let alive = true;
    if (y.getVersion) {
      y.getVersion().then((v) => { if (alive) setAppVersion(String(v || '')); }).catch(() => {});
    }
    if (!y.onUpdateEvent) return () => { alive = false; };
    const off = y.onUpdateEvent((ev) => {
      if (alive) setUpdate((prev) => reduceUpdateEvent(prev, ev));
    });
    return () => { alive = false; if (typeof off === 'function') off(); };
  }, [y]);

  const checkUpdate = async () => {
    if (!y?.updateCheck) return;
    setUpdate((prev) => ({ ...prev, phase: 'checking', percent: null, message: '' }));
    try {
      const r = await y.updateCheck();
      if (r && !r.ok) {
        setUpdate((prev) => (prev.phase === 'error' ? prev : reduceUpdateEvent(prev, { type: 'error', message: r.error || '检查更新失败' })));
        return;
      }
      // 正常路径由主进程事件驱动；这里只做事件丢失时的兜底
      if (r?.latestVersion) {
        setUpdate((prev) => (prev.phase === 'checking' ? reduceUpdateEvent(prev, { type: 'available', version: r.latestVersion }) : prev));
      } else if (r?.ok) {
        setUpdate((prev) => (prev.phase === 'checking' ? reduceUpdateEvent(prev, { type: 'not-available', version: r.currentVersion }) : prev));
      }
    } catch (e) {
      setUpdate((prev) => reduceUpdateEvent(prev, { type: 'error', message: e?.message }));
    }
  };

  const downloadUpdate = async () => {
    if (!y?.updateDownload) return;
    setUpdate((prev) => ({ ...prev, phase: 'downloading', percent: 0, message: '' }));
    try {
      const r = await y.updateDownload();
      if (r && !r.ok) setUpdate((prev) => reduceUpdateEvent(prev, { type: 'error', message: r.error || '下载更新失败' }));
    } catch (e) {
      setUpdate((prev) => reduceUpdateEvent(prev, { type: 'error', message: e?.message }));
    }
  };

  const installUpdate = async () => {
    if (!y?.updateInstall) return;
    try {
      const r = await y.updateInstall();
      if (r && !r.ok) setUpdate((prev) => reduceUpdateEvent(prev, { type: 'error', message: r.error || '安装更新失败' }));
    } catch (e) {
      setUpdate((prev) => reduceUpdateEvent(prev, { type: 'error', message: e?.message }));
    }
  };

  const selected = providers.find((p) => p.id === selectedId) || null;

  const touch = () => { setDirty(true); setSaved(false); };

  const patchSelected = (patch) => {
    setProviders((ps) => ps.map((p) => (p.id === selectedId ? { ...p, ...patch } : p)));
    touch();
  };

  const addProvider = () => {
    const p = { id: newId(), name: '新供应商', baseUrl: '', apiFormat: 'chat-completions', apiKey: '', models: [], enabled: true };
    setProviders((ps) => [...ps, p]);
    setSelectedId(p.id);
    setTestRes(null);
    touch();
  };

  const removeProvider = (id) => {
    const p = providers.find((x) => x.id === id);
    if (!window.confirm(`删除供应商「${p?.name || id}」？`)) return;
    const rest = providers.filter((x) => x.id !== id);
    setProviders(rest);
    if (activeId === id) setActiveId(rest.find((x) => x.enabled)?.id ?? rest[0]?.id ?? null);
    if (selectedId === id) setSelectedId(rest[0]?.id ?? null);
    setTestRes(null);
    touch();
  };

  const openAddModel = (e) => {
    if (!selected) return;
    modelTriggerRef.current = e?.currentTarget ?? document.activeElement;
    setModelDialog({ isNew: true, index: null, entry: null, providerId: selected.id });
  };

  const openEditModel = (index, trigger) => {
    if (!selected) return;
    modelTriggerRef.current = trigger ?? document.activeElement;
    setModelDialog({ isNew: false, index, entry: (selected.models || [])[index] ?? null, providerId: selected.id });
  };

  const applyModelEdit = (entry) => {
    // 弹窗期间若选中项被切走，按原 provider 校验，避免把条目写进另一个供应商
    if (!selected || !modelDialog || modelDialog.providerId !== selected.id) return;
    const models = [...(selected.models || [])];
    if (modelDialog.isNew) models.push(entry);
    else models[modelDialog.index] = entry;
    patchSelected({ models });
    setModelDialog(null);
  };

  const removeModel = (index) => {
    if (!selected) return;
    patchSelected({ models: (selected.models || []).filter((_, i) => i !== index) });
  };

  const save = async () => {
    setErr('');
    try {
      const clean = providers.map((p) => {
        const windowRaw = asPositiveInt(p.contextWindow);
        // 以原对象为底：family / 供应商级 toolConcurrency 等非界面字段必须原样保留，否则一次保存就丢
        const entry = {
          ...p,
          id: p.id, name: String(p.name || '').trim() || '未命名供应商',
          baseUrl: String(p.baseUrl || '').trim(), apiFormat: p.apiFormat === 'openai-responses' ? 'openai-responses' : 'chat-completions',
          apiKey: String(p.apiKey || '').trim(),
          // 写回统一转对象：{ id, contextWindow?, maxOutputTokens?, vision? }，空字段不写（继承供应商）
          models: toModelObjects(p.models),
          contextWindow: windowRaw != null ? Math.min(Math.max(windowRaw, 8000), 2000000) : DEFAULT_CONTEXT_WINDOW,
          enabled: p.enabled !== false
        };
        const maxOut = asPositiveInt(p.maxOutputTokens);
        if (maxOut != null) entry.maxOutputTokens = maxOut;
        if (p.vision === true) entry.vision = true;
        return entry;
      });
      const mode = SANDBOX_MODES.some((m) => m.value === sandboxMode) ? sandboxMode : 'workspace';
      const conc = Math.min(16, Math.max(1, Math.trunc(Number(toolConc)) || DEFAULT_TOOL_CONCURRENCY));
      const nextCfg = {
        ...baseCfg,
        sandboxMode: mode,
        toolConcurrency: conc,
        providers: clean,
        activeProviderId: clean.some((p) => p.id === activeId) ? activeId : (clean[0]?.id ?? null)
      };
      await y.setConfig(nextCfg);
      setBaseCfg(nextCfg);
      setProviders(clean);
      setSandboxMode(mode);
      setToolConc(conc);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr('保存失败：' + (e?.message || '请检查配置是否可写（Electron 中运行）')); }
  };

  const testConnection = async () => {
    if (!selected || !y) return;
    setTestRes(null);
    setTesting(true);
    try {
      const first = modelEntryView((selected.models || [])[0], selected);
      const r = await y.testProvider({ baseUrl: selected.baseUrl, apiKey: selected.apiKey, model: first.id });
      setTestRes(r);
    } catch (e) {
      setTestRes({ ok: false, reason: '调用失败：' + e.message, hint: '请确认应用运行在 Electron 中' });
    } finally { setTesting(false); }
  };

  // Agent / 运行时：策略沙箱 + 工具并发（写入 cfg.sandboxMode / cfg.toolConcurrency，无供应商时也可配置）
  const runtimeCard = (
    <Card className="p-5 space-y-4">
      <div>
        <div className="text-sm text-ink font-medium">Agent / 运行时</div>
        <div className="text-xs text-mute mt-0.5">Sandbox 管路径与命令边界，Tool concurrency 管同时跑几个工具。</div>
      </div>

      <Field label="Sandbox mode" hint="默认 workspace；Full access 下也生效">
        <div className="grid grid-cols-3 gap-2">
          {SANDBOX_MODES.map((m) => {
            const on = sandboxMode === m.value;
            return (
              <button key={m.value} type="button" onClick={() => { setSandboxMode(m.value); touch(); }} disabled={!y}
                className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${on ? 'border-gold/45 bg-gold/10' : 'border-edge bg-[#15151a] hover:bg-cardHover'}`}>
                <div className={`text-xs font-mono ${on ? 'text-goldSoft' : 'text-ink/85'}`}>{m.label}</div>
                <div className="text-[10px] text-mute/70 mt-0.5 leading-snug">{m.desc}</div>
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Tool concurrency" hint="同时执行的工具调用数，1–16，默认 8">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => { setToolConc((v) => Math.max(1, (Math.trunc(Number(v)) || DEFAULT_TOOL_CONCURRENCY) - 1)); touch(); }} disabled={!y}
            className="h-8 w-8 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-ink/80 disabled:opacity-40">−</button>
          <input type="number" min="1" max="16" step="1" value={toolConc}
            onChange={(e) => { setToolConc(e.target.value); touch(); }}
            onBlur={() => setToolConc((v) => Math.min(16, Math.max(1, Math.trunc(Number(v)) || DEFAULT_TOOL_CONCURRENCY)))}
            className="input font-mono !w-20 text-center" disabled={!y} />
          <button type="button" onClick={() => { setToolConc((v) => Math.min(16, (Math.trunc(Number(v)) || DEFAULT_TOOL_CONCURRENCY) + 1)); touch(); }} disabled={!y}
            className="h-8 w-8 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-ink/80 disabled:opacity-40">+</button>
          <span className="text-xs text-mute/50">1–16</span>
        </div>
      </Field>

      <div className="flex items-center gap-3 pt-2 border-t border-edge/60">
        <button className="btn-primary min-w-[92px]" onClick={save} disabled={!y || !loaded}>保存</button>
        {saved && !dirty && (
          <span className="text-sm text-jade flex items-center gap-1.5 transition-all duration-200">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            已保存
          </span>
        )}
        {dirty && <span className="text-xs text-mute">有未保存的修改</span>}
      </div>
      <ErrorNote>{!y ? '请在 Electron 中运行后修改设置。' : err}</ErrorNote>
    </Card>
  );

  // 关于 / 更新：文案与按钮可见性全部来自纯函数 describeUpdate（不硬编码 owner/repo，不展示原始 JSON）
  const updateView = describeUpdate(update, appVersion);
  const updateToneClass = { mute: 'text-mute', gold: 'text-goldSoft', jade: 'text-jade', red: 'text-red-300' };
  const aboutCard = (
    <Card className="p-5 space-y-4">
      <div>
        <div className="text-sm text-ink font-medium">应用更新</div>
        <div className="text-xs text-mute mt-0.5">从 GitHub Release 检查新版本。发现后由你确认下载，重启完成安装；版本与下载地址均由更新模块读取。</div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg bg-[#15151a] border border-edge px-4 py-3">
        <div>
          <div className="text-sm text-ink">当前版本</div>
          <div className="text-xs text-mute mt-0.5">仅安装版检查更新；开发模式不联网。</div>
        </div>
        <span className="font-mono text-sm text-goldSoft shrink-0">{updateView.currentText}</span>
      </div>

      <div className="min-h-[22px]">
        {updateView.errorText ? (
          <div className="text-sm text-red-300 leading-relaxed break-words">{updateView.errorText}</div>
        ) : (
          <div className={`text-sm leading-relaxed ${updateToneClass[updateView.tone] || 'text-mute'}`}>{updateView.statusText}</div>
        )}
        {updateView.phase === 'downloading' && (
          <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full rounded-full bg-goldSoft transition-[width] duration-200" style={{ width: `${updateView.progress ?? 0}%` }} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-edge/60">
        {updateView.showCheck && (
          <button className="btn-primary min-w-[100px]" onClick={checkUpdate} disabled={!y || updateView.checkDisabled}>
            {updateView.checkLabel}
          </button>
        )}
        {updateView.showDownload && (
          <button className="btn-primary min-w-[100px]" onClick={downloadUpdate} disabled={!y}>
            {updateView.downloadLabel}
          </button>
        )}
        {updateView.showInstall && (
          <button className="btn-primary min-w-[100px]" onClick={installUpdate} disabled={!y}>
            {updateView.installLabel}
          </button>
        )}
        {!y && <span className="text-xs text-mute">请在 Electron 中运行后检查更新。</span>}
      </div>

      {updateView.phase === 'available' && (
        <div className="text-xs text-mute leading-relaxed">下载完成后不会自动重启；点「重启并安装」立即更新，或下次退出应用时自动安装。</div>
      )}
    </Card>
  );

  return (
    <div className="h-full min-h-0 flex">
      {/* ---- 设置导航（仿 ZCode：Basics / Agent / Data and statistics） ---- */}
      <nav className="glass-side w-[240px] shrink-0 flex flex-col">
        <div className="px-2.5 pt-2.5 pb-2">
          <button onClick={onBack} disabled={!onBack}
            className="glass-row w-full flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] text-ink/85 hover:text-ink disabled:opacity-40">
            <IconChevronLeft />
            Back to workspace
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-4 space-y-5">
          <NavGroup label="Basics">
            <NavRow label="Model settings" active={section === 'models'} onClick={() => setSection('models')} icon={<IconLayers />} />
          </NavGroup>
          <NavGroup label="Agent">
            <NavRow label="Runtime" active={section === 'runtime'} onClick={() => setSection('runtime')} icon={<IconSliders />} />
          </NavGroup>
          <NavGroup label="Data and statistics">
            <NavRow label="Usage stats" active={section === 'usage'} onClick={() => setSection('usage')} icon={<IconChart />} trailing="Tokens" />
          </NavGroup>
          <NavGroup label="About">
            <NavRow label="About & updates" active={section === 'about'} onClick={() => setSection('about')} icon={<IconRefresh />}
              trailing={updateView.hasUpdate ? <span className="text-red-400">有新版本</span> : ''} />
          </NavGroup>
        </div>
      </nav>

      {/* ---- 内容区 ---- */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {section === 'usage' ? (
          <UsagePage />
        ) : (
          <>
        {/* 页头：大标题 + 副标题 + 主操作（仿 ZCode） */}
        <div className="shrink-0 px-8 pt-6 pb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-kai text-[22px] leading-tight text-goldSoft">
              {section === 'models' ? 'Model settings' : section === 'runtime' ? 'Runtime' : 'About'}
            </h1>
            <p className="text-[12px] text-mute mt-1.5 leading-relaxed">
              {section === 'models'
                ? '管理自定义模型供应商。配置好后可在对话里选择使用。'
                : section === 'runtime'
                  ? '沙箱与工具并发：对所有供应商生效，与权限模式（Full access）独立。'
                  : '版本信息与更新：检查 GitHub Release，下载后重启安装。'}
            </p>
          </div>
          {section === 'models' && (
            <button className="btn-primary shrink-0" onClick={addProvider} disabled={!y || !loaded}>
              <IconPlus /> Add provider
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {section === 'models' ? (
            <>
              {/* ---- Providers 列 ---- */}
              <div className="w-[240px] shrink-0 border-r border-edge/40 flex flex-col min-h-0">
                <div className="px-3.5 pt-2 pb-2 text-[10px] uppercase tracking-[0.14em] text-mute/45">Providers</div>
                <div className="flex-1 min-h-0 overflow-y-auto px-2 space-y-1">
                  {providers.length === 0 && loaded && (
                    <div className="text-xs text-mute/70 px-2 py-3">还没有供应商，点下方按钮添加。</div>
                  )}
                  {providers.map((p) => {
                    const sel = p.id === selectedId;
                    return (
                      <div key={p.id} onClick={() => { setSelectedId(p.id); setTestRes(null); }}
                        className={`group relative cursor-pointer rounded-lg pl-3 pr-7 py-2 border transition-all duration-200 ${
                          sel ? 'border-gold/45 bg-gold/10' : 'border-transparent hover:bg-cardHover hover:border-edge'}`}>
                        <div className="flex items-center gap-2 min-w-0">
                          {/* 绿点 = 已启用（与 ZCode 一致） */}
                          <span title={p.enabled !== false ? '已启用' : '已停用'}
                            className={`w-2 h-2 rounded-full shrink-0 ${p.enabled !== false ? 'bg-jade' : 'bg-mute/30'}`} />
                          <span className={`text-sm truncate ${sel ? 'text-goldSoft' : 'text-ink/90'}`}>{p.name || '未命名供应商'}</span>
                        </div>
                        {p.id === activeId && (
                          <span className="badge bg-gold/15 text-goldSoft border border-gold/30 !px-1.5 !text-[10px] absolute right-1.5 top-1.5">当前</span>
                        )}
                        <button title="删除供应商" onClick={(e) => { e.stopPropagation(); removeProvider(p.id); }}
                          className="absolute right-1.5 bottom-1 p-1 rounded-md text-mute/50 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="p-2.5 border-t border-edge/40">
                  <button className="glass-row w-full flex items-center justify-center gap-1.5 rounded-xl px-2.5 h-8 text-[12px] text-ink/85 hover:text-ink disabled:opacity-40" onClick={addProvider} disabled={!y || !loaded}>
                    <IconPlus /> Add provider
                  </button>
                </div>
              </div>

              {/* ---- 供应商详情 ---- */}
              <div className="flex-1 min-w-0 overflow-y-auto">
                {!selected ? (
                  /* 空态：没有供应商时只留主 CTA（Runtime 已独立成节） */
                  <div className="min-h-full flex flex-col items-center justify-center px-6 py-10 text-center">
                    <div className="h-14 w-14 rounded-2xl bg-gold/10 border border-gold/30 flex items-center justify-center mb-4">
                      <IconGearBig />
                    </div>
                    <div className="font-kai text-lg text-goldSoft mb-1">还没有模型供应商</div>
                    <p className="text-sm text-mute mb-6 max-w-sm leading-relaxed">
                      添加一个 OpenAI 兼容网关（Base URL + API Key + 模型），对话即可用。<br />API Key 只存本机 config.json。
                    </p>
                    <button className="btn-primary" onClick={addProvider} disabled={!y || !loaded}>
                      <IconPlus /> Add provider
                    </button>
                  </div>
                ) : (
                  <div className="max-w-[620px] px-6 py-6 space-y-5">
            {/* 标题行 */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <h2 className="text-lg font-bold truncate">{selected.name || '未命名供应商'}</h2>
                {selected.id === activeId
                  ? <span className="badge bg-gold/15 text-goldSoft border border-gold/30 shrink-0">对话使用中</span>
                  : <button className="btn-ghost text-xs px-2.5 py-1 shrink-0" onClick={() => { setActiveId(selected.id); touch(); }} disabled={!selected.enabled}>设为对话使用</button>}
              </div>
            </div>

            <Card className="p-5 space-y-4">
              <Field label="名称">
                <input value={selected.name} onChange={(e) => patchSelected({ name: e.target.value })}
                  placeholder="供应商名称，如 硅基流动 / 自建网关" className="input" disabled={!y} />
              </Field>
              <Field label="Base URL" hint="通常以 https:// 开头、/v1 结尾">
                <input value={selected.baseUrl} onChange={(e) => patchSelected({ baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1" className="input font-mono" disabled={!y} />
              </Field>
              <Field label="API 格式">
                <select value={selected.apiFormat || 'chat-completions'}
                  onChange={(e) => patchSelected({ apiFormat: e.target.value })}
                  className="input appearance-none cursor-pointer" disabled={!y}>
                  {API_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </Field>
              <Field label="API Key" hint="只存本机 desktop/config.json，不上传、不进仓库">
                <input type="password" value={selected.apiKey} onChange={(e) => patchSelected({ apiKey: e.target.value })}
                  placeholder="sk-…" className="input font-mono" disabled={!y} autoComplete="new-password" />
              </Field>

              {/* 模型列表：行尾徽标（窗口 / Vision）+ 编辑 / 删除；新增走同一个编辑弹窗 */}
              <div>
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <label className="block text-sm text-mute">
                    模型列表
                    <span className="ml-2 text-xs text-mute/60">对话使用列表中的第一个模型</span>
                  </label>
                  <button type="button" className="btn-ghost text-xs px-2.5 py-1 shrink-0" onClick={openAddModel} disabled={!y}>
                    <IconPlus /> Add model
                  </button>
                </div>
                <div className="space-y-1.5">
                  {(selected.models || []).length === 0 && (
                    <div className="text-xs text-mute/70 px-1 py-1">还没有模型，点右上角「Add model」添加。</div>
                  )}
                  {(selected.models || []).map((entry, idx) => {
                    const v = modelEntryView(entry, selected);
                    const windowTitle = v.window == null
                      ? '上下文窗口未配置（默认 1,000,000）'
                      : `上下文窗口 ${v.window.toLocaleString('en-US')} tokens${v.windowSource === 'model' ? '（模型单独设置）' : '（继承供应商）'}`;
                    return (
                      <div key={`${idx}-${v.id}`} className="flex items-center justify-between gap-2 rounded-lg bg-[#15151a] border border-edge px-3 py-2 group">
                        <span className="font-mono text-sm truncate min-w-0">{v.id || '（空模型名）'}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span title={windowTitle}
                            className={`badge !text-[10px] !px-1.5 !py-0.5 font-mono border ${
                              v.windowSource === 'model'
                                ? 'bg-gold/10 text-goldSoft border-gold/30'
                                : 'bg-white/[0.05] text-mute border-edge'
                            }`}>
                            {formatWindowBadge(v.window)}
                          </span>
                          {v.vision && (
                            <span title="支持图片输入（多模态）"
                              className="badge !text-[10px] !px-1.5 !py-0.5 border border-jade/30 bg-jade/10 text-jade">
                              Vision
                            </span>
                          )}
                          <button type="button" title="编辑模型" aria-label="编辑模型" onClick={(e) => openEditModel(idx, e.currentTarget)}
                            className="p-1 rounded-md text-mute/60 opacity-60 group-hover:opacity-100 hover:text-goldSoft hover:bg-gold/10 transition-all duration-200">
                            <IconPencil />
                          </button>
                          <button type="button" title="删除模型" aria-label="删除模型" onClick={() => removeModel(idx)}
                            className="p-1 rounded-md text-mute/60 opacity-60 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200">
                            <IconX />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <Field label="供应商上下文窗口" hint="模型未单独设置时使用；token 数，默认 1,000,000">
                <input type="number" min="8000" max="2000000" step="1000"
                  value={selected.contextWindow || 1000000}
                  onChange={(e) => patchSelected({ contextWindow: Number(e.target.value) })}
                  className="input font-mono" disabled={!y} />
              </Field>

              {/* 启用开关 */}
              <div className="flex items-center justify-between pt-1">
                <div>
                  <div className="text-sm text-ink">启用</div>
                  <div className="text-xs text-mute mt-0.5">关闭后对话不会使用该供应商</div>
                </div>
                <button role="switch" aria-checked={selected.enabled} aria-label="启用供应商" onClick={() => patchSelected({ enabled: !selected.enabled })}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${selected.enabled ? 'bg-jade' : 'bg-edge'}`}>
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#ece7dc] shadow transition-all duration-200 ${selected.enabled ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
              </div>

              {/* 操作行 */}
              <div className="flex items-center gap-3 pt-2 border-t border-edge/60">
                <button className="btn-primary min-w-[92px]" onClick={save} disabled={!y || !loaded}>保存</button>
                <button className="btn-ghost" onClick={testConnection} disabled={!y || testing}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
                {saved && !dirty && (
                  <span className="text-sm text-jade flex items-center gap-1.5 transition-all duration-200">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                    已保存
                  </span>
                )}
                {dirty && <span className="text-xs text-mute">有未保存的修改</span>}
              </div>

              {/* 测试结果 */}
              {testRes && (testRes.ok ? (
                <div className="rounded-lg bg-jade/10 border border-jade/40 px-4 py-3 text-sm space-y-2">
                  <div className="text-jade font-medium flex items-center gap-1.5">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                    已连通 · 模型已回复
                  </div>
                  <div className="text-xs text-ink/80 bg-card border border-edge rounded px-2.5 py-1.5 leading-relaxed break-words">
                    <span className="text-mute font-mono mr-1.5">{testRes.model}</span>
                    “{testRes.reply}”
                  </div>
                  {testRes.models?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {testRes.models.slice(0, 8).map((m) => (
                        <span key={m} className="badge bg-card border border-edge text-mute font-mono !text-[11px]">{m}</span>
                      ))}
                      {testRes.count > 8 && <span className="text-xs text-mute self-center">…等 {testRes.count} 个</span>}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-lg bg-red-500/10 border border-red-500/40 px-4 py-3 text-sm space-y-1">
                  <div className="text-red-300 font-medium">✗ 连接失败：{testRes.reason}</div>
                  {testRes.hint && <div className="text-xs text-mute leading-relaxed">{testRes.hint}</div>}
                </div>
              ))}

              <ErrorNote>{y ? err : '请在 Electron 中运行后修改设置。'}</ErrorNote>
            </Card>

            <div className="glass-card rounded-xl px-3.5 py-3 text-xs text-mute leading-relaxed">
              <div className="flex items-start gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0 text-goldSoft">
                  <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>对话使用<span className="text-goldSoft">已启用且标记「当前」</span>的供应商；选中者被禁用时自动回退到其他已启用供应商。所有 Key 只存本机。</span>
              </div>
            </div>
                  </div>
                )}
              </div>
            </>
          ) : section === 'about' ? (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6">{aboutCard}</div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6">{runtimeCard}</div>
            </div>
          )}
        </div>
          </>
        )}
      </div>

      {/* Edit model settings（黑金弹窗，参照 ZCode 版式） */}
      {modelDialog && selected && (
        <ModelEditorDialog
          provider={selected}
          isNew={modelDialog.isNew}
          initialEntry={modelDialog.entry}
          otherIds={(selected.models || [])
            .map((m, i) => (i === modelDialog.index ? null : modelEntryView(m, selected).id))
            .filter(Boolean)}
          onSave={applyModelEdit}
          onClose={() => setModelDialog(null)}
          returnFocusRef={modelTriggerRef}
        />
      )}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm text-mute mb-1.5">
        {label}
        {hint && <span className="ml-2 text-xs text-mute/60">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function FieldError({ children }) {
  if (!children) return null;
  return <div className="text-[11px] text-red-400 mt-1 leading-snug">{children}</div>;
}

function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${checked ? 'bg-jade' : 'bg-edge'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#ece7dc] shadow transition-all duration-200 ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

// 参照 ZCode「Edit model settings」：智能配置 / Model ID / 窗口 / 输出 / 高级项 / Reset·Cancel·Save
function ModelEditorDialog({ provider, isNew, initialEntry, otherIds, onSave, onClose, returnFocusRef }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const idInputRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const providerWindow = asPositiveInt(provider?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
  const providerMaxOut = asPositiveInt(provider?.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const view = modelEntryView(initialEntry, provider);
  const initialId = isNew ? '' : view.id;
  const initialOwnWindow = isNew ? null : view.ownContextWindow;
  const initialOwnMaxOut = isNew ? null : view.ownMaxOutputTokens;
  const providerVision = provider?.vision === true;

  const [id, setId] = useState(initialId);
  const [smart, setSmart] = useState(true);
  const [contextWindow, setContextWindow] = useState(() => {
    if (initialOwnWindow != null) return String(initialOwnWindow);
    const auto = detectSmartWindow(initialId);
    return auto != null ? String(auto) : '';
  });
  const [maxOutputTokens, setMaxOutputTokens] = useState(initialOwnMaxOut != null ? String(initialOwnMaxOut) : '');
  const [vision, setVision] = useState(isNew ? providerVision : view.vision);
  const [advanced, setAdvanced] = useState(false);
  const [errors, setErrors] = useState({});
  const detectedWindow = detectSmartWindow(id);

  // 模态：背景 inert（遮罩下不可聚焦）+ Tab 循环 + Esc 关闭 + 关闭后焦点回到打开它的按钮
  useEffect(() => {
    const returnEl = returnFocusRef?.current || document.activeElement;
    const root = dialogRef.current;
    const touched = [];
    let node = root;
    while (node && node.parentElement && node !== document.body) {
      for (const sib of Array.from(node.parentElement.children)) {
        if (sib === node || sib.nodeType !== 1 || sib.hasAttribute('inert')) continue;
        sib.setAttribute('inert', '');
        touched.push(sib);
      }
      node = node.parentElement;
    }
    idInputRef.current?.focus();

    const focusables = () => {
      if (!root) return [];
      return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => el.getClientRects().length > 0);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes.length) { e.preventDefault(); return; }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = root ? root.contains(active) : false;
      if (e.shiftKey) {
        if (!inside || active === first) { e.preventDefault(); last.focus(); }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      for (const el of touched) el.removeAttribute('inert');
      if (returnEl && returnEl.isConnected && typeof returnEl.focus === 'function') returnEl.focus();
    };
  }, [returnFocusRef]);

  // Smart configuration：模型名能识别就填识别值；否则回落到编辑前的显式值（新增则留空继承）
  const smartContext = (modelId) => {
    const auto = detectSmartWindow(modelId);
    if (auto != null) return String(auto);
    return initialOwnWindow != null ? String(initialOwnWindow) : '';
  };

  const changeId = (value) => {
    setId(value);
    setErrors((prev) => (prev.id ? { ...prev, id: undefined } : prev));
    if (smart) setContextWindow(smartContext(value));
  };

  const toggleSmart = (next) => {
    setErrors((prev) => ({ ...prev, contextWindow: undefined, maxOutputTokens: undefined }));
    if (next) setContextWindow(smartContext(id));
    setSmart(next);
  };

  const resetForm = () => {
    // 恢复为继承/默认：窗口/输出留空，Vision 回到供应商默认；不清空 Model ID，避免误删模型身份
    setSmart(true);
    setContextWindow(detectSmartWindow(id) != null ? String(detectSmartWindow(id)) : '');
    setMaxOutputTokens('');
    setVision(providerVision);
    setAdvanced(false);
    setErrors({});
  };

  const submit = () => {
    const checked = validateModelForm({ id, contextWindow, maxOutputTokens, otherIds });
    if (!checked.ok) { setErrors(checked.errors); return; }
    const entry = buildModelObject({
      id: checked.id,
      contextWindow: checked.contextWindow,
      maxOutputTokens: checked.maxOutputTokens,
      vision,
      // 供应商默认开 Vision 时，关闭需要显式写 false，否则会继续继承 true
      forceVisionFalse: providerVision && !vision
    });
    onSave(entry);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-[2px] px-4"
      onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="glass-pop pop-in w-[460px] max-w-[94vw] max-h-[88vh] overflow-y-auto rounded-2xl"
        onClick={(e) => e.stopPropagation()}>
        {/* 标题行 */}
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-edge/60">
          <div className="min-w-0">
            <h3 id={titleId} className="font-kai text-base text-goldSoft">{isNew ? 'Add model' : 'Edit model settings'}</h3>
            <div className="text-[11px] text-mute/60 mt-0.5">{isNew ? '新增模型；留空字段继承供应商' : '修改模型参数'}</div>
          </div>
          <button type="button" className="p-1.5 -mr-1 rounded-md text-mute/60 hover:text-ink hover:bg-white/[0.06] transition-colors shrink-0"
            aria-label="关闭" onClick={onClose}>
            <IconX />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Smart configuration */}
          <div className="flex items-start justify-between gap-3 rounded-lg bg-[#15151a] border border-edge px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm text-ink">Smart configuration</div>
              <div className="text-[11px] text-mute/70 mt-0.5 leading-snug">按模型名自动识别上下文窗口（如 128k / 200k / 1m）；关闭后手动填写。</div>
              {smart && detectedWindow != null && (
                <div className="text-[11px] text-jade/90 mt-1">已匹配到智能配置：{detectedWindow.toLocaleString('en-US')} tokens</div>
              )}
            </div>
            <Switch checked={smart} onChange={toggleSmart} label="Smart configuration" />
          </div>

          <Field label="Model ID">
            <input ref={idInputRef} value={id} onChange={(e) => changeId(e.target.value)}
              placeholder="如 glm-4.6 / deepseek-v4.1-flash"
              className="input font-mono" />
            <FieldError>{errors.id}</FieldError>
          </Field>

          <Field label="Context window"
            hint={smart ? 'Smart configuration 自动填写' : '留空 = 继承供应商'}>
            <input value={contextWindow} onChange={(e) => setContextWindow(e.target.value)}
              disabled={smart} inputMode="numeric" placeholder={String(providerWindow)}
              className={`input font-mono ${smart ? 'opacity-60 cursor-not-allowed' : ''}`} />
            <div className="text-[11px] text-mute/55 mt-1">
              留空继承供应商：{providerWindow.toLocaleString('en-US')} tokens{asPositiveInt(provider?.contextWindow) == null ? '（默认）' : ''}
            </div>
            <FieldError>{errors.contextWindow}</FieldError>
          </Field>

          <Field label="Max output tokens"
            hint={smart ? '关闭 Smart configuration 后可手填' : '留空 = 继承供应商'}>
            <input value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value)}
              disabled={smart} inputMode="numeric" placeholder={String(providerMaxOut)}
              className={`input font-mono ${smart ? 'opacity-60 cursor-not-allowed' : ''}`} />
            <div className="text-[11px] text-mute/55 mt-1">
              留空继承供应商：{providerMaxOut.toLocaleString('en-US')} tokens{asPositiveInt(provider?.maxOutputTokens) == null ? '（默认）' : ''}
            </div>
            <FieldError>{errors.maxOutputTokens}</FieldError>
          </Field>

          {/* Advanced settings：默认收起 */}
          <div className="pt-0.5">
            <button type="button" onClick={() => setAdvanced((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-mute hover:text-ink transition-colors">
              <span className={`inline-block transition-transform duration-200 ${advanced ? 'rotate-90' : ''}`}>▸</span>
              Advanced settings
            </button>
            {advanced && (
              <div className="mt-2.5 rounded-lg border border-edge bg-[#15151a] px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm text-ink">Vision</div>
                    <div className="text-[11px] text-mute/70 mt-0.5">支持图片输入（多模态）</div>
                  </div>
                  <Switch checked={vision} onChange={setVision} label="Vision" />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 底部：Reset form / Cancel / Save */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-edge/60">
          <button type="button" onClick={resetForm}
            className="text-xs text-mute hover:text-ink transition-colors underline-offset-2 hover:underline">
            Reset form
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn-ghost px-3.5 py-1.5 text-xs" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary px-3.5 py-1.5 text-xs min-w-[72px]" onClick={submit}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function IconPencil() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function IconX() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 16v-5M13 16V7M18 16v-3" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
    </svg>
  );
}
function IconChevronLeft() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function IconLayers() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l9 5-9 5-9-5 9-5Z" /><path d="M3 13l9 5 9-5" />
    </svg>
  );
}
function IconSliders() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="11" cy="18" r="1.6" />
    </svg>
  );
}

/* ZCode 式设置导航：分组小标题 + 行（图标 / 标题 / 右侧尾注） */
function NavGroup({ label, children }) {
  return (
    <div>
      <div className="px-3 mb-1 text-[10px] uppercase tracking-[0.14em] text-mute/45">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
function NavRow({ label, icon, active = false, onClick, disabled = false, trailing = '' }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] transition-colors duration-150 disabled:opacity-40 ${
        active ? 'bg-gold/10 text-goldSoft border border-gold/30' : 'border border-transparent text-ink/85 hover:bg-white/[0.045] hover:text-ink'}`}>
      <span className={active ? 'text-goldSoft' : 'text-mute/70'}>{icon}</span>
      <span className="truncate">{label}</span>
      {trailing ? <span className="ml-auto text-[10px] text-mute/40 shrink-0">{trailing}</span> : null}
    </button>
  );
}

function IconGearBig() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-goldSoft">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
