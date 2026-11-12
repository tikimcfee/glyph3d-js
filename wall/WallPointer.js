import { terminalWheelLines } from '@glyph3d/core/services/terminal/terminalCommands.js';
import { edgeCursor, resizeFromDrag } from './wallLayout.js';

/** Pointer travel (CSS px) before a press becomes a drag instead of a click. */
const DRAG_SLOP_PX = 4;
/** Smallest terminal a border drag can make. */
const MIN_SIZE = { minCols: 20, minRows: 5 };
/** A wheel event in lines (deltaMode 1) moves this many CSS px. */
const LINE_PX = 16;
/** A ctrl+wheel delta under this (CSS px) is a trackpad pinch, followed directly; at or over it, a mouse notch. */
const PINCH_MAX_DELTA = 50;

/**
 * WallPointer — every pointer gesture on the wall, as one state machine.
 *
 *   press on …                 click (no travel)          drag
 *   empty canvas (or middle)   drop focus                 pan
 *   a terminal's border        —                          resize (cells; left/top keep the far edge)
 *   a title bar                focus                      move the terminal
 *   a map label                focus + frame              move the terminal
 *   a terminal's body          focus                      — (the body never drags…)
 *   ⌥ + anywhere on a terminal focus                      move  (…unless ⌥ is held: drawing-canvas move)
 *
 * Wheel: over the FOCUSED terminal it drives that terminal's scrollback; anywhere else it zooms
 * about the pointer in small eased steps (WallCamera.wheelZoomAt), and a sideways delta pans. A
 * trackpad pinch (ctrl+wheel, small deltas) zooms directly with the fingers; ctrl + a mouse notch
 * glides like a plain notch. Double-click a terminal: focus + frame;
 * double-click empty canvas: fit all. Hover lights the border and sets the cursor (⌥ shows move).
 * A pointercancel or a lost pointer capture ends the gesture where it stands (no click), and so
 * does the gesture's terminal going away; either way the capture is given back.
 */
export default class WallPointer {
    /**
     * @param {import('./TerminalWall.js').default} wall
     * @param {import('./WallCamera.js').default} camera
     */
    constructor(wall, camera) {
        this.wall = wall;
        this.camera = camera;
        this.canvas = camera.canvas;
        this._drag = null;
        this._last = null;   // last pointer position, to re-evaluate the cursor when ⌥ changes
        this._h = {
            wheel: (e) => this._onWheel(e),
            down: (e) => this._onDown(e),
            move: (e) => this._onMove(e),
            up: (e) => this._onUp(e),
            cancel: (e) => this._onCancel(e),
            dbl: (e) => this._onDouble(e),
            key: (e) => { if (e.key === 'Alt' && !this._drag && this._last) this._hover({ ...this._last, altKey: e.type === 'keydown' }); },
        };
    }

    install() {
        const c = this.canvas, h = this._h;
        c.addEventListener('wheel', h.wheel, { passive: false });
        c.addEventListener('pointerdown', h.down);
        c.addEventListener('dblclick', h.dbl);
        window.addEventListener('pointermove', h.move);
        window.addEventListener('pointerup', h.up);
        window.addEventListener('pointercancel', h.cancel);
        c.addEventListener('lostpointercapture', h.cancel);
        window.addEventListener('keydown', h.key);
        window.addEventListener('keyup', h.key);
    }

    uninstall() {
        const c = this.canvas, h = this._h;
        c.removeEventListener('wheel', h.wheel);
        c.removeEventListener('pointerdown', h.down);
        c.removeEventListener('dblclick', h.dbl);
        window.removeEventListener('pointermove', h.move);
        window.removeEventListener('pointerup', h.up);
        window.removeEventListener('pointercancel', h.cancel);
        c.removeEventListener('lostpointercapture', h.cancel);
        window.removeEventListener('keydown', h.key);
        window.removeEventListener('keyup', h.key);
    }

    /** A map label was pressed: a click frames its terminal, a drag moves it. */
    pressLabel(id, e) {
        if (e.button !== 0) return;
        this._start(e, { kind: 'press', id, clickFrames: true });
    }

    // ── gestures ──────────────────────────────────────────────────────────────

    _start(e, gesture) {
        const p = this.camera.toWorld(e.clientX, e.clientY);
        const grid = gesture.id ? this.wall.terminal(gesture.id) : null;
        this._drag = {
            pointerId: e.pointerId, captured: false,
            startX: e.clientX, startY: e.clientY, startWorld: p,
            camStart: { x: this.camera.camera.position.x, y: this.camera.camera.position.y },
            startPos: grid ? { x: grid.position.x, y: grid.position.y } : null,
            moved: false,
            ...gesture,
        };
    }

