/**
 * terminalScroll — proportional sub-line accumulation and discrete-notch momentum stepping for
 * terminal wheel scrolling (`terminal.scroll`).
 *
 *   - Trackpads & continuous pixel wheels (`deltaMode === 0`, small deltas + OS momentum):
 *     accumulate fractional lines scaled to the terminal's rendered screen-space row height
 *     (`rowPx = cellStride.y * zoom`, clamped to a comfortable `[12, 36]` px band) and emit
 *     whole lines as the remainder crosses integer boundaries — preserving slow 1:1 finger
 *     tracking and gentle OS momentum tails instead of clamping every 1 px event to ±1 line.
 *   - Discrete mouse wheel notches (`deltaMode === 1`, or large isolated pixel jumps):
 *     emit one immediate line on the notch for zero-latency feedback and glide the remaining
 *     lines across animation frames (`step(dt)`) with exponential decay, stacking consecutive
 *     notches smoothly and halting immediately on direction reversal, focus change, or typing.
 */

/** Fallback CSS px per line when a stand-in terminal has no `cellStride`. */
const DEFAULT_WHEEL_PX_PER_LINE = 30;
/** Clamp screen-space row height so micro-zoomed terminals don't rocket and huge ones stay responsive. */
const MIN_ROW_PX = 12;
const MAX_ROW_PX = 36;
/** Idle gap (ms) after which a finished wheel gesture drops its leftover sub-line remainder or latch. */
export const STREAM_IDLE_MS = 180;
/** Quiet gap (ms) with zero wheel events before an inertial wheel stream is considered finished. */
const GATE_QUIET_MS = 140;
/** Pixel delta threshold (CSS px) at gesture start separating a trackpad from a discrete mouse notch. */
const NOTCH_MIN_PX = 80;
/** Exponential settle rate (1/s) for gliding multi-line discrete mouse wheel notches across frames. */
const GLIDE_SETTLE_RATE = 22;
/** Pointer travel (CSS px) that breaks a stationary canvas wheel-stream target latch. */
const LATCH_SLOP_PX = 24;
const EPS = 1e-6;

/**
 * Convert a raw vertical wheel delta into signed fractional terminal lines
 * (+ = up into scrollback history, − = down toward live).
 * @param {number} dy
 * @param {number} [deltaMode=0] - 0 = pixel, 1 = line, 2 = page
 * @param {{ rowPx?: number|null, rows?: number, multiplier?: number }} [o]
 * @returns {number}
 */
export function wheelDeltaLines(dy, deltaMode = 0, { rowPx = null, rows = 24, multiplier = 1 } = {}) {
    if (!dy || !Number.isFinite(dy)) return 0;
    const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
    if (deltaMode === 1) return -dy * m;
    if (deltaMode === 2) return -dy * Math.max(1, rows - 2) * m;
    const pxPerLine = rowPx != null && Number.isFinite(rowPx) && rowPx > 0
        ? Math.min(MAX_ROW_PX, Math.max(MIN_ROW_PX, rowPx))
        : DEFAULT_WHEEL_PX_PER_LINE;
    return -(dy / pxPerLine) * m;
}

export default class TerminalScroller {
    /**
     * @param {(id: string, lines: number, cell: { x: number, y: number }) => void} onScroll
     */
    constructor(onScroll) {
        this._emit = onScroll;
        /** @type {string|null} */
        this._id = null;
        this._rem = 0;
        this._pending = 0;
        this._trackpad = false;
        this._lastAt = -Infinity;
        this._cell = { x: 0, y: 0 };
    }

    /** Terminal currently holding remainder or momentum glide state, if any. */
    get activeId() { return this._id; }

    /** True while discrete wheel-notch lines are gliding across frames. */
    get gliding() { return Math.abs(this._pending) >= EPS; }

    /** Drop any buffered remainder and in-flight momentum glide. */
    reset() {
        this._id = null;
        this._rem = 0;
        this._pending = 0;
        this._trackpad = false;
        this._lastAt = -Infinity;
    }

