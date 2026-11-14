// wall-keys.test.mjs — the wall's keyboard on a stand-in wall: keys go to the focused terminal as
// key events carrying the optionAsAlt knob, read as each key is sent, so `wall.config optionAsAlt
// false` takes the next key with no reload; the knob is checked as wall.config's.
// Run: bun test tools/wall-keys.test.mjs
import { test, expect } from 'bun:test';
import WallKeys from '../wall/WallKeys.js';
import { WALL_CONFIG, checkConfig } from '../wall/wallConfig.js';

/** A wall with one focused terminal whose sent keys land in `sent`. */
function standIn() {
    const sent = [];
    const grid = { sendKey: (k) => (sent.push(k), true) };
    const wall = { focusedId: 't1', config: { ...WALL_CONFIG }, selection: new Set(), terminal: (id) => (id === 't1' ? grid : null) };
    return { wall, sent, keys: new WallKeys(/** @type {any} */ (wall)) };
}

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