    _onDown(e) {
        if (e.button !== 0 && e.button !== 1) return;
        this.camera.target = null;
        const hit = e.button === 0 ? this.wall.hit(this.camera.toWorld(e.clientX, e.clientY)) : null;
        if (!hit) this._start(e, { kind: 'pan' });
        else if (e.altKey || hit.part === 'title') this._start(e, { kind: 'press', id: hit.id });
        else if (hit.part === 'edge') {
            const grid = this.wall.terminal(hit.id);
            this._start(e, {
                kind: 'resize', id: hit.id, edges: hit.edges, stride: grid.cellStride,
                start: { cols: grid.cols, rows: grid.rows }, last: { cols: grid.cols, rows: grid.rows },
            });
            this.wall.focus(hit.id);
        } else this._start(e, { kind: 'focus', id: hit.id });
        this.canvas.setPointerCapture(e.pointerId);
        this._drag.captured = true;
    }

    /** End the gesture in hand: drop it and give back the pointer capture it took. */
    _end() {
        const d = this._drag;
        this._drag = null;
        if (d?.captured && this.canvas.hasPointerCapture(d.pointerId)) this.canvas.releasePointerCapture(d.pointerId);
        return d;
    }

    /**
     * The browser took the pointer away (pointercancel — a touch turned into a scroll, the window lost
     * it) or its capture went (lostpointercapture). The gesture ends where it is: no click, and a
     * terminal it already moved keeps — and remembers — its new spot.
     */
    _onCancel(e) {
        const d = this._drag;
        if (!d || d.pointerId !== e.pointerId) return;
        this._end();
        if ((d.kind === 'press' || d.kind === 'resize') && d.moved && this.wall.terminal(d.id)) this.wall.rememberPosition(d.id);
    }

    _onMove(e) {
        this._last = { clientX: e.clientX, clientY: e.clientY };
        const d = this._drag;
        if (!d) { this._hover(e); return; }
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_SLOP_PX) d.moved = true;
        if (d.kind === 'pan') {
            const z = this.camera.zoom;
            this.camera.moveTo(d.camStart.x - (e.clientX - d.startX) / z, d.camStart.y + (e.clientY - d.startY) / z);
            return;
        }
        const grid = this.wall.terminal(d.id);
        if (!grid) { this._end(); return; }   // its terminal went away mid-drag
        const p = this.camera.toWorld(e.clientX, e.clientY);
        const dx = p.x - d.startWorld.x, dy = p.y - d.startWorld.y;
        if (d.kind === 'press' && d.moved) {
            grid.position.x = d.startPos.x + dx;
            grid.position.y = d.startPos.y + dy;
        } else if (d.kind === 'resize') {
            const r = resizeFromDrag(d.edges, d.start, d.stride, dx, dy, MIN_SIZE);
            if (r.cols !== d.last.cols || r.rows !== d.last.rows) {
                d.last = { cols: r.cols, rows: r.rows };
                this.wall.router.execute(['terminal.resize', d.id, String(r.cols), String(r.rows)]);
            }
            grid.position.x = d.startPos.x + r.shiftX;
            grid.position.y = d.startPos.y + r.shiftY;
        }
    }

    _onUp(e) {
        const d = this._drag;
        if (!d || d.pointerId !== e.pointerId) return;
        this._end();
        if (d.kind !== 'pan' && !this.wall.terminal(d.id)) return;   // its terminal went away
        if (d.kind === 'pan') { if (!d.moved) this.wall.focus(null); return; }
        if (d.kind === 'focus') { this.wall.focus(d.id); return; }   // a body press focuses, however it wobbled
        if (d.kind === 'press' && !d.moved) { this.wall.focus(d.id, { frame: !!d.clickFrames }); return; }
        if (d.kind === 'press' || d.kind === 'resize') this.wall.rememberPosition(d.id);
    }

    _onDouble(e) {
        const hit = this.wall.hit(this.camera.toWorld(e.clientX, e.clientY));
        if (hit && hit.part !== 'edge') this.wall.focus(hit.id, { frame: true });
        else if (!hit) this.wall.fitAll();
    }

    _onWheel(e) {
        e.preventDefault();
        const focused = this.wall.focusedId;
        if (!e.ctrlKey && focused) {
            const r = this.wall.terminalRect(focused);
            const p = this.camera.toWorld(e.clientX, e.clientY);
            if (p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY) {
                this.wall.router.execute(['terminal.scroll', focused, String(terminalWheelLines(e.deltaY))]);
                return;
            }
        }
        const px = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.camera.view.h : 1;
        const dy = e.deltaY * px;
        if (e.ctrlKey && Math.abs(dy) < PINCH_MAX_DELTA) {
            this.camera.zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
            return;
        }
        if (e.deltaX) this.camera.panBy(e.deltaX * px, 0);
        if (dy) this.camera.wheelZoomAt(e.clientX, e.clientY, dy);
    }

    _hover(e) {
        const hit = this.wall.hit(this.camera.toWorld(e.clientX, e.clientY));
        this.wall.setHovered(hit?.id ?? null);
        this.canvas.style.cursor = !hit ? 'grab'
            : e.altKey || hit.part === 'title' ? 'move'
            : hit.part === 'edge' ? edgeCursor(hit.edges) : 'text';
    }
}
