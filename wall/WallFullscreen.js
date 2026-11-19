import { dockLayout } from './dockLayout.js';
import { chordLabel } from './chord.js';
import { tileLayout, unionRect, fitRect, BAR_ROOM } from './wallLayout.js';
import { panes, minSize, remove as removePane } from './splitTree.js';

/** The smallest terminal fullscreen makes (a tiny window still gets a usable one). */
const MIN = { cols: 20, rows: 5 };
/** A window or dock change waits this long to settle before the terminal re-wraps to it, ms. */
const REFIT_SETTLE_MS = 150;
/** The text sizes a fullscreen keeps between, CSS px per row. */
const LINE_PX = { min: 4, max: 200 };
/** Opacity of the frosted backing veil around fullscreen panes. */
const BACKDROP_OPACITY = 0.9;
const BACKDROP_BLUR_PX = 8;
const EDGE_EPS = 1e-6;

/**
 * Saved canvas geometry of one terminal while fullscreen re-wraps/moves it.
 * @typedef {{ cols: number, rows: number, x: number, y: number }} SavedCanvasPane
 *
 * Fullscreen state (single terminal or whole group):
 *   - `mode === 'single'`: `id` is the solo terminal (`canvas` = `saved[id]`); `returnGroup` names the
 *     group we zoomed into this single pane from (`⌘⇧↵`), so pressing `⌘⇧↵` again unzooms back to that
 *     group's fullscreen while `⌘↵` exits all the way to the canvas.
 *   - `mode === 'group'`: `groupId` is the fullscreen group (`split` re-wraps panes to its split tree,
 *     `tile` re-wraps panes preserving their column/row proportions, `freeform` frames the group as-is so
 *     windows can be moved and resized freely inside fullscreen).
 * @typedef {{ mode?: 'single'|'group', id: string|null, groupId?: string|null, returnGroup?: string|null,
 *             soloOverride?: boolean,
 *             canvas?: SavedCanvasPane, saved?: Record<string, SavedCanvasPane>,
 *             camera: { x: number, y: number, zoom: number },
 *             linePx: number, entryLinePx: number, zoomScale?: number }} FullscreenState
 */

