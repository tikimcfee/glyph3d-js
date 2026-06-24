import { flowBoxes, squareWrap } from './layouts/flowBoxes.js';

// "Callable units" — the default griddable leaf scopes. A file is rarely a bag of
// free functions; it's usually a class full of methods. So the default grids
// functions AND methods wherever they nest (outermost-first), which is what you
// almost always mean by "lay out this file's routines".
const LEAF_SCOPES = new Set(['function', 'method', 'constructor', 'getter', 'setter']);

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
     * Arrange the grid's blocks into a grid sorted by glyph surface area
     * (smallest→largest), hiding everything else. Lens-style.
     * @param {string|null} [kind=null] a specific normalized kind, or null for the
     *   "callable units" default (functions + methods at any depth).
     * @returns {{ok:boolean, count?:number, reason?:string, available?:string[]}}
     */
    async grid(kind = null) {
        const r = this._renderer();
        const model = this._grid.getSemantics?.();
        if (!r || !model) return { ok: false, reason: 'grid has no renderer or semantic model' };

        // A structural arrangement moves each block as one rigid swathe, so a block must
        // be a CONTIGUOUS vertical run. A paginated (newspaper) layout fans a long method
        // across columns — moving it as a unit then shatters it into hanging fragments.
        // Collapse to a single long column first; reset() restores the prior pagination.
        const cur = this._grid.getLayout?.();
        if (cur && ((cur.pagesWide ?? 1) > 1 || (cur.pageHeight ?? 0) > 0)) {
            this._priorLayout = { pageHeight: cur.pageHeight ?? 0, pagesWide: cur.pagesWide ?? 1 };
            await this._grid.setLayout({ pageHeight: 0, pagesWide: 1 });
        }

        const blocks = this._blocks(model, kind, r);
        if (!blocks.length) {
            const available = [...new Set((model.flat ?? []).map((n) => n.kind))].filter(Boolean);
            return { ok: false, reason: kind ? `no ${kind} blocks` : 'no functions or methods', available };
        }

        // Smallest surface-area first, then pack into a roughly-square grid. The grid is
        // free to take its natural shape — the caller re-fits the scene (a tree relayout)
        // around the grown footprint afterwards, exactly like a layout-mode change, so a
        // bigger arrangement never overlaps its neighbours.
        blocks.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
        const sizes = blocks.map((b) => ({ w: b.bounds.width, h: b.bounds.height }));
        const margin = (this._grid.metrics?.lineSpacing ?? this._grid.metrics?.charHeight ?? 1) * 1.6;
        const { slots } = flowBoxes(sizes, { margin, wrapWidth: squareWrap(sizes, margin) });

        this._apply(r, blocks, slots);
        this._scheme = { kind: kind || 'callable', scheme: 'grid', count: blocks.length };
        return { ok: true, count: blocks.length };
    }

    /**
     * Debug: for each block, what the AST claims vs. what the slot range actually
     * lands on — so an off-by-N shows up as a mismatch between `head`/`tail` (the
     * AST's view of the text) and `slotHead`/`slotTail` (the glyphs the range moves).
     */
    inspect(kind = null) {
        const r = this._renderer();
        const model = this._grid.getSemantics?.();
        if (!r || !model) return { ok: false, reason: 'no renderer or semantic model' };
        const lines = this._grid.lines || [];
        const charAt = (slot) => {
            const c = this._grid.getCharForSlot?.(slot);
            return c ? { at: `${c.line}:${c.col}`, ch: (lines[c.line] ?? '')[c.col] ?? '' } : null;
        };
        const blocks = this._blocks(model, kind, r).map((b) => {
            const s = b.node.start, e = b.node.end;
            return {
                kind: b.node.kind, name: b.node.name,
                node: `${s.line}:${s.col}..${e.line}:${e.col}`,
                slots: `${b.startSlot}..${b.startSlot + b.count}`,
                head: (lines[s.line] ?? '').slice(s.col, s.col + 20),
                tail: (lines[e.line] ?? '').slice(Math.max(0, e.col - 20), e.col),
                slotHead: charAt(b.startSlot),               // glyph the range STARTS on
                slotTail: charAt(b.startSlot + b.count - 1), // glyph the range ENDS on
            };
        });
        return { ok: true, count: blocks.length, blocks };
    }

    /** Restore every glyph to the identity group + the prior pagination — back to flow. */
    async reset() {
        const r = this._renderer();
        if (!r) return { ok: false };
        r.setGlyphGroupRange(0, this._glyphCount(r), 0);
        r.refreshBounds();                            // re-walk the base positions
        this._grid.setContentBoundsOverride?.(null);  // drop the override → recompute
        this._scheme = null;
        if (this._priorLayout) {
            const prior = this._priorLayout;
            this._priorLayout = null;
            await this._grid.setLayout?.(prior);      // restore the pagination we collapsed
        }
        return { ok: true };
    }

    // ---- internals ----

    _renderer() { return this._grid.getRenderer?.() ?? this._grid._renderer ?? null; }

    _glyphCount(r) { return r.instanceMesh?.geometry?.instanceCount ?? 0; }

    /**
     * Outermost nodes matching the kind → [{node, startSlot, count, bounds}].
     * Don't descend into a match (so a block's nested functions stay part of it,
     * and parent/child never both get selected → no overlap). With no kind, the
     * default is the "callable units" — functions + methods wherever they nest, so
     * a class's methods grid just as cleanly as a file's free functions.
     */
    _blocks(model, kind, r) {
        const match = kind ? (n) => n.kind === kind : (n) => LEAF_SCOPES.has(n.kind);
        const picked = [];
        const visit = (nodes) => {
            for (const n of nodes || []) {
                if (match(n)) picked.push(n);                   // outermost match — stop here
                else if (n.children?.length) visit(n.children); // a container — descend to find members
            }
        };
        visit(model.roots ?? (model.outline ? model.outline() : []));

        const out = [];
        for (const n of picked) {
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

        // Track the ARRANGED extent: glyphs move via in-shader group offsets, so the
        // renderer's base-position bounds-walk can't see the new shape. We feed the
        // extent we already know to both the frustum-cull bounds and the grid's
        // content bounds — otherwise blocks fall outside the stale box and get culled.
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const slot = slots[i];
            const ox = slot.x - b.bounds.min.x; // slot.x = box left; bounds.min.x = block left
            const oy = slot.y - b.bounds.max.y; // slot.y = box top (y descends); bounds.max.y = block top
            const g = r.createGroup();
            r.setGroupOffset(g, { x: ox, y: oy, z: 0 });
            r.setGlyphGroupRange(b.startSlot, b.count, g);

            // block's arranged box: [slot.x, slot.y - h] .. [slot.x + w, slot.y]
            if (slot.x < minX) minX = slot.x;
            if (slot.y - b.bounds.height < minY) minY = slot.y - b.bounds.height;
            if (b.bounds.min.z < minZ) minZ = b.bounds.min.z;
            if (slot.x + b.bounds.width > maxX) maxX = slot.x + b.bounds.width;
            if (slot.y > maxY) maxY = slot.y;
            if (b.bounds.max.z > maxZ) maxZ = b.bounds.max.z;
        }

        const extent = { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
        r.refreshBounds(extent);                       // Three's frustum cull tests the new shape
        this._grid.setContentBoundsOverride?.(extent); // panel / focus / dock / picking / layout
    }
}

export default StructureLayout;
