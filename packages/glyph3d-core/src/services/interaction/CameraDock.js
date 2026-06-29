/**
 * CameraDock — a camera-locked HUD bar that holds windows (code grids /
 * terminals) as live, dimensionally-scaled tiles.
 *
 * This is the L2 the AttentionManager.docks map was stubbed for. A docked
 * window is the SAME live Object3D — not a proxy or snapshot — reparented under
 * this node and scaled down via its Object3D transform. An 80×80 terminal keeps
 * its 80×80 buffer; only its `scale` shrinks, so it reads as a tidy box without
 * losing a cell. ("Shrunk dimensionally, not re-windowed.")
 *
 * Each tile is CONTAIN-FIT into a fixed bounding box (boxFrac·viewH tall, boxAspect
 * wide — per-entity overridable): the box owns the packing footprint, the content
 * scales to sit inside it (tall files pillarbox, wide terminals letterbox). So a
 * tile's slot is independent of its content size or readability zoom — the bar packs
 * as a uniform icon strip and nothing slides off the sides. Zoom lives at home/focus,
 * never in the bar.
 *
 * A spotlit (or PINNED) tile leaves the bar and OCCUPIES the root VIEW-FRAME — a
 * configurable rect of the camera frustum (full-screen, or a 2/3 / left / right pane)
 * the window CONTAIN-FITS into with a margin. Pin and dock-spotlight are the SAME state
 * ("this window holds the frame"); the frame's size is a pure function of (frustum,
 * frame rect, live grid extent), refit live as the canvas resizes — zoom never bleeds
 * past its edges. This is the seam future SUBFRAMES partition. See _frameRect / _placeFrame.
 *
 * How it rides the camera: this node is itself a THREE.Object3D added to the
 * scene. Each frame `update(dt, camera)` parks it a fixed `distance` ahead of
 * the camera, matching the camera's orientation — the sky-follow trick with an
 * offset. Tiles are CHILDREN, so they inherit that transform for free and the
 * whole bar travels with the view. Slot positions are laid out in dock-LOCAL
 * space (a strip near the bottom of the frame), so a `SpatialAnimator` only ever
 * animates local position/scale — the camera-follow and the slide compose.
 *
 * Reparenting uses THREE.Object3D.attach() (world-transform preserving) so a
 * window doesn't jump when it docks or releases. The window's ORIGINAL parent
 * (a ContentTree dir node for code grids, the scene for terminals) and local
 * transform are captured on lock and restored on release — we never assume the
 * scene is the home.
 *
 * State of record lives in the shared AttentionManager.docks map (passed in), so
 * command handlers and the session store read one place, not a second service.
 *
 * @typedef {Object} DockEntry
 * @property {string} id
 * @property {Object} grid        - the live Object3D (CodeGrid / TerminalGrid)
 * @property {Object|null} homeParent
 * @property {{pos:{x,y,z}, scale:number, quat:THREE.Quaternion}} home
 * @property {{h:number,cx:number,cy:number,cz:number}} _extentFallback - last-resort content
 *   extent for a transient empty-bounds read; the LIVE grid.getLocalBounds() (via _extentOf)
 *   is preferred. Content size is derived, never cached as a delta.
 * @property {number} order - stable sort key (the dock's record of "which tile is which slot").
 *   Assigned a monotonic counter on an interactive dock so new tiles append; threaded from the saved
 *   snapshot on restore so a tile lands in its SAVED position no matter WHEN its surface re-adopts
 *   (terminals re-adopt async, in arrival order — order is what keeps the bar from scrambling).
 * @property {number} slot - dense 0..n-1 DISPLAY rank, derived from `order` every _relayout.
 * @property {THREE.Quaternion} quatTarget - orientation the tile slerps toward
 */

import * as THREE from 'three';
import { SpatialAnimator } from '../spatial/SpatialAnimator.js';
import { flowBoxes } from '../../collections/layouts/flowBoxes.js';
import { BORDER_FLAGS } from '../../collections/panelMaterial.js';

const _forward = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _off = new THREE.Vector3();
const DEG2RAD = Math.PI / 180;

// Focus-placeholder animation. A spotlit tile leaves a ghost outline in its held-open slot; this
// drives the subtle breathe that says "this is where it lives; it returns here".
const GHOST_PULSE_HZ = 0.5;          // outline opacity breathe (cycles/sec)
const GHOST_RENDER_ORDER = 1000;     // HUD affordance — drawn over the tiles, depth-test off

// Per-tile identity hue — AUTO-GENERATED per docked window, not a fixed palette. A golden-angle
// rotation (137.5°) walks the hue circle so successive windows land maximally far apart: distinct for
// ANY count, no ring-buffer wrap/collision past N. Quiet fixed S/L keeps them desaturated (not
// garish); the start hue sits near the old single ghost blue for continuity. The hue is painted as the
// window's in-shader panel border AND its dock ghost outline, so a tile in the bar and its placeholder
// read as the same window by color — the "which rectangle is which" solver.
const IDENTITY_GOLDEN = 137.508 / 360; // golden-angle as a hue fraction — the most-irrational step
const IDENTITY_HUE0 = 0.58;            // start hue (~blue) — continuity with the old ghost color
const IDENTITY_SAT = 0.72;             // quiet but present — distinct as a hairline on a small tile
const IDENTITY_LIGHT = 0.68;           // light — reads on the dark background, not washed out

