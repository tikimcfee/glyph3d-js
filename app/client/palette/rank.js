/**
 * rank — the palette's scoring seam. The ONLY module that imports fzf; the bar
 * consumes rank(query, entries) and never touches the library API, so swapping
 * scorers later is a one-file change.
 *
 * Entries are scored by fzf's v2 algorithm over entry.key (path-tuned bonuses:
 * separator boundaries, camelCase, consecutive runs), then the merge policy
 * applies on top:
 *   • an exact verb-name match pins to the top (a fully-typed verb always wins),
 *   • open sheets outrank unopened files (jumping beats re-opening),
 *   • ties break toward the shorter key (byLengthAsc).
 * Match positions ride along so rows can highlight the matched characters.
 */
import { Fzf, byLengthAsc } from 'fzf';

// Additive nudges on fzf's score, by kind. Decent fzf matches land roughly
// 30–150, so +24 lifts a same-quality sheet above a file without letting a
// weak sheet match beat a strong file match.
const KIND_BOOST = { sheet: 24, scheme: 8, verb: 0, file: 0 };
const EXACT_VERB_PIN = 1000;

// Corpus is stable for a whole bar-open (the bar memoizes its entries array),
// so build the fzf index once per array identity, not once per keystroke.
const _fzfByEntries = new WeakMap();

function fzfFor(entries) {
    let f = _fzfByEntries.get(entries);
    if (!f) {
        f = new Fzf(entries, { selector: (e) => e.key, tiebreakers: [byLengthAsc] });
        _fzfByEntries.set(entries, f);
    }
    return f;
}

/**
 * @param {string} query
 * @param {Array<{kind: string, key: string}>} entries — pass the SAME array
 *   identity across keystrokes so the index is reused
 * @param {number} [limit]
 * @returns {Array<{ entry: object, positions: Set<number>, score: number }>}
 */
export function rank(query, entries, limit = 9) {
    const q = query.trim();
    if (!q) return [];
    return fzfFor(entries)
        .find(q)
        .map((r) => ({
            entry: r.item,
            positions: r.positions,
            score: r.score
                + (KIND_BOOST[r.item.kind] || 0)
                + (r.item.kind === 'verb' && r.item.key === q.toLowerCase() ? EXACT_VERB_PIN : 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
