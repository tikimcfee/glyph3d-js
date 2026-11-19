// wall-keys.test.mjs — the wall's keyboard on a stand-in wall: keys go to the focused terminal as
// key events carrying the optionAsAlt knob, read as each key is sent, so `wall.config optionAsAlt
// false` takes the next key with no reload; the knob is checked as wall.config's. The copy chord
// (the platform's: ⌘C on macOS, Ctrl+Shift+C elsewhere — the test presses the one its host has, as
// chord.js decides) copies the focused terminal's selection only when it has one — with none it
// reaches the program as a key off macOS and stays the browser's on macOS, and Ctrl+C always reaches
// the program; a typed key drops the selection while selectionClearOnTyping is on.
// Run: bun test tools/wall-keys.test.mjs
import { test, expect } from 'bun:test';
import WallKeys from '../wall/WallKeys.js';
import { WALL_CONFIG, checkConfig } from '../wall/wallConfig.js';
import { IS_MAC } from '../wall/chord.js';

/** A wall with one focused terminal whose sent keys land in `sent`. */
function standIn() {
    const sent = [], ran = [];
    const grid = { sendKey: (k) => (sent.push(k), true), hasSelection: false, clearSelection() { grid.hasSelection = false; } };
    const wall = {
        focusedId: 't1', config: { ...WALL_CONFIG }, selection: new Set(), terminal: (id) => (id === 't1' ? grid : null),
        run: (cmd) => ran.push(cmd),
    };
    return { wall, grid, sent, ran, keys: new WallKeys(/** @type {any} */ (wall)) };
}

/** A keydown: `key` and `code` with the modifiers named. */
const down = (key, code, mods = {}) => ({
    type: 'keydown', key, code, repeat: false, isComposing: false, target: null,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods,
    getModifierState: () => false, preventDefault() { this.prevented = true; }, stopPropagation() {},
});

/** The platform's copy chord: ⌘C on macOS, Ctrl+Shift+C elsewhere (chord.isCopyChord). */
const copyChord = () => (IS_MAC ? down('c', 'KeyC', { metaKey: true }) : down('C', 'KeyC', { ctrlKey: true, shiftKey: true }));

/** A Mac browser's Option+A keydown (or keyup): the character Option typed, Alt held. */
const optionA = (type = 'keydown') => ({
    type, key: 'å', code: 'KeyA', repeat: false, isComposing: false, target: null,
    ctrlKey: false, shiftKey: false, altKey: true, metaKey: false,
    getModifierState: () => false, preventDefault() {}, stopPropagation() {},
});

test('optionAsAlt is born auto and checked as a wall knob', () => {
    expect(WALL_CONFIG.optionAsAlt).toBe('auto');
    for (const v of ['auto', 'true', 'false']) expect(checkConfig('optionAsAlt', v)).toBe(v);
    expect(() => checkConfig('optionAsAlt', 'left')).toThrow(/optionAsAlt is auto, true, false/);
});

test('every key carries the knob as it is when sent: a change takes the next key', () => {
    const { wall, sent, keys } = standIn();
    keys._key(optionA());
    keys._keyUp(optionA('keyup'));
    expect(sent.map((k) => [k.action, k.option_as_alt])).toEqual([['press', 'auto'], ['release', 'auto']]);
    wall.config.optionAsAlt = checkConfig('optionAsAlt', 'false');
    keys._key(optionA());
    expect(sent.at(-1)).toMatchObject({ code: 'KeyA', text: 'å', mods: ['Alt'], option_as_alt: false });
    wall.config.optionAsAlt = 'true';
    keys._keyUp(optionA('keyup'));
    expect(sent.at(-1)).toMatchObject({ action: 'release', option_as_alt: true });
});

test('the copy chord copies a selection; with none it is the program\'s key, and Ctrl+C always is', () => {
    const { grid, sent, ran, keys } = standIn();
    // Nothing selected: nothing is copied. Off macOS Ctrl+Shift+C reaches the program as a key; on
    // macOS ⌘C is left to the browser (WallKeys: ⌘ keys the keymap doesn't hold stay its own).
    const bare = copyChord();
    keys._key(bare);
    expect(ran).toEqual([]);
    if (IS_MAC) { expect(sent).toEqual([]); expect(bare.prevented).toBeUndefined(); }
    else expect(sent.at(-1)).toMatchObject({ code: 'KeyC', mods: ['Shift', 'Control'] });
    // A selection: the chord copies it and the program hears nothing.
    grid.hasSelection = true;
    const n = sent.length;
    const chord = copyChord();
    keys._key(chord);
    expect(ran).toEqual([['wall.copy', 't1']]);
    expect(sent.length).toBe(n);
    expect(chord.prevented).toBe(true);
    expect(grid.hasSelection).toBe(true);          // copying keeps the selection
    // Ctrl+C is SIGINT's: the program's, selection or not — and typing drops the selection.
    keys._key(down('c', 'KeyC', { ctrlKey: true }));
    expect(sent.at(-1)).toMatchObject({ code: 'KeyC', key: 'c', mods: ['Control'] });
    expect(ran.length).toBe(1);
    expect(grid.hasSelection).toBe(false);
});

test('selectionClearOnTyping off: a typed key leaves the selection', () => {
    const { wall, grid, keys } = standIn();
    wall.config.selectionClearOnTyping = false;
    grid.hasSelection = true;
    keys._key(down('a', 'KeyA'));
    expect(grid.hasSelection).toBe(true);
    keys._key(down('Shift', 'ShiftLeft', { shiftKey: true }));   // a modifier alone types nothing either way
    wall.config.selectionClearOnTyping = true;
    keys._key(down('Shift', 'ShiftLeft', { shiftKey: true }));
    expect(grid.hasSelection).toBe(true);
    keys._key(down('a', 'KeyA'));
    expect(grid.hasSelection).toBe(false);
});

test('unshifted Ctrl+[ (ESC) and Ctrl+] still reach the focused terminal while Ctrl+Shift+[ / ] cycles groups', () => {
    const { wall, sent, keys } = standIn();
    const groups = [];
    wall.cycleGroupFocus = (d) => groups.push(d);
    keys._key(down('[', 'BracketLeft', { ctrlKey: true }));
    keys._key(down(']', 'BracketRight', { ctrlKey: true }));
    expect(groups).toEqual([]);
    expect(sent.map((k) => [k.code, k.mods])).toEqual([
        ['BracketLeft', ['Control']],
        ['BracketRight', ['Control']],
    ]);
    keys._key(down('{', 'BracketLeft', { ctrlKey: true, shiftKey: true }));
    keys._key(down('}', 'BracketRight', { ctrlKey: true, shiftKey: true }));
    expect(groups).toEqual([-1, 1]);
    expect(sent.length).toBe(2);   // Ctrl+Shift+[ / ] never leak into the terminal
});
