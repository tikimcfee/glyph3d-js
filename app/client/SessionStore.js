/**
 * SessionStore — the IDE's saved-state system.
 *
 * Persists "what's loaded" to a SERVER-SIDE file (`.glyph3d-session.json` in the
 * project root, written via the relay's fs/writeFile RPC) so a reload — or a
 * different browser/device — comes back to the same workspace: one versioned
 * snapshot blob, restored by a STAGED PHASED LOADER, autosaved on change after.
 *
 * RESTORE = named phases in STAGES: stages run in order (the real dependencies),
 * the lanes inside a stage run CONCURRENTLY (independent content families — a
 * launch overlaps their relay round-trips instead of queueing them). Every phase
 * stays individually awaited + guarded + timed:
 *   1  substrate    layout scheme + world-grouping order (direct state, empty scene)
 *   2  panels       2D dockview layout FIRST — the chrome rises while content loads
 *                   behind it (prunes by component type, never by entity)
 *      ∥ field→tabs replay fieldSources (bulk fetch, one batch-window settle), then
 *                   file.open each saved sheet + viewport — chained: tabs dedupe
 *                   against the field
 *      ∥ agents     reopen saved session books (its own world grouping + relay reads)
 *      ∥ surfaces   publish terminal geometry + 3D-dock membership into the model
 *   3  camera       pose, set directly on the controller (after the field's fitall)
 *      settle       one projection pass over surfaces that re-adopted mid-restore
 *      focus        attention primary/key slots, last — the scene is as live as it gets
 * The registry PROJECTOR is always on (attached at connect, before restore): an
 * entity arriving in ANY lane is projected — viewport applied, dock tile adopted —
 * the moment it registers, so docked windows are born docked, never seen jumping.
 *
 * A failed phase is REPORTED (console + ctx.status + this.lastRestore; the
 * `session.status` verb reads it) and QUARANTINED, not swallowed: later phases
 * still run, and capture() keeps a failed section's LOADED blob verbatim — you
 * may only re-capture a section you successfully projected, so a degraded
 * restore can never overwrite the parts of the saved session it failed to
 * reproduce. (The old shape armed autosave over whatever a half-restore left,
 * which erased good layouts from the file — the self-perpetuating default-dock bug.)
 *
 * Restore runs once per SCENE GENERATION (ctx._sessionRestored), not per store
 * instance, and every rendezvous is PULL-based (the dock registers ctx.dockLayout;
 * the panels phase awaits it) — so a vite hot swap that rebuilds one participant
 * mid-life never pairs a live object with a dead partner via a push-once handshake.
 *
 * Two cooperating stores, by design:
 *   - THIS file persists what you RECONSTRUCT: open files (path + position),
 *     camera, and the dockview panel layout.
 *   - Live TERMINALS are re-adopted from the relay's live-adapter roster on
 *     reconnect (you reattach to a living shell, never resurrect a dead one);
 *     this file only carries their last positions as a placement hint.
 *
 * Self-heal policy: when saved DATA doesn't match reality, CLEAR IT WITH A LOG —
 * a missing file is dropped, a non-finite camera ignored, an orphaned dock panel
 * pruned from the layout's panel map AND grid tree (dockLayoutPrune.js). Data
 * mismatches self-heal inside their phase; only a structural throw fails a phase.
 */

import { canonicalPath } from '../commands/handlers/pathResolve.js';
import { openAgentSession } from '../commands/handlers/agentCommands.js';
import { restoreCarrel, carrelSweep } from '../commands/handlers/carrelCommands.js';
import { pruneDockLayout } from './dockLayoutPrune.js';
import { beginLoad } from '../commands/loadTrace.js';

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
// How long the panels phase waits for the dock to register ctx.dockLayout before declaring
// the section failed (headless clients have no dock; a live IDE registers it near-instantly).
const DOCK_BRIDGE_TIMEOUT_MS = 10000;

