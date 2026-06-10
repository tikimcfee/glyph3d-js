/**
 * readability.js — the bounds of human-readable source.
 *
 * One judgment, shared by every consumer that has to decide whether text is
 * code a person reads or an artifact a machine wrote (minified bundles, data
 * dumps, lockfiles): the colorizer skips parsing it, the IDE's file loaders
 * render a "not rendered" placeholder instead of millions of glyphs. Keeping
 * the thresholds in one place means "why didn't this file render/color?"
 * always has the same answer.
 */

export const READABLE_MAX_CHARS = 1_000_000;
export const READABLE_MAX_LINE_CHARS = 10_000;

/**
 * Why this text is not readable source, or null if it is. The newline hunt is
 * native `indexOf` hops — one JS iteration per LINE, not per character — so even
 * a multi-megabyte string costs microseconds, cheaper than the `split('\n')`
 * every render path performs on the same content right after.
 * @param {string} text
 * @returns {{ chars: number, maxLineChars: number } | null}
 */
export function unreadableReason(text) {
    if (typeof text !== 'string' || !text) return null;
    let maxLine = 0;
    let start = 0;
    let nl = 0;
    do {
        nl = text.indexOf('\n', start);
        const end = nl === -1 ? text.length : nl;
        if (end - start > maxLine) maxLine = end - start;
        start = nl + 1;
    } while (nl !== -1);
    if (text.length <= READABLE_MAX_CHARS && maxLine <= READABLE_MAX_LINE_CHARS) return null;
    return { chars: text.length, maxLineChars: maxLine };
}
