/**
 * rank — the palette's scoring seam. The ONLY module that imports fzf; the bar
 * consumes rank(query, entries) and never touches the library API, so swapping
 * scorers later is a one-file change.
 *
 * Entries are scored by fzf's v2 algorithm over entry.key (path-tuned bonuses:
 * separator boundaries, camelCase, consecutive runs) in extended-match mode —
 * space-separated terms AND together, so the dot-free verb spelling ("grid
 * list") matches grid.list and a multi-word file query ("pane cmd") lands on
 * paneCommands.js. Then the merge policy applies on top:
 *   • an exact verb-name match pins to the top (a fully-typed verb always
 *     wins), dotted or dot-free — "grid list" pins grid.list,
 *   • open sheets outrank unopened files (jumping beats re-opening),
 *   • ties break toward the shorter key (byLengthAsc).
 * Match positions ride along so rows can highlight the matched characters.
 */
import { Fzf, byLengthAsc, extendedMatch } from 'fzf';

// Additive nudges on fzf's score, by kind. Decent fzf matches land roughly
// 30–150, so +24 lifts a same-quality sheet above a file without letting a
// weak sheet match beat a strong file match.
const KIND_BOOST = { sheet: 24, scheme: 8, verb: 0, file: 0 };
const EXACT_VERB_PIN = 1000;

// Verbs aren't equal. "Go look at X" (*.focus) and "open X" (*.open[Dir]) are
// the everyday moves; highlight.* is decoration — niche, and usually issued
// programmatically (hover-preview), not typed. On an ambiguous short query
// (six highlight.* verbs crowd the corpus) that floated highlight above
// file.open / *.focus, which is the wrong default. So float focus/open and
// sink highlight by a swing comparable to the sheet boost — WITHOUT removing
// highlight: typing toward it still surfaces it (the nudge only reorders the
// matched set), and a fully-typed verb still pins via EXACT_VERB_PIN.
const VERB_NUDGE = 16;
function verbNudge(key) {
    const action = key.slice(key.lastIndexOf('.') + 1);
    if (action === 'focus' || action === 'open' || action === 'openDir') return VERB_NUDGE;
    if (key.startsWith('highlight.')) return -VERB_NUDGE;
    return 0;
}

// Corpus is stable for a whole bar-open (the bar memoizes its entries array),
// so build the fzf index once per array identity, not once per keystroke.
const _fzfByEntries = new WeakMap();

function fzfFor(entries) {
    let f = _fzfByEntries.get(entries);
    if (!f) {
        f = new Fzf(entries, { selector: (e) => e.key, tiebreakers: [byLengthAsc], match: extendedMatch });
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
    const qNorm = q.toLowerCase();
    const qDot = qNorm.replace(/\s+/g, '.');   // dot-free verb spelling: "grid list" pins grid.list
    return fzfFor(entries)
        .find(q)
        .map((r) => ({
            entry: r.item,
            positions: r.positions,
            score: r.score
                + (KIND_BOOST[r.item.kind] || 0)
                + (r.item.kind === 'verb' ? verbNudge(r.item.key) : 0)
                + (r.item.kind === 'verb' && (r.item.key === qNorm || r.item.key === qDot) ? EXACT_VERB_PIN : 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
