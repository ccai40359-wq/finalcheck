// 内置浏览器的会话加固（0.32.7）。
//
// 为什么：Electron 的默认行为是「没有设置权限处理函数 → 自动批准所有权限请求」
// （官方安全清单第 5 条）。FinalCheck 的内置浏览器会打开 AI 选的任意网页，
// 不加这一层，任何网页都能静默拿到摄像头、麦克风、定位、通知、MIDI、USB/HID/串口……
//
// 做法：只放行「看网页必需、又不碰隐私/设备」的极少数权限，其余一律拒绝。
// 本模块不 import electron：传入 session 对象即可，纯 Node 单测用假对象直测。

/** 放行名单：全屏视频、网页写剪贴板（写入经过 Chromium 净化，读剪贴板 clipboard-read 不放行）。 */
export const ALLOWED_PERMISSIONS = Object.freeze(['fullscreen', 'clipboard-sanitized-write']);

export function permissionAllowed(permission) {
  return ALLOWED_PERMISSIONS.includes(String(permission || ''));
}

const hardened = new WeakSet();

/**
 * 给一个 Electron session 装上「默认拒绝」的权限处理（幂等：同一个 session 只装一次）。
 * @param {import('electron').Session} ses
 * @param {{ onDenied?: (permission: string, url: string) => void }} [opts]
 */
export function hardenSession(ses, { onDenied = null } = {}) {
  if (!ses || typeof ses !== 'object' || hardened.has(ses)) return ses;
  hardened.add(ses);
  ses.setPermissionRequestHandler?.((_contents, permission, callback, details) => {
    const ok = permissionAllowed(permission);
    if (!ok && typeof onDenied === 'function') {
      try { onDenied(String(permission), String(details?.requestingUrl || '')); } catch { /* 记录失败不影响拒绝 */ }
    }
    callback(ok);
  });
  // 同步查询（navigator.permissions.query / Notification.permission）同样按名单回答，
  // 否则页面会看到「granted」再去请求，行为不一致。
  ses.setPermissionCheckHandler?.((_contents, permission) => permissionAllowed(permission));
  // USB / HID / 串口等设备访问：一律不给。
  ses.setDevicePermissionHandler?.(() => false);
  return ses;
}

export function isHardened(ses) {
  return Boolean(ses) && hardened.has(ses);
}
