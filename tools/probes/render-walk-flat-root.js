// render-walk-flat-root.js — the flat-render-root PROTOTYPE of docs/planes/RENDER-WALK.md, installed page-side
// (nothing in the tree): checks its preconditions, compares one frame pixel for pixel, then leaves
// itself on and reports how often the collected list changed over 4 s. Run through frame-profile:
//   --eval "$(cat tools/probes/render-walk-flat-root.js)"
(async () => {
  const ctx = window.__glyphClient.ctx, r = ctx.renderer, scene = ctx.scene, cam = ctx.camera, THREE = ctx.cameraController.THREE;
  // Preconditions a flat render root must respect.
  let groupsWithOrder = 0, lights = 0, sprites = 0, ownHooks = 0, ownHookNames = new Set();
  scene.traverse((o) => {
    if (o.isGroup && o.renderOrder !== 0) { let d = false; o.traverse((c) => { if (c !== o && (c.isMesh || c.isLine)) d = true; }); if (d) groupsWithOrder++; }
    if (o.isLight) lights++;
    if (o.isSprite) sprites++;
    if ((o.isMesh || o.isLine) && o.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) { ownHooks++; ownHookNames.add(o.name || o.constructor.name); }
  });
  // The flat root: a Scene sharing the real one's look, its children = shown layer-0 drawables.
  const root = new THREE.Scene();
  root.matrixWorldAutoUpdate = false;
  root.background = scene.background; root.fog = scene.fog; root.environment = scene.environment;
  const collect = (o, out, layers) => {
    if (o.visible === false) return;
    if ((o.isMesh || o.isLine || o.isPoints || o.isSprite || o.isLight) && o.layers.test(layers)) out.push(o);
    const ch = o.children; for (let i = 0; i < ch.length; i++) collect(ch[i], out, layers);
  };
  let collectMs = 0, collects = 0, listLen = 0, changed = 0, prev = [];
  root.onBeforeRender = function (renderer, _s, camera, target) {
    scene.onBeforeRender(renderer, scene, camera, target);   // the batches flip layers here
    const t0 = performance.now();
    const out = [];
    collect(scene, out, camera.layers);
    root.children = out;
    collectMs += performance.now() - t0; collects++; listLen = out.length;
    if (out.length !== prev.length || out.some((o, i) => o !== prev[i])) changed++;
    prev = out;
  };
  root.onAfterRender = function (renderer, _s, camera, target) { scene.onAfterRender(renderer, scene, camera, target); };
  const orig = r.render;
  const flat = function (s, c) {
    if (s === scene && c.layers.isEnabled(0)) { scene.updateMatrixWorld(); return orig.call(this, root, c); }
    return orig.call(this, s, c);
  };
  // Pixel check: one frame each way, same camera, read back.
  const gl = r.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, px = new Uint8Array(W * H * 4);
  const shot = () => { r.render(scene, cam); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); let h = 0, ink = 0; for (let i = 0; i < px.length; i++) { h = (h * 31 + px[i]) >>> 0; if (px[i] > 40 && (i & 3) !== 3) ink++; } return { h, ink, copy: px.slice() }; };
  await new Promise((res) => requestAnimationFrame(res));
  const a = shot();
  r.render = flat;
  const b = shot();
  let diff = 0, maxd = 0;
  for (let i = 0; i < px.length; i++) { const d = Math.abs(a.copy[i] - b.copy[i]); if (d) { diff++; if (d > maxd) maxd = d; } }
  // Leave the flat root on for the profile window (window.__flatStats reads its costs).
  window.__flatStats = () => ({ collectMsPerRender: +(collectMs / Math.max(1, collects)).toFixed(3), listLen, collects, listChanged: changed });
  collectMs = 0; collects = 0; changed = 0;
  await new Promise((res) => setTimeout(res, 4000));
  const churn = window.__flatStats();
  return { churn, groupsWithOrder, lights, sprites, ownHooks, ownHookNames: [...ownHookNames].slice(0, 8), hashSame: a.h === b.h, inkA: a.ink, inkB: b.ink, bytesDiffering: diff, maxDiff: maxd, listLen };
})()
