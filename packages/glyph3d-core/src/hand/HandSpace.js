/**
 * HandSpace — composable, pass-through stages from a raw phone-frame hand vector to the
 * app's unit space. Each stage takes a vector and a time and returns a vector; every stage
 * can be switched off (identity), so the whole chain can be stepped through one stage at a
 * time while looking at the numbers.
 *
 *   raw (m, phone frame)
 *     → spike      — a lone sample far off where the hand was heading (beyond what a hand can
 *                    accelerate in a frame, plus k × the rest noise) is held at the prediction,
 *                    for at most `maxHold` frames, then accepted as real motion. Rare spikes slow
 *                    3-D pointing far more than steady jitter (Teather 2009: 1% of samples ≈ 30%)
 *     → oneEuro    — the 1€ filter (Casiez et al. 2012): a low-pass whose cutoff rises with
 *                    speed, so it kills jitter at rest without lagging fast motion. Depth (z)
 *                    has its own cutoff and beta: from below, the image-plane axes come from
 *                    2-D keypoints and z from LiDAR — independent noise of different size
 *     → deadZone   — the hand holds a point until it moves past a radius (default: k × the rest
 *                    jitter LEFT AFTER the filter, not the raw noise — sized from raw noise it
 *                    would swallow fine motion), then drags it: no drift at rest, no jump on leaving
 *     → normalize  — the measured volume onto a cube: its centre → 0 and ONE gain for every axis
 *                    (the widest reach → ±1), so motion means the same in every direction; the
 *                    mapping FREEZES once the volume settles and changes only when the volume
 *                    starts over (a phone bump, a reset) — a hand can't learn a map that drifts
 *     → app        — phone axes onto app axes (default: right → +x, up → +y, away → −z),
 *                    scaled to app units
 *
 * The stages read the live HandModel's summary (`setModel`: noise, volume, pinch, frame rate),
 * so they sharpen as the model converges. A stage whose input the model doesn't know yet
 * (deadZone's radius before a still moment, normalize before a volume) passes through and says
 * why. With `oneEuro.auto`, the rest cutoffs are SOLVED from the measured jitter and frame rate
 * for a target residual jitter, not guessed. Also here: PinchTracker, the per-user pinch with
 * hysteresis from the model's thresholds.
 *
 * Nothing here is bound to the camera or a verb — this is the measuring bench for that next
 * step. Pure: no DOM, no Three.js.
 */

/** @typedef {import('./handMath.js').Vec3} Vec3 */

export const HAND_SPACE_DEFAULTS = {
    // minCutoff Hz at rest; the cutoff rises by beta Hz per m/s (x, y; zMinCutoff / zBeta for
    // depth). beta 20 on the simulator's 2 mm jitter: rest variance ×0.1, worst lag ~20 mm
    // (~24 ms) at 0.85 m/s (the research's start is beta 5: ×0.06, ~33 mm).
    spike: { enabled: true, accel: 30, noiseK: 6, maxHold: 2 },            // accel m/s² a hand can reach; hold ≤ maxHold frames
    // auto: minCutoff / zMinCutoff solved per frame from the model's rest noise + frame rate so
    // the filtered jitter at rest is targetJitter (m, per axis); the manual cutoffs apply until it
    // knows. Smoothing costs lag (τ = 1/2πfc, shown live): 1.2 mm leaves ~0.4 mm-rms-class jitter
    // at a fraction of 0.5 mm's lag — and sub-0.3 mm jitter has no measured cost (Teather 2009).
    oneEuro: { enabled: true, auto: true, targetJitter: 0.0012, minCutoff: 1.0, beta: 20, zMinCutoff: 0.7, zBeta: 20, dCutoff: 1.0 },
    deadZone: { enabled: true, noiseK: 3, radius: 0 },                    // radius (m) > 0 overrides noiseK × post-filter rest jitter
    normalize: { enabled: true, clamp: false, isotropic: true, freeze: true },
    app: { enabled: true, axes: 'x z -y', scale: 1 },                     // out.x out.y out.z ← signed phone axes
    // PinchTracker: held above `off` this long to release; the pinch POINT is thumb→index at
    // pointT (MRTK's stabilized point leans to the thumb, which moves less); the onset point is
    // where it was rewindS before the pinch registered (the closing motion moves it — Wolf 2020).
    pinch: { releaseDwellS: 0.06, pointT: 0.2, rewindS: 0.1 },
};

