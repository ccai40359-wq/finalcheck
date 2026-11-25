// 回合中途提问卡（不是 modal）：插在消息流里，用户点选项或自己输入，回答后本回合继续。
// 状态机：pending（可交互）→ answered / cancelled / expired（只读结果）。
// 实时卡由 App 的 askCards 驱动；历史卡由 assistant.trace 里的 ask_user part 还原（readOnly）。
//
// 0.33.7（用户：「下面这个卡片我也不喜欢，一大坨在这里不好看」）：
//   · 待回答：一张安静的卡（细边框 + 极淡的底），短选项排成一行按钮，长选项才用列表
//   · 回答过 / 失效：收成**一行**「你回答了：…」，点开才看原问题——不再在消息流里留一大块
import React, { useEffect, useState } from 'react';
import { t } from '../i18n/core.mjs';
import { useLanguage } from '../i18n/index.jsx';
import { EN_QUESTION_FALLBACK, displayAskText, translateAskText } from '../lib/ask-user-i18n.mjs';
import { renderMarkdown } from '../chat/md.jsx';

const STATUS_DONE = new Set(['answered', 'cancelled', 'expired', 'rejected']);

function IconQuestion({ className = '' }) {
  return (
    <svg aria-hidden="true" className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" /><path d="M12 17h.01" />
    </svg>
  );
}
function IconCheck({ className = '' }) {
  return (
    <svg aria-hidden="true" className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
  );
}
function IconDash({ className = '' }) {
  return (
    <svg aria-hidden="true" className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 12h12" /></svg>
  );
}

/** 只读一行：回答过 / 取消 / 未发出 / 失效。点开看原问题。 */
function DoneRow({ data, status, lang, isPlan }) {
  const [open, setOpen] = useState(false);
  const answered = status === 'answered';
  const answer = translateAskText(data.answer, lang) || t('(空)');
  const lead = answered
    ? (isPlan ? t('计划已回复：') : t('你回答了：'))
    : status === 'cancelled' ? t('用户取消')
      : status === 'rejected' ? t('提问未发出')
        : t('未回答（已失效）');
  const tail = answered ? answer
    : status === 'cancelled' ? t('本回合已按停止处理')
      : status === 'rejected' ? (translateAskText(data.error, lang) || t('未知原因'))
        : t('这张提问来自已结束的回合，不能再回答');
  const question = String(data.question || '');
  return (
    <div data-testid="ask-user-card" data-status={status} className="my-2 min-w-0 animate-[fadeIn_.2s_ease]">
      <button type="button" onClick={() => question && setOpen((v) => !v)} aria-expanded={open}
        data-testid="ask-user-result"
        className={`group inline-flex max-w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-[12px] transition-colors duration-150 ${question ? 'cursor-pointer hover:text-ink/90' : 'cursor-default'}`}>
        {answered
          ? <IconCheck className="shrink-0 text-emerald-400/80" />
          : <IconDash className={`shrink-0 ${status === 'rejected' ? 'text-red-300/80' : 'text-mute/60'}`} />}
        <span className="shrink-0 text-mute/70">{lead}</span>
        <span className={`min-w-0 truncate ${answered ? 'text-ink/85' : status === 'rejected' ? 'text-red-300/80' : 'text-mute/60'}`}>{tail}</span>
        {question ? <span className={`shrink-0 text-[10px] text-mute/45 opacity-0 transition-all duration-200 group-hover:opacity-100 ${open ? 'rotate-180 opacity-100' : ''}`}>▾</span> : null}
      </button>
      {open && question ? (
        isPlan ? (
          <div className="md mt-1.5 ml-[5px] max-h-[320px] overflow-y-auto border-l border-edge/70 pl-3 text-[12px] leading-relaxed text-mute/85 break-words animate-[fadeIn_.18s_ease]"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(question) }} />
        ) : (
          <div className="mt-1.5 ml-[5px] border-l border-edge/70 pl-3 text-[12px] leading-relaxed text-mute/85 whitespace-pre-wrap break-words animate-[fadeIn_.18s_ease]">
            {displayAskText(question, lang, EN_QUESTION_FALLBACK)}
          </div>
        )
      ) : null}
    </div>
  );
}

