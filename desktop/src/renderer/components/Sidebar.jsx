// 左栏（液态玻璃）：Workspaces / 项目行 / 会话行 / Archived / Show more / 底部 Settings。
// 纯展示组件：所有状态仍在 App，行为通过 props 回调（与原 App.jsx 内联 JSX 一一对应）。
import React from 'react';
import { t } from '../i18n/core.mjs';
import { prettyTitle, relTime } from '../lib/app-helpers.mjs';
import { IconPlusCircle, IconFolderPlus, IconFolder, IconPlus, IconTrash, IconArchive, IconUnarchive, IconGear, Spinner } from './Icons.jsx';

const SESSION_PREVIEW = 5; // 每个工作区默认露出几条会话，其余走 Show more

export default function Sidebar({
  y, booted, page, projects, activeProjectId, activeId, sessions, projectSessions,
  showAllSessions, showArchived, runningIds, updateVersion, isProjectExpanded,
  setShowAllSessions, setShowArchived,
  onNewSession, onAddProject, onToggleProject, onOpenSession, onNewSessionInProject,
  onRemoveProject, onArchiveSession, onOpenRowMenu, onSettings
}) {
  return (
    <aside className="glass-side w-[212px] shrink-0 flex flex-col">
      {/* 最上面一条：New Session（居中、全英文，仿 ZCode） */}
      <div className="px-2 pt-2.5 pb-1">
        <button onClick={onNewSession} disabled={!y || !activeProjectId}
          className="glass-row w-full flex items-center justify-center gap-2 rounded-xl px-2.5 h-9 text-[13px] text-ink/90 hover:text-ink disabled:opacity-35">
          <IconPlusCircle /> New Session
        </button>
      </div>

      {/* Workspaces 标题 + 新建项目文件夹（右边这个图标） */}
      <div className="px-3.5 pt-3.5 pb-1 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.16em] text-mute/45 select-none">Workspaces</span>
        <button onClick={onAddProject} title={t('新建项目文件夹（会话与记忆存到该目录 .finalcheck/）')}
          className="h-6 w-6 -mr-1 rounded-lg text-mute/55 hover:text-goldSoft hover:bg-white/[0.07] transition-colors flex items-center justify-center">
          <IconFolderPlus />
        </button>
      </div>

      {/* 工作区列表：每个 Workspace 独立展开/收起（可同时展开多个，ZCode 语义）；默认 5 条，多的 Show more */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {!y && <div className="text-xs text-mute/70 px-2 py-3">{t('浏览器直开：项目/会话不可用')}</div>}
        {y && booted && projects.length === 0 && <div className="text-xs text-mute/70 px-2 py-3">No workspaces yet</div>}
        {projects.map((p) => {
          const isActive = p.id === activeProjectId;
          const open = isProjectExpanded(p);
          const cached = isActive ? sessions : projectSessions[p.id];
          const loading = open && !isActive && projectSessions[p.id] === undefined;
          const list = open ? (cached || []) : [];
          const live = list.filter((x) => !x.archived);   // 归档的默认不出现（文件、历史、记忆都还在磁盘上）
          const arch = list.filter((x) => x.archived);
          const headerCount = cached ? live.length : (p.sessionCount || 0);
          const expanded = !!showAllSessions[p.id];
          const archOpen = !!showArchived[p.id];
          const shown = expanded ? live : live.slice(0, SESSION_PREVIEW);

          // 一行会话：hover 的动作是归档（不删任何数据）；归档过的行 hover 变成恢复
          const renderSessionRow = (s) => {
            const sActive = s.id === activeId && page === 'chat';
            const running = !!runningIds[s.id];
            return (
              <div key={s.id} onClick={() => onOpenSession(p, s)}
                onContextMenu={(e) => { e.preventDefault(); onOpenRowMenu(e.clientX, e.clientY, s, p); }}
                title={`${prettyTitle(s.title)} · ${new Date(s.updatedAt).toLocaleString('zh-CN')}${s.turns ? ` · ${t('{n} 轮', { n: s.turns })}` : ''}`}
                className={`group relative flex items-center gap-1.5 rounded-lg pl-2 pr-1.5 py-1.5 cursor-pointer transition-colors ${s.archived ? 'opacity-45' : ''} ${
                  sActive ? 'bg-white/[0.09] text-goldSoft' : 'text-ink/85 hover:bg-white/[0.06] hover:text-ink'}`}>
                {s.pinned ? <span className="text-goldDeep/70 text-[9px] shrink-0">▴</span> : null}
                {/* 状态槽：跑的时候转圈，跑完才是绿点 */}
                <span className="w-3 shrink-0 flex items-center justify-center">
                  {running
                    ? <Spinner size={13} className="text-ink/65" title={t('运行中')} />
                    : s.unread ? <span title={t('已完成')} className="w-1.5 h-1.5 rounded-full bg-jade" /> : null}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px]">{prettyTitle(s.title)}</span>
                <span className="shrink-0 text-[10px] text-mute/60 tabular-nums group-hover:opacity-0 transition-opacity">{relTime(s.updatedAt)}</span>
                <button title={s.archived ? t('恢复会话') : t('归档会话（历史与记忆保留，在 Archived 里可找回）')}
                  onClick={(e) => { e.stopPropagation(); onArchiveSession(s, p.id); }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-md text-mute/40 opacity-0 group-hover:opacity-100 hover:text-goldSoft hover:bg-white/[0.08] transition-opacity">
                  {s.archived ? <IconUnarchive /> : <IconArchive />}
                </button>
              </div>
            );
          };
          return (
            <div key={p.id} className="mb-0.5">
              <div onClick={() => onToggleProject(p)} title={p.path}
                className={`group relative flex items-center gap-1 rounded-lg pl-1 pr-1.5 py-1.5 cursor-pointer transition-colors ${
                  isActive ? 'text-goldSoft bg-white/[0.045]' : 'text-ink/80 hover:bg-white/[0.05] hover:text-ink'}`}>
                <span role="button" tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); onToggleProject(p); }}
                  className="shrink-0 p-0.5 rounded text-mute/45 hover:text-ink transition-colors">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                    className={`transition-transform duration-300 ${open ? '' : '-rotate-90'}`}><path d="M6 9l6 6 6-6" /></svg>
                </span>
                <IconFolder active={isActive} />
                <span className={`flex-1 min-w-0 truncate text-[13px] ${isActive ? 'font-medium' : ''}`}>{p.name}</span>
                <span className="shrink-0 text-[10px] text-mute/55 tabular-nums group-hover:opacity-0 transition-opacity">{headerCount}</span>
                {/* hover 操作槽：＋（新建对话）/ 删除项目；flex 容器方便以后再加 … 与列表图标，不写死宽度 */}
                <span className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button title={t('在这个项目里新建对话')}
                    onClick={(e) => { e.stopPropagation(); onNewSessionInProject(p); }}
                    className="p-1 rounded-md text-mute/40 hover:text-goldSoft hover:bg-white/[0.08] transition-colors">
                    <IconPlus />
                  </button>
                  <button title={t('从列表移除项目（不删磁盘目录）')} onClick={(e) => { e.stopPropagation(); onRemoveProject(p); }}
                    className="p-1 rounded-md text-mute/40 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                    <IconTrash />
                  </button>
                </span>
              </div>

              {open && (
                <div className="mt-0.5 mb-1 ml-[13px] pl-2 border-l border-white/[0.06]">
                  {loading ? (
                    <div className="px-2 py-1 text-[10px] text-mute/30">{t('加载中…')}</div>
                  ) : (
                    <>
                      {list.length === 0 && <div className="px-2 py-1 text-[10px] text-mute/30">No sessions</div>}
                      {shown.map((s) => renderSessionRow(s))}
                      {live.length > SESSION_PREVIEW && (
                        <button onClick={() => setShowAllSessions((v) => ({ ...v, [p.id]: !v[p.id] }))}
                          className="mt-0.5 w-full text-left px-2 py-1 rounded-lg text-[11px] text-mute/55 hover:text-goldSoft hover:bg-white/[0.045] transition-colors">
                          {expanded ? 'Show less' : 'Show more'}
                        </button>
                      )}
                      {arch.length > 0 && (
                        <>
                          <button onClick={() => setShowArchived((v) => ({ ...v, [p.id]: !v[p.id] }))}
                            className="mt-0.5 w-full text-left px-2 py-1 rounded-lg text-[11px] text-mute/45 hover:text-ink hover:bg-white/[0.045] transition-colors flex items-center gap-1.5">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                              className={`transition-transform duration-300 ${archOpen ? '' : '-rotate-90'}`}><path d="M6 9l6 6 6-6" /></svg>
                            Archived <span className="text-mute/30 tabular-nums">{arch.length}</span>
                          </button>
                          {archOpen && arch.map((s) => renderSessionRow(s))}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部：Settings + 连接状态点 */}
      <div className="px-2 py-2 border-t border-white/[0.06] flex items-center gap-1">
        <button onClick={onSettings}
          className={`flex-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
            page === 'settings' ? 'bg-white/[0.06] text-goldSoft' : 'text-mute hover:text-ink hover:bg-white/[0.045]'}`}>
          <IconGear active={page === 'settings'} />Settings
          {updateVersion ? (
            <span title={updateVersion ? t('有新版本 v{v}', { v: updateVersion }) : t('有新版本')}
              className="ml-auto w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
          ) : null}
        </button>
        <span title={y ? t('IPC 已连接') : t('IPC 不可用')} className={`w-1.5 h-1.5 rounded-full ${y ? 'bg-jade' : 'bg-red-400/70'}`} />
      </div>
    </aside>
  );
}