/** Walk up the parent chain to confirm an object still reaches a live Scene. */
function reachesScene(obj) {
    let o = obj;
    while (o) {
        if (o.isScene) return true;
        o = o.parent;
    }
    return false;
}

/** A grid's content extent in its OWN local frame (scale-free, orientation-free): panel height
 *  + the origin→center offset. Pulled from a local-frame Box3; null if empty. This is the dock's
 *  content-size truth — read LIVE from the grid each time it's needed, never cached and
 *  delta-updated (the cached `*= ratio` form desynced from cols/rows and double-applied). */
function extentFromBox(lb) {
    if (!lb || lb.isEmpty?.()) return null;
    return {
        h: Math.max(lb.max.y - lb.min.y, 1e-3),
        cx: (lb.min.x + lb.max.x) * 0.5,
        cy: (lb.min.y + lb.max.y) * 0.5,
        cz: (lb.min.z + lb.max.z) * 0.5,
    };
}

export class CameraDock extends THREE.Object3D {
    /**
     * @param {Object} [opts]
     * @param {Object} [opts.attentionManager] - shared AttentionManager (its .docks map is the record of truth)
     * @param {number} [opts.distance=10]   - world units ahead of the camera the bar sits
     * @param {number} [opts.boxFrac=0.1]   - slot-box height as a fraction of the visible height
     * @param {number} [opts.boxAspect=1.15] - slot-box width/height; content contain-fits inside
     * @param {number} [opts.gapFrac=0.4]   - gap between tiles as a fraction of the box height
     * @param {number} [opts.maxColumns=0]  - radial: max tiles per row (0 = auto, fill the arc)
     * @param {number} [opts.fillFrac=0.9]  - linear: fraction of viewport width the row may fill
     * @param {number} [opts.maxArcDeg=80]  - radial: azimuth span the dome wraps within (degrees)
     * @param {number} [opts.maxRiseDeg=80] - radial: elevation span the dome rises through (degrees)
     * @param {number} [opts.bottomFrac=0.86] - row depth: 0 = view center, 1 = bottom edge
     * @param {number} [opts.frameW=1]    - root view-frame width as a fraction of the frustum width
     * @param {number} [opts.frameH=1]    - root view-frame height as a fraction of the frustum height
     * @param {number} [opts.frameX=0]    - frame center X offset (fraction of half the frustum width)
     * @param {number} [opts.frameY=0]    - frame center Y offset (fraction of half the frustum height)
     * @param {number} [opts.frameMarginLeft=0.06]   - inset from the frame's LEFT edge (fraction of frame width)
     * @param {number} [opts.frameMarginRight=0.06]  - inset from the frame's RIGHT edge (fraction of frame width)
     * @param {number} [opts.frameMarginTop=0.06]    - inset from the frame's TOP edge (fraction of frame height)
     * @param {number} [opts.frameMarginBottom=0.06] - inset from the frame's BOTTOM edge (fraction of frame height)
     * @param {number} [opts.frameDistFrac=0.7] - frame pull-in toward the eye (renders over the bar)
     * @param {number} [opts.yawRate=14]    - tile face-the-eye slerp rate (×dt)
     * @param {number} [opts.borderWidth=1.5] - docked window's panel-border thickness (screen pixels)
     * @param {number} [opts.borderStrength=1] - docked window's border intensity (0 = no border)
     * @param {'linear'|'radial'} [opts.layout='radial']
     */
    constructor({ attentionManager = null, distance = 10, boxFrac = 0.1, boxAspect = 1.15, gapFrac = 0.4,
                  maxColumns = 0, fillFrac = 0.9, maxArcDeg = 80, maxRiseDeg = 80, bottomFrac = 0.86,
                  frameW = 1, frameH = 1, frameX = 0, frameY = 0,
                  frameMarginLeft = 0.06, frameMarginRight = 0.06, frameMarginTop = 0.06, frameMarginBottom = 0.06,
                  frameDistFrac = 0.7,
                  animDur = 0.167, yawRate = 14,
                  ghostColor = 0x8ab4ff, ghostOpacity = 0.55, borderWidth = 1.5, borderStrength = 1,
                  layout = 'radial' } = {}) {
        super();
        this.name = 'camera-dock';
        this.attentionManager = attentionManager;
        this.distance = distance;
        this.boxFrac = boxFrac;       // slot-box height as a fraction of the visible height
        this.boxAspect = boxAspect;   // slot-box width/height; content contain-fits inside
        this.gapFrac = gapFrac;       // tile gap as a fraction of the box height
        this.maxColumns = maxColumns; // radial: cap tiles per row (0 = auto, fill the arc)
        this.fillFrac = fillFrac;     // linear: row may fill this fraction of the viewport width
        this.maxArcDeg = maxArcDeg;   // radial: azimuth span the dome wraps within (degrees)
        this.maxRiseDeg = maxRiseDeg; // radial: elevation span the dome rises through (degrees)
        this.yawRate = yawRate;       // tile face-the-eye slerp rate (×dt)
        this.bottomFrac = bottomFrac;
        // The ROOT view-frame: a rect of the camera frustum a pinned/spotlit window contain-fits
        // INTO (the "window-pane" the canvas frames). Frustum-normalized, so it tracks the drawing
        // frame's size live. frameW/H size it, frameX/Y offset it (full-screen, 2/3, left/right
        // panes), frameMargin insets the window inside it. The seam future SUBFRAMES grow from.
        this.frameW = frameW;
        this.frameH = frameH;
        this.frameX = frameX;
        this.frameY = frameY;
        // Per-side margins (left/right of the width, top/bottom of the height). An ASYMMETRIC set
        // both SHRINKS and RE-CENTERS the pane — a bigger left margin pushes content right, a bigger
        // bottom margin pushes it up — so the four sliders hand-place the window inside its frame.
        this.frameMarginLeft = frameMarginLeft;
        this.frameMarginRight = frameMarginRight;
        this.frameMarginTop = frameMarginTop;
        this.frameMarginBottom = frameMarginBottom;
        this.frameDistFrac = frameDistFrac; // frame pulls this fraction of `distance` toward the eye
                                            // — <1 sits it IN FRONT of the dock sphere so it always
                                            // renders on top (scale/offset compensate, so it looks
                                            // identical in size, just nearer)
        this.animDur = animDur;       // tile slide/scale duration (s) — a curt, polite snap
        this.layoutMode = layout;     // 'radial' (hemisphere, default) | 'linear'
        this.ghostColor = ghostColor;     // fallback outline color (entries get a palette hue)
        this.ghostOpacity = ghostOpacity; // its peak opacity (breathes below this)
        this.borderWidth = borderWidth;       // docked window's panel-border thickness (screen pixels)
        this.borderStrength = borderStrength; // docked window's panel-border intensity (0 = off)
        this._colorCursor = 0;            // golden-angle step counter — each docked window gets a fresh spread hue
        this._orderSeq = 0;               // monotonic sort-key source for interactive locks (restore overrides per-tile)

        /** The tile currently raised into the focus area (centered + enlarged, still
         *  camera-locked), or null. Toggled by spotlight(). Its bar slot stays RESERVED and a
         *  ghost placeholder stands in for it — see _showGhost. */
        this.focusedId = null;

        /** The focus placeholder — a slot-box outline parked in the focused tile's held-open slot.
         *  Built on first spotlight and reused (at most one tile is focused). @type {Object|null} */
        this._ghost = null;
        this._ghostClock = 0;  // seconds, advances each update() to drive the breathe

        this.animator = new SpatialAnimator();

        /** @type {Map<string, DockEntry>} locked tiles */
        this.entries = new Map();
        /** @type {Map<string, DockEntry>} tiles mid-release (kept for the slerp-home) */
        this._releasing = new Map();
        /** Identity set of docked grid objects — the camera reads this (ctx.dockTiles)
         *  to skip dock chrome in its per-frame look-distance sampling, an O(1) has()
         *  with no array allocation. @type {Set<Object>} */
        this.tiles = new Set();

        // Visible extents at `distance`, refreshed each frame from the camera.
        this._viewH = 100;
        this._viewW = 160;

        // The dock itself is structural — invisible, never picked. Tiles carry the pixels.
        this.renderOrder = 0;
    }

