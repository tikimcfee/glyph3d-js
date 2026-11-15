import { terminalWheelLines } from '@glyph3d/core/services/terminal/terminalCommands.js';
import { edgeCursor, resizeFromDrag, lassoTouches, unionRect } from './wallLayout.js';
import { snapStep, snapMove, snapResize, snapTo } from './wallSnap.js';
import { invertsSnap, zoomsWheel, IS_MAC } from './chord.js';

/** Pointer travel (CSS px) before a press becomes a drag instead of a click. */
const DRAG_SLOP_PX = 4;
/** A lasso takes a new point once the pointer is this far (CSS px) from its last one. */
const LASSO_STEP_PX = 3;
/** Smallest terminal a border drag can make. */
const MIN_SIZE = { minCols: 20, minRows: 5 };
/** A wheel event in lines (deltaMode 1) moves this many CSS px. */
const LINE_PX = 16;
/** A zoom wheel's delta (zoomsWheel) under this (CSS px) is a trackpad pinch, followed directly; at or over it, a mouse notch. */
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
 * Moves, resizes and group drags snap to the drafting grid while the `snap` knob is on (wallSnap.js
 * has the rule: a moved body's top-left lands on a crossing, a dragged edge on or just inside a
 * line); Ctrl (⌃) held while dragging inverts it, read as the drag goes — pressing or letting go of
 * it mid-drag re-places what's held. A tiled member's spot is its tile's: its drag and resize
 * don't snap (the group's header drag does, by the group's corner).
 *
 * A right-click (or, on macOS, a Ctrl+click — which is why ⌃ inverts snapping only once a drag is
 * under way there) is the menu's (WallMenu), never a gesture.
 *
 * A group's backdrop is canvas (it pans and lassoes). A title bar's hide / close buttons and the
 * selection's group button are DOM over the canvas and never reach here.
 *
 * Wheel, a canvas's convention: a plain wheel or two-finger swipe PANS, both axes, the content
 * moving as a scrolled page's would — except over the FOCUSED terminal, where it drives that
 * terminal's scrollback. With a zoom modifier (chord.js zoomsWheel, the `zoomKeys` knob) it
 * ZOOMS the canvas about the pointer, over a terminal or not: a small delta (a trackpad pinch, which
 * the browser sends as Ctrl+wheel) zooms directly with the fingers, a mouse notch glides in eased
 * steps (WallCamera.wheelZoomAt). The browser never page-zooms or scrolls.
 * Double-click a terminal: focus + frame; a group's header: frame the group; empty canvas: fit all.
 * Hover lights the border and sets the cursor (⌥ shows move).
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
            key: (e) => {
                if ((e.key === 'Alt' || e.key === 'Shift') && !this._drag && this._last) this._hover({ ...this._last, altKey: e.altKey, shiftKey: e.shiftKey });
                this._snapKey(e);
            },
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
        if (IS_MAC && e.ctrlKey && e.button === 0) return;   // macOS: Ctrl+click is the secondary click (the menu's)
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
            if (d.moved) { const s = this._snapGroup(d, dx, dy, e); this.wall.groups.dragTo(d.groupDrag, s.x, s.y); }
            return;
        }
        const grid = this.wall.terminal(d.id);
        if (!grid) { this._end(); return; }   // its terminal went away mid-drag
        if (d.kind === 'press' && d.moved) {
            const s = this._snapPress(d, dx, dy, e);
            grid.position.x = d.startPos.x + dx + s.x;
            grid.position.y = d.startPos.y + dy + s.y;
        } else if (d.kind === 'resize') {
            const step = this._snapStep(d, e);
            d.startRect ??= this.wall.terminalRect(d.id);   // first move: nothing has resized yet
            if (step && !d.moved) return;   // a snapped edge jumps to its line: not for a click's wobble
            const r = step ? snapResize(d.edges, d.startRect, d.start, d.stride, dx, dy, MIN_SIZE, step)
                : resizeFromDrag(d.edges, d.start, d.stride, dx, dy, MIN_SIZE);
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
        // The deltas before deltaMode: Firefox reports lines only to a listener that reads the mode first.
        const rawX = e.deltaX, rawY = e.deltaY;
        const zoom = zoomsWheel(e, this.wall.config.zoomKeys);
        const focused = this.wall.focusedId;
        if (!zoom && focused) {
            const r = this.wall.terminalRect(focused);
            const p = this.camera.toWorld(e.clientX, e.clientY);
            if (p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY) {
                this.wall.router.execute(['terminal.scroll', focused, String(terminalWheelLines(rawY))]);
                return;
            }
        }
        const px = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.camera.view.h : 1;
        const dx = rawX * px, dy = rawY * px;
        // panBy takes a screen delta and moves the camera by it: + deltaY (scroll down) shows what's
        // below, so the content rises, as a page's does; + deltaX shows what's to the right.
        if (!zoom) { this.camera.panBy(dx, dy); return; }
        if (!dy) return;
        if (Math.abs(dy) < PINCH_MAX_DELTA) this.camera.zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
        else this.camera.wheelZoomAt(e.clientX, e.clientY, dy);
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

    // ── snapping ──────────────────────────────────────────────────────────────

    /**
     * The grid step this drag snaps to now, or 0 when it doesn't: the `snap` knob, inverted while the
     * snap modifier is held; never for a tiled member (its spot is its tile's).
     * @param {{ kind: string, id?: string }} d @param {{ ctrlKey: boolean }} e
     */
    _snapStep(d, e) {
        if (this.wall.config.snap === invertsSnap(e)) return 0;
        if (d.id && this.wall.groups.tiles(d.id)) return 0;
        return snapStep(this.wall.config, this.camera.zoom);
    }

    /** The extra shift that puts a moved body's top-left on the grid ({0, 0} when not snapping). */
    _snapPress(d, dx, dy, e) {
        d.startRect ??= this.wall.terminalRect(d.id);   // first move: the terminal is still where it started
        const step = this._snapStep(d, e);
        if (!step) return { x: 0, y: 0 };
        const r = d.startRect;
        return snapMove({ minX: r.minX + dx, maxX: r.maxX + dx, minY: r.minY + dy, maxY: r.maxY + dy }, step);
    }

    /** A group drag's delta, snapped so the group's top-left body corner (its shown members') lands on the grid. */
    _snapGroup(d, dx, dy, e) {
        if (d.groupCorner === undefined) {   // first move: the members are still where they started
            const u = unionRect(this.wall.groups.shownMembers(d.group).map((id) => this.wall.terminalRect(id)));
            d.groupCorner = u ? { x: u.minX, y: u.maxY } : null;
        }
        const step = this._snapStep(d, e), c = d.groupCorner;
        return step && c ? { x: snapTo(c.x + dx, step) - c.x, y: snapTo(c.y + dy, step) - c.y } : { x: dx, y: dy };
    }

    /** The snap modifier went down or up mid-drag: re-place what's held as if the pointer moved. */
    _snapKey(e) {
        const d = this._drag;
        if (e.key !== 'Control' || !d || !this._last || !(d.kind === 'press' || d.kind === 'resize' || d.kind === 'group')) return;
        this._onMove(/** @type {PointerEvent} */ ({ ...this._last, ctrlKey: e.ctrlKey }));
    }
}
