import { flowBoxes, squareWrap } from './layouts/flowBoxes.js';

// "Callable units" — the default griddable leaf scopes. A file is rarely a bag of
// free functions; it's usually a class full of methods. So the default grids
// functions AND methods wherever they nest (outermost-first), which is what you
// almost always mean by "lay out this file's routines".
const LEAF_SCOPES = new Set(['function', 'method', 'constructor', 'getter', 'setter']);

// A structural arrangement moves each block as one rigid swathe, so a block must be a
// CONTIGUOUS vertical run. A paginated (newspaper) fold fans a long method across
// columns — moving it as a unit would shatter it. So while arranged, the arranger forces
// a single long column at fold time (without mutating the grid's config.layout; reset
// just stops forcing it). See CodeGrid._foldLayout.
const SINGLE_COLUMN = Object.freeze({ pageHeight: 0, pagesWide: 1 });

/**
 * StructureLayout — a per-grid ARRANGER that re-arranges a code grid's glyphs BY
 * SEMANTIC ENTITY (the AST), registered into the grid's relayout pipeline.
 *
 * Each AST node of a chosen kind is a contiguous glyph slot range (slots are
 * source-order). The arranger measures each block's bounds, packs the blocks with the
 * shared box-packer, and BAKES the move straight into the live instance buffer —
 * instancePosition for the move, instanceSize=0 (parked inside the arranged extent) to
 * hide everything else. Because the move lives in the buffer, the footprint walk, the
 * frustum-cull bounds, and the buffer-backed `positionAt` (caret, picking, future LSP
 * arrows) all agree for free — the buffer is the single source of truth.
 *
 * Crucially, `arrange` runs INSIDE every fold (CodeGrid._applyArrangers), re-deriving
 * from stable anchors (the SemanticModel's node ranges). So an arrangement can never go
 * stale: an edit, scroll, or layout-mode change re-folds, and the arranger re-applies on
 * the fresh positions. There is no snapshot to invalidate.
 *
 * Language-agnostic by construction: it reads the SemanticModel's NORMALIZED kinds
 * (function/method/class/interface/enum/…), never a language's raw node types.
 *
 * v1 is a LENS: arrange the blocks of one kind into a size-sorted grid and hide the
 * rest; reset() stops arranging and the next fold returns the grid to its normal flow.
 */
export class StructureLayout {
    /** @param {import('./CodeGrid.js').default} grid */
    constructor(grid) {
        this._grid = grid;
        /** Required fold layout while active — read by CodeGrid._foldLayout. */
        this.foldLayout = SINGLE_COLUMN;
        this._active = false;
        this._kind = null;
        /** @type {{kind:string, scheme:string, count:number}|null} */
        this._scheme = null;
        this._healing = false;
    }

    /** The active arrangement, or null when the grid is in its normal flow. */
    get active() { return this._scheme; }

    /**
     * Begin arranging the grid's blocks into a size-sorted grid (smallest→largest),
     * hiding everything else. Registers as an arranger and re-folds; the fold collapses
     * to a single column (foldLayout) and `arrange` bakes the packed positions.
     * @param {string|null} [kind=null] a specific normalized kind, or null for the
     *   "callable units" default (functions + methods at any depth).
     * @returns {Promise<{ok:boolean, count?:number, reason?:string, available?:string[]}>}
     */
    async grid(kind = null) {
        const r = this._renderer();
        const model = this._grid.getSemantics?.();
        if (!r) return { ok: false, reason: 'grid has no renderer' };
        if (!model) return { ok: false, reason: 'semantic model not ready' };

        // Probe for matching blocks up front, so an empty result is a clean error (with
        // the available kinds) rather than a silently-flat grid.
        const probe = this._blocks(model, kind, r);
        if (!probe.length) {
            const available = [...new Set((model.flat ?? []).map((n) => n.kind))].filter(Boolean);
            return { ok: false, reason: kind ? `no ${kind} blocks` : 'no functions or methods', available };
        }

        this._kind = kind;
        this._active = true;
        this._scheme = { kind: kind || 'callable', scheme: 'grid', count: probe.length };
        this._grid.registerArranger(this);
        await this._grid._relayoutInPlace();   // fold → single column → arrange bakes the packing
        return { ok: true, count: probe.length };
    }

    /** Stop arranging; the next fold returns the grid to its normal flow layout. */
    async reset() {
        const wasActive = this._active;
        this._active = false;
        this._kind = null;
        this._scheme = null;
        this._grid.unregisterArranger?.(this);
        if (wasActive) await this._grid._relayoutInPlace?.(); // fold with config.layout → flow
        return { ok: true };
    }

