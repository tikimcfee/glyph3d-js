/** @import * as THREE from 'three' */
/** @import FlatRenderRoot from '@glyph3d/core/collections/FlatRenderRoot.js' */

/**
 * FramePasses — the ONE owner of what the frame draws, in a declared order (docs/planes/DESIGN.md
 * §3.13). r3f renders the frame itself unless a positive-priority `useFrame` takes the loop; the
 * app's one such `useFrame` is <RenderPasses/> (RenderPasses.jsx), and it calls `renderFrame` —
 * so does the screenshot verb, so a screenshot is what you see.
 *
 * The passes, in order (PASS_ORDER):
 *   main     the scene through the view camera — its flat render root when one serves
 *            (FlatRenderRoot.target), else the scene itself
 *   overlay  the plane overlay (strip, map labels, edge marks), depth cleared, over the main pass
 *   cloud    the hand cloud's picture-in-picture
 *   minimap  the 3D overview in its scissored corner (view.minimap)
 * A pass is a named entry (`add`), never another loop owner. Each pass is timed every frame into a
 * ring of the last `window` frames; work drawn on its own schedule (carrel card captures, picks)
 * reports its time with `record`. scene.render reads `stats()`.
 *
 * A second loop owner — another positive-priority `useFrame` — would draw the frame again (or over
 * this one): `checkLoop` sees r3f's count of them each frame and records a FAULT, loud (console.error
 * naming the offender's callback, once per offender) — and keeps rendering: a frozen shared display
 * is worse than a loud one. A pass that throws is logged with its name (once) and the passes after it
 * still run.
 *
 * Gate: tools/render-passes.test.mjs; tools/render-passes-check.mjs (the frame byte-identical to the
 * passes it replaced).
 */

/** The declared order of the frame's passes. */
export const PASS_ORDER = Object.freeze({ main: 0, overlay: 10, cloud: 20, minimap: 30 });

class Ring {
    constructor(n) { this.a = new Float64Array(n); this.i = 0; this.n = 0; this.last = 0; this.total = 0; }
    push(ms) { this.a[this.i] = ms; this.i = (this.i + 1) % this.a.length; this.n = Math.min(this.n + 1, this.a.length); this.last = ms; this.total++; }
    quantile(q) {
        if (!this.n) return 0;
        const s = Array.from(this.a.subarray(0, this.n)).sort((x, y) => x - y);
        return s[Math.min(s.length - 1, Math.floor(q * s.length))];
    }
}

export default class FramePasses {
    /**
     * @param {{renderer: THREE.WebGLRenderer, scene: THREE.Scene, window?: number, now?: () => number}} opts
     */
    constructor({ renderer, scene, window = 240, now = () => performance.now() }) {
        if (!renderer?.render || !scene?.isScene) throw new Error('FramePasses: needs a renderer and a scene');
        this.renderer = renderer;
        this.scene = scene;
        /** @type {FlatRenderRoot|null} the view's flat render root (the main pass renders it when it serves) */
        this.flatRoot = null;
        this.window = window;
        this.now = now;
        /** @type {Array<{name: string, order: number, fn: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void}>} */
        this.passes = [];
        /** @type {Map<string, Ring>} per-pass frame timing, and off-frame records */
        this.timing = new Map();
        /** Frames rendered. */
        this.frames = 0;
        /** @type {{offenders: string[], at: number}|null} a second loop owner, while one is there */
        this.fault = null;
        this._loggedOffenders = new Set();
        this._failedPasses = new Set();
        this.add('main', PASS_ORDER.main, (r, cam) => r.render(this.flatRoot ? this.flatRoot.target(cam) : this.scene, cam));
    }

    /**
     * Declare a pass. Names are unique; order decides where it draws (ties: first added first).
     * @param {string} name @param {number} order
     * @param {(renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void} fn
     * @returns {() => void} removes it
     */
    add(name, order, fn) {
        if (typeof fn !== 'function') throw new Error(`FramePasses.add('${name}'): fn must be a function`);
        if (!Number.isFinite(order)) throw new Error(`FramePasses.add('${name}'): order must be a number (got ${order})`);
        if (this.passes.some((p) => p.name === name)) throw new Error(`RenderPasses.add: a pass named '${name}' is already declared`);
        this.passes.push({ name, order, fn });
        this.passes.sort((a, b) => a.order - b.order);   // stable: ties keep insertion order
        return () => this.remove(name);
    }

    /** @param {string} name @returns {boolean} */
    remove(name) {
        const i = this.passes.findIndex((p) => p.name === name);
        if (i < 0) return false;
        this.passes.splice(i, 1);
        return true;
    }

    /** The passes' names, in the order they draw. */
    order() { return this.passes.map((p) => p.name); }

    /**
     * Draw the frame: every pass, in order, each timed. A pass that throws is logged (once) and the
     * rest still draw.
     * @param {THREE.Camera} camera the view camera
     */
    renderFrame(camera) {
        const r = this.renderer;
        for (const p of this.passes) {
            const t0 = this.now();
            try {
                p.fn(r, camera);
            } catch (e) {
                if (!this._failedPasses.has(p.name)) {
                    this._failedPasses.add(p.name);
                    console.error(`[render-passes] pass '${p.name}' failed — the passes after it still draw:`, e);
                }
            }
            this.record(p.name, this.now() - t0);
        }
        this.frames++;
    }

    /** Record a pass's time — a frame pass's, or work drawn on its own schedule (cards, picks). */
    record(name, ms) {
        let ring = this.timing.get(name);
        if (!ring) this.timing.set(name, ring = new Ring(this.window));
        ring.push(ms);
    }

    /**
     * Check that this owner is the only positive-priority subscriber of r3f's loop (state.internal:
     * `priority` counts them, `subscribers` lists them). Another one records a fault, logged once per
     * offender; it clears when the offender goes.
     * @param {{priority: number, subscribers: Array<{ref: {current: Function}, priority: number}>}} internal
     * @param {Function} own this owner's useFrame callback
     */
    checkLoop(internal, own) {
        if (!(internal?.priority > 1)) { this.fault = null; return; }
        const offenders = (internal.subscribers ?? []).filter((s) => s.priority > 0 && s.ref?.current !== own).map((s) => s.ref?.current);
        const names = offenders.map((fn) => String(fn).replace(/\s+/g, ' ').slice(0, 140));
        for (let i = 0; i < offenders.length; i++) {
            if (this._loggedOffenders.has(offenders[i])) continue;
            this._loggedOffenders.add(offenders[i]);
            console.error(`[render-passes] a second render-loop owner: a useFrame with priority ${internal.subscribers.find((s) => s.ref?.current === offenders[i])?.priority} took r3f's loop beside RenderPasses — the frame is RenderPasses' (declare a pass: ctx.renderPasses.add). Its callback: ${names[i]}`);
        }
        this.fault = { offenders: names, at: this.frames };
    }

    /** Per pass: frames timed, p50 / p95 / last ms over the window, and whether it is a frame pass. */
    stats() {
        const frame = new Set(this.passes.map((p) => p.name));
        const out = [];
        for (const name of [...this.order(), ...[...this.timing.keys()].filter((n) => !frame.has(n))]) {
            const r = this.timing.get(name);
            out.push({ name, frame: frame.has(name), count: r?.total ?? 0, p50: r ? r.quantile(0.5) : 0, p95: r ? r.quantile(0.95) : 0, last: r?.last ?? 0 });
        }
        return out;
    }
}
