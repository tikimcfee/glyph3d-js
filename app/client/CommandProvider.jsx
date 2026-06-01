import React, { createContext, useContext, useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useGridRegistry } from 'glyph3d-r3f';

import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
import { installConsoleForwarder } from '@glyph3d/core/services/orchestration/consoleForwarder.js';
import AttentionManager from '@glyph3d/core/services/interaction/AttentionManager.js';
import EntityKeystrokeRouter from '@glyph3d/core/services/interaction/EntityKeystrokeRouter.js';
import RemoteFileSystemProvider from '@glyph3d/core/services/data/RemoteFileSystemProvider.js';
import { PickingSystem } from '@glyph3d/core/picking/PickingSystem.js';
import SessionStore from './SessionStore.js';
// The spine, ported verbatim — handlers register lazily; nothing here knows the
// shell. Their only deps are @glyph3d/core, three, and sibling helpers.
import { registerAllCommands } from '../commands/handlers/index.js';

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
function buildClientContext({ scene, camera, renderer, atlas, registryBundle, cameraControllerRef }) {
  // The registry is the ONE core SceneRegistry, provided by GlyphCanvas and
  // shared with the binding components (<CodeGrid> self-registers into it,
  // <ViewerCamera> frames it). No second registry, no drift.
  const { registry, addGrid, removeGrid, getGrids } = registryBundle;

  return {
    // Core Three.js — straight from r3f
    scene,
    camera,
    renderer,
    atlas,

    registry,
    getGrids,

    // For grids created imperatively by a command (not via <CodeGrid>): register
    // in the shared registry AND scene.add (React grids do their own scene.add).
    addGrid(grid, opts = {}) {
      const id = addGrid(grid, opts);
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

    // Camera controller — supplied by <ViewerCamera> via a ref the app threads
    // in. A live getter (not a snapshot) so handlers see it regardless of which
    // sibling effect mounted first.
    get cameraController() { return cameraControllerRef?.current ?? null; },

    // Subsystems not yet supplied by the r3f client. Commands that need these
    // will error until the corresponding field is wired (the iterative work).
    selectionManager: null,
    fileStateManager: null,
    codeColorManager: null,
    spatialManager: null,

    getActiveLayout: () => null,
    layoutManagers: { hierarchical: null, spiral: null, treemap: null, grid: null },

    windowManager: null,
    wsbridge: null,

    // GPU glyph-picking system (material-swap ID pass on a dedicated render
    // layer). Created in the effect below once gl exists; canvas hover/click
    // resolves pixel-perfect picks through it. Null until then.
    pickingSystem: null,

    // Read-only local filesystem over the relay (fs/* RPC). Set once the bridge
    // exists; commands like file.open read files through it. Swap for the GitHub
    // adapter (RepositoryAdapter) here later — same surface, no command changes.
    fileProvider: null,

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
 * CommandProvider — wires the command spine inside an r3f Canvas.
 *
 * Must be rendered inside <GlyphCanvas> (it reads scene/camera/renderer via
 * useThree). Builds the context bag once, registers all handlers, and connects
 * a WebSocketBridge to the relay so `glyph3d-cli <cmd>` round-trips into the
 * browser. Children render inside its context provider (useAppCommands).
 *
 * DOM chrome lives OUTSIDE the Canvas and can't read that in-canvas context, so
 * `onReady(client)` hands the wired client up to the app once the bridge connects
 * — the app then prop-drills it to panels (file tree, command bar, …).
 *
 * Shared by apps/home and apps/ide — it sits next to the spine (app/commands) it
 * wires, so there's exactly one of it.
 */
export default function CommandProvider({ atlas, port = 8080, cameraControllerRef, onReady, children }) {
  const { scene, camera, gl } = useThree();
  const registryBundle = useGridRegistry();
  const stateRef = useRef(null);

  // Build router + context once. useThree's scene/camera/gl are stable refs;
  // the registry bundle is memoized in GlyphProvider.
  if (!stateRef.current) {
    const ctx = buildClientContext({
      scene, camera, renderer: gl, atlas, registryBundle, cameraControllerRef,
    });
    const router = new CommandRouter(ctx);
    registerAllCommands(router);
    router.use((name, args) => console.debug(`[cmd] ${name}`, args.length ? args : ''));
    stateRef.current = { ctx, router, registry: ctx.registry, bridge: null };
  }

  useEffect(() => {
    const state = stateRef.current;

    // GPU glyph picking — one ID-pass system bound to the WebGPU renderer. Canvas
    // hover/click resolves through it (CanvasPicker wires each grid/terminal in
    // via setPickingSystem). 'cell' mode: the whole glyph quad is pickable.
    const pickingSystem = new PickingSystem(gl, { mode: 'cell' });
    state.ctx.pickingSystem = pickingSystem;

    const url = `ws://localhost:${port}`;
    const bridge = new WebSocketBridge(state.router, {
      port,
      autoConnect: false,
      showStatus: false,
    });
    state.ctx.wsbridge = bridge;
    state.ctx.fileProvider = new RemoteFileSystemProvider(bridge);
    state.bridge = bridge;
    bridge.connect(url);
    installConsoleForwarder(bridge);

    // Devtools/agent handle, mirroring the vanilla IDE's window.viewer.
    window.__glyphClient = state;
    console.log(`[command-center] r3f client wired — relay ${url}, ${state.router.commands.size} handlers`);

    // Keyboard delivery to the focused entity (terminal → ANSI bytes via
    // grid.onInput; grid → edit ops). One capture-phase listener, sharing the
    // SAME AttentionManager that attention.set writes to.
    const keystrokes = new EntityKeystrokeRouter(state.ctx.attentionManager).start();
    state.keystrokes = keystrokes;

    // Share that AttentionManager onto the camera controller's ctx so VCC's
    // keydown gate bails while an entity holds key focus — otherwise typing 'w'
    // into a terminal would also fly the camera. Analog of the vanilla
    // initCommandCenter wiring (viewer.sceneContext.attentionManager = ...).
    const cc = cameraControllerRef?.current;
    if (cc?.ctx) cc.ctx.attentionManager = state.ctx.attentionManager;

    // Saved-state system: the server-side session store. Restore (open files +
    // camera + dock layout) runs once, on the first connect after this page
    // load; autosave arms after. IdeDock registers its dock bridge onto it.
    const session = new SessionStore({ ctx: state.ctx, router: state.router, bridge });
    state.session = session;
    const offConn = bridge.onConnectionChange((connected) => { if (connected) session.startOnConnect(); });

    // Hand the wired client to the app (for DOM chrome outside the Canvas).
    onReady?.(state);

    return () => {
      offConn?.();
      session.dispose();
      keystrokes.dispose();
      bridge.disconnect();
      pickingSystem.dispose();
      state.ctx.pickingSystem = null;
    };
  }, [port]);

  return (
    <AppCommandContext.Provider value={stateRef.current}>
      {children}
    </AppCommandContext.Provider>
  );
}
