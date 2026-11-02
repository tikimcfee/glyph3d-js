// plane-click.test.mjs — a click INSIDE a plane focuses and never moves the camera
// (app/client/gestureResolver.js focusTarget + planeReading; pane.focus --keep-view).
//
//   bun tools/plane-click.test.mjs
//
// Driven through the real resolveGesture, the real pane.* verbs and a real pin-board Carrel.
// Locks:
//   - control: in the open world a click on a new target flies (camera.focus) — the test sees flights
//   - in a plane, every chain path (root, focus, key, edit nodes; grid and terminal targets) sends no
//     camera verb and no plane aim; the clicked member takes primary, a terminal the keyboard, and
//     on a plane desk its pin takes the desk's focus (so the h/j/k/l hops go on from it)
//   - a click on something that isn't on the desk, or in a plane read with no desk, only focuses
//   - a plane easing OUT is the open world again (a click there flies, as before)
//   - the keyboard hop (pane.focus <dir>) still slides the view to show the pin it lands on
// Teeth: dropping the plane branch in focusTarget fails every in-plane check (camera.focus returns).

import './headless-canvas.mjs';
import * as THREE from 'three';
import { Carrel } from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import { resolveGesture } from '../app/client/gestureResolver.js';
import registerPaneCommands from '../app/commands/handlers/paneCommands.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const J = (v) => JSON.stringify(v);

const CW = 0.725, LS = 1.359375;
const UNIT = { column: CW, cellPx: 8, rowRatio: LS / CW };
/** A terminal-like member: cols × rows cells from its top-left origin. */
function screen(name, cols, rows) {
    const g = new THREE.Object3D();
    g.name = name;
    g.metrics = { charWidth: CW, lineSpacing: LS, charHeight: LS };
    g.pixelOrigin = () => ({ x: 0, y: 0 });
    g.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -rows * LS, -0.5), new THREE.Vector3(cols * CW, 0, 0.5));
    return g;
}

const verbs = new Map();
registerPaneCommands({ register: (name, fn) => verbs.set(name, fn) });

/**
 * A world: a pin board 'b' with members a (terminal), g (grid), t (terminal) — and 'x', a grid
 * that isn't on it. `plane`: null (open world) | 'desk' | 'surface' (plane.enter, no desk) | 'leaving'.
 */
function world(plane) {
    const scene = new THREE.Scene();
    const desk = new Carrel({ name: 'b', mode: 'plane', animDur: 0 });
    scene.add(desk);
    desk.setPlaneUnit(UNIT);
    for (const [id, cols] of [['a', 120], ['g', 80], ['t', 100]]) { const s = screen(id, cols, 40); scene.add(s); desk.lock(id, s, { immediate: true }); }
    const types = { a: 'terminal', g: 'grid', t: 'terminal', x: 'grid' };
    const slots = { primary: null, key: null };
    const sent = [], aims = [];
    const ctx = {
        enteredCarrel: plane === 'desk' || plane === 'leaving' ? 'b' : null,
        carrels: new Map([['b', desk]]),
        registry: { get: (id) => (types[id] ? { id, type: types[id] } : null) },
        holding: {
            isDocked: () => false,
            resolve: (id) => (types[id] ? { id } : { error: `nothing named '${id}'` }),
        },
        attentionManager: {
            get: (slot) => (slots[slot] ? { id: slots[slot] } : null),
            set: (slot, id) => { slots[slot] = id ?? null; },
        },
        cameraController: {
            planeState: () => (plane ? { leaving: plane === 'leaving' } : null),
            planeViewport: () => ({ width: 1600, height: 942, dpr: 1 }),
            setPlaneAim: (x, y) => { aims.push([x, y]); return true; },
        },
    };
    const exec = (cmd) => {
        const parts = Array.isArray(cmd) ? cmd.map(String) : String(cmd).split(' ');
        sent.push(parts.join(' '));
        if (parts[0] === 'attention.set') { slots[parts[1]] = parts[2] === 'none' ? null : parts[2]; return { text: 'OK' }; }
        const fn = verbs.get(parts[0]);
        return fn ? fn(parts.slice(1), ctx) : { text: 'OK' };
    };
    const env = {
        exec, ctx, attention: ctx.attentionManager,
        context: { nodes: () => [] },
        placeCaretFromPointer: async () => false,
    };
    const click = (id, nodes = []) => {
        sent.length = 0; aims.length = 0;
        env.context = { nodes: () => nodes };
        const claimed = resolveGesture({ type: 'click', target: id ? { id, type: types[id] } : null, mods: {} }, env);
        return { claimed, sent: [...sent], aims: [...aims] };
    };
    return { desk, ctx, slots, click, exec, sent, aims };
}

