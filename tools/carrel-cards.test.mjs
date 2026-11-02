#!/usr/bin/env bun
// carrel-cards.test.mjs — Gate for Slice 11: Impostor cards for carrels (§3.16)
// and the `carrel.card` / `card.list` command-bus verbs.
//
// Verifies:
//   1. Power-of-two resolution tiers (256 / 512 / 1024 / 2048) + 'native' 1:1 dims
//   2. getCardRect for both plane desks (Carrel.getPlaneRect) and ring/wall desks
//   3. THE LAYER STATEMENT (§3.16): card pass renders on CARD_LAYER (29) with layer 0
//      disabled; GlyphBatch and PanelBatch repack/update counts are unchanged across
//      a card pass, and PlaneOverlay does not fire during the FBO pass
//   4. Postcard capture on `carrel.leave`, budgeted refresh under `budgetMs` (1.5 ms),
//      near-live top `live = 6` vs staleness stamp, and byte-capped LRU pool eviction
//      (falls back to 'live')
//   5. Live <-> card swap at texel >= pixel with hysteresis (1.0 / 0.85)
//   6. `carrel.card <name>` and `card.list` verbs
//   7. Real WebGL2 GPU pixel gate: a card of a terminal vs the live member has
//      maxChannelDelta <= 1, a 0.5 px offset FAILS (teeth), and capture < 2 ms.
//
// Run:
//   bun tools/carrel-cards.test.mjs

