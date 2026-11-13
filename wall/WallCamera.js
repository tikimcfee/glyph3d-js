import { fitRect } from './wallLayout.js';

/** Ease rate (1/s) for framing animations. */
const EASE_RATE = 14;
/** Zoom clamp, CSS px per world unit. Plain floats are ample at this range. */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 200;
/**
 * Wheel zoom, born configurable (`new WallCamera(camera, canvas, { wheelZoom })`): every
 * `pixelsPerNotch` of wheel delta (one mouse notch) zooms by `stepFactor` about the pointer, and the
 * camera eases there at `settleRate` (1/s, exponential in log zoom: 95% in 3/settleRate s), so a run
 * of notches is one continuous glide that lands exactly. No overshoot, no inertia.
 */
export const WHEEL_ZOOM = Object.freeze({ stepFactor: 1.12, pixelsPerNotch: 100, settleRate: 24 });

/**
 * WallCamera — the wall's orthographic camera and every mapping through it. zoom = CSS px per
 * world unit; the camera looks straight down −Z at the plane, y up in the world, y down on screen.
 * Holds the viewport size (set each frame) so screen↔world never reads a stale size, and an
 * optional ease target that `step` approaches (any direct move cancels it).
 */
export default class WallCamera {
    /**
     * @param {import('three').OrthographicCamera} camera
     * @param {HTMLCanvasElement} canvas
     * @param {{wheelZoom?: Partial<typeof WHEEL_ZOOM>}} [opts]
     */
    constructor(camera, canvas, { wheelZoom = {} } = {}) {
        if (!camera.isOrthographicCamera) {
            throw new Error('[wall] the wall needs an orthographic camera (GlyphCanvas orthographic)');
        }
        this.camera = camera;
        this.canvas = canvas;
        this.view = { w: 1, h: 1 };
        /** @type {{x:number, y:number, zoom:number}|null} */
        this.target = null;
        this.wheelZoom = { ...WHEEL_ZOOM, ...wheelZoom };
        /** A wheel zoom in flight: the log zoom it lands on, and the world point held under the pointer. */
        /** @type {{lnZoom:number, clientX:number, clientY:number, world:{x:number,y:number}}|null} */
        this.wheel = null;
    }

    /** True while the camera is moving on its own (a framing ease or a wheel glide). */
    get moving() { return !!(this.target || this.wheel); }

    get zoom() { return this.camera.zoom; }

    setView(w, h) { this.view.w = w; this.view.h = h; }

    /** A client (page) point → world. */
    toWorld(clientX, clientY) {
        const r = this.canvas.getBoundingClientRect(), c = this.camera;
        return {
            x: c.position.x + (clientX - r.left - r.width / 2) / c.zoom,
            y: c.position.y - (clientY - r.top - r.height / 2) / c.zoom,
        };
    }

    /** A world rect → canvas-relative screen box (CSS px, y down). */
    toScreenBox(rect) {
        const c = this.camera, w = this.view.w, h = this.view.h;
        return {
            left: w / 2 + (rect.minX - c.position.x) * c.zoom, right: w / 2 + (rect.maxX - c.position.x) * c.zoom,
            top: h / 2 - (rect.maxY - c.position.y) * c.zoom, bottom: h / 2 - (rect.minY - c.position.y) * c.zoom,
        };
    }

    /** Pan by a screen-space delta (CSS px). */
    panBy(dxPx, dyPx) {
        this.target = null;
        const dx = dxPx / this.camera.zoom, dy = -dyPx / this.camera.zoom;
        this.camera.position.x += dx;
        this.camera.position.y += dy;
        // A pan during a wheel glide carries the held point with it (the glide keeps going).
        if (this.wheel) { this.wheel.world.x += dx; this.wheel.world.y += dy; }
    }

    /** Place the camera centre directly (world). */
    moveTo(x, y) {
        this.target = null;
        this.wheel = null;
        this.camera.position.x = x;
        this.camera.position.y = y;
    }

    /** Zoom by `factor` about a client point, keeping the world point under it fixed. */
    zoomAt(clientX, clientY, factor) {
        this.target = null;
        this.wheel = null;
        const before = this.toWorld(clientX, clientY);
        this.camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.camera.zoom * factor));
        this.camera.updateProjectionMatrix();
        const after = this.toWorld(clientX, clientY);
        this.camera.position.x += before.x - after.x;
        this.camera.position.y += before.y - after.y;
    }

    /**
     * Wheel zoom about a client point: `deltaPx` (wheel delta in CSS px, + = away = out) moves the
     * glide's landing zoom; `step` eases there, holding the world point under the pointer fixed.
     * Notches arriving mid-glide add to where it lands, not to where it is.
     */
    wheelZoomAt(clientX, clientY, deltaPx) {
        this.target = null;
        const w = this.wheelZoom;
        const from = this.wheel ? this.wheel.lnZoom : Math.log(this.camera.zoom);
        const lnZoom = Math.min(Math.log(ZOOM_MAX), Math.max(Math.log(ZOOM_MIN),
            from - Math.log(w.stepFactor) * (deltaPx / w.pixelsPerNotch)));
        this.wheel = { lnZoom, clientX, clientY, world: this.toWorld(clientX, clientY) };
    }

    /** The pose that fits `rect` in the view (margin fraction; zoom capped at maxZoom). */
    fitTarget(rect, margin, maxZoom = Infinity) {
        return fitRect(rect, this.view.w, this.view.h, margin, maxZoom);
    }

    /** Ease toward a pose. */
    easeTo(target) { this.wheel = null; this.target = target; }

    /** True when the camera already sits at `target` (within a few px / 2% zoom). */
    isAt(target) {
        const c = this.camera;
        return Math.abs(c.zoom / target.zoom - 1) < 0.02
            && Math.hypot(c.position.x - target.x, c.position.y - target.y) * c.zoom < 4;
    }

    /** Per frame: step the wheel glide or the ease (exponential, zoom in log space); each lands exactly and clears. */
    step(dt) {
        if (this.wheel) this._stepWheel(dt);
        const a = this.target;
        if (!a) return;
        const c = this.camera;
        const k = 1 - Math.exp(-dt * EASE_RATE);
        c.position.x += (a.x - c.position.x) * k;
        c.position.y += (a.y - c.position.y) * k;
        c.zoom = Math.exp(Math.log(c.zoom) + (Math.log(a.zoom) - Math.log(c.zoom)) * k);
        c.updateProjectionMatrix();
        if (Math.hypot(a.x - c.position.x, a.y - c.position.y) * c.zoom < 0.5 && Math.abs(a.zoom / c.zoom - 1) < 1e-3) {
            c.position.x = a.x; c.position.y = a.y; c.zoom = a.zoom;
            c.updateProjectionMatrix();
            this.target = null;
        }
    }

    _stepWheel(dt) {
        const g = this.wheel, c = this.camera;
        const ln = Math.log(c.zoom);
        const k = 1 - Math.exp(-dt * this.wheelZoom.settleRate);
        const landed = Math.abs(g.lnZoom - ln) < 1e-3;
        c.zoom = Math.exp(landed ? g.lnZoom : ln + (g.lnZoom - ln) * k);
        c.updateProjectionMatrix();
        const at = this.toWorld(g.clientX, g.clientY);
        c.position.x += g.world.x - at.x;
        c.position.y += g.world.y - at.y;
        if (landed) this.wheel = null;
    }
}
