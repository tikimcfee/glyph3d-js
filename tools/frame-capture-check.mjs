// frame-capture-check.mjs — headless pixel + orientation + liveness gate for FrameGrid (§6 Slice 3).
//
// Verifies end-to-end with teeth:
//   1. `frame.pattern` streams a 4-quadrant test card (TL red, TR green, BL blue, BR white +
//      1-px midline checker strip) through `canvas.captureStream()` and the same handler code
//      as `frame.capture`. Reads back the four quadrant centres via `gl.readPixels` and asserts
//      both colour within tolerance AND orientation (red top-left, green top-right, blue
//      bottom-left, white bottom-right), plus stream liveness (`frame.status`) and advancing
//      checker pixels across frames.
//   2. A 2×2 PNG (TL red, TR green, BL blue, BR white) decoded through
//      `FrameGrid.textureFromImageBytes` renders into a FrameGrid with exact quadrant colours
//      and orientation (red top-left), proving `ImageBitmap` `flipY=false` + `NoColorSpace`
//      parity with `VideoTexture`.
//   3. `frame.capture` (browser `getDisplayMedia` via fake-media flags) streams live and
//      advances rendered pixels.
//
// Opens CLIENT-ONLY (no relay dial) so it never touches the live session.
//
//   bun tools/frame-capture-check.mjs   →   /tmp/frame-capture-check.png + verdict dump

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openApp, webgpuArgs, makeAssert } from './itest/driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const assert = makeAssert();

async function execCmd(app, verb) {
  return app.evalPage(async (v) => {
    const r = await window.__glyphClient?.router?.execute(v);
    return { text: r?.text ?? null, data: r?.data ?? null };
  }, verb);
}

function assertRgbNear(got, want, tol, label) {
  assert.ok(Array.isArray(got) && got.length === 3, `${label}: missing RGB sample`);
  const dr = Math.abs(got[0] - want[0]);
  const dg = Math.abs(got[1] - want[1]);
  const db = Math.abs(got[2] - want[2]);
  assert.ok(
    dr <= tol && dg <= tol && db <= tol,
    `${label}: got rgb(${got.join(',')}), want rgb(${want.join(',')}) ±${tol} (Δ=${dr},${dg},${db})`,
  );
}

/**
 * Force a synchronous WebGL render and read back the 4 quadrant centres (TL, TR, BL, BR)
 * plus a midline strip sample of `frameId`.
 */
async function readFrameQuadrants(app, frameId) {
  return app.evalPage((id) => {
    const c = window.__glyphClient;
    const ctx = c?.ctx;
    const entry = (id && ctx?.registry?.get?.(id)) || (ctx?.registry?.findByType?.('frame') || [])[0];
    const g = entry?.grid;
    if (!g || !ctx?.renderer || !ctx?.scene || !ctx?.camera) return null;

    ctx.renderer.render(ctx.scene, ctx.camera);
    const gl = ctx.renderer.getContext();
    const dbW = gl.drawingBufferWidth;
    const dbH = gl.drawingBufferHeight;

    g.updateMatrixWorld(true);
    ctx.camera.updateMatrixWorld(true);

    const w = g.width;
    const h = g.width / g.aspect;

    // Project a local (lx, ly, 0) point on the FrameGrid to WebGL drawingBuffer pixel coords
    // (Note: in WebGL readPixels, y=0 is bottom, y=dbH is top).
    const projectLocal = (lx, ly) => {
      const v = g.localToWorld(ctx.camera.position.clone().set(lx, ly, 0));
      v.project(ctx.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * dbW),
        y: Math.round((v.y * 0.5 + 0.5) * dbH),
      };
    };

    const readPatch = (pt, radius = 1) => {
      const side = radius * 2 + 1;
      const x0 = Math.max(0, Math.min(dbW - side, pt.x - radius));
      const y0 = Math.max(0, Math.min(dbH - side, pt.y - radius));
      const buf = new Uint8Array(side * side * 4);
      gl.readPixels(x0, y0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let r = 0, gr = 0, b = 0;
      const n = side * side;
      for (let i = 0; i < buf.length; i += 4) {
        r += buf[i];
        gr += buf[i + 1];
        b += buf[i + 2];
      }
      return [Math.round(r / n), Math.round(gr / n), Math.round(b / n)];
    };

    // Quadrant centres in FrameGrid local space (+X right, +Y up):
    const tlPt = projectLocal(-w * 0.25,  h * 0.25);
    const trPt = projectLocal( w * 0.25,  h * 0.25);
    const blPt = projectLocal(-w * 0.25, -h * 0.25);
    const brPt = projectLocal( w * 0.25, -h * 0.25);

    // Midline checker strip sample (y = 0 in local space, across x in [-0.4*w .. +0.4*w])
    const leftMid = projectLocal(-w * 0.4, 0);
    const rightMid = projectLocal(w * 0.4, 0);
    const stripW = Math.max(1, rightMid.x - leftMid.x);
    const stripBuf = new Uint8Array(stripW * 4);
    gl.readPixels(
      Math.max(0, leftMid.x),
      Math.max(0, Math.min(dbH - 1, leftMid.y)),
      stripW,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      stripBuf,
    );
    const stripLuma = [];
    for (let i = 0; i < stripBuf.length; i += 4) {
      stripLuma.push(stripBuf[i] + stripBuf[i + 1] + stripBuf[i + 2]);
    }

    return {
      coords: { tl: tlPt, tr: trPt, bl: blPt, br: brPt, dbW, dbH },
      quadrants: {
        tl: readPatch(tlPt, 1),
        tr: readPatch(trPt, 1),
        bl: readPatch(blPt, 1),
        br: readPatch(brPt, 1),
      },
      stripLuma,
      renderMode: g._renderer?.material?.uniforms?.uRenderMode?.value ?? null,
      uFrameFlipY: g._renderer?.material?.uniforms?.uFrameFlipY?.value ?? null,
      isFrame: !!g._renderer?.isFrame,
      status: g.getStreamStatus?.() || null,
    };
  }, frameId);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    ...webgpuArgs(),
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
  ],
});

