// src/annotations/ConnectionRenderer.js

import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';

const MAX_CONNECTIONS = 256;
const VERTS_PER_CONNECTION = 6; // shaft(2) + arrowL(2) + arrowR(2)
const ARROW_HALF_ANGLE = Math.PI / 7;  // ~25 degrees
const ARROW_LENGTH_RATIO = 0.12;       // arrowhead = 12% of connection length

/**
 * @typedef {{ object: import('three').Object3D, local?: { x, y, z } }} Anchor
 *   a point PINNED inside an object's local space — resolved to world each frame so
 *   the connection follows the object (drag, relayout, scroll) for free.
 */

/**
 * @typedef {Object} ConnectionEntry
 * @property {number} slot
 * @property {{ x, y, z }|null} from - literal world point (static endpoint), or null if bound
 * @property {{ x, y, z }|null} to
 * @property {Anchor|null} fromAnchor - bound endpoint (follows its object), or null if static
 * @property {Anchor|null} toAnchor
 * @property {{ r, g, b }} color
 * @property {Object|null} fromGrid - visibility ref for a STATIC endpoint
 * @property {Object|null} toGrid
 * @property {boolean} visible
 */

/**
 * GPU-efficient line renderer for connections between scene objects.
 * All connections share one THREE.LineSegments geometry — one draw call total.
 * Supports arrowheads, frustum-aware visibility, and partial buffer uploads.
 *
 * Each endpoint is EITHER a literal world point {x,y,z} (static) OR an ANCHOR — an
 * Object3D (or { object, local }) the endpoint is pinned to. Bound endpoints resolve
 * their world position from the object's matrix every refresh(), so the line follows
 * the object through drags/relayout without the caller re-setting positions. (You
 * can't scene-parent a batched line — its two ends follow two different parents — so
 * binding-and-resolving is the parenting.)
 *
 * Usage:
 *   const cr = new ConnectionRenderer(scene);
 *   cr.set('static', fromPoint, toPoint, color, { fromGrid, toGrid });  // frozen
 *   cr.set('bound',  callGrid,  snapGrid,  color);                       // follows the grids
 *   // each frame: cr.refresh();
 */
/** Normalize an endpoint arg into an Anchor, or null if it's a literal {x,y,z} point. */
function _asAnchor(ep) {
    if (!ep) return null;
    if (ep.isObject3D) return { object: ep };                                  // a bare Object3D
    if (ep.object?.isObject3D) return { object: ep.object, local: ep.local || null };
    return null;                                                              // literal world point
}

