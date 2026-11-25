// 消息区：滚动容器 + 用户/助手/Notice 气泡 + 回到底部按钮 + 右上角常驻验收单面板。
// 纯展示：消息、会话与滚动状态都在 App，这里只读 props 并按原有内联 JSX 渲染。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';
import { useLanguage } from '../i18n/index.jsx';
import {
  splitAttachmentBlock, parseWorkflowPrompt, parseSkillSegments, baseName, IMG_EXT_RE, previewFromPath, modelDisplayLabel
} from '../lib/app-helpers.mjs';
import { latestTodoFromMessages } from '../lib/todo.mjs';
import { openLightbox } from '../lib/lightbox.mjs';
import { withModelDividers } from '../lib/model-switch.mjs';
import { ProcessTimeline, WorkingStatus } from '../chat/ProcessTimeline.jsx';
import { TraceBlock, WorkflowLiveCard } from '../chat/TraceCards.jsx';
import { ArtifactChips, collectArtifacts } from '../chat/ArtifactPanel.jsx';
import { renderMarkdown } from '../chat/md.jsx';
import { IconChevron, IconCopy, IconEdit, IconRewind } from './Icons.jsx';
import AskUserCard from './AskUserCard.jsx';
import CompactionStatus from './CompactionStatus.jsx';
import { TodoPanel, TodoHistoryRow } from './TodoCard.jsx';
import BgTasksPanel from './BgTasksPanel.jsx';

