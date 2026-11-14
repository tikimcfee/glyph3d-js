import { OPTION_AS_ALT } from '@glyph3d/core/services/interaction/keyEncoding.js';
import { parseSizes } from './contextMenu.js';

/**
 * wallSettings — what each wall knob IS: its section, its label, its type and range, and a sentence
 * saying what changing it does on screen. The one schema the `wall.config` verb checks values by
 * (wallConfig.checkConfig) and the settings panel (SettingsPanel.jsx) draws and searches. The values
 * themselves are born in wallConfig.WALL_CONFIG; every knob there has an entry here and every entry a
 * knob (wallConfig checks it as it loads).
 *
 * The type vocabulary is the IDE Settings schema's (app/client/settings.js): `bool`, `number` (min,
 * max, step; `whole` for integers), `color` (a `#rrggbb` sRGB hex) and `enum` (options) — so a knob
 * reads the same in either — plus `text`: a line of words (a list, like menuSizes), checked and
 * tidied by the knob's own `parse`. Unlike the IDE's coerce, a value that doesn't fit is REFUSED, naming the
 * knob, never clamped: ranges are wide, bounding only what would break.
 */

/**
 * @typedef {{ id: string, title: string, subtitle: string }} SettingsSection
 * @typedef {{ section: string, label: string, description: string,
 *             type: 'bool'|'number'|'color'|'enum'|'text',
 *             min?: number, above?: number, max?: number, step?: number, whole?: boolean, unit?: string,
 *             options?: readonly string[], parse?: (s: string) => string }} KnobDef
 *   min: the least value (inclusive); above: a value must exceed it (exclusive); max: the most.
 *   parse (text): the value as it is kept, or a throw saying what's wrong with it.
 */

/** The panel's sections, in order. @type {readonly SettingsSection[]} */
export const SECTIONS = Object.freeze([
    { id: 'canvas', title: 'Canvas', subtitle: 'background · drafting grid · snapping' },
    { id: 'terminals', title: 'Terminals', subtitle: 'closing · title-bar buttons' },
    { id: 'text', title: 'Text', subtitle: 'underline · strikethrough · overline · dim' },
    { id: 'groups', title: 'Groups', subtitle: 'what a new group is born with · backdrop' },
    { id: 'status', title: 'Status', subtitle: 'the termd status window · notices' },
    { id: 'input', title: 'Input', subtitle: 'keyboard' },
    { id: 'menu', title: 'Menu', subtitle: 'the right-click menu' },
]);

