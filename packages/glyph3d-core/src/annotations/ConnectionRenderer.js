// src/annotations/ConnectionRenderer.js

import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';

const MAX_CONNECTIONS = 256;
const VERTS_PER_CONNECTION = 6; // shaft(2) + arrowL(2) + arrowR(2)
const ARROW_HALF_ANGLE = Math.PI / 7;  // ~25 degrees
const ARROW_LENGTH_RATIO = 0.12;       // arrowhead = 12% of connection length

/**
 * @typedef {Object} ConnectionEntry
 * @property {number} slot
 * @property {{ x, y, z }} from
 * @property {{ x, y, z }} to
 * @property {{ r, g, b }} color
 * @property {Object|null} fromGrid - CodeGrid or null
 * @property {Object|null} toGrid   - CodeGrid or null
 * @property {boolean} visible
 */

/**
 * GPU-efficient line renderer for connections between scene objects.
 * All connections share one THREE.LineSegments geometry — one draw call total.
 * Supports arrowheads, frustum-aware visibility, and partial buffer uploads.
 *
 * Usage:
 *   const cr = new ConnectionRenderer(scene);
 *   cr.set('my-link', from, to, color, { fromGrid, toGrid });
 *   // in animate loop, after virtualizer.update():
 *   cr.refreshVisibility();
 */
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
    }

    /**
     * Add or replace a connection. Idempotent: same id -> same visual result.
     * Stores grid references for frustum-aware visibility via refreshVisibility().
     * @param {string} id - stable identifier (e.g. 'call:foo->bar')
     * @param {{ x, y, z }} from - world-space start point
     * @param {{ x, y, z }} to   - world-space end point
     * @param {{ r, g, b }} color
     * @param {Object} [opts]
     * @param {Object|null} [opts.fromGrid] - source CodeGrid (for frustum check)
     * @param {Object|null} [opts.toGrid]   - target CodeGrid (for frustum check)
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
            entry = { slot, from: null, to: null, color: null, fromGrid: null, toGrid: null, visible: true };
            this._connections.set(id, entry);
        }
        entry.from = from;
        entry.to = to;
        entry.color = color;
        if (fromGrid !== undefined) entry.fromGrid = fromGrid;
        if (toGrid !== undefined) entry.toGrid = toGrid;
        this._writeSlot(entry.slot, from, to, color);
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
     * Called each frame after virtualizer.update(). Hides connections whose grids are
     * off-screen (grid.parent === null) and restores them when grids re-appear.
     */
    refreshVisibility() {
        for (const [, entry] of this._connections) {
            const shouldShow = (!entry.fromGrid || entry.fromGrid.parent !== null)
                            && (!entry.toGrid   || entry.toGrid.parent   !== null);
            if (shouldShow !== entry.visible) {
                entry.visible = shouldShow;
                if (shouldShow) {
                    this._writeSlot(entry.slot, entry.from, entry.to, entry.color);
                } else {
                    this._zeroSlot(entry.slot);
                }
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
