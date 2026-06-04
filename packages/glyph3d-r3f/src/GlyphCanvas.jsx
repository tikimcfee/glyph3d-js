import React, { useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { GlyphProvider } from './context.jsx';

/**
 * Re-apply the renderer size once the (async) WebGPU renderer is live and on
 * every resize. r3f's async `gl` factory creates the renderer with `await
 * renderer.init()`; in that window r3f sizes the canvas backing store (so the
 * color attachment follows the laid-out size) but the renderer's *internal*
 * size — which drives the screen depth texture — can be left at the canvas
 * default (300×150). The result is a per-frame WebGPU validation error:
 * "depth stencil attachment size … does not match … the other attachments".
 * Forcing setSize here (after `gl` exists) makes three rebuild the depth at the
 * real size, so the two attachments match.
 */
function SyncSize() {
  const gl = useThree((s) => s.gl);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  useEffect(() => {
    if (gl && width > 0 && height > 0) gl.setSize(width, height, false);
  }, [gl, width, height]);
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
  // Size the renderer BEFORE the first frame. The async WebGPU init leaves the
  // renderer at the canvas default (300×150), and <SyncSize> only corrects it
  // after the first commit — so the opening frames would render with a depth
  // attachment that doesn't match the color target. onCreated runs before the
  // render loop, so sizing here avoids those startup validation errors too.
  const handleCreated = (state) => {
    if (state?.gl && state.size?.width > 0 && state.size?.height > 0) {
      state.gl.setSize(state.size.width, state.size.height, false);
    }
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
