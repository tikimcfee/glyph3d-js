import React from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { GlyphProvider } from './context.jsx';

/**
 * GlyphCanvas — an r3f <Canvas> wired for standard WebGL2 rendering.
 *
 * Uses THREE.WebGLRenderer with antialias and high-performance power preference,
 * supporting >99% of browsers with instant startup and fast vertex-instanced rendering.
 *
 * @param {object} props
 * @param {number} [props.toneMapping] - THREE tone-mapping constant. Default NoToneMapping.
 * @param {number} [props.dpr] - Device pixel ratio. Defaults to clamped window.devicePixelRatio.
 * @param {(renderer, props) => void} [props.onRenderer] - Hook after renderer creation.
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
  const resolvedDpr = dpr ?? (typeof window !== 'undefined'
    ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2) : 1);

  return (
    <Canvas
      {...canvasProps}
      dpr={resolvedDpr}
      gl={(glProps) => {
        const renderer = new THREE.WebGLRenderer({
          ...glProps,
          antialias: true,
          powerPreference: 'high-performance',
        });
        renderer.toneMapping = toneMapping;
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
