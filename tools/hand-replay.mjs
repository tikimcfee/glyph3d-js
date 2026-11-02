#!/usr/bin/env bun
// hand-replay.mjs — replay a sensor recording through the WHOLE live hand pipeline, headless, and
// print the numbers that matter: is a still hand still, and how far behind is a moving one.
//
//   bun tools/hand-replay.mjs <recording.jsonl> [options]
//   bun tools/hand-replay.mjs --synth <seconds> [--out file.jsonl]     # a simulated recording
//
//   --source <id>            replay one source (default: the first hand source in the file)
//   --no-cloud               skip the LiDAR cloud tracker even where frames carry a depth crop
//   --set k=v                a knob for every run: hand.stab.<k> | hand.model.<k> | hand.space.<stage>.<k> | cloud.<k>
//   --variant "name:k=v,k=v" run again with these knobs on top (repeatable) — compare side by side
//   --joints                 print each joint's still-jitter p95
//   --json                   the full reports as JSON
//
// Recordings come from the relay: `./glyph3d-cli source.record start <name>` … `stop` (files land
// in the user cache dir's glyph3d/recordings unless serve --record-dir). Each frame goes, by its
// device time, through SourceStream → the app's HandCalib (decode → HandModel → the cloud
// tracker's fit for that frame → merge → HandStabilizer → HandMetrics → HandSpace) — the same code
// the page runs, with localStorage and the camera stubbed. Fits are synchronous here (age 0);
// live they run 30–60 ms behind in a worker.

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), get length() { return store.size; }, key: (i) => [...store.keys()][i],
};
globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent ??= class { constructor(type) { this.type = type; } };

const THREE = await import('three');
const { default: SourceStream } = await import('../packages/glyph3d-core/src/services/orchestration/SourceStream.js');
const { default: HandPresence } = await import('../packages/glyph3d-core/src/hand/HandPresence.js');
const { HandSim } = await import('../packages/glyph3d-core/src/hand/index.js');
const { default: HandCloudTracker } = await import('../packages/glyph3d-core/src/hand/cloud/HandCloudTracker.js');
const { default: HandCalib } = await import('../app/client/HandCalib.js');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const all = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));

/** Parse "k=v,k=v" knob lists (numbers and booleans typed). */
function knobs(spec) {
    const out = {};
    for (const kv of String(spec).split(',').filter(Boolean)) {
        const [k, v] = kv.split('=');
        out[k.trim()] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v;
    }
    return out;
}

/** A simulated recording in the relay's format (no depth crops). */
export function synthRecording(seconds, { seed = 3 } = {}) {
    const deep = {};
    for (const j of [4, 8, 12, 16, 20]) deep[j] = 0.008;
    for (const j of [3, 7, 11, 15, 19]) deep[j] = 0.004;
    for (const j of [2, 6, 10, 14, 18]) deep[j] = 0.002;
    const sim = new HandSim({ seed, sigmaXY: 0.0006, sigmaZ: 0.0009, extraDepthNoise: deep });
    const lines = [JSON.stringify({ type: 'header', v: 1, name: `synth-${seconds}s`, started: new Date(0).toISOString(), sources: [] })];
    lines.push(JSON.stringify({ type: 'source', t: 0, event: 'connected', source: 'src-hand-0', kind: 'hand' }));
    const plan = [['wander', 0.35], ['flat', 0.25], ['motion', 0.2], ['tilt', 0.2]];
    let t = 1e3, k = 0;
    for (const [mode, share] of plan) {
        sim.setMode(mode);
        for (let i = 0; i < share * seconds * 60; i++, t += 1 / 60, k++) {
            lines.push(JSON.stringify({ type: 'frame', t: k * (1000 / 60), source: 'src-hand-0', kind: 'hand', data: sim.frame(t) }));
        }
    }
    return lines.join('\n') + '\n';
}

/** Read a recording's frame lines (optionally one source). */
async function readFrames(path, source) {
    const frames = [];
    let src = source;
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const raw of rl) {
        if (!raw.trim()) continue;
        const line = JSON.parse(raw);
        if (line.type !== 'frame' || line.kind !== 'hand') continue;
        if (!src) src = line.source;
        if (line.source !== src) continue;
        frames.push(line);
    }
    return { frames, source: src };
}

/**
 * Replay frames through a fresh pipeline with these knobs; return the reports.
 * @param {Array} frames - recording frame lines
 * @param {{stab?: Object, model?: Object, space?: Object, cloud?: Object, useCloud?: boolean}} cfg
 */