/** Every knob's definition, in the panel's order within each section. @type {Readonly<Record<string, KnobDef>>} */
export const KNOBS = Object.freeze({
    background: {
        section: 'canvas', label: 'Background', type: 'color',
        description: 'The canvas colour behind every terminal and group.',
    },
    gridShow: {
        section: 'canvas', label: 'Show grid', type: 'bool',
        description: 'Draw the drafting-paper grid on the canvas. Snapping works with the grid hidden too.',
    },
    gridMinor: {
        section: 'canvas', label: 'Grid spacing', type: 'number', above: 0, step: 1, unit: 'world units',
        description: 'Distance between the fine grid lines — the step moves and resizes snap to.',
    },
    gridMajorEvery: {
        section: 'canvas', label: 'Major line every', type: 'number', min: 1, whole: true, step: 1, unit: 'lines',
        description: 'Every Nth line is a major (brighter) line; 1 makes every line major.',
    },
    gridMinPx: {
        section: 'canvas', label: 'Hide lines closer than', type: 'number', min: 0, step: 1, unit: 'px',
        description: 'Zoomed out, a level of lines packed closer than this on screen is not drawn, and snapping steps to the major lines.',
    },
    gridLinePx: {
        section: 'canvas', label: 'Line width', type: 'number', above: 0, step: 1, unit: 'px',
        description: 'How thick each grid line is on screen.',
    },
    gridMinorColor: {
        section: 'canvas', label: 'Line colour', type: 'color',
        description: 'The colour of the fine grid lines.',
    },
    gridMajorColor: {
        section: 'canvas', label: 'Major line colour', type: 'color',
        description: 'The colour of every major grid line.',
    },
    snap: {
        section: 'canvas', label: 'Snap to grid', type: 'bool',
        description: 'Moving a terminal puts its top-left corner on a grid crossing; resizing lands the dragged edge on or just inside a line. Hold Ctrl (⌃) while dragging to do the opposite.',
    },
    closeHoldMs: {
        section: 'terminals', label: 'Hold to close', type: 'number', min: 0, step: 50, unit: 'ms',
        description: 'How long the close button (or the close chord, X) must be held before the terminal is killed; its ring fills over this time.',
    },
    barButtonsMinPx: {
        section: 'terminals', label: 'Bar buttons from', type: 'number', min: 0, step: 1, unit: 'px',
        description: "A hovered title bar shows its hide and close buttons only when the bar is at least this tall on screen.",
    },
    lineThickness: {
        section: 'text', label: 'Line thickness', type: 'number', above: 0, step: 0.05, unit: "× the font's",
        description: "How thick underlines, strikethroughs and overlines are drawn in every terminal, as a multiple of the font's own underline thickness. A line is never thinner than one pixel.",
    },
    underlineRaise: {
        section: 'text', label: 'Underline raise', type: 'number', min: -1, max: 1, step: 0.005, unit: 'line heights',
        description: 'Lifts every underline from where the font puts it (Cousine draws its own under the descenders, close to the next line): 0.05 is a twentieth of a line up; a negative value lowers it.',
    },
    curlyAmplitude: {
        section: 'text', label: 'Curly underline height', type: 'number', min: 0, step: 0.1, unit: '× thickness',
        description: "How tall the wave of a curly underline — the squiggle under a diagnostic — is, as a multiple of the line's thickness; 0 flattens it to a straight line.",
    },
    dimAlpha: {
        section: 'text', label: 'Dim text opacity', type: 'number', min: 0, max: 1, step: 0.02,
        description: 'How much of its opacity dim (faint) text keeps: 1 draws it like plain text, lower lets the background show through it, 0 hides it.',
    },
    groupLayout: {
        section: 'groups', label: 'New group layout', type: 'enum', options: ['tile', 'freeform'],
        description: "A new group's layout: tile packs its members in columns; freeform leaves each where it is.",
    },
    groupColumns: {
        section: 'groups', label: 'New group columns', type: 'number', min: 0, whole: true, step: 1,
        description: "A new tiled group's columns; 0 picks the square root of its size, rounded up.",
    },
    groupGap: {
        section: 'groups', label: 'Tile gap', type: 'number', min: 0, step: 1, unit: 'world units',
        description: "Space between a new tiled group's members (a title bar's room is added above each row).",
    },
    groupPad: {
        section: 'groups', label: 'Backdrop margin', type: 'number', min: 0, step: 1, unit: 'world units',
        description: "How far a group's backdrop reaches past its members' windows.",
    },
    restartNoticeMs: {
        section: 'status', label: 'Restart notice after', type: 'number', min: 0, step: 50, unit: 'ms',
        description: 'A termd brain restart shows its amber notice only once it has lasted this long; a quick one shows just the chip.',
    },
    errorsShown: {
        section: 'status', label: 'Errors listed', type: 'number', min: 0, whole: true, step: 1,
        description: 'How many recent termd errors the status window lists, newest first.',
    },
    optionAsAlt: {
        section: 'input', label: 'Option as Alt', type: 'enum', options: OPTION_AS_ALT,
        description: "Whether ⌥/Alt is Alt for the terminal: auto sends Option's character when it made one (å), else Alt; true always Alt (Option+A is ESC a); false types characters. Takes the next key.",
    },
    menuHint: {
        section: 'menu', label: 'Second-click hint', type: 'bool',
        description: "Show the quiet line at the foot of the right-click menu saying a second right-click opens the browser's own menu.",
    },
    menuSizes: {
        section: 'menu', label: 'Terminal sizes', type: 'text',
        parse: (s) => { parseSizes(s); return s.trim().split(/\s+/).filter(Boolean).join(' '); },
        description: "The sizes a terminal's right-click menu offers to resize it to, as COLSxROWS separated by spaces (like 80x24 120x36); empty offers none.",
    },
});

