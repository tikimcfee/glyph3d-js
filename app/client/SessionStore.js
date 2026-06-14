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
const CAMERA_TARGET_DIST = 100; // how far ahead to place the look-target we restore via camera.aim

const round = (n) => Math.round(n * 100) / 100;
const isFinitePos = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

// Camera forward = local -Z rotated by the camera quaternion. We save a look
// TARGET (pos + forward) rather than a raw rotation so restore can go through
// camera.aim, which re-syncs the controller's pitch/yaw (a raw quaternion set
// would desync the next mouse input).
function forwardFromQuat(q) {
  const { x, y, z, w } = q;
  return {
    x: -2 * (x * z + w * y),
    y: -2 * (y * z - w * x),
    z: -(1 - 2 * (x * x + y * y)),
  };
}

export default class SessionStore {
  /** @param {{ ctx: object, router: object, bridge: object }} deps */
  constructor({ ctx, router, bridge }) {
    this.ctx = ctx;
    this.router = router;
    this.bridge = bridge;

    /** @type {{toJSON:Function, fromJSON:Function, components:string[]}|null} */
    this._dock = null;
    this._pendingDock = null;       // dock layout from a loaded snapshot, awaiting the dock bridge
    this._pendingDock3d = null;     // {layout, tiles[]} from a snapshot, applied as surfaces reappear (CameraDock)
    // Terminal geometry intent now lives in the WorkspaceModel surface table (ctx.workspace),
    // the durable buffer — apply() pushes it onto each grid as it re-adopts. No pending queue.
    this._offSurfaces = null;       // unsubscribe from the model's change:surfaces (autosave trigger)

    this._restored = false;         // load+restore runs ONCE per page load (not per reconnect)
    this._autosaveOn = false;       // gate: no save may clobber the file until restore finishes
    this._lastSavedCmp = null;      // dedup: skip writes when nothing changed
    this._saveTimer = null;
    this._periodic = null;
    this._disposed = false;

    this._onRegistryChange = () => { this._reconcileSurfaces(); this.scheduleSave(); };
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

    // The bulk field source — what fills the scene without tabs. A GitHub repo
    // restores via repo.load; a relay-local project via file.openDir. Both are
    // recorded INTENT: the repo from the provider's loaded repo, the local field
    // from ctx.fieldSource (written by the file.openDir handler, cleared by
    // scene.clear_grids). Never inferred from a census of non-tab grids — a
    // census can't tell a deliberate dir pop from grids other systems created,
    // and it re-trips on the grids its own restore opened (a session that could
    // never stop bulk-loading the whole project).
    let field = null;
    const repo = ctx.fileProvider?._currentRepo;
    if (repo?.owner) {
      field = { type: 'repo', ref: `${repo.owner}/${repo.repo}${repo.branch ? '/' + repo.branch : ''}` };
    } else if (ctx.fieldSource?.type === 'local') {
      field = { type: 'local', dir: ctx.fieldSource.dir || '' };
    }

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
      try { dock = this._dock.toJSON(); } catch (e) { console.warn('[session] dock toJSON failed:', e?.message || e); }
    }

    // The 3D camera-dock: ordered tile membership + layout mode. If a surface hasn't
    // reappeared yet (terminal re-adopting), its id is still in _pendingDock3d —
    // carry those forward so a save mid-restore doesn't drop them.
    let dock3d = this._pendingDock3d;
    const cd = ctx.cameraDock;
    if (cd) {
      // Each tile records its readability zoom alongside membership, so a docked window
      // restores at the size the operator scaled it to (orthogonal to its cols/rows). A
      // pinned window also carries its pin state (+ the pre-pin zoom) so a post-reload
      // unpin still drops back to the right size. (Loose-window zoom/pin persistence is
      // the known migration gap — only docked tiles round-trip today.)
      const tiles = cd.list().sort((a, b) => a.slot - b.slot).map((t) => {
        const v = ctx.workspace?.getSurface?.(t.id)?.view || {};
        const tile = { id: t.id, zoom: t.zoom ?? 1 };
        if (v.pinned) { tile.pinned = true; tile.prePinZoom = v.prePinZoom ?? 1; }
        return tile;
      });
      const have = new Set(tiles.map((t) => t.id));
      const pend = this._pendingDock3d?.tiles?.filter((t) => !have.has(t.id)) || [];
      const all = [...tiles, ...pend];
      dock3d = all.length ? { layout: cd.layoutMode, tiles: all } : null;
    }

