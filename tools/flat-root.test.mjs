// flat-root.test.mjs — the view's flat render list (collections/FlatRenderRoot.js) renders what
// three's walk of the scene would, and is rebuilt only when something it depends on moved.
//
//   bun tools/flat-root.test.mjs
//
// Locks:
//   - EQUIVALENT: three's projectObject (replicated: visible prunes, the layer test gates a push, the
//     nearest Group the camera sees sets the group order; lights / LODs / sprites act as they are
//     walked) yields the same render items (object × group order) and the same lights from the root
//     as from the scene — over a scene of nested containers, hidden subtrees, objects off layer 0, a
//     Group with a renderOrder, a nested renderOrder-0 Group inside it, lights, an LOD, a sprite, and
//     after every change below
//   - REBUILDS: 0 at rest; one on a layer-0 flip, a visible flip, a join, a leave, a camera mask
//     change; 0 on an idempotent disable or on a layer the camera doesn't see (pick layers)
//   - REFUSALS with teeth: a drawable with its own onBeforeRender and a shadow-casting light are
//     refused loudly (console.error naming the object), the view gets the scene itself, and the
//     refusal lifts when the object leaves; the refused scene without the refusal would be handed
//     the root (teeth: the hook sees the root)
//   - the source never writes `layers.mask =` (the generation can't see it); teeth: such a write
//     leaves the list stale, and verify() names it

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import SceneTransforms from '../packages/glyph3d-core/src/collections/SceneTransforms.js';
import FlatRenderRoot, { layerGeneration } from '../packages/glyph3d-core/src/collections/FlatRenderRoot.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

/** three's projectObject, replicated (frustum culling aside — it is per object, the same both ways). */
function project(scene, camera) {
    const items = [], lights = [];
    const walk = (o, groupOrder) => {
        if (o.visible === false) return;
        if (o.layers.test(camera.layers)) {
            if (o.isGroup) groupOrder = o.renderOrder;
            else if (o.isLOD) { /* update(camera) picks levels: the same object either way */ }
            else if (o.isLight) lights.push(o);
            else if (o.isSprite || o.isMesh || o.isLine || o.isPoints) items.push(`${o.id}:${groupOrder}`);
        }
        for (const c of o.children) walk(c, groupOrder);
    };
    walk(scene, 0);
    return { items: items.sort().join(','), lights: lights.map((l) => l.id).sort().join(','), count: items.length };
}

/** One frame through `flat` the way the renderer runs it: target, then the root's hooks. */
function frame(flat, camera) {
    const t = flat.target(camera);
    t.onBeforeRender(null, t, camera, null);
    t.onAfterRender(null, t, camera, null);
    return t;
}

const mesh = (name) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial()); m.name = name; return m; };

function world() {
    const scene = new THREE.Scene();
    new SceneTransforms(scene);
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 1e5);
    scene.add(camera);
    const a = new THREE.Object3D(); a.name = 'a';
    const b = new THREE.Group(); b.name = 'b';
    const m1 = mesh('m1'), m2 = mesh('m2'), m3 = mesh('m3');
    a.add(b); b.add(m1, m2); a.add(m3);
    const hidden = new THREE.Object3D(); hidden.name = 'hidden'; hidden.visible = false; hidden.add(mesh('h1'));
    const off = mesh('off0'); off.layers.disable(0); off.layers.enable(5);       // batched: off layer 0
    const ordered = new THREE.Group(); ordered.name = 'ordered'; ordered.renderOrder = 7;
    const inner = new THREE.Group(); inner.name = 'inner';                          // renderOrder 0 resets the group order
    const o1 = mesh('o1'), o2 = mesh('o2');
    ordered.add(o1, inner); inner.add(o2);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
    const lod = new THREE.LOD(); lod.addLevel(mesh('lod0'), 0); lod.addLevel(mesh('lod1'), 50);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial()); sprite.name = 'sprite';
    const onCam = mesh('onCamera');
    camera.add(onCam);
    // A drawable with a drawable child (a box fill and its edges): three walks a list entry's
    // subtree, so the child must not be listed again. Its twin is batched (off layer 0): its edges
    // are the entry.
    const edges = () => new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    const box = mesh('box'), boxEdge = edges(); boxEdge.name = 'boxEdge'; box.add(boxEdge);
    const boxOff = mesh('boxOff'), offEdge = edges(); offEdge.name = 'offEdge'; boxOff.add(offEdge);
    boxOff.layers.disable(0); boxOff.layers.enable(5);
    a.add(box, boxOff);
    scene.add(a, hidden, off, ordered, hemi, lod, sprite);
    scene.updateMatrixWorld();
    const flat = new FlatRenderRoot(scene);
    return { scene, camera, flat, a, b, m1, m2, m3, hidden, off, ordered, o1, o2, hemi, lod, sprite, box, boxEdge, boxOff, offEdge };
}

