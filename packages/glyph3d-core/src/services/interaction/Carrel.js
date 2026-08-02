/**
 * Carrel — a world-anchored reading desk that holds windows (code grids /
 * terminals / agent books) as live, dimensionally-scaled members.
 *
 * The CameraDock's mirror. The dock wraps tiles on a sphere around the POV and
 * rides the camera; a carrel wraps members on a cylinder around a fixed world
 * point and stays put — stand at its center and you are the camera the dock
 * orbits. Same occupancy mechanics as the dock (the SAME live Object3D,
 * `attach()`ed world-preservingly, home captured on lock and restored on
 * release, ScaleModel placement animated); the only structural difference is
 * that `update(dt)` takes no camera.
 *
 * TABLE grammar, not containment: the carrel is a surface things REST ON. The
 * local origin is the tabletop center (y=0); the first members land ON the
 * table and overflow wraps UPWARD in rows — the footprint holds its radius and
 * the stack grows taller, never wider. The arc is centered on the carrel's back
 * (local −z) so the unfilled remainder of the circle is a doorway facing +z —
 * you walk in through the gap. A soft additive glow (tabletop disc + rising
 * aura shell) marks the desk's airspace; it is decoration (userData.isMarker),
 * never picked, never a collider.
 *
 * OWNERSHIP LAW (the residence/vehicle distinction): a carrel is a RESIDENCE —
 * where content lives by choice, as the tree is where it lives by structure —
 * and the dock is a VEHICLE — how content rides with you. A residence may be
 * captured as `home` (dock.lock on a carrel member records the carrel, and the
 * tile returns here on release); a vehicle must never be. Adopting a docked
 * window therefore passes the dock's OWN captured home through `lock(...,
 * {home})` (see CameraDock.homeOf) instead of reading the tile's in-bar
 * transform — home records chain residence → residence, never through a
 * vehicle.
 *
 * A member currently ridden elsewhere (docked, or parked by the virtualizer) is
 * BORROWED: its parent is not this carrel, and the carrel keeps its entry but
 * takes its hands off the transform (no relayout placement, no yaw slerp) until
 * the object returns, at which point the next update() re-seats everyone.
 *
 * @typedef {Object} CarrelEntry
 * @property {string} id
 * @property {Object} grid - the live Object3D (CodeGrid / TerminalGrid / Book)
 * @property {Object|null} homeParent
 * @property {{pos:{x,y,z}, scale:number, quat:THREE.Quaternion}} home
 * @property {Object|null} homeBounds - world AABB at home (focus framing)
 * @property {{h:number,cx:number,cy:number,cz:number}} _extentFallback
 * @property {number} order - stable sort key (restore threads the saved value)
 * @property {number} slot  - dense 0..n-1 display rank, derived from `order`
 * @property {THREE.Quaternion} quatTarget - orientation the member slerps toward
 * @property {boolean} _borrowed - parent observed elsewhere; hands off until it returns
 */

import * as THREE from 'three';
import { SpatialAnimator } from '../spatial/SpatialAnimator.js';
import { flowBoxes } from '../../collections/layouts/flowBoxes.js';
import { RENDER_ORDER } from '../../core/renderOrder.js';

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

/** A grid's content extent in its OWN local frame (scale-free): panel width and
 *  height + the origin→center offset, from a local-frame Box3; null if empty.
 *  Width is the plain box span — anchor-agnostic, unlike the dock's 2·|cx| form,
 *  which assumes top-left-anchored content. Read LIVE each time it's needed,
 *  never cached and delta-updated (the dock's lesson). */
function extentFromBox(lb) {
    if (!lb || lb.isEmpty?.()) return null;
    return {
        w: Math.max(lb.max.x - lb.min.x, 1e-3),
        h: Math.max(lb.max.y - lb.min.y, 1e-3),
        cx: (lb.min.x + lb.max.x) * 0.5,
        cy: (lb.min.y + lb.max.y) * 0.5,
        cz: (lb.min.z + lb.max.z) * 0.5,
    };
}

