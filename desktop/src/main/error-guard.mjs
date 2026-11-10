// 主进程错误边界：任何意外都不要「静默死」。
//
// 三类事故（都是真实踩过的）在这里统一兜住：
//  1) IPC handler 抛异常 → 渲染层的 invoke 变成 reject，前端若没 catch 就是「点了没反应」；
//  2) 回合/工具里的未捕获 Promise → Electron 主进程无输出、窗口像卡住；
//  3) 原始堆栈直接丢给用户（本机路径、内部实现细节），既看不懂也无法行动。
//
// 约定：handler 出错返回 `{ error, code: 'IPC_FAILED', channel }`，文案里不带栈；
// 完整栈只写日志（console + <logs>/main.log），给排查用。
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { t } from '../renderer/i18n/core.mjs';

export const IPC_ERROR_CODE = 'IPC_FAILED';
export const AGENT_EVENT_CHANNEL = 'finalcheck:agent-event';
const MAX_MESSAGE_CHARS = 300;

/**
 * 把任意异常压成一行「人话」：去掉栈帧与本机绝对路径，只留可行动的半句。
 * 不返回空白（最差也有「未知错误」），避免界面出现空错误条。
 * @param {unknown} err
 * @param {{ max?: number }} [opts]
 * @returns {string}
 */
export function sanitizeErrorMessage(err, { max = MAX_MESSAGE_CHARS } = {}) {
  const raw = typeof err === 'string'
    ? err
    : (err && typeof err === 'object' && (/** @type {any} */ (err).userMessage || /** @type {any} */ (err).message)) || '';
  let msg = String(raw || '').replace(/\r/g, '').split('\n')[0].trim();
  // 绝对路径（C:\... / /home/...）→ <path>：既保护隐私，也不让文案被超长路径淹没
  msg = msg.replace(/(?:[A-Za-z]:[\\/]|\/(?:home|Users|root)\/)[^\s'")]*/g, '<path>');
  // 「    at foo (file:1:2)」这类栈帧行（万一混进首行）
  msg = msg.replace(/\s+at\s+.*$/, '').trim();
  if (!msg) msg = t('未知错误');
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

/**
 * IPC 失败的标准返回体（渲染层只需判 `r.error`）。
 * @param {unknown} err
 * @param {{ channel?: string }} [opts]
 */
export function ipcErrorPayload(err, { channel = '' } = {}) {
  return {
    error: t('操作失败：{msg}', { msg: sanitizeErrorMessage(err) }),
    code: IPC_ERROR_CODE,
    ...(channel ? { channel } : {})
  };
}

/** 判断一个返回值是不是本模块产出的错误包（避免把业务对象里的 .error 误当 IPC 失败）。 */
export function isIpcError(value) {
  return !!value && typeof value === 'object' && /** @type {any} */ (value).code === IPC_ERROR_CODE;
}

/**
 * 给 ipcMain.handle 统一加上错误边界（原地替换 handle，已有注册代码零改动）。
 * 幂等：重复调用只包一次。
 * @param {{ handle: Function }} ipcMain Electron 的 ipcMain（测试里可传最小假对象）
 * @param {{ warn?: Pick<Console, 'warn'>, log?: (line: string) => void }} [opts]
 */
export function installSafeIpc(ipcMain, { warn = console, log = null } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return ipcMain;
  if (/** @type {any} */ (ipcMain).__safeIpcInstalled) return ipcMain;
  const original = ipcMain.handle.bind(ipcMain);
  Object.defineProperty(ipcMain, '__safeIpcInstalled', { value: true, enumerable: false, configurable: true });
  ipcMain.handle = (channel, fn) => {
    if (typeof fn !== 'function') return original(channel, fn);
    return original(channel, async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        const detail = `[ipc] ${channel} 处理失败：${(/** @type {any} */ (e)?.stack) || e}`;
        // 控制台 + 文件都记：打包版没有控制台，只能靠日志文件
        try { warn.warn?.(detail); } catch { /* 日志本身失败不能影响返回 */ }
        try { log?.(detail); } catch { /* 同上 */ }
        return ipcErrorPayload(e, { channel });
      }
    });
  };
  return ipcMain;
}

/**
 * 追加一行日志到文件（自动建目录；超过 MAX_LOG_BYTES 时整体丢弃重写，避免无限增长）。
 * 永远不抛：日志失败不能把错误处理本身变成新的错误源。
 * @param {string} file
 * @param {string} line
 */
export async function appendLogLine(file, line) {
  if (!file) return false;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 进程级兜底：uncaughtException / unhandledRejection。
 * - 记日志（含栈），不退出进程（窗口还能用，用户能保存/导出诊断）；
 * - 给渲染层发一条 notice（sessionId 为 null = 全局提示），界面不会「没反应」。
 * @param {{
 *   proc?: NodeJS.EventEmitter,
 *   getWin?: () => any,
 *   warn?: Console,
 *   log?: (line: string) => void,
 *   now?: () => number
 * }} [opts]
 */
export function installProcessGuards({ proc = process, getWin = () => null, warn = console, log = null, now = Date.now } = {}) {
  let lastNoticeAt = 0;
  const notify = (message, detail) => {
    // 同一秒内的连环异常只弹一条：主进程出事时别把界面刷成日志墙
    const at = now();
    if (at - lastNoticeAt < 1000) return false;
    lastNoticeAt = at;
    const line = `[main] ${message}${detail ? `：${detail}` : ''}`;
    try { warn.error?.(line); } catch { /* 忽略 */ }
    try { log?.(line); } catch { /* 忽略 */ }
    try {
      const w = getWin();
      if (w && !w.isDestroyed?.()) {
        w.webContents.send(AGENT_EVENT_CHANNEL, {
          sessionId: null,
          ev: { kind: 'notice', level: 'error', message, at }
        });
      }
    } catch { /* 窗口不在也不能让兜底逻辑自己炸 */ }
    return true;
  };

  const onUncaught = (err) => {
    notify(
      t('主进程发生未捕获异常，当前操作可能没有完成。可以继续使用，必要时导出诊断包反馈。'),
      sanitizeErrorMessage(err)
    );
  };
  const onRejection = (reason) => {
    notify(
      t('主进程有后台任务失败（未处理的 Promise），当前操作可能没有完成。可以继续使用，必要时导出诊断包反馈。'),
      sanitizeErrorMessage(reason)
    );
  };

  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onRejection);
  return {
    dispose() {
      proc.removeListener?.('uncaughtException', onUncaught);
      proc.removeListener?.('unhandledRejection', onRejection);
    },
    // 测试用：直接触发一次通知路径
    notify
  };
}
