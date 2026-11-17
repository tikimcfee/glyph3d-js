import { dockLayout } from './dockLayout.js';
import { chordLabel } from './chord.js';

/** The smallest terminal fullscreen makes (a tiny window still gets a usable one). */
const MIN = { cols: 20, rows: 5 };
/** A window or dock change waits this long to settle before the terminal re-wraps to it, ms. */
const REFIT_SETTLE_MS = 150;
/** The text sizes a fullscreen keeps between, CSS px per row. */
const LINE_PX = { min: 4, max: 200 };
/** Opacity of the frosted backing veil around a fullscreen terminal. */
const BACKDROP_OPACITY = 0.9;
const BACKDROP_BLUR_PX = 8;

/**
 * One terminal fullscreen: where it goes back to on the canvas, the camera's canvas pose, and its text
 * size here (CSS px per row).
 * @typedef {{ id: string, canvas: { cols: number, rows: number, x: number, y: number },
 *             camera: { x: number, y: number, zoom: number }, linePx: number, entryLinePx: number }} FullscreenState
 */

/**
 * WallFullscreen — one terminal takes the screen, as a terminal app's fullscreen does: lifted above the
 * canvas Z-stack (wallLayout.FULLSCREEN_Z), it re-wraps to fill the canvas the docked panels leave
 * (cols × rows at its text size, the leftover under a cell split evenly round it, `fullscreenPad` px
 * inside the edge), the camera eases onto it at that size, and a ~90%-opacity blurred backing plate
 * veils the live canvas round it while keeping visual context as the camera glides between selections.
 * Leaving gives the terminal back its canvas cols × rows, spot and Z-slot, and the camera its canvas pose.
 *
 * Its text size is its own. The first time a terminal goes fullscreen it keeps the size it had on
 * the canvas (at least `fullscreenMinLinePx`), so it shows more text, not bigger text; the text keys
 * (bigger, smaller: × `fullscreenTextStep`) change that, re-wrapping it, and the size they set is
 * remembered for that terminal (WallStore.fullscreenText) until reset puts it back to the canvas's.
 *
 * Focusing another terminal while fullscreen (cycling, the palette, the sidebar) moves fullscreen to
 * it, as switching tabs does; leaving then returns to the canvas pose of the first entry. A window or
 * dock change re-wraps it once it settles. The state is saved (WallStore.fullscreen), so a reload
 * comes back fullscreen rather than leaving a terminal at its fullscreen size on the canvas; hiding
 * the terminal leaves fullscreen first, and one that goes (closed, killed) ends it.
 */
export default class WallFullscreen {
    /** @param {import('./TerminalWall.js').default} wall */
    constructor(wall) {
        this.wall = wall;
        /** @type {FullscreenState|null} */
        this.state = null;
        /** The area the last fit filled, as a key; a change re-fits once it settles. */
        this._areaKey = '';
        /** When a pending re-fit runs (performance.now ms), or 0. */
        this._refitAt = 0;
        /** @type {HTMLDivElement|null} */
        this._backdrop = null;
        this._backdropKey = '';
    }

    /** The fullscreen terminal's id, or null. */
    get id() { return this.state?.id ?? null; }

    /**
     * The fullscreen terminal's pre-fullscreen body rect on the canvas, reconstructed from `state.canvas`
     * so directional navigation and group frames read where it lives on the canvas even while expanded.
     * @returns {import('./wallLayout.js').Rect|null}
     */
    canvasBodyRect() {
        const s = this.state, grid = s && this.wall.terminal(s.id);
        if (!s || !grid) return null;
        const r = this.wall.terminalRect(s.id), st = grid.cellStride;
        const frameX = r.maxX - r.minX - grid.cols * st.x;
        const frameY = r.maxY - r.minY - grid.rows * st.y;
        const minX = r.minX + (s.canvas.x - grid.position.x);
        const maxY = r.maxY + (s.canvas.y - grid.position.y);
        return {
            minX, maxX: minX + s.canvas.cols * st.x + frameX,
            maxY, minY: maxY - (s.canvas.rows * st.y + frameY),
        };
    }

    /** Mount the frosted backing plate inside the canvas host (DOM environments). @param {HTMLElement|null} host */
    attachBackdrop(host) {
        this.detachBackdrop();
        if (!host || typeof document === 'undefined') return;
        const el = document.createElement('div');
        el.dataset.fullscreenBackdrop = '';
        Object.assign(el.style, {
            position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '3', display: 'none',
            backdropFilter: `blur(${BACKDROP_BLUR_PX}px)`, WebkitBackdropFilter: `blur(${BACKDROP_BLUR_PX}px)`,
        });
        host.appendChild(el);
        this._backdrop = el;
        this._backdropKey = 'hidden';
    }

    /** Remove the frosted backing plate. */
    detachBackdrop() {
        this._backdrop?.remove();
        this._backdrop = null;
        this._backdropKey = '';
    }

