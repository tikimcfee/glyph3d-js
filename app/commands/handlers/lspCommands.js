/**
 * lsp.* — language-server-backed navigation verbs.
 *
 * The relay hosts the actual language servers (cli/lsp.go); these verbs send the
 * caret position over the bus and render the result in 3D — jump to + highlight
 * the definition. The IDE indexes text by codepoint column; LSP speaks UTF-16, so
 * we convert at the seam (cpToUtf16 outbound, utf16ToCp on the result).
 */
import { resolveGridByIdOrIndex } from './spatialHelpers.js';
import { renderSheetGrid } from './fileLoader.js';

const DEF_COLOR = { r: 0.3, g: 0.8, b: 1.0 }; // matches highlightCommands' 'blue'

/** codepoint column → UTF-16 column (a caret position on its way to the server). */
function cpToUtf16(lineText, col) {
    if (!lineText || col <= 0) return Math.max(0, col | 0);
    return [...lineText].slice(0, col).join('').length;
}

/** UTF-16 column → codepoint column (a server result on its way to a glyph slot). */
function utf16ToCp(lineText, col) {
    if (!lineText || col <= 0) return Math.max(0, col | 0);
    return [...lineText.slice(0, col)].length;
}

/** file:///<path> → <path>, the form renderSheetGrid / the registry address files by. */
function pathFromURI(u) {
    return String(u).replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
}

export default function registerLspCommands(router) {
    router.register('lsp.definition', async (args, ctx) => {
        if (!ctx.lsp) return { text: 'ERR: LSP unavailable — connect the relay', data: null };

        // [] → caret on focused grid; [line col] → focused grid at position;
        // [grid line col] → explicit grid + position.
        let gridArg = null, line = null, col = null;
        if (args.length >= 3) { gridArg = args[0]; line = Number(args[1]); col = Number(args[2]); }
        else if (args.length === 2) { line = Number(args[0]); col = Number(args[1]); }
        else if (args.length === 1) { gridArg = args[0]; }

        const targetId = gridArg ?? ctx.attention?.primary?.id ?? ctx.attention?.key?.id ?? null;
        if (!targetId) return { text: 'ERR: no focused grid — open a file or pass <grid> <line> <col>', data: null };
        const resolved = resolveGridByIdOrIndex(ctx, String(targetId), 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };
        const grid = resolved.grid;

        if (line == null) {
            const cur = grid.getCursor?.();
            if (!cur) return { text: 'ERR: no caret — click into the grid or pass <line> <col>', data: null };
            line = cur.line; col = cur.col;
        }
        if (!Number.isFinite(line) || !Number.isFinite(col)) {
            return { text: 'ERR: line and col must be numbers', data: null };
        }

        const srcURI = grid.getSourcePath?.();
        if (!srcURI) return { text: 'ERR: focused grid has no source path', data: null };
        const character = cpToUtf16(grid.lines?.[line] ?? '', col);

        let res;
        try {
            res = await ctx.lsp.definition(srcURI, line, character, grid.getContent?.());
        } catch (e) {
            const hint = e?.data?.install ? ` — install: ${e.data.install}` : '';
            return { text: `ERR: lsp.definition: ${e?.message || e}${hint}`, data: null };
        }

        const locs = res?.locations || [];
        if (!locs.length) return { text: `OK: no definition at ${line}:${col}`, data: { locations: [] } };
        const loc = locs[0];

        // Open (or focus) the destination, highlight the def range, fly to it.
        let destId;
        try {
            destId = await renderSheetGrid(ctx, pathFromURI(loc.uri));
        } catch (e) {
            return { text: `OK: definition at ${loc.uri} (couldn't open: ${e?.message || e})`, data: { location: loc } };
        }

        const destGrid = ctx.registry?.get?.(destId)?.grid;
        if (destGrid) {
            const sL = loc.range.start.line, eL = loc.range.end.line;
            const sCp = utf16ToCp(destGrid.lines?.[sL] ?? '', loc.range.start.character);
            const eCp = utf16ToCp(destGrid.lines?.[eL] ?? '', loc.range.end.character);
            destGrid.clearAllHighlights?.();
            destGrid.highlightRange?.(sL, sCp, eL, eCp, DEF_COLOR);
        }
        ctx.attentionManager?.set?.('primary', destId, { registry: ctx.registry });
        try { await router.execute(['camera.focus', destId]); } catch { /* framing is best-effort */ }

        return {
            text: `OK: definition → ${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`,
            data: { source: { uri: srcURI, line, col }, location: loc, gridId: destId },
        };
    }, {
        description: 'Jump to the LSP definition of the symbol at the caret (or an explicit position)',
        usage: '[grid] [line col]',
        returns: '{ location, gridId }',
    });

    router.register('lsp.status', async (args, ctx) => {
        if (!ctx.lsp) return { text: 'ERR: LSP unavailable — connect the relay', data: null };
        let s;
        try {
            s = await ctx.lsp.status();
        } catch (e) {
            return { text: `ERR: ${e?.message || e}`, data: null };
        }
        const rows = (s?.servers || []).map(
            (sv) => `  ${sv.key} (${sv.command}): ${sv.installed ? 'installed' : 'NOT installed'}${sv.running ? ', running' : ''}`,
        );
        return {
            text: `LSP root: ${s?.root || '(none)'}\n${rows.join('\n') || '  (no servers configured)'}`,
            data: s,
        };
    }, {
        description: 'Report LSP server availability and run state',
        usage: '',
        returns: '{ root, servers }',
    });
}