const same = (w, what) => {
    const t = frame(w.flat, w.camera);
    const full = project(w.scene, w.camera), flat = project(t, w.camera);
    ok(t === w.flat.root, `${what}: the view renders the flat root`);
    ok(full.items === flat.items && full.lights === flat.lights, `${what}: the root renders what the scene does (${flat.count} vs ${full.count} items)`);
    const v = w.flat.verify(w.camera);
    ok(!v.missing.length && !v.extra.length, `${what}: verify finds the list current`);
};

// ── 1. Equivalence and rebuild counts.
{
    const w = world();
    same(w, 'first frame');
    ok(w.flat.stats.rebuilds === 1, `first frame builds the list once (${w.flat.stats.rebuilds})`);
    ok(w.flat.root.children.includes(w.ordered) && !w.flat.root.children.includes(w.o1), 'a Group with a renderOrder is walked whole by three (it carries the group order)');
    ok(w.flat.root.children.includes(w.hemi) && w.flat.root.children.includes(w.lod) && w.flat.root.children.includes(w.sprite), 'a light, an LOD and a sprite are in the list');
    ok(!w.flat.root.children.includes(w.a) && !w.flat.root.children.includes(w.b), 'containers are not');
    ok(w.flat.stats.drawables === 7 && w.flat.stats.carried === 3, `drawables ${w.flat.stats.drawables} (m1 m2 m3 box offEdge onCamera sprite) · carried ${w.flat.stats.carried} (ordered hemi lod)`);
    ok(w.flat.root.children.includes(w.box) && !w.flat.root.children.includes(w.boxEdge), 'a drawable\'s drawable child is walked by three under it, never listed again (it would draw twice)');
    ok(w.flat.root.children.includes(w.offEdge) && !w.flat.root.children.includes(w.boxOff), 'under a drawable the camera doesn\'t see, the child is the entry');

    const r = () => w.flat.stats.rebuilds;
    let n = r();
    for (let i = 0; i < 10; i++) frame(w.flat, w.camera);
    ok(r() === n, `at rest: 0 rebuilds in 10 frames (${r() - n})`);

    const steps = [
        ['a layer-0 flip (a batch takes m1 off)', () => w.m1.layers.disable(0), 1],
        ['the same disable again (idempotent: the batches every frame)', () => w.m1.layers.disable(0), 0],
        ['a pick layer on and off (a layer the camera does not see)', () => { w.m2.layers.enable(3); w.m2.layers.disable(3); }, 0],
        ['m1 back on layer 0', () => w.m1.layers.enable(0), 1],
        ['a visible flip', () => { w.b.visible = false; }, 1],
        ['shown again', () => { w.b.visible = true; }, 1],
        ['a join', () => w.a.add(mesh('joiner')), 1],
        ['a leave', () => w.a.remove(w.m3), 1],
        ['a hidden subtree gains a child (the list does not care, the key moves)', () => w.hidden.add(mesh('h2')), 1],
        ['the camera sees layer 5 too', () => w.camera.layers.enable(5), 1],
        ['the batched object leaves layer 5 (the camera sees it now)', () => w.off.layers.disable(5), 1],
        ['set() on a mesh (layer 0 → 5 only)', () => w.m2.layers.set(5), 1],
        ['toggle / enableAll / disableAll', () => { w.m2.layers.toggle(0); w.m2.layers.enableAll(); w.m2.layers.disableAll(); }, 1],
        ['a box fill leaves layer 0 (a batch takes it): its edges become the entry', () => w.box.layers.disable(0), 1],
        ['and comes back', () => w.box.layers.enable(0), 1],
    ];
    for (const [what, act, want] of steps) {
        n = r();
        act();
        same(w, what);
        frame(w.flat, w.camera);
        ok(r() - n === want, `${what}: ${want} rebuild(s) (${r() - n})`);
    }

    // Disabled: the scene itself; re-enabled after a change: rebuilt, current.
    w.flat.enabled = false;
    ok(frame(w.flat, w.camera) === w.scene, 'render.flatRoot off: the view renders the scene');
    w.a.add(mesh('whileOff'));
    w.flat.enabled = true;
    same(w, 're-enabled after a change while off');

    // A camera that doesn't see layer 0 (a pick or overlay camera) gets the scene.
    const pickCam = new THREE.PerspectiveCamera(); pickCam.layers.set(4);
    ok(w.flat.target(pickCam) === w.scene, 'a camera off layer 0 renders the scene itself');
}

// ── 2. The scene's hooks run first and the list is collected after them (a batch flipping a layer
//       in onBeforeRender is in THIS frame's list), and both hooks get the scene, not the root.
{
    const w = world();
    const seen = [];
    w.scene.onBeforeRender = (_r, sc) => { seen.push(sc === w.scene); w.m2.layers.disable(0); };
    w.scene.onAfterRender = (_r, sc) => { seen.push(sc === w.scene); };
    same(w, 'a hook flips a layer before the list is collected');
    ok(!w.flat.root.children.includes(w.m2), 'the flipped object is out of this frame\'s list');
    ok(seen.length === 2 && seen.every(Boolean), `the scene's own hooks are handed the scene (${seen})`);
}