const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

/** One axis of a 1€ filter. */
class OneEuroAxis {
    constructor() { this.reset(); }
    reset() { this.x = null; this.dx = 0; }
    filter(v, dt, p) {
        if (this.x == null || !(dt > 0)) { this.x = v; this.dx = 0; return v; }
        const ad = alpha(p.dCutoff, dt);
        this.dx = this.dx + ad * ((v - this.x) / dt - this.dx);
        const a = alpha(p.minCutoff + p.beta * Math.abs(this.dx), dt);
        this.x = this.x + a * (v - this.x);
        return this.x;
    }
}

/**
 * @typedef {Object} Stage
 * @property {string} id
 * @property {(v: Vec3, t: number) => Vec3} apply
 * @property {() => void} reset
 * @property {() => {active: boolean, why?: string, params: Object}} describe
 */

/**
 * @param {typeof HAND_SPACE_DEFAULTS.spike} p
 * @param {() => Object|null} model - the model summary (rest noise)
 * @returns {Stage}
 */
export function spikeStage(p, model) {
    let last = null, prev = null, held = 0, spikes = 0, frames = 0;
    return {
        id: 'spike',
        apply(v, t) {
            if (!p.enabled) { last = prev = null; return v; }
            frames++;
            if (!last || !prev || !(t > last.t)) { prev = last; last = { v, t }; return v; }
            const dt = t - last.t, dt0 = last.t - prev.t;
            const vel = dt0 > 0 ? { x: (last.v.x - prev.v.x) / dt0, y: (last.v.y - prev.v.y) / dt0, z: (last.v.z - prev.v.z) / dt0 } : { x: 0, y: 0, z: 0 };
            const pred = { x: last.v.x + vel.x * dt, y: last.v.y + vel.y * dt, z: last.v.z + vel.z * dt };
            const err = Math.hypot(v.x - pred.x, v.y - pred.y, v.z - pred.z);
            const sigma = model()?.noise?.rms ?? 0.002;
            const gate = 0.5 * p.accel * dt * dt + p.noiseK * sigma;
            if (err > gate && held < p.maxHold) {
                held++; spikes++;
                prev = last; last = { v: pred, t };
                return pred;
            }
            // Accepted. After a hold this is a real jump: restart the velocity from rest rather than
            // let the jump itself read as speed.
            prev = held > 0 ? { v, t: last.t } : last;
            held = 0;
            last = { v, t };
            return v;
        },
        reset() { last = prev = null; held = 0; },
        describe: () => (p.enabled
            ? { active: true, from: `held ${spikes} of ${frames} samples`, params: { ...p } }
            : { active: false, why: 'off', params: { ...p } }),
    };
}

/**
 * The rest cutoff (Hz) that leaves `target` of white jitter `sigma` at `rate` Hz: a one-pole
 * low-pass passes a variance fraction α/(2−α), so α = 2ρ/(1+ρ) for ρ = (target/σ)²; then
 * τ = Te(1/α − 1) and fc = 1/(2πτ). Null when the jitter is already under target.
 */
export function cutoffForJitter(sigma, target, rate) {
    if (!(sigma > 0) || !(rate > 0) || !(target > 0)) return null;
    const rho = (target / sigma) ** 2;
    if (rho >= 1) return null;
    const alpha = (2 * rho) / (1 + rho);
    const tau = (1 / rate) * (1 / alpha - 1);
    return 1 / (2 * Math.PI * tau);
}

/**
 * The white jitter a one-pole low-pass at `fc` leaves of `sigma` at `rate` Hz: σ·√(α/(2−α)).
 * (The inverse of cutoffForJitter.)
 */
