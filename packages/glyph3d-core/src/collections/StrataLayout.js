import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';

/**
 * StrataLayout — a per-grid ARRANGER that renders a file as nested Z-depth STRATA.
 *
 * Every node in the SemanticModel tree (already a normalized tree of declarations, not
 * raw tokens) floats FORWARD in Z by its nesting depth, and gets a thin border box drawn
 * around its glyph bounds. The text keeps its normal X/Y flow — fully readable — so depth
 * is expressed purely as physical layers + boxes: a class sits on the back plane, its
 * methods float a step toward you, a nested closure another step, each ringed by a box.
 *
 * It registers into the grid's relayout pipeline like StructureLayout, so it can never go
 * stale: `arrange` runs INSIDE every fold (CodeGrid._applyArrangers), re-deriving the Z
 * offsets + boxes from the AST on the freshly-folded buffer. Unlike StructureLayout (a
 * LENS that grids one kind and hides the rest), StrataLayout keeps EVERY glyph visible and
 * only moves Z — it's a depth reading of the whole file, not a selection.
 *
 * The boxes are one batched THREE.LineSegments parented to the glyph instanceMesh, so they
 * live in the exact same local space as the per-glyph instancePositions measureSlotRange
 * reads — no transform bookkeeping, they track the grid for free.
 *
 * v1 keeps X/Y at flow; a later pass can repack each depth level (newspaper-on-scope-
 * boundary). Tuning lives in STRATA_DEFAULTS (configurable from birth via the ctor opts).
 */

/** Tuning — all factors are × the grid's lineSpacing so they scale with the font. */
export const STRATA_DEFAULTS = Object.freeze({
    zStepFactor: 1.5,   // how far a node floats forward per nesting level (× lineSpacing)
    padFactor:   0.35,  // box outset around a node's glyph bounds (× lineSpacing)
    boxOpacity:  0.6,
    minSlots:    2,     // skip boxing nodes smaller than this many glyphs
    maxDepth:    16,    // recursion guard
});

// Depth palette — boxes tint by nesting level so you can read depth at a glance (cycles).
const DEPTH_COLORS = [
    [0.42, 0.55, 0.70],  // slate blue   (depth 0)
    [0.46, 0.70, 0.55],  // green
    [0.80, 0.66, 0.40],  // amber
    [0.74, 0.50, 0.68],  // magenta
    [0.45, 0.72, 0.76],  // cyan
    [0.78, 0.56, 0.46],  // terracotta
];

export class StrataLayout {
    /** @param {import('./CodeGrid.js').default} grid */
    constructor(grid, opts = {}) {
        this._grid = grid;
        this.cfg = { ...STRATA_DEFAULTS, ...opts };
        this._active = false;
        this._healing = false;
        this._boxMesh = null;
        this._boxGeo = null;
        this._boxMat = null;
    }

    get active() { return this._active; }

    /** Begin the strata view: register as an arranger and re-fold (arrange bakes it). */
    async start() {
        if (!this._renderer()) return { ok: false, reason: 'grid has no renderer' };
        if (!this._grid.getSemantics?.()) await this._grid.ensureSemantics?.();
        const model = this._grid.getSemantics?.();
        if (!model) return { ok: false, reason: 'semantic model not ready' };
        const nodes = this._collect(model);
        if (!nodes.length) return { ok: false, reason: 'no structural nodes in this file' };

        this._active = true;
        this._grid.registerArranger(this);
        await this._grid._relayoutInPlace();
        return { ok: true, count: nodes.length, maxDepth: nodes.reduce((d, n) => Math.max(d, n.depth), 0) };
    }

    /** Stop the strata view: drop the boxes, unregister, and re-fold back to flow. */
    async reset() {
        const was = this._active;
        this._active = false;
        this._grid.unregisterArranger?.(this);
        this._clearBoxes();
        if (was) await this._grid._relayoutInPlace?.();
        return { ok: true };
    }

    /**
     * ARRANGE hook (CodeGrid._applyArrangers, inside every fold). Re-derives Z-by-depth +
     * boxes from the AST on the freshly-folded (flow) buffer. Idempotent per fold.
     * @param {import('./CodeGrid.js').default} grid
     */
    arrange(grid) {
        const r = this._renderer();
        if (!r || !this._active) return;
        // An edit invalidates the content-identity AST cache. Prefer a synchronous re-parse
        // (engine is warm once active) so we re-derive in THIS fold — no flow flash.
        const model = grid.getSemantics?.() || grid.refreshSemanticsSync?.();
        if (!model) { this._healLater(grid); return; }

        const pos = r.getInstancePositions();
        if (!pos) return;
        const total = r.instanceMesh?.geometry?.instanceCount ?? 0;

        const unit  = grid.metrics?.lineSpacing ?? grid.metrics?.charHeight ?? 1;
        const zStep = unit * this.cfg.zStepFactor;
        const pad   = unit * this.cfg.padFactor;

        const nodes = this._collect(model);
        if (!nodes.length) return;

        // 1) Z by depth. Pre-order (parent before child) so a child's deeper Z overwrites
        //    the parent's for the glyphs they share — each glyph lands on its DEEPEST scope.
        //    The parent's own direct glyphs (its header/footer, the gaps between children)
        //    keep the parent's plane.
        const boxes = [];
        for (const { node, depth } of nodes) {
            const range = this._slotRange(node, total);
            if (!range) continue;
            const z = depth * zStep;
            for (let s = range.start; s < range.end; s++) pos[s * 3 + 2] = z;
            boxes.push({ start: range.start, count: range.end - range.start, depth, z });
        }
        r.markInstanceTransformsDirty();

        // 2) Boxes — measure each node's X/Y bounds from the now-shifted buffer, draw a flat
        //    rectangle at the node's OWN depth plane (not the measured z-span, which mixes
        //    the parent header at one plane with child bodies at another).
        this._rebuildBoxes(r, boxes, pad);
    }

