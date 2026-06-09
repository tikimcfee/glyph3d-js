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
// Kept at 1: the sizing/frame fields (grid window+frame+scroll, terminal cols/rows)
// are ADDITIVE and optional — restore guards each, so an older same-schema snapshot
// loads cleanly. v2 is NOT additive: `files` now means the TABS (sheet-backed grids)
// only, and a new `field` records the bulk source (repo / local). A v1 snapshot dumped
// the WHOLE field into `files`, so loading it under v2 restore would flood the tab bar —
// the schema-mismatch WIPE is intended here (one clean reset, then the v2 shape).
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
    /** @type {Array<{id:string,x:number,y:number,z:number,cols?:number,rows?:number}>} */
    this.pendingTerminals = [];     // last-known terminal placement + size, consumed by terminal re-adoption

    this._restored = false;         // load+restore runs ONCE per page load (not per reconnect)
    this._autosaveOn = false;       // gate: no save may clobber the file until restore finishes
    this._lastSavedCmp = null;      // dedup: skip writes when nothing changed
    this._saveTimer = null;
    this._periodic = null;
    this._disposed = false;

    this._onRegistryChange = () => { this._placePendingTerminals(); this.scheduleSave(); };
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
        const p = grid.position;
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
      field = { type: 'local', dir: ctx.fieldSource.dir || '', cap: ctx.fieldSource.cap ?? null };
    }

    const terminals = [];
    for (const e of ctx.registry.findByType('terminal')) {
      const p = e.grid.position;
      const entry = { id: e.id, x: round(p.x), y: round(p.y), z: round(p.z) };
      // Resize state: cols/rows live on the TerminalGrid (terminal.resize mutates them).
      if (Number.isInteger(e.grid.cols) && Number.isInteger(e.grid.rows)) {
        entry.cols = e.grid.cols;
        entry.rows = e.grid.rows;
      }
      terminals.push(entry);
    }

    let dock = this._pendingDock; // if we never got a live dock bridge, preserve what we loaded
    if (this._dock?.toJSON) {
      try { dock = this._dock.toJSON(); } catch (e) { console.warn('[session] dock toJSON failed:', e?.message || e); }
    }

    return {
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      files,
      field,
      camera: this._captureCamera(),
      dock: dock || null,
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
    if (snap.version !== SCHEMA_VERSION) {
      console.warn(`[session] schema mismatch (saved v${snap.version}, expected v${SCHEMA_VERSION}) — clearing session, not migrating`);
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
        // Replay the recorded pop exactly: same dir, same cap. (Pre-intent saves
        // carry neither — those fall back to the whole project at the default cap.)
        const dirArgs = ['file.openDir', snap.field.dir || ''];
        if (snap.field.cap != null) dirArgs.push(String(snap.field.cap));
        await this.router.execute(dirArgs);
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

    // Stash for the dock bridge (may not be registered yet) and for terminal
    // re-adoption (handled by the relay roster path, not here).
    this._pendingDock = snap.dock || null;
    this.pendingTerminals = Array.isArray(snap.terminals) ? snap.terminals : [];
    this._maybeApplyDock();
    } finally {
      this.ctx.status?.clear();
    }
  }

  async _fileExists(path) {
    try { await this.ctx.fileProvider.stat('file:///' + path); return true; }
    catch { return false; }
  }

  // Terminals re-adopt themselves on reload (the adapter re-creates its grid when
  // the reloaded display has forgotten it). We don't reconstruct them — we just
  // nudge each back to its saved position once it reappears in the registry.
  // Fired from the registry change listener; entries linger in pendingTerminals
  // until their terminal shows up (or forever if that shell died — harmless).
  _placePendingTerminals() {
    if (!this.pendingTerminals.length) return;
    const remaining = [];
    for (const t of this.pendingTerminals) {
      if (t?.id && isFinitePos(t) && this.ctx.registry.has(t.id)) {
        this.router.execute(`terminal.move ${t.id} ${t.x} ${t.y} ${t.z}`);
        // Restore saved size — terminal.resize drives grid + emulator + PTY in lockstep,
        // so the re-adopted shell comes back at its last dimensions, not the adapter default.
        const grid = this.ctx.registry.get(t.id)?.grid;
        if (Number.isInteger(t.cols) && Number.isInteger(t.rows) && t.cols > 0 && t.rows > 0
            && grid && (grid.cols !== t.cols || grid.rows !== t.rows)) {
          this.router.execute(`terminal.resize ${t.id} ${t.cols} ${t.rows}`);
        }
      } else {
        remaining.push(t);
      }
    }
    this.pendingTerminals = remaining;
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
    this.pendingTerminals = [];
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
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this._onVisibility);
  }
}
