// App 外壳的纯函数 / 常量（原先都内联在 App.jsx）：不依赖 React，不持有状态。
// 双语约定不变：这里只把 t() 放进函数体，调用时才读当前语言，绝不在模块级求值。
import { t } from '../i18n/core.mjs';

// 模型条目兼容 string 与 { id, contextWindow, maxOutputTokens, vision }：
// 模型设置保存的是对象，而会话配置/菜单只认 string 的 id（否则会把对象当 React child 渲染）
export const modelId = (m) => (typeof m === 'string' ? m.trim() : String(m?.id ?? '').trim());
export const modelIdsOf = (p) => (Array.isArray(p?.models) ? p.models : []).map(modelId).filter(Boolean);
export const modelEntriesOf = (p) => (Array.isArray(p?.models) ? p.models : [])
  .map((m) => (typeof m === 'string' ? { id: m.trim() } : (m && typeof m === 'object' ? { ...m, id: modelId(m) } : { id: '' })))
  .filter((m) => m.id);

// 队列 id / 粘贴块 id / 行数统计 / 长粘贴阈值（照 ZCode：≥8 行或 ≥1000 字符 → 收成「粘贴文本块」卡片）
export const nextQueueId = () => `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const nextPasteId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const countLines = (text) => String(text || '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
export const isLongPaste = (text) => {
  const str = String(text || '');
  if (!str.trim()) return false;
  return countLines(str) >= 8 || str.length >= 1000;
};

// 空态能力卡：直接对应我们自己的功能，不写死任何目录/端口
export const CAPABILITIES = [
  { id: 'audit', title: '代码体检', en: 'Audit', icon: 'shield', desc: '对当前项目跑 L1/L2/L3，结论带文件:行证据',
    prompt: '对当前项目做一次 L2 安全体检：先给目录概览，再按检查项跑，结论要带文件:行证据。' },
  { id: 'pentest', title: '渗透测试', en: 'Pentest', icon: 'radar', desc: '先侦察再按方法论跑最小验证集，不爆破',
    prompt: `我要做渗透测试，目标 URL 是：
