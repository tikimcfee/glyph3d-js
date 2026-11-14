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
 * Colour is three's standard colour management, as three and r3f default it: colours are given in
 * sRGB, the working space is linear, and the canvas is written in sRGB. There is no tone mapping
 * (`flat` — r3f would otherwise switch ACES filmic on after the renderer is made, and every
 * built-in material's colour would bend): the scene is interface colour, not scene light, so a
 * specified colour is the colour on the canvas.
 *
 * @param {object} props
 * @param {number} [props.dpr] - Device pixel ratio. Defaults to clamped window.devicePixelRatio.
 * @param {(renderer, props) => void} [props.onRenderer] - Hook after renderer creation.
 * @param {import('@glyph3d/core').GlyphAtlas} props.atlas - Ready atlas from bootGlyphEngine.
 */
export default function GlyphCanvas({
  atlas,
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
      flat
      dpr={resolvedDpr}
      gl={(glProps) => {
        const renderer = new THREE.WebGLRenderer({
          ...glProps,
          antialias: true,
          powerPreference: 'high-performance',
        });
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
