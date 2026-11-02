/**
 * HandSim — a plausible hand over a face-down phone, emitted as hand-wire v2 `handFrame`
 * payloads, with KNOWN truth.
 *
 * The phone lies face-down, top edge away from the user; its PHONE frame is +y toward the
 * top edge (where the fingers point), +z up out of its back, +x = y × z (the user's right).
 * The simulated hand hovers palm-down above it: a 21-joint skeleton of fixed bone lengths
 * (scaled by `handScale`), posed by a palm-centre path, an orientation, finger curl, splay
 * and a pinch — the thumb reaches the index tip by CCD inverse kinematics, so bone lengths
 * hold through a pinch. Then the sensor's faults: per-joint Gaussian noise (depth noisier
 * than image-plane), dropped joints (`null`, low confidence), the thumb tip lost from below
 * mid-pinch, fingertips seen in 2-D with no usable depth (a ray, no point), gravity jitter, a
 * ceiling estimate, `hands: []` frames when no hand is in view — and `bump()`, the phone being
 * moved on the desk.
 *
 * MODES are scripts: `wander` (the default) is a person just using it — roaming the space,
 * pausing, pinching, resting flat, moving fast, tilting — which is all the live HandModel
 * needs to converge; `none`, `flat`, `sweep`, `motion`, `pinch` and `tilt` isolate one of
 * those. `truth` is what a perfect model recovers; `lastTruth` is the last frame's pose.
 *
 * Pure and deterministic: a seeded RNG, time passed in. No DOM, no Three.js.
 */

import { Joint, JOINT_COUNT, SKELETON_CONNECTIONS } from './HandData.js';
import {
    v3, add, sub, scale, len, dist, norm, cross, dot, lerp, centroid, rng,
    PALM_JOINTS, HAND_LENGTH_BONES, boneKey, qmul, qconj, qrot, qaxis,
} from './handMath.js';

const TIPS = new Set([Joint.THUMB_TIP, Joint.INDEX_TIP, Joint.MIDDLE_TIP, Joint.RING_TIP, Joint.PINKY_TIP]);
const Q_ID = { w: 1, x: 0, y: 0, z: 0 };
/** The hand's rotation as a quaternion: R = Rz(yaw)·Rx(pitch)·Ry(roll). */
const poseQuat = (yaw = 0, pitch = 0, roll = 0) => qmul(qaxis(v3(0, 0, 1), yaw), qmul(qaxis(v3(1, 0, 0), pitch), qaxis(v3(0, 1, 0), roll)));

/** @typedef {import('./handMath.js').Vec3} Vec3 */

export const SIM_MODES = ['none', 'flat', 'sweep', 'motion', 'pinch', 'tilt', 'palmUp', 'wander'];

export const HAND_SIM_DEFAULTS = {
    rate: 60,                              // frames per second
    seed: 1,
    handedness: 'right',
    handScale: 1.0,                        // × an adult hand (~0.19 m wrist → middle tip)
    center: { x: 0, y: 0.03, z: 0.22 },    // the comfortable palm centre, phone frame, m
    half: { x: 0.12, y: 0.08, z: 0.07 },   // the swept volume's half extents, m
    sigmaXY: 0.0015,                       // per-joint noise across the image plane, m
    sigmaZ: 0.003,                         // per-joint noise in depth, m
    dropout: 0.01,                         // chance a joint goes unseen in a frame
    thumbOcclusion: 0.15,                  // chance the thumb tip is hidden at full pinch
    ceiling: 2.3,                          // m above the phone
    gravityNoise: 0.002,                   // radians-ish, per axis
    sendDelay: 0.008,                      // s, capture → send (plus up to 4 ms of jitter)
    tipDepthLoss: 0.3,                     // chance a seen fingertip has no usable depth (ray only)
    label: null,                           // null: report the true handedness; else what Vision reports instead
    skinPalm: 0.015,                       // m: LiDAR sees the palmar SKIN — wrist + MCPs read this much nearer along their rays
    skinFinger: 0.008,                     // m: … and finger joints this much (hand-wire v2: points are skin-surface points)
    phalangeScale: 1,                      // fingers (phalanges) × this relative to the palm — a non-reference hand
    extraNoise: {},                        // {joint: sigma m} — a joint the detector places worse than the rest
    extraDepthNoise: {},                   // {joint: sigma m} along the joint's RAY only — LiDAR depth at fingertips (5–11 mm live)
    noiseRangeExp: 0,                      // noise × (range / 0.22 m)^k: LiDAR depth and keypoint jitter both grow with range
    accelOnBump: 2,                        // m/s²: userAcceleration reported for the frames after a bump() that moves the phone
    hfovDeg: 70,                           // for the v1 image-space landmarks
};

