/**
 * identityHue — the ONE rule an identity's colour follows: a hash of its id into a palette. An agent's
 * book (AgentBooks lane), a delta set, a caller's points and its channel rows all read their hue
 * through it, so a name wears the same colour on every load — never the order things happened to open
 * in (which a reload reshuffles).
 */

/**
 * The palette slot for an id: FNV-1a over its codepoints, modulo the palette's size. Pure.
 * @param {string} id @param {number} n the palette's length @returns {number} in [0, n)
 */
export function hueIndexOf(id, n) {
    if (!(n > 0)) return 0;
    let h = 2166136261;
    for (const ch of String(id ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    return (h >>> 0) % n;
}
