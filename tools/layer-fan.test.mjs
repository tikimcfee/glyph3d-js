// layer-fan.test.mjs — depth as time's FAN quasimode (slice 10a step 3): in a plane, HOLDING the pane
// prefix chord past the key-repeat delay fans the layers (`plane.fan on` — the layers behind a page
// spread: a whole-px shear on the orthographic endpoint, a wider lens on the perspective one) and
// RELEASING it folds them (`plane.fan off`); a TAP is still the prefix. Driven through the real installKeyboardRouter with an injected document.
//
//   bun tools/layer-fan.test.mjs
//
// Locks: a tap arms the prefix (its next key runs a pane command, no fan); held (repeat) → exactly one
// plane.fan on however long, the prefix disarmed (the release isn't a command key wait); the
// chord's key or a modifier lifting → plane.fan off, once; outside a plane the chord isn't claimed
// and nothing fans; a focused terminal never sees the held chord.

const ROUTER = process.env.KEYBOARD_ROUTER || '../app/client/keyboardRouter.js';
const { installKeyboardRouter } = await import(ROUTER);

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

function harness({ entered = true, terminal = false } = {}) {
    const listeners = new Map();
    const doc = { activeElement: null, addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t) };
    const sent = [];
    const grid = { sendInput: (b) => { sent.push(b); return true; } };
    const am = { get: (slot) => (slot === 'key' && terminal ? { id: 'term', entity: { type: 'terminal', grid } } : null), isCaptured: () => false, on: () => () => {} };
    const ran = [];
    const state = { entered };
    const env = {
        document: doc, am,
        exec: (cmd) => { ran.push(Array.isArray(cmd) ? cmd.join(' ') : cmd); return { text: 'OK' }; },
        gestureEnv: { exec: () => {}, attention: { get: () => null, clear: () => {} }, context: { nodes: () => [] } },
        planeEntered: () => state.entered, planePrefixMs: 1500,
    };
    installKeyboardRouter(env);
    const ev = (key, mods = {}, repeat = false) => ({ key, repeat, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
        claimed: false, preventDefault() { this.claimed = true; }, stopImmediatePropagation() {} });
    const down = (key, mods, repeat) => { const e = ev(key, mods, repeat); listeners.get('keydown')(e); return e.claimed; };
    const up = (key, mods) => { const e = ev(key, mods); listeners.get('keyup')?.(e); return e.claimed; };
    return { down, up, ran, sent, state };
}
const CTRL = { ctrl: true };

{   // a tap is still the prefix
    const h = harness();
    ok(h.down(' ', CTRL), 'the chord is claimed in a plane');
    h.up(' ', CTRL); h.up('Control');
    ok(h.down('h'), 'the next key is the pane command');
    ok(h.ran.join('|') === 'pane.focus left', `a tap fans nothing (${h.ran.join('|')})`);
}
{   // held: one fan, released: flat
    const h = harness();
    h.down(' ', CTRL);
    ok(h.down(' ', CTRL, true) && h.down(' ', CTRL, true) && h.down(' ', CTRL, true), 'the held chord stays claimed');
    ok(h.ran.join('|') === 'plane.fan on', `held → one plane.fan on (${h.ran.join('|')})`);
    ok(h.up(' ', CTRL), 'its release is claimed');
    ok(h.ran.join('|') === 'plane.fan on|plane.fan off', `released → plane.fan off (${h.ran.join('|')})`);
    h.up('Control');
    ok(h.ran.length === 2, 'the other key lifting after does nothing more');
    h.down('h');
    ok(!h.ran.includes('pane.focus left'), 'the hold disarmed the prefix (the release is not followed by a command wait)');
}
{   // released by the modifier first
    const h = harness();
    h.down(' ', CTRL); h.down(' ', CTRL, true);
    h.up('Control');
    ok(h.ran.at(-1) === 'plane.fan off', 'lifting Ctrl first folds too');
}
{   // outside a plane: not claimed, no fan
    const h = harness({ entered: false });
    ok(!h.down(' ', CTRL) && !h.down(' ', CTRL, true), 'outside a plane the chord is not claimed');
    h.up(' ', CTRL);
    ok(h.ran.length === 0, 'and nothing fans');
}
{   // a focused terminal never sees the held chord
    const h = harness({ terminal: true });
    h.down(' ', CTRL); h.down(' ', CTRL, true); h.up(' ', CTRL);
    ok(h.sent.length === 0, `the terminal got no bytes (${h.sent.length})`);
}

console.log(`layer-fan: ${checks - fails}/${checks} passed`);
process.exit(fails ? 1 : 0);
