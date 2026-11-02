// overlay.test.mjs — headless gate for Step 1: PlaneOverlay (§3.6, §4.1, §4.4)
// and the `overlay.text`, `overlay.clear`, `overlay.list` command-bus verbs.
//
// Run:
//   bun tools/overlay.test.mjs

import * as THREE from 'three';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';
import SceneTransforms from '../packages/glyph3d-core/src/collections/SceneTransforms.js';
import GlyphBatch from '../packages/glyph3d-core/src/collections/GlyphBatch.js';
import PanelBatch from '../packages/glyph3d-core/src/collections/PanelBatch.js';
import GlyphFarLod from '../packages/glyph3d-core/src/collections/GlyphFarLod.js';
import { SLOT_FLOATS, LANE_POS_X, LANE_POS_Y, LANE_HEIGHT } from '../packages/glyph3d-core/src/core/InstancedSlotBuffer.js';
import PlaneOverlay, { OVERLAY_LAYER, snapOverlayOrigin, overlayScaleForPx, measureOverlayText } from '../app/client/PlaneOverlay.js';
import registerLabelCommands from '../app/commands/handlers/labelCommands.js';

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
    ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, expected ${b}, diff ${Math.abs(a - b)})`);
}

// Cousine 48 px atlas mock matching runtime deriveCharSize(chain, 48).
const mockAtlas = {
    getCharSize: () => ({ width: 29, height: 54.375, em: 48 }),
    _slugData: null,
    _shaper: {
        upem: 2048,
        lookup: (cp) => ({ g: cp, ax: 1229 }),
    },
};

console.log('=== overlay.test.mjs ===');

// ── 1. Origin snapping & row scale math ─────────────────────────────────────
{
    const s1 = snapOverlayOrigin(120.49, 80.51);
    ok(s1.x === 120 && s1.y === 81 && s1.sceneX === 120 && s1.sceneY === -81,
        'snapOverlayOrigin rounds to integer device pixels and flips y for overlay scene');

    const sc13 = overlayScaleForPx(mockAtlas, 13);
    near(sc13.rowWorld, 1.359375, 1e-9, 'rowWorld is 54.375 * 0.025 = 1.359375');
    near(sc13.charWorld, 0.725, 1e-9, 'charWorld is 29 * 0.025 = 0.725');
    near(sc13.scale * sc13.rowWorld, 13, 1e-9, 'scale * rowWorld == 13 device px exact');
    near(sc13.colPx, 13 * (29 / 54.375), 1e-9, 'colPx = 13 * (29 / 54.375)');

    const m = measureOverlayText(mockAtlas, 'alpha\nbravo!', 42.3, 99.7, 13);
    ok(m.x === 42 && m.y === 100, 'measureOverlayText snaps top-left origin');
    ok(m.cols === 6 && m.rows === 2, 'measureOverlayText counts widest line cols and rows');
    near(m.textRect.h, 26, 1e-9, '2 rows at 13 px = 26 device px tall');
    near(m.textRect.w, 6 * sc13.colPx, 1e-9, '6 cols width matches 6 * colPx');
}

// ── 2. Camera frustum (1 unit = 1 device px) & NDC projection ───────────────
{
    const mainScene = new THREE.Scene();
    const mainTransforms = new SceneTransforms(mainScene);
    const canvas = { width: 1600, height: 942, clientWidth: 800, clientHeight: 471 };
    const ctx = {
        scene: mainScene,
        atlas: mockAtlas,
        canvas,
        renderer: { domElement: canvas },
    };
    const overlay = new PlaneOverlay(ctx);
    const vp = overlay.syncCamera();
    ok(vp.width === 1600 && vp.height === 942 && Math.abs(vp.dpr - 2) < 1e-9,
        `viewport reads drawing buffer 1600x942 at dpr 2 (got ${JSON.stringify(vp)})`);
    ok(overlay.camera.left === 0 && overlay.camera.right === 1600
        && overlay.camera.top === 0 && overlay.camera.bottom === -942,
        'OrthographicCamera frustum is [0, Wdev] x [0, -Hdev]');

    overlay.camera.updateMatrixWorld(true);
    const pv = new THREE.Matrix4().multiplyMatrices(
        overlay.camera.projectionMatrix,
        overlay.camera.matrixWorldInverse,
    );
    const projectToDev = (sceneX, sceneY) => {
        const v = new THREE.Vector3(sceneX, sceneY, 0).applyMatrix4(pv);
        return {
            devX: (v.x + 1) * 0.5 * vp.width,
            devY: (1 - v.y) * 0.5 * vp.height,
        };
    };

    const tl = projectToDev(0, 0);
    near(tl.devX, 0, 1e-6, 'scene (0, 0) projects to device pixel (0, 0) X');
    near(tl.devY, 0, 1e-6, 'scene (0, 0) projects to device pixel (0, 0) Y');

    const br = projectToDev(1600, -942);
    near(br.devX, 1600, 1e-6, 'scene (Wdev, -Hdev) projects to (Wdev, Hdev) X');
    near(br.devY, 942, 1e-6, 'scene (Wdev, -Hdev) projects to (Wdev, Hdev) Y');

    const arbitrary = projectToDev(345, -210);
    near(arbitrary.devX, 345, 1e-6, 'scene (345, -210) projects to devX = 345');
    near(arbitrary.devY, 210, 1e-6, 'scene (345, -210) projects to devY = 210');

    overlay.dispose();
    mainTransforms.dispose();
}

// ── 3. Glyph placement & exact integer row boundaries at 13 px ──────────────
{
    const mainScene = new THREE.Scene();
    const mainTransforms = new SceneTransforms(mainScene);
    const panelBatch = new PanelBatch(mainScene);
    const glyphBatch = new GlyphBatch(mainScene, mockAtlas);
    const glyphFarLod = new GlyphFarLod(mainScene);

    const canvas = { width: 1600, height: 942, clientWidth: 1600, clientHeight: 942 };
    let renderCalls = 0, depthClears = 0;
    let currentTarget = null;
    const mockRenderer = {
        domElement: canvas,
        autoClear: true,
        info: { autoReset: true, render: { calls: 5 } },
        getRenderTarget: () => currentTarget,
        clearDepth: () => { depthClears++; },
        render: (sc) => { sc.updateMatrixWorld(); renderCalls++; },
    };

    const ctx = {
        scene: mainScene,
        atlas: mockAtlas,
        canvas,
        renderer: mockRenderer,
    };
    const overlay = new PlaneOverlay(ctx);

    // Place a 3-row 13 px label at fractional coords (200.4, 150.6) with a backing plate.
    const rec = overlay.setText('test-13', {
        x: 200.4,
        y: 150.6,
        px: 13,
        text: 'Row0\nRow1\nRow2',
        plate: { color: 0x101824, opacity: 0.85 },
    });
    overlay.scene.updateMatrixWorld();

    ok(rec.x === 200 && rec.y === 151, `snapped origin is (200, 151), got (${rec.x}, ${rec.y})`);
    const label = rec.object;
    const mesh = label._instancedField.instanceMesh;

    // Verify every node in the label is on OVERLAY_LAYER (30) and NOT on VIEW_LAYER (0).
    let allOnOverlayLayer = true, anyOnViewLayer = false;
    label.traverse((n) => {
        if (!n.layers.isEnabled(OVERLAY_LAYER)) allOnOverlayLayer = false;
        if (n.layers.isEnabled(0)) anyOnViewLayer = true;
    });
    ok(allOnOverlayLayer && !anyOnViewLayer, 'all overlay label nodes are on OVERLAY_LAYER and not on layer 0');

    // Verify each row's top and bottom edges in overlay scene coordinates land on exact integers!
    const f32 = label._instancedField.slotBuffer.f32;
    const rowTopYs = [], rowBotYs = [];
    // Row 0 starts at slot 0 ('R'), Row 1 at slot 4 ('R'), Row 2 at slot 8 ('R')
    for (const [rowIdx, slotIdx] of [[0, 0], [1, 4], [2, 8]]) {
        const base = slotIdx * SLOT_FLOATS;
        const posX = f32[base + LANE_POS_X];
        const posY = f32[base + LANE_POS_Y];
        const h = f32[base + LANE_HEIGHT];
        const topWorld = new THREE.Vector3(posX, posY + h * 0.5, 0).applyMatrix4(mesh.matrixWorld);
        const botWorld = new THREE.Vector3(posX, posY - h * 0.5, 0).applyMatrix4(mesh.matrixWorld);
        rowTopYs.push(-topWorld.y);
        rowBotYs.push(-botWorld.y);
        near(topWorld.x, 200, 1e-5, `Row ${rowIdx} col 0 left edge is at device pixel x = 200`);
        near(-topWorld.y, 151 + rowIdx * 13, 1e-5, `Row ${rowIdx} top edge is at exact integer y = ${151 + rowIdx * 13}`);
        near(-botWorld.y, 151 + (rowIdx + 1) * 13, 1e-5, `Row ${rowIdx} bottom edge is at exact integer y = ${151 + (rowIdx + 1) * 13}`);
    }

    // Verify main-scene batches skip the overlay completely, regardless of 3D camera pose.
    const cam3d = new THREE.PerspectiveCamera(70, 1600 / 942, 1, 20000);
    for (const pose of [
        { pos: [0, 0, 500], rot: [0, 0, 0] },
        { pos: [2500, -800, 4200], rot: [0.4, -1.2, 0] },
        { pos: [-50, 10, 15], rot: [-0.2, 2.5, 0] },
    ]) {
        cam3d.position.set(...pose.pos);
        cam3d.rotation.set(...pose.rot);
        cam3d.updateMatrixWorld(true);
        cam3d.updateProjectionMatrix();

        const gbStats = glyphBatch.update(cam3d);
        const pbStats = panelBatch.update(cam3d);
        const lodStats = glyphFarLod.update(cam3d, 942);

        ok(gbStats.drawn === 0 && gbStats.elsewhere >= 1, 'GlyphBatch skips overlay field (counted as elsewhere)');
        ok(pbStats.drawn === 0 && pbStats.elsewhere >= 1, 'PanelBatch skips overlay plate (counted as elsewhere)');
        ok(lodStats.backdrops === 0, 'GlyphFarLod stages 0 backdrops for overlay field');
        ok(mesh.layers.isEnabled(OVERLAY_LAYER) && !mesh.layers.isEnabled(0),
            'overlay mesh layer untouched by 3D camera batches');
    }

    // The overlay is the frame's `overlay` pass (app/client/FramePasses.js): its render draws over the
    // main pass with depth cleared and restores the renderer's state.
    overlay.render(mockRenderer);
    ok(renderCalls === 1 && depthClears === 1, 'the overlay pass clears depth and renders the overlay scene');
    ok(mockRenderer.autoClear === true && mockRenderer.info.autoReset === true,
        'overlay pass restores renderer.autoClear and renderer.info.autoReset');

    // No render of the main scene draws it (the frame owner calls it, once): not the main pass, not an
    // offscreen pass (picking), not another camera.
    mainScene.onAfterRender(mockRenderer, mainScene, cam3d);
    currentTarget = {};
    mainScene.onAfterRender(mockRenderer, mainScene, cam3d);
    currentTarget = null;
    const pickCam = new THREE.PerspectiveCamera();
    pickCam.layers.set(31);
    mainScene.onAfterRender(mockRenderer, mainScene, pickCam);
    ok(renderCalls === 1, 'no render of the main scene draws the overlay (it is a frame pass, never a scene hook)');

    overlay.dispose();
    glyphBatch.dispose();
    panelBatch.dispose();
    glyphFarLod.dispose();
    mainTransforms.dispose();
}

// ── 4. Command-bus verbs: overlay.text, overlay.list, overlay.clear ─────────
{
    const mainScene = new THREE.Scene();
    const mainTransforms = new SceneTransforms(mainScene);
    const canvas = { width: 1600, height: 942, clientWidth: 1600, clientHeight: 942 };
    const ctx = {
        scene: mainScene,
        atlas: mockAtlas,
        canvas,
        renderer: { domElement: canvas },
    };
    const router = new CommandRouter(ctx);
    registerLabelCommands(router);

    const r1 = await router.execute('overlay.text greet 100.4 200.6 13 "Hello\\nOverlay"');
    ok(r1.text.startsWith('OK:') && r1.data?.id === 'greet', `overlay.text succeeded: ${r1.text}`);
    ok(r1.data.x === 100 && r1.data.y === 201 && r1.data.px === 13 && r1.data.rows === 2,
        'overlay.text returns snapped coords (100, 201), px=13, rows=2');

    const hit = ctx.planeOverlay.hitTest(110, 215);
    ok(hit?.id === 'greet', 'PlaneOverlay.hitTest resolves the placed overlay item');
    ok(ctx.planeOverlay.hitTest(10, 10) === null, 'PlaneOverlay.hitTest returns null outside item rect');

    const list1 = await router.execute('overlay.list');
    ok(list1.data?.count === 1 && list1.data.items[0].id === 'greet', 'overlay.list reports the active item');

    const clr1 = await router.execute('overlay.clear greet');
    ok(clr1.data?.removed === 1 && ctx.planeOverlay.items.size === 0, 'overlay.clear <id> removes and disposes item');

    await router.execute('overlay.text a 10 10 13 A');
    await router.execute('overlay.text b 10 30 13 B');
    const clrAll = await router.execute('overlay.clear');
    ok(clrAll.data?.removed === 2 && ctx.planeOverlay.items.size === 0, 'overlay.clear removes all manual items');

    ctx.planeOverlay.dispose();
    mainTransforms.dispose();
}

console.log(`${fail ? 'FAIL' : 'ok'} overlay: ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