// 技能 chip：金色符号 + 名称，细底无边框（不是药丸）；title 只在 hover 时暴露 playbook id
function SkillChips({ skills }) {
  if (!skills?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {skills.map((s, k) => (
        <span key={`${s.id}-${k}`} title={`playbook ${s.id}`}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] bg-gold/[0.10] px-1.5 py-[1px] text-[12.5px] leading-relaxed text-goldSoft shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
          <span aria-hidden="true" className="text-[10px] leading-none text-gold">✦</span>
          <span className="font-medium">{s.name}</span>
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
  // 0.33.9：图片点开是大图（同一条消息里的几张可以左右切），不再直接塞进右栏
  const images = files.filter((p) => loaded[p]);
  const zoom = (p) => openLightbox({ items: images.map((x) => ({ src: loaded[x], name: baseName(x), path: x })), index: images.indexOf(p) });
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
      {files.map((p) => loaded[p] ? (
        <button key={p} data-testid="message-image" onClick={() => zoom(p)} title={`${baseName(p)} · ${t('点击查看大图')}`}
          className="w-28 h-20 rounded-lg overflow-hidden border border-gold/30 hover:border-gold/70 bg-sunken transition-colors cursor-zoom-in">
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
      className="mt-1.5 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-base px-3 py-2 font-mono text-[12px] leading-6 text-ink/80 select-text">
      {String(text || '')}
    </pre>
  );
}

export default function MessageList({
  messages, activeId, providers, artifactPath, openWorkflowRaw, setOpenWorkflowRaw,
  scrollRef, stickRef, jumpingRef, showJump, setShowJump,
  y, onSendRecover, onOpenArtifact, onEditMessage, onOpenStep, onRewindFiles,
  askCards = [], onAskUserAnswer = null, compaction = null
}) {
  // 当前会话最新一份验收单：面板只显示这一份；消息流里同一份不再内联渲染（避免一屏两份）。
  const language = useLanguage();
  const latestTodo = useMemo(() => latestTodoFromMessages(messages), [messages]);
  // 模型切换分隔线（round9，对齐 ZCode）：相邻回合的模型/厂商不同 → 中间插一条居中分隔线。
  // 显示用 modelDisplayLabel 换成「供应商名 · 模型名」，不暴露内部 providerId（2026-11-16 用户反馈）。
  const shown = useMemo(
    () => withModelDividers(
      messages,
      (from, to) => `⇄ ${t('模型切换')}：${modelDisplayLabel(from, providers)} → ${modelDisplayLabel(to, providers)}`
    ),
    [messages, providers, language]
  );

  // 贴底滚动期间临时关掉 content-visibility 的收尾函数（幂等）。
  // 存 ref 是为了让「再点一次」和「组件卸载」都先把上一轮收尾：上一轮的定时器若迟到，
  // 会把这一轮刚加上的 cv-off 摘掉 → 又按 400px 估计滚 → 又停在半路。
  const cvOffReleaseRef = useRef(null);
  useEffect(() => () => { cvOffReleaseRef.current?.(); }, []); // 卸载时摘掉（DOM 一起没了，但定时器要清）

  // 只有用户本来就在底部附近才自动跟随；往上看历史时保持不动（判定逻辑与拆分前一致）
  const handleScroll = (e) => {
    const el = e.currentTarget;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = stuck;
    if (jumpingRef.current) { if (stuck) setShowJump(false); }
    else setShowJump(!stuck);
  };
  // 一键回到底部：平滑滚动，立刻隐藏按钮（滚动事件里会再兜底校正）。
  // 0.33.3 用户实测「滚到半路就停」的根因：消息行带 content-visibility:auto（styles.css 的 .cv-auto），
  // 屏幕外的行只按 400px 占位，而一条含大标题/表格的 AI 回答真实高度有 1500-2500px
  // → scrollHeight 被严重低估 → 平滑滚到「假底部」停住；停稳后视口内消息按真实内容撑开，人又离底部很远
  // （消息越长越明显）。所以：滚动期间给容器挂 .cv-off，让所有行按真实高度参与布局，量到真 scrollHeight 再滚。
  // 摘掉 .cv-off 后高度不会缩回去——contain-intrinsic-size:auto 已把这一轮实测的真实高度记住了。
  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) { jumpingRef.current = false; return; } // 没有滚动容器：别留下「动画中」的悬空状态
    // 上一轮（若有）先收尾：它的定时器/scrollend 若迟到，会把这一轮刚加的 cv-off 摘掉。
    // 必须在置 jumpingRef=true **之前**调：release 里会把它复位成 false，
    // 顺序反了就变成「正在平滑滚动，但 jumpingRef 是 false」→ 滚动事件会把箭头又弹出来。
    cvOffReleaseRef.current?.();
    stickRef.current = true;
    jumpingRef.current = true;
    setShowJump(false);
    el.classList.add('cv-off');
    let released = false;
    let timer = 0;
    const release = () => {
      if (released) return; // 幂等：scrollend / 兜底定时器 / 卸载 三条路径谁先到谁干活
      released = true;
      clearTimeout(timer);
      el.removeEventListener('scrollend', release);
      el.classList.remove('cv-off'); // 必须摘：留着等于整条会话永久全量渲染，长会话滚动会卡
      if (cvOffReleaseRef.current === release) cvOffReleaseRef.current = null;
      jumpingRef.current = false;
      // 摘掉后高度理论上不变（已记住实测值），但字体/图片可能正好在这一刻才落位：
      // 只要用户还在跟随态就再贴一次底；已经贴底时这句是 no-op，不会造成可见跳动。
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    };
    cvOffReleaseRef.current = release;
    // 兜底定时器先挂上，再排 rAF：下面任何一步抛异常都不会把 .cv-off 永久留在容器上
    // （永久留着 = 整条会话全量渲染，长会话每帧多排 14k 节点，滚动会明显发卡）。
    // 时长必须盖住整段平滑滚动——实测 Chromium 的 smooth 与距离无关，
    // 3.6 万 px 和 21.6 万 px 都是 ~1500ms 停住（见 .tmp 验证），所以给 1600ms。
    // 本来就在底部时不会产生滚动、scrollend 不来；系统开了「减少动效」时 smooth 被降级成
    // 瞬间跳，同样可能不来——这两种情况都靠这个定时器兜底。
    timer = setTimeout(release, 1600);
    try {
      el.addEventListener('scrollend', release, { passive: true });
      // 等一帧再滚：class 刚加上，浏览器还没重新布局，同一任务里读到的 scrollHeight 仍是旧的估计值。
      requestAnimationFrame(() => {
        if (released) return; // 这一帧到来前已被收尾（重新点过 / 容器被卸载）
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        // 本来就在底部（连点/已在底部）：不会产生滚动，也就没有 scrollend，不必白等那 1.6s
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 2) release();
      });
    } catch (err) {
      release(); // 异常路径也一定摘掉 .cv-off，再把错误抛回去（不吞，免得掩盖真 bug）
      throw err;
    }
  };
  return (
    <div className="flex-1 min-h-0 flex" data-testid="message-host">
      {/* 消息滚动列：验收单浮层 absolute 覆盖在本列内，不占布局宽度 */}
      <div className="relative min-w-0 flex-1">
      <div ref={scrollRef} data-testid="message-scroll" className="h-full overflow-y-auto overflow-x-hidden px-5 py-4"
        onScroll={handleScroll}>
        {/* 全宽文档式排版：消息/输入区同宽（≥90% 容器宽） */}
        <div className="w-full max-w-[96%] mx-auto space-y-4">
          {shown.map((m, i) => {
            // React 身份键：绝不能用数组下标——切会话时两条会话的消息数组重叠，
            // 下标相同会让 React 复用组件实例，ProcessTimeline 的展开 state 就被跨会话继承，
            // 表现为「切回来所有过程全收起」（round9 用户实测根因之②）。
            // 会话 id 始终参与身份：旧 JSON 可能没有 id，且不同会话可能有相同开头。
            // 整条消息及其 Timeline/TodoHistoryRow 等子树均随会话切换重建，避免继承展开/分页状态。
            const mk = JSON.stringify([activeId ?? null, m.mid || m.id || `local-${m.role}-${m.startedAt || ''}-${String(m.content || '').slice(0, 24)}-${i}`]);
            return (
          m.role === 'notice' ? (
            <div key={mk} className="flex items-center gap-3 py-1 text-[11px] text-mute/60">
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
            const keepTurns = shown.slice(0, i).filter((x) => x.role === 'user' && !x.steer).length;
            // Steer 气泡：不是会话历史，只展示「已注入当前回合」；不给编辑/回退入口
            if (m.steer) {
              return (
                <div key={mk} className="flex flex-col items-start gap-1 border-l-2 border-gold/70 pl-3" data-testid="steer-bubble">
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
              <div key={mk} className={`group flex flex-col items-end ${i >= shown.length - 2 ? 'fc-msg-in' : ''}`}>
                <div className={`glass-bubble max-w-[75%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm break-words leading-relaxed ${wf || m.pasted?.length || hasSkills ? '' : 'whitespace-pre-wrap'}`}>
                  {m.pasted?.length ? (
                    <div className="min-w-0">
                      {m.typed ? (typedSk.skills.length ? (
                        <div className="min-w-0">
                          <SkillChips skills={typedSk.skills} />
                          {typedSk.text ? <div className="mt-2 whitespace-pre-wrap break-words">{typedSk.text}</div> : null}
                        </div>
                      ) : <div className="whitespace-pre-wrap">{m.typed}</div>) : null}
                      {m.pasted.map((text, k) => <PastedTextBlock key={k} text={text} />)}
                    </div>
                  ) : wf ? (
                    // Workflow：金色符号 + 标题，正文另起一行；不用药丸/边框，原始指令折叠区低调内滚
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="text-[12px] leading-none text-goldSoft/90 [text-shadow:0_0_10px_rgba(227,197,107,0.35)]">✦</span>
                        <span className="fc-title text-[14px] leading-none">Workflow</span>
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
                      className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-lift/5 transition-colors"><IconChevron /></button>
                  ) : null}
                  <button title={t('复制')} onClick={() => y?.copyText?.(restoreText)}
                    className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-lift/5 transition-colors"><IconCopy /></button>
                  <button title={t('编辑并从这条重开')}
                    onClick={() => {
                      if (m.pasted?.length) {
                        onEditMessage(i, typedSk?.tokenText || m.typed || '', keepTurns, u.files, m.pasted);
                      } else {
                        onEditMessage(i, restoreText, keepTurns, u.files, null);
                      }
                    }}
                    className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-lift/5 transition-colors"><IconEdit /></button>
                  {onRewindFiles ? (
                    <button title={t('恢复文件到这条消息之前')} onClick={() => onRewindFiles(keepTurns)}
                      className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-lift/5 transition-colors"><IconRewind /></button>
                  ) : null}
                </div>
              </div>
            );
          })() : (
            /* AI 回答去气泡：无底色卡片，仅左侧金竖线（错误消息换红线）区分 */
            <div key={mk} className={`w-full border-l-2 pl-4 transition-all duration-200 cv-auto ${i >= shown.length - 2 ? 'fc-msg-in' : ''} ${m.error ? 'border-red-500/50' : m.interrupted ? 'border-gold/30' : 'border-lift/[0.07]'}`}>
              <ProcessTimeline msg={m} />
              {/* 验收单：最新一份钉在右上角面板；这里只在旧回合留一行只读摘要（同一份不渲染两次） */}
              {latestTodo?.index === i ? null : <TodoHistoryRow msg={m} />}
              {m.streaming && m.workflow ? <WorkflowLiveCard data={m.workflow} sessionId={activeId} providers={providers}
                onRecover={(text) => onSendRecover(text)}
                onOpenStep={(s) => onOpenStep(s)} /> : null}
              {m.interrupted && !m.error && (
                <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] text-mute/80">
                  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className="text-mute/70"><rect x="6" y="5" width="4" height="14" rx="1.2" /><rect x="14" y="5" width="4" height="14" rx="1.2" /></svg>
                  {t('已中断 · 输出已保留')}
                </div>
              )}
              {/* 0.33.7：回答过的提问收成一行，放在正文上面（它发生在回复之前） */}
              {!m.streaming && m.trace?.length > 0 && <TraceBlock trace={m.trace} only="ask" />}
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
              {!m.streaming && m.trace?.length > 0 && <TraceBlock trace={m.trace} only="cards" onRecover={(text) => onSendRecover(text)} onOpenStep={(s) => onOpenStep(s)} />}
              <ArtifactChips artifacts={collectArtifacts(m.trace)} activePath={artifactPath} onOpen={onOpenArtifact} />
            </div>
          ));
          })}
          {/* 回合中途提问卡（实时）：在消息流末尾；回答后本回合继续，历史卡由 assistant.trace 还原 */}
          {askCards.map((card) => (
            <AskUserCard key={card.callId} payload={card}
              onSubmit={onAskUserAnswer ? ({ selected, text }) => onAskUserAnswer(card.callId, { selected, text }) : null} />
          ))}
          {/* 上下文压缩：作为**正文流里的一条分隔线**（CC/ZCode 观感）。
              放在消息末尾而不是输入框上方——压缩是会话事件，改的是这条会话的历史，
              完成后那条线要留在历史里，让人回头能看见「这里压过一次、上下文为什么变短」。
              自动压缩不落 notice（只有手动 /compact 落），所以 done 态必须自己渲染。 */}
          <CompactionStatus state={compaction} lang={language} />
        </div>
      </div>
      {/* 不在底部时：底部居中的回到底部箭头（不挡输入框、不压 WorkingStatus） */}
      {showJump && (
        <button type="button" data-testid="scroll-bottom" onClick={jumpToBottom} title={t('回到底部')}
          className="absolute bottom-2 left-1/2 z-20 flex h-[30px] w-[30px] -translate-x-1/2 items-center justify-center rounded-full border border-gold/45 bg-cardHover/80 text-goldSoft shadow-lg backdrop-blur-md transition-all duration-200 motion-reduce:transition-none hover:border-gold hover:bg-gold/20 hover:text-ink">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
        </button>
      )}
      {/* 验收单浮层：absolute 覆盖在消息列右上角，不占宽、不随消息滚动；
          透明区域 pointer-events-none（可穿透滚动），只有卡片/chip 可交互。 */}
      {/* 0.33.5：后台任务胶囊放在验收单上面（同一个右上角浮层列） */}
      <TodoPanel items={latestTodo?.items || []} error={latestTodo?.error || null} sessionId={activeId}
        live={latestTodo ? latestTodo.live : true}
        top={activeId ? <BgTasksPanel y={y} sessionId={activeId} onOpenStep={onOpenStep} /> : null} />
      </div>
    </div>
  );
}
