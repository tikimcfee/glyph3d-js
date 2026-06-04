import React, { useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { GlyphProvider } from './context.jsx';

/**
 * Re-apply r3f's measured size to the renderer and rebuild the screen depth on
 * resize. three sizes the screen depth from `canvasTarget._width × pixelRatio`
 * and only rebuilds it through a resize listener gated on `_initialized`, which
 * the async WebGPU init can miss. `backend.updateSize()` drops the cached screen
 * target so the depth is recreated at the current size. Size comes from r3f's
 * LOGICAL `size` — never the canvas backing, which would feed back and grow.
 */
function applyFit(gl, width, height) {
  if (!gl || width <= 0 || height <= 0) return;
  gl.setSize(width, height, false);
  if (gl.backend && typeof gl.backend.updateSize === 'function') gl.backend.updateSize();
}

function SyncSize() {
  const gl = useThree((s) => s.gl);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  useEffect(() => { applyFit(gl, width, height); }, [gl, width, height]);
  return null;
}

/**
 * GlyphCanvas — an r3f <Canvas> wired for the WebGPU GlyphField stack.
 *
 * Handles the async WebGPU `gl` factory and the screen-depth sizing dance. The
 * latter is the load-bearing bit: three builds the screen depth texture from
 * `canvas.width/height` at renderer construction and its rebuild path can miss
 * the async-init window — so a canvas at the 300×150 default when the renderer is
 * constructed yields a depth that never matches the color attachment, a fatal
 * per-frame WebGPU error (most visible on HiDPI, where the dpr mismatch makes the
 * early frames fail instead of self-correcting). The fix: size the canvas (×dpr)
 * BEFORE `new WebGPURenderer`, and pin dpr so r3f's later sizing matches.
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
  onCreated,
  dpr,
  children,
  ...canvasProps
}) {
  // Pin dpr so the size baked into the canvas (gl factory) matches what r3f uses
  // afterward — otherwise depth and color diverge by the dpr factor on HiDPI.
  const resolvedDpr = dpr ?? (typeof window !== 'undefined'
    ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2) : 1);

  const handleCreated = (state) => {
    applyFit(state.gl, state.size.width, state.size.height);
    onCreated?.(state);
  };

  return (
    <Canvas
      {...canvasProps}
      dpr={resolvedDpr}
      onCreated={handleCreated}
      gl={async (glProps) => {
        // Size the canvas backing BEFORE constructing the renderer so the screen
        // depth texture is born at the right size (see component note). Use the
        // PARENT's layout size (or the window) × dpr — never the canvas's own
        // clientWidth, which would feed back from the backing we're setting.
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
        <SyncSize />
        {children}
      </GlyphProvider>
    </Canvas>
  );
}
