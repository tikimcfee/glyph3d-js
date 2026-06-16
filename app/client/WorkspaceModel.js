/**
 * WorkspaceModel — the working-set layer ABOVE SceneRegistry (the rendered set).
 *
 * Owns FIELDS (workspaces: an ordered set of sheets + a saved camera) and SHEETS (open
 * documents — the persistent thing, which exist whether or not they're drawn). A PANEL is a
 * rendered sheet = a SceneRegistry entry. The open/rendered/focused triple is DERIVED, never
 * stored:
 *   open     = the sheet is in the active field's sheetIds
 *   rendered = sheet.panelId is registered in the SceneRegistry
 *   focused  = attention.primary === sheet.panelId
 *
 * Single writer; emits change events (shaped like AttentionManager) the HUD subscribes to.
 * Client-side, a sibling of SessionStore (exposed as ctx.workspace). panelId === the registry id
 * (for files, the path) so existing path-keyed seams (SessionStore, file.open dedup,
 * resolveGridByIdOrIndex) stay untouched. See the fields→sheets→panels design synthesis.
 *
 * Build status: Step 0–1 (model + open/list). render/derender/focus + fields + persistence land
 * in later steps; the render-record helpers (setPanelId/reconcile) are here so those steps are
 * thin verb additions, not model surgery.
 */

const basename = (p) => {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
};

export default class WorkspaceModel {
  constructor() {
    /** @type {Map<string, {id:string,name:string,sheetIds:string[],activeSheetId:string|null,camera:object|null}>} */
    this.fields = new Map();
    /** @type {Map<string, {id:string,kind:string,source:object,title:string,panelId:string|null,view:object|null}>} */
    this.sheets = new Map();
    /** Per-rendered-thing view-intent (appState.surfaces): the declarative geometry/placement a
     *  reconcile pass pushes onto the live three.js object, keyed by the REGISTRY id. Distinct from
     *  `sheets` (open documents/tabs). Terminals live here now; code grids join in later slices.
     *  @type {Map<string, {id:string,kind:string,view:object}>} */
    this.surfaces = new Map();
    this.activeFieldId = 'field:main';
    this.fields.set(this.activeFieldId, {
      id: this.activeFieldId, name: 'main', sheetIds: [], activeSheetId: null, camera: null,
    });
    this._listeners = new Map();  // event → fn[]
  }

