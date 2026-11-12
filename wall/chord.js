/**
 * chord — the wall's chord modifier, decided once, here: ⌘ on macOS, Ctrl+Alt everywhere else.
 * Ctrl alone belongs to the shell (^C, ^R, ^[…) and Alt alone is readline's Meta, so off macOS a
 * wall chord takes both. AltGr — which Linux and Windows report as Ctrl+Alt, and which many
 * layouts type [ ] { } 0 with — is never a chord. WallKeys and the palette's chord (main.jsx) both
 * ask isChord; the hint line and the palette label chords with chordLabel.
 */

const platform = (typeof navigator !== 'undefined' && (navigator.userAgentData?.platform || navigator.platform)) || '';

/** macOS (and iPadOS with a keyboard): ⌘ chords. */
export const IS_MAC = /mac|iphone|ipad|ipod/i.test(platform);

/** The chord's modifiers as Playwright key names — what a test presses. */
export const CHORD_KEYS = IS_MAC ? ['Meta'] : ['Control', 'Alt'];

/** What the drag-to-move modifier (e.altKey) is called on this platform. */
export const ALT_LABEL = IS_MAC ? '⌥' : 'Alt';

/** @param {KeyboardEvent} e @returns {boolean} true when `e` carries the wall's chord (Shift may ride along) */
export function isChord(e) {
    if (IS_MAC) return e.metaKey;
    return e.ctrlKey && e.altKey && !e.metaKey && !e.getModifierState?.('AltGraph');
}

/**
 * A chord's label for the hint and the palette: `⌘]` / `Ctrl+Alt+]`; several keys share one
 * modifier (`⌘[ ⌘]` / `Ctrl+Alt+[ ]`).
 * @param {string[]} keys - the key glyphs (`[`, `↵`, `0`, `K`)
 * @param {{ shift?: boolean }} [o]
 */
export function chordLabel(keys, { shift = false } = {}) {
    if (IS_MAC) return keys.map((k) => `⌘${shift ? '⇧' : ''}${k}`).join(' ');
    return `Ctrl+Alt+${shift ? 'Shift+' : ''}${keys.join(' ')}`;
}