    /**
     * The ARRANGE stage hook (called by CodeGrid._applyArrangers inside every fold).
     * Re-derives the packing from the AST and bakes it into the freshly-folded buffer.
     * Idempotent: each fold rebuilds flow positions first, then this re-measures + re-packs.
     * @param {import('./CodeGrid.js').default} grid
     */
    arrange(grid) {
        const r = this._renderer();
        if (!r || !this._active) return;
        // An edit invalidates the AST cache (content-identity). Prefer a SYNCHRONOUS re-parse
        // (the engine is warm once arranged) so we re-derive in THIS fold — no flow flicker.
        // Only if the engine is cold (can't happen for an already-arranged grid) do we fall
        // back to the async heal, which re-folds once the model rebuilds.
        const model = grid.getSemantics?.() || grid.refreshSemanticsSync?.();
        if (!model) { this._healLater(grid); return; }

        const blocks = this._blocks(model, this._kind, r);
        if (!blocks.length) return; // nothing matches in the new content → leave this fold as flow

        // Smallest surface-area first, packed into a roughly-square grid. The grid takes its
        // natural shape; the command re-fits the scene (a tree relayout) around the footprint.
        blocks.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
        const sizes = blocks.map((b) => ({ w: b.bounds.width, h: b.bounds.height }));
        const margin = (grid.metrics?.lineSpacing ?? grid.metrics?.charHeight ?? 1) * 1.6;
        const { slots } = flowBoxes(sizes, { margin, wrapWidth: squareWrap(sizes, margin) });

        this._bake(r, blocks, slots);
    }

    /**
     * Bake the packing into the live instance buffer: move each block's slot range by a
     * per-block offset (instancePosition), then hide every other glyph by zeroing its size
     * and parking it inside the arranged extent (a size-0 glyph renders + picks nothing,
     * and parked inside the box it never inflates the footprint walk).
     * @private
     */
    _bake(r, blocks, slots) {
        const pos = r.getInstancePositions();
        const siz = r.getInstanceSizes();
        if (!pos || !siz) return;
        const total = this._glyphCount(r);
        const isBlock = new Uint8Array(total);

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const slot = slots[i];
            const ox = slot.x - b.bounds.min.x; // slot.x = box left;  bounds.min.x = block left
            const oy = slot.y - b.bounds.max.y; // slot.y = box top (y descends); bounds.max.y = block top
            const end = Math.min(total, b.startSlot + b.count);
            for (let s = b.startSlot; s < end; s++) {
                pos[s * 3]     += ox;
                pos[s * 3 + 1] += oy;
                isBlock[s] = 1;
            }
            // arranged box: [slot.x, slot.y − h] .. [slot.x + w, slot.y]
            if (slot.x < minX) minX = slot.x;
            if (slot.y - b.bounds.height < minY) minY = slot.y - b.bounds.height;
            if (slot.x + b.bounds.width > maxX) maxX = slot.x + b.bounds.width;
            if (slot.y > maxY) maxY = slot.y;
        }

        const parkX = minX === Infinity ? 0 : minX;
        const parkY = maxY === -Infinity ? 0 : maxY;
        for (let s = 0; s < total; s++) {
            if (isBlock[s]) continue;
            pos[s * 3] = parkX; pos[s * 3 + 1] = parkY; pos[s * 3 + 2] = 0;
            siz[s * 2] = 0; siz[s * 2 + 1] = 0;
        }
        r.markInstanceTransformsDirty();
    }

    /**
     * After a content edit, getSemantics() misses (content-identity cache) until the model
     * rebuilds. Re-fold once it's ready so the arrangement re-applies on the new ranges —
     * the brief flow flash in between is the model catching up, not a stale snapshot.
     * @private
     */
    _healLater(grid) {
        if (this._healing) return;
        this._healing = true;
        Promise.resolve(grid.ensureSemantics?.()).then(() => {
            this._healing = false;
            if (this._active) grid._relayoutInPlace?.();
        }).catch(() => { this._healing = false; });
    }

    /**
     * Debug: for each block, what the AST claims vs. what the slot range actually lands on
     * — an off-by-N shows as a mismatch between `head`/`tail` (the AST's view of the text)
     * and `slotHead`/`slotTail` (the glyphs the range moves).
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

    // ---- internals ----

    _renderer() { return this._grid.getRenderer?.() ?? this._grid._renderer ?? null; }

    _glyphCount(r) { return r.instanceMesh?.geometry?.instanceCount ?? 0; }

    /**
     * Outermost nodes matching the kind → [{node, startSlot, count, bounds}].
     * Don't descend into a match (so a block's nested functions stay part of it, and
     * parent/child never both get selected → no overlap). With no kind, the default is the
     * "callable units" — functions + methods wherever they nest, so a class's methods grid
     * just as cleanly as a file's free functions.
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
        // end.col is past the line's glyphs (end-of-line / blank) → slot after the last glyph
        // on the nearest non-empty line at or above end.line.
        for (let l = end.line; l >= 0; l--) {
            const c = this._grid.getLineSlotCount?.(l) ?? 0;
            if (c > 0) {
                const last = this._grid.getSlotForChar(l, c - 1);
                if (last >= 0) return last + 1;
            }
        }
        return -1;
    }
}

export default StructureLayout;
