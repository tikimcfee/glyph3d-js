import { useEffect, useState } from 'react';
import { bootGlyphEngine } from './glyphEngine.js';

/**
 * Boot the glyph engine (atlas + shaper + slug) once and expose its state.
 * Renderer-independent, so it runs before any <GlyphCanvas> mounts.
 *
 * @param {import('./glyphEngine.js').GlyphEngineOptions} options - Must include `fontUrl`.
 * @returns {{ atlas: object|null, stage: string, error: Error|null }}
 */
export function useGlyphEngine(options) {
  const [atlas, setAtlas] = useState(null);
  const [stage, setStage] = useState('idle');
  const [error, setError] = useState(null);

  // fontUrl is the meaningful identity of a boot; re-boot only if it changes.
  const fontUrl = options?.fontUrl;

  useEffect(() => {
    let cancelled = false;
    setStage('booting');
    bootGlyphEngine({ ...options, onStage: (s) => !cancelled && setStage(s) })
      .then((a) => { if (!cancelled) setAtlas(a); })
      .catch((e) => { if (!cancelled) { setError(e); setStage('error'); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontUrl]);

  return { atlas, stage, error };
}
