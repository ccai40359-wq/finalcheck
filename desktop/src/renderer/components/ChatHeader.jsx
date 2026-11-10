// 会话头部：当前会话标题 + 归档标记 + 思考中；下面是首次使用向导的挂载位。
import React from 'react';
import { t } from '../i18n/core.mjs';
import { prettyTitle } from '../lib/app-helpers.mjs';
import FirstRunCard from './FirstRunCard.jsx';

export default function ChatHeader({
  sessions, activeId, activeProjectId, projects, busy,
  showSetup, y, cfg, onArchiveSession, onSaved, onSkip
}) {
  const activeProject = projects.find((p) => p.id === activeProjectId) || null;
  const activeTitle = prettyTitle(sessions.find((s) => s.id === activeId)?.title) || (activeId ? activeProject?.name : 'New Session');
  return (
    <>
      {/* 顶栏：当前会话标题 */}
      <div className="shrink-0 h-10 flex items-center px-5 border-b border-edge/60">
        <span className="font-kai text-sm text-goldSoft truncate">{activeTitle || 'FinalCheck'}</span>
        {(() => { const cur = sessions.find((x) => x.id === activeId); return cur?.archived ? (
          <button onClick={() => onArchiveSession(cur, activeProjectId)} title={t('这条会话已归档（历史和记忆都还在），点一下恢复')}
            className="ml-2 shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-mute/70 hover:text-goldSoft hover:border-gold/40 transition-colors">{t('归档')}</button>
        ) : null; })()}
        {busy && <span className="ml-3 text-[11px] text-mute">{t('思考中…')}</span>}
      </div>

      {showSetup && (
        <div className="shrink-0 px-5 pt-4">
          <FirstRunCard y={y} cfg={cfg} onSaved={onSaved} onSkip={onSkip} />
        </div>
      )}
    </>
  );
}