export function residualJitter(sigma, fc, rate) {
    if (!(sigma > 0) || !(rate > 0) || !(fc > 0)) return sigma;
    const tau = 1 / (2 * Math.PI * fc);
    const alpha = 1 / (1 + tau * rate);
    return sigma * Math.sqrt(alpha / (2 - alpha));
}

/** @param {typeof HAND_SPACE_DEFAULTS.oneEuro} p @param {() => Object|null} model @returns {Stage & {restJitter: () => number|null}} */
export function oneEuroStage(p, model) {
    const ax = [new OneEuroAxis(), new OneEuroAxis(), new OneEuroAxis()];
    const xp = { minCutoff: 0, beta: 0, dCutoff: 0 }, zp = { minCutoff: 0, beta: 0, dCutoff: 0 };
    let tPrev = null;
    /** The rest cutoffs in force, and where they came from. */
    const cutoffs = () => {
        const m = model();
        if (p.auto && m?.noise && m?.rate) {
            const xy = cutoffForJitter(Math.hypot(m.noise.x, m.noise.y) / Math.SQRT2, p.targetJitter, m.rate);
            const z = cutoffForJitter(m.noise.z, p.targetJitter, m.rate);
            // Already under target: no smoothing needed at rest — the cutoff opens to Nyquist.
            return { xy: xy ?? m.rate / 2, z: z ?? m.rate / 2, from: `auto: rest noise → ${p.targetJitter} m at ${Math.round(m.rate)} Hz` };
        }
        return { xy: p.minCutoff, z: p.zMinCutoff, from: p.auto ? 'manual (auto waits for the rest noise and frame rate)' : 'manual' };
    };
    return {
        id: 'oneEuro',
        apply(v, t) {
            if (!p.enabled) return v;
            const dt = tPrev == null ? 0 : t - tPrev;
            tPrev = t;
            const c = cutoffs();
            xp.minCutoff = c.xy; xp.beta = p.beta; xp.dCutoff = p.dCutoff;
            zp.minCutoff = c.z; zp.beta = p.zBeta; zp.dCutoff = p.dCutoff;
            return { x: ax[0].filter(v.x, dt, xp), y: ax[1].filter(v.y, dt, xp), z: ax[2].filter(v.z, dt, zp) };
        },
        reset() { for (const a of ax) a.reset(); tPrev = null; },
        /** The rest jitter (3-D rms, m) this stage passes on: the model's noise through its rest cutoffs. */
        restJitter() {
            const m = model();
            if (!m?.noise) return null;
            if (!p.enabled || !m.rate) return m.noise.rms;
            const c = cutoffs();
            const x = residualJitter(m.noise.x, c.xy, m.rate), y = residualJitter(m.noise.y, c.xy, m.rate), z = residualJitter(m.noise.z, c.z, m.rate);
            return Math.hypot(x, y, z);
        },
        describe() {
            if (!p.enabled) return { active: false, why: 'off', params: { ...p } };
            const c = cutoffs();
            // A one-pole low-pass lags a slow ramp by τ = 1/(2π fc): the price of the smoothing.
            const lag = (fc) => Math.round(1000 / (2 * Math.PI * fc));
            return {
                active: true, minCutoff: Number(c.xy.toFixed(3)), zMinCutoff: Number(c.z.toFixed(3)),
                lagMs: { xy: lag(c.xy), z: lag(c.z) },
                from: `${c.from} · rest lag ${lag(c.xy)} / ${lag(c.z)} ms (xy / z)`, params: { ...p },
            };
        },
    };
}

/**
 * @param {typeof HAND_SPACE_DEFAULTS.deadZone} p
 * @param {() => number|null} restJitter - the rest jitter reaching this stage (after the filter), m
 * @returns {Stage}
 */
