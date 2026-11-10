// markdown 渲染：marked 解析 → DOMPurify 净化 → HTML 字符串（仅 assistant 消息使用）
// 净化兜底：即使模型输出含恶意脚本/事件属性也会被剥离，渲染处用 dangerouslySetInnerHTML
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,       // 表格 / 删除线 / 任务列表
  breaks: true     // 单个换行 → <br>（流式输出观感更接近 DeepSeek）
});

// 链接一律新窗口 + 补 rel（防 reverse tabnabbing）
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const PURIFY_CFG = {
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
  FORBID_ATTR: ['style']
};

export function renderMarkdown(text) {
  const raw = marked.parse(String(text ?? ''));
  return DOMPurify.sanitize(raw, PURIFY_CFG);
}
