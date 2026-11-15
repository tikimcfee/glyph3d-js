import { useEffect, useState } from 'react';
import { bootGlyphEngine, disposeGlyphEngine } from '@glyph3d/core';

/**
 * Boot the glyph engine (atlas + shaper + slug) once and expose its state.
 * Renderer-independent, so it runs before any <GlyphCanvas> mounts.
 *
 * @param {import('@glyph3d/core/glyphEngine.js').GlyphEngineOptions} options - Must include `fonts` (a chain) or `fontUrl`.
 * @returns {{ atlas: object|null, stage: string, error: Error|null }}
 */
export function useGlyphEngine(options) {
  const [atlas, setAtlas] = useState(null);
  const [stage, setStage] = useState('idle');
  const [error, setError] = useState(null);

  // The primary font is the meaningful identity of a boot; re-boot only if it changes.
  const fontUrl = options?.fontUrl ?? options?.fonts?.[0]?.url;

  useEffect(() => {
    let cancelled = false;
    setStage('booting');
    bootGlyphEngine({ ...options, onStage: (s) => !cancelled && setStage(s) })
      // A cancelled boot's atlas is never used: release its workers (encode + emoji raster).
      .then((a) => { if (cancelled) disposeGlyphEngine(a); else setAtlas(a); })
      .catch((e) => { if (!cancelled) { setError(e); setStage('error'); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontUrl]);

  return { atlas, stage, error };
}
