// desk-placement.test.mjs — carrel.create never sets a desk down over another desk
// (carrelCommands setDown → Carrel.airspace + clearSpot).
//
//   bun tools/desk-placement.test.mjs
//
// Real desks through the real verb (carrel.create → buildCarrel), a real atlas unit, one camera pose:
//   - three desks created from the SAME pose: no two airspaces intersect, each kept `carrel.createGap`
//     from the rest; every one faces the camera as the first does (it slides along its own right, it
//     doesn't turn); the first stands exactly where you were looking (nothing was there)
//   - the reply says where it went and who stood there
//   - inside a plane (ctx.enteredCarrel): the new desk starts beside the entered desk, facing as it
//     does, and slides clear of it
//   - an empty plane desk claims its frame (airspace ⊇ the shelf width × tile frame height), so a
//     desk set down beside it isn't overrun when its board fills
//   - the gap knob is honored (a bigger gap → farther apart) and born configurable (a Setting)
//   - TEETH: with the slide off (gap ignored, offset 0 — today's create), the same three overlap

import './headless-canvas.mjs';
import * as THREE from 'three';

const store = new Map();
globalThis.localStorage ??= {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
};
globalThis.window ??= { addEventListener() {}, dispatchEvent() {} };
globalThis.window.dispatchEvent ??= () => {};

const { HEADLESS_ATLAS } = await import('./headless-atlas.mjs');
const { default: WorkspaceModel } = await import('../app/client/WorkspaceModel.js');
const { default: Holding } = await import('../app/client/Holding.js');
const { default: registerCarrelCommands } = await import('../app/commands/handlers/carrelCommands.js');
const { getSetting, setSetting, resetSetting } = await import('../app/client/settings.js');
const CarrelModule = await import('../packages/glyph3d-core/src/services/interaction/Carrel.js');

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

function makeWorld() {
    const scene = new THREE.Scene();
    const entries = new Map();
    const registry = {
        register(id, grid, meta = {}) { entries.set(id, { id, grid, ...meta }); },
        unregister(id) { const e = entries.get(id); entries.delete(id); return e; },
        get: (id) => entries.get(id) || null,
        has: (id) => entries.has(id),
        list: () => [...entries.values()],
        findByType: (t) => [...entries.values()].filter((e) => e.type === t),
        addChangeListener() {}, removeChangeListener() {},
    };
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1e6);
    camera.position.set(100, 300, 2000);
    camera.lookAt(100, 300, 0);
    camera.updateMatrixWorld();
    const ctx = { scene, registry, camera, atlas: HEADLESS_ATLAS, carrels: new Map(), workspace: new WorkspaceModel(), cameraDock: null, getSurfaces: () => [], getGrids: () => [] };
    ctx.holding = new Holding(ctx);
    const verbs = new Map();
    registerCarrelCommands({ register: (name, fn) => verbs.set(name, fn) });
    const run = (name, ...args) => verbs.get(name)(args.map(String), ctx);
    return { ctx, run };
}

const boxesOf = (ctx) => [...ctx.carrels.values()].map((d) => [d.carrelName, d.airspace()]);
function overlaps(ctx, gap = 0) {
    const b = boxesOf(ctx), out = [];
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
        if (b[i][1].clone().expandByScalar(gap / 2 - 1e-6).intersectsBox(b[j][1].clone().expandByScalar(gap / 2 - 1e-6))) out.push(`${b[i][0]}×${b[j][0]}`);
    }
    return out;
}