    // ===================== membership =====================

    /** @param {string} id @returns {boolean} */
    has(id) { return this.entries.has(id); }

    /** @returns {Array<{id:string, slot:number, layout:string, focused:boolean, zoom:number}>} */
    list() {
        // Sorted by slot (the order-derived display rank), so list order == bar order — what
        // persistence serializes and dock.list prints.
        return [...this.entries.values()].sort((a, b) => a.slot - b.slot).map((e) => ({
            id: e.id, slot: e.slot, layout: this.layoutMode, focused: e.id === this.focusedId,
            zoom: e.grid?.scaleModel ? e.grid.scaleModel.zoomScalar : 1,
        }));
    }

    /**
     * Toggle a docked tile in/out of the focus area: raised, it sits centered and
     * enlarged (still camera-locked, still a dock entry); clicking it again — or
     * spotlighting another — returns it to its bar slot. At most one is focused.
     * @param {string} id
     * @returns {'spotlit'|'returned'|false}
     */
    spotlight(id) {
        if (!this.entries.has(id)) return false;
        const prev = this.focusedId;
        // Toggle off: the occupant returns to its bar slot, its Pin button unlights.
        if (prev === id) {
            this.focusedId = null;
            this.entries.get(id)?.grid?.setControlActive?.('pin', false);
            this._relayout();
            return 'returned';
        }
        // Move the frame to `id`: the previous occupant (if any) returns to the bar; the new one
        // lights its Pin button. Pin and spotlight are ONE state, so the button tracks frame
        // occupancy no matter who set it (Pin button, tile click, CLI).
        if (prev) this.entries.get(prev)?.grid?.setControlActive?.('pin', false);
        this.focusedId = id;
        this.entries.get(id)?.grid?.setControlActive?.('pin', true);
        this._relayout();
        return 'spotlit';
    }

    /**
     * The HOME position a docked window will return to on release (in its home
     * parent's space) — NOT its current tile-local position. Persistence reads this
     * so a docked window's saved position is its world home, not the tile coordinate.
     * @param {string} id
     * @returns {{x:number,y:number,z:number}|null}
     */
    homePosition(id) {
        const e = this.entries.get(id);
        return e ? { x: e.home.pos.x, y: e.home.pos.y, z: e.home.pos.z } : null;
    }

    /**
     * The world AABB the docked window had at home — for framing it on focus.
     * @param {string} id
     * @returns {Object|null} a THREE.Box3 clone, or null
     */
    homeBounds(id) {
        const e = this.entries.get(id);
        return e?.homeBounds ? e.homeBounds.clone() : null;
    }

    /** Release every docked tile (back to its home). */
    releaseAll() {
        for (const id of [...this.entries.keys()]) this.release(id);
    }

