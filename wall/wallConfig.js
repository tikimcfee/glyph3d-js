import { GLYPH_LINE_DEFAULTS } from '@glyph3d/core/core/glyphMaterial.js';
import { BOLD_IS_BRIGHT_DEFAULT } from '@glyph3d/core/collections/TerminalEmulator.js';
import { TERMINAL_SELECTION_DEFAULTS } from '@glyph3d/core/collections/terminalSelection.js';
import { KNOBS, checkKnob } from './wallSettings.js';

/**
 * wallConfig — the wall's knobs for hiding, closing, selecting (terminals, and text in them) and grouping, the termd status
 * window's, the keyboard's, the right-click menu's, the canvas's (its colour, the drafting grid,
 * snapping) and the text's (the font family, bold's colour, the cell's own lines, dim), born configurable: `new TerminalWall({ …, config })` overrides any of them, and `wall.config <key>
 * <value>` dials one live and remembers it per relay (WallStore; `wall.config <key> default` hands it
 * back). A group's own columns and gap live on the group; these are what a new group is born with.
 * What each knob is — its type, range, section and description — is wallSettings.KNOBS.
 */
export const WALL_CONFIG = Object.freeze({
    /** How long the close button (or the close chord, X) must be held before the terminal is killed, ms. */
    closeHoldMs: 650,
    /** A title bar's button cluster shows only when the bar is at least this tall on screen, CSS px. */
    barButtonsMinPx: 14,

    // ── agent view (WallAgentViews.js, AgentViewOverlay.jsx) ──
    /** Default side of a terminal a newly opened Agent View attaches to ('right'|'left'|'top'|'bottom'). */
    agentViewSide: 'right',
    /** World width of an Agent View on the left or right side of a terminal. */
    agentViewWidth: 76,
    /** World height of an Agent View on the top or bottom side of a terminal. */
    agentViewHeight: 44,
    /** World gap between a terminal and its attached Agent View. */
    agentViewGap: 1.5,
    /** A new group's layout: 'tile' (members packed in columns), 'freeform' (members keep their spots) or 'split' (one rect cut into panes). */
    groupLayout: 'tile',
    /** A new tiled group's columns; 0 = the square root of its size, rounded up. */
    groupColumns: 0,
    /** World units between tiled members (a title bar's room is added above each row on top of it). */
    groupGap: 2,
    /** World units the group's backdrop reaches past its members' windows. */
    groupPad: 3,
    /** World units between a split's panes (WallGroups, splitTree.js). */
    splitGap: 0.5,
    /** The room above each split pane for its title bar, in the terminal's rows (the bar is capped to it). */
    splitBarRows: 1.25,
    /** Whether a new split's panes show title bars (`wall.group.bars` turns one split's on or off). */
    splitBars: true,
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
    /** Log every wheel, key and pointer press the page receives as an `[input]` line (inputTrace.js), into the relay's log store. */
    traceInput: false,
    /**
     * The modifiers that make a wheel zoom instead of pan (chord.js zoomsWheel), any of ctrl alt meta
     * shift. Ctrl is how a trackpad pinch arrives; alt (Option) and meta (⌘) reach the wall from a Mac
     * through a remote desktop when macOS's screen zoom takes Ctrl+scroll.
     */
    zoomKeys: 'ctrl alt meta',

    // ── fullscreen (WallFullscreen.js) ──
    /** A terminal going fullscreen keeps its canvas text size, but at least this many CSS px a row (from far out). */
    fullscreenMinLinePx: 14,
    /** Room kept inside the canvas edge round a fullscreen terminal, CSS px. */
    fullscreenPad: 6,
    /** The factor one bigger / smaller text key changes a fullscreen terminal's text size by. */
    fullscreenTextStep: 1.1,

    // ── selecting text in a terminal: the drag, a word, a line; copy and paste (WallPointer, TerminalGrid) ──
    /** A selected cell's fill, sRGB. Ghostty's default: the terminal's own text colour (its colours inverted). */
    selectionColor: TERMINAL_SELECTION_DEFAULTS.background,
    /** A selected cell's text colour, sRGB — or 'keep': each keeps its own. Ghostty's default: the terminal's background. */
    selectionForeground: TERMINAL_SELECTION_DEFAULTS.foreground,
    /** What ends a word for a double-click, besides whitespace (Ghostty's `selection-word-chars`). */
    selectionWordChars: TERMINAL_SELECTION_DEFAULTS.wordChars,
    /**
     * What a finished selection is copied to (Ghostty's `copy-on-select`, its values and its default):
     * 'true' — the wall's selection clipboard, which a middle-click pastes (the browser can't reach the
     * system's primary selection); 'clipboard' — that and the system clipboard; 'false' — neither.
     */
    copyOnSelect: 'true',
    /** Presses closer together than this (ms, and a few px) count as a double or triple click (Ghostty's `click-repeat-interval`, 500 off macOS). */
    clickRepeatMs: 500,
    /** A key typed into a terminal drops its selection (Ghostty's `selection-clear-on-typing`). */
    selectionClearOnTyping: true,
    /** How long a wall notice (a refused copy or paste) stays up, ms. */
    noticeMs: 5000,

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

    // ── the right-click menu (contextMenu.js) ──
    /** Whether the right-click menu's footer says a second right-click gives the browser's own menu. */
    menuHint: true,
    /** The sizes a terminal's right-click menu offers, as COLSxROWS, space-separated ('' offers none). */
    menuSizes: '80x24 120x36 160x48',

    // ── text: the font family and what bold does (live on every terminal) ──
    /**
     * The font family every terminal draws in — an id of the font chain (core fonts/families.js),
     * with its regular, bold, italic and bold-italic faces. Live: each terminal takes the family's
     * cell (its size on the canvas changes; cols × rows stay) and rewrites its glyphs. Monaspace
     * Neon by default: sturdier strokes and opener letterforms than Cousine's hold up at the small
     * sizes a wall of terminals is read at, and it carries its own arrows, checks and icons.
     */
    fontFamily: 'monaspace-neon',
    /**
     * Bold text in one of the eight standard colours (SGR 30–37) draws in its bright twin (90–97).
     * Off, as Ghostty's bold-is-bright is: bold is the bold face, in the colour the program named.
     */
    boldIsBright: BOLD_IS_BRIGHT_DEFAULT,

    // ── text: the lines a cell draws itself, and dim (core/glyphMaterial.js GLYPH_LINE_DEFAULTS; live on every terminal) ──
    /** The thickness of underline, strikethrough and overline, × the font's own underline thickness. */
    lineThickness: GLYPH_LINE_DEFAULTS.lineThickness,
    /** Lifts the underline from where the font puts it, in line heights (0.05 = a twentieth of a line up; negative lowers it). */
    underlineRaise: GLYPH_LINE_DEFAULTS.underlineRaise,
    /** The curly underline's wave height, × the line's thickness. */
    curlyAmplitude: GLYPH_LINE_DEFAULTS.curlyAmplitude,
    /** How much of its opacity dim (SGR 2) text keeps, 0..1. */
    dimAlpha: GLYPH_LINE_DEFAULTS.dimAlpha,
});

/** The knobs that are the glyph shader's line style (TerminalWall hands them to setGlyphLineStyle). */
export const LINE_STYLE_KNOBS = Object.freeze(Object.keys(GLYPH_LINE_DEFAULTS));

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