export function deadZoneStage(p, restJitter) {
    let held = null;
    const radius = () => {
        if (p.radius > 0) return { r: p.radius, from: 'radius' };
        const j = restJitter();
        return j > 0 ? { r: p.noiseK * j, from: `${p.noiseK} × post-filter rest jitter ${j.toFixed(5)} m` } : null;
    };
    return {
        id: 'deadZone',
        apply(v) {
            const r = p.enabled ? radius() : null;
            if (!r || !(r.r > 0)) { held = null; return v; }
            if (!held) { held = { ...v }; return held; }
            const dx = v.x - held.x, dy = v.y - held.y, dz = v.z - held.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d > r.r) {
                const k = (d - r.r) / d;
                held = { x: held.x + dx * k, y: held.y + dy * k, z: held.z + dz * k };
            }
            return held;
        },
        reset() { held = null; },
        describe() {
            if (!p.enabled) return { active: false, why: 'off', params: { ...p } };
            const r = radius();
            return r ? { active: true, radius: r.r, from: r.from, params: { ...p } }
                : { active: false, why: 'no radius yet: the model measures rest noise when the hand pauses (or set a radius)', params: { ...p } };
        },
    };
}

/** @param {typeof HAND_SPACE_DEFAULTS.normalize} p @param {() => Object|null} model - the model summary @returns {Stage} */
export function normalizeStage(p, model) {
    /** The mapping in force once frozen: {center, half: Vec3, epoch}. */
    let frozen = null;
    const mapping = () => {
        const v = model()?.volume;
        const ok = v?.center && v?.reach && v.reach.x > 0 && v.reach.y > 0 && v.reach.z > 0;
        // Unfreeze only when the volume started over (bump, reset), or the map's own shape knobs change.
        if (frozen && (!p.freeze || frozen.isotropic !== p.isotropic || (v && v.epoch !== frozen.epoch))) frozen = null;
        if (frozen) return { ...frozen, from: `frozen at the settled volume (epoch ${frozen.epoch})` };
        if (!ok) return null;
        const r = v.reach;
        const iso = Math.max(r.x, r.y, r.z) / 2;
        const half = p.isotropic ? { x: iso, y: iso, z: iso } : { x: r.x / 2, y: r.y / 2, z: r.z / 2 };
        const m = { center: { ...v.center }, half, epoch: v.epoch, isotropic: p.isotropic };
        if (p.freeze && v.state === 'settled') { frozen = m; return { ...m, from: `frozen at the settled volume (epoch ${m.epoch})` }; }
        return { ...m, from: p.freeze ? 'live — freezes when the volume settles' : 'live (freeze off)' };
    };
    const c = (u) => (p.clamp ? Math.max(-1, Math.min(1, u)) : u);
    return {
        id: 'normalize',
        apply(v) {
            const M = p.enabled ? mapping() : null;
            if (!M) return v;
            return {
                x: c((v.x - M.center.x) / M.half.x),
                y: c((v.y - M.center.y) / M.half.y),
                z: c((v.z - M.center.z) / M.half.z),
            };
        },
        reset() {}, // a filter knob or a bump of the stage chain must not move a frozen map
        describe() {
            if (!p.enabled) return { active: false, why: 'off', params: { ...p } };
            const M = mapping();
            return M
                ? { active: true, from: M.from, gain: p.isotropic ? Number((1 / M.half.x).toFixed(3)) : null, params: { ...p } }
                : { active: false, why: 'the model has no volume yet (move the hand around)', params: { ...p } };
        },
    };
}

/**
 * Parse an axes spec: three signed phone axes naming the source of out.x, out.y, out.z.
 * 'x z -y' = right stays right, up becomes +y, away (phone +y) becomes −z (into the screen).
 * @param {string} spec
 * @returns {{axis: 'x'|'y'|'z', sign: number}[]}
 */
export function parseAxes(spec) {
    const parts = String(spec).trim().split(/[\s,]+/);
    const out = parts.map((s) => {
        const m = /^([+-]?)([xyz])$/.exec(s);
        if (!m) throw new Error(`HandSpace: axes '${spec}' — each of three parts is [+|-]x|y|z`);
        return { axis: /** @type {'x'|'y'|'z'} */ (m[2]), sign: m[1] === '-' ? -1 : 1 };
    });
    if (out.length !== 3 || new Set(out.map((a) => a.axis)).size !== 3) {
        throw new Error(`HandSpace: axes '${spec}' must name x, y and z once each`);
    }
    return out;
}