// ── The skeleton, hand-local: wrist at origin, +y along the fingers, +z the back of the
// hand (palm faces −z), +x toward the pinky for a RIGHT hand. Meters, adult hand.
const MCP = {
    index: v3(-0.024, 0.088, 0),
    middle: v3(-0.004, 0.092, 0),
    ring: v3(0.014, 0.086, 0),
    pinky: v3(0.030, 0.074, 0),
};
const PHALANGES = {
    index: [0.040, 0.024, 0.020],
    middle: [0.045, 0.028, 0.021],
    ring: [0.042, 0.027, 0.021],
    pinky: [0.033, 0.019, 0.018],
};
const SPLAY_DEG = { index: -6, middle: 0, ring: 6, pinky: 14 };
const FINGER_BASE = { index: Joint.INDEX_MCP, middle: Joint.MIDDLE_MCP, ring: Joint.RING_MCP, pinky: Joint.PINKY_MCP };
const THUMB_CMC = v3(-0.018, 0.030, -0.015);
const THUMB_BONES = [0.044, 0.034, 0.028];
/** Thumb tip and index tip joint centres when the pads touch, m (× handScale). */
const PINCH_GAP = 0.012;
const PALM_SET = new Set([Joint.WRIST, Joint.INDEX_MCP, Joint.MIDDLE_MCP, Joint.RING_MCP, Joint.PINKY_MCP]);

const smooth = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };

/** Rotation from yaw (about +z), pitch (about +x), roll (about +y), radians: R = Rz·Rx·Ry. */
function rotation(yaw, pitch, roll) {
    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    const cx = Math.cos(pitch), sx = Math.sin(pitch);
    const cy = Math.cos(roll), sy = Math.sin(roll);
    return (v) => {
        // Ry
        let x = cy * v.x + sy * v.z, y = v.y, z = -sy * v.x + cy * v.z;
        // Rx
        const y1 = cx * y - sx * z, z1 = sx * y + cx * z; y = y1; z = z1;
        // Rz
        const x2 = cz * x - sz * y, y2 = sz * x + cz * y;
        return { x: x2, y: y2, z };
    };
}

