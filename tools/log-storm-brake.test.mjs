// log-storm-brake.test.mjs — headless behavior lock for the consoleForwarder storm
// brake (the 2026-08-04 log-flood fix).
//
//   bun tools/log-storm-brake.test.mjs
//
// emitLogRecord is the single funnel for every browser log record. An identical
// error/warn signature (level+scope+msg) beyond BRAKE_PASS is dropped and counted;
// every BRAKE_HEARTBEAT drops one summary warn rides through. Storms interleave
// scopes (error-tracker line + [unhandled-rejection] line alternate per frame), so
// the brake is per-signature, not consecutive-run. Info/log levels are never braked.

import { emitLogRecord, recentConsole } from '../packages/glyph3d-core/src/services/orchestration/consoleForwarder.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

const STORM_MSG = "AbortError: Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists.";

// Count ring records by predicate over the WHOLE ring (module-level, capped 500 —
// keep the ring small by design of what we emit).
const count = (pred) => recentConsole().filter(pred).length;

// ── one signature: first 5 pass, the rest drop ──
{
    const before = count((r) => r.msg === STORM_MSG && r.scope === 'error-tracker');
    for (let i = 0; i < 20; i++) emitLogRecord('error', 'error-tracker', STORM_MSG, null);
    const after = count((r) => r.msg === STORM_MSG && r.scope === 'error-tracker');
    ok(after - before === 5, `20 identical errors → 5 in the ring (got ${after - before})`);
}

// ── interleaved scopes brake independently (the real storm's shape) ──
{
    const sigA = (r) => r.msg === STORM_MSG && r.scope === null && r.msg.startsWith('Abort');
    for (let i = 0; i < 20; i++) {
        emitLogRecord('error', 'error-tracker', STORM_MSG, null);      // already over its 5
        emitLogRecord('error', null, `[unhandled-rejection] ${STORM_MSG}`, null);
    }
    const unhandled = count((r) => r.scope === null && r.msg === `[unhandled-rejection] ${STORM_MSG}`);
    ok(unhandled === 5, `interleaved second scope also capped at 5 (got ${unhandled})`);
    const tracker = count((r) => r.scope === 'error-tracker' && r.msg === STORM_MSG);
    ok(tracker === 5, `first scope stayed capped while interleaving (got ${tracker})`);
}

// ── heartbeat: 500 suppressed → one summary warn ──
{
    const hbBefore = count((r) => r.scope === 'log-brake');
    // 7 already suppressed above (20-5=15 for tracker... compute fresh with a new sig):
    const fresh = 'Error: totally different fresh storm signature';
    for (let i = 0; i < 5 + 500; i++) emitLogRecord('error', 'fresh-scope', fresh, null);
    const freshInRing = count((r) => r.msg === fresh);
    ok(freshInRing === 5, `fresh signature capped at 5 (got ${freshInRing})`);
    const hbAfter = count((r) => r.scope === 'log-brake');
    ok(hbAfter - hbBefore >= 1, `heartbeat fired after 500 suppressed (Δ=${hbAfter - hbBefore})`);
    const hb = recentConsole().filter((r) => r.scope === 'log-brake').pop();
    ok(hb && /suppressed 500/.test(hb.msg), `heartbeat reports the count (got: ${hb?.msg})`);
}

// ── non-error levels are never braked ──
{
    const before = count((r) => r.msg === 'terminal.ping-ish' && r.level === 'info');
    for (let i = 0; i < 30; i++) emitLogRecord('info', 'terminal', 'terminal.ping-ish', null);
    const after = count((r) => r.msg === 'terminal.ping-ish' && r.level === 'info');
    ok(after - before === 30, `30 identical info records all pass (got ${after - before})`);
}

// ── a DIFFERENT error message is a different signature — never suppressed ──
{
    const msg = 'Error: one-off failure, brand new';
    emitLogRecord('error', 'error-tracker', msg, null);
    const seen = count((r) => r.msg === msg);
    ok(seen === 1, 'a fresh error signature lands immediately');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
