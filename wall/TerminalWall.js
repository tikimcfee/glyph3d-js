import * as THREE from 'three';
import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
import TerminalGrid from '@glyph3d/core/collections/TerminalGrid.js';
import SceneTransforms from '@glyph3d/core/collections/SceneTransforms.js';
import PanelBatch from '@glyph3d/core/collections/PanelBatch.js';
import GlyphBatch from '@glyph3d/core/collections/GlyphBatch.js';
import GlyphFarLod from '@glyph3d/core/collections/GlyphFarLod.js';
import { BORDER_FLAGS } from '@glyph3d/core/collections/panelMaterial.js';
import { keyToTerminalBytes } from '@glyph3d/core/services/interaction/keyEncoding.js';
import registerTerminalCommands from '../app/commands/handlers/terminalCommands.js';
import { wheelScrollCommand } from '../app/client/surfaceInteractions.js';
import TitleBar from './TitleBar.js';
import {
    freeFlowSlot, fitRect, unionRect, edgesAt, edgeCursor, cycle, resizeFromDrag, FLOW_GAP,
} from './wallLayout.js';

/** Border band width a pointer can grab, in CSS px (converted to world units per zoom). */
const EDGE_GRAB_PX = 7;
/** Pointer travel (CSS px) before a press on a terminal becomes a move instead of a click. */
const DRAG_SLOP_PX = 4;
/** Smallest terminal a border drag can make. */
const MIN_SIZE = { minCols: 20, minRows: 5 };
/** Camera ease rate (1/s) for framing animations. */
const EASE_RATE = 14;
/** Framing a terminal never magnifies its rows past this line height (CSS px): fit, but capped. */
const FRAME_MAX_LINE_PX = 28;
/** Zoom clamp, CSS px per world unit. Plain floats are ample at this range. */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 200;
/** localStorage keys — the wall's durable per-browser state: where each terminal sits, and the
 *  names the person gave them. Both keyed by terminal id. */
const POSITIONS_KEY = 'glyph3d.wall.positions';
const NAMES_KEY = 'glyph3d.wall.names';
const BORDER_STYLE = { color: 0x3b4352, width: 1.5, intensity: 1 };

/**
 * A terminal's world rect, from its own pose — position + local bounds × scale. Wall terminals sit
 * directly under the scene, unrotated, so this is exact at any moment. It deliberately does NOT
 * read matrixWorld (getBounds): SceneTransforms refreshes world matrices lazily at render, so a
 * burst of terminals placed between two renders would all read stale origins — that stacked
 * re-adopted terminals 4-deep on one slot (4× glyph overdraw when framed: 116 ms GPU frames).
 * @param {import('@glyph3d/core/collections/TerminalGrid.js').default} grid
 * @returns {import('./wallLayout.js').Rect}
 */
function rectOf(grid) {
    if (grid.parent && !grid.parent.isScene) {
        throw new Error(`[wall] terminal ${grid.terminalId} is parented under ${grid.parent.type}, not the scene — its rect needs the full world transform`);
    }
    const lb = grid.getLocalBounds();
    const p = grid.position, s = grid.scale;
    return {
        minX: p.x + lb.min.x * s.x, maxX: p.x + lb.max.x * s.x,
        minY: p.y + lb.min.y * s.y, maxY: p.y + lb.max.y * s.y,
    };
}

function readStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch { return {}; }
}
function writeStore(key, map) {
    try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* storage blocked: it just won't persist */ }
}

/** A shell title, shortened for naming: drop the `user@host:` prefix prompts put in front. */
function shortTitle(title) {
    return (title || '').replace(/^[^@\s]+@[^:\s]+:/, '').trim();
}

