// terminal-input.test.mjs — headless behavior lock for what a terminal grid sends: key events,
// pastes and raw bytes, each as its own push to the owning adapter (termd encodes the first two in
// the program's live modes; docs/termd/PROTOCOL.md "`key`", "`paste`").
//
//   bun tools/terminal-input.test.mjs
//
// Three things hold here, and each was a real bug or the reason this exists:
//
//   1. keyEventFor DECLINES the paste chord. The responder chain suppresses any event a tier
//      claimed, so taking Cmd+V as a key both eats the clipboard (no native `paste` fires) and
//      types a literal 'v'. Declining is what lets the browser event happen at all.
//   2. keyEventFor maps, never encodes: Shift+Enter stays Shift+Enter (the browser wall used to
//      send \r, so a Kitty-keyboard program never saw the Shift), and a dead key or an IME's
//      keystroke types nothing until the browser resolves it.
//   3. The grid stamps its own id on every input and hands it on whole, its kind named
//      ({key} / {paste} / {bytes}); the relay push for each is terminal-readopt.test.mjs's.
//
// Pure functions of their input, so this runs with no DOM and no GPU.

import { keyEventFor, isPasteChord } from '../packages/glyph3d-core/src/services/interaction/keyEncoding.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A KeyboardEvent stand-in: the fields keyEventFor reads. */
const ev = (key, code, mods = {}, extra = {}) => ({
    type: 'keydown', key, code, repeat: false, isComposing: false,
    ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
    getModifierState: (m) => (m === 'CapsLock' ? !!mods.caps : m === 'AltGraph' ? !!mods.altGr : false),
    ...extra,
});

// ── 1. the paste chord is declined, and ONLY the chord ──
{
    ok(keyEventFor(ev('v', 'KeyV', { meta: true })) === null, 'Cmd+V is no key');
    ok(keyEventFor(ev('V', 'KeyV', { ctrl: true, shift: true })) === null, 'Ctrl+Shift+V is no key');
    // Plain Ctrl+V stays a real key — readline's quoted-insert. Breaking it to "fix paste" would be
    // a silent regression for anyone using C-v C-j to insert a newline.
    ok(same(keyEventFor(ev('v', 'KeyV', { ctrl: true })), { code: 'KeyV', key: 'v', mods: ['Control'], text: 'v', action: 'press' }),
        'plain Ctrl+V is the key Ctrl+V (termd makes it \\x16)');
    ok(isPasteChord(ev('v', 'KeyV', { ctrl: true })) === false, 'Ctrl+V is not a paste chord');
    ok(keyEventFor(ev('c', 'KeyC', { meta: true }))?.text === 'c', 'Cmd+C is not swept up by the chord test');
}

// ── 2. keys map to W3C key events, never to bytes ──
{
    ok(same(keyEventFor(ev('Enter', 'Enter', { shift: true })), { code: 'Enter', key: 'Enter', mods: ['Shift'], text: '', action: 'press' }),
        'Shift+Enter is Shift+Enter (no \\r: termd encodes it for the program)');
    ok(same(keyEventFor(ev('A', 'KeyA', { shift: true })), { code: 'KeyA', key: 'A', mods: ['Shift'], text: 'A', action: 'press' }), 'Shift+A types A');
    ok(keyEventFor(ev('a', 'KeyA', { caps: true }))?.mods.includes('CapsLock'), 'Caps Lock is reported as held');
    ok(keyEventFor(ev('ArrowLeft', 'ArrowLeft', { alt: true }))?.text === '', 'a named key types no text');
    ok(keyEventFor(ev('é', 'KeyE'))?.text === 'é', "a dead key's result types the composed character");
    ok(keyEventFor(ev('😀', ''))?.text === '😀', 'an astral character is one character of text');
    ok(keyEventFor(ev('Dead', 'BracketLeft')) === null, "a dead key's own keydown types nothing yet");
    ok(keyEventFor(ev('Process', 'KeyA', {}, { isComposing: true })) === null, "an IME's keystroke types nothing yet");
    ok(keyEventFor(ev('Shift', 'ShiftLeft', { shift: true })) === null, 'a bare modifier is no key');
    ok(keyEventFor(ev('Escape', 'Escape')) === null, 'Esc is the host\'s unless captured');
    ok(keyEventFor(ev('Escape', 'Escape'), { captureEscape: true })?.code === 'Escape', 'captured, Esc goes to the terminal');
    ok(keyEventFor(ev('a', 'KeyA', {}, { repeat: true }))?.action === 'repeat', 'a held key repeats');
    ok(keyEventFor(ev('a', 'KeyA', {}, { type: 'keyup' }))?.action === 'release', 'a keyup is a release');
    // AltGr on a Windows browser is Ctrl+Alt with AltGraph held: the character is the text, and
    // Ctrl/Alt went into it (termd would make Ctrl+Alt+@ a NUL).
    ok(same(keyEventFor(ev('@', 'KeyQ', { ctrl: true, alt: true, altGr: true })), { code: 'KeyQ', key: '@', mods: [], text: '@', action: 'press' }),
        'AltGr+Q on a German layout types @, no Ctrl or Alt');
    ok(same(keyEventFor(ev('{', 'Digit7', { ctrl: true, alt: true, altGr: true }))?.mods, []), 'AltGr+7 types {');
    ok(same(keyEventFor(ev('@', 'KeyQ', { ctrl: true, alt: true }))?.mods, ['Control', 'Alt']), 'a real Ctrl+Alt still rides');
}

