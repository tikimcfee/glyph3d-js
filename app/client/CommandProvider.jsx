import React, { createContext, useContext, useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useGridRegistry } from '@glyph3d/r3f';

import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
import AgentBooks from '@glyph3d/core/collections/AgentBooks.js';
import DeltaBooks from '@glyph3d/core/collections/DeltaBooks.js';
import { installConsoleForwarder } from '@glyph3d/core/services/orchestration/consoleForwarder.js';
import AttentionManager from '@glyph3d/core/services/interaction/AttentionManager.js';
import { installKeyboardRouter } from './keyboardRouter.js';
import InteractionContext from '@glyph3d/core/services/interaction/InteractionContext.js';
import LspNavigator from '@glyph3d/core/services/interaction/LspNavigator.js';
import CameraDock from '@glyph3d/core/services/interaction/CameraDock.js';
import OcclusionCuller from '@glyph3d/core/services/visual/OcclusionCuller.js';
import RemoteFileSystemProvider from '@glyph3d/core/services/data/RemoteFileSystemProvider.js';
import AgentSessionProvider from '@glyph3d/core/services/data/AgentSessionProvider.js';
import RemoteLspProvider from '@glyph3d/core/services/data/RemoteLspProvider.js';
import GitHubFileProvider from '@glyph3d/core/services/data/GitHubFileProvider.js';
import { PickingSystem } from '@glyph3d/core/picking/PickingSystem.js';
import ContentTree from '@glyph3d/core/collections/ContentTree.js';
import WorldLayout from '@glyph3d/core/collections/WorldLayout.js';
import ContentTreeMarkers from '@glyph3d/core/collections/ContentTreeMarkers.js';
import ContentTreeArrows from '@glyph3d/core/collections/ContentTreeArrows.js';
import ContentTreeProbes from '@glyph3d/core/collections/ContentTreeProbes.js';
import ContentTreeLabels from '@glyph3d/core/collections/ContentTreeLabels.js';
import ContentTreeMotion from '@glyph3d/core/collections/ContentTreeMotion.js';
import { installFrameWatch } from '../commands/loadTrace.js';
import { materializeActor } from '../commands/handlers/fileLoader.js';
import SessionStore from './SessionStore.js';
import WorkspaceModel from './WorkspaceModel.js';
import { getSetting, applyGroupSettings } from './settings.js';
import { scheduleCarrelSweep } from '../commands/handlers/carrelCommands.js';
import { wheelScrollCommand, wheelPageCommand } from './surfaceInteractions.js';
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

    // `relayout:false` defers the tree re-pack for BULK removals (file.closeDir):
    // the caller batches one relayout at the end instead of N full packings.
    removeGrid(idOrIndex, { relayout = true } = {}) {
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
        if (relayout) {
          tree.relayout();
          tree.restAbove();                  // rest the re-settled tree on the floor (default y=0)
        }
      } else {
        entry.grid.dispose?.();
        scene.remove(entry.grid);
      }
      return entry;
    },

    // The ONE bulk-removal primitive: remove a SET of grids with zero intermediate
    // re-packs, then settle the world once. A per-removal relayout re-packs the whole
    // field and rebuilds every overlay N times — quadratic, a minute-class clear on a
    // 2k-file repo — so the batch discipline lives in this seam rather than as a flag
    // each bulk caller must remember. Callers own their scoping (a prefix, everything)
    // and their bookkeeping (sheets, attention, fieldSources); this owns the removal.
    removeGrids(ids) {
      // Registry hold: N unregistrations → ONE coalesced listener pass (the
      // removal cascade, the mirroring panels), same shape as the load side.
      const removed = this.registry.holdChanges(() => {
        let n = 0;
        for (const id of ids) if (this.removeGrid(id, { relayout: false })) n++;
        return n;
      });
      if (removed) this.contentTree?.relayoutAndRest?.();
      return removed;
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

    // World-anchored reading desks (Carrel) — the dock's mirror: rings of seated
    // windows around fixed tabletops. carrel.* verbs create/drive them; the same
    // runner that parks the dock ticks their animators. Keyed by carrel name.
    carrels: new Map(),
    activeCarrel: null,

    // Holder protocol — unified holder membership. All holders (dock + carrels) join
    // this set on create/restore; holderOf(id) finds which one holds a surface id.
    // AgentBooks are excluded (they use inline parent tests at 3 sites).
    holders: new Set(),
    get holderOf() {
      // Return the holder (dock or carrel) currently holding id, or null.
      // Guarded: checks can fire before a holder exists.
      return (id) => {
        const dock = this.cameraDock;
        if (dock?.has?.(id)) return dock;
        for (const holder of this.holders) {
          if (holder !== dock && holder?.has?.(id)) return holder;
        }
        return null;
      };
    },

    // Agent books — every agent's run bound as a book of page-pair spreads (description
    // verso, content recto), the one agent-viewing system. The agent.* verbs sink here;
    // book.* pages it. Created in the effect (needs the live ctx); ticked by <AgentRunner/>.
    agentBooks: null,

    // Delta books — before/after change sets (delta.* verbs): one sheet per changed
    // file, base verso / head recto. Created in the effect; ticked by <AgentRunner/>.
    deltaBooks: null,

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
 * AgentRunner — eases every rolodex deck toward its slots, once per frame: the agent
 * books (plus their stall detection) and the library's directory VOLUMES (the tree's
 * pageable decks). Rendered inside the Canvas (so useFrame is valid); a logic-only
 * component (returns null). Guards until the effect wires the ctx.
 */
