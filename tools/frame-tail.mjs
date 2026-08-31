// frame-tail.mjs — DOES IT HOLD 60? The capped counterpart to frame-anatomy.mjs.
//
// frame-anatomy answers "what is in a frame" and, with ANATOMY_UNCAPPED=1, "how much
// headroom is there". Neither answers the question a human actually asks, which is
// "does it stutter when I fly around". This does.
//
// THE TWO RULES THIS TOOL EXISTS TO ENFORCE (learned 2026-08-30, the hard way):
//
//   1. MEASURE CAPPED. Uncapped (--disable-gpu-vsync) pins the GPU, starves the window
//      server, and makes the human's desktop stutter — which then gets reported as an
//      app bug. It also measures throughput against a saturated queue, not whether a
//      frame fits in 16.7ms. Two builds with a real 2x GPU-cost difference both hold a
//      flat 60fps capped; only uncapped separates them, and that separation is a
//      headroom fact, not a stutter fact.
//
//   2. UNDER VSYNC, p50 IS WORTHLESS. It is 16.7ms by construction whether there is 4x
//      headroom or none. Stutter lives in the TAIL. This reports p95/p99/max and the
//      COUNT of frames past 16.7ms — the number that means "stutter" in the only sense
//      the person at the desk cares about.
//
// Every row also prints the scene state it INTENDED (grids, glyphs, camera distance,
// approximate on-screen glyph px), because a camera verb that silently no-ops produces
// a row that reads like a clean result at the wrong pose. That has happened here.
//
// WHAT THE NUMBERS MEAN (measured 2026-08-30, dictgen 694 files):
//   Frame time at overview is LINEAR in instances actually DRAWN: ~4.11 ms per million.
//   The 60fps budget is therefore ~4.0M drawn instances. Everything else tested came back
//   negative — fragment/LOD cost, vertex alpha-cull, draw-call count, JS heap, GC — so
//   `drawn` is the column to watch and the only one that has ever moved the frame time.
//
//   `drawn` comes from the INDIRECT buffer, not geometry.instanceCount. Per-view frustum
//   culling already works (MegaGlyphField._cullRanges): near draws 1.99M of the same
//   19.55M-instance scene that overview draws whole. When everything is genuinely on
//   screen there is nothing left to cull, and the only lever is substitution — fewer
//   instances per file at distance.
//
//   ms/Minst IS ONLY MEANINGFUL WHEN THE ROW IS MISSING VSYNC. A pose comfortably inside
//   budget reports the 16.7ms CAP divided by its instances, which inflates the figure and
//   says nothing about cost (a `near` row reading 7.30 next to an `overview` row reading
//   4.12 is not a regression — it is the cap). Read it only on rows at ~100% >16.7ms.
//
//   bun tools/frame-tail.mjs --url http://localhost:5174/ --dir packages --label post-lod
//   bun tools/frame-tail.mjs --url http://localhost:5174/ --dir . --seconds 6
import { launchGpuBrowser, openApp, assertRealGpu } from './itest/driver.mjs';

const argv = process.argv.slice(2);
const get = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const URL_ = get('--url', 'http://localhost:5173/');
const DIR = get('--dir', null);
const RELAY = Number(get('--relay', 8099));
const SECONDS = Number(get('--seconds', 5));
const LABEL = get('--label', 'tree');
const VSYNC_MS = 16.7;

const pct = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN;

