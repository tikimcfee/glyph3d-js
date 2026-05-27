import React, { createContext, useContext, useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';

import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
import { installConsoleForwarder } from '@glyph3d/core/services/orchestration/consoleForwarder.js';
import SceneRegistry from '@glyph3d/core/services/SceneRegistry.js';
import AttentionManager from '@glyph3d/core/services/interaction/AttentionManager.js';
// The spine, ported verbatim — handlers register lazily; nothing here knows the
// shell. Their only deps are @glyph3d/core, three, and sibling helpers.
import { registerAllCommands } from '../app/commands/handlers/index.js';

// ---------------------------------------------------------------------------
// The app-context provider (the linchpin).
//
// In the vanilla IDE, buildContext(viewer) sourced the context bag from a
// GitHubRepoViewer god-object. Here we source the same bag from r3f primitives
// (useThree) + fresh core instances. The handlers don't change; only the socket
// they read from does. A command that errors is telling us "field X isn't
// supplied yet," not "the handler is broken." Fields start null and light up as
// the client grows toward the v1 tour slice.
// ---------------------------------------------------------------------------
function buildClientContext({ scene, camera, renderer, atlas, registry }) {
  return {
    // Core Three.js — straight from r3f
    scene,
    camera,
    renderer,
    atlas,

    // Scene object registry — the real core SceneRegistry (THE source of truth),
    // not the tiny Set-wrapper glyph3d-r3f keeps for its own mount tracking.
    registry,

    getGrids: () => registry.toArray('grid'),

    addGrid(grid, opts = {}) {
      const sourcePath = grid.getSourcePath?.() || null;
      const filename = grid.getFilename?.() || grid.name || null;
      const id = opts.id || sourcePath || filename
        || `grid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      if (!registry.getIdByGrid(grid)) {
        registry.register(id, grid, {
          type: opts.type || 'grid',
          sourcePath,
          filename,
          ...opts.meta,
        });
      }
      if (!grid.parent) scene.add(grid);
      return id;
    },

    removeGrid(idOrIndex) {
      let entry;
      if (typeof idOrIndex === 'number' || /^\d+$/.test(idOrIndex)) {
        const idx = typeof idOrIndex === 'number' ? idOrIndex : parseInt(idOrIndex);
        const grids = registry.toArray('grid');
        if (idx < 0 || idx >= grids.length) return null;
        const regId = registry.getIdByGrid(grids[idx]);
        if (!regId) return null;
        entry = registry.unregister(regId);
      } else {
        entry = registry.unregister(idOrIndex);
      }
      if (!entry) return null;
      entry.grid.dispose?.();
      scene.remove(entry.grid);
      return entry;
    },

    // Subsystems — not yet supplied by the r3f client. Commands that need these
    // will error until the corresponding field is wired (the iterative work).
    cameraController: null,
    selectionManager: null,
    fileStateManager: null,
    codeColorManager: null,
    spatialManager: null,

    getActiveLayout: () => null,
    layoutManagers: { hierarchical: null, spiral: null, treemap: null, grid: null },

    windowManager: null,
    wsbridge: null,

    annotations: new Map(),
    gridVisualState: new Map(),
    _cancelCameraAnimation: null,
    spatialNav: null,

    mode: { state: 'explorer' },
    attentionManager: new AttentionManager(),
    get attention() { return this.attentionManager.state; },
  };
}

const AppCommandContext = createContext(null);

/** Access the wired command client: { ctx, router, registry, bridge }. */
export function useAppCommands() {
  return useContext(AppCommandContext);
}

/**
 * CommandCenter — wires the command spine inside an r3f Canvas.
 *
 * Must be rendered inside <GlyphCanvas> (it reads scene/camera/renderer via
 * useThree). Builds the context bag once, registers all handlers, and connects
 * a WebSocketBridge to the relay so `glyph3d-cli <cmd>` round-trips into the
 * browser. Children render inside its context provider so they can register
 * grids via useAppCommands().ctx.addGrid.
 */
export default function CommandCenter({ atlas, port = 8080, children }) {
  const { scene, camera, gl } = useThree();
  const stateRef = useRef(null);

  // Build router + context once. useThree's scene/camera/gl are stable refs.
  if (!stateRef.current) {
    const registry = new SceneRegistry();
    const ctx = buildClientContext({ scene, camera, renderer: gl, atlas, registry });
    const router = new CommandRouter(ctx);
    registerAllCommands(router);
    router.use((name, args) => console.debug(`[cmd] ${name}`, args.length ? args : ''));
    stateRef.current = { ctx, router, registry, bridge: null };
  }

  useEffect(() => {
    const state = stateRef.current;
    const url = `ws://localhost:${port}`;
    const bridge = new WebSocketBridge(state.router, {
      port,
      autoConnect: false,
      showStatus: false,
    });
    state.ctx.wsbridge = bridge;
    state.bridge = bridge;
    bridge.connect(url);
    installConsoleForwarder(bridge);

    // Devtools/agent handle, mirroring the vanilla IDE's window.viewer.
    window.__glyphClient = state;
    console.log(`[command-center] r3f client wired — relay ${url}, ${state.router.commands.size} handlers`);

    return () => bridge.disconnect();
  }, [port]);

  return (
    <AppCommandContext.Provider value={stateRef.current}>
      {children}
    </AppCommandContext.Provider>
  );
}
