// 空态：能力卡（直接对应产品功能，不硬编码路径）+ 示例体检的一键演示。
// 展示与演示逻辑原先内联在 App；demoBusy / messages 等状态仍由 App 持有，这里只调回调。
import React from 'react';
import { t } from '../i18n/core.mjs';
import { CAPABILITIES, formatDemoAuditSummary } from '../lib/app-helpers.mjs';
import { CAP_ICON, IconSparkle } from './Icons.jsx';
import { LogoMark } from './Logo.jsx';

export default function EmptyState({ y, demoBusy, setDemoBusy, setMessages, setInput, inputRef }) {
  // 示例一键演示：demoPath() → 现有 audit IPC（L2）→ 把摘要作为一条本地 assistant 消息展示
  const pushNotice = (content) => setMessages((prev) => [...prev, { role: 'notice', content }]);
  const runDemoAudit = async () => {
    if (!y || demoBusy) return;
    if (!y.demoPath) { pushNotice(t('示例项目未随包发布')); return; }
    setDemoBusy(true);
    let phase = 'demo';
    try {
      const p = await y.demoPath();
      const dir = typeof p === 'string' ? p : (p && typeof p === 'object' && !p.error ? (p.path || p.dir || null) : null);
      if (!dir) { pushNotice(t('示例项目未随包发布')); return; }
      if (!y.audit) { pushNotice(t('当前版本不支持体检调用')); return; }
      phase = 'audit';
      const r = await y.audit(dir, { tier: 'L2', interactive: true });
      setMessages((prev) => [...prev, { role: 'assistant', content: formatDemoAuditSummary(r, dir), trace: [], local: true }]);
    } catch (e) {
      if (phase === 'demo') pushNotice(t('示例项目未随包发布'));
      else pushNotice(t('示例体检失败：{msg}', { msg: e?.message || String(e) }));
    } finally {
      setDemoBusy(false);
    }
  };
  const pickSuggestion = (s) => {
    setInput(s);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6">
      <div className="min-h-full flex flex-col items-center justify-center py-10">
        <LogoMark size={52} className="mb-5 drop-shadow-[0_8px_24px_rgba(0,0,0,0.35)] animate-[fadeIn_.4s_ease]" />
        <div className="text-[28px] font-semibold tracking-[-0.01em] text-ink mb-2">Final<span className="text-mute">Check</span></div>
        <p className="text-[13px] text-mute mb-9">{t('体检 · 渗透 · 下载闸 · 工作流 —— 选一个，或直接说')}</p>
        <div className="w-full max-w-2xl grid grid-cols-2 gap-2.5">
          {CAPABILITIES.map((c) => {
            const Icon = CAP_ICON[c.icon] || IconSparkle;
            const isDemo = c.id === 'demo';
            return (
              <button key={c.id} onClick={() => (isDemo ? runDemoAudit() : pickSuggestion(t(c.prompt)))}
                disabled={isDemo && demoBusy}
                className="glass-row group flex items-start gap-3 rounded-2xl px-3.5 py-3 text-left disabled:opacity-50">
                <span className="shrink-0 h-8 w-8 rounded-[10px] flex items-center justify-center bg-lift/[0.06] text-mute group-hover:text-goldSoft group-hover:bg-gold/[0.10] transition-colors duration-200"><Icon /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium text-ink/90">{t(c.title)}</span>
                    <span className="text-[10px] text-mute/45">{c.en}</span>
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-mute/80">
                    {isDemo && demoBusy ? t('体检中…示例项目 L2 正在跑') : t(c.desc)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
