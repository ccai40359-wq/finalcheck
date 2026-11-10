// 更新状态机（纯函数，不依赖 React/DOM）：事件 → 状态；状态 → 文案 / 按钮可见性。
// 主进程复用人话化错误文案；渲染层用它渲染「关于 / 更新」小节。
// 不变量：任何展示文案里都不出现 `undefined`、裸 JSON / 堆栈；版本号缺失时给「未知版本」或省略。

const PHASES = ['idle', 'checking', 'not-available', 'available', 'downloading', 'downloaded', 'error'];
const DEFAULT_ERROR_TEXT = '检查更新失败，请稍后再试。';

export const initialUpdateState = Object.freeze({
  phase: 'idle',
  latestVersion: '',
  percent: null,
  message: '',
  notes: ''
});

const asText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// 版本号只保留可读部分：去掉前缀 v，超长/带 JSON 片段的值一律丢弃，避免 undefined 进界面
export const cleanVersion = (v) => {
  const t = asText(v).replace(/^v/i, '');
  if (!t || t === 'undefined' || t === 'null' || /[{}"[\]]/.test(t)) return '';
  return t.slice(0, 40);
};

const percentOf = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
};

// 原始错误 → 一句中文。固定文案，保证不把堆栈 / JSON 透给用户。
export function humanizeUpdateError(raw) {
  const text = String(raw ?? '').replace(/\r/g, '');
  if (!text.trim()) return DEFAULT_ERROR_TEXT;
  if (/signature|signing|code ?sign|certificate|publisherName|not signed|WinVerifyTrust|签名/i.test(text)) {
    return '更新包签名校验未通过，已停止更新，请联系开发者。';
  }
  if (/net::|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|getaddrinfo|network|internet|socket hang up|无法连接网络|网络/i.test(text)) {
    return '无法连接更新服务器，请检查网络后重试。';
  }
  if (/404|not found|no published versions|no releases|latest\.yml|C?annot find/i.test(text)) {
    return 'GitHub 上还没有可用的正式版本（暂无 Release），请稍后再试。';
  }
  return DEFAULT_ERROR_TEXT;
}

// 主进程推送的 update-event → 渲染层状态（未知事件保持原状态）
export function reduceUpdateEvent(state, ev) {
  const base = state && typeof state === 'object' ? state : initialUpdateState;
  const type = ev && typeof ev === 'object' ? String(ev.type || '') : '';
  switch (type) {
    case 'checking':
      return { ...base, phase: 'checking', percent: null, message: '' };
    case 'available':
      return {
        ...base,
        phase: 'available',
        latestVersion: cleanVersion(ev.version),
        notes: asText(ev.notes).slice(0, 500),
        percent: null,
        message: ''
      };
    case 'not-available':
      return { ...base, phase: 'not-available', latestVersion: cleanVersion(ev.version), percent: null, message: '' };
    case 'progress':
      return { ...base, phase: 'downloading', percent: percentOf(ev.percent), message: '' };
    case 'downloaded':
      return {
        ...base,
        phase: 'downloaded',
        latestVersion: cleanVersion(ev.version) || cleanVersion(base.latestVersion),
        percent: 100,
        message: ''
      };
    case 'error':
      return { ...base, phase: 'error', percent: null, message: humanizeUpdateError(ev.message ?? ev.error) };
    default:
      return base;
  }
}

// 状态 → 用户可见文案 + 按钮可见性（测试直接断言这里，不渲染 React）
export function describeUpdate(state, currentVersion) {
  const base = state && typeof state === 'object' ? state : initialUpdateState;
  const phase = PHASES.includes(base.phase) ? base.phase : 'idle';
  const current = cleanVersion(currentVersion) || cleanVersion(base.currentVersion);
  const latest = cleanVersion(base.latestVersion);
  const pct = base.percent == null ? 0 : percentOf(base.percent);
  const currentText = current ? `v${current}` : '未知版本';
  let statusText = '';
  let errorText = '';
  let tone = 'mute';

  if (phase === 'checking') {
    statusText = '正在检查…';
  } else if (phase === 'not-available') {
    statusText = `已是最新（${currentText}）`;
    tone = 'jade';
  } else if (phase === 'available') {
    statusText = latest ? `发现 v${latest}，是否下载？` : '发现新版本，是否下载？';
    tone = 'gold';
  } else if (phase === 'downloading') {
    statusText = `下载中 ${pct}%`;
    tone = 'gold';
  } else if (phase === 'downloaded') {
    statusText = latest ? `已下载 v${latest}，重启安装` : '已下载，重启安装';
    tone = 'jade';
  } else if (phase === 'error') {
    const msg = asText(base.message);
    // 防御：即便调用方塞了原始错误，也不把裸 JSON / undefined 显示给用户
    errorText = msg && !/\{\s*"|"\s*:|undefined/.test(msg) ? msg : DEFAULT_ERROR_TEXT;
    statusText = '检查更新失败';
    tone = 'red';
  } else {
    statusText = '尚未检查更新';
  }

  return {
    phase,
    tone,
    statusText,
    errorText,
    currentText,
    latestText: latest ? `v${latest}` : '',
    progress: phase === 'downloading' ? pct : null,
    showCheck: phase !== 'checking' && phase !== 'downloading' && phase !== 'downloaded',
    showDownload: phase === 'available',
    showInstall: phase === 'downloaded',
    checkDisabled: phase === 'checking' || phase === 'downloading',
    hasUpdate: phase === 'available' || phase === 'downloading' || phase === 'downloaded',
    checkLabel: '检查更新',
    downloadLabel: '下载更新',
    installLabel: '重启并安装'
  };
}