function AgentRunner({ stateRef }) {
  useFrame((_, dt) => {
    const c = stateRef.current?.ctx;
    c?.agentBooks?.update(dt);
    c?.deltaBooks?.update(dt);
    const volumes = c?.contentTree?.volumes?.();
    if (volumes) for (const v of volumes) v.update(dt);
  });
  return null;
}

/**
 * DockRunner — the camera-coupled per-frame systems: parks the camera-locked dock
 * ahead of the active camera and advances its tile animations, drives the
 * container labels' approach fade + hover grow (the hovered entity's ancestor
 * containers swell their names), and advances the relayout glide.
 * Logic-only (returns null); guarded so it's a no-op until the effect wires the ctx.
 */
function DockRunner({ stateRef }) {
  useFrame((state, dt) => {
    const s = stateRef.current;
    const c = s?.ctx;
    c?.cameraDock?.update(dt, state.camera);
    // Apply last pass's occlusion verdicts + refit query proxies for this pass.
    c?.occlusionCuller?.update();
    // Carrels tick beside the dock (same animator discipline, no camera) — and a
    // dissolved desk that has drained its homeward slides gets swept out here.
    if (c?.carrels) {
      for (const [name, carrel] of c.carrels) {
        carrel.update(dt);
        if (carrel._dead) { c.carrels.delete(name); carrel.dispose(); }
      }
    }
    // The relayout glide: while nodes ease toward their stamped slots, the overlays
    // that track positions BY VALUE follow along — wire endpoints rewrite, label
    // anchors re-walk. Everything parented INTO a node (prisms, lines) rides free.
    if (c?.contentTreeMotion?.update(dt)) {
      c.contentTreeArrows?.update();
      c.contentTreeLabels?.reanchor();
    }
    c?.contentTreeLabels?.update(state.camera, dt, c?.attentionManager?.state?.hover?.id ?? null);
  });
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

    // Dropped-frame attribution, always on: main-thread blocks > 50ms land in
    // ctx.frameTasks tagged with whichever load they interrupted ([frames] lines
    // → the relay log store; load.stats reports the worst). The chunky decomposer.
    const offFrameWatch = installFrameWatch(state.ctx);

    // GPU glyph picking — one ID-pass system bound to the WebGPU renderer. Canvas
    // hover/click resolves through it (CanvasPicker wires each grid/terminal in
    // via setPickingSystem). 'cell' mode: the whole glyph quad is pickable.
    const pickingSystem = new PickingSystem(gl, { mode: 'cell' });
    state.ctx.pickingSystem = pickingSystem;

    // The world layout — the top-level spatial system. The major groupings (file tree, agent-trail
    // cluster, …) are SIBLINGS on a shared floor, laid out by a bottom-aligned stack (the same bounds-node
    // + controller pattern one level up). Each grouping registers its root (with a bounds fn) and notifies
    // the world when its footprint changes, so the whole application reads as one deterministic layout.
    const world = new WorldLayout(scene);
    state.ctx.world = world;

    // The content tree — the project as a directory-mirroring scene graph (one root Group;
    // dir nodes parent file grids). Loads route through it (tree.insert + relayout), so the
    // whole project moves as a unit. Its root is a world grouping (not scene-added directly);
    // it keeps its own floor-rest, which under the world just agrees with the shared baseline.
    const contentTree = new ContentTree();
    world.register('files', contentTree.root, () => contentTree.getLocalBounds());
    contentTree.onRelayout(() => world.relayout());   // re-space the world as the tree loads/unloads
    state.ctx.contentTree = contentTree;

    // Bounding prisms: per-directory translucent volumes, parented into the dir nodes
    // and rebuilt on every tree relayout (tree.onRelayout). layout.markers dials them.
    state.ctx.contentTreeMarkers = new ContentTreeMarkers(contentTree);

    // Container labels: every visible directory named in space — one shared GlyphField
    // under the tree root, rebuilt on relayout; depth-scaled (physical LOD) with a
    // per-frame approach fade (<DockRunner/> ticks it). layout.labels dials them.
    state.ctx.contentTreeLabels = new ContentTreeLabels(contentTree, atlas);

    // Ownership lines: per-directory wires from each dir's hub to every file and child
    // dir it contains, parented into the node and rebuilt on relayout. File lines and dir
    // lines toggle independently (Tree settings); layout.arrows is the master on/off.
    state.ctx.contentTreeArrows = new ContentTreeArrows(contentTree);

    // Relayout motion: every re-lay becomes a glide — durable nodes ease from where
    // they were to where the scheme stamped them (<DockRunner/> ticks it; while it
    // reports active, the ownership lines and label anchors refresh so the by-value
    // overlays track the gliding nodes). layout.motion dials it.
    state.ctx.contentTreeMotion = new ContentTreeMotion(contentTree);
    applyGroupSettings(state.ctx, 'Tree');   // fold persisted file/dir-line toggles in at boot
    applyGroupSettings(state.ctx, 'Labels'); // fold persisted container-label dials in at boot
    applyGroupSettings(state.ctx, 'Motion'); // fold the persisted relayout-glide dials in at boot
    applyGroupSettings(state.ctx, 'Loading'); // fold the streamed-build budget in at boot
    applyGroupSettings(state.ctx, 'Appearance'); // set the configured interaction colors as the panel default before any window spawns
    applyGroupSettings(state.ctx, 'Glyph LOD');  // fold persisted minification/LOD dials into the global glyph uniforms at boot
    applyGroupSettings(state.ctx, 'Grid');       // set the configured default fold before any grid spawns (file.open / session restore)

    // Diagnostic: origin-vs-content-anchor dots per dir (layout.probes). Reveals where the
    // arrows anchor relative to each footprint origin — a debug instrument, toggle off when done.
    state.ctx.contentTreeProbes = new ContentTreeProbes(contentTree);

    // Library volumes are pickable BOOKS: each registers (id `vol:<dir>`, the volume as
    // the entry's object) and its COVER rides the 'group' pick channel — so the wheel
    // over a cover turns the directory, the same interaction grammar as agent books.
    // Volumes are rebuilt every relayout, so registration reconciles per relayout.
    state.registry.setPickable?.('volume');
    let volumeEntries = new Map();   // id → { vol, mesh } from the previous reconcile
    // The whole reconcile runs under a registry HOLD: V volumes unregistering +
    // re-registering per relayout is 2V listener passes without it — one with.
    const syncVolumeCovers = () => state.registry.holdChanges(() => {
      const ps = state.ctx.pickingSystem;
      for (const [id, prev] of volumeEntries) {
        try { state.registry.unregister?.(id); } catch (_e) { /* best effort */ }
        if (prev.mesh) { try { ps?.unregister?.('group', prev.mesh); } catch (_e) { /* best effort */ } }
      }
      const next = new Map();
      for (const vol of contentTree.volumes()) {
        const path = vol.userData.path;
        const id = `vol:${path}`;
        try { state.registry.register?.(id, vol, { type: 'book', role: 'volume', path }); } catch (_e) { /* best effort */ }
        const mesh = vol.cover?.mesh ?? null;
        if (ps && mesh) {
          Promise.resolve(ps._tslReady).then(() => {
            try { ps.register('group', mesh, vol); } catch (_e) { /* best effort */ }
          });
        }
        // Per-sheet edge tabs — one per file, banded up the cover by first letter,
        // each riding its sheet's deck slot (the thumb-index stagger). Render-only
        // for now (picking/click wired next); rebuilt with the volume each relayout.
        if (vol.sheets.length >= 2 && state.ctx.atlas) {
          vol.bindTabs({ atlas: state.ctx.atlas, lineHeight: Math.max(8, (vol.fitInfo?.pageH ?? 1000) * 0.018) });
        }
        next.set(id, { vol, mesh });
      }
      volumeEntries = next;
    });
    contentTree.onRelayout(syncVolumeCovers);

    // Agent books: the agent.* verbs sink here — each record an agent produces pages a
    // sheet (description verso, content recto) into that agent's book. The camera is
    // never touched; book.* turns the pages.
    state.ctx.agentBooks = new AgentBooks(state.ctx);
    // The agent shelf is the second world grouping — a sibling of the file tree on the shared floor
    // (its constructor scene-added its root; register reparents it under the world). It notifies the
    // world as it streams, so new agents/sheets re-space the whole layout.
    world.register('agents', state.ctx.agentBooks.root, () => state.ctx.agentBooks.localBounds());
    // Every extent change funnels through the books' relayout — including the ASYNC
    // card loads that settle after a book was seated (a hydration burst coalesces
    // here, never through onChange). Re-contain seated books FIRST (a late-settling
    // book otherwise keeps its pre-load scale and overlaps its shelf neighbors —
    // the giant-spread bug, seen in pixels), THEN re-space the world: the managed
    // shelf is a world grouping now, and the world must measure its POST-refit
    // footprint, not the one it just outgrew. (relayout is footprint-diffed — the
    // frequent nothing-moved case costs one measure and no writes.)
    state.ctx.agentBooks.onRelayout(() => {
      for (const carrel of state.ctx.carrels.values()) carrel.refit();
      world.relayout();
    });
    // Fold the persisted Agent Books settings into the freshly-built shelf (its apply()s
    // otherwise fire only on a user change), so tuned sizes hold from boot.
    applyGroupSettings(state.ctx, 'Agent Books');
    // The change event announces lane BIRTHS: restored books seat at the desk that
    // claims them (the manifest pass), new books at the auto-created 'agents' desk
    // (grid mode — the semi-grid shelf) by default; the deferred sweep respects
    // pins, docks, manual seats, and the book.autoShelf setting. (Seat
    // re-containment rides onRelayout above — the one funnel every extent change
    // passes through; onChange also fires for state/beacon flips that move nothing.)
    state.ctx.agentBooks.onChange?.(() => scheduleCarrelSweep(state.ctx));

    // Delta books: the delta.* verbs sink here — a changeset (a watched agent's live
    // edits, a git diff, a file pair) becomes a book of before/after spreads, one
    // sheet per changed file. A third world grouping on the shared floor.
    state.ctx.deltaBooks = new DeltaBooks(state.ctx);
    world.register('deltas', state.ctx.deltaBooks.root, () => state.ctx.deltaBooks.localBounds());
    state.ctx.deltaBooks.onRelayout(() => world.relayout());

    // Camera-locked HUD dock: a bar of window tiles that rides the view. Reparents
    // a docked grid/terminal under itself (world-preserving attach) and scales it to
    // a tile. Shares the AttentionManager so its .docks map is the record of truth.
    // <DockRunner/> ticks it; dock.* verbs drive it.
    const cameraDock = new CameraDock({ attentionManager: state.ctx.attentionManager, atlas: state.ctx.atlas });
    scene.add(cameraDock);
    state.ctx.cameraDock = cameraDock;
    state.ctx.holders.add(cameraDock);  // Holder protocol: dock joins on create
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
    // Hardware occlusion-query culling (three's native occlusionTest seam): every world
    // surface gets an invisible query proxy; candidates fully behind the OPAQUE occluder
    // set (1.0 page faces, panels) go dark. Registry-driven membership; docked tiles are
    // exempt (camera chrome is never occluded). Settings ▸ Culling arms it; cull.stats reads it.
    const occlusionCuller = new OcclusionCuller({ renderer: state.ctx.renderer, scene });
    occlusionCuller.shouldTest = (id) => !state.ctx.cameraDock?.has?.(id);
    state.ctx.occlusionCuller = occlusionCuller;
    // Tags (role||type): loose world citizens + agent deck roots. A card
    // inside a book is its book's problem — the culler never reaches in.
    const CULL_TAGS = new Set(['grid', 'terminal', 'frame', 'agent']);
    const syncCullCandidates = () => {
      for (const e of state.ctx.registry.list()) {
        if (CULL_TAGS.has(e.role || e.type)) occlusionCuller.track(e.id, e.grid);
      }
      occlusionCuller.pruneMissing((id) => state.ctx.registry.has(id));
    };
    state.ctx.registry.addChangeListener(syncCullCandidates);
    // Exposed for the cull.enabled setting: proxies exist only while culling is ON
    // (a disabled culler's ~N proxy meshes were pure scene-walk cost), so flipping
    // it on must re-track the current registry.
    state.ctx.syncCullCandidates = syncCullCandidates;
    syncCullCandidates();
    applyGroupSettings(state.ctx, 'Culling');

    const onRemoval = () => {
      // Agent books are hostable at carrels but live in AgentBooks' lanes, not the
      // registry — a liveness check that only asks the registry would dismiss a
      // seated agent book on every unrelated close. A lane is alive until cleared.
      const isLive = (id) => state.ctx.registry.has(id) || !!state.ctx.agentBooks?.lanes?.has?.(id);
      state.ctx.attentionManager?.pruneGone?.(isLive);
      cameraDock.pruneDismissed(isLive);
      for (const carrel of state.ctx.carrels.values()) carrel.pruneDismissed(isLive);
      // A gone NON-terminal surface drops its intent (e.g. a closed docked code grid) so capture
      // can't serialize a phantom tile. Terminals are spared — their PTY re-adopts and the surface
      // is the durable buffer that re-docks/re-sizes them (terminal.kill drops it explicitly).
      for (const s of state.ctx.workspace?.listSurfaces?.() || [])
        if (s.kind !== 'terminal' && !isLive(s.id)) state.ctx.workspace.removeSurface(s.id);
      // While restored desks have unseated members in the model, every registration is
      // a chance a claimed window just materialized (a re-adopted terminal, a reopened
      // file) — offer it its seat. Idempotent; no-op once all are seated.
      const unseated = (state.ctx.workspace?.listCarreled?.() ?? []).some((s) => {
        const desk = state.ctx.carrels?.get(s.view.carrel.name);
        return desk && !desk.has(s.id);
      });
      if (unseated) scheduleCarrelSweep(state.ctx);
    };
    state.ctx.registry.addChangeListener(onRemoval);

    // ROWS → ACTORS at the attention seam: focus (primary) or keyboard target (key)
    // landing on a FileRow materializes its CodeGrid actor. This listener is the
    // net under EVERY slot writer (clicks, nav verbs, mode/workspace restores —
    // most call am.set directly, not the attention.set verb); handlers that hold a
    // grid reference across this boundary resolve with { actor: true } instead.
    // Hover never materializes — sweeping over a thousand rows stays free.
    const materializeOnAttention = (value) => {
      if (!value?.id) return;
      if (state.ctx.registry.get(value.id)?.grid?.isFileRow) {
        materializeActor(state.ctx, value.id);
      }
    };
    state.ctx.attentionManager.on('change:primary', materializeOnAttention);
    state.ctx.attentionManager.on('change:key', materializeOnAttention);
    // The resolver-side seam: resolveGridByIdOrIndex({ actor: true }) upgrades
    // through this hook (spatialHelpers stays a pure-math layer, no app imports).
    state.ctx.materializeActor = (id) => materializeActor(state.ctx, id);

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

    // Terminal OUTPUT data plane: binary frames (type 1) carry raw VT bytes + the size tmux drew
    // them at → the terminal's emulator (grid.writeBytes). The bridge demuxes by type byte; terminal
    // semantics live here, keyed by the id the adapter stamped into the frame.
    bridge.onBinaryFrame(1, (id, bytes, cols, rows) => {
      const grid = state.ctx.terminals?.get(id);
      if (!grid) return;
      // Align the emulator to the size THIS content was drawn at BEFORE parsing it. Size and redraw
      // ride one ordered channel (see attach_unix.go), so a resize can never race ahead of its redraw
      // and address a row that doesn't exist — the split-across-a-WebSocket crash, gone by construction.
      if (cols > 0 && rows > 0 && (grid.cols !== cols || grid.rows !== rows)) grid.resize(cols, rows);
      grid.writeBytes?.(bytes);
    });

    // The relay's local file source. Swapped in as ctx.fileProvider on connect when
    // no explicit ?repo was given (the binary serving a project); GitHub stays the
    // baseline until then.
    const remoteProvider = new RemoteFileSystemProvider(bridge);
    // The agent-session archive (the relay's stored transcripts) — a PURE ADDITIVE
    // relay feature: agent.open / agent.sessions / the panel's Archive region read it;
    // client-only mode simply has no archive. Content semantics live in the adapter.
    state.ctx.sessionProvider = new AgentSessionProvider(bridge);
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

    // The keyboard responder chain: ONE capture-phase listener owning an ordered, composable
    // precedence (entity typing → Esc/context pop → nav keymap; camera WASD is the bubble-phase
    // fallthrough). The keyboard twin of gestureResolver — see keyboardRouter.js. Shares the SAME
    // AttentionManager that attention.set writes to. gestureEnv (for the Esc tier) reads ctx lazily
    // so it tracks the live interactionContext/cameraDock.
    const keystrokes = installKeyboardRouter({
      am: state.ctx.attentionManager,
      exec: (cmd) => state.router.execute(cmd),
      gestureEnv: {
        exec: (cmd) => state.router.execute(cmd),
        get attention() { return state.ctx.attentionManager; },
        get context() { return state.ctx.interactionContext; },
        get cameraDock() { return state.ctx.cameraDock; },
      },
    });
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

    // The PAGING wheel (shift+scroll): turns the book under the cursor. A separate gate from
    // tryScrollHovered because movement and page-turning are separate gestures — the camera
    // controller routes plain wheel there and shift+wheel here, and never mixes the two.
    state.ctx.tryPageHovered = (dy) => {
      if (!dy) return false;
      const hov = state.ctx.attentionManager?.get('hover');
      const entry = hov?.id ? state.registry.get(hov.id) : null;
      const cmd = wheelPageCommand(entry, dy);
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
      //   • tryPageHovered — shift+wheel turns the book under the cursor (paging, not movement).
      Object.defineProperty(cc.ctx, 'tryPageHovered', {
        configurable: true,
        get: () => state.ctx.tryPageHovered ?? null,
      });
      //   • dockTiles — the CameraDock's identity Set of docked grids; VCC's per-frame
      //     look-distance / fit-all skip them (camera-locked chrome, not world content).
      Object.defineProperty(cc.ctx, 'dockTiles', {
        configurable: true,
        get: () => state.ctx.cameraDock?.tiles ?? null,
      });
    }
    // Fold the persisted Camera dials in at boot (speed, auto-slow, soft bounds, draw
    // distance). Each apply self-guards on its subsystem, and the controller ref is live
    // by the time this effect runs — without this fold, stored values sat unused until
    // the panel next touched them.
    applyGroupSettings(state.ctx, 'Camera');

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
      // Learn what the binary serves BEFORE restore: session restore normalizes
      // saved relative paths against the served root, and the file browser needs
      // its anchors (root, home, reach roots). An old relay without fs/roots just
      // logs and the session starts anyway.
      remoteProvider.refreshRoots()
        .catch((err) => console.warn('[fs] roots unavailable:', err?.message || err))
        .finally(() => session.startOnConnect());
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
      offFrameWatch();
      offConn?.();
      for (const [id, prev] of volumeEntries) {
        try { state.registry.unregister?.(id); } catch (_e) { /* best effort */ }
        if (prev.mesh) { try { state.ctx.pickingSystem?.unregister?.('group', prev.mesh); } catch (_e) { /* best effort */ } }
      }
      state.registry.removeChangeListener(reconcileWorkspace);
      session.dispose();
      keystrokes();   // installKeyboardRouter returns its uninstall fn
      bridge.disconnect();
      pickingSystem.dispose();
      state.ctx.pickingSystem = null;
      state.ctx.agentBooks?.dispose();
      state.ctx.agentBooks = null;
      state.ctx.interactionContext?.dispose();
      state.ctx.interactionContext = null;
      if (state.ctx.cameraDock) {
        state.ctx.registry.removeChangeListener(onRemoval);
        scene.remove(state.ctx.cameraDock);
        state.ctx.cameraDock.dispose();
        state.ctx.cameraDock = null;
      }
      for (const carrel of state.ctx.carrels.values()) {
        scene.remove(carrel);
        carrel.dispose();
      }
      state.ctx.carrels.clear();
      state.ctx.activeCarrel = null;
      state.ctx.registry.removeChangeListener(syncCullCandidates);
      occlusionCuller.dispose();
      state.ctx.occlusionCuller = null;
    };
  }, [relay]);

  return (
    <AppCommandContext.Provider value={stateRef.current}>
      <AgentRunner stateRef={stateRef} />
      <DockRunner stateRef={stateRef} />
      {children}
    </AppCommandContext.Provider>
  );
}