/**
 * TerminalWall — the whole wall app minus its DOM chrome: an infinite 2D canvas of terminals.
 *
 * It owns one CommandRouter carrying the core terminal verbs (the same handlers the IDE uses —
 * terminal.create/resize/kill/… arrive from the relay's adapters and run here), one WebSocketBridge
 * to the relay (this page registers as its DISPLAY), the orthographic camera's pan/zoom, pointer
 * interaction (pan, move, border-resize, click-to-focus), and the keyboard (typing into the focused
 * terminal, cycling, framing). DOM chrome subscribes via onChange() and calls the public methods.
 */
export default class TerminalWall {
    /**
     * @param {{ scene: THREE.Scene, camera: THREE.OrthographicCamera, gl: any, atlas: any,
     *           registry: any, relayPort: number }} deps
     */
    constructor({ scene, camera, gl, atlas, registry, relayPort }) {
        if (!camera.isOrthographicCamera) {
            throw new Error('[wall] TerminalWall needs an orthographic camera (GlyphCanvas orthographic)');
        }
        this.camera = camera;
        this.canvas = gl.domElement;
        /** Terminal ids in arrival order — the order cycling walks. @type {string[]} */
        this.order = [];
        /** @type {string|null} */
        this.focusedId = null;
        this.hoveredId = null;
        this._listeners = new Set();
        /** Each terminal's title bar, by id. @type {Map<string, TitleBar>} */
        this._bars = new Map();
        this._positions = readStore(POSITIONS_KEY);
        this._names = readStore(NAMES_KEY);
        this._anim = null;      // { x, y, zoom } camera target while easing
        this._drag = null;      // active pointer gesture
        this._view = { w: 1, h: 1 };

        // The renderer's scene systems, in the IDE CommandProvider's order: world matrices
        // recomputed only where something moved (the batches read its marks, so it goes first);
        // panels — terminal backgrounds + borders — draw as batched instances, labels as one glyph
        // field, and a field too small to read draws as one backdrop quad (far-LOD, ticked per frame).
        this.sceneTransforms = new SceneTransforms(scene);
        this.panelBatch = new PanelBatch(scene);
        this.glyphBatch = new GlyphBatch(scene, atlas);
        this.farLod = new GlyphFarLod(scene);

        this.ctx = {
            scene, atlas, registry, camera, renderer: gl,
            terminals: new Map(),
            wsbridge: null,
            // terminal.create lands each new grid "in view" through this hook; the wall's answer
            // is its remembered spot, else the first free flow slot.
            cameraController: { placeInView: (grid) => this._place(grid) },
        };
        this.router = new CommandRouter(this.ctx);
        registerTerminalCommands(this.router);

        const url = `ws://${location.hostname}:${relayPort}`;
        this.bridge = new WebSocketBridge(this.router, { url, port: relayPort, autoConnect: false, showStatus: false });
        this.ctx.wsbridge = this.bridge;
        // Terminal OUTPUT: raw VT bytes tagged with the size tmux drew them at. Align the grid to
        // that size BEFORE parsing (size and redraw travel one ordered channel — see attach_unix.go).
        this.bridge.onBinaryFrame(1, (id, bytes, cols, rows) => {
            const grid = this.ctx.terminals.get(id);
            if (!grid) return;
            if (cols > 0 && rows > 0 && (grid.cols !== cols || grid.rows !== rows)) grid.resize(cols, rows);
            grid.writeBytes(bytes);
        });
        this.bridge.onConnectionChange((up) => {
            // Re-adopt glyphd sessions whose adapters died with a relay restart.
            if (up) this.bridge.send(JSON.stringify({ relay: 'terminal.recover' }));
            this._emit();
        });

        this._onRegistry = () => this._syncTerminals();
        registry.addChangeListener(this._onRegistry);
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    start() {
        const c = this.canvas;
        this._handlers = {
            wheel: (e) => this._onWheel(e),
            pointerdown: (e) => this._onPointerDown(e),
            pointermove: (e) => this._onPointerMove(e),
            pointerup: (e) => this._onPointerUp(e),
            dblclick: (e) => this._onDoubleClick(e),
            keydown: (e) => this._onKeyDown(e),
            paste: (e) => this._onPaste(e),
        };
        c.addEventListener('wheel', this._handlers.wheel, { passive: false });
        c.addEventListener('pointerdown', this._handlers.pointerdown);
        c.addEventListener('dblclick', this._handlers.dblclick);
        window.addEventListener('pointermove', this._handlers.pointermove);
        window.addEventListener('pointerup', this._handlers.pointerup);
        window.addEventListener('keydown', this._handlers.keydown, true);
        document.addEventListener('paste', this._handlers.paste);
        this.bridge.connect();
    }

    stop() {
        const c = this.canvas;
        c.removeEventListener('wheel', this._handlers.wheel);
        c.removeEventListener('pointerdown', this._handlers.pointerdown);
        c.removeEventListener('dblclick', this._handlers.dblclick);
        window.removeEventListener('pointermove', this._handlers.pointermove);
        window.removeEventListener('pointerup', this._handlers.pointerup);
        window.removeEventListener('keydown', this._handlers.keydown, true);
        document.removeEventListener('paste', this._handlers.paste);
        this.ctx.registry.removeChangeListener(this._onRegistry);
        this.bridge.disconnect();
        this.farLod.dispose();
        this.glyphBatch.dispose();   // its scene hook chains after the panel batch's: unhook it first
        this.panelBatch.dispose();
        this.sceneTransforms.dispose();   // hands scene.updateMatrixWorld back to three
    }

    /** Per frame: track the viewport and ease the camera toward a framing target. */
    tick(dt, size) {
        this._view.w = size.width;
        this._view.h = size.height;
        this._stepCamera(dt);
        this._layoutBars();
        this.farLod.update(this.camera, size.height);
    }

    /** Keep every title bar on its terminal's top edge, named, at this frame's zoom (cheap when
     *  nothing changed — each bar skips a layout whose inputs it already applied). */
    _layoutBars() {
        const zoom = this.camera.zoom;
        for (const [id, bar] of this._bars) {
            const grid = this.ctx.terminals.get(id);
            if (!grid) continue;
            bar.setName(this.nameOf(id));
            bar.setFocused(id === this.focusedId);
            bar.layout(grid, zoom);
        }
    }

    /** A terminal's rect plus its title bar at `zoom` — what the person sees as the window. */
    _windowRect(id, zoom = this.camera.zoom) {
        const r = rectOf(this.ctx.terminals.get(id));
        const bar = this._bars.get(id);
        return bar ? { ...r, maxY: r.maxY + bar.worldHeight(zoom) } : r;
    }

    /** Ease the camera toward the framing target, if one is set. */
    _stepCamera(dt) {
        const a = this._anim;
        if (!a) return;
        const cam = this.camera;
        const k = 1 - Math.exp(-dt * EASE_RATE);
        cam.position.x += (a.x - cam.position.x) * k;
        cam.position.y += (a.y - cam.position.y) * k;
        cam.zoom = Math.exp(Math.log(cam.zoom) + (Math.log(a.zoom) - Math.log(cam.zoom)) * k);
        cam.updateProjectionMatrix();
        const px = Math.hypot(a.x - cam.position.x, a.y - cam.position.y) * cam.zoom;
        if (px < 0.5 && Math.abs(a.zoom / cam.zoom - 1) < 1e-3) {
            cam.position.x = a.x; cam.position.y = a.y; cam.zoom = a.zoom;
            cam.updateProjectionMatrix();
            this._anim = null;
        }
    }

    // ── public API (DOM chrome + palette) ───────────────────────────────────

    /** Subscribe to state changes (connection, terminal set, focus). Returns an unsubscribe. */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    /**
     * A terminal's name: the one the person gave it, else its shell's title, else its id.
     * @param {string} id @returns {string}
     */
    nameOf(id) {
        return this._names[id] || shortTitle(this.ctx.terminals.get(id)?.windowTitle) || id;
    }

    /** Name a terminal; an empty name clears it back to the shell's title. */
    rename(id, name) {
        if (!this.ctx.terminals.has(id)) return false;
        const n = (name || '').trim();
        if (n) this._names[id] = n; else delete this._names[id];
        writeStore(NAMES_KEY, this._names);
        this._emit();
        return true;
    }

    /** @returns {{ connected: boolean, focusedId: string|null, terminals: {id:string, name:string, named:boolean, cols:number, rows:number, preview:string}[] }} */
    snapshot() {
        return {
            connected: !!this.bridge.connected,
            focusedId: this.focusedId,
            terminals: this.order.map((id) => {
                const g = this.ctx.terminals.get(id);
                const lines = g?.readText?.() ?? [];
                let preview = '';
                for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { preview = lines[i].trim(); break; } }
                return { id, name: this.nameOf(id), named: !!this._names[id], cols: g?.cols ?? 0, rows: g?.rows ?? 0, preview };
            }),
        };
    }