/** Rotate v about unit axis k by angle a (Rodrigues). */
function rotateAbout(v, k, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

export default class HandSim {
    /** @param {Partial<typeof HAND_SIM_DEFAULTS>} [opts] */
    constructor(opts = {}) {
        this.opts = { ...HAND_SIM_DEFAULTS, ...opts };
        this._rand = rng(this.opts.seed);
        this.mode = 'wander';
        this._modeStart = null;
        /** The pose behind the last frame (null: no hand) — truth for orientation checks. */
        this.lastPose = null;
        /** The last frame's truth in the phone's CURRENT frame: palm centre (m), hand rotation, noise-free joints. */
        this.lastTruth = null;
        /** Where the phone sits relative to where it started (bump()). */
        this.phone = { q: Q_ID, shift: v3() };
        this._localCentroid = centroid(PALM_JOINTS.map((j) => this._localPose({ curl: 0, splay: 1, pinch: 0 })[j]));
    }

    /**
     * Move the phone on the desk: turn it by `yawDeg`, tip it by `tiltDeg` (about its x axis),
     * slide it by `shift` (m, in its starting frame). Everything after is seen from there.
     * @param {{yawDeg?: number, tiltDeg?: number, shift?: Vec3}} b
     */
    bump({ yawDeg = 0, tiltDeg = 0, shift = v3() } = {}) {
        const r = qmul(qaxis(v3(0, 0, 1), (yawDeg * Math.PI) / 180), qaxis(v3(1, 0, 0), (tiltDeg * Math.PI) / 180));
        this.phone = { q: qmul(this.phone.q, r), shift: add(this.phone.shift, shift) };
        if (len(shift) > 0) this._accelFrames = 6; // a slide shows only in the accelerometer
    }

    /** A point from the starting frame into the phone's current frame. @private */
    _toPhone(p) { return qrot(qconj(this.phone.q), sub(p, this.phone.shift)); }

    /** Switch the script; its clock starts at the next frame. @param {string} mode */
    setMode(mode) {
        if (!SIM_MODES.includes(mode)) throw new Error(`HandSim: unknown mode '${mode}' (${SIM_MODES.join('|')})`);
        if (mode !== this.mode) { this.mode = mode; this._modeStart = null; }
    }

    /**
     * What a perfect calibration recovers from this simulator.
     * @returns {{handedness: string, bones: Record<string, number>, handSize: number, skin: {palm: number, finger: number},
     *   height: number, volume: {min: Vec3, max: Vec3, center: Vec3},
     *   noise: {sigmaXY: number, sigmaZ: number}, pinch: {closed: number, open: number}}}
     */
    get truth() {
        const o = this.opts;
        const flat = this._localPose({ curl: 0, splay: 1, pinch: 0 });
        const closed = this._localPose({ curl: 0, splay: 1, pinch: 1 });
        const bones = {};
        for (const [a, b] of SKELETON_CONNECTIONS) bones[boneKey(a, b)] = dist(flat[a], flat[b]) * o.handScale;
        const handSize = HAND_LENGTH_BONES.reduce((s, [a, b]) => s + bones[boneKey(a, b)], 0);
        return {
            handedness: o.handedness,
            bones,
            handSize,
            height: o.center.z,
            volume: { min: sub(o.center, o.half), max: add(o.center, o.half), center: { ...o.center } },
            noise: { sigmaXY: o.sigmaXY, sigmaZ: o.sigmaZ },
            skin: { palm: o.skinPalm, finger: o.skinFinger },
            pinch: {
                closed: dist(closed[Joint.THUMB_TIP], closed[Joint.INDEX_TIP]) * o.handScale,
                open: dist(flat[Joint.THUMB_TIP], flat[Joint.INDEX_TIP]) * o.handScale,
            },
        };
    }

    /**
     * One v2 frame at time `t` (seconds, the device's clock).
     * @param {number} t
     */
    frame(t) {
        if (this._modeStart == null) this._modeStart = t;
        const o = this.opts;
        const r = this._rand;
        const pose = this._script(t - this._modeStart);
        this.lastPose = pose;

        // Gravity is a direction: rotate it into the phone's current frame (no shift).
        const g = qrot(qconj(this.phone.q), norm(v3(r.gauss() * o.gravityNoise, r.gauss() * o.gravityNoise, -1)));
        const pq = this.phone.q;
        const payload = {
            type: 'handFrame',
            v: 2,
            timestamp: t,
            sentAt: t + o.sendDelay + r() * 0.004,
            mount: 'faceDown',
            device: {
                gravity: [g.x, g.y, g.z], attitude: [pq.x, pq.y, pq.z, pq.w],
                userAcceleration: (this._accelFrames ?? 0) > 0
                    ? (this._accelFrames--, [o.accelOnBump, 0, 0])
                    : [r.gauss() * 0.04, r.gauss() * 0.04, r.gauss() * 0.04],
            },
            ceiling: o.ceiling + r.gauss() * 0.005,
            hands: [],
        };
        if (!pose) { this.lastTruth = null; return payload; }
        this.lastTruth = {
            center: this._toPhone(pose.center),
            q: qmul(qconj(this.phone.q), poseQuat(pose.yaw, pose.pitch, pose.roll)),
            points: [],
        };

        const local = this._localPose(pose);
        const rot = rotation(pose.yaw || 0, pose.pitch || 0, pose.roll || 0);
        const mirror = o.handedness === 'left' ? -1 : 1;
        const lc = this._localCentroid;
        const f = 0.5 / Math.tan((o.hfovDeg * Math.PI) / 360);

        const points = [], confidence = [], landmarks = [], rays = [];
        for (let j = 0; j < JOINT_COUNT; j++) {
            const l = sub(local[j], lc);
            const world = this._toPhone(add(pose.center, scale(rot({ x: l.x * mirror, y: l.y, z: l.z }), o.handScale)));
            this.lastTruth.points.push(world);
            // The skin the LiDAR hits sits r nearer along the joint's own ray.
            const skin = PALM_SET.has(j) ? o.skinPalm : o.skinFinger;
            const sk = scale(world, 1 - skin / len(world));
            const ex = o.extraNoise[j] ?? 0;
            const rs = o.noiseRangeExp ? (len(sk) / 0.22) ** o.noiseRangeExp : 1;
            const dz = (o.extraDepthNoise[j] ?? 0) * r.gauss();
            const ray0 = norm(sk);
            const p = {
                x: sk.x + r.gauss() * o.sigmaXY * rs + r.gauss() * ex + ray0.x * dz,
                y: sk.y + r.gauss() * o.sigmaXY * rs + r.gauss() * ex + ray0.y * dz,
                z: sk.z + r.gauss() * o.sigmaZ * rs + r.gauss() * ex + ray0.z * dz,
            };
            const occluded = j === Joint.THUMB_TIP && r() < o.thumbOcclusion * (pose.pinch || 0);
            const seen = !occluded && r() >= o.dropout;
            // Seen in 2-D: a ray (its direction carries the image-plane noise, not the depth's).
            const ray = norm({ x: world.x + r.gauss() * o.sigmaXY, y: world.y + r.gauss() * o.sigmaXY, z: world.z });
            const depthless = seen && TIPS.has(j) && r() < o.tipDepthLoss;
            points.push(seen && !depthless ? [p.x, p.y, p.z] : null);
            rays.push(seen ? [ray.x, ray.y, ray.z] : null);
            confidence.push(seen ? 0.8 + r() * 0.2 : r() * 0.2);
            landmarks.push([0.5 + (p.x / p.z) * f, 0.5 - (p.y / p.z) * f, p.z]);
        }
        payload.hands.push({ handedness: o.label || o.handedness, confidence, points, rays, landmarks });
        return payload;
    }

    /**
     * The scripted pose at mode time `s`, or null for no hand.
     * @private
     */
    _script(s) {
        const { center: c, half: h } = this.opts;
        switch (this.mode) {
            case 'none':
                return null;
            case 'flat':
                return { center: add(c, v3(0.002 * Math.sin(s * 0.7), 0.002 * Math.sin(s * 0.5), 0)), curl: 0, splay: 1, pinch: 0 };
            case 'sweep':
                // A Lissajous over the box: dense at its faces, covers it in ~10 s.
                return {
                    center: add(c, v3(h.x * Math.sin(1.13 * s), h.y * Math.sin(0.71 * s + 1), h.z * Math.sin(0.53 * s + 2))),
                    curl: 0.1, splay: 1, pinch: 0,
                    yaw: 0.15 * Math.sin(0.4 * s),
                };
            case 'motion': {
                // 0–3 s dead still; 3–8 s slow (≈0.1 m/s); 8–12 s fast (≈0.85 m/s); repeat.
                const k = s % 12;
                if (k < 3) return { center: c, curl: 0.1, splay: 1, pinch: 0 };
                if (k < 8) return { center: add(c, v3(0.08 * Math.sin(1.2 * (k - 3)), 0.03 * Math.sin(0.9 * (k - 3)), 0)), curl: 0.1, splay: 1, pinch: 0 };
                return { center: add(c, v3(0.12 * Math.sin(7 * (k - 8)), 0.04 * Math.sin(5 * (k - 8)), 0.02 * Math.sin(3 * (k - 8)))), curl: 0.1, splay: 1, pinch: 0 };
            }
            case 'pinch': {
                // Pinch cycles of 1.6 s (closed for the middle half); every 4th one opens wide.
                const cycle = Math.floor(s / 1.6), k = (s % 1.6) / 1.6;
                const pinch = smooth((k - 0.15) / 0.15) * (1 - smooth((k - 0.7) / 0.15));
                const wide = cycle % 4 === 3 ? 1 - pinch : 0;
                return { center: c, curl: 0.05, splay: 1 + 0.6 * wide, thumbOut: wide, pinch };
            }
            case 'palmUp':
                // Turned over: palm to the ceiling, fingers loosely curled (toward the palm, so up).
                return { center: c, curl: 0.35, splay: 1, pinch: 0, roll: Math.PI };
            case 'tilt':
                // Yaw ±25°, pitch ±15°, roll ±20° on incommensurate periods, about the rest pose.
                return {
                    center: c, curl: 0.05, splay: 1, pinch: 0,
                    yaw: 0.44 * Math.sin(0.5 * s), pitch: 0.26 * Math.sin(0.37 * s + 1), roll: 0.35 * Math.sin(0.29 * s + 2),
                };
            case 'wander':
            default:
                return this._wander(s);
        }
    }

    /**
     * A person using it, on a 30 s loop: roam the whole space, pause, pinch, rest flat, move
     * fast, tilt. Nothing is announced — the live model has to find each kind of moment.
     * @private
     */
    _wander(s) {
        const { center: c, half: h } = this.opts;
        const k = s % 30;
        const roam = (u, a = 1) => add(c, v3(a * h.x * Math.sin(1.13 * u), a * h.y * Math.sin(0.71 * u + 1), a * h.z * Math.sin(0.53 * u + 2)));
        if (k < 8) return { center: roam(s), curl: 0.1, splay: 1, pinch: 0, yaw: 0.15 * Math.sin(0.4 * s) };
        if (k < 11) return { center: add(c, v3(0.02, -0.01, 0)), curl: 0.1, splay: 1, pinch: 0 };            // a pause
        if (k < 16) {                                                                                       // pinches
            const q = ((k - 11) % 1.6) / 1.6;
            return { center: c, curl: 0.05, splay: 1, pinch: smooth((q - 0.15) / 0.15) * (1 - smooth((q - 0.7) / 0.15)) };
        }
        if (k < 19) return { center: add(c, v3(-0.01, 0.01, 0.01)), curl: 0, splay: 1, pinch: 0 };          // resting flat
        if (k < 23) return { center: add(c, v3(0.1 * Math.sin(7 * (k - 19)), 0.04 * Math.sin(5 * (k - 19)), 0)), curl: 0.1, splay: 1, pinch: 0 }; // fast
        return {                                                                                            // tilting while drifting
            center: roam(s, 0.5), curl: 0.05, splay: 1, pinch: 0,
            yaw: 0.44 * Math.sin(0.5 * s), pitch: 0.26 * Math.sin(0.37 * s + 1), roll: 0.35 * Math.sin(0.29 * s + 2),
        };
    }

    /**
     * Hand-local joints for a pose (right hand, unscaled): fingers curled toward the palm
     * (−z), splayed about the wrist, the thumb solved onto the index tip by `pinch`.
     * @private
     * @param {{curl?: number, splay?: number, pinch?: number, thumbOut?: number}} pose
     * @returns {Vec3[]}
     */
    _localPose({ curl = 0, splay = 1, pinch = 0, thumbOut = 0 }) {
        const pts = new Array(JOINT_COUNT);
        pts[Joint.WRIST] = v3();
        for (const name of Object.keys(MCP)) {
            const a = (SPLAY_DEG[name] * splay * Math.PI) / 180;
            const dir = v3(Math.sin(a), Math.cos(a), 0);
            const base = FINGER_BASE[name];
            // Spread the MCP row a little with splay, about the middle MCP.
            const mcp = add(MCP.middle, scale(sub(MCP[name], MCP.middle), 1 + 0.15 * (splay - 1)));
            pts[base] = mcp;
            // Index curls into the pinch; every finger carries the base curl.
            const c = curl + (name === 'index' ? 1.0 * pinch : 0);
            const flex = [0.6 * c, 0.9 * c, 0.6 * c];
            let p = mcp, acc = 0;
            for (let k = 0; k < 3; k++) {
                acc += flex[k];
                const seg = add(scale(dir, Math.cos(acc)), v3(0, 0, -Math.sin(acc)));
                p = add(p, scale(seg, PHALANGES[name][k] * this.opts.phalangeScale));
                pts[base + 1 + k] = p;
            }
        }
        // Thumb, open: out toward −x and forward, a little under the palm.
        const out = (50 + 15 * thumbOut) * Math.PI / 180;
        const tdir = norm(v3(-Math.sin(out), Math.cos(out), -0.25));
        const chain = [THUMB_CMC];
        for (let k = 0; k < 3; k++) chain.push(add(chain[k], scale(tdir, THUMB_BONES[k] * (k ? this.opts.phalangeScale : 1))));
        if (pinch > 0) {
            const openTip = chain[3];
            const idx = pts[Joint.INDEX_TIP];
            // Touch the index pad from below-left: the gap direction is the index tip toward the thumb.
            const touch = add(idx, scale(norm(sub(openTip, idx)), PINCH_GAP));
            ccd(chain, lerp(openTip, touch, pinch));
        }
        pts[Joint.THUMB_CMC] = chain[0];
        pts[Joint.THUMB_MCP] = chain[1];
        pts[Joint.THUMB_IP] = chain[2];
        pts[Joint.THUMB_TIP] = chain[3];
        return pts;
    }
}

/** Cyclic-coordinate-descent IK in place: bend `chain` (root fixed) so its tip meets `target`. */
function ccd(chain, target, iterations = 12) {
    const n = chain.length - 1;
    for (let it = 0; it < iterations; it++) {
        for (let i = n - 1; i >= 0; i--) {
            const toTip = sub(chain[n], chain[i]), toTarget = sub(target, chain[i]);
            const axis = cross(toTip, toTarget);
            const al = len(axis);
            if (al < 1e-12) continue;
            const k = scale(axis, 1 / al);
            const ang = Math.atan2(al, dot(toTip, toTarget));
            for (let j = i + 1; j <= n; j++) chain[j] = add(chain[i], rotateAbout(sub(chain[j], chain[i]), k, ang));
        }
        if (dist(chain[n], target) < 1e-5) break;
    }
}
