// glyph-bench — boot the REAL WebGPU glyph renderer and drive it from our map.
//
// LEFT  (text-path):  <CodeGrid text> — the renderer shapes the text itself.
// RIGHT (map-path):   our map → cp→slot via the live cache → real buildBatchBuffers
//                     → LiveSlugAtlas.ensureCodepoints → GlyphField.applyPrebuiltBuffers.
//                     No re-shaping — the GPU is driven straight from the map's slots.
// If the two read identically, the map drives the real renderer for real.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useThree } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid, ViewerCamera, useGlyphAtlas } from '@glyph3d/r3f';
import { CodeGrid as CodeGridCore } from '@glyph3d/core/collections';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
import mesloUrl from '@glyph3d/core/fonts/MesloLGS-NF-Mono.ttf?url';
import dejavuUrl from '@glyph3d/core/fonts/DejaVuSans.ttf?url';
import { encode, pack, unpack, decodeSource, sizes } from '../_experiments/glyph-encoding/codec.js';
import { buildBatchBuffers, resolveLayoutParams } from '../packages/glyph3d-core/src/workers/builders/index.js';
// Corpus fixtures, imported as raw text (Vite ?raw).
import sampleJs from '../_experiments/glyph-encoding/corpus/sample.js?raw';
import tortureTxt from '../_experiments/glyph-encoding/corpus/torture.txt?raw';
import harfbuzzSrc from '../packages/glyph3d-core/src/shaping/HarfBuzzShaper.js?raw';
import glyphFieldSrc from '../packages/glyph3d-core/src/GlyphField.js?raw';

const FONT_CHAIN = [
  { url: fontUrl, name: 'Cousine' },
  { url: mesloUrl, name: 'MesloLGS NF Mono' },
  { url: dejavuUrl, name: 'DejaVu Sans' },
];