    /**
     * Tune a layout parameter live and re-pack. Keys: distance, boxFrac, boxAspect, gapFrac,
     * maxColumns, fillFrac, maxArcDeg, maxRiseDeg, bottomFrac, frameW, frameH, frameX, frameY,
     * frameMarginLeft, frameMarginRight, frameMarginTop, frameMarginBottom, frameDistFrac, animDur, yawRate.
     * @param {string} key @param {number} value @returns {boolean}
     */
    setParam(key, value) {
        if (!['distance', 'boxFrac', 'boxAspect', 'gapFrac', 'maxColumns', 'fillFrac', 'maxArcDeg',
              'maxRiseDeg', 'bottomFrac', 'frameW', 'frameH', 'frameX', 'frameY',
              'frameMarginLeft', 'frameMarginRight', 'frameMarginTop', 'frameMarginBottom',
              'frameDistFrac', 'animDur', 'yawRate', 'ghostOpacity', 'borderWidth', 'borderStrength'].includes(key)) return false;
        if (!Number.isFinite(value)) return false;
        this[key] = value;
        this._relayout();
        return true;
    }

    /**
     * Auto-generate the i-th identity hue: a golden-angle walk of the hue circle at a fixed quiet
     * S/L. Deterministic in the lock sequence (each entry keeps its hue for its docked lifetime) and
     * maximally spread for any count — no fixed list to wrap or collide.
     * @param {number} i sequence index (this._colorCursor at lock time)
     * @returns {number} hex color
     */
    _identityColor(i) {
        const hue = (IDENTITY_HUE0 + i * IDENTITY_GOLDEN) % 1;
        return new THREE.Color().setHSL(hue, IDENTITY_SAT, IDENTITY_LIGHT).getHex();
    }

    /**
     * Dock a window: capture its home, reparent it under the bar (world-preserving),
     * and animate it into its slot at tile scale.
     * @param {string} id  registry id
     * @param {Object} grid live Object3D with getBounds()
     * @param {{order?:number}} [opts] order = a stable sort-key hint (restore passes the saved
     *   index so an async-re-adopting tile lands in its saved position); omitted = append (next
     *   monotonic counter), which is what an interactive dock wants.
     * @returns {boolean}
     */
    lock(id, grid, opts = {}) {
        if (!grid || this.entries.has(id)) return false;

        // Order is the dock's record of "which tile goes where" — a sort key, not a placement.
        // A hint (restore) pins the saved position; absent, the next counter appends. Either way the
        // counter advances past it so subsequent interactive locks land AFTER, never colliding.
        const order = Number.isFinite(opts?.order) ? opts.order : this._orderSeq;
        this._orderSeq = Math.max(this._orderSeq, order + 1);

        // World bounds at lock, for the home framing (dock.focus) and the home PLACEMENT to
        // animate back to on release. Content EXTENT (height + center offset) is NOT captured
        // here — it's derived live from grid.getLocalBounds() each time it's needed (_extentOf),
        // so a resize can never desync a cached copy.
        const b = grid.getBounds?.();
        const hasBounds = b && !b.isEmpty?.();
        const resolvedScale = grid.scale.x || 1;
        const homePlacement = grid.scaleModel ? grid.scaleModel.placement : resolvedScale;

        const entry = {
            id,
            grid,
            homeParent: grid.parent || null,
            home: {
                pos: { x: grid.position.x, y: grid.position.y, z: grid.position.z },
                scale: homePlacement, // release animates PLACEMENT home; resolve re-adds zoom
                quat: grid.quaternion.clone(),
            },
            // Fallback only for a transient empty-bounds read; the live getLocalBounds path wins.
            _extentFallback: extentFromBox(grid.getLocalBounds?.()) ||
                { h: hasBounds ? Math.max((b.max.y - b.min.y) / resolvedScale, 1e-3) : 10, cx: 0, cy: 0, cz: 0 },
            unsubscribeResize: null,
            // The world AABB the window had at home, captured before docking — dock.focus
            // frames THIS (computed, stable) rather than the tile's live mid-slide bounds.
            homeBounds: hasBounds ? b.clone() : null,
            order,
            slot: this.entries.size, // provisional; _relayout re-ranks by `order` immediately below
            quatTarget: new THREE.Quaternion(),
            // This window's identity hue — painted as its panel border AND its ghost outline, so the
            // tile in the bar and its placeholder read as the same window by color.
            ghostColor: this._identityColor(this._colorCursor++),
        };

        // Reparent preserving world transform — the tile stays put for this frame,
        // then the animator slides it to its slot while the bar carries it cameraward.
        this.attach(grid);

        // The dock reacts to the tile actually changing size (grip-resize, terminal.resize,
        // CLI) — just re-place it (reflowTile reads the new extent live). Terminals expose
        // onResize; grids that don't simply never refresh.
        entry.unsubscribeResize = grid.onResize?.(() => this.reflowTile(id)) ?? null;

        // Register as chrome so the camera's dynamic-speed / fit-all sampling skips it
        // (a tile pinned ahead of the camera would otherwise brake every move).
        this.tiles.add(grid);

        this.entries.set(id, entry);
        this.attentionManager?.docks?.set(id, {
            anchor: 'camera',
            offset: { slot: entry.slot },
            ts: (typeof performance !== 'undefined' ? performance.now() : 0),
        });

        // Paint the window's identity hue onto its panel edge — the in-shader border (no extra
        // object). The DOCKED bit makes it show; it wears this hue while docked, release() clears it.
        grid.setBorder?.({ color: entry.ghostColor, width: this.borderWidth, intensity: this.borderStrength });
        grid.setBorderFlag?.(BORDER_FLAGS.DOCKED, true);

        this._relayout();
        return true;
    }

