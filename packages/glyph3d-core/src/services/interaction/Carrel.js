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
 * you walk in through the gap. A soft BASE-SHADOW (one flat additive rectangle
 * under the member footprint, falloff edges — the bounding-volume read, but on
 * the ground and easy on the eyes) marks the desk's place; it is decoration
 * (userData.isMarker), never picked, never a collider.
 *
 * TWO ARRANGEMENTS, two grammars (`mode`): 'ring' wraps the members along the
 * arc as UNIFORM contain-fit seats — the dock's grammar, a carousel of tiles.
 * 'grid' is the ring's 0-curvature limit — a flat wall standing where the
 * ring's back was (z = −R), facing the doorway — and it speaks the TREE's
 * grammar instead: members keep their NATURAL scale and the wall packs their
 * REAL bounds (flowBoxes over actual extents, per-row heights, squareWrap
 * balancing rows against columns). A shelf shows things the size they are;
 * text reads at one physical size across the whole world. Rows climb from the
 * tabletop in both; the table and doorway keep their meaning.
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
 * A member currently ridden elsewhere (docked) is
 * BORROWED: its parent is not this carrel, and the carrel keeps its entry but
 * takes its hands off the transform (no relayout placement, no yaw slerp) until
 * the object returns, at which point the next update() re-seats everyone.
 *
 * CALM SEATS: a member's seat is the room it CLAIMS, not what it draws this frame. A
 * member that states its room (`claimsSeat` — a reserved Book, a desk) is seated by that
 * claim as given. Any other member (a code grid, a terminal, an unreserved book) is
 * seated by the UNION of every box it has measured since the desk last re-learned — a
 * seat that only grows: content shrinking never pulls its neighbors in, and only growth
 * past every size it has had re-packs the row. The desk re-learns at its structural
 * moments — a member joining or leaving, and settle() (`carrel.settle`).
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
 * @property {THREE.Box3|null} _seatBox - a non-claiming member's grow-only seat (local frame); null = re-learn
 */