    /** Focus a terminal (keys go to it). `frame` also eases the camera to fit it. */
    focus(id, { frame = false } = {}) {
        if (id != null && !this.ctx.terminals.has(id)) return false;
        const prev = this.focusedId ? this.ctx.terminals.get(this.focusedId) : null;
        if (prev && this.focusedId !== id) {
            prev.setBorderFlag(BORDER_FLAGS.FOCUSED, false);
            prev.setCursorFocused?.(false);
            prev.position.z = 0;
        }
        this.focusedId = id;
        const grid = id ? this.ctx.terminals.get(id) : null;
        if (grid) {
            grid.setBorderFlag(BORDER_FLAGS.FOCUSED, true);
            grid.setCursorFocused?.(true);
            grid.position.z = 1;   // the focused terminal draws over any it overlaps
            if (frame) this.frame(id);
        }
        this._emit();
        return true;
    }

    /** Cycle focus through the terminals in arrival order, framing the one it lands on. */
    cycleFocus(dir) {
        const next = cycle(this.order, this.focusedId, dir);
        if (next) this.focus(next, { frame: true });
    }

    /** Ease the camera to fit one terminal. */
    frame(id) {
        const grid = this.ctx.terminals.get(id);
        if (!grid) return;
        this._anim = this._frameTarget(grid);
    }

