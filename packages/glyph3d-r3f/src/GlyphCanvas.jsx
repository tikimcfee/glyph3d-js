import React, { useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { GlyphProvider } from './context.jsx';

/**
 * Re-apply r3f's measured size to the renderer and rebuild the screen depth
 * texture.
 *
 * Why this is needed: three's WebGPU renderer rebuilds its screen depth texture
 * only through a CanvasTarget 'resize' listener gated on `renderer._initialized`.
 * Because the WebGPU `gl` factory is async (`await renderer.init()`), the size
 * event fired while r3f is configuring lands before init finishes, is dropped,
 * and never re-fires — so the depth stays at the canvas default (300×150) while
 * the color attachment tracks the real size. That's a fatal, per-frame WebGPU
 * error: "depth stencil attachment size … does not match". We re-apply setSize
 * and call `backend.updateSize()` directly (it drops the cached screen target so
 * the depth is recreated at the current size) to cover the missed event.
 *
 * Size comes from r3f's LOGICAL `size` — never the canvas backing / clientWidth,
 * which feeds back into the canvas size and grows without bound (a loop that
 * shows up as an ever-growing depth attachment).
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
 * Encapsulates the one genuinely fiddly thing (the async WebGPU `gl` factory)
 * and the depth-resize workaround (see applyFit). It does NOT impose a camera, a
 * background, or scene content — those are the consumer's. The only opinion it
 * holds is `toneMapping`, which defaults to NoToneMapping because the GlyphField
 * coverage shader emits its own pow(2.2)-encoded color (r3f's default ACESFilmic
 * would crush it). That default is overridable via `toneMapping`.
 *
 * @param {object} props
 * @param {number} [props.toneMapping] - THREE tone-mapping constant. Default NoToneMapping.
 * @param {(renderer, props) => void} [props.onRenderer] - Hook after init() (clear color, etc.).
 * @param {import('@glyph3d/core').GlyphAtlas} props.atlas - Ready atlas from bootGlyphEngine.
 */
export default function GlyphCanvas({
  atlas,
  toneMapping = THREE.NoToneMapping,
  onRenderer,
  onCreated,
  children,
  ...canvasProps
}) {
  // Fit once before the first frame (onCreated runs ahead of the render loop) so
  // there are no startup mismatch frames; <SyncSize> re-fits on every resize.
  const handleCreated = (state) => {
    applyFit(state.gl, state.size.width, state.size.height);
    onCreated?.(state);
  };
  return (
    <Canvas
      {...canvasProps}
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
    >
      <GlyphProvider atlas={atlas}>
        <SyncSize />
        {children}
      </GlyphProvider>
    </Canvas>
  );
}
