import React from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { GlyphProvider } from './context.jsx';

/**
 * GlyphCanvas — an r3f <Canvas> wired for the WebGPU GlyphField stack.
 *
 * The load-bearing detail is sizing the canvas BEFORE the WebGPU renderer is
 * constructed. Root cause (from r3f's source + three's WebGPU backend): r3f waits
 * for a non-zero measured container, then `await`s the async `gl` factory, then
 * applies the size via setSize. But three's WebGPU `CanvasTarget` builds its
 * depth + MSAA render targets from `canvas.width/height` AT CONSTRUCTION — which,
 * inside the factory, is still the HTML default 300×150 — and it does NOT rebuild
 * them on the later setSize (only on a real resize *event*). So the targets
 * freeze at 300×150 while the color attachment tracks the real size: a permanent
 * "attachment size does not match" (fatal on HiDPI). It's exactly why a manual
 * window resize "fixes" it — the resize event finally triggers the rebuild.
 *
 * Fix: bake the canvas backing size in up front — from the PARENT container that
 * r3f has already measured (reading the canvas itself feeds back from the backing
 * we're setting → a runaway loop), times a pinned dpr so r3f's later setSize lands
 * on the exact same size and there's nothing to rebuild.
 *
 * @param {object} props
 * @param {number} [props.toneMapping] - THREE tone-mapping constant. Default NoToneMapping.
 * @param {number} [props.dpr] - Device pixel ratio. Defaults to clamped window.devicePixelRatio.
 * @param {(renderer, props) => void} [props.onRenderer] - Hook after init().
 * @param {import('@glyph3d/core').GlyphAtlas} props.atlas - Ready atlas from bootGlyphEngine.
 */
export default function GlyphCanvas({
  atlas,
  toneMapping = THREE.NoToneMapping,
  onRenderer,
  dpr,
  children,
  ...canvasProps
}) {
  // Pin dpr so the size we bake into the canvas matches exactly what r3f applies
  // afterward (otherwise depth/color diverge by the dpr factor — the HiDPI bug).
  const resolvedDpr = dpr ?? (typeof window !== 'undefined'
    ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2) : 1);

  return (
    <Canvas
      {...canvasProps}
      dpr={resolvedDpr}
      // r3f v9: the gl factory may be async; configure() awaits it and mounts
      // children only after it resolves. We size the canvas backing here, before
      // `new WebGPURenderer`, so the screen depth/MSAA targets are born at the
      // right size (see the component note above).
      gl={async (glProps) => {
        const canvas = glProps && glProps.canvas;
        if (canvas) {
          const host = canvas.parentElement;
          const w = (host && host.clientWidth) || (typeof window !== 'undefined' ? window.innerWidth : 0);
          const h = (host && host.clientHeight) || (typeof window !== 'undefined' ? window.innerHeight : 0);
          if (w > 0 && h > 0) {
            canvas.width = Math.round(w * resolvedDpr);
            canvas.height = Math.round(h * resolvedDpr);
          }
        }
        const renderer = new THREE.WebGPURenderer({ ...glProps, antialias: true });
        renderer.toneMapping = toneMapping;
        await renderer.init();
        onRenderer?.(renderer, glProps);
        return renderer;
      }}
    >
      <GlyphProvider atlas={atlas}>
        {children}
      </GlyphProvider>
    </Canvas>
  );
}