    /**
     * Undock a window: reparent it back to its home (world-preserving) and animate
     * it back to its home transform. Re-packs the remaining tiles.
     * @param {string} id
     * @returns {boolean}
     */
    release(id) {
        const e = this.entries.get(id);
        if (!e) return false;

        e.unsubscribeResize?.(); // stop reacting to its size once it leaves the dock
        e.grid.setBorderFlag?.(BORDER_FLAGS.DOCKED, false); // drop the dock identity — leaving the bar
        this.entries.delete(id);
        this.tiles.delete(e.grid); // back to world content for the camera the moment it heads home
        if (this.focusedId === id) { this.focusedId = null; e.grid?.setControlActive?.('pin', false); }
        this.attentionManager?.docks?.delete(id);

        // Home parent may have been pruned (file closed while docked) — fall back to
        // the scene (this bar's own parent) so the window is never orphaned.
        const parent = (e.homeParent && reachesScene(e.homeParent)) ? e.homeParent : this.parent;
        (parent || this.parent)?.attach?.(e.grid);

        e.quatTarget.copy(e.home.quat);
        this._releasing.set(id, e);

        this.animator.animateTo(e.grid, 'position', e.home.pos, { duration: this.animDur });
        this.animator.animateTo(e.grid, 'scale', e.home.scale, {
            duration: this.animDur,
            onComplete: () => { this._releasing.delete(id); },
        });

        this._relayout();
        return true;
    }

    /**
     * Dismiss a tile whose window is GONE (closed/disposed) — the clean-removal counterpart to
     * release(). Unlike release() it does NOT send the grid home (there's no live grid to send): it
     * drops the entry, lifts the orphan object out of the bar, clears focus if it held it, and
     * re-packs the survivors. This is how the dock "handles its own removal" — see pruneDismissed.
     * @param {string} id @returns {boolean}
     */
    dismiss(id) {
        const e = this.entries.get(id);
        if (!e) return false;

        e.unsubscribeResize?.();
        this.entries.delete(id);
        this._releasing.delete(id);            // abandon any in-flight release of the same id
        this.tiles.delete(e.grid);
        if (this.focusedId === id) { this.focusedId = null; e.grid?.setControlActive?.('pin', false); }
        this.attentionManager?.docks?.delete(id);

        // The grid is being disposed, so stop any tween still writing to it and lift it out of the
        // bar's children. dispose() couldn't: a DOCKED grid's parent is THIS node (reparented on
        // lock), not its origin scene, so the grid's own scene.remove(this) was a no-op — exactly
        // why a closed-while-docked window left an orphan the dock kept animating every frame.
        this.animator.cancelAll(e.grid);
        if (e.grid && e.grid.parent === this) this.remove(e.grid);

        this._relayout();                      // re-pack the survivors (no-op when empty)
        return true;
    }

    /**
     * Self-heal: dismiss any docked tile whose window is no longer live. Driven by the registry's
     * change event, so closing a window ANY way (terminal.kill→close, grid.remove, scene clear)
     * cascades to the dock without the closer needing to know the window was docked.
     * @param {(id:string)=>boolean} isLive returns true while a window id is still registered
     */
    pruneDismissed(isLive) {
        for (const id of [...this.entries.keys()]) {
            if (!isLive(id)) this.dismiss(id);
        }
    }

    /**
     * Dock if loose, release if docked.
     * @param {string} id @param {Object} grid @returns {'locked'|'released'}
     */
    toggle(id, grid) {
        if (this.entries.has(id)) { this.release(id); return 'released'; }
        this.lock(id, grid); return 'locked';
    }

    /** @param {'linear'|'radial'} mode */
    setLayout(mode) {
        if (mode !== 'linear' && mode !== 'radial') return false;
        this.layoutMode = mode;
        this._relayout();
        return true;
    }

    // ===================== layout & tick =====================

    /** The slot box for an entry, in dock-local world units: height = boxFrac·viewH,
     *  width = height·boxAspect. Per-entry boxFrac/boxAspect override the dock defaults —
     *  the "configurable bounding volume" a window can ask for. */
    _boxFor(e) {
        const h = this._viewH * (e.boxFrac ?? this.boxFrac);
        return { w: h * (e.boxAspect ?? this.boxAspect), h };
    }

    /** The entry's content extent, derived LIVE from the grid (never a cached delta). @returns
     *  {{h:number,cx:number,cy:number,cz:number}} */
    _extentOf(e) { return extentFromBox(e.grid.getLocalBounds?.()) || e._extentFallback; }

    /** Contain-fit: the EFFECTIVE (rendered) scale that sits an entry's natural content INSIDE
     *  box (w,h) with aspect preserved — tall content pillarboxes, wide content letterboxes.
     *  The footprint stays the box; only the content shrinks, never the slot. This is a RENDERED
     *  scale (it ignores zoom), so the bar shows box-fit no matter what zoom is dialed in. */
    _containScale(e, box) {
        const ext = this._extentOf(e);
        const nW = Math.max(2 * Math.abs(ext.cx), 1e-3); // local content width (top-left anchored)
        const nH = Math.max(ext.h, 1e-3);
        return Math.min(box.w / nW, box.h / nH);
    }

