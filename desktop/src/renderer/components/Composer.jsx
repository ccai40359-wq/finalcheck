// 输入区：审批条 / 排队卡片 / 附件与粘贴块 / 文本框 / 权限·模型·思考强度控件 / slash 菜单 / 发送键。
// 所有状态仍在 App（这里只读 props、调回调）；组件内部仅有输入框高度等 DOM 行为，与拆分前一致。
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/ui.jsx';
import { t, getLanguage } from '../i18n/core.mjs';
import {
  IMG_EXT_RE, previewFromPath, isLongPaste, countLines, fmtTokens, modelIdsOf, modelEntriesOf, EFFORTS, COMMANDS,
  nextPasteId, baseName, readBase64, fileToDataUrl, shrinkImageDataUrl, skillDescription
} from '../lib/app-helpers.mjs';
import { IconPlus, IconPaste, IconTrash, IconEdit, IconShield, IconSend, ContextRing } from './Icons.jsx';

// 输入框里的附件 chip：图片直接显示缩略图（无 preview 时按路径读），文件名 + 移除
function AttachmentChip({ item, onRemove }) {
  const y = api();
  const [src, setSrc] = useState(item.preview || null);
  const triedRef = useRef(false);
  const retriedRef = useRef(false);
  useEffect(() => { setSrc(item.preview || null); triedRef.current = false; retriedRef.current = false; }, [item.preview, item.path]);
  useEffect(() => {
    let alive = true;
    if (src || triedRef.current || !IMG_EXT_RE.test(item.path || '')) return undefined;
    triedRef.current = true;
    (async () => {
      const url = await previewFromPath(y, item.path);
      if (alive && url) setSrc(url);
    })();
    return () => { alive = false; };
  }, [item.path, src, item.preview]);
  // 图片加载失败：先撤下破图（立刻回 ▤ 占位），再按路径用主进程重读一次 data URL
  const handleImgError = () => {
    setSrc(null);
    if (retriedRef.current || !item.path) return;
    retriedRef.current = true;
    previewFromPath(y, item.path).then((url) => { if (url) setSrc(url); }).catch(() => {});
  };
  // 图片附件只显示缩略图（不写文件名），删除按钮悬停浮出；非图片仍保留文件名 chip
  const isImage = !!src || IMG_EXT_RE.test(item.path || '') || IMG_EXT_RE.test(item.name || '');
  if (isImage) {
    return (
      <div className="group relative shrink-0">
        {src
          ? <img src={src} alt={item.name || ''} title={item.name || ''} className="h-9 w-9 rounded-lg object-cover border border-edge/60 hover:border-gold/50 transition-colors" onError={handleImgError} />
          : <span title={item.name || ''} className="h-9 w-9 rounded-lg bg-white/[0.04] border border-edge/60 flex items-center justify-center text-goldDeep">▤</span>}
        <button onClick={onRemove} title={t('移除附件')}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-black/80 border border-edge text-[9px] leading-none text-mute/80 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity">✕</button>
      </div>
    );
  }
  return (
    <div className="group inline-flex items-center gap-2 rounded-xl bg-white/[0.04] border border-edge/60 pl-1.5 pr-2 py-1 text-[11px] transition-colors duration-200 hover:border-edge">
      <span className="h-7 w-7 rounded-lg bg-white/[0.04] flex items-center justify-center text-goldDeep">▤</span>
      <span className="max-w-[170px] truncate text-ink/80">{item.name}</span>
      <button onClick={onRemove} title={t('移除附件')} className="text-mute/50 hover:text-red-400 transition-colors duration-200">✕</button>
    </div>
  );
}

