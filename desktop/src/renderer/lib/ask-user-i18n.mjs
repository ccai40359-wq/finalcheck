// ask_user 卡片的中文片段英文化：模型常把系统提示里的 11 维中文名照抄成选项描述。
// - 只在 en 生效；zh 原样返回
// - 只替换已知短语，保留原有分隔符/标点结构；未知中文原样保留（宁可中英混排，也不瞎翻）
// - 按最长优先匹配，避免「代码可读性」被「可读性」规则截成「代码Readability」
import { getLanguage } from '../i18n/core.mjs';

const PHRASES = Object.freeze({
  // 11 维（审计前置问法里的中文列名）
  '安全性': 'Security',
  '数据与隐私': 'Data & privacy',
  '供应链与许可证': 'Supply chain & license',
  '可维护性': 'Maintainability',
  '代码可读性': 'Readability',
  '可测试性': 'Testability',
  '鲁棒性': 'Robustness',
  '运行稳定性': 'Runtime stability',
  '性能': 'Performance',
  '可观测性与可运维': 'Observability & ops',
  '可移交性': 'Handover',
  // 系统提示已改成「中文 (English)」；模型整段照抄时直接收敛成英文，避免出现「Security (Security)」
  '安全性 (Security)': 'Security',
  '数据与隐私 (Data & privacy)': 'Data & privacy',
  '供应链与许可证 (Supply chain & license)': 'Supply chain & license',
  '可维护性 (Maintainability)': 'Maintainability',
  '代码可读性 (Readability)': 'Readability',
  '可测试性 (Testability)': 'Testability',
  '鲁棒性 (Robustness)': 'Robustness',
  '运行稳定性 (Runtime stability)': 'Runtime stability',
  '性能 (Performance)': 'Performance',
  '可观测性与可运维 (Observability & ops)': 'Observability & ops',
  '可移交性 (Handover)': 'Handover',
  // 维度短名/截图里出现的简化写法
  '安全': 'Security',
  '可读性': 'Readability',
  '稳定性': 'Stability',
  '可观测性': 'Observability',
  '可运维': 'Ops',
  // 选项说明里的固定短语
  '全选 = 完整验收': 'Select all = full acceptance',
  '完整验收': 'full acceptance',
  '查什么': 'what it checks',
  '基础安全与依赖有没有硬伤': 'basic security and dependency issues',
  '全选': 'Select all'
});

// 长 key 先匹配：同一个位置有长短两条规则时，长规则先吃掉整词。
const ORDER = Object.keys(PHRASES).sort((a, b) => b.length - a.length);

/**
 * 把已知中文片段换成英文；lang !== 'en' 时原样返回。
 * @param {unknown} text
 * @param {'zh'|'en'|string} [lang] 默认取当前界面语言
 * @returns {string}
 */
export function translateAskText(text, lang = getLanguage()) {
  const src = text == null ? '' : String(text);
  if (lang !== 'en' || !src) return src;
  let out = src;
  for (const zh of ORDER) {
    if (out.includes(zh)) out = out.split(zh).join(PHRASES[zh]);
  }
  return out;
}
