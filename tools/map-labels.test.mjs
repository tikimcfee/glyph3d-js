/**
 * Headless gate for Step 2: Map labels (`app/client/MapLabels.js` & `label.*` / `maplabel.*` verbs).
 *
 * Verifies:
 *   1. No two placed labels ever overlap, even in a dense 36-candidate field.
 *   2. Priority ordering: a P1 (waiting on Ivan) always beats a P6 (file) for the same cell,
 *      and P0 > P1 > P2 > P3 > P4 > P5 > P6 > P7 > P8 holds pairwise.
 *   3. Variable anchors (`above`, `right`, `below`, `left`) allow nearby candidates to fan out
 *      around a point, with full `triedAnchors` trace in `label.explain <id>`.
 *   4. Hysteresis has teeth:
 *      - Sub-cell camera jitter produces zero placement/anchor flip-flops.
 *      - Self-naming handoff (`worldTitlePx >= labelPx`) uses hysteresis and guarantees
 *        world title and map label are NEVER both shown.
 *   5. Cluster labels (`gomux · 7 agents · 2 waiting`) never aggregate a waiting count away,
 *      and off-screen P0/P1 candidates always get viewport-clamped edge markers.
 *   6. Never truncated (`text === sourceText`), never shrunk below 11 px (`px` in `16/14/13/12/11`).
 *   7. Command-bus verbs: `label.list`, `label.explain <id>`, `label.freeze on|off` (and `maplabel.*`).
 *
 * Run: `bun tools/map-labels.test.mjs`
 */

import * as THREE from 'three';
import { deriveCharSize } from '../packages/glyph3d-core/src/core/cellMetrics.js';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';
import PlaneOverlay from '../app/client/PlaneOverlay.js';
import MapLabels, {
    PRIORITY_CLASSES,
    DISCRETE_PX_STEPS,
    ANCHOR_ORDER,
    rectsOverlap,
    snapDiscretePx,
    formatClusterLabel,
} from '../app/client/MapLabels.js';
import registerLabelCommands from '../app/commands/handlers/labelCommands.js';
import { bootHeadlessFontChain } from './headlessFontChain.mjs';

let passed = 0;
let failed = 0;

function check(cond, label, detail = '') {
    if (cond) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    }
}

