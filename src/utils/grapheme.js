/**
 * Grapheme segmentation utility.
 *
 * Iterates Unicode grapheme clusters using Intl.Segmenter (Baseline 2024).
 * Fallback for environments without Intl.Segmenter: codePointAt() iteration,
 * which handles surrogate pairs (emoji stored as single codepoints) but not
 * ZWJ sequences (each codepoint renders separately). Acceptable degradation.
 *
 * Worker-safe: Intl is available on DedicatedWorkerGlobalScope.
 * No DOM, no Three.js imports.
 */

const _hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

/** @type {Intl.Segmenter|null} */
let _segmenter = null;
if (_hasSegmenter) {
    _segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
}

/**
 * Iterate grapheme clusters in a string.
 *
 * Each yielded value is a grapheme cluster string — a single visible character
 * as the user perceives it. For ASCII this is always a single code unit.
 * For supplementary plane characters (emoji, CJK Extension B) the string may
 * be 2+ JavaScript chars. For ZWJ sequences (e.g. family emoji) it may be
 * many chars with zero-width joiners in between.
 *
 * @param {string} text
 * @returns {Iterable<string>} Iterable of grapheme cluster strings
 */
export function iterGraphemes(text) {
    if (_segmenter) {
        return _iterSegmenter(text);
    }
    return _iterCodePoints(text);
}

/**
 * Count grapheme clusters in a string.
 * O(n) regardless of path.
 * @param {string} text
 * @returns {number}
 */
export function countGraphemes(text) {
    let n = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _g of iterGraphemes(text)) n++;
    return n;
}

/** @returns {Iterable<string>} */
function* _iterSegmenter(text) {
    for (const seg of _segmenter.segment(text)) {
        yield seg.segment;
    }
}

/** @returns {Iterable<string>} */
function* _iterCodePoints(text) {
    let i = 0;
    while (i < text.length) {
        const cp = text.codePointAt(i);
        // Supplementary plane: codepoint > 0xFFFF uses a surrogate pair (2 JS chars)
        const len = cp > 0xFFFF ? 2 : 1;
        yield text.slice(i, i + len);
        i += len;
    }
}