    return {
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      files,
      field,
      camera: this._captureCamera(),
      dock: dock || null,
      dock3d: dock3d || null,
      terminals,
    };
  }

  _captureCamera() {
    const cam = this.ctx.camera;
    if (!cam?.position) return null;
    const p = cam.position;
    const fwd = forwardFromQuat(cam.quaternion);
    return {
      pos: { x: round(p.x), y: round(p.y), z: round(p.z) },
      target: {
        x: round(p.x + fwd.x * CAMERA_TARGET_DIST),
        y: round(p.y + fwd.y * CAMERA_TARGET_DIST),
        z: round(p.z + fwd.z * CAMERA_TARGET_DIST),
      },
      fov: cam.fov ?? null,
      speed: this.ctx.cameraController?.cameraSpeed ?? null,
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
          // Restore sizing + frame state (each a no-op when absent). Window first —
          // it re-renders the slice; grid.window takes an absolute firstLine to
          // reproduce the scroll. Then frame/scroll: file.open lands at scroll 0, so
          // a relative scroll by the saved offset reproduces the absolute position.
          const w = f.window;
          if (w && w.cols > 0 && w.rows > 0) {
            await this.router.execute(`grid.window ${f.path} ${w.cols} ${w.rows} ${w.firstLine || 0}`);
          }
          if (f.frameRows > 0) await this.router.execute(`grid.frame ${f.path} ${f.frameRows}`);
          if (f.scrollOffset > 0) await this.router.execute(`grid.scroll ${f.path} ${f.scrollOffset}`);
        } catch (e) {
          console.warn(`[session] failed to reopen ${f.path}:`, e?.message || e);
        }
      }
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
    this._pendingDock3d = (snap.dock3d?.tiles?.length)
      ? {
          layout: snap.dock3d.layout || 'linear',
          tiles: snap.dock3d.tiles.map((t) =>
            (typeof t === 'string'
              ? { id: t, zoom: 1 }
              : { id: t.id, zoom: t.zoom ?? 1, pinned: !!t.pinned, prePinZoom: t.prePinZoom })),
        }
      : null;
    this._maybeApplyDock();

    // One reconcile pass at the end of restore. Re-adoption is driven by an independent
    // adapter ping loop that races this whole method, and the registry-change listener
    // isn't armed until _armAutosave (below) — so a terminal that re-created DURING the
    // awaits above is already in the registry but was never sized/placed. This nets it
    // (and any docked surface whose home only now exists); later stragglers re-adopt
    // into the live listener, which runs the SAME _reconcileSurfaces.
    this._reconcileSurfaces();
    } finally {
      this.ctx.status?.clear();
    }
  }

  async _fileExists(path) {
    try { await this.ctx.fileProvider.stat('file:///' + path); return true; }
    catch { return false; }
  }

  // Reconcile the loaded INTENT into the live scene as surfaces re-adopt. The SINGLE entry
  // point — driven both by the registry-change listener (each surface as it reappears) and by
  // the final pass at the end of restore (any that re-adopted mid-restore, before the listener
  // was armed). Order is load-bearing: terminals move/size FIRST so the subsequent 3D-dock lock
  // captures the RESTORED home, not the adapter's spawn placement. Idempotent, so repeats are free.
  _reconcileSurfaces() {
    this._applyTerminalViews();
    this._applyDock3d();
  }

  // apply(): push terminal geometry intent from the MODEL onto each live terminal grid. The PTY
  // re-adopts async — the adapter re-creates its grid on a liveness-ping bounce, ALWAYS at its
  // startup 80×24 (never the resized size), so the model is the only record — so this runs both as
  // terminals reappear (the registry listener) and once at end-of-restore. The model is NOT
  // consumed: each push is a guarded set-to-target (resize/move only when the grid differs),
  // idempotent, so re-running is free and order stops mattering. This retired pendingTerminals.
  _applyTerminalViews() {
    const ws = this.ctx.workspace;
    if (!ws?.listSurfaces) return;
    for (const s of ws.listSurfaces()) {
      if (s.kind !== 'terminal' || !this.ctx.registry.has(s.id)) continue;
      const grid = this.ctx.registry.get(s.id)?.grid;
      if (!grid) continue;
      const v = s.view || {};
      // Position: skip while docked — the dock owns a docked tile's transform (its home is set by
      // the pre-dock move below, then captured at lock). Loose terminals get moved to their home.
      const docked = this.ctx.cameraDock?.has?.(s.id);
      if (!docked && isFinitePos(v.position)
          && (grid.position.x !== v.position.x || grid.position.y !== v.position.y || grid.position.z !== v.position.z)) {
        this.router.execute(`terminal.move ${s.id} ${v.position.x} ${v.position.y} ${v.position.z}`);
      }
      // Size: terminal.resize drives grid + emulator + PTY in lockstep; guarded so it only fires
      // when the re-adopted grid (spawned at 80×24) differs from the intent.
      if (Number.isInteger(v.cols) && Number.isInteger(v.rows) && v.cols > 0 && v.rows > 0
          && (grid.cols !== v.cols || grid.rows !== v.rows)) {
        this.router.execute(`terminal.resize ${s.id} ${v.cols} ${v.rows}`);
      }
    }
  }

  // Replay 3D dock membership as surfaces reappear. Code grids are back synchronously
  // after restore()'s file loop; terminals re-adopt later, so this is also fired from
  // the registry-change listener (after _applyTerminalViews, so a docked terminal
  // captures a sensible home before it's reparented away). Ids not yet in the registry
  // linger in _pendingDock3d (or forever, if that shell died — harmless).
  _applyDock3d() {
    const cd = this.ctx.cameraDock;
    const pend = this._pendingDock3d;
    if (!cd || !pend) return;
    if (pend.layout) cd.setLayout(pend.layout);
    const remaining = [];
    for (const t of pend.tiles) {
      if (cd.has(t.id)) continue;
      if (this.ctx.registry.has(t.id)) {
        // Array form skips the router's space-tokenizer — a registry id can be a file path.
        this.router.execute(['dock.lock', t.id]);
        // Restore the readability zoom after the lock captures home (the dock reads
        // user back for layout, so this re-places the tile at its saved size).
        if (t.zoom && t.zoom !== 1) this.router.execute(['window.scale', t.id, String(t.zoom)]);
        // Re-seat the pin view state: the saved zoom already IS the pinned (max) size, so
        // this only restores the flag + pre-pin zoom so a later unpin drops back correctly,
        // and lights the Pin button to match.
        if (t.pinned) {
          this.ctx.workspace?.setSurfaceView?.(t.id, 'terminal', { pinned: true, prePinZoom: t.prePinZoom ?? 1 });
          this.ctx.registry?.get?.(t.id)?.grid?.setControlActive?.('pin', true);
        }
      } else {
        remaining.push(t);
      }
    }
    this._pendingDock3d = remaining.length ? { layout: pend.layout, tiles: remaining } : null;
  }

  _restoreCamera(cam) {
    if (!cam?.pos) return;
    if (!isFinitePos(cam.pos)) { console.warn('[session] dropped non-finite camera position'); return; }
    this.router.execute(`camera.move ${cam.pos.x} ${cam.pos.y} ${cam.pos.z}`);
    if (isFinitePos(cam.target)) {
      this.router.execute(`camera.aim ${cam.target.x} ${cam.target.y} ${cam.target.z}`);
    }
    if (cam.speed != null && this.ctx.cameraController) this.ctx.cameraController.cameraSpeed = cam.speed;
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
  // Drops any pending dock/terminal placement so a stale snapshot can't re-apply,
  // then writes the empty file. Live objects stay in the scene; autosave will
  // re-capture them on the next change (clear-with-log, mirror-of-reality policy).
  async clear() {
    this._pendingDock = null;
    this._pendingDock3d = null;
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
    this._offSurfaces?.();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this._onVisibility);
  }
}
