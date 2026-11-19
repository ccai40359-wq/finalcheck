// 视口宽度：右栏要在「并排」与「浮层」之间切换，必须跟着窗口变化重算。
// 单独抽出来是因为 App.jsx 已经很大，且两个面板共用同一份。
import { useEffect, useState } from 'react';

export function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frame = 0;
    const onResize = () => {
      // rAF 节流：拖动窗口时几十次 resize 只重算一帧
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; setW(window.innerWidth); });
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); if (frame) cancelAnimationFrame(frame); };
  }, []);
  return w;
}