const moves = (r) => r.sent.filter((c) => /^(camera\.|plane\.(aim|enter|leave)|carrel\.(enter|leave|back))/.test(c));

// control: the open world flies to a new target
{
    const w = world(null);
    const r = w.click('g');
    ok(r.claimed && r.sent.includes('camera.focus g'), `open world: a click on a new target flies (${J(r.sent)})`);
    ok(w.click('g').sent.every((c) => !c.startsWith('camera.')), 'open world: re-clicking the focused target does not');
}

// in a plane desk: every chain path focuses, nothing moves
{
    const paths = [
        ['root, a grid', 'g', []],
        ['root, a terminal', 't', []],
        ['focus node, its grid', 'g', [{ kind: 'focus', id: 'g' }]],
        ['focus node, its terminal', 'a', [{ kind: 'focus', id: 'a' }]],
        ['key node, its terminal', 't', [{ kind: 'key', id: 't' }]],
        ['edit node, its grid', 'g', [{ kind: 'edit', id: 'g' }]],
        ['focus node elsewhere → root', 't', [{ kind: 'focus', id: 'g' }]],
    ];
    for (const [name, id, nodes] of paths) {
        const w = world('desk');
        const r = w.click(id, nodes);
        ok(r.claimed, `${name}: claimed`);
        ok(moves(r).length === 0, `${name}: no camera verb (${J(r.sent)})`);
        ok(r.aims.length === 0, `${name}: the plane's aim is untouched (${J(r.aims)})`);
        ok(w.slots.primary === id, `${name}: ${id} takes primary (${w.slots.primary})`);
        ok(w.desk.focusedPin() === id, `${name}: ${id}'s pin takes the desk's focus (${w.desk.focusedPin()})`);
        if (w.ctx.registry.get(id).type === 'terminal') ok(w.slots.key === id, `${name}: the terminal takes the keyboard (${w.slots.key})`);
    }
}

// a click on something not on the desk, a plane read with no desk: focus only
{
    const w = world('desk');
    const r = w.click('x');
    ok(moves(r).length === 0 && !r.sent.some((c) => c.startsWith('pane.')) && w.slots.primary === 'x',
        `plane desk, a target off the desk: focused, no pane verb, nothing moves (${J(r.sent)})`);
    const s = world('surface');
    const r2 = s.click('g');
    ok(moves(r2).length === 0 && !r2.sent.some((c) => c.startsWith('pane.')) && s.slots.primary === 'g',
        `plane read with no desk: focused, nothing moves (${J(r2.sent)})`);
    ok(s.click(null).sent.join() === 'attention.set key none', 'plane: empty space frees the keyboard, nothing else');
}

// a plane easing out is the open world again
{
    const w = world('leaving');
    ok(w.click('g').sent.includes('camera.focus g'), 'a plane easing out: a click flies as in the open world');
}

// the hop still slides the view to the pin it lands on; --keep-view is what holds it
{
    const w = world('desk');
    w.click('a');
    w.sent.length = 0; w.aims.length = 0;
    const res = w.exec('pane.focus right');
    ok(/^OK/.test(res.text) && w.desk.focusedPin() !== 'a' && w.aims.length === 1, `pane.focus right hops and aims (${res.text}, ${J(w.aims)})`);
    w.aims.length = 0;
    const res2 = w.exec(['pane.focus', 'a']);
    ok(/^OK/.test(res2.text) && w.aims.length === 1, 'pane.focus <member> without --keep-view aims as before');
    w.aims.length = 0;
    const res3 = w.exec(['pane.focus', 't', '--keep-view']);
    ok(/^OK/.test(res3.text) && w.aims.length === 0 && w.desk.focusedPin() === 't', `pane.focus <member> --keep-view focuses the pin, no aim (${res3.text})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} — plane-click: ${checks - fails}/${checks}`);
process.exit(fails ? 1 : 0);