import * as THREE from 'three';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';
import SceneTransforms from '../packages/glyph3d-core/src/collections/SceneTransforms.js';
import GlyphBatch, { enrollGlyphField } from '../packages/glyph3d-core/src/collections/GlyphBatch.js';
import PanelBatch, { enrollPanel } from '../packages/glyph3d-core/src/collections/PanelBatch.js';
import GlyphFarLod from '../packages/glyph3d-core/src/collections/GlyphFarLod.js';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';
import { createPanelMaterial } from '../packages/glyph3d-core/src/collections/panelMaterial.js';
import Carrel from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import CarrelCards, {
    CARD_LAYER,
    CARD_TIERS,
    tierForProjectedPx,
    dimsForTier,
    getCardRect,
} from '../packages/glyph3d-core/src/collections/CarrelCards.js';
import PlaneOverlay from '../app/client/PlaneOverlay.js';
import registerLabelCommands from '../app/commands/handlers/labelCommands.js';
import { measureStillness } from './lib/pixel-metrics.mjs';
import { launchGpuBrowser } from './itest/driver.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) {
        pass++;
    } else {
        fail++;
        console.error(`  FAIL: ${msg}`);
    }
}
function near(a, b, eps, msg) {
    ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, expected ${b})`);
}

const mockAtlas = {
    getCharSize: () => ({ width: 29, height: 54.375, em: 48 }),
    _slugData: null,
    _shaper: {
        upem: 2048,
        lookup: (cp) => ({ g: cp, ax: 1229 }),
    },
};

/** Build a lightweight mock grid (panel + glyph field + label) that satisfies Carrel's seat contract. */
function makeMockGrid(id, cols = 80, rows = 24) {
    const g = new THREE.Object3D();
    g.name = id;
    g.cols = cols;
    g.rows = rows;
    g.metrics = { charWidth: 0.725, charHeight: 1.359375, lineSpacing: 0 };
    const w = cols * g.metrics.charWidth;
    const h = rows * g.metrics.charHeight;
    g._scale = 1;
    g.setScale = (s) => { g._scale = s; g.scale.setScalar(s); };
    g.pixelOrigin = () => ({ x: 0, y: 0 });
    g.getLocalBounds = (target = new THREE.Box3()) => target.set(
        new THREE.Vector3(0, -h, -0.5),
        new THREE.Vector3(w, 0, 0.5),
    );
    g.getBounds = (target = new THREE.Box3()) => {
        g.updateWorldMatrix(true, false);
        return g.getLocalBounds(target).applyMatrix4(g.matrixWorld);
    };

    // Enrolled background panel
    const panel = createPanelMaterial({ color: 0x0a1220, opacity: 0.92 });
    const bg = enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), panel.material));
    bg.scale.set(w, h, 1);
    bg.position.set(w * 0.5, -h * 0.5, -0.05);
    g.add(bg);
    g._background = bg;
    g._panel = panel;

    // Unbatched main glyph field
    const field = new InstancedField(null, mockAtlas, { maxInstances: 64 });
    field.loadText(`$ echo ${id}\nready`);
    g.add(field.instanceMesh);
    g._renderer = field;

    // Enrolled label glyph field (batched by GlyphBatch)
    const labelField = enrollGlyphField(new InstancedField(null, mockAtlas, { maxInstances: 32 }));
    labelField.loadText(id);
    g.add(labelField.instanceMesh);
    g._labelField = labelField;

    return g;
}

const UNIT = { column: 0.725, cellPx: 8, rowRatio: 1.359375 / 0.725 };

console.log('=== carrel-cards.test.mjs ===');

// ── 1. Tier selection & aspect-matched dimensions ───────────────────────────
{
    ok(CARD_TIERS.join(',') === '256,512,1024,2048', 'CARD_TIERS is [256, 512, 1024, 2048]');
    ok(tierForProjectedPx(120) === 256, '120 px -> 256 tier');
    ok(tierForProjectedPx(256) === 256, '256 px -> 256 tier');
    ok(tierForProjectedPx(300) === 512, '300 px -> 512 tier');
    ok(tierForProjectedPx(900) === 1024, '900 px -> 1024 tier');
    ok(tierForProjectedPx(1600) === 2048, '1600 px -> 2048 tier');
    ok(tierForProjectedPx(4096) === 2048, '4096 px -> clamped to 2048 tier');

    const dWide = dimsForTier({ width: 200, height: 100 }, 512);
    ok(dWide.width === 512 && dWide.height === 256 && dWide.tier === 512,
        `2:1 rect at tier 512 -> 512x256 (got ${JSON.stringify(dWide)})`);

    const dTall = dimsForTier({ width: 100, height: 200 }, 1024);
    ok(dTall.width === 512 && dTall.height === 1024 && dTall.tier === 1024,
        `1:2 rect at tier 1024 -> 512x1024 (got ${JSON.stringify(dTall)})`);

    const dNat = dimsForTier({ width: 58, height: 32.625, nativeW: 640, nativeH: 360 }, 'native');
    ok(dNat.width === 640 && dNat.height === 360 && dNat.tier === 'native',
        `native tier returns exact nativeW x nativeH (got ${JSON.stringify(dNat)})`);
}

// ── 2. getCardRect for plane desk and ring/wall desk ────────────────────────
{
    const scene = new THREE.Scene();
    const transforms = new SceneTransforms(scene);

    const planeDesk = new Carrel({ name: 'plane-desk', mode: 'plane', planeArrange: 'tiles', tileCols: 80, tileRows: 24, animDur: 0 });
    planeDesk.position.set(100, 0, -200);
    scene.add(planeDesk);
    planeDesk.setPlaneUnit(UNIT);
    const g1 = makeMockGrid('term:1', 80, 24);
    scene.add(g1);
    planeDesk.lock('term:1', g1, { immediate: true });
    planeDesk.animator.update?.(10);

    const pr = getCardRect(planeDesk);
    const wantPr = planeDesk.getPlaneRect();
    const boardPx = planeDesk.tileFrame();
    ok(pr !== null && wantPr !== null, 'getCardRect returns rect for plane desk');
    near(pr.width, wantPr.width, 1e-5, 'plane card rect width matches Carrel.getPlaneRect()');
    near(pr.height, wantPr.height, 1e-5, 'plane card rect height matches Carrel.getPlaneRect()');
    ok(pr.nativeW === boardPx.widthPx && pr.nativeH === boardPx.heightPx,
        `plane card rect records native pixel dims (${pr.nativeW}x${pr.nativeH})`);

    // Nested plane desk inside a parent scaled 0.5 (e.g. a gomux team desk at the hub):
    // world width/height are halved, pxPerUnit is doubled, and card native px == board device px.
    const parentGroup = new THREE.Group();
    parentGroup.scale.setScalar(0.5);
    scene.add(parentGroup);
    const nestedDesk = new Carrel({ name: 'nested-plane', mode: 'plane', planeArrange: 'tiles', tileCols: 80, tileRows: 24, animDur: 0 });
    parentGroup.add(nestedDesk);
    nestedDesk.setPlaneUnit(UNIT);
    const gNested = makeMockGrid('term:nested', 80, 24);
    scene.add(gNested);
    nestedDesk.lock('term:nested', gNested, { immediate: true });
    nestedDesk.animator.update?.(10);

    const npr = getCardRect(nestedDesk);
    const wantNpr = nestedDesk.getPlaneRect();
    near(npr.width, wantPr.width * 0.5, 1e-5, 'nested plane card rect world width is scaled by parent (0.5x)');
    near(npr.height, wantPr.height * 0.5, 1e-5, 'nested plane card rect world height is scaled by parent (0.5x)');
    near(npr.pxPerUnit, wantNpr.pxPerUnit, 1e-5, 'nested plane card rect records world pxPerUnit (= planeK / scale)');
    ok(npr.nativeW === boardPx.widthPx && npr.nativeH === boardPx.heightPx,
        `nested plane desk (scale 0.5) card native px == board device px (${npr.nativeW}x${npr.nativeH} === ${boardPx.widthPx}x${boardPx.heightPx})`);
    const nestedDims = dimsForTier(npr, 'native');
    ok(nestedDims.width === boardPx.widthPx && nestedDims.height === boardPx.heightPx,
        `dimsForTier(nestedRect, 'native') matches board device px (${nestedDims.width}x${nestedDims.height})`);

    const ringDesk = new Carrel({ name: 'ring-desk', radius: 80, animDur: 0 });
    ringDesk.position.set(-150, 0, -200);
    scene.add(ringDesk);
    const g2 = makeMockGrid('term:2', 80, 24);
    scene.add(g2);
    ringDesk.lock('term:2', g2, { immediate: true });
    ringDesk.animator.update?.(10);

    const rr = getCardRect(ringDesk);
    ok(rr !== null && rr.width > 10 && rr.height > 10 && rr.nativeW === null,
        `getCardRect returns bounds face for ring desk (${rr?.width?.toFixed(1)}x${rr?.height?.toFixed(1)})`);

    transforms.dispose();
}

// ── 3. THE LAYER STATEMENT (§3.16): zero GlyphBatch/PanelBatch repacks ──────
{
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060a12);
    const transforms = new SceneTransforms(scene);
    const panelBatch = new PanelBatch(scene);
    const glyphBatch = new GlyphBatch(scene, mockAtlas);
    const glyphFarLod = new GlyphFarLod(scene);

    let glyphRepacks = 0;
    const origGlyphRepack = glyphBatch._repack.bind(glyphBatch);
    glyphBatch._repack = function () {
        glyphRepacks++;
        return origGlyphRepack();
    };
    let glyphUpdates = 0;
    const origGlyphUpdate = glyphBatch.update.bind(glyphBatch);
    glyphBatch.update = function (cam) {
        glyphUpdates++;
        return origGlyphUpdate(cam);
    };
    let panelUpdates = 0;
    const origPanelUpdate = panelBatch.update.bind(panelBatch);
    panelBatch.update = function (cam) {
        panelUpdates++;
        return origPanelUpdate(cam);
    };

    const carrel = new Carrel({ name: 'alpha', mode: 'plane', planeArrange: 'tiles', tileCols: 80, tileRows: 24, animDur: 0 });
    scene.add(carrel);
    carrel.setPlaneUnit(UNIT);
    const g = makeMockGrid('term:alpha', 80, 24);
    scene.add(g);
    carrel.lock('term:alpha', g, { immediate: true });
    carrel.animator.update?.(10);

    // Simulate GlyphFarLod having disabled layer 0 on the main glyph field at far distance.
    g._renderer.instanceMesh.layers.disable(0);

    const viewCam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
    viewCam.position.set(0, 0, 500);
    viewCam.lookAt(0, 0, 0);
    viewCam.updateMatrixWorld(true);

    // Run one main-camera render so GlyphBatch and PanelBatch settle their initial state.
    let currentTarget = null;
    const seenInCardPass = [];
    const mockRenderer = {
        domElement: { width: 1600, height: 942, clientWidth: 1600, clientHeight: 942 },
        autoClear: true,
        getRenderTarget: () => currentTarget,
        setRenderTarget: (t) => { currentTarget = t; },
        getClearAlpha: () => 1,
        getClearColor: (c) => c.set(0x060a12),
        setClearColor: () => {},
        clear: () => {},
        clearDepth: () => {},
        render: (sc, cam) => {
            sc.onBeforeRender?.(mockRenderer, sc, cam, currentTarget);
            if (cam.layers.isEnabled(CARD_LAYER) && !cam.layers.isEnabled(0)) {
                sc.traverse((obj) => {
                    if ((obj.isMesh || obj.isLineSegments) && obj.layers.test(cam.layers)) {
                        seenInCardPass.push(obj);
                    }
                });
            }
            sc.onAfterRender?.(mockRenderer, sc, cam);
        },
    };

    const ctx = {
        scene,
        renderer: mockRenderer,
        atlas: mockAtlas,
        canvas: mockRenderer.domElement,
        carrels: new Map([['alpha', carrel]]),
    };
    const overlay = new PlaneOverlay(ctx);
    overlay.setText('hud', { x: 20, y: 20, px: 13, text: 'HUD' });

    // Initial main pass
    mockRenderer.render(scene, viewCam);
    const repacksBefore = glyphRepacks;
    const glyphUpdatesBefore = glyphUpdates;
    const panelUpdatesBefore = panelUpdates;
    const panelEnrolledBefore = panelBatch.stats.enrolled;

    const cards = new CarrelCards(ctx);
    const snap = cards.capture(carrel, { tier: 512 });

    ok(snap !== null && snap.tier === 512, 'CarrelCards.capture succeeds on CARD_LAYER');
    ok(glyphRepacks === repacksBefore,
        `GlyphBatch repack count unchanged across card pass (${glyphRepacks} === ${repacksBefore})`);
    ok(glyphUpdates === glyphUpdatesBefore,
        `GlyphBatch.update did not run during card pass (${glyphUpdates} === ${glyphUpdatesBefore})`);
    ok(panelUpdates === panelUpdatesBefore,
        `PanelBatch.update did not run during card pass (${panelUpdates} === ${panelUpdatesBefore})`);
    ok(panelBatch.stats.enrolled === panelEnrolledBefore,
        `Card FrameGrid did not pollute PanelBatch enrolled set (${panelBatch.stats.enrolled} === ${panelEnrolledBefore})`);

    // Verify the card pass saw the member's background panel, main glyph field (even though
    // GlyphFarLod had disabled layer 0 on it!), and enrolled label field!
    ok(seenInCardPass.includes(g._background), 'Card pass saw the enrolled panel mesh on CARD_LAYER');
    ok(seenInCardPass.includes(g._renderer.instanceMesh), 'Card pass saw the main glyph field even when layer 0 was disabled by GlyphFarLod');
    ok(seenInCardPass.includes(g._labelField.instanceMesh), 'Card pass saw the enrolled label field on CARD_LAYER');
    ok(!g._background.layers.isEnabled(CARD_LAYER)
        && !g._renderer.instanceMesh.layers.isEnabled(CARD_LAYER)
        && !g._labelField.instanceMesh.layers.isEnabled(CARD_LAYER),
        'CARD_LAYER bit is cleanly restored after the card pass');

    // Follow-up main pass after capture (while still showing 'live') must not repack GlyphBatch either!
    mockRenderer.render(scene, viewCam);
    ok(glyphRepacks === repacksBefore,
        `GlyphBatch repack count remains unchanged on the following main render (${glyphRepacks} === ${repacksBefore})`);

    cards.dispose();
    overlay.dispose();
    glyphFarLod.dispose();
    glyphBatch.dispose();
    panelBatch.dispose();
    transforms.dispose();
}

// ── 4. Lifecycle: carrel.leave postcard, budgetMs cap, live=6, LRU maxBytes & hysteresis ──
{
    const scene = new THREE.Scene();
    const transforms = new SceneTransforms(scene);

    let planeListeners = [];
    const mockCC = {
        addPlaneListener: (fn) => planeListeners.push(fn),
        removePlaneListener: (fn) => { planeListeners = planeListeners.filter((f) => f !== fn); },
    };

    let fakeNow = 1000;
    const carrels = new Map();
    for (let i = 0; i < 8; i++) {
        const name = `desk-${i}`;
        const c = new Carrel({ name, radius: 80, animDur: 0 });
        // Place desk-0 closest to the camera, desk-7 farthest
        c.position.set(0, 0, -(i + 1) * 200);
        scene.add(c);
        const g = makeMockGrid(`term:${i}`, 80, 24);
        scene.add(g);
        c.lock(`term:${i}`, g, { immediate: true });
        c.animator.update?.(10);
        carrels.set(name, c);
    }

    let currentTarget = null;
    const mockRenderer = {
        autoClear: true,
        getRenderTarget: () => currentTarget,
        setRenderTarget: (t) => { currentTarget = t; },
        getClearAlpha: () => 1,
        getClearColor: (c) => c.set(0),
        setClearColor: () => {},
        clear: () => {},
        render: () => {},
    };

    const ctx = {
        scene,
        renderer: mockRenderer,
        atlas: mockAtlas,
        carrels,
        cameraController: mockCC,
        enteredCarrel: null,
    };

    const cards = new CarrelCards(ctx, { live: 6, budgetMs: 1.5, maxBytes: 64 * 1024 * 1024 });
    ctx.carrelCards = cards;

    // 4.0 Default enabled=false gates per-frame update and leave-captures
    ok(cards.cfg.enabled === false, 'CarrelCards defaults to enabled=false');
    ctx.enteredCarrel = 'desk-0';
    for (const fn of planeListeners) fn(true);
    ctx.enteredCarrel = null;
    for (const fn of planeListeners) fn(false);
    ok(cards.get('desk-0') === null, 'when enabled=false, carrel.leave does not auto-capture');

    // Enable CarrelCards for lifecycle checks
    cards.configure({ enabled: true });

    // Validate RT size seam check (throws loudly when exceeding maxTextureSize)
    let threwRange = false;
    try {
        cards.capture('desk-0', { width: 8192, height: 8192 });
    } catch (err) {
        threwRange = err instanceof RangeError;
    }
    ok(threwRange, '_acquireTarget throws RangeError when render-target dimensions exceed cap');

    // 4a. Entering and leaving a plane captures the postcard automatically
    ctx.enteredCarrel = 'desk-0';
    for (const fn of planeListeners) fn(true);
    ctx.enteredCarrel = null;
    for (const fn of planeListeners) fn(false);

    const d0 = cards.get('desk-0');
    ok(d0 && d0.target && d0.reason === 'leave', 'carrel.leave listener captures the postcard');

    // 4b. Top `live = 6` near-live vs staleness stamp on the 7th/8th carrels
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
    cam.position.set(0, 0, 100);
    cam.lookAt(0, 0, -1000);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    cards.update(cam, 1000);
    const list1 = cards.list().cards;
    const nearLiveCount = list1.filter((c) => c.nearLive).length;
    const staleCount = list1.filter((c) => c.stale).length;
    ok(nearLiveCount === 6, `top 6 carrels by projected size are nearLive (got ${nearLiveCount})`);
    ok(staleCount === 2, `carrels beyond top 6 with dirty content carry staleness stamp (got ${staleCount})`);

    // 4c. Live <-> card swap with hysteresis (1.0 / 0.85)
    // Capture desk-0 at max tier 2048 and test swap thresholds by moving camera closer/farther.
    cards.capture('desk-0', { tier: 2048 });
    // Far camera: projected size < 0.85 * 2048 -> swaps to 'card'
    cam.position.set(0, 0, 800);
    cam.updateMatrixWorld(true);
    cards.update(cam, 1000);
    ok(cards.get('desk-0').showing === 'card', 'far camera (pxPerTexel < 0.85) swaps carrel to card');
    ok(carrels.get('desk-0').entries.get('term:0').grid.visible === false
        && cards.get('desk-0').frame.visible === true,
        'in card mode, member grids are hidden and 1x1 FrameGrid is visible');

    // Mid-hysteresis zone (0.85 <= pxPerTexel < 1.0): stays 'card'
    const rect0 = getCardRect(carrels.get('desk-0'));
    const e5 = cam.projectionMatrix.elements[5];
    const wantDepthMid = (Math.max(rect0.width, rect0.height) * e5 * 1000) / (2 * 0.92 * 2048);
    cam.position.set(0, 0, rect0.center.z + wantDepthMid);
    cam.updateMatrixWorld(true);
    cards.update(cam, 1000);
    ok(cards.get('desk-0').showing === 'card', 'inside hysteresis band (0.92 px/texel), card stays card');

    // Close camera (pxPerTexel >= 1.0): swaps back to 'live'
    const wantDepthClose = (Math.max(rect0.width, rect0.height) * e5 * 1000) / (2 * 1.15 * 2048);
    cam.position.set(0, 0, rect0.center.z + wantDepthClose);
    cam.updateMatrixWorld(true);
    cards.update(cam, 1000);
    ok(cards.get('desk-0').showing === 'live', 'close camera (1.15 px/texel >= 1.0) swaps card back to live');
    ok(carrels.get('desk-0').entries.get('term:0').grid.visible === true
        && cards.get('desk-0').frame.visible === false,
        'in live mode, member grids are visible and FrameGrid is hidden');

    // Entering hysteresis band from 'live' (0.92 px/texel >= 0.85): stays 'live'
    cam.position.set(0, 0, rect0.center.z + wantDepthMid);
    cam.updateMatrixWorld(true);
    cards.update(cam, 1000);
    ok(cards.get('desk-0').showing === 'live', 'inside hysteresis band from live (0.92 px/texel), stays live');

    // 4d. Byte-capped LRU pool eviction falls back to 'live'
    // Cap pool at 1.5 MB and capture two 512x512 (~1 MB each) cards: first must be evicted.
    cards.configure({ maxBytes: Math.floor(1.5 * 1024 * 1024) });
    cards.capture('desk-0', { width: 512, height: 512 });
    cards.setDisplayMode('desk-0', 'card');
    await new Promise((r) => setTimeout(r, 2));
    cards.capture('desk-1', { width: 512, height: 512 });
    ok(cards.totalBytes <= Math.floor(1.5 * 1024 * 1024),
        `totalBytes (${cards.totalBytes}) stays within maxBytes cap`);
    ok(cards.get('desk-0').target === null && cards.get('desk-0').showing === 'live',
        'evicted LRU card disposes its target and falls back to live mode');
    ok(cards.get('desk-1').target !== null, 'newly captured card retains its target');

    // 4e. Command verbs: carrel.card and card.list
    const router = new CommandRouter(ctx);
    registerLabelCommands(router);
    const resCard = await router.execute('carrel.card desk-2 512 --show card');
    ok(resCard.text.startsWith('OK: carrel.card "desk-2"') && resCard.data.tier === 512 && resCard.data.showing === 'card',
        `carrel.card verb captures and switches mode (${resCard.text})`);

    const resList = await router.execute('card.list');
    ok(resList.text.includes('OK:') && Array.isArray(resList.data?.cards) && resList.data.cards.length === 8,
        'card.list verb reports all cards with tier, age, and bytes');

    cards.dispose();
    transforms.dispose();
}

// ── 5. Real WebGL2 GPU Gate: card vs live terminal maxChannelDelta <= 1, half-px offset fails, < 2ms ──
{
    let browser = null;
    try {
        browser = await launchGpuBrowser();
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const viteOrigin = (process.env.GLYPH_VITE_URL || 'http://localhost:5173').replace(/\/$/, '');
        await page.goto(`${viteOrigin}/?session=off`, { waitUntil: 'load', timeout: 30000 });
        await page.waitForFunction(() => !!window.__glyphClient?.ctx?.atlas, { timeout: 20000 });

        const rootDir = process.cwd();
        const gpuResult = await page.evaluate(async (root) => {
            const { default: SceneTransforms } = await import(`/@fs${root}/packages/glyph3d-core/src/collections/SceneTransforms.js`);
            const { default: GlyphBatch, enrollGlyphField } = await import(`/@fs${root}/packages/glyph3d-core/src/collections/GlyphBatch.js`);
            const { default: PanelBatch, enrollPanel } = await import(`/@fs${root}/packages/glyph3d-core/src/collections/PanelBatch.js`);
            const { default: TerminalGrid } = await import(`/@fs${root}/packages/glyph3d-core/src/collections/TerminalGrid.js`);
            const { default: InstancedField } = await import(`/@fs${root}/packages/glyph3d-core/src/collections/InstancedField.js`);
            const { default: Carrel } = await import(`/@fs${root}/packages/glyph3d-core/src/services/interaction/Carrel.js`);
            const { default: CarrelCards, getCardRect } = await import(`/@fs${root}/packages/glyph3d-core/src/collections/CarrelCards.js`);

            const appCtx = window.__glyphClient.ctx;
            const atlas = appCtx.atlas;
            const SceneCtor = appCtx.scene.constructor;
            const RendererCtor = appCtx.renderer.constructor;

            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 360;
            const renderer = new RendererCtor({
                canvas,
                antialias: false,
                alpha: false,
                powerPreference: 'high-performance',
                preserveDrawingBuffer: true,
            });
            renderer.setPixelRatio(1);
            renderer.setSize(640, 360, false);
            renderer.setClearColor(0x060a12, 1.0);

            const scene = new SceneCtor();
            const transforms = new SceneTransforms(scene);
            const panelBatch = new PanelBatch(scene);
            const glyphBatch = new GlyphBatch(scene, atlas);

            let glyphRepacks = 0;
            const origRepack = glyphBatch._repack.bind(glyphBatch);
            glyphBatch._repack = function () {
                glyphRepacks++;
                return origRepack();
            };
            let panelUpdates = 0;
            const origPanelUpdate = panelBatch.update.bind(panelBatch);
            panelBatch.update = function (cam) {
                panelUpdates++;
                return origPanelUpdate(cam);
            };

            const carrel = new Carrel({
                name: 'gpu-desk',
                mode: 'plane',
                planeArrange: 'tiles',
                tileCols: 44,
                tileRows: 14,
                animDur: 0,
            });
            const ColorCtor = carrel._shadow.material.color.constructor;
            scene.background = new ColorCtor(0x060a12);
            scene.add(carrel);

            const term = new TerminalGrid(scene, atlas, {
                cols: 40,
                rows: 12,
                title: 'gpu-term',
                showChrome: false,
            });
            if (term._background) enrollPanel(term._background);
            term.writeBytes(
                '$ bun tools/carrel-cards.test.mjs\r\n'
                + 'PASS: card vs live terminal pixel gate\r\n'
                + '0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n'
                + 'abcdefghijklmnopqrstuvwxyz !@#$%^&*()\r\n',
            );
            // TerminalEmulator flushes writeBytes on requestAnimationFrame
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

            const m = term._metrics || term.metrics;
            const cw = m.charWidth;
            const ls = m.lineSpacing || m.charHeight;

            // Also attach a batched label to the scene to verify GlyphBatch repack invariance on real GPU
            const lbl = enrollGlyphField(new InstancedField(null, atlas, {
                maxInstances: 64,
                worldScale: 0.025,
                slugData: atlas._slugData,
                shaper: atlas._shapeCache || atlas._shaper,
            }));
            lbl.loadText('gpu-scene-label');
            lbl.instanceMesh.position.set(0, 500, 0);
            scene.add(lbl.instanceMesh);

            carrel.setPlaneUnit({ column: cw, cellPx: 8, rowRatio: ls / cw });
            carrel.lock('term:gpu', term, { immediate: true });
            carrel.update(10);
            scene.updateMatrixWorld(true);

            const rect = getCardRect(carrel);
            const W = rect.nativeW;
            const H = rect.nativeH;
            renderer.setSize(W, H, false);

            const ctx = { scene, renderer, atlas, carrels: new Map([['gpu-desk', carrel]]) };
            const cards = new CarrelCards(ctx);

            // Orthographic camera matching the exact carrel plane rect at 1:1 native pixels
            const OrthoCtor = cards.camera.constructor;
            const orthoCam = new OrthoCtor(
                -rect.width * 0.5,
                rect.width * 0.5,
                rect.height * 0.5,
                -rect.height * 0.5,
                0.1,
                500,
            );
            orthoCam.up.copy(rect.up);
            orthoCam.position.copy(rect.center).addScaledVector(rect.normal, 50);
            orthoCam.lookAt(rect.center);
            orthoCam.updateProjectionMatrix();
            orthoCam.updateMatrixWorld(true);

            const gl = renderer.getContext();
            const readFlipped = () => {
                const raw = new Uint8Array(W * H * 4);
                gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
                const out = new Uint8Array(W * H * 4);
                const stride = W * 4;
                for (let y = 0; y < H; y++) {
                    out.set(raw.subarray((H - 1 - y) * stride, (H - y) * stride), y * stride);
                }
                return Array.from(out);
            };

            // 1. Render LIVE member on layer 0
            renderer.setRenderTarget(null);
            renderer.clear(true, true, false);
            renderer.render(scene, orthoCam);
            const livePixels = readFlipped();

            // Warm up shader compilation for FrameGrid once before timing capture
            cards.capture(carrel, { tier: 'native' });
            cards.setDisplayMode(carrel, 'card');
            renderer.render(scene, orthoCam);
            cards.setDisplayMode(carrel, 'live');
            renderer.render(scene, orthoCam);

            const repacksBefore = glyphRepacks;
            const panelUpdatesBefore = panelUpdates;
            const snap = cards.capture(carrel, { tier: 'native' });
            const repacksAfter = glyphRepacks;
            const panelUpdatesAfter = panelUpdates;

            // 2. Switch carrel to 'card' mode and render with the exact same orthoCam on layer 0
            cards.setDisplayMode(carrel, 'card');
            renderer.setRenderTarget(null);
            renderer.clear(true, true, false);
            renderer.render(scene, orthoCam);
            const cardPixels = readFlipped();

            // 3. Teeth check: capture with 0.5 px offset and render
            cards.capture(carrel, { tier: 'native', halfPxOffset: 0.5 });
            cards.setDisplayMode(carrel, 'card');
            renderer.setRenderTarget(null);
            renderer.clear(true, true, false);
            renderer.render(scene, orthoCam);
            const shiftedPixels = readFlipped();

            cards.dispose();
            glyphBatch.dispose();
            panelBatch.dispose();
            transforms.dispose();
            renderer.dispose();

            return {
                W,
                H,
                captureMs: snap.captureMs,
                repacksBefore,
                repacksAfter,
                panelUpdatesBefore,
                panelUpdatesAfter,
                livePixels,
                cardPixels,
                shiftedPixels,
            };
        }, rootDir);

        const liveImg = {
            width: gpuResult.W,
            height: gpuResult.H,
            data: new Uint8Array(gpuResult.livePixels),
        };
        const cardImg = {
            width: gpuResult.W,
            height: gpuResult.H,
            data: new Uint8Array(gpuResult.cardPixels),
        };
        const shiftedImg = {
            width: gpuResult.W,
            height: gpuResult.H,
            data: new Uint8Array(gpuResult.shiftedPixels),
        };

        const cmpExact = measureStillness(liveImg, cardImg, { tolerance: 1 });
        const cmpShifted = measureStillness(liveImg, shiftedImg, { tolerance: 1 });

        console.log(`  [GPU] dims=${gpuResult.W}x${gpuResult.H}, captureMs=${gpuResult.captureMs}ms, maxChannelDelta=${cmpExact.maxDiff}, halfPxShiftDelta=${cmpShifted.maxDiff}`);

        ok(!cmpExact.vacuous && cmpExact.maxDiff <= 1,
            `GPU gate: card vs live terminal maxChannelDelta <= 1 (got ${cmpExact.maxDiff}, changedAboveTol=${cmpExact.changedAboveTol})`);
        ok(cmpShifted.maxDiff > 10 && cmpShifted.changedAboveTol > 50,
            `GPU gate teeth: 0.5px offset fails stillness comparison (got maxDiff=${cmpShifted.maxDiff}, changedAboveTol=${cmpShifted.changedAboveTol})`);
        ok(gpuResult.captureMs < 2.0,
            `GPU gate: card capture < 2 ms (got ${gpuResult.captureMs} ms)`);
        ok(gpuResult.repacksAfter === gpuResult.repacksBefore,
            `GPU gate: GlyphBatch repack count unchanged across card pass (${gpuResult.repacksAfter} === ${gpuResult.repacksBefore})`);
        ok(gpuResult.panelUpdatesAfter === gpuResult.panelUpdatesBefore,
            `GPU gate: PanelBatch update count unchanged across card pass (${gpuResult.panelUpdatesAfter} === ${gpuResult.panelUpdatesBefore})`);

        await page.close();
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