import * as THREE from 'three';
import { SpatialAnimator } from '../spatial/SpatialAnimator.js';
import { flowBoxes, squareWrap } from '../../collections/layouts/flowBoxes.js';
import { RENDER_ORDER } from '../../core/renderOrder.js';
import PaneTree from './PaneTree.js';

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
        d: Math.max(lb.max.z - lb.min.z, 1e-3),
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
     * @param {number} [opts.gapFrac=0.9]    - gap between slots as a fraction of boxH
     *   (Ivan-dialed: the 0.9 spacing from the first knob-strip session read right — books
     *   want air between them)
     * @param {number} [opts.growCap=1.25]   - contain-fit may GROW content at most this much.
     *   Fitting means fitting INSIDE; growing is a courtesy. Without the cap, a nearly-empty
     *   member (a fresh agent book before its first sheet) measures tiny and the fit inflates
     *   it absurdly — the seated-book overlap bug
     * @param {number} [opts.maxArcDeg=300]  - arc span the ring fills; the remainder is the doorway (faces local +z)
     * @param {'ring'|'grid'|'plane'} [opts.mode='ring'] - member arrangement: the arc, its
     *   0-curvature limit — a flat semi-grid wall at z=−R facing the doorway (the agent shelf's read)
     *   — or a PLANE: a flat board read pixel-exact when entered (carrel.enter), every member scaled so
     *   its text column is the plane's one column, its cell grid on whole device pixels. A plane
     *   stands in the world exactly as it reads entered, and its layout never depends on the viewport
     *   or the dpr (see setPlaneUnit / planeArrange).
     * @param {'uniform'|'natural'} [opts.seat='uniform'] - the RING's seats: uniform contain-fit
     *   boxes (the dock's grammar), or members at their natural size wrapped along the arc (the
     *   tree's grammar bent into a cylinder — stand at the center and everything is a turn
     *   away). A natural ring keeps its radius and wraps into more rows as members arrive, up
     *   to `ringMaxRows`; past that it widens. (The grid is always natural.)
     * @param {number} [opts.ringMaxRows=2] - most rows a natural ring stacks before its radius grows
     * @param {'in'|'out'} [opts.facing='in'] - members face the center (stand inside) or outward
     * @param {number} [opts.tableFrac=1.25] - base-shadow overhang: the shadow reaches this
     *   fraction of `radius` beyond the member footprint (1 = flush)
     * @param {number} [opts.shadowSoft=0.35] - shadow edge softness, 0..1 fraction of the
     *   half-extent the falloff band occupies (0 = hard rim, 1 = falls off from the center)
     * @param {number} [opts.glowColor=0x6f9fd0] - chrome tint (the base-shadow)
     * @param {number} [opts.glowStrength=0.35]  - chrome intensity (0 = chrome invisible)
     * @param {number} [opts.animDur=0.167] - member slide/scale duration (s)
     * @param {number} [opts.yawRate=14]    - member face-target slerp rate (×dt)
     * @param {'pins'|'tiles'} [opts.planeArrange='pins'] - a plane's arrangement: PINS — every
     *   member at its natural size (a 239-column screen is 239 columns wide), on shelves left to
     *   right in seat order, never clipped; a newcomer takes the next free slot, a leaver's gap
     *   stays until settle, a pin only grows — or TILES: a tiling window manager (a PaneTree of
     *   panes, each a stack of tabs) over a frame of `tileCols × tileRows` cells, members reflowed to
     *   their panes.
     * @param {number} [opts.paneGapPx=8]   - gutter between pins / panes, device px
     * @param {number} [opts.shelfCols=480] - a pin shelf's width in text columns (two 239-col screens
     *   and a gutter)
     * @param {number} [opts.tileCols=200]  - a tiled plane's width, text columns
     * @param {number} [opts.tileRows=60]   - a tiled plane's height, text rows
     * @param {number} [opts.bookCols=120]  - a member without cell metrics (a book) pins this many
     *   plane columns wide
     */
    constructor({ name = 'carrel', radius = 240, boxH = 110, boxAspect = 1.15, gapFrac = 0.9,
                  growCap = 1.25, maxArcDeg = 300, mode = 'ring', seat = 'uniform', ringMaxRows = 2,
                  facing = 'in', tableFrac = 1.25,
                  shadowSoft = 0.35, glowColor = 0x6f9fd0, glowStrength = 0.35,
                  animDur = 0.167, yawRate = 14, planeArrange = 'pins', paneGapPx = 8, shelfCols = 480,
                  tileCols = 200, tileRows = 60, bookCols = 120 } = {}) {
        super();
        this.name = `carrel:${name}`;
        this.carrelName = name;
        this.radius = radius;
        this.boxH = boxH;
        this.boxAspect = boxAspect;
        this.gapFrac = gapFrac;
        this.growCap = growCap;
        this.maxArcDeg = maxArcDeg;
        this.mode = mode === 'grid' || mode === 'plane' ? mode : 'ring';
        this.seat = seat === 'natural' ? 'natural' : 'uniform';
        this.ringMaxRows = ringMaxRows;
        /** the radius the last layout used — a natural ring grows past `radius` to fit */
        this._ringR = radius;
        this.facing = facing === 'out' ? 'out' : 'in';
        this.tableFrac = tableFrac;
        this.shadowSoft = shadowSoft;
        this.glowColor = glowColor;
        this.glowStrength = glowStrength;
        this.animDur = animDur;
        this.yawRate = yawRate;
        this.planeArrange = planeArrange === 'tiles' ? 'tiles' : 'pins';
        this.paneGapPx = paneGapPx;
        this.shelfCols = shelfCols;
        this.tileCols = tileCols;
        this.tileRows = tileRows;
        this.bookCols = bookCols;
        /** The plane's unit — set by the app from the ATLAS, never the viewport (setPlaneUnit):
         *  `column` = the one text column in world units every member is scaled to; `cellPx` = device
         *  px per column when entered (k = cellPx / column device px per world unit); `rowRatio` =
         *  a row's height over a column's width. Null until set: a plane desk without it lays out as
         *  a wall. */
        this.planeUnit = null;
        /** The plane's layout state — PINS: `pins`, the slots in seat order ({id, w, h} device px at
         *  k, grow-only; a leaver's slot stays a ghost until settle) and `focus` (a member); TILES: a
         *  PaneTree over pane ids, each pane a stack of member ids with one active, the `inbox` a
         *  joiner lands in, `focus` (a pane) and `zoomed`. Durable as the desk's Panes. */
        this.panes = { tree: null, stacks: new Map(), inbox: null, seq: 0, focus: null, zoomed: null, pins: [] };
        /** Told whenever the plane's layout changes (the app persists it as the desk's Panes). */
        this.onPanesChanged = null;
        /** What this desk was BORN as — every knob's value at construction. A desk's own
         *  values (the app's per-desk tuning) are set over these; a knob returned to its
         *  default comes back here, and serialize() saves these, never the tuned ones. */
        this.born = Object.freeze({
            radius, boxH, boxAspect, gapFrac, growCap, maxArcDeg,
            mode: this.mode, seat: this.seat, ringMaxRows, facing: this.facing,
            tableFrac, shadowSoft, glowColor, glowStrength, animDur, yawRate,
            planeArrange: this.planeArrange, paneGapPx, shelfCols, tileCols, tileRows, bookCols,
        });

        this._orderSeq = 0;      // monotonic sort-key source (restore threads saved values past it)
        this._rows = 1;          // last layout's row count — bounds read the stack height off it
        this._layoutW = 0;       // last layout's shelf width — the grid shadow hugs it
        this._layoutD = 0;       // last layout's deepest member — the grid shadow strip depth
        this._stackH = boxH;     // last layout's stack height — bounds read it
        this._expected = 0;      // announced incoming complement (expect()) — wrap pre-shapes for it
        this._expectShape = null; // frozen synthetic box + wrap while a complement fills (stable slots)
        this.worldManaged = false; // placed by a WorldLayout grouping, not a hand (the app flips it)
        this.derived = false;      // rebuilt from an outside source each boot (the gomuxai hub) — never saved
        /** @type {Set<Function>} footprint listeners — a desk seated at another desk is its member */
        this._resizeListeners = new Set();
        this._footprint = '';
        /** @type {Object|null} a title (FieldLabel) standing over the stack (setTitle) */
        this.title = null;
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
     * @param {boolean} [opts.immediate] LAND in the seat this tick — no slide from wherever
     *   the loader built the object. Load-is-not-replay: a rebuilt desk re-seats restored
     *   members in place; only live, mid-session seating flies.
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
        grid.updateWorldMatrix(true, false);   // fresh: getBounds reads matrixWorld as three last left it
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
            _extentFallback: extentFromBox(grid.getSeatBounds?.() ?? grid.getLocalBounds?.()) || {
                w: hasBounds ? Math.max((b.max.x - b.min.x) / resolvedScale, 1e-3) : 10,
                h: hasBounds ? Math.max((b.max.y - b.min.y) / resolvedScale, 1e-3) : 10,
                d: hasBounds ? Math.max((b.max.z - b.min.z) / resolvedScale, 1e-3) : 10,
                cx: 0, cy: 0, cz: 0,
            },
            unsubscribeResize: null,
            order,
            slot: this.entries.size, // provisional; _relayout re-ranks by `order` immediately
            quatTarget: new THREE.Quaternion(),
            _borrowed: false,
            _seatBox: null,
        };

        // Reparent preserving world transform — the member stays put this frame,
        // then the animator slides it into the ring.
        this.attach(grid);
        entry.unsubscribeResize = grid.onResize?.(() => this.reflow(id)) ?? null;

        this.entries.set(id, entry);
        this._relearnSeats();   // a member joining is a structural moment — every seat re-learns
        this._relayout();
        // Immediate seating: place the member AT its seat and drop the slide tweens
        // the relayout just issued for it. With expect() holding the wrap stable
        // during a restore fill, the rest of the ring has no reason to move either.
        if (opts.immediate && entry._seat) {
            this.animator.cancelAll(grid);
            grid.position.set(entry._seat.x, entry._seat.y, entry._seat.z);
            const placement = entry._seat.eff / this._userOf(entry);
            if (grid.scaleModel) { grid.scaleModel.placement = placement; grid.scaleModel.resolve(grid); }
            else grid.scale.setScalar(placement);
            grid.quaternion.copy(entry.quatTarget);
        }
        return true;
    }

    /**
     * Send a member home: reparent it back (world-preserving) and animate it to
     * its home transform. A BORROWED member (currently ridden elsewhere — its
     * parent is not this carrel) just drops its entry; the rider's own home
     * record governs where it lands when the ride ends.
     *
     * `opts.to` re-aims THIS release at a caller-computed pose instead of home
     * (window.drop lands the member camera-front) — mirrors CameraDock.release.
     * `opts.inPlace` lands it where it is now (a drag lifting it off the desk): no
     * position slide, only the scale eases home. A borrowed member ignores both: the
     * rider owns the trip.
     * @param {string} id
     * @param {{to?:{parent?:Object, pos?:{x:number,y:number,z:number}, quat?:Object, scale?:number}, inPlace?:boolean}} [opts]
     * @returns {boolean}
     */
    release(id, opts = {}) {
        const e = this.entries.get(id);
        if (!e) return false;

        this._unpane(e);
        this._unstack(id);
        e.unsubscribeResize?.();
        this.entries.delete(id);
        this._relearnSeats();   // a member leaving is a structural moment — every seat re-learns

        if (e.grid.parent !== this) {
            this._relayout();
            return true;
        }

        const to = opts.to;
        if (to) {
            if (to.parent) e.homeParent = to.parent;
            if (to.pos) e.home.pos = { x: to.pos.x, y: to.pos.y, z: to.pos.z };
            if (to.quat) e.home.quat.copy(to.quat);
            if (Number.isFinite(to.scale)) e.home.scale = to.scale;
        }

        // Home parent may have been pruned (file closed while seated) — fall back
        // to the scene (this table's own parent) so the window is never orphaned.
        const parent = (e.homeParent && reachesScene(e.homeParent)) ? e.homeParent : this.parent;
        (parent || this.parent)?.attach?.(e.grid);

        e.quatTarget.copy(e.home.quat);
        this._releasing.set(id, e);

        if (opts.inPlace) {
            this.animator.cancelAll(e.grid);
            e.home.pos = { x: e.grid.position.x, y: e.grid.position.y, z: e.grid.position.z };
        } else {
            this.animator.animateTo(e.grid, 'position', e.home.pos, { duration: this.animDur });
        }
        this.animator.animateTo(e.grid, 'scale', e.home.scale, {
            duration: this.animDur,
            onComplete: () => { this._releasing.delete(id); },
        });

        this._relayout();
        return true;
    }

    /**
     * Hand a member to another holder: drop its entry WITHOUT moving the window — it
     * stays where it is (still parented here, unless borrowed) until the receiver
     * attach()es it — and return its home record for the receiver to adopt. No
     * homeward slide, so nothing fights the receiver's own seating animation.
     * Mirrors CameraDock.handOff.
     * @param {string} id
     * @returns {{parent:Object|null,pos:{x,y,z},scale:number,quat:THREE.Quaternion,bounds:Object|null}|null}
     */
    handOff(id) {
        const home = this.homeOf(id);
        const e = this.entries.get(id);
        if (!e) return null;
        this._unpane(e);
        this._unstack(id);
        e.unsubscribeResize?.();
        this.entries.delete(id);
        this._relearnSeats();   // a member leaving is a structural moment — every seat re-learns
        this._releasing.delete(id);
        if (e.grid.parent === this) this.animator.cancelAll(e.grid);
        this._relayout();
        return home;
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

        this._unstack(id);
        e.unsubscribeResize?.();
        this.entries.delete(id);
        this._relearnSeats();   // a member leaving is a structural moment — every seat re-learns
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
        this._expected = 0;
        if (this._shadow) this._shadow.visible = false;
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
     * gapFrac, growCap, maxArcDeg, ringMaxRows, tableFrac, shadowSoft, glowStrength, animDur, yawRate.
     * @param {string} key @param {number} value @returns {boolean}
     */
    setParam(key, value) {
        if (!['radius', 'boxH', 'boxAspect', 'gapFrac', 'growCap', 'maxArcDeg', 'ringMaxRows', 'tableFrac',
              'shadowSoft', 'glowStrength', 'animDur', 'yawRate', 'paneGapPx', 'shelfCols', 'tileCols', 'tileRows', 'bookCols'].includes(key)) return false;
        if (!Number.isFinite(value)) return false;
        this[key] = value;
        if (key === 'glowStrength') this._tintChrome();
        if (key === 'shadowSoft') this._paintShadow(this._shadow.geometry);
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

    /** The arrangement: 'ring' wraps the arc, 'grid' flattens it into the semi-grid wall (the
     *  0-curvature limit), 'plane' is the board read flat when entered. Leaving plane hands every
     *  member its own view back. @param {'ring'|'grid'|'plane'} mode */
    setMode(mode) {
        if (mode !== 'ring' && mode !== 'grid' && mode !== 'plane') return false;
        if (mode === this.mode) return false;
        const was = this.mode;
        this.mode = mode;
        if (was === 'plane') for (const e of this.entries.values()) this._unpane(e);
        if (mode === 'plane') this._seedTiles();
        this._relayout();
        return true;
    }

    /** A plane's arrangement: 'pins' (natural size, shelves) or 'tiles' (a tiling window manager).
     *  @param {'pins'|'tiles'} arrange */
    setPlaneArrange(arrange) {
        if (arrange !== 'pins' && arrange !== 'tiles') return false;
        if (arrange === this.planeArrange) return false;
        this.planeArrange = arrange;
        for (const e of this.entries.values()) this._unpane(e);
        if (this.mode === 'plane') this._seedTiles();
        this._relayout();
        return true;
    }

    /** A tiled plane with members and no tree yet gets the 'even' layout. @private */
    _seedTiles() {
        if (this.mode !== 'plane' || this.planeArrange !== 'tiles') return;
        if ((!this.panes.tree || this.panes.tree.isEmpty()) && this.entries.size) this.layoutPanes('even', { relayout: false });
    }

    /**
     * The plane's unit, from the ATLAS (never the viewport): `column` world units per text column
     * (every member is scaled so its column is this), `cellPx` device px per column when entered,
     * `rowRatio` a row's height ÷ a column's width. Re-lays a plane desk when it changes.
     * @param {{column:number, cellPx:number, rowRatio:number}} u @returns {boolean} changed
     */
    setPlaneUnit(u) {
        for (const k of ['column', 'cellPx', 'rowRatio']) {
            if (!(Number.isFinite(u?.[k]) && u[k] > 0)) throw new Error(`Carrel.setPlaneUnit(${this.carrelName}): ${k} must be a positive number (got ${u?.[k]})`);
        }
        const c = this.planeUnit;
        if (c && c.column === u.column && c.cellPx === u.cellPx && c.rowRatio === u.rowRatio) return false;
        this.planeUnit = { column: u.column, cellPx: u.cellPx, rowRatio: u.rowRatio };
        if (this.mode === 'plane') this._relayout();
        return true;
    }

    /** Device px per world unit when entered (k), or null without a unit. */
    get planeK() { const u = this.planeUnit; return u ? u.cellPx / u.column : null; }

    /**
     * Re-lay a plane desk's panes as a named layout over its members (in seat order), one member
     * per pane: 'even' — rows of up to `perRow` side by side; 'main' — the first member a wide pane
     * on the left, the rest stacked on the right; 'stack' — one pane, every member a tab. The
     * last pane becomes the inbox.
     * @param {'even'|'main'|'stack'} name @param {{perRow?:number, mainRatio?:number}} [opts]
     * @returns {boolean}
     */
    layoutPanes(name, { perRow = 3, mainRatio = 0.6, relayout = true } = {}) {
        if (!['even', 'main', 'stack'].includes(name)) return false;
        const ids = [...this.entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((e) => e.id);
        const P = this.panes;
        P.stacks = new Map();
        P.tree = null;
        P.inbox = null;
        if (!ids.length) { if (relayout) this._relayout(); this.onPanesChanged?.(); return true; }
        const add = (memberIds) => { const id = this._newPaneId(); P.stacks.set(id, { ids: [...memberIds], active: memberIds[memberIds.length - 1] ?? null }); return id; };
        // Split `from` into equal parts along `axis`, one new pane per extra member list.
        const fan = (from, axis, lists) => {
            const out = [from];
            for (let i = 1; i < lists.length; i++) {
                const id = add(lists[i]);
                P.tree.split(out[out.length - 1], axis, id, { ratio: 1 / (lists.length - i + 1) });
                out.push(id);
            }
            return out;
        };
        if (name === 'stack') {
            P.tree = PaneTree.leaf(add(ids));
        } else if (name === 'main' && ids.length > 1) {
            const main = add([ids[0]]);
            P.tree = PaneTree.leaf(main);
            const side = add([ids[1]]);
            P.tree.split(main, 'x', side, { ratio: mainRatio });
            fan(side, 'y', ids.slice(1).map((id) => [id]));
        } else {
            const rows = [];
            for (let i = 0; i < ids.length; i += Math.max(1, perRow)) rows.push(ids.slice(i, i + Math.max(1, perRow)));
            const first = add([rows[0][0]]);
            P.tree = PaneTree.leaf(first);
            // Rows first (stacked, top to bottom), each row's first pane standing for it…
            const rowHeads = [first];
            for (let r = 1; r < rows.length; r++) {
                const id = add([rows[r][0]]);
                P.tree.split(rowHeads[rowHeads.length - 1], 'y', id, { ratio: 1 / (rows.length - r + 1) });
                rowHeads.push(id);
            }
            // …then each row fans out side by side.
            rows.forEach((row, r) => fan(rowHeads[r], 'x', row.map((id) => [id])));
        }
        const leaves = P.tree.leaves();
        P.inbox = leaves[leaves.length - 1];
        P.focus = leaves[0];
        P.zoomed = null;
        if (relayout) this._relayout();
        this.onPanesChanged?.();
        return true;
    }

    // ===================== pane operations (the pane.* verbs on a plane desk) =====================

    /** The focused pane (else the inbox, else the first). @returns {string|null} */
    focusedPane() {
        const P = this.panes;
        if (!P.tree || P.tree.isEmpty()) return null;
        if (P.focus && P.stacks.has(P.focus) && P.tree.has(P.focus)) return P.focus;
        return P.tree.has(P.inbox) ? P.inbox : P.tree.leaves()[0];
    }

    /** The member a pane shows (its active tab when seated, else its newest seated member). */
    paneFront(paneId) {
        const st = this.panes.stacks.get(paneId);
        if (!st) return null;
        if (st.active && this.entries.has(st.active)) return st.active;
        return [...st.ids].reverse().find((id) => this.entries.has(id)) ?? null;
    }

    /** The pane a member sits in. @returns {string|null} */
    paneOf(memberId) {
        for (const [id, st] of this.panes.stacks) if (st.ids.includes(memberId)) return id;
        return null;
    }

    /** @private */
    _panesChanged() { this._relayout(); this.onPanesChanged?.(); }

    /** Focus a pane by id, or the pane holding a member. @returns {string|null} the focused pane */
    paneFocusOn(idOrMember) {
        const P = this.panes;
        const pane = P.stacks.has(idOrMember) ? idOrMember : this.paneOf(idOrMember);
        if (!pane) return null;
        if (P.zoomed && P.zoomed !== pane) P.zoomed = null;
        P.focus = pane;
        this.onPanesChanged?.();
        if (!P.zoomed) this._relayout();
        return pane;
    }

    /** Move focus to the geometric neighbor (i3). @param {'left'|'right'|'up'|'down'} dir @returns {string|null} */
    paneFocus(dir) {
        const cur = this.focusedPane();
        const next = cur ? this.panes.tree.neighbor(cur, dir) : null;
        return next ? this.paneFocusOn(next) : null;
    }

    /**
     * Split the focused pane, putting a member (already seated here) in the new pane — taken out of
     * whatever stack held it. The new pane is focused. @param {'x'|'y'} axis @param {string} memberId
     * @param {{before?:boolean}} [opts] @returns {string|null} the new pane
     */
    paneSplit(axis, memberId, { before = false } = {}) {
        const cur = this.focusedPane();
        if (!cur || !this.entries.has(memberId) || (axis !== 'x' && axis !== 'y')) return null;
        const from = this.paneOf(memberId);
        if (from) {
            const st = this.panes.stacks.get(from);
            st.ids = st.ids.filter((id) => id !== memberId);
            if (st.active === memberId) st.active = st.ids[st.ids.length - 1] ?? null;
        }
        const id = this._newPaneId();
        this.panes.stacks.set(id, { ids: [memberId], active: memberId });
        this.panes.tree.split(cur, axis, id, { before });
        this.panes.focus = id;
        this.panes.zoomed = null;
        this._panesChanged();
        return id;
    }

    /** Grow the focused pane along an axis (siblings give up space). @returns {boolean} */
    paneResize(axis, delta) {
        const cur = this.focusedPane();
        if (!cur || !this.panes.tree.resize(cur, axis, delta)) return false;
        this._panesChanged();
        return true;
    }

    /**
     * Close a pane: its tabs join the pane that takes its place (the sibling that collapses up) —
     * nothing leaves the desk. The last pane can't close. @param {string} [paneId] (default: focused)
     * @returns {string|null} the pane its tabs joined
     */
    paneClose(paneId = this.focusedPane()) {
        const P = this.panes;
        if (!paneId || !P.tree.has(paneId) || P.tree.count() < 2) return null;
        const moving = P.stacks.get(paneId)?.ids ?? [];
        const next = P.tree.close(paneId);
        P.stacks.delete(paneId);
        const into = P.stacks.get(next);
        for (const id of moving) if (!into.ids.includes(id)) into.ids.push(id);
        if (P.inbox === paneId) P.inbox = next;
        P.focus = next;
        if (P.zoomed === paneId) P.zoomed = null;
        this._panesChanged();
        return next;
    }

    /** Exchange two panes' contents in place (rects unchanged). @returns {boolean} */
    paneSwap(a, b) {
        const P = this.panes;
        if (!P.stacks.has(a) || !P.stacks.has(b) || a === b) return false;
        const sa = P.stacks.get(a);
        P.stacks.set(a, P.stacks.get(b));
        P.stacks.set(b, sa);
        this._panesChanged();
        return true;
    }

    /**
     * Change the focused pane's active tab: 'next' / 'prev' cycle, a member id picks it.
     * @returns {string|null} the active member
     */
    paneTab(which = 'next') {
        const cur = this.focusedPane();
        const st = cur && this.panes.stacks.get(cur);
        const ids = st ? st.ids.filter((id) => this.entries.has(id)) : [];
        if (!ids.length) return null;
        let next;
        if (which === 'next' || which === 'prev') {
            const i = Math.max(0, ids.indexOf(this.paneFront(cur)));
            next = ids[(i + (which === 'next' ? 1 : ids.length - 1)) % ids.length];
        } else if (ids.includes(which)) next = which;
        else return null;
        st.active = next;
        this._panesChanged();
        return next;
    }

    /** Zoom the focused pane to the whole plane (tmux -Z), or unzoom. @returns {string|null} the zoomed pane */
    paneZoom(on = !this.panes.zoomed) {
        const cur = this.focusedPane();
        if (!cur) return null;
        this.panes.zoomed = on ? cur : null;
        this._panesChanged();
        return this.panes.zoomed;
    }

    /**
     * Put a member in a pane: 'tab' — into its stack as the active tab; a direction — a new pane split
     * off that side of it. @param {string} memberId @param {string} paneId
     * @param {'tab'|'left'|'right'|'up'|'down'} where @returns {string|null} the member's pane
     */
    panePlace(memberId, paneId, where = 'tab') {
        const P = this.panes;
        if (!this.entries.has(memberId) || !P.stacks.has(paneId)) return null;
        if (where === 'tab') {
            const from = this.paneOf(memberId);
            if (from) { const st = P.stacks.get(from); st.ids = st.ids.filter((id) => id !== memberId); if (st.active === memberId) st.active = st.ids[st.ids.length - 1] ?? null; }
            const st = P.stacks.get(paneId);
            st.ids.push(memberId);
            st.active = memberId;
            P.focus = paneId;
            this._panesChanged();
            return paneId;
        }
        const axis = (where === 'left' || where === 'right') ? 'x' : (where === 'up' || where === 'down') ? 'y' : null;
        if (!axis) return null;
        P.focus = paneId;
        return this.paneSplit(axis, memberId, { before: where === 'left' || where === 'up' });
    }

    /**
     * A TILED plane's frame in device px at k — a desk value in cells (tileCols × tileRows), never the
     * viewport. Null without a unit.
     * @returns {{widthPx:number, heightPx:number}|null}
     */
    tileFrame() {
        const u = this.planeUnit;
        if (!u) return null;
        return {
            widthPx: Math.max(1, Math.round(this.tileCols)) * u.cellPx,
            heightPx: Math.round(Math.max(1, Math.round(this.tileRows)) * u.cellPx * u.rowRatio),
        };
    }

    /**
     * The board a plane desk reads on, in WORLD space: its center, the normal facing the viewer (the
     * doorway), its up, its size in world units, and its top-left in plane coordinates (world units
     * from the center, +y up) — the point a plane view snaps to a device-pixel corner. PINS: the
     * union of the pins (at least one cell); TILES: the tile frame. The board's top-left is a fixed
     * point of the desk (local (−shelf/2, 0) at z = −R), so a growing board never moves what's on it.
     * Null unless the desk is a plane with a unit.
     * @returns {{center:Object, normal:Object, up:Object, width:number, height:number, origin:{x:number,y:number}}|null}
     */
    getPlaneRect() {
        const box = this._boardPx();
        if (!box) return null;
        const k = this.planeK;
        const W = box.w / k, H = box.h / k;
        const tl = this._boardTopLeft();
        this.updateWorldMatrix(true, false);
        const q = this.getWorldQuaternion(new THREE.Quaternion());
        return {
            center: this.localToWorld(new THREE.Vector3(tl.x + W / 2, tl.y - H / 2, tl.z)),
            normal: new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize(),
            up: new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize(),
            width: W, height: H,
            origin: { x: -W / 2, y: H / 2 },
        };
    }

    /** The board's size in device px at k (pins: their union; tiles: the frame). @private */
    _boardPx() {
        if (this.mode !== 'plane' || !this.planeUnit) return null;
        if (this.planeArrange === 'tiles') {
            const f = this.tileFrame();
            return { w: f.widthPx, h: f.heightPx };
        }
        let w = this.planeUnit.cellPx, h = Math.round(this.planeUnit.cellPx * this.planeUnit.rowRatio);
        for (const p of this.panes.pins) {
            if (p.x == null) continue;
            w = Math.max(w, p.x + p.w);
            h = Math.max(h, p.y + p.h);
        }
        return { w, h };
    }

    /** The board's top-left, desk-local: fixed (local (−shelf/2, 0) at z = −R). @private */
    _boardTopLeft() {
        const u = this.planeUnit, k = this.planeK;
        const shelfW = this.planeArrange === 'tiles' ? this.tileFrame().widthPx / k : Math.max(1, this.shelfCols) * u.column;
        return { x: -shelfW / 2, y: 0, z: -Math.max(this.radius, 1e-3) };
    }

    /**
     * Every pane of a TILED plane: its id, rect (device px from the board's top-left, +y DOWN, whole
     * pixels, gaps taken out), its stack and active member. The tile layout's one reading — placement,
     * verbs and gates all use it. Empty for a pin board.
     * @returns {Array<{id:string, rect:{x:number,y:number,w:number,h:number}, stack:string[], active:string|null}>}
     */
    paneRects() {
        const f = this.mode === 'plane' && this.planeArrange === 'tiles' ? this.tileFrame() : null;
        const tree = this.panes.tree;
        if (!f || !tree || tree.isEmpty()) return [];
        const g = Math.max(0, Math.round(this.paneGapPx));
        const half = g / 2;
        const out = [];
        // A zoomed pane takes the whole frame (tmux -Z); the others keep their rects in the tree.
        const z = this.panes.zoomed;
        const rects = z && tree.has(z) ? new Map([[z, { x: 0, y: 0, w: f.widthPx, h: f.heightPx }]]) : tree.rects({ x: 0, y: 0, w: f.widthPx, h: f.heightPx });
        for (const [id, r] of rects) {
            // y-up rect → top-down device px; cut on whole pixels, then take the gap out of every side
            // (half a gap each, so neighbors meet a whole gap apart and the board edge keeps half).
            const left = Math.round(r.x), right = Math.round(r.x + r.w);
            const top = Math.round(f.heightPx - (r.y + r.h)), bottom = Math.round(f.heightPx - r.y);
            const x = left + Math.ceil(half), y = top + Math.ceil(half);
            const w = Math.max(0, right - Math.floor(half) - x), h = Math.max(0, bottom - Math.floor(half) - y);
            const st = this.panes.stacks.get(id) || { ids: [], active: null };
            out.push({ id, rect: { x, y, w, h }, stack: [...st.ids], active: st.active });
        }
        return out;
    }

    /**
     * Every pin of a PIN board, in seat order: the member id, its rect (device px from the board's
     * top-left, +y down, whole pixels), and whether it's a GHOST (its member left; the gap stays until
     * settle). Empty for a tiled plane.
     * @returns {Array<{id:string, rect:{x:number,y:number,w:number,h:number}, ghost:boolean}>}
     */
    pinRects() {
        if (this.mode !== 'plane' || this.planeArrange !== 'pins') return [];
        return this.panes.pins.filter((p) => p.x != null)
            .map((p) => ({ id: p.id, rect: { x: p.x, y: p.y, w: p.w, h: p.h }, ghost: !this.entries.has(p.id) }));
    }

    /** The ring's seats: 'uniform' contain-fit boxes or 'natural' sizes (see the ctor). */
    setSeat(seat) {
        const next = seat === 'natural' ? 'natural' : 'uniform';
        if (next === this.seat) return false;
        this.seat = next;
        this._relayout();
        return true;
    }

    /**
     * Announce a KNOWN incoming complement (session restore reads it off the saved
     * member list): the grid wrap computes for at least `n` members, so a wall
     * filling one by one wraps for its FINAL shape from the first arrival — every
     * member lands in its lasting slot, nothing reorganizes mid-pour. Self-clearing:
     * once the live count reaches it, the live count rules again.
     * @param {number} n
     */
    expect(n) {
        this._expected = Math.max(0, Math.floor(n) || 0);
        this._expectShape = null;   // re-derive the fill shape for the new complement
        this._relayout();
    }

    // ===================== layout & tick =====================

    /** Gap between slots in world units. */
    get _gap() { return this.boxH * this.gapFrac; }

    /** The member's SEAT extent (see CALM SEATS): a claiming member's stated room, else
     *  the union of every box it has measured since the last re-learn — read live, grown,
     *  never shrunk. A successful read becomes the new fallback, so a TRANSIENT empty read
     *  (a book mid-mutation between sheets) holds the last-good form instead of flashing
     *  the lock-time guess — form is continuous even when measurement briefly isn't. */
    _extentOf(e) {
        // A member that knows the room it draws in (a Book: nameplate, tabs, cover) is
        // seated by that; anything else by its content box.
        const lb = e.grid.getSeatBounds?.() ?? e.grid.getLocalBounds?.();
        let box = lb;
        if (lb && !lb.isEmpty() && !e.grid.claimsSeat) {
            if (e._seatBox) e._seatBox.union(lb); else e._seatBox = lb.clone();
            box = e._seatBox;
        }
        const live = extentFromBox(box);
        if (live) e._extentFallback = live;
        return live || e._extentFallback;
    }

    /** Forget every grow-only seat — the next layout measures members as they stand. @private */
    _relearnSeats() {
        for (const e of this.entries.values()) e._seatBox = null;
    }

    /** Re-learn every member's seat from its size NOW (a grown-then-shrunk member gives
     *  its room back) and re-seat — the explicit settle (`carrel.settle`). */
    settle() {
        this._relearnSeats();
        if (this.mode === 'plane' && this.planeArrange === 'pins') {
            // Repack: ghosts go, every pin re-measures from its member as it stands (it may shrink).
            this.panes.pins = this.panes.pins.filter((p) => this.entries.has(p.id)).map((p) => ({ id: p.id, w: 0, h: 0 }));
            this.onPanesChanged?.();
        }
        this._relayout();
        return this;
    }

    /** A desk states its room: its footprint is what it holds — seated as-is at an outer desk. */
    get claimsSeat() { return true; }

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

    /**
     * Give the desk a title — a label (FieldLabel or anything with width/height) standing
     * centered over the member stack, at the wall (grid) or the ring's back. Parented in,
     * placed with the chrome, and counted in getLocalBounds, so a desk seated at another
     * desk keeps its title clear of its neighbors. Replacing disposes the old one; null
     * detaches without disposing.
     * @param {Object|null} label
     */
    setTitle(label) {
        if (this.title && this.title !== label) {
            this.remove(this.title);
            this.title.dispose?.();
        }
        this.title = label || null;
        if (this.title) {
            this.title.userData.isMarker = true;
            this.add(this.title);
        }
        this._refreshChrome();
        this._notifyFootprint();
        return this;
    }

    /**
     * Subscribe to footprint changes (getLocalBounds moved) — the member contract a desk
     * seated at another desk needs: the outer desk re-seats its row when this one grows.
     * @param {Function} cb @returns {Function} unsubscribe
     */
    onResize(cb) {
        this._resizeListeners.add(cb);
        return () => this._resizeListeners.delete(cb);
    }

    /** Re-seat everyone off current extents — the external content-growth tap (a seated
     *  agent book pages in sheets; AgentBooks.onChange calls this; Books have no onResize). */
    refit() { this._relayout(); }

    /** Animate one member so its content center lands at carrel-local (sx,sy,sz) at rendered
     *  scale `eff`, yawed to `faceDir` (unit, XZ-plane). Same placement algebra as the dock:
     *  the top-anchored origin is offset off the visual center by the rotated extent center,
     *  and 'scale' drives ScaleModel placement = eff/user so zoom composes back in.
     *
     *  SEAT-DIFF: an internal change (a seated book paging in a sheet) refits the whole
     *  ring, and re-issuing an identical tween RESTARTS its ease (the animator is
     *  last-write-wins) — every member visibly stuttered on every agent event. So a member
     *  whose target hasn't moved (beyond a boxH-relative epsilon) is left alone: in-flight
     *  slides continue undisturbed, resting members rest. Only real motion animates. */
    _animateMember(e, sx, sy, sz, eff, faceDir) {
        e.quatTarget.setFromUnitVectors(_z, faceDir);
        const ext = this._extentOf(e);
        _off.set(ext.cx * eff, ext.cy * eff, ext.cz * eff).applyQuaternion(e.quatTarget);
        const tx = sx - _off.x, ty = sy - _off.y, tz = sz - _off.z;
        const s = e._seat;
        const eps = this.boxH * 0.01;
        if (s && Math.abs(s.x - tx) < eps && Math.abs(s.y - ty) < eps && Math.abs(s.z - tz) < eps
              && Math.abs(s.eff - eff) < eff * 0.01) return;
        e._seat = { x: tx, y: ty, z: tz, eff };
        this.animator.animateTo(e.grid, 'position', { x: tx, y: ty, z: tz }, { duration: this.animDur });
        this.animator.animateTo(e.grid, 'scale', eff / this._userOf(e), { duration: this.animDur });
    }

    /**
     * Seat the members along the shelf. Boxes wrap (flowBoxes) and rows stack
     * UPWARD from the tabletop — row 0 rests ON the table, overflow climbs
     * (bottomY = −slot.y: flowBoxes' descending rows read as cumulative shelf
     * lines, per-row heights included). Two grammars:
     *   ring — the arc (x → azimuth, wrapped at the arc length, centered on
     *     local −z so the unfilled remainder faces +z: the doorway); UNIFORM
     *     slot boxes, content contain-fit into its seat — the dock's grammar.
     *   grid — the arc's 0-curvature limit: a flat wall at z=−R facing the
     *     doorway; members keep their NATURAL scale and the wall packs their
     *     REAL rendered bounds, wrapped as a semi-grid (squareWrap) — the
     *     tree's grammar.
     * Content is BOTTOM-anchored (things rest, they don't float). Borrowed
     * members (parent elsewhere) are skipped. While a complement is announced
     * (expect()), wrap AND centering compute for it — frozen at first derive
     * (_expectShape) so a restore fill takes its final shape from the first
     * arrival and every member lands in its lasting slot.
     */
    _relayout() {
        const members = [...this.entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        members.forEach((e, i) => { e.slot = i; });

        const live = members.filter((e) => e.grid.parent === this && !e._borrowed);
        if (this.mode === 'plane' && this.planeUnit) {
            if (this.planeArrange === 'tiles') { this._reconcilePanes(members); this._layoutTiles(live); }
            else this._layoutPins(members, live);
            this._refreshChrome();
            this._notifyFootprint();
            return;
        }
        const boxW = this.boxH * this.boxAspect;
        const boxH = this.boxH;
        const gap = this._gap;
        let R = Math.max(this.radius, 1e-3);
        const grid = this.mode === 'grid' || this.mode === 'plane';   // a plane without its unit yet stands as a wall
        const natural = grid || this.seat === 'natural';
        if (this._expected && live.length >= this._expected) {   // complement arrived
            this._expected = 0;
            this._expectShape = null;
        }

        if (live.length) {
            // The measured boxes: real rendered extents on the grid shelf, uniform
            // seats on the ring. eff is decided here once per member — natural scale
            // (the user zoom passes through) vs contain-fit into the seat box.
            const effs = live.map((e) => (natural ? this._userOf(e) : this._containScale(e, boxW, boxH)));
            const boxes = natural
                ? live.map((e, i) => {
                    const ext = this._extentOf(e);
                    return { w: Math.max(ext.w * effs[i], 1e-3), h: Math.max(ext.h * effs[i], 1e-3) };
                })
                : live.map(() => ({ w: boxW, h: boxH }));

            // A natural ring keeps its radius while its members wrap into up to ringMaxRows
            // rows; past that it widens. The greedy wrap packs unevenly, so the radius is
            // searched against the real wrap (rows only fall as the arc lengthens) — solving it
            // from the total run can spill a row past the cap.
            if (!grid && natural) {
                const arc = this.maxArcDeg * DEG2RAD, cap = Math.max(1, Math.floor(this.ringMaxRows));
                const rowsAt = (r) => flowBoxes(boxes, { margin: gap, wrapWidth: Math.max(arc * r, boxW + 1e-3) }).rows;
                if (rowsAt(R) > cap) {
                    let lo = R;
                    let hi = Math.max(R, boxes.reduce((sum, b) => sum + b.w + gap, 0) / arc);   // one row fits here
                    for (let i = 0; i < 24; i++) {
                        const mid = (lo + hi) / 2;
                        if (rowsAt(mid) > cap) lo = mid; else hi = mid;
                    }
                    R = hi;
                }
            }
            const wrapN = Math.max(live.length, this._expected);
            let wrapWidth, W;
            if (wrapN > live.length) {
                // Fill in progress: synthesize the absentees at the FROZEN average box
                // and wrap for the whole complement — stable slots while the pour runs.
                this._expectShape ??= (() => {
                    const avgW = boxes.reduce((s, b) => s + b.w, 0) / boxes.length;
                    const avgH = boxes.reduce((s, b) => s + b.h, 0) / boxes.length;
                    const synth = boxes.concat(Array.from({ length: wrapN - boxes.length }, () => ({ w: avgW, h: avgH })));
                    return {
                        avgW, avgH,
                        wrapWidth: grid ? squareWrap(synth, gap) : Math.max(this.maxArcDeg * DEG2RAD * R, boxW + 1e-3),
                    };
                })();
                const shape = this._expectShape;
                wrapWidth = shape.wrapWidth;
                const synth = boxes.concat(Array.from({ length: wrapN - boxes.length }, () => ({ w: shape.avgW, h: shape.avgH })));
                W = flowBoxes(synth, { margin: gap, wrapWidth }).width;
            } else {
                wrapWidth = grid
                    ? squareWrap(boxes, gap)
                    : Math.max(this.maxArcDeg * DEG2RAD * R, boxW + 1e-3);
                W = 0;   // filled below from the live run
            }

            const { slots, width: liveW, height: liveH } = flowBoxes(boxes, { margin: gap, wrapWidth });
            if (!W) W = liveW;
            this._layoutW = W;
            let rows = 1, deepest = 0;
            live.forEach((e, i) => {
                const s = slots[i];
                rows = Math.max(rows, s.row + 1);
                const eff = effs[i];
                const ext = this._extentOf(e);
                deepest = Math.max(deepest, ext.d * eff);
                const cx = (s.x + boxes[i].w / 2) - W / 2;      // slot center, shelf centered on the back
                const bottomY = -s.y;                           // rows climb; each rests on its shelf line
                let sx, sz;
                if (grid) {
                    sx = cx; sz = -R;                           // the wall stands where the ring's back was
                    _dir.set(0, 0, this.facing === 'in' ? 1 : -1);   // face the doorway (or the far side)
                } else {
                    const th = cx / R;                          // azimuth, arc centered on −z
                    sx = R * Math.sin(th);
                    sz = -R * Math.cos(th);
                    // face the axis (stand-at-center reads them like the dock) or outward
                    if (this.facing === 'in') _dir.set(-Math.sin(th), 0, Math.cos(th));
                    else _dir.set(Math.sin(th), 0, -Math.cos(th));
                }
                const cy = bottomY + (ext.h * eff) / 2;         // bottom-anchored: content RESTS
                this._animateMember(e, sx, cy, sz, eff, _dir);
            });
            this._rows = rows;
            this._layoutD = deepest;
            // Real-size rows: the stack height reads straight off the flow (uniform
            // rows reduce to the old rows·(boxH+gap)−gap).
            this._stackH = Math.max(liveH, 1e-3);
        } else {
            this._rows = 1;
            this._layoutW = 0;
            this._layoutD = 0;
            this._stackH = boxH;
        }

        this._ringR = grid ? Math.max(this.radius, 1e-3) : R;
        this._refreshChrome();
        this._notifyFootprint();
    }

    // ===================== plane form =====================

    /**
     * Seat new members in panes: a member not in any pane joins the INBOX pane as its active tab
     * (a first member founds the tree). Members already placed keep their pane — a join never
     * changes another pane's rect. A stack may name members not seated YET (a restored layout
     * waiting for its windows): they hold their place. Members leave stacks only by leaving the
     * desk (_unstack). @private
     */
    _reconcilePanes(members) {
        const P = this.panes;
        const placed = new Set([...P.stacks.values()].flatMap((st) => st.ids));
        let changed = false;
        for (const e of members) {
            if (placed.has(e.id)) continue;
            if (!P.tree || P.tree.isEmpty()) {
                const id = this._newPaneId();
                P.tree = PaneTree.leaf(id);
                P.stacks.set(id, { ids: [], active: null });
                P.inbox = id;
            }
            if (!P.inbox || !P.stacks.has(P.inbox)) P.inbox = P.tree.leaves()[P.tree.leaves().length - 1];
            const st = P.stacks.get(P.inbox);
            st.ids.push(e.id);
            st.active = e.id;
            changed = true;
        }
        if (changed) this.onPanesChanged?.();
    }

    /** A member leaving the desk leaves its pane's stack (the pane stays). @private */
    _unstack(id) {
        let changed = false;
        for (const st of this.panes.stacks.values()) {
            const i = st.ids.indexOf(id);
            if (i < 0) continue;
            st.ids.splice(i, 1);
            if (st.active === id) st.active = st.ids[st.ids.length - 1] ?? null;
            changed = true;
        }
        if (changed) this.onPanesChanged?.();
    }

    /**
     * The plane's layout as a plain record (the desk's Panes) — null when it has none: the tile tree
     * and its stacks (null tree for a pin board), and the pin slots in seat order (sizes only; their
     * places follow from the order).
     * @returns {{tree:Object|null, stacks:Array<{id:string, ids:string[], active:string|null}>, inbox:string|null, seq:number, focus:string|null, zoomed:string|null, pins:Array<{id:string,w:number,h:number}>}|null}
     */
    serializePanes() {
        const P = this.panes;
        const hasTree = !!(P.tree && !P.tree.isEmpty());
        if (!hasTree && !P.pins.length) return null;
        return {
            tree: hasTree ? P.tree.serialize() : null,
            stacks: hasTree ? [...P.stacks].map(([id, st]) => ({ id, ids: [...st.ids], active: st.active })) : [],
            inbox: P.inbox, seq: P.seq, focus: P.focus, zoomed: P.zoomed,
            pins: P.pins.map((p) => ({ id: p.id, w: p.w, h: p.h })),
        };
    }

    /**
     * Stand a saved pane layout back up (restore): the tree, every stack — members not seated yet
     * hold their place — and the inbox. A malformed record throws (a silent fallback would lay the
     * desk out as something it never was).
     * @param {ReturnType<Carrel['serializePanes']>} rec
     */
    applyPanes(rec) {
        if (!rec || typeof rec !== 'object' || !Array.isArray(rec.stacks) || (rec.pins != null && !Array.isArray(rec.pins))) {
            throw new Error(`Carrel.applyPanes(${this.carrelName}): malformed record ${JSON.stringify(rec)?.slice(0, 200)}`);
        }
        const pins = (rec.pins || []).map((p) => {
            if (typeof p?.id !== 'string' || !(p.w >= 0) || !(p.h >= 0)) throw new Error(`Carrel.applyPanes(${this.carrelName}): pin ${JSON.stringify(p)} is malformed`);
            return { id: p.id, w: p.w, h: p.h };
        });
        if (!rec.tree) {
            // A pin board: slots only.
            const P = this.panes;
            P.pins = pins;
            P.focus = typeof rec.focus === 'string' ? rec.focus : null;
            this._relayout();
            return;
        }
        const tree = PaneTree.deserialize(rec.tree);
        const leaves = new Set(tree.leaves());
        const stacks = new Map();
        for (const st of rec.stacks) {
            if (!leaves.has(st?.id) || !Array.isArray(st.ids)) throw new Error(`Carrel.applyPanes(${this.carrelName}): stack ${JSON.stringify(st)} names no pane of the tree`);
            stacks.set(st.id, { ids: st.ids.map(String), active: st.active ?? null });
        }
        for (const id of leaves) if (!stacks.has(id)) stacks.set(id, { ids: [], active: null });
        const P = this.panes;
        P.tree = tree;
        P.stacks = stacks;
        P.inbox = leaves.has(rec.inbox) ? rec.inbox : [...leaves].pop();
        P.focus = leaves.has(rec.focus) ? rec.focus : P.inbox;
        P.zoomed = leaves.has(rec.zoomed) ? rec.zoomed : null;
        P.pins = pins;
        const maxSeq = Math.max(0, ...[...leaves].map((id) => Number(String(id).split(':')[1]) || 0));
        P.seq = Math.max(Number(rec.seq) || 0, maxSeq);
        this._relayout();
    }

    /** @private */
    _newPaneId() { return `pane:${++this.panes.seq}`; }

    /**
     * PINS: every member at its natural size, scaled so its text column is the plane's, on shelves in
     * seat order. Slots are the record (`panes.pins`, device px at k): a new member APPENDS (no earlier
     * pin moves), a pin's size only grows (a member that outgrows it moves only the pins after it), a
     * leaver's slot stays a ghost until settle. Each member's cell-grid origin (pixelOrigin, else its
     * top-left) lands on a whole device pixel inside its pin. Nothing here reads the viewport. @private
     */
    _layoutPins(members, live) {
        const u = this.planeUnit, k = this.planeK, cw = u.column;
        const P = this.panes;
        let changed = false;
        const have = new Set(P.pins.map((p) => p.id));
        for (const e of members) if (!have.has(e.id)) { P.pins.push({ id: e.id, w: 0, h: 0 }); changed = true; }
        const byId = new Map(live.map((e) => [e.id, e]));
        const placed = new Map();
        for (const p of P.pins) {
            const e = byId.get(p.id);
            if (!e) continue;
            if (e.grid.visible === false) e.grid.visible = true;   // a pin board hides nothing
            const fit = this._pinFit(e, cw, k);
            if (fit.w > p.w) { p.w = fit.w; changed = true; }
            if (fit.h > p.h) { p.h = fit.h; changed = true; }
            placed.set(p.id, fit);
        }
        const gap = Math.max(0, Math.round(this.paneGapPx));
        const wrapW = Math.max(1, Math.round(this.shelfCols)) * u.cellPx;
        let x = 0, y = 0, rowH = 0;
        for (const p of P.pins) {
            if (!(p.w > 0 && p.h > 0)) { p.x = p.y = null; continue; }   // never measured: no slot yet
            if (x > 0 && x + p.w > wrapW) { x = 0; y += rowH + gap; rowH = 0; }
            p.x = x; p.y = y;
            x += p.w + gap;
            rowH = Math.max(rowH, p.h);
        }
        const tl = this._boardTopLeft();
        let deepest = 0;
        for (const p of P.pins) {
            const fit = placed.get(p.id);
            if (!fit || p.x == null) continue;
            const e = byId.get(p.id);
            // The cell origin at a whole-pixel offset inside the pin, the pin at whole pixels on the board.
            const tx = tl.x + (p.x + fit.dx) / k - fit.ox * fit.m;
            const ty = tl.y - (p.y + fit.dy) / k - fit.oy * fit.m;
            this._placePaneMember(e, tx, ty, tl.z, fit.m);
            deepest = Math.max(deepest, (this._extentOf(e)?.d ?? 0) * fit.m);
        }
        if (!P.focus || !byId.has(P.focus)) P.focus = P.pins.find((p) => byId.has(p.id) && p.x != null)?.id ?? null;
        const box = this._boardPx();
        this._rows = 1;
        this._layoutW = box.w / k;
        this._layoutD = deepest;
        this._stackH = box.h / k;
        this._ringR = Math.max(this.radius, 1e-3);
        if (changed) this.onPanesChanged?.();
    }

    /**
     * A member's pin: its scale (its column → the plane's), its size in whole device px at k, and where
     * its cell origin sits inside the pin (dx, dy whole px; ox, oy the origin in member-local units).
     * A member without cell metrics (a book) is scaled to `bookCols` plane columns wide. @private
     */
    _pinFit(e, cw, k) {
        const g = e.grid;
        const ext = this._extentOf(e);
        const colW = g.metrics?.charWidth;
        const m = Number.isFinite(colW) && colW > 0 ? cw / colW : (Math.max(1, this.bookCols ?? 120) * cw) / Math.max(ext.w, 1e-6);
        const left = ext.cx - ext.w / 2, top = ext.cy + ext.h / 2;
        const po = g.pixelOrigin?.() ?? { x: left, y: top };
        const dx = Math.round((po.x - left) * m * k), dy = Math.round((top - po.y) * m * k);
        return {
            m, ox: po.x, oy: po.y, dx: Math.max(0, dx), dy: Math.max(0, dy),
            w: Math.ceil(ext.w * m * k - 1e-6), h: Math.ceil(ext.h * m * k - 1e-6),
        };
    }

    /**
     * The plane-view aim (plane coordinates: world units from the board center, +y up) that shows a
     * pin in a viewport: centered when it fits, else its top-left `marginPx` in from the view's
     * top-left (read from the head). Null for no such pin.
     * @param {string} id @param {{width:number, height:number}} vp device px @param {number} marginPx device px
     */
    pinAim(id, vp, marginPx = 0) {
        const pin = this.pinRects().find((p) => p.id === id);
        const box = this._boardPx();
        if (!pin || !box) return null;
        const r = pin.rect, k = this.planeK;
        const ax = r.w <= vp.width - 2 * marginPx ? r.x + r.w / 2 : r.x - marginPx + vp.width / 2;
        const ay = r.h <= vp.height - 2 * marginPx ? r.y + r.h / 2 : r.y - marginPx + vp.height / 2;
        return { x: -box.w / (2 * k) + ax / k, y: box.h / (2 * k) - ay / k };
    }

    /** The focused pin's member (pins), else null. */
    focusedPin() {
        const f = this.panes.focus;
        return f && this.entries.has(f) && this.panes.pins.some((p) => p.id === f && p.x != null) ? f : null;
    }

    /** Focus a pin (a member on the board). @returns {string|null} */
    pinFocusOn(memberId) {
        if (!this.pinRects().some((p) => p.id === memberId && !p.ghost)) return null;
        this.panes.focus = memberId;
        this.onPanesChanged?.();
        return memberId;
    }

    /** Focus the nearest pin in a direction (geometry, like PaneTree.neighbor; +y down here). */
    pinFocus(dir) {
        const pins = this.pinRects().filter((p) => !p.ghost);
        const from = pins.find((p) => p.id === this.focusedPin());
        if (!from) return null;
        const c = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
        const fc = c(from.rect);
        const horiz = dir === 'left' || dir === 'right';
        const sign = (dir === 'right' || dir === 'down') ? 1 : -1;
        let best = null, bestScore = Infinity;
        for (const p of pins) {
            if (p.id === from.id) continue;
            const pc = c(p.rect);
            const primary = horiz ? pc.x - fc.x : pc.y - fc.y;
            if (primary * sign <= 1e-9) continue;
            const score = Math.abs(primary) + 2 * Math.abs(horiz ? pc.y - fc.y : pc.x - fc.x);
            if (score < bestScore) { bestScore = score; best = p.id; }
        }
        return best ? this.pinFocusOn(best) : null;
    }

    /**
     * TILES: lay the panes out on the tile frame and seat each pane's active member in it (the rest of
     * its stack hidden, still members). Each member is scaled so its text column is the plane's and
     * placed so its cell-grid origin (pixelOrigin, else its top-left) sits at its pane's top-left. A
     * member that can reflow (a CodeGrid: setLayout + setFrameRows) takes the pane's columns and rows;
     * foreign content (a terminal) keeps its size. A member without cell metrics (a book) is contain-fit
     * into its pane. @private
     */
    _layoutTiles(live) {
        const u = this.planeUnit, k = this.planeK, cw = u.column;
        const tl = this._boardTopLeft();
        const byId = new Map(live.map((e) => [e.id, e]));
        let deepest = 0;
        const panes = this.paneRects();
        const shownPanes = new Set(panes.map((p) => p.id));
        for (const [id, st] of this.panes.stacks) {
            if (shownPanes.has(id)) continue;   // a pane hidden by a zoom hides its whole stack
            for (const mid of st.ids) { const e = byId.get(mid); if (e && e.grid.visible !== false) e.grid.visible = false; }
        }
        for (const pane of panes) {
            // The active tab when it's seated, else the newest seated member of the stack.
            const front = byId.has(pane.active) ? pane.active : [...pane.stack].reverse().find((id) => byId.has(id));
            for (const id of pane.stack) {
                const e = byId.get(id);
                if (!e) continue;
                const shown = id === front;
                if (e.grid.visible !== shown) e.grid.visible = shown;
                if (!shown) continue;
                const r = pane.rect;
                const colW = e.grid.metrics?.charWidth;
                let m, ox, oy, headPx = 0;
                if (Number.isFinite(colW) && colW > 0) {
                    m = cw / colW;
                    headPx = this._reflowToPane(e, r, u);
                    const po = e.grid.pixelOrigin?.() ?? (() => { const lb = e.grid.getLocalBounds?.(); return lb && !lb.isEmpty() ? { x: lb.min.x, y: lb.max.y } : { x: 0, y: 0 }; })();
                    ox = po.x; oy = po.y;
                } else {
                    const ext = this._extentOf(e);
                    m = Math.min((r.w / k) / ext.w, (r.h / k) / ext.h);
                    ox = ext.cx - ext.w / 2; oy = ext.cy + ext.h / 2;
                }
                // A header (a grid's filename) sits in whole rows above row 0, so the row phase holds.
                const tx = tl.x + r.x / k - ox * m;
                const ty = tl.y - (r.y + headPx) / k - oy * m;
                this._placePaneMember(e, tx, ty, tl.z, m);
                deepest = Math.max(deepest, (this._extentOf(e)?.d ?? 0) * m);
            }
        }
        const box = this._boardPx();
        this._rows = 1;
        this._layoutW = box.w / k;
        this._layoutD = deepest;
        this._stackH = box.h / k;
        this._ringR = Math.max(this.radius, 1e-3);
    }

    /** Seat a pane's member exactly (facing the doorway), animating only real motion. @private */
    _placePaneMember(e, tx, ty, tz, m) {
        e.quatTarget.identity();
        const s = e._seat;
        const eps = 1e-6 * Math.max(1, Math.abs(tx), Math.abs(ty), Math.abs(tz));
        if (s && Math.abs(s.x - tx) < eps && Math.abs(s.y - ty) < eps && Math.abs(s.z - tz) < eps && Math.abs(s.eff - m) < m * 1e-9) return;
        e._seat = { x: tx, y: ty, z: tz, eff: m };
        this.animator.animateTo(e.grid, 'position', { x: tx, y: ty, z: tz }, { duration: this.animDur });
        this.animator.animateTo(e.grid, 'scale', m / this._userOf(e), { duration: this.animDur });
    }

    /**
     * A reflowable member takes its pane's columns and rows (wrap at the pane width, a frame of the
     * rows that fit). Its own header (a grid's filename) steps aside — a pane's title is the
     * overlay's, and a header is a separate field no pane clips. Its own view is kept to hand back
     * (_unpane).
     * @returns {number} the header's height in device px (whole rows) — 0 without one @private
     */
    _reflowToPane(e, r, f) {
        const g = e.grid;
        const mt = g.metrics;
        const rowPx = f.cellPx * (mt.lineSpacing / mt.charWidth);
        if (typeof g.setLayout !== 'function' || typeof g.setFrameRows !== 'function') {
            return (g.config?.showFilename && g.filename) ? 2 * rowPx : 0;
        }
        const cols = Math.max(8, Math.floor(r.w / f.cellPx));
        const rows = Math.max(1, Math.floor(r.h / rowPx));
        if (!e._paneSaved) {
            e._paneSaved = { wrapWidth: g.getLayout?.()?.wrapWidth ?? 0, frameRows: g.getFrameRows?.() ?? 0, showFilename: g.config?.showFilename !== false };
            if (e._paneSaved.showFilename && typeof g.showFilename === 'function') g.showFilename(false);
            // The member's OWN view while the pane dresses it — what a save records for it (the pane's
            // columns and rows are the desk's presentation, never the grid's).
            g.userData.paneOwn = e._paneSaved;
        }
        const p = e._paneFit;
        if (p && p.cols === cols && p.rows === rows) return 0;
        e._paneFit = { cols, rows };
        Promise.resolve(g.setLayout({ wrapWidth: cols })).then(() => g.setFrameRows(rows)).catch((err) => {
            console.warn(`[carrel] ${this.carrelName}: reflowing '${e.id}' to its pane (${cols}×${rows}) failed: ${err?.message ?? err}`);
        });
        return 0;
    }

    /** Hand a member its own layout and visibility back as it leaves the plane. @private */
    _unpane(e) {
        if (e.grid && e.grid.visible === false) e.grid.visible = true;
        const saved = e._paneSaved;
        e._paneSaved = null;
        e._paneFit = null;
        if (e.grid?.userData) delete e.grid.userData.paneOwn;
        if (!saved || !e.grid) return;
        if (saved.showFilename && typeof e.grid.showFilename === 'function') e.grid.showFilename(true);
        Promise.resolve(e.grid.setLayout?.({ wrapWidth: saved.wrapWidth })).then(() => e.grid.setFrameRows?.(saved.frameRows)).catch((err) => {
            console.warn(`[carrel] ${this.carrelName}: giving '${e.id}' its layout back failed: ${err?.message ?? err}`);
        });
    }

    /** Tell footprint listeners when getLocalBounds moved (an outer desk re-seats). */
    _notifyFootprint() {
        const t = this.title;
        const fp = `${this._shadow.scale.x}|${this._shadow.scale.z}|${this._shadow.position.z}|${this._stackH}|${t ? `${t.width}x${t.height}` : ''}`;
        if (fp !== this._footprint) {
            this._footprint = fp;
            for (const cb of this._resizeListeners) cb();
        }
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
                e._seat = null;                   // the rider moved it; its return must re-seat for real
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
     * The desk's mark: ONE flat base-shadow rectangle on the ground under the
     * member footprint — the bounding-volume read laid flat, quiet enough to
     * live under a wall of books. A unit plane carrying a vertex-color falloff
     * (bright interior, smoothstep to dark over the shadowSoft band), scaled to
     * the footprint — knob changes are transform-only; only shadowSoft re-bakes
     * the colors. Additive blending makes "dark" read as "gone", so plain
     * vertex RGB is the whole gradient — no shader, headless-safe. Decoration
     * only: isMarker (the tree's decoration convention), raycast no-op, never
     * registered with picking, depthWrite off, drawn behind content.
     */
    _buildChrome() {
        const geo = new THREE.PlaneGeometry(1, 1, 24, 24);
        geo.rotateX(-Math.PI / 2);   // flat on the ground; falloff reads x/z
        this._paintShadow(geo);
        this._shadow = new THREE.Mesh(geo, this._chromeMaterial());
        this._shadow.name = 'carrel-shadow';
        this._shadow.userData.isMarker = true;
        this._shadow.raycast = () => {};
        this._shadow.renderOrder = RENDER_ORDER.CARREL_CHROME;
        this.add(this._shadow);
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

    /** Bake the falloff into the unit plane (post-rotate: x/z span ±0.5): interior =
     *  white, smoothstep to black across the shadowSoft band at the rim — a soft-edged
     *  rectangle, no hard lines. Re-run when shadowSoft changes. */
    _paintShadow(geo) {
        const pos = geo.attributes.position;
        const colors = new Float32Array(pos.count * 3);
        const soft = Math.max(this.shadowSoft, 1e-3) * 0.5;
        for (let i = 0; i < pos.count; i++) {
            const d = Math.min(0.5 - Math.abs(pos.getX(i)), 0.5 - Math.abs(pos.getZ(i)));
            const t = Math.min(Math.max(d / soft, 0), 1);
            const v = t * t * (3 - 2 * t);
            colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    /** Push glowColor·glowStrength into the chrome material (vertex falloff multiplies it). */
    _tintChrome() {
        const c = new THREE.Color(this.glowColor).multiplyScalar(this.glowStrength);
        this._shadow.material.color.copy(c);
    }

    /** Seat the shadow under the current footprint. Ring: the members stand on the
     *  circle, so the shadow is the tabletop square (±R·tableFrac). Grid: a strip
     *  hugging the wall at z=−R — the live shelf width and the deepest member,
     *  plus the tableFrac overhang. Snaps with the layout (knob gestures read as
     *  direct manipulation). */
    _refreshChrome() {
        const R = Math.max(this._ringR ?? this.radius, 1e-3);
        const pad = R * Math.max(this.tableFrac - 1, 0);
        if (this.mode === 'grid') {
            const boxW = this.boxH * this.boxAspect;
            const halfW = (this._layoutW ? this._layoutW / 2 : boxW / 2) + pad;
            const halfD = Math.max(this._layoutD, boxW) / 2 + pad;
            this._shadow.scale.set(halfW * 2, 1, halfD * 2);
            this._shadow.position.set(0, 0, -R);
        } else {
            const r = R * this.tableFrac;
            this._shadow.scale.set(r * 2, 1, r * 2);
            this._shadow.position.set(0, 0, 0);
        }
        // The title stands over the stack's top, at the wall (grid) / the ring's back.
        if (this.title) {
            const top = (this._stackH ?? this.boxH) + this._gap * 0.5;
            this.title.position.set(0, top + this.title.height / 2, -R);
        }
    }

    // ===================== bounds & state =====================

    /**
     * The desk's airspace in its OWN frame (base-shadow footprint × stack height,
     * plus a breath of headroom) — what a WorldLayout grouping measures (the
     * bounds-fn it registers) and the local half of getBounds.
     * @param {Object} [target] THREE.Box3
     * @returns {Object} THREE.Box3
     */
    getLocalBounds(target = new THREE.Box3()) {
        const board = this._boardPx();
        if (board) {
            // A plane desk's airspace is its board: the flat wall of pins / tiles and its depth.
            const k = this.planeK, tl = this._boardTopLeft();
            const W = board.w / k, H = board.h / k, d = Math.max(this._layoutD ?? 0, 1);
            target.min.set(tl.x, tl.y - H, tl.z - d);
            target.max.set(tl.x + W, tl.y, tl.z + d);
            return target;
        }
        const hx = this._shadow.scale.x / 2, hz = this._shadow.scale.z / 2;
        const cz = this._shadow.position.z;
        target.min.set(-hx, 0, cz - hz);
        target.max.set(hx, (this._stackH ?? this.boxH) + this.boxH * 0.25, cz + hz);
        const t = this.title;
        if (t) {
            const tw = t.width / 2, R = Math.max(this._ringR ?? this.radius, 1e-3);
            target.max.y = Math.max(target.max.y, t.position.y + t.height / 2);
            target.min.x = Math.min(target.min.x, -tw);
            target.max.x = Math.max(target.max.x, tw);
            target.min.z = Math.min(target.min.z, -R);
            target.max.z = Math.max(target.max.z, -R);
        }
        return target;
    }

    /**
     * World AABB of the desk's airspace — what carrel.focus frames and a selection
     * box would draw. Reads matrixWorld as three last left it (see BoundedObject3D.getBounds).
     * @param {Object} [target] THREE.Box3
     * @returns {Object} THREE.Box3
     */
    getBounds(target = new THREE.Box3()) {
        return this.getLocalBounds(target).applyMatrix4(this.matrixWorld);
    }

    /**
     * The carrel as SERIALIZABLE STATE — pose and what it was BORN as (`born`). Its own
     * values (tuned on this desk) are not here: the app keeps them as the desk's tuning
     * and lays them over the born values whenever the desk is built — restore included.
     */
    serialize() {
        return {
            name: this.carrelName,
            managed: this.worldManaged,   // placed by a world grouping — restore re-registers, pose is the layout's
            position: { x: this.position.x, y: this.position.y, z: this.position.z },
            yaw: this.rotation.y,
            params: { ...this.born },
            // No members here — carrel residence is the MODEL's authority (view.carrel).
            // Capture reads listCarreled(); restore writes view.carrel directly.
        };
    }

    dispose() {
        this.animator.dispose?.();
        this.entries.clear();
        this._releasing.clear();
        this._resizeListeners.clear();
        this.title?.dispose?.();
        this.title = null;
        this._shadow.geometry.dispose();
        this._shadow.material.dispose();
    }
}

export default Carrel;
