// render-walk-census.js — a page-side census of what three's projectObject visits each frame, for
// docs/planes/RENDER-WALK.md. Run through frame-profile:  --eval "$(cat tools/probes/render-walk-census.js)"
(async () => {
  const ctx = window.__glyphClient.ctx, scene = ctx.scene, cam = ctx.camera, THREE = ctx.THREE || window.THREE;
  const proj = new cam.projectionMatrix.constructor().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const planes = []; const m = proj.elements;
  const mk = (a,b,c,d) => { const l = Math.hypot(a,b,c); return [a/l,b/l,c/l,d/l]; };
  planes.push(mk(m[3]-m[0],m[7]-m[4],m[11]-m[8],m[15]-m[12]), mk(m[3]+m[0],m[7]+m[4],m[11]+m[8],m[15]+m[12]),
              mk(m[3]+m[1],m[7]+m[5],m[11]+m[9],m[15]+m[13]), mk(m[3]-m[1],m[7]-m[5],m[11]-m[9],m[15]-m[13]),
              mk(m[3]-m[2],m[7]-m[6],m[11]-m[10],m[15]-m[14]), mk(m[3]+m[2],m[7]+m[6],m[11]+m[10],m[15]+m[14]));
  const sphereIn = (o) => {
    const g = o.geometry; if (!g) return true;
    if (!g.boundingSphere) g.computeBoundingSphere?.();
    const bs = o.boundingSphere ?? g.boundingSphere; if (!bs) return true;
    const e = o.matrixWorld.elements, c = bs.center;
    const x = e[0]*c.x+e[4]*c.y+e[8]*c.z+e[12], y = e[1]*c.x+e[5]*c.y+e[9]*c.z+e[13], z = e[2]*c.x+e[6]*c.y+e[10]*c.z+e[14];
    const s = Math.max(Math.hypot(e[0],e[1],e[2]), Math.hypot(e[4],e[5],e[6]), Math.hypot(e[8],e[9],e[10]));
    const r = bs.radius * s;
    for (const p of planes) if (p[0]*x+p[1]*y+p[2]*z+p[3] < -r) return false;
    return true;
  };
  const generic = new Set(['Object3D','Group','Mesh','LineSegments','Line','Points','Sprite','InstancedMesh','LineSegments2','Line2','Scene']);
  const C = { visited: 0, pruned: 0, invisibleRoots: 0, container: 0, drawOff0: 0, batchedPanel: 0, batchedLabel: 0, pickOnly: 0, on0Culled: 0, on0Drawn: 0, on0NoCull: 0 };
  const byOwner = new Map(), byType = new Map();
  const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  const subtree = (o) => { let n = 1; for (const c of o.children) n += subtree(c); return n; };
  const walk = (o, owner) => {
    if (o.visible === false) { C.invisibleRoots++; C.pruned += subtree(o); return; }
    C.visited++;
    const cn = o.constructor?.name || o.type;
    if (!generic.has(cn)) owner = cn;
    bump(byOwner, owner); bump(byType, cn);
    const on0 = o.layers.test(cam.layers);
    const drawable = o.isMesh || o.isLine || o.isPoints || o.isSprite;
    if (!drawable) C.container++;
    else if (!on0) {
      C.drawOff0++;
      if (o.userData?.glyphBatched) C.batchedLabel++;
      else if (o.material?.userData?.panelBatchDispose) C.batchedPanel++;
      else C.pickOnly++;
    } else if (!o.frustumCulled) C.on0NoCull++;
    else if (sphereIn(o)) C.on0Drawn++; else C.on0Culled++;
    for (const c of o.children) walk(c, owner);
  };
  walk(scene, 'Scene');
  // renders of the main scene per frame
  const r = ctx.renderer; const orig = r.render; let calls = 0, frames = 0;
  r.render = function (s, c) { if (s === scene) calls++; return orig.call(this, s, c); };
  await new Promise((res) => { const t0 = performance.now(); const tick = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
  r.render = orig;
  // a replica of projectObject's walk alone (visible + layers + recursion), timed
  const rep = (o, n) => { if (o.visible === false) return n; o.layers.test(cam.layers); n++; const ch = o.children; for (let i = 0; i < ch.length; i++) n = rep(ch[i], n); return n; };
  let n = 0; const t0 = performance.now(); for (let i = 0; i < 50; i++) n = rep(scene, 0); const walkMs = (performance.now() - t0) / 50;
  const top = (map, k = 14) => [...map].sort((a, b) => b[1] - a[1]).slice(0, k);
  return { C, rendersOfMainScenePerFrame: +(calls / frames).toFixed(2), frames, replicaWalkMs: +walkMs.toFixed(3), replicaVisits: n, byOwner: top(byOwner), byType: top(byType),
           batches: { panel: ctx.panelBatch?.stats ?? null, glyph: ctx.glyphBatch?.stats ?? null } };
})()
