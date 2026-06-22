/**
 * toolMeta — per-tool-call metadata handling, keyed by the normalized action. The ONE home for
 * "what does each tool's metadata mean, and what do we do with it", so the knowledge isn't smeared
 * across the replay (extract) and the trail (render):
 *
 *   parse(toolUseResult) → a normalized meta object (the bits worth carrying), INCLUDING the line
 *                          ranges an action touched (an edit's added-line runs, a partial read's
 *                          slice) so the snapshot can be decorated.
 *   decorate(meta)       → highlight directives [{ startLine, endLine, color }] (0-based, inclusive)
 *                          the trail lights up on the snapshot grid via highlightRange.
 *
 * `parse` is the JS source-shape reader (the session JSONL / hook payload's `toolUseResult`); the Go
 * hook mirrors it. `decorate` is universal — it runs on the normalized meta regardless of source.
 * Presentation of the meta FIELDS (the call-card subtitle) is the generic fmtMeta in AgentTrail; this
 * module is parse + decorate only.
 *
 * Pure: plain `{ r, g, b }` colors, no THREE / DOM — so the bun replay imports it too.
 */

// Additive highlight — ADDED to the (already syntax-colored) glyph, so it must be bright + saturated
// to read at trail scale. These pop the touched lines without a full background bar.
const ADDED = { r: 0.15, g: 1.00, b: 0.45 };   // bright green — lines an edit added
const READ  = { r: 0.25, g: 0.70, b: 1.00 };   // bright blue  — the slice a partial read touched

/** Walk unified-diff hunks, collecting runs of consecutive ADDED new-file line numbers (1-based). */
function addedRanges(structuredPatch) {
    const ranges = [];
    for (const h of (structuredPatch || [])) {
        let newLine = h.newStart || 1;
        let runStart = null;
        for (const ln of (h.lines || [])) {
            const c = ln[0];
            if (c === '+') {
                if (runStart === null) runStart = newLine;
                newLine++;
            } else {
                if (runStart !== null) { ranges.push([runStart, newLine - 1]); runStart = null; }
                if (c !== '-') newLine++;   // context advances the new-file cursor; '-' (removed) does not
            }
        }
        if (runStart !== null) ranges.push([runStart, newLine - 1]);
    }
    return ranges;
}

/** Total +added / −removed across all hunks. */
function countPatch(structuredPatch) {
    let added = 0, removed = 0;
    for (const h of (structuredPatch || [])) {
        for (const ln of (h.lines || [])) {
            if (ln[0] === '+') added++;
            else if (ln[0] === '-') removed++;
        }
    }
    return { added, removed };
}

export const TOOL_META = {
    read: {
        parse(tur) {
            const f = tur && tur.file;
            if (!f) return null;
            if (f.numLines != null) {
                const m = { lines: f.numLines };
                const partial = f.startLine > 1 || (f.totalLines != null && f.numLines < f.totalLines);
                if (partial && f.startLine != null) m.range = [f.startLine, f.startLine + f.numLines - 1];
                return m;
            }
            if (f.originalSize != null) return { bytes: f.originalSize };   // image / binary read
            return null;
        },
        decorate(meta) {
            return meta && meta.range
                ? [{ startLine: meta.range[0] - 1, endLine: meta.range[1] - 1, color: READ }]
                : null;
        },
    },

    edit: {
        parse(tur) {
            const { added, removed } = countPatch(tur && tur.structuredPatch);
            return { added, removed, ranges: addedRanges(tur && tur.structuredPatch) };
        },
        decorate(meta) {
            return (meta && meta.ranges || []).map(([s, e]) => ({ startLine: s - 1, endLine: e - 1, color: ADDED }));
        },
    },

    write: {
        // A create is all-new; lighting up every line is noise, so no decorate — the subtitle carries it.
        parse(tur) { return { kind: tur && tur.type, lines: String(tur && tur.content || '').split('\n').length }; },
    },

    bash: {
        parse(tur) {
            const out = String(tur && tur.stdout || '');
            const m = { lines: out ? out.replace(/\n$/, '').split('\n').length : 0 };
            if (tur && tur.interrupted) m.interrupted = true;
            return m;
        },
    },

    task: {
        parse(tur) { return { tools: tur && tur.totalToolUseCount, tokens: tur && tur.totalTokens, ms: tur && tur.totalDurationMs }; },
    },
};

/**
 * Normalize a tool's raw result into meta. Keyed by the NORMALIZED action (read/edit/write/bash/task),
 * which is what both the replay's mapTool and the trail's record carry.
 * @param {string} action
 * @param {Object} toolUseResult
 * @returns {Object|null}
 */
export function parseToolMeta(action, toolUseResult) {
    if (!toolUseResult || typeof toolUseResult !== 'object') return null;
    return TOOL_META[action]?.parse?.(toolUseResult) ?? null;
}

/**
 * Highlight directives for a snapshot grid, given a record's action + normalized meta.
 * @param {string} action
 * @param {Object} meta
 * @returns {Array<{startLine:number, endLine:number, color:{r:number,g:number,b:number}}>|null}
 */
export function decorateForMeta(action, meta) {
    if (!meta) return null;
    const d = TOOL_META[action]?.decorate?.(meta);
    return (d && d.length) ? d : null;
}
