// wall-keymap.test.mjs — the wall's chords as one table (wall/wallKeymap.js): no two chords can both
// answer one key (Shift and the mode — fullscreen or canvas — are matched as each entry says: held,
// not held, or either), WallKeys dispatches from the table on a stand-in wall in the wall's mode (a chord with a run claims the key and runs; K, the palette's, is left
// alone), and the help (HelpPanel.helpSections) lists every chord and every verb the router holds,
// its search keeping only rows with every word. Run: bun test tools/wall-keymap.test.mjs
import { test, expect } from 'bun:test';
import { KEYMAP, chordFor, HELP_SECTIONS, PLAIN_KEYS, gestures, chordText } from '../wall/wallKeymap.js';
import { helpSections, searchHelp } from '../wall/HelpPanel.jsx';
import { CHORD_KEYS } from '../wall/chord.js';
import { WALL_CONFIG } from '../wall/wallConfig.js';
import WallKeys from '../wall/WallKeys.js';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';

/** A keydown carrying the platform's chord (+ Shift if asked). */
function chordKey(code, { shift = false } = {}) {
    const ev = {
        type: 'keydown', key: '', code, repeat: false, isComposing: false, target: null, shiftKey: shift,
        ctrlKey: CHORD_KEYS.includes('Control'), altKey: CHORD_KEYS.includes('Alt'), metaKey: CHORD_KEYS.includes('Meta'),
        getModifierState: () => false, claimed: false,
        preventDefault() { ev.claimed = true; }, stopPropagation() {},
    };
    return ev;
}

/** Whether two entries could both answer one key event: the same key, Shift and mode not told apart. */
const overlap = (a, b) => a.code === b.code
    && (a.shift === undefined || b.shift === undefined || a.shift === b.shift)
    && (a.mode === undefined || b.mode === undefined || a.mode === b.mode);

test('no two chords can both answer one key', () => {
    KEYMAP.forEach((a, i) => KEYMAP.forEach((b, j) => { if (i < j) expect({ a: a.does, overlaps: overlap(a, b) }).toEqual({ a: a.does, overlaps: false }); }));
    for (const c of KEYMAP) expect(HELP_SECTIONS.map((s) => s.id)).toContain(c.section);
});

test('chordFor matches Shift and the mode as each entry says', () => {
    const at = (code, mode, shiftKey = false) => chordFor({ code, shiftKey }, mode);
    expect(at('Enter', 'canvas').does).toMatch(/fullscreen/);
    expect(at('Enter', 'fullscreen')).toBe(at('Enter', 'canvas'));
    expect(at('Enter', 'canvas', true).does).toMatch(/new terminal/);
    expect(at('BracketRight', 'canvas', true)).toBe(at('BracketRight', 'canvas'));
    expect(at('Minus', 'canvas').does).toMatch(/hide/);
    expect(at('Minus', 'fullscreen').does).toMatch(/smaller text/);
    expect(at('Digit0', 'canvas').does).toMatch(/fit every/);
    expect(at('Digit0', 'fullscreen').does).toMatch(/back to the size/);
    expect(at('Equal', 'canvas')).toBe(null);
    expect(at('KeyQ', 'canvas')).toBe(null);
});

test('WallKeys dispatches from the table: a chord runs and claims its key; the palette\'s K is left alone', () => {
    const ran = [];
    const wall = {
        focusedId: null, menu: null, config: { ...WALL_CONFIG }, selection: new Set(), terminal: () => null,
        fullscreen: { id: null }, cycleFocus: (d) => ran.push(['cycle', d]), fitAll: () => ran.push(['fit']), spawn: () => ran.push(['spawn']),
        run: (cmd) => ran.push(cmd),
    };
    const keys = new WallKeys(/** @type {any} */ (wall));
    const next = chordKey('BracketRight');
    keys._key(next);
    keys._key(chordKey('Enter', { shift: true }));
    keys._key(chordKey('Slash'));
    keys._key(chordKey('Enter'));   // nothing focused, nothing fullscreen: fit them all
    keys._key(chordKey('Minus'));   // the canvas's: hide — nothing focused, so nothing
    wall.fullscreen.id = 't1';
    keys._key(chordKey('Minus'));   // fullscreen's: smaller text
    keys._key(chordKey('Enter'));   // leave
    const k = chordKey('KeyK');
    keys._key(k);
    expect(ran).toEqual([['cycle', 1], ['spawn'], ['wall.help', 'toggle'], ['fit'],
        ['wall.fullscreen.text', 'smaller'], ['wall.fullscreen', 'toggle']]);
    expect(next.claimed).toBe(true);
    expect(k.claimed).toBe(false);
});

test('the help lists every chord, plain key, gesture and verb; its search keeps rows with every word', () => {
    const router = new CommandRouter({});
    router.register('wall.hide', () => 'OK', { description: 'Take terminals off the canvas', usage: '<id…>' });
    const wall = { router, config: { ...WALL_CONFIG } };
    const sections = helpSections(wall);
    const rows = sections.flatMap((s) => s.rows.map((r) => `${r.how} | ${r.does}`));
    for (const c of KEYMAP) expect(rows).toContain(`${chordText(c)} | ${c.does}`);
    for (const k of PLAIN_KEYS) expect(rows).toContain(`${k.key} | ${k.does}`);
    for (const g of gestures(wall.config)) expect(rows).toContain(`${g.how} | ${g.does}`);
    const verbs = sections.find((s) => s.id === 'verbs').rows.map((r) => r.how);
    expect(verbs).toEqual(['call <base64-json>', 'help [namespace|verb]', 'wall.hide <id…>']);
    const found = searchHelp(sections, 'hide terminal');
    expect(found.flatMap((s) => s.rows.map((r) => r.how))).toContain('wall.hide <id…>');
    expect(found.every((s) => s.rows.every((r) => `${r.how} ${r.does} ${s.title}`.toLowerCase().includes('hide')))).toBe(true);
    expect(searchHelp(sections, 'zzqq')).toEqual([]);
});