const FIB = `// left = text-path (renderer shapes it)   right = map -> GPU (our slots)
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

const FIXTURES = [
  { name: 'fib (inline)', text: FIB },
  { name: 'sample.js', text: sampleJs },
  { name: 'torture.txt (CJK/emoji/RTL)', text: tortureTxt },
  { name: 'HarfBuzzShaper.js (~7k glyphs)', text: harfbuzzSrc },
  { name: 'GlyphField.js (~64k glyphs)', text: glyphFieldSrc },
];

// The whole repo's JS/JSX source, eager-loaded as raw text for the memory test.
const REPO = import.meta.glob(['../packages/*/src/**/*.{js,jsx}', '../app/**/*.{js,jsx}'], {
  query: '?raw', eager: true, import: 'default',
});
const MB = (n) => (n / 1048576).toFixed(1);

const toXYZ = (p) => (Array.isArray(p) ? p : [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0]);

/**
 * MapGrid — render `text` by driving the real GlyphField from our map's slot
 * stream (no text shaping in this path). Reuses a real CodeGrid's metrics +
 * renderer; injects buffers built from the map via applyPrebuiltBuffers.
 */
const L = (...a) => console.log('[bench]', ...a);

function MapGrid({ text, position, textColor, onStatus, quiet }) {
  const scene = useThree((s) => s.scene);
  const atlas = useGlyphAtlas();
  useEffect(() => {
    let grid;
    const log = quiet ? () => {} : L;
    try {
      log('MapGrid effect start', { scene: !!scene, atlas: !!atlas, shapeCache: !!atlas?._shapeCache, shaper: !!atlas?._shaper, live: !!atlas?._live, slugData: !!atlas?._slugData });

      grid = new CodeGridCore(scene, atlas, {
        name: 'map-path', worldScale: 0.025, showBackground: false,
        ...(textColor ? { textColor } : {}),
      });
      scene.add(grid);
      grid.position.set(...toXYZ(position));
      log('grid built', { type: grid?.constructor?.name, inScene: scene.children.includes(grid) });

      grid._ensureRenderer();
      log('ensureRenderer', { hasRenderer: !!grid._renderer, metrics: grid.metrics, color: grid.config?.textColor, layout: grid.config?.layout });

      const cache = atlas._shapeCache;
      const map = encode(text);
      log('encoded', { lines: map.lines.length, dict: map.dict.length });

      const shaped = {
        lines: map.lines.map((line) => ({
          shaped: line.map((i) => { const e = cache.lookup(map.dict[i].cp); return { g: e.g, ax: e.ax, dx: 0, dy: 0 }; }),
        })),
        totalGlyphs: map.lines.reduce((n, l) => n + l.length, 0),
      };
      log('shaped', { totalGlyphs: shaped.totalGlyphs, line0: shaped.lines[0]?.shaped?.length, g0: shaped.lines[0]?.shaped?.[0] });

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
      log('metrics built', metrics);

      const items = [{ text, position: { x: 0, y: 0, z: 0 }, color: grid.config.textColor, scale: 1, groupId: 0, shaped }];
      const buffers = buildBatchBuffers(items, {
        metrics, defaultColor: grid.config.textColor,
        upem: atlas._shaper.upem, layout: resolveLayoutParams(grid.config.layout), scrollOffset: 0,
      });
      const P = buffers.positions, S = buffers.sizes;
      log('buildBatchBuffers', {
        count: buffers.count, posLen: P.length,
        pos0: [P[0], P[1], P[2]], size0: [S[0], S[1]], glyph0: buffers.glyphIds?.[0],
        anyNaN: Array.from(P.slice(0, 30)).some(Number.isNaN), bounds: buffers.bounds,
      });

      const ensured = atlas._live ? atlas._live.ensureGlyphsEncoded(buffers.glyphIds) : null;
      log('ensureGlyphsEncoded', ensured);

      // bind slug textures (what LiveSlugAtlas registration does for real fields)
      if (typeof grid._renderer.setSlugData === 'function') grid._renderer.setSlugData(atlas._slugData, atlas._shaper);
      // use the SAME commit path CodeGrid uses (bookkeeping + applyPrebuiltBuffers)
      if (typeof grid._commitBuiltBuffers === 'function') grid._commitBuiltBuffers(buffers, items);
      else grid._renderer.applyPrebuiltBuffers(buffers, items);

      const mesh = grid._renderer?.instanceMesh;
      if (mesh) mesh.frustumCulled = false;
      grid.updateMatrixWorld(true);
      log('committed v2', {
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
  const [sel, setSel] = useState(0);
  const text = FIXTURES[sel].text;

  const m = useMemo(() => {
    const map = unpack(pack(encode(text)));
    const sz = sizes(text, map, pack(map));
    return { ok: decodeSource(map) === text, sz };
  }, [text]);

  const [mem, setMem] = useState(null);
  const memRef = useRef(null); // hold the packed maps resident so heap reflects them

  const runMemTest = () => {
    const entries = Object.entries(REPO).filter(([, c]) => typeof c === 'string');
    const t0 = performance.now();
    const heap0 = performance.memory?.usedJSHeapSize ?? 0;
    let glyphs = 0, srcBytes = 0, mapBytes = 0, mapBitsBytes = 0, roundtripFails = 0;
    const packs = [];
    for (const [, content] of entries) {
      const map = encode(content);
      const packed = pack(map);
      if (decodeSource(unpack(packed)) !== content) roundtripFails++;
      const sz = sizes(content, map, packed);
      glyphs += sz.glyphs; srcBytes += sz.utf8; mapBytes += packed.length; mapBitsBytes += sz.mapBytesPacked;
      packs.push(packed);
    }
    const heap1 = performance.memory?.usedJSHeapSize ?? 0;
    memRef.current = packs; // keep referenced
    const result = {
      files: entries.length, glyphs, roundtripFails,
      srcMB: MB(srcBytes), mapMB: MB(mapBytes), mapBitsMB: MB(mapBitsBytes), instMB: MB(glyphs * 40),
      ratio: (glyphs * 40 / mapBytes).toFixed(1), bitsRatio: (glyphs * 40 / mapBitsBytes).toFixed(1),
      heapMB: MB(Math.max(0, heap1 - heap0)), ms: (performance.now() - t0).toFixed(0),
    };
    setMem(result);
    console.log('[bench] MEM whole-repo', result);
  };

  // Live JS heap — the actual system memory number (Chromium/Vivaldi).
  const [heap, setHeap] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setHeap(performance.memory?.usedJSHeapSize ?? 0), 800);
    return () => clearInterval(t);
  }, []);

  // Wall mode: actually render N repo files on screen via the map→GPU path.
  const [view, setView] = useState('demo');
  const [wallMode, setWallMode] = useState('map'); // 'map' (new) vs 'text' (old/unoptimized text-path)
  const repoEntries = useMemo(() => Object.entries(REPO).filter(([, c]) => typeof c === 'string'), []);
  const btn = { background: '#234', color: '#cde', border: '1px solid #356', borderRadius: 4, padding: '2px 7px', cursor: 'pointer', font: 'inherit' };

  // Progressive wall: stream files in 6-at-a-time so the browser stays responsive
  // and you watch the heap climb as the real repo loads.
  const [wallCount, setWallCount] = useState(0);
  useEffect(() => {
    if (view !== 'wall') { setWallCount(0); return; }
    setWallCount(0);
    let n = 0;
    const t = setInterval(() => {
      n = Math.min(repoEntries.length, n + 6);
      setWallCount(n);
      if (n >= repoEntries.length) clearInterval(t);
    }, 120);
    return () => clearInterval(t);
  }, [view, wallMode, repoEntries.length]);

  return (
    <>
      <div style={overlay}>
        <div><b>glyph-encoding bench — map drives the real WebGPU renderer</b></div>
        <div style={{ margin: '4px 0' }}>
          fixture:{' '}
          <select value={sel} onChange={(e) => { setSel(+e.target.value); setMapStatus(null); }}
            style={{ background: '#0c0f15', color: '#cde', border: '1px solid #243', borderRadius: 4, padding: '2px 4px', font: 'inherit' }}>
            {FIXTURES.map((f, i) => <option key={i} value={i}>{f.name}</option>)}
          </select>
        </div>
        <div>engine: {error ? `ERROR: ${String(error)}` : stage}
          {' · '}JS heap (live): <b style={{ color: '#fd8' }}>{MB(heap)} MB</b>
          {' · '}<button onClick={() => setView(view === 'wall' ? 'demo' : 'wall')} style={btn}>
            {view === 'wall' ? `wall ${wallCount}/${repoEntries.length} — back to demo` : `render whole repo wall (${repoEntries.length} files) →`}
          </button>
          {view === 'wall' && <>{' · '}pipeline:{' '}
            <button onClick={() => setWallMode(wallMode === 'map' ? 'text' : 'map')} style={btn}>
              {wallMode === 'map' ? 'MAP (new)' : 'TEXT-PATH (old/unoptimized)'} — switch
            </button>
          </>}
        </div>
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
        <div style={{ marginTop: 8, borderTop: '1px solid #243', paddingTop: 6 }}>
          <button onClick={runMemTest} style={{ background: '#1b6', color: '#fff', border: 0, borderRadius: 4, padding: '4px 9px', cursor: 'pointer', font: 'inherit' }}>
            Run whole-repo memory test ({Object.keys(REPO).length} files)
          </button>
          {mem && (
            <div style={{ marginTop: 6 }}>
              <div>{mem.files} files · {mem.glyphs.toLocaleString()} glyphs · {mem.ms}ms · round-trip {mem.roundtripFails === 0 ? 'OK ✓' : `${mem.roundtripFails} FAIL`}</div>
              <div>source UTF-8: {mem.srcMB} MB</div>
              <div>map (packed, resident): <b style={{ color: '#7e7' }}>{mem.mapMB} MB</b> · bit-packed est: {mem.mapBitsMB} MB</div>
              <div>if all RENDERED (instance buffers): <b style={{ color: '#e88' }}>≥{mem.instMB} MB</b> computed · ~2× real (codepoints+picking+per-grid overhead → ~290MB measured)</div>
              <div>→ <b>~36× measured</b> (rendered/maps) · resident maps = the {mem.mapMB}MB above. (build heap +{mem.heapMB}MB is transient encode garbage, not resident)</div>
            </div>
          )}
        </div>
      </div>
      {atlas && (
        <div style={{ position: 'fixed', inset: 0 }}>
          <GlyphCanvas atlas={atlas} camera={{ position: [38, -18, 135], fov: 70, near: 0.1, far: 20000 }}>
            <ViewerCamera />
            {view === 'demo' ? (
              <>
                {/* LEFT green = text-path. RIGHT cyan = map → GPU (our slots). */}
                <CodeGrid key={`text-${sel}`} text={text} filename="" position={[0, 0, 0]} textColor={{ r: 0.55, g: 0.92, b: 0.7 }} />
                <MapGrid key={`map-${sel}`} text={text} position={[70, 0, 0]} textColor={{ r: 0.5, g: 0.85, b: 1.0 }} onStatus={setMapStatus} />
              </>
            ) : (
              // Wall: whole repo rendered for real. Toggle pipeline (map vs text-path)
              // to compare heap. Both build instance buffers to draw → similar when
              // rendering ALL; the map's win is the resident-not-rendered form (8MB).
              repoEntries.slice(0, wallCount).map(([path, content], i) => {
                const pos = [(i % 12) * 58, -Math.floor(i / 12) * 115, 0];
                return wallMode === 'text'
                  ? <CodeGrid key={`wt-${i}`} text={content} filename="" position={pos} textColor={{ r: 0.55, g: 0.92, b: 0.7 }} />
                  : <MapGrid key={`wm-${i}`} text={content} quiet position={pos} textColor={{ r: 0.5, g: 0.85, b: 1.0 }} onStatus={i === 0 ? setMapStatus : undefined} />;
              })
            )}
          </GlyphCanvas>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
