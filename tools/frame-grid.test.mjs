#!/usr/bin/env bun
// frame-grid.test.mjs — headless, GPU-free unit lock for FrameGrid, InstancedField
// frame-mode shader uniform wiring, PickingSystem uRenderMode propagation, stream
// liveness telemetry (getStreamStatus / noteFrame), and frame.status command verb.

import * as THREE from 'three';
import FrameGrid from '../packages/glyph3d-core/src/collections/FrameGrid.js';
import { PickingSystem } from '../packages/glyph3d-core/src/picking/PickingSystem.js';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';
import registerFrameCommands from '../app/commands/handlers/frameCommands.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL: ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);

// ── 1. deriveGrid honors budget and aspect ───────────────────────────────────────────────
{
  const d = FrameGrid.deriveGrid(1920, 1080, { budget: 4096 });
  ok(d.cols * d.rows <= 4096, `deriveGrid stays within budget (got ${d.cols}x${d.rows}=${d.cols * d.rows})`);
  eq(d.cols, 85, '1920x1080 @ 4096 budget → 85 cols');
  eq(d.rows, 48, '1920x1080 @ 4096 budget → 48 rows');
}

// ── 2. FrameGrid construction & setFrameTexture uniform wiring ───────────────────────────
{
  const scene = new THREE.Scene();
  const fg = new FrameGrid(scene, null, { name: 'test-fg', cols: 16, rows: 9, width: 24, aspect: 16 / 9 });
  const r = fg.getRenderer();
  const u = r.material.uniforms;

  eq(r.isFrame, true, 'FrameGrid renderer starts with isFrame === true');
  eq(u.uRenderMode.value, 1, 'FrameGrid material starts with uRenderMode === 1');
  eq(fg.getCellCount(), 144, '16x9 FrameGrid allocates 144 cells');

  // Verify packed white color does not overflow to black in shader's int(aColor) decode:
  // white is 0xFFFFFFFF -> RGB bits (uCol & 0xFFFFFF) == 0xFFFFFF -> float32 16777215.0
  const rawColor = r.slotBuffer.f32[4]; // slot 0 aColor float
  eq(rawColor, 0xFFFFFF, 'slot 0 aColor is exact 24-bit white (16777215)');

  // DataTexture has flipY = false by default -> uFrameFlipY must be 0
  const dataTex = new THREE.DataTexture(new Uint8Array(16 * 9 * 4), 16, 9, THREE.RGBAFormat);
  fg.setFrameTexture(dataTex);
  eq(u.frameTexture.value, dataTex, 'setFrameTexture binds frameTexture uniform');
  eq(u.frameCols.value, 16, 'setFrameTexture sets frameCols uniform');
  eq(u.frameRows.value, 9, 'setFrameTexture sets frameRows uniform');
  eq(u.uFrameFlipY.value, 0, 'DataTexture (flipY=false) sets uFrameFlipY=0');
  eq(u.uRenderMode.value, 1, 'setFrameTexture keeps uRenderMode=1');

  // Texture with flipY = true (like VideoTexture) -> uFrameFlipY must be 1
  const vidTex = new THREE.Texture({ width: 1280, height: 720 });
  vidTex.flipY = true;
  fg.setFrameTexture(vidTex);
  eq(u.uFrameFlipY.value, 1, 'flipY=true texture sets uFrameFlipY=1');

  // PickingSystem registration propagates uRenderMode=1 to pick material
  const mockRenderer = {
    domElement: {},
    getSize: (v) => v.set(800, 600),
    getPixelRatio: () => 1,
    getClearAlpha: () => 1,
    getClearColor: (c) => c.set(0),
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    setClearColor: () => {},
    clear: () => {},
    render: () => {},
  };
  const ps = new PickingSystem(mockRenderer);
  fg.setPickingSystem(ps);
  eq(r._pickMaterial?.uniforms?.uRenderMode?.value, 1, 'PickingSystem glyph pick material gets uRenderMode=1');

  // Clearing texture resets uRenderMode to 0 on both materials
  fg.setFrameTexture(null);
  eq(u.uRenderMode.value, 0, 'setFrameTexture(null) resets material uRenderMode=0');
  eq(r._pickMaterial?.uniforms?.uRenderMode?.value, 0, 'setFrameTexture(null) resets pick material uRenderMode=0');

  fg.dispose();
  ps.dispose();
}