（把目标地址补在这行后面）
先侦察端口/指纹，再按方法论跑最小验证集，不要爆破。` },
  { id: 'download', title: '下载闸安检', en: 'Download gate', icon: 'download', desc: '安装脚本、投毒、外呼、README 注入',
    prompt: '对当前项目做下载闸安检：安装脚本、投毒、外呼、README 注入。' },
  { id: 'workflow', title: '多 Agent 工作流', en: 'Workflow', icon: 'flow', desc: '分头查多个方向，最后汇总成一份结论',
    prompt: '用工作流分头查这个项目的三个方向：依赖与供应链、鉴权与越权、动态探测；最后汇总成一份结论。' },
  { id: 'report', title: '生成报告', en: 'Report', icon: 'report', desc: '跑体检并生成可预览的完整报告',
    prompt: '对当前项目跑一次体检，并生成可预览的完整报告。' },
  { id: 'explore', title: '自由执行', en: 'Free run', icon: 'terminal', desc: '看目录、读代码、跑命令，像 coding agent 一样',
    prompt: '先看一下当前项目的目录结构和 README，再用三句话告诉我这是个什么项目。' }
];

// 首次使用判定：没有供应商，或所有供应商都被禁用（enabled === false）
export const needsFirstRunSetup = (cfg) => !(Array.isArray(cfg?.providers) ? cfg.providers : []).some((p) => p?.enabled !== false);

// 示例体检结果 → 展示摘要（verdict + 发现数 + 前 3 条）
export function formatDemoAuditSummary(result, dir) {
  const verdict = result?.conclusion?.verdict || result?.verdict || t('未给出结论');
  const reason = result?.conclusion?.reason || result?.reason || '';
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const SEV_LABEL = { high: t('高危'), medium: t('中危'), low: t('低危') };
  const lines = findings.slice(0, 3).map((f) => {
    const sev = SEV_LABEL[f?.severity] || t('提示');
    const where = f?.file ? t('（{where}）', { where: `${baseName(f.file)}${f?.line ? `:${f.line}` : ''}` }) : '';
    return `- [${sev}] ${f?.checkId ? `${f.checkId} · ` : ''}${f?.message || f?.rule || t('未命名问题')}${where}`;
  });
  return [
    t('### 示例体检完成（L2）'),
    `${t('**结论：{verdict}**', { verdict })}${reason ? ` · ${reason}` : ''}`,
    t(findings.length > 3 ? '发现 **{n}** 条，先列前 3 条' : '发现 **{n}** 条', { n: findings.length }),
    lines.length ? lines.join('\n') : t('没有发现明显问题。'),
    t('> 示例目录：`{dir}`', { dir })
  ].join('\n\n');
}

// 用户消息里的附件块（发送时由 renderer 追加，模型可见；UI 显示成文件 chips）
export const splitAttachmentBlock = (content) => {
  const s = String(content || '');
  const m = s.match(/\n\n\[附件\]\n((?:- .+\n?)+)$/);
  if (!m) return { text: s, files: [] };
  return {
    text: s.slice(0, m.index),
    files: m[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
  };
};
export const baseName = (p) => String(p || '').split(/[\\/]/).pop();

// /workflow 会展开成一段工程指令发给模型；聊天里只显示「Workflow + 任务」，原始指令折叠可查
// 新文案先让模型判断任务形状；旧会话仍以老前缀开头，解析时两种都要认（否则历史消息标题/正文露指令原文）
export const WF_PROMPT_PREFIX = '先判断任务形状，再决定表示方式（二选一，互斥）';
export const WF_PROMPT_PREFIX_LEGACY = '请用 run_workflow 组织一次多 agent 工作流';
export const parseWorkflowPrompt = (content) => {
  const s = String(content || '');
  if (!s.startsWith(WF_PROMPT_PREFIX) && !s.startsWith(WF_PROMPT_PREFIX_LEGACY)) return null;
  const m = s.match(/\n任务：([\s\S]*)$/);
  return { task: (m?.[1] || '').trim() };
};

// 会话标题展示：把技能/工作流的内部指令原文折成可读形式（老会话也立即变干净）
export const prettyTitle = (text) => {
  const s = String(text || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim();
  const skill = s.match(/^\[技能\]\s*([^（(]+)/);
  if (skill) return `✦ ${skill[1].trim().slice(0, 24)}`;
  if (s.startsWith(WF_PROMPT_PREFIX)) {
    const task = s.match(/\n任务：([^\n]+)/);
    return `Workflow · ${(task?.[1] || t('多 agent 工作流')).trim().slice(0, 24)}`;
  }
  return s;
};

// ---- 技能展开段（纯函数，便于单测） ----
// expandSkill() 会把用户输入的 /ssrf 展开成固定句式（发给模型）：
//   [技能] <中文名>（playbook <id>）—— 请先调用 read_playbook(topic="<id>") 加载方法论，再严格按手册执行。
// 聊天里不该露这段内部指令，所以在这里解析回「名称 + id」并把它从正文里摘掉。
// 正则说明：名称可含中文/空格/括号，故名称用惰性 [\s\S]*? 并锚定「（playbook 」；
// id 优先取 topic="..." 引号内的值（比括号里的 id 更可靠，名称里的括号不会污染它）；
// 段首空白一并吃掉，段后空白留给后续正文，最后再规整一次空白（不动普通消息）。
export const SKILL_SEGMENT_RE = /[ \t]*\[技能\]\s*([\s\S]*?)（playbook\s+([^）]*?)）——\s*请先调用\s*read_playbook\(topic="([^"]*)"\)\s*加载方法论，再严格按手册执行。/g;
export const buildSkillSegment = (s) => `[技能] ${s.cn}（playbook ${s.id}）—— 请先调用 read_playbook(topic="${s.id}") 加载方法论，再严格按手册执行。`;

export const tidySkillRemoval = (s) => String(s || '')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n[ \t]+/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const parseSkillSegments = (content) => {
  const source = String(content || '');
  const skills = [];
  // String.replace 每次从 lastIndex 0 开始，这里显式归零，避免全局正则被外部复用时串状态
  SKILL_SEGMENT_RE.lastIndex = 0;
  const stripped = source.replace(SKILL_SEGMENT_RE, (full, name, idInParen, topic) => {
    const id = String(topic || idInParen || '').trim();
    skills.push({ name: String(name || '').trim() || id, id });
    return ' ';
  });
  if (!skills.length) return { skills, text: source, tokenText: source };
  SKILL_SEGMENT_RE.lastIndex = 0;
  // tokenText：把展开段还原成 /id，供复制/编辑用；重发时再由 expandSkill 展开
  const tokenText = tidySkillRemoval(source.replace(SKILL_SEGMENT_RE, (full, name, idInParen, topic) => ` /${String(topic || idInParen || '').trim()} `));
  return { skills, text: tidySkillRemoval(stripped), tokenText };
};

export const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// 图片预览统一入口：磁盘路径 → artifactRead 拿 dataURL（不依赖内存 File/blob 生命周期），
// 展示前用 canvas 把最长边压到 ≤480px，避免把 20MB 原图 base64 塞进 React state。
export const MAX_PREVIEW_DIM = 480;
export function shrinkImageDataUrl(dataUrl, maxDim = MAX_PREVIEW_DIM) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (!w || !h || Math.max(w, h) <= maxDim) return resolve(dataUrl);
          const scale = maxDim / Math.max(w, h);
          const cw = Math.max(1, Math.round(w * scale));
          const ch = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(dataUrl);
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl); // 解码失败交给调用方决定占位/重试
      img.src = dataUrl;
    } catch { resolve(dataUrl); }
  });
}

export async function previewFromPath(y, p) {
  if (!p || !IMG_EXT_RE.test(String(p))) return null;
  try {
    const r = await y?.artifactRead?.(p);
    if (!r?.dataUrl) return null;
    return await shrinkImageDataUrl(r.dataUrl);
  } catch { return null; }
}

// / 技能展开：/workflow 展开成工程指令，其它 /token 逐个展开成 read_playbook 指令（纯文本变换）。
export const expandSkill = (text, skills) => {
  const raw = String(text || '');
  // /workflow 出现在任意位置都生效：把命令本身拿掉，剩下的全文当任务
  if (/(^|\s)\/workflow(?=\s|$)/i.test(raw)) {
    const task = raw.replace(/(^|\s)\/workflow(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();
    return `先判断任务形状，再决定表示方式（二选一，互斥），不要问用户用哪种，你自己判断，用 run_workflow 执行：
