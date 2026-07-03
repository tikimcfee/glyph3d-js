/**
 * SessionStore — the IDE's saved-state system.
 *
 * Persists "what's loaded" to a SERVER-SIDE file (`.glyph3d-session.json` in the
 * project root, written via the relay's fs/writeFile RPC) so a reload — or a
 * different browser/device — comes back to the same workspace. It is the spiritual
 * successor to the vanilla IDE's StatePersistence, rebuilt for the r3f client:
 * one versioned snapshot blob (not field-by-field), restored by replaying bus
 * commands, with self-heal on every step.
 *
 * Two cooperating stores, by design:
 *   - THIS file persists what you RECONSTRUCT: open files (path + position),
 *     camera, and the dockview panel layout.
 *   - Live TERMINALS are re-adopted from the relay's live-adapter roster on
 *     reconnect (you reattach to a living shell, never resurrect a dead one);
 *     this file only carries their last positions as a placement hint.
 *
 * Self-heal policy: when saved state doesn't match reality, CLEAR
 * IT WITH A LOG — never fight to resurrect. A missing file is dropped, a
 * non-finite camera is ignored, an orphaned dock panel is filtered, and a whole
 * snapshot whose schema version differs is wiped rather than migrated.
 */

const SESSION_URI = 'file:///.glyph3d-session.json';
// Schema policy: restore is FORWARD-ADDITIVE. Every restored field is guarded/optional, so a
// snapshot at this version OR a newer one (read back after a code rollback over a newer file)
// loads the keys this build understands and ignores the rest — NEVER wiping on version drift
// (that drift-wipe used to destroy the session on any bump and block additive migration). The
// ONE hard cliff is v1→v2: v1 dumped the whole field into `files`, v2 made `files` mean the TABS
// only, so a v1 blob would flood the tab bar — restore() wipes `version < 2` once, cleanly. Bump
// this only for a genuinely incompatible reshape (and add its migration/wipe at the boundary).
const SCHEMA_VERSION = 2;
const SAVE_DEBOUNCE_MS = 600;
const PERIODIC_SAVE_MS = 5000;

const round = (n) => Math.round(n * 100) / 100;
const isFinitePos = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/**
 * A surface's POSITION is derived — never stored, never projected — iff it's a grid laid out by the
 * ContentTree: its xyz comes from `field.layout` + the tree path, recomputed on load. Terminals,
 * captures, and manually-moved/loose grids are NOT tree leaves, so their position is stored intent.
 * The one subtle discriminator the projection and capture paths share (STATE_ARCHITECTURE.md §9).
 * @param {object} ctx @param {string} id registry id
 */
export function positionIsDerived(ctx, id) {
  return ctx?.contentTree?.has?.(id) === true;
}

/**
 * Per-kind PROJECTORS: push a surface's view-intent onto its live object by calling the object's own
 * `applyView(view)` — DIRECT state, not a replay of the verbs that produced it. applyView is guarded
 * (a present, already-correct surface is a no-op), so this re-projects a genuinely-external child
 * (relay PTY, capture stream) when it re-adopts after the original gesture. Adding a surface kind =
 * adding a projector here. NOT a drift-scanner.
 * @type {Record<string, (store: SessionStore, s: object, grid: object) => void>}
 */
const SURFACE_PROJECTORS = {
  terminal(store, s, grid) {
    // Skip position while docked (the dock owns a docked tile's transform; its home is set by the
    // pre-dock move, then captured at lock). applyView sets the LOCAL geometry (position + grid +
    // emulator) directly — no terminal.move / terminal.resize verb replay on the load path.
    const docked = store.ctx.cameraDock?.has?.(s.id);
    const changed = grid.applyView?.(s.view || {}, { skipPosition: docked }) || {};
    // The relay PTY is the one external child the grid can't reach. If applyView resized the local
    // grid/emulator, tell the owning adapter to match (pty.Setsize → SIGWINCH → tmux), exactly as
    // terminal.resize does — the bridge lives at THIS layer, not on the grid.
    if (changed.resized) {
      const owner = store.ctx.registry.get(s.id)?.meta?.owner;
      if (owner && store.ctx.wsbridge?.connected) {
        store.ctx.wsbridge.push(owner, {
          event: 'terminal.resize',
          data: { terminalId: s.id, cols: changed.resized.cols, rows: changed.resized.rows },
        });
      }
    }
  },
};

