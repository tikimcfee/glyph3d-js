import React from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { GlyphProvider } from './context.jsx';

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
 * @param {import('glyph3d-js').GlyphAtlas} props.atlas - Ready atlas from
 *        bootGlyphEngine (carries shaper + slug data). Provided to children.
 * @param {object} [props.canvasProps] - Extra props spread onto r3f <Canvas>
 *        (camera, dpr, onCreated, style, children, etc.).
 */
export default function GlyphCanvas({
  atlas,
  toneMapping = THREE.NoToneMapping,
  onRenderer,
  children,
  ...canvasProps
}) {
  return (
    <Canvas
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
        {children}
      </GlyphProvider>
    </Canvas>
  );
}