export default function Composer({
  y, input, setInput, attachments, setAttachments, pastedBlocks, setPastedBlocks, editing, dragging, busy, stopping, steering, compacting,
  approval, queueItems, menu, providerMenu, permMode, ctxStats, skills, cfg, sessCfg, effortPos, activeId, onNotice,
  slashIndex, setSlashIndex,
  inputRef, modelMenuRef,
  setDragging, setMenu, setProviderMenu, setEffortPos, setSessCfg, setCfg, setPermMode,
  cancelEdit, chooseSlash,
  decideApproval, steerQueueItem, moveQueueItemToInput, removeQueueItem, sendQueueItemNow, queueHeld = false,
  send, stop, onGoSettings
}) {
  // ---- 输入框下方的模型 / 思考强度 / 技能菜单（按当前会话的配置显示） ----
  const allProviders = cfg?.providers || [];
  const providers = allProviders.filter((p) => p.enabled !== false);
  const activeProv = allProviders.find((p) => p.id === sessCfg.providerId) || providers[0] || null;
  const activeModelIds = modelIdsOf(activeProv);
  const activeModel = (sessCfg.model && activeModelIds.includes(sessCfg.model)) ? sessCfg.model : (activeModelIds[0] || '');
  const activeModelEntries = modelEntriesOf(activeProv);
  const effort = sessCfg.effort || cfg?.thinkingEffort || 'max';
  const effortIndex = Math.max(0, EFFORTS.findIndex((x) => x.v === effort));
  const sliderPos = effortPos ?? effortIndex;
  const effortLabel = EFFORTS[Math.round(sliderPos)]?.label || 'Max';
  // 语言每次渲染都现读（Composer 随 App 重渲染）；不做模块级缓存，切换语言后菜单立即跟着变
  const lang = getLanguage();
  const skillItems = skills.map((s) => ({
    type: 'skill', id: s.id, name: s.name, cn: s.cn,
    description: skillDescription(s, lang),
    descriptionEn: s.descriptionEn || '',
    descriptionZh: s.description || ''
  }));
  const slashMatch = input.match(/(^|\s)\/([a-z0-9-]*)$/i);
  const slashQ = (slashMatch?.[2] || '').toLowerCase();
  const slashItems = [...COMMANDS, ...skillItems]
    .filter((i) => !slashQ
      || String(i.name).toLowerCase().includes(slashQ)
      || String(i.cn).toLowerCase().includes(slashQ)
      || String(i.description).toLowerCase().includes(slashQ)
      || String(i.descriptionEn || '').toLowerCase().includes(slashQ)
      || String(i.descriptionZh || '').toLowerCase().includes(slashQ))
    .slice(0, 50);
  const slashOpen = !!slashMatch;

  // ---- 权限 / 模型 / 思考强度（按会话保存，不再改全局默认） ----
  const changeMode = async (m) => {
    setPermMode(m);
    setMenu(null);
    try { const c = await y.getConfig(); const nc = { ...c, permissionMode: m }; await y.setConfig(nc); setCfg(nc); } catch { /* 忽略 */ }
  };
  // 运行中改模型/供应商：立刻落盘（主进程每次请求/每步开始重读），并给一条轻提示。
  // 正在流式输出的那一条不中断，所以忙碌时文案要说清「下一条/后续步骤生效」。
  const notifySwitch = (model) => {
    if (!activeId || typeof onNotice !== 'function') return; // 草稿态还没有会话，切换只记内存
    const label = model || t('未配置模型');
    onNotice(busy
      ? t('已切换：后续步骤与下一条消息使用 {model}；本条正在输出的内容不中断', { model: label })
      : t('已切换：后续消息与步骤使用 {model}', { model: label }));
  };
  const persistSessionCfg = async (patch, { close = true, notify = true } = {}) => {
    const next = { ...sessCfg, ...patch };
    setSessCfg(next);
    if (close) setMenu(null);
    // 忙碌时也允许切换：set-model 立即写盘，运行中的回合在「下一次模型请求/工作流下一步」读到新值
    if (activeId && y?.sessions?.setModel) {
      try { await y.sessions.setModel(activeId, next); } catch { /* 保存失败仅影响下次打开（主进程仍用内存快照） */ }
    }
    const switchedModel = 'model' in patch || 'providerId' in patch;
    if (notify && switchedModel) notifySwitch(next.model);
  };
  const chooseModel = (providerId, model) => persistSessionCfg({ providerId, model });
  const chooseEffort = (thinkingEffort, opts) => persistSessionCfg({ effort: thinkingEffort }, { ...(opts || {}), notify: false });
  const pickProvider = (p) => {
    setProviderMenu(false);
    persistSessionCfg({ providerId: p.id, model: modelIdsOf(p)[0] || '' });
  };

  // ---- 附件：粘贴截图 / 拖拽文件 / 加号选择 ----
  const addFiles = async (files) => {
    if (!y?.saveAttachment) return;
    for (const f of Array.from(files || [])) {
      if (f.size > 20 * 1024 * 1024) continue;
      try {
        const dataBase64 = await readBase64(f);
        const saved = await y.saveAttachment({ name: f.name || 'pasted.png', dataBase64 });
        // 主进程失败时返回 { error }（IPC 安全层）：不能把它当附件加进去，否则发送时会带上 "- undefined"
        if (!saved || saved.error || !saved.path) throw new Error(saved?.error || t('附件保存失败'));
        let preview = null;
        if (String(f.type || '').startsWith('image/')) {
          // 主路径：从落盘文件回读（切会话/重开仍可显示）；大图在 previewFromPath 内缩到 ≤480px
          preview = await previewFromPath(y, saved.path);
          // 极端情况（落盘文件暂不可读）：退回内存 File 转 dataURL，仍缩到预览尺寸
          if (!preview) {
            try { preview = await shrinkImageDataUrl(await fileToDataUrl(f)); } catch { /* 保持 ▤ 占位 */ }
          }
        }
        setAttachments((prev) => [...prev, { ...saved, preview }]);
      } catch { /* 单个附件失败不阻断 */ }
    }
  };
  const pickAttachFiles = async () => {
    if (!y?.pickFiles) return;
    try {
      const paths = await y.pickFiles();
      setAttachments((prev) => [...prev, ...(paths || []).map((p) => ({ path: p, name: baseName(p), size: 0, preview: null }))]);
    } catch { /* 用户取消 */ }
  };
  const removeAttachment = (idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx));

  // ---- 长粘贴文本块：≥8 行或 ≥1000 字符收成卡片（内容不进输入框，发送时并入正文） ----
  const addPastedBlock = (text) => {
    const body = String(text || '').replace(/\r\n?/g, '\n');
    if (!isLongPaste(body)) return false;
    setPastedBlocks((prev) => [...prev, { id: nextPasteId(), text: body, lines: countLines(body), expanded: false }]);
    return true;
  };
  const togglePasted = (id) => setPastedBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, expanded: !b.expanded } : b)));
  const removePasted = (id) => setPastedBlocks((prev) => prev.filter((b) => b.id !== id));

  const onComposerKeyDown = (e) => {
    if (slashOpen && slashItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((v) => (v + 1) % slashItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((v) => (v - 1 + slashItems.length) % slashItems.length); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); chooseSlash(slashItems[Math.min(slashIndex, slashItems.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  return (
    /* 输入区（与消息区同宽） */
    <div className="shrink-0 px-5 pb-3 pt-1">
      <div className="w-full max-w-[96%] mx-auto">
        {/* 权限确认条：agent 请求执行敏感操作（run_command）时弹出，三选一回传主进程 */}
        {approval && (
          <div data-testid="approval-bar"
            className="mb-2.5 rounded-xl border border-gold/50 bg-gold/10 px-4 py-3 animate-[fadeIn_.2s_ease]">
            <div className="flex items-center gap-2 text-xs font-medium text-goldSoft">
              <IconShield />
              <span>{t(approval.tool === 'edit_file' ? 'Agent 请求修改文件，需要你的授权' : approval.tool === 'write_file' ? 'Agent 请求写入文件，需要你的授权' : 'Agent 请求执行命令，需要你的授权')}</span>
              <span className="ml-auto text-[11px] font-normal text-mute/70">{t('120 秒内未处理将自动拒绝')}</span>
            </div>
            <div data-testid="approval-summary"
              className="glass-card mt-2 rounded-xl px-3 py-2 font-mono text-xs text-ink/90 break-all whitespace-pre-wrap max-h-28 overflow-y-auto">
              {approval.summary || t('(空命令)')}
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <button data-testid="approval-allow-once" onClick={() => decideApproval('allowed-once')}
                className="btn-primary px-3 py-1.5 text-xs">{t('允许一次')}</button>
              <button data-testid="approval-allow-session" onClick={() => decideApproval('always-session')}
                className="btn-ghost px-3 py-1.5 text-xs !text-goldSoft !border-gold/40 hover:!bg-gold/10">{t('本会话总是允许')}</button>
              <button data-testid="approval-reject" onClick={() => decideApproval('rejected')}
                className="ml-auto rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 transition-all duration-200">{t('拒绝')}</button>
            </div>
          </div>
        )}
        {/* 排队卡片（当前回合进行中还能继续发消息）：FIFO，回合结束后自动发队首 */}
        {queueItems.length > 0 && (
          <div className="mb-2.5 space-y-1.5" data-testid="queue-list">
            <div className="flex items-center gap-2 px-1">
              <span className="badge bg-gold/15 text-goldSoft border border-gold/35">{t('排队 {n}', { n: queueItems.length })}</span>
              <span className="text-[10px] text-mute/55" data-testid="queue-hint">
                {queueHeld
                  ? t('有 {n} 条排队消息，点发送', { n: queueItems.length })
                  : t('当前回合结束后自动发送（Steer 会中断当前回合并重发）')}
              </span>
            </div>
            {queueItems.map((item, idx) => (
              <div key={item.id} data-testid="queue-item"
                className="glass-card flex items-center gap-2 rounded-xl border border-gold/20 px-3 py-2">
                <span className="shrink-0 font-mono text-[10px] text-goldSoft/60">{idx + 1}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink/85"
                  title={[item.text, ...(item.pasted || [])].filter(Boolean).join('\n\n') || 'Pasted text'}>
                  {item.text || (item.pasted?.length
                    ? t('Pasted text · {n} 行', { n: item.pasted.reduce((n, t) => n + countLines(t), 0) })
                    : t('(空)'))}
                </span>
                {item.previews?.length ? <span className="shrink-0 text-[10px] text-mute/50">{t('附件 {n}', { n: item.previews.length })}</span> : null}
                <button type="button" data-testid="queue-send" onClick={() => sendQueueItemNow(item.id)} disabled={busy || stopping || steering}
                  title={(busy || stopping) ? t('当前回合仍在运行，无法立即发送排队消息（可等它结束或点停止）') : t('立即发送这条（停止/报错收尾后队列不再自动发送）')}
                  className="shrink-0 rounded-md border border-jade/40 px-2 py-0.5 text-[10px] text-jade hover:bg-jade/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">{t('发送')}</button>
                <button type="button" data-testid="queue-steer" onClick={() => steerQueueItem(item)} disabled={steering}
                  title={steering ? t('正在中断当前回合…') : (busy && !stopping ? t('中断当前回合，并用这条消息重开一个新回合') : t('当前回合未在运行，无法 Steer'))}
                  className="shrink-0 rounded-md border border-gold/40 px-2 py-0.5 text-[10px] text-goldSoft hover:bg-gold/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">Steer</button>
                <button type="button" data-testid="queue-edit" onClick={() => moveQueueItemToInput(item.id)}
                  title={t('取回编辑（从队列移除，内容放回输入框）')}
                  className="shrink-0 rounded-md p-1 text-mute/55 hover:text-goldSoft hover:bg-white/5 transition-colors">
                  <IconEdit />
                </button>
                <button type="button" data-testid="queue-remove" onClick={() => removeQueueItem(item.id)}
                  title={t('移除此条')}
                  className="shrink-0 rounded-md p-1 text-mute/55 hover:text-red-300 hover:bg-red-500/10 transition-colors">
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={`glass-composer relative z-30 rounded-[20px] ${dragging ? 'fc-drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={async (e) => { e.preventDefault(); setDragging(false); await addFiles(e.dataTransfer?.files); }}
        >
          {editing && (
            <div className="flex items-center gap-2 px-3 pt-2.5 text-[11px]">
              <span className="badge bg-gold/15 text-goldSoft border border-gold/35">{t('编辑中')}</span>
              <span className="text-mute/60">{t('发送后将从这条消息重开，后面的对话会被丢弃')}</span>
              <button onClick={cancelEdit} className="ml-auto text-mute/60 hover:text-ink transition-colors">{t('取消')}</button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {attachments.map((a, i) => (
                <AttachmentChip key={a.path} item={a} onRemove={() => removeAttachment(i)} />
              ))}
            </div>
          )}
          {/* 长粘贴：收成「Pasted text」卡片（默认折叠，点击展开纯文本全文） */}
          {pastedBlocks.length > 0 && (
            <div className="space-y-1.5 px-3 pt-2.5">
              {pastedBlocks.map((b) => (
                <div key={b.id} data-testid="pasted-card"
                  className="overflow-hidden rounded-xl border border-edge bg-white/[0.035]">
                  <div role="button" tabIndex={0}
                    onClick={() => togglePasted(b.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePasted(b.id); } }}
                    title={b.expanded ? t('收起粘贴文本') : t('展开粘贴文本')}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer hover:bg-white/5 transition-colors">
                    <IconPaste />
                    <span className="shrink-0 text-[11px] text-goldSoft">Pasted text</span>
                    <span className="shrink-0 text-[10px] text-mute/55">{t('{n} 行', { n: b.lines })}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-mute/70">{b.text.split('\n')[0]}</span>
                    <button type="button" title={t('删除粘贴文本')}
                      onClick={(e) => { e.stopPropagation(); removePasted(b.id); }}
                      className="shrink-0 rounded-md p-1 text-mute/45 hover:text-red-300 hover:bg-red-500/10 transition-colors">
                      <IconTrash />
                    </button>
                    <span className={`shrink-0 text-[10px] text-mute/40 transition-transform duration-200 ${b.expanded ? 'rotate-180' : ''}`}>▾</span>
                  </div>
                  {b.expanded && (
                    <pre data-testid="pasted-text-full"
                      className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words border-t border-edge bg-[#0a0a0c] px-3 py-2 font-mono text-[12px] leading-6 text-ink/80">
                      {b.text}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="px-3.5 pt-3">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files || []);
                if (files.length) { e.preventDefault(); addFiles(files); return; }
                // 长文本不直接塞进输入框：收成「Pasted text」卡片（短文本保持原样粘贴）
                const pasted = e.clipboardData?.getData('text/plain') || '';
                if (isLongPaste(pasted)) { e.preventDefault(); addPastedBlock(pasted); }
              }}
              onKeyDown={onComposerKeyDown}
              placeholder={y ? (busy ? t('输入消息排队，回合结束后自动发送（Enter 入队）…') : t('输入消息，/ 唤起技能，Enter 发送…')) : t('IPC 不可用（浏览器直开）')}
              disabled={!y}
              className="w-full bg-transparent outline-none resize-none text-sm leading-6 placeholder:text-mute/45 disabled:opacity-50"
            />
          </div>

          {/* 底部工具条：只有图标与文字，没有边框（对齐 ZCode） */}
          <div className="flex items-center gap-0.5 px-2 pb-2">
            <button onClick={pickAttachFiles} title={t('添加文件（也可直接粘贴截图 / 拖拽文件）')}
              className="shrink-0 h-7 w-7 rounded-lg text-mute/70 hover:text-goldSoft hover:bg-white/[0.06] transition-colors flex items-center justify-center">
              <IconPlus />
            </button>
            <div className="relative">
              <button onClick={() => setMenu(menu === 'perm' ? null : 'perm')}
                className={`inline-flex items-center gap-1.5 text-[11px] rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.06] ${permMode === 'full' ? 'text-goldSoft' : 'text-mute hover:text-ink'}`}>
                <IconShield />
                {permMode === 'full' ? t('完全权限') : t('标准审批')}
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {menu === 'perm' && (
                <div className="glass-pop absolute bottom-full mb-1.5 left-0 w-60 rounded-2xl p-1.5 z-40">
                  <button onClick={() => changeMode('ask')} className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors text-xs ${permMode === 'ask' ? 'bg-gold/10 text-goldSoft' : 'hover:bg-white/5'}`}>
                    {t('标准审批')}<span className="block text-[10px] text-mute mt-0.5">{t('执行命令前每次确认（默认）')}</span>
                  </button>
                  <button onClick={() => changeMode('full')} className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors text-xs ${permMode === 'full' ? 'bg-gold/10 text-goldSoft' : 'hover:bg-white/5'}`}>
                    {t('完全权限')}<span className="block text-[10px] text-mute mt-0.5">{t('不再询问；灾难命令仍会被拦截')}</span>
                  </button>
                </div>
              )}
            </div>

            <span className="text-[10px] text-mute/35 select-none pl-1">{compacting ? t('压缩中…') : t('输入 / 选技能')}</span>

            <div className="ml-auto flex items-center gap-1.5">
              <div className="relative">
                <button
                  onMouseEnter={() => setMenu('context')}
                  onMouseLeave={() => setMenu((m) => (m === 'context' ? null : m))}
                  onClick={() => setMenu(menu === 'context' ? null : 'context')}
                  title={t('上下文使用情况')}
                  className="p-1 rounded-full hover:bg-white/5 transition-colors">
                  <ContextRing percent={ctxStats?.measured?.prompt ? Math.min(100, (ctxStats.measured.prompt / ctxStats.window) * 100) : (ctxStats?.percent || 0)} />
                </button>
                {menu === 'context' && (
                  <div onMouseEnter={() => setMenu('context')} onMouseLeave={() => setMenu((m) => (m === 'context' ? null : m))}
                    className="glass-pop absolute bottom-full mb-2 right-0 w-[352px] rounded-2xl p-3 z-50">
                    {(() => {
                      // 实测 = 服务端 usage.prompt_tokens（本轮最后一次请求，含工具输出）；估算 = 下一轮会发出去的内容
                      const measured = ctxStats?.measured || null;
                      const pct = measured?.prompt ? Math.min(100, (measured.prompt / ctxStats.window) * 100) : (ctxStats?.percent || 0);
                      const shownTokens = measured?.prompt || ctxStats?.used || 0;
                      return (
                        <>
                          <div className="flex items-baseline justify-between">
                            <span className="text-xs text-ink/85">Context windows</span>
                            <span className="text-[11px] font-mono text-mute/60">
                              {ctxStats ? `${fmtTokens(shownTokens)}/${fmtTokens(ctxStats.window)}` : '—'}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-mute/60">
                            {measured?.prompt ? (
                              <>
                                <span>{t('实测 {pct}%', { pct: pct.toFixed(1) })}</span>
                                <span className="text-mute/25">·</span>
                                <span className="text-mute/45">{t('下一轮估算 {tokens}（{pct}%）', { tokens: fmtTokens(ctxStats.used), pct: ctxStats.percent.toFixed(1) })}</span>
                              </>
                            ) : (
                              <span>{busy ? t('估算 {pct}%（下一轮请求） · 本轮进行中，暂无实测', { pct: pct.toFixed(1) }) : t('估算 {pct}%（下一轮请求）', { pct: pct.toFixed(1) })}</span>
                            )}
                          </div>
                          <div className="mt-1.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div className="h-full rounded-full bg-goldSoft transition-all duration-300" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="mt-1 text-[10px] leading-relaxed text-mute/40">
                            {measured?.prompt ? t('实测＝本轮最后一次请求（含工具输出）；估算只算下一轮要发的内容（不含历史工具输出）') : t('估算＝下一轮要发的内容（不含历史工具输出）')}
                          </div>
                        </>
                      );
                    })()}
                    <div className="mt-2.5 mb-1 text-[10px] text-mute/40">{t('下一轮构成（按估算）')}</div>
                    <div className="space-y-1.5">
                      {[
                        ['Messages', 'messages', 'bg-goldSoft'],
                        ['System tools', 'systemTools', 'bg-[#7aa2ff]'],
                        ['MCP tools', 'mcpTools', 'bg-[#9b8cff]'],
                        ['Meta context', 'metaContext', 'bg-[#6fd3c7]'],
                        ['Skills', 'skills', 'bg-[#c6d36f]'],
                        ['System prompt', 'systemPrompt', 'bg-[#d38f6f]']
                      ].map(([label, key, color]) => {
                        const v = ctxStats?.breakdown?.[key] || 0;
                        const pct = ctxStats?.used ? (v / ctxStats.used) * 100 : 0;
                        return (
                          <div key={key} className="flex items-center gap-2 text-[11px]">
                            <span className={`w-2 h-2 rounded-full ${color}`} />
                            <span className="text-mute/70">{label}</span>
                            <span className="ml-auto font-mono text-mute/50">{pct.toFixed(1)}%</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2.5 pt-2 border-t border-edge/70 flex items-center justify-between text-[11px]">
                      <span className="text-mute/60">Last request cache hit</span>
                      <span className="font-mono text-mute/70">{ctxStats?.cacheHit != null ? `${ctxStats.cacheHit.toFixed(1)}%` : t('—（网关未返回缓存字段）')}</span>
                    </div>
                    <div className="mt-1.5 text-[10px] text-mute/35 leading-relaxed">{t('估算口径：CJK 1 字≈1 token、4 字符≈1 token；上下文上限在模型设置里改。')}</div>
                  </div>
                )}
              </div>
              <div className="relative" ref={modelMenuRef}>
                <button onClick={() => { setMenu(menu === 'model' ? null : 'model'); setProviderMenu(false); }}
                  className="inline-flex items-center gap-1.5 max-w-[280px] text-[11px] px-1 py-1 text-mute hover:text-goldSoft transition-colors duration-200">
                  <span className="truncate">{activeModel || t('未配置模型')}</span>
                  <span className="text-mute/45">{effortLabel}</span>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {menu === 'model' && (
                  <div className="glass-pop absolute bottom-full mb-2 right-0 w-[300px] rounded-2xl z-50 pop-in">
                    {/* 供应商头：点一下切到供应商列表 */}
                    <button onClick={() => setProviderMenu(!providerMenu)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-white/5 transition-colors text-left">
                      <span className="w-5 h-5 rounded-md bg-gold/15 border border-gold/40 flex items-center justify-center text-[11px] text-goldSoft">⌬</span>
                      <span className="text-[13px] text-ink/90 truncate">{activeProv?.name || t('未配置供应商')}</span>
                      <span className="text-[9px] px-1 py-0.5 rounded border border-edge text-mute/55">API</span>
                      <svg className="ml-auto shrink-0 text-mute/50" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                    </button>

                    <div className="px-3 pt-2 pb-1 text-[10px] text-mute/50">Models</div>
                    <div className="max-h-56 overflow-y-auto px-1.5 pb-1">
                      {activeModelEntries.map((m) => (
                        <button key={m.id} onClick={() => chooseModel(activeProv.id, m.id)}
                          className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-mono transition-colors ${m.id === activeModel ? 'bg-white/[0.06] text-ink' : 'text-ink/75 hover:bg-white/5'}`}>
                          <span className="truncate">{m.id}</span>
                          {(m.vision || /vision|vl\b/i.test(m.id)) ? <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-edge text-mute/60 font-sans shrink-0">Vision</span> : null}
                          {m.id === activeModel ? <span className="ml-auto text-jade shrink-0">✓</span> : null}
                        </button>
                      ))}
                      {activeModelEntries.length === 0 && (
                        <div className="px-2.5 py-3 text-[11px] text-mute">
                          {t('该供应商还没有模型')}
                          <button onClick={() => { setMenu(null); onGoSettings(); }} className="ml-2 text-goldSoft hover:underline underline-offset-2">{t('去添加')}</button>
                        </div>
                      )}
                    </div>
                    <div className="border-t border-edge/70 px-3 py-2.5">
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-mute">Effort</span>
                        <span className="text-ink/85">{effortLabel}</span>
                        <span className="ml-auto text-[10px] text-mute/40">Ctrl+T</span>
                      </div>
                      <input type="range" min="0" max="4" step="0.01" value={sliderPos}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setEffortPos(v);
                          const lvl = EFFORTS[Math.round(v)]?.v;
                          if (lvl && lvl !== effort) chooseEffort(lvl, { close: false });
                        }}
                        onMouseUp={() => setEffortPos(null)}
                        onTouchEnd={() => setEffortPos(null)}
                        className="effort-slider w-full mt-2" />
                    </div>

                    {/* 供应商列表：浮在面板左侧，切换不用跳去模型设置 */}
                    {providerMenu && (
                      <div className="glass-pop absolute right-full top-0 mr-2 w-56 rounded-2xl p-1.5 z-[60] pop-in">
                        <div className="px-2.5 py-1.5 text-[10px] text-mute/50">{t('供应商（{n}）', { n: providers.length })}</div>
                        {providers.length === 0 && <div className="px-2.5 py-3 text-[11px] text-mute">{t('还没有供应商，请到「模型设置」添加')}</div>}
                        {providers.map((p) => (
                          <button key={p.id} onClick={() => pickProvider(p)}
                            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs transition-colors ${p.id === activeProv?.id ? 'bg-white/[0.06] text-ink' : 'text-ink/75 hover:bg-white/5'}`}>
                            <span className="truncate">{p.name}</span>
                            <span className="text-[9px] px-1 py-0.5 rounded border border-edge text-mute/50">API</span>
                            {(p.models || []).length === 0 ? <span className="text-[9px] text-amber-400/80">{t('无模型')}</span> : null}
                            {p.id === activeProv?.id ? <span className="ml-auto text-jade">✓</span> : null}
                          </button>
                        ))}
                        <button onClick={() => { setMenu(null); onGoSettings(); }}
                          className="w-full text-left px-2.5 py-2 mt-1 rounded-lg text-xs text-mute hover:text-goldSoft hover:bg-white/5 border-t border-edge/60">
                          Manage models
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* 发送键：金色方块（busy 时变成停止 + 可选「排队发送」；已点停止则变为「停止中…」且禁用重复点击） */}
            {busy || stopping ? (
              <>
                {/* 注意：这里必须转布尔。input 为空时 ('' || 0) 是数字 0，
                    React 的 {0 && <x/>} 会把「0」当成文本渲染出来（就是那个多余的 0） */}
                {!!(input.trim() || pastedBlocks.length) && (
                  <button onClick={() => send()} data-testid="queue-send"
                    title={t('排队发送（当前回合结束后自动发送）')}
                    className="ml-1.5 shrink-0 h-7 w-7 rounded-[9px] flex items-center justify-center border border-gold/45 text-goldSoft hover:bg-gold/15 transition-colors duration-200">
                    <IconSend />
                  </button>
                )}
                <button onClick={stop} disabled={stopping} title={stopping ? t('正在中断，请稍候') : t('停止本回合')}
                  className={`ml-1.5 shrink-0 h-7 rounded-[9px] flex items-center justify-center gap-1 transition-colors duration-200 ${stopping ? 'px-2 bg-gold/60 text-[#0a0a0c] cursor-not-allowed' : 'w-7 bg-gold hover:bg-goldSoft text-[#0a0a0c]'}`}>
                  {stopping ? (
                    <>
                      <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 4" /></svg>
                      <span className="text-[10px] font-medium leading-none">{t('停止中…')}</span>
                    </>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" /></svg>
                  )}
                </button>
              </>
            ) : (
              <button onClick={() => send()} disabled={!y || (!input.trim() && !pastedBlocks.length)} title={t('发送')}
                className="ml-1.5 shrink-0 h-7 w-7 rounded-[9px] flex items-center justify-center bg-gold text-[#141008] hover:bg-goldSoft disabled:opacity-60 transition-colors duration-200">
                <IconSend />
              </button>
            )}
          </div>

          {/* / 技能菜单（命令 + 40 类方法论） */}
          {slashOpen && (
            <div className="glass-pop absolute bottom-full mb-2 left-0 right-0 rounded-2xl overflow-hidden z-50 pop-in">
              <div className="max-h-80 overflow-y-auto p-1.5">
                {slashItems.length === 0 ? (
                  <div className="px-3 py-4 text-[11px] text-mute">{t('没有匹配的命令或技能')}</div>
                ) : slashItems.map((item, idx) => (
                  <button key={item.type + item.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseSlash(item)}
                    onMouseEnter={() => setSlashIndex(idx)}
                    className={`w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg transition-colors ${idx === Math.min(slashIndex, slashItems.length - 1) ? 'bg-gold/12' : 'hover:bg-white/5'}`}>
                    <span className={`shrink-0 font-mono text-[12px] ${item.type === 'command' ? 'text-goldSoft' : 'text-jade'}`}>/{item.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink/70">
                      {item.type === 'skill' && lang === 'en' ? (item.description || t(item.cn)) : t(item.cn)}
                    </span>
                    <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full ${item.type === 'command' ? 'text-goldDeep/80 bg-gold/10' : 'text-mute/50 bg-white/[0.05]'}`}>
                      {item.type === 'command' ? t('命令') : t('技能')}
                    </span>
                  </button>
                ))}
                <div className="px-3 py-1.5 text-[10px] text-mute/35 border-t border-white/[0.06] mt-1">
                  {t('↑↓ 选择 · Enter 确认 · Esc 关闭')}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
