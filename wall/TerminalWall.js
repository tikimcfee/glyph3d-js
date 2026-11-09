import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
import TerminalGrid from '@glyph3d/core/collections/TerminalGrid.js';
import SceneTransforms from '@glyph3d/core/collections/SceneTransforms.js';
import PanelBatch from '@glyph3d/core/collections/PanelBatch.js';
import GlyphBatch from '@glyph3d/core/collections/GlyphBatch.js';
import GlyphFarLod from '@glyph3d/core/collections/GlyphFarLod.js';
import { BORDER_FLAGS } from '@glyph3d/core/collections/panelMaterial.js';
import registerTerminalCommands from '../app/commands/handlers/terminalCommands.js';
import WallCamera from './WallCamera.js';
import WallStore from './WallStore.js';
import WallNames from './WallNames.js';
import WallPointer from './WallPointer.js';
import WallKeys from './WallKeys.js';
import { freeFlowSlot, unionRect, edgesAt, cycle } from './wallLayout.js';

/** Border band width a pointer can grab, in CSS px (converted to world units per zoom). */
const EDGE_GRAB_PX = 7;
/** Framing a terminal never magnifies its rows past this line height (CSS px): fit, but capped. */
const FRAME_MAX_LINE_PX = 28;
const BORDER_STYLE = { color: 0x3b4352, width: 1.5, intensity: 1 };

/**
 * A terminal's world rect, from its own pose — position + local bounds × scale. Wall terminals sit
 * directly under the scene, unrotated, so this is exact at any moment. It deliberately does NOT
 * read matrixWorld (getBounds): SceneTransforms refreshes world matrices lazily at render, so a
 * burst of terminals placed between two renders would all read stale origins — that stacked
 * re-adopted terminals 4-deep on one slot (4× glyph overdraw when framed: 116 ms GPU frames).
 * @param {TerminalGrid} grid
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

/** A shell title, shortened for naming: drop the `user@host:` prefix prompts put in front. */
function shortTitle(title) {
    return (title || '').replace(/^[^@\s]+@[^:\s]+:/, '').trim();
}

/**
 * TerminalWall — an infinite 2D canvas of terminals: the composition root.
 *
 *   relay        one CommandRouter carrying the core terminal verbs (the IDE's own handlers —
 *                terminal.create/resize/kill/… arrive from the relay's adapters and run here) and
 *                one WebSocketBridge (this page is the relay's DISPLAY)
 *   scene        the renderer's systems, as the IDE installs them (SceneTransforms, PanelBatch,
 *                GlyphBatch, GlyphFarLod)
 *   terminals    arrival order, focus, hover, placement, names (WallStore persists positions + names)
 *   parts        WallCamera (the ortho camera + every mapping through it), WallNames (title bars +
 *                map labels), WallPointer (gestures), WallKeys (keyboard)
 *
 * DOM chrome subscribes with onChange() and calls the public methods.
 */
export default class TerminalWall {
    /**
     * @param {{ scene: import('three').Scene, camera: import('three').OrthographicCamera, gl: any,
     *           atlas: any, registry: any, relayPort: number }} deps
     */
    constructor({ scene, camera, gl, atlas, registry, relayPort }) {
        /** Terminal ids in arrival order — the order cycling walks. @type {string[]} */
        this.order = [];
        /** @type {string|null} */
        this.focusedId = null;
        /** @type {string|null} */
        this.hoveredId = null;
        this._listeners = new Set();
        this.store = new WallStore();
        this.viewport = new WallCamera(camera, gl.domElement);

        // Scene systems, in the IDE CommandProvider's order: world matrices recomputed only where
        // something moved (the batches read its marks, so it goes first); panels draw as batched
        // instances, labels as one glyph field, a field too small to read as one backdrop quad.
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

        this.bridge = new WebSocketBridge(this.router, {
            url: `ws://${location.hostname}:${relayPort}`, port: relayPort, autoConnect: false, showStatus: false,
        });
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
        this.pointer = new WallPointer(this, this.viewport);
        this.keys = new WallKeys(this);
        this.names = new WallNames({
            atlas: this.ctx.atlas, host: this.viewport.canvas.parentElement, camera: this.viewport,
            onLabelPress: (id, e) => this.pointer.pressLabel(id, e),
        });
        for (const [id, grid] of this.ctx.terminals) this.names.attach(id, grid);
        this.pointer.install();
        this.keys.install();
        this.bridge.connect();
    }

    stop() {
        this.pointer.uninstall();
        this.keys.uninstall();
        this.ctx.registry.removeChangeListener(this._onRegistry);
        this.bridge.disconnect();
        this.names.dispose();
        this.farLod.dispose();
        this.glyphBatch.dispose();        // its scene hook chains after the panel batch's: unhook it first
        this.panelBatch.dispose();
        this.sceneTransforms.dispose();   // hands scene.updateMatrixWorld back to three
    }

    /** Per frame: track the viewport, ease the camera, lay out names, far-LOD. */
    tick(dt, size) {
        this.viewport.setView(size.width, size.height);
        this.viewport.step(dt);
        this.names?.update({
            order: this.order, terminals: this.ctx.terminals, focusedId: this.focusedId, hoveredId: this.hoveredId,
            nameOf: (id) => this.nameOf(id), windowRect: (id) => this.windowRect(id),
        });
        this.farLod.update(this.viewport.camera, size.height);
    }

    /** Subscribe to state changes (connection, terminal set, focus, names). Returns an unsubscribe. */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    _emit() { for (const fn of this._listeners) { try { fn(); } catch (e) { console.error('[wall] listener threw:', e); } } }