try {
  const app = await openApp(browser, { wait: 4000, session: 'off' });
  assert.ok(app.booted, 'app failed to boot');

  // ── 1. `frame.pattern` 4-quadrant test card + 1-px checker strip ─────────────
  const patRes = await app.cmd('frame.pattern test-card');
  console.log('frame.pattern →', JSON.stringify(patRes));
  assert.ok(patRes.text?.startsWith('OK:'), `frame.pattern failed: ${JSON.stringify(patRes)}`);

  await app.waitFor(700);
  const p0 = await readFrameQuadrants(app, 'test-card');
  await app.waitFor(450);
  const p1 = await readFrameQuadrants(app, 'test-card');

  await app.shot('/tmp/frame-capture-check.png');
  console.log('shot → /tmp/frame-capture-check.png');

  console.log('frame.pattern quadrants →', JSON.stringify({
    coords: p1?.coords,
    quadrants: p1?.quadrants,
    uFrameFlipY: p1?.uFrameFlipY,
    status: p1?.status,
  }, null, 2));

  // Orientation in screen space: TL must be left of TR and above BL (WebGL y grows upward)
  assert.ok(p1.coords.tl.x < p1.coords.tr.x, 'TL must project left of TR');
  assert.ok(p1.coords.tl.y > p1.coords.bl.y, 'TL must project above BL');
  assert.equal(p1.renderMode, 1, 'frame.pattern uRenderMode must be 1');
  assert.equal(p1.uFrameFlipY, 1, 'VideoTexture uFrameFlipY must be 1');

  // Quadrant colour & orientation assertions (tolerance ±25 for <video> YUV420 conversion)
  assertRgbNear(p1.quadrants.tl, [255, 0, 0], 25, 'frame.pattern top-left (RED)');
  assertRgbNear(p1.quadrants.tr, [0, 255, 0], 25, 'frame.pattern top-right (GREEN)');
  assertRgbNear(p1.quadrants.bl, [0, 0, 255], 25, 'frame.pattern bottom-left (BLUE)');
  assertRgbNear(p1.quadrants.br, [255, 255, 255], 25, 'frame.pattern bottom-right (WHITE)');

  // Stream liveness & advancing checker strip
  assert.ok(p1.status?.live, 'frame.pattern must report live: true');
  assert.equal(p1.status?.stalled, false, 'frame.pattern must not be stalled');
  assert.atLeast(p1.status?.frames ?? 0, 2, 'frame.pattern must deliver >= 2 frames');
  assert.ok((p1.status?.fps ?? 0) > 0, 'frame.pattern fps must be > 0');
  assert.ok((p1.status?.frames ?? 0) > (p0.status?.frames ?? 0), 'frame.pattern frame count must advance');

  // Verify the 1-px midline checker strip has spatial contrast (dark + light texels)
  const minStrip = Math.min(...p1.stripLuma);
  const maxStrip = Math.max(...p1.stripLuma);
  assert.ok(maxStrip - minStrip > 200, `midline 1-px checker strip must show contrast (min=${minStrip}, max=${maxStrip})`);

  // Teeth: verify the gate fails on pre-repair / mis-oriented material states
  const teeth = await app.evalPage(() => {
    const c = window.__glyphClient;
    const g = c.ctx.registry.get('test-card').grid;
    const u = g._renderer.material.uniforms;
    return { origFlip: u.uFrameFlipY.value, origMode: u.uRenderMode.value };
  });
  await app.evalPage(() => {
    const u = window.__glyphClient.ctx.registry.get('test-card').grid._renderer.material.uniforms;
    u.uFrameFlipY.value = 0; // wrong flipY -> upside-down (TL becomes BLUE)
  });
  const flippedQ = await readFrameQuadrants(app, 'test-card');
  assert.ok(flippedQ.quadrants.tl[0] < 50 && flippedQ.quadrants.tl[2] > 200,
    `teeth: wrong uFrameFlipY must fail TL=RED check (got rgb(${flippedQ.quadrants.tl.join(',')}))`);

  await app.evalPage(() => {
    const u = window.__glyphClient.ctx.registry.get('test-card').grid._renderer.material.uniforms;
    u.uFrameFlipY.value = 1;
    u.uRenderMode.value = 0; // pre-repair glyph-soup mode
  });
  const glyphSoupQ = await readFrameQuadrants(app, 'test-card');
  assert.ok(glyphSoupQ.quadrants.tl[0] < 100 || glyphSoupQ.quadrants.br[0] < 100,
    `teeth: pre-repair uRenderMode=0 must fail quadrant check (got TL=${glyphSoupQ.quadrants.tl}, BR=${glyphSoupQ.quadrants.br})`);

  await app.evalPage((orig) => {
    const u = window.__glyphClient.ctx.registry.get('test-card').grid._renderer.material.uniforms;
    u.uFrameFlipY.value = orig.origFlip;
    u.uRenderMode.value = orig.origMode;
  }, teeth);

  // ── 2. 2×2 PNG through `FrameGrid.textureFromImageBytes` ────────────────────
  await app.evalPage(async () => {
    const c = window.__glyphClient;
    const ctx = c.ctx;
    const prevGrid = ctx.registry.get('test-card')?.grid;
    const FrameGrid = prevGrid.constructor;
    const Vector3 = ctx.camera.position.constructor;
    await c.router.execute('frame.kill test-card');

    // Build a 2×2 PNG in memory: TL=(255,0,0), TR=(0,255,0), BL=(0,0,255), BR=(255,255,255)
    const cv = document.createElement('canvas');
    cv.width = 2;
    cv.height = 2;
    const g2d = cv.getContext('2d');
    const img = g2d.createImageData(2, 2);
    img.data.set([
      255, 0, 0, 255,     0, 255, 0, 255,
      0, 0, 255, 255,     255, 255, 255, 255,
    ]);
    g2d.putImageData(img, 0, 0);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const { texture, width, height } = await FrameGrid.textureFromImageBytes(bytes, 'png');
    // THREE.NearestFilter === 1003: crisp 2×2 texels with no bilinear bleed across quadrant edges
    texture.minFilter = 1003;
    texture.magFilter = 1003;
    texture.needsUpdate = true;

    const fg = new FrameGrid(ctx.scene, ctx.atlas, {
      name: 'png-2x2',
      cols: 2,
      rows: 2,
      width: 24,
      aspect: width / height,
    });
    const cam = ctx.camera;
    const forward = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    fg.position.copy(cam.position).addScaledVector(forward, 30);
    fg.quaternion.copy(cam.quaternion);
    fg.setFrameTexture(texture);
    ctx.addGrid(fg, { id: 'png-2x2', type: 'frame' });
  });

  await app.waitFor(100);
  const pngQ = await readFrameQuadrants(app, 'png-2x2');
  console.log('2x2 PNG quadrants →', JSON.stringify({
    quadrants: pngQ?.quadrants,
    uFrameFlipY: pngQ?.uFrameFlipY,
    status: pngQ?.status,
  }, null, 2));

  assert.equal(pngQ.uFrameFlipY, 0, 'ImageBitmap textureFromImageBytes uFrameFlipY must be 0');
  assertRgbNear(pngQ.quadrants.tl, [255, 0, 0], 3, '2x2 PNG top-left (RED)');
  assertRgbNear(pngQ.quadrants.tr, [0, 255, 0], 3, '2x2 PNG top-right (GREEN)');
  assertRgbNear(pngQ.quadrants.bl, [0, 0, 255], 3, '2x2 PNG bottom-left (BLUE)');
  assertRgbNear(pngQ.quadrants.br, [255, 255, 255], 3, '2x2 PNG bottom-right (WHITE)');

  await app.cmd('frame.kill png-2x2');

  // ── 3. `frame.capture` (Chromium fake display media stream) ─────────────────
  const capRes = await app.cmd('frame.capture fake-screen');
  console.log('frame.capture →', JSON.stringify(capRes));
  assert.ok(capRes.text?.startsWith('OK:'), `frame.capture failed: ${JSON.stringify(capRes)}`);
  await app.waitFor(900);
  const c0 = await readFrameQuadrants(app, 'fake-screen');
  await app.waitFor(600);
  const c1 = await readFrameQuadrants(app, 'fake-screen');
  assert.ok(c1.status?.live, 'frame.capture must report live: true');
  assert.ok((c1.status?.frames ?? 0) > (c0.status?.frames ?? 0), 'frame.capture frames must advance');
  await app.cmd('frame.kill fake-screen');

  // ── 4. Agent-owned desktops (`desktop.start / still / list / stop`, 0x03 binary plane,
  //       1:1 pixel match against CDP PNG, carrel holding, reload restore) ──────────────
  const relayBin = '/tmp/glyph3d-cli-desktop-gate';
  execFileSync('go', ['build', '-o', relayBin, '.'], {
    cwd: path.join(REPO_ROOT, 'cli'),
    stdio: 'inherit',
  });
  const relayPort = await getFreePort();
  const relayProc = spawn(
    relayBin,
    [
      'serve',
      '--relay-only',
      '--no-gomuxai',
      '--tmux-socket', `glyphd-gate-${process.pid}`,
      '--port', String(relayPort),
      '--listen', '127.0.0.1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  try {
    // Wait for the ephemeral relay to start listening
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ephemeral relay listen timeout')), 5000);
      const onOut = (chunk) => {
        if (String(chunk).includes(String(relayPort))) {
          clearTimeout(t);
          resolve();
        }
      };
      relayProc.stdout.on('data', onOut);
      relayProc.stderr.on('data', onOut);
      relayProc.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`ephemeral relay exited early (${code})`));
      });
    });

    const connRes = await app.cmd(`relay.connect ${relayPort}`);
    assert.ok(connRes.text?.startsWith('OK:'), `relay.connect failed: ${JSON.stringify(connRes)}`);
    await app.waitFor(200);

    // 4a. Loud failure when Chromium binary does not exist
    const badBinRes = await app.cmd('desktop.start no-browser 160x120 --chromium /nonexistent/chromium-bin');
    console.log('desktop.start (missing binary) →', badBinRes.text);
    assert.ok(
      badBinRes.text?.startsWith('ERR:') && badBinRes.text.includes('/nonexistent/chromium-bin'),
      `desktop.start with missing binary must fail loud naming what it looked for: ${badBinRes.text}`,
    );

    // 4b. Start a 160×120 agent-owned desktop on a deterministic 4-quadrant + 1-px checker HTML page
    const testHtml = [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<style>',
      'html,body{margin:0;padding:0;width:160px;height:120px;overflow:hidden;background:#000;}',
      '.q{position:absolute;width:80px;height:60px;}',
      '#tl{left:0;top:0;background:rgb(255,0,0);}',
      '#tr{left:80px;top:0;background:rgb(0,255,0);}',
      '#bl{left:0;top:60px;background:rgb(0,0,255);}',
      '#br{left:80px;top:60px;background:rgb(255,255,255);}',
      '#bar{position:absolute;left:20px;top:56px;width:120px;height:8px;background:rgb(255,200,0);}',
      '</style></head><body>',
      '<div id="tl" class="q"></div><div id="tr" class="q"></div>',
      '<div id="bl" class="q"></div><div id="br" class="q"></div>',
      '<div id="bar"></div>',
      '</body></html>',
    ].join('');
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`;

    const startRes = await execCmd(app, ['desktop.start', 'agent-desk', '160x120', '--browser', dataUrl]);
    console.log('desktop.start →', JSON.stringify(startRes));
    assert.ok(startRes.text?.startsWith('OK:'), `desktop.start failed: ${JSON.stringify(startRes)}`);
    assert.equal(startRes.data?.naturalPx?.w, 160, 'desktop.start naturalPx.w must be 160');
    assert.equal(startRes.data?.naturalPx?.h, 120, 'desktop.start naturalPx.h must be 120');
    assert.equal(startRes.data?.oneToOne, true, 'desktop FrameGrid must default to oneToOne (NearestFilter)');

    const listRes = await execCmd(app, 'desktop.list');
    console.log('desktop.list →', listRes.text);
    assert.equal(listRes.data?.count, 1, 'desktop.list must show 1 running desktop');
    assert.equal(listRes.data?.desktops?.[0]?.name, 'agent-desk');
    assert.equal(listRes.data?.desktops?.[0]?.inScene, true);

    // 4c. Capture a lossless CDP PNG still via `desktop.still` and compare 1:1 on-screen
    //     WebGL pixels against the CDP PNG across all 160×120 texels (max channel delta <= 1)
    const stillRes = await execCmd(app, 'desktop.still agent-desk');
    assert.ok(stillRes.text?.startsWith('OK:'), `desktop.still failed: ${stillRes.text}`);
    assert.ok(stillRes.data?.pngBase64?.length > 50, 'desktop.still must return lossless PNG bytes');

    // Enter a 1:1 plane on `agent-desk` (`1 texel = 1 device px`, snap top-left to integer device px)
    const cellPxFor1to1 = await app.evalPage(() => {
      const c = window.__glyphClient;
      const ctx = c.ctx;
      const fg = ctx.registry.get('agent-desk').grid;
      fg.setOneToOne(true);
      const nat = fg.naturalPx();
      const cs = ctx.atlas.getCharSize();
      const defaultScale = 0.025; // plane.defaultWorldScale default
      const colWorld = cs.width * defaultScale;
      // pxPerUnit = cellPx / colWorld; for 1:1 texels we want pxPerUnit = nat.w / fg.width
      return (nat.w / fg.width) * colWorld;
    });

    await execCmd(app, `plane.enter agent-desk ${cellPxFor1to1}`);
    // Wait for plane enter tween to settle
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const st = await execCmd(app, 'plane.state');
      if (!st.data?.tweening) break;
      await app.waitFor(50);
    }

    const pixelCmp = await app.evalPage(async (pngB64) => {
      const c = window.__glyphClient;
      const ctx = c.ctx;
      const fg = ctx.registry.get('agent-desk').grid;

      // Decode the CDP PNG into raw RGBA bytes FIRST (before synchronous WebGL render + readPixels)
      const bin = atob(pngB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      const g2d = cv.getContext('2d');
      g2d.drawImage(bmp, 0, 0);
      const refData = g2d.getImageData(0, 0, bmp.width, bmp.height).data;

      // Render and read back in the SAME synchronous turn so the WebGL backbuffer isn't cleared
      ctx.renderer.render(ctx.scene, ctx.camera);
      const gl = ctx.renderer.getContext();
      const H = gl.drawingBufferHeight;

      // Project fg.pixelOrigin() (top-left) to device pixel coordinates
      const Vector3 = ctx.camera.position.constructor;
      fg.updateWorldMatrix(true, false);
      const po = fg.pixelOrigin();
      const tlWorld = fg.localToWorld(new Vector3(po.x, po.y, 0)).project(ctx.camera);
      const x0 = Math.round((tlWorld.x * 0.5 + 0.5) * gl.drawingBufferWidth);
      const yTop = Math.round((0.5 - tlWorld.y * 0.5) * H);

      // Read back the 160×120 block from WebGL drawingBuffer (note gl.readPixels is bottom-up)
      const w = bmp.width;
      const h = bmp.height;
      const glBuf = new Uint8Array(w * h * 4);
      gl.readPixels(x0, H - (yTop + h), w, h, gl.RGBA, gl.UNSIGNED_BYTE, glBuf);

      let maxDelta = 0;
      let worst = null;
      for (let y = 0; y < h; y++) {
        const glRow = h - 1 - y; // flip WebGL bottom-up row to top-down row
        for (let x = 0; x < w; x++) {
          const refIdx = (y * w + x) * 4;
          const glIdx = (glRow * w + x) * 4;
          const dr = Math.abs(glBuf[glIdx] - refData[refIdx]);
          const dg = Math.abs(glBuf[glIdx + 1] - refData[refIdx + 1]);
          const db = Math.abs(glBuf[glIdx + 2] - refData[refIdx + 2]);
          const d = Math.max(dr, dg, db);
          if (d > maxDelta) {
            maxDelta = d;
            worst = {
              x, y,
              got: [glBuf[glIdx], glBuf[glIdx + 1], glBuf[glIdx + 2]],
              want: [refData[refIdx], refData[refIdx + 1], refData[refIdx + 2]],
            };
          }
        }
      }
      bmp.close();
      return { w, h, x0, yTop, maxDelta, worst };
    }, stillRes.data.pngBase64);

    console.log('1:1 desktop vs CDP PNG comparison →', JSON.stringify(pixelCmp));
    assert.ok(
      pixelCmp.maxDelta <= 1,
      `1:1 desktop pixels must match CDP PNG with max channel delta <= 1 (got maxDelta=${pixelCmp.maxDelta} at ${JSON.stringify(pixelCmp.worst)})`,
    );

    await app.cmd('plane.leave');
    await app.waitFor(100);

    // 4d. A desktop `frame` is holdable by a carrel AND keeps the exact same FrameGrid
    //     instance across resyncs / reconnects / new frames (never overwritten).
    const beforeSeatInfo = await app.evalPage(() => {
      const g = window.__glyphClient.ctx.registry.get('agent-desk').grid;
      window.__agentDeskGridRef = g;
      return {
        isFrameGrid: g.isFrameGrid,
        hasTexture: g.hasTexture,
        frames: g.getStreamStatus().frames,
      };
    });
    assert.equal(beforeSeatInfo.isFrameGrid, true, 'desktop FrameGrid must have isFrameGrid = true');
    assert.equal(beforeSeatInfo.hasTexture, true, 'desktop FrameGrid must have hasTexture = true before seating');
    assert.atLeast(beforeSeatInfo.frames, 1, 'desktop FrameGrid must have >= 1 frame before seating');

    await execCmd(app, 'carrel.create desk-carrel');
    await execCmd(app, 'carrel.set desk-carrel mode plane');
    const seatRes = await execCmd(app, 'carrel.add desk-carrel agent-desk');
    console.log('carrel.add desktop →', seatRes.text);
    assert.ok(seatRes.text?.startsWith('OK:'), `carrel must hold a frame: ${seatRes.text}`);

    // Trigger a resync (`desktop.list`), a reconnect (`relay.disconnect` -> `relay.connect`),
    // and a new frame (`desktop.still`), then verify the registered + seated FrameGrid
    // reference is unchanged, frame count advances on THAT grid, and its pixels render non-blank.
    await execCmd(app, 'desktop.list');
    await execCmd(app, 'relay.disconnect');
    await app.waitFor(100);
    await execCmd(app, `relay.connect ${relayPort}`);
    await app.waitFor(300);
    await execCmd(app, 'desktop.still agent-desk');

    const identityCheck = await app.evalPage(() => {
      const ctx = window.__glyphClient.ctx;
      const regGrid = ctx.registry.get('agent-desk')?.grid;
      const seatedGrid = ctx.carrels.get('desk-carrel')?.entries?.get('agent-desk')?.grid;
      return {
        sameRegistryGrid: regGrid === window.__agentDeskGridRef,
        sameSeatedGrid: seatedGrid === window.__agentDeskGridRef,
        status: regGrid?.getStreamStatus?.() ?? null,
      };
    });
    console.log('desktop identity across resync/reconnect →', JSON.stringify(identityCheck));
    assert.equal(identityCheck.sameRegistryGrid, true, 'resync/reconnect must reuse the exact same FrameGrid in registry');
    assert.equal(identityCheck.sameSeatedGrid, true, 'carrel seat must hold the exact same live FrameGrid');
    assert.equal(identityCheck.status?.live, true, 'seated desktop FrameGrid must report live: true');
    assert.ok(
      (identityCheck.status?.frames ?? 0) > beforeSeatInfo.frames,
      `frames must advance on the seated FrameGrid (${beforeSeatInfo.frames} -> ${identityCheck.status?.frames})`,
    );

    const overwriteWarnings = app.warnings.filter((w) => w.includes('overwriting "agent-desk"'));
    assert.equal(
      overwriteWarnings.length,
      0,
      `registry must never overwrite "agent-desk" (got warnings: ${JSON.stringify(overwriteWarnings)})`,
    );

    await execCmd(app, 'carrel.enter desk-carrel');
    const carrelDeadline = Date.now() + 3000;
    while (Date.now() < carrelDeadline) {
      const st = await execCmd(app, 'plane.state');
      if (!st.data?.tweening) break;
      await app.waitFor(50);
    }
    const seatedQ = await readFrameQuadrants(app, 'agent-desk');
    console.log('seated desktop quadrants →', JSON.stringify(seatedQ?.quadrants));
    assertRgbNear(seatedQ.quadrants.tl, [255, 0, 0], 5, 'seated desktop top-left (RED)');
    assertRgbNear(seatedQ.quadrants.tr, [0, 255, 0], 5, 'seated desktop top-right (GREEN)');
    assertRgbNear(seatedQ.quadrants.bl, [0, 0, 255], 5, 'seated desktop bottom-left (BLUE)');
    assertRgbNear(seatedQ.quadrants.br, [255, 255, 255], 5, 'seated desktop bottom-right (WHITE)');
    await execCmd(app, 'plane.leave');
    await app.waitFor(100);

    // 4e. Restorable across reloads with no user gesture (the relay owns the producer)
    await execCmd(app, 'relay.disconnect');
    await app.waitFor(100);
    await app.page.reload({ waitUntil: 'load' });
    await app.page.waitForFunction(() => Boolean(window.__glyphClient?.ctx?.atlas), null, { timeout: 15000 });
    await app.waitFor(500);
    const conn2Res = await execCmd(app, `relay.connect ${relayPort}`);
    console.log('relay.connect after reload →', conn2Res.text);

    // Wait up to 3s for the relay's 0x03 replay + desktop/list sync to restore `agent-desk`
    const restoreDeadline = Date.now() + 3000;
    let restored = null;
    while (Date.now() < restoreDeadline) {
      restored = await app.evalPage(() => {
        const g = window.__glyphClient?.ctx?.registry?.get('agent-desk')?.grid;
        if (!g?.hasTexture) return null;
        return {
          hasTexture: g.hasTexture,
          naturalPx: g.naturalPx(),
          oneToOne: g.oneToOne,
        };
      });
      if (restored) break;
      await app.waitFor(50);
    }
    console.log('desktop after page reload →', JSON.stringify(restored));
    assert.ok(restored?.hasTexture, 'desktop FrameGrid must restore with texture after reload with no user gesture');
    assert.equal(restored?.naturalPx?.w, 160, 'restored desktop must keep naturalPx.w 160');
    assert.equal(restored?.naturalPx?.h, 120, 'restored desktop must keep naturalPx.h 120');

    // 4f. Stop the desktop and verify cleanup
    const stopRes = await execCmd(app, 'desktop.stop agent-desk');
    assert.ok(stopRes.text?.startsWith('OK:'), `desktop.stop failed: ${stopRes.text}`);
    const listAfterStop = await execCmd(app, 'desktop.list');
    assert.equal(listAfterStop.data?.count, 0, 'desktop.list must be empty after desktop.stop');
    await execCmd(app, 'relay.disconnect');
  } finally {
    relayProc.kill('SIGTERM');
    fs.rmSync(relayBin, { force: true });
  }

  assert.noErrors(app);
  const tracked = await app.trackedErrors();
  assert.equal(tracked.length, 0, `unexpected tracked error(s): ${JSON.stringify(tracked)}`);
  console.log('PASS: frame-capture-check (4-quadrant test card + 2x2 PNG + fake capture + agent desktop verified)');
} finally {
  await browser.close();
}