- 步骤数量固定、方向并列/串行 → 用 steps（DAG）：设计 2-8 个步骤（id/name/role/prompt/depends_on），互不依赖的步骤会并行执行；每步 prompt 必须自包含（要做什么、输入是什么、交付什么），上游结果引擎会自动附上。
- 步骤数量由上游结果决定（按列表逐个处理、循环到满足条件、按类型递归、条件分支、纯计算汇总）→ 用 script（受限 JSON 指令）：step/fanout/if/gate/verify/report/loop/recurse/aggregate，只解释执行、不运行代码。
- 判断不了 → 默认 steps。
拿到各步结果后再汇总成一份结论——不要只列计划，也不要用文字模拟并行；最后用一句话说明本次用了哪种、为什么。${task ? `\n任务：${task}` : ''}`;
  }
  // 技能 token 可以嵌在正文里：逐个展开成 read_playbook 指令，保留其它文字
  return raw.replace(/(^|\s)\/([a-z0-9][a-z0-9-]*)(?=\s|$)/gi, (full, space, name) => {
    const s = (Array.isArray(skills) ? skills : []).find((x) => String(x.name).toLowerCase() === String(name).toLowerCase());
    if (!s) return full;
    return `${space}${buildSkillSegment(s)}`;
  });
};

// ---- 附件读取（浏览器 FileReader；纯工具函数） ----
export const readBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});
// 粘贴/拖入的图片直接转 data URL（blob: URL 会随源 File 生命周期失效，导致 chip 显示破图）
export const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || ''));
  r.onerror = () => reject(r.error || new Error('读取图片失败'));
  r.readAsDataURL(file);
});

export const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(v));
};

export const relTime = (ts) => {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return t('刚刚');
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)}d`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

// 输入框下方的思考强度档位 / slash 命令（文案是中文原文，渲染时经 t() 查词典）
export const EFFORTS = [
  { v: 'default', label: 'Default', desc: '跟随模型默认' },
  { v: 'low', label: 'Low', desc: '更快，思考更少' },
  { v: 'medium', label: 'Medium', desc: '平衡' },
  { v: 'high', label: 'High', desc: '更深入' },
  { v: 'max', label: 'Max', desc: '最大思考强度（默认）' }
];
export const COMMANDS = [
  { type: 'command', id: 'compact', name: 'compact', cn: '压缩上下文', description: '把当前对话压成摘要，后续只带摘要 + 最近 6 条' },
  { type: 'command', id: 'workflow', name: 'workflow', cn: '多 agent 工作流', description: '你自己写步骤，引擎按依赖并行调度多个子代理' }
];
