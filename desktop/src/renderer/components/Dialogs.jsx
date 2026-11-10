// 弹层：会话右键菜单（含 Move to group）/ 重命名会话 / 自定义黑金确认框。
// 状态与 setter 全部留在 App；这里按拆分前的顺序与条件渲染，只把动作转成 props 回调。
import React from 'react';
import { t } from '../i18n/core.mjs';
import { fmtTokens } from '../lib/app-helpers.mjs';

export default function Dialogs({
  y, rowMenu, moveOpen, renameBox, confirmBox, projects, activeModel, ctxStats, rowMenuRef,
  onCloseRowMenu, onDismissRowMenu, onToggleMove, onMoveSession, onPatchFlags, onStartRename,
  onRemoveSession, onCopyText, onOpenArtifact, onGoSettings, onNotice,
  onRenameChange, onSaveRename, onCloseRename
}) {
  return (
    <>
      {/* 会话右键菜单（ZCode 式） */}
      {rowMenu && (
        <div className="fixed inset-0 z-[60]" onClick={onDismissRowMenu} onContextMenu={(e) => { e.preventDefault(); onCloseRowMenu(); }}>
          <div ref={rowMenuRef} className="glass-pop absolute w-56 rounded-2xl py-1 text-[12px]"
            style={{ left: Math.min(rowMenu.x, (window.innerWidth || 1200) - 250), top: Math.min(rowMenu.y, (window.innerHeight || 800) - 430) }}
            onClick={(e) => e.stopPropagation()}>
            <button onClick={onToggleMove} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5 flex items-center">
              Move to group <span className="ml-auto text-mute/50">▸</span>
            </button>
            {moveOpen && (
              <div className="mx-2 mb-1 border-l border-edge pl-1">
                {projects.filter((x) => x.id !== rowMenu.project.id).map((x) => (
                  <button key={x.id} onClick={() => onMoveSession(rowMenu.session, x.id, rowMenu.project.id)}
                    className="w-full text-left px-2 py-1 rounded-md text-[11px] text-mute hover:text-goldSoft hover:bg-white/5 truncate">{x.name}</button>
                ))}
                {projects.length < 2 && <div className="px-2 py-1 text-[10px] text-mute/40">{t('只有当前项目')}</div>}
              </div>
            )}
            <button onClick={() => onPatchFlags(rowMenu.session, { pinned: !rowMenu.session.pinned }, rowMenu.project.id)} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">{rowMenu.session.pinned ? 'Unpin task' : 'Pin task'}</button>
            <button onClick={() => onStartRename(rowMenu.session, rowMenu.project.id)} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Rename task</button>
            <button onClick={() => onPatchFlags(rowMenu.session, { archived: !rowMenu.session.archived }, rowMenu.project.id)} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">{rowMenu.session.archived ? 'Unarchive task' : 'Archive task'}</button>
            <button onClick={() => { const s = rowMenu.session; onCloseRowMenu(); onRemoveSession(s, rowMenu.project.id); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-red-300 hover:bg-red-500/10">{t('Delete task（不可恢复）')}</button>
            <button onClick={() => onPatchFlags(rowMenu.session, { unread: true }, rowMenu.project.id)} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Mark as unread</button>
            <div className="my-1 border-t border-edge/70" />
            <button onClick={() => { y?.artifactOpen?.(rowMenu.project.path); onCloseRowMenu(); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Open in File Explorer</button>
            <button onClick={() => { onCopyText(rowMenu.project.path); onCloseRowMenu(); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Copy path</button>
            <button onClick={() => { onCopyText(rowMenu.session.path || ''); onCloseRowMenu(); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Copy task path</button>
            <button onClick={() => { onCopyText(rowMenu.session.path || ''); onCloseRowMenu(); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Copy log path</button>
            <button onClick={() => { onCopyText(rowMenu.session.id); onCloseRowMenu(); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Copy session ID</button>
            <div className="my-1 border-t border-edge/70" />
            <button onClick={() => { onCloseRowMenu(); onGoSettings(); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Go to config</button>
            <button onClick={() => { const s = rowMenu.session; onCloseRowMenu(); if (s.path) onOpenArtifact(s.path); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">View model trajectory</button>
            <button onClick={() => {
              onCopyText(`${t('FinalCheck 问题反馈')}\n${t('项目')}: ${rowMenu.project.path}\n${t('会话')}: ${rowMenu.session.title}\n${t('会话文件')}: ${rowMenu.session.path}\n${t('模型')}: ${activeModel}\n${t('上下文')}: ${ctxStats ? `${fmtTokens(ctxStats.used)}/${fmtTokens(ctxStats.window)}` : '—'}`);
              onCloseRowMenu();
              onNotice(t('已复制诊断信息，可粘贴到反馈里。'));
            }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Report issue</button>
          </div>
        </div>
      )}

      {/* 重命名会话 */}
      {renameBox && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onClick={onCloseRename}>
          <div className="glass-pop w-[380px] rounded-2xl p-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm text-goldSoft mb-2">{t('重命名会话')}</div>
            <input autoFocus value={renameBox.value}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSaveRename(); } if (e.key === 'Escape') onCloseRename(); }}
              className="input w-full" />
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={onCloseRename} className="btn-ghost px-3 py-1.5 text-xs">{t('取消')}</button>
              <button onClick={onSaveRename} className="btn-primary px-3 py-1.5 text-xs">{t('保存')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 自定义黑金确认框 */}
      {confirmBox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]" onClick={() => confirmBox.resolve(false)}>
          <div className="glass-pop w-[380px] rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="font-kai text-goldSoft text-base tracking-wider">{t('确认操作')}</div>
            <div className="mt-2.5 text-sm text-ink/90 leading-relaxed">{confirmBox.text}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => confirmBox.resolve(false)} className="btn-ghost px-3.5 py-1.5 text-xs">{t('取消')}</button>
              <button onClick={() => confirmBox.resolve(true)} className="rounded-lg bg-red-500/90 hover:bg-red-500 px-3.5 py-1.5 text-xs text-white transition-colors">{t('确定删除')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