export class Carrel extends THREE.Object3D {
    /**
     * @param {Object} [opts]
     * @param {string} [opts.name='carrel']  - registry name (carrel.* verbs address it)
     * @param {number} [opts.radius=240]     - cylinder radius the member faces sit at (world units)
     * @param {number} [opts.boxH=110]       - slot-box height (world units); content contain-fits.
     *   BOOK SCALE: a file grid at natural reading scale is ~96-100 wide and 100-350 tall
     *   (measured), so a ~110-unit slot seats a typical file near 1:1 — a member reads as a
     *   real book on the desk, not a dock-tile icon
     * @param {number} [opts.boxAspect=1.15] - slot-box width/height
     * @param {number} [opts.gapFrac=0.5]    - gap between slots as a fraction of boxH
     * @param {number} [opts.growCap=1.25]   - contain-fit may GROW content at most this much.
     *   Fitting means fitting INSIDE; growing is a courtesy. Without the cap, a nearly-empty
     *   member (a fresh agent book before its first sheet) measures tiny and the fit inflates
     *   it absurdly — the seated-book overlap bug
     * @param {number} [opts.maxArcDeg=300]  - arc span the ring fills; the remainder is the doorway (faces local +z)
     * @param {'in'|'out'} [opts.facing='in'] - members face the center (stand inside) or outward
     * @param {number} [opts.tableFrac=1.25] - tabletop disc radius as a fraction of `radius`
     * @param {number} [opts.auraHeadroom=40] - aura shell rise above the top row (world units)
     * @param {number} [opts.glowColor=0x6f9fd0] - chrome tint (tabletop + aura)
     * @param {number} [opts.glowStrength=0.35]  - chrome intensity (0 = chrome invisible)
     * @param {number} [opts.animDur=0.167] - member slide/scale duration (s)
     * @param {number} [opts.yawRate=14]    - member face-target slerp rate (×dt)
     */
    constructor({ name = 'carrel', radius = 240, boxH = 110, boxAspect = 1.15, gapFrac = 0.5,
                  growCap = 1.25, maxArcDeg = 300, facing = 'in', tableFrac = 1.25, auraHeadroom = 40,
                  glowColor = 0x6f9fd0, glowStrength = 0.35,
                  animDur = 0.167, yawRate = 14 } = {}) {
        super();
        this.name = `carrel:${name}`;
        this.carrelName = name;
        this.radius = radius;
        this.boxH = boxH;
        this.boxAspect = boxAspect;
        this.gapFrac = gapFrac;
        this.growCap = growCap;
        this.maxArcDeg = maxArcDeg;
        this.facing = facing === 'out' ? 'out' : 'in';
        this.tableFrac = tableFrac;
        this.auraHeadroom = auraHeadroom;
        this.glowColor = glowColor;
        this.glowStrength = glowStrength;
        this.animDur = animDur;
        this.yawRate = yawRate;

        this._orderSeq = 0;      // monotonic sort-key source (restore threads saved values past it)
        this._rows = 1;          // last layout's row count — the aura reads it for its height
        this._dissolving = false;
        /** Set once a dissolve has fully drained; the ticking runner sweeps dead carrels. */
        this._dead = false;

        this.animator = new SpatialAnimator();

        /** @type {Map<string, CarrelEntry>} members */
        this.entries = new Map();
        /** @type {Map<string, CarrelEntry>} members mid-release (kept for the slerp-home) */
        this._releasing = new Map();

        this._buildChrome();
    }

    // ===================== membership =====================

    /** @param {string} id @returns {boolean} */
    has(id) { return this.entries.has(id); }

    /** @returns {Array<{id:string, slot:number, order:number}>} sorted by slot (display rank). */
    list() {
        return [...this.entries.values()].sort((a, b) => a.slot - b.slot)
            .map((e) => ({ id: e.id, slot: e.slot, order: e.order }));
    }