export default function AskUserCard({ payload, onSubmit = null }) {
  const data = payload || {};
  const lang = useLanguage(); // 切换语言后本卡跟着重渲染；提交仍用原始 label
  const status = STATUS_DONE.has(data.status) ? data.status : (data.status === 'pending' ? 'pending' : 'expired');
  const [selected, setSelected] = useState(() => (Array.isArray(data.selected) ? data.selected : []));
  const [text, setText] = useState(() => String(data.text ?? ''));
  const [submitting, setSubmitting] = useState(false);
  const interactive = status === 'pending' && typeof onSubmit === 'function';
  const options = Array.isArray(data.options) ? data.options.slice(0, 6) : [];
  const multi = data.multiSelect === true;
  const isPlan = data.kind === 'plan'; // 0.33.1 exit_plan_mode 的计划审批卡
  // 选项都短、都没说明 → 一行按钮（像对话里的快捷回复）；否则列表
  const compactOptions = !multi && options.length > 0 && options.length <= 4
    && options.every((o) => !o?.description && String(o?.label ?? '').length <= 18);

  // 同一张卡被主进程回填（answered/cancelled）或换了 callId 时，重置本地输入
  useEffect(() => {
    setSelected(Array.isArray(data.selected) ? data.selected : []);
    setText(String(data.text ?? ''));
    setSubmitting(false);
  }, [data.callId, data.status]);

  if (status !== 'pending') return <DoneRow data={data} status={status} lang={lang} isPlan={isPlan} />;

  const toggle = (label) => {
    if (!interactive || submitting) return;
    setSelected((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]));
  };

  const submit = async (selectedOverride = null) => {
    if (!interactive || submitting) return;
    const picks = (selectedOverride || selected || []).map((x) => String(x)).filter(Boolean);
    const typed = text.trim();
    if (!picks.length && !typed) return;
    setSubmitting(true);
    try {
      await onSubmit({ selected: picks, text: typed });
    } finally {
      setSubmitting(false);
    }
  };

  const onOption = (label) => {
    if (multi) toggle(label);
    else void submit([label]);
  };

  const canSubmit = !submitting && (selected.length > 0 || text.trim().length > 0);

  return (
    <div data-testid="ask-user-card" data-status={status}
      className="my-3 rounded-xl border border-gold/20 bg-gold/[0.035] px-4 py-3 animate-[fadeIn_.2s_ease]">
      <div className="flex items-center gap-2 text-[12px]">
        <IconQuestion className="shrink-0 text-goldSoft/90" />
        <span className="font-medium text-goldSoft/90">{isPlan ? t('计划待批准') : t('需要你的选择')}</span>
        {multi ? <span className="text-[11px] text-mute/60">· {t('可多选')}</span> : null}
        <span className="ml-auto text-[11px] text-mute/50">{t('回答后本回合继续')}</span>
      </div>

      {isPlan ? (
        <div data-testid="plan-body" className="md mt-2 max-h-[420px] overflow-y-auto rounded-lg bg-lift/[0.03] px-3 py-2 text-sm leading-relaxed text-ink/95 break-words"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(String(data.question || '')) }} />
      ) : (
        <div className="mt-1.5 text-sm leading-relaxed text-ink/95 break-words whitespace-pre-wrap">{displayAskText(data.question, lang, EN_QUESTION_FALLBACK)}</div>
      )}

      {options.length && compactOptions ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((opt, i) => {
            const label = String(opt?.label ?? '');
            return (
              <button key={`${label}-${i}`} type="button" disabled={submitting}
                data-testid="ask-user-option"
                onClick={() => onOption(label)}
                className={`rounded-lg px-3.5 py-1.5 text-xs transition-colors duration-150 disabled:opacity-50 ${i === 0
                  ? 'bg-goldSoft/90 font-medium text-black hover:bg-goldSoft'
                  : 'border border-lift/[0.1] bg-lift/[0.03] text-ink/90 hover:bg-lift/[0.07]'}`}>
                {translateAskText(label, lang)}
              </button>
            );
          })}
        </div>
      ) : null}

      {options.length && !compactOptions ? (
        <div className="mt-2.5 flex flex-col gap-1">
          {options.map((opt, i) => {
            const label = String(opt?.label ?? '');
            const active = selected.includes(label);
            return (
              <button key={`${label}-${i}`} type="button" disabled={submitting}
                data-testid="ask-user-option"
                onClick={() => onOption(label)}
                className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors duration-150 disabled:opacity-50 ${active ? 'border-gold/35 bg-gold/[0.08]' : 'border-lift/[0.07] bg-lift/[0.02] hover:bg-lift/[0.05]'}`}>
                <div className="flex items-center gap-2">
                  {multi ? (
                    <span className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] text-[9px] ${active ? 'bg-goldSoft text-black' : 'bg-lift/[0.08] text-transparent'}`}>✓</span>
                  ) : null}
                  <span className={`font-medium ${active ? 'text-goldSoft' : 'text-ink/90'}`}>{translateAskText(label, lang)}</span>
                </div>
                {opt?.description ? <div className="mt-0.5 text-[11px] leading-relaxed text-mute/65">{displayAskText(opt.description, lang, '', { keepOriginal: true })}</div> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        <input type="text" value={text} disabled={submitting}
          data-testid="ask-user-input"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
          placeholder={isPlan ? t('想改哪里？写下意见，AI 会改好计划再交') : options.length ? t('也可以直接输入回答…') : t('输入你的回答…')}
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-lift/[0.04] px-3 py-1.5 text-xs text-ink placeholder:text-mute/45 transition-colors duration-150 focus:border-lift/[0.12] focus:bg-lift/[0.06] focus:outline-none disabled:opacity-50" />
        {canSubmit || !options.length || multi ? (
          <button type="button" disabled={!canSubmit}
            data-testid="ask-user-submit" onClick={() => void submit()}
            className="shrink-0 rounded-lg border border-lift/[0.1] bg-lift/[0.05] px-3 py-1.5 text-xs text-ink/90 transition-colors duration-150 hover:bg-lift/[0.09] disabled:opacity-40">
            {submitting ? t('提交中…') : t('提交回答')}
          </button>
        ) : null}
      </div>
      {multi && selected.length ? <div className="mt-1.5 text-[11px] text-goldSoft/70">{t('已选 {n} 项', { n: selected.length })}</div> : null}
    </div>
  );
}
