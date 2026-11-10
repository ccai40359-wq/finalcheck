// 消息区：滚动容器 + 用户/助手/Notice 气泡 + 回到底部按钮。
// 纯展示：消息、会话与滚动状态都在 App，这里只读 props 并按原有内联 JSX 渲染。
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';
import {
  splitAttachmentBlock, parseWorkflowPrompt, parseSkillSegments, baseName, IMG_EXT_RE, previewFromPath
} from '../lib/app-helpers.mjs';
import { ProcessTimeline, WorkingStatus } from '../chat/ProcessTimeline.jsx';
import { TraceBlock, WorkflowLiveCard } from '../chat/TraceCards.jsx';
import { ArtifactChips, collectArtifacts } from '../chat/ArtifactPanel.jsx';
import { renderMarkdown } from '../chat/md.jsx';
import { IconChevron, IconCopy, IconEdit } from './Icons.jsx';

// 技能 chip：金色符号 + 名称，细底无边框（不是药丸）；title 只在 hover 时暴露 playbook id
function SkillChips({ skills }) {
  if (!skills?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {skills.map((s, k) => (
        <span key={`${s.id}-${k}`} title={`playbook ${s.id}`}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] bg-gold/[0.10] px-1.5 py-[1px] text-[12.5px] leading-relaxed text-goldSoft shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
          <span aria-hidden="true" className="text-[10px] leading-none text-gold">✦</span>
          <span className="font-kai tracking-[0.03em]">{s.name}</span>
        </span>
      ))}
    </div>
  );
}

// 用户消息里的附件：图片直接出缩略图（点开右侧预览），其它类型保留文件名 chip
function UserAttachments({ files, onOpen }) {
  const y = api();
  const [loaded, setLoaded] = useState({});
  const retriedRef = useRef(new Set());
  const key = (files || []).join('|');
  useEffect(() => {
    let alive = true;
    retriedRef.current = new Set();
    (async () => {
      for (const p of (files || []).filter((f) => IMG_EXT_RE.test(f))) {
        const url = await previewFromPath(y, p);
        if (alive && url) setLoaded((s) => ({ ...s, [p]: url }));
      }
    })();
    return () => { alive = false; };
  }, [key]);
  // data URL 也加载失败（文件损坏/已删除）：先回 ▤ 占位，再按路径重读一次；仍失败保持占位，不显示破图
  const handleImgError = (p) => {
    setLoaded((s) => { if (!s[p]) return s; const n = { ...s }; delete n[p]; return n; });
    if (retriedRef.current.has(p)) return;
    retriedRef.current.add(p);
    previewFromPath(y, p).then((url) => { if (url) setLoaded((s) => ({ ...s, [p]: url })); }).catch(() => {});
  };
  if (!files?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
      {files.map((p) => loaded[p] ? (
        <button key={p} onClick={() => onOpen?.(p)} title={p}
          className="w-28 h-20 rounded-lg overflow-hidden border border-gold/30 hover:border-gold/70 bg-[#0d0d10] transition-colors">
          <img src={loaded[p]} alt={baseName(p)} className="w-full h-full object-cover" onError={() => handleImgError(p)} />
        </button>
      ) : (
        <button key={p} onClick={() => onOpen?.(p)} title={p}
          className="inline-flex items-center gap-1 rounded-md border border-gold/30 bg-gold/10 px-2 py-1 text-[10px] font-mono text-goldSoft/90 hover:border-gold/60">
          <span>▤</span><span className="max-w-[180px] truncate">{baseName(p)}</span>
        </button>
      ))}
    </div>
  );
}

// 用户消息里的粘贴文本块：纯文本 + 等宽字体，不做 markdown/着色/链接识别；内部滚动、深色底
function PastedTextBlock({ text }) {
  return (
    <pre data-testid="pasted-text-block"
      className="mt-1.5 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-[#0a0a0c] px-3 py-2 font-mono text-[12px] leading-6 text-ink/80 select-text">
      {String(text || '')}
    </pre>
  );
}

