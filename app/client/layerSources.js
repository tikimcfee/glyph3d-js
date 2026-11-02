/**
 * layerSources — where a member's DEPTH LAYERS come from (LayerStack, slice 10a: depth as time).
 *
 *   a code grid  → its file's revisions, newest first: the relay's fs/gitLog (`git log --follow`,
 *                  each commit's text at that commit), laid as the grid lays its own text
 *                  (textRows at its wrap) — revisions identical to what the grid shows now are
 *                  skipped at the front, so layer 1 is the last version that DIFFERS;
 *   an agent book in its scroll form → its run by turn (AgentBooks.turnLayers);
 *   a terminal   → its scrollback, a screen per layer (terminalPageLayers).
 *
 * Each source answers `{layers, opts}` — the layers and the LayerStack options its member reads
 * best with. Nothing here places anything; the layer verbs do (layerCommands.js).
 */

import { textRows, terminalPageLayers } from '@glyph3d/core/collections';

/** History text colour on a revision page (its own dim neutral — the member keeps its syntax colours). */
export const REVISION_COLOR = Object.freeze({ r: 0.74, g: 0.77, b: 0.84 });

/**
 * A commit's day as the display's calendar, `YYYY-MM-DD` in the browser's own zone (fs/gitLog's `time` is
 * unix ms, UTC; it stays so). @param {number} ms @returns {string}
 */
export function localDay(ms) {
    const d = new Date(ms), two = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * A file's revisions as layers — pure: `commits` as fs/gitLog answers (newest first, with text),
 * `current` the text the grid shows now. Leading revisions equal to `current` are skipped; a
 * revision the relay left textless (its budget) is skipped and counted. A label is `sha7 day subject`, the day
 * the display's local one (localDay).
 * @param {Array<{sha:string, time:number, subject:string, path:string, text?:string, textOmitted?:boolean}>} commits
 * @param {string} current @param {{wrapWidth?:number, n?:number, color?:{r:number,g:number,b:number}}} [o]
 * @returns {{layers: Array<{id:string, label:string, kind:'history', rows:Object[], sha:string, text:string}>, omitted:number}}
 */
export function revisionLayers(commits, current, { wrapWidth = 0, n = 5, color = REVISION_COLOR } = {}) {
    const layers = [];
    let omitted = 0, leading = true;
    for (const c of commits) {
        if (typeof c.text !== 'string') { if (c.textOmitted) omitted++; continue; }
        if (leading && c.text === current) continue;
        leading = false;
        if (layers.length >= n) break;
        const day = Number.isFinite(c.time) ? localDay(c.time) : '';
        layers.push({
            id: c.sha.slice(0, 12), label: `${c.sha.slice(0, 7)} ${day} ${c.subject}`.trim(), kind: 'history',
            rows: textRows(c.text, { wrapWidth, color }).rows, sha: c.sha, text: c.text,
        });
    }
    return { layers, omitted };
}

/**
 * The layers a member has, by kind: `{layers, opts}` (LayerStack options), or throws a reason.
 * @param {import('./CommandProvider.jsx').AppContext} ctx
 * @param {{id:string, type?:string, role?:string, grid:Object}} entry a registry entry
 * @param {{n?:number}} [o] how many layers at most
 */
export async function layersFor(ctx, entry, { n = 5 } = {}) {
    const g = entry.grid;
    if (g?.form === 'scroll' && g.scrollDoc) {
        const layers = ctx.agentBooks?.turnLayers?.(entry.id);
        if (!layers) throw new Error(`${entry.id}: not an agent book in its scroll form`);
        return { layers: layers.slice(0, n), opts: { clipToFrame: true } };
    }
    if (Array.isArray(g?._history) && Number.isFinite(g.rows)) {
        return { layers: terminalPageLayers(g._history, g.rows, n), opts: {} };
    }
    const uri = g?.getSourcePath?.();
    if (!uri) throw new Error(`${entry.id}: no layers — not a file grid, a terminal, or a scroll book`);
    const fp = ctx.fileProvider;
    if (typeof fp?.gitLog !== 'function') throw new Error('file revisions need the relay (fs/gitLog)');
    const r = await fp.gitLog({ uri, n: Math.min(50, n + 3), text: true });
    const current = typeof g.getContent === 'function' ? g.getContent() : String(g.content ?? '');
    const { layers, omitted } = revisionLayers(r.commits, current, { wrapWidth: g.getLayout?.()?.wrapWidth ?? 0, n });
    if (omitted) console.warn(`[layers] ${entry.id}: ${omitted} revision(s) came without text (the relay's text budget)`);
    return { layers, opts: {} };
}
