import { wheelScrollCommand } from '../app/client/surfaceInteractions.js';
import { edgeCursor, resizeFromDrag } from './wallLayout.js';

/** Pointer travel (CSS px) before a press becomes a drag instead of a click. */
const DRAG_SLOP_PX = 4;
/** Smallest terminal a border drag can make. */
const MIN_SIZE = { minCols: 20, minRows: 5 };

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
 * Wheel: two-finger scroll over the FOCUSED terminal drives its scrollback; pinch (ctrl+wheel)
 * zooms about the pointer; anywhere else the wheel pans. Double-click a terminal: focus + frame;
 * double-click empty canvas: fit all. Hover lights the border and sets the cursor (⌥ shows move).
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
        this.canvas.setPointerCapture?.(e.pointerId);
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
        if (!grid) { this._drag = null; return; }
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
        if (!d) return;
        this._drag = null;
        this.canvas.releasePointerCapture?.(e.pointerId);
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
                const cmd = wheelScrollCommand(this.wall.ctx.registry.get(focused), e.deltaY);
                if (cmd) { this.wall.router.execute(cmd); return; }
            }
        }
        if (e.ctrlKey) this.camera.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
        else this.camera.panBy(e.deltaX, e.deltaY);
    }

    _hover(e) {
        const hit = this.wall.hit(this.camera.toWorld(e.clientX, e.clientY));
        this.wall.setHovered(hit?.id ?? null);
        this.canvas.style.cursor = !hit ? 'grab'
            : e.altKey || hit.part === 'title' ? 'move'
            : hit.part === 'edge' ? edgeCursor(hit.edges) : 'text';
    }
}
