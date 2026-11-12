// panel-batch-shown.test.mjs — PanelBatch walks only the enrolled objects that are under its scene and
// shown, and rebuilds that list only when it can have changed (collections/PanelBatch.js).
//
//   bun tools/panel-batch-shown.test.mjs
//
// Locks:
//   - at rest the per-frame walk visits the shown panels only (stats.walked), not the hidden ones
//   - the list follows every way it can change: a hidden subtree shown and hidden again, a panel
//     added, removed, enrolled while already parented, a panel moved under another root
//   - after every change the batch's outcome (drawn / hidden / culled counts and each panel's
//     instance) equals a FRESH batch's built from scratch — teeth: a list that never rebuilds fails
//   - a panel hidden while drawn, the camera moved meanwhile, shown again: decided afresh (not its
//     stale outcome)

import * as THREE from 'three';
import SceneTransforms, { showGeneration } from '../packages/glyph3d-core/src/collections/SceneTransforms.js';
import PanelBatch, { enrollPanel } from '../packages/glyph3d-core/src/collections/PanelBatch.js';
import { createPanelMaterial } from '../packages/glyph3d-core/src/collections/panelMaterial.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const scene = new THREE.Scene();
const transforms = new SceneTransforms(scene);
const camera = new THREE.PerspectiveCamera(50, 1.6, 1, 10000);
camera.position.set(0, 0, 400);
const shown = new THREE.Group(); shown.name = 'shown';
const shut = new THREE.Group(); shut.name = 'shut'; shut.visible = false;
scene.add(shown, shut);
const geo = new THREE.PlaneGeometry(1, 1);
const panel = (x, parent, enroll = true) => {
    const m = new THREE.Mesh(geo, createPanelMaterial({ color: 0x223344, opacity: 1 }).material);
    m.scale.set(30, 20, 1);
    m.position.set(x, 0, 0);
    if (enroll) enrollPanel(m);
    parent.add(m);
    return m;
};
const a = [0, 1, 2, 3].map((i) => panel(i * 40 - 60, shown));
[0, 1, 2, 3, 4, 5].forEach((i) => panel(i * 40 - 100, shut));

const batch = new PanelBatch(scene);
const frame = () => { transforms.update(); camera.updateMatrixWorld(); return batch.update(camera); };

/** The outcome a fresh batch reaches on this scene now (counts + which objects are instanced). */
function fresh() {
    const prevHook = scene.onBeforeRender;
    const f = new PanelBatch(scene);
    const st = f.update(camera);
    const members = new Set([...f._buckets.values()].flatMap((bk) => bk.members));
    f.dispose();
    scene.onBeforeRender = prevHook;
    // dispose put every panel back on layer 0; the batch under test takes them off again next frame
    return { st, members };
}
function same(what) {
    const st = frame();
    const fr = fresh();
    frame();   // re-assert the layers dispose() handed back
    const mine = new Set([...batch._buckets.values()].flatMap((bk) => bk.members));
    const eq = st.drawn === fr.st.drawn && st.hidden === fr.st.hidden && st.culled === fr.st.culled && st.elsewhere === fr.st.elsewhere
        && mine.size === fr.members.size && [...mine].every((m) => fr.members.has(m));
    ok(eq, `${what}: the outcome equals a fresh batch's (drawn ${st.drawn}/${fr.st.drawn}, hidden ${st.hidden}/${fr.st.hidden}, culled ${st.culled}/${fr.st.culled})`);
    return st;
}

let st = same('first frame');
ok(st.walked === 4 && st.hidden === 6, `at rest it walks the 4 shown, not the 6 hidden (walked ${st.walked}, hidden ${st.hidden})`);
for (let i = 0; i < 3; i++) st = frame();
ok(st.walked === 4, 'still 4 at rest');

shut.visible = true;
st = same('the hidden group shown');
ok(st.walked === 10, `walks all 10 (${st.walked})`);
shut.visible = false;
st = same('hidden again');
ok(st.walked === 4, `back to 4 (${st.walked})`);

const late = panel(200, shown, false);
frame();                                    // the add is seen (unenrolled) …
enrollPanel(late);                          // … then enrolled while already parented: no scene change at all
st = same('a panel enrolled while already parented');
ok(st.walked === 5, `walks it (${st.walked})`);

const added = panel(-200, shown);
st = same('a panel added');
ok(st.walked === 6, `walks it (${st.walked})`);
shown.remove(added);
st = same('a panel removed');
ok(st.walked === 5, `drops it (${st.walked})`);

const other = new THREE.Scene();
new SceneTransforms(other);
other.add(a[3]);
st = same('a panel moved under another root');
ok(st.walked === 4 && st.elsewhere >= 1, `walks 4, counts it elsewhere (${st.walked}, ${st.elsewhere})`);

// Hidden while drawn, the camera moves so it would be culled, shown again: decided afresh.
const p = a[0];
p.visible = false;
frame();
camera.position.set(5000, 0, 400); camera.lookAt(5000, 0, 0);
frame();
p.visible = true;
st = same('a panel hidden while drawn, the camera moved away, shown again');
ok(![...batch._buckets.values()].some((bk) => bk.members.includes(p)), 'it is not drawn from its stale outcome');
camera.position.set(0, 0, 400); camera.lookAt(0, 0, 0);
same('the camera back');

// Teeth: a list that never rebuilds (its key pinned to "unchanged") misses a shown group.
frame();
const k = batch._shownKey, panelsAt = k.panels;
batch._shownKey = { get show() { return showGeneration(); }, set show(_v) {}, get panels() { return panelsAt; }, set panels(_v) {}, hidden: k.hidden, elsewhere: k.elsewhere };
shut.visible = true;
const t = frame();
const fr = fresh();
ok(t.drawn !== fr.st.drawn, `teeth: a list pinned to an old key misses the shown group (drawn ${t.drawn} vs fresh ${fr.st.drawn})`);

batch.dispose();
console.log(`${fails ? 'FAIL' : 'ok'} panel-batch-shown: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