// ── 3. Stream telemetry (noteFrame / getStreamStatus) & frame.status command ─────────────
{
  const scene = new THREE.Scene();
  const fg = new FrameGrid(scene, null, { name: 'stream-1', cols: 85, rows: 48 });

  let stopped = 0;
  const mockTrack = {
    label: 'mock-display',
    readyState: 'live',
    enabled: true,
    muted: false,
    stop: () => { stopped++; mockTrack.readyState = 'ended'; },
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 60, displaySurface: 'monitor' }),
  };
  const mockStream = { getTracks: () => [mockTrack], getVideoTracks: () => [mockTrack] };
  const tex = new THREE.Texture({ width: 1920, height: 1080 });
  tex.flipY = true;

  fg.setFrameSource({ texture: tex, stream: mockStream, video: null, stop: () => { stopped += 10; } });
  fg.noteFrame({ now: 1000, width: 1920, height: 1080, captureToPresent: 12.5, processing: 1.2 });
  fg.noteFrame({ now: 1016.67, width: 1920, height: 1080, captureToPresent: 11.8, processing: 1.1 });
  fg.noteFrame({ now: 1033.33, width: 1920, height: 1080, captureToPresent: 11.2, processing: 1.0 });

  const st = fg.getStreamStatus(1040);
  eq(st.kind, 'stream', 'getStreamStatus kind is stream');
  eq(st.live, true, 'getStreamStatus live is true');
  eq(st.stalled, false, 'getStreamStatus stalled is false');
  eq(st.frames, 3, 'getStreamStatus counts 3 frames');
  ok(Math.abs(st.fps - 60) < 0.5, `getStreamStatus measures ~60 fps (got ${st.fps})`);
  eq(st.lastFrameAgeMs, 7, 'getStreamStatus computes lastFrameAgeMs');
  eq(st.size.width, 1920, 'getStreamStatus reports width 1920');
  eq(st.size.height, 1080, 'getStreamStatus reports height 1080');
  eq(st.latencyMs.captureToPresent, 11.2, 'getStreamStatus reports captureToPresent latency');

  // Stall detection past 2000ms
  const stalledSt = fg.getStreamStatus(4000);
  eq(stalledSt.stalled, true, 'stream with frame age > 2000ms flags stalled: true');
  eq(stalledSt.fps, 0, 'stalled stream reports fps: 0');

  // Command router integration for frame.status / frame.list / frame.info / frame.kill
  const entries = new Map([['stream-1', { id: 'stream-1', type: 'frame', grid: fg }]]);
  const ctx = {
    scene,
    registry: {
      get: (id) => entries.get(id) || null,
      findByType: (t) => [...entries.values()].filter((e) => e.type === t),
      getIdByGrid: (g) => [...entries.values()].find((e) => e.grid === g)?.id || null,
    },
    removeGrid: (id) => {
      const e = entries.get(id);
      if (e) { entries.delete(id); e.grid.dispose(); }
    },
  };
  const router = new CommandRouter(ctx);
  registerFrameCommands(router);

  const statusAll = await router.execute('frame.status');
  eq(statusAll.data?.count, 1, 'frame.status lists 1 active capture');
  eq(statusAll.data?.streams?.[0]?.id, 'stream-1', 'frame.status includes stream-1');

  const statusOne = await router.execute('frame.status stream-1');
  eq(statusOne.data?.frames, 3, 'frame.status <id> returns single stream telemetry');

  const killRes = await router.execute('frame.kill stream-1');
  ok(killRes.text.startsWith('OK:'), 'frame.kill succeeds');
  eq(stopped, 11, 'dispose stops both the MediaStream track and custom stop callback');
}

