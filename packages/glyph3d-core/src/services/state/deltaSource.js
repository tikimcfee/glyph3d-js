/**
 * deltaSource — the pure delta algebra behind DeltaBooks: every way a before/after
 * pair reaches the display reduces here to ONE shape, the aligned side-by-side
 * line arrays DiffParser speaks ({ left, right } of DiffLine). Three sources:
 *
 *   a unified diff (git)            → splitUnifiedDiff → alignPatch      (hunk-condensed)
 *   two full texts (watch/pair)     → alignTexts                          (condensed or full)
 *   head text + the edit's hunks    → reconstructBase                     (the watch lane's
 *                                     base capture: reverse-apply the FIRST edit's patch
 *                                     against disk, so the spread shows cumulative drift)
 *
 * Diffing itself is jsdiff (`diff`) — the same library whose structuredPatch shape
 * the agent tool events already carry, so the two lanes can never disagree about
 * what a hunk is. Pure: no THREE / DOM — bun tests import this directly.
 */

import { structuredPatch, applyPatch, reversePatch } from 'diff';
import { parsePatchAligned, buildAlignedDiff } from './DiffParser.js';

/** jsdiff hunks → minimal unified-patch text (@@ headers + lines) — exactly what
 *  DiffParser's parsers consume; no file headers, so nothing to strip downstream. */
export function hunksToPatch(hunks) {
    const out = [];
    for (const h of (hunks || [])) {
        const oldN = h.oldLines ?? h.oldCount ?? 0;
        const newN = h.newLines ?? h.newCount ?? 0;
        out.push(`@@ -${h.oldStart},${oldN} +${h.newStart},${newN} @@`);
        out.push(...(h.lines || []));
    }
    return out.join('\n');
}

/** Tolerant hunk normalization: the wire shape (oldCount/newCount variants) → jsdiff's
 *  (oldLines/newLines), so reversePatch/applyPatch accept hunks from any ingress. */
function normalizeHunks(hunks) {
    return (hunks || []).map((h) => ({
        oldStart: h.oldStart, oldLines: h.oldLines ?? h.oldCount ?? 0,
        newStart: h.newStart, newLines: h.newLines ?? h.newCount ?? 0,
        lines: h.lines || [],
    }));
}

/** +added / −removed over an aligned pair. */
export function alignedStats({ left, right }) {
    let added = 0, removed = 0;
    for (const l of left) if (l.type === 'remove') removed++;
    for (const r of right) if (r.type === 'add') added++;
    return { added, removed };
}

/**
 * One changed file's slice of a multi-file unified diff (`git diff` output).
 * @typedef {{ path: string, oldPath: string, newPath: string,
 *             status: 'modified'|'added'|'deleted'|'renamed'|'binary',
 *             patch: string }} DiffFile
 */

/**
 * Split raw `git diff` output into per-file records. The patch each record keeps
 * starts at its first @@ line — the ---/+++/index headers are read for status and
 * paths, then dropped (DiffParser's aligned parser reads -/+ prefixes positionally,
 * so headers must never reach it).
 * @param {string} text
 * @returns {DiffFile[]}
 */
export function splitUnifiedDiff(text) {
    const files = [];
    if (!text) return files;
    const chunks = String(text).split(/^diff --git /m).slice(1);
    for (const chunk of chunks) {
        const lines = chunk.split('\n');
        // Header line: `a/old/path b/new/path` (quoted forms stay raw — the paths still read).
        const m = lines[0].match(/^"?a\/(.+?)"? "?b\/(.+?)"?\s*$/);
        let oldPath = m ? m[1] : lines[0];
        let newPath = m ? m[2] : lines[0];
        let status = 'modified';
        let hunkStart = -1;
        for (let i = 1; i < lines.length; i++) {
            const ln = lines[i];
            if (ln.startsWith('@@')) { hunkStart = i; break; }
            if (ln.startsWith('new file mode')) status = 'added';
            else if (ln.startsWith('deleted file mode')) status = 'deleted';
            else if (ln.startsWith('rename from ')) { status = 'renamed'; oldPath = ln.slice('rename from '.length); }
            else if (ln.startsWith('rename to ')) newPath = ln.slice('rename to '.length);
            else if (ln.startsWith('Binary files ')) status = 'binary';
        }
        files.push({
            path: status === 'deleted' ? oldPath : newPath,
            oldPath, newPath, status,
            patch: hunkStart >= 0 ? lines.slice(hunkStart).join('\n') : '',
        });
    }
    return files;
}

/**
 * A patch (no full texts available — the git lane) → the hunk-condensed aligned pair.
 * @param {string} patch  unified patch text starting at its first @@ line
 * @returns {{ left: import('./DiffParser.js').DiffLine[], right: import('./DiffParser.js').DiffLine[], added: number, removed: number }}
 */
export function alignPatch(patch) {
    const pair = parsePatchAligned(patch);
    return { ...pair, ...alignedStats(pair) };
}

/**
 * Two full texts → the aligned pair, diffed here (jsdiff structuredPatch).
 * @param {string} baseText
 * @param {string} headText
 * @param {{ view?: 'condensed'|'full', context?: number }} [opts]
 *        condensed (default) shows hunks + context lines only — the dense
 *        observation view; full aligns the entire files.
 * @returns {{ left: Array, right: Array, added: number, removed: number }}
 */
export function alignTexts(baseText, headText, { view = 'condensed', context = 3 } = {}) {
    const base = String(baseText ?? ''), head = String(headText ?? '');
    const { hunks } = structuredPatch('a', 'b', base, head, '', '', { context });
    const patch = hunksToPatch(hunks);
    const pair = view === 'full' ? buildAlignedDiff(base, head, patch) : parsePatchAligned(patch);
    return { ...pair, ...alignedStats(pair) };
}

/**
 * Reverse-apply an edit's hunks against the text AS WRITTEN to recover the text as
 * it was BEFORE the edit — the watch lane's base capture (the first event for a
 * file arrives after the write already landed; the patch is the way back).
 * @param {string} headText  the file's content after the edit
 * @param {Array} hunks      the edit's structuredPatch hunks (wire shape tolerated)
 * @returns {string|null}    the base text, or null when the patch no longer applies
 *                           (the file drifted between the edit and the read)
 */
export function reconstructBase(headText, hunks) {
    const norm = normalizeHunks(hunks);
    if (!norm.length) return String(headText ?? '');
    try {
        const r = applyPatch(String(headText ?? ''), reversePatch({ hunks: norm }));
        return r === false ? null : r;
    } catch (_e) {
        return null;
    }
}
