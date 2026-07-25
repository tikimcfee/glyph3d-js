/**
 * providers — the palette's noun sources. Each provider lists addressable THINGS
 * and the verb line each one implies; the bar executes that line through
 * router.execute, so selecting a row and typing the command are the same act.
 * The subtitle under every row IS entry.command — the palette teaches the bus
 * vocabulary while you use it, and a row that can't show its command line is a
 * row reaching around the bus.
 *
 * Entry shape:
 *   { kind, key, command, insert, detail, usage }
 *     kind    — 'file' | 'sheet' | 'scheme' | 'verb'
 *     key     — the searched AND displayed text (rank positions index into it)
 *     command — token array for router.execute (array form keeps a path with
 *               spaces intact); null for verbs
 *     insert  — verbs only: what Tab/Enter put in the input for arg entry
 *     detail  — small annotation ('open — jump', 'layout scheme', verb description)
 */
import { LAYOUT_SCHEMES } from '@glyph3d/core/collections/layouts/index.js';

/** Verbs from the router registry — selecting one inserts `name ` for arg entry. */
export function verbEntries(client) {
    let list = [];
    try { list = client?.router?.listCommands?.() || []; } catch { /* registry not up */ }
    return list.map((v) => ({
        kind: 'verb', key: v.name, command: null, insert: v.name + ' ',
        detail: v.description || '', usage: v.usage || '',
    }));
}

/**
 * Nouns: open sheets (jump via sheet.focus), the repo file roster (open via
 * file.open), layout schemes. A file already open as a sheet is deduped out —
 * the jump row subsumes the open row. Async because the roster may be an RPC
 * away; every source degrades to "absent" rather than failing the palette.
 */
export async function nounEntries(client) {
    const ctx = client?.ctx;
    const out = [];
    const openPaths = new Set();

    // Open sheets — the working set. sheet.focus is THE jump gesture in one verb:
    // render-if-needed → attention primary → camera frame → mark active.
    // Sheet paths are canonical (absolute in relay mode); the roster rows below are
    // root-relative. Compare + display both in the relative space.
    const root = ctx?.fileProvider?.rootInfo?.root;
    const relOf = (p) => {
        const s = String(p ?? '');
        return root && s.startsWith(root + '/') ? s.slice(root.length + 1) : s.replace(/^\/+/, '');
    };
    try {
        const sheets = ctx?.workspace?.listActiveSheets?.(ctx.registry, ctx.attentionManager) || [];
        for (const s of sheets) {
            const path = s.source?.path ? relOf(s.source.path) : null;
            if (path) openPaths.add(path);
            out.push({ kind: 'sheet', key: path || s.title, command: ['sheet.focus', s.id], detail: 'open — jump' });
        }
    } catch { /* workspace not wired yet */ }

    // The repo roster — relay fs or GitHub, same surface; the same call openDir uses.
    // File rows ALSO ride sheet.focus (it opens unopened paths on the way through),
    // so every palette jump flies the camera — open or not, same gesture, same verb.
    // file.open stays the no-camera-yank primitive for bulk/scripted opens.
    try {
        const { entries } = await ctx.fileProvider.listTree('file:///');
        for (const f of ctx.fileProvider.filterCodeFiles({ tree: entries })) {
            if (openPaths.has(f.path)) continue;
            out.push({ kind: 'file', key: f.path, command: ['sheet.focus', f.path], detail: '' });
        }
    } catch { /* no source yet (no repo, relay down) — sheets/schemes/verbs still work */ }

    for (const name of Object.keys(LAYOUT_SCHEMES)) {
        out.push({ kind: 'scheme', key: name, command: ['layout.scheme', name], detail: 'layout scheme' });
    }
    return out;
}