    /** The camera pose that frames one terminal: fit to the view, capped at FRAME_MAX_LINE_PX rows. */
    _frameTarget(grid) {
        const cap = FRAME_MAX_LINE_PX / grid.cellStride.y;
        const first = fitRect(rectOf(grid), this._view.w, this._view.h, 0.94, cap);
        return fitRect(this._windowRect(grid.terminalId, first.zoom), this._view.w, this._view.h, 0.94, cap);
    }

    /** Ease the camera to fit every terminal. */
    fitAll() {
        const all = unionRect(this.order.map((id) => rectOf(this.ctx.terminals.get(id))));
        if (!all) return;
        const first = fitRect(all, this._view.w, this._view.h, 0.9);
        this._anim = fitRect(unionRect(this.order.map((id) => this._windowRect(id, first.zoom))), this._view.w, this._view.h, 0.9);
    }

    /** Toggle between framing the focused terminal and fitting everything. */
    toggleFrame() {
        if (!this.focusedId) { this.fitAll(); return; }
        const grid = this.ctx.terminals.get(this.focusedId);
        const target = this._frameTarget(grid);
        const framed = Math.abs(this.camera.zoom / target.zoom - 1) < 0.02
            && Math.hypot(this.camera.position.x - target.x, this.camera.position.y - target.y) * this.camera.zoom < 4;
        if (framed) this.fitAll(); else this._anim = target;
    }

