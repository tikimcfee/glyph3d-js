import { flowBoxes, squareWrap } from './layouts/flowBoxes.js';

/**
 * StructureLayout — a per-grid control surface that re-arranges a code grid's
 * glyphs BY SEMANTIC ENTITY, using the AST.
 *
 * Each AST node of a chosen kind is a contiguous glyph slot range (slots are
 * source-order). We measure its bounds, arrange the blocks with the shared
 * box-packer, and move each block by assigning its slot range to a transform
 * GROUP with an offset — which the shader ADDS on top of the base flow layout, so
 * it composes with (rather than fights) the normal layout and rides relayout.
 *
 * Language-agnostic by construction: it reads the SemanticModel's NORMALIZED
 * kinds (function/method/class/interface/enum/…), never a language's raw node
 * types. Any tree-sitter grammar the arborist supports works unchanged.
 *
 * v1 is a LENS: arrange the top-level blocks of one kind into a size-sorted grid
 * and hide everything else; reset() restores. Recursion (methods within a class),
 * side-by-side, and a full structural re-layout build on the same three atoms:
 * measure a range, move a range (group offset), hide a range (group visibility).
 */
export class StructureLayout {
    /** @param {import('./CodeGrid.js').default} grid */
    constructor(grid) {
        this._grid = grid;
        /** @type {{kind:string, scheme:string, count:number}|null} */
        this._scheme = null;
    }

    /** The active arrangement, or null when the grid is in its normal flow. */
    get active() { return this._scheme; }

    /**
     * Arrange the grid's top-level <kind> blocks into a grid sorted by glyph
     * surface area (smallest→largest), hiding everything else. Lens-style.
     * @param {string} [kind='function']
     * @returns {{ok:boolean, count?:number, reason?:string}}
     */
    grid(kind = 'function') {
        const r = this._renderer();
        const model = this._grid.getSemantics?.();
        if (!r || !model) return { ok: false, reason: 'grid has no renderer or semantic model' };

        const blocks = this._blocks(model, kind, r);
        if (!blocks.length) return { ok: false, reason: `no top-level ${kind} blocks in this file` };

        // Smallest surface-area first, then pack into a roughly-square grid.
        blocks.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
        const sizes = blocks.map((b) => ({ w: b.bounds.width, h: b.bounds.height }));
        const margin = (this._grid.metrics?.lineSpacing ?? this._grid.metrics?.charHeight ?? 1) * 1.6;
        const { slots } = flowBoxes(sizes, { margin, wrapWidth: squareWrap(sizes, margin) });

        this._apply(r, blocks, slots);
        this._scheme = { kind, scheme: 'grid', count: blocks.length };
        return { ok: true, count: blocks.length };
    }

    /** Restore every glyph to the identity group — back to the normal flow layout. */
    reset() {
        const r = this._renderer();
        if (!r) return { ok: false };
        r.setGlyphGroupRange(0, this._glyphCount(r), 0);
        this._scheme = null;
        return { ok: true };
    }

    // ---- internals ----

    _renderer() { return this._grid.getRenderer?.() ?? this._grid._renderer ?? null; }

    _glyphCount(r) { return r.instanceMesh?.geometry?.instanceCount ?? 0; }

    /** Top-level nodes of `kind` → [{node, startSlot, count, bounds}]. */
    _blocks(model, kind, r) {
        const top = model.outline ? model.outline() : (model.roots ?? []); // top-level (no nesting overlap)
        const out = [];
        for (const n of top) {
            if (n.kind !== kind) continue;
            const startSlot = this._grid.getSlotForChar(n.start.line, n.start.col);
            const endSlot = this._endSlot(n.end);
            if (startSlot < 0 || endSlot <= startSlot) continue;
            const bounds = r.measureSlotRange(startSlot, endSlot - startSlot);
            if (!bounds) continue;
            out.push({ node: n, startSlot, count: endSlot - startSlot, bounds });
        }
        return out;
    }

    /** Exclusive end slot for a node ending at {line, col} (col exclusive). */
    _endSlot(end) {
        const s = this._grid.getSlotForChar(end.line, end.col);
        if (s >= 0) return s;
        // end.col is past the line's glyphs (end-of-line / blank) → slot after the
        // last glyph on the nearest non-empty line at or above end.line.
        for (let l = end.line; l >= 0; l--) {
            const c = this._grid.getLineSlotCount?.(l) ?? 0;
            if (c > 0) {
                const last = this._grid.getSlotForChar(l, c - 1);
                if (last >= 0) return last + 1;
            }
        }
        return -1;
    }

    /**
     * Hide everything, then reveal each block at its packed slot via a group offset.
     * The packing is anchored at the grid's local origin (where the flow content sits),
     * so the block grid replaces the linear text in place. Offsets are local-space,
     * matching the slot/bounds units; the grid's world matrix carries the whole thing.
     */
    _apply(r, blocks, slots) {
        const hidden = r.createGroup();
        r.setGroupVisibility(hidden, false);
        r.setGlyphGroupRange(0, this._glyphCount(r), hidden);

        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const slot = slots[i];
            const g = r.createGroup();
            r.setGroupOffset(g, {
                x: slot.x - b.bounds.min.x, // slot.x = box left; bounds.min.x = block left
                y: slot.y - b.bounds.max.y, // slot.y = box top (y descends); bounds.max.y = block top
                z: 0,
            });
            r.setGlyphGroupRange(b.startSlot, b.count, g);
        }
    }
}

export default StructureLayout;
