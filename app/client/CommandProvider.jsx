import React, { createContext, useContext, useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { useGridRegistry } from '@glyph3d/r3f';

import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
import FieldVisitorManager from '@glyph3d/core/services/orchestration/FieldVisitorManager.js';
import AgentTrail from '@glyph3d/core/collections/AgentTrail.js';
import { installConsoleForwarder } from '@glyph3d/core/services/orchestration/consoleForwarder.js';
import AttentionManager from '@glyph3d/core/services/interaction/AttentionManager.js';
import EntityKeystrokeRouter from '@glyph3d/core/services/interaction/EntityKeystrokeRouter.js';
import InteractionContext from '@glyph3d/core/services/interaction/InteractionContext.js';
import LspNavigator from '@glyph3d/core/services/interaction/LspNavigator.js';
import CameraDock from '@glyph3d/core/services/interaction/CameraDock.js';
import RemoteFileSystemProvider from '@glyph3d/core/services/data/RemoteFileSystemProvider.js';
import RemoteLspProvider from '@glyph3d/core/services/data/RemoteLspProvider.js';
import GitHubFileProvider from '@glyph3d/core/services/data/GitHubFileProvider.js';
import { PickingSystem } from '@glyph3d/core/picking/PickingSystem.js';
import ContentTree from '@glyph3d/core/collections/ContentTree.js';
import ContentTreeMarkers from '@glyph3d/core/collections/ContentTreeMarkers.js';
import ContentTreeArrows from '@glyph3d/core/collections/ContentTreeArrows.js';
import ContentTreeProbes from '@glyph3d/core/collections/ContentTreeProbes.js';
import SessionStore from './SessionStore.js';
import WorkspaceModel from './WorkspaceModel.js';
import { getSetting, applyGroupSettings } from './settings.js';
import { wheelScrollCommand } from './surfaceInteractions.js';
import errorTracker from '@glyph3d/core/utils/ErrorTracker.js';
import { createStatusChannel } from './statusChannel.js';
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
  const { registry, addGrid, removeGrid, getGrids, getSurfaces } = registryBundle;

  return {
    // Core Three.js — straight from r3f
    scene,
    camera,
    renderer,
    atlas,

    registry,
    getGrids,
    // Grids + terminals — every bounds-bearing window. Used for dynamic-speed sampling,
    // fit-all framing, and viewport-relative placement (terminal.create).
    getSurfaces,

    // Live activity signal — operations post here; the StatusBar reflects it.
    status: createStatusChannel(),

    // For grids created imperatively by a command (not via <CodeGrid>): register
    // in the shared registry AND scene.add (React grids do their own scene.add).
    addGrid(grid, opts = {}) {
      const id = addGrid(grid, opts);
      if (!grid.parent) scene.add(grid);
      return id;
    },

    removeGrid(idOrIndex) {
      let entry, regId;
      if (typeof idOrIndex === 'number' || /^\d+$/.test(idOrIndex)) {
        const idx = typeof idOrIndex === 'number' ? idOrIndex : parseInt(idOrIndex);
        const grids = registry.toArray('grid');
        if (idx < 0 || idx >= grids.length) return null;
        regId = registry.getIdByGrid(grids[idx]);
        if (!regId) return null;
        entry = registry.unregister(regId);
      } else {
        regId = idOrIndex;
        entry = registry.unregister(idOrIndex);
      }
      if (!entry) return null;

      // A content-tree leaf (registry id == its path) detaches THROUGH the tree and
      // relayouts, so removing a file closes its gap and the project re-settles on the
      // floor — the unload half of the dynamic add/remove. Plain scene grids (terminals,
      // workspace sheets) take the flat scene.remove. (scene.remove is a no-op on a tree
      // leaf anyway — its parent is a dir node, not the scene.)
      const tree = this.contentTree;
      if (tree && regId && tree.has(regId)) {
        tree.remove(regId, { prune: true }); // detach leaf + drop now-empty dir nodes
        entry.grid.dispose?.();
        tree.relayout();
        tree.restAbove();                    // rest the re-settled tree on the floor (default y=0)
      } else {
        entry.grid.dispose?.();
        scene.remove(entry.grid);
      }
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

    windowManager: null,
    wsbridge: null,

    // Camera-locked HUD bar of window tiles (CameraDock). Created in the effect
    // (needs scene + the shared AttentionManager) and ticked by <DockRunner/>.
    // dock.* verbs drive it; distinct from ctx.dock (the DOM dockview).
    cameraDock: null,

    // Field-visitor multiplexer — one self-driving visitor per agent. Created in the
    // effect (needs the live ctx); ticked each frame by <VisitorRunner/>.
    visitorManager: null,

    // Agent trail — every agent action laid out as a card receding into depth, the file
    // it touched on a parallel rail, tethered. Fed by visitorManager.onActivity.
    agentTrail: null,

    // GPU glyph-picking system (material-swap ID pass on a dedicated render
    // layer). Created in the effect below once gl exists; canvas hover/click
    // resolves pixel-perfect picks through it. Null until then.
    pickingSystem: null,

    // The file source. BASELINE = GitHubFileProvider: client-only GitHub browsing
    // that always works, no relay needed. The effect swaps in RemoteFileSystemProvider
    // (local fs over the relay) when the binary is serving a project. Same surface
    // either way (getFile / listTree / filterCodeFiles / getMultipleFiles), so
    // file.open / FileTree don't care which is active.
    fileProvider: new GitHubFileProvider(),

    annotations: new Map(),
    gridVisualState: new Map(),
    _cancelCameraAnimation: null,
    spatialNav: null,

    mode: { state: 'explorer' },
    attentionManager: new AttentionManager(),
    // Working-set model (fields → sheets → panels) — the editor-tab layer ABOVE the registry.
    // The HUD reflects it; the field.*/sheet.* verbs mutate it. Client-side, like SessionStore.
    workspace: new WorkspaceModel(),
    get attention() { return this.attentionManager.state; },
  };
}

const AppCommandContext = createContext(null);

/**
 * VisitorRunner — drives the field-visitor multiplexer once per frame. Rendered
 * inside the Canvas (so useFrame is valid); a logic-only component (returns null).
 * Guards on visitorManager so it's a no-op until the effect wires it.
 */
function VisitorRunner({ stateRef }) {
  useFrame((_, dt) => {
    const c = stateRef.current?.ctx;
    c?.visitorManager?.update(dt);
    c?.agentTrail?.update(dt);
  });
  return null;
}

/**
 * DockRunner — parks the camera-locked dock ahead of the active camera and
 * advances its tile animations once per frame. Logic-only (returns null);
 * guarded so it's a no-op until the effect wires ctx.cameraDock.
 */
function DockRunner({ stateRef }) {
  useFrame((state, dt) => stateRef.current?.ctx?.cameraDock?.update(dt, state.camera));
  return null;
}

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
 * The app's client layer — it sits next to the spine (app/commands) it wires,
 * so there's exactly one of it.
 */
// Resolve where the relay is and whether to auto-dial it. The relay is pure
// enhancement, so we only auto-connect where one is plausibly present:
//   • ?relay=PORT        — dev: vite serves the page (:5173), relay on another port.
//   • localhost / LAN IP — the glyph3d-cli binary serves page + relay same-origin.
// A public host (glyph3d.dev) is the static hosted demo: no relay there, so we
// never cross-dial the visitor's OWN localhost. The connection chip can still
// connect manually. ws for http, wss for https — same scheme as the page.
function resolveRelay(loc, relayParam) {
  const port = relayParam ? Number(relayParam) : null;
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = port ? `ws://${loc.hostname}:${port}` : `${wsProto}//${loc.host}`;
  const h = loc.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1'
    || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  return { url, port: port || Number(loc.port) || null, autoConnect: !!port || isLocal };
}

export default function CommandProvider({ atlas, relay = null, repo = null, cameraControllerRef, onReady, children }) {
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

    // The content tree — the project as a directory-mirroring scene graph (one root Group;
    // dir nodes parent file grids). Loads route through it (tree.insert + relayout), so the
    // whole project moves as a unit and the ground (a fixed world floor) stays a constant the
    // content rests above. Only the root is scene.add-ed; leaves attach under their dir node.
    const contentTree = new ContentTree();
    scene.add(contentTree.root);
    state.ctx.contentTree = contentTree;

    // Bounding prisms: per-directory translucent volumes, parented into the dir nodes
    // and rebuilt on every tree relayout (tree.onRelayout). layout.markers dials them.
    state.ctx.contentTreeMarkers = new ContentTreeMarkers(contentTree);

    // Ownership lines: per-directory wires from each dir's hub to every file and child
    // dir it contains, parented into the node and rebuilt on relayout. File lines and dir
    // lines toggle independently (Tree settings); layout.arrows is the master on/off.
    state.ctx.contentTreeArrows = new ContentTreeArrows(contentTree);
    applyGroupSettings(state.ctx, 'Tree');   // fold persisted file/dir-line toggles in at boot
    applyGroupSettings(state.ctx, 'Appearance'); // set the configured interaction colors as the panel default before any window spawns
    applyGroupSettings(state.ctx, 'Glyph LOD');  // fold persisted minification/LOD dials into the global glyph uniforms at boot

    // Diagnostic: origin-vs-content-anchor dots per dir (layout.probes). Reveals where the
    // arrows anchor relative to each footprint origin — a debug instrument, toggle off when done.
    state.ctx.contentTreeProbes = new ContentTreeProbes(contentTree);

    // Field-visitor multiplexer: agent.* commands spawn/move/follow one self-driving
    // visitor per agent. The camera stays free unless `camera.follow <id>` opts in.
    state.ctx.visitorManager = new FieldVisitorManager(state.ctx);

    // Spatial trail: every agent action leaves a card receding into depth, the file it
    // touched on a parallel rail, tethered. Subscribes to visitorManager.onActivity.
    state.ctx.agentTrail = new AgentTrail(state.ctx).attach(state.ctx.visitorManager);
    // Fold the persisted Trail card-scale settings into the freshly-built trail (its apply()s
    // otherwise fire only on a user change), so tuned sizes hold from boot.
    applyGroupSettings(state.ctx, 'Trail');

    // Camera-locked HUD dock: a bar of window tiles that rides the view. Reparents
    // a docked grid/terminal under itself (world-preserving attach) and scales it to
    // a tile. Shares the AttentionManager so its .docks map is the record of truth.
    // <DockRunner/> ticks it; dock.* verbs drive it.
    const cameraDock = new CameraDock({ attentionManager: state.ctx.attentionManager });
    scene.add(cameraDock);
    state.ctx.cameraDock = cameraDock;
    // Fold the persisted Dock settings into the freshly-built dock — its apply()s only
    // fire on a user change, so without this a stored value would wait until next touch.
    applyGroupSettings(state.ctx, 'Dock');
    // Same boot-fold for the root view-frame knobs (Settings ▸ Frame) → CameraDock.setParam.
    applyGroupSettings(state.ctx, 'Frame');
    // Removal cascade: however a window is closed (terminal.kill→close, grid.remove, scene clear),
    // its registry entry vanishes — and the holders self-heal off that single event. Attention
    // releases focus/keystroke-target from the gone id (else input routes to a corpse); the dock
    // dismisses its tile (orphan lifted, focus cleared, bar re-packed). One cascade, every close
    // path; no closer needs to know the window was focused or docked.
    const onRemoval = () => {
      const isLive = (id) => state.ctx.registry.has(id);
      state.ctx.attentionManager?.pruneGone?.(isLive);
      cameraDock.pruneDismissed(isLive);
      // A gone NON-terminal surface drops its intent (e.g. a closed docked code grid) so capture
      // can't serialize a phantom tile. Terminals are spared — their PTY re-adopts and the surface
      // is the durable buffer that re-docks/re-sizes them (terminal.kill drops it explicitly).
      for (const s of state.ctx.workspace?.listSurfaces?.() || [])
        if (s.kind !== 'terminal' && !isLive(s.id)) state.ctx.workspace.removeSurface(s.id);
    };
    state.ctx.registry.addChangeListener(onRemoval);

    // The composable "what is the user locked into" projection — focus/edit/key
    // nodes derived from attention + cursor state (owns nothing). The breadcrumb
    // chips and context.info read it; gesture resolution and binding tables will.
    state.ctx.interactionContext = new InteractionContext({
      attentionManager: state.ctx.attentionManager,
      registry: state.ctx.registry,
    });

    // Where's the relay, and should we auto-dial it? (See resolveRelay.)
    const { url, port, autoConnect } = resolveRelay(window.location, relay);
    const bridge = new WebSocketBridge(state.router, {
      url,                 // boot-resolved target; relay.connect reuses it
      port,                // for status display
      autoConnect: false,  // we gate the dial explicitly below
      showStatus: false,
    });
    state.ctx.wsbridge = bridge;
    // LSP client: present whenever the bridge is, but only functional against a
    // relay started with a project root (the relay gates lsp/* on --root).
    state.ctx.lsp = new RemoteLspProvider(bridge);
    // LspNavigator: the presentation-agnostic def/refs model that the breadcrumb
    // (and, later, the 2D panel + 3D peek) render. Layered on the caret model.
    state.ctx.lspNavigator = new LspNavigator({
      interactionContext: state.ctx.interactionContext,
      registry: state.ctx.registry,
      lsp: state.ctx.lsp,
    });

    // Terminal OUTPUT data plane: binary frames (type 1) carry raw VT bytes → the
    // terminal's emulator (grid.writeBytes). The bridge demuxes by type byte; terminal
    // semantics live here, keyed by the id the adapter stamped into the frame.
    bridge.onBinaryFrame(1, (id, bytes) => {
      state.ctx.terminals?.get(id)?.writeBytes?.(bytes);
    });

    // The relay's local file source. Swapped in as ctx.fileProvider on connect when
    // no explicit ?repo was given (the binary serving a project); GitHub stays the
    // baseline until then.
    const remoteProvider = new RemoteFileSystemProvider(bridge);
    state.bridge = bridge;
    // Auto-dial only where a relay is plausibly present (resolveRelay's host gate) AND
    // the user hasn't opted out (settings: relay.autoConnect, default on). Otherwise
    // stay client-only — the chip can connect on demand — so the hosted demo never
    // polls a dead socket.
    if (autoConnect && getSetting('relay.autoConnect')) bridge.connect();
    installConsoleForwarder(bridge);

    // Devtools/agent handle, mirroring the vanilla IDE's window.viewer.
    window.__glyphClient = state;
    // Structured error buffer (uncaught + rejections + captured) for the test harness:
    // it preventDefault()s the error event, so reading getErrors() is the authoritative
    // signal — see tools/itest/driver.mjs trackedErrors().
    window.__errorTracker = errorTracker;
    console.log(`[command-center] r3f client wired — relay ${url}${autoConnect ? '' : ' (manual)'}, ${state.router.commands.size} handlers`);

    // Keyboard delivery to the focused entity (terminal → ANSI bytes via
    // grid.onInput; grid → edit ops). One capture-phase listener, sharing the
    // SAME AttentionManager that attention.set writes to.
    const keystrokes = new EntityKeystrokeRouter(state.ctx.attentionManager).start();
    state.keystrokes = keystrokes;

    // Share that AttentionManager onto the camera controller's ctx so VCC's
    // keydown gate bails while an entity holds key focus — otherwise typing 'w'
    // into a terminal would also fly the camera. Analog of the vanilla
    // initCommandCenter wiring (viewer.sceneContext.attentionManager = ...).
    //
    // Wheel routing: the wheel scrolls the framed surface UNDER THE CURSOR (a terminal's tmux
    // scrollback, or a framed code grid's conveyor) and otherwise yields to the camera dolly.
    // HOVER, not focus — so pointing at open space (or an unframed whole-file grid) always flies,
    // and the dynamic-speed braking is available near a terminal exactly as it is near a file:
    // you scroll the thing you point at, and fly when you point at the world. The per-surface
    // verb mapping is one record per type in surfaceInteractions — this gate just reads the
    // hovered entry and dispatches. VCC calls this in its per-frame wheel drain; it returns true
    // when it consumed the wheel.
    state.ctx.tryScrollHovered = (dy) => {
      if (!dy) return false;
      const hov = state.ctx.attentionManager?.get('hover');
      const entry = hov?.id ? state.registry.get(hov.id) : null;
      // Array form skips the router's space-tokenizer — a registry id with a space (a file path)
      // would otherwise split into bogus args and dead-end the wheel.
      const cmd = wheelScrollCommand(entry, dy);
      if (!cmd) return false;
      state.router.execute(cmd);
      return true;
    };

    const cc = cameraControllerRef?.current;
    if (cc?.ctx) {
      cc.ctx.attentionManager = state.ctx.attentionManager;
      // VCC runs on its OWN SceneContext (ViewerCamera.jsx), so client-side input
      // authorities aren't visible to it by default. Forward them LIVE (getters, not
      // copies) so VCC's handlers consult the same verdict the draggers do:
      //   • isGripPress — a plain left-press on a resize grip yields the camera pan.
      //   • tryScrollHovered — the wheel scrolls the framed surface under the cursor (terminal/grid).
      Object.defineProperty(cc.ctx, 'isGripPress', {
        configurable: true,
        get: () => state.ctx.isGripPress ?? null,
      });
      Object.defineProperty(cc.ctx, 'tryScrollHovered', {
        configurable: true,
        get: () => state.ctx.tryScrollHovered ?? null,
      });
      //   • dockTiles — the CameraDock's identity Set of docked grids; VCC's per-frame
      //     look-distance / fit-all skip them (camera-locked chrome, not world content).
      Object.defineProperty(cc.ctx, 'dockTiles', {
        configurable: true,
        get: () => state.ctx.cameraDock?.tiles ?? null,
      });
    }

    // Saved-state system: the server-side session store. Restore (open files +
    // camera + dock layout) runs once, on the first connect after this page
    // load; autosave arms after. IdeDock registers its dock bridge onto it.
    const session = new SessionStore({ ctx: state.ctx, router: state.router, bridge });
    state.session = session;
    state.ctx.session = session; // so session.* command handlers can reach it
    // The relay is pure enhancement. When it connects it lights up terminals + the
    // command bus; and — unless an explicit ?repo pinned us to GitHub — it makes the
    // local project the binary serves the active file source + restores its session.
    // (SessionStore is a local/relay feature; it never runs in pure GitHub mode.)
    const offConn = bridge.onConnectionChange((connected) => {
      if (!connected || repo) return;
      state.ctx.fileProvider = remoteProvider;
      session.startOnConnect();
    });

    // Workspace self-heal: when a panel is removed out-of-band (grid.remove, scene.clear_*,
    // eviction) rather than via sheet.derender, scrub the dangling sheet.panelId so the
    // working-set model never diverges from the rendered registry (clear-with-log policy).
    const reconcileWorkspace = () => state.ctx.workspace?.reconcile(state.registry);
    state.registry.addChangeListener(reconcileWorkspace);

    // Hand the wired client to the app (for DOM chrome outside the Canvas).
    onReady?.(state);

    // Baseline client-only load: ?repo=owner/repo[/branch] renders that GitHub repo
    // immediately, no relay required (the hosted-demo path). repo.load does the
    // clear → fetch → field-render.
    if (repo) {
      state.router.execute(['repo.load', repo]).catch(
        (err) => console.warn('[repo] initial load failed:', err?.message || err)
      );
    }

    return () => {
      offConn?.();
      state.registry.removeChangeListener(reconcileWorkspace);
      session.dispose();
      keystrokes.dispose();
      bridge.disconnect();
      pickingSystem.dispose();
      state.ctx.pickingSystem = null;
      state.ctx.visitorManager?.dispose();
      state.ctx.visitorManager = null;
      state.ctx.agentTrail?.dispose();
      state.ctx.agentTrail = null;
      state.ctx.interactionContext?.dispose();
      state.ctx.interactionContext = null;
      if (state.ctx.cameraDock) {
        state.ctx.registry.removeChangeListener(onRemoval);
        scene.remove(state.ctx.cameraDock);
        state.ctx.cameraDock.dispose();
        state.ctx.cameraDock = null;
      }
    };
  }, [relay]);

  return (
    <AppCommandContext.Provider value={stateRef.current}>
      <VisitorRunner stateRef={stateRef} />
      <DockRunner stateRef={stateRef} />
      {children}
    </AppCommandContext.Provider>
  );
}
