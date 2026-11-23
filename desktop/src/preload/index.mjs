import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('finalcheck', {
  pickDirectory: () => ipcRenderer.invoke('finalcheck:pick-directory'),
  pickFiles: () => ipcRenderer.invoke('finalcheck:pick-files'),
  saveAttachment: (payload) => ipcRenderer.invoke('finalcheck:attachment:save', payload),
  artifactRead: (p) => ipcRenderer.invoke('finalcheck:artifact:read', p),
  artifactOpen: (p) => ipcRenderer.invoke('finalcheck:artifact:open', p),
  artifactBytes: (p) => ipcRenderer.invoke('finalcheck:artifact:bytes', p),
  copyText: (text) => ipcRenderer.invoke('finalcheck:clipboard:write', text),
  skillsList: () => ipcRenderer.invoke('finalcheck:skills:list'),
  compactSession: (id) => ipcRenderer.invoke('finalcheck:compact-session', id),
  compactCancel: (id) => ipcRenderer.invoke('finalcheck:compact-cancel', id),
  contextStats: (payload) => ipcRenderer.invoke('finalcheck:context:stats', payload),
  usageStats: (payload) => ipcRenderer.invoke('finalcheck:usage:stats', payload),
  exportDiagnostics: () => ipcRenderer.invoke('finalcheck:diagnostics:export'),
  demoPath: () => ipcRenderer.invoke('finalcheck:demo:path'),
  windowCtl: (action) => ipcRenderer.invoke('finalcheck:window-ctl', action),
  cuStop: () => ipcRenderer.invoke('finalcheck:cu-stop'),
  audit: (dir, opts) => ipcRenderer.invoke('finalcheck:audit', dir, opts),
  scanDownload: (dir) => ipcRenderer.invoke('finalcheck:scan-download', dir),
  probe: (url, opts) => ipcRenderer.invoke('finalcheck:probe', url, opts),
  stress: (url, opts) => ipcRenderer.invoke('finalcheck:stress', url, opts),
  agentChat: (messages, confirmedHosts, sessionId) => ipcRenderer.invoke('finalcheck:agent-chat', messages, confirmedHosts, sessionId),
  agentRunState: (sessionId) => ipcRenderer.invoke('finalcheck:agent-run-state', sessionId),
  agentSteer: (sessionId, text) => ipcRenderer.invoke('finalcheck:agent-steer', sessionId, text),
  cancelChat: (sessionId) => ipcRenderer.invoke('finalcheck:agent-cancel', sessionId),
  workflowControl: (sessionId, payload) => ipcRenderer.invoke('finalcheck:workflow-control', sessionId, payload),
  workflowStepContext: (sessionId, stepId) => ipcRenderer.invoke('finalcheck:workflow-step', sessionId, stepId),
  sessions: {
    list: () => ipcRenderer.invoke('finalcheck:sessions:list'),
    open: (id) => ipcRenderer.invoke('finalcheck:sessions:open', id),
    create: (title) => ipcRenderer.invoke('finalcheck:sessions:new', title),
    remove: (id) => ipcRenderer.invoke('finalcheck:sessions:delete', id),
    rename: (id, title) => ipcRenderer.invoke('finalcheck:sessions:rename', id, title),
    flags: (id, flags) => ipcRenderer.invoke('finalcheck:sessions:flags', id, flags),
    rewind: (id, keepUserTurns) => ipcRenderer.invoke('finalcheck:sessions:rewind', id, keepUserTurns),
    setModel: (id, cfg) => ipcRenderer.invoke('finalcheck:sessions:set-model', id, cfg),
    move: (id, targetProjectId) => ipcRenderer.invoke('finalcheck:sessions:move', id, targetProjectId),
    // 排队消息存档：重启后恢复为「待发送」（不静默丢失）
    queueGet: (id) => ipcRenderer.invoke('finalcheck:sessions:queue-get', id),
    queueSave: (id, items) => ipcRenderer.invoke('finalcheck:sessions:queue-save', id, items)
  },
  projects: {
    list: () => ipcRenderer.invoke('finalcheck:projects:list'),
    current: () => ipcRenderer.invoke('finalcheck:projects:current'),
    add: (dir) => ipcRenderer.invoke('finalcheck:projects:add', dir),
    remove: (id) => ipcRenderer.invoke('finalcheck:projects:remove', id),
    select: (id) => ipcRenderer.invoke('finalcheck:projects:select', id),
    sessions: (projectId) => ipcRenderer.invoke('finalcheck:projects:sessions', projectId)
  },
  onAgentToken: (cb) => { const h = (_e, t) => cb(t); ipcRenderer.on('finalcheck:agent-token', h); return () => ipcRenderer.removeListener('finalcheck:agent-token', h); },
  onAgentEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('finalcheck:agent-event', h); return () => ipcRenderer.removeListener('finalcheck:agent-event', h); },
  onSessionTitle: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('finalcheck:session-title', h); return () => ipcRenderer.removeListener('finalcheck:session-title', h); },
  // 权限审批：主进程 fail-closed 闭集（allowed-once / always-session / rejected）
  onApprovalRequest: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('finalcheck:approval-request', h); return () => ipcRenderer.removeListener('finalcheck:approval-request', h); },
  approvalDecide: (callId, decision) => ipcRenderer.invoke('finalcheck:approval-decide', callId, decision),
  // 回合中途提问：主进程推送卡片；回答走 invoke，回填后本回合继续
  onAskUser: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('finalcheck:ask-user', h); return () => ipcRenderer.removeListener('finalcheck:ask-user', h); },
  askUserAnswer: (payload) => ipcRenderer.invoke('finalcheck:ask-user-answer', payload),
  confirmHost: (host) => ipcRenderer.invoke('finalcheck:confirm-host', host),
  confirmDir: (dir) => ipcRenderer.invoke('finalcheck:confirm-dir', dir),
  getConfig: () => ipcRenderer.invoke('finalcheck:get-config'),
  setConfig: (cfg) => ipcRenderer.invoke('finalcheck:set-config', cfg),
  // 0.31.0 浏览器会话（无痕 / 持久）：清空持久数据 + 读当前策略 + 首次使用提示事件
  browserClearData: () => ipcRenderer.invoke('finalcheck:browser-clear-data'),
  browserSessionInfo: () => ipcRenderer.invoke('finalcheck:browser-session-info'),
  onBrowserFirstUse: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('finalcheck:browser-first-use', h); return () => ipcRenderer.removeListener('finalcheck:browser-first-use', h); },
  // 0.32.0 右栏内嵌浏览器：rect 上报（WebContentsView 不跟随窗口缩放）+ 显隐 + 多标签 + 用户自己输网址
  railRect: (rect) => ipcRenderer.invoke('finalcheck:rail-rect', rect),
  railVisible: (visible) => ipcRenderer.invoke('finalcheck:rail-visible', visible === true),
  browserTabs: () => ipcRenderer.invoke('finalcheck:browser-tabs'),
  browserTabOpen: (url) => ipcRenderer.invoke('finalcheck:browser-tab-open', url),
  browserTabSwitch: (id) => ipcRenderer.invoke('finalcheck:browser-tab-switch', id),
  browserTabClose: (id) => ipcRenderer.invoke('finalcheck:browser-tab-close', id),
  browserGoto: (url) => ipcRenderer.invoke('finalcheck:browser-goto', url),
  // AI 或用户打开网页时主进程推一次 → 右栏自动跳到浏览器 tab
  onBrowserRailOpen: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('finalcheck:browser-rail-open', h); return () => ipcRenderer.removeListener('finalcheck:browser-rail-open', h); },
  testProvider: (p) => ipcRenderer.invoke('finalcheck:test-provider', p),
  // 自动更新（仅安装版生效；开发模式主进程返回友好错误）
  getVersion: () => ipcRenderer.invoke('finalcheck:update:version'),
  // 更新详情：读随包 CHANGELOG.md，返回 { version, entries, raw }
  changelogGet: () => ipcRenderer.invoke('finalcheck:update:changelog'),
  updateCheck: () => ipcRenderer.invoke('finalcheck:update:check'),
  updateDownload: () => ipcRenderer.invoke('finalcheck:update:download'),
  updateInstall: () => ipcRenderer.invoke('finalcheck:update:install'),
  onUpdateEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('finalcheck:update-event', h); return () => ipcRenderer.removeListener('finalcheck:update-event', h); }
});
