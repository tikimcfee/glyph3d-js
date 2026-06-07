// glyph-bench — boot the REAL WebGPU glyph renderer and drive it from our map.
//
// LEFT  (text-path):  <CodeGrid text> — the renderer shapes the text itself.
// RIGHT (map-path):   our map → cp→slot via the live cache → real buildBatchBuffers
//                     → LiveSlugAtlas.ensureCodepoints → GlyphField.applyPrebuiltBuffers.
//                     No re-shaping — the GPU is driven straight from the map's slots.
// If the two read identically, the map drives the real renderer for real.
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useThree } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid, ViewerCamera, useGlyphAtlas } from '@glyph3d/r3f';
import { CodeGrid as CodeGridCore } from '@glyph3d/core/collections';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
import mesloUrl from '@glyph3d/core/fonts/MesloLGS-NF-Mono.ttf?url';
import dejavuUrl from '@glyph3d/core/fonts/DejaVuSans.ttf?url';
import { encode, pack, unpack, decodeSource, sizes } from '../_experiments/glyph-encoding/codec.js';
import { buildBatchBuffers, resolveLayoutParams } from '../packages/glyph3d-core/src/workers/builders/index.js';

const FONT_CHAIN = [
  { url: fontUrl, name: 'Cousine' },
  { url: mesloUrl, name: 'MesloLGS NF Mono' },
  { url: dejavuUrl, name: 'DejaVu Sans' },
];

const SAMPLE = `// left = text-path (renderer shapes it)   right = map -> GPU (our slots)
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
  return (memo.set(n, v), v);
}`;

const toXYZ = (p) => (Array.isArray(p) ? p : [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0]);

/**
 * MapGrid — render `text` by driving the real GlyphField from our map's slot
 * stream (no text shaping in this path). Reuses a real CodeGrid's metrics +
 * renderer; injects buffers built from the map via applyPrebuiltBuffers.
 */
const L = (...a) => console.log('[bench]', ...a);

function MapGrid({ text, position, textColor, onStatus }) {
  const scene = useThree((s) => s.scene);
  const atlas = useGlyphAtlas();
  useEffect(() => {
    let grid;
    try {
      L('MapGrid effect start', { scene: !!scene, atlas: !!atlas, shapeCache: !!atlas?._shapeCache, shaper: !!atlas?._shaper, live: !!atlas?._live, slugData: !!atlas?._slugData });

      grid = new CodeGridCore(scene, atlas, {
        name: 'map-path', worldScale: 0.025, showBackground: false,
        ...(textColor ? { textColor } : {}),
      });
      scene.add(grid);
      grid.position.set(...toXYZ(position));
      L('grid built', { type: grid?.constructor?.name, inScene: scene.children.includes(grid) });

      grid._ensureRenderer();
      L('ensureRenderer', { hasRenderer: !!grid._renderer, metrics: grid.metrics, color: grid.config?.textColor, layout: grid.config?.layout });

      const cache = atlas._shapeCache;
      const map = encode(text);
      L('encoded', { lines: map.lines.length, dict: map.dict.length });

      const shaped = {
        lines: map.lines.map((line) => ({
          shaped: line.map((i) => { const e = cache.lookup(map.dict[i].cp); return { g: e.g, ax: e.ax, dx: 0, dy: 0 }; }),
        })),
        totalGlyphs: map.lines.reduce((n, l) => n + l.length, 0),
      };
      L('shaped', { totalGlyphs: shaped.totalGlyphs, line0: shaped.lines[0]?.shaped?.length, g0: shaped.lines[0]?.shaped?.[0] });

      // Build the metrics the builder actually wants — the SAME object CodeGrid
      // assembles in _prepareAddsForBuild (lineSpacing/pixel*/worldScale), NOT
      // grid.metrics from _computeMetrics (which lacks lineSpacing → NaN Y).
      const cs = atlas.getCharSize();
      const scale = grid.config.worldScale;
      const metrics = {
        charWidth: cs.width * scale, charHeight: cs.height * scale,
        letterSpacing: cs.width * scale * 0.05, lineSpacing: cs.height * scale * 1.2,
        worldScale: scale, atlasSize: atlas.getAtlasTexture().width,
        pixelWidth: cs.width, pixelHeight: cs.height,
      };
      L('metrics built', metrics);

      const items = [{ text, position: { x: 0, y: 0, z: 0 }, color: grid.config.textColor, scale: 1, groupId: 0, shaped }];
      const buffers = buildBatchBuffers(items, {
        metrics, defaultColor: grid.config.textColor,
        upem: atlas._shaper.upem, layout: resolveLayoutParams(grid.config.layout), scrollOffset: 0,
      });
      const P = buffers.positions, S = buffers.sizes;
      L('buildBatchBuffers', {
        count: buffers.count, posLen: P.length,
        pos0: [P[0], P[1], P[2]], size0: [S[0], S[1]], glyph0: buffers.glyphIds?.[0],
        anyNaN: Array.from(P.slice(0, 30)).some(Number.isNaN), bounds: buffers.bounds,
      });

      const ensured = atlas._live ? atlas._live.ensureGlyphsEncoded(buffers.glyphIds) : null;
      L('ensureGlyphsEncoded', ensured);

      // bind slug textures (what LiveSlugAtlas registration does for real fields)
      if (typeof grid._renderer.setSlugData === 'function') grid._renderer.setSlugData(atlas._slugData, atlas._shaper);
      // use the SAME commit path CodeGrid uses (bookkeeping + applyPrebuiltBuffers)
      if (typeof grid._commitBuiltBuffers === 'function') grid._commitBuiltBuffers(buffers, items);
      else grid._renderer.applyPrebuiltBuffers(buffers, items);

      const mesh = grid._renderer?.instanceMesh;
      if (mesh) mesh.frustumCulled = false;
      grid.updateMatrixWorld(true);
      L('committed v2', {
        instanceCount: mesh?.geometry?.instanceCount, meshVisible: mesh?.visible, meshParent: mesh?.parent?.type,
        pos0: `${P[0]?.toFixed(2)},${P[1]?.toFixed(2)},${P[2]?.toFixed(2)}`,
        size0: `${S[0]?.toFixed(3)}x${S[1]?.toFixed(3)}`,
        gridScale: grid.scale.toArray().join(','),
        rgScale: grid._rendererGroup?.scale?.toArray?.().join(','),
        meshScale: mesh?.scale?.toArray?.().join(','),
        curveTex: !!(grid._renderer._curveTexture || grid._renderer._curveTexUniform?.value),
        glyphMapTex: !!(grid._renderer._glyphMapTexture || grid._renderer._glyphMapTexUniform?.value),
        bSphere: mesh?.geometry?.boundingSphere?.radius?.toFixed?.(1),
        meshWorldXY: mesh ? `${mesh.matrixWorld.elements[12].toFixed(1)},${mesh.matrixWorld.elements[13].toFixed(1)}` : null,
      });

      onStatus?.({
        ok: true, glyphs: buffers.count, ensured,
        detail: `pos0(${P[0]?.toFixed(1)},${P[1]?.toFixed(1)},${P[2]?.toFixed(1)}) size0(${S[0]?.toFixed(2)},${S[1]?.toFixed(2)}) ` +
          `iCount=${mesh?.geometry?.instanceCount} meshInScene=${!!mesh?.parent}`,
      });
    } catch (e) {
      onStatus?.({ ok: false, error: String(e?.stack || e) });
      console.error('[bench] MapGrid FAILED:', e);
    }
    return () => { if (grid) { scene.remove(grid); grid.dispose?.(); } };
  }, [scene, atlas, text]);
  return null;
}

