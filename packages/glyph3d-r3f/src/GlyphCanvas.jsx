import React, { useLayoutEffect, useRef, useState } from 'react';
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
 *
 * PIXEL-EXACT BOX: the canvas fills its container, but its CSS box is sized so it spans a WHOLE
 * number of device pixels (from ResizeObserver's devicePixelContentBoxSize). three sizes the
 * backing store floor(cssSize × dpr); at a fractional dpr (1.25, 1.5) a container of, say, 943 CSS
 * px is 1414.5 device px, the buffer 1414, and the compositor resamples the whole canvas — no
 * pixel-exact text is possible (the plane view's premise). Sized to the container's device pixels,
 * buffer and screen match 1:1. (When dpr is clamped below the window's — above 2× — the canvas
 * resamples by design and the box is left at 100%.)
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
  const hostRef = useRef(null);
  const box = usePixelExactBox(hostRef, resolvedDpr);

  return (
    <div ref={hostRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
    <Canvas
      {...canvasProps}
      style={box ? { position: 'absolute', left: 0, top: 0, width: `${box.width}px`, height: `${box.height}px`, ...canvasProps.style } : canvasProps.style}
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
    </div>
  );
}

/**
 * The CSS size that spans exactly the host's device pixels, or null until measured (or when the
 * canvas dpr isn't the window's). The quarter pixel keeps three's floor(css × dpr) on the whole
 * count against float error; layout snaps the box to the same whole count.
 * @param {{current: HTMLElement|null}} hostRef
 * @param {number} canvasDpr
 * @returns {{width:number, height:number}|null}
 */
function usePixelExactBox(hostRef, canvasDpr) {
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let warned = false;
    const ro = new ResizeObserver(([entry]) => {
      const winDpr = window.devicePixelRatio || 1;
      const dev = entry.devicePixelContentBoxSize?.[0];
      if (!dev || Math.abs(winDpr - canvasDpr) > 1e-6) { setBox(null); return; }
      // Trust the device box only when it IS the CSS box × dpr (to layout's rounding). Emulated
      // densities (headless deviceScaleFactor) report it in CSS px; sizing from that would shrink
      // the canvas by 1/dpr — leave it at 100% and say why, once.
      const css = entry.contentRect;
      if (Math.abs(dev.inlineSize - css.width * winDpr) > 2 || Math.abs(dev.blockSize - css.height * winDpr) > 2) {
        if (!warned) {
          warned = true;
          console.warn(`[glyph3d] devicePixelContentBoxSize ${dev.inlineSize}×${dev.blockSize} isn't the CSS box `
            + `${css.width}×${css.height} × dpr ${winDpr} — not pixel-snapping the canvas (it may resample at this dpr)`);
        }
        setBox(null);
        return;
      }
      const next = { width: (dev.inlineSize + 0.25) / winDpr, height: (dev.blockSize + 0.25) / winDpr };
      setBox((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    });
    try { ro.observe(el, { box: 'device-pixel-content-box' }); }
    catch { ro.observe(el); }   // no device-pixel box: the entry has none, and the canvas stays at 100%
    return () => ro.disconnect();
  }, [hostRef, canvasDpr]);
  return box;
}
