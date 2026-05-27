import React, { createContext, useContext, useMemo, useRef } from 'react';
import SceneRegistry from '@glyph3d/core/services/SceneRegistry.js';

// One context for the in-canvas glyph world: the ready atlas (which carries the
// shaper + slug data) and a live registry of mounted CodeGrid cores.
//
// The registry IS the core SceneRegistry — the single source of truth the
// command layer also reads as ctx.registry. (It used to be a private Set here,
// drifting from the command layer's own registry; that dual-registry split is
// gone.) GlyphCanvas provides this; <CodeGrid>, <ViewerCamera>, and the app's
// CommandCenter all consume the same instance.

const GlyphContext = createContext(null);

export function GlyphProvider({ atlas, children }) {
  const registryRef = useRef(null);
  if (!registryRef.current) registryRef.current = new SceneRegistry();

  const value = useMemo(() => {
    const registry = registryRef.current;
    return {
      atlas,
      // The bare core SceneRegistry (full API: findByType, register, getIdByGrid…)
      registry,
      // Convenience used by binding components AND the command layer, so grid
      // identity/typing is synthesized one way. Registration only — scene.add is
      // the caller's job (the core CodeGrid ctor's scene.add is dead; see CodeGrid.jsx).
      addGrid(grid, { id, type = 'grid', ...meta } = {}) {
        const sourcePath = grid.getSourcePath?.() || null;
        const filename = grid.getFilename?.() || grid.name || null;
        const gid = id || sourcePath || filename
          || `grid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (!registry.getIdByGrid(grid)) {
          registry.register(gid, grid, { type, sourcePath, filename, ...meta });
        }
        return gid;
      },
      removeGrid(grid) {
        const gid = registry.getIdByGrid(grid);
        return gid ? registry.unregister(gid) : null;
      },
      getGrids: () => registry.toArray('grid'),
    };
  }, [atlas]);

  return <GlyphContext.Provider value={value}>{children}</GlyphContext.Provider>;
}

function useGlyph() {
  const ctx = useContext(GlyphContext);
  if (!ctx) throw new Error('glyph3d-r3f components must be rendered inside <GlyphCanvas> (it provides the glyph context).');
  return ctx;
}

/** The ready GlyphAtlas (with `_shaper` + `_slugData` attached). */
export function useGlyphAtlas() { return useGlyph().atlas; }

/**
 * The glyph registry bundle: { registry, addGrid, removeGrid, getGrids }.
 * `registry` is the core SceneRegistry instance (the single source of truth);
 * the helpers wrap it with grid-id/type synthesis.
 */
export function useGridRegistry() { return useGlyph(); }
