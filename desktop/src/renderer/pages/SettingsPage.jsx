// 模型设置页（Cherry Studio 式）：左列供应商列表 + 右列编辑详情
// 配置 schema v2：{ providers: [{ id, name, baseUrl, apiFormat, apiKey, models, enabled }], activeProviderId }
// models 兼容 string[] 与混合对象数组：{ id, contextWindow?, maxOutputTokens?, vision? }
import React, { useEffect, useId, useRef, useState } from 'react';
import { api, Card, ErrorNote } from '../lib/ui.jsx';
import McpSettings from '../components/McpSettings.jsx';
import PermissionRules from '../components/PermissionRules.jsx';
import WebSearchSettings from '../components/WebSearchSettings.jsx';
import HooksSettings from '../components/HooksSettings.jsx';
import { initialUpdateState, reduceUpdateEvent, describeUpdate } from '../lib/updater-state.mjs';
import { changelogView, pickChangelogEntries } from '../lib/changelog.mjs';
import UsagePage from './UsagePage.jsx';
// 双语：界面语言开关（auto 跟随系统 / zh / en）；applyLanguage 立即生效，保存后写入 config
import { t, setLanguage as applyLanguage, resolveLanguage } from '../i18n/core.mjs';
import { useLanguage } from '../i18n/index.jsx';
// 主题：外观节的两个选项（dark 墨黑鎏金 / light 宣纸暖白）
import { THEMES, normalizeTheme, readCachedTheme, writeCachedTheme, applyThemeToDocument } from '../lib/theme.mjs';

const API_FORMATS = [
  { value: 'chat-completions', label: 'chat-completions（OpenAI 兼容）' },
  { value: 'openai-responses', label: 'openai-responses（暂未支持对话）' }
];
// 策略沙箱（与 permissionMode 审批模式独立，Full access 下也生效）
//
// 2026-11-17 说明变更（规格 §2 + §8）：ACL 写保护已拆成独立开关（默认关），
// 所以这里的 mode 只控制「项目边界」这一层，不再等于「有沙箱」。
// 下面三道闸随时生效，与 mode 无关：敏感路径 / 项目边界 / 删除目标。
const SANDBOX_MODES = [
  { value: 'workspace', label: 'workspace', desc: '项目目录内可读写；命令里写明的项目外路径整条拒绝；跨目录需你在消息里点名该目录。敏感路径（~/.ssh、私钥等）与删除项目外文件永久拒绝' },
  { value: 'readonly', label: 'readonly', desc: '全部只读：拒绝任何写入与命令执行（敏感路径与删除检查同样生效）' },
  { value: 'off', label: 'off', desc: '放开项目边界（跨目录不必逐个授权）；但敏感路径与删除项目外文件仍然拒绝——这两道闸不看 mode' }
];
const DEFAULT_TOOL_CONCURRENCY = 8;
// 界面语言：只有中文 / English 两态（不再有跟随系统）。旧配置的 auto 在读取时落成实际语言。
export const LANGUAGE_MODES = [
  { value: 'zh', label: '中文', desc: '界面文案用中文；AI 回复与报告跟随你的提问语言。' },
  { value: 'en', label: 'English', desc: '界面文案用英文；AI 回复与报告跟随你的提问语言。' }
];
const SECTIONS = ['models', 'appearance', 'language', 'runtime', 'browser', 'mcp', 'permissions', 'hooks', 'usage', 'about'];
// 浏览器会话模式（0.31.0）：默认（''）＝还没选过，按无痕运行；选过之后按值运行。
// value 与配置字段同名（browserSessionMode），便于直接写回。
export const BROWSER_SESSION_MODES = [
  { value: 'oneshot', label: '一次性（无痕）', desc: '每次关闭浏览器就清空登录态与 Cookie，不写磁盘。共享电脑请选这一项。' },
  { value: 'persistent', label: '长期保留', desc: '登录态与 Cookie 写进本机磁盘，重启 FinalCheck 后仍保留。只在自己的电脑上使用。' }
];
// 外观：主题只有两套（深色是 0.23.0 之前的唯一皮肤，保持默认）
export const THEME_MODES = [
  { value: 'dark', label: '深色', desc: '墨黑鎏金：暗底金字，长时间看不刺眼。' },
  { value: 'light', label: '浅色', desc: '宣纸暖白：亮底深字，白天或投影时更清楚。' }
];
// 更新详情三段（label 是界面中文原文，t() 负责英文）
const CHANGELOG_SECTIONS = [['added', '新增'], ['fixed', '修复'], ['improved', '优化']];
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
  if (!ctx.ok) errors.contextWindow = t('上下文窗口：{msg}', { msg: t(ctx.error) });
  const out = parseTokenCountInput(maxOutputTokens);
  if (!out.ok) errors.maxOutputTokens = t('最大输出 tokens：{msg}', { msg: t(out.error) });
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