    /**
     * Ask the relay to fork a new terminal, then focus + frame it once it lands. The spawn ack
     * carries the new id; the grid arrives when its adapter connects and runs terminal.create.
     */
    async spawn() {
        if (!this.bridge.connected) return { ok: false, reason: 'not connected to the relay' };
        const ack = this.bridge.waitForEvent('terminal.spawning', 5000);
        this.bridge.send(JSON.stringify({ relay: 'terminal.spawn' }));
        const id = (await ack)?.id;
        if (!id) return { ok: false, reason: 'no spawn ack from the relay' };
        const arrived = await new Promise((resolve) => {
            if (this.ctx.terminals.has(id)) { resolve(true); return; }
            const off = this.onChange(() => { if (this.ctx.terminals.has(id)) { off(); clearTimeout(t); resolve(true); } });
            const t = setTimeout(() => { off(); resolve(false); }, 15000);
        });
        if (arrived) this.focus(id, { frame: true });
        return { ok: arrived, id };
    }

    /** Fully close a terminal (its shell and tmux session too). */
    kill(id) { return this.router.execute(['terminal.kill', id]); }

    // ── terminals arriving / leaving ────────────────────────────────────────

    _syncTerminals() {
        const live = this.ctx.terminals;
        let changed = false;
        for (const [id, grid] of live) {
            if (this.order.includes(id)) continue;
            this.order.push(id);
            grid.setBorder(BORDER_STYLE);
            grid.setBorderFlag(BORDER_FLAGS.EDGE, true);   // the always-visible frame
            for (const { role } of TerminalGrid.CONTROL_SPEC) grid.setControlVisible(role, false);
            grid.onResize(() => this._emit());
            grid.onWindowTitle(() => this._emit());
            const bar = new TitleBar({ atlas: this.ctx.atlas, maxWorldHeight: FLOW_GAP * 0.8 });
            grid.add(bar);
            this._bars.set(id, bar);
            changed = true;
        }
        for (const [id, bar] of this._bars) {
            if (!live.has(id)) { bar.dispose(); this._bars.delete(id); }
        }
        const before = this.order.length;
        this.order = this.order.filter((id) => live.has(id));
        if (this.order.length !== before) changed = true;
        if (this.focusedId && !live.has(this.focusedId)) { this.focusedId = null; changed = true; }
        if (changed) this._emit();
    }

    /** Land a new grid at its remembered spot, else the first free flow slot. */
    _place(grid) {
        const saved = this._positions[grid.terminalId];
        if (saved) { grid.position.set(saved.x, saved.y, 0); return; }
        grid.position.set(0, 0, 0);
        const r = rectOf(grid);
        // Offset from the grid's origin to its bounds' top-left, so the slot math works on rects.
        const offX = -r.minX, offY = -r.maxY;
        const taken = [];
        for (const g of this.ctx.terminals.values()) if (g !== grid) taken.push(rectOf(g));
        const slot = freeFlowSlot(r.maxX - r.minX, r.maxY - r.minY, taken);
        grid.position.set(slot.x + offX, slot.y + offY, 0);
        this._remember(grid);
    }

    _remember(grid) {
        if (!grid.terminalId) return;
        this._positions[grid.terminalId] = { x: grid.position.x, y: grid.position.y };
        writeStore(POSITIONS_KEY, this._positions);
    }

    _emit() { for (const fn of this._listeners) { try { fn(); } catch (e) { console.error('[wall] listener threw:', e); } } }

    // ── pointer ─────────────────────────────────────────────────────────────

    _toWorld(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const cam = this.camera;
        return {
            x: cam.position.x + (clientX - rect.left - rect.width / 2) / cam.zoom,
            y: cam.position.y - (clientY - rect.top - rect.height / 2) / cam.zoom,
        };
    }