const overlay = {
  position: 'fixed', top: 8, left: 8, zIndex: 10, maxWidth: 680,
  font: '12px/1.55 ui-monospace, monospace', color: '#cde',
  background: 'rgba(10,12,16,0.82)', padding: '10px 12px', borderRadius: 6, border: '1px solid #243',
};

function App() {
  const { atlas, stage, error } = useGlyphEngine({ fontUrl, fonts: FONT_CHAIN, fontSize: 48, atlasSize: 2048 });
  console.log('[bench] App render', { atlas: !!atlas, stage, error: error ? String(error) : null });
  const [mapStatus, setMapStatus] = useState(null);

  const m = useMemo(() => {
    const map = unpack(pack(encode(SAMPLE)));
    const sz = sizes(SAMPLE, map, pack(map));
    return { ok: decodeSource(map) === SAMPLE, sz };
  }, []);

  return (
    <>
      <div style={overlay}>
        <div><b>glyph-encoding bench — map drives the real WebGPU renderer</b></div>
        <div>engine: {error ? `ERROR: ${String(error)}` : stage}</div>
        <div>codec in-browser: round-trip {m.ok ? 'OK ✓' : 'FAIL ✗'} · {m.sz.glyphs} glyphs, {m.sz.distinct} distinct · map {(m.sz.mapBytes / 1024).toFixed(1)}k vs GPU buf {(m.sz.current / 1024).toFixed(1)}k ({(m.sz.current / m.sz.mapBytes).toFixed(1)}×)</div>
        <div style={{ color: mapStatus && !mapStatus.ok ? '#f88' : '#cde' }}>map → GPU: {
          !mapStatus ? '…' :
          mapStatus.ok ? `applyPrebuiltBuffers OK ✓ · ${mapStatus.glyphs} glyphs · ${mapStatus.detail}${mapStatus.ensured ? ` · ensured +${mapStatus.ensured.added}` : ''}` :
          `FAILED ✗: ${(mapStatus.error || '').split('\n').slice(0, 2).join('  |  ').slice(0, 260)}`
        }</div>
        <div style={{ color: '#8a9', marginTop: 6 }}>
          LEFT green = text-path (renderer shapes it). RIGHT cyan = map → GPU (our slots, no re-shape).
          Same code on both = the map drives the renderer. Drag orbit · scroll zoom.
        </div>
      </div>
      {atlas && (
        <div style={{ position: 'fixed', inset: 0 }}>
          <GlyphCanvas atlas={atlas} camera={{ position: [40, -20, 90], fov: 70, near: 0.1, far: 20000 }}>
            <ViewerCamera />
            {/* map-path ONLY, at the known-good origin from pass 1 — is the GPU driven by the map? */}
            <MapGrid text={SAMPLE} position={[0, 0, 0]} textColor={{ r: 0.5, g: 0.85, b: 1.0 }} onStatus={setMapStatus} />
          </GlyphCanvas>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