export default function SettingsPage({ onBack, initialSection = 'models', running = false, theme: controlledTheme, onThemeChange }) {
  const y = api();
  const lang = useLanguage(); // 切换语言后本页跟着重渲染（t() 读的是模块级语言状态）
  const [providers, setProviders] = useState([]);   // 草稿（保存前仅在本地）
  const [activeId, setActiveId] = useState(null);   // 对话使用的供应商（activeProviderId）
  const [selectedId, setSelectedId] = useState(null); // 右侧正在编辑的供应商
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState(null); // { key, msg?, fallback? }：渲染时取译文，切换语言后跟着变
  const errText = !err ? '' : t(err.key, { msg: err.msg || (err.fallback ? t(err.fallback) : '') });
  const [modelDialog, setModelDialog] = useState(null); // { isNew, index, entry }
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState(null);     // { ok, reason, hint, count, models }
  const [baseCfg, setBaseCfg] = useState({});       // 保留 permissionMode / activeModel / thinkingEffort 等字段
  const [sandboxMode, setSandboxMode] = useState('workspace');
  // 浏览器会话模式：'oneshot' / 'persistent' / ''（还没选过 → 无痕运行）
  const [browserMode, setBrowserMode] = useState('');
  const [browserClear, setBrowserClear] = useState(null); // 清空结果：{ ok, removed, failed } | { error }
  const [browserClearing, setBrowserClearing] = useState(false);
  const [browserPolicy, setBrowserPolicy] = useState(null); // 主进程解析出的「当前生效」策略（含 partition / open）
  const [toolConc, setToolConc] = useState(DEFAULT_TOOL_CONCURRENCY);
  const [language, setLanguageChoice] = useState(() => resolveLanguage(undefined, navigator.language)); // 界面语言：zh / en（旧配置 auto 读取时落成实际值）
  const [theme, setThemeChoice] = useState(() => readCachedTheme(typeof localStorage !== 'undefined' ? localStorage : null)); // 界面主题：dark / light
  const [section, setSection] = useState(() => (SECTIONS.includes(initialSection) ? initialSection : 'models')); // 设置页内分节：models / runtime / usage / about（仿 ZCode 左侧分组导航）
  const [update, setUpdate] = useState(initialUpdateState); // 更新状态机（纯函数见 lib/updater-state.mjs）
  const [appVersion, setAppVersion] = useState('');
  // 更新详情：null = 还没加载过；{ version, entries, entriesEn } 由 IPC finalcheck:update:changelog 读取随包 CHANGELOG.md / CHANGELOG.en.md
  const [changelog, setChangelog] = useState(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [diagExporting, setDiagExporting] = useState(false);
  const [diagMsg, setDiagMsg] = useState(null);
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
        // 浏览器会话模式：只认 oneshot / persistent；缺省或脏值 → ''（还没选过，按无痕）
        setBrowserMode(c?.browserSessionMode === 'persistent' ? 'persistent' : c?.browserSessionMode === 'oneshot' ? 'oneshot' : '');
        const conc = Number(c?.toolConcurrency);
        setToolConc(Number.isFinite(conc) && conc > 0 ? Math.min(16, Math.max(1, Math.trunc(conc))) : DEFAULT_TOOL_CONCURRENCY);
        // 兼容旧配置：language 缺失或为 'auto' 时按系统语言落成实际值，UI 上选中对应项
        setLanguageChoice(resolveLanguage(c?.language, navigator.language));
        setThemeChoice(normalizeTheme(c?.theme));
        setSelectedId(list[0]?.id ?? null);
        setLoaded(true);
      })
      .catch((e) => { setErr({ key: '读取配置失败：{msg}', msg: e.message }); setLoaded(true); });
  }, [y]);

  // 浏览器会话：进设置页时读一次主进程实际解析出的策略（保存/清空后重读，界面标识与实际一致）
  const refreshBrowserPolicy = () => {
    if (!y?.browserSessionInfo) return;
    y.browserSessionInfo().then((p) => setBrowserPolicy(p || null)).catch(() => setBrowserPolicy(null));
  };
  useEffect(() => { refreshBrowserPolicy(); }, [y]);

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

  // 更新详情：首次展开时才读 CHANGELOG（懒加载）；失败/为空都落到「暂无更新记录」，不抛错
  const toggleChangelog = async () => {
    const next = !changelogOpen;
    setChangelogOpen(next);
    if (!next || changelog || changelogLoading) return;
    if (!y?.changelogGet) {
      setChangelog({ version: appVersion, entries: [], entriesEn: [] });
      return;
    }
    setChangelogLoading(true);
    try {
      const r = await y.changelogGet();
      setChangelog({
        version: String(r?.version || appVersion || ''),
        entries: Array.isArray(r?.entries) ? r.entries : [],
        entriesEn: Array.isArray(r?.entriesEn) ? r.entriesEn : []
      });
    } catch {
      setChangelog({ version: appVersion, entries: [], entriesEn: [] });
    } finally {
      setChangelogLoading(false);
    }
  };

  const selected = providers.find((p) => p.id === selectedId) || null;

  // 诊断包导出：主进程负责脱敏；失败只提示，不影响设置页
  const exportDiagnostics = async () => {
    if (diagExporting) return;
    if (!y?.exportDiagnostics) { setDiagMsg({ key: '当前版本不支持导出诊断' }); return; }
    setDiagExporting(true);
    setDiagMsg(null);
    try {
      const r = await y.exportDiagnostics();
      if (r?.canceled) setDiagMsg({ key: '已取消' });
      else if (r?.ok && r?.path) setDiagMsg({ key: '已导出：{path}', vars: { path: r.path } });
      else setDiagMsg({ key: r?.error || '导出失败' });
    } catch (e) {
      setDiagMsg({ key: '导出失败：{msg}', vars: { msg: e?.message || String(e) } });
    } finally { setDiagExporting(false); }
  };

  const touch = () => { setDirty(true); setSaved(false); };

  const patchSelected = (patch) => {
    setProviders((ps) => ps.map((p) => (p.id === selectedId ? { ...p, ...patch } : p)));
    touch();
  };

  const addProvider = () => {
    const p = { id: newId(), name: t('新供应商'), baseUrl: '', apiFormat: 'chat-completions', apiKey: '', models: [], enabled: true };
    setProviders((ps) => [...ps, p]);
    setSelectedId(p.id);
    setTestRes(null);
    touch();
  };

  const removeProvider = (id) => {
    const p = providers.find((x) => x.id === id);
    if (!window.confirm(t('删除供应商「{name}」？', { name: p?.name || id }))) return;
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
    setErr(null);
    try {
      const clean = providers.map((p) => {
        const windowRaw = asPositiveInt(p.contextWindow);
        // 以原对象为底：family / 供应商级 toolConcurrency 等非界面字段必须原样保留，否则一次保存就丢
        const entry = {
          ...p,
          id: p.id, name: String(p.name || '').trim() || t('未命名供应商'),
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
        // 浏览器会话模式：只写 oneshot / persistent；'' 保留为「还没选过」（首次使用还会再问一次）
        browserSessionMode: browserMode === 'persistent' ? 'persistent' : browserMode === 'oneshot' ? 'oneshot' : '',
        language: language === 'en' ? 'en' : 'zh',
        theme: normalizeTheme(themeValue),
        providers: clean,
        activeProviderId: clean.some((p) => p.id === activeId) ? activeId : (clean[0]?.id ?? null)
      };
      await y.setConfig(nextCfg);
      setBaseCfg(nextCfg);
      setProviders(clean);
      setSandboxMode(mode);
      setToolConc(conc);
      // 保存后重读主进程策略：改模式会关掉旧窗口（partition 改不了），界面标识要跟着变
      refreshBrowserPolicy();
      // 语言立即生效：只切界面文案；agent / 报告不再跟随界面语言（AI 按用户提问语言输出）
      applyLanguage(nextCfg.language);
      // 主题同样立即生效并写本地缓存（设置页内选完就已经落 DOM 了，这里再对齐一次）
      applyThemeToDocument(document, nextCfg.theme);
      writeCachedTheme(typeof localStorage !== 'undefined' ? localStorage : null, nextCfg.theme);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr({ key: '保存失败：{msg}', msg: e?.message, fallback: '请检查配置是否可写（Electron 中运行）' }); }
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

  // 外观：主题两套（受控组件——状态由 App 持有，设置页与标题栏共用一份，
  // 否则「标题栏切了、外观页还显示旧的已选」这种双源 bug 必然复发）。
  // 没传 props 时（单独渲染/测试）退回本地状态，仍可用。
  const themeValue = controlledTheme ?? theme;
  const onPickTheme = (value) => {
    setThemeChoice(value);
    // 主题是即时生效 + 当场落盘的（走 App 的 onThemeChange），不参与「未保存修改」计数：
    // 再调 touch() 会让底部的「保存」一直亮着，暗示还有东西没存，属于假信号。
    applyThemeToDocument(document, value);
    writeCachedTheme(typeof localStorage !== 'undefined' ? localStorage : null, value);
    onThemeChange?.(value);
  };
  const appearanceCard = (
    <Card className="p-5 space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {THEME_MODES.map((m) => {
          const on = themeValue === m.value;
          return (
            <button key={m.value} type="button" role="radio" aria-checked={on}
              onClick={() => onPickTheme(m.value)} disabled={!y}
              className={`relative rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-50 ${on ? 'border-gold/40 bg-gold/[0.06]' : 'border-edge/80 bg-well hover:bg-cardHover'}`}>
              <div className="text-sm text-ink flex items-center gap-2">
                {t(m.label)}
                {on && <span className="text-[10px] text-goldSoft border border-gold/30 rounded px-1 leading-tight">{t('已选')}</span>}
              </div>
              <div className="text-xs text-mute mt-1 leading-snug">{t(m.desc)}</div>
              {/* 一小块配色预览：底 / 面 / 字 / 金 四个色块，一眼看出这套主题长什么样。
                  每块都带一圈描边，否则深色卡的墨底与浅色卡的白面在同类卡片上会「消失」。 */}
              <div className="mt-2.5 flex gap-1.5" aria-hidden="true">
                {(m.value === 'light'
                  ? ['#f7f5f0', '#ffffff', '#1f1c18', '#a8811a']
                  : ['#0a0a0c', '#17171c', '#ece7dc', '#c9a227']
                ).map((c, i) => (
                  <span key={i} className="h-4 w-4 rounded-full ring-1 ring-inset ring-lift/25"
                    style={{ background: c }} />
                ))}
                <span className="ml-0.5 self-center text-[10px] text-mute/70">{t('底 · 面 · 字 · 金')}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="text-xs text-mute leading-relaxed rounded-lg bg-well border border-edge px-3.5 py-2.5">
        {t('主题只影响界面配色，不改动任何代码、报告与导出的文件内容。标题栏右上角的 ☀/☾ 也能随时切换。')}
      </div>

      <div className="flex items-center gap-3 pt-2 border-t border-edge/60">
        <button className="btn-primary min-w-[92px]" onClick={save} disabled={!y || !loaded}>{t('保存')}</button>
        {saved && !dirty && (
          <span className="text-xs text-jade">{t('已保存')}</span>
        )}
      </div>
    </Card>
  );

  // 界面语言：只切界面文案，独立成节（切换立即生效，保存时写入 cfg.language = 'zh' | 'en'）
  const languageCard = (
    <Card className="p-5 space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {LANGUAGE_MODES.map((m) => {
          const on = language === m.value;
          return (
            <button key={m.value} type="button" role="radio" aria-checked={on}
              onClick={() => { setLanguageChoice(m.value); touch(); applyLanguage(m.value); }} disabled={!y}
              className={`relative rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-50 ${on ? 'border-gold/40 bg-gold/[0.06]' : 'border-edge/80 bg-well hover:bg-cardHover'}`}>
              <div className="text-sm text-ink flex items-center gap-2">
                {m.label}
                {on && <span className="text-[10px] text-goldSoft border border-gold/30 rounded px-1 leading-tight">{t('已选')}</span>}
              </div>
              <div className="text-xs text-mute mt-1 leading-snug">{t(m.desc)}</div>
            </button>
          );
        })}
      </div>

      <div className="text-xs text-mute leading-relaxed rounded-lg bg-well border border-edge px-3.5 py-2.5">
        {t('这里只影响按钮、菜单、表单与提示等界面文案；AI 回复和报告使用你提问时的语言，不随这里切换。')}
      </div>

      <div className="flex items-center gap-3 pt-2 border-t border-edge/60">
        <button className="btn-primary min-w-[92px]" onClick={save} disabled={!y || !loaded}>{t('保存')}</button>
        {saved && !dirty && (
          <span className="text-sm text-jade flex items-center gap-1.5 transition-all duration-200">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            {t('已保存')}
          </span>
        )}
        {dirty && <span className="text-xs text-mute">{t('有未保存的修改')}</span>}
      </div>
      <ErrorNote>{!y ? t('请在 Electron 中运行后修改设置。') : errText}</ErrorNote>
    </Card>
  );

  // 浏览器会话（0.31.0）：无痕 / 持久 + 清空持久数据。
  // 与 runtimeCard 同款「选项卡片 + 保存」结构；模式立即写回配置（下一次 browser_navigate 生效）。
  const clearBrowserData = async () => {
    if (!y?.browserClearData || browserClearing) return;
    setBrowserClearing(true);
    setBrowserClear(null);
    try {
      const r = await y.browserClearData();
      setBrowserClear(r || { ok: true, removed: [], failed: [] });
      refreshBrowserPolicy();
    } catch (e) {
      setBrowserClear({ ok: false, error: e?.message || String(e) });
    } finally { setBrowserClearing(false); }
  };
  const browserCard = (
    <Card className="p-5 space-y-4">
      <div>
        <div className="text-sm text-ink font-medium">{t('浏览器会话')}</div>
        <div className="text-xs text-mute mt-0.5">{t('AI 操作网页时用哪种会话：一次性（无痕）不写盘；长期保留会记住登录。')}</div>
      </div>

      <Field label={t('会话模式')} hint={t('默认一次性（无痕）；切换后下一次导航生效')}>
        <div className="flex flex-col gap-2">
          {/* 还没选过（''）在界面上按「一次性」显示，但会标注「尚未选择」，避免用户以为自己已经选过 */}
          {BROWSER_SESSION_MODES.map((m) => {
            const effective = browserMode === m.value || (browserMode === '' && m.value === 'oneshot');
            return (
              <button key={m.value} type="button" onClick={() => { setBrowserMode(m.value); touch(); }} disabled={!y}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${effective ? 'border-gold/40 bg-gold/[0.06]' : 'border-edge/80 bg-well hover:bg-cardHover'}`}>
                <div className={`text-xs font-mono ${effective ? 'text-goldSoft' : 'text-ink/85'}`}>
                  {t(m.label)}{browserMode === '' && m.value === 'oneshot' ? ` · ${t('尚未选择')}` : ''}
                </div>
                <div className="text-[11px] text-mute/80 mt-1 leading-relaxed">{t(m.desc)}</div>
              </button>
            );
          })}
        </div>

        {/* 持久模式的可见标识：让用户随时知道「现在正在记住登录」（红框提示，不靠记忆） */}
        {browserPolicy?.persistent === true && (
          <div className="mt-2.5 rounded-lg border border-red-500/35 bg-red-500/[0.07] px-3 py-2 text-[10px] leading-relaxed text-red-200/90">
            {t('当前正在记住登录：Cookie 与会话写在本机磁盘（userData/Partitions/persist:fc-browser-use）。共享电脑请改回一次性并点「清空浏览器数据」。')}
          </div>
        )}
        {browserPolicy && browserPolicy.persistent !== true && (
          <div className="mt-2.5 rounded-lg border border-jade/25 bg-jade/[0.05] px-3 py-2 text-[10px] leading-relaxed text-jade/85">
            {t('当前为一次性（无痕）：会话保存在内存，关闭浏览器即清空，不写磁盘。')}
          </div>
        )}
      </Field>

      <Field label={t('清空浏览器数据')} hint={t('删除持久会话的 Cookie / 登录态')}>
        <div className="flex items-center gap-2">
          <button type="button" onClick={clearBrowserData} disabled={!y?.browserClearData || browserClearing}
            className="rounded-lg border border-red-500/35 bg-red-500/[0.08] px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/[0.14] disabled:opacity-40">
            {browserClearing ? t('清空中…') : t('清空浏览器数据')}
          </button>
          {browserClear && browserClear.ok === true && (
            <span className="text-[11px] text-jade">
              {browserClear.removed && browserClear.removed.length > 0
                ? t('已清空登录态并删除目录')
                : t('已清空登录态（浏览器进程仍占着目录，缓存文件稍后由系统清理）')}
            </span>
          )}
          {browserClear && browserClear.ok !== true && (
            <span className="text-[11px] text-red-400">{browserClear.error || t('清空失败')}</span>
          )}
        </div>
        <div className="mt-1.5 text-[10px] text-mute/70 leading-relaxed">
          {t('只清 FinalCheck 自己的浏览器数据，不碰你日常用的 Edge 或其它程序。清空前会先关闭浏览器窗口，避免文件被占用删不干净。')}
        </div>
      </Field>

      <div className="flex items-center gap-3 pt-2 border-t border-edge/60">
        <button className="btn-primary min-w-[92px]" onClick={save} disabled={!y || !loaded}>{t('保存')}</button>
        {saved && !dirty && (
          <span className="text-sm text-jade flex items-center gap-1.5 transition-all duration-200">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            {t('已保存')}
          </span>
        )}
        {dirty && <span className="text-xs text-mute">{t('有未保存的修改')}</span>}
      </div>
      <ErrorNote>{!y ? t('请在 Electron 中运行后修改设置。') : errText}</ErrorNote>
    </Card>
  );

  // Agent / 运行时：策略沙箱 + 工具并发（写入 cfg.sandboxMode / cfg.toolConcurrency）
  const runtimeCard = (
    <Card className="p-5 space-y-4">
      <div>
        <div className="text-sm text-ink font-medium">{t('Agent / 运行时')}</div>
        <div className="text-xs text-mute mt-0.5">{t('Sandbox 管路径与命令边界，Tool concurrency 管同时跑几个工具。')}</div>
      </div>

      <Field label={t('沙箱模式')} hint={t('默认 workspace；Full access 下也生效')}>
        {/* 2026-11-17：从 grid-cols-3 改成单列纵向排列。
            原因：三列时每列只有约 220px，新写的说明文字（尤其是「哪些拦得住/拦不住」）
            会挤成 9 行小字，可读性很差；单列每档一行、文字能横向铺开。 */}
        <div className="flex flex-col gap-2">
          {SANDBOX_MODES.map((m) => {
            const on = sandboxMode === m.value;
            return (
              <button key={m.value} type="button" onClick={() => { setSandboxMode(m.value); touch(); }} disabled={!y}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${on ? 'border-gold/40 bg-gold/[0.06]' : 'border-edge/80 bg-well hover:bg-cardHover'}`}>
                <div className={`text-xs font-mono ${on ? 'text-goldSoft' : 'text-ink/85'}`}>{m.label}</div>
                <div className="text-[11px] text-mute/80 mt-1 leading-relaxed">{t(m.desc)}</div>
              </button>
            );
          })}
        </div>
        {/* 诚实声明（决策 3.3）：讲清挡得住什么、挡不住什么，不给虚假安全感 */}
        <div className="mt-2.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[10px] leading-relaxed text-amber-200/80">
          {/* 文案刻意不含 Windows 反斜杠路径：JSX 字符串 / i18n 词典 / 正则闸门三层转义极易写错，
              用「用户主目录下的 .ssh」这种自然语言描述同样清楚，且不会因转义层数不匹配而漏译。 */}
          {t('这不是真沙箱，是「应用层规则 + 审批」。命令统一走 Git Bash（一条命令一种语法）；能拦的是：敏感路径（含 ~、$HOME 这类会先展开再判定的写法）、命令里写明的项目外路径、删除项目外文件、灾难性命令（格式化磁盘 / dd 写设备 / rm -rf 绝对路径）。拦不住的是：程序运行时自己拼出来的路径（脚本内部字符串拼接、读取到的配置里指定的路径、$HOME 之外的变量展开）。要真正的隔离，请在独立容器或 WSL 里跑。')}
        </div>
      </Field>

      <Field label={t('工具并发')} hint={t('同时执行的工具调用数，1–16，默认 8')}>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => { setToolConc((v) => Math.max(1, (Math.trunc(Number(v)) || DEFAULT_TOOL_CONCURRENCY) - 1)); touch(); }} disabled={!y}
            className="h-8 w-8 rounded-md bg-lift/[0.06] hover:bg-lift/[0.12] text-ink/80 disabled:opacity-40">−</button>
          <input type="number" min="1" max="16" step="1" value={toolConc}
            onChange={(e) => { setToolConc(e.target.value); touch(); }}
            onBlur={() => setToolConc((v) => Math.min(16, Math.max(1, Math.trunc(Number(v)) || DEFAULT_TOOL_CONCURRENCY)))}
            className="input font-mono !w-20 text-center" disabled={!y} />
          <button type="button" onClick={() => { setToolConc((v) => Math.min(16, (Math.trunc(Number(v)) || DEFAULT_TOOL_CONCURRENCY) + 1)); touch(); }} disabled={!y}
            className="h-8 w-8 rounded-md bg-lift/[0.06] hover:bg-lift/[0.12] text-ink/80 disabled:opacity-40">+</button>
          <span className="text-xs text-mute/50">1–16</span>
        </div>
      </Field>

      <div className="flex items-center gap-3 pt-2 border-t border-edge/60">
        <button className="btn-primary min-w-[92px]" onClick={save} disabled={!y || !loaded}>{t('保存')}</button>
        {saved && !dirty && (
          <span className="text-sm text-jade flex items-center gap-1.5 transition-all duration-200">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            {t('已保存')}
          </span>
        )}
        {dirty && <span className="text-xs text-mute">{t('有未保存的修改')}</span>}
      </div>
      <ErrorNote>{!y ? t('请在 Electron 中运行后修改设置。') : errText}</ErrorNote>
    </Card>
  );

  // 关于 / 更新：文案与按钮可见性全部来自纯函数 describeUpdate（不硬编码 owner/repo，不展示原始 JSON）
  const updateView = describeUpdate(update, appVersion);
  // 状态机只产出中文句，这里在渲染时按语言重组（zh 输出与 describeUpdate 原文逐字一致）
  const currentVersionText = t(updateView.currentText);
  const updateStatusText = (() => {
    switch (updateView.phase) {
      case 'checking': return t('正在检查…');
      case 'not-available': return t('已是最新（{version}）', { version: currentVersionText });
      case 'available': return updateView.latestText
        ? t('发现 {version}，是否下载？', { version: updateView.latestText })
        : t('发现新版本，是否下载？');
      case 'downloading': return t('下载中 {percent}%', { percent: updateView.progress ?? 0 });
      case 'downloaded': return t('已下载，重启安装');
      case 'error': return t('检查更新失败');
      default: return t('尚未检查更新');
    }
  })();
  const updateToneClass = { mute: 'text-mute', gold: 'text-goldSoft', jade: 'text-jade', red: 'text-red-300' };
  // 更新详情视图：按当前界面语言选条目（英文缺失/为空回退中文）；当前版本置顶，历史版本按 CHANGELOG 顺序向下排列（整卡仍只有一个边框）
  const changelogData = changelogView(pickChangelogEntries(lang, changelog), changelog?.version || appVersion);
  const renderChangelogEntry = (entry, isCurrent) => (
    <div key={`${isCurrent ? 'current' : 'history'}-${entry.version}`} className={isCurrent ? '' : 'pt-3 border-t border-edge/40'}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs text-goldSoft">v{entry.version}</span>
          {isCurrent && (
            <span className="text-[10px] text-mute border border-edge rounded px-1 py-0.5 shrink-0">{t('当前')}</span>
          )}
        </div>
        {entry.date && <span className="font-mono text-[10px] text-mute/60 shrink-0">{entry.date}</span>}
      </div>
      {CHANGELOG_SECTIONS.map(([key, label]) => {
        const items = Array.isArray(entry[key]) ? entry[key] : [];
        if (!items.length) return null; // 空段直接省略，不留空标题
        return (
          <div key={key} className="mt-2">
            <div className="text-[11px] text-ink/70 font-medium">{t(label)}</div>
            <ul className="mt-1 space-y-1">
              {items.map((item, i) => (
                <li key={`${key}-${i}`} className="text-xs text-mute leading-relaxed break-words flex gap-1.5">
                  <span className="text-mute/50 shrink-0">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
  const aboutCard = (
    <Card className="p-5 space-y-4">
      <div>
        <div className="text-sm text-ink font-medium">{t('应用更新')}</div>
        <div className="text-xs text-mute mt-0.5">{t('从 GitHub Release 检查新版本。发现后由你确认下载，重启完成安装；版本与下载地址均由更新模块读取。')}</div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg bg-well border border-edge px-4 py-3">
        <div>
          <div className="text-sm text-ink">{t('当前版本')}</div>
          <div className="text-xs text-mute mt-0.5">{t('仅安装版检查更新；开发模式不联网。')}</div>
        </div>
        <span className="font-mono text-sm text-goldSoft shrink-0">{currentVersionText}</span>
      </div>

      <div className="min-h-[22px]">
        {updateView.errorText ? (
          <div className="text-sm text-red-300 leading-relaxed break-words">{t(updateView.errorText)}</div>
        ) : (
          <div className={`text-sm leading-relaxed ${updateToneClass[updateView.tone] || 'text-mute'}`}>{updateStatusText}</div>
        )}
        {updateView.phase === 'downloading' && (
          <div className="mt-2 h-1 rounded-full bg-lift/10 overflow-hidden">
            <div className="h-full rounded-full bg-goldSoft transition-[width] duration-200" style={{ width: `${updateView.progress ?? 0}%` }} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-edge/60">
        {updateView.showCheck && (
          <button className="btn-primary min-w-[100px]" onClick={checkUpdate} disabled={!y || updateView.checkDisabled}>
            {t(updateView.checkLabel)}
          </button>
        )}
        {updateView.showDownload && (
          <button className="btn-primary min-w-[100px]" onClick={downloadUpdate} disabled={!y}>
            {t(updateView.downloadLabel)}
          </button>
        )}
        {updateView.showInstall && (
          <button className="btn-primary min-w-[100px]" onClick={installUpdate} disabled={!y}>
            {t(updateView.installLabel)}
          </button>
        )}
        <button type="button" className="btn-ghost min-w-[100px]"
          onClick={toggleChangelog} aria-expanded={changelogOpen} aria-controls="about-changelog">
          {t('查看更新详情')}
        </button>
        <button type="button" className="btn-ghost min-w-[100px]"
          onClick={exportDiagnostics} disabled={!y || diagExporting}>
          {diagExporting ? t('导出中…') : t('导出诊断')}
        </button>
        {!y && <span className="text-xs text-mute">{t('请在 Electron 中运行后检查更新。')}</span>}
      </div>
      {diagMsg && (
        <div className="text-xs text-mute leading-relaxed break-words pt-2 border-t border-edge/60">
          {t(diagMsg.key, diagMsg.vars)}
        </div>
      )}

      {changelogOpen && (
        <div id="about-changelog" className="pt-3 border-t border-edge/60">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-ink/80 font-medium">{t('更新详情')}</div>
            <button type="button" className="text-xs text-mute hover:text-ink" onClick={toggleChangelog}>
              {t('收起更新详情')}
            </button>
          </div>
          <div className="mt-2 max-h-64 overflow-y-auto overscroll-contain pr-1 pb-1 space-y-3"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#3a3a42 transparent' }}>
            {changelogLoading && <div className="text-sm text-mute">{t('正在读取更新记录…')}</div>}
            {!changelogLoading && changelogData.empty && (
              <div className="text-sm text-mute">{t('暂无更新记录')}</div>
            )}
            {!changelogLoading && !changelogData.empty && (
              <>
                {changelogData.current
                  ? renderChangelogEntry(changelogData.current, true)
                  : <div className="text-sm text-mute">{t('暂无本版更新记录')}</div>}
                {changelogData.history.map((entry) => renderChangelogEntry(entry, false))}
              </>
            )}
          </div>
        </div>
      )}

      {updateView.phase === 'available' && (
        <div className="text-xs text-mute leading-relaxed">{t('下载完成后不会自动重启；点「重启并安装」立即更新，或下次退出应用时自动安装。')}</div>
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
            {t('返回工作区')}
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-4 space-y-5">
          <NavGroup label={t('基础')}>
            <NavRow label={t('模型设置')} active={section === 'models'} onClick={() => setSection('models')} icon={<IconLayers />} />
            <NavRow label={t('外观')} active={section === 'appearance'} onClick={() => setSection('appearance')} icon={<IconPalette />} />
          </NavGroup>
          <NavGroup label="Agent">
            <NavRow label={t('语言')} active={section === 'language'} onClick={() => setSection('language')} icon={<IconGlobe />} />
            <NavRow label={t('运行时')} active={section === 'runtime'} onClick={() => setSection('runtime')} icon={<IconSliders />} />
            <NavRow label={t('浏览器会话')} active={section === 'browser'} onClick={() => { setSection('browser'); refreshBrowserPolicy(); }} icon={<IconGlobe />}
              trailing={browserPolicy?.persistent === true ? <span className="text-red-400">{t('记住登录')}</span> : ''} />
            <NavRow label={t('MCP 服务器')} active={section === 'mcp'} onClick={() => setSection('mcp')} icon={<IconPlug />} />
            <NavRow label={t('权限规则')} active={section === 'permissions'} onClick={() => setSection('permissions')} icon={<IconShieldRule />} />
            <NavRow label="Hooks" active={section === 'hooks'} onClick={() => setSection('hooks')} icon={<IconHook />} />
          </NavGroup>
          <NavGroup label={t('数据与统计')}>
            <NavRow label={t('用量统计')} active={section === 'usage'} onClick={() => setSection('usage')} icon={<IconChart />} trailing="Tokens" />
          </NavGroup>
          <NavGroup label={t('关于')}>
            <NavRow label={t('关于与更新')} active={section === 'about'} onClick={() => setSection('about')} icon={<IconRefresh />}
              trailing={updateView.hasUpdate ? <span className="text-red-400">{t('有新版本')}</span> : ''} />
          </NavGroup>
        </div>
      </nav>

      {/* ---- 内容区 ---- */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {section === 'usage' ? (
          <UsagePage running={running} />
        ) : (
          <>
        {/* 页头：大标题 + 副标题 + 主操作（仿 ZCode） */}
        <div className="shrink-0 px-8 pt-6 pb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="fc-title text-[22px] leading-tight">
              {section === 'models' ? t('模型设置') : section === 'appearance' ? t('外观') : section === 'language' ? t('语言') : section === 'runtime' ? t('运行时') : section === 'browser' ? t('浏览器会话') : section === 'mcp' ? t('MCP 服务器') : section === 'permissions' ? t('权限规则') : section === 'hooks' ? 'Hooks' : t('关于')}
            </h1>
            <p className="text-[12px] text-mute mt-1.5 leading-relaxed">
              {section === 'models'
                ? t('管理自定义模型供应商。配置好后可在对话里选择使用。')
                : section === 'appearance'
                  ? t('深色（墨黑鎏金）与浅色（宣纸暖白）两套主题；切换立即生效。')
                  : section === 'language'
                  ? t('只切换界面文案（按钮、菜单、表单、提示）；立即生效。AI 回复与报告跟随你的提问语言。')
                  : section === 'runtime'
                    ? t('沙箱与工具并发：对所有供应商生效，与权限模式（Full access）独立。')
                    : section === 'browser'
                      ? t('AI 操作网页时的会话模式：默认一次性（无痕），可切换为长期保留登录。')
                      : section === 'mcp'
                        ? t('接入外部 MCP 服务器（GitHub、数据库、设计工具……），它们的工具会出现在 AI 的工具箱里。')
                        : section === 'permissions'
                          ? t('长期有效的允许 / 拒绝规则：常用命令不用每次点批准，危险操作永远不让 AI 做。')
                        : section === 'hooks'
                          ? t('在关键时刻自动跑你的脚本：改完文件自动格式化、拦截危险命令、回复结束发通知。')
                        : t('版本信息与更新：检查 GitHub Release，下载后重启安装。')}
            </p>
          </div>
          {section === 'models' && (
            <button className="btn-primary shrink-0" onClick={addProvider} disabled={!y || !loaded}>
              <IconPlus /> {t('添加供应商')}
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {section === 'models' ? (
            <>
              {/* ---- Providers 列 ---- */}
              <div className="w-[240px] shrink-0 border-r border-edge/40 flex flex-col min-h-0">
                <div className="px-3.5 pt-2 pb-2 text-[10px] uppercase tracking-[0.14em] text-mute/45">{t('供应商')}</div>
                <div className="flex-1 min-h-0 overflow-y-auto px-2 space-y-1">
                  {providers.length === 0 && loaded && (
                    <div className="text-xs text-mute/70 px-2 py-3">{t('还没有供应商，点下方按钮添加。')}</div>
                  )}
                  {providers.map((p) => {
                    const sel = p.id === selectedId;
                    return (
                      <div key={p.id} onClick={() => { setSelectedId(p.id); setTestRes(null); }}
                        className={`group relative cursor-pointer rounded-lg pl-3 pr-7 py-2 border transition-all duration-200 ${
                          sel ? 'border-lift/[0.10] bg-lift/[0.07]' : 'border-transparent hover:bg-lift/[0.04]'}`}>
                        <div className="flex items-center gap-2 min-w-0">
                          {/* 绿点 = 已启用（与 ZCode 一致） */}
                          <span title={p.enabled !== false ? t('已启用') : t('已停用')}
                            className={`w-2 h-2 rounded-full shrink-0 ${p.enabled !== false ? 'bg-jade' : 'bg-mute/30'}`} />
                          <span className={`text-sm truncate ${sel ? 'text-ink font-medium' : 'text-ink/80'}`}>{p.name || t('未命名供应商')}</span>
                        </div>
                        {p.id === activeId && (
                          <span className="badge bg-gold/15 text-goldSoft border border-gold/30 !px-1.5 !text-[10px] absolute right-1.5 top-1.5">{t('当前')}</span>
                        )}
                        <button title={t('删除供应商')} onClick={(e) => { e.stopPropagation(); removeProvider(p.id); }}
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
                    <IconPlus /> {t('添加供应商')}
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
                    <div className="fc-title text-lg mb-1">{t('还没有模型供应商')}</div>
                    <p className="text-sm text-mute mb-6 max-w-sm leading-relaxed">
                      {t('添加一个 OpenAI 兼容网关（Base URL + API Key + 模型），对话即可用。')}<br />{t('API Key 只存本机 config.json。')}
                    </p>
                    <button className="btn-primary" onClick={addProvider} disabled={!y || !loaded}>
                      <IconPlus /> {t('添加供应商')}
                    </button>
                  </div>
                ) : (
                  <div className="max-w-[620px] px-6 py-6 space-y-5">
            {/* 标题行 */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <h2 className="text-lg font-bold truncate">{selected.name || t('未命名供应商')}</h2>
                {selected.id === activeId
                  ? <span className="badge bg-gold/15 text-goldSoft border border-gold/30 shrink-0">{t('对话使用中')}</span>
                  : <button className="btn-ghost text-xs px-2.5 py-1 shrink-0" onClick={() => { setActiveId(selected.id); touch(); }} disabled={!selected.enabled}>{t('设为对话使用')}</button>}
              </div>
            </div>

            <Card className="p-5 space-y-4">
              <Field label={t('名称')}>
                <input value={selected.name} onChange={(e) => patchSelected({ name: e.target.value })}
                  placeholder={t('供应商名称，如 硅基流动 / 自建网关')} className="input" disabled={!y} />
              </Field>
              <Field label="Base URL" hint={t('通常以 https:// 开头、/v1 结尾')}>
                <input value={selected.baseUrl} onChange={(e) => patchSelected({ baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1" className="input font-mono" disabled={!y} />
              </Field>
              <Field label={t('API 格式')}>
                <select value={selected.apiFormat || 'chat-completions'}
                  onChange={(e) => patchSelected({ apiFormat: e.target.value })}
                  className="input appearance-none cursor-pointer" disabled={!y}>
                  {API_FORMATS.map((f) => <option key={f.value} value={f.value}>{t(f.label)}</option>)}
                </select>
              </Field>
              <Field label="API Key" hint={t('只存本机 desktop/config.json，不上传、不进仓库')}>
                <input type="password" value={selected.apiKey} onChange={(e) => patchSelected({ apiKey: e.target.value })}
                  placeholder="sk-…" className="input font-mono" disabled={!y} autoComplete="new-password" />
              </Field>

              {/* 模型列表：行尾徽标（窗口 / Vision）+ 编辑 / 删除；新增走同一个编辑弹窗 */}
              <div>
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <label className="block text-sm text-mute">
                    {t('模型列表')}
                    <span className="ml-2 text-xs text-mute/60">{t('对话使用列表中的第一个模型')}</span>
                  </label>
                  <button type="button" className="btn-ghost text-xs px-2.5 py-1 shrink-0" onClick={openAddModel} disabled={!y}>
                    <IconPlus /> {t('添加模型')}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {(selected.models || []).length === 0 && (
                    <div className="text-xs text-mute/70 px-1 py-1">{t('还没有模型，点右上角「添加模型」添加。')}</div>
                  )}
                  {(selected.models || []).map((entry, idx) => {
                    const v = modelEntryView(entry, selected);
                    const windowTitle = v.window == null
                      ? t('上下文窗口未配置（默认 1,000,000）')
                      : t(v.windowSource === 'model'
                        ? '上下文窗口 {window} tokens（模型单独设置）'
                        : '上下文窗口 {window} tokens（继承供应商）',
                        { window: v.window.toLocaleString('en-US') });
                    return (
                      <div key={`${idx}-${v.id}`} className="flex items-center justify-between gap-2 rounded-lg bg-well border border-edge px-3 py-2 group">
                        <span className="font-mono text-sm truncate min-w-0">{v.id || t('（空模型名）')}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span title={windowTitle}
                            className={`badge !text-[10px] !px-1.5 !py-0.5 font-mono border ${
                              v.windowSource === 'model'
                                ? 'bg-gold/10 text-goldSoft border-gold/30'
                                : 'bg-lift/[0.05] text-mute border-edge'
                            }`}>
                            {t(formatWindowBadge(v.window))}
                          </span>
                          {v.vision && (
                            <span title={t('支持图片输入（多模态）')}
                              className="badge !text-[10px] !px-1.5 !py-0.5 border border-jade/30 bg-jade/10 text-jade">
                              Vision
                            </span>
                          )}
                          <button type="button" title={t('编辑模型')} aria-label={t('编辑模型')} onClick={(e) => openEditModel(idx, e.currentTarget)}
                            className="p-1 rounded-md text-mute/60 opacity-60 group-hover:opacity-100 hover:text-goldSoft hover:bg-gold/10 transition-all duration-200">
                            <IconPencil />
                          </button>
                          <button type="button" title={t('删除模型')} aria-label={t('删除模型')} onClick={() => removeModel(idx)}
                            className="p-1 rounded-md text-mute/60 opacity-60 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200">
                            <IconX />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <Field label={t('供应商上下文窗口')} hint={t('模型未单独设置时使用；token 数，默认 1,000,000')}>
                <input type="number" min="8000" max="2000000" step="1000"
                  value={selected.contextWindow || 1000000}
                  onChange={(e) => patchSelected({ contextWindow: Number(e.target.value) })}
                  className="input font-mono" disabled={!y} />
              </Field>

              {/* 启用开关 */}
              <div className="flex items-center justify-between pt-1">
                <div>
                  <div className="text-sm text-ink">{t('启用')}</div>
                  <div className="text-xs text-mute mt-0.5">{t('关闭后对话不会使用该供应商')}</div>
                </div>
                <button role="switch" aria-checked={selected.enabled} aria-label={t('启用供应商')} onClick={() => patchSelected({ enabled: !selected.enabled })}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${selected.enabled ? 'bg-jade' : 'bg-edge'}`}>
                  <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-[rgb(var(--fc-knob))] shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-[cubic-bezier(.22,1,.36,1)] ${selected.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* 操作行 */}
              <div className="flex items-center gap-3 pt-2 border-t border-edge/60">
                <button className="btn-primary min-w-[92px]" onClick={save} disabled={!y || !loaded}>{t('保存')}</button>
                <button className="btn-ghost" onClick={testConnection} disabled={!y || testing}>
                  {testing ? t('测试中…') : t('测试连接')}
                </button>
                {saved && !dirty && (
                  <span className="text-sm text-jade flex items-center gap-1.5 transition-all duration-200">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                    {t('已保存')}
                  </span>
                )}
                {dirty && <span className="text-xs text-mute">{t('有未保存的修改')}</span>}
              </div>

              {/* 测试结果 */}
              {testRes && (testRes.ok ? (
                <div className="rounded-lg bg-jade/10 border border-jade/40 px-4 py-3 text-sm space-y-2">
                  <div className="text-jade font-medium flex items-center gap-1.5">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                    {t('已连通 · 模型已回复')}
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
                      {testRes.count > 8 && <span className="text-xs text-mute self-center">{t('…等 {n} 个', { n: testRes.count })}</span>}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-lg bg-red-500/10 border border-red-500/40 px-4 py-3 text-sm space-y-1">
                  <div className="text-red-300 font-medium">✗ {t('连接失败：{reason}', { reason: t(testRes.reason) })}</div>
                  {testRes.hint && <div className="text-xs text-mute leading-relaxed">{t(testRes.hint)}</div>}
                </div>
              ))}

              <ErrorNote>{y ? errText : t('请在 Electron 中运行后修改设置。')}</ErrorNote>
            </Card>

            <div className="glass-card rounded-xl px-3.5 py-3 text-xs text-mute leading-relaxed">
              <div className="flex items-start gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0 text-goldSoft">
                  <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>{t('对话使用已启用且标记「当前」的供应商；选中者被禁用时自动回退到其他已启用供应商。所有 Key 只存本机。')}</span>
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
          ) : section === 'appearance' ? (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6">{appearanceCard}</div>
            </div>
          ) : section === 'language' ? (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6">{languageCard}</div>
            </div>
          ) : section === 'browser' ? (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6">{browserCard}</div>
            </div>
          ) : section === 'mcp' ? (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6"><McpSettings /></div>
            </div>
          ) : section === 'permissions' ? (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6"><PermissionRules /></div>
            </div>
          ) : section === 'hooks' ? (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6"><HooksSettings /></div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-2xl px-6 py-6 space-y-4">{runtimeCard}<WebSearchSettings /></div>
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
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-[rgb(var(--fc-knob))] shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-[cubic-bezier(.22,1,.36,1)] ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
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
            <h3 id={titleId} className="fc-title text-base">{isNew ? t('添加模型') : t('编辑模型设置')}</h3>
            <div className="text-[11px] text-mute/60 mt-0.5">{isNew ? t('新增模型；留空字段继承供应商') : t('修改模型参数')}</div>
          </div>
          <button type="button" className="p-1.5 -mr-1 rounded-md text-mute/60 hover:text-ink hover:bg-lift/[0.06] transition-colors shrink-0"
            aria-label={t('关闭')} onClick={onClose}>
            <IconX />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Smart configuration */}
          <div className="flex items-start justify-between gap-3 rounded-lg bg-well border border-edge px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm text-ink">{t('智能配置')}</div>
              <div className="text-[11px] text-mute/70 mt-0.5 leading-snug">{t('按模型名自动识别上下文窗口（如 128k / 200k / 1m）；关闭后手动填写。')}</div>
              {smart && detectedWindow != null && (
                <div className="text-[11px] text-jade/90 mt-1">{t('已匹配到智能配置：{window} tokens', { window: detectedWindow.toLocaleString('en-US') })}</div>
              )}
            </div>
            <Switch checked={smart} onChange={toggleSmart} label={t('智能配置')} />
          </div>

          <Field label="Model ID">
            <input ref={idInputRef} value={id} onChange={(e) => changeId(e.target.value)}
              placeholder={t('如 glm-4.6 / deepseek-v4.1-flash')}
              className="input font-mono" />
            <FieldError>{t(errors.id)}</FieldError>
          </Field>

          <Field label={t('上下文窗口')}
            hint={smart ? t('Smart configuration 自动填写') : t('留空 = 继承供应商')}>
            <input value={contextWindow} onChange={(e) => setContextWindow(e.target.value)}
              disabled={smart} inputMode="numeric" placeholder={String(providerWindow)}
              className={`input font-mono ${smart ? 'opacity-60 cursor-not-allowed' : ''}`} />
            <div className="text-[11px] text-mute/55 mt-1">
              {t(asPositiveInt(provider?.contextWindow) == null
                ? '留空继承供应商：{value} tokens（默认）'
                : '留空继承供应商：{value} tokens',
                { value: providerWindow.toLocaleString('en-US') })}
            </div>
            <FieldError>{t(errors.contextWindow)}</FieldError>
          </Field>

          <Field label={t('最大输出 tokens')}
            hint={smart ? t('关闭 Smart configuration 后可手填') : t('留空 = 继承供应商')}>
            <input value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value)}
              disabled={smart} inputMode="numeric" placeholder={String(providerMaxOut)}
              className={`input font-mono ${smart ? 'opacity-60 cursor-not-allowed' : ''}`} />
            <div className="text-[11px] text-mute/55 mt-1">
              {t(asPositiveInt(provider?.maxOutputTokens) == null
                ? '留空继承供应商：{value} tokens（默认）'
                : '留空继承供应商：{value} tokens',
                { value: providerMaxOut.toLocaleString('en-US') })}
            </div>
            <FieldError>{t(errors.maxOutputTokens)}</FieldError>
          </Field>

          {/* Advanced settings：默认收起 */}
          <div className="pt-0.5">
            <button type="button" onClick={() => setAdvanced((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-mute hover:text-ink transition-colors">
              <span className={`inline-block transition-transform duration-200 ${advanced ? 'rotate-90' : ''}`}>▸</span>
              {t('高级设置')}
            </button>
            {advanced && (
              <div className="mt-2.5 rounded-lg border border-edge bg-well px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm text-ink">Vision</div>
                    <div className="text-[11px] text-mute/70 mt-0.5">{t('支持图片输入（多模态）')}</div>
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
            {t('重置表单')}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn-ghost px-3.5 py-1.5 text-xs" onClick={onClose}>{t('取消')}</button>
            <button type="button" className="btn-primary px-3.5 py-1.5 text-xs min-w-[72px]" onClick={submit}>{t('保存')}</button>
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
function IconGlobe() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.6 3.1 4 5.9 4 9s-1.4 5.9-4 9c-2.6-3.1-4-5.9-4-9s1.4-5.9 4-9Z" />
    </svg>
  );
}
function IconPalette() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a5.5 5.5 0 0 0 5.5-5.5C20.5 5 16.6 3 12 3Z" />
      <circle cx="7.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconHook() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 4v6a6 6 0 0 1-12 0v-1" /><path d="m3 12 3-3 3 3" /><circle cx="18" cy="4" r="1.5" />
    </svg>
  );
}
function IconShieldRule() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" />
    </svg>
  );
}
function IconPlug() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 7V3M15 7V3" /><path d="M6 7h12v4a6 6 0 0 1-12 0V7Z" /><path d="M12 17v4" />
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
      <div className="px-3 mb-1 text-[10.5px] font-medium uppercase tracking-[0.09em] text-mute/55">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
function NavRow({ label, icon, active = false, onClick, disabled = false, trailing = '' }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] transition-colors duration-150 disabled:opacity-40 ${
        active ? 'fc-row-active fc-ind-in relative bg-lift/[0.08] text-ink border border-transparent' : 'border border-transparent text-ink/75 hover:bg-lift/[0.045] hover:text-ink'}`}>
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
