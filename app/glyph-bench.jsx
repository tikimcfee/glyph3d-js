// glyph-bench — a minimal page that boots the REAL WebGPU glyph renderer and
// runs our bench codec in the browser. Not the IDE: just the renderer + our map.
//
// Pass 1 (this file): boot the real renderer, render text RECONSTRUCTED FROM THE
//   MAP (encode → pack → unpack → decodeSource), and show codec stats. This
//   proves (a) the minimal real-render harness works and (b) the codec runs in
//   the browser and round-trips. The text is still re-shaped by the renderer.
// Pass 2 (next): drive the GPU directly from the map's slot stream via
//   GlyphField.applyPrebuiltBuffers — the real "map → GPU" gears.
import React, { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { useGlyphEngine, GlyphCanvas, CodeGrid, ViewerCamera } from '@glyph3d/r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
import mesloUrl from '@glyph3d/core/fonts/MesloLGS-NF-Mono.ttf?url';
import dejavuUrl from '@glyph3d/core/fonts/DejaVuSans.ttf?url';
import { encode, pack, unpack, decodeSource, sizes } from '../_experiments/glyph-encoding/codec.js';

const FONT_CHAIN = [
  { url: fontUrl, name: 'Cousine' },
  { url: mesloUrl, name: 'MesloLGS NF Mono' },
  { url: dejavuUrl, name: 'DejaVu Sans' },
];

const SAMPLE = `// rendered from the glyph-encoding MAP, by the real WebGPU renderer.
export function fib(n) {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

const memo = new Map();
export function fibMemo(n) {
  if (n < 2) return n;
  if (memo.has(n)) return memo.get(n);
  const v = fibMemo(n - 1) + fibMemo(n - 2);
  memo.set(n, v);
  return v;
}`;

const overlay = {
  position: 'fixed', top: 8, left: 8, zIndex: 10, maxWidth: 640,
  font: '12px/1.5 ui-monospace, monospace', color: '#cde',
  background: 'rgba(10,12,16,0.82)', padding: '10px 12px', borderRadius: 6, border: '1px solid #243',
};

function App() {
  const { atlas, stage, error } = useGlyphEngine({
    fontUrl, fonts: FONT_CHAIN, fontSize: 48, atlasSize: 2048,
  });

  // Run the codec in the browser, through the actual packed bytes.
  const m = useMemo(() => {
    const map = unpack(pack(encode(SAMPLE)));
    const text = decodeSource(map);
    return { text, ok: text === SAMPLE, sz: sizes(SAMPLE, map, pack(map)) };
  }, []);

  return (
    <>
      <div style={overlay}>
        <div><b>glyph-encoding bench — real WebGPU renderer</b></div>
        <div>engine: {error ? `ERROR: ${String(error)}` : stage}</div>
        <div>codec in-browser: round-trip {m.ok ? 'OK ✓' : 'FAIL ✗'} · {m.sz.glyphs} glyphs, {m.sz.distinct} distinct</div>
        <div>map {(m.sz.mapBytes / 1024).toFixed(1)}k vs real GPU instance buffer {(m.sz.current / 1024).toFixed(1)}k ({(m.sz.current / m.sz.mapBytes).toFixed(1)}×)</div>
        <div style={{ color: '#8a9', marginTop: 6 }}>
          Below: text reconstructed FROM the map, drawn by the real renderer (still re-shaped).
          Pass 2 = drive the GPU from the map's slot stream directly. Drag to orbit, scroll to zoom.
        </div>
      </div>
      {atlas && (
        <div style={{ position: 'fixed', inset: 0 }}>
          <GlyphCanvas atlas={atlas} camera={{ position: [40, -20, 90], fov: 70, near: 0.1, far: 20000 }}>
            <ViewerCamera />
            <CodeGrid text={m.text} filename="via-map" position={[0, 0, 0]} textColor={{ r: 0.6, g: 0.9, b: 0.7 }} />
          </GlyphCanvas>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
