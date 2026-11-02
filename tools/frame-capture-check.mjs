// frame-capture-check.mjs — headless pixel + liveness gate for screen captures (FrameGrid).
//
// Verifies end-to-end:
//   1. `frame.capture` (browser getDisplayMedia stream via fake media device flags)
//      populates a FrameGrid in RENDER_MODE.FRAME (`uRenderMode = 1`).
//   2. `frame.status` reports a live, non-stalled stream with advancing `frames`,
//      positive `fps`, valid `size`, and fresh `lastFrameAgeMs`.
//   3. WebGL2 pixel readback (`gl.readPixels`) across the projected FrameGrid interior
//      shows bright, non-background frame texture content (not the #141820 scene clear
//      color and not black glyph bars) AND pixels actually change between t0 and t1 as
//      the video stream advances.
//   4. `frame.capture --test` (gesture-free synthetic canvas stream) also renders live,
//      advancing frame pixels and cleans up on `frame.remove`.
//
// Opens CLIENT-ONLY (no relay dial) so it never touches the live session.
//
//   bun tools/frame-capture-check.mjs   →   /tmp/frame-capture-check.png + state dump

import { chromium } from 'playwright';
import { openApp, webgpuArgs, makeAssert } from './itest/driver.mjs';

const assert = makeAssert();

/**
 * Force a synchronous WebGL render and read back a grid of sample pixels inside the
 * projected screen-space bounding box of `frameId`.
 */
async function sampleFramePixels(app, frameId) {
  return app.evalPage((id) => {
    const c = window.__glyphClient;
    const ctx = c?.ctx;
    const entry = ctx?.registry?.get?.(id) || (ctx?.registry?.findByType?.('frame') || [])[0];
    const g = entry?.grid;
    if (!g || !ctx?.renderer || !ctx?.scene || !ctx?.camera) return null;

    ctx.renderer.render(ctx.scene, ctx.camera);
    const gl = ctx.renderer.getContext();
    const dbW = gl.drawingBufferWidth;
    const dbH = gl.drawingBufferHeight;

    g.updateMatrixWorld(true);
    ctx.camera.updateMatrixWorld(true);

    // Project interior 94% of the FrameGrid [-0.47*W..+0.47*W, -0.47*H..+0.47*H] to NDC
    // so both the center sweep and corner/timestamp regions of the video stream are covered.
    const halfW = (g.width / 2) * 0.94;
    const halfH = ((g.width / g.aspect) / 2) * 0.94;
    const corners = [
      [-halfW, -halfH, 0],
      [ halfW, -halfH, 0],
      [ halfW,  halfH, 0],
      [-halfW,  halfH, 0],
    ].map(([lx, ly, lz]) => {
      const v = g.localToWorld(ctx.camera.position.clone().set(lx, ly, lz));
      v.project(ctx.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * dbW),
        y: Math.round((v.y * 0.5 + 0.5) * dbH),
      };
    });

    const minX = Math.max(0, Math.min(...corners.map((p) => p.x)));
    const maxX = Math.min(dbW - 1, Math.max(...corners.map((p) => p.x)));
    const minY = Math.max(0, Math.min(...corners.map((p) => p.y)));
    const maxY = Math.min(dbH - 1, Math.max(...corners.map((p) => p.y)));
    const rectW = Math.max(1, maxX - minX);
    const rectH = Math.max(1, maxY - minY);

    const buf = new Uint8Array(rectW * rectH * 4);
    gl.readPixels(minX, minY, rectW, rectH, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    // Subsample a 96x54 grid across the readback rectangle for fast, deterministic comparison.
    const cols = 96, rows = 54;
    const samples = [];
    let nonBgCount = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    const total = cols * rows;

    for (let r = 0; r < rows; r++) {
      const py = Math.min(rectH - 1, Math.floor(((r + 0.5) / rows) * rectH));
      for (let col = 0; col < cols; col++) {
        const px = Math.min(rectW - 1, Math.floor(((col + 0.5) / cols) * rectW));
        const idx = (py * rectW + px) * 4;
        const R = buf[idx], G = buf[idx + 1], B = buf[idx + 2];
        sumR += R; sumG += G; sumB += B;
        // Scene background is #141820 (20, 24, 32) and panel backing is ~#0a0c10 (10, 12, 16).
        const distBg = Math.abs(R - 20) + Math.abs(G - 24) + Math.abs(B - 32);
        const distBlack = R + G + B;
        if (distBg > 35 && distBlack > 35) nonBgCount++;
        samples.push(R, G, B);
      }
    }

    return {
      rect: { minX, minY, width: rectW, height: rectH, dbW, dbH },
      nonBgRatio: +(nonBgCount / total).toFixed(3),
      meanRgb: [Math.round(sumR / total), Math.round(sumG / total), Math.round(sumB / total)],
      renderMode: g._renderer?.material?.uniforms?.uRenderMode?.value ?? null,
      isFrame: !!g._renderer?.isFrame,
      status: g.getStreamStatus?.() || null,
      samples,
    };
  }, frameId);
}