// ── 4. 1:1 frames API: naturalPx(), texelSize(), pixelOrigin(), setOneToOne() ────────────
{
  const scene = new THREE.Scene();
  const fg = new FrameGrid(scene, null, { name: 'one-to-one', cols: 1, rows: 1, width: 24, aspect: 16 / 9 });

  eq(fg.naturalPx(), null, 'naturalPx() is null before any source size is known');
  eq(fg.texelSize(), null, 'texelSize() is null before any source size is known');

  const po = fg.pixelOrigin();
  ok(Math.abs(po.x - (-12)) < 1e-9 && Math.abs(po.y - 6.75) < 1e-9, `pixelOrigin() is (-width/2, +height/2) (got ${po.x}, ${po.y})`);

  let resizeEvents = 0;
  fg.onResize(() => { resizeEvents++; });

  const tex1 = new THREE.Texture({ width: 1280, height: 720 });
  tex1.minFilter = THREE.LinearFilter;
  tex1.magFilter = THREE.LinearFilter;
  fg.setFrameTexture(tex1);

  eq(resizeEvents, 1, 'setFrameTexture with new source dims fires onResize');
  const nat = fg.naturalPx();
  ok(nat && nat.w === 1280 && nat.h === 720, `naturalPx() returns {w: 1280, h: 720} (got ${JSON.stringify(nat)})`);

  const ts = fg.texelSize();
  ok(ts && Math.abs(ts.x - 24 / 1280) < 1e-9 && Math.abs(ts.y - 13.5 / 720) < 1e-9,
    `texelSize() maps 1 texel to local units (got ${JSON.stringify(ts)})`);

  // Verify 1:1 scale math: at m = (1 / k) / texelSize().x, rendered width in device px is nat.w
  const k = 10; // 10 device px per world unit
  const m1to1 = (1 / k) / ts.x;
  ok(Math.abs(m1to1 * fg.width * k - 1280) < 1e-9, '1:1 scale m = (1/k)/texelSize().x maps local width to w device px');
  ok(Math.abs(m1to1 * (fg.width / fg.aspect) * k - 720) < 1e-9, '1:1 scale maps local height to h device px');

  eq(fg.oneToOne, false, 'oneToOne defaults to false');
  eq(tex1.minFilter, THREE.LinearFilter, 'default filter is LinearFilter');

  fg.setOneToOne(true);
  eq(fg.oneToOne, true, 'setOneToOne(true) updates getter');
  eq(tex1.minFilter, THREE.NearestFilter, 'setOneToOne(true) sets minFilter = NearestFilter');
  eq(tex1.magFilter, THREE.NearestFilter, 'setOneToOne(true) sets magFilter = NearestFilter');

  // Subsequent texture swap preserves NearestFilter when oneToOne is true
  const tex2 = new THREE.Texture({ width: 1920, height: 1080 });
  tex2.minFilter = THREE.LinearFilter;
  tex2.magFilter = THREE.LinearFilter;
  fg.setFrameTexture(tex2);
  eq(tex2.minFilter, THREE.NearestFilter, 'new texture inherits NearestFilter when oneToOne is true');
  eq(tex2.magFilter, THREE.NearestFilter, 'new texture inherits magFilter=NearestFilter when oneToOne is true');
  eq(resizeEvents, 2, 'changing source dims from 1280x720 to 1920x1080 fires onResize');

  fg.setOneToOne(false);
  eq(tex2.minFilter, THREE.LinearFilter, 'setOneToOne(false) restores LinearFilter');
  eq(fg.isFrameGrid, true, 'FrameGrid sets isFrameGrid = true');
  eq(fg.hasTexture, true, 'hasTexture is true when a texture is attached');
  fg.setFrameTexture(null);
  eq(fg.hasTexture, false, 'hasTexture is false after setFrameTexture(null)');

  fg.dispose();
}

console.log(`frame-grid: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
