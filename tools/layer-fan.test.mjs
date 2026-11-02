// layer-fan.test.mjs — depth as time's FAN quasimode (slice 10a step 3): in a plane, HOLDING the pane
// prefix chord past the key-repeat delay fans the layers (`plane.fan on` — the layers behind a page
// spread: the pages slide whole px per rank on the orthographic endpoint, a wider lens on the
// perspective one) and
// RELEASING it folds them (`plane.fan off`); a TAP is still the prefix. Driven through the real installKeyboardRouter with an injected document.
//
//   bun tools/layer-fan.test.mjs
//
// Locks: a tap arms the prefix (its next key runs a pane command, no fan); held (repeat) → exactly one
// plane.fan on however long, the prefix disarmed (the release isn't a command key wait); the
// chord's key or a modifier lifting → plane.fan off, once; outside a plane the chord isn't claimed
// and nothing fans; a focused terminal never sees the held chord.
// The fan WITHOUT key-repeat: prefix then f → plane.fan toggle, and the verb's toggle flips the fan on
// either endpoint (orthographic: setPlaneFan(layers.fanPx) ↔ 0; perspective: layers.fanFov ↔ plane.fov).
// The TRACE (keys.trace, env.trace): each key event the router sees is one [keys] record — key, code,
// modifiers, repeat, the tier that claimed it (null: none; dom-input), the plane state it met; trace
// off, none.

const ROUTER = process.env.KEYBOARD_ROUTER || '../app/client/keyboardRouter.js';
const { installKeyboardRouter } = await import(ROUTER);

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

function harness({ entered = true, terminal = false, trace = false } = {}) {
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
        trace: () => trace,
    };
    installKeyboardRouter(env);
    const ev = (key, mods = {}, repeat = false) => ({ key, code: CODES[key] ?? key, repeat, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
        claimed: false, preventDefault() { this.claimed = true; }, stopImmediatePropagation() {} });
    const down = (key, mods, repeat) => { const e = ev(key, mods, repeat); listeners.get('keydown')(e); return e.claimed; };
    const up = (key, mods) => { const e = ev(key, mods); listeners.get('keyup')?.(e); return e.claimed; };
    return { down, up, ran, sent, state, doc };
}
const CTRL = { ctrl: true };
const CODES = { ' ': 'Space', Control: 'ControlLeft', h: 'KeyH', f: 'KeyF', q: 'KeyQ' };

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

{   // the fan without holding: prefix then f
    const h = harness();
    h.down(' ', CTRL); h.up(' ', CTRL); h.up('Control');
    ok(h.down('f') && h.ran.join('|') === 'plane.fan toggle', `prefix + f → plane.fan toggle (${h.ran.join('|')})`);
    h.down('f');
    ok(h.ran.length === 1, 'a bare f after it is not a fan (the prefix is spent)');
}

{   // plane.fan toggle flips the fan on both endpoints
    const { default: registerPlaneCommands } = await import('../app/commands/handlers/planeCommands.js');
    const { getSetting } = await import('../app/client/settings.js');
    const verbs = new Map();
    registerPlaneCommands({ register: (n, fn) => verbs.set(n, fn) });
    const fan = (st) => {
        const calls = [];
        const ctx = { cameraController: {
            planeState: () => st,
            setPlaneFan: (px) => { calls.push(['px', px]); st.fan = px ? { px } : null; return true; },
            setPlaneFov: (fov) => { calls.push(['fov', fov]); st.fovDeg = fov; return true; },
            addPlaneFanListener: () => {},
        } };
        return { calls, run: () => verbs.get('plane.fan')(['toggle'], ctx) };
    };
    const px = Number(getSetting('layers.fanPx')), fov0 = Number(getSetting('plane.fov')), fov1 = Number(getSetting('layers.fanFov'));
    const o = fan({ ortho: true, fan: null, fovDeg: 50 });
    const r1 = o.run(), r2 = o.run();
    ok(/^OK/.test(r1.text) && /^OK/.test(r2.text) && JSON.stringify(o.calls) === JSON.stringify([['px', px], ['px', 0]]),
        `orthographic: toggle fans by layers.fanPx, then folds (${JSON.stringify(o.calls)})`);
    const p = fan({ ortho: false, fan: null, fovDeg: fov0 });
    p.run(); p.run();
    ok(JSON.stringify(p.calls) === JSON.stringify([['fov', fov1], ['fov', fov0]]),
        `perspective: toggle widens to layers.fanFov, then narrows to plane.fov (${JSON.stringify(p.calls)})`);
}

{   // the trace: what the router saw, and who claimed it
    const recs = [];
    const info = console.info;
    console.info = (m) => { if (String(m).startsWith('[keys] ')) recs.push(String(m)); else info(m); };
    try {
        const h = harness({ trace: true });
        h.down(' ', CTRL); h.down(' ', CTRL, true); h.up(' ', CTRL);
        const parse = (r) => (r ? { phase: r.split(' ')[1], ...JSON.parse(r.slice(r.indexOf('{'))) } : {});
        const [tap, held, rel] = recs.map(parse);
        ok(recs.length === 3, `one record per key event (${recs.length})`);
        ok(tap?.phase === 'down' && tap.key === ' ' && tap.code === 'Space' && tap.ctrl && !tap.shift && !tap.repeat && tap.tier === 'planePrefix' && tap.plane && !tap.armed,
            `the tap: Ctrl+Space, claimed by planePrefix, nothing armed yet (${recs[0]})`);
        ok(held?.repeat && held.tier === 'planePrefix' && held.fanning, `the repeat: repeat true, planePrefix, fanning (${recs[1]})`);
        ok(rel?.phase === 'up' && rel.key === ' ' && rel.tier === 'fan', `the release: up, the fan's (${recs[2]})`);
        recs.length = 0;
        const o = harness({ entered: false, trace: true });
        o.down('q');
        ok(recs.length === 1 && parse(recs[0]).tier === null && !parse(recs[0]).plane, `unclaimed: tier null, outside a plane (${recs[0]})`);
        recs.length = 0;
        const d = harness({ trace: true });
        d.doc.activeElement = { tagName: 'INPUT' };
        d.down('h');
        ok(recs.length === 1 && parse(recs[0]).tier === 'dom-input', `a focused input keeps it: dom-input (${recs[0]})`);
        recs.length = 0;
        const a = harness({ trace: true });
        a.down(' ', CTRL); a.down('h');
        ok(parse(recs[1]).armed === true && parse(recs[1]).tier === 'planePrefix', `a prefixed key is traced armed (${recs[1]})`);
        recs.length = 0;
        const off = harness();
        off.down(' ', CTRL); off.down(' ', CTRL, true); off.up(' ', CTRL);
        ok(recs.length === 0, `trace off: no records (${recs.length})`);
    } finally { console.info = info; }
}

console.log(`layer-fan: ${checks - fails}/${checks} passed`);
process.exit(fails ? 1 : 0);