/** @param {typeof HAND_SPACE_DEFAULTS.app} p @returns {Stage} */
export function appStage(p) {
    let spec = null, axes = null;
    const map = () => { if (spec !== p.axes) { axes = parseAxes(p.axes); spec = p.axes; } return axes; };
    return {
        id: 'app',
        apply(v) {
            if (!p.enabled) return v;
            const a = map(), s = p.scale;
            return { x: a[0].sign * v[a[0].axis] * s, y: a[1].sign * v[a[1].axis] * s, z: a[2].sign * v[a[2].axis] * s };
        },
        reset() {},
        describe: () => ({ active: !!p.enabled, ...(p.enabled ? {} : { why: 'off' }), params: { ...p } }),
    };
}

/** Velocity per stage output: the least-squares slope over a short window. */
class Slope {
    constructor(windowS) { this.windowS = windowS; this.r = []; }
    reset() { this.r = []; }
    push(v, t) {
        const r = this.r;
        r.push({ v, t });
        while (r.length > 2 && r[0].t < t - this.windowS) r.shift();
        if (r.length < 3) return null;
        const tm = r.reduce((s, e) => s + e.t, 0) / r.length;
        let den = 0, x = 0, y = 0, z = 0;
        for (const e of r) { const d = e.t - tm; den += d * d; x += d * e.v.x; y += d * e.v.y; z += d * e.v.z; }
        return den > 0 ? { x: x / den, y: y / den, z: z / den } : null;
    }
}

/**
 * The stage chain. `params` is held by reference: a knob changed on it applies on the next
 * frame. `model` (a HandModel hand summary) is read each frame.
 */
export default class HandSpace {
    /**
     * @param {Object} [params] - deep-merged over HAND_SPACE_DEFAULTS
     * @param {Object|null} [model] - a HandModel hand's `summary()` (noise, volume, pinch, rate)
     * @param {{velocityS?: number}} [opts]
     */
    constructor(params = {}, model = null, { velocityS = 0.1 } = {}) {
        this.params = {};
        for (const [k, d] of Object.entries(HAND_SPACE_DEFAULTS)) this.params[k] = { ...d, ...(params[k] || {}) };
        /** The model summary the stages read each frame (assign freely; it's live data, not config). */
        this.model = model;
        const prof = () => this.model;
        const euro = oneEuroStage(this.params.oneEuro, prof);
        /** @type {Stage[]} */
        this.stages = [
            spikeStage(this.params.spike, prof),
            euro,
            deadZoneStage(this.params.deadZone, () => euro.restJitter()),
            normalizeStage(this.params.normalize, prof),
            appStage(this.params.app),
        ];
        this._slopes = [new Slope(velocityS), ...this.stages.map(() => new Slope(velocityS))];
        /** @type {{id: string, value: Vec3, velocity: Vec3|null}[]|null} */
        this.last = null;
    }

    /** Set one knob: `stage.key` (e.g. 'oneEuro.beta'), value already typed. */
    set(path, value) {
        const [stage, key] = String(path).split('.');
        if (!this.params[stage] || !(key in this.params[stage])) {
            throw new Error(`HandSpace: no knob '${path}' (${Object.entries(this.params).flatMap(([s, p]) => Object.keys(p).map((k) => `${s}.${k}`)).join(', ')})`);
        }
        if (stage === 'app' && key === 'axes') parseAxes(value);
        this.params[stage][key] = value;
        this.reset();
    }

    reset() {
        for (const s of this.stages) s.reset();
        for (const s of this._slopes) s.reset();
        this.last = null;
    }

    /**
     * Run one vector through every stage.
     * @param {Vec3} raw - phone frame, meters
     * @param {number} t - seconds
     * @returns {{id: string, value: Vec3, velocity: Vec3|null}[]} raw first, then each stage's output
     */
    run(raw, t) {
        const out = [{ id: 'raw', value: raw, velocity: this._slopes[0].push(raw, t) }];
        let v = raw;
        this.stages.forEach((s, i) => {
            v = s.apply(v, t);
            out.push({ id: s.id, value: v, velocity: this._slopes[i + 1].push(v, t) });
        });
        this.last = out;
        return out;
    }

