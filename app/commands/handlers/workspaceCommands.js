/**
 * Workspace commands — the field / sheet (working-set) verbs.
 *
 * They MUTATE ctx.workspace (the WorkspaceModel) and NEVER reach into the scene directly;
 * rendering is delegated to the existing render verbs (wired in later steps). The HUD is a
 * pure reflection of this model. See the fields→sheets→panels design.
 *
 * Build status: Step 0–1 — sheet.open / sheet.list / field.list (headless: proves the
 * open⊋rendered layer with nothing drawn). sheet.render/derender/focus + field.* land next.
 */
import { box, table } from '../formatResponse.js';

const dot = (s) => (s.focused ? '●' : s.rendered ? '◐' : '○');  // focused · rendered · open-only

export default function registerWorkspaceCommands(router) {
  router.register('sheet.open', (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: sheet.open <path>', data: null };
    const ws = ctx.workspace;
    if (!ws) return { text: 'ERR: workspace not ready', data: null };
    const path = args.join(' ');
    const sheet = ws.openSheet({ kind: 'file', source: { path, uri: 'file://' + path } });
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
