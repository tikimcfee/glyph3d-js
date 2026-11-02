#!/usr/bin/env bun
/**
 * Gate for Slice 8 — The strip & `carrel.neighbor` (`docs/planes/DESIGN.md` §3.14).
 *
 * Verifies:
 *   1. `Carrel.prototype.seatMap` & `rollSeat`:
 *      - `l` then `h` returns to the starting seat.
 *      - `l × N` visits every seat once and returns to start.
 *      - `j` / `k` navigates between shelf rows on a multi-row ring/wall.
 *   2. `carrel.neighbor <h|l|j|k|parent|child>`:
 *      - `carrel.neighbor l` then `h` returns to the starting carrel.
 *      - `carrel.neighbor l` repeated N times visits all N carrels once (both top-level bearing ring
 *        and nested desks seated inside a parent hub desk).
 *      - `carrel.neighbor parent` and `carrel.neighbor child` step between outer and nested desks.
 *   3. Strip cards in an entered plane (`Strip` + `PlaneOverlay`):
 *      - Ordered by true bearing from where you stand.
 *      - At most 6 cards on the left edge, remainder in a cluster (`+N more` / `+N more · M waiting`).
 *      - Card click (`overlay.clickAt`) invokes `carrel.enter <name>`.
 *   4. Waiting agents & Deixis off-screen edge marks:
 *      - A waiting agent is always shown on a visible card (with badge) or edge-marked.
 *      - An off-screen Deixis point (`Deixis.show`) emits a clamped edge mark on the strip overlay.
 *   5. Focused-pin non-overlap:
 *      - The strip never covers the focused pin; if the focused pin's screen rect would overlap
 *        `[0, stripRightPx]`, the plane's aim is inset so `pinScreenLeft >= stripRightPx`.
 */

import * as THREE from 'three';
import Carrel from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import PlaneOverlay from '../app/client/PlaneOverlay.js';
import Deixis from '../app/client/Deixis.js';
import registerPlaneCommands from '../app/commands/handlers/planeCommands.js';
import {
    Strip,
    seatMap,
    computeSeatMap,
    rollSeat,
    carrelBearingFrom,
    resolveCarrelNeighbor,
    registerStripCommands,
} from '../app/client/Strip.js';

let passed = 0;
let failed = 0;