const SECTION_IDS = new Set(SECTIONS.map((s) => s.id));
for (const [key, def] of Object.entries(KNOBS)) {
    if (!SECTION_IDS.has(def.section)) throw new Error(`[wall] knob '${key}' names section '${def.section}', which SECTIONS lacks`);
}

const HEX = /^#[0-9a-f]{6}$/i;
const ON = new Set(['true', 'on', '1', 'yes']);
const OFF = new Set(['false', 'off', '0', 'no']);

/**
 * Check one value against its knob's definition, coerced from a string when it came from a verb.
 * Throws naming the knob.
 * @param {string} key @param {KnobDef} def @param {any} value @returns {any}
 */
export function checkKnob(key, def, value) {
    if (def.type === 'bool') {
        if (typeof value === 'boolean') return value;
        const s = String(value).toLowerCase();
        if (ON.has(s)) return true;
        if (OFF.has(s)) return false;
        throw new Error(`${key} is on or off, not '${value}'`);
    }
    if (def.type === 'color') {
        const s = String(value).trim();
        if (!HEX.test(s)) throw new Error(`${key} takes a colour as #rrggbb, not '${value}'`);
        return s.toLowerCase();
    }
    if (def.type === 'text') {
        const s = String(value);
        try { return def.parse ? def.parse(s) : s.trim(); } catch (e) { throw new Error(`${key}: ${e.message}`); }
    }
    if (def.type === 'enum') {
        const s = String(value);
        if (!def.options.includes(s)) throw new Error(`${key} is ${def.options.join(', ')}, not '${value}'`);
        return s;
    }
    const n = typeof value === 'number' ? value : Number(String(value).trim() || NaN);
    if (!Number.isFinite(n)) throw new Error(`${key} takes a number, not '${value}'`);
    if (def.min != null && n < def.min) throw new Error(`${key} takes a number ≥ ${def.min}, not '${value}'`);
    if (def.above != null && !(n > def.above)) throw new Error(`${key} takes a number > ${def.above}, not '${value}'`);
    if (def.max != null && n > def.max) throw new Error(`${key} takes a number ≤ ${def.max}, not '${value}'`);
    if (def.whole && !Number.isInteger(n)) throw new Error(`${key} takes a whole number, not '${value}'`);
    return n;
}

// ── search ───────────────────────────────────────────────────────────────────

/** @typedef {[number, number][]} Hits - [start, end) character ranges, sorted, not overlapping */

/**
 * Where any of `terms` (lower-case) occur in `text`, merged.
 * @param {string} text @param {string[]} terms @returns {Hits}
 */
export function hitsIn(text, terms) {
    const low = text.toLowerCase(), raw = [];
    for (const t of terms) {
        for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + 1)) raw.push([i, i + t.length]);
    }
    raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    /** @type {Hits} */
    const out = [];
    for (const r of raw) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
    }
    return out;
}

/**
 * @typedef {{ key: string, def: KnobDef, hits: { label: Hits, key: Hits, description: Hits } }} SettingsItem
 * @typedef {{ section: SettingsSection, title: Hits, items: SettingsItem[] }} SettingsGroup
 */

/**
 * Filter the knobs by a query: its words (any case) must each occur in the knob's label, its key, its
 * description or its section's title. Returns the sections with a match, in order, each with its
 * matching knobs in order and where every word hit (for highlighting); a section with none is left
 * out. An empty query keeps everything, with no hits.
 * @param {string} query
 * @param {{ sections?: readonly SettingsSection[], knobs?: Readonly<Record<string, KnobDef>> }} [schema]
 * @returns {SettingsGroup[]}
 */
export function searchSettings(query, { sections = SECTIONS, knobs = KNOBS } = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const section of sections) {
        const title = section.title.toLowerCase();
        const items = [];
        for (const [key, def] of Object.entries(knobs)) {
            if (def.section !== section.id) continue;
            const hay = [def.label.toLowerCase(), key.toLowerCase(), def.description.toLowerCase(), title];
            if (!terms.every((t) => hay.some((h) => h.includes(t)))) continue;
            items.push({ key, def, hits: { label: hitsIn(def.label, terms), key: hitsIn(key, terms), description: hitsIn(def.description, terms) } });
        }
        if (items.length) out.push({ section, title: hitsIn(section.title, terms), items });
    }
    return out;
}