export default function MessageList({
  messages, activeId, providers, artifactPath, openWorkflowRaw, setOpenWorkflowRaw,
  scrollRef, stickRef, jumpingRef, showJump, setShowJump,
  y, onSendRecover, onOpenArtifact, onEditMessage, onOpenStep
}) {
  // 只有用户本来就在底部附近才自动跟随；往上看历史时保持不动（判定逻辑与拆分前一致）
  const handleScroll = (e) => {
    const el = e.currentTarget;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = stuck;
    if (jumpingRef.current) { if (stuck) setShowJump(false); }
    else setShowJump(!stuck);
  };
  // 一键回到底部：平滑滚动，立刻隐藏按钮（滚动事件里会再兜底校正）
  const jumpToBottom = () => {
    stickRef.current = true;
    jumpingRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setTimeout(() => { jumpingRef.current = false; }, 500);
  };
  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} className="h-full overflow-y-auto px-5 py-4"
        onScroll={handleScroll}>
        {/* 全宽文档式排版：消息/输入区同宽（≥90% 容器宽） */}
        <div className="w-full max-w-[96%] mx-auto space-y-4">
          {messages.map((m, i) => (
          m.role === 'notice' ? (
            <div key={i} className="flex items-center gap-3 py-1 text-[11px] text-mute/60">
              <span className="h-px flex-1 bg-edge" />
              <span className="max-w-[80%] text-center whitespace-pre-wrap">{m.content}</span>
              <span className="h-px flex-1 bg-edge" />
            </div>
          ) : m.role === 'user' ? (() => {
            const u = splitAttachmentBlock(m.content);
            const wf = parseWorkflowPrompt(u.text);
            const wfText = wf ? (`/workflow ${wf.task}`.trim()) : null;
            // 技能段：展示时摘掉内部 read_playbook 指令，只剩 chip；复制/编辑还原成 /id token
            const sk = parseSkillSegments(u.text);
            const typedSk = m.pasted?.length ? parseSkillSegments(m.typed || '') : null;
            const hasSkills = !wf && sk.skills.length > 0;
            const restoreText = m.pasted?.length
              ? [typedSk?.tokenText, ...(m.pasted || [])].filter((x) => String(x || '').trim()).join('\n\n')
              : (wf ? wfText : (sk.skills.length ? sk.tokenText : u.text));
            const keepTurns = messages.slice(0, i).filter((x) => x.role === 'user' && !x.steer).length;
            // Steer 气泡：不是会话历史，只展示「已注入当前回合」；不给编辑/回退入口
            if (m.steer) {
              return (
                <div key={i} className="flex flex-col items-start gap-1 border-l-2 border-gold/70 pl-3" data-testid="steer-bubble">
                  <div className="inline-flex items-center gap-1.5">
                    <span className="badge bg-gold/20 text-goldSoft border border-gold/50">Steer</span>
                    <span className="text-[10px] text-mute/60">{t('已注入当前回合')}</span>
                  </div>
                  <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-gold/25 bg-gold/[0.06] px-3.5 py-2 text-sm leading-relaxed text-ink/90">
                    {m.content}
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className="group flex flex-col items-end">
                <div className={`glass-bubble max-w-[75%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm break-words leading-relaxed ${wf || m.pasted?.length || hasSkills ? '' : 'whitespace-pre-wrap'}`}>
                  {m.pasted?.length ? (
                    <div className="min-w-0">
                      {m.typed ? (typedSk.skills.length ? (
                        <div className="min-w-0">
                          <SkillChips skills={typedSk.skills} />
                          {typedSk.text ? <div className="mt-2 whitespace-pre-wrap break-words">{typedSk.text}</div> : null}
                        </div>
                      ) : <div className="whitespace-pre-wrap">{m.typed}</div>) : null}
                      {m.pasted.map((t, k) => <PastedTextBlock key={k} text={t} />)}
                    </div>
                  ) : wf ? (
                    // Workflow：金色符号 + 标题，正文另起一行；不用药丸/边框，原始指令折叠区低调内滚
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="text-[12px] leading-none text-goldSoft/90 [text-shadow:0_0_10px_rgba(227,197,107,0.35)]">✦</span>
                        <span className="font-kai text-[15px] font-semibold leading-none tracking-[0.14em] text-goldSoft">Workflow</span>
                      </div>
                      <div className="mt-2 text-[13.5px] leading-relaxed text-ink/90 break-words">{wf.task || t('多 agent 并行执行')}</div>
                      {openWorkflowRaw === i ? (
                        <div className="mt-2.5 max-h-36 overflow-y-auto border-t border-gold/15 pt-2 pr-1 text-[11px] leading-relaxed text-mute/70 whitespace-pre-wrap break-words">
                          {u.text}
                        </div>
                      ) : null}
                    </div>
                  ) : hasSkills ? (
                    <div className="min-w-0">
                      <SkillChips skills={sk.skills} />
                      {sk.text ? <div className="mt-2 whitespace-pre-wrap break-words">{sk.text}</div> : null}
                    </div>
                  ) : u.text}
                </div>
                <UserAttachments files={u.files} onOpen={onOpenArtifact} />
                <div className="mt-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {wf ? (
                    <button title={openWorkflowRaw === i ? t('收起原始指令') : t('查看原始指令')}
                      onClick={() => setOpenWorkflowRaw((v) => (v === i ? null : i))}
                      className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-white/5 transition-colors"><IconChevron /></button>
                  ) : null}
                  <button title={t('复制')} onClick={() => y?.copyText?.(restoreText)}
                    className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-white/5 transition-colors"><IconCopy /></button>
                  <button title={t('编辑并从这条重开')}
                    onClick={() => {
                      if (m.pasted?.length) {
                        onEditMessage(i, typedSk?.tokenText || m.typed || '', keepTurns, u.files, m.pasted);
                      } else {
                        onEditMessage(i, restoreText, keepTurns, u.files, null);
                      }
                    }}
                    className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-white/5 transition-colors"><IconEdit /></button>
                </div>
              </div>
            );
          })() : (
            /* AI 回答去气泡：无底色卡片，仅左侧金竖线（错误消息换红线）区分 */
            <div key={i} className={`w-full border-l-2 pl-4 transition-all duration-200 ${m.error ? 'border-red-500/50' : m.interrupted ? 'border-gold/25' : 'border-gold/45'}`}>
              <ProcessTimeline msg={m} />
              {m.streaming && m.workflow ? <WorkflowLiveCard data={m.workflow} sessionId={activeId} providers={providers}
                onRecover={(text) => onSendRecover(text)}
                onOpenStep={(s) => onOpenStep(s)} /> : null}
              {m.interrupted && !m.error && (
                <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] text-mute/80">
                  <span className="inline-block w-2.5 h-2.5 rounded-[2px] bg-gold/70" />
                  {t('已停止 · 输出已保留')}
                </div>
              )}
              {m.content && <div className="md text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />}
              {m.streaming && (
                m.startedAt
                  ? <WorkingStatus startedAt={m.startedAt} label={m.activityLabel} tone={m.activityTone || 'activity'} className="mt-2" />
                  : (
                    <span className="inline-flex gap-1 items-center h-4 mt-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-goldSoft animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-goldSoft animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-goldSoft animate-bounce" style={{ animationDelay: '300ms' }} />
                    </span>
                  )
              )}
              {m.error && (
                <div className="text-red-300">
                  <div className="font-medium mb-1">{t('出错了')}</div>
                  <div className="text-xs leading-relaxed">{m.error}</div>
                  {/* 恢复键在工作流卡片底栏（只在中断/失败时出现）；这里只留说明文字 */}
                </div>
              )}
              {/* 出错的回合也可能是「工作流跑完了、总结被打断」：trace 照样要渲染（否则卡片/证据全看不到） */}
              {!m.streaming && m.trace?.length > 0 && <TraceBlock trace={m.trace} onRecover={(text) => onSendRecover(text)} onOpenStep={(s) => onOpenStep(s)} />}
              <ArtifactChips artifacts={collectArtifacts(m.trace)} activePath={artifactPath} onOpen={onOpenArtifact} />
            </div>
          )
        ))}
        </div>
      </div>
      {/* 不在底部时：底部居中的回到底部箭头（不挡输入框、不压 WorkingStatus） */}
      {showJump && (
        <button type="button" data-testid="scroll-bottom" onClick={jumpToBottom} title={t('回到底部')}
          className="absolute bottom-2 left-1/2 z-20 flex h-[30px] w-[30px] -translate-x-1/2 items-center justify-center rounded-full border border-gold/45 bg-[#141210]/80 text-goldSoft shadow-lg backdrop-blur-md transition-all duration-200 hover:border-gold hover:bg-gold/20 hover:text-ink">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
        </button>
      )}
    </div>
  );
}
