// wall-keys.test.mjs — the wall's keyboard on a stand-in wall: keys go to the focused terminal as
// key events carrying the optionAsAlt knob, read as each key is sent, so `wall.config optionAsAlt
// false` takes the next key with no reload; the knob is checked as wall.config's. The copy chord
// (Ctrl+Shift+C off macOS) copies the focused terminal's selection only when it has one — with none it
// reaches the program as a key, and Ctrl+C always does; a typed key drops the selection while
// selectionClearOnTyping is on.
// Run: bun test tools/wall-keys.test.mjs
import { test, expect } from 'bun:test';
import WallKeys from '../wall/WallKeys.js';
import { WALL_CONFIG, checkConfig } from '../wall/wallConfig.js';

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

/** A keydown off macOS. */
const down = (key, code, mods = {}) => ({
    type: 'keydown', key, code, repeat: false, isComposing: false, target: null,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods,
    getModifierState: () => false, preventDefault() { this.prevented = true; }, stopPropagation() {},
});

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
    // Nothing selected: Ctrl+Shift+C reaches the program as a key.
    keys._key(down('C', 'KeyC', { ctrlKey: true, shiftKey: true }));
    expect(ran).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ code: 'KeyC', mods: ['Shift', 'Control'] });
    // A selection: the chord copies it and the program hears nothing.
    grid.hasSelection = true;
    const n = sent.length;
    const chord = down('C', 'KeyC', { ctrlKey: true, shiftKey: true });
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
