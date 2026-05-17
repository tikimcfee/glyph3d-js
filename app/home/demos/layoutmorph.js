/**
 * demo.layoutmorph — animate the welcome + tryThis pair through
 * different layout compositions: HStack → VStack → ZStack → HStack.
 *
 * The point: the layout kit isn't just a static positioner. Composition
 * is choreography. Watching the two clusters slide between HStack,
 * VStack, and ZStack arrangements is the most direct way to *show*
 * what the kit does that a static screenshot can't.
 *
 * Per-frame: tween each grid's THREE.Object3D position toward the
 * phase's target. Cluster sizes are read at start via layoutBounds()
 * so the target positions honor real extent. After each phase the
 * page holds briefly so the eye can settle.
 *
 * Cleanup: the catalog's `restore` callback calls layoutRoot.layout()
 * after this resolves, which snaps the grids back to the canonical
 * HStack arrangement.
 */

import { tween, sleep, easeInOutCubic } from './helpers.js';

const PHASE_MS = 1100;
const HOLD_MS  = 600;
const GAP      = 36;     // matches the HStack gap in HomeShell
const V_GAP    = 28;     // vertical gap in VStack mode (generous)
const Z_GAP    = 50;     // forward/back depth in ZStack mode (subtle, frame-safe)

function vec(g) { return { x: g.position.x, y: g.position.y, z: g.position.z }; }
function set(g, v) { g.position.set(v.x, v.y, v.z); }

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpVec(a, b, t) {
    return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t),
    };
}

export default async function demoLayoutMorph({ welcome, tryThis, bar, run }) {
    const signal = run?.signal;
    const wG = welcome?.grid, tG = tryThis?.grid;
    if (!wG || !tG) return { text: 'ERR: missing clusters' };

    // Measure once. Sizes don't change during the demo.
    const wBox = wG.layoutBounds();
    const tBox = tG.layoutBounds();
    const wW = wBox.max.x - wBox.min.x, wH = wBox.max.y - wBox.min.y;
    const tW = tBox.max.x - tBox.min.x, tH = tBox.max.y - tBox.min.y;

    // Snapshot starting positions (canonical HStack arrangement).
    const wHome = vec(wG), tHome = vec(tG);

    // Center-x of the HStack pair, in HStack-local frame. This is the
    // x both clusters share in the VStack and ZStack phases — they get
    // re-centered horizontally as a column or a stack.
    const centerX = (wHome.x + tHome.x + tW) / 2;

    // CodeGrid renders text DOWNWARD from its position, so position.y
    // is the TOP edge of the content and (position.y - height) is the
    // BOTTOM. VStack target: lift welcome by half-total above original
    // baseline, then place tryThis directly under welcome's bottom edge
    // with V_GAP between them — no math-by-feel, just geometry.
    const wVStack = {
        x: centerX - wW / 2 - wBox.min.x,
        y: wHome.y + (wH + V_GAP) / 2,
        z: 0,
    };
    const tVStack = {
        x: centerX - tW / 2 - tBox.min.x,
        y: wVStack.y - wH - V_GAP,              // tryThis top = V_GAP below welcome bottom
        z: 0,
    };
    const wZStack = {
        x: centerX - wW / 2 - wBox.min.x,
        y: tHome.y,
        z: +Z_GAP,                              // pulled toward camera
    };
    const tZStack = {
        x: centerX - tW / 2 - tBox.min.x,
        y: tHome.y,
        z: -Z_GAP,                              // pushed back
    };

    // Tween both grids in lock-step from their current pos to targets.
    const morphTo = async (wTarget, tTarget, label) => {
        const wFrom = vec(wG), tFrom = vec(tG);
        if (bar && label) bar.appendOutput(`  • ${label}`, 'info');
        await tween(PHASE_MS, t => {
            set(wG, lerpVec(wFrom, wTarget, t));
            set(tG, lerpVec(tFrom, tTarget, t));
        }, { signal, ease: easeInOutCubic });
    };

    // Diagnostic strings stay quiet in normal use; uncomment when iterating.
    // console.log(`[morph] welcome ${wW.toFixed(1)}×${wH.toFixed(1)} box.y=[${wBox.min.y.toFixed(1)}..${wBox.max.y.toFixed(1)}] home=(${wHome.x.toFixed(1)},${wHome.y.toFixed(1)})`);
    // console.log(`[morph] tryThis ${tW.toFixed(1)}×${tH.toFixed(1)} box.y=[${tBox.min.y.toFixed(1)}..${tBox.max.y.toFixed(1)}] home=(${tHome.x.toFixed(1)},${tHome.y.toFixed(1)})`);

    try {
        await sleep(150, signal);
        await morphTo(wVStack, tVStack, 'VStack — stacked vertically');
        await sleep(HOLD_MS, signal);

        await morphTo(wZStack, tZStack, 'ZStack — layered in depth');
        await sleep(HOLD_MS, signal);

        await morphTo(wHome, tHome, 'HStack — back to the side-by-side');

        bar?.appendOutput('  • morph complete', 'info');
        return { text: 'OK: layout morph done' };
    } catch (e) {
        // Restore to home immediately on cancel so we don't strand
        // clusters in some intermediate phase.
        set(wG, wHome);
        set(tG, tHome);
        if (e?.cancelled) return { text: 'layoutmorph cancelled.' };
        throw e;
    }
}