    /**
     * What's under a world point: a border grab (of the whole window — bar included, so the top
     * edge is the bar's top) beats the rest; then the title bar, then the body. The focused
     * terminal is on top. @returns {{ id: string, part: 'edge'|'title'|'body', edges?: object }|null}
     */
    _hit(p) {
        const tol = EDGE_GRAB_PX / this.camera.zoom;
        const ids = this.focusedId ? [this.focusedId, ...[...this.order].reverse().filter((i) => i !== this.focusedId)] : [...this.order].reverse();
        for (const id of ids) {
            const edges = edgesAt(this._windowRect(id), p.x, p.y, tol);
            if (edges) return { id, part: 'edge', edges };
        }
        for (const id of ids) {
            const w = this._windowRect(id);
            if (p.x < w.minX || p.x > w.maxX || p.y < w.minY || p.y > w.maxY) continue;
            const top = rectOf(this.ctx.terminals.get(id)).maxY;
            return { id, part: p.y > top ? 'title' : 'body' };
        }
        return null;
    }

    _onWheel(e) {
        e.preventDefault();
        // Two-finger scroll over the FOCUSED terminal drives its scrollback (the IDE's own
        // surface record maps the delta to terminal.scroll). Pinch (ctrl+wheel) always zooms the
        // canvas, and anywhere else the wheel pans — an unfocused terminal never eats the wheel.
        if (!e.ctrlKey && this.focusedId) {
            const r = rectOf(this.ctx.terminals.get(this.focusedId));
            const p = this._toWorld(e.clientX, e.clientY);
            if (p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY) {
                const cmd = wheelScrollCommand(this.ctx.registry.get(this.focusedId), e.deltaY);
                if (cmd) { this.router.execute(cmd); return; }
            }
        }
        this._anim = null;
        const cam = this.camera;
        if (e.ctrlKey) {
            // Trackpad pinch arrives as ctrl+wheel: zoom about the pointer, keeping the world point
            // under it fixed.
            const before = this._toWorld(e.clientX, e.clientY);
            cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom * Math.exp(-e.deltaY * 0.01)));
            cam.updateProjectionMatrix();
            const after = this._toWorld(e.clientX, e.clientY);
            cam.position.x += before.x - after.x;
            cam.position.y += before.y - after.y;
        } else {
            // Two-finger scroll pans.
            cam.position.x += e.deltaX / cam.zoom;
            cam.position.y -= e.deltaY / cam.zoom;
        }
    }

    _onPointerDown(e) {
        if (e.button !== 0 && e.button !== 1) return;
        this._anim = null;
        const p = this._toWorld(e.clientX, e.clientY);
        const hit = e.button === 0 ? this._hit(p) : null;
        const base = { startX: e.clientX, startY: e.clientY, startWorld: p, camStart: this.camera.position.clone() };
        if (hit?.part === 'edge') {
            const grid = this.ctx.terminals.get(hit.id);
            this._drag = {
                ...base, kind: 'resize', id: hit.id, edges: hit.edges,
                start: { cols: grid.cols, rows: grid.rows },
                stride: grid.cellStride,
                startPos: grid.position.clone(),
                last: { cols: grid.cols, rows: grid.rows },
            };
            this.focus(hit.id);
        } else if (hit?.part === 'title') {
            // The title bar is the handle: press + drag moves the terminal; a click focuses it.
            const grid = this.ctx.terminals.get(hit.id);
            this._drag = { ...base, kind: 'press', id: hit.id, startPos: grid.position.clone() };
        } else if (hit) {
            // The body only focuses — a press there never drags the window.
            this._drag = { ...base, kind: 'focus', id: hit.id };
        } else {
            this._drag = { ...base, kind: 'pan', moved: false };
        }
        this.canvas.setPointerCapture?.(e.pointerId);
    }

    _onPointerMove(e) {
        const d = this._drag;
        if (!d) { this._updateHover(e); return; }
        const travel = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        const cam = this.camera;
        if (d.kind === 'pan') {
            if (travel > DRAG_SLOP_PX) d.moved = true;
            cam.position.x = d.camStart.x - (e.clientX - d.startX) / cam.zoom;
            cam.position.y = d.camStart.y + (e.clientY - d.startY) / cam.zoom;
            return;
        }
        const p = this._toWorld(e.clientX, e.clientY);
        const dx = p.x - d.startWorld.x;
        const dy = p.y - d.startWorld.y;
        const grid = this.ctx.terminals.get(d.id);
        if (!grid) { this._drag = null; return; }
        if (d.kind === 'press' && travel > DRAG_SLOP_PX) d.kind = 'move';
        if (d.kind === 'move') {
            grid.position.x = d.startPos.x + dx;
            grid.position.y = d.startPos.y + dy;
        } else if (d.kind === 'resize') {
            const r = resizeFromDrag(d.edges, d.start, d.stride, dx, dy, MIN_SIZE);
            if (r.cols !== d.last.cols || r.rows !== d.last.rows) {
                d.last = { cols: r.cols, rows: r.rows };
                this.router.execute(['terminal.resize', d.id, String(r.cols), String(r.rows)]);
            }
            grid.position.x = d.startPos.x + r.shiftX;
            grid.position.y = d.startPos.y + r.shiftY;
        }
    }

    _onPointerUp(e) {
        const d = this._drag;
        if (!d) return;
        this._drag = null;
        this.canvas.releasePointerCapture?.(e.pointerId);
        if (d.kind === 'press' || d.kind === 'focus') this.focus(d.id);
        else if (d.kind === 'pan' && !d.moved) this.focus(null);
        else if (d.kind === 'move' || d.kind === 'resize') {
            const grid = this.ctx.terminals.get(d.id);
            if (grid) this._remember(grid);
        }
    }

    _onDoubleClick(e) {
        const hit = this._hit(this._toWorld(e.clientX, e.clientY));
        if (hit && hit.part !== 'edge') this.focus(hit.id, { frame: true });
        else if (!hit) this.fitAll();
    }

    _updateHover(e) {
        const hit = this._hit(this._toWorld(e.clientX, e.clientY));
        const id = hit?.id ?? null;
        if (id !== this.hoveredId) {
            this.ctx.terminals.get(this.hoveredId)?.setBorderFlag(BORDER_FLAGS.HOVERED, false);
            this.ctx.terminals.get(id)?.setBorderFlag(BORDER_FLAGS.HOVERED, true);
            this.hoveredId = id;
        }
        this.canvas.style.cursor = hit?.part === 'edge' ? edgeCursor(hit.edges)
            : hit?.part === 'title' ? 'move' : hit ? 'text' : 'grab';
    }

    // ── keyboard ────────────────────────────────────────────────────────────

    /**
     * Wall chords are Cmd+<key>, matched on e.code (physical key) so layouts and Option don't
     * rewrite them. Everything else goes to the focused terminal as terminal bytes — including
     * Esc (vim/readline need it); click empty canvas to drop focus.
     */
    _onKeyDown(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.metaKey) {
            const claim = () => { e.preventDefault(); e.stopPropagation(); };
            switch (e.code) {
                case 'BracketRight': claim(); this.cycleFocus(+1); return;
                case 'BracketLeft': claim(); this.cycleFocus(-1); return;
                case 'Enter': claim(); if (e.shiftKey) this.spawn(); else this.toggleFrame(); return;
                case 'Digit0': claim(); this.fitAll(); return;
                default: return;   // Cmd+C/V/K/… stay with the browser and the DOM chrome
            }
        }
        const grid = this.focusedId ? this.ctx.terminals.get(this.focusedId) : null;
        if (!grid) return;
        const bytes = keyToTerminalBytes(e, { captureEscape: true });
        if (bytes == null) return;
        e.preventDefault();
        e.stopPropagation();
        grid.sendInput(bytes);
    }

    _onPaste(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        const grid = this.focusedId ? this.ctx.terminals.get(this.focusedId) : null;
        const text = e.clipboardData?.getData('text/plain');
        if (grid && text) { e.preventDefault(); grid.paste(text); }
    }
}
