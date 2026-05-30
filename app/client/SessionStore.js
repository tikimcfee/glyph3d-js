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
 * Self-heal policy (Ivan's call): when saved state doesn't match reality, CLEAR
 * IT WITH A LOG — never fight to resurrect. A missing file is dropped, a
 * non-finite camera is ignored, an orphaned dock panel is filtered, and a whole
 * snapshot whose schema version differs is wiped rather than migrated.
 */

const SESSION_URI = 'file:///.glyph3d-session.json';
const SCHEMA_VERSION = 1;
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
    /** @type {Array<{id:string,x:number,y:number,z:number}>} */
    this.pendingTerminals = [];     // last-known terminal positions, consumed by terminal re-adoption

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
    const files = [];
    for (const e of ctx.registry.findByType('grid')) {
      // The registry id IS the file path; meta.sourcePath is its file:// URI.
      const path = e.meta?.sourcePath ? e.meta.sourcePath.replace(/^file:\/\//, '') : e.id;
      const p = e.grid.position;
      files.push({ path, x: round(p.x), y: round(p.y), z: round(p.z) });
    }

    const terminals = [];
    for (const e of ctx.registry.findByType('terminal')) {
      const p = e.grid.position;
      terminals.push({ id: e.id, x: round(p.x), y: round(p.y), z: round(p.z) });
    }

    let dock = this._pendingDock; // if we never got a live dock bridge, preserve what we loaded
    if (this._dock?.toJSON) {
      try { dock = this._dock.toJSON(); } catch (e) { console.warn('[session] dock toJSON failed:', e?.message || e); }
    }

    return {
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      files,
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

    // Files first — so the camera (restored next) isn't fought by file.open's
    // framing, and so the dock/registry are populated.
    if (Array.isArray(snap.files)) {
      for (const f of snap.files) {
        if (!f?.path) continue;
        if (this.ctx.registry.has(f.path)) continue;              // already open — don't double
        if (!(await this._fileExists(f.path))) {
          console.warn(`[session] dropped missing file: ${f.path}`);
          continue;
        }
        try {
          await this.router.execute(`file.open ${f.path} ${f.x ?? 0} ${f.y ?? 0} ${f.z ?? 0}`);
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