    /**
     * Per frame: veil and blur the canvas outside the fullscreen terminal's screen box, leaving the
     * terminal's own panel crisp inside the cutout.
     * @param {import('./WallCamera.js').default} viewport
     * @param {string} background - canvas hex colour
     */
    updateBackdrop(viewport, background) {
        const el = this._backdrop;
        if (!el) return;
        const id = this.id;
        if (!id || !this.wall.terminal(id)) {
            if (this._backdropKey !== 'hidden') { this._backdropKey = 'hidden'; el.style.display = 'none'; }
            return;
        }
        const box = viewport.toScreenBox(this.wall.terminalRect(id));
        const clip = backdropClipPath(box, viewport.view);
        const bg = backdropColor(background, BACKDROP_OPACITY);
        const key = `${bg}|${clip}`;
        if (key === this._backdropKey) return;
        this._backdropKey = key;
        el.style.display = 'block';
        el.style.background = bg;
        el.style.clipPath = clip;
    }

    /**
     * The canvas a fullscreen fills: the viewport less the docked panels, CSS px.
     * @returns {{ left: number, top: number, width: number, height: number }}
     */
    area() {
        const s = this.wall.store, v = this.wall.viewport.view;
        const { edges } = dockLayout({ sidebar: s.sidebar(), statusWindow: s.statusWindow(), settingsPanel: s.settingsPanel(), helpPanel: s.helpPanel() });
        return { left: edges.left, top: 0, width: Math.max(0, v.w - edges.left - edges.right), height: v.h };
    }

    /** Toggle: leave a fullscreen, or put `id` (else the focused terminal) fullscreen. @param {string|null} [id] */
    toggle(id = null) {
        if (this.state) { this.exit(); return; }
        const target = id ?? this.wall.focusedId;
        if (target) this.enter(target);
    }

    /**
     * Put a terminal fullscreen — or, while another is, move fullscreen to it.
     * @param {string} id @returns {boolean}
     */
    enter(id) {
        const w = this.wall, grid = w.terminal(id);
        if (!grid || !w.isShown(id)) return false;
        if (this.state?.id === id) { this.refit(); return true; }
        const cam = w.viewport.camera;
        // The canvas pose is the first entry's: moving between fullscreen terminals keeps it.
        const camera = this.state?.camera ?? { x: cam.position.x, y: cam.position.y, zoom: cam.zoom };
        if (this.state) this._giveBack(this.state);
        const canvasPx = grid.cellStride.y * w.viewport.zoom;
        const entryLinePx = this.state?.entryLinePx ?? clampLine(Math.max(canvasPx, w.config.fullscreenMinLinePx));
        this.state = {
            id, camera, entryLinePx,
            canvas: { cols: grid.cols, rows: grid.rows, x: grid.position.x, y: grid.position.y },
            linePx: w.store.fullscreenText(id) ?? entryLinePx,
        };
        w.store.setFullscreen(this.state);
        w.pointer?.quenchWheel?.();
        if (w.focusedId !== id) w.focus(id);
        w.applyCanvas();
        this.refit();
        w._emit();
        return true;
    }

    /** Leave fullscreen: the terminal back to its canvas size and spot, the camera to its canvas pose. */
    exit() {
        const s = this.state;
        if (!s) return;
        this.state = null;
        this.wall.store.setFullscreen(null);
        this.wall.pointer?.quenchWheel?.();
        this._giveBack(s);
        this.wall.applyCanvas();
        this.wall.groups.relayoutOf(s.id);
        this.wall.viewport.easeTo(s.camera);
        this.wall._emit();
    }

    /**
     * The fullscreen terminal went (closed or killed): end it without touching the terminal, the camera
     * back to its canvas pose. (One being hidden leaves through exit, so it hides at its canvas size.)
     * @param {string} id
     */
    gone(id) {
        const s = this.state;
        if (!s || s.id !== id) return;
        this.state = null;
        this.wall.store.setFullscreen(null);
        this.wall.pointer?.quenchWheel?.();
        this.wall.applyCanvas();
        this.wall.viewport.easeTo(s.camera);
        this.wall._emit();
    }

    /**
     * A terminal registered: if it's the one a saved fullscreen named (a reload), take that up again,
     * and say so in the wall's notice.
     * @param {string} id
     */
    adopt(id) {
        if (this.state) return;
        const saved = this.wall.store.fullscreen();
        if (!saved || saved.id !== id || !this.wall.isShown(id)) return;
        this.state = { ...saved };
        this.wall.applyCanvas();
        this.refit();
        // Fullscreen hides the wall's own chrome, so a page that loads into it says so: one terminal
        // on screen is the saved fullscreen, not a wall that lost the rest.
        this.wall.notify(`fullscreen: ${this.wall.nameOf(id)} — ${chordLabel(['↵'])} shows the whole wall again`);
        this.wall._emit();
    }