    // ── terminals ───────────────────────────────────────────────────────────

    /** @param {string} id @returns {TerminalGrid|undefined} */
    terminal(id) { return this.ctx.terminals.get(id); }

    /** A terminal's world rect (the grid alone). */
    terminalRect(id) { return rectOf(this.ctx.terminals.get(id)); }

    /** A terminal's rect plus its title bar at `zoom` — what the person sees as the window. */
    windowRect(id, zoom = this.viewport.zoom) {
        const r = this.terminalRect(id);
        const bar = this.names ? this.names.barHeight(id, zoom) : 0;
        return { ...r, maxY: r.maxY + bar };
    }

    /**
     * What's under a world point: a border grab (of the whole window — bar included, so the top
     * edge is the bar's top) beats the rest; then the title bar, then the body. The focused
     * terminal is on top. @returns {{ id: string, part: 'edge'|'title'|'body', edges?: object }|null}
     */
    hit(p) {
        const tol = EDGE_GRAB_PX / this.viewport.zoom;
        const ids = this.focusedId ? [this.focusedId, ...[...this.order].reverse().filter((i) => i !== this.focusedId)] : [...this.order].reverse();
        for (const id of ids) {
            const edges = edgesAt(this.windowRect(id), p.x, p.y, tol);
            if (edges) return { id, part: 'edge', edges };
        }
        for (const id of ids) {
            const w = this.windowRect(id);
            if (p.x < w.minX || p.x > w.maxX || p.y < w.minY || p.y > w.maxY) continue;
            return { id, part: p.y > this.terminalRect(id).maxY ? 'title' : 'body' };
        }
        return null;
    }

    /** Light the hovered terminal's border. */
    setHovered(id) {
        if (id === this.hoveredId) return;
        this.ctx.terminals.get(this.hoveredId)?.setBorderFlag(BORDER_FLAGS.HOVERED, false);
        this.ctx.terminals.get(id)?.setBorderFlag(BORDER_FLAGS.HOVERED, true);
        this.hoveredId = id;
    }

    /** Persist a terminal's current position (after a move or an anchored resize). */
    rememberPosition(id) {
        const grid = this.ctx.terminals.get(id);
        if (grid) this.store.setPosition(id, grid.position);
    }

    /** A terminal's name: the one the person gave it, else its shell's title, else its id. */
    nameOf(id) {
        return this.store.name(id) || shortTitle(this.ctx.terminals.get(id)?.windowTitle) || id;
    }

    /** Name a terminal; an empty name clears it back to the shell's title. */
    rename(id, name) {
        if (!this.ctx.terminals.has(id)) return false;
        this.store.setName(id, name);
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
                return { id, name: this.nameOf(id), named: !!this.store.name(id), cols: g?.cols ?? 0, rows: g?.rows ?? 0, preview };
            }),
        };
    }

    // ── focus + framing ─────────────────────────────────────────────────────

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
        if (this.ctx.terminals.has(id)) this.viewport.easeTo(this.frameTarget(id));
    }

    /** The pose that frames one terminal + its bar: fit to the view, capped at FRAME_MAX_LINE_PX rows.
     *  Fit once for the zoom, then again with the bar's height at that zoom (the bar is screen-sized). */
    frameTarget(id) {
        const cap = FRAME_MAX_LINE_PX / this.ctx.terminals.get(id).cellStride.y;
        const first = this.viewport.fitTarget(this.terminalRect(id), 0.94, cap);
        return this.viewport.fitTarget(this.windowRect(id, first.zoom), 0.94, cap);
    }

    /** Ease the camera to fit every terminal (bars included). */
    fitAll() {
        const all = unionRect(this.order.map((id) => this.terminalRect(id)));
        if (!all) return;
        const first = this.viewport.fitTarget(all, 0.9);
        this.viewport.easeTo(this.viewport.fitTarget(unionRect(this.order.map((id) => this.windowRect(id, first.zoom))), 0.9));
    }

    /** Toggle between framing the focused terminal and fitting everything. */
    toggleFrame() {
        if (!this.focusedId) { this.fitAll(); return; }
        const target = this.frameTarget(this.focusedId);
        if (this.viewport.isAt(target)) this.fitAll(); else this.viewport.easeTo(target);
    }

    // ── relay-side lifecycle ────────────────────────────────────────────────

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
            this.names?.attach(id, grid);
            changed = true;
        }
        this.names?.prune((id) => live.has(id));
        const before = this.order.length;
        this.order = this.order.filter((id) => live.has(id));
        if (this.order.length !== before) changed = true;
        if (this.focusedId && !live.has(this.focusedId)) { this.focusedId = null; changed = true; }
        if (this.hoveredId && !live.has(this.hoveredId)) this.hoveredId = null;
        if (changed) this._emit();
    }

    /** Land a new grid at its remembered spot, else the first free flow slot. */
    _place(grid) {
        const saved = this.store.position(grid.terminalId);
        if (saved) { grid.position.set(saved.x, saved.y, 0); return; }
        grid.position.set(0, 0, 0);
        const r = rectOf(grid);
        // Offset from the grid's origin to its bounds' top-left, so the slot math works on rects.
        const offX = -r.minX, offY = -r.maxY;
        const taken = [];
        for (const g of this.ctx.terminals.values()) if (g !== grid) taken.push(rectOf(g));
        const slot = freeFlowSlot(r.maxX - r.minX, r.maxY - r.minY, taken);
        grid.position.set(slot.x + offX, slot.y + offY, 0);
        if (grid.terminalId) this.store.setPosition(grid.terminalId, grid.position);
    }
}