export default class SessionStore {
  /** @param {{ ctx: object, router: object, bridge: object }} deps */
  constructor({ ctx, router, bridge }) {
    this.ctx = ctx;
    this.router = router;
    this.bridge = bridge;

    /** @type {{toJSON:Function, fromJSON:Function, components:string[]}|null} */
    this._dock = null;
    this._pendingDock = null;       // 2D dockview layout from a loaded snapshot, awaiting the dock bridge
    this._lastGoodDock = null;      // last live dock layout that actually had panels — anti-clobber (never persist an empty dock over a good one)
    // Surface intent (terminal geometry AND dock membership/order/zoom) lives in the WorkspaceModel
    // surface table (ctx.workspace) — the durable buffer. _projectSurfaces pushes it onto each live
    // object as it re-adopts (terminal applyView + dock reconcile). No pending queue, no scrape.
    this._offSurfaces = null;       // unsubscribe from the model's change:surfaces (autosave trigger)

    this._restored = false;         // load+restore runs ONCE per page load (not per reconnect)
    this._autosaveOn = false;       // gate: no save may clobber the file until restore finishes
    this._lastSavedCmp = null;      // dedup: skip writes when nothing changed
    this._saveTimer = null;
    this._periodic = null;
    this._disposed = false;

    this._onRegistryChange = () => { this._projectSurfaces(); this.scheduleSave(); };
    this._onVisibility = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.saveNow(); };
  }

  // -- Dock bridge ----------------------------------------------------------
  // IdeDock registers its dockview api here (it lives outside the Canvas/ctx).
  // Registering may complete the restore if a snapshot already loaded first.
  setDockBridge(dock) {
    this._dock = dock;
    this._maybeApplyDock();
  }

  // -- Capture --------------------------------------------------------------
  capture() {
    const ctx = this.ctx;
    // Persist the TABS (sheet-backed grids), NOT the whole field. A bulk repo/local
    // load drops hundreds of grids into the registry; those are the field, not tabs —
    // restoring them as individual file.opens floods the tab bar. The field is
    // persisted as one `field` source (below) and replayed in bulk on restore; only
    // sheets the user actually opened come back as tabs.
    const files = [];
    const ws = ctx.workspace;
    const sheets = ws ? ws.listActiveSheets(ctx.registry, ctx.attentionManager) : [];
    const sheetPanelIds = new Set();
    for (const s of sheets) {
      if (s.kind !== 'file') continue;
      const path = s.source?.path ?? (s.id.startsWith('sheet:') ? s.id.slice(6) : s.id);
      const entry = { path };
      const grid = (s.panelId && ctx.registry.has(s.panelId)) ? ctx.registry.get(s.panelId).grid : null;
      if (grid) {
        sheetPanelIds.add(s.panelId);
        // A docked grid's .position is its tiny tile-local coordinate; persist the
        // HOME it returns to on release instead, so the saved position is meaningful.
        const p = (ctx.cameraDock?.has?.(s.panelId) && ctx.cameraDock.homePosition(s.panelId)) || grid.position;
        entry.x = round(p.x); entry.y = round(p.y); entry.z = round(p.z);
        // Window state: a code grid sized to a cols×rows scrollable viewport (grid.window).
        if (grid.isWindowed?.()) {
          const w = grid.getWindow();
          if (w) entry.window = { cols: w.cols, rows: w.rows, firstLine: w.firstLine || 0 };
        }
        // Frame state (Step 3c.2): a clipped/scrolled code grid restores its window.
        // Omit zeros so unframed grids stay terse and the dedup compare stays stable.
        if (typeof grid.getFrameRows === 'function') {
          const frameRows = grid.getFrameRows() || 0;
          const scrollOffset = (grid.getScrollOffset?.() || 0);
          if (frameRows) entry.frameRows = frameRows;
          if (scrollOffset) entry.scrollOffset = scrollOffset;
        }
      }
      files.push(entry);
    }

    // The bulk field source — what fills the scene without tabs. ONE decider: ctx.fieldSource,
    // recorded INTENT written by the field-load handlers (file.openDir → {type:'local',dir};
    // repo.load → {type:'repo',ref}) and nulled by clearScene / scene.clear_grids. The provider's
    // _currentRepo is its OWN working state (it needs the parsed repo to fetch files) — a cache, not
    // this fact's owner; capture reads fieldSource alone. Never inferred from a census of non-tab
    // grids — a census can't tell a deliberate dir pop from grids other systems made, and it
    // re-trips on the grids its own restore opened (a session that could never stop bulk-loading).
    let field = null;
    const fs = ctx.fieldSource;
    if (fs?.type === 'repo' && fs.ref) field = { type: 'repo', ref: fs.ref };
    else if (fs?.type === 'local') field = { type: 'local', dir: fs.dir || '' };

    // Terminals: serialize the MODEL's surface view-intent (cols/rows + position), NOT a scrape of
    // the live grids. The model is the durable buffer — it holds a terminal's geometry whether or
    // not its grid is currently in the scene (the PTY re-adopts async on the relay's clock), so a
    // save landing mid-re-adopt reads a consistent intent snapshot instead of a half-built scene.
    // This retired pendingTerminals + the carry-forward + the docked-vs-loose position scrape.
    const terminals = [];
    if (ws?.listSurfaces) {
      for (const s of ws.listSurfaces()) {
        if (s.kind !== 'terminal') continue;
        const v = s.view || {};
        const entry = { id: s.id };
        if (isFinitePos(v.position)) { entry.x = round(v.position.x); entry.y = round(v.position.y); entry.z = round(v.position.z); }
        if (Number.isInteger(v.cols) && Number.isInteger(v.rows)) { entry.cols = v.cols; entry.rows = v.rows; }
        terminals.push(entry);
      }
    }

    let dock = this._pendingDock; // if we never got a live dock bridge, preserve what we loaded
    if (this._dock?.toJSON) {
      try {
        const live = this._dock.toJSON();
        // Never persist a degenerate EMPTY dock (panels:{}) over a good layout — a
        // reload caught mid-rebuild, an all-closed dock, or (historically) experiment
        // churn would otherwise clobber the saved layout with an empty grid and strand
        // the next restore. Persist the live layout only when it actually has panels;
        // otherwise keep the last one that did.
        if (live?.panels && Object.keys(live.panels).length > 0) { dock = live; this._lastGoodDock = live; }
        else dock = this._lastGoodDock ?? dock;
      } catch (e) { console.warn('[session] dock toJSON failed:', e?.message || e); }
    }

    // The 3D camera-dock: ordered membership + per-tile zoom/pin, read straight from the MODEL
    // (ws.listDocked, sorted by the persisted slot order) — NOT a scrape of the live CameraDock. The
    // model is the durable buffer, so a docked terminal still re-adopting (its grid temporarily
    // gone) stays in the snapshot without a carry-forward shadow. The CameraDock is just the
    // projection; only its layout mode is read live. Array order IS the slot order on restore.
    let dock3d = null;
    const docked = ws?.listDocked ? ws.listDocked() : [];
    if (docked.length) {
      const tiles = docked.map((s) => ({ id: s.id, zoom: (s.view || {}).zoom ?? 1 }));
      // The active frame pane — persisted so a reload re-raises the single-occupant pin. (Multi-pane
      // split trees are re-framed as the active pane for now; full tree persistence is the next pass.)
      dock3d = { layout: ctx.cameraDock?.layoutMode || 'linear', tiles, focused: ctx.cameraDock?.focusedPane || null };
    }

    return {
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      files,
      field,
      layout: this._captureLayout(),
      camera: this._captureCamera(),
      focus: this._captureFocus(),
      dock: dock || null,
      dock3d: dock3d || null,
      terminals,
    };
  }

  // Focus = the sticky `primary` (what you're looking at) + `key` (keystroke target) attention slots,
  // by id only. Hover is transient (mouse position) — never persisted. Ids can be any kind (grid,
  // terminal, dir:, agent:); restore sets them directly and lets pruning self-heal a stale one.
  _captureFocus() {
    const am = this.ctx.attentionManager;
    if (!am?.get) return null;
    const primary = am.get('primary')?.id ?? null;
    const key = am.get('key')?.id ?? null;
    return (primary || key) ? { primary, key } : null;
  }

  // Field layout = serializable state read DIRECTLY off the live tree (scheme name + opt overrides),
  // not a bus round-trip — router.execute is async, so a synchronous read of its result was always
  // null (the bug that silently saved no scheme). The ContentTree owns the name<->function mapping.
  _captureLayout() {
    return this.ctx.contentTree?.getLayoutState?.() ?? null;
  }

  // Camera = serializable state read DIRECTLY off the controller (position + pitch/yaw + speed —
  // its complete pose; pitch/yaw are the raw quaternion inputs, so no forward/target reconstruction).
  // Rounded here only to keep the dedup compare and the on-disk blob terse.
  _captureCamera() {
    const s = this.ctx.cameraController?.getState?.();
    if (!s || !isFinitePos(s.pos)) return null;
    return {
      pos: { x: round(s.pos.x), y: round(s.pos.y), z: round(s.pos.z) },
      pitch: round(s.pitch),
      yaw: round(s.yaw),
      speed: s.speed ?? null,
    };
  }

  // -- Save -----------------------------------------------------------------
  scheduleSave() {
    if (this._disposed || !this._autosaveOn) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
  }

  async saveNow() {
    if (this._disposed || !this._autosaveOn) return;
    let snap;
    try { snap = this.capture(); } catch (e) { console.warn('[session] capture failed:', e?.message || e); return; }
    // Dedup on everything-but-the-timestamp so a quiet IDE doesn't churn the file.
    const cmp = JSON.stringify({ ...snap, savedAt: 0 });
    if (cmp === this._lastSavedCmp) return;
    try {
      await this.bridge.rpcRequest('fs/writeFile', { uri: SESSION_URI, content: JSON.stringify(snap) });
      this._lastSavedCmp = cmp;
    } catch (e) {
      console.warn('[session] save failed:', e?.message || e);
    }
  }

  // -- Load -----------------------------------------------------------------
  async load() {
    try {
      const fc = await this.ctx.fileProvider.readFile(SESSION_URI);
      return JSON.parse(fc.content);
    } catch (e) {
      // First run (no file) lands here too — that's not an error.
      console.debug('[session] no saved session to load:', e?.message || e);
      return null;
    }
  }

  // -- Restore (self-heal: clear-with-log on mismatch) ----------------------
  async restore(snap) {
    if (!snap || typeof snap !== 'object') return;
    // Forward-additive: a snapshot at this major (v2) or a FUTURE one (after a code rollback over
    // a newer file) restores its known, guarded keys and ignores the rest — no wipe on version
    // drift. Only the genuine cliff wipes: v1 stored the whole field in `files` (v2 made `files`
    // mean TABS only), so a v1 blob under v2 restore would flood the tab bar — reset it once.
    if (typeof snap.version !== 'number' || snap.version < 2) {
      console.warn(`[session] incompatible schema (saved v${snap.version}) — clearing, not migrating`);
      await this._clear();
      return;
    }

    // Live status for the reload story — the field/tab ops below override it with
    // their own, then clear; this finally tidies up the slot at the end.
    this.ctx.status?.set('Restoring session…');
    try {
    // Field layout scheme FIRST — SET it directly on the (still-empty) tree (no verb replay) so the
    // bulk field-load below and every grid land in the saved scheme instead of the packed default.
    if (snap.layout?.scheme) this.ctx.contentTree?.applyLayoutState?.(snap.layout);

    // The bulk field fills the scene first (no tabs), so tabs layer on top and the
    // camera (restored last) wins. repo.load clears the scene itself; both are
    // guarded so a network/offline failure still lets the tabs restore.
    if (snap.field?.type === 'repo' && snap.field.ref) {
      try { await this.router.execute(['repo.load', snap.field.ref]); }
      catch (e) { console.warn('[session] repo field restore failed:', e?.message || e); }
    } else if (snap.field?.type === 'local') {
      try {
        // Replay the recorded pop exactly (a pre-intent save carries no dir —
        // that restores as the whole project).
        await this.router.execute(['file.openDir', snap.field.dir || '']);
        await this.router.execute('camera.fitall');
      } catch (e) { console.warn('[session] local field restore failed:', e?.message || e); }
    }

    // Tabs next — so the camera (restored next) isn't fought by file.open's framing,
    // and so the dock/registry are populated.
    if (Array.isArray(snap.files)) {
      let anyWindowed = false;
      for (const f of snap.files) {
        if (!f?.path) continue;
        // The grid may already exist (the field-restore above bulk-loaded it). Still
        // run file.open — it dedups the grid and creates the SHEET, so the file comes
        // back as a tab. Only probe existence for files not already loaded.
        const already = this.ctx.registry.has(f.path);
        if (!already && !(await this._fileExists(f.path))) {
          console.warn(`[session] dropped missing file: ${f.path}`);
          continue;
        }
        try {
          await this.router.execute(`file.open ${f.path} ${f.x ?? 0} ${f.y ?? 0} ${f.z ?? 0}`);
          // Viewport (window / frame / scroll) loads as DIRECT state — the grid's own applyView,
          // NOT a replay of grid.window/grid.frame/grid.scroll. file.open created/deduped the grid +
          // sheet; the viewport rides on top. applyView orders window→frame→scroll itself and is
          // absolute (no "scroll-from-0" assumption).
          if (f.window || f.frameRows || f.scrollOffset) {
            const grid = this.ctx.registry.get(f.path)?.grid;
            if (grid?.applyView) {
              const { windowed } = await grid.applyView({ window: f.window, frameRows: f.frameRows, scrollOffset: f.scrollOffset });
              if (windowed) anyWindowed = true;
            }
          }
        } catch (e) {
          console.warn(`[session] failed to reopen ${f.path}:`, e?.message || e);
        }
      }
      // Windowing changes a grid's footprint → relayout the tree ONCE after all tabs land (the
      // grid.window verb did this per-call; batching is the same end-state, less churn).
      if (anyWindowed) this.ctx.contentTree?.relayoutAndRest?.();
    }

    this._restoreCamera(snap.camera);

    // Publish the loaded INTENT — terminal size/placement, dockview layout, and 3D
    // dock membership/zoom — then reconcile it into whatever has re-adopted so far.
    // Normalize dock3d tiles to { id, zoom } (tolerant of the legacy string-id form).
    this._pendingDock = snap.dock || null;
    // Load terminal geometry intent into the model (the durable buffer). apply() pushes it onto
    // each terminal grid as it re-adopts — at end-of-restore (below) and via the registry listener.
    if (Array.isArray(snap.terminals)) {
      for (const t of snap.terminals) {
        if (!t?.id) continue;
        const view = {};
        if (isFinitePos(t)) view.position = { x: t.x, y: t.y, z: t.z };
        if (Number.isInteger(t.cols) && Number.isInteger(t.rows)) { view.cols = t.cols; view.rows = t.rows; }
        this.ctx.workspace?.setSurfaceView?.(t.id, 'terminal', view);
      }
    }
    // Dock membership/order/zoom/pin → the MODEL (the durable buffer the reconcile reads), and the
    // bar LAYOUT straight onto the live CameraDock. `dockOrder` = the tile's index in the saved
    // slot-ordered array, so a terminal re-adopting out of arrival order still lands in its saved
    // bar slot. No verb replay, no _pendingDock3d: _projectSurfaces → _reconcileDock locks each tile
    // as its grid goes live, in any order. Tolerant of the legacy string-tile form.
    if (snap.dock3d?.tiles?.length) {
      this.ctx.cameraDock?.setLayout?.(snap.dock3d.layout || 'linear');
      // The window that holds the root view-frame (pinned) — a dock-level fact, not a per-surface
      // flag. _reconcileDock re-raises it once it's a live tile (spotlight → frame-fit + Pin light).
      this._pendingFrameOccupant = snap.dock3d.focused || null;
      snap.dock3d.tiles.forEach((t, i) => {
        const id = typeof t === 'string' ? t : t?.id;
        if (!id) return;
        const patch = { docked: true, dockOrder: i, zoom: (typeof t === 'object' ? t.zoom : 1) ?? 1 };
        // kind undefined: don't clobber a terminal's 'terminal' kind (set by the loop above); a docked
        // code grid with no prior record becomes a generic 'surface' (the reconcile ignores kind).
        this.ctx.workspace?.setSurfaceView?.(id, undefined, patch);
      });
    }
    this._maybeApplyDock();

    // One reconcile pass at the end of restore. Re-adoption is driven by an independent
    // adapter ping loop that races this whole method, and the registry-change listener
    // isn't armed until _armAutosave (below) — so a terminal that re-created DURING the
    // awaits above is already in the registry but was never sized/placed. This nets it
    // (and any docked surface whose home only now exists); later stragglers re-adopt
    // into the live listener, which runs the SAME _projectSurfaces.
    this._projectSurfaces();

    // Focus LAST — after surfaces re-adopt, so a focused grid/terminal is live when we set it.
    this._restoreFocus(snap.focus);
    } finally {
      this.ctx.status?.clear();
    }
  }

  // Restore the sticky focus by SETTING the attention slots directly (the AttentionManager IS the
  // owner — set() is its writer, not a verb replay). Self-healing by design: an id whose entity
  // isn't live sets with entity null and is pruned on the next registry change (pruneGone) — exactly
  // the mirror-of-reality policy. Setting primary/key emits change:<slot>; no listener flies the
  // camera (that lives in the click path), so this can't clobber the just-restored pose.
  _restoreFocus(focus) {
    const am = this.ctx.attentionManager;
    if (!focus || !am?.set) return;
    if (focus.primary) am.set('primary', focus.primary, { registry: this.ctx.registry });
    if (focus.key) am.set('key', focus.key, { registry: this.ctx.registry });
  }

  async _fileExists(path) {
    try { await this.ctx.fileProvider.stat('file:///' + path); return true; }
    catch { return false; }
  }

  // The deferred-construction tail of the projection. The live three object is a PROJECTION of the
  // model, never a peer that drifts: a verb writes intent AND projects it synchronously, so the
  // common path is correct by construction. THIS exists only for genuinely-external children — the
  // relay-backed PTY (and, later, the capture stream) re-adopt on their own clock and reappear AFTER
  // the verb ran, ALWAYS at a default size — so we re-project them from the model when they land.
  // Driven by the registry-change listener (each surface as it reappears) + one pass at the end of
  // restore (any that re-adopted mid-restore, before the listener was armed). Per-kind via
  // SURFACE_PROJECTORS, guarded → a present, already-correct surface is a no-op (NOT a drift-scan).
  // Order is load-bearing: surfaces move/size FIRST so the subsequent 3D-dock lock captures the
  // RESTORED home, not the adapter's spawn placement.
  _projectSurfaces() {
    const ws = this.ctx.workspace;
    if (ws?.listSurfaces) {
      for (const s of ws.listSurfaces()) {
        if (!this.ctx.registry.has(s.id)) continue;
        const grid = this.ctx.registry.get(s.id)?.grid;
        if (grid) SURFACE_PROJECTORS[s.kind]?.(this, s, grid);
      }
    }
    this._reconcileDock();
  }

  // Dock = f(model): converge the live CameraDock to the model's docked surfaces. ADDITIVE — it locks
  // each docked surface that's live but not yet a tile (a terminal re-adopting AFTER restore lands
  // here when its grid appears) and re-applies its zoom + pin. It does NOT release: a verb releases
  // live (writing docked:false), and a gone window is dismissed by pruneDismissed — both keep model
  // and dock in step without this pass fighting them. The model IS the durable buffer, so there's no
  // pending queue: a not-yet-live docked surface is simply skipped and caught on the next pass. This
  // replaced the dock.lock + window.scale VERB REPLAY (+ the _pendingDock3d carry-forward shadow).
  // Runs after the per-surface projection above, so a docked terminal is moved/sized to its restored
  // home BEFORE it's reparented into a tile.
  _reconcileDock() {
    const cd = this.ctx.cameraDock;
    const ws = this.ctx.workspace;
    if (!cd || !ws?.listDocked) return;
    for (const s of ws.listDocked()) {
      if (cd.has(s.id)) continue;                       // already a tile
      if (!this.ctx.registry.has(s.id)) continue;       // not live yet → re-adopts later, caught next pass
      const grid = this.ctx.registry.get(s.id)?.grid;
      if (!grid) continue;
      const v = s.view || {};
      // Per-tile guard: one bad surface must not abort the whole reconcile.
      try {
        // Direct CameraDock method (NOT a dock.lock verb). The saved slot order pins the bar
        // position regardless of arrival timing.
        cd.lock(s.id, grid, { order: v.dockOrder });
        // Re-apply the readability zoom (the dock reads `user` back for its box-fit).
        if (v.zoom && v.zoom !== 1) { grid.setZoom?.(v.zoom); cd.reflowTile?.(s.id); }
        // Re-raise the saved frame occupant (pinned window) once it's a live tile — spotlight() fits
        // it into the root view-frame and lights its Pin button. A dock-level fact, applied once.
        if (this._pendingFrameOccupant === s.id && cd.focusedPane !== s.id) {
          cd.spotlight(s.id);
          this._pendingFrameOccupant = null;
        }
      } catch (e) {
        console.warn(`[session] dock reconcile failed for '${s.id}' — skipping:`, e?.message || e);
      }
    }
  }

  // Load the camera by SETTING it directly on the controller — no camera.move/aim verb replay (which
  // fired async and fought the field-restore fly), no quaternion stomp. applyState cancels any
  // in-flight fly and lands the saved pose exactly.
  _restoreCamera(cam) {
    if (!cam?.pos) return;
    if (!isFinitePos(cam.pos)) { console.warn('[session] dropped non-finite camera position'); return; }
    this.ctx.cameraController?.applyState?.(cam);
  }

  _maybeApplyDock() {
    if (!this._dock?.fromJSON || !this._pendingDock) return;
    const layout = this._filterDockOrphans(this._pendingDock);
    try {
      this._dock.fromJSON(layout);
    } catch (e) {
      console.warn('[session] dock restore failed — keeping default layout:', e?.message || e);
    }
    this._pendingDock = null;
  }

  // Drop any saved panel whose component is no longer registered, so a removed
  // panel type doesn't render as dockview's blank "unknown" placeholder.
  _filterDockOrphans(layout) {
    const known = this._dock?.components;
    if (!layout?.panels || !Array.isArray(known)) return layout;
    const panels = {};
    for (const [id, p] of Object.entries(layout.panels)) {
      const comp = p?.contentComponent;
      if (comp && !known.includes(comp)) {
        console.warn(`[session] dropped dock panel '${id}' — unknown component '${comp}'`);
        continue;
      }
      panels[id] = p;
    }
    return { ...layout, panels };
  }

  // Public clear — wipe the saved snapshot on demand (the `session.clear` verb).
  // Drops the pending 2D-dock layout so a stale snapshot can't re-apply, then writes the empty file.
  // Dock membership lives in the model now (cleared by clearScene), not a pending buffer here.
  // Live objects stay in the scene; autosave re-captures them on the next change (mirror-of-reality).
  async clear() {
    this._pendingDock = null;
    await this._clear();
  }

  async _clear() {
    this._lastSavedCmp = null;
    try {
      await this.bridge.rpcRequest('fs/writeFile', {
        uri: SESSION_URI,
        content: JSON.stringify({ version: SCHEMA_VERSION, savedAt: Date.now(), files: [], camera: null, dock: null, terminals: [] }),
      });
    } catch (e) {
      console.warn('[session] clear failed:', e?.message || e);
    }
  }

  // -- Lifecycle ------------------------------------------------------------
  // Load + restore exactly once (first connect after a page load); then arm
  // autosave. Reconnects after that don't re-restore — the scene already holds
  // the in-browser state, and re-restoring would snap the camera back.
  async startOnConnect() {
    if (this._restored) return;
    this._restored = true;
    const snap = await this.load();
    if (snap) {
      try { await this.restore(snap); }
      catch (e) { console.warn('[session] restore failed:', e?.message || e); }
    }
    this._armAutosave();
  }

  _armAutosave() {
    if (this._disposed) return;
    this._autosaveOn = true;
    this.ctx.registry.addChangeListener(this._onRegistryChange);
    // A verb writing the model (terminal.resize/move/…) is intent changing — save it. The model
    // emits change:surfaces only on a real change, so this can't churn on idempotent re-pushes.
    this._offSurfaces = this.ctx.workspace?.on?.('change:surfaces', () => this.scheduleSave()) || null;
    // Camera pose is intent too, but it lives on the controller, not the model — so the controller
    // fires onMoved when the pose actually changes (debounced here → one save when flight settles).
    // This is the fix for "saved the first time, not again": without it, a move persisted only if a
    // periodic tick or tab-hide happened to catch it before reload.
    if (this.ctx.cameraController) this.ctx.cameraController.onMoved = () => this.scheduleSave();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this._onVisibility);
    this._periodic = setInterval(() => this.scheduleSave(), PERIODIC_SAVE_MS);
  }

  dispose() {
    this._disposed = true;
    this._autosaveOn = false;
    clearTimeout(this._saveTimer);
    clearInterval(this._periodic);
    this.ctx.registry.removeChangeListener(this._onRegistryChange);
    if (this.ctx.cameraController) this.ctx.cameraController.onMoved = null;
    this._offSurfaces?.();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this._onVisibility);
  }
}