    /**
     * Seat a window at this carrel: capture (or adopt) its home, reparent it under
     * the table (world-preserving), and animate it into its ring slot.
     * @param {string} id registry id
     * @param {Object} grid live Object3D with getBounds()/getLocalBounds()
     * @param {Object} [opts]
     * @param {number} [opts.order] stable sort-key hint (restore passes the saved value; omitted = append)
     * @param {{parent:Object|null,pos:{x,y,z},scale:number,quat:THREE.Quaternion,bounds:Object|null}} [opts.home]
     *   an ADOPTED home record (CameraDock.homeOf) — the occupancy handoff. Without it the
     *   grid's CURRENT transform is captured, which is only correct when the grid is at rest
     *   in its residence (tree/scene), never mid-ride in a vehicle.
     * @returns {boolean}
     */
    lock(id, grid, opts = {}) {
        if (!grid || this.entries.has(id) || this._dissolving) return false;

        const order = Number.isFinite(opts?.order) ? opts.order : this._orderSeq;
        this._orderSeq = Math.max(this._orderSeq, order + 1);

        const h = opts.home || null;
        const b = h ? null : grid.getBounds?.();
        const hasBounds = b && !b.isEmpty?.();
        const resolvedScale = grid.scale.x || 1;
        const homePlacement = grid.scaleModel ? grid.scaleModel.placement : resolvedScale;

        const entry = {
            id,
            grid,
            homeParent: h ? (h.parent || null) : (grid.parent || null),
            home: h
                ? { pos: { ...h.pos }, scale: h.scale, quat: h.quat.clone() }
                : {
                    pos: { x: grid.position.x, y: grid.position.y, z: grid.position.z },
                    scale: homePlacement, // release animates PLACEMENT home; resolve re-adds zoom
                    quat: grid.quaternion.clone(),
                },
            homeBounds: h ? (h.bounds ? h.bounds.clone() : null) : (hasBounds ? b.clone() : null),
            _extentFallback: extentFromBox(grid.getLocalBounds?.()) || {
                w: hasBounds ? Math.max((b.max.x - b.min.x) / resolvedScale, 1e-3) : 10,
                h: hasBounds ? Math.max((b.max.y - b.min.y) / resolvedScale, 1e-3) : 10,
                cx: 0, cy: 0, cz: 0,
            },
            unsubscribeResize: null,
            order,
            slot: this.entries.size, // provisional; _relayout re-ranks by `order` immediately
            quatTarget: new THREE.Quaternion(),
            _borrowed: false,
        };

        // Reparent preserving world transform — the member stays put this frame,
        // then the animator slides it into the ring.
        this.attach(grid);
        entry.unsubscribeResize = grid.onResize?.(() => this.reflow(id)) ?? null;

        this.entries.set(id, entry);
        this._relayout();
        return true;
    }

