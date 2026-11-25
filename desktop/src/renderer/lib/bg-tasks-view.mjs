// 0.33.5 后台任务面板的纯函数（可单测）：胶囊上显示什么
export function bgChipSummary(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  const running = list.filter((x) => x?.status === 'running').length;
  const failed = list.filter((x) => x?.status === 'failed').length;
  return { total: list.length, running, failed, done: list.length - running };
}
