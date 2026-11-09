import { fitRect } from './wallLayout.js';

/** Ease rate (1/s) for framing animations. */
const EASE_RATE = 14;
/** Zoom clamp, CSS px per world unit. Plain floats are ample at this range. */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 200;

/**
 * WallCamera — the wall's orthographic camera and every mapping through it. zoom = CSS px per
 * world unit; the camera looks straight down −Z at the plane, y up in the world, y down on screen.
 * Holds the viewport size (set each frame) so screen↔world never reads a stale size, and an
 * optional ease target that `step` approaches (any direct move cancels it).
 */
export default class WallCamera {
    /** @param {import('three').OrthographicCamera} camera @param {HTMLCanvasElement} canvas */
    constructor(camera, canvas) {
        if (!camera.isOrthographicCamera) {
            throw new Error('[wall] the wall needs an orthographic camera (GlyphCanvas orthographic)');
        }
        this.camera = camera;
        this.canvas = canvas;
        this.view = { w: 1, h: 1 };
        /** @type {{x:number, y:number, zoom:number}|null} */
        this.target = null;
    }

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
        this.camera.position.x += dxPx / this.camera.zoom;
        this.camera.position.y -= dyPx / this.camera.zoom;
    }

    /** Place the camera centre directly (world). */
    moveTo(x, y) {
        this.target = null;
        this.camera.position.x = x;
        this.camera.position.y = y;
    }

    /** Zoom by `factor` about a client point, keeping the world point under it fixed. */
    zoomAt(clientX, clientY, factor) {
        this.target = null;
        const before = this.toWorld(clientX, clientY);
        this.camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.camera.zoom * factor));
        this.camera.updateProjectionMatrix();
        const after = this.toWorld(clientX, clientY);
        this.camera.position.x += before.x - after.x;
        this.camera.position.y += before.y - after.y;
    }

    /** The pose that fits `rect` in the view (margin fraction; zoom capped at maxZoom). */
    fitTarget(rect, margin, maxZoom = Infinity) {
        return fitRect(rect, this.view.w, this.view.h, margin, maxZoom);
    }

    /** Ease toward a pose. */
    easeTo(target) { this.target = target; }

    /** True when the camera already sits at `target` (within a few px / 2% zoom). */
    isAt(target) {
        const c = this.camera;
        return Math.abs(c.zoom / target.zoom - 1) < 0.02
            && Math.hypot(c.position.x - target.x, c.position.y - target.y) * c.zoom < 4;
    }

    /** Per frame: step the ease (exponential, zoom in log space); lands exactly and clears. */
    step(dt) {
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
}
