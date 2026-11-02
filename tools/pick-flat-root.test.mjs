// pick-flat-root.test.mjs — each pick channel renders its flat list (PickingSystem.flatLists,
// collections/FlatRenderRoot.js): the pass draws what three's walk of the scene would, and a list is
// rebuilt only when something on ITS layer (or visibility, membership) moved.
//
//   bun tools/pick-flat-root.test.mjs
//
// Locks, on a real PickingSystem over a SceneTransforms scene (the renderer records each pass and
// replicates three's projectObject over whatever it is handed):
//   - EQUIVALENT: every channel's pass yields the same render items (object × group order × the pick
//     material swapped in) flat as full — glyph fields, panels, handles, volumes, a mesh hidden by an
//     ancestor, one in a hidden subtree, a fully cut panel (drawn by neither) — after every change
//   - REBUILDS: 0 over many picks at rest (the pick camera's per-pass layers.set moves nothing — teeth:
//     a watched pick camera rebuilds every pass); a registration rebuilds only its channel's list, never
//     the view's; a view-only layer flip (a batch taking a panel off layer 0) rebuilds no pick list; a
//     visible flip rebuilds the lists that read it; a fully cut panel picked over and over rebuilds
//     nothing (teeth: the old layer-toggle cut rebuilds the grid list every pick)
//   - flatLists off: the pass renders the scene itself

import * as THREE from 'three';
import SceneTransforms from '../packages/glyph3d-core/src/collections/SceneTransforms.js';
import FlatRenderRoot, { unwatchLayers } from '../packages/glyph3d-core/src/collections/FlatRenderRoot.js';
import { PickingSystem } from '../packages/glyph3d-core/src/picking/PickingSystem.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

/** three's projectObject, replicated (as tools/flat-root.test.mjs): render items incl. the material drawn. */
function project(scene, camera) {
    const items = [];
    const walk = (o, groupOrder) => {
        if (o.visible === false) return;
        if (o.layers.test(camera.layers)) {
            if (o.isGroup) groupOrder = o.renderOrder;
            else if ((o.isMesh || o.isLine || o.isPoints) && o.material.visible) items.push(`${o.id}:${groupOrder}:${o.material.id}`);
        }
        for (const c of o.children) walk(c, groupOrder);
    };
    walk(scene, 0);
    return items.sort().join(',');
}

/** A renderer that runs a render's hooks and records what three's walk would draw. */
class RecordingRenderer {
    constructor() { this.passes = []; }
    getSize(v) { return v.set(800, 600); }
    setRenderTarget() {} getRenderTarget() { return null; } clear() {}
    getClearAlpha() { return 1; } getClearColor(c) { return c; } setClearColor() {}
    render(scene, camera) {
        scene.onBeforeRender(this, scene, camera, null);
        this.passes.push({ scene, items: project(scene, camera), layer: Math.log2(camera.layers.mask) });
        scene.onAfterRender(this, scene, camera, null);
    }
}

const mesh = (name, layer0 = true) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    m.name = name;
    if (!layer0) m.layers.disable(0);
    return m;
};
const instanced = (name) => {
    const g = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
    g.instanceCount = 10;
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    m.name = name;
    return m;
};