/**
 * WallFullscreen — puts a group (`⌘↵` when the focused pane belongs to a multi-pane group) or a single
 * terminal (`⌘⇧↵`, or `⌘↵` on a loose window) fullscreen at `FULLSCREEN_Z` above a 90%-opacity blurred
 * backing plate while keeping the rest of the wall live underneath.
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
        /** Active world rect of a fullscreen `split` group (read by `WallGroups._splitRect` without mutating store). */
        this._fsSplitRect = null;
        this._fsSplitFirstMember = null;
        this._refitting = false;
        this._adoptedNoticeShown = false;
    }

    /** True while any fullscreen (single pane or group) is active. */
    get active() { return !!this.state; }

    /** `'single'`, `'group'`, or `null`. */
    get mode() { return this.state ? (this.state.mode ?? (this.state.groupId ? 'group' : 'single')) : null; }

    /** The solo fullscreen terminal's id (`mode === 'single'`), else `null`. */
    get id() { return this.mode === 'single' ? this.state.id : null; }

    /** Alias for `id`: the lone terminal whose own TitleBar is hidden in fullscreen. */
    get soloId() { return this.id; }

    /** The fullscreen group's id (`mode === 'group'`), else `null`. */
    get groupId() { return this.mode === 'group' ? (this.state.groupId ?? null) : null; }

    /** Layout (`'split'|'tile'|'freeform'`) of the active fullscreen group, else `null`. */
    get groupLayout() {
        const gid = this.groupId;
        return gid ? (this.wall.store.group(gid)?.layout ?? null) : null;
    }

    /** Identifier surfaced in `snapshot().fullscreen`: solo terminal id or fullscreen group id, else `null`. */
    get target() { return this.state ? (this.groupId ?? this.id) : null; }

    /** Shown terminal ids currently elevated in fullscreen. @returns {string[]} */
    elevatedIds() {
        if (!this.state) return [];
        if (this.mode === 'group') return this._shownOf(this.state.groupId);
        return this.state.id && this.wall.isShown(this.state.id) ? [this.state.id] : [];
    }

    /** Whether terminal `id` is currently part of the active fullscreen view. @param {string} id */
    has(id) {
        if (!this.state || !id) return false;
        if (this.mode === 'single') return this.state.id === id;
        return this._shownOf(this.state.groupId).includes(id);
    }

    /** Whether terminal `id` has a saved pre-fullscreen canvas rect (re-wrapped by fullscreen). @param {string} id */
    hasSaved(id) {
        const s = this.state;
        if (!s || !id) return false;
        return !!(s.saved?.[id] || (s.id === id && s.canvas));
    }

    /** Active fullscreen split rect for group `g`, or `null` when `g` isn't fullscreened as a split. */
    splitRectForGroup(g) {
        if (this.mode !== 'group' || !this._fsSplitRect || !g?.members?.length) return null;
        return g.members.includes(this._fsSplitFirstMember) ? this._fsSplitRect : null;
    }

    /**
     * Pre-fullscreen body rect of `id` (defaults to `this.id`) on the canvas, reconstructed from its saved
     * `{ cols, rows, x, y }` so directional navigation and canvas group frames read where it lives on the canvas.
     * @param {string|null} [id]
     * @returns {import('./wallLayout.js').Rect|null}
     */
    canvasBodyRect(id = this.id) {
        const s = this.state;
        const sv = s && id ? (s.saved?.[id] ?? (s.id === id ? s.canvas : null)) : null;
        const grid = sv && id ? this.wall.terminal(id) : null;
        if (!sv || !grid) return null;
        const r = this.wall.terminalRect(id), st = grid.cellStride;
        const frameX = r.maxX - r.minX - grid.cols * st.x;
        const frameY = r.maxY - r.minY - grid.rows * st.y;
        const minX = r.minX + (sv.x - grid.position.x);
        const maxY = r.maxY + (sv.y - grid.position.y);
        return {
            minX, maxX: minX + sv.cols * st.x + frameX,
            maxY, minY: maxY - (sv.rows * st.y + frameY),
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
     * Per frame: veil and blur the canvas outside the fullscreen pane(s), leaving active panes crisp.
     * @param {import('./WallCamera.js').default} viewport
     * @param {string} background - canvas hex colour
     */
    updateBackdrop(viewport, background) {
        const el = this._backdrop;
        if (!el) return;
        if (!this.state) {
            if (this._backdropKey !== 'hidden') { this._backdropKey = 'hidden'; el.style.display = 'none'; }
            return;
        }
        const boxes = this._cutoutBoxes(viewport);
        if (!boxes.length) {
            if (this._backdropKey !== 'hidden') { this._backdropKey = 'hidden'; el.style.display = 'none'; }
            return;
        }
        const clip = backdropClipPath(boxes, viewport.view);
        const bg = backdropColor(background, BACKDROP_OPACITY);
        const key = `${bg}|${clip}`;
        if (key === this._backdropKey) return;
        this._backdropKey = key;
        el.style.display = 'block';
        el.style.background = bg;
        el.style.clipPath = clip;
    }

    _cutoutBoxes(viewport) {
        const w = this.wall;
        if (this.mode === 'single') {
            const id = this.id;
            return id && w.terminal(id) ? [viewport.toScreenBox(w.terminalRect(id))] : [];
        }
        const gid = this.groupId;
        const g = gid ? w.store.group(gid) : null;
        const shown = gid ? this._shownOf(gid) : [];
        if (!g || !shown.length) return [];
        if (g.layout === 'split') {
            const rectOf = (id) => (g.split?.bars && w.windowRect ? w.windowRect(id, viewport.zoom) : w.terminalRect(id));
            const u = unionRect(shown.map(rectOf));
            return u ? [viewport.toScreenBox(u)] : [];
        }
        const winOf = (id) => (w.windowRect ? w.windowRect(id, viewport.zoom) : w.terminalRect(id));
        return shown.map((id) => viewport.toScreenBox(winOf(id)));
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

    /**
     * Default fullscreen toggle (`⌘↵`): exits any active fullscreen back to the canvas; otherwise enters
     * Group Fullscreen when the target belongs to a group with 2+ shown panes, else Single-Pane Fullscreen.
     * @param {string|null} [target] - optional group id or terminal id
     */
    toggle(target = null) {
        if (this.state) {
            if (!target || target === this.id || target === this.groupId) { this.exit(); return; }
        }
        if (target && this.wall.store.group(target)) { this.enterGroup(target); return; }
        const id = target ?? this.wall.focusedId;
        if (id) this.enterDefault(id);
    }

    /**
     * Enter Group Fullscreen if `id` is in a group with 2+ shown members, else Single-Pane Fullscreen on `id`.
     * @param {string} id @returns {boolean}
     */
    enterDefault(id) {
        if (!id) return false;
        const gid = this.wall.store.groupOf(id);
        if (gid && this._shownOf(gid).length >= 2) return this.enterGroup(gid);
        return this.enter(id, { soloOverride: false });
    }

    /**
     * Single-pane fullscreen / zoom toggle (`⌘⇧↵`):
     *   - From canvas: enters Single-Pane Fullscreen on `id ?? focusedId`.
     *   - From Group Fullscreen: zooms `id ?? focusedId` solo (remembering `returnGroup`).
     *   - From Single-Pane Fullscreen: unzooms back to `returnGroup` if it came from Group Fullscreen and
     *     that group still has 2+ shown members, else exits back to the canvas.
     * @param {string|null} [id] @returns {boolean}
     */
    togglePane(id = null) {
        const w = this.wall;
        if (!this.state) {
            const target = id ?? w.focusedId;
            return target ? this.enter(target) : false;
        }
        if (this.mode === 'group') {
            const gid = this.groupId;
            const shown = this._shownOf(gid);
            const target = id ?? (w.focusedId && shown.includes(w.focusedId) ? w.focusedId : shown[0]);
            return target ? this.enter(target, { returnGroup: gid }) : false;
        }
        // Currently in single-pane fullscreen:
        if (id && id !== this.id) {
            const keepRg = this.state.returnGroup && w.store.groupOf(id) === this.state.returnGroup ? this.state.returnGroup : null;
            return this.enter(id, { returnGroup: keepRg });
        }
        const rg = this.state.returnGroup;
        if (rg && w.store.group(rg) && this._shownOf(rg).length >= 2) return this.enterGroup(rg);
        this.exit();
        return false;
    }

    /**
     * Put one terminal fullscreen (`mode === 'single'`).
     * @param {string} id
     * @param {{ returnGroup?: string|null, soloOverride?: boolean }} [o]
     * @returns {boolean}
     */
    enter(id, { returnGroup = null, soloOverride = true } = {}) {
        const w = this.wall, grid = w.terminal(id);
        if (!grid || !w.isShown(id)) return false;
        if (this.mode === 'single' && this.state.id === id) {
            this.state.returnGroup = returnGroup;
            this.state.soloOverride = soloOverride;
            this.refit();
            return true;
        }
        const prev = this.state;
        const cam = w.viewport.camera;
        const camera = prev?.camera ?? { x: cam.position.x, y: cam.position.y, zoom: cam.zoom };
        // Capture `id`'s true canvas geometry BEFORE restoring `prev` (if `id` was already re-wrapped inside
        // a Group Fullscreen, its true canvas geometry lives in `prev.saved[id]`).
        const priorCanvas = prev?.saved?.[id] ?? (prev?.id === id ? prev.canvas : null);
        if (prev) this._restoreState(prev, { exceptId: priorCanvas ? id : null });
        const canvasSnap = priorCanvas
            ? { ...priorCanvas }
            : { cols: grid.cols, rows: grid.rows, x: grid.position.x, y: grid.position.y };
        const canvasPx = grid.cellStride.y * w.viewport.zoom;
        const entryLinePx = prev?.entryLinePx ?? clampLine(Math.max(canvasPx, w.config.fullscreenMinLinePx));
        this._fsSplitRect = null;
        this._fsSplitFirstMember = null;
        this.state = {
            mode: 'single', id, groupId: null, returnGroup: returnGroup ?? null, soloOverride,
            camera, entryLinePx, zoomScale: 1,
            canvas: canvasSnap,
            saved: { [id]: { ...canvasSnap } },
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

    /**
     * Put a group fullscreen (`mode === 'group'`).
     *   - `split`: re-wraps all panes across the fullscreen viewport using the group's `split.tree`.
     *   - `tile`: re-wraps all panes proportionally across the fullscreen viewport, preserving column/row ratios.
     *   - `freeform`: elevates and fits the group's windows as-is so they can be moved/resized in fullscreen.
     * @param {string} gid @returns {boolean}
     */
    enterGroup(gid) {
        const w = this.wall;
        const g = w.store.group(gid);
        const shown = g ? this._shownOf(gid) : [];
        if (!g || !shown.length) return false;
        if (shown.length === 1 && g.layout !== 'freeform') return this.enter(shown[0]);
        if (this.mode === 'group' && this.state.groupId === gid) { this.refit(); return true; }

        const prev = this.state;
        const cam = w.viewport.camera;
        const camera = prev?.camera ?? { x: cam.position.x, y: cam.position.y, zoom: cam.zoom };
        const prevSaved = prev?.saved ? { ...prev.saved } : (prev?.id && prev?.canvas ? { [prev.id]: { ...prev.canvas } } : {});
        if (prev) this._restoreState(prev);

        /** @type {Record<string, SavedCanvasPane>} */
        const saved = {};
        if (g.layout !== 'freeform') {
            for (const m of shown) {
                const mg = w.terminal(m);
                if (!mg) continue;
                saved[m] = prevSaved[m]
                    ? { ...prevSaved[m] }
                    : { cols: mg.cols, rows: mg.rows, x: mg.position.x, y: mg.position.y };
            }
        }
        const ref = w.terminal(shown[0]);
        const canvasPx = ref.cellStride.y * w.viewport.zoom;
        const entryLinePx = prev?.entryLinePx ?? clampLine(Math.max(canvasPx, w.config.fullscreenMinLinePx));
        const textKey = `group:${gid}`;
        this._fsSplitRect = null;
        this._fsSplitFirstMember = null;
        this.state = {
            mode: 'group', id: null, groupId: gid, returnGroup: null,
            camera, entryLinePx, zoomScale: 1,
            saved,
            linePx: w.store.fullscreenText(textKey) ?? entryLinePx,
        };
        w.store.setFullscreen(this.state);
        w.pointer?.quenchWheel?.();

        // Ensure focus rests on a member of this group (preferring the already-focused or most recently focused member).
        if (!w.focusedId || !shown.includes(w.focusedId)) {
            let pick = shown[0];
            const hist = w._focusHistory ?? [];
            for (let i = hist.length - 1; i >= 0; i--) {
                if (shown.includes(hist[i])) { pick = hist[i]; break; }
            }
            w.focus(pick);
        }
        w.applyCanvas();
        this.refit();
        w._emit();
        return true;
    }

    /**
     * Handle focus moving to `id` while fullscreen is active:
     *   - Inside Group Fullscreen: focusing another member of the SAME group stays in place; focusing a
     *     terminal outside the group transitions fullscreen to that target's group (or solo pane).
     *   - Inside Single-Pane Fullscreen: moves solo fullscreen to `id` (keeping `returnGroup` while inside it).
     * @param {string} id
     */
    onFocus(id) {
        if (!this.state || !id) return;
        if (this.mode === 'group') {
            if (this.wall.store.groupOf(id) === this.state.groupId) return;
            this.enterDefault(id);
            return;
        }
        if (id !== this.state.id) {
            if (this.state.soloOverride === false) {
                this.enterDefault(id);
                return;
            }
            const rg = this.state.returnGroup;
            const keepRg = rg && this.wall.store.groupOf(id) === rg ? rg : null;
            this.enter(id, { returnGroup: keepRg, soloOverride: true });
        }
    }

    /** Leave fullscreen: restore any re-wrapped terminals to their canvas sizes/spots and ease camera back. */
    exit() {
        const s = this.state;
        if (!s) return;
        const gid = s.groupId ?? (s.id ? this.wall.store.groupOf(s.id) : null);
        this.state = null;
        this._fsSplitRect = null;
        this._fsSplitFirstMember = null;
        this._adoptedNoticeShown = false;
        this.wall.store.setFullscreen(null);
        this.wall.pointer?.quenchWheel?.();
        this._restoreState(s);
        this.wall.applyCanvas();
        if (gid && this.wall.store.group(gid)) {
            if (this.wall.groups?.relayout) this.wall.groups.relayout(gid);
            else if (s.id) this.wall.groups?.relayoutOf?.(s.id);
        } else if (s.id) {
            this.wall.groups?.relayoutOf?.(s.id);
        }
        this.wall.viewport.easeTo(s.camera);
        this.wall._emit();
    }

    /**
     * Terminal `id` is hiding while part of fullscreen: give `id` its canvas size/spot back first; in
     * Group Fullscreen, stay fullscreen if other members remain shown, else exit.
     * @param {string} id
     */
    onHide(id) {
        const s = this.state;
        if (!s) return;
        if (this.mode === 'single') {
            if (s.id === id) this.exit();
            return;
        }
        const sv = s.saved?.[id];
        if (sv) {
            this._giveBackOne(id, sv);
            delete s.saved[id];
        }
        // Let caller finish marking `id` hidden; `afterMemberLeft` refits or exits once hidden/split state updates.
    }

    /** Called after a member hid or left so a fullscreen group re-fits its remaining members (or exits if empty). */
    afterMemberLeft() {
        if (this.mode !== 'group') return;
        const gid = this.groupId;
        const g = gid ? this.wall.store.group(gid) : null;
        const shown = g ? this._shownOf(gid) : [];
        if (!shown.length) { this.exit(); return; }
        this.wall.store.setFullscreen(this.state);
        this.wall.applyCanvas();
        this.refit();
    }

    /**
     * A terminal went (closed or killed): end single-pane fullscreen on it, or re-fit the remaining
     * members of a fullscreen group (ending fullscreen when none remain).
     * @param {string} id
     */
    gone(id) {
        const s = this.state;
        if (!s) return;
        if (this.mode === 'single') {
            if (s.id !== id) return;
            this.state = null;
            this._fsSplitRect = null;
            this._fsSplitFirstMember = null;
            this.wall.store.setFullscreen(null);
            this.wall.pointer?.quenchWheel?.();
            this.wall.applyCanvas();
            this.wall.viewport.easeTo(s.camera);
            this.wall._emit();
            return;
        }
        if (s.saved && id in s.saved) delete s.saved[id];
        const gid = s.groupId;
        const shown = gid && this.wall.store.group(gid) ? this._shownOf(gid) : [];
        if (!shown.length) {
            this.state = null;
            this._fsSplitRect = null;
            this._fsSplitFirstMember = null;
            this.wall.store.setFullscreen(null);
            this.wall.pointer?.quenchWheel?.();
            this.wall.applyCanvas();
            this.wall.viewport.easeTo(s.camera);
            this.wall._emit();
            return;
        }
        this.wall.store.setFullscreen(this.state);
        this.wall.applyCanvas();
        this.refit();
        this.wall._emit();
    }

    /**
     * A terminal registered: if it belongs to a saved fullscreen (a reload), take that up again and put
     * up the reload notice once.
     * @param {string} id
     */
    adopt(id) {
        const w = this.wall;
        if (this.state) {
            // Another member of an already-adopted fullscreen group just registered: capture & re-fit it.
            if (this.mode === 'group' && w.store.groupOf(id) === this.groupId && w.isShown(id)) {
                const g = w.store.group(this.groupId);
                if (g && g.layout !== 'freeform' && !this.state.saved?.[id]) {
                    const grid = w.terminal(id);
                    if (grid) {
                        this.state.saved ??= {};
                        this.state.saved[id] = { cols: grid.cols, rows: grid.rows, x: grid.position.x, y: grid.position.y };
                    }
                }
                w.applyCanvas();
                this.refit();
                w._emit();
            }
            return;
        }
        const saved = w.store.fullscreen();
        if (!saved) return;
        if (saved.groupId) {
            const gid = saved.groupId;
            if (w.store.groupOf(id) !== gid || !w.isShown(id)) return;
            const g = w.store.group(gid);
            if (!g) return;
            this.state = structuredClone(saved);
            this.state.mode = 'group';
            if (g.layout !== 'freeform') {
                this.state.saved ??= {};
                for (const m of this._shownOf(gid)) {
                    const grid = w.terminal(m);
                    if (grid && !this.state.saved[m]) {
                        this.state.saved[m] = { cols: grid.cols, rows: grid.rows, x: grid.position.x, y: grid.position.y };
                    }
                }
            }
            w.applyCanvas();
            this.refit();
            if (!this._adoptedNoticeShown) {
                this._adoptedNoticeShown = true;
                const label = w.groups?.nameOf ? w.groups.nameOf(gid) : gid;
                w.notify(`fullscreen: ${label} — ${chordLabel(['↵'])} shows the whole wall again`);
            }
            w._emit();
            return;
        }
        if (saved.id !== id || !w.isShown(id)) return;
        this.state = {
            ...saved,
            mode: 'single',
            canvas: { ...saved.canvas },
            saved: saved.saved ? structuredClone(saved.saved) : { [id]: { ...saved.canvas } },
            camera: { ...saved.camera },
        };
        w.applyCanvas();
        this.refit();
        w.notify(`fullscreen: ${w.nameOf(id)} — ${chordLabel(['↵'])} shows the whole wall again`);
        w._emit();
    }

    /**
     * Change the fullscreen text size: +1 bigger, −1 smaller (× fullscreenTextStep), 0 back to entry size.
     * @param {-1|0|1} dir @returns {number|null} the text size now, CSS px per row
     */
    text(dir) {
        const s = this.state;
        if (!s) return null;
        const w = this.wall;
        const step = w.config.fullscreenTextStep;
        if (this.mode === 'group' && this.groupLayout === 'freeform') {
            s.zoomScale = dir === 0 ? 1 : Math.min(8, Math.max(0.2, (s.zoomScale ?? 1) * Math.pow(step, dir)));
            s.linePx = clampLine(s.entryLinePx * s.zoomScale);
            w.store.setFullscreen(s);
            this.refit();
            w._emit();
            return s.linePx;
        }
        const key = this.mode === 'group' ? `group:${s.groupId}` : s.id;
        if (dir === 0) {
            s.linePx = s.entryLinePx;
            if (key) w.store.setFullscreenText(key, null);
        } else {
            s.linePx = clampLine(s.linePx * Math.pow(step, dir));
            if (key) w.store.setFullscreenText(key, s.linePx);
        }
        w.store.setFullscreen(s);
        this.refit();
        w._emit();
        return s.linePx;
    }

    /**
     * Fit the active fullscreen view (single terminal, or split / tile / freeform group) into `area()`.
     * @returns {{ cols: number, rows: number }|null}
     */
    refit() {
        if (this._refitting || !this.state) return null;
        this._refitting = true;
        try {
            const a = this.area();
            this._areaKey = areaKey(a);
            this._refitAt = 0;
            if (this.mode === 'group') return this._refitGroup(a);
            return this._refitSingle(a);
        } finally {
            this._refitting = false;
        }
    }

    _refitSingle(a) {
        const s = this.state, w = this.wall;
        const grid = s.id && w.terminal(s.id);
        if (!grid) return null;
        this._fsSplitRect = null;
        this._fsSplitFirstMember = null;
        const stride = grid.cellStride;
        const zoom = s.linePx / stride.y;
        const cellW = stride.x * zoom, cellH = s.linePx, pad = w.config.fullscreenPad;
        const r = w.terminalRect(s.id), v = w.viewport.view;
        const frameX = (r.maxX - r.minX - grid.cols * stride.x) * zoom;
        const frameY = (r.maxY - r.minY - grid.rows * stride.y) * zoom;
        const cols = Math.max(MIN.cols, Math.floor((a.width - 2 * pad - frameX) / cellW));
        const rows = Math.max(MIN.rows, Math.floor((a.height - 2 * pad - frameY) / cellH));
        if (cols !== grid.cols || rows !== grid.rows) w.router.execute(['terminal.resize', s.id, String(cols), String(rows)]);
        const left = a.left + Math.max(0, (a.width - cols * cellW - frameX) / 2);
        const top = a.top + Math.max(0, (a.height - rows * cellH - frameY) / 2);
        w.viewport.easeTo({ x: r.minX + (v.w / 2 - left) / zoom, y: r.maxY - (v.h / 2 - top) / zoom, zoom });
        return { cols, rows };
    }

    _refitGroup(a) {
        const s = this.state, w = this.wall;
        const gid = s.groupId;
        const g = gid ? w.store.group(gid) : null;
        const shown = g ? this._shownOf(gid) : [];
        if (!g || !shown.length) return null;
        if (g.layout === 'split') return this._refitSplit(g, shown, a);
        if (g.layout === 'tile') return this._refitTile(g, shown, a);
        return this._refitFreeform(shown, a);
    }

    _refitSplit(g, shown, a) {
        const s = this.state, w = this.wall;
        const ref = w.terminal(shown[0]), stride = ref.cellStride;
        const pad = w.config.fullscreenPad, splitGap = w.config.splitGap;
        const room = g.split.bars ? w.config.splitBarRows * stride.y : 0;
        const f0 = this._frameOf(shown[0]);
        let tree = g.split.tree;
        for (const m of g.members) if (!shown.includes(m)) tree = removePane(tree, m) ?? tree;
        const min = minSize(tree, () => ({ w: MIN.cols * stride.x + f0.x, h: MIN.rows * stride.y + f0.y + room }), splitGap);
        let zoom = s.linePx / stride.y;
        const fitW = Math.max(1, a.width - 2 * pad), fitH = Math.max(1, a.height - 2 * pad);
        if (fitW / zoom < min.w || fitH / zoom < min.h) {
            zoom = Math.max(0.05, Math.min(fitW / min.w, fitH / min.h));
        }
        const availW = Math.max(min.w, fitW / zoom), availH = Math.max(min.h, fitH / zoom);
        const origin = g.origin ?? { x: 0, y: 0 };
        const fsRect = { minX: origin.x, maxX: origin.x + availW, maxY: origin.y, minY: origin.y - availH };
        this._fsSplitRect = fsRect;
        this._fsSplitFirstMember = g.members[0];

        let firstSize = null;
        for (const [id, pr] of panes(tree, fsRect, splitGap)) {
            const grid = w.terminal(id);
            if (!grid) continue;
            const f = this._frameOf(id);
            const cols = Math.max(MIN.cols, Math.floor((pr.maxX - pr.minX - f.x) / stride.x + EDGE_EPS));
            const rows = Math.max(MIN.rows, Math.floor((pr.maxY - pr.minY - room - f.y) / stride.y + EDGE_EPS));
            if (cols !== grid.cols || rows !== grid.rows) w.router.execute(['terminal.resize', id, String(cols), String(rows)]);
            w.placeBody(id, { x: pr.minX, y: pr.maxY - room });
            w.names?.setBarRoom?.(id, room);
            firstSize ??= { cols, rows };
        }
        const rectOf = (id) => (g.split.bars && w.windowRect ? w.windowRect(id, zoom) : w.terminalRect(id));
        this._centerRectInArea(unionRect(shown.map(rectOf)), a, zoom);
        return firstSize;
    }

    _refitTile(g, shown, a) {
        const s = this.state, w = this.wall;
        this._fsSplitRect = null;
        this._fsSplitFirstMember = null;
        const ref = w.terminal(shown[0]), stride = ref.cellStride;
        const pad = w.config.fullscreenPad, gap = g.gap;
        const colsCount = Math.max(1, Math.min(g.columns, shown.length));
        const rowsCount = Math.ceil(shown.length / colsCount);

        // Read each member's original canvas body dimensions (w0, h0) so custom tile proportions (e.g. 2:3:2) stay intact.
        const orig = shown.map((id) => {
            const grid = w.terminal(id), f = this._frameOf(id);
            const sv = s.saved?.[id] ?? { cols: grid.cols, rows: grid.rows, x: grid.position.x, y: grid.position.y };
            return { id, grid, f, w0: sv.cols * stride.x + f.x, h0: sv.rows * stride.y + f.y };
        });
        const colW0 = new Array(colsCount).fill(0);
        const rowH0 = new Array(rowsCount).fill(0);
        orig.forEach(({ w0, h0 }, i) => {
            const c = i % colsCount, r = Math.floor(i / colsCount);
            colW0[c] = Math.max(colW0[c], w0);
            rowH0[r] = Math.max(rowH0[r], h0);
        });
        const sumColW0 = colW0.reduce((acc, v) => acc + v, 0) || 1;
        const sumRowH0 = rowH0.reduce((acc, v) => acc + v, 0) || 1;

        let zoom = s.linePx / stride.y;
        const barRoom = Math.min(BAR_ROOM, 22 / zoom);
        const f0 = orig[0].f;
        const minTotalW = colsCount * (MIN.cols * stride.x + f0.x) + (colsCount - 1) * gap;
        const minTotalH = rowsCount * (MIN.rows * stride.y + f0.y + barRoom) + (rowsCount - 1) * gap;
        const fitW = Math.max(1, a.width - 2 * pad), fitH = Math.max(1, a.height - 2 * pad);
        if (fitW / zoom < minTotalW || fitH / zoom < minTotalH) {
            zoom = Math.max(0.05, Math.min(fitW / minTotalW, fitH / minTotalH));
        }
        const barH = w.names
            ? (Math.max(...shown.map((id) => w.names.barHeight(id, zoom)), 0) || Math.min(BAR_ROOM, 22 / zoom))
            : Math.min(BAR_ROOM, 22 / zoom);
        const usableW = Math.max(colsCount * (MIN.cols * stride.x + f0.x), fitW / zoom - (colsCount - 1) * gap);
        const usableH = Math.max(rowsCount * (MIN.rows * stride.y + f0.y), fitH / zoom - rowsCount * barH - (rowsCount - 1) * gap);
        const kx = usableW / sumColW0;
        const ky = usableH / sumRowH0;

        let firstSize = null;
        const newSizes = orig.map(({ id, grid, f, w0, h0 }) => {
            const cols = Math.max(MIN.cols, Math.floor((w0 * kx - f.x) / stride.x + EDGE_EPS));
            const rows = Math.max(MIN.rows, Math.floor((h0 * ky - f.y) / stride.y + EDGE_EPS));
            if (cols !== grid.cols || rows !== grid.rows) w.router.execute(['terminal.resize', id, String(cols), String(rows)]);
            firstSize ??= { cols, rows };
            const r = w.terminalRect(id);
            return { w: r.maxX - r.minX, h: r.maxY - r.minY };
        });
        const origin = g.origin ?? { x: s.saved?.[shown[0]]?.x ?? 0, y: (s.saved?.[shown[0]]?.y ?? 0) + barH };
        const { places } = tileLayout(newSizes, { origin, columns: colsCount, gap, barRoom: barH });
        shown.forEach((id, i) => w.placeBody(id, places[i]));

        const winOf = (id) => (w.windowRect ? w.windowRect(id, zoom) : w.terminalRect(id));
        this._centerRectInArea(unionRect(shown.map(winOf)), a, zoom);
        return firstSize;
    }

    _refitFreeform(shown, a) {
        const s = this.state, w = this.wall;
        this._fsSplitRect = null;
        this._fsSplitFirstMember = null;
        const pad = w.config.fullscreenPad;
        const fitW = Math.max(1, a.width - 2 * pad), fitH = Math.max(1, a.height - 2 * pad);
        const winAt = (z) => unionRect(shown.map((id) => (w.windowRect ? w.windowRect(id, z) : w.terminalRect(id))));
        const first = fitRect(winAt(w.viewport.zoom), fitW, fitH, 1);
        const second = fitRect(winAt(first.zoom), fitW, fitH, 1);
        const zoom = Math.max(0.05, second.zoom * (s.zoomScale ?? 1));
        this._centerRectInArea(winAt(zoom), a, zoom);
        const ref = w.terminal(shown[0]);
        return ref ? { cols: ref.cols, rows: ref.rows } : null;
    }

    _centerRectInArea(rect, a, zoom) {
        if (!rect) return;
        const v = this.wall.viewport.view;
        const cx = (rect.minX + rect.maxX) / 2 + (v.w / 2 - (a.left + a.width / 2)) / zoom;
        const cy = (rect.minY + rect.maxY) / 2 - (v.h / 2 - (a.top + a.height / 2)) / zoom;
        this.wall.viewport.easeTo({ x: cx, y: cy, zoom });
    }

    _shownOf(gid) {
        if (!gid) return [];
        if (this.wall.groups?.shownMembers) return this.wall.groups.shownMembers(gid);
        const g = this.wall.store.group(gid);
        return g ? g.members.filter((id) => this.wall.isShown(id)) : [];
    }

    _frameOf(id) {
        const grid = this.wall.terminal(id), r = this.wall.terminalRect(id), st = grid.cellStride;
        return { x: r.maxX - r.minX - grid.cols * st.x, y: r.maxY - r.minY - grid.rows * st.y };
    }

    /** Per frame: a window or dock change re-fits once it has held still for REFIT_SETTLE_MS. @param {number} now */
    tick(now) {
        if (!this.state) return;
        const key = areaKey(this.area());
        if (key !== this._areaKey) { this._areaKey = key; this._refitAt = now + REFIT_SETTLE_MS; }
        if (this._refitAt && now >= this._refitAt) this.refit();
    }

    /** Restore all saved canvas geometries on `s` (optionally skipping `exceptId` when zooming into it). */
    _restoreState(s, { exceptId = null } = {}) {
        const saved = s.saved ?? (s.id && s.canvas ? { [s.id]: s.canvas } : {});
        for (const [id, sv] of Object.entries(saved)) {
            if (id === exceptId) continue;
            this._giveBackOne(id, sv);
        }
    }

    _giveBackOne(id, sv) {
        const w = this.wall, grid = w.terminal(id);
        if (!grid || !sv) return;
        const { cols, rows, x, y } = sv;
        if (grid.cols !== cols || grid.rows !== rows) w.router.execute(['terminal.resize', id, String(cols), String(rows)]);
        grid.position.x = x;
        grid.position.y = y;
    }
}

/** @param {number} px */
function clampLine(px) { return Math.min(LINE_PX.max, Math.max(LINE_PX.min, px)); }

/** @param {{ left: number, top: number, width: number, height: number }} a */
function areaKey(a) { return `${a.left},${a.top},${Math.round(a.width)},${Math.round(a.height)}`; }

/**
 * CSS `clip-path` covering the viewport except `boxOrBoxes` (one screen box or an array of possibly
 * overlapping screen boxes). Multiple boxes are decomposed into mutually disjoint horizontal strips so
 * winding inside every pane — including overlapping freeform panes — is strictly `1 - 1 = 0` (crisp).
 * `'none'` when all boxes lie wholly off-screen during the start of a camera glide.
 * @param {{ left: number, right: number, top: number, bottom: number } | { left: number, right: number, top: number, bottom: number }[]} boxOrBoxes
 * @param {{ w: number, h: number }} view
 */
export function backdropClipPath(boxOrBoxes, view) {
    const raw = Array.isArray(boxOrBoxes) ? boxOrBoxes : (boxOrBoxes ? [boxOrBoxes] : []);
    const rects = [];
    for (const box of raw) {
        if (!box) continue;
        const l = Math.max(0, Math.min(view.w, box.left));
        const r = Math.max(0, Math.min(view.w, box.right));
        const t = Math.max(0, Math.min(view.h, box.top));
        const b = Math.max(0, Math.min(view.h, box.bottom));
        if (r - l > 0.5 && b - t > 0.5) rects.push({ l, r, t, b });
    }
    if (!rects.length) return 'none';
    if (rects.length === 1) {
        const { l, r, t, b } = rects[0];
        const ls = l.toFixed(1), rs = r.toFixed(1), ts = t.toFixed(1), bs = b.toFixed(1);
        return `polygon(0px 0px, 100% 0px, 100% 100%, 0px 100%, 0px 0px, ${ls}px ${ts}px, ${ls}px ${bs}px, ${rs}px ${bs}px, ${rs}px ${ts}px, ${ls}px ${ts}px, 0px 0px)`;
    }
    const ys = [...new Set(rects.flatMap((q) => [Math.round(q.t * 10) / 10, Math.round(q.b * 10) / 10]))].sort((a, b) => a - b);
    /** @type {{ l: number, r: number, t: number, b: number }[]} */
    const strips = [];
    for (let i = 0; i < ys.length - 1; i++) {
        const y0 = ys[i], y1 = ys[i + 1];
        if (y1 - y0 <= 0.1) continue;
        const mid = (y0 + y1) / 2;
        const spans = rects.filter((q) => q.t <= mid && q.b >= mid).map((q) => ({ l: q.l, r: q.r })).sort((a, b) => a.l - b.l);
        if (!spans.length) continue;
        const merged = [{ ...spans[0] }];
        for (let k = 1; k < spans.length; k++) {
            const prev = merged[merged.length - 1];
            if (spans[k].l <= prev.r + 0.2) prev.r = Math.max(prev.r, spans[k].r);
            else merged.push({ ...spans[k] });
        }
        for (const m of merged) {
            const prev = strips.find((s) => Math.abs(s.b - y0) <= 0.1 && Math.abs(s.l - m.l) <= 0.2 && Math.abs(s.r - m.r) <= 0.2);
            if (prev) prev.b = y1;
            else strips.push({ l: m.l, r: m.r, t: y0, b: y1 });
        }
    }
    if (!strips.length) return 'none';
    const holes = strips.map(({ l, r, t, b }) => {
        const ls = l.toFixed(1), rs = r.toFixed(1), ts = t.toFixed(1), bs = b.toFixed(1);
        return `${ls}px ${ts}px, ${ls}px ${bs}px, ${rs}px ${bs}px, ${rs}px ${ts}px, ${ls}px ${ts}px, 0px 0px`;
    }).join(', ');
    return `polygon(0px 0px, 100% 0px, 100% 100%, 0px 100%, 0px 0px, ${holes})`;
}

/** @param {string} hex @param {number} alpha */
export function backdropColor(hex, alpha = BACKDROP_OPACITY) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return `rgba(7, 8, 11, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
