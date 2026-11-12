import React, { useLayoutEffect, useRef } from 'react';

/**
 * A name on one line, whole: too wide for its box, its text shrinks to fit (down to `minPx`); past
 * that floor it wraps rather than being cut. Never an ellipsis — the DOM twin of TitleBar's fit.
 */
export default function FitText({ text, maxPx = 13, minPx = 8, style }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.whiteSpace = 'nowrap';
    el.style.fontSize = `${maxPx}px`;
    const room = el.clientWidth, need = el.scrollWidth;
    if (room <= 0 || need <= room) return;
    const px = maxPx * room / need;
    if (px >= minPx) el.style.fontSize = `${px}px`;
    else { el.style.fontSize = `${minPx}px`; el.style.whiteSpace = 'normal'; }
  });
  return (
    <span ref={ref} style={{ display: 'block', flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere', ...style }}>{text}</span>
  );
}