    /**
     * Feed a vertical wheel event on terminal `id` at pointer cell `cell`.
     * @param {string} id
     * @param {number} dy - `e.deltaY` (read before `e.deltaMode`)
     * @param {number} deltaMode - `e.deltaMode` (0 = px, 1 = line, 2 = page)
     * @param {{ x: number, y: number }} cell
     * @param {{ rowPx?: number|null, rows?: number, multiplier?: number, now?: number, glide?: boolean }} [opts]
     * @returns {number} whole lines emitted synchronously on this event
     */
    wheel(id, dy, deltaMode, cell, opts = {}) {
        if (!id || !dy || !Number.isFinite(dy)) return 0;
        const now = opts.now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (this._id !== id) {
            this.reset();
            this._id = id;
        } else if (now - this._lastAt > STREAM_IDLE_MS && !this.gliding) {
            this._rem = 0;
            this._trackpad = false;
        }

        const delta = wheelDeltaLines(dy, deltaMode, opts);
        if (!delta) return 0;

        const total = this._rem + this._pending;
        if (total !== 0 && Math.sign(delta) !== Math.sign(total)) {
            this._rem = 0;
            this._pending = 0;
        }

        const subNotchPixel = deltaMode === 0 && (Math.abs(dy) < NOTCH_MIN_PX || !Number.isInteger(dy));
        if (subNotchPixel) {
            this._trackpad = true;
            if (this._pending !== 0) {
                this._rem += this._pending;
                this._pending = 0;
            }
        } else if (deltaMode !== 0) {
            this._trackpad = false;
        }

        this._lastAt = now;
        this._cell.x = cell.x;
        this._cell.y = cell.y;

        if (this._trackpad || !opts.glide || Math.abs(delta) <= 1.25) {
            this._rem += delta;
            const whole = this._takeWhole();
            if (whole !== 0) this._emit(id, whole, this._cell);
            return whole;
        }

        const wasIdle = Math.abs(this._pending) < 0.5;
        this._pending += delta;
        if (wasIdle && Math.abs(this._pending + this._rem) >= 1 - EPS) {
            const lead = Math.sign(delta);
            this._pending -= lead;
            this._emit(id, lead, this._cell);
            return lead;
        }
        return 0;
    }

    /**
     * Advance any in-flight discrete-notch glide by `dt` seconds.
     * @param {number} dt
     * @returns {number} whole lines emitted on this frame
     */
    step(dt) {
        if (!this._id || Math.abs(this._pending) < EPS) return 0;
        if (!(dt > 0) || !Number.isFinite(dt)) return 0;
        const k = 1 - Math.exp(-dt * GLIDE_SETTLE_RATE);
        const done = Math.abs(this._pending) < 0.15;
        const take = done ? this._pending : this._pending * k;
        this._pending = done ? 0 : this._pending - take;
        this._rem += take;
        const whole = this._takeWhole();
        if (whole !== 0) this._emit(this._id, whole, this._cell);
        return whole;
    }

    _takeWhole() {
        const biased = this._rem + Math.sign(this._rem) * EPS;
        const whole = Math.trunc(biased);
        if (whole === 0) return 0;
        this._rem -= whole;
        if (Math.abs(this._rem) < EPS) this._rem = 0;
        return whole;
    }
}

/**
 * WheelStreamGate — tracks continuous OS wheel/trackpad streams across mode and focus transitions:
 *   - `quench(now)` (called when entering/exiting fullscreen or framing the camera): if ANY wheel stream
 *     (plain OR `⌥`/`⌘`/`⌃` zoom!) was active within `GATE_QUIET_MS`, absorbs the entire remaining OS
 *     inertial tail — regardless of modifier keys held or released during the chord — so `(⌥+fling) → ⌘↵`
 *     or `fling → ⌘↵` never triggers camera zoomies or pans away. Releases once the stream goes quiet
 *     (`> GATE_QUIET_MS`), reverses direction after the transition grace window, or clearly re-grips after
 *     decaying near rest.
 *   - Mid-stream modifier guard: if a stream began as a plain scroll/pan (`!zoom`), pressing `⌘` or `⌥`
 *     mid-momentum (e.g. holding `⌘` on the way to `⌘↵` or `⌘B`) never promotes that coasting stream into
 *     a camera zoom; genuine trackpad pinches (`ctrlKey`) still zoom at any moment.
 *   - `canvasTarget(x, y, hitFocusedId)`: latches a continuous wheel gesture under a stationary pointer
 *     (`<= LATCH_SLOP_PX`) to where it started (`'terminal'` vs `'pan'`).
 */