    /**
     * Send a member home: reparent it back (world-preserving) and animate it to
     * its home transform. A BORROWED member (currently ridden elsewhere — its
     * parent is not this carrel) just drops its entry; the rider's own home
     * record governs where it lands when the ride ends.
     * @param {string} id @returns {boolean}
     */
    release(id) {
        const e = this.entries.get(id);
        if (!e) return false;

        e.unsubscribeResize?.();
        this.entries.delete(id);

        if (e.grid.parent !== this) {
            this._relayout();
            return true;
        }

        // Home parent may have been pruned (file closed while seated) — fall back
        // to the scene (this table's own parent) so the window is never orphaned.
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
     * Dismiss a member whose window is GONE (closed/disposed) — the clean-removal
     * counterpart to release(): no live grid to send home, so drop the entry,
     * stop any tween still writing to it, lift the orphan out of the table, and
     * re-seat the survivors.
     * @param {string} id @returns {boolean}
     */
    dismiss(id) {
        const e = this.entries.get(id);
        if (!e) return false;

        e.unsubscribeResize?.();
        this.entries.delete(id);
        this._releasing.delete(id);
        this.animator.cancelAll?.(e.grid);
        if (e.grid && e.grid.parent === this) this.remove(e.grid);

        this._relayout();
        return true;
    }

    /**
     * Self-heal off the registry's removal cascade: dismiss any member whose
     * window is no longer live, however it was closed.
     * @param {(id:string)=>boolean} isLive
     */
    pruneDismissed(isLive) {
        for (const id of [...this.entries.keys()]) {
            if (!isLive(id)) this.dismiss(id);
        }
    }

    /** Send every member home. */
    releaseAll() {
        for (const id of [...this.entries.keys()]) this.release(id);
    }

    /**
     * Fold the desk: every member goes home, the chrome dims out, and once the
     * homeward slides drain, update() marks the carrel dead for its runner to
     * sweep out of the scene. The table stays ticking until the last member
     * lands — dissolving never freezes a window mid-flight.
     */
    dissolve() {
        this._dissolving = true;
        if (this._table) this._table.visible = false;
        if (this._aura) this._aura.visible = false;
        this.releaseAll();
    }

    /**
     * The captured home of a member — the occupancy-handoff read (a residence
     * adopting this member takes over the record). Mirrors CameraDock.homeOf.
     * @param {string} id
     * @returns {{parent:Object|null,pos:{x,y,z},scale:number,quat:THREE.Quaternion,bounds:Object|null}|null}
     */
    homeOf(id) {
        const e = this.entries.get(id);
        if (!e) return null;
        return {
            parent: e.homeParent,
            pos: { ...e.home.pos },
            scale: e.home.scale,
            quat: e.home.quat.clone(),
            bounds: e.homeBounds ? e.homeBounds.clone() : null,
        };
    }

    // ===================== knobs =====================

    /**
     * Tune a layout/chrome parameter live and re-seat. Keys: radius, boxH, boxAspect,
     * gapFrac, maxArcDeg, tableFrac, auraHeadroom, glowStrength, animDur, yawRate.
     * @param {string} key @param {number} value @returns {boolean}
     */
    setParam(key, value) {
        if (!['radius', 'boxH', 'boxAspect', 'gapFrac', 'growCap', 'maxArcDeg', 'tableFrac',
              'auraHeadroom', 'glowStrength', 'animDur', 'yawRate'].includes(key)) return false;
        if (!Number.isFinite(value)) return false;
        this[key] = value;
        if (key === 'glowStrength') this._tintChrome();
        this._relayout();
        return true;
    }

    /** @param {'in'|'out'} facing */
    setFacing(facing) {
        if (facing !== 'in' && facing !== 'out') return false;
        this.facing = facing;
        this._relayout();
        return true;
    }

    // ===================== layout & tick =====================

    /** Gap between slots in world units. */
    get _gap() { return this.boxH * this.gapFrac; }

    /** The member's content extent, derived LIVE from the grid. */
    _extentOf(e) { return extentFromBox(e.grid.getLocalBounds?.()) || e._extentFallback; }

    /** The uniform zoom a member's grid carries (ScaleModel `user`); 1 when absent. The ring
     *  works in RENDERED scale and divides this out of the placement it animates. */
    _userOf(e) { return (e.grid.scaleModel && e.grid.scaleModel.user.x) || 1; }

    /** Contain-fit: the RENDERED scale that sits content inside a slot box (aspect kept).
     *  Growth is capped (growCap): fitting means fitting INSIDE — a nearly-empty member
     *  (a fresh agent book) must not be inflated to fill its slot. */
    _containScale(e, boxW, boxHt) {
        const ext = this._extentOf(e);
        return Math.min(boxW / ext.w, boxHt / ext.h, this.growCap);
    }

    /** Re-seat everyone off current extents — the external content-growth tap (a seated
     *  agent book pages in sheets; AgentBooks.onChange calls this; Books have no onResize). */
    refit() { this._relayout(); }

    /** Animate one member so its content center lands at carrel-local (sx,sy,sz) at rendered
     *  scale `eff`, yawed to `faceDir` (unit, XZ-plane). Same placement algebra as the dock:
     *  the top-anchored origin is offset off the visual center by the rotated extent center,
     *  and 'scale' drives ScaleModel placement = eff/user so zoom composes back in. */
    _animateMember(e, sx, sy, sz, eff, faceDir) {
        e.quatTarget.setFromUnitVectors(_z, faceDir);
        const ext = this._extentOf(e);
        _off.set(ext.cx * eff, ext.cy * eff, ext.cz * eff).applyQuaternion(e.quatTarget);
        this.animator.animateTo(e.grid, 'position',
            { x: sx - _off.x, y: sy - _off.y, z: sz - _off.z }, { duration: this.animDur });
        this.animator.animateTo(e.grid, 'scale', eff / this._userOf(e), { duration: this.animDur });
    }

    /**
     * Seat the members around the ring. Uniform slot boxes wrap along the arc
     * (flowBoxes: x → azimuth) and rows stack UPWARD from the tabletop — row 0
     * rests ON the table, overflow climbs, the footprint never widens. The arc
     * is centered on local −z so the unfilled remainder faces +z: the doorway.
     * Content is contain-fit into its box and BOTTOM-anchored (things rest,
     * they don't float). Borrowed members (parent elsewhere) are skipped.
     */
    _relayout() {
        const members = [...this.entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        members.forEach((e, i) => { e.slot = i; });

        const live = members.filter((e) => e.grid.parent === this && !e._borrowed);
        const boxW = this.boxH * this.boxAspect;
        const boxH = this.boxH;
        const gap = this._gap;
        const R = Math.max(this.radius, 1e-3);
        const arcLen = Math.max(this.maxArcDeg * DEG2RAD * R, boxW + 1e-3);

        if (live.length) {
            const { slots, width: W } = flowBoxes(
                live.map(() => ({ w: boxW, h: boxH })),
                { margin: gap, wrapWidth: arcLen },
            );
            let rows = 1;
            live.forEach((e, i) => {
                const s = slots[i];
                rows = Math.max(rows, s.row + 1);
                const th = ((s.x + boxW / 2) - W / 2) / R;      // azimuth, arc centered on −z
                const bottomY = s.row * (boxH + gap);           // row 0 rests on the table
                const sx = R * Math.sin(th);
                const sz = -R * Math.cos(th);
                // face the axis (stand-at-center reads them like the dock) or outward
                if (this.facing === 'in') _dir.set(-Math.sin(th), 0, Math.cos(th));
                else _dir.set(Math.sin(th), 0, -Math.cos(th));
                const eff = this._containScale(e, boxW, boxH);
                const ext = this._extentOf(e);
                const cy = bottomY + (ext.h * eff) / 2;         // bottom-anchored: content RESTS
                this._animateMember(e, sx, cy, sz, eff, _dir);
            });
            this._rows = rows;
        } else {
            this._rows = 1;
        }

        this._refreshChrome();
    }

    /**
     * Re-seat one member after a size/zoom change (the grid.onResize tap). No
     * cached size math — the whole ring re-reads extents live.
     * @param {string} id @returns {boolean}
     */
    reflow(id) {
        if (!this.entries.has(id)) return false;
        this._relayout();
        return true;
    }

    /**
     * Per-frame: advance member animations, slerp orientations, notice borrowed
     * members coming home (and re-seat everyone when one does), and complete a
     * drained dissolve. No camera — the table doesn't move for anyone.
     * @param {number} dt seconds
     */
    update(dt) {
        this.animator.update(dt);

        const rate = Math.min(1, dt * this.yawRate);
        let returned = false;
        for (const e of this.entries.values()) {
            if (e.grid.parent !== this) {
                e._borrowed = true;               // ridden elsewhere — hands off
                continue;
            }
            if (e._borrowed) { e._borrowed = false; returned = true; }
            e.grid.quaternion.slerp(e.quatTarget, rate);
        }
        if (returned) this._relayout();

        for (const e of this._releasing.values()) e.grid.quaternion.slerp(e.quatTarget, rate);

        if (this._dissolving && !this.entries.size && !this._releasing.size) {
            this.parent?.remove(this);
            this._dead = true;
        }
    }

    // ===================== chrome =====================

    /**
     * The desk's light: a tabletop disc (radial glow, bright center → dark rim)
     * and an open cylinder aura rising from it (bright base → dark top). Both are
     * UNIT geometry carrying vertex-color gradients, scaled to size — knob changes
     * are transform-only, no rebuilds. Additive blending makes "dark" read as
     * "gone", so plain vertex RGB is the whole gradient — no shader, headless-safe.
     * Decoration only: isMarker (the tree's decoration convention), raycast
     * no-op, never registered with picking, depthWrite off, drawn behind content.
     */
    _buildChrome() {
        const disc = new THREE.CircleGeometry(1, 64);
        this._paintRadial(disc);
        disc.rotateX(-Math.PI / 2);
        this._table = new THREE.Mesh(disc, this._chromeMaterial());
        this._table.name = 'carrel-table';

        const shell = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true);
        shell.translate(0, 0.5, 0); // base at y=0, rises to y=1 — scale.y IS the height
        this._paintRise(shell);
        this._aura = new THREE.Mesh(shell, this._chromeMaterial(THREE.DoubleSide));
        this._aura.name = 'carrel-aura';

        for (const m of [this._table, this._aura]) {
            m.userData.isMarker = true;
            m.raycast = () => {};
            m.renderOrder = RENDER_ORDER.CARREL_CHROME;
            this.add(m);
        }
        this._tintChrome();
        this._refreshChrome();
    }

    _chromeMaterial(side = THREE.FrontSide) {
        return new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side,
        });
    }

    /** Radial gradient on a unit disc: center = white, rim = black (tint scales it). */
    _paintRadial(geo) {
        const pos = geo.attributes.position;
        const colors = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            const r = Math.hypot(pos.getX(i), pos.getY(i));
            const v = Math.max(0, 1 - r);
            colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    /** Rising gradient on the unit shell: base = white, top = black (fades out upward). */
    _paintRise(geo) {
        const pos = geo.attributes.position;
        const colors = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            const v = Math.max(0, 1 - pos.getY(i));
            colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    /** Push glowColor·glowStrength into the chrome materials (vertex gradient multiplies it). */
    _tintChrome() {
        const c = new THREE.Color(this.glowColor).multiplyScalar(this.glowStrength);
        this._table.material.color.copy(c);
        this._aura.material.color.copy(c);
    }

    /** Size the chrome to the current ring: disc radius, aura radius + stack height. */
    _refreshChrome() {
        const outerR = this.radius * this.tableFrac;
        this._table.scale.set(outerR, outerR, outerR);
        const stackH = this._rows * (this.boxH + this._gap) - this._gap;
        this._aura.scale.set(outerR, Math.max(stackH + this.auraHeadroom, 1e-3), outerR);
    }

    // ===================== bounds & state =====================

    /**
     * World AABB of the desk's airspace (tabletop footprint × aura height) — what
     * carrel.focus frames and a selection box would draw.
     * @param {Object} [target] THREE.Box3
     * @returns {Object} THREE.Box3
     */
    getBounds(target = new THREE.Box3()) {
        this.updateWorldMatrix(true, false);
        const r = this.radius * this.tableFrac;
        target.min.set(-r, 0, -r);
        target.max.set(r, this._aura.scale.y, r);
        return target.applyMatrix4(this.matrixWorld);
    }

    /**
     * The carrel as SERIALIZABLE STATE — pose, knobs, membership. What persistence
     * reads (the getState side of the load-is-not-replay pattern; applyState is the
     * restore pass's future work).
     */
    serialize() {
        return {
            name: this.carrelName,
            position: { x: this.position.x, y: this.position.y, z: this.position.z },
            yaw: this.rotation.y,
            params: {
                radius: this.radius, boxH: this.boxH, boxAspect: this.boxAspect,
                gapFrac: this.gapFrac, maxArcDeg: this.maxArcDeg, facing: this.facing,
                tableFrac: this.tableFrac, auraHeadroom: this.auraHeadroom,
                glowColor: this.glowColor, glowStrength: this.glowStrength,
            },
            members: this.list(),
        };
    }

    dispose() {
        this.animator.dispose?.();
        this.entries.clear();
        this._releasing.clear();
        for (const m of [this._table, this._aura]) {
            m.geometry.dispose();
            m.material.dispose();
        }
    }
}

export default Carrel;