// ── Three desks from the same pose.
{
    const { ctx, run } = makeWorld();
    const gap = getSetting('carrel.createGap');
    ok(Number.isFinite(gap) && gap > 0, `carrel.createGap is a Setting, born ${gap}`);
    const r1 = run('carrel.create', 'one');
    const want = r1.data.setDown.at;
    ok(r1.data.setDown.slid === 0 && r1.data.setDown.blockedBy.length === 0, `the first stands where you were looking (${r1.text})`);
    const r2 = run('carrel.create', 'two');
    const r3 = run('carrel.create', 'three');
    ok(overlaps(ctx).length === 0, `three desks from one pose: no two airspaces intersect (${overlaps(ctx).join(' ') || 'none'})`);
    ok(overlaps(ctx, gap).length === 0, `and each keeps carrel.createGap (${gap}) from the rest (${overlaps(ctx, gap).join(' ') || 'none'})`);
    const yaws = [...ctx.carrels.values()].map((d) => d.rotation.y);
    ok(yaws.every((y) => Math.abs(y - yaws[0]) < 1e-12), 'every one faces as the first (it slid, it did not turn)');
    ok(Math.abs(ctx.carrels.get('two').position.y - want.y) < 1e-9 && Math.abs(ctx.carrels.get('three').position.y - want.y) < 1e-9, 'and stands at the same height');
    ok(/slid [\d.]+ to its (right|left): 'one' stood where you were looking/.test(r2.text), `the reply says where and who (${r2.text})`);
    ok(r3.data.setDown.blockedBy.length >= 1, `the third names what blocked it (${r3.data.setDown.blockedBy.join(', ')})`);

    // An empty plane desk claims its frame: the shelf width × the tile frame height.
    const one = ctx.carrels.get('one');
    const air = one.airspace(), own = one.getBounds();
    const k = one.planeK, shelfW = Math.max(1, one.shelfCols) * one.planeUnit.column, f = one.tileFrame();
    ok(air.containsBox(own), 'airspace ⊇ the desk\'s own bounds');
    ok(air.max.x - air.min.x >= Math.max(shelfW, f.widthPx / k) - 1e-6 && air.max.y - air.min.y >= f.heightPx / k - 1e-6, `an empty plane desk claims its frame (${(air.max.x - air.min.x).toFixed(1)} × ${(air.max.y - air.min.y).toFixed(1)})`);
}

// ── Inside a plane: beside the entered desk, facing as it does.
{
    const { ctx, run } = makeWorld();
    run('carrel.create', 'reading');
    const reading = ctx.carrels.get('reading');
    reading.rotation.y = 0.4; reading.updateMatrixWorld(true);
    ctx.enteredCarrel = 'reading';
    ctx.camera.position.set(-5000, 0, 9000); ctx.camera.updateMatrixWorld();   // a plane view stands far back
    const r = run('carrel.create', 'probe');
    const probe = ctx.carrels.get('probe');
    ok(Math.abs(probe.rotation.y - 0.4) < 1e-12, 'inside a plane: the new desk faces as the entered desk');
    const right = new THREE.Vector3(Math.cos(0.4), 0, -Math.sin(0.4));
    const d = probe.position.clone().sub(reading.position);
    ok(Math.abs(d.y) < 1e-9 && d.clone().sub(right.clone().multiplyScalar(d.dot(right))).length() < 1e-6, 'and stands beside it, along its right');
    ok(r.data.setDown.blockedBy.includes('reading') && overlaps(ctx).length === 0, `and clear of it (${r.text})`);
}

// ── The gap knob: bigger → farther apart.
{
    const near = makeWorld(); near.run('carrel.create', 'a'); near.run('carrel.create', 'b');
    setSetting(null, 'carrel.createGap', 400);
    const far = makeWorld(); far.run('carrel.create', 'a'); far.run('carrel.create', 'b');
    resetSetting(null, 'carrel.createGap');
    const dist = (w) => w.ctx.carrels.get('a').position.distanceTo(w.ctx.carrels.get('b').position);
    ok(dist(far) > dist(near) + 300, `a bigger carrel.createGap sets them farther apart (${dist(near).toFixed(1)} → ${dist(far).toFixed(1)})`);
}

// ── Teeth: today's create (no slide) overlaps.
{
    const { ctx, run } = makeWorld();
    const real = CarrelModule.Carrel.prototype.airspace;
    // The slide sees nothing to avoid (every airspace empty) — the wanted spot is always taken as is.
    CarrelModule.Carrel.prototype.airspace = function (t = new THREE.Box3()) { return t.makeEmpty(); };
    run('carrel.create', 'one'); run('carrel.create', 'two'); run('carrel.create', 'three');
    CarrelModule.Carrel.prototype.airspace = real;
    ok(overlaps(ctx).length === 3, `teeth: without the slide the three overlap (${overlaps(ctx).join(' ')})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} desk-placement: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
