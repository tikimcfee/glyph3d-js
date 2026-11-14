import { KNOBS, checkKnob } from './wallSettings.js';

/**
 * wallConfig — the wall's knobs for hiding, closing, selecting and grouping, the termd status
 * window's and the keyboard's, the canvas's (its colour, the drafting grid, snapping), born
 * configurable: `new TerminalWall({ …, config })` overrides any of them, and `wall.config <key>
 * <value>` dials one live and remembers it per relay (WallStore; `wall.config <key> default` hands it
 * back). A group's own columns and gap live on the group; these are what a new group is born with.
 * What each knob is — its type, range, section and description — is wallSettings.KNOBS.
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

    // ── the canvas: its colour, the drafting grid, snapping (wallSnap.js, WallPaper.js) ──
    /** The canvas colour, sRGB. */
    background: '#07080b',
    /** Draw the grid. */
    gridShow: true,
    /** World units between minor lines — the snap step. */
    gridMinor: 4,
    /** Every Nth minor line is a major line (1: every line is major). */
    gridMajorEvery: 5,
    /** A level whose lines would be closer than this on screen (CSS px) is not drawn — a hard switch. */
    gridMinPx: 6,
    /** A grid line's width on screen, CSS px. */
    gridLinePx: 1,
    /** Minor line colour, sRGB. */
    gridMinorColor: '#0f1219',
    /** Major line colour, sRGB. */
    gridMajorColor: '#181c26',
    /** Moves and resizes snap to the grid (a held Ctrl / ⌃ inverts it for that drag: chord.js). */
    snap: true,
});

for (const key of Object.keys(WALL_CONFIG)) if (!(key in KNOBS)) throw new Error(`[wall] knob '${key}' has no definition in wallSettings.KNOBS`);
for (const key of Object.keys(KNOBS)) if (!(key in WALL_CONFIG)) throw new Error(`[wall] wallSettings.KNOBS defines '${key}', which WALL_CONFIG lacks`);

/** @typedef {{ -readonly [K in keyof typeof WALL_CONFIG]: (typeof WALL_CONFIG)[K] }} WallConfig */

/**
 * Check one knob's value, coerced from a string when it came from a verb. Throws naming the knob.
 * @param {string} key @param {any} value @returns {any}
 */
export function checkConfig(key, value) {
    if (!(key in WALL_CONFIG)) throw new Error(`unknown wall knob '${key}' (knobs: ${Object.keys(WALL_CONFIG).join(', ')})`);
    return checkKnob(key, KNOBS[key], value);
}