function check(cond, msg) {
    if (cond) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${msg}`);
    }
}

function makeBoundedMember(id, w = 24, h = 15, cols = 80, rows = 24) {
    const obj = new THREE.Object3D();
    obj.name = id;
    const charW = w / cols;
    const lineS = h / rows;
    obj.metrics = { charWidth: charW, lineSpacing: lineS };
    obj.cols = cols;
    obj.rows = rows;
    obj.lines = Array.from({ length: rows }, (_, i) => `line ${i + 1} token_${i + 1} content`);
    obj.pixelOrigin = () => ({ x: 0, y: 0 });
    obj.getLocalBounds = (target = new THREE.Box3()) => {
        target.min.set(0, -h, -0.5);
        target.max.set(w, 0, 0.5);
        return target;
    };
    obj.getBounds = (target = new THREE.Box3()) => obj.getLocalBounds(target).applyMatrix4(obj.matrixWorld);
    return obj;
}

function makePlaneUnit() {
    return { column: 0.3, rowRatio: 2.0, cellPx: 9, scale: 30 };
}

function makeTestContext(vpWidth = 1600, vpHeight = 1000) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, vpWidth / vpHeight, 0.1, 2000);
    camera.position.set(0, 10, 40);
    camera.lookAt(0, 10, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const carrels = new Map();
    const registryMap = new Map();
    const registry = {
        register: (id, grid, meta = {}) => registryMap.set(id, { id, grid, ...meta }),
        unregister: (id) => registryMap.delete(id),
        get: (id) => registryMap.get(id) || null,
        has: (id) => registryMap.has(id),
    };

    let currentAim = { x: 0, y: 0 };
    let currentPxPerUnit = 30;
    let inPlane = false;
    const planeListeners = new Set();
    const cameraController = {
        addPlaneListener: (fn) => planeListeners.add(fn),
        planeViewport: () => ({ width: vpWidth, height: vpHeight, dpr: 1, exact: true }),
        isInPlane: () => inPlane,
        planeOf: (obj) => {
            obj?.updateWorldMatrix?.(true, false);
            const b = obj?.getLocalBounds?.();
            if (!b) return null;
            const s = Math.abs(obj?.getWorldScale?.(new THREE.Vector3())?.x ?? 1);
            const w = (b.max.x - b.min.x) * s;
            const h = (b.max.y - b.min.y) * s;
            const d = (b.max.z - b.min.z) * s;
            const center = obj.localToWorld(
                new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2)
            );
            const q = obj.getWorldQuaternion(new THREE.Quaternion());
            return {
                center,
                normal: new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize(),
                up: new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize(),
                width: w,
                height: h,
                depth: d,
            };
        },
        planePointAtView: () => ({ x: 0, y: 0 }),
        planeState: () => (inPlane ? {
            aim: { ...currentAim },
            pxPerUnit: currentPxPerUnit,
            fovDeg: 1,
            camera: { fov: 1, near: 1, far: 1000 },
            viewport: { width: vpWidth, height: vpHeight, dpr: 1, exact: true },
            tweening: false,
            leaving: false,
        } : null),
        setPlaneAim: (x, y) => {
            currentAim = { x, y };
            return true;
        },
        enterPlane: (p) => {
            inPlane = true;
            currentAim = { ...(p.referent || p.aim || { x: 0, y: 0 }) };
            if (p.pxPerUnit > 0) currentPxPerUnit = p.pxPerUnit;
            for (const fn of planeListeners) fn(true);
            return true;
        },
        leavePlane: () => {
            inPlane = false;
            for (const fn of planeListeners) fn(false);
            return true;
        },
        flyTo: () => true,
    };

    const commands = new Map();
    const ctx = {
        scene,
        camera,
        carrels,
        registry,
        getGrids: () => [],
        cameraController,
        enteredCarrel: null,
        activeCarrel: null,
        carrelBack: null,
        gomuxHub: { snapshot: { agents: [] } },
        agentBooks: { lanes: new Map(), agents: () => [] },
        holding: {
            holderOf: () => null,
        },
        deixis: null,
        commandRouter: null,
    };
    ctx.deixis = new Deixis(ctx);

    const router = {
        _commands: commands,
        register: (name, fn) => commands.set(name, fn),
        has: (name) => commands.has(name),
        execute: async (cmdStr) => {
            const parts = cmdStr.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
            const verb = parts[0];
            const args = parts.slice(1).map((a) => (a.startsWith('"') && a.endsWith('"') ? JSON.parse(a) : a));
            const fn = commands.get(verb);
            if (!fn) throw new Error(`Unknown command: ${verb}`);
            return await fn(args, ctx);
        },
    };
    ctx.commandRouter = router;

    // Register a minimal `carrel.enter` matching app/commands/handlers/carrelCommands.js
    router.register('carrel.enter', (args, c) => {
        const name = String(args[0] ?? '');
        const desk = c.carrels.get(name);
        if (!desk) return { text: `ERR: no carrel '${name}'`, data: null };
        const prev = c.enteredCarrel;
        if (prev && prev !== name) c.carrelBack = prev;
        c.activeCarrel = name;
        c.enteredCarrel = name;
        if (desk.mode === 'plane' && desk.planeUnit) {
            const vp = c.cameraController.planeViewport();
            const focus = desk.focusedPin?.();
            const leftInset = c.strip?.leftInsetForCarrel?.(desk) ?? 0;
            const aim = (focus && desk.pinAim(focus, vp, 0, leftInset)) || { x: 0, y: 0 };
            c.cameraController.enterPlane({ aim });
        }
        return { text: `OK: entered '${name}'`, data: { name } };
    });

    registerPlaneCommands(router);
    registerStripCommands(router);
    return { ctx, router, scene, camera, carrels, registry };
}

console.log('=== strip.test.mjs ===');

// ----------------------------------------------------------------------------
// 1. seatMap & rollSeat (single-row and multi-row ring/wall)
// ----------------------------------------------------------------------------
{
    const ring = new Carrel({ name: 'ring-test', mode: 'ring', seat: 'natural', radius: 18, maxArcDeg: 120, ringMaxRows: 1 });
    const ids = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
    ids.forEach((id, i) => {
        ring.lock(id, makeBoundedMember(id, 24, 15), { order: i });
    });

    const map = seatMap(ring);
    check(map.seats.length === ids.length, `seatMap has all ${ids.length} live seats (got ${map.seats.length})`);
    check(map.rows.length >= 1, `seatMap has rows (got ${map.rows.length})`);

    // l then h returns from every seat
    for (const id of ids) {
        const nextL = rollSeat(ring, id, 'l');
        const backH = rollSeat(ring, nextL, 'h');
        check(backH === id, `rollSeat('${id}', 'l') -> '${nextL}' then 'h' returns '${id}' (got '${backH}')`);
    }

    // l × N visits every seat once and returns to start
    const visited = [];
    let cur = ids[0];
    for (let i = 0; i < ids.length; i++) {
        visited.push(cur);
        cur = rollSeat(ring, cur, 'l');
    }
    check(cur === ids[0], `rollSeat 'l' × ${ids.length} returns to '${ids[0]}' (got '${cur}')`);
    check(new Set(visited).size === ids.length, `rollSeat 'l' × ${ids.length} visited all ${ids.length} unique seats`);

    // Multi-row wall (`mode: 'grid'`) j / k row stepping
    const wall = new Carrel({ name: 'wall-test', mode: 'grid', radius: 15 });
    for (let i = 0; i < 6; i++) {
        wall.lock(`w${i}`, makeBoundedMember(`w${i}`, 30, 18), { order: i });
    }
    const wallMap = computeSeatMap(wall);
    check(wallMap.rows.length >= 2, `multi-item grid wall wraps into >= 2 rows (got ${wallMap.rows.length})`);
    const row0Seat = wallMap.rows[0][0];
    const upSeat = rollSeat(wall, row0Seat, 'k');
    check(wallMap.rows[1].includes(upSeat), `rollSeat('${row0Seat}', 'k') steps to row 1 (got '${upSeat}')`);
    const downSeat = rollSeat(wall, upSeat, 'j');
    check(downSeat === row0Seat, `rollSeat('${upSeat}', 'j') steps back to '${row0Seat}' (got '${downSeat}')`);
}

// ----------------------------------------------------------------------------
// 2. `carrel.neighbor` — top-level bearing ring AND nested child carrels
// ----------------------------------------------------------------------------
{
    const { ctx, router, scene, carrels } = makeTestContext();
    const N = 5;
    const R = 40;
    const names = [];
    for (let i = 0; i < N; i++) {
        const name = `desk-${i}`;
        names.push(name);
        const angle = (i / N) * Math.PI * 2;
        const c = new Carrel({ name, mode: 'plane', radius: 12 });
        c.setPlaneUnit(makePlaneUnit());
        c.position.set(Math.sin(angle) * R, 0, -Math.cos(angle) * R);
        c.rotation.y = -angle;
        c.lock(`code-${i}`, makeBoundedMember(`code-${i}`), { order: 0 });
        c.updateWorldMatrix(true, true);
        scene.add(c);
        carrels.set(name, c);
    }

    await router.execute('carrel.enter desk-0');
    check(ctx.enteredCarrel === 'desk-0', 'entered desk-0 initially');

    // `carrel.neighbor l` then `h` returns
    const stepL = await router.execute('carrel.neighbor l');
    check(stepL.data?.to && stepL.data.to !== 'desk-0', `carrel.neighbor l moved from desk-0 to ${stepL.data?.to}`);
    const stepH = await router.execute('carrel.neighbor h');
    check(stepH.data?.to === 'desk-0' && ctx.enteredCarrel === 'desk-0', `carrel.neighbor h returned to desk-0 (got ${stepH.data?.to})`);

    // `carrel.neighbor l` × N visits every carrel once and returns to start
    const seen = [];
    for (let i = 0; i < N; i++) {
        seen.push(ctx.enteredCarrel);
        await router.execute('carrel.neighbor l');
    }
    check(ctx.enteredCarrel === 'desk-0', `carrel.neighbor l × ${N} returned to desk-0 (got ${ctx.enteredCarrel})`);
    check(new Set(seen).size === N, `carrel.neighbor l × ${N} visited all ${N} carrels once (${seen.join(' -> ')})`);

    // Nested child carrels inside an outer hub carrel: `parent`, `child`, and `l`/`h` inside the parent
    const hub = new Carrel({ name: 'gomux', mode: 'ring', seat: 'natural', radius: 25 });
    scene.add(hub);
    carrels.set('gomux', hub);

    const teamNames = ['gomux/alpha', 'gomux/beta', 'gomux/gamma', 'gomux/delta'];
    teamNames.forEach((tName, idx) => {
        const team = new Carrel({ name: tName, mode: 'plane', radius: 10 });
        team.setPlaneUnit(makePlaneUnit());
        team.lock(`${tName}:book`, makeBoundedMember(`${tName}:book`), { order: 0 });
        hub.lock(team.name, team, { order: idx });
        carrels.set(tName, team);
    });
    hub.updateWorldMatrix(true, true);

    await router.execute('carrel.enter "gomux/alpha"');
    const toParent = await router.execute('carrel.neighbor parent');
    check(toParent.data?.to === 'gomux', `carrel.neighbor parent from gomux/alpha -> gomux (got ${toParent.data?.to})`);

    const toChild = await router.execute('carrel.neighbor child');
    check(toChild.data?.to === 'gomux/alpha', `carrel.neighbor child from gomux -> gomux/alpha (got ${toChild.data?.to})`);

    // `l` × 4 across nested teams visits every team once and `l` then `h` returns
    const teamVisited = [];
    for (let i = 0; i < teamNames.length; i++) {
        teamVisited.push(ctx.enteredCarrel);
        await router.execute('carrel.neighbor l');
    }
    check(ctx.enteredCarrel === 'gomux/alpha', `nested carrel.neighbor l × 4 returned to gomux/alpha (got ${ctx.enteredCarrel})`);
    check(new Set(teamVisited).size === teamNames.length, `nested carrel.neighbor l × 4 visited all 4 teams (${teamVisited.join(' -> ')})`);
    await router.execute('carrel.neighbor l');
    await router.execute('carrel.neighbor h');
    check(ctx.enteredCarrel === 'gomux/alpha', `nested carrel.neighbor l then h returned to gomux/alpha`);
}

// ----------------------------------------------------------------------------
// 3. Strip left-edge cards: true bearing order, max 6 cards + cluster, click-to-enter, waiting badge
// ----------------------------------------------------------------------------
{
    const { ctx, router, scene, carrels } = makeTestContext(1600, 1000);
    const overlay = new PlaneOverlay({ width: 1600, height: 1000, dpr: 1 });
    const strip = new Strip(ctx, overlay);
    ctx.strip = strip;

    // Create 1 entered carrel at origin facing -Z (normal = +Z) and 8 other carrels at known bearings
    const home = new Carrel({ name: 'home', mode: 'plane', radius: 10 });
    home.setPlaneUnit(makePlaneUnit());
    home.position.set(0, 0, 0);
    home.rotation.y = 0;
    home.lock('home-pin', makeBoundedMember('home-pin', 24, 15), { order: 0 });
    home.updateWorldMatrix(true, true);
    scene.add(home);
    carrels.set('home', home);

    // 8 other carrels sweeping from left (-70 deg) to right (+70 deg) in front of `home` (-Z)
    const degs = [-70, -50, -30, -10, 10, 30, 50, 70];
    degs.forEach((deg, i) => {
        const rad = (deg * Math.PI) / 180;
        const name = `peer-${i}`;
        const c = new Carrel({ name, mode: 'plane', radius: 10 });
        c.setPlaneUnit(makePlaneUnit());
        // Looking -Z: +X is right, -X is left, -Z is forward
        c.position.set(Math.sin(rad) * 50, 0, -Math.cos(rad) * 50);
        c.lock(`${name}:m`, makeBoundedMember(`${name}:m`, 24, 15), { order: 0 });
        c.updateWorldMatrix(true, true);
        scene.add(c);
        carrels.set(name, c);
    });

    // Make `peer-7` (at +70 deg, normally 8th) have a waiting agent!
    ctx.gomuxHub.snapshot.agents = [
        { name: 'agent-wait-7', live: true, status: 'waiting', detail: 'permission prompt', statusAt: new Date(Date.now() - 15000).toISOString() },
    ];
    ctx.holding.holderOf = (groupId) => (groupId === 'agent:book:agent-wait-7' ? carrels.get('peer-7') : null);

    await router.execute('carrel.enter home');
    strip.update();

    const st = strip.getState();
    const shownCards = st.cards.filter((c) => c.shown);
    check(shownCards.length === 6, `strip shows at most 6 cards on the edge (got ${shownCards.length})`);
    check(st.cluster != null && st.cluster.count === 2, `remaining 2 carrels form a '+2 more' cluster (got ${JSON.stringify(st.cluster)})`);

    // Check that shown cards are strictly ordered by bearing ascending
    for (let i = 1; i < shownCards.length; i++) {
        check(
            shownCards[i].bearing > shownCards[i - 1].bearing,
            `shown strip cards ordered by true bearing: ${shownCards[i - 1].name} (${shownCards[i - 1].bearing.toFixed(2)}) < ${shownCards[i].name} (${shownCards[i].bearing.toFixed(2)})`
        );
    }

    // Check that `peer-7` (which has a waiting agent) was promoted into the visible 6 cards with a waiting badge!
    const peer7Card = shownCards.find((c) => c.name === 'peer-7');
    check(Boolean(peer7Card && peer7Card.waitingCount === 1), 'carrel with waiting agent (peer-7) is shown on the strip with waitingCount=1');
    const peer7OverlayItem = overlay.items.get('strip:card:peer-7');
    check(peer7OverlayItem?.badge === '1 waiting', `peer-7 overlay card has '1 waiting' badge (got '${peer7OverlayItem?.badge}')`);

    // Click the second visible card via `overlay.clickAt` -> switches entered carrel!
    const targetCard = shownCards[1];
    const clickX = targetCard.rect.x + targetCard.rect.w / 2;
    const clickY = targetCard.rect.y + targetCard.rect.h / 2;
    const hitItem = overlay.clickAt(clickX, clickY);
    check(Boolean(hitItem) && ctx.enteredCarrel === targetCard.name, `clicking strip card '${targetCard.name}' enters '${targetCard.name}' (enteredCarrel='${ctx.enteredCarrel}')`);
}

// ----------------------------------------------------------------------------
// 4. Off-screen Deixis point & off-screen waiting agent edge marks
// ----------------------------------------------------------------------------
{
    const { ctx, router, scene, camera, carrels, registry } = makeTestContext(1600, 1000);
    const overlay = new PlaneOverlay({ width: 1600, height: 1000, dpr: 1 });
    const strip = new Strip(ctx, overlay);
    ctx.strip = strip;

    const desk = new Carrel({ name: 'work', mode: 'plane', radius: 10 });
    desk.setPlaneUnit(makePlaneUnit());
    desk.position.set(0, 0, 0);
    const member = makeBoundedMember('app/far.js', 24, 15);
    desk.lock('app/far.js', member, { order: 0 });
    scene.add(desk);
    carrels.set('work', desk);

    // Place a second surface far off to the right in world space (outside camera frustum)
    const offscreenGrid = makeBoundedMember('app/offscreen.js', 24, 15);
    offscreenGrid.position.set(500, 10, 0);
    offscreenGrid.updateMatrixWorld(true);
    scene.add(offscreenGrid);
    registry.register('app/offscreen.js', offscreenGrid, { type: 'code' });

    // Point at `app/offscreen.js:3` with Deixis
    ctx.deixis.show('helper-1', {
        kind: 'code',
        entity: 'app/offscreen.js',
        durable: { path: 'app/offscreen.js', line: 3, col: 1 },
        quote: 'token_3',
        origin: { who: 'helper-1', ts: Date.now() },
        text: 'app/offscreen.js:3 «token_3»',
    }, { kind: 'look', say: 'check this', fill: 0.3 });

    // Also add a waiting agent on `work` whose book is off-screen
    const waitingBook = makeBoundedMember('agent:book:waiter', 24, 15);
    waitingBook.position.set(-500, 10, 0);
    waitingBook.updateMatrixWorld(true);
    scene.add(waitingBook);
    registry.register('agent:book:waiter', waitingBook, { type: 'agent' });
    ctx.gomuxHub.snapshot.agents = [
        { name: 'waiter', live: true, status: 'waiting', detail: 'needs input', statusAt: new Date().toISOString() },
    ];
    ctx.holding.holderOf = (id) => (id === 'agent:book:waiter' ? desk : null);

    await router.execute('carrel.enter work');
    strip.update();

    const st = strip.getState();
    const deixisMark = st.edgeMarks.find((m) => m.kind === 'deixis' && m.who === 'helper-1');
    check(Boolean(deixisMark), `off-screen deixis point produces an edge mark (got ${JSON.stringify(deixisMark)})`);
    check(deixisMark?.edge === 'right', `deixis point at +X=500 is clamped to the right edge (got '${deixisMark?.edge}')`);

    const waitingMark = st.edgeMarks.find((m) => m.kind === 'waiting' && m.who === 'waiter');
    check(Boolean(waitingMark), `off-screen waiting agent produces an edge mark (got ${JSON.stringify(waitingMark)})`);
    check(waitingMark?.edge === 'left', `waiting agent at -X=500 is clamped to the left edge (got '${waitingMark?.edge}')`);
}

// ----------------------------------------------------------------------------
// 5. Focused-pin non-overlap: the strip never covers the focused pin
// ----------------------------------------------------------------------------
{
    const vpW = 1600, vpH = 1000;
    const { ctx, router, scene, carrels } = makeTestContext(vpW, vpH);
    const overlay = new PlaneOverlay({ width: vpW, height: vpH, dpr: 1 });
    const strip = new Strip(ctx, overlay);
    ctx.strip = strip;

    // Create a plane desk with a wide pin (1500 px wide in a 1600 px viewport: centered at x=50,
    // which would overlap the 172 px left-edge strip if not inset!)
    const mainDesk = new Carrel({ name: 'main', mode: 'plane', radius: 10 });
    const unit = makePlaneUnit(); // scale = 30 px/world-unit, cellPx = 9
    mainDesk.setPlaneUnit(unit);
    // 1500 device px wide = 50 world units wide at k=30
    const widePin = makeBoundedMember('wide-pin', 50, 20, 160, 40);
    mainDesk.lock('wide-pin', widePin, { order: 0 });
    mainDesk.updateWorldMatrix(true, true);
    scene.add(mainDesk);
    carrels.set('main', mainDesk);

    // Add a second carrel so the left-edge strip is non-empty
    const otherDesk = new Carrel({ name: 'other', mode: 'plane', radius: 10 });
    otherDesk.setPlaneUnit(unit);
    otherDesk.position.set(-30, 0, -20);
    otherDesk.lock('other-pin', makeBoundedMember('other-pin', 24, 15), { order: 0 });
    otherDesk.updateWorldMatrix(true, true);
    scene.add(otherDesk);
    carrels.set('other', otherDesk);

    // Enter `main` and update the strip
    await router.execute('carrel.enter main');
    strip.update();

    const stripRight = strip.stripRightPx();
    check(stripRight > 0, `strip occupies left edge [0, ${stripRight}] px`);

    // Compute where the focused pin's left edge lands on screen given the plane camera's aim
    const pin = mainDesk.pinRects().find((p) => p.id === 'wide-pin');
    const box = mainDesk._boardPx();
    const k = mainDesk.planeK;
    const pinLeftWorld = -box.w / (2 * k) + pin.rect.x / k;
    const planeAim = ctx.cameraController.planeState().aim;
    const pinScreenLeft = vpW / 2 + (pinLeftWorld - planeAim.x) * k;

    check(
        pinScreenLeft >= stripRight - 1e-3,
        `focused pin screen left (${pinScreenLeft.toFixed(1)} px) >= stripRightPx (${stripRight} px) — strip never covers focused pin`
    );

    // Also test dynamic overlap: if the user/test aims at (0, 0) where pinScreenLeft = 50 < stripRight,
    // `strip.update()` insets the plane aim so `pinScreenLeft >= stripRight`!
    ctx.cameraController.setPlaneAim(0, 0);
    strip.update();
    const aimAfter = ctx.cameraController.planeState().aim;
    const pinScreenLeftAfter = vpW / 2 + (pinLeftWorld - aimAfter.x) * k;
    check(
        pinScreenLeftAfter >= stripRight - 1e-3,
        `dynamic strip.update() insets plane aim so focused pin left (${pinScreenLeftAfter.toFixed(1)} px) >= stripRightPx (${stripRight} px)`
    );
}

// ----------------------------------------------------------------------------
// 6. `plane.enter` on a wide surface (not a desk): column 0 lands right of the
//    strip band, backdrop + cards are opaque, and switching from a desk clears enteredCarrel
// ----------------------------------------------------------------------------
{
    const vpW = 1600, vpH = 942;
    const { ctx, router, scene, carrels, registry } = makeTestContext(vpW, vpH);
    const overlay = new PlaneOverlay({ width: vpW, height: vpH, dpr: 1 });
    const strip = new Strip(ctx, overlay);
    ctx.strip = strip;

    // Set up a pin desk with two pins (like `gomux/glyph3d-js-root` with an AgentBook + wide terminal)
    const unit = makePlaneUnit(); // cellPx = 9, column = 0.3, k = 30
    const teamDesk = new Carrel({ name: 'gomux/root', mode: 'plane', radius: 10 });
    teamDesk.setPlaneUnit(unit);
    const bookPin = makeBoundedMember('root-book', 11.2, 20, 40, 30); // ~336 px wide at Pin 0
    const termSurface = makeBoundedMember('gx-root', 64.2, 27, 214, 45); // 214 cols * 9 px = 1926 px wide
    teamDesk.lock('root-book', bookPin, { order: 0 });
    teamDesk.lock('gx-root', termSurface, { order: 1 });
    teamDesk.updateWorldMatrix(true, true);
    scene.add(teamDesk);
    carrels.set('gomux/root', teamDesk);
    registry.register('gx-root', termSurface, { type: 'terminal' });

    // First enter the desk (`carrel.enter`), then enter the wide terminal directly via `plane.enter gx-root`
    await router.execute('carrel.enter "gomux/root"');
    check(ctx.enteredCarrel === 'gomux/root', 'initially in gomux/root desk');

    const enterRes = await router.execute('plane.enter gx-root');
    check(enterRes.text.startsWith('OK:'), `plane.enter gx-root succeeded (${enterRes.text})`);
    check(ctx.enteredCarrel === null, `plane.enter on non-desk surface clears ctx.enteredCarrel (got ${ctx.enteredCarrel})`);

    strip.update();
    const stripRight = strip.stripRightPx();
    check(stripRight > 0, `strip is active in non-desk plane.enter view (stripRightPx=${stripRight})`);

    // Verify strip backdrop and cards are 100% opaque (`opacity === 1`) and backdrop is non-interactive
    const backdrop = overlay.items.get('strip:backdrop');
    check(
        Boolean(backdrop && backdrop.opacity === 1 && backdrop.rect.x === 0 && backdrop.rect.w === stripRight && backdrop.rect.h === vpH),
        `strip:backdrop covers [0, ${stripRight}] × [0, ${vpH}] at opacity=1 (got ${JSON.stringify(backdrop ? { opacity: backdrop.opacity, rect: backdrop.rect } : null)})`
    );
    check(backdrop?.interactive === false && overlay.hitTest(4, vpH - 10) === null, 'strip:backdrop is non-interactive (does not intercept hitTest)');
    const cardItem = overlay.items.get('strip:card:gomux/root');
    check(Boolean(cardItem && cardItem.opacity === 1), `strip card is opaque (opacity=${cardItem?.opacity})`);

    // Verify the wide surface's column 0 (`origin.x = -plane.width / 2`) lands at/to the right of the strip band!
    const st = ctx.cameraController.planeState();
    const plane = ctx.cameraController.planeOf(termSurface);
    const col0PlaneX = -plane.width / 2;
    const col0ScreenX = vpW / 2 + (col0PlaneX - st.aim.x) * st.pxPerUnit;
    check(
        col0ScreenX >= stripRight - 1e-3 && Math.abs(col0ScreenX - stripRight) < 1.5,
        `plane.enter'd wide surface column 0 screen X (${col0ScreenX.toFixed(2)} px) lands right of the strip band (${stripRight} px)`
    );
}

console.log(`ok strip: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