    /** The uniform zoom an entry's grid carries (the ScaleModel `user` scalar); 1 when absent.
     *  The dock works in RENDERED scale, so it divides this out of the placement it animates
     *  (the animator re-applies it via resolve) — see _animateTile. */
    _userOf(e) { return (e.grid.scaleModel && e.grid.scaleModel.user.x) || 1; }

    /** The ROOT view-frame as a dock-LOCAL box at the dock plane: a rect of the camera frustum
     *  (frameW×frameH of it), centered at the (frameX,frameY) offsets, then inset by the FOUR
     *  per-side margins. Asymmetric margins both shrink AND re-center the inner box — a bigger left
     *  margin shifts it right, a bigger bottom margin shifts it up — so the sliders hand-place the
     *  pane. A pinned/spotlit window contain-fits INTO this. Frustum-normalized (viewW/viewH), so it
     *  tracks the drawing-frame size live — update() refits the occupant when the canvas resizes.
     *  This is the seam future SUBFRAMES partition. @returns {{cx:number,cy:number,w:number,h:number}} */
    _frameRect() {
        const cl = (v) => Math.min(Math.max(v, 0), 0.49); // keep w,h positive whatever the sliders say
        const mL = cl(this.frameMarginLeft), mR = cl(this.frameMarginRight);
        const mT = cl(this.frameMarginTop), mB = cl(this.frameMarginBottom);
        const outerW = this._viewW * this.frameW, outerH = this._viewH * this.frameH;
        return {
            cx: (this._viewW * 0.5) * this.frameX + outerW * (mL - mR) * 0.5,
            cy: (this._viewH * 0.5) * this.frameY + outerH * (mB - mT) * 0.5,
            w: outerW * (1 - mL - mR),
            h: outerH * (1 - mT - mB),
        };
    }

    /** Place the frame occupant (the pinned/spotlit window): contain-fit the WHOLE window into the
     *  root frame rect (margin + offset), centered, pulled toward the eye (frameDistFrac) so it
     *  renders over the bar. Size is a PURE FUNCTION of (frustum, frame rect, live grid extent) —
     *  zoom is DIVIDED OUT (_animateTile re-divides user), so the frame owns the size and the window
     *  always sits wholly inside its pane (no zoom bleed past the edges; tall files pillarbox, wide
     *  terminals letterbox). A resize / cols change reshapes content inside the unchanged pane. */
    _placeFrame(e) {
        const fd = this.frameDistFrac;
        const r = this._frameRect();
        const ext = this._extentOf(e);
        const contentW = Math.max(2 * Math.abs(ext.cx), 1e-3); // top-left-anchored content width
        const contentH = Math.max(ext.h, 1e-3);
        const eff = Math.min(r.w / contentW, r.h / contentH) * fd; // contain-fit, depth-compensated
        this._animateTile(e, r.cx * fd, r.cy * fd, this.distance * (1 - fd), eff);
        const d = this.attentionManager?.docks?.get(e.id);
        if (d) d.offset = { slot: 'frame' };
    }

