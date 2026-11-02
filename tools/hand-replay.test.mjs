// hand-replay.test.mjs — a recording round trip through the whole live hand pipeline, headless:
//
//   bun tools/hand-replay.test.mjs
//
// A simulated recording in the relay's source.record format (header, source event, frame lines)
// is written, read back, and replayed through the app's HandCalib — decode → HandModel → merge →
// HandStabilizer → HandMetrics → HandSpace, the code the page runs. Locked:
//   - the acceptance target on the DISPLAYED hand over a whole mixed session (wander, still, move,
//     tilt): every joint's still jitter under 0.5 mm p95, with the lag while moving reported;
//   - the same recording with the stabilizer off jitters by millimetres (the comparison has teeth);
//   - variants run side by side on one recording (a knob changes the numbers, nothing else);
//   - the model still learns from the replay (bones settle, palm length right).

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const quiet = console.log;
console.log = (...a) => { if (!/^\[(source|hand)\]/.test(String(a[0]))) quiet(...a); };
const { synthRecording, replay } = await import('./hand-replay.mjs');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } };

const dir = mkdtempSync(join(tmpdir(), 'hand-replay-'));
const file = join(dir, 'synth.jsonl');
writeFileSync(file, synthRecording(90));
const lines = (await Bun.file(file).text()).trim().split('\n').map((l) => JSON.parse(l));
ok(lines[0].type === 'header' && lines[0].v === 1, 'header line first');
const frames = lines.filter((l) => l.type === 'frame' && l.kind === 'hand');
ok(frames.length === 5400 && frames.every((f) => f.data.type === 'handFrame'), `5400 raw frame lines (${frames.length})`);

const base = replay(frames, { useCloud: false });
const off = replay(frames, { stab: { enabled: false }, useCloud: false });
const loose = replay(frames, { stab: { targetJitter: 0.0004, rotTarget: 0.004 }, useCloud: false });
const r = base.hands.right, ro = off.hands.right, rl = loose.hands.right;
const mm = (x) => (x * 1000).toFixed(2);
console.log(`  displayed still p95 worst: ${mm(r.stability.worstJitterP95)} mm (stabilizer off ${mm(ro.stability.worstJitterP95)}, loose ${mm(rl.stability.worstJitterP95)}); lag ${Math.round(r.stability.lagP50 * 1000)}/${Math.round(r.stability.lagP95 * 1000)} ms p50/p95; ${base.msPerFrame.toFixed(3)} ms/frame`);
ok(r.stability.joints.every((j) => j.jitter.n > 10 && j.jitter.p95 < 0.0005), `every joint still under 0.5 mm p95 over a mixed session (worst ${mm(r.stability.worstJitterP95)} mm)`);
ok(r.stability.lagP50 != null && r.stability.lagP50 < 0.05, `lag while moving reported (${Math.round(r.stability.lagP50 * 1000)} ms p50)`);
ok(ro.stability.worstJitterP95 > 0.005, `stabilizer off: millimetres of jitter (${mm(ro.stability.worstJitterP95)} mm) — the comparison has teeth`);
ok(rl.stability.worstJitterP95 > r.stability.worstJitterP95 && rl.stability.lagP50 <= r.stability.lagP50, 'a looser target trades stillness for lag, side by side on one recording');
ok(r.model.bones.settled === 20 && Math.abs(r.model.scale.value - 0.0921) < 0.002, `the model learns from the replay (bones ${r.model.bones.settled}/20, palm ${r.model.scale.value} m)`);
ok(base.msPerFrame < 2, `fast enough to iterate (${base.msPerFrame.toFixed(3)} ms/frame)`);

console.log = quiet;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