function world() {
    const scene = new THREE.Scene();
    new SceneTransforms(scene);
    const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 1e5);
    scene.add(camera);
    camera.position.set(0, 0, 50); camera.updateMatrixWorld();
    const ps = new PickingSystem(new RecordingRenderer());
    ps._target = new THREE.WebGLRenderTarget(4, 1);
    const desk = new THREE.Object3D(); desk.name = 'desk';
    const g1 = instanced('glyphs1'), g2 = instanced('glyphs2');
    const spare = instanced('spare');   // in the scene, registered later
    const p1 = mesh('panel1'), p2 = mesh('panel2', false);   // p2: batched (off layer 0)
    const handle = mesh('handle'), vol = mesh('volume');
    const shut = new THREE.Object3D(); shut.name = 'shut'; shut.visible = false;
    const g3 = instanced('glyphsShut');
    desk.add(g1, g2, p1, p2, handle, vol, spare); shut.add(g3);
    const ordered = new THREE.Group(); ordered.name = 'ordered'; ordered.renderOrder = 4;
    ordered.layers.enable(8);   // on the grid channel's layer: three takes its order for the panel under it
    const p3 = mesh('panelOrdered'); ordered.add(p3);
    scene.add(desk, shut, ordered, mesh('scenery'));
    scene.updateMatrixWorld();
    const tok = (n) => ({ name: n });   // a glyph token stands for its field (the pick material reads it)
    ps.register('glyph', g1, tok('g1')); ps.register('glyph', g2, tok('g2')); ps.register('glyph', g3, tok('g3'));
    ps.register('grid', p1, tok('p1')); ps.register('grid', p2, tok('p2')); ps.register('grid', p3, tok('p3'));
    ps.register('handle', handle, tok('h')); ps.register('group', vol, tok('v'));
    const view = new FlatRenderRoot(scene);
    return { scene, camera, ps, view, g1, g2, g3, p1, p2, p3, handle, vol, desk, shut, ordered, spare };
}

/** One pick's passes (all channels), flat and full; true when every channel's items match. */
function pickBoth(w) {
    const pc = w.ps._pixelCamera(w.camera, 400, 300, 800, 600);
    const out = {};
    for (const flat of [true, false]) {
        w.ps.flatLists = flat;
        w.ps._renderer.passes = [];
        [...w.ps._channels.values()].forEach((ch, i) => w.ps._renderChannelPass(ch, pc, w.scene, i));
        out[flat ? 'flat' : 'full'] = w.ps._renderer.passes;
    }
    w.ps.flatLists = true;
    const same = out.flat.every((p, i) => p.items === out.full[i].items);
    const served = out.flat.every((p) => p.scene !== w.scene) && out.full.every((p) => p.scene === w.scene);
    return { same, served, out };
}
const rebuilds = (w) => Object.fromEntries([...w.ps.flatRoots].map(([n, r]) => [n, r.stats.rebuilds]));
const diff = (a, b) => Object.keys(b).filter((k) => b[k] !== (a[k] ?? 0));
const viewFrame = (w) => { const t = w.view.target(w.camera); t.onBeforeRender(null, t, w.camera, null); };