    /** Lazily build the focus placeholder: a slot-box outline. One per dock (at most one tile is
     *  focused), reused across spotlights. A HUD affordance — depth-test off, drawn over the tiles,
     *  pick-inert (isMarker). @private */
    _ensureGhost() {
        if (this._ghost) return this._ghost;

        const boxMat = new THREE.LineBasicMaterial({ color: this.ghostColor });
        boxMat.transparent = true; boxMat.depthTest = false; boxMat.depthWrite = false;

        // Unit rectangle (XY plane, centered) as a closed line loop — scaled to the slot box each
        // relayout, so a single geometry serves any box size.
        const r = 0.5;
        const boxGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-r, -r, 0), new THREE.Vector3(r, -r, 0),
            new THREE.Vector3(r, r, 0), new THREE.Vector3(-r, r, 0), new THREE.Vector3(-r, -r, 0),
        ]);
        const box = new THREE.Line(boxGeo, boxMat);
        box.name = 'dock-focus-ghost';
        box.renderOrder = GHOST_RENDER_ORDER;
        box.userData.isMarker = true;
        this.add(box);

        this._ghost = { box, boxMat };
        return this._ghost;
    }

    /** Stand the placeholder in the focused tile's held-open slot. boxW/boxH are the slot-box dims
     *  (the tile's footprint); faceDir tilts the outline to face the eye like the tile did
     *  (null = flat, for the linear row); color is the focused window's identity hue, so the
     *  placeholder matches that window's panel border. @private */
    _showGhost(slot, boxW, boxH, faceDir, color) {
        const g = this._ensureGhost();
        g.box.visible = true;
        g.box.position.set(slot.x, slot.y, slot.z);
        g.box.scale.set(boxW, boxH, 1);
        if (faceDir) g.box.quaternion.setFromUnitVectors(_z, faceDir);
        else g.box.quaternion.identity();
        g.boxMat.color.set(color ?? this.ghostColor);
    }

    /** Hide the placeholder (nothing focused). @private */
    _hideGhost() { if (this._ghost) this._ghost.box.visible = false; }

    /** @private — free the placeholder's geometry + material. */
    _disposeGhost() {
        const g = this._ghost;
        if (!g) return;
        this.remove(g.box);
        g.box.geometry.dispose();
        g.boxMat.dispose();
        this._ghost = null;
    }

    /** Animate one tile so its CONTENT CENTER sits at (sx,sy,sz) at the RENDERED scale `eff`.
     *  The top-anchored origin is offset off the visual center by centerOffset·eff (rotated to
     *  match the tile's facing), so the center lands on (sx,sy,sz) at any zoom. `faceDir`
     *  (dock-local, toward the eye) tilts the tile to face the POV on the arc/dome; null squares
     *  it flat (linear row, focus area).
     *
     *  The 'scale' animation drives ScaleModel.placement (the animator resolve()s placement·user,
     *  per SpatialAnimator), so to LAND the rendered scale at `eff` we target placement = eff/user.
     *  That makes `eff` the single source of truth for on-screen size — the box-fit the bar wants
     *  (zoom divided out) or the zoom-applied size focus wants (zoom multiplied into eff). */
    _animateTile(e, sx, sy, sz, eff, faceDir = null) {
        if (faceDir) e.quatTarget.setFromUnitVectors(_z, faceDir);
        else e.quatTarget.identity();

        const ext = this._extentOf(e);
        _off.set(ext.cx * eff, ext.cy * eff, ext.cz * eff)
            .applyQuaternion(e.quatTarget);
        const target = { x: sx - _off.x, y: sy - _off.y, z: sz - _off.z };
        this.animator.animateTo(e.grid, 'position', target, { duration: this.animDur });
        this.animator.animateTo(e.grid, 'scale', eff / this._userOf(e), { duration: this.animDur });
    }

    /** Pack the bar tiles into a row (or dome) of fixed-size slot boxes and place the
     *  focused tile (if any) in the focus area. The focused tile is excluded from the row.
     *  Each tile contain-fits its slot box, so footprint == box (uniform unless per-entity
     *  overridden), independent of content size or zoom — the row packs as an even icon
     *  strip and nothing slides off the sides. */
    _relayout() {
        // Sort by `order` (the stable per-tile sort key), NOT raw Map insertion order — so a tile
        // that re-adopted late on restore still sits in its saved position rather than at the end.
        // Interactive locks get a monotonic order == lock sequence, so this is a no-op reorder there.
        const all = [...this.entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (all.length === 0) { this._hideGhost(); return; }

        // Slot = each tile's position in the (order-sorted) entry set — assigned in THIS one place,
        // before the bar/focus split, so every tile gets a UNIQUE label (focused included).
        // Previously the bar renumbered 0..n-1 while the spotlit tile kept a stale number → two
        // tiles could share a slot, and a shadowed tile silently ate its sibling's hover/wheel.
        // Slots are LABELS (dock.list + session order); placement is by bar geometry / this sorted
        // order, never by a stale e.slot — so numbering here changes no placement, only kills the
        // collision and pins the saved sequence.
        all.forEach((e, i) => { e.slot = i; });

        // The focused tile keeps its slot RESERVED — neighbors don't shift when it lifts out. Every
        // entry takes a bar slot; only the focused one renders as a ghost outline (a placeholder for
        // where it returns) instead of the live grid. So `bar` is the full set and the placement
        // branches per tile, rather than excluding the focused tile from packing.
        const focused = this.focusedId ? this.entries.get(this.focusedId) : null;
        const bar = all;

        const rowY = -this._viewH * 0.5 * this.bottomFrac; // tile-CENTER row
        const gap = (this._viewH * this.boxFrac) * this.gapFrac;

        // ---- bar row ----
        const n = bar.length;
        if (n > 0) {
            // Each tile's FIXED slot box + the contain-fit scale that sits its content inside.
            // The BOX is the packing footprint (uniform unless per-entity overridden); the
            // content scale is whatever fits — never the other way around. Zoom does NOT enter
            // here (it lives at home/focus), so a zoomed-up tile never bloats the bar.
            const boxes = bar.map((e) => this._boxFor(e));
            let scales = bar.map((e, i) => this._containScale(e, boxes[i]));
            let widths = boxes.map((b) => b.w);

            if (this.layoutMode === 'radial') {
                // Hemispherical: slot boxes ride a sphere of radius `distance` centered on the
                // POV, each tilted to face the eye. flowBoxes grids the boxes (few → an arc,
                // more → a dome). The planar grid is wrapped onto the sphere — x → azimuth,
                // height-above-bottom → elevation (angle = arc length / R) — and bottom-anchored
                // at the same place the bar sits (phiBase = rowY/R).
                const R = this.distance;
                const maxAz = this.maxArcDeg * DEG2RAD, maxEl = this.maxRiseDeg * DEG2RAD;
                const sizes = boxes.map((b) => ({ w: b.w, h: b.h }));
                // Wrap rule: fill a row up to the wrap width, then wrap UP into the next row —
                // few = a single arc, many = a dome. maxColumns caps tiles per row (a representative
                // box width sets the count threshold); 0 = auto, bounded only by the arc. The arc
                // (maxAz·R) is always the ceiling so a high column cap can't overrun the hemisphere.
                const cols = Math.floor(this.maxColumns);
                const defBoxW = this._viewH * this.boxFrac * this.boxAspect;
                const wrapWidth = Math.min(cols > 0 ? cols * (defBoxW + gap) : Infinity, maxAz * R);
                const { slots, width: W, height: H } = flowBoxes(sizes, {
                    margin: gap, wrapWidth, serpentine: false,
                });

                // Azimuth is already bounded by wrapWidth; only shrink if the dome grew
                // too TALL (too many rows → elevation span > maxEl).
                const f = Math.min(1, (maxEl * R) / H);
                const phiBase = rowY / R; // bottom row sits where the linear bar sits

                bar.forEach((e, i) => {
                    const s = slots[i];
                    const th = (((s.x + sizes[i].w * 0.5) - W * 0.5) * f) / R;       // azimuth, centered
                    const phi = phiBase + (((s.y - sizes[i].h * 0.5) + H) * f) / R;  // elevation, bottom-anchored
                    const cs = Math.cos(phi);
                    const sx = R * Math.sin(th) * cs;
                    const sy = R * Math.sin(phi);
                    const sz = R * (1 - Math.cos(th) * cs);
                    _dir.set(-sx, -sy, R - sz).normalize();                          // toward the eye (0,0,R)
                    if (e === focused) {
                        this._showGhost({ x: sx, y: sy, z: sz }, boxes[i].w * f, boxes[i].h * f, _dir, focused.ghostColor);
                    } else {
                        this._animateTile(e, sx, sy, sz, scales[i] * f, _dir);
                        const d = this.attentionManager?.docks?.get(e.id);
                        if (d) d.offset = { slot: e.slot };
                    }
                });
            } else {
                // Linear row, centered on x=0. Fit-to-width still guards genuine overflow (too
                // many boxes to fit), but it now fires only on COUNT — never because one tile's
                // content or zoom is wide — so adding a wide tile no longer snaps the whole row.
                const availW = this._viewW * this.fillFrac;
                const tilesW = widths.reduce((a, w) => a + w, 0);
                const gapsW = gap * (n - 1);
                if (tilesW + gapsW > availW) {
                    const f = Math.max(0.1, (availW - gapsW) / tilesW);
                    scales = scales.map((s) => s * f);
                    widths = widths.map((w) => w * f);
                }
                const totalW = widths.reduce((a, w) => a + w, 0) + gap * (n - 1);
                let cx = -totalW * 0.5;
                bar.forEach((e, i) => {
                    const sx = cx + widths[i] * 0.5;
                    cx += widths[i] + gap;
                    if (e === focused) {
                        // Slot box shrinks with the fit-to-width factor too (widths[i] already has it).
                        const boxH = boxes[i].h * (widths[i] / Math.max(boxes[i].w, 1e-9));
                        this._showGhost({ x: sx, y: rowY, z: 0 }, widths[i], boxH, null, focused.ghostColor);
                    } else {
                        this._animateTile(e, sx, rowY, 0, scales[i]);
                        const d = this.attentionManager?.docks?.get(e.id);
                        if (d) d.offset = { slot: e.slot };
                    }
                });
            }
        }

        // ---- frame occupant (contain-fit into the root view-frame, pulled in front of the bar) ----
        if (focused) this._placeFrame(focused);
        else this._hideGhost();
    }

    /**
     * Re-place a docked tile after a size or zoom change — the grid.onResize tap and window.scale
     * both land here. There is no size math to do: the FRAME occupant re-contain-fits into the root
     * view-frame and the BAR tile re-contains into its FIXED slot box, BOTH reading the grid's
     * current extent live (_extentOf). So a resize reshapes the content inside an unchanged
     * pane/slot, idempotently — no cached delta to desync, no rendered-scale read-back, no toggle snap.
     * @param {string} id
     * @returns {boolean}
     */
    reflowTile(id) {
        const e = this.entries.get(id);
        if (!e) return false;
        if (id === this.focusedId) this._placeFrame(e);
        else this._relayout();
        return true;
    }

    /**
     * Per-frame: park the bar ahead of the camera, advance animations, and slerp
     * each tile toward its target orientation. Call from the render loop.
     * @param {number} dt seconds
     * @param {Object} camera active THREE camera
     */
    update(dt, camera) {
        if (camera) {
            const fov = (camera.fov || 70) * Math.PI / 180;
            const vh = 2 * this.distance * Math.tan(fov * 0.5);
            const vw = vh * (camera.aspect || 1.6);
            // The frame + bar are frustum-normalized; refit the live tiles when the DRAWING FRAME
            // changes size (browser/canvas resize, fov change) so a pinned window stays locked to
            // the canvas. Camera MOVEMENT doesn't trip this (viewW/H are position-independent).
            const resized = Math.abs(vh - this._viewH) > 1e-3 || Math.abs(vw - this._viewW) > 1e-3;
            this._viewH = vh;
            this._viewW = vw;

            _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
            this.position.copy(camera.position).addScaledVector(_forward, this.distance);
            this.quaternion.copy(camera.quaternion);

            if (resized && this.entries.size) this._relayout();
        }

        this.animator.update(dt);

        const rate = Math.min(1, dt * this.yawRate); // crisp yaw to match the curter slide
        for (const e of this.entries.values()) e.grid.quaternion.slerp(e.quatTarget, rate);
        for (const e of this._releasing.values()) e.grid.quaternion.slerp(e.quatTarget, rate);

        this._tickGhost(dt);
    }

    /** Advance the focus placeholder's breathe — the outline pulses gently below ghostOpacity.
     *  Driven here, not by the SpatialAnimator: it's a steady cosmetic cycle, not a one-shot tween. */
    _tickGhost(dt) {
        this._ghostClock += dt;
        const g = this._ghost;
        if (!g || !g.box.visible) return;
        const breathe = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(this._ghostClock * GHOST_PULSE_HZ * 2 * Math.PI));
        g.boxMat.opacity = this.ghostOpacity * breathe;
    }

    dispose() {
        this.animator.dispose();
        this._disposeGhost();
        this.entries.clear();
        this._releasing.clear();
        this.tiles.clear();
        this.focusedId = null;
    }
}

export default CameraDock;