  // ── events: 'change:fields' | 'change:sheets' | 'change:active' ──
  on(evt, fn) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, []);
    this._listeners.get(evt).push(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) {
    const a = this._listeners.get(evt);
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  }
  _emit(evt) {
    const a = this._listeners.get(evt);
    if (a) for (const fn of a.slice()) { try { fn(); } catch (e) { console.warn('[workspace] listener error', e); } }
  }

  // ── fields ──
  getActiveField() { return this.fields.get(this.activeFieldId) || null; }
  listFields() {
    return [...this.fields.values()].map((f) => ({
      id: f.id, name: f.name, sheetCount: f.sheetIds.length, active: f.id === this.activeFieldId,
    }));
  }

  // ── sheets ──
  /**
   * Create-or-find a sheet and ensure it's in the active field. Does NOT render.
   * @returns {object|null} the sheet record
   */
  openSheet({ kind = 'file', source, title } = {}) {
    const raw = source?.path ?? source?.adapterId;
    if (!raw) return null;
    // Canonicalize file paths (strip leading slashes) so ONE file is ONE sheet regardless of the
    // caller's path form — matches the file:/// URI canonicalization fileCommands uses for grid
    // dedup. Without this, file.open's rooted "/x" and a bare "x" from the CLI make two sheets for
    // one file. (adapterId-keyed sheets — terminals — are not path-like, so leave them as-is.)
    const key = source?.path != null ? String(source.path).replace(/^\/+/, '') : raw;
    const id = 'sheet:' + key;
    let sheet = this.sheets.get(id);
    let added = false;
    if (!sheet) {
      sheet = { id, kind, source, title: title || basename(key), panelId: null, view: null };
      this.sheets.set(id, sheet);
      added = true;
    }
    const field = this.getActiveField();
    let fieldChanged = false;
    if (field && !field.sheetIds.includes(id)) {
      field.sheetIds.push(id);
      if (!field.activeSheetId) field.activeSheetId = id;
      fieldChanged = true;
    }
    if (added) this._emit('change:sheets');
    if (fieldChanged) this._emit('change:fields');
    return sheet;
  }

  getSheet(id) { return this.sheets.get(id) || null; }

  /** Record (or clear, with null) the rendered panel id for a sheet. */
  setPanelId(sheetId, panelId) {
    const s = this.sheets.get(sheetId);
    if (s && s.panelId !== panelId) { s.panelId = panelId; this._emit('change:sheets'); }
  }

  /** Mark a sheet active in its field (the field's remembered focus; drives the active tab). */
  setActiveSheet(sheetId) {
    const f = this.getActiveField();
    if (!f || !f.sheetIds.includes(sheetId)) return false;
    if (f.activeSheetId !== sheetId) { f.activeSheetId = sheetId; this._emit('change:fields'); }
    return true;
  }

  /**
   * Wipe every sheet and reset all fields to empty — the model side of a scene clear or repo
   * switch, so stale surface intent can't survive (repo.load A → repo.load B must not leave A's
   * tabs). Derendering the live panels is the caller's job (clearScene removes the grids; this
   * drops the intent). Mirrors SessionStore's clear-with-log policy.
   * (When terminals become surfaces — Slice 1 — this will need to spare live terminal records;
   * today the model holds only file sheets, so a blanket clear is correct.)
   */
  clear() {
    const hadSheets = this.sheets.size > 0;
    this.sheets.clear();
    let fieldsChanged = false;
    for (const f of this.fields.values()) {
      if (f.sheetIds.length || f.activeSheetId) {
        f.sheetIds = [];
        f.activeSheetId = null;
        fieldsChanged = true;
      }
    }
    if (hadSheets) this._emit('change:sheets');
    if (fieldsChanged) this._emit('change:fields');
  }

  // ── surfaces: per-rendered-thing view-intent (appState.surfaces) ──
  // Keyed by the registry id, so a reconcile pass joins straight to the live object. A verb
  // writes the intent here; the reconcile pushes it onto the live grid (and re-pushes idempotently
  // when the grid re-adopts). This is the durable buffer that retired SessionStore.pendingTerminals.

  /**
   * Create-or-merge a surface's view-intent. Only emits when something actually changed, so a
   * re-push of the same value (the idempotent apply path) can't churn the autosave.
   * @param {string} id registry id @param {string} kind 'terminal' | … @param {object} patch view fields
   * @returns {object|null} the surface record
   */
  setSurfaceView(id, kind, patch) {
    if (!id || !patch) return null;
    let s = this.surfaces.get(id);
    let changed = false;
    if (!s) { s = { id, kind: kind || 'surface', view: {} }; this.surfaces.set(id, s); changed = true; }
    if (kind && s.kind !== kind) { s.kind = kind; changed = true; }
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(s.view[k]) !== JSON.stringify(v)) { s.view[k] = v; changed = true; }
    }
    if (changed) this._emit('change:surfaces');
    return s;
  }

  getSurface(id) { return this.surfaces.get(id) || null; }
  listSurfaces() { return [...this.surfaces.values()]; }
  /** Drop a surface's view-intent (the thing was explicitly closed/killed). */
  removeSurface(id) { if (this.surfaces.delete(id)) this._emit('change:surfaces'); }

  // ── dock membership (a view fact): which surfaces are in the camera-locked HUD, in what order.
  // The CameraDock is a PROJECTION of this — the dock reconciler locks these as they go live, so the
  // model is the durable buffer across an async re-adopt (no separate pending queue).

  /** Docked surfaces, sorted by their persisted slot order (the bar sequence). */
  listDocked() {
    return [...this.surfaces.values()]
      .filter((s) => s.view?.docked)
      .sort((a, b) => (a.view.dockOrder ?? 0) - (b.view.dockOrder ?? 0));
  }

  /** The next slot order for an interactive dock — one past the current max (append to the bar). */
  nextDockOrder() {
    let max = -1;
    for (const s of this.surfaces.values()) if (s.view?.docked && (s.view.dockOrder ?? 0) > max) max = s.view.dockOrder ?? 0;
    return max + 1;
  }

  /** Drop a sheet from every field + the sheet map. (Derendering its panel is the caller's job.) */
  removeSheet(sheetId) {
    let fieldChanged = false;
    for (const f of this.fields.values()) {
      const i = f.sheetIds.indexOf(sheetId);
      if (i >= 0) {
        f.sheetIds.splice(i, 1);
        if (f.activeSheetId === sheetId) f.activeSheetId = f.sheetIds[0] || null;
        fieldChanged = true;
      }
    }
    const dropped = this.sheets.delete(sheetId);
    if (dropped) this._emit('change:sheets');
    if (fieldChanged) this._emit('change:fields');
  }

  // ── derived triple + listing ──
  /** The live {open, rendered, focused} for a sheet, joined from registry + attention. */
  triple(sheet, registry, attention) {
    const rendered = !!sheet.panelId && !!registry?.has?.(sheet.panelId);
    const focused = !!sheet.panelId && attention?.get?.('primary')?.id === sheet.panelId;
    return { open: true, rendered, focused };
  }

  /** The active field's sheets, in order, each annotated with the live triple. */
  listActiveSheets(registry, attention) {
    const f = this.getActiveField();
    if (!f) return [];
    return f.sheetIds.map((id) => {
      const s = this.sheets.get(id);
      if (!s) return null;
      return { id: s.id, kind: s.kind, title: s.title, source: s.source, panelId: s.panelId, ...this.triple(s, registry, attention) };
    }).filter(Boolean);
  }

  /**
   * Null any panelId whose registry entry has vanished (e.g. a raw grid.remove that bypassed
   * sheet.derender) — clear-with-log self-heal, matching SessionStore's policy. Wire to the
   * registry change listener so a dangling render flag can't survive.
   */
  reconcile(registry) {
    let changed = false;
    for (const s of this.sheets.values()) {
      if (s.panelId && !registry?.has?.(s.panelId)) { s.panelId = null; changed = true; }
    }
    if (changed) { console.debug('[workspace] reconciled dangling panelId(s)'); this._emit('change:sheets'); }
  }
}
