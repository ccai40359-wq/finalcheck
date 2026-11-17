import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolveModel, modelIdsOf, pickUsableProvider } from '../model-config.mjs';
import { setLanguage, resolveLanguage, t } from '../../renderer/i18n/core.mjs';
import { testProviderConnection } from '../provider-test.mjs';

// 配置 schema v2：{ providers: [{ id, name, baseUrl, apiFormat, apiKey, models, enabled }], activeProviderId }
// 兼容旧单供应商形状 { baseUrl, apiKey, model } → 映射为一个 provider
// agent-service 必须动态 import（engineUrl）：main 打包时不能被静态拉进 bundle，
// 否则 src/playbooks.mjs 的 import.meta.url 会指向 out/，方法论库路径失效。
export function createConfigStore({ app, getDataRoot, engineUrl }) {
  const configFile = () => process.env.FINALCHECK_CONFIG_FILE || path.join(getDataRoot(), 'config.json');

  let providerLimitsLoader = null;
  const loadProviderLimits = () => {
    if (!providerLimitsLoader) {
      providerLimitsLoader = import(engineUrl('desktop/src/main/agent-service.mjs'))
        .then((m) => m.normalizeProviderLimits)
        .catch((e) => { providerLimitsLoader = null; throw e; });
    }
    return providerLimitsLoader;
  };

  const normalizeConfig = async (raw) => {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    let providers = Array.isArray(cfg.providers) ? cfg.providers : null;
    if (!providers) {
      providers = (cfg.baseUrl || cfg.apiKey || cfg.model)
        ? [{ id: 'legacy-default', name: '默认供应商', baseUrl: cfg.baseUrl, apiFormat: 'chat-completions', apiKey: cfg.apiKey, models: cfg.model ? [cfg.model] : [], enabled: true }]
        : [];
    }
    let normalizeProviderLimits = () => ({});
    try {
      const fn = await loadProviderLimits();
      if (typeof fn === 'function') normalizeProviderLimits = fn;
    } catch { /* 引擎文件缺失：按未配置扩展字段处理，不拖垮基础配置 */ }
    const normProvider = (p, i) => ({
      id: typeof p?.id === 'string' && p.id ? p.id : `p-${randomUUID().slice(0, 8)}`,
      name: String(p?.name || `供应商 ${i + 1}`).slice(0, 60),
      baseUrl: String(p?.baseUrl || '').trim(),
      apiFormat: p?.apiFormat === 'openai-responses' ? 'openai-responses' : 'chat-completions',
      apiKey: String(p?.apiKey || ''),
      // models 兼容 string[] 与混合对象数组：字符串 trim 后保留，对象原样保留（不做写入迁移）
      models: Array.isArray(p?.models)
        ? p.models
          .map((m) => (typeof m === 'string' ? m.trim() : m))
          .filter((m) => (
            typeof m === 'string'
              ? m.length > 0
              : !!(m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim())
          ))
        : [],
      // 跨家族复核用的家族名（可选）：缺省时 family 判定回落到 name/baseUrl host
      ...(typeof p?.family === 'string' && p.family.trim() ? { family: p.family.trim().slice(0, 60) } : {}),
      // contextWindow / maxOutputTokens / toolConcurrency 按配置原样保留；缺省不写，消费方各回落默认值
      ...normalizeProviderLimits(p),
      enabled: p?.enabled !== false
    });
    const out = { ...cfg, providers: providers.map(normProvider) };
    out.permissionMode = cfg.permissionMode === 'full' ? 'full' : 'ask'; // 权限模式（仿 ZCode Full access）
    // 界面语言只有 zh / en；旧配置的 auto 或缺失先保留为 auto，读取时按系统语言落成实际值（见 loadConfig）
    out.language = cfg.language === 'en' || cfg.language === 'zh' ? cfg.language : 'auto';
    out.activeModel = typeof cfg.activeModel === 'string' ? cfg.activeModel : '';
    out.thinkingEffort = ['low', 'medium', 'high', 'max', 'default'].includes(cfg.thinkingEffort) ? cfg.thinkingEffort : 'max';
    delete out.baseUrl; delete out.apiKey; delete out.model; // 旧形状已迁移进 providers
    const ids = out.providers.map((p) => p.id);
    out.activeProviderId = ids.includes(cfg.activeProviderId) ? cfg.activeProviderId : (ids[0] ?? null);
    return out;
  };

  // 策略沙箱：mode 只认 cfg.sandboxMode，与 permissionMode（审批模式）完全独立。
  //
  // ⚠️ 2026-11-17 修正（规格 §1.2 抓到的真问题）：
  // 我最初把默认值改成 'off' 想「关沙箱 + 允许跨目录」，但 mode 这一个值同时控制三件事：
  //   · ACL 沙箱（sandbox.mjs）
  //   · 项目边界闸（checkCommandPaths 的 strictBoundary = mode !== 'off'）
  //   · 删除目标检查（checkDestructiveTargets 的 `mode === 'off'` 短路）
  // 改 off = 一次丢两道防线，只剩敏感路径。而用户要的只是「关写保护」。
  // 所以默认值恢复 'workspace'（边界闸保留），ACL 写保护由独立的 aclSandbox 开关控制。
  const SANDBOX_MODES = Object.freeze(['workspace', 'readonly', 'off']);
  const sandboxModeOf = (cfg) => (SANDBOX_MODES.includes(cfg?.sandboxMode) ? cfg.sandboxMode : 'workspace');
  // ACL 写保护独立开关（2026-11-17 用户决策：默认关）。
  // 关掉后命令全量走宿主机 Git Bash（一种 shell 一套语法），但项目边界/敏感路径/删除目标三道闸照旧。
  const aclSandboxOf = (cfg) => cfg?.aclSandbox === true;
  const sandboxAllowPathsOf = (cfg) => (
    Array.isArray(cfg?.sandboxAllowPaths) ? cfg.sandboxAllowPaths.filter((x) => typeof x === 'string') : []
  );

  // 界面语言只影响 UI 文案；旧配置 auto/缺失在此落成 zh 或 en（不改写盘上文件，保存时写实际值）
  const applyLanguage = (cfg) => {
    let systemLang = '';
    try { systemLang = app.getLocale?.() || ''; } catch { /* app ready 之前取不到 locale，按 auto→英文 */ }
    const lang = resolveLanguage(cfg?.language, systemLang);
    setLanguage(lang);
    return lang;
  };

  const loadConfig = async () => {
    let cfg;
    try { cfg = await normalizeConfig(JSON.parse(await readFile(configFile(), 'utf8'))); } catch { cfg = await normalizeConfig({}); }
    cfg.language = applyLanguage(cfg); // auto/缺失 → 实际 zh|en，UI 与后续保存都拿实际值
    return cfg;
  };
  const saveConfig = async (cfg) => {
    const next = await normalizeConfig(cfg);
    next.language = applyLanguage(next); // 保存时写回 'zh' / 'en'，不再落 auto
    await writeFile(configFile(), JSON.stringify(next, null, 2), 'utf8');
    return true;
  };

  // 对话使用的供应商：enabled 且被选中（选中者被禁用时回退到第一个 enabled）
  const pickActiveProvider = (cfg) => pickUsableProvider(cfg, '') || null;
  const firstModelId = (prov) => resolveModel(prov, null)?.id || '';

  // 非流式摘要：上下文压缩 / 手动 /compact 共用（失败由调用方兜底）
  // signal：调用方的取消信号（手动压缩点「停止」），与内部 30s 超时取或
  //
  // 2026-11-17（规格 §4 步 5，修缺陷 D3/D4）：
  //   · maxTokens 从 800 提到 5120 —— 800 token 连 CC 八段模板的标题都写不完，
  //     压缩出来的摘要信息量趋零。
  //   · 原来 `String(text).slice(0, maxChars)` 是**保头丢尾**：被压缩区最老的
  //     3 万字符进摘要，最新的 93% 直接消失。而手动 /compact 用的是 slice(-30000)
  //     （保尾）—— 同一上限两个路径口径相反。
  //   · 现在超长时分段摘要再合并：每段都进摘要，覆盖头也覆盖尾。
  async function summarizeWithProvider(prov, text, { maxChars = 30000, maxTokens = 5120, signal = null } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    const onAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const full = String(text ?? '');
      // 分段：超长文本按 maxChars 切块，每块都进摘要（这样头尾都覆盖，不会像
      // slice(0, maxChars) 那样把最新 93% 丢掉）。短文本只有一块，行为与旧版一致。
      const chunks = [];
      if (full.length <= maxChars) {
        chunks.push(full);
      } else {
        for (let i = 0; i < full.length; i += maxChars) chunks.push(full.slice(i, i + maxChars));
      }
      const askOne = async (payload, isMerge) => {
        const prompt = isMerge
          ? '下面是把同一段对话历史分块压缩后得到的多份摘要。请合并成一份完整摘要，使用与对话相同的语言，保留关键结论、文件路径与数字，去掉重复，直接输出摘要本身：\n\n' + payload
          : '请把以下对话历史压缩成要点摘要，使用与对话相同的语言，保留关键结论、路径与数字，直接输出摘要本身：\n\n' + payload;
        const res = await fetch(prov.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + prov.apiKey },
          body: JSON.stringify({
            model: firstModelId(prov),
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            stream: false
          }),
          signal: ctl.signal
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        const s = j.choices?.[0]?.message?.content;
        if (!s || !String(s).trim()) throw new Error(t('空摘要'));
        return String(s).trim();
      };
      // 一块：直接一次摘要
      if (chunks.length === 1) return await askOne(chunks[0], false);
      // 多块：逐块摘要 → 合并（覆盖率 100%，不再丢尾）
      const parts = [];
      for (const c of chunks) parts.push(await askOne(c, false));
      // 合并请求本身也可能超长：合并输入按 maxChars 截，但只截「多份摘要的拼接」，
      // 每份摘要本身已经是压缩过的，所以这里截不会丢原始信息
      return await askOne(parts.join('\n\n---\n\n').slice(0, maxChars), true);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // 会话标题（dsh 式 AI 命名）：首轮结束后用一句短 prompt 生成，失败就保留第一条消息当标题
  async function generateSessionTitle(prov, { user, assistant } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(prov.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(prov.apiKey ? { authorization: 'Bearer ' + prov.apiKey } : {}) },
        body: JSON.stringify({
          model: firstModelId(prov),
          messages: [
            // 标题语言跟随对话本身（不看界面语言）
            { role: 'system', content: '你负责给对话起标题：概括用户要做什么，使用与用户消息相同的语言，长度不超过 12 个汉字或 6 个英文单词；只输出标题本身，不要引号、不要句号、不要解释。' },
            { role: 'user', content: `用户：${String(user || '').slice(0, 600)}\n\n助手：${String(assistant || '').slice(0, 600)}` }
          ],
          max_tokens: 200, // 推理模型会先把预算烧在思考上，给足才拿得到正文标题
          temperature: 0.2,
          stream: false
        }),
        signal: ctl.signal
      });
      if (!res.ok) return null;
      const j = await res.json();
      const title = String(j?.choices?.[0]?.message?.content || '')
        .replace(/^["'「『《（(]+|["'」』》）)]+$/g, '')
        .replace(/[。.!！?？\n\r]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return title ? title.slice(0, 24) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    configFile,
    normalizeConfig,
    applyLanguage,
    loadConfig,
    saveConfig,
    pickActiveProvider,
    modelIdsOf,
    firstModelId,
    sandboxModeOf,
    aclSandboxOf,
    sandboxAllowPathsOf,
    summarizeWithProvider,
    generateSessionTitle
  };
}

// ---- 配置 IPC（读取 / 保存 / 测试供应商连通性） ----
export function registerConfigIpc({ ipcMain, store }) {
  ipcMain.handle('finalcheck:get-config', () => store.loadConfig());
  ipcMain.handle('finalcheck:set-config', (_e, cfg) => store.saveConfig(cfg));

  // 测试供应商连通性：真问一句 hi，模型有回复才算连通（/models 只用来补模型清单，不作为判据）
  ipcMain.handle('finalcheck:test-provider', async (_e, p = {}) => testProviderConnection({
    baseUrl: p?.baseUrl,
    apiKey: p?.apiKey,
    model: p?.model
  }));
}
