import React, { useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { GlyphProvider } from './context.jsx';

/**
 * Force the renderer — and crucially its screen depth texture — to the canvas's
 * REAL pixel size. The async WebGPU `gl` factory (`await renderer.init()`)
 * builds the renderer's CanvasTarget (which owns the screen depth texture) at
 * the canvas default 300×150; the color attachment then follows the laid-out
 * size, but the depth texture's GPU resource stays at 300×150 — a per-frame
 * (and fatal: "invalid command buffer") "depth attachment size does not match"
 * error.
 *
 * Why setSize alone isn't enough: three rebuilds the screen depth via
 * `backend.updateSize()`, but only through the CanvasTarget 'resize' listener,
 * which guards on `renderer._initialized`. The resize fired while the async init
 * is still in flight is therefore dropped and never re-fires — so the depth is
 * never rebuilt. We call `backend.updateSize()` directly (it drops the cached
 * canvas target so the next render recreates the depth at the current size),
 * after setSize. Size is read from the DOM, not r3f's size store, so it's
 * correct even for a lazily-mounted iframe canvas.
 */
function fitRenderer(gl) {
  const canvas = gl && gl.domElement;
  if (!canvas) return;
  const w = canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
  const h = canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
  if (w <= 0 || h <= 0) return;
  gl.setSize(w, h, false);
  // Directly rebuild the screen render target (incl. depth) — the 'resize'-driven
  // path is gated on _initialized and misses the async-init window (see above).
  if (gl.backend && typeof gl.backend.updateSize === 'function') gl.backend.updateSize();
}

function SyncSize() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!gl || !gl.domElement) return;
    fitRenderer(gl);
    const ro = new ResizeObserver(() => fitRenderer(gl));
    ro.observe(gl.domElement);
    return () => ro.disconnect();
  }, [gl]);
  return null;
}

/**
 * GlyphCanvas — an r3f <Canvas> wired for the WebGPU GlyphField stack.
 *
 * Encapsulates the one genuinely fiddly thing (the async WebGPU `gl` factory)
 * and nothing else. It does NOT impose a camera, a background, or scene content
 * — those are the consumer's. The only opinion it holds is `toneMapping`, which
 * defaults to NoToneMapping because the GlyphField coverage shader emits its own
 * pow(2.2)-encoded color (r3f's default ACESFilmic would crush it). That default
 * is overridable via `toneMapping` for callers who composite differently.
 *
 * @param {object} props
 * @param {number} [props.toneMapping] - THREE tone-mapping constant. Default
 *        NoToneMapping (required by the current GlyphField output; override
 *        knowingly).
 * @param {(renderer, props) => void} [props.onRenderer] - Hook to tweak the
 *        renderer after init() (e.g. clear color, pixel ratio policy).
 * @param {import('@glyph3d/core').GlyphAtlas} props.atlas - Ready atlas from
 *        bootGlyphEngine (carries shaper + slug data). Provided to children.
 * @param {object} [props.canvasProps] - Extra props spread onto r3f <Canvas>
 *        (camera, dpr, onCreated, style, children, etc.).
 */
export default function GlyphCanvas({
  atlas,
  toneMapping = THREE.NoToneMapping,
  onRenderer,
  onCreated,
  children,
  ...canvasProps
}) {
  // Size the renderer BEFORE the first frame (onCreated runs ahead of the render
  // loop), then again on resize via <SyncSize>. fitRenderer reads the real DOM
  // size and rebuilds the depth texture — see its note above.
  const handleCreated = (state) => {
    fitRenderer(state.gl);
    onCreated?.(state);
  };
  return (
    <Canvas
      onCreated={handleCreated}
      // r3f v9: the gl factory may be async; configure() awaits it and mounts
      // children only after it resolves — so the WebGPU backend is initialized
      // before the first render(). (Verified against r3f 9.6.1 + three 0.183.)
      gl={async (glProps) => {
        const renderer = new THREE.WebGPURenderer({ ...glProps, antialias: true });
        renderer.toneMapping = toneMapping;
        await renderer.init();
        onRenderer?.(renderer, glProps);
        return renderer;
      }}
      {...canvasProps}
    >
      <GlyphProvider atlas={atlas}>
        <SyncSize />
        {children}
      </GlyphProvider>
    </Canvas>
  );
}