async function main() {
    console.log('=== map-labels.test.mjs ===');

    const { chain, slugData } = await bootHeadlessFontChain();
    const charSize = deriveCharSize(chain, 48);
    const fakeAtlas = {
        getCharSize: () => charSize,
        getAtlasMap: () => new Map(),
        getSerializableMetrics: () => ({}),
        _slugData: slugData,
        _shaper: chain,
        _shapeCache: null,
    };

    const mainScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1600 / 1000, 1, 50000);
    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const fakeCanvas = { width: 1600, height: 1000, clientWidth: 1600, clientHeight: 1000 };
    const ctx = {
        scene: mainScene,
        camera,
        atlas: fakeAtlas,
        canvas: fakeCanvas,
        renderer: {
            domElement: fakeCanvas,
            autoClear: true,
            info: { autoReset: true, render: { calls: 0 } },
            getRenderTarget: () => null,
            clearDepth: () => {},
            render: () => {},
        },
        planeOverlay: null,
        mapLabels: null,
    };
    ctx.planeOverlay = new PlaneOverlay(ctx);
    ctx.mapLabels = new MapLabels(ctx, { fadeMs: 0 }); // hard switch for deterministic solver checks

    const router = new CommandRouter(ctx);
    registerLabelCommands(router);

    // -------------------------------------------------------------------------
    // 1. Discrete px steps & never-shrink floor
    // -------------------------------------------------------------------------
    check(snapDiscretePx(16, 11) === 16, 'snapDiscretePx(16) === 16');
    check(snapDiscretePx(15.2, 11) === 16, 'snapDiscretePx(15.2) snaps to 16');
    check(snapDiscretePx(13.4, 11) === 13, 'snapDiscretePx(13.4) snaps to 13');
    check(snapDiscretePx(7, 11) === 11, 'snapDiscretePx(7, 11) clamps at floor 11');

    // -------------------------------------------------------------------------
    // 2. Priority competition: P1 always beats P6 for the same cell, and full P0..P8 ladder
    // -------------------------------------------------------------------------
    ctx.mapLabels.resetHistory();
    ctx.mapLabels.setSyntheticCandidates([
        { id: 'file:app/index.js', class: 'P6', text: 'index.js', x: 0, y: 0, z: 0, interest: 99 },
        { id: 'agent:waiting-1', class: 'P1', text: 'pixels · approve bash', x: 0, y: 0, z: 0, interest: 1 },
    ]);
    let snap = ctx.mapLabels.solvePlacement(camera);
    const p1 = snap.candidates.find((c) => c.id === 'agent:waiting-1');
    const p6 = snap.candidates.find((c) => c.id === 'file:app/index.js');
    check(p1?.state === 'placed', 'P1 waiting agent wins placement over P6 file at same anchor');
    check(p1?.anchor === 'above', 'Winning P1 takes primary anchor "above"');
    // Note: because variable anchors exist, P6 at exact same point still shares anchorCellKey
    // on its primary anchor or collides; let's verify that if only 1 cell/rect is available, P1 wins.

    // Pairwise priority check across all P0..P8 competing for the same 32px cell:
    for (let i = 0; i < PRIORITY_CLASSES.length - 1; i++) {
        const hiClass = PRIORITY_CLASSES[i];
        const loClass = PRIORITY_CLASSES[i + 1];
        ctx.mapLabels.resetHistory();
        ctx.mapLabels.setSyntheticCandidates([
            { id: `lo:${loClass}`, class: loClass, text: `candidate-${loClass}-long-label`, x: 0, y: 0, z: 0, interest: 500 },
            { id: `hi:${hiClass}`, class: hiClass, text: `candidate-${hiClass}-long-label`, x: 2, y: 2, z: 0, interest: 1 },
        ]);
        const s = ctx.mapLabels.solvePlacement(camera);
        const hi = s.candidates.find((c) => c.id === `hi:${hiClass}`);
        const lo = s.candidates.find((c) => c.id === `lo:${loClass}`);
        check(
            hi?.state === 'placed' && lo?.state !== 'placed',
            `Priority ladder: ${hiClass} beats ${loClass} for the same cell`,
            `hi=${hi?.state}, lo=${lo?.state} (${lo?.whyHidden})`
        );
    }

    // -------------------------------------------------------------------------
    // 3. Variable anchors (`above`, `right`, `below`, `left`) & `label.explain`
    // -------------------------------------------------------------------------
    ctx.mapLabels.resetHistory();
    // Adjacent cells (38 world units ≈ 33 device px apart -> distinct 32px anchor cells,
    // but their wide "above" text plates overlap, forcing cand-2 and cand-3 to alternate anchors).
    ctx.mapLabels.setSyntheticCandidates([
        { id: 'cand-1', class: 'P3', text: 'alpha-desk', x: 0, y: 0, z: 0, interest: 40 },
        { id: 'cand-2', class: 'P3', text: 'bravo-desk', x: 38, y: 0, z: 0, interest: 30 },
        { id: 'cand-3', class: 'P3', text: 'charlie-desk', x: -55, y: 22, z: 0, interest: 20 },
    ]);
    snap = ctx.mapLabels.solvePlacement(camera);
    const c1 = snap.candidates.find((c) => c.id === 'cand-1');
    const c2 = snap.candidates.find((c) => c.id === 'cand-2');
    const c3 = snap.candidates.find((c) => c.id === 'cand-3');
    check(c1?.state === 'placed' && c1?.anchor === 'above', 'cand-1 places at "above"');
    check(c2?.state === 'placed' && c2?.anchor !== 'above', `cand-2 shifts to alternate anchor (${c2?.anchor})`);
    check(c3?.state === 'placed' && c3?.anchor !== c1?.anchor && c3?.anchor !== c2?.anchor, `cand-3 shifts to third anchor (${c3?.anchor})`);

    const expRes = await router.execute('label.explain cand-2');
    check(expRes.text.includes('OK: label.explain "cand-2"'), 'label.explain verb succeeds');
    check(
        Array.isArray(expRes.data?.triedAnchors) &&
        expRes.data.triedAnchors[0]?.anchor === 'above' &&
        expRes.data.triedAnchors[0]?.ok === false &&
        expRes.data.triedAnchors[0]?.blockedBy === 'cand-1',
        'label.explain reports triedAnchors with exact blocker id ("cand-1")'
    );

    // -------------------------------------------------------------------------
    // 4. Dense field declutter: NO TWO PLACED LABELS OVERLAP + never truncated/shrunk
    // -------------------------------------------------------------------------
    ctx.mapLabels.resetHistory();
    const dense = [];
    for (let i = 0; i < 36; i++) {
        const cls = PRIORITY_CLASSES[i % PRIORITY_CLASSES.length];
        const angle = (i / 36) * Math.PI * 2;
        const radius = (i % 6) * 28;
        const fullName = `entity-${i}-${cls}-full-untruncated-identifier-name`;
        dense.push({
            id: `dense:${i}`,
            class: cls,
            sourceText: fullName,
            text: fullName,
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
            z: 0,
            interest: 50 - i,
            groupKey: cls === 'P4' ? 'gomux' : null,
            isWaiting: cls === 'P1',
            isAgent: cls === 'P1' || cls === 'P4' || cls === 'P8',
        });
    }
    ctx.mapLabels.setSyntheticCandidates(dense);
    snap = ctx.mapLabels.solvePlacement(camera);
    const placedList = snap.candidates.filter((c) => c.state === 'placed' || c.state === 'edge');
    check(placedList.length >= 4, `Dense field places multiple labels (placed=${placedList.length})`);

    let overlapPairs = 0;
    for (let i = 0; i < placedList.length; i++) {
        for (let j = i + 1; j < placedList.length; j++) {
            if (rectsOverlap(placedList[i].rect, placedList[j].rect, 0)) {
                overlapPairs++;
                console.error(`Overlap between ${placedList[i].id} and ${placedList[j].id}`);
            }
        }
    }
    check(overlapPairs === 0, `No two placed labels overlap in dense 36-candidate field (overlaps=${overlapPairs})`);

    // Never truncated, never shrunk check across all candidates
    let truncatedCount = 0;
    let shrunkCount = 0;
    for (const c of snap.candidates) {
        if (c.text !== c.sourceText || c.text.includes('…') || c.text.includes('...')) {
            truncatedCount++;
        }
        if (!DISCRETE_PX_STEPS.includes(c.px) || c.px < 11) {
            shrunkCount++;
        }
    }
    check(truncatedCount === 0, 'Never truncated: shown text equals source text for every candidate');
    check(shrunkCount === 0, 'Never shrunk: every candidate px is in discrete steps [16,14,13,12,11] >= 11');

    // -------------------------------------------------------------------------
    // 5. Hysteresis under sub-cell camera jitter
    // -------------------------------------------------------------------------
    ctx.mapLabels.resetHistory();
    ctx.mapLabels.setSyntheticCandidates([
        { id: 'peer-a', class: 'P4', text: 'agent-alpha', x: -10, y: 0, z: 0, interest: 20 },
        { id: 'peer-b', class: 'P4', text: 'agent-bravo', x: 10, y: 0, z: 0, interest: 19.5 },
        { id: 'peer-c', class: 'P4', text: 'agent-charlie', x: 0, y: 12, z: 0, interest: 19.0 },
    ]);
    const baseSnap = ctx.mapLabels.solvePlacement(camera);
    const baseSignature = baseSnap.candidates.map((c) => `${c.id}:${c.state}:${c.anchor}`).join('|');

    let flipFlops = 0;
    for (let step = 0; step < 20; step++) {
        // Sub-cell camera jitter (+-1.5 world units at z=1000 is ~1.3 device px < hysteresisPx=4)
        const jx = Math.sin(step * 1.7) * 1.5;
        const jy = Math.cos(step * 2.3) * 1.5;
        camera.position.set(jx, jy, 1000);
        camera.lookAt(jx, jy, 0);
        camera.updateMatrixWorld();
        const jSnap = ctx.mapLabels.solvePlacement(camera);
        const sig = jSnap.candidates.map((c) => `${c.id}:${c.state}:${c.anchor}`).join('|');
        if (sig !== baseSignature) flipFlops++;
    }
    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    check(flipFlops === 0, `Hysteresis prevents flip-flopping under 20 sub-cell camera jitter steps (flipFlops=${flipFlops})`);

    // -------------------------------------------------------------------------
    // 6. Self-naming handoff & hysteresis (world title and map label NEVER both shown)
    // -------------------------------------------------------------------------
    ctx.mapLabels.resetHistory();
    const fakeWorldTitle = { visible: true };
    // At z=1000, fov=60, H=1000: pxPerUnit = 1000 / (2 * 1000 * tan(30°)) = 0.866025 px/unit.
    // With titleRowWorld = 14, at z=1000 worldTitlePx = 12.12 px (< P3's 14 px -> map names it).
    // At z=750, pxPerUnit = 1.1547 -> worldTitlePx = 16.16 px (>= 14 px -> self-named!).
    // At z=900, pxPerUnit = 0.96225 -> worldTitlePx = 13.47 px (between 12.5 and 14 -> hysteresis keeps it self-named!).
    // At z=1100, pxPerUnit = 0.7873 -> worldTitlePx = 11.02 px (< 12.5 -> map names it again!).
    ctx.mapLabels.setSyntheticCandidates([
        {
            id: 'carrel:main',
            class: 'P3',
            text: 'main-carrel',
            x: 0,
            y: 0,
            z: 0,
            titleRowWorld: 14,
            titleObject: fakeWorldTitle,
        },
    ]);

    // Far (z = 1000): map label shown, world title hidden
    camera.position.set(0, 0, 1000);
    camera.updateMatrixWorld();
    snap = ctx.mapLabels.solvePlacement(camera);
    let cm = snap.candidates[0];
    check(cm.state === 'placed' && !cm.worldTitleShown && fakeWorldTitle.visible === false, 'Far away: map label is placed and world title is hidden');

    // Near (z = 750): self-named, map label hidden, world title shown
    camera.position.set(0, 0, 750);
    camera.updateMatrixWorld();
    snap = ctx.mapLabels.solvePlacement(camera);
    cm = snap.candidates[0];
    check(cm.state === 'hidden' && cm.whyHidden === 'self-named' && cm.worldTitleShown && fakeWorldTitle.visible === true, 'Close up: thing names itself (whyHidden="self-named") and map label hides');

    // Hysteresis band (z = 900, worldTitlePx ≈ 13.47 px, inside [12.5, 14]): stays self-named!
    camera.position.set(0, 0, 900);
    camera.updateMatrixWorld();
    snap = ctx.mapLabels.solvePlacement(camera);
    cm = snap.candidates[0];
    check(cm.state === 'hidden' && cm.whyHidden === 'self-named' && cm.worldTitleShown, 'Self-naming hysteresis holds in [px - selfNameHysteresisPx, px] band without flickering');

    // Past hysteresis threshold (z = 1100, worldTitlePx ≈ 11.02 px < 12.5): map names it again
    camera.position.set(0, 0, 1100);
    camera.updateMatrixWorld();
    snap = ctx.mapLabels.solvePlacement(camera);
    cm = snap.candidates[0];
    check(cm.state === 'placed' && !cm.worldTitleShown && fakeWorldTitle.visible === false, 'Beyond hysteresis band: map label takes over again and world title hides');

    camera.position.set(0, 0, 1000);
    camera.updateMatrixWorld();

    // -------------------------------------------------------------------------
    // 7. Cluster labels (`gomux · 7 agents · 2 waiting`) & off-screen P0/P1 edge markers
    // -------------------------------------------------------------------------
    check(
        formatClusterLabel('gomux', 7, 2) === 'gomux · 7 agents · 2 waiting',
        'formatClusterLabel formats "gomux · 7 agents · 2 waiting"'
    );
    check(
        formatClusterLabel('gomux', 7, 0) === 'gomux · 7 agents',
        'formatClusterLabel omits waiting suffix only when waitingCount === 0'
    );

    ctx.mapLabels.resetHistory();
    const gomuxAgents = [];
    for (let i = 0; i < 7; i++) {
        const isWaiting = i < 2;
        gomuxAgents.push({
            id: `agent:gomux-${i}`,
            class: isWaiting ? 'P1' : 'P4',
            text: `gomux-worker-${i}`,
            x: (i % 2) * 3,
            y: Math.floor(i / 2) * 2,
            z: 0,
            interest: 50 - i,
            groupKey: 'gomux',
            isWaiting,
            isAgent: true,
        });
    }
    // Also add an off-screen P1 waiting agent and an off-screen P6 file
    gomuxAgents.push({
        id: 'agent:offscreen-waiting',
        class: 'P1',
        text: 'offscreen-helper · waiting on permission',
        x: 3500,
        y: 0,
        z: 0,
        interest: 80,
        isWaiting: true,
        isAgent: true,
    });
    gomuxAgents.push({
        id: 'file:offscreen-file',
        class: 'P6',
        text: 'offscreen.js',
        x: -3500,
        y: 0,
        z: 0,
        interest: 10,
    });

    ctx.mapLabels.setSyntheticCandidates(gomuxAgents);
    snap = ctx.mapLabels.solvePlacement(camera);

    const cluster = snap.candidates.find((c) => c.id === 'cluster:gomux');
    check(Boolean(cluster), 'Collided gomux group spawns cluster:gomux label');
    check(
        cluster?.text === 'gomux · 7 agents · 2 waiting' && cluster?.waitingCount === 2,
        `Cluster label preserves waiting count ("${cluster?.text}")`
    );

    const offWaiting = snap.candidates.find((c) => c.id === 'agent:offscreen-waiting');
    const offFile = snap.candidates.find((c) => c.id === 'file:offscreen-file');
    check(
        offWaiting?.state === 'edge' && offWaiting?.anchor === 'edge-right',
        `Off-screen P1 waiting agent gets viewport edge marker (state=${offWaiting?.state}, anchor=${offWaiting?.anchor})`
    );
    check(
        offFile?.state === 'hidden' && offFile?.whyHidden === 'offscreen',
        'Off-screen P6 file is hidden with whyHidden="offscreen"'
    );

    // -------------------------------------------------------------------------
    // 8. Command-bus verbs: `label.list`, `label.freeze on|off`
    // -------------------------------------------------------------------------
    const listRes = await router.execute('label.list');
    check(listRes.text.includes('OK:') && listRes.data.candidates.length === snap.candidates.length, 'label.list returns all candidates and cluster');

    const freezeOn = await router.execute('label.freeze on');
    check(freezeOn.data?.frozen === true, 'label.freeze on sets frozen=true');

    // While frozen, changing candidates and calling update() keeps previous placement
    const countBeforeFreezeChange = ctx.mapLabels.snapshot().candidates.length;
    ctx.mapLabels.setSyntheticCandidates([
        { id: 'only-one', class: 'P4', text: 'only-one', x: 0, y: 0, z: 0 },
    ]);
    ctx.mapLabels._hasSolvedOnce = true;
    ctx.mapLabels.update(camera, 0.25);
    check(
        ctx.mapLabels.snapshot().candidates.length === countBeforeFreezeChange,
        'While frozen, update() does not re-run placement solver'
    );

    const freezeOff = await router.execute('label.freeze off');
    check(freezeOff.data?.frozen === false, 'label.freeze off sets frozen=false');
    ctx.mapLabels.update(camera, 0.25);
    check(
        ctx.mapLabels.snapshot().candidates.length === 1,
        'After label.freeze off, update() runs placement solver'
    );

    // -------------------------------------------------------------------------
    // 9. Still-camera gate: 120 still frames -> 0 label moves
    //    (Teeth: before fix, solvePlacement vs _reprojectPlaced alternated between
    //     solveScreen and proj at 8 Hz, and cluster:gomux alternated between 2D screen
    //     mean and 3D centroid projection, producing 87 label moves across 120 frames.)
    // -------------------------------------------------------------------------
    ctx.mapLabels.resetHistory();
    ctx.mapLabels.setSyntheticCandidates([
        { id: 'carrel:alpha', class: 'P3', text: 'alpha-desk', x: -120, y: 40, z: 0, interest: 40 },
        { id: 'carrel:bravo', class: 'P3', text: 'bravo-desk', x: -82, y: 40, z: 0, interest: 35 },
        { id: 'dot:loser', class: 'P6', text: 'shadowed-file.js', x: -120, y: 40, z: 0, interest: 5 },
        { id: 'agent:edge-wait', class: 'P1', text: 'edge-helper · waiting', x: 3200, y: 120, z: 0, interest: 90, isWaiting: true, isAgent: true },
        { id: 'agent:g0', class: 'P1', text: 'worker-0 · waiting', x: 60, y: -30, z: -80, interest: 90, groupKey: 'gomux', isWaiting: true, isAgent: true },
        { id: 'agent:g1', class: 'P4', text: 'worker-1', x: 62, y: -28, z: 0, interest: 30, groupKey: 'gomux', isAgent: true },
        { id: 'agent:g2', class: 'P4', text: 'worker-2', x: 64, y: -32, z: 80, interest: 29, groupKey: 'gomux', isAgent: true },
    ]);

    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    ctx.mapLabels.update(camera, 1 / 60);

    // Pan slightly (inside the 4 px hysteresis deadband) and come to rest:
    camera.position.set(2.2, 1.4, 1000);
    camera.lookAt(2.2, 1.4, 0);
    camera.updateMatrixWorld();
    ctx.mapLabels.update(camera, 1 / 60); // moving frame

    let stillMoves = 0;
    let prevPosById = null;
    for (let f = 0; f < 120; f++) {
        ctx.mapLabels.update(camera, 1 / 60);
        const snapNow = ctx.mapLabels.snapshot();
        const curPosById = new Map();
        for (const c of snapNow.candidates) {
            if (c.state === 'placed' || c.state === 'dot' || c.state === 'edge') {
                curPosById.set(c.id, `${c.state}:${c.anchor}:${c.x},${c.y}`);
            }
        }
        // Also verify overlay items match
        for (const [id, item] of ctx.planeOverlay.items.entries()) {
            curPosById.set(`ov:${id}`, `${item.kind}:${item.x},${item.y}`);
        }
        if (prevPosById) {
            for (const [id, sig] of curPosById.entries()) {
                if (prevPosById.get(id) !== sig) {
                    stillMoves++;
                }
            }
            if (curPosById.size !== prevPosById.size) {
                stillMoves++;
            }
        }
        prevPosById = curPosById;
    }
    check(
        stillMoves === 0,
        `120 still frames -> 0 label moves (moves=${stillMoves})`
    );

    // -------------------------------------------------------------------------
    // 10. Strip occupied screen gate (expanded band + collapsed header, with teeth)
    // -------------------------------------------------------------------------
    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const expandedBandRect = { x: 0, y: 0, w: 192, h: 1000 };
    const collapsedHeaderRect = { x: 12, y: 52, w: 168, h: 26 };

    const stripCandidates = [
        // Deep inside the left strip band (screen x ≈ 90, y ≈ 490)
        { id: 'carrel:desk-extra-1', class: 'P3', text: 'desk-extra-1', x: -820, y: 12, z: 0, interest: 45 },
        // Just outside the right edge of the strip band (screen x ≈ 205, y ≈ 300):
        // 'above' centered at x=205 extends left into [0, 192], so solver must pick 'right'
        { id: 'carrel:near-band', class: 'P3', text: 'near-band-desk', x: -687, y: 231, z: 0, interest: 40 },
        // Near the top-left header (screen x ≈ 90, y ≈ 72)
        { id: 'carrel:under-header', class: 'P3', text: 'header-neighbor', x: -820, y: 494, z: 0, interest: 38 },
        // Off-screen left waiting agent (clamps to left edge unless pushed past strip band)
        { id: 'agent:left-edge-wait', class: 'P1', text: 'left-helper · waiting', x: -3500, y: 0, z: 0, interest: 95, isWaiting: true, isAgent: true },
    ];

    // 10a. TEETH: without strip occupied rect (strip disabled / absent), `carrel:desk-extra-1`
    // and `carrel:near-band` draw directly over the strip band [0, 0, 192, 1000].
    ctx.strip = null;
    ctx.mapLabels.resetHistory();
    ctx.mapLabels.setSyntheticCandidates(stripCandidates);
    ctx.mapLabels.solvePlacement(camera);
    const snapWithoutStrip = ctx.mapLabels.snapshot();
    const extraWithoutStrip = snapWithoutStrip.candidates.find((c) => c.id === 'carrel:desk-extra-1');
    const nearWithoutStrip = snapWithoutStrip.candidates.find((c) => c.id === 'carrel:near-band');
    const edgeWithoutStrip = snapWithoutStrip.candidates.find((c) => c.id === 'agent:left-edge-wait');
    check(
        extraWithoutStrip?.state === 'placed' && rectsOverlap(extraWithoutStrip.rect, expandedBandRect, 0),
        'Teeth: without strip occupiedRect, carrel:desk-extra-1 is placed directly over the strip band',
        JSON.stringify(extraWithoutStrip?.rect)
    );
    check(
        nearWithoutStrip?.state === 'placed' && nearWithoutStrip?.anchor === 'above' && rectsOverlap(nearWithoutStrip.rect, expandedBandRect, 0),
        'Teeth: without strip occupiedRect, carrel:near-band uses centered above anchor and overlaps strip band',
        JSON.stringify(nearWithoutStrip?.rect)
    );
    check(
        edgeWithoutStrip?.state === 'edge' && rectsOverlap(edgeWithoutStrip.rect, expandedBandRect, 0),
        'Teeth: without strip occupiedRect, left off-screen edge marker clamps inside the strip band',
        JSON.stringify(edgeWithoutStrip?.rect)
    );

    // 10b. EXPANDED STRIP: full band [0, 0, 192, 1000] is occupied screen.
    // Every map label / dot / edge marker must be hidden or placed completely clear of expandedBandRect.
    ctx.strip = {
        occupiedRect: () => ({ ...expandedBandRect }),
    };
    ctx.mapLabels.resetHistory();
    ctx.mapLabels.setSyntheticCandidates(stripCandidates);
    ctx.mapLabels.solvePlacement(camera);
    const snapExpanded = ctx.mapLabels.snapshot();

    const extraExpanded = snapExpanded.candidates.find((c) => c.id === 'carrel:desk-extra-1');
    check(
        extraExpanded?.state === 'hidden' && extraExpanded?.whyHidden === 'collided:strip',
        'Expanded strip: candidate deep inside band is hidden with whyHidden=collided:strip (neither label nor dot drawn over band)',
        `${extraExpanded?.state} (${extraExpanded?.whyHidden})`
    );

    const nearExpanded = snapExpanded.candidates.find((c) => c.id === 'carrel:near-band');
    const nearExplain = ctx.mapLabels.explain('carrel:near-band');
    const aboveBlockedByStrip = nearExplain?.triedAnchors?.some((a) => a.anchor === 'above' && a.blockedBy === 'strip');
    check(
        nearExpanded?.state === 'placed'
            && nearExpanded?.anchor === 'right'
            && !rectsOverlap(nearExpanded.rect, expandedBandRect, 0)
            && Boolean(aboveBlockedByStrip),
        'Expanded strip: candidate near band edge shifts anchor from above (blockedBy=strip) to right, clear of band',
        JSON.stringify({ anchor: nearExpanded?.anchor, rect: nearExpanded?.rect, tried: nearExplain?.triedAnchors })
    );

    const edgeExpanded = snapExpanded.candidates.find((c) => c.id === 'agent:left-edge-wait');
    check(
        edgeExpanded?.state === 'edge' && !rectsOverlap(edgeExpanded.rect, expandedBandRect, 0) && edgeExpanded.rect.x >= expandedBandRect.w,
        'Expanded strip: left-side off-screen P1 edge marker is inset past the strip band',
        JSON.stringify(edgeExpanded?.rect)
    );

    const anyExpandedOverlap = snapExpanded.candidates
        .filter((c) => c.state === 'placed' || c.state === 'dot' || c.state === 'edge')
        .some((c) => c.rect && rectsOverlap(c.rect, expandedBandRect, 0));
    check(
        !anyExpandedOverlap,
        'Expanded strip: zero visible map labels, dots, or edge markers overlap the strip band rect'
    );

    // 10c. COLLAPSED STRIP: only the header rect { x: 12, y: 52, w: 168, h: 26 } is occupied screen.
    // Desks below the header (`carrel:desk-extra-1` at y≈490) reclaim the column and place cleanly;
    // candidates near the header (`carrel:under-header` at y≈72) avoid the header rect.
    ctx.strip = {
        occupiedRect: () => ({ ...collapsedHeaderRect }),
    };
    // Calling update() when strip state changes should automatically re-solve even within the 8 Hz window
    ctx.mapLabels.update(camera, 0.001);
    const snapCollapsed = ctx.mapLabels.snapshot();

    const extraCollapsed = snapCollapsed.candidates.find((c) => c.id === 'carrel:desk-extra-1');
    check(
        extraCollapsed?.state === 'placed' && !rectsOverlap(extraCollapsed.rect, collapsedHeaderRect, 0),
        'Collapsed strip: candidate below header (desk-extra-1) places cleanly once band collapses',
        JSON.stringify({ state: extraCollapsed?.state, rect: extraCollapsed?.rect })
    );

    const underHeaderCollapsed = snapCollapsed.candidates.find((c) => c.id === 'carrel:under-header');
    const underHeaderExplain = ctx.mapLabels.explain('carrel:under-header');
    const headerBlockedAbove = underHeaderExplain?.triedAnchors?.some((a) => a.anchor === 'above' && a.blockedBy === 'strip');
    check(
        Boolean(headerBlockedAbove)
            && (underHeaderCollapsed?.state === 'hidden' || !rectsOverlap(underHeaderCollapsed.rect, collapsedHeaderRect, 0)),
        'Collapsed strip: candidate near header has above anchor blocked by strip header and does not overlap header rect',
        JSON.stringify({ state: underHeaderCollapsed?.state, anchor: underHeaderCollapsed?.anchor, rect: underHeaderCollapsed?.rect })
    );

    const anyCollapsedOverlap = snapCollapsed.candidates
        .filter((c) => c.state === 'placed' || c.state === 'dot' || c.state === 'edge')
        .some((c) => c.rect && rectsOverlap(c.rect, collapsedHeaderRect, 0));
    check(
        !anyCollapsedOverlap,
        'Collapsed strip: zero visible map labels, dots, or edge markers overlap the collapsed header rect'
    );

    ctx.planeOverlay.dispose();

    console.log(`ok map-labels: ${passed}/${passed + failed} checks passed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