    /**
     * Change the fullscreen text size: +1 bigger, −1 smaller (× fullscreenTextStep), 0 back to the
     * canvas's size. The terminal re-wraps to it, and the size is remembered for it (reset forgets it).
     * @param {-1|0|1} dir @returns {number|null} the text size now, CSS px per row
     */
    text(dir) {
        const s = this.state;
        if (!s) return null;
        const w = this.wall;
        if (dir === 0) { s.linePx = s.entryLinePx; w.store.setFullscreenText(s.id, null); }
        else {
            s.linePx = clampLine(s.linePx * Math.pow(w.config.fullscreenTextStep, dir));
            w.store.setFullscreenText(s.id, s.linePx);
        }
        w.store.setFullscreen(s);
        this.refit();
        w._emit();
        return s.linePx;
    }

    /**
     * Fit the fullscreen terminal to the area: cols × rows at its text size, the camera on it.
     * @returns {{ cols: number, rows: number }|null}
     */
    refit() {
        const s = this.state, w = this.wall;
        const grid = s && w.terminal(s.id);
        if (!grid) return null;
        const a = this.area();
        this._areaKey = areaKey(a);
        this._refitAt = 0;
        const stride = grid.cellStride;
        const zoom = s.linePx / stride.y;
        const cellW = stride.x * zoom, cellH = s.linePx, pad = w.config.fullscreenPad;
        // The panel is the cells plus the grid's own padding round them (computeCellGridLayout), so
        // the whole panel is what must fit: its frame (panel less cells) is measured off the grid as it
        // stands, in px at this size — it doesn't change as the grid re-wraps.
        const r = w.terminalRect(s.id), v = w.viewport.view;
        const frameX = (r.maxX - r.minX - grid.cols * stride.x) * zoom;
        const frameY = (r.maxY - r.minY - grid.rows * stride.y) * zoom;
        const cols = Math.max(MIN.cols, Math.floor((a.width - 2 * pad - frameX) / cellW));
        const rows = Math.max(MIN.rows, Math.floor((a.height - 2 * pad - frameY) / cellH));
        if (cols !== grid.cols || rows !== grid.rows) w.router.execute(['terminal.resize', s.id, String(cols), String(rows)]);
        // The panel's top-left stays put as it re-wraps (it grows right and down), so the pose is known
        // now: that corner at the area's top-left, the leftover under a cell split evenly round it.
        const left = a.left + Math.max(0, (a.width - cols * cellW - frameX) / 2);
        const top = a.top + Math.max(0, (a.height - rows * cellH - frameY) / 2);
        w.viewport.easeTo({ x: r.minX + (v.w / 2 - left) / zoom, y: r.maxY - (v.h / 2 - top) / zoom, zoom });
        return { cols, rows };
    }

    /** Per frame: a window or dock change re-fits once it has held still for REFIT_SETTLE_MS. @param {number} now */
    tick(now) {
        if (!this.state) return;
        const key = areaKey(this.area());
        if (key !== this._areaKey) { this._areaKey = key; this._refitAt = now + REFIT_SETTLE_MS; }
        if (this._refitAt && now >= this._refitAt) this.refit();
    }

    /** Give a terminal that was fullscreen its canvas size and spot back. @param {FullscreenState} s */
    _giveBack(s) {
        const w = this.wall, grid = w.terminal(s.id);
        if (!grid) return;
        const { cols, rows, x, y } = s.canvas;
        if (grid.cols !== cols || grid.rows !== rows) w.router.execute(['terminal.resize', s.id, String(cols), String(rows)]);
        grid.position.x = x;
        grid.position.y = y;
    }
}

/** @param {number} px */
function clampLine(px) { return Math.min(LINE_PX.max, Math.max(LINE_PX.min, px)); }

/** @param {{ left: number, top: number, width: number, height: number }} a */
function areaKey(a) { return `${a.left},${a.top},${Math.round(a.width)},${Math.round(a.height)}`; }

/**
 * CSS `clip-path` covering the viewport except `box` (a counter-clockwise inner contour joined by a
 * zero-width bridge, so the interior has winding 0 and stays completely unblurred). `'none'` when `box`
 * lies wholly off-screen during the start of a camera glide.
 * @param {{ left: number, right: number, top: number, bottom: number }} box
 * @param {{ w: number, h: number }} view
 */
export function backdropClipPath(box, view) {
    const L = Math.max(0, Math.min(view.w, box.left));
    const R = Math.max(0, Math.min(view.w, box.right));
    const T = Math.max(0, Math.min(view.h, box.top));
    const B = Math.max(0, Math.min(view.h, box.bottom));
    if (R - L <= 0.5 || B - T <= 0.5) return 'none';
    const l = L.toFixed(1), r = R.toFixed(1), t = T.toFixed(1), b = B.toFixed(1);
    return `polygon(0px 0px, 100% 0px, 100% 100%, 0px 100%, 0px 0px, ${l}px ${t}px, ${l}px ${b}px, ${r}px ${b}px, ${r}px ${t}px, ${l}px ${t}px, 0px 0px)`;
}

/** @param {string} hex @param {number} alpha */
export function backdropColor(hex, alpha = BACKDROP_OPACITY) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return `rgba(7, 8, 11, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