export default class ConnectionRenderer {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} [options]
     * @param {number} [options.maxConnections=256]
     * @param {number} [options.arrowLengthRatio=0.12]
     */
    constructor(scene, options = {}) {
        this._scene = scene;
        this._max = options.maxConnections ?? MAX_CONNECTIONS;
        this._arrowRatio = options.arrowLengthRatio ?? ARROW_LENGTH_RATIO;

        /** @type {Map<string, ConnectionEntry>} id -> entry */
        this._connections = new Map();

        this._posArr  = new Float32Array(this._max * VERTS_PER_CONNECTION * 3);
        this._colArr  = new Float32Array(this._max * VERTS_PER_CONNECTION * 3);
        this._slotFree = Array.from({ length: this._max }, (_, i) => i).reverse();

        this._geo = new THREE.BufferGeometry();
        this._posBuf = new THREE.BufferAttribute(this._posArr, 3);
        this._colBuf = new THREE.BufferAttribute(this._colArr, 3);
        this._posBuf.setUsage(THREE.DynamicDrawUsage);
        this._colBuf.setUsage(THREE.DynamicDrawUsage);
        this._geo.setAttribute('position', this._posBuf);
        this._geo.setAttribute('color',    this._colBuf);
        this._geo.setDrawRange(0, 0);

        this._mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            depthTest: true,
            depthWrite: false,
            transparent: true,
            opacity: 1.0,
        });

        this._mesh = new THREE.LineSegments(this._geo, this._mat);
        this._mesh.frustumCulled = false; // connections span arbitrary world space
        this._mesh.renderOrder = RENDER_ORDER.CONNECTION;       // draw on top of grid quads
        scene.add(this._mesh);

        this._tmpA = new THREE.Vector3();   // scratch for anchor resolution
        this._tmpB = new THREE.Vector3();
    }

    /**
     * Add or replace a connection. Idempotent: same id -> same visual result.
     * Bound endpoints (Object3D / anchor) follow their object each refresh(); literal
     * points stay put and cull via opts.fromGrid/toGrid.
     * @param {string} id - stable identifier (e.g. 'call:foo->bar')
     * @param {{ x, y, z }|import('three').Object3D|Anchor} from - a literal world point,
     *   an Object3D, or an { object, local } anchor. Anchors follow their object each refresh().
     * @param {{ x, y, z }|import('three').Object3D|Anchor} to
     * @param {{ r, g, b }} color
     * @param {Object} [opts]
     * @param {Object|null} [opts.fromGrid] - visibility ref for a STATIC endpoint (anchors self-cull)
     * @param {Object|null} [opts.toGrid]
     * @returns {string} id
     */
    set(id, from, to, color, { fromGrid, toGrid } = {}) {
        let entry = this._connections.get(id);
        if (!entry) {
            const slot = this._slotFree.pop();
            if (slot === undefined) {
                console.warn('[ConnectionRenderer] MAX_CONNECTIONS reached, dropping:', id);
                return id;
            }
            entry = { slot, from: null, to: null, fromAnchor: null, toAnchor: null, color: null, fromGrid: null, toGrid: null, visible: true };
            this._connections.set(id, entry);
        }
        entry.fromAnchor = _asAnchor(from);
        entry.toAnchor   = _asAnchor(to);
        entry.from = entry.fromAnchor ? null : from;
        entry.to   = entry.toAnchor   ? null : to;
        entry.color = color;
        if (fromGrid !== undefined) entry.fromGrid = fromGrid;
        if (toGrid !== undefined) entry.toGrid = toGrid;
        // Draw once now (bound endpoints get re-resolved every refresh()).
        const f = entry.fromAnchor ? this._resolveAnchor(entry.fromAnchor, this._tmpA) : from;
        const t = entry.toAnchor   ? this._resolveAnchor(entry.toAnchor, this._tmpB)   : to;
        this._writeSlot(entry.slot, f, t, color);
        this._refreshDrawRange();
        return id;
    }

    /**
     * Remove a connection by id. Zeroes its vertices (degenerate — GPU discards).
     * @param {string} id
     */
    remove(id) {
        const entry = this._connections.get(id);
        if (!entry) return;
        this._zeroSlot(entry.slot);
        this._slotFree.push(entry.slot);
        this._connections.delete(id);
        this._refreshDrawRange();
    }

    /**
     * Remove all connections.
     */
    clear() {
        for (const id of [...this._connections.keys()]) this.remove(id);
    }

    /**
     * Update only the position of an existing connection.
     * Reads color from the cached entry (not from buffer).
     * @param {string} id
     * @param {{ x, y, z }} from
     * @param {{ x, y, z }} to
     */
    updatePosition(id, from, to) {
        const entry = this._connections.get(id);
        if (!entry) return;
        entry.from = from;
        entry.to = to;
        this._writeSlot(entry.slot, from, to, entry.color);
    }

    /**
     * Update only the color of an existing connection.
     * @param {string} id
     * @param {{ r, g, b }} color
     */
    setColor(id, color) {
        const entry = this._connections.get(id);
        if (!entry) return;
        entry.color = color;
        this._writeSlot(entry.slot, entry.from, entry.to, color);
    }

    /**
     * Called each frame. For BOUND connections, re-resolves both endpoints from their
     * anchor objects' current world matrices and rewrites the slot (this is what makes
     * a tether follow a dragged corridor). For STATIC connections, only rewrites on a
     * visibility transition. Either way, culls when an endpoint's object leaves the
     * scene (parent === null) and restores it when it returns.
     */
    refresh() {
        for (const [, entry] of this._connections) {
            const fromObj = entry.fromAnchor?.object || entry.fromGrid;
            const toObj   = entry.toAnchor?.object   || entry.toGrid;
            const shouldShow = (!fromObj || fromObj.parent !== null)
                            && (!toObj   || toObj.parent   !== null);

            if (!shouldShow) {
                if (entry.visible) { entry.visible = false; this._zeroSlot(entry.slot); }
                continue;
            }
            if (entry.fromAnchor || entry.toAnchor) {
                // Bound: resolve live world positions and rewrite every frame.
                const f = entry.fromAnchor ? this._resolveAnchor(entry.fromAnchor, this._tmpA) : entry.from;
                const t = entry.toAnchor   ? this._resolveAnchor(entry.toAnchor, this._tmpB)   : entry.to;
                entry.visible = true;
                this._writeSlot(entry.slot, f, t, entry.color);
            } else if (!entry.visible) {
                // Static: just re-entered the frustum.
                entry.visible = true;
                this._writeSlot(entry.slot, entry.from, entry.to, entry.color);
            }
        }
    }

    /**
     * Show or hide all connections. O(1) — just toggles mesh visibility.
     * @param {boolean} visible
     */
    setVisible(visible) {
        this._mesh.visible = visible;
    }

    /**
     * Free GPU resources.
     */
    dispose() {
        this._scene.remove(this._mesh);
        this._geo.dispose();
        this._mat.dispose();
    }

    // -- private ----------------------------------------------------------

    /**
     * Resolve a bound anchor to its current world position (into `out`). Freshens the
     * object's transform chain (parents only — skips its heavy descendant grids) so a
     * mid-drag read is zero-lag.
     * @param {Anchor} anchor
     * @param {THREE.Vector3} out
     * @returns {THREE.Vector3}
     * @private
     */
    _resolveAnchor(anchor, out) {
        const obj = anchor.object;
        obj.updateWorldMatrix(true, false);
        const lo = anchor.local;
        return lo
            ? out.set(lo.x || 0, lo.y || 0, lo.z || 0).applyMatrix4(obj.matrixWorld)
            : out.setFromMatrixPosition(obj.matrixWorld);
    }

    /**
     * Write shaft + arrowhead vertices for a slot.
     * Uses addUpdateRange for partial GPU upload — only this slot's region is uploaded.
     * @param {number} slot
     * @param {{ x, y, z }} from
     * @param {{ x, y, z }} to
     * @param {{ r, g, b }} color
     * @private
     */
    _writeSlot(slot, from, to, color) {
        const base = slot * VERTS_PER_CONNECTION * 3;
        const p = this._posArr;
        const c = this._colArr;

        // Direction vector
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dz = to.z - from.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) { this._zeroSlot(slot); return; }

        // Shaft: from -> to
        p[base]     = from.x; p[base + 1] = from.y; p[base + 2] = from.z;
        p[base + 3] = to.x;   p[base + 4] = to.y;   p[base + 5] = to.z;

        // Arrowhead: two lines from `to` backward along shaft direction, spread by angle
        const arrowLen = len * this._arrowRatio;
        const ux = dx / len, uy = dy / len, uz = dz / len;

        // Build a perpendicular vector. Pick axis least aligned with direction.
        let px, py, pz;
        if (Math.abs(ux) < 0.9) { px = 0; py = -uz; pz = uy; }
        else                     { px = uy; py = -ux; pz = 0; }
        const plen = Math.sqrt(px * px + py * py + pz * pz);
        px /= plen; py /= plen; pz /= plen;

        const sinA = Math.sin(ARROW_HALF_ANGLE);
        const cosA = Math.cos(ARROW_HALF_ANGLE);

        // Arrow left: to + arrowLen * (-u * cosA + p * sinA)
        const al = base + 6;
        p[al]     = to.x; p[al + 1] = to.y; p[al + 2] = to.z;
        p[al + 3] = to.x + arrowLen * (-ux * cosA + px * sinA);
        p[al + 4] = to.y + arrowLen * (-uy * cosA + py * sinA);
        p[al + 5] = to.z + arrowLen * (-uz * cosA + pz * sinA);

        // Arrow right: to + arrowLen * (-u * cosA - p * sinA)
        const ar = base + 12;
        p[ar]     = to.x; p[ar + 1] = to.y; p[ar + 2] = to.z;
        p[ar + 3] = to.x + arrowLen * (-ux * cosA - px * sinA);
        p[ar + 4] = to.y + arrowLen * (-uy * cosA - py * sinA);
        p[ar + 5] = to.z + arrowLen * (-uz * cosA - pz * sinA);

        // Colors: all 6 vertices same color
        const { r, g, b } = color;
        for (let v = 0; v < VERTS_PER_CONNECTION; v++) {
            c[base + v * 3]     = r;
            c[base + v * 3 + 1] = g;
            c[base + v * 3 + 2] = b;
        }

        // Partial GPU upload — array element indices (floats), not bytes.
        // vertBase * 3 converts vertex index to float index; VERTS_PER_CONNECTION * 3 is float count.
        const vertBase = slot * VERTS_PER_CONNECTION;
        this._posBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3);
        this._colBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3);
        this._posBuf.needsUpdate = true;
        this._colBuf.needsUpdate = true;
    }

    /** @private */
    _zeroSlot(slot) {
        const base = slot * VERTS_PER_CONNECTION * 3;
        this._posArr.fill(0, base, base + VERTS_PER_CONNECTION * 3);
        this._colArr.fill(0, base, base + VERTS_PER_CONNECTION * 3);
        const vertBase = slot * VERTS_PER_CONNECTION;
        this._posBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3);
        this._posBuf.needsUpdate = true;
        this._colBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3);
        this._colBuf.needsUpdate = true;
    }

    /**
     * Recompute setDrawRange to cover all occupied slots.
     * Vertex count = activeConnections * VERTS_PER_CONNECTION.
     * @private
     */
    _refreshDrawRange() {
        if (this._connections.size === 0) {
            this._geo.setDrawRange(0, 0);
            return;
        }
        let maxSlot = 0;
        for (const { slot } of this._connections.values()) {
            if (slot > maxSlot) maxSlot = slot;
        }
        this._geo.setDrawRange(0, (maxSlot + 1) * VERTS_PER_CONNECTION);
    }
}
