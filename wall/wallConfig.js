import { OPTION_AS_ALT } from '@glyph3d/core/services/interaction/keyEncoding.js';

/**
 * wallConfig — the wall's knobs for hiding, closing, selecting and grouping, the termd status
 * window's and the keyboard's, born configurable: `new TerminalWall({ …, config })` overrides any of them, and
 * `wall.config <key> <value>` dials one live (a group's own columns and gap live on the group; these
 * are what a new group is born with).
 */
export const WALL_CONFIG = Object.freeze({
    /** How long the close button (or the close chord, X) must be held before the terminal is killed, ms. */
    closeHoldMs: 650,
    /** A title bar's button cluster shows only when the bar is at least this tall on screen, CSS px. */
    barButtonsMinPx: 14,
    /** A new group's layout: 'tile' (members packed in columns) or 'freeform' (members keep their spots). */
    groupLayout: 'tile',
    /** A new tiled group's columns; 0 = the square root of its size, rounded up. */
    groupColumns: 0,
    /** World units between tiled members (a title bar's room is added above each row on top of it). */
    groupGap: 2,
    /** World units the group's backdrop reaches past its members' windows. */
    groupPad: 3,
    /**
     * A termd brain restart shows its notice only once it has lasted this long, ms: a crash restart
     * that comes back in a blink shows only the amber chip (docs/termd/DESIGN.md "Status: in the
     * app"); one that lingers says so in words. Unreachable, failed and lost show at once.
     */
    restartNoticeMs: 400,
    /** Recent termd errors the status window lists, newest first (the document keeps more; `g3d status --json` has them all). */
    errorsShown: 3,
    /**
     * Whether Alt is Alt when it typed a character (macOS Option), sent with every key for termd
     * (keyEncoding.OPTION_AS_ALT): 'auto' — Option's character (å) when it made one, else Alt;
     * 'true' — Option is Alt (Option+A is ESC a); 'false' — Option types characters, even Alt+A.
     * Read per key: a change takes the next key.
     */
    optionAsAlt: 'auto',
});

/** @typedef {{ -readonly [K in keyof typeof WALL_CONFIG]: (typeof WALL_CONFIG)[K] }} WallConfig */

/**
 * Check one knob's value, coerced from a string when it came from a verb. Throws naming the knob.
 * @param {string} key @param {any} value @returns {any}
 */
export function checkConfig(key, value) {
    if (!(key in WALL_CONFIG)) throw new Error(`unknown wall knob '${key}' (knobs: ${Object.keys(WALL_CONFIG).join(', ')})`);
    if (key === 'groupLayout') {
        if (value !== 'tile' && value !== 'freeform') throw new Error(`groupLayout is 'tile' or 'freeform', not '${value}'`);
        return value;
    }
    if (key === 'optionAsAlt') {
        const v = String(value);
        if (!OPTION_AS_ALT.includes(v)) throw new Error(`optionAsAlt is ${OPTION_AS_ALT.join(', ')}, not '${value}'`);
        return v;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} takes a number ≥ 0, not '${value}'`);
    if ((key === 'groupColumns' || key === 'errorsShown') && !Number.isInteger(n)) throw new Error(`${key} takes a whole number, not '${value}'`);
    return n;
}
