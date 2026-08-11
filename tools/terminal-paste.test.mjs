// terminal-paste.test.mjs — headless behavior lock for clipboard paste into a terminal.
//
//   bun tools/terminal-paste.test.mjs
//
// Paste works only if TWO things hold, and each was a real bug:
//
//   1. keyEncoding DECLINES the paste chord. The responder chain suppresses any event a tier
//      claimed, so encoding Cmd+V to bytes both eats the clipboard (no native `paste` fires)
//      and types a literal 'v'. Declining is what lets the browser event happen at all.
//   2. TerminalGrid.paste() frames the text as ONE bracketed-paste burst stamped with the
//      grid's own id — the caller supplies text, never bytes and never identity.
//
// Both are pure functions of their input, so this runs with no DOM and no GPU.

import { keyToTerminalBytes, isPasteChord } from '../packages/glyph3d-core/src/services/interaction/keyEncoding.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

const key = (k, mods = {}) => ({
    key: k,
    ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
});

// ── 1. the chord is declined, and ONLY the chord ──
{
    ok(keyToTerminalBytes(key('v', { meta: true })) === null, 'Cmd+V encodes to nothing');
    ok(keyToTerminalBytes(key('V', { ctrl: true, shift: true })) === null, 'Ctrl+Shift+V encodes to nothing');

    // The regression this replaces: the catch-all used to return the bare character.
    ok(keyToTerminalBytes(key('v', { meta: true })) !== 'v', 'Cmd+V does NOT type a literal v');

    // Plain Ctrl+V stays a real terminal byte — readline's quoted-insert. Breaking this to
    // "fix paste" would be a silent regression for anyone using C-v C-j to insert a newline.
    ok(keyToTerminalBytes(key('v', { ctrl: true })) === '\x16', 'plain Ctrl+V still encodes \\x16');
    ok(keyToTerminalBytes(key('v')) === 'v', 'bare v still types v');
    ok(keyToTerminalBytes(key('c', { meta: true })) === 'c', 'Cmd+C is not swept up by the chord test');
    ok(isPasteChord(key('v', { ctrl: true })) === false, 'Ctrl+V is not a paste chord');
}

// ── 2. paste() framing, against a TerminalGrid stand-in ──
// The real class constructs a GlyphField (WebGPU), so exercise the two methods under test on
// their own prototype — they touch nothing but `this.terminalId` and `this.onInput`.
// NOT `id`: Object3D makes that non-writable, so a stub that sets `id` would pass while the
// real constructor throws. Identity lives on `terminalId` for exactly that reason.
const { default: TerminalGrid } = await import('../packages/glyph3d-core/src/collections/TerminalGrid.js');
const gridStub = (id) => {
    const sent = [];
    const g = Object.create(TerminalGrid.prototype);
    g.terminalId = id;
    g.onInput = (bytes, termId) => sent.push({ bytes, termId });
    return { g, sent };
};

// The constraint that makes `terminalId` necessary, asserted against three itself: Object3D
// defines `id` non-writable, so any `this.id = …` in a grid constructor throws (ES modules are
// strict) and NO grid is ever built. A stub can't catch that — it has no Object3D on its chain.
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
    ok(g.paste('echo hi') === true, 'paste() reports sent');
    ok(sent.length === 1, 'a paste is ONE burst, not one write per line');
    ok(sent[0].bytes === '\x1b[200~echo hi\x1b[201~', 'text is bracket-framed');
    ok(sent[0].termId === 'term-7', "the grid stamps its OWN id — the caller never passes one");
}

// Multi-line text stays one burst with newlines intact: bracketing is what tells the shell not
// to execute the lines, and tmux converts LF on the way in, so no rewriting here.
{
    const { g, sent } = gridStub('t');
    g.paste('one\ntwo\n');
    ok(sent.length === 1 && sent[0].bytes === '\x1b[200~one\ntwo\n\x1b[201~', 'multi-line is one framed burst, newlines unchanged');
}

// Paste injection: clipboard text carrying the END marker would close the bracket early and
// let its remainder run as keystrokes. The marker is stripped; the rest of the text survives.
{
    const { g, sent } = gridStub('t');
    g.paste('safe\x1b[201~rm -rf /\r');
    ok(!sent[0].bytes.slice(6, -6).includes('\x1b[201~'), 'embedded end-marker is stripped from the payload');
    ok(sent[0].bytes === '\x1b[200~saferm -rf /\r\x1b[201~', 'exactly one closing bracket, at the end');
}

// Degenerate input is a no-op, not an empty burst (an empty bracket pair still makes some apps flash).
{
    const { g, sent } = gridStub('t');
    ok(g.paste('') === false && g.paste(null) === false && sent.length === 0, 'empty/non-string paste sends nothing');
}

// No owner attached (a terminal whose adapter dropped) → false, no throw.
{
    const g = Object.create(TerminalGrid.prototype);
    g.terminalId = 't'; g.onInput = null;
    ok(g.paste('x') === false, 'paste with no owner returns false');
    ok(g.sendInput('x') === false, 'sendInput with no owner returns false');
}

console.log(`${fail === 0 ? '✓' : '✗'} terminal-paste: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