// ── 3. Refusals, loud, lifted when the object leaves — with teeth.
{
    const errors = [];
    const origError = console.error, origWarn = console.warn;
    console.error = (m) => errors.push(String(m));
    console.warn = () => {};
    try {
        const w = world();
        same(w, 'before the refusal');
        const hooked = mesh('hooked');
        let sceneSeen = null;
        hooked.onBeforeRender = (_r, sc) => { sceneSeen = sc; };
        w.b.add(hooked);
        let t = frame(w.flat, w.camera);
        ok(w.flat.refused && /onBeforeRender/.test(w.flat.refused.reason) && /hooked/.test(w.flat.refused.object), `a drawable with its own onBeforeRender is refused, named (${w.flat.refused?.object})`);
        ok(errors.length === 1 && /REFUSED/.test(errors[0]) && /hooked/.test(errors[0]), 'loudly: one console.error naming it');
        ok(t.children === w.scene.children || t === w.scene, 'the refusal frame renders the full walk');
        t = frame(w.flat, w.camera);
        ok(t === w.scene, 'after it: the view renders the scene itself');
        for (let i = 0; i < 5; i++) frame(w.flat, w.camera);
        ok(errors.length === 1, `refused at rest: no repeated record (${errors.length})`);
        // Teeth: had the list served this scene, three would hand the hook the root.
        const forced = new FlatRenderRoot(w.scene);
        forced._collect = function (_o, out) { out.push(hooked); return null; };
        const ft = forced.target(w.camera);
        ft.onBeforeRender(null, ft, w.camera, null);
        hooked.onBeforeRender(null, ft, w.camera);   // what three's renderObject does with the list's scene
        ok(sceneSeen === forced.root, 'teeth: through an unrefused list the hook would be handed the root, not the scene');

        w.b.remove(hooked);
        t = frame(w.flat, w.camera);
        ok(t === w.flat.root && !w.flat.refused, 'the hook gone: the list serves again');
        same(w, 'after the refusal lifts');

        const sun = new THREE.DirectionalLight(); sun.castShadow = true; sun.name = 'sun';
        w.a.add(sun);
        frame(w.flat, w.camera);
        ok(/shadow/.test(w.flat.refused?.reason ?? '') && /sun/.test(w.flat.refused.object), `a shadow-casting light is refused, named (${w.flat.refused?.object})`);
        ok(errors.length === 2, `and recorded (${errors.length} records)`);
        sun.castShadow = false; w.a.remove(sun); w.a.add(sun);   // a change the key sees
        frame(w.flat, w.camera);
        ok(!w.flat.refused, 'a light that casts no shadow serves (three walks it from the list)');
        same(w, 'with a plain light');

        // The fat lines' own hook reads only the renderer: served (the ownership traces are fat lines).
        const fat = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial());
        fat.name = 'fat';
        w.a.add(fat);
        frame(w.flat, w.camera);
        ok(!w.flat.refused && w.flat.root.children.includes(fat), 'a fat line (LineSegments2) is served: its hook never reads the scene');
        same(w, 'with a fat line');

        // A hidden or off-layer hooked drawable is no refusal: three would never hand it the scene.
        const quiet = mesh('quiet'); quiet.onBeforeRender = () => {}; quiet.layers.set(6);
        w.a.add(quiet);
        frame(w.flat, w.camera);
        ok(!w.flat.refused, 'a hooked drawable the camera doesn\'t see is no refusal');
    } finally {
        console.error = origError; console.warn = origWarn;
    }
}

// ── 4. No direct `layers.mask =` write in the source (the generation can't see one) — and its teeth.
{
    const hits = execSync(`rg -n --glob '!**/node_modules/**' --glob '!**/dist/**' -e 'layers\\.mask\\s*=[^=]' packages app tools || true`, { encoding: 'utf8' })
        .split('\n').filter(Boolean)
        .filter((l) => !/^tools\/flat-root\.test\.mjs:/.test(l))
        .filter((l) => !/^\S+:\d+:\s*(\*|\/\/)/.test(l));   // doc comments
    ok(hits.length === 0, `no direct layers.mask write in the source (${hits.join(' | ')})`);
    const w = world();
    frame(w.flat, w.camera);
    const g = layerGeneration(1);
    w.m1.layers.mask = 0;   // the write the scan forbids
    frame(w.flat, w.camera);
    const v = w.flat.verify(w.camera);
    ok(layerGeneration(1) === g && v.extra.includes(w.m1), 'teeth: a direct mask write moves no generation, and verify names the stale entry');
}

// Sanity: the module header names its gates.
ok(/flat-root\.test\.mjs/.test(readFileSync(new URL('../packages/glyph3d-core/src/collections/FlatRenderRoot.js', import.meta.url), 'utf8')), 'the module names this gate');

console.log(`${fails ? 'FAIL' : 'ok'} flat-root: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