{
    const w = world();
    viewFrame(w);
    let r = pickBoth(w);
    ok(r.served, 'flat passes render each channel\'s root; flatLists off renders the scene');
    ok(r.same, `first pick: every channel draws the same items flat as full (${r.out.flat.map((p) => p.items.split(',').filter(Boolean).length).join('/')})`);
    ok(r.out.flat[1].items.includes(`${w.p2.id}:`), 'a batched panel (off layer 0) is still in the grid channel');
    ok(!r.out.flat[0].items.includes(`${w.g3.id}:`), 'a glyph field in a hidden subtree is in neither');
    ok(w.ps.flatRoots.get('grid').root.children.includes(w.ordered), 'a Group with a renderOrder over a picked panel is walked whole');

    let b = rebuilds(w), vb = w.view.stats.rebuilds;
    for (let i = 0; i < 20; i++) { viewFrame(w); pickBoth(w); }
    ok(diff(b, rebuilds(w)).length === 0 && w.view.stats.rebuilds === vb, `20 picks + frames at rest: 0 rebuilds (${JSON.stringify(rebuilds(w))}, view ${w.view.stats.rebuilds - vb})`);

    const steps = [
        ['a glyph field registers', () => { const g = instanced('late'); w.desk.add(g); w.scene.updateMatrixWorld(); }, null],   // a join: show gen moves everything
        ['a registration on glyph (a field already in the scene)', () => w.ps.register('glyph', w.spare, { name: 'sp' }), ['glyph']],
        ['its unregistration', () => w.ps.unregister('glyph', w.spare), ['glyph']],
        ['a batch takes a panel off layer 0 (view only)', () => w.p1.layers.disable(0), []],
        ['a volume registers on group (its layer only)', () => w.ps.register('group', w.p1, { name: 'pv' }), ['group']],
        ['a visible flip', () => { w.desk.visible = false; }, ['glyph', 'grid', 'handle', 'group']],
        ['shown again', () => { w.desk.visible = true; }, ['glyph', 'grid', 'handle', 'group']],
    ];
    for (const [what, act, want] of steps) {
        b = rebuilds(w); vb = w.view.stats.rebuilds;
        act();
        viewFrame(w);
        r = pickBoth(w);
        ok(r.same, `${what}: every channel draws the same items flat as full`);
        const moved = diff(b, rebuilds(w)).sort();
        if (want) ok(moved.join() === [...want].sort().join(), `${what}: rebuilt ${moved.join(',') || 'nothing'} (want ${want.join(',') || 'nothing'})`);
        if (what.includes('registration') || what.includes('registers on')) ok(w.view.stats.rebuilds === vb, `${what}: the view's list is not rebuilt`);
    }

    // A fully cut panel: drawn by neither path, and picking it over and over rebuilds nothing.
    w.p3.userData.panelClip = { left: 1e6, right: 1e6 + 1, top: 0, bottom: -1 };
    viewFrame(w); pickBoth(w);
    b = rebuilds(w);
    for (let i = 0; i < 5; i++) r = pickBoth(w);
    ok(r.same && !r.out.flat[1].items.includes(`${w.p3.id}:`), 'a fully cut panel is drawn by neither path');
    ok(diff(b, rebuilds(w)).length === 0, `and 5 picks over it rebuild nothing (${JSON.stringify(rebuilds(w))})`);
    ok(w.p3.layers.isEnabled(8) && w.p3.material.visible, 'its layer and material are as they were');
    // Teeth: the old cut (the layer off for the pass, back on after) rebuilds the grid list each pick.
    const grid = w.ps.flatRoots.get('grid');
    const before = grid.stats.rebuilds;
    for (let i = 0; i < 3; i++) { w.p3.layers.disable(8); pickBoth(w); w.p3.layers.enable(8); }
    ok(grid.stats.rebuilds - before >= 3, `teeth: toggling the layer around the pass rebuilds the grid list every pick (${grid.stats.rebuilds - before})`);
    delete w.p3.userData.panelClip;

    // Teeth: a pick camera whose layers count (not unwatched) rebuilds the lists every pass.
    const watched = new THREE.PerspectiveCamera(); watched.copy(w.camera, false); watched.matrixWorldAutoUpdate = false;
    b = rebuilds(w);
    for (let i = 0; i < 3; i++) [...w.ps._channels.values()].forEach((ch, k) => w.ps._renderChannelPass(ch, watched, w.scene, k));
    ok(diff(b, rebuilds(w)).length > 0, `teeth: a watched pick camera's per-pass layers.set rebuilds the lists (${JSON.stringify(rebuilds(w))})`);
    unwatchLayers(watched.layers);
    for (const ch of w.ps._channels.values()) w.ps._renderChannelPass(ch, watched, w.scene, 0);   // settle once
    b = rebuilds(w);
    for (let i = 0; i < 3; i++) [...w.ps._channels.values()].forEach((ch, k) => w.ps._renderChannelPass(ch, watched, w.scene, k));
    ok(diff(b, rebuilds(w)).length === 0, 'unwatched, the same passes rebuild nothing');

    // Every list current, checked against a fresh walk.
    for (const [n, root] of w.ps.flatRoots) {
        const v = root.verify();
        ok(!v.missing.length && !v.extra.length && !v.refused, `pick ${n}: verify finds the list current`);
    }
}

// A scene without a SceneTransforms is refused at the seam (its show generation would never move).
{
    const ps = new PickingSystem(new RecordingRenderer());
    ps._target = new THREE.WebGLRenderTarget(4, 1);
    ps.flatLists = true;
    const bare = new THREE.Scene(), m = mesh('m');
    bare.add(m); ps.register('grid', m, { name: 'm' });
    let msg = '';
    try { ps._renderChannelPass(ps._channel('grid'), new THREE.PerspectiveCamera(), bare, 0); } catch (e) { msg = e.message; }
    ok(/SceneTransforms/.test(msg), `an untracked scene is refused by name (${msg})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} pick-flat-root: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
