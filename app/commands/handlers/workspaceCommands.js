/**
 * Workspace commands — the field / sheet (working-set) verbs.
 *
 * They MUTATE ctx.workspace (the WorkspaceModel) and NEVER reach into the scene directly;
 * rendering is delegated to the existing render verbs (wired in later steps). The HUD is a
 * pure reflection of this model. See the fields→sheets→panels design.
 *
 * Build status: Steps 0–4 — open / list / render / derender / focus + field.list. sheet.focus is
 * the render-if-needed → attention-primary → camera-frame → mark-active gesture. Multi-field
 * (per-field camera) + SessionStore persistence land next.
 */
import { box, table } from '../formatResponse.js';
import { renderSheetGrid, reflowGrids } from './fileCommands.js';

const dot = (s) => (s.focused ? '●' : s.rendered ? '◐' : '○');  // focused · rendered · open-only

export default function registerWorkspaceCommands(router) {
  router.register('sheet.open', (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: sheet.open <path>', data: null };
    const ws = ctx.workspace;
    if (!ws) return { text: 'ERR: workspace not ready', data: null };
    const path = args.join(' ');
    const uri = 'file:///' + String(path).replace(/^\/+/, '');   // canonical form — matches file.open / the registry meta
    const sheet = ws.openSheet({ kind: 'file', source: { path, uri } });
    if (!sheet) return { text: 'ERR: could not open sheet', data: null };
    return {
      text: `OK: opened sheet "${sheet.title}" (open, not rendered — sheet.render ${sheet.id} to draw it)`,
      data: { id: sheet.id, title: sheet.title, rendered: false },
    };
  }, { description: 'Open a file as a sheet in the active field (does NOT render)', usage: '<path>' });

  router.register('sheet.list', (args, ctx) => {
    const ws = ctx.workspace;
    if (!ws) return { text: 'ERR: workspace not ready', data: null };
    const sheets = ws.listActiveSheets(ctx.registry, ctx.attentionManager);
    if (sheets.length === 0) {
      return { text: box('SHEETS', ['(none open)'], 50) + '\nOK: 0 sheets', data: { sheets: [], count: 0 } };
    }
    const rows = sheets.map((s, i) => [String(i), dot(s), s.kind, s.title, s.id]);
    return {
      text: table(['#', 'st', 'kind', 'title', 'id'], rows) + `\nOK: ${sheets.length} sheets  (● focused · ◐ rendered · ○ open)`,
      data: { sheets, count: sheets.length },
    };
  }, { description: "List the active field's sheets with open/rendered/focused state" });

  router.register('sheet.render', async (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: sheet.render <sheetId>', data: null };
    const ws = ctx.workspace;
    if (!ws) return { text: 'ERR: workspace not ready', data: null };
    const sheetId = args.join(' ');   // sheetId is "sheet:"+path; a path can contain spaces
    const sheet = ws.getSheet(sheetId);
    if (!sheet) return { text: `ERR: no sheet "${sheetId}"`, data: null };
    if (sheet.kind !== 'file') return { text: `ERR: sheet kind '${sheet.kind}' not renderable yet`, data: null };
    let id;
    try {
      id = await renderSheetGrid(ctx, sheet.source.path);  // load + create + register (or existing)
    } catch (err) {
      return { text: `ERR: render failed for ${sheet.title}: ${err?.message || err}`, data: null };
    }
    if (!id) return { text: `ERR: could not render "${sheet.title}"`, data: null };
    ws.setPanelId(sheet.id, id);
    reflowGrids(ctx);
    return { text: `OK: rendered "${sheet.title}" → panel ${id}`, data: { id: sheet.id, panelId: id, rendered: true } };
  }, { description: 'Render an open sheet (draw its panel)', usage: '<sheetId>' });

  router.register('sheet.derender', (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: sheet.derender <sheetId>', data: null };
    const ws = ctx.workspace;
    if (!ws) return { text: 'ERR: workspace not ready', data: null };
    const sheetId = args.join(' ');
    const sheet = ws.getSheet(sheetId);
    if (!sheet) return { text: `ERR: no sheet "${sheetId}"`, data: null };
    if (!sheet.panelId || !ctx.registry.has(sheet.panelId)) {
      ws.setPanelId(sheet.id, null);  // clear any stale panelId; sheet stays open
      return { text: `OK: "${sheet.title}" not rendered (still open)`, data: { id: sheet.id, rendered: false } };
    }
    // Null the panel ref BEFORE unregistering. SceneRegistry.unregister fires its change
    // listeners synchronously, and reconcile() is wired to them — if the sheet still pointed
    // at the just-removed id, reconcile would see it as "dangling" and log the out-of-band
    // self-heal on this fully-sanctioned path. Clearing first keeps that diagnostic honest:
    // it only fires for removals that bypassed sheet.derender (raw grid.remove / eviction).
    const pid = sheet.panelId;
    ws.setPanelId(sheet.id, null);
    ctx.removeGrid(pid);              // unregister + dispose + scene.remove
    reflowGrids(ctx);
    return { text: `OK: derendered "${sheet.title}" (still open)`, data: { id: sheet.id, rendered: false } };
  }, { description: 'Remove a sheet\'s panel but keep the sheet open', usage: '<sheetId>' });

  router.register('sheet.focus', async (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: sheet.focus <sheetId>', data: null };
    const ws = ctx.workspace;
    if (!ws) return { text: 'ERR: workspace not ready', data: null };
    const sheetId = args.join(' ');
    const sheet = ws.getSheet(sheetId);
    if (!sheet) return { text: `ERR: no sheet "${sheetId}"`, data: null };

    // Render-if-needed: focusing an open-but-undrawn sheet draws it first — the single gesture
    // that takes you from a tab to looking at it. Already-rendered → straight to refocus.
    let panelId = (sheet.panelId && ctx.registry.has(sheet.panelId)) ? sheet.panelId : null;
    if (!panelId) {
      if (sheet.kind !== 'file') return { text: `ERR: sheet kind '${sheet.kind}' not renderable yet`, data: null };
      try {
        panelId = await renderSheetGrid(ctx, sheet.source.path);
      } catch (err) {
        return { text: `ERR: render failed for ${sheet.title}: ${err?.message || err}`, data: null };
      }
      if (!panelId) return { text: `ERR: could not render "${sheet.title}"`, data: null };
      ws.setPanelId(sheet.id, panelId);
      reflowGrids(ctx);
    }

    // Focus = attention primary (single writer, drives the HUD's ●) + camera framing (reuse the
    // verb — array form keeps a space/slash path intact) + the field's remembered active sheet.
    ctx.attentionManager?.set('primary', panelId, { registry: ctx.registry });
    await router.execute(['camera.focus', panelId]);
    ws.setActiveSheet(sheet.id);

    return { text: `OK: focused "${sheet.title}" → panel ${panelId}`, data: { id: sheet.id, panelId, focused: true } };
  }, { description: 'Focus a sheet: render if needed, set attention primary, frame the camera, mark active', usage: '<sheetId>' });

  router.register('sheet.close', (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: sheet.close <sheetId>', data: null };
    const ws = ctx.workspace;
    if (!ws) return { text: 'ERR: workspace not ready', data: null };
    const sheetId = args.join(' ');
    const sheet = ws.getSheet(sheetId);
    if (!sheet) return { text: `ERR: no sheet "${sheetId}"`, data: null };
    const title = sheet.title;
    // Closing = derender-if-drawn (same null-before-remove ordering as sheet.derender, so the
    // reconcile self-heal stays quiet) THEN drop the sheet from its field(s). If the closed panel
    // held attention.primary, clear it — otherwise focus dangles on a panel that no longer exists.
    if (sheet.panelId && ctx.registry.has(sheet.panelId)) {
      const pid = sheet.panelId;
      // Clear the key slot FIRST (if this panel held it): change:key fires exitEdit() on the
      // still-live grid (hides the caret + nulls _cursor) before disposal — otherwise an in-edit
      // grid is removed with _cursor intact, and a later keystroke resurrects a phantom unregistered
      // grid. Then clear primary so focus doesn't dangle on a panel that no longer exists.
      if (ctx.attentionManager?.get?.('key')?.id === pid) {
        ctx.attentionManager.set('key', null, { registry: ctx.registry });
      }
      if (ctx.attentionManager?.get?.('primary')?.id === pid) {
        ctx.attentionManager.set('primary', null, { registry: ctx.registry });
      }
      ws.setPanelId(sheet.id, null);
      ctx.removeGrid(pid);
      reflowGrids(ctx);
    }
    ws.removeSheet(sheet.id);
    return { text: `OK: closed sheet "${title}"`, data: { id: sheetId, closed: true } };
  }, { description: 'Close a sheet: derender its panel (if drawn) + drop it from the field', usage: '<sheetId>' });

  router.register('field.list', (args, ctx) => {
    const ws = ctx.workspace;
    if (!ws) return { text: 'ERR: workspace not ready', data: null };
    const fields = ws.listFields();
    const rows = fields.map((f, i) => [String(i), f.active ? '*' : ' ', f.name, String(f.sheetCount)]);
    return {
      text: table(['#', 'a', 'name', 'sheets'], rows) + `\nOK: ${fields.length} fields`,
      data: { fields, count: fields.length },
    };
  }, { description: 'List workspace fields (active marked *)' });
}
