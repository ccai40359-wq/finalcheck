// 「恢复文件到这条消息之前」确认框（0.33.0）：先列出会动哪些文件、怎么动，用户确认后才执行。
import React from 'react';
import { t } from '../i18n/core.mjs';

const ACTION = {
  restore: { label: '恢复', cls: 'text-goldSoft border-gold/35 bg-gold/[0.07]' },
  delete: { label: '删除（AI 新建的）', cls: 'text-red-300 border-red-500/35 bg-red-500/[0.07]' },
  unavailable: { label: '无法恢复', cls: 'text-mute border-edge/60 bg-well' },
  noop: { label: '已不存在', cls: 'text-mute border-edge/60 bg-well' }
};

export default function RewindFilesDialog({ state, onConfirm, onClose }) {
  if (!state) return null;
  const { plan, loading, applying, result, error } = state;
  const files = plan?.files || [];
  const actionable = files.filter((f) => f.action === 'restore' || f.action === 'delete').length;
  const short = (p) => {
    const s = String(p || '').replace(/\\/g, '/');
    return s.length > 64 ? '…' + s.slice(-63) : s;
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]" onClick={() => !applying && onClose()}>
      <div className="glass-pop w-[520px] max-w-[92vw] rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="fc-title text-base">{t('恢复文件到这条消息之前')}</div>
        <div className="mt-1.5 text-[12px] text-mute leading-relaxed">
          {t('把 AI 在这条消息之后用 edit_file / write_file 改过的文件恢复原样。对话本身不变；run_command、子代理和你自己手改的文件不在范围内。')}
        </div>
        {loading && <div className="mt-4 text-[12px] text-mute">{t('正在计算…')}</div>}
        {error && <div className="mt-4 text-[12px] text-red-300">{error}</div>}
        {!loading && plan && files.length === 0 && (
          <div className="mt-4 text-[12px] text-mute">{t('这条消息之后 AI 没有改过文件，没有需要恢复的。')}</div>
        )}
        {files.length > 0 && (
          <div className="mt-3 max-h-72 overflow-y-auto space-y-1 pr-1">
            {files.map((f) => {
              const done = result?.results?.find((r) => r.path === f.path);
              const a = ACTION[f.action] || ACTION.unavailable;
              return (
                <div key={f.path} className="flex items-center gap-2 rounded-lg border border-edge/50 bg-well/50 px-2.5 py-1.5">
                  <span className={`shrink-0 rounded-md border px-1.5 py-[1px] text-[10px] ${a.cls}`}>{t(a.label)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink/85" title={f.path}>{short(f.path)}</span>
                  {f.reason && !done && <span className="shrink-0 text-[10px] text-mute/70" title={f.reason}>{t(f.reason)}</span>}
                  {done && <span className={`shrink-0 text-[10px] ${done.ok ? 'text-jade' : 'text-red-300'}`}>{done.ok ? '✓' : (done.error || t('失败'))}</span>}
                </div>
              );
            })}
          </div>
        )}
        {result && (
          <div className="mt-3 text-[12px] text-ink/90">
            {t('已恢复 {r} 个、删除 {d} 个文件', { r: result.restored, d: result.deleted })}{result.failed ? t('，{n} 个失败', { n: result.failed }) : ''}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} disabled={applying} className="btn-ghost px-3.5 py-1.5 text-xs">{result ? t('关闭') : t('取消')}</button>
          {!result && (
            <button onClick={onConfirm} disabled={loading || applying || actionable === 0} className="btn-primary px-3.5 py-1.5 text-xs">
              {applying ? t('恢复中…') : t('恢复 {n} 个文件', { n: actionable })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
