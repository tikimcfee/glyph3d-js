import React, { createContext, useContext, useMemo, useRef } from 'react';

// One context for the in-canvas glyph world: the ready atlas (which carries the
// shaper + slug data) and a live registry of mounted CodeGrid cores. GlyphCanvas
// provides this; <CodeGrid> and <ViewerCamera> consume it. Kept deliberately
// small — a Set behind a stable API, no event emitter until a consumer needs one.

const GlyphContext = createContext(null);

export function GlyphProvider({ atlas, children }) {
  const setRef = useRef(new Set());
  const value = useMemo(() => ({
    atlas,
    registry: {
      add: (grid) => { setRef.current.add(grid); },
      remove: (grid) => { setRef.current.delete(grid); },
      getGrids: () => Array.from(setRef.current),
    },
  }), [atlas]);
  return <GlyphContext.Provider value={value}>{children}</GlyphContext.Provider>;
}

function useGlyph() {
  const ctx = useContext(GlyphContext);
  if (!ctx) throw new Error('glyph3d-r3f components must be rendered inside <GlyphCanvas> (it provides the glyph context).');
  return ctx;
}

/** The ready GlyphAtlas (with `_shaper` + `_slugData` attached). */
export function useGlyphAtlas() { return useGlyph().atlas; }

/** The live grid registry: { add, remove, getGrids }. */
export function useGridRegistry() { return useGlyph().registry; }
