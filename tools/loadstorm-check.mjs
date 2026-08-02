// loadstorm-check.mjs — the LOAD STORM harness: measure a launch-shaped burst of
// sequential directory loads and hold the batching invariants.
//
//   bun tools/loadstorm-check.mjs                        (relay on :8099 — the scratch fixture)
//   STORM_RELAY=8080 bun tools/loadstorm-check.mjs       (point it elsewhere; NEVER the live display's autosave)
//
// What it does: boots headless, clears the field, picks the fixture's N largest
// directories, then storms them the way session restore does — file.openDir each,
// sequential, awaited. Every load runs a staged loadTrace (reach → list → fetch →
// build → relayout); this harness pulls the ring (load.stats) and asserts the
// STRUCTURE while printing the MILLISECONDS:
//
//   - one trace per source, every trace ends (no half-measured loads)
//   - exactly ONE relayout stage per openDir (the batching discipline — a per-file
//     relayout regression turns a launch quadratic, which is the storm's worst case)
//   - stage coverage: the marked stages account for the trace total (no dark time)
//
// Numbers are PRINTED, not asserted — machines vary; structure doesn't.

import { launchBrowser, openApp } from './itest/driver.mjs';

const RELAY = Number(process.env.STORM_RELAY || 8099);
const SOURCES = Number(process.env.STORM_SOURCES || 3);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

const browser = await launchBrowser({});
try {
    const app = await openApp(browser, { relayPort: RELAY, wait: 8000 });
    if (!app.booted) { console.log('✗ app did not boot'); process.exit(1); }

    // The storm sources: real, meaty directories of THIS repo, reached absolutely
    // (openDir addRoots them on the relay) — deterministic regardless of what the
    // scratch session last saved. Clear first, reset the ring, then storm the way
    // session restore does: sequential, awaited.
    const repo = process.cwd();
    const dirs = [
        `${repo}/packages/glyph3d-core/src/collections`,
        `${repo}/packages/glyph3d-core/src/services`,
        `${repo}/packages/glyph3d-core/src/shaping`,
    ].slice(0, SOURCES);
    const setup = await app.evalPage(`(async () => {
        const dirs = ${JSON.stringify(dirs)};
        const c = window.__glyphClient;
        await c.router.execute(['scene.clear_grids']);
        await c.router.execute(['load.stats', 'clear']);
        // Listener-fire counter: the registry hold must coalesce the per-grid
        // notification storm into a few fires per source (pour beats + close).
        let listenerFires = 0;
        const count = () => listenerFires++;
        c.ctx.registry.addChangeListener(count);
        const t0 = performance.now();
        const results = [];
        for (const d of dirs) results.push((await c.router.execute(['file.openDir', d]))?.text?.slice(0, 60));
        const wall = +(performance.now() - t0).toFixed(0);
        c.ctx.registry.removeChangeListener(count);
        const stats = await c.router.execute(['load.stats']);
        return { wall, results, listenerFires, traces: stats.data.traces, relayouts: stats.data.relayouts ?? 0 };
    })()`);

    const { wall, traces, relayouts } = setup;
    console.log(`storm: ${dirs.length} sources, wall ${wall}ms\n`);
    ok(dirs.length >= 2, 'storm has real sources (non-vacuous)');
    for (const r of setup.results) ok(String(r).startsWith('OK'), `source loaded: ${r}`);

    // ── structure: the batching invariants ──────────────────────────────────
    const opens = traces.filter((t) => t.kind === 'openDir');
    ok(opens.length === dirs.length, `one trace per source (want ${dirs.length}, got ${opens.length})`);
    ok(traces.every((t) => t.total > 0), 'every trace ended (no half-measured loads)');
    for (const t of opens) {
        const r = t.stages.filter((s) => s.name === 'relayout');
        ok(r.length === 1, `${t.target}: exactly ONE relayout per openDir (got ${r.length})`);
        ok(t.stages.some((s) => s.name === 'fetch') && t.stages.some((s) => s.name === 'build'),
            `${t.target}: fetch + build stages present`);
        const sum = t.stages.reduce((n, s) => n + s.ms, 0);
        ok(Math.abs(sum - t.total) <= Math.max(t.total * 0.25, 5),
            `${t.target}: stages cover the total (${sum.toFixed(0)}ms of ${t.total}ms)`);
    }
    ok(relayouts === opens.length, `relayout count == source count (${relayouts} == ${opens.length}) — no hidden re-packs`);

    // The registry hold: ~111 grids must NOT mean ~111 listener passes — a few
    // fires per source (pour heartbeats + the close), bounded well under grid count.
    const gridCount = opens.reduce((n, t) => n + (t.stages.find((s) => s.name === 'build')?.grids ?? 0), 0);
    ok(setup.listenerFires <= dirs.length * 8,
        `registry notifications coalesce (${setup.listenerFires} fires for ${gridCount} grids across ${dirs.length} sources)`);

    // ── numbers: the storm profile (printed, not asserted) ──────────────────
    const agg = new Map();
    for (const t of opens) for (const s of t.stages) {
        const a = agg.get(s.name) || { ms: 0, n: 0 };
        a.ms += s.ms; a.n++; agg.set(s.name, a);
    }
    console.log('\nper stage across the storm:');
    for (const [name, a] of [...agg.entries()].sort((x, y) => y[1].ms - x[1].ms)) {
        console.log(`  ${name.padEnd(10)} ${String(a.ms.toFixed(0)).padStart(6)}ms  (${a.n}×)`);
    }
    for (const t of opens) {
        const grids = t.stages.find((s) => s.name === 'build')?.grids ?? '?';
        console.log(`  · ${t.target}  ${t.total}ms  (${grids} grids)`);
    }

    await app.close();
} finally {
    await browser.close();
}

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
