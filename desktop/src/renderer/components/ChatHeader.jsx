// 会话头部：当前会话标题 + 归档标记 + 思考中；下面是首次使用向导的挂载位。
import React from 'react';
import { t } from '../i18n/core.mjs';
import { prettyTitle } from '../lib/app-helpers.mjs';
import FirstRunCard from './FirstRunCard.jsx';

export default function ChatHeader({
  sessions, activeId, activeProjectId, projects, busy,
  showSetup, y, cfg, onArchiveSession, onSaved, onSkip, onOpenRail = null
}) {
  const activeProject = projects.find((p) => p.id === activeProjectId) || null;
  const activeTitle = prettyTitle(sessions.find((s) => s.id === activeId)?.title) || (activeId ? activeProject?.name : 'New Session');
  return (
    <>
      {/* 顶栏：当前会话标题（CU 迷你形态下由 body.fc-cu-mini 整体隐藏） */}
      <div className="fc-chat-header shrink-0 h-10 flex items-center px-5 border-b border-edge/60">
        <span className="text-[13px] font-medium tracking-[0.01em] text-ink/90 truncate">{activeTitle || 'FinalCheck'}</span>
        {(() => { const cur = sessions.find((x) => x.id === activeId); return cur?.archived ? (
          <button onClick={() => onArchiveSession(cur, activeProjectId)} title={t('这条会话已归档（历史和记忆都还在），点一下恢复')}
            className="ml-2 shrink-0 rounded-full border border-lift/10 px-2 py-0.5 text-[10px] text-mute/70 hover:text-goldSoft hover:border-gold/40 transition-colors">{t('归档')}</button>
        ) : null; })()}
        {busy && <span className="ml-3 text-[11px] text-mute">{t('思考中…')}</span>}
        {/* 0.33.9：自己打开右栏（浏览器 / 文件 / 后台任务）；右栏已经开着时不显示 */}
        {onOpenRail ? (
          <button type="button" data-testid="rail-open" onClick={onOpenRail}
            title={t('打开右栏（浏览器 / 文件 / 后台任务）')} aria-label={t('打开右栏')}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-mute/60 transition-colors hover:bg-lift/[0.07] hover:text-goldSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" /><line x1="15.5" y1="4" x2="15.5" y2="20" />
            </svg>
          </button>
        ) : null}
      </div>

      {showSetup && (
        <div className="shrink-0 px-5 pt-4">
          <FirstRunCard y={y} cfg={cfg} onSaved={onSaved} onSkip={onSkip} />
        </div>
      )}
    </>
  );
}
