// FinalCheck 标识（0.32.9）：石墨圆角方牌 + 琥珀单线「FC」，C 的开口里放一个对勾（= Final Check）。
// 与 build/brand/logo.svg（exe / 任务栏图标的源文件）是同一组路径，改一处记得同步另一处。
// 渐变 id 带 useId 前缀：同一页面出现多个 Logo 时 <defs> 不会互相覆盖。
import React, { useId } from 'react';

export const LOGO_GLYPH_PATHS = [
  'M140 362 V196 q0 -44 44 -44 H226', // F 竖笔 + 顶横
  'M140 258 H208',                    // F 中横
  'M392 200 A88 88 0 1 0 374 338',    // C（开口朝右）
  'M356 272 L384 300 L436 240'        // 对勾
];

/** 带底牌的完整标识（标题栏 / 空态 / 关于页） */
export function LogoMark({ size = 20, className = '', title = 'FinalCheck' }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a2a30" />
          <stop offset="1" stopColor="#151518" />
        </linearGradient>
        <linearGradient id={`${id}au`} gradientUnits="userSpaceOnUse" x1="130" y1="130" x2="440" y2="390">
          <stop offset="0" stopColor="#f0d29c" />
          <stop offset="0.55" stopColor="#d9a95c" />
          <stop offset="1" stopColor="#b8843e" />
        </linearGradient>
      </defs>
      <rect x="16" y="16" width="480" height="480" rx="112" fill={`url(#${id}bg)`} />
      <rect x="17.5" y="17.5" width="477" height="477" rx="110.5" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="6" />
      <g fill="none" stroke={`url(#${id}au)`} strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" transform="translate(-14 0)">
        {LOGO_GLYPH_PATHS.map((d) => <path key={d} d={d} />)}
      </g>
    </svg>
  );
}

/** 只有字形、跟随 currentColor（用在已有底色的地方） */
export function LogoGlyph({ size = 16, className = '', strokeWidth = 34 }) {
  return (
    <svg width={size} height={size} viewBox="96 120 352 272" className={className} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" transform="translate(-14 0)">
        {LOGO_GLYPH_PATHS.map((d) => <path key={d} d={d} />)}
      </g>
    </svg>
  );
}
