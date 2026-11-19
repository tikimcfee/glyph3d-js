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
    expect(at('Enter', 'canvas').does).toMatch(/fullscreen the focused group/);
    expect(at('Enter', 'fullscreen')).toBe(at('Enter', 'canvas'));
    expect(at('Enter', 'canvas', true).does).toMatch(/focused pane alone/);
    expect(at('Enter', 'fullscreen', true)).toBe(at('Enter', 'canvas', true));
    expect(at('Backslash', 'canvas', false).does).toMatch(/new terminal/);
    expect(at('BracketRight', 'canvas', false).does).toMatch(/next pane/);
    expect(at('BracketRight', 'canvas', true)).toBe(null);
    expect(at('BracketLeft', 'canvas', false).does).toMatch(/previous pane/);
    expect(at('BracketLeft', 'canvas', true)).toBe(null);
    expect(at('ArrowLeft', 'canvas').does).toMatch(/focus the pane/);
    expect(at('ArrowLeft', 'canvas', true).does).toMatch(/move the focused pane/);
    expect(at('ArrowDown', 'fullscreen', true)).toBe(at('ArrowDown', 'canvas', true));
    expect(at('Minus', 'canvas').does).toMatch(/hide/);
    expect(at('Minus', 'fullscreen').does).toMatch(/smaller text/);
    expect(at('Digit0', 'canvas').does).toMatch(/fit every/);
    expect(at('Digit0', 'fullscreen').does).toMatch(/back to the size/);
    expect(at('Equal', 'canvas')).toBe(null);
    expect(at('KeyQ', 'canvas')).toBe(null);
});

test('WallKeys dispatches from the table: pane bracket chords and Ctrl+Shift+[ / ] claim the key; ⌘⇧[ / ] is left to the browser; Ctrl+,/. steps focus history; K is left alone', () => {
    const ran = [];
    const wall = {
        focusedId: null, menu: null, config: { ...WALL_CONFIG }, selection: new Set(), terminal: () => null,
        fullscreen: { id: null },
        cycleFocus: (d) => ran.push(['cycle', d]),
        cycleGroupFocus: (d) => ran.push(['cycleGroup', d]),
        stepFocusHistory: (d) => ran.push(['history', d]),
        fitAll: () => ran.push(['fit']), spawn: () => ran.push(['spawn']),
        run: (cmd) => ran.push(cmd),
    };
    const keys = new WallKeys(/** @type {any} */ (wall));
    const next = chordKey('BracketRight');
    const prevPane = chordKey('BracketLeft');
    const browserTabNext = chordKey('BracketRight', { shift: true });
    const browserTabPrev = chordKey('BracketLeft', { shift: true });
    keys._key(next);
    keys._key(prevPane);
    keys._key(browserTabNext);
    keys._key(browserTabPrev);
    // Ctrl+, / Ctrl+. (and Ctrl+< / Ctrl+> with Shift) step focus history and preventDefault, never touching ⌘, settings.
    const ctrlKey = (code, shiftKey = false) => {
        const ev = {
            type: 'keydown', key: '', code, repeat: false, isComposing: false, target: null, shiftKey,
            ctrlKey: true, altKey: false, metaKey: false, getModifierState: () => false, claimed: false,
            preventDefault() { ev.claimed = true; }, stopPropagation() {},
        };
        return ev;
    };
    const back = ctrlKey('Comma');
    const fwd = ctrlKey('Period', true);   // Ctrl+> works identically
    const ctrlPrevGroup = ctrlKey('BracketLeft', true);    // Ctrl+Shift+[ group cycling
    const ctrlNextGroup = ctrlKey('BracketRight', true);   // Ctrl+Shift+] group cycling
    keys._key(back);
    keys._key(fwd);
    keys._key(ctrlPrevGroup);
    keys._key(ctrlNextGroup);
    keys._key(chordKey('Comma'));          // platform chord + Comma still toggles settings
    keys._key(chordKey('Backslash'));      // ⌘\ opens a new terminal
    keys._key(chordKey('Slash'));
    keys._key(chordKey('Enter'));          // nothing focused, nothing fullscreen: fit them all
    keys._key(chordKey('Minus'));          // the canvas's: hide — nothing focused, so nothing
    wall.fullscreen.id = 't1';
    keys._key(chordKey('Enter', { shift: true }));   // ⌘⇧↵ toggles single-pane fullscreen
    keys._key(chordKey('Minus'));          // fullscreen's: smaller text
    keys._key(chordKey('Enter'));          // leave
    const k = chordKey('KeyK');
    keys._key(k);
    expect(ran).toEqual([
        ['cycle', 1], ['cycle', -1],
        ['history', -1], ['history', 1], ['cycleGroup', -1], ['cycleGroup', 1],
        ['wall.settings', 'toggle'],
        ['spawn'], ['wall.help', 'toggle'], ['fit'],
        ['wall.fullscreen.pane', 'toggle'], ['wall.fullscreen.text', 'smaller'], ['wall.fullscreen', 'toggle'],
    ]);
    expect(next.claimed).toBe(true);
    expect(prevPane.claimed).toBe(true);
    expect(browserTabNext.claimed).toBe(false);
    expect(browserTabPrev.claimed).toBe(false);
    expect(back.claimed).toBe(true);
    expect(fwd.claimed).toBe(true);
    expect(ctrlPrevGroup.claimed).toBe(true);
    expect(ctrlNextGroup.claimed).toBe(true);
    expect(k.claimed).toBe(false);

    // Keypress, keyup and a focused panel search <input> claim ⌘] and Ctrl+Shift+[ with stopImmediatePropagation.
    const makePhase = (type, target = null) => {
        const ev = chordKey('BracketRight');
        ev.type = type;
        ev.target = target;
        ev.immediate = false;
        ev.stopImmediatePropagation = () => { ev.immediate = true; };
        return ev;
    };
    const kp = makePhase('keypress');
    const ku = makePhase('keyup');
    let blurred = false;
    const panelInput = { tagName: 'INPUT', closest: () => ({}), blur() { blurred = true; } };
    const kdInPanel = makePhase('keydown', panelInput);
    const ctrlInPanel = ctrlKey('BracketLeft', true);
    ctrlInPanel.target = panelInput;
    ctrlInPanel.immediate = false;
    ctrlInPanel.stopImmediatePropagation = () => { ctrlInPanel.immediate = true; };
    keys._keyPress(kp);
    keys._keyUp(ku);
    keys._key(kdInPanel);
    expect([kp.claimed, kp.immediate, ku.claimed, ku.immediate, kdInPanel.claimed, kdInPanel.immediate, blurred])
        .toEqual([true, true, true, true, true, true, true]);
    expect(ran.at(-1)).toEqual(['cycle', 1]);
    blurred = false;
    keys._key(ctrlInPanel);
    expect([ctrlInPanel.claimed, ctrlInPanel.immediate, blurred]).toEqual([true, true, true]);
    expect(ran.at(-1)).toEqual(['cycleGroup', -1]);
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
