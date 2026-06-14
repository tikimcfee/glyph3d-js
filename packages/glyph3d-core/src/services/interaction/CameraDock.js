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
 * @property {number} naturalH    - world height at scale 1 (for tile-scale math)
 * @property {number|null} focusHeightFrac - focus-slot size INTENT: the tile's target
 *   apparent height in the focus area, as a fraction of the view. null = a never-grown
 *   tile that follows the live global `focusFrac`. A resize done WHILE FOCUSED bumps it
 *   (free-grow), so the grown size is recorded here and survives a focus toggle instead
 *   of being re-derived from the rendered transform.
 * @property {number} slot
 * @property {THREE.Quaternion} quatTarget - orientation the tile slerps toward
 */

import * as THREE from 'three';
import { SpatialAnimator } from '../spatial/SpatialAnimator.js';
import { flowBoxes } from '../../collections/layouts/flowBoxes.js';

const _forward = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _off = new THREE.Vector3();
const DEG2RAD = Math.PI / 180;

/** Walk up the parent chain to confirm an object still reaches a live Scene. */
function reachesScene(obj) {
    let o = obj;
    while (o) {
        if (o.isScene) return true;
        o = o.parent;
    }
    return false;
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
     * @param {number} [opts.yawRate=14]    - tile face-the-eye slerp rate (×dt)
     * @param {'linear'|'radial'} [opts.layout='radial']
     */
    constructor({ attentionManager = null, distance = 10, boxFrac = 0.1, boxAspect = 1.15, gapFrac = 0.4,
                  maxColumns = 0, fillFrac = 0.9, maxArcDeg = 80, maxRiseDeg = 80, bottomFrac = 0.86,
                  focusFrac = 0.62, focusY = 0.06, focusDistFrac = 0.7, animDur = 0.167, yawRate = 14,
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
        this.focusFrac = focusFrac;   // focus-area tile height as a fraction of the visible height
        this.focusY = focusY;         // focus-area center: fraction of viewH above the view center
        this.focusDistFrac = focusDistFrac; // focus tile sits this fraction of `distance` from the
                                            // eye — <1 pulls it IN FRONT of the dock sphere so it
                                            // always renders on top (scale/y compensate, so it
                                            // looks identical, just nearer)
        this.animDur = animDur;       // tile slide/scale duration (s) — a curt, polite snap
        this.layoutMode = layout;     // 'radial' (hemisphere, default) | 'linear'

        /** The tile currently raised into the focus area (centered + enlarged, still
         *  camera-locked), or null. Toggled by spotlight(); excluded from bar packing. */
        this.focusedId = null;

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
        return [...this.entries.values()].map((e) => ({
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
        if (this.focusedId === id) { this.focusedId = null; this._relayout(); return 'returned'; }
        this.focusedId = id;
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
     * maxColumns, fillFrac, maxArcDeg, maxRiseDeg, bottomFrac, focusFrac, focusY, focusDistFrac,
     * animDur, yawRate.
     * @param {string} key @param {number} value @returns {boolean}
     */
    setParam(key, value) {
        if (!['distance', 'boxFrac', 'boxAspect', 'gapFrac', 'maxColumns', 'fillFrac', 'maxArcDeg',
              'maxRiseDeg', 'bottomFrac', 'focusFrac', 'focusY', 'focusDistFrac', 'animDur',
              'yawRate'].includes(key)) return false;
        if (!Number.isFinite(value)) return false;
        this[key] = value;
        this._relayout();
        return true;
    }

    /**
     * Dock a window: capture its home, reparent it under the bar (world-preserving),
     * and animate it into its slot at tile scale.
     * @param {string} id  registry id
     * @param {Object} grid live Object3D with getBounds()
     * @returns {boolean}
     */
    lock(id, grid) {
        if (!grid || this.entries.has(id)) return false;

        // World bounds BEFORE reparent/scale: tile scale is computed against the
        // window's natural size (getBounds is world-space, includes current scale).
        const b = grid.getBounds?.();
        // The RESOLVED world scale (placement · user) is what getBounds reflects, so it
        // is the divisor that brings measurements back to user-free LOCAL units — both
        // naturalH and centerOffset. The home PLACEMENT (user-free) is what release
        // animates back to; resolve() re-applies the persisted zoom on top.
        const resolvedScale = grid.scale.x || 1;
        const homePlacement = grid.scaleModel ? grid.scaleModel.placement : resolvedScale;
        const hasBounds = b && !b.isEmpty?.();
        const worldH = hasBounds ? (b.max.y - b.min.y) : 10;

        // Grids are top-anchored (origin at top-left; content flows down/right), so the
        // origin is NOT the visual center. Capture the origin→bounds-center vector in the
        // window's own LOCAL units (user/placement divided out) so _relayout can place
        // the tile's CENTER in its slot at any scale: targetOrigin = slotCenter −
        // centerOffset·(placement·user). _animateTile re-applies that effective scale.
        let centerOffset = { x: 0, y: 0, z: 0 };
        if (hasBounds) {
            const origin = grid.getWorldPosition(new THREE.Vector3());
            const center = b.getCenter(new THREE.Vector3());
            centerOffset = {
                x: (center.x - origin.x) / resolvedScale,
                y: (center.y - origin.y) / resolvedScale,
                z: (center.z - origin.z) / resolvedScale,
            };
        }

        const entry = {
            id,
            grid,
            homeParent: grid.parent || null,
            home: {
                pos: { x: grid.position.x, y: grid.position.y, z: grid.position.z },
                scale: homePlacement, // release animates PLACEMENT home; resolve re-adds zoom
                quat: grid.quaternion.clone(),
            },
            naturalH: Math.max(worldH / resolvedScale, 1e-3),
            // Focus-slot size intent. null until the tile is grown while focused, so a fresh
            // tile spotlights at the live global focusFrac; free-grow records the grown size here.
            focusHeightFrac: null,
            centerOffset,
            // Cell-grid dimensions at lock — refreshTile scales naturalH/centerOffset by
            // the col/row ratio when the tile resizes (cell metrics are constant, so the
            // natural extent scales linearly with the grid), avoiding a world-AABB
            // re-measure that the tile's eye-facing rotation would corrupt.
            dims: { cols: grid.cols ?? 0, rows: grid.rows ?? 0 },
            unsubscribeResize: null,
            // The world AABB the window had at home, captured before docking — dock.focus
            // frames THIS (computed, stable) rather than the tile's live mid-slide bounds.
            homeBounds: hasBounds ? b.clone() : null,
            slot: this.entries.size,
            quatTarget: new THREE.Quaternion(),
        };

        // Reparent preserving world transform — the tile stays put for this frame,
        // then the animator slides it to its slot while the bar carries it cameraward.
        this.attach(grid);

        // The dock reacts to the tile actually changing size (grip-resize, terminal.resize,
        // CLI) — re-pack so a resized tile never overlaps the bar and a focused tile grows
        // in place. Terminals expose onResize; grids that don't simply never refresh.
        entry.unsubscribeResize = grid.onResize?.((c, r) => this.refreshTile(id, c, r)) ?? null;

        // Register as chrome so the camera's dynamic-speed / fit-all sampling skips it
        // (a tile pinned ahead of the camera would otherwise brake every move).
        this.tiles.add(grid);

        this.entries.set(id, entry);
        this.attentionManager?.docks?.set(id, {
            anchor: 'camera',
            offset: { slot: entry.slot },
            ts: (typeof performance !== 'undefined' ? performance.now() : 0),
        });

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
        this.entries.delete(id);
        this.tiles.delete(e.grid); // back to world content for the camera the moment it heads home
        if (this.focusedId === id) this.focusedId = null;
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
        if (this.focusedId === id) this.focusedId = null;
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

    /** Contain-fit: the EFFECTIVE (rendered) scale that sits an entry's natural content INSIDE
     *  box (w,h) with aspect preserved — tall content pillarboxes, wide content letterboxes.
     *  The footprint stays the box; only the content shrinks, never the slot. This is a RENDERED
     *  scale (it ignores zoom), so the bar shows box-fit no matter what zoom is dialed in. */
    _containScale(e, box) {
        const nW = Math.max(2 * Math.abs(e.centerOffset.x), 1e-3); // local content width (top-left anchored)
        const nH = Math.max(e.naturalH, 1e-3);
        return Math.min(box.w / nW, box.h / nH);
    }

    /** The uniform zoom an entry's grid carries (the ScaleModel `user` scalar); 1 when absent.
     *  The dock works in RENDERED scale, so it divides this out of the placement it animates
     *  (the animator re-applies it via resolve) — see _animateTile. */
    _userOf(e) { return (e.grid.scaleModel && e.grid.scaleModel.user.x) || 1; }

    /** Place the focused tile: centered, height-fit to the tile's TRACKED focus size, pulled
     *  toward the eye (focusDistFrac) so it renders in front of the dock sphere. This is the
     *  "read it" state — not box-bounded — so the dialed zoom DOES show here (eff = height-fit ·
     *  zoom): focus is where reading happens, the bar is where the icon sits.
     *
     *  The target height is per-window INTENT (`e.focusHeightFrac`), not the global default —
     *  so a tile spotlights at the size you last left it, and a resize/rescale done while
     *  focused survives a focus toggle. null = a never-grown tile, which follows the live global
     *  `focusFrac` (so tuning it in Settings still moves fresh tiles). Computing eff from this
     *  durable intent (not the live grid.scale.x) is what removed the resize→scale snap. */
    _placeFocus(e) {
        const fd = this.focusDistFrac;
        const heightFrac = e.focusHeightFrac ?? this.focusFrac;
        const eff = (this._viewH * heightFrac / Math.max(e.naturalH, 1e-3)) * fd * this._userOf(e);
        this._animateTile(e, 0, this._viewH * this.focusY * fd, this.distance * (1 - fd), eff);
        const d = this.attentionManager?.docks?.get(e.id);
        if (d) d.offset = { slot: 'focus' };
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

        _off.set(e.centerOffset.x * eff, e.centerOffset.y * eff, e.centerOffset.z * eff)
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
        const all = [...this.entries.values()];
        if (all.length === 0) return;

        // Slot = each tile's position in the (insertion-ordered) entry set — assigned in
        // THIS one place, before the bar/focus split, so every tile gets a UNIQUE label
        // (focused included). Previously the bar renumbered 0..n-1 while the spotlit tile
        // kept a stale number → two tiles could share a slot, and a shadowed tile silently
        // ate its sibling's hover/wheel. Slots are LABELS (dock.list + session order);
        // placement is by bar geometry / Map order, never by e.slot — so numbering here
        // changes no placement, only kills the collision.
        all.forEach((e, i) => { e.slot = i; });

        const focused = this.focusedId ? this.entries.get(this.focusedId) : null;
        const bar = all.filter((e) => e !== focused);

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
                    this._animateTile(e, sx, sy, sz, scales[i] * f, _dir);
                    const d = this.attentionManager?.docks?.get(e.id);
                    if (d) d.offset = { slot: e.slot };
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
                    this._animateTile(e, sx, rowY, 0, scales[i]);
                    const d = this.attentionManager?.docks?.get(e.id);
                    if (d) d.offset = { slot: e.slot };
                });
            }
        }

        // ---- focus area (centered + enlarged, pulled in front of the dock sphere) ----
        if (focused) this._placeFocus(focused);
    }

    /**
     * React to a docked tile changing size (subscribed via grid.onResize at lock).
     * Cell metrics are constant, so the natural extent scales linearly with the cell
     * grid — scale naturalH/centerOffset by the col/row ratio rather than re-measuring
     * the world AABB (which the tile's eye-facing rotation would distort). A BAR tile
     * re-packs (fit stays bounded); the FOCUSED tile grows in place — see below.
     * @param {string} id @param {number} cols @param {number} rows
     */
    refreshTile(id, cols, rows) {
        const e = this.entries.get(id);
        if (!e || !e.dims) return;
        const cx = e.dims.cols ? cols / e.dims.cols : 1;
        const ry = e.dims.rows ? rows / e.dims.rows : 1;
        e.naturalH = Math.max(e.naturalH * ry, 1e-3);
        e.centerOffset = { x: e.centerOffset.x * cx, y: e.centerOffset.y * ry, z: e.centerOffset.z };
        e.dims = { cols, rows };
        // FREE-GROW as recorded INTENT: a resize done WHILE FOCUSED grows the focus size with the
        // row count (focusHeightFrac ∝ naturalH → placement held → per-cell size constant → the
        // panel visibly upsizes as you drag). Storing it in the intent — not leaving it implicit
        // in the rendered scale — is what lets a focus toggle restore it instead of snapping back.
        // A bar resize leaves it untouched, so a never-grown tile keeps fitting to focusFrac.
        if (id === this.focusedId) e.focusHeightFrac = (e.focusHeightFrac ?? this.focusFrac) * ry;
        this.reflowTile(id);
    }

    /**
     * Re-place a docked tile after a size change, without a full membership pass — called by
     * refreshTile when a terminal's cell grid changes (and by window.scale). The FOCUSED tile
     * re-places from its tracked focus-size intent (`_placeFocus` reads `focusHeightFrac`), which
     * refreshTile has already grown for a resize — so free-grow happens, but it lives in the
     * intent rather than in the rendered transform. Reading grid.scale.x back as truth was the
     * resize→scale coupling: it left a size nothing recorded, so the next spotlight re-derived a
     * different one and the tile snapped. A bar tile re-contains into its FIXED slot box, so the
     * row never reshuffles on resize — only the content rescales inside the unchanged slot.
     * @param {string} id
     * @returns {boolean}
     */
    reflowTile(id) {
        const e = this.entries.get(id);
        if (!e) return false;
        if (id === this.focusedId) this._placeFocus(e);
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
            this._viewH = 2 * this.distance * Math.tan(fov * 0.5);
            this._viewW = this._viewH * (camera.aspect || 1.6);

            _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
            this.position.copy(camera.position).addScaledVector(_forward, this.distance);
            this.quaternion.copy(camera.quaternion);
        }

        this.animator.update(dt);

        const rate = Math.min(1, dt * this.yawRate); // crisp yaw to match the curter slide
        for (const e of this.entries.values()) e.grid.quaternion.slerp(e.quatTarget, rate);
        for (const e of this._releasing.values()) e.grid.quaternion.slerp(e.quatTarget, rate);
    }

    dispose() {
        this.animator.dispose();
        this.entries.clear();
        this._releasing.clear();
        this.tiles.clear();
        this.focusedId = null;
    }
}

export default CameraDock;
