/**
 * keyEncoding — a browser KeyboardEvent as the key event a terminal daemon encodes: g3d-termd's
 * `key` op (docs/termd/PROTOCOL.md, "`key`"), W3C KeyboardEvent semantics. The keyboard tier of a
 * terminal (app/client/keyboardRouter.js, wall/WallKeys.js) hands it to the grid (`sendKey`).
 *
 * The bytes are termd's to choose, not ours: it encodes each event with libghostty's key encoder
 * against the program's live keyboard modes (Kitty keyboard flags, modifyOtherKeys, application
 * cursor keys), modes this side can't know at the moment it matters. So this maps and never
 * encodes: the physical key (`code`), the logical key (`key`), the modifiers held, the text the
 * key typed, press / repeat / release. Layouts, dead keys and Option-as-character resolve in the
 * browser into `key`, which is the text; a dead key's own keydown (`Dead`) and an IME's (`Process`,
 * isComposing) type nothing yet and map to null.
 *
 * Pure and framework-agnostic: a KeyboardEvent in, a plain object (or null) out.
 */

/**
 * @typedef {Object} TerminalKeyEvent
 * @property {string} code   - KeyboardEvent.code: the physical key ("KeyA", "Enter")
 * @property {string} key    - KeyboardEvent.key: the logical key ("a", "A", "Enter")
 * @property {string[]} mods - the modifiers held, by their W3C names ("Shift", "Control", "Alt",
 *   "Meta", "CapsLock", "NumLock")
 * @property {string} text   - what the key typed ("" for Enter, the arrows, F-keys)
 * @property {'press'|'repeat'|'release'} action
 */

/** The W3C modifier names termd reads, each with the state that says it's held. */
const MODS = [
    ['Shift', (e) => e.shiftKey],
    ['Control', (e) => e.ctrlKey],
    ['Alt', (e) => e.altKey],
    ['Meta', (e) => e.metaKey],
    ['CapsLock', (e) => e.getModifierState?.('CapsLock')],
    ['NumLock', (e) => e.getModifierState?.('NumLock')],
];

/** Keys that are modifiers themselves, or a composition still under way: they type nothing. */
const NOTHING_YET = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock',
    'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock', 'Dead', 'Process', 'Unidentified']);

/**
 * The chords that mean "paste", which a terminal must NOT take as keys.
 *
 *   Cmd+V         — the macOS clipboard chord.
 *   Ctrl+Shift+V  — the terminal-emulator convention everywhere else, and the reason it isn't
 *                   plain Ctrl+V: that one is a real key to the program (\x16, readline's
 *                   quoted-insert) and stays one.
 *
 * Exported because it names a policy, not a detail — a keybindings UI should be able to read
 * and rebind it rather than rediscover the literal.
 */
export function isPasteChord(e) {
    if (e.key !== 'v' && e.key !== 'V') return false;
    if (e.metaKey && !e.ctrlKey && !e.altKey) return true;         // Cmd+V
    return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;     // Ctrl+Shift+V
}

/**
 * A KeyboardEvent (keydown or keyup) as a terminal key event, or null to leave the key alone (the
 * chain then lets a lower tier — Esc-pop, nav, camera — have it).
 *
 * @param {KeyboardEvent} e
 * @param {Object} [opts]
 * @param {boolean} [opts.captureEscape=false] - when true, Escape goes to the terminal so a
 *   captured terminal can drive vim/readline; when false it returns null so the host's Esc-LIFO
 *   releases focus (the soft-focus default). This is the ONE key capture changes.
 * @returns {TerminalKeyEvent|null}
 */
export function keyEventFor(e, { captureEscape = false } = {}) {
    const k = e.key;
    if (!k || NOTHING_YET.has(k) || e.isComposing) return null;

    // A paste chord is no key. Returning null is what makes paste work at all: the responder
    // chain only suppresses an event a tier CLAIMED, so declining here lets the keystroke reach
    // the browser, which then fires the native `paste` event carrying the clipboard (the paste
    // tiers in keyboardRouter.js and WallKeys.js). Claiming it would eat the clipboard.
    if (isPasteChord(e)) return null;
    if (k === 'Escape' && !captureEscape) return null;

    // AltGr (European layouts' third level) is Ctrl+Alt to a Windows browser: ctrlKey and altKey
    // both set, with AltGraph held. They made the character, as Shift makes 'A', so they don't
    // ride: German AltGr+Q is the text '@', not Ctrl+Alt+@ (which termd would make NUL).
    const altGr = !!e.getModifierState?.('AltGraph');
    const mods = MODS.filter(([name, held]) => held(e) && !(altGr && (name === 'Control' || name === 'Alt')))
        .map(([name]) => name);
    // One character (one code point, so an astral emoji counts) is what the key typed; a named
    // key ("Enter", "ArrowLeft") typed nothing. With Ctrl held the browser still names the
    // character ("c" for Ctrl+C), which is what termd wants: the C0 byte is its to make.
    const text = [...k].length === 1 ? k : '';
    const action = e.type === 'keyup' ? 'release' : e.repeat ? 'repeat' : 'press';
    return { code: e.code || '', key: k, mods, text, action };
}
