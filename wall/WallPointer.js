import { terminalWheelLines } from '@glyph3d/core/services/terminal/terminalCommands.js';
import { edgeCursor, resizeFromDrag, lassoTouches } from './wallLayout.js';

/** Pointer travel (CSS px) before a press becomes a drag instead of a click. */
const DRAG_SLOP_PX = 4;
/** A lasso takes a new point once the pointer is this far (CSS px) from its last one. */
const LASSO_STEP_PX = 3;
/** Smallest terminal a border drag can make. */
const MIN_SIZE = { minCols: 20, minRows: 5 };
/** A wheel event in lines (deltaMode 1) moves this many CSS px. */
const LINE_PX = 16;
/** A ctrl+wheel delta under this (CSS px) is a trackpad pinch, followed directly; at or over it, a mouse notch. */
const PINCH_MAX_DELTA = 50;

/**
 * WallPointer — every pointer gesture on the wall, as one state machine.
 *
 *   press on …                   click (no travel)             drag
 *   empty canvas (or middle)     drop focus + the selection    pan
 *   ⇧ + empty canvas             —                             lasso: what it touches joins the selection
 *   ⇧ + a terminal               add it to / take it out of    lasso (from there)
 *                                the selection
 *   a terminal's border          —                             resize (cells; left/top keep the far edge)
 *   a title bar                  focus                         move the terminal (a tiled member: drops
 *                                                              into the nearest tile, the group re-tiles)
 *   a map label                  focus + frame                 move the terminal
 *   a terminal's body            focus                         — (the body never drags…)
 *   ⌥ + anywhere on a terminal   focus                         move  (…unless ⌥ is held: drawing-canvas move)
 *   a group's header             select the group's members    move the whole group
 *
 * A group's backdrop is canvas (it pans and lassoes). A title bar's hide / close buttons and the
 * selection's group button are DOM over the canvas and never reach here.
 *
 * Wheel: over the FOCUSED terminal it drives that terminal's scrollback; anywhere else it zooms
 * about the pointer in small eased steps (WallCamera.wheelZoomAt), and a sideways delta pans. A
 * trackpad pinch (ctrl+wheel, small deltas) zooms directly with the fingers; ctrl + a mouse notch
 * glides like a plain notch. Double-click a terminal: focus + frame; a group's header: frame the
 * group; empty canvas: fit all. Hover lights the border and sets the cursor (⌥ shows move).
 * A pointercancel or a lost pointer capture ends the gesture where it stands (no click), and so
 * does the gesture's terminal (or group) going away; either way the capture is given back.
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
            key: (e) => { if ((e.key === 'Alt' || e.key === 'Shift') && !this._drag && this._last) this._hover({ ...this._last, altKey: e.altKey, shiftKey: e.shiftKey }); },
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
        this.wall.selectionOverlay?.setLasso(null);
    }

    /** A gesture is in hand (the hover buttons wait). */
    get busy() { return !!this._drag; }

    /** A lasso is being drawn. */
    get lassoing() { return this._drag?.kind === 'lasso'; }

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
        if (e.button === 0 && e.shiftKey) {
            if (hit?.id) this._start(e, { kind: 'shift', id: hit.id });
            else this._start(e, { kind: 'lasso', points: [{ x: e.clientX, y: e.clientY }] });
        } else if (!hit) this._start(e, { kind: 'pan' });
        else if (hit.group) this._start(e, { kind: 'group', group: hit.group, groupDrag: this.wall.groups.dragStart(hit.group) });
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
        if (d?.kind === 'lasso') this.wall.selectionOverlay.setLasso(null);
        return d;
    }

    /**
     * The browser took the pointer away (pointercancel — a touch turned into a scroll, the window lost
     * it) or its capture went (lostpointercapture). The gesture ends where it is: no click, no lasso
     * selection, and a terminal (or group) it already moved keeps — and remembers — its new spot.
     */
    _onCancel(e) {
        const d = this._drag;
        if (!d || d.pointerId !== e.pointerId) return;
        this._end();
        if ((d.kind === 'press' || d.kind === 'resize') && d.moved && this.wall.terminal(d.id)) this._settle(d);
        if (d.kind === 'group' && d.moved) this.wall.groups.dragEnd(d.groupDrag);
    }

    _onMove(e) {
        this._last = { clientX: e.clientX, clientY: e.clientY };   // (modifiers come from the key event that re-hovers)
        const d = this._drag;
        if (!d) { this._hover(e); return; }
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_SLOP_PX) d.moved = true;
        if (d.kind === 'pan') {
            const z = this.camera.zoom;
            this.camera.moveTo(d.camStart.x - (e.clientX - d.startX) / z, d.camStart.y + (e.clientY - d.startY) / z);
            return;
        }
        if (d.kind === 'shift') {
            if (!d.moved) return;
            d.kind = 'lasso';   // a ⇧-press on a terminal that travels becomes a lasso from where it started
            d.points = [{ x: d.startX, y: d.startY }];
        }
        if (d.kind === 'lasso') {
            const last = d.points[d.points.length - 1];
            if (Math.hypot(e.clientX - last.x, e.clientY - last.y) >= LASSO_STEP_PX) d.points.push({ x: e.clientX, y: e.clientY });
            if (d.moved) this.wall.selectionOverlay.setLasso(d.points);
            return;
        }
        const p = this.camera.toWorld(e.clientX, e.clientY);
        const dx = p.x - d.startWorld.x, dy = p.y - d.startWorld.y;
        if (d.kind === 'group') {
            if (!this.wall.store.group(d.group)) { this._end(); return; }   // the group went mid-drag
            if (d.moved) this.wall.groups.dragTo(d.groupDrag, dx, dy);
            return;
        }
        const grid = this.wall.terminal(d.id);
        if (!grid) { this._end(); return; }   // its terminal went away mid-drag
        if (d.kind === 'press' && d.moved) {
            grid.position.x = d.startPos.x + dx;
            grid.position.y = d.startPos.y + dy;
        } else if (d.kind === 'resize') {
            const r = resizeFromDrag(d.edges, d.start, d.stride, dx, dy, MIN_SIZE);
            if (r.cols !== d.last.cols || r.rows !== d.last.rows) {
                d.last = { cols: r.cols, rows: r.rows };
                this.wall.router.execute(['terminal.resize', d.id, String(r.cols), String(r.rows)]);
            }
            // A tiled member's spot is its tile's: the group re-tiles as it resizes.
            if (!this.wall.groups.tiles(d.id)) {
                grid.position.x = d.startPos.x + r.shiftX;
                grid.position.y = d.startPos.y + r.shiftY;
            }
        }
    }

    _onUp(e) {
        const d = this._drag;
        if (!d || d.pointerId !== e.pointerId) return;
        this._end();
        if (d.kind === 'pan') { if (!d.moved) { this.wall.focus(null); this.wall.run(['wall.select', 'none']); } return; }
        if (d.kind === 'lasso') { if (d.moved) this._lassoSelect(d.points); return; }
        if (d.kind === 'group') {
            if (!this.wall.store.group(d.group)) return;
            if (d.moved) this.wall.groups.dragEnd(d.groupDrag);
            else this.wall.run(['wall.select', ...this.wall.groups.shownMembers(d.group)]);
            return;
        }
        if (!this.wall.terminal(d.id)) return;   // its terminal went away
        if (d.kind === 'shift') { this.wall.run(['wall.select.toggle', d.id]); return; }
        if (d.kind === 'focus') { this.wall.focus(d.id); return; }   // a body press focuses, however it wobbled
        if (d.kind === 'press' && !d.moved) { this.wall.focus(d.id, { frame: !!d.clickFrames }); return; }
        if (d.kind === 'press' || d.kind === 'resize') this._settle(d);
    }

    /** A move or resize is done: a tiled member drops into its nearest tile; anything else keeps its spot. */
    _settle(d) {
        if (d.kind === 'press' && this.wall.groups.tiles(d.id)) this.wall.groups.dropMember(d.id);
        else if (this.wall.groups.tiles(d.id)) this.wall.groups.relayoutOf(d.id);
        else this.wall.rememberPosition(d.id);
    }

    /** A lasso was let go: every shown terminal whose window it touches joins the selection. */
    _lassoSelect(points) {
        const poly = points.map((p) => this.camera.toWorld(p.x, p.y));
        const touched = this.wall.shownOrder().filter((id) => lassoTouches(poly, this.wall.windowRect(id)));
        if (touched.length) this.wall.run(['wall.select.add', ...touched]);
    }

    _onDouble(e) {
        if (e.shiftKey) return;   // ⇧-clicks are selection
        const hit = this.wall.hit(this.camera.toWorld(e.clientX, e.clientY));
        if (hit?.group) this.wall.run(['wall.group.frame', hit.group]);
        else if (hit && hit.part !== 'edge') this.wall.focus(hit.id, { frame: true });
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
        this.canvas.style.cursor = !hit ? (e.shiftKey ? 'crosshair' : 'grab')
            : hit.group ? 'move'
            : e.shiftKey ? 'copy'
            : e.altKey || hit.part === 'title' ? 'move'
            : hit.part === 'edge' ? edgeCursor(hit.edges) : 'text';
    }
}
