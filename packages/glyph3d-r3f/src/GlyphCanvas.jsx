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
function applyFit(gl, width, height, dpr) {
  if (!gl || width <= 0 || height <= 0) return;
  const pr = dpr || (gl.getPixelRatio ? gl.getPixelRatio() : 1);
  // Set size AND pixel ratio ATOMICALLY. r3f applies them in two separate calls
  // (setSize then setPixelRatio), which momentarily leaves canvas.width !=
  // _width × pixelRatio — and a frame rendered in that window has a depth
  // attachment that doesn't match the color (harmless at dpr 1, fatal on HiDPI).
  // setDrawingBufferSize sets _width/_height/_pixelRatio/canvas all at once, so
  // the invariant never breaks. Then drop the cached screen target so the depth
  // is rebuilt at the new size.
  if (typeof gl.setDrawingBufferSize === 'function') gl.setDrawingBufferSize(width, height, pr);
  else gl.setSize(width, height, false);
  if (gl.backend && typeof gl.backend.updateSize === 'function') gl.backend.updateSize();
}

function SyncSize() {
  const gl = useThree((s) => s.gl);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const dpr = useThree((s) => s.viewport.dpr);
  useEffect(() => { applyFit(gl, width, height, dpr); }, [gl, width, height, dpr]);
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
  dpr = 1,
  children,
  ...canvasProps
}) {
  const handleCreated = (state) => {
    applyFit(state.gl, state.size.width, state.size.height, state.viewport && state.viewport.dpr);
    onCreated?.(state);
  };

  return (
    <Canvas
      {...canvasProps}
      dpr={dpr}
      onCreated={handleCreated}
      gl={async (glProps) => {
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
