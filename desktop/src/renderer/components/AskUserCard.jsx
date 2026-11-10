// 回合中途提问卡（不是 modal）：插在消息流里，用户点选项或自己输入，回答后本回合继续。
// 状态机：pending（可交互）→ answered / cancelled / expired（只读结果）。
// 实时卡由 App 的 askCards 驱动；历史卡由 assistant.trace 里的 ask_user part 还原（readOnly）。
import React, { useEffect, useState } from 'react';
import { t } from '../i18n/core.mjs';

const STATUS_DONE = new Set(['answered', 'cancelled', 'expired', 'rejected']);

function ResultLine({ payload }) {
  const status = payload.status;
  if (status === 'answered') {
    return (
      <div data-testid="ask-user-result" className="flex items-start gap-2 text-xs leading-relaxed text-ink/85">
        <span className="badge shrink-0 bg-emerald-500/15 text-emerald-300 border border-emerald-500/35">{t('已回答')}</span>
        <span className="min-w-0 break-words">{t('已提交：{answer}', { answer: payload.answer || t('(空)') })}</span>
      </div>
    );
  }
  if (status === 'cancelled') {
    return (
      <div data-testid="ask-user-result" className="flex items-center gap-2 text-xs text-mute/75">
        <span className="badge shrink-0 bg-white/5 text-mute border border-edge">{t('用户取消')}</span>
        <span>{t('本回合已按停止处理')}</span>
      </div>
    );
  }
  if (status === 'rejected') {
    return (
      <div data-testid="ask-user-result" className="flex items-start gap-2 text-xs text-red-300/85">
        <span className="badge shrink-0 bg-red-500/10 text-red-300 border border-red-500/35">{t('提问未发出')}</span>
        <span className="min-w-0 break-words">{payload.error || t('未知原因')}</span>
      </div>
    );
  }
  return (
    <div data-testid="ask-user-result" className="flex items-center gap-2 text-xs text-amber-300/85">
      <span className="badge shrink-0 bg-amber-500/10 text-amber-300 border border-amber-500/35">{t('未回答（已失效）')}</span>
      <span className="text-mute/60">{t('这张提问来自已结束的回合，不能再回答')}</span>
    </div>
  );
}

export default function AskUserCard({ payload, onSubmit = null }) {
  const data = payload || {};
  const status = STATUS_DONE.has(data.status) ? data.status : (data.status === 'pending' ? 'pending' : 'expired');
  const [selected, setSelected] = useState(() => (Array.isArray(data.selected) ? data.selected : []));
  const [text, setText] = useState(() => String(data.text ?? ''));
  const [submitting, setSubmitting] = useState(false);
  const interactive = status === 'pending' && typeof onSubmit === 'function';
  const options = Array.isArray(data.options) ? data.options.slice(0, 6) : [];
  const multi = data.multiSelect === true;

  // 同一张卡被主进程回填（answered/cancelled）或换了 callId 时，重置本地输入
  useEffect(() => {
    setSelected(Array.isArray(data.selected) ? data.selected : []);
    setText(String(data.text ?? ''));
    setSubmitting(false);
  }, [data.callId, data.status]);

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

  return (
    <div data-testid="ask-user-card" data-status={status}
      className="my-3 rounded-xl border border-gold/45 bg-gold/[0.07] px-4 py-3 animate-[fadeIn_.2s_ease]">
      <div className="flex items-center gap-2">
        <span className="badge shrink-0 bg-gold/15 text-goldSoft border border-gold/40">{t('需要你的选择')}</span>
        {multi && status === 'pending' ? <span className="text-[10px] text-mute/60">{t('可多选')}</span> : null}
        {status === 'pending' ? <span className="ml-auto text-[10px] text-mute/45">{t('回答后本回合继续')}</span> : null}
      </div>

      <div className="mt-2 text-sm leading-relaxed text-ink/95 break-words whitespace-pre-wrap">{data.question}</div>

      {status === 'pending' ? (
        <>
          {options.length ? (
            <div className="mt-2.5 flex flex-col gap-1.5">
              {options.map((opt, i) => {
                const label = String(opt?.label ?? '');
                const active = selected.includes(label);
                return (
                  <button key={`${label}-${i}`} type="button" disabled={submitting}
                    data-testid="ask-user-option"
                    onClick={() => onOption(label)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors duration-150 disabled:opacity-50 ${active ? 'border-gold/70 bg-gold/15' : 'border-edge bg-[#0b0b0e] hover:border-gold/50 hover:bg-gold/[0.06]'}`}>
                    <div className="flex items-center gap-2">
                      {multi ? (
                        <span className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[9px] ${active ? 'border-gold bg-gold/80 text-black' : 'border-mute/50 text-transparent'}`}>✓</span>
                      ) : null}
                      <span className="font-medium text-ink/90">{label}</span>
                    </div>
                    {opt?.description ? <div className="mt-0.5 pl-0.5 text-[11px] leading-relaxed text-mute/65">{opt.description}</div> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="mt-2.5 flex items-start gap-2">
            <input type="text" value={text} disabled={submitting}
              data-testid="ask-user-input"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
              placeholder={options.length ? t('也可以直接输入回答…') : t('输入你的回答…')}
              className="min-w-0 flex-1 rounded-lg border border-edge bg-[#0a0a0c] px-3 py-2 text-xs text-ink placeholder:text-mute/40 focus:border-gold/60 focus:outline-none disabled:opacity-50" />
            <button type="button" disabled={submitting || (!selected.length && !text.trim())}
              data-testid="ask-user-submit" onClick={() => void submit()}
              className="btn-primary shrink-0 px-3 py-2 text-xs disabled:opacity-50">
              {submitting ? t('提交中…') : t('提交回答')}
            </button>
          </div>
          {multi && selected.length ? <div className="mt-1.5 text-[10px] text-goldSoft/70">{t('已选 {n} 项', { n: selected.length })}</div> : null}
        </>
      ) : (
        <div className="mt-2.5">
          <ResultLine payload={data} />
        </div>
      )}
    </div>
  );
}
