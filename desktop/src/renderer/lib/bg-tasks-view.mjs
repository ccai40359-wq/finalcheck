// 0.33.5 后台任务面板的纯函数（可单测）：胶囊上显示什么
export function bgChipSummary(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  const running = list.filter((x) => x?.status === 'running').length;
  const failed = list.filter((x) => x?.status === 'failed').length;
  return { total: list.length, running, failed, done: list.length - running };
}

// 0.33.7 终端小窗口：把真实输出整理成能看的文本
//   · 去掉 ANSI 颜色 / 光标控制码
//   · 进度条那种用 \r 原地覆盖的行，只留最后一版（和真终端看到的一样）
//   · CRLF 统一成 \n
export function cleanTerminalText(raw = '') {
  const s = String(raw ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n');
  return s.split('\n').map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r').filter((p) => p.length);
    return parts.length ? parts[parts.length - 1] : '';
  }).join('\n');
}