// ── 3. the grid stamps its id; the push names the kind ──
// The real class constructs a GlyphField (WebGPU), so exercise the methods under test on their own
// prototype — they touch nothing but `this.terminalId` and `this.onInput`. NOT `id`: Object3D makes
// that non-writable, so a stub that sets `id` would pass while the real constructor throws.
const { default: TerminalGrid } = await import('../packages/glyph3d-core/src/collections/TerminalGrid.js');
const gridStub = (id) => {
    const sent = [];
    const g = Object.create(TerminalGrid.prototype);
    g.terminalId = id;
    g.onInput = (input, termId) => sent.push({ input, termId });
    return { g, sent };
};

// The constraint that makes `terminalId` necessary, asserted against three itself.
{
    const { Object3D } = await import('three');
    const o = new Object3D();
    ok(Object.getOwnPropertyDescriptor(o, 'id').writable === false, 'Object3D.id is non-writable');
    let threw = false;
    try { o.id = 'term-1'; } catch { threw = true; }
    ok(threw, 'assigning Object3D.id throws — grids must hold identity under another name');
}

{
    const { g, sent } = gridStub('term-7');
    const k = keyEventFor(ev('Enter', 'Enter', { shift: true }));
    ok(g.sendKey(k) === true && same(sent[0], { input: { key: k }, termId: 'term-7' }), 'sendKey hands the key event on, stamped with the grid\'s OWN id');
    // A paste is the text, whole: termd brackets it (or not) and strips its control bytes, by the
    // program's mode at the moment it lands — which only termd knows.
    ok(g.paste('one\ntwo\x1b[201~') === true && same(sent[1].input, { paste: 'one\ntwo\x1b[201~' }), 'paste hands the text on whole, unframed');
    ok(g.sendInput('ls\r') === true && same(sent[2].input, { bytes: 'ls\r' }), 'sendInput hands raw bytes on as bytes');
    ok(g.paste('') === false && g.paste(null) === false && sent.length === 3, 'empty/non-string paste sends nothing');
}

// No owner attached (a terminal whose adapter dropped) → false, no throw.
{
    const g = Object.create(TerminalGrid.prototype);
    g.terminalId = 't'; g.onInput = null;
    ok(g.paste('x') === false, 'paste with no owner returns false');
    ok(g.sendKey({ code: 'KeyX', key: 'x', mods: [], text: 'x', action: 'press' }) === false, 'sendKey with no owner returns false');
    ok(g.sendInput('x') === false, 'sendInput with no owner returns false');
}

// The push each input becomes on the relay, through terminal.create's real owner binding:
// tools/terminal-readopt.test.mjs.

console.log(`${fail === 0 ? '✓' : '✗'} terminal-input: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
