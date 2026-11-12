// ask_user 卡片的中文片段英文化：模型常把系统提示里的 11 维/档位中文名照抄成选项描述。
// - 只在 en 生效；zh 原样返回
// - 只替换已知短语，保留原有分隔符结构；未知中文原样保留（宁可中英混排，也不瞎翻）
// - 按最长优先匹配，避免「代码可读性」被「可读性」规则截成「代码Readability」
// - en 下顺带把中文标点换成英文标点，避免「英文卡片里还挂着：、，」这类残留
import { getLanguage } from '../i18n/core.mjs';

export const CJK_TEXT = /[\u3400-\u9fff]/;
export const EN_QUESTION_FALLBACK = 'Choose from the options below.';

const PHRASES = Object.freeze({
  // 审计前置问法的整句（模型照抄系统提示时的高频写法）
  '这次体检要覆盖哪些维度': 'Which dimensions should this audit cover',
  '本次体检要覆盖哪些维度': 'Which dimensions should this audit cover',
  '这次体检要覆盖哪些维度？': 'Which dimensions should this audit cover?',
  '请选择要覆盖的维度': 'Select the dimensions to cover',
  '要覆盖哪些维度': 'which dimensions to cover',
  '请选择本次体检的档位': 'Select the tier for this audit',
  '这次体检用哪个档位': 'Which tier should this audit use',
  '选哪个档位': 'which tier',
  '选择全部 11 维': 'Select all 11 dimensions',
  '选择全部11维': 'Select all 11 dimensions',
  '列出 11 维': 'list the 11 dimensions',
  '11 维': '11 dimensions',
  '再加交接 H1、可维护 Q3、动态探测': 'plus handover H1, maintainability Q3, dynamic probing',
  '再加许可证 C1、运维 O1、对抗性复核': 'plus license C1, ops O1, adversarial review',
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
  // 档位选项
  '个人发布': 'personal release',
  '真实用户': 'real users',
  '公司交付': 'company delivery',
  '底线': 'baseline',
  // 选项说明里的固定短语
  '全选 = 完整验收': 'Select all = full acceptance',
  '完整验收': 'full acceptance',
  '查什么': 'what it checks',
  '查基础安全与依赖有没有硬伤': 'checks basic security and dependency issues',
  '基础安全与依赖有没有硬伤': 'basic security and dependency issues',
  '全选': 'Select all'
});

// 长 key 先匹配：同一个位置有长短两条规则时，长规则先吃掉整词。
const ORDER = Object.keys(PHRASES).sort((a, b) => b.length - a.length);

function normalizePunctuation(text) {
  return text
    .replace(/：/g, ': ')
    .replace(/，/g, ', ')
    .replace(/；/g, '; ')
    .replace(/。/g, '.')
    .replace(/？/g, '?')
    .replace(/！/g, '!')
    .replace(/（/g, ' (')
    .replace(/）/g, ')')
    .replace(/、/g, ', ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;])/g, '$1')
    .trim();
}

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
  return normalizePunctuation(out);
}

/** 翻译后仍含中文的文本：英文界面里用它决定是否退回英文兜底/隐藏描述 */
export function containsCjk(text) {
  return CJK_TEXT.test(text == null ? '' : String(text));
}

/**
 * 英文界面的显示兜底：翻译后仍是中文就不原样露出（问题用 fallback，描述默认隐藏）。
 * 中文界面原样返回；英文但已无中文时返回译文。
 */
export function displayAskText(text, lang, fallback = '') {
  const out = translateAskText(text, lang);
  if (lang === 'en' && containsCjk(out)) return fallback;
  return out;
}
