// render-passes.test.mjs — the frame has ONE render owner (app/client/FramePasses.js + the
// <RenderPasses/> loop, RenderPasses.jsx), on real react-three-fiber (createRoot, frameloop 'never',
// advance()) over a recording renderer.
//
//   bun tools/render-passes.test.mjs   (run from the repo root; resolves react + r3f from app/)
//
// Locks:
//   - the passes draw in the declared order (main → overlay → cloud → minimap), each exactly once a
//     frame, and r3f draws nothing itself (the owner took the loop)
//   - main renders the flat root's target when one serves, else the scene
//   - a pass that throws is logged once, by name, and the passes after it still draw
//   - names are unique; every frame pass is timed; off-frame work (cards, picks) reports with record
//   - the minimap pass follows the `minimap` prop (declared on, removed off)
//   - a SECOND positive-priority useFrame (another loop owner) is a fault: recorded, console.error
//     naming it once, scene stays drawn (the owner keeps rendering — never a frozen display); it
//     clears when the offender unmounts
// Mutation-checked: dropping the loop check, the ordering, or the per-pass catch each fails it.

import './headless-canvas.mjs';
import * as THREE from 'three';
import { createRequire } from 'node:module';

const req = createRequire(new URL('../app/package.json', import.meta.url));
const React = req('react');
const { createRoot, useFrame, advance } = req('@react-three/fiber');
const { default: FramePasses, PASS_ORDER } = await import('../app/client/FramePasses.js');
const { default: RenderPasses } = await import('../app/client/RenderPasses.jsx');

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const h = React.createElement;

/** A renderer that records what it is asked to draw. */
function recordingRenderer() {
    const calls = [];
    return {
        calls,
        render: (s) => calls.push(`render:${s.name || s.type}`),
        setSize() {}, setPixelRatio() {}, getPixelRatio: () => 1, getSize: (v) => v.set(800, 600),
        xr: { enabled: false, setAnimationLoop() {}, addEventListener() {}, removeEventListener() {}, isPresenting: false },
        shadowMap: {}, setAnimationLoop() {}, getContext: () => ({}), info: { render: {} }, dispose() {},
        setScissorTest() {}, setViewport() {}, setScissor() {},
    };
}

async function mount(element, gl) {
    const canvas = document.createElement('canvas');
    gl.domElement = canvas;
    const root = createRoot(canvas);
    await root.configure({ gl: () => gl, frameloop: 'never', size: { width: 800, height: 600, top: 0, left: 0 } });
    root.render(element);
    await new Promise((r) => setTimeout(r, 30));
    return root;
}
const frame = () => advance(performance.now(), true);
const settle = () => new Promise((r) => setTimeout(r, 30));

const scene = new THREE.Scene(); scene.name = 'main-scene';
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
try {
    // ── Order, once each, r3f silent.
    const gl = recordingRenderer();
    const passes = new FramePasses({ renderer: gl, scene });
    const seen = [];
    passes.add('cloud', PASS_ORDER.cloud, () => seen.push('cloud'));
    passes.add('overlay', PASS_ORDER.overlay, () => seen.push('overlay'));
    const registry = { toArray: () => [] };
    const Host = ({ minimap, rogue }) => h(React.Fragment, null,
        h(RenderPasses, { passes, registry, minimap }),
        rogue ? h(Rogue) : null);
    function Rogue() { useFrame(function rogueLoopOwner(s) { s.gl.render(s.scene, s.camera); }, 1); return null; }
    const root = await mount(h(Host, { minimap: false, rogue: false }), gl);
    gl.calls.length = 0;
    frame();
    ok(JSON.stringify(passes.order()) === JSON.stringify(['main', 'overlay', 'cloud']), `declared order (${passes.order()})`);
    ok(gl.calls.length === 1 && gl.calls[0] === 'render:main-scene', `one main render a frame, r3f draws nothing itself (${gl.calls})`);
    ok(seen.join() === 'overlay,cloud', `overlay then cloud, once each (${seen})`);

    // main renders the flat root's target when it serves.
    const flatScene = new THREE.Scene(); flatScene.name = 'flat-root';
    passes.flatRoot = { target: () => flatScene };
    gl.calls.length = 0; frame();
    ok(gl.calls[0] === 'render:flat-root', `main renders the flat root's target (${gl.calls[0]})`);
    passes.flatRoot = null;

    // The minimap follows its prop (its pass renders its own scene into the corner).
    root.render(h(Host, { minimap: true, rogue: false }));
    await settle();
    ok(passes.order().join() === 'main,overlay,cloud,minimap', `minimap on: declared last (${passes.order()})`);
    gl.calls.length = 0; seen.length = 0; frame();
    ok(gl.calls.length === 2 && gl.calls[1] !== 'render:main-scene', `and draws after the rest (${gl.calls})`);
    root.render(h(Host, { minimap: false, rogue: false }));
    await settle();
    ok(!passes.order().includes('minimap'), 'minimap off: removed');

    // A failing pass: named once, the rest still draw.
    passes.add('broken', 15, () => { throw new Error('boom'); });
    seen.length = 0; errors.length = 0;
    frame(); frame();
    ok(seen.join() === 'overlay,cloud,overlay,cloud', `a throwing pass doesn't stop the ones after it (${seen})`);
    ok(errors.length === 1 && /pass 'broken' failed/.test(errors[0]), `logged once, by name (${errors.length}: ${errors[0]?.slice(0, 60)})`);
    passes.remove('broken');

    // Names unique; timing.
    let threw = false;
    try { passes.add('overlay', 99, () => {}); } catch { threw = true; }
    ok(threw, 'a second pass with a taken name throws');
    passes.record('pick', 0.7); passes.record('cards', 1.2);
    const st = Object.fromEntries(passes.stats().map((s) => [s.name, s]));
    ok(st.main.frame && st.main.count === passes.frames && st.overlay.count === passes.frames, `every frame pass timed every frame (${st.main.count}/${passes.frames})`);
    ok(!st.pick.frame && st.pick.last === 0.7 && !st.cards.frame && st.cards.count === 1, 'off-frame work reported with record');

    // ── A second loop owner: loud, recorded, the frame still drawn.
    errors.length = 0;
    root.render(h(Host, { minimap: false, rogue: true }));
    await settle();
    gl.calls.length = 0;
    frame(); frame();
    ok(passes.fault && passes.fault.offenders.length === 1 && /rogueLoopOwner/.test(passes.fault.offenders[0]), `a second positive-priority useFrame is a fault naming it (${passes.fault?.offenders})`);
    ok(errors.filter((e) => /second render-loop owner/.test(e)).length === 1, `logged loudly, once (${errors.length})`);
    ok(gl.calls.filter((c) => c === 'render:main-scene').length >= 2, 'and the owner keeps drawing the frame (never frozen)');
    root.render(h(Host, { minimap: false, rogue: false }));
    await settle();
    frame();
    ok(passes.fault === null, 'the fault clears when the offender goes');

    root.unmount();
} finally {
    console.error = origError;
}

console.log(`${fails ? 'FAIL' : 'ok'} render-passes: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