    describe() { return this.stages.map((s) => ({ id: s.id, ...s.describe() })); }

    /**
     * The phone → view mapping alone: the app stage's axes (its sign and permutation, no scale),
     * the ONE mapping the drawn hand and the stages share — his right → +x, up from the desk → +y,
     * away from him → −z (into the view) by default.
     * @param {Vec3} v
     */
    toView(v) {
        const a = parseAxes(this.params.app.axes);
        return { x: a[0].sign * v[a[0].axis], y: a[1].sign * v[a[1].axis], z: a[2].sign * v[a[2].axis] };
    }
}

/**
 * Pinch from the live model's per-user thresholds, with hysteresis: on below `on`, off once above
 * `off` for `releaseDwellS` (a single noisy frame doesn't drop a pinch-drag). Distances are
 * normalized by the model's palm length |wrist − middle MCP|.
 *
 * It also keeps the pinch POINT and, at onset, where that point was `rewindS` earlier. Closing a
 * pinch moves the very point it selects with (the Heisenberg effect, Wolf et al. CHI 2020 — the
 * largest single cause of direct-hand selection errors); the known fix is to take the pointer
 * from just before the closing motion. The point itself is MRTK's stabilized one: thumb → index
 * at `pointT`, leaning to the thumb, which moves less than the index as a pinch closes.
 */
export class PinchTracker {
    /** @param {{releaseDwellS: number, pointT: number, rewindS: number}} [params] - held by reference (live knobs) */
    constructor(params = { ...HAND_SPACE_DEFAULTS.pinch }) { this.params = params; this.reset(); }
    reset() { this.pinching = false; this._aboveSince = null; this._ring = []; this.onset = null; }
    /**
     * @param {number|null} distance - thumb–index tip distance, meters (null = not seen)
     * @param {Object|null} pinch - the model's `pinch` ({on, off, scale}; research priors until it has seen a pinch)
     * @param {number} t - seconds
     * @param {{thumb: Vec3, index: Vec3}|null} [tips] - the tips, for the pinch point
     * @returns {{pinching: boolean, normalized: number|null, point: Vec3|null, onset: {t: number, point: Vec3}|null, why?: string}}
     */
    update(distance, pinch, t, tips = null) {
        const k = this.params.pointT;
        const point = tips?.thumb && tips?.index ? {
            x: tips.thumb.x + k * (tips.index.x - tips.thumb.x),
            y: tips.thumb.y + k * (tips.index.y - tips.thumb.y),
            z: tips.thumb.z + k * (tips.index.z - tips.thumb.z),
        } : null;
        if (point) {
            this._ring.push({ t, point });
            while (this._ring.length > 2 && this._ring[0].t < t - Math.max(0.5, 3 * this.params.rewindS)) this._ring.shift();
        }
        const out = (o) => ({ point, onset: this.pinching ? this.onset : null, ...o });
        if (!pinch?.on || !pinch?.off || !(pinch.scale > 0)) return out({ pinching: false, normalized: null, why: 'no hand scale yet' });
        if (distance == null) return out({ pinching: this.pinching, normalized: null, why: 'tips not seen (held)' });
        const n = distance / pinch.scale;
        if (!this.pinching) {
            if (n < pinch.on) {
                this.pinching = true; this._aboveSince = null;
                this.onset = { t, point: this._pointAt(t - this.params.rewindS) ?? point };
            }
        } else if (n > pinch.off) {
            if (this._aboveSince == null) this._aboveSince = t;
            if (t - this._aboveSince >= this.params.releaseDwellS) { this.pinching = false; this._aboveSince = null; }
        } else this._aboveSince = null;
        return out({ pinching: this.pinching, normalized: n });
    }

    /** The recorded pinch point nearest time `t` (null with nothing recorded). @private */
    _pointAt(t) {
        let best = null;
        for (const e of this._ring) if (!best || Math.abs(e.t - t) < Math.abs(best.t - t)) best = e;
        return best ? { ...best.point } : null;
    }
}