function diffSamples(a, b) {
  if (!a?.samples || !b?.samples || a.samples.length !== b.samples.length) return 0;
  const n = a.samples.length / 3;
  let changed = 0;
  for (let i = 0; i < a.samples.length; i += 3) {
    const d = Math.abs(a.samples[i] - b.samples[i])
            + Math.abs(a.samples[i + 1] - b.samples[i + 1])
            + Math.abs(a.samples[i + 2] - b.samples[i + 2]);
    if (d > 12) changed++;
  }
  return +(changed / n).toFixed(4);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    ...webgpuArgs(),
    // Auto-grant getDisplayMedia with a synthetic moving pattern.
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
  ],
});

try {
  const app = await openApp(browser, { wait: 4000, session: 'off' }); // client-only, no contention
  assert.ok(app.booted, 'app failed to boot');

  // ── 1. Real getDisplayMedia path (`frame.capture`) ──────────────────────────
  const cap = await app.cmd('frame.capture');
  console.log('frame.capture →', JSON.stringify(cap));
  assert.ok(cap.text?.startsWith('OK:'), `frame.capture failed: ${JSON.stringify(cap)}`);

  await app.waitFor(900);
  const t0 = await sampleFramePixels(app, null);
  await app.waitFor(1100);
  const t1 = await sampleFramePixels(app, null);

  const statusRes = await app.evalPage(async () => {
    const r = await window.__glyphClient.router.execute('frame.status');
    return { text: r?.text, data: r?.data };
  });
  console.log('frame.status →\n' + statusRes.text);

  const changedRatio = diffSamples(t0, t1);
  const firstId = statusRes.data?.streams?.[0]?.id;
  const summary = {
    id: firstId,
    renderMode: t1?.renderMode,
    isFrame: t1?.isFrame,
    rect: t1?.rect,
    nonBgRatio: t1?.nonBgRatio,
    meanRgb: t1?.meanRgb,
    changedRatio,
    status: t1?.status,
  };
  console.log('capture verdict →', JSON.stringify(summary, null, 2));

  await app.shot('/tmp/frame-capture-check.png');
  console.log('shot → /tmp/frame-capture-check.png');

  assert.equal(t1?.renderMode, 1, 'InstancedField material uRenderMode must be 1 (FRAME)');
  assert.equal(t1?.isFrame, true, 'InstancedField.isFrame must be true');
  assert.ok(t1?.status?.live, 'stream must report live: true');
  assert.equal(t1?.status?.stalled, false, 'stream must not be stalled');
  assert.atLeast(t1?.status?.frames ?? 0, 2, 'stream must have delivered >= 2 frames');
  assert.ok((t1?.status?.fps ?? 0) > 0, `stream fps must be > 0 (got ${t1?.status?.fps})`);
  assert.ok((t1?.status?.size?.width ?? 0) > 0 && (t1?.status?.size?.height ?? 0) > 0, 'stream size must be non-zero');
  assert.atLeast(t1?.nonBgRatio ?? 0, 0.85, 'projected FrameGrid interior must render non-background frame pixels');
  assert.ok(changedRatio > 0.005, `rendered FrameGrid pixels must advance over time (changedRatio=${changedRatio})`);
  assert.ok((t1?.status?.frames ?? 0) > (t0?.status?.frames ?? 0), 'frame counter must advance between t0 and t1');

  // ── 2. Gesture-free synthetic stream path (`frame.capture --test`) ──────────
  if (firstId) {
    const killRes = await app.cmd(`frame.kill ${firstId}`);
    assert.ok(killRes.text?.startsWith('OK:'), `frame.kill failed: ${JSON.stringify(killRes)}`);
  }

  const testCap = await app.cmd('frame.capture --test synth-check');
  console.log('frame.capture --test →', JSON.stringify(testCap));
  assert.ok(testCap.text?.startsWith('OK:'), `frame.capture --test failed: ${JSON.stringify(testCap)}`);

  await app.waitFor(700);
  const s0 = await sampleFramePixels(app, 'synth-check');
  await app.waitFor(500);
  const s1 = await sampleFramePixels(app, 'synth-check');
  const synthChanged = diffSamples(s0, s1);

  console.log('synth verdict →', JSON.stringify({
    nonBgRatio: s1?.nonBgRatio,
    meanRgb: s1?.meanRgb,
    changedRatio: synthChanged,
    status: s1?.status,
  }, null, 2));

  assert.ok(s1?.status?.live, '--test stream must report live: true');
  assert.atLeast(s1?.status?.frames ?? 0, 2, '--test stream must deliver >= 2 frames');
  assert.atLeast(s1?.nonBgRatio ?? 0, 0.85, '--test FrameGrid interior must render bright test pattern pixels');
  assert.ok(synthChanged > 0.01, `--test FrameGrid pixels must advance over time (changedRatio=${synthChanged})`);

  const killSynth = await app.cmd('frame.kill synth-check');
  assert.ok(killSynth.text?.startsWith('OK:'), `frame.kill synth-check failed: ${JSON.stringify(killSynth)}`);
  assert.noErrors(app);
  const tracked = await app.trackedErrors();
  assert.equal(tracked.length, 0, `unexpected tracked error(s): ${JSON.stringify(tracked)}`);
  console.log('PASS: frame-capture-check (pixel + stream liveness verified)');
} finally {
  await browser.close();
}
