// 预览/截图放行表：artifact:bytes 只给这里登记过的 PDF（含 Office 转换缓存——它在 %APPDATA%\FinalCheck 下，
// 普通产物闸会拒绝，所以用显式放行而不是放宽产物闸）。IPC 与 AI 截图工具共用。
import path from 'node:path';

const allowed = new Set();
export function allowPreviewFile(abs) {
  const p = path.resolve(abs);
  allowed.add(p);
  if (allowed.size > 200) allowed.delete(allowed.values().next().value);
  return p;
}
export function isPreviewAllowed(abs) {
  return allowed.has(path.resolve(String(abs || '')));
}