    // ---- internals ----

    _renderer() { return this._grid.getRenderer?.() ?? this._grid._renderer ?? null; }

    /** Pre-order list of every tree node with its depth (roots = 0). */
    _collect(model) {
        const out = [];
        const visit = (nodes, depth) => {
            if (depth > this.cfg.maxDepth) return;
            for (const n of nodes || []) {
                out.push({ node: n, depth });
                if (n.children?.length) visit(n.children, depth + 1);
            }
        };
        visit(model.roots ?? (model.outline ? model.outline() : []), 0);
        return out;
    }

    /** Inclusive-start / exclusive-end slot range for a node, clamped; null if too small. */
    _slotRange(node, total) {
        const start = this._grid.getSlotForChar(node.start.line, node.start.col);
        const end   = this._endSlot(node.end);
        if (start < 0 || end <= start) return null;
        const e = Math.min(total, end);
        if (e - start < this.cfg.minSlots) return null;
        return { start, end: e };
    }

    /** Exclusive end slot for a node ending at {line,col} (col exclusive). Mirrors the
     *  end-of-line fallback StructureLayout uses so a node ending past the last glyph still
     *  resolves to the slot after that line's final glyph. */
    _endSlot(end) {
        const s = this._grid.getSlotForChar(end.line, end.col);
        if (s >= 0) return s;
        for (let l = end.line; l >= 0; l--) {
            const c = this._grid.getLineSlotCount?.(l) ?? 0;
            if (c > 0) {
                const last = this._grid.getSlotForChar(l, c - 1);
                if (last >= 0) return last + 1;
            }
        }
        return -1;
    }

    /** Rebuild the batched box LineSegments — 4 edges (8 verts) per node. */
    _rebuildBoxes(r, boxes, pad) {
        if (!boxes.length) { this._clearBoxes(); return; }
        const cap = boxes.length * 8;                 // 4 edges × 2 verts
        const posArr = new Float32Array(cap * 3);
        const colArr = new Float32Array(cap * 3);
        let v = 0;
        for (const b of boxes) {
            const bb = r.measureSlotRange(b.start, b.count);
            if (!bb) continue;
            const x0 = bb.min.x - pad, y0 = bb.min.y - pad;
            const x1 = bb.max.x + pad, y1 = bb.max.y + pad;
            const z = b.z;
            const c = DEPTH_COLORS[b.depth % DEPTH_COLORS.length];
            // edges: bottom, right, top, left
            const e = [x0,y0, x1,y0,  x1,y0, x1,y1,  x1,y1, x0,y1,  x0,y1, x0,y0];
            for (let k = 0; k < 8; k++) {
                posArr[v*3] = e[k*2]; posArr[v*3+1] = e[k*2+1]; posArr[v*3+2] = z;
                colArr[v*3] = c[0]; colArr[v*3+1] = c[1]; colArr[v*3+2] = c[2];
                v++;
            }
        }
        if (!this._ensureBoxMesh(r)) return;
        this._boxGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        this._boxGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
        this._boxGeo.setDrawRange(0, v);
    }

    /** Create the box mesh (once) and keep it parented to the live instanceMesh, so it
     *  shares the glyphs' local space and survives buffer-reusing re-folds. */
    _ensureBoxMesh(r) {
        const parent = r.instanceMesh;
        if (!parent) return false;
        if (!this._boxMesh) {
            this._boxGeo = new THREE.BufferGeometry();
            this._boxMat = new THREE.LineBasicMaterial({
                vertexColors: true, transparent: true, opacity: this.cfg.boxOpacity,
                depthTest: true, depthWrite: false,
            });
            this._boxMesh = new THREE.LineSegments(this._boxGeo, this._boxMat);
            this._boxMesh.frustumCulled = false;
            this._boxMesh.renderOrder = RENDER_ORDER.CONNECTION; // draw over the glyph quads
        }
        if (this._boxMesh.parent !== parent) {
            this._boxMesh.parent?.remove(this._boxMesh);
            parent.add(this._boxMesh);
        }
        return true;
    }

    _clearBoxes() {
        if (!this._boxMesh) return;
        this._boxMesh.parent?.remove(this._boxMesh);
        this._boxGeo?.dispose();
        this._boxMat?.dispose();
        this._boxMesh = null; this._boxGeo = null; this._boxMat = null;
    }

    /** Cold-engine fallback: re-fold once the model rebuilds (brief flow flash between). */
    _healLater(grid) {
        if (this._healing) return;
        this._healing = true;
        Promise.resolve(grid.ensureSemantics?.()).then(() => {
            this._healing = false;
            if (this._active) grid._relayoutInPlace?.();
        }).catch(() => { this._healing = false; });
    }
}

export default StrataLayout;
