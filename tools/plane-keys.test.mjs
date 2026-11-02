// plane-keys.test.mjs — the keyboard responder chain's PLANE tiers (app/client/keyboardRouter.js):
// the pane prefix and Esc-to-step-out, driven through the real installKeyboardRouter with an
// injected document.
//
//   bun tools/plane-keys.test.mjs
//
// Locks:
//   - outside a plane the prefix chord is not claimed (it reaches whatever would get it)
//   - inside a plane: prefix + h/j/k/l/arrows → pane.focus, Tab → carrel.back, z → pane.zoom,
//     ] / [ → pane.tab next/prev, x → pane.close, e/m/s → pane.layout, q/Esc → carrel.leave
//   - a focused terminal never sees the prefix or its command key (claimed above typing), and
//     still gets every other key
//   - an unknown key after the prefix is consumed (no surprise bytes) and disarms
//   - the prefix times out (planePrefixMs)
//   - a bare Esc leaves the plane only when nothing else claims it (a focus to pop goes first)

import { installKeyboardRouter } from '../app/client/keyboardRouter.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

function harness({ entered = true, terminal = false, popsFocus = false } = {}) {
    const listeners = new Map();
    const doc = {
        activeElement: null,
        addEventListener: (t, fn) => listeners.set(t, fn),
        removeEventListener: (t) => listeners.delete(t),
    };
    const sent = [];
    const grid = { sendInput: (b) => { sent.push(b); return true; } };
    const am = {
        get: (slot) => (slot === 'key' && terminal ? { id: 'term', entity: { type: 'terminal', grid } } : null),
        isCaptured: () => false,
        on: () => () => {},
    };
    const ran = [];
    const state = { entered };
    const env = {
        document: doc, am,
        exec: (cmd) => { ran.push(Array.isArray(cmd) ? cmd.join(' ') : cmd); return { text: 'OK' }; },
        gestureEnv: {
            exec: () => {},
            attention: { get: () => (popsFocus ? { id: 'x' } : null), clear: () => {} },
            // A node whose policy claims Esc (an edit session) when there's focus to pop; none otherwise.
            context: { nodes: () => (popsFocus ? [{ kind: 'edit' }] : []) },
        },
        planeEntered: () => state.entered,
        planePrefixMs: 1500,
    };
    installKeyboardRouter(env);
    const press = (key, mods = {}) => {
        const e = { key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
            claimed: false, preventDefault() { this.claimed = true; }, stopImmediatePropagation() {} };
        listeners.get('keydown')(e);
        return e.claimed;
    };
    return { press, ran, sent, state, env };
}

// outside a plane
{
    const h = harness({ entered: false });
    ok(!h.press(' ', { ctrl: true }), 'outside a plane the prefix is not claimed');
    h.press('l');
    ok(!h.ran.includes('pane.focus right'), 'outside a plane, l runs no pane verb');
}

// the command table
{
    const table = [
        [['h'], 'pane.focus left'], [['ArrowRight'], 'pane.focus right'], [['k'], 'pane.focus up'], [['j'], 'pane.focus down'],
        [['z'], 'pane.zoom'], [['Tab'], 'carrel.back'], [[']'], 'pane.tab next'], [['['], 'pane.tab prev'], [['x'], 'pane.close'],
        [['e'], 'pane.layout even'], [['m'], 'pane.layout main'], [['s'], 'pane.layout stack'], [['p'], 'point.mark here'], [['q'], 'carrel.leave'], [['Escape'], 'carrel.leave'],
    ];
    for (const [[key, mods], verb] of table) {
        const h = harness();
        ok(h.press(' ', { ctrl: true }), `prefix claimed (${key})`);
        ok(h.press(key, mods), `prefixed ${key} claimed`);
        ok(h.ran.at(-1) === verb, `prefix ${key}${mods?.shift ? ' (shift)' : ''} → ${verb} (got ${h.ran.at(-1)})`);
    }
}

// a focused terminal never sees the prefix or its command, still gets everything else
{
    const h = harness({ terminal: true });
    h.press('a');
    ok(h.sent.length === 1, 'a focused terminal gets a plain key');
    h.press(' ', { ctrl: true });
    h.press('l');
    ok(h.sent.length === 1 && h.ran.includes('pane.focus right'), 'prefix + l moves focus; the terminal saw neither');
    h.press('l');
    ok(h.sent.length === 2, 'after the command, l types again');
}

// unknown prefixed key: consumed, disarms
{
    const h = harness({ terminal: true });
    h.press(' ', { ctrl: true });
    ok(h.press('7') && h.sent.length === 0 && h.ran.length === 0, 'an unknown prefixed key is consumed, runs nothing, types nothing');
    h.press('7');
    ok(h.sent.length === 1, 'and the prefix is disarmed after it');
}

// timeout
{
    const h = harness({ terminal: true });
    h.press(' ', { ctrl: true });
    h.env._planeArmed = Date.now() - 1;   // past planePrefixMs
    h.press('l');
    ok(!h.ran.includes('pane.focus right') && h.sent.length === 1, 'an expired prefix arms nothing: l types');
}

// bare Esc: leaves only when nothing else claims it
{
    const h = harness();
    ok(h.press('Escape') && h.ran.at(-1) === 'carrel.leave', 'a bare Esc with nothing to pop leaves the plane');
    const h3 = harness({ popsFocus: true });
    h3.press('Escape');
    ok(!h3.ran.includes('carrel.leave'), 'with focus to pop, the first Esc pops it — it does not leave');
    const h2 = harness({ entered: false });
    h2.press('Escape');
    ok(!h2.ran.includes('carrel.leave'), 'outside a plane Esc never leaves');
}

console.log(`${fails ? 'FAIL' : 'ok'} plane-keys: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