const round = (n) => Math.round(n * 100) / 100;
const isFinitePos = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

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
    // Skip position while HELD — docked or carrel-seated (the holder owns the transform; home is
    // the captured record it returns to). A seated terminal's .position is carrel-LOCAL, so a
    // world-space fact applied here would yank it out of the ring. applyView sets the LOCAL
    // geometry (position + grid + emulator) directly — no verb replay on the load path.
    const held = !!store.ctx.holderOf?.(s.id);
    const changed = grid.applyView?.(s.view || {}, { skipPosition: held }) || {};
    // Readability zoom for a LOOSE terminal (held tiles get theirs from the holder's own
    // reconcile — the dock re-applies zoom + box-fit itself). Guarded like applyView:
    // already-correct is a no-op, so steady-state projections never touch the grid.
    const z = (s.view || {}).zoom;
    if (!held && Number.isFinite(z) && z > 0 && typeof grid.setZoom === 'function' && grid.zoom !== z) {
      grid.setZoom(z);
    }
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

    this._loadedSnap = null;        // the snapshot restore() ran from — quarantine + no-dock capture source
    this._failedSections = new Set(); // snapshot keys whose phase failed → capture keeps the loaded blob
    this._lastGoodDock = null;      // anti-clobber: last dock layout (loaded OR live) that had panels
    this._pendingFrameOccupant = null; // saved frame pane (pinned window), re-raised by the dock reconcile
    /** @type {{at:number, ok:boolean, phases:Array<{name:string,ok:boolean,ms:number,error?:string}>}|null} */
    this.lastRestore = null;        // the phase report — session.status reads it
    this.dockBridgeTimeoutMs = DOCK_BRIDGE_TIMEOUT_MS;

    this._autosaveOn = false;       // gate: no save may clobber the file until restore finishes
    this._offSurfaces = null;       // unsubscribe from the model's change:surfaces (autosave trigger)
    this._lastSavedCmp = null;      // dedup: skip writes when nothing changed
    this._saveTimer = null;
    this._periodic = null;
    this._disposed = false;

    // Projection and persistence are DIFFERENT concerns on the same event: an entity
    // arriving must be projected (view intent applied, dock membership adopted)
    // IMMEDIATELY — during restore too, or a window visibly appears in place and
    // THEN snaps into its dock tile at the settle phase. Saving stays armed only
    // after restore (the half-restore autosave hazard).
    this._onRegistryChange = () => { this._projectSurfaces(); if (this._autosaveOn) this.scheduleSave(); };
    this._onVisibility = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.saveNow(); };
  }

  // -- Capture --------------------------------------------------------------
  capture() {
    const ctx = this.ctx;
    // Persist the TABS (sheet-backed grids), NOT the whole field. A bulk repo/local
    // load drops hundreds of grids into the registry; those are the field, not tabs —
    // restoring them as individual file.opens floods the tab bar. The field is
    // persisted as `fieldSources` (below) and replayed in bulk on restore; only
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

    // The bulk field sources — what fills the scene without tabs. ONE decider: ctx.fieldSources,
    // the recorded-INTENT list written by the field-load handlers (file.openDir APPENDS
    // {type:'local',dir} per opened root — the additive multi-root world; repo.load replaces the
    // list with its single {type:'repo',ref}) and emptied by clearScene / scene.clear_grids. The
    // provider's _currentRepo is its OWN working state (it needs the parsed repo to fetch files) —
    // a cache, not this fact's owner; capture reads fieldSources alone. Never inferred from a
    // census of non-tab grids — a census can't tell a deliberate dir pop from grids other systems
    // made, and it re-trips on the grids its own restore opened (a session that could never stop
    // bulk-loading).
    const fieldSources = [];
    for (const fs of Array.isArray(ctx.fieldSources) ? ctx.fieldSources : []) {
        if (fs?.type === 'repo' && fs.ref) fieldSources.push({ type: 'repo', ref: fs.ref });
        else if (fs?.type === 'local') fieldSources.push({ type: 'local', dir: fs.dir || '' });
    }

    // Terminals: serialize the MODEL's surface view-intent (cols/rows + position), NOT a scrape of
    // the live grids. The model is the durable buffer — it holds a terminal's geometry whether or
    // not its grid is currently in the scene (the PTY re-adopts async on the relay's clock), so a
    // save landing mid-re-adopt reads a consistent intent snapshot instead of a half-built scene.
    const terminals = [];
    if (ws?.listSurfaces) {
      for (const s of ws.listSurfaces()) {
        if (s.kind !== 'terminal') continue;
        const v = s.view || {};
        const entry = { id: s.id };
        if (isFinitePos(v.position)) { entry.x = round(v.position.x); entry.y = round(v.position.y); entry.z = round(v.position.z); }
        if (Number.isInteger(v.cols) && Number.isInteger(v.rows)) { entry.cols = v.cols; entry.rows = v.rows; }
        // Readability zoom (window.scale / the scale grip) — uniform zooms only (a stretch
        // tuple isn't a number and is skipped). Docked tiles ALSO carry zoom in dock3d;
        // this entry is what a LOOSE terminal (a dropped billboard) restores from.
        if (Number.isFinite(v.zoom) && v.zoom > 0 && v.zoom !== 1) entry.zoom = round(v.zoom);
        terminals.push(entry);
      }
    }

    // 2D dock layout: the live dock when one has registered (ctx.dockLayout, pull-based) and it
    // actually has panels; else the last layout that did — seeded from the LOADED snapshot, so a
    // session captured before any dock registers (or after a failed dock restore) preserves the
    // saved layout instead of nulling it out of the file.
    let dock = this._lastGoodDock ?? this._loadedSnap?.dock ?? null;
    const dockBridge = ctx.dockLayout;
    if (dockBridge?.toJSON) {
      try {
        const live = dockBridge.toJSON();
        // Never persist a degenerate EMPTY dock (panels:{}) over a good layout — a reload caught
        // mid-rebuild or an all-closed dock would clobber the saved layout and strand the next
        // restore. A normal layout with some tabs closed still wins (it has panels).
        if (live?.panels && Object.keys(live.panels).length > 0) { dock = live; this._lastGoodDock = live; }
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

    // Agent books: persisted BY REFERENCE — the harness's session record is the durable
    // state, so we save WHICH sessions are open plus view intent (head, live-follow, pin,
    // and a per-book retention override when one is set) and restore re-derives the
    // content through the adapter. A hydrated lane knows its full session id; a hook-born
    // lane knows only its 8-hex prefix — saved as `prefix`, resolved against the archive
    // listing at restore.
    const agents = [];
    for (const a of (ctx.agentBooks?.agents?.() || [])) {
      const lane = ctx.agentBooks.lanes.get(a.id);
      const entry = a.sessionId ? { session: a.sessionId } : { prefix: a.id };
      entry.head = a.head;
      entry.following = !!a.following;
      if (lane?.maxSheets != null) entry.limit = lane.maxSheets;
      if (lane?.pinned && lane.pinnedPos) {
        entry.pinned = [round(lane.pinnedPos.x), round(lane.pinnedPos.y), round(lane.pinnedPos.z)];
      }
      agents.push(entry);
    }

    // Carrels: world furniture — each desk's serialize() carries pose and knobs
    // (NO members — residence is the MODEL's authority via view.carrel).
    const carrels = ctx.carrels instanceof Map
      ? [...ctx.carrels.values()].filter((c) => !c._dissolving).map((c) => c.serialize())
      : [];

    // Carrel membership: read from the MODEL (listCarreled), not a live-object
    // scrape. The model is the durable buffer — it holds residence whether or not
    // the grid is currently live — so a save mid-re-adopt reads a consistent state.
    // Order threads members back into their saved ring position on restore.
    const carrelMembers = ws?.listCarreled
      ? ws.listCarreled().map((s) => ({ id: s.id, name: s.view.carrel.name, order: s.view.carrel.order ?? 0 }))
      : [];

    const snap = {
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      files,
      fieldSources,
      layout: this._captureLayout(),
      world: this.ctx.world?.getState?.() ?? null,   // world-grouping order (files/agents/…)
      camera: this._captureCamera(),
      focus: this._captureFocus(),
      dock: dock || null,
      dock3d: dock3d || null,
      terminals,
      agents,
      carrels,
      carrelMembers,
    };

    // Quarantine: a section whose restore phase FAILED keeps its loaded blob verbatim — never
    // re-capture (and thus overwrite) state you failed to project into the scene.
    if (this._failedSections.size && this._loadedSnap) {
      for (const key of this._failedSections) {
        if (key in this._loadedSnap) snap[key] = this._loadedSnap[key];
      }
    }
    return snap;
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

  // -- Restore: the sequential phased loader --------------------------------
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

    this._loadedSnap = snap;
    this._failedSections = new Set();
    // The loaded layout IS the last-good dock until a live one with panels exists — so a failed
    // dock restore can never null the layout out of the file. (The old anti-clobber's blind spot:
    // both of its sources were empty exactly when the dock restore had failed.)
    this._lastGoodDock = snap.dock || null;

    /** @type {(p: [string, () => any, string[]]) => Promise<void>} one phase, guarded +
     *  timed + quarantined exactly as the serial loader did — concurrency changes the
     *  SCHEDULE, never the per-phase contract. */
    const report = [];
    const runPhase = async ([name, run, keys]) => {
      const t0 = performance.now();
      try {
        await run();
        report.push({ name, ok: true, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        for (const k of keys) this._failedSections.add(k);
        report.push({ name, ok: false, ms: Math.round(performance.now() - t0), error: e?.message || String(e) });
        console.warn(`[session] restore: phase '${name}' failed —`, e?.message || e);
      }
    };

    /** Stages run IN ORDER; the LANES inside a stage run CONCURRENTLY (each lane is an
     *  ordered chain of phases). The lanes are independent content families — the wall
     *  clock overlaps their relay round-trips instead of queueing them:
     *    1. substrate ALONE — the scheme must exist before any content lands in it.
     *    2. panels (the CHROME rises first — its prune needs only the dock bridge's
     *       component types, never the registry, so the operator watches content load
     *       into a laid-out workspace instead of a default shell)
     *       ∥ field→tabs (tabs dedupes against the field, so they chain in one lane)
     *       ∥ agents (its own world grouping + its own relay reads)
     *       ∥ surfaces (sync view-intent writes; the always-on projector applies them
     *         the moment an entity registers — docked windows are born docked).
     *       Safe because: the bridge id-correlates concurrent RPCs; the field lane
     *       holds the tree's batch window; world.relayout is sync + idempotent under
     *       interleaved settles; registry writes are sync map ops.
     *    3. camera → settle → focus, exactly the old tail (camera after the field
     *       lane's fitall, focus last).
     *  @type {Array<Array<Array<[string, () => any, string[]]>>>} stages → lanes → phases */
    const stages = [
      [[['substrate', () => this._restoreSubstrate(snap), ['layout', 'world']],
        // Camera FIRST, not last: the saved pose is ABSOLUTE state — nothing about
        // it depends on content existing, and the operator should watch the field
        // pour into the view they left, not stare at a default pose until every
        // lane lands. The field lane skips its fitall when this succeeds (the
        // fitall only ever existed for pose-less sessions), so nothing stomps it.
        ['camera', () => { this._cameraRestored = this._restoreCamera(snap.camera) === true; }, ['camera']],
        // Desks BEFORE content: each saved carrel stands back up at its pose,
        // pre-shaped for its complement, and files a membership manifest — so
        // stage 2's windows (books, terminals, grids) seat IN PLACE the moment
        // they materialize instead of flying to a desk that arrived late.
        ['carrels', () => this._restoreCarrels(snap), ['carrels']]]],
      [
        [['panels', () => this._restorePanels(snap), ['dock']]],
        [['field', () => this._restoreField(snap), ['fieldSources']],
         ['tabs', () => this._restoreTabs(snap), ['files']]],
        [['agents', () => this._restoreAgents(snap), ['agents']]],
        [['surfaces', () => this._restoreSurfaces(snap), ['terminals', 'dock3d']]],
      ],
      [[['settle', () => this._projectSurfaces(), []],
        ['focus', () => this._restoreFocus(snap.focus), ['focus']]]],
    ];

    const t0 = performance.now();
    for (const stage of stages) {
      this.ctx.status?.set(`Restoring: ${stage.flat(1).map(([name]) => name).join(' + ')}…`);
      await Promise.all(stage.map(async (lane) => { for (const p of lane) await runPhase(p); }));
    }
    // The pour is over: one synchronous sweep catches members that landed after the
    // last change event, then desks stop pre-shaping for members that never came
    // (the wall re-wraps to what actually arrived — truth wins). Unserved manifest
    // claims PERSIST as residence memory: a window reopened later still comes home.
    try {
      carrelSweep(this.ctx);
      if (this.ctx.carrels instanceof Map) {
        for (const c of this.ctx.carrels.values()) { if (c._expected) c.expect(0); }
      }
      this.ctx.world?.relayout();   // the row is true at close (footprint-diffed — free if it already is)
    } catch (e) { console.warn('[session] carrel close-out failed:', e?.message || e); }
    const wall = Math.round(performance.now() - t0);
    this.ctx.status?.clear();

    const failed = report.filter((p) => !p.ok);
    this.lastRestore = { at: Date.now(), ok: failed.length === 0, wall, phases: report };
    console.info(
      `[session] restore ${failed.length ? `DEGRADED — failed: ${failed.map((p) => p.name).join(', ')}` : 'complete'} `
      + `(wall ${wall}ms · ${report.map((p) => `${p.name} ${p.ms}ms`).join(' · ')})`
    );
  }

  // carrels — world furniture, stage 1: each saved desk stands back up at its saved pose
  // wearing its saved knobs (restoreCarrel — no camera-ray placement, no Settings fold).
  // Carrel membership (view.carrel) is written to the MODEL here, so the sweep seats
  // members from model authority as windows materialize — no manifest, no parallel pipeline.
  _restoreCarrels(snap) {
    const list = Array.isArray(snap.carrels) ? snap.carrels : [];
    if (!list.length) return;
    let memberCount = 0;
    for (const c of list) {
      if (!restoreCarrel(this.ctx, c)) continue;
      memberCount += (c.members?.length ?? 0);  // pre-Slice-1 snapshots carry members inline
    }
    // Write carrel residence into the model from carrelMembers (the model-based path).
    // Pre-Slice-1 snapshots without carrelMembers but with inline c.members fall back
    // to those — forward-additive restore, no migration shim needed.
    const members = Array.isArray(snap.carrelMembers) ? snap.carrelMembers
      : list.flatMap((c) => (c.members || []).map((m) => ({ id: m.id, name: c.name, order: m.order ?? 0 })));
    for (const m of members) {
      if (m?.id != null && m.name != null) {
        this.ctx.workspace?.setSurfaceView?.(String(m.id), undefined, { carrel: { name: m.name, order: m.order ?? 0 } });
      }
    }
    if (memberCount) { /* migrated from inline members — noted for the expect() pre-shape */ }
  }

  // agents — reopen the saved session books BY REFERENCE: each entry re-reads the harness's
  // own record through the adapter (the one open path agent.open rides), then re-applies view
  // intent. A saved retention override rides `limit` straight into the hydration (it becomes
  // the lane's cap again); books without one follow the settings default. Per-entry guarded
  // (a vanished record logs + skips, the rest land — data self-heal); no session provider
  // (client-only baseline) is simply an empty phase. Saved heads index the previous view's
  // sheet list — a tail-capped hydration clamps them (pageTo clamps).
  //
  // The pour is CONCURRENT (a bounded worker pool): each book is independent, and its
  // seat is pre-assigned (the carrel manifest's order + the desk's expect pre-shape),
  // so arrival order is irrelevant — overlapping the relay reads collapses the
  // one-book-at-a-time trickle into a few waves. Per-entry hydrate + pin stay one
  // synchronous block, so the deferred carrel sweep still sees pins before it seats.
  async _restoreAgents(snap) {
    const list = Array.isArray(snap.agents) ? snap.agents : [];
    if (!list.length) return;
    const books = this.ctx.agentBooks;
    const provider = this.ctx.sessionProvider;
    if (!books || !provider) return;
    let archivePromise = null;   // fetched once, only if a prefix needs resolving
    const open = async (a) => {
      try {
        let sid = a.session || null;
        if (!sid && a.prefix) {
          archivePromise ??= provider.list();
          const archive = await archivePromise;
          const norm = String(a.prefix).replace(/-/g, '');
          sid = archive.find((s) => s.id.replace(/-/g, '').startsWith(norm))?.id || null;
        }
        if (!sid) return;   // nothing on disk answers to this book — it stays closed
        const { agentId } = await openAgentSession(this.ctx, sid, { limit: a.limit });
        const lane = books.lanes.get(agentId);
        if (!lane) return;
        if (Array.isArray(a.pinned) && a.pinned.length === 3) books.moveGroup(agentId, ...a.pinned);
        if (!a.following && Number.isInteger(a.head)) lane.book.pageTo(a.head);
      } catch (e) {
        console.warn('[session] agent restore failed:', a.session || a.prefix, e?.message || e);
      }
    };
    const POUR_WIDTH = 6;
    const queue = [...list];
    await Promise.all(Array.from({ length: Math.min(POUR_WIDTH, queue.length) }, async () => {
      while (queue.length) await open(queue.shift());
    }));
  }

  // substrate — the field layout scheme, SET directly on the (still-empty) tree so the bulk load
  // below and every grid land in the saved scheme instead of the packed default; plus the
  // world-grouping order. Direct state, no verbs.
  _restoreSubstrate(snap) {
    if (snap.layout?.scheme) this.ctx.contentTree?.applyLayoutState?.(snap.layout);
    if (snap.world) this.ctx.world?.applyState?.(snap.world);
  }

  // field — replay the recorded field sources: the bulk content fetch that fills the scene before
  // tabs layer on top. `fieldSources` is a LIST — every opened root replays (additive multi-root
  // world). Each entry is guarded independently (one vanished root, or a network/offline repo,
  // logs + skips and the rest still land — data self-heal); only a structural throw fails the phase.
  async _restoreField(snap) {
    // Pre-list snapshots carried ONE `field` object — read it as a single-entry list
    // (data tolerance, not a code shim: old saves keep restoring, capture writes the list).
    const sources = Array.isArray(snap.fieldSources) ? snap.fieldSources
      : (snap.field ? [snap.field] : []);
    // The STORM trace: one stage per source, so the launch profile reads as a list —
    // each source's own openDir/repo trace carries the stage breakdown beneath it.
    const trace = sources.length ? beginLoad(this.ctx, 'restore.field') : null;
    let anyLocal = false;
    // Repo sources first, OUTSIDE any hold — repo.load owns the whole scene (it
    // clears first) and frames itself, so it must see a settled tree. In practice
    // a repo source replaces the list entirely; the split just makes mixed lists safe.
    for (const src of sources) {
      if (src?.type === 'repo' && src.ref) {
        // --no-frame when the saved pose already landed (stage 1): repo.load's
        // internal fitall would stomp the exact view the operator left.
        const cmd = this._cameraRestored ? ['repo.load', src.ref, '--no-frame'] : ['repo.load', src.ref];
        try { await this.router.execute(cmd); }
        catch (e) { console.warn('[session] repo field restore failed:', e?.message || e); }
        trace?.mark(src.ref);
      }
    }
    // Local sources in ONE batch window: every openDir's polite relayoutAndRest
    // coalesces into a single settle at close — a launch pays one relayout + one
    // overlay rebuild, not one per source. (fitall stays outside: it frames the
    // settled tree.)
    const locals = sources.filter((s) => s?.type === 'local');
    const runLocals = async () => {
      for (const src of locals) {
        try {
          // Replay the recorded pop exactly (a pre-intent save carries no dir —
          // that restores as the whole project).
          await this.router.execute(['file.openDir', src.dir || '']);
          anyLocal = true;
        } catch (e) { console.warn('[session] local field restore failed:', e?.message || e); }
        trace?.mark(src.dir || '/');
      }
    };
    const tree = this.ctx.contentTree;
    if (locals.length && tree?.batchRelayouts) { await tree.batchRelayouts(runLocals); trace?.mark('settle'); }
    else await runLocals();
    // Frame the field ONLY when no saved pose landed — fitall is the pose-less
    // session's welcome, never a correction over the view the operator left.
    if (anyLocal && !this._cameraRestored) {
      try { await this.router.execute('camera.fitall'); }
      catch (e) { console.warn('[session] fitall after field restore failed:', e?.message || e); }
      trace?.mark('frame');
    }
    trace?.end({ sources: sources.length });
  }

  // tabs — reopen each saved sheet so the dock/registry are populated before the camera phase
  // (file.open's framing must not fight the restored pose).
  async _restoreTabs(snap) {
    if (!Array.isArray(snap.files)) return;
    // One stage per tab (file.open runs a FULL relayout per call — the second storm
    // layer; load.stats holds the per-tab detail, the console line compacts).
    const trace = snap.files.length ? beginLoad(this.ctx, 'restore.tabs') : null;
    let anyWindowed = false;
    // The tab loop shares the field phase's batch discipline: each genuinely-new
    // file.open politely relayouts — held, they coalesce into one settle at close.
    const runTabs = async () => {
    for (const f of snap.files) {
      if (!f?.path) continue;
      try {
        // Canonicalize FIRST (an old snapshot carries root-relative paths; the
        // registry keys on canonical ids) so the exists-probe, the dedupe inside
        // file.open, and the applyView lookup below all address the same entity.
        const path = canonicalPath(this.ctx, f.path);
        // The grid may already exist (the field phase bulk-loaded it). Still run
        // file.open — it dedups the grid and creates the SHEET, so the file comes
        // back as a tab. Only probe existence for files not already loaded.
        const already = this.ctx.registry.has(path);
        if (!already && !(await this._fileExists(path))) {
          console.warn(`[session] dropped missing file: ${path}`);
          continue;
        }
        // Array form: a path with spaces survives, and coordinates stay their own args.
        await this.router.execute(['file.open', path, String(f.x ?? 0), String(f.y ?? 0), String(f.z ?? 0)]);
        // Viewport (window / frame / scroll) loads as DIRECT state — the grid's own applyView,
        // NOT a replay of grid.window/grid.frame/grid.scroll. file.open created/deduped the grid +
        // sheet; the viewport rides on top. applyView orders window→frame→scroll itself and is
        // absolute (no "scroll-from-0" assumption).
        if (f.window || f.frameRows || f.scrollOffset) {
          const grid = this.ctx.registry.get(path)?.grid;
          if (grid?.applyView) {
            const { windowed } = await grid.applyView({ window: f.window, frameRows: f.frameRows, scrollOffset: f.scrollOffset });
            if (windowed) anyWindowed = true;
          }
        }
      } catch (e) {
        console.warn(`[session] failed to reopen ${f.path}:`, e?.message || e);
      } finally {
        trace?.mark(String(f.path).split('/').pop() || f.path);
      }
    }
    // Windowing changes a grid's footprint → relayout the tree ONCE after all tabs land (the
    // grid.window verb did this per-call; batching is the same end-state, less churn).
    if (anyWindowed) this.ctx.contentTree?.relayoutAndRest?.();
    };
    const tree = this.ctx.contentTree;
    if (tree?.batchRelayouts) { await tree.batchRelayouts(runTabs); trace?.mark('settle'); }
    else await runTabs();
    trace?.end({ files: snap.files.length });
  }

  // surfaces — publish the loaded INTENT (terminal size/placement, 3D dock membership/order/zoom)
  // into the WorkspaceModel, the durable buffer. Nothing is pushed onto live objects here; the
  // settle phase and the registry-change listener project it as each surface (re-)adopts, in any
  // order. No verb replay, no pending queues.
  _restoreSurfaces(snap) {
    if (Array.isArray(snap.terminals)) {
      for (const t of snap.terminals) {
        if (!t?.id) continue;
        const view = {};
        if (isFinitePos(t)) view.position = { x: t.x, y: t.y, z: t.z };
        if (Number.isInteger(t.cols) && Number.isInteger(t.rows)) { view.cols = t.cols; view.rows = t.rows; }
        if (Number.isFinite(t.zoom) && t.zoom > 0) view.zoom = t.zoom;
        this.ctx.workspace?.setSurfaceView?.(t.id, 'terminal', view);
      }
    }
    // `dockOrder` = the tile's index in the saved slot-ordered array, so a terminal re-adopting
    // out of arrival order still lands in its saved bar slot.
    if (snap.dock3d?.tiles?.length) {
      this.ctx.cameraDock?.setLayout?.(snap.dock3d.layout || 'linear');
      // The window that holds the root view-frame (pinned) — a dock-level fact, not a per-surface
      // flag. _reconcileDock re-raises it once it's a live tile (spotlight → frame-fit + Pin light).
      this._pendingFrameOccupant = snap.dock3d.focused || null;
      snap.dock3d.tiles.forEach((t, i) => {
        if (!t?.id) return;
        // kind undefined: don't clobber a terminal's 'terminal' kind (set by the loop above); a docked
        // code grid with no prior record becomes a generic 'surface' (the reconcile ignores kind).
        this.ctx.workspace?.setSurfaceView?.(t.id, undefined, { docked: true, dockOrder: i, zoom: t.zoom ?? 1 });
      });
    }
  }

  // panels — the 2D dockview layout. Awaits the dock's pull-based bridge (ctx.dockLayout,
  // registered by IdeDock at dock-ready), prunes panels the current catalog no longer knows —
  // from the panel map AND the grid tree, so dockview's fromJSON can't throw on a dangling view
  // id — and applies the saved layout wholesale (closed tabs stay closed). The defaults IdeDock
  // built at dock-ready stand when there's nothing (usable) to apply; a failed apply rebuilds
  // them (dockview reverts to EMPTY on a fromJSON error) and reports, which also quarantines the
  // saved blob from capture.
  async _restorePanels(snap) {
    if (!snap.dock) return;   // nothing saved — the defaults stand
    const bridge = await this._awaitDockBridge();
    if (!bridge) throw new Error('dock bridge never registered');
    const { layout, dropped } = pruneDockLayout(snap.dock, bridge.components);
    for (const d of dropped) console.warn(`[session] pruned dock panel '${d.id}' — unknown component '${d.component}'`);
    if (!layout) { console.warn('[session] saved dock layout had no live panels — keeping defaults'); return; }
    try {
      bridge.fromJSON(layout);
    } catch (e) {
      bridge.buildDefaults();
      throw e;
    }
  }

  async _awaitDockBridge() {
    const t0 = performance.now();
    while (!this.ctx.dockLayout) {
      if (this._disposed || performance.now() - t0 > this.dockBridgeTimeoutMs) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.ctx.dockLayout;
  }

  // camera — SET directly on the controller: no camera.move/aim verb replay (which fired async and
  // fought the field-restore fly), no quaternion stomp. applyState cancels any in-flight fly and
  // lands the saved pose exactly. Non-finite data self-heals (drop with a log), it doesn't fail.
  /** @returns {boolean} true when a saved pose was actually applied — the field
   *  lane reads this to skip its fitall (framing is only for pose-less sessions). */
  _restoreCamera(cam) {
    if (!cam?.pos) return false;
    if (!isFinitePos(cam.pos)) { console.warn('[session] dropped non-finite camera position'); return false; }
    this.ctx.cameraController?.applyState?.(cam);
    return true;
  }

  // focus — restore the sticky slots by SETTING them directly (the AttentionManager IS the owner —
  // set() is its writer, not a verb replay). Runs LAST: the scene is as live as it gets. Self-healing
  // by design: an id whose entity isn't live sets with entity null and is pruned on the next registry
  // change (pruneGone) — exactly the mirror-of-reality policy. Setting primary/key emits
  // change:<slot>; no listener flies the camera (that lives in the click path), so this can't
  // clobber the just-restored pose.
  _restoreFocus(focus) {
    const am = this.ctx.attentionManager;
    if (!focus || !am?.set) return;
    if (focus.primary) am.set('primary', focus.primary, { registry: this.ctx.registry });
    if (focus.key) am.set('key', focus.key, { registry: this.ctx.registry });
  }

  async _fileExists(path) {
    try { await this.ctx.fileProvider.stat('file:///' + String(path).replace(/^\/+/, '')); return true; }
    catch { return false; }
  }

  // The deferred-construction tail of the projection. The live three object is a PROJECTION of the
  // model, never a peer that drifts: a verb writes intent AND projects it synchronously, so the
  // common path is correct by construction. THIS exists only for genuinely-external children — the
  // relay-backed PTY (and, later, the capture stream) re-adopt on their own clock and reappear AFTER
  // the verb ran, ALWAYS at a default size — so we re-project them from the model when they land.
  // Driven by the registry-change listener (each surface as it reappears) + the settle phase (any
  // that re-adopted mid-restore, before the listener was armed). Per-kind via SURFACE_PROJECTORS,
  // guarded → a present, already-correct surface is a no-op (NOT a drift-scan). Order is
  // load-bearing: surfaces move/size FIRST so the subsequent 3D-dock lock captures the RESTORED
  // home, not the adapter's spawn placement.
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
  // pending queue: a not-yet-live docked surface is simply skipped and caught on the next pass.
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

  // Public clear — wipe the saved snapshot on demand (the `session.clear` verb). Drops the loaded
  // snapshot + quarantine so a stale blob can't re-persist through capture's preserve paths, then
  // writes the empty file. Live objects stay in the scene; autosave re-captures them on the next
  // change (mirror-of-reality).
  async clear() {
    this._loadedSnap = null;
    this._failedSections = new Set();
    this._lastGoodDock = null;
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
  // Load + restore once per SCENE GENERATION (ctx._sessionRestored — the ctx is born with the
  // scene), then arm autosave. Keying on the ctx, not this instance, makes both re-entries safe:
  // a relay reconnect (same store) and a vite hot swap that rebuilt the store inside a live tree
  // (new store, same scene) each just re-arm autosave instead of re-restoring — which would
  // bulk-load over the live field and snap the camera back.
  async startOnConnect() {
    this._attachProjector();               // entities dock the moment they register — restore included
    if (this.ctx._sessionRestored) { this._armAutosave(); return; }
    this.ctx._sessionRestored = true;
    const snap = await this.load();
    if (snap) await this.restore(snap);   // phased; each phase is guarded, this never throws
    else console.info('[session] no saved session — fresh start');
    this._armAutosave();
  }

  /** Attach the registry projection listener (idempotent). Projection is a VIEW
   *  concern — always on from connect; only SAVING waits for the arm. */
  _attachProjector() {
    if (this._disposed || this._projectorOn) return;
    this._projectorOn = true;
    this.ctx.registry.addChangeListener(this._onRegistryChange);
  }

  _armAutosave() {
    if (this._disposed || this._autosaveOn) return;
    this._autosaveOn = true;
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
