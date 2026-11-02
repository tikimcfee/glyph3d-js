/**
 * cloudWorker — the hand cloud tracker off the main thread. A module worker (no DOM, no
 * Three.js): it holds one HandCloudTracker, and optionally a simulated source (HandSim +
 * DepthSim) that emits handFrames WITH depth crops — which the page injects into its
 * SourceStream like any device, so they come back here through the same path a phone's do.
 *
 * Protocol (postMessage):
 *   page → worker
 *     {type: 'opts', opts}                     tracker knobs (merged; take hold next frame)
 *     {type: 'track', seq, cloud, hand, bones, ceiling, t, handedness, view}
 *                                              one hand's crop; `view` asks for the per-pixel planes.
 *                                              Latest wins per hand, in here: the page posts every crop.
 *     {type: 'reset'}                          forget the temporal state
 *     {type: 'sim', cmd: 'on'|'off'|'mode'|'bump', mode?, rate?, seed?, sim?, depth?, yawDeg?, tiltDeg?}
 *   worker → page
 *     {type: 'result', seq, replaced, status, hand, pinch, workerMs, queuedMs, view?}
 *                                              (`replaced`: the seqs this crop superseded unseen;
 *                                              view planes are transferred)
 *     {type: 'simFrame', payload}              a simulated handFrame (v2 + hands[i].cloud)
 *     {type: 'error', where, message, stack}
 */

import HandCloudTracker from './HandCloudTracker.js';
import DepthSim from './DepthSim.js';
import HandSim from '../HandSim.js';

const tracker = new HandCloudTracker();
let sim = null;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);
const fail = (where, e) => post({ type: 'error', where, message: e?.message ?? String(e), stack: e?.stack ?? null });

/** The planes a view draws, copied out of the tracker's reused buffers (so they can be transferred). */
function viewPlanes(L) {
    const c = L.cloud, n = c.rw * c.rh;
    const xyz = L.xyz.slice(0, 3 * n);
    const cls = L.segment.cls.slice();
    const geo = L.tips.geo ? L.tips.geo.slice() : null;
    const inliers = L.palm.inliers ? L.palm.inliers.slice() : new Int32Array(0);
    const holeIdx = new Int32Array(L.holes.holes.filter((h) => h.ok).flatMap((h) => h.pixels));
    const transfer = [xyz.buffer, cls.buffer, inliers.buffer, holeIdx.buffer];
    if (geo) transfer.push(geo.buffer);
    return {
        planes: {
            crop: { x0: c.x0, y0: c.y0, rw: c.rw, rh: c.rh, w: c.w, h: c.h, fx: c.fx, fy: c.fy, cx: c.cx, cy: c.cy, R: Array.from(c.R) },
            xyz, cls, geo, inliers, holeIdx,
            palm: L.palm.ok ? { center: L.palm.center, normal: L.palm.plane.normal, radius: L.palm.radius, axis: L.palm.axis } : null,
            tips: L.tips.tips.map((t) => ({ p: t.p, joint: t.joint, clipped: t.clipped })),
            fit: L.fit.ok ? { joints: L.fit.joints, source: L.fit.source, confidence: L.fit.confidence, outOfView: L.edge.outOfView } : null,
        },
        transfer,
    };
}

function startSim(m) {
    stopSim();
    const hs = new HandSim({ seed: m.seed ?? 1, ...(m.sim || {}) });
    hs.setMode(m.mode || 'wander');
    const ds = new DepthSim(m.depth || {});
    const rate = m.rate || 30;
    const t0 = performance.now() / 1000;
    sim = {
        hs, ds, rate,
        timer: setInterval(() => {
            try {
                const payload = ds.attach(hs.frame(performance.now() / 1000 - t0 + 1000), hs);
                post({ type: 'simFrame', payload });
            } catch (e) { fail('sim', e); }
        }, 1000 / rate),
    };
}
function stopSim() { if (sim) { clearInterval(sim.timer); sim = null; } }

/** handedness → the newest crop waiting; the seqs it replaced. */
const pending = new Map();
const replacedBy = {};
let scheduled = false;

/** Track the crop that has waited longest (one hand per turn), then yield to the queue. */
function drain() {
    scheduled = false;
    const first = pending.entries().next();
    if (first.done) return;
    const [side, m] = first.value;
    pending.delete(side);
    const replaced = replacedBy[side] || [];
    delete replacedBy[side];
    const got = performance.now();
    try {
        const L = tracker.track({ cloud: m.cloud, hand: m.hand, bones: m.bones, ceiling: m.ceiling, t: m.t, handedness: m.handedness });
        const msg = L
            ? { type: 'result', seq: m.seq, replaced, status: tracker.status(), hand: L.hand, pinch: L.pinch, workerMs: performance.now() - got, queuedMs: got - m.receivedAt }
            : { type: 'result', seq: m.seq, replaced, status: null, hand: null, pinch: null };
        if (L && m.view) {
            const { planes, transfer } = viewPlanes(L);
            msg.view = planes;
            post(msg, transfer);
        } else post(msg);
    } catch (e) {
        post({ type: 'error', where: 'track', seq: m.seq, replaced, message: e?.message ?? String(e), stack: e?.stack ?? null });
    }
    if (pending.size && !scheduled) { scheduled = true; setTimeout(drain, 0); }
}

self.onmessage = (ev) => {
    const m = ev.data;
    try {
        switch (m.type) {
            case 'opts':
                Object.assign(tracker.opts, m.opts);
                break;
            case 'reset':
                tracker.reset();
                break;
            case 'track': {
                // Latest wins HERE: a crop waiting for its hand is replaced by a newer one, so
                // the page never has to wait for a result before sending the next crop.
                const prev = pending.get(m.handedness);
                if (prev) (replacedBy[m.handedness] ??= []).push(prev.seq);
                m.receivedAt = performance.now();
                pending.set(m.handedness, m);
                if (!scheduled) { scheduled = true; setTimeout(drain, 0); }
                break;
            }
            case 'sim':
                if (m.cmd === 'on') startSim(m);
                else if (m.cmd === 'off') stopSim();
                else if (m.cmd === 'mode' && sim) sim.hs.setMode(m.mode);
                else if (m.cmd === 'bump' && sim) sim.hs.bump({ yawDeg: m.yawDeg ?? 0, tiltDeg: m.tiltDeg ?? 0 });
                break;
            default:
                fail('message', new Error(`cloudWorker: unknown message type '${m?.type}'`));
        }
    } catch (e) { fail(m?.type ?? 'message', e); }
};