// CAPPED on purpose — see rule 1 above. There is deliberately no --uncapped flag here.
const browser = await launchGpuBrowser({});
try {
  const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 7000, session: 'off' });
  const gpu = await assertRealGpu(app, { tool: 'frame-tail' });
  console.log(`[gpu] ${gpu.vendor}/${gpu.architecture}   [tree] ${LABEL}`);
  if (!app.booted) { console.error('did not boot'); process.exit(1); }

  if (DIR) {
    const t0 = Date.now();
    const r = await app.cmd(`file.openDir ${DIR}`);
    console.log(`load: ${(r.text || '').split('\n')[0].slice(0, 76)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    await app.waitFor(8000);
  }

  await app.evalPage(() => {
    const c = window.__glyphClient.ctx;
    const gl = c.renderer;
    window.__ft = { s: [], on: false, draws: 0, tris: 0, renders: 0 };
    // Draw calls / triangles must be read as PER-RENDER DELTAS: three resets info at the
    // start of every render() call, so a sample taken between frames sees only the last
    // pass. Wrap it, same as frame-anatomy does.
    const orig = gl.render.bind(gl);
    gl.render = (sc, cam) => {
      const d0 = gl.info.render.drawCalls, t0 = gl.info.render.triangles;
      const r = orig(sc, cam);
      if (window.__ft.on) {
        window.__ft.draws += gl.info.render.drawCalls - d0;
        window.__ft.tris += gl.info.render.triangles - t0;
        window.__ft.renders++;
      }
      return r;
    };
    let last = performance.now();
    const tick = () => { const n = performance.now(); if (window.__ft.on) window.__ft.s.push(n - last); last = n; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  const census = await app.evalPage(() => {
    const c = window.__glyphClient.ctx;
    // The renderer-parked arena is the ONE reference reachable across module instances
    // (an /@fs import gets a different singleton). c.arena is NOT it.
    const m = c.renderer?.glyphPipelineArena?.megaField;
    let liveBytes = 0;
    for (const v of m?.views ?? []) if (!v.dead) liveBytes += v.byteCount;
    return {
      grids: (c.getGrids?.() || []).length,
      glyphs: m?.field?.instanceMesh?.geometry?.instanceCount ?? null,
      liveBytes, views: m?.views?.length ?? 0,
      culled: m?.field?.instanceMesh?.frustumCulled ?? null,
    };
  });
  console.log(`scene: ${census.grids} grids · ${census.glyphs ?? '?'} glyph instances · ` +
    `${(census.liveBytes / 1048576).toFixed(1)}MB live · ${census.views} views · frustumCulled=${census.culled}\n`);
  console.log('  pose        p50     p95     p99     max    >16.7ms      drawn  recs  promo/demo   glyphPx');
  console.log('  ' + '-'.repeat(98));

  async function pose(name, verb) {
    if (verb) await app.cmd(verb);
    await app.waitFor(4000);                       // let camera flight finish before sampling
    const st = await app.evalPage(() => {
      const c = window.__glyphClient.ctx, cam = c.camera;
      const V3 = cam.position.constructor;
      let best = Infinity;
      for (const g of (c.getGrids?.() || []).slice(0, 60)) {
        const o = g?.object3D || g?.group || g; if (!o?.getWorldPosition) continue;
        const d = cam.position.distanceTo(o.getWorldPosition(new V3()));
        if (d < best) best = d;
      }
      const h = c.renderer?.domElement?.height || 800;
      const fov = (cam.fov || 50) * Math.PI / 180;
      // INSTANCES ACTUALLY DRAWN, from the indirect buffer — NOT geometry.instanceCount.
      // The mega field draws indirect (MegaGlyphField._cullRanges), so instanceCount is
      // ignored at draw-encode time: it reads 19.5M at every pose while the real drawn
      // count swings 10x between near and overview. Reporting the wrong one hides the
      // single variable that predicts frame time.
      const mf = c.renderer?.glyphPipelineArena?.megaField;
      // Only the ISSUED records draw — summing over capacity includes stale leftovers
      // from frames that had more records, and reported more instances than the scene has.
      const arr = mf?._indirect?.attr?.array;
      let drawn = 0;
      const nrec = mf?._indirectOffsets?.length || 0;
      for (let i = 0; i < nrec; i++) drawn += (arr ? arr[i * 5 + 1] : 0);
      return {
        dist: best, glyphPx: (1.0 * h) / (2 * best * Math.tan(fov / 2)),
        drawn, records: mf?._indirectOffsets?.length ?? 0, indirect: mf?._indirectState ?? null,
        promoted: mf?._promotedViews ?? null, demoted: mf?._demotedViews ?? null,
      };
    });
    await app.evalPage(() => { const t = window.__ft; t.s = []; t.draws = 0; t.tris = 0; t.renders = 0; t.on = true; });
    await app.waitFor(SECONDS * 1000);
    const r = await app.evalPage(() => { window.__ft.on = false; const t = window.__ft; return { s: t.s.slice(), draws: t.draws, tris: t.tris, renders: t.renders }; });
    const f = r.s.filter(v => v > 0 && v < 2000).sort((a, b) => a - b);
    const missed = f.filter(v => v > VSYNC_MS).length;
    const nf = f.length || 1;
    console.log(
      `  ${name.padEnd(10)} ${pct(f,0.5).toFixed(1).padStart(5)}ms ${pct(f,0.95).toFixed(1).padStart(6)}ms ` +
      `${pct(f,0.99).toFixed(1).padStart(6)}ms ${(f[f.length-1]||0).toFixed(0).padStart(5)}ms ` +
      `${String(missed).padStart(5)}/${String(f.length).padEnd(5)} ${((missed/nf)*100).toFixed(1).padStart(4)}% ` +
      `${(st.drawn/1e6).toFixed(2).padStart(7)}M ${String(st.records).padStart(5)} ` +
      `${String(st.promoted).padStart(6)}/${String(st.demoted).padEnd(5)} ${st.glyphPx.toFixed(2).padStart(8)}`
    );
  }

  await pose('overview', 'camera.fitall');
  await pose('near', 'camera.focus 0');
  await pose('overview2', 'camera.fitall');        // repeat: is the first reading stable?
} finally { await browser.close(); }
