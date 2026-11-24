// 上下文压缩的「流内分隔线」显示（对齐 Claude Code / ZCode 的观感）：
//   进行中：  ——— Compressing context ———      文字带渐变扫光，表示正在压
//   已完成：  ——— 🗄 Context compressed ———     停下来，图标 + 灰字，长期留在会话里
//   失败：    ——— 压缩失败：… ———              红字，静态不转圈
//
// 为什么从「输入框上方的胶囊」改成「消息流里的分隔线」：
//   压缩是一次**会话事件**，它改变的是这条会话的历史长度，跟输入框没有关系。
//   胶囊挂在输入框上方会随脉冲状的出现/消失让人以为是个临时状态；而 CC/ZCode 都是
//   把它当作一条分隔线插进正文，压缩完成后那条线还在——用户回头翻历史时能看到
//   「这里压过一次」，也就是上下文为什么变短了。
//
// done 态不再靠会话里落库的 notice 兜底：
//   自动压缩（回合开始 / 回合内）**根本不落 notice**（只有手动 /compact 落），
//   老实现「done 不渲染」的结果是自动压缩在界面上完全无痕。这里让 done 自己渲染，
//   渲染条件带「本次会话内」与「同一次压缩只显示一次」的去重，见 App 侧的 state。
import React from 'react';
import { t } from '../i18n/core.mjs';

// 压缩完成后显示多久再淡出（0 = 永不淡出，留在会话里直到切会话/重开）
// 选 0：用户明确要「压缩完就是这样子」持续可见；切会话会自然重置
const DONE_VISIBLE = true;

function Line({ tone = 'mute', children, icon = null }) {
  const bar = tone === 'red' ? 'bg-red-500/25' : tone === 'gold' ? 'bg-gold/25' : 'bg-edge';
  const text = tone === 'red' ? 'text-red-300' : tone === 'gold' ? 'text-goldSoft/90' : 'text-mute/60';
  return (
    <div className="flex items-center gap-3 py-1" data-testid="compaction-line" data-phase={tone}>
      <span className={`h-px flex-1 ${bar}`} />
      <span className={`inline-flex max-w-[80%] items-center gap-1.5 text-[11px] ${text}`}>
        {icon}
        <span className="truncate">{children}</span>
      </span>
      <span className={`h-px flex-1 ${bar}`} />
    </div>
  );
}

function ArchiveIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <path d="M2 3.5h12M3.5 3.5v9.5h9V3.5M6 7h4" stroke="currentColor" strokeWidth="1.2"
        strokeLinecap="round" fill="none" />
    </svg>
  );
}

export default function CompactionStatus({ state, lang = 'zh' }) {
  const phase = state?.phase;
  if (phase !== 'running' && phase !== 'failed' && phase !== 'done') return null;

  if (phase === 'failed') {
    return (
      <div data-testid="compaction-status" data-phase="failed">
        <Line tone="red">{t('压缩失败：{msg}', { msg: state.error || t('未知原因') })}</Line>
      </div>
    );
  }

  if (phase === 'done') {
    if (!DONE_VISIBLE) return null;
    // 有 token 数就给出来（「16.2万 → 2.9万」），没有就只说压缩完了
    const before = Number(state.before);
    const after = Number(state.after);
    const detail = Number.isFinite(before) && before > 0 && Number.isFinite(after) && after > 0
      ? ` · ${fmtTokens(before)} → ${fmtTokens(after)}`
      : '';
    return (
      <div data-testid="compaction-status" data-phase="done">
        <Line tone="mute" icon={<ArchiveIcon />}>
          {t('上下文已压缩')}{detail}
        </Line>
      </div>
    );
  }

  // running：文字带渐变扫光（.fc-compact-sweep），120ms 延迟出现避免瞬时压缩闪一下
  return (
    <div data-testid="compaction-status" data-phase="running" className="fc-compact-appear">
      <Line tone="gold">
        <span className="fc-compact-sweep tracking-wide">{t('正在压缩上下文…')}</span>
      </Line>
    </div>
  );
}

// 与上下文面板同口径的紧凑数字（16.2万 / 2.9万），避免两处显示不一致
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}