export class WheelStreamGate {
    constructor() {
        this._lastAt = -Infinity;
        this._lastDx = 0;
        this._lastDy = 0;
        this._lastMag = 0;
        /** @type {boolean|null} */
        this._streamZoom = null;
        /** @type {{ startedAt: number, minMag: number, vx: number, vy: number }|null} */
        this._quench = null;
        /** @type {{ kind: 'terminal', id: string, x: number, y: number }|{ kind: 'pan', x: number, y: number }|null} */
        this._latch = null;
    }

    reset() {
        this._lastAt = -Infinity;
        this._lastDx = 0;
        this._lastDy = 0;
        this._lastMag = 0;
        this._streamZoom = null;
        this._quench = null;
        this._latch = null;
    }

    /** Quench any active wheel inertial stream (plain or zoom) across a fullscreen or framing transition. */
    quench(now = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
        this._latch = null;
        if (now - this._lastAt <= GATE_QUIET_MS) {
            this._quench = {
                startedAt: now,
                minMag: this._lastMag > 0 ? this._lastMag : Infinity,
                vx: this._lastDx,
                vy: this._lastDy,
            };
        } else {
            this._quench = null;
        }
    }

    /**
     * Inspect an incoming wheel event; returns `{ ok: false, zoom: false }` when it belongs to a quenched
     * pre-transition inertial tail, else `{ ok: true, zoom }` with the effective zoom flag for this stream.
     * @param {number} dx - pixel-scaled deltaX
     * @param {number} dy - pixel-scaled deltaY
     * @param {{ zoom?: boolean, ctrlKey?: boolean, now?: number }} [o]
     * @returns {{ ok: boolean, zoom: boolean }}
     */
    accept(dx, dy, { zoom = false, ctrlKey = false, now = typeof performance !== 'undefined' ? performance.now() : Date.now() } = {}) {
        const dt = now - this._lastAt;
        const mag = Math.hypot(dx, dy);
        if (this._quench) {
            if (dt > GATE_QUIET_MS) {
                this._quench = null;
                this._streamZoom = null;
            } else {
                const q = this._quench;
                const age = now - q.startedAt;
                const reversed = age > 120 && (dx * q.vx + dy * q.vy) < -16;
                const regripped = age > 250 && q.minMag < 4 && mag > 36;
                if (reversed || regripped) {
                    this._quench = null;
                    this._streamZoom = null;
                } else {
                    if (mag > 0) {
                        q.minMag = Math.min(q.minMag, mag);
                        q.vx = dx;
                        q.vy = dy;
                    }
                    this._lastAt = now;
                    this._lastDx = dx;
                    this._lastDy = dy;
                    this._lastMag = mag;
                    return { ok: false, zoom: false };
                }
            }
        }
        let effectiveZoom = !!zoom;
        if (dt > GATE_QUIET_MS || this._streamZoom === null) {
            this._latch = null;
            this._streamZoom = effectiveZoom;
        } else if (ctrlKey) {
            // Trackpad pinch arrives as ctrlKey+wheel and may start mid-pan: always honour it.
            this._streamZoom = effectiveZoom;
        } else if (this._streamZoom === false && effectiveZoom) {
            // Pressing ⌘ or ⌥ mid-momentum (e.g. preparing ⌘↵) must never turn a coasting scroll into zoomies.
            effectiveZoom = false;
        }
        this._lastAt = now;
        this._lastDx = dx;
        this._lastDy = dy;
        this._lastMag = mag;
        return { ok: true, zoom: effectiveZoom };
    }

    /**
     * Resolve or maintain the latched target for a continuous plain-wheel gesture on the canvas.
     * @param {number} clientX
     * @param {number} clientY
     * @param {string|null} hitFocusedId - focused terminal id under `(clientX, clientY)`, if any
     */
    canvasTarget(clientX, clientY, hitFocusedId) {
        if (this._latch && Math.hypot(clientX - this._latch.x, clientY - this._latch.y) <= LATCH_SLOP_PX) {
            return this._latch;
        }
        this._latch = hitFocusedId
            ? { kind: 'terminal', id: hitFocusedId, x: clientX, y: clientY }
            : { kind: 'pan', x: clientX, y: clientY };
        return this._latch;
    }
}
