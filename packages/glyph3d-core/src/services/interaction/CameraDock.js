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
     * @param {number} [opts.distance=40]   - world units ahead of the camera the bar sits
     * @param {number} [opts.tileFrac=0.16] - tile height as a fraction of the visible height
     * @param {number} [opts.bottomFrac=0.74] - row depth: 0 = view center, 1 = bottom edge
     * @param {'linear'|'radial'} [opts.layout='linear']
     */
    constructor({ attentionManager = null, distance = 40, tileFrac = 0.18, bottomFrac = 0.66,
                  focusFrac = 0.5, focusY = 0.06, focusDistFrac = 0.7, animDur = 0.22, layout = 'radial' } = {}) {
        super();
        this.name = 'camera-dock';
        this.attentionManager = attentionManager;
        this.distance = distance;
        this.tileFrac = tileFrac;
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

    /** @returns {Array<{id:string, slot:number, layout:string, focused:boolean}>} */
    list() {
        return [...this.entries.values()].map((e) => ({
            id: e.id, slot: e.slot, layout: this.layoutMode, focused: e.id === this.focusedId,
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
     * Tune a layout parameter live and re-pack. Keys: distance, tileFrac, bottomFrac.
     * @param {string} key @param {number} value @returns {boolean}
     */
    setParam(key, value) {
        if (!['distance', 'tileFrac', 'bottomFrac', 'focusFrac', 'focusY', 'focusDistFrac', 'animDur'].includes(key)) return false;
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
        const homeScale = grid.scale.x || 1;
        const hasBounds = b && !b.isEmpty?.();
        const worldH = hasBounds ? (b.max.y - b.min.y) : 10;

        // Grids are top-anchored (origin at top-left; content flows down/right), so the
        // origin is NOT the visual center. Capture the origin→bounds-center vector in the
        // window's own units (scale 1) so _relayout can place the tile's CENTER in its slot
        // at any scale: targetOrigin = slotCenter − centerOffset·tileScale.
        let centerOffset = { x: 0, y: 0, z: 0 };
        if (hasBounds) {
            const origin = grid.getWorldPosition(new THREE.Vector3());
            const center = b.getCenter(new THREE.Vector3());
            centerOffset = {
                x: (center.x - origin.x) / homeScale,
                y: (center.y - origin.y) / homeScale,
                z: (center.z - origin.z) / homeScale,
            };
        }

        const entry = {
            id,
            grid,
            homeParent: grid.parent || null,
            home: {
                pos: { x: grid.position.x, y: grid.position.y, z: grid.position.z },
                scale: homeScale,
                quat: grid.quaternion.clone(),
            },
            naturalH: Math.max(worldH / homeScale, 1e-3),
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

    /** Animate one tile so its CENTER sits at (sx,sy,sz) at a uniform-height scale.
     *  `faceDir` (dock-local, toward the eye) tilts the tile to face the POV — used on
     *  the arc/dome; null squares it flat to the bar (linear row, focus area). Origin =
     *  center − R·(centerOffset·scale): grids are top-anchored, so the origin sits off
     *  the visual center, and that offset rotates with the tile's orientation. */
    _animateTile(e, sx, sy, sz, scale, faceDir = null) {
        if (faceDir) e.quatTarget.setFromUnitVectors(_z, faceDir);
        else e.quatTarget.identity();

        _off.set(e.centerOffset.x * scale, e.centerOffset.y * scale, e.centerOffset.z * scale)
            .applyQuaternion(e.quatTarget);
        const target = { x: sx - _off.x, y: sy - _off.y, z: sz - _off.z };
        this.animator.animateTo(e.grid, 'position', target, { duration: this.animDur });
        this.animator.animateTo(e.grid, 'scale', scale, { duration: this.animDur });
    }

    /** Pack the bar tiles into a row and place the focused tile (if any) in the
     *  focus area (centered + enlarged). The focused tile is excluded from the row. */
    _relayout() {
        const all = [...this.entries.values()];
        if (all.length === 0) return;

        const focused = this.focusedId ? this.entries.get(this.focusedId) : null;
        const bar = all.filter((e) => e !== focused);

        const tileH = this._viewH * this.tileFrac;
        const rowY = -this._viewH * 0.5 * this.bottomFrac; // tile-CENTER row

        // ---- bar row ----
        const n = bar.length;
        if (n > 0) {
            // Per-tile scale (uniform height) and world width (centerOffset.x is the
            // half-width in window units, so width = 2·|cx|·scale).
            let scales = bar.map((e) => tileH / e.naturalH);
            let widths = bar.map((e, i) => Math.max(2 * Math.abs(e.centerOffset.x) * scales[i], tileH * 0.4));
            const gap = tileH * 0.3;

            if (this.layoutMode === 'radial') {
                // Hemispherical: tiles ride a sphere of radius `distance` centered on the
                // POV, each tilted to face the eye. Placement is GRIDDED through flowBoxes
                // (the packing DSL): few tiles → one row (an arc), more → multiple rows
                // (a dome), automatically. The planar grid is wrapped onto the sphere —
                // x → azimuth, height-above-bottom → elevation (angle = arc length / R) —
                // and bottom-anchored at the same place the bar sits (phiBase = rowY/R).
                const R = this.distance;
                const maxAz = Math.PI * 0.85, maxEl = Math.PI * 0.45;
                const sizes = widths.map((w) => ({ w, h: tileH }));
                // Wrap at the max azimuth arc: tiles fill one row up to that width, then
                // wrap UP into the next row — few tiles = a single arc, many = a dome.
                const { slots, width: W, height: H } = flowBoxes(sizes, {
                    margin: gap, wrapWidth: maxAz * R, serpentine: false,
                });

                // Azimuth is already bounded by wrapWidth; only shrink if the dome grew
                // too TALL (too many rows → elevation span > maxEl).
                const f = Math.min(1, (maxEl * R) / H);
                const phiBase = rowY / R; // bottom row sits where the linear bar sits

                bar.forEach((e, i) => {
                    e.slot = i;
                    const s = slots[i];
                    const th = (((s.x + sizes[i].w * 0.5) - W * 0.5) * f) / R;     // azimuth, centered
                    const phi = phiBase + (((s.y - tileH * 0.5) + H) * f) / R;     // elevation, bottom-anchored
                    const cs = Math.cos(phi);
                    const sx = R * Math.sin(th) * cs;
                    const sy = R * Math.sin(phi);
                    const sz = R * (1 - Math.cos(th) * cs);
                    _dir.set(-sx, -sy, R - sz).normalize();                        // toward the eye (0,0,R)
                    this._animateTile(e, sx, sy, sz, scales[i] * f, _dir);
                    const d = this.attentionManager?.docks?.get(e.id);
                    if (d) d.offset = { slot: i };
                });
            } else {
                // Linear row, centered on x=0. Fit-to-width: shrink tiles so the row
                // never overruns the viewport (gaps fixed, subtracted first → exact fit).
                const availW = this._viewW * 0.88;
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
                    e.slot = i;
                    const sx = cx + widths[i] * 0.5;
                    cx += widths[i] + gap;
                    this._animateTile(e, sx, rowY, 0, scales[i]);
                    const d = this.attentionManager?.docks?.get(e.id);
                    if (d) d.offset = { slot: i };
                });
            }
        }

        // ---- focus area: centered + enlarged, and pulled toward the eye so it always
        //      renders in front of the dock sphere (and the scene). focusDistFrac<1 sits
        //      it at that fraction of `distance`; scale and screen-y scale by it too, so
        //      it looks identical — just nearer, so plain depth-testing puts it on top.
        if (focused) {
            const fd = this.focusDistFrac;
            const scale = (this._viewH * this.focusFrac / focused.naturalH) * fd;
            this._animateTile(focused, 0, this._viewH * this.focusY * fd, this.distance * (1 - fd), scale);
            const d = this.attentionManager?.docks?.get(focused.id);
            if (d) d.offset = { slot: 'focus' };
        }
    }

    /**
     * React to a docked tile changing size (subscribed via grid.onResize at lock).
     * Cell metrics are constant, so the natural extent scales linearly with the cell
     * grid — scale naturalH/centerOffset by the col/row ratio rather than re-measuring
     * the world AABB (which the tile's eye-facing rotation would distort). A BAR tile
     * re-packs (fit stays bounded); the FOCUSED tile grows in place at its current
     * scale (re-centered so it expands from the middle), so a live grip-drag visibly
     * upsizes it on the fly instead of being re-pinned to the focus fraction.
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

        if (id === this.focusedId) {
            const scale = e.grid.scale.x || 1; // free-grow: keep scale, re-center on the focus point
            this._animateTile(e, 0, this._viewH * this.focusY * this.focusDistFrac,
                              this.distance * (1 - this.focusDistFrac), scale);
        } else {
            this._relayout();
        }
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

        const rate = Math.min(1, dt * 14); // crisp yaw to match the curter slide
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