export function replay(frames, cfg = {}) {
    const stream = new SourceStream({ bridge: { onSourceEvent: () => () => {} } });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
    const presence = new HandPresence({ stream, camera, scene });
    const tracker = cfg.useCloud === false ? null : new HandCloudTracker(cfg.cloud || {});
    let fits = 0, fitJoints = { cloud: 0, vision: 0, prior: 0 }, fitMs = 0;
    const calib = new HandCalib({ stream, presence, persistEveryS: 1e9 });
    calib.fitProvider = (_source, h, t, hand) => {
        if (!tracker || !hand?.cloud) return null;
        const t0 = performance.now();
        const L = tracker.track({
            cloud: hand.cloud, hand, handedness: h, t,
            bones: Object.fromEntries(Object.entries(calib.model.skeleton(h)?.bones ?? {}).filter(([, b]) => b.length > 0).map(([k, b]) => [k, b.length])),
            ceiling: calib.model.device.ceiling,
        });
        fitMs += performance.now() - t0;
        if (!L?.hand) return null;
        fits++;
        for (const s of L.hand.source) if (s in fitJoints) fitJoints[s]++;
        return { ...L.hand, t, age: 0 };
    };
    for (const [k, v] of Object.entries(cfg.model || {})) calib.model.opts[k] = v;
    for (const [k, v] of Object.entries(cfg.stab || {})) calib.setStab(k, v);
    for (const [k, v] of Object.entries(cfg.space || {})) calib.setSpace(k, v);
    const id = frames[0]?.source ?? 'src';
    stream.attachLocal(id, 'hand');
    const t0 = performance.now();
    for (const f of frames) stream.injectFrame(id, f.data);
    const wall = performance.now() - t0;
    const st = calib.status();
    const hands = {};
    for (const [h, m] of Object.entries(st.model.hands)) {
        const c = calib.chains.get(h);
        hands[h] = { model: m, stability: c ? c.metrics.report() : null, stab: c ? c.stab.describe() : null };
    }
    calib.dispose();
    return { frames: frames.length, wallMs: wall, msPerFrame: wall / Math.max(1, frames.length), fits, fitJoints, fitMs, device: st.model.device, hands };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
    const synth = opt('--synth');
    if (synth) {
        const text = synthRecording(Number(synth));
        const out = opt('--out', `synth-${synth}s.jsonl`);
        writeFileSync(out, text);
        console.log(`wrote ${out} (${text.split('\n').length - 1} lines)`);
        process.exit(0);
    }
    const file = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
    if (!file) { console.error('usage: bun tools/hand-replay.mjs <recording.jsonl> [--source id] [--no-cloud] [--set k=v]… [--variant "name:k=v,…"]… [--joints] [--json]'); process.exit(2); }
    const { frames, source } = await readFrames(file, opt('--source'));
    if (!frames.length) { console.error(`no hand frames in ${file}`); process.exit(1); }

    const split = (kv) => {
        const cfg = { stab: {}, model: {}, space: {}, cloud: {} };
        for (const [k, v] of Object.entries(kv)) {
            if (k.startsWith('hand.stab.')) cfg.stab[k.slice(10)] = v;
            else if (k.startsWith('hand.model.')) cfg.model[k.slice(11)] = v;
            else if (k.startsWith('hand.space.')) cfg.space[k.slice(11)] = v;
            else if (k.startsWith('cloud.')) cfg.cloud[k.slice(6)] = v;
            else throw new Error(`unknown knob '${k}' (hand.stab.* | hand.model.* | hand.space.* | cloud.*)`);
        }
        return cfg;
    };
    const base = split(Object.assign({}, ...all('--set').map(knobs)));
    const merge = (a, b) => ({ stab: { ...a.stab, ...b.stab }, model: { ...a.model, ...b.model }, space: { ...a.space, ...b.space }, cloud: { ...a.cloud, ...b.cloud } });
    const runs = [['base', base], ...all('--variant').map((v) => { const [name, spec] = v.split(':'); return [name, merge(base, split(knobs(spec)))]; })];

    const span = (frames.at(-1).data.timestamp - frames[0].data.timestamp) || 0;
    console.log(`${file}: ${frames.length} frames of ${source} over ${span.toFixed(1)} s (device clock)`);
    const results = [];
    for (const [name, cfg] of runs) {
        const r = replay(frames, { ...cfg, useCloud: !flag('--no-cloud') });
        results.push({ name, ...r });
        const mm = (x) => (x == null ? '—' : (x * 1000).toFixed(2));
        const ms = (x) => (x == null ? '—' : Math.round(x * 1000));
        for (const [h, x] of Object.entries(r.hands)) {
            const s = x.stability, m = x.model;
            console.log(`  [${name}] ${h}: still jitter p95 worst ${mm(s?.worstJitterP95)} mm (joint ${s?.worstJoint ?? '—'}) · lag ${ms(s?.lagP50)}/${ms(s?.lagP95)} ms p50/p95`
                + ` · palm ${m.scale.value ?? '—'} m · bones ${m.bones.settled}/${m.bones.of} · pinch on ${m.pinch.value?.on ?? '—'}${m.pinch.prior ? ' (prior)' : ''}`
                + ` · ${x.stab?.measured ?? 0}/21 joints' noise measured`);
            if (flag('--joints') && s) console.log(`      p95 by joint (mm): ${s.joints.map((j) => mm(j.jitter.p95)).join(' ')}`);
        }
        console.log(`  [${name}] ${r.msPerFrame.toFixed(3)} ms/frame · cloud fits ${r.fits} (${r.fits ? `${(r.fitMs / r.fits).toFixed(1)} ms each; joints ${Object.entries(r.fitJoints).map(([k, v]) => `${k} ${(v / r.fits).toFixed(1)}`).join(' / ')}` : 'no crops'}) · bumps ${r.device.bumps}`);
    }
    if (flag('--json')) console.log(JSON.stringify(results, null, 1));
}
