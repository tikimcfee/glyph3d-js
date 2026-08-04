/**
 * GlyphLayoutKernel — the glyph fold as a WebGPU compute kernel.
 *
 * One GPU thread per glyph slot, O(log lines) each. A thread resolves its own position from
 * three lookup tables plus pure math — no inter-thread communication, no scan, no backtracking:
 *
 *     L    = binary search of the slot in lineTable        → its source line
 *     j    = slot − lineTable[L]                           → codepoint index within the line
 *     seg  = wrapWidth > 0 ? floor(j / wrapWidth) : 0      → visual row within the line
 *     x    = origin.x + xOffsets[slot]
 *     y    = origin.y − (lineStartRow[L] + seg − scrollOffset) · lineSpacing
 *     z    = origin.z − seg · zStep
 *
 * then, when pagination is enabled, a pure per-slot remap of that position (see `_buildFold`).
 *
 * The tables are the whole trick. Two quantities in that fold are prefix sums, and a prefix sum
 * is not per-slot pure (spec §5.4): `lineStartRow[L]` — the visual rows every earlier line
 * consumed, wraps included — and the x offset, the running sum of the real advances of every
 * earlier glyph on the visual row. The CPU already walks both, so it hands the first in
 * (`CodeGrid._buildLayoutWrapIndex`'s output) and derives the second in `configure()` from the
 * builder's own per-slot `sizes.x` advances. Everything the shader does around those two lookups
 * is arithmetic on uniforms, which is why a thread never looks at another thread.
 *
 * X IS A LOOKUP, NOT A MULTIPLY. A color-emoji codepoint occupies ONE slot but advances TWO cells
 * (`FontChain.shape` doubles `ax` for bitmap slots), so `col × cellWidth` is wrong for every glyph
 * after an emoji on the same row — and wrong by a whole cell, not an epsilon. `xOffsets` carries
 * the summed truth instead. Moving that scan onto the GPU is a later optimization that changes
 * nothing in this shader.
 *
 * Ported from the CPU builder (`workers/builders/index.js`: the newline/wrap loop at :248-357
 * and `paginationShift` at :132-150). `dx`/`dy` are not applied: the live shapers emit them as 0
 * (`FontChain.js:227,255`, `MonospaceShapeCache.js:115`), and a shaper that didn't would need a
 * second per-slot table.
 *
 * Standalone: this module owns its buffers and its kernel and touches nothing in the render path.
 * `positions` is the seam — `positions.toAttribute()` feeds a render material with no readback at
 * all; `readPositions()` exists for tests and debugging.
 *
 * WebGPU only — storage buffers do not exist on the WebGL backend.
 */

import * as THREE from 'three';
import { TSL } from 'three/webgpu';

const {
    Fn,
    If,
    Loop,
    Break,
    uniform,
    instancedArray,
    storage,
    instanceIndex,
    int,
    uint,
    float,
    vec3,
    vec4,
} = TSL;

/**
 * Binary-search iteration cap (TSL loop bound). 32 halvings address 2^32 lines, so the cap is
 * unreachable in practice; it exists because an unbounded `while` in a compute shader that fails
 * to converge is a device loss, not a wrong pixel. `Break()` exits as soon as the range collapses.
 */
const BINARY_SEARCH_STEPS = 32;

/**
 * Floats per slot in the positions buffer. WGSL gives `array<vec3<f32>>` a 16-byte stride, and
 * three quietly rewrites a vec3 storage attribute's itemSize to 4 to match
 * (`WebGPUAttributeUtils.createAttribute`). Declaring vec4 makes that stride visible instead of
 * surprising: the .w lane is alignment padding, written 0.
 */
export const POSITION_STRIDE = 4;

/**
 * Floats per item in the item table — the per-item params that VARY across items in a
 * field (everything else is field-level, set once as a uniform). Layout:
 *   [0] originX   [1] originY   [2] originZ
 *   [3] outBase (uint as float)  [4] lineCount  [5] lineTableOffset
 *   [6] pageStrideX  [7] paginated (0|1)
 * Small integers (outBase, lineCount, lineTableOffset) are exactly representable as f32.
 */
export const ITEM_STRIDE = 8;

/** Item capacity a kernel is born with. A field's items are few (filename + content = 2). */
export const DEFAULT_MAX_ITEMS = 8;

/** Slot capacity a kernel is born with. configure() grows past it by reallocating. */
export const DEFAULT_MAX_SLOTS = 262144;

/** Line-table capacity a kernel is born with. Lines can outnumber slots — a file of blank lines. */
export const DEFAULT_MAX_LINES = 65536;

/**
 * Page-fan axis. These integers cross the JS→GPU boundary as a numeric uniform (WGSL has no
 * enums), so the values themselves are the contract — the shader casts with int() and compares.
 * Names match the builder's `layout.axis` vocabulary.
 *
 *  xy  newspaper: pages fan right up to pagesWide, then wrap downward.
 *  z   depth stack: every page shares the front page's footprint and recedes by its index.
 */
export const LAYOUT_AXIS = Object.freeze({ xy: 0, z: 1 });

/**
 * Every tunable the fold has, with the value it takes when unspecified. There are no baked
 * literals in the kernel — each number below reaches the shader as a uniform, so any of them can
 * be dialled per-configure without a recompile.
 *
 * Counts are counts and world units are world units, and nothing here is re-derived from
 * anything else. That split matters: the builder's z step multiplies `charHeight` while every
 * page gap multiplies `lineSpacing` (they coincide only while `LINE_PITCH === 1.0`), and
 * `paginationGeometry`'s gap unit is the CEIL'd `charWidth + letterSpacing`, ~12% under the real
 * glyph advance. Passing each world quantity outright is what keeps those apart.
 *
 * `pageWidthWorld` is the widest laid-out row — a reduction over the kernel's own output, and the
 * one genuine impurity in the fold. v1 takes it as a param; the CPU measures it.
 */
export const LAYOUT_PARAM_DEFAULTS = Object.freeze({
    /** World position of the item origin. x is a cell's LEFT edge, y its VERTICAL CENTER. */
    origin: Object.freeze({ x: 0, y: 0, z: 0 }),

    /** Visual rows the conveyor has shifted content up by. Applied before the page fold. */
    scrollOffset: 0,

    /** Slots on a visual row before a line wraps down-and-back. 0 = no wrap. */
    wrapWidth: 200,

    /** World y drop per visual row (`metrics.lineSpacing`). */
    lineSpacing: 1,

    /** World z step per intra-line wrap segment (`charHeight × zWrapSpacing`). 0 = flat. */
    zWrapStep: 0,

    /**
     * Visual ROWS per page before a page break. 0 = pagination off, and the only switch there is
     * — matching the builder's own `layout.pageHeight` gate. (The builder additionally skips the
     * whole pass unless `totalYSpan > pageHeightWorld`, a reduction over the item; that gate is
     * redundant with the per-slot `screenRow >= pageHeight` test except when the content is
     * exactly one page tall, where the builder leaves the last row unshifted.)
     */
    pageHeight: 0,

    /** P — horizontal pages before wrapping down. Clamped to ≥ 1: it divides. */
    pagesWide: 1,

    /** Wp — world width of a page: the MEASURED widest row extent, not a char-count guess. */
    pageWidthWorld: 0,

    /** Gx — world x gap between pages (`pageGapX × charAdvance`). */
    pageGapXWorld: 0,

    /** Gy — world y gap between page rows (`pageGapY × lineSpacing`). */
    pageGapYWorld: 0,

    /** D — world z gap between page planes on axis 'z' (`pageDepth × lineSpacing`). */
    pageDepthWorld: 0,

    /** 'xy' newspaper fan | 'z' depth stack, or the LAYOUT_AXIS integer. */
    axis: 'xy',
});

/**
 * @typedef {Object} GlyphLayoutParams
 * @property {{x?:number, y?:number, z?:number}} [origin]
 * @property {number} [scrollOffset]
 * @property {number} [wrapWidth]
 * @property {number} [lineSpacing]
 * @property {number} [zWrapStep]
 * @property {number} [pageHeight]
 * @property {number} [pagesWide]
 * @property {number} [pageWidthWorld]
 * @property {number} [pageGapXWorld]
 * @property {number} [pageGapYWorld]
 * @property {number} [pageDepthWorld]
 * @property {string|number} [axis]
 */

/**
 * Resolve an axis name or integer to its LAYOUT_AXIS value.
 * Unknown input is an error, not a silent fallback — a typo'd axis should surface, not lay out.
 * @param {string|number} axis
 * @returns {number}
 */
function resolveAxis(axis) {
    if (typeof axis === 'number') {
        for (const v of Object.values(LAYOUT_AXIS)) if (v === axis) return axis;
        throw new Error(`GlyphLayoutKernel: unknown page axis ${axis}`);
    }
    const v = LAYOUT_AXIS[axis];
    if (v === undefined) throw new Error(`GlyphLayoutKernel: unknown page axis '${axis}'`);
    return v;
}

/**
 * Merge a partial params bag over the defaults. `??` keeps an explicit `0` — the "off" sentinel —
 * rather than treating it as missing.
 * @param {GlyphLayoutParams} [params]
 * @returns {typeof LAYOUT_PARAM_DEFAULTS}
 */
function resolveParams(params = {}) {
    const d = LAYOUT_PARAM_DEFAULTS;
    return {
        origin:         { ...d.origin, ...(params.origin || {}) },
        scrollOffset:   params.scrollOffset   ?? d.scrollOffset,
        wrapWidth:      params.wrapWidth      ?? d.wrapWidth,
        lineSpacing:    params.lineSpacing    ?? d.lineSpacing,
        zWrapStep:      params.zWrapStep      ?? d.zWrapStep,
        pageHeight:     params.pageHeight     ?? d.pageHeight,
        pagesWide:      params.pagesWide      ?? d.pagesWide,
        pageWidthWorld: params.pageWidthWorld ?? d.pageWidthWorld,
        pageGapXWorld:  params.pageGapXWorld  ?? d.pageGapXWorld,
        pageGapYWorld:  params.pageGapYWorld  ?? d.pageGapYWorld,
        pageDepthWorld: params.pageDepthWorld ?? d.pageDepthWorld,
        axis:           params.axis           ?? d.axis,
    };
}

export default class GlyphLayoutKernel {
    /**
     * @param {THREE.WebGPURenderer} renderer - an initialized WebGPU renderer
     * @param {{ maxSlots?: number, maxLines?: number,
     *           positionsAttribute?: import('three/webgpu').StorageInstancedBufferAttribute }} [opts]
     *   positionsAttribute: write into an EXTERNAL storage-backed attribute instead of an owned
     *   buffer — the integration mode, where the target is a GlyphField's own instancePosition
     *   (stride-4 vec4, installed by applyPrebuiltBuffers' engine branch). With an external
     *   target, configure()'s outBase places each item at its bufferStartIndex range, and
     *   dispose() leaves the attribute alone — the field owns it.
     */
    constructor(renderer, opts = {}) {
        if (!renderer) throw new Error('GlyphLayoutKernel: a WebGPU renderer is required');

        /** @type {THREE.WebGPURenderer} */
        this.renderer = renderer;

        /** External output attribute (integration mode), or null for an owned buffer. */
        this._externalOut = opts.positionsAttribute || null;

        /** Displacement-table capacity in floats (3 × slots). 0 until first armed — lazy. */
        this._dispCapacity = 0;

        /** Allocated slot capacity. configure() grows this by reallocating. */
        this.maxSlots = Math.max(1, opts.maxSlots ?? DEFAULT_MAX_SLOTS);
        /** Allocated line capacity. */
        this.maxLines = Math.max(1, opts.maxLines ?? DEFAULT_MAX_LINES);
        /** Allocated item capacity (item-table + item-starts buffers). */
        this.maxItems = Math.max(1, opts.maxItems ?? DEFAULT_MAX_ITEMS);

        /** Slots the last configure() armed — the dispatch width and the readback width. */
        this.slotCount = 0;
        /** Lines the last configure() armed (field-total across all items). */
        this.lineCount = 0;
        /** Items the last configure() armed. */
        this.itemCount = 0;
        /** Resolved params from the last configure(), for inspection. */
        this.params = resolveParams();

        // Uniforms are size-independent, so they outlive buffer reallocation and the kernel is
        // never rebuilt just to retune the fold. Per-item params (origin, outBase, lineCount,
        // pagination stride) live in the item table — only FIELD-LEVEL values are uniforms.
        this._u = {
            itemCount:       uniform(0, 'uint'),
            dispEnabled:     uniform(0, 'int'),
            wrapWidth:       uniform(0, 'uint'),
            scrollRows:      uniform(0, 'int'),
            lineSpacing:     uniform(0, 'float'),
            zStep:           uniform(0, 'float'),
            pagAxis:         uniform(LAYOUT_AXIS.xy, 'int'),
            pagesWide:       uniform(1, 'int'),
            pageRows:        uniform(0, 'int'),     // H / lineSpacing — see the fold's note
            pageStrideY:     uniform(0, 'float'),   // H  + Gy
            pageDepthWorld:  uniform(0, 'float'),
        };

        /** @type {?import('three/webgpu').StorageBufferNode} slotCount×vec4 — the kernel's output */
        this.positions = null;
        /** @type {?import('three/webgpu').StorageBufferNode} lineCount×uint — line-start slot index */
        this.lineTable = null;
        /** @type {?import('three/webgpu').StorageBufferNode} lineCount×uint — line-start visual row */
        this.lineStartRow = null;
        /** @type {?import('three/webgpu').StorageBufferNode} slotCount×float — x offset from the visual row's left edge */
        this.xOffsets = null;
        /** @type {?import('three/webgpu').StorageBufferNode} itemCount×ITEM_STRIDE float — per-item params (origin, outBase, …) */
        this.itemTable = null;
        /** @type {?import('three/webgpu').StorageBufferNode} itemCount×uint — bufferStartIndex per item (the item-search key) */
        this.itemStarts = null;
        /** @type {?import('three/webgpu').ComputeNode} */
        this._kernel = null;
        /** Readback needs a GPU buffer, which only exists once something has dispatched. */
        this._dispatched = false;

        this._allocate(this.maxSlots, this.maxLines);
    }

    /**
     * (Re)allocate the storage buffers and rebuild the kernel around them.
     *
     * The compute node closes over the buffer nodes, so new buffers mean a new node. Capacity
     * changes are the ONLY thing that forces this — slot count, line count and every fold param
     * are uniforms.
     *
     * @private
     * @param {number} maxSlots
     * @param {number} maxLines
     * @param {number} [maxItems]
     */
    _allocate(maxSlots, maxLines, maxItems) {
        this._releaseBuffers();

        this.maxSlots = maxSlots;
        this.maxLines = maxLines;
        if (maxItems) this.maxItems = maxItems;

        // Owned output is vec4 (visible stride); an external target is the field's OWN vec3
        // attribute wrapped as a storage node. instancedArray() and storage() both create a
        // StorageInstancedBufferAttribute under the hood, so both paths work the same way.
        this.positions = this._externalOut
            ? storage(this._externalOut, 'vec4', maxSlots).setName('GlyphLayoutPositionsExt')
            : instancedArray(maxSlots, 'vec4').setName('GlyphLayoutPositions');
        this.xOffsets     = instancedArray(maxSlots, 'float').setName('GlyphLayoutXOffsets');
        this.lineTable    = instancedArray(maxLines, 'uint').setName('GlyphLayoutLineTable');
        this.lineStartRow = instancedArray(maxLines, 'uint').setName('GlyphLayoutLineStartRow');
        // The item table: per-item params that vary across items (origin, outBase, lineCount,
        // lineTableOffset, pageStrideX, paginated). Field-level params are uniforms.
        this.itemTable  = instancedArray(this.maxItems * ITEM_STRIDE, 'float').setName('GlyphLayoutItemTable');
        this.itemStarts = instancedArray(this.maxItems, 'uint').setName('GlyphLayoutItemStarts');
        // Arranger displacements (stage 4): flat xyz per FIELD-GLOBAL slot, added after the
        // fold. LAZY — 1 float until setDisplacements() first arms it, so unarranged grids
        // pay nothing (the memory-layout rule). Flat f32 (4-byte stride) dodges vec3's
        // 16-byte padding: 12B/slot, not 16.
        this.displacements = instancedArray(Math.max(1, this._dispCapacity | 0), 'float')
            .setName('GlyphLayoutDisplacements');

        this._kernel = this._buildKernel();
        this._dispatched = false;
    }

    /**
     * The fold: (localSlot, line, item, globalSlot) → world position.
     *
     * Kept as its own Fn so a new fold is a new function, not a new kernel. The item + line
     * searches and the write around them never change.
     *
     * Per-item params (origin, pagination stride) are read from the item table via `item`;
     * field-level params are uniforms. `globalSlot` is the field-global index for the xOffsets
     * lookup and the displacement add (both field-global).
     *
     * @private
     * @returns {Function} TSL fn (localSlot:uint, line:uint, item:uint, globalSlot:uint) → vec3
     */
    _buildFold() {
        const u = this._u;
        const STRIDE = ITEM_STRIDE;
        const it = this.itemTable;
        const lt = this.lineTable;
        const lsr = this.lineStartRow;
        const xo = this.xOffsets;
        const disp = this.displacements;

        return Fn(([slot, line, item, globalSlot]) => {
            const ib = item.mul(uint(STRIDE)).toVar('ib');   // item-table base

            const j = slot.sub(lt.element(line)).toVar('j');

            // Intra-line wrap — the Z staircase. A source line spills into wrapWidth-wide
            // segments that step down in Y and back in Z. wrapWidth counts SLOTS, not columns:
            // a double-advance emoji still costs exactly one against the budget.
            const seg = uint(0).toVar('seg');
            If(u.wrapWidth.greaterThan(uint(0)), () => {
                seg.assign(j.div(u.wrapWidth));
            });

            // Per-item origin (the one param that positions every glyph of the item).
            const originX = it.element(ib).toVar('ox');
            const originY = it.element(ib.add(uint(1))).toVar('oy');
            const originZ = it.element(ib.add(uint(2))).toVar('oz');

            // x is a lookup, not a multiply: xOffsets holds each slot's distance from its visual
            // row's left edge — the running sum of REAL advances. Field-global index now.
            const x = xo.element(globalSlot).add(originX).toVar('x');

            // Visual row = the line's row prefix (CPU-supplied) + this glyph's wrap segment.
            const visualRow = lsr.element(line).add(seg).toInt().toVar('visualRow');
            const screenRow = visualRow.sub(u.scrollRows).toVar('screenRow');
            const y = originY.sub(screenRow.toFloat().mul(u.lineSpacing)).toVar('y');

            const z = originZ.sub(seg.toFloat().mul(u.zStep)).toVar('z');

            // Page fold — per-item gate + stride (pageWidthWorld varies by item's row extent),
            // field-level pageRows/pageStrideY/depth. Integer-row pagination (WGSL f32 division
            // is 2.5-ULP loose; see the original note in git history).
            const paginated = it.element(ib.add(uint(7))).toVar('pag');
            If(paginated.greaterThan(float(0.5)), () => {
                If(screenRow.greaterThanEqual(u.pageRows), () => {
                    const page = screenRow.div(u.pageRows).toVar('page');
                    const rowOff = screenRow.sub(page.mul(u.pageRows))
                        .toFloat().mul(u.lineSpacing).toVar('rowOff');
                    const strideX = it.element(ib.add(uint(6))).toVar('strideX');

                    If(u.pagAxis.equal(int(LAYOUT_AXIS.z)), () => {
                        y.assign(originY.sub(rowOff));
                        z.subAssign(page.toFloat().mul(u.pageDepthWorld));
                    }).Else(() => {
                        const hSlot = page.mod(u.pagesWide);
                        const yRow = page.div(u.pagesWide);
                        x.addAssign(hSlot.toFloat().mul(strideX));
                        y.assign(originY.sub(rowOff.add(yRow.toFloat().mul(u.pageStrideY))));
                    });
                });
            });

            // Arranger displacement — CPU-authored per-slot xyz, field-global index.
            If(u.dispEnabled.equal(int(1)), () => {
                const d = globalSlot.mul(uint(3));
                x.addAssign(disp.element(d));
                y.addAssign(disp.element(d.add(uint(1))));
                z.addAssign(disp.element(d.add(uint(2))));
            });

            return vec3(x, y, z);
        });
    }

    /**
     * Arm (or clear) the arranger displacement table — flat [dx,dy,dz] per FIELD-GLOBAL
     * slot, CPU-authored (the arrangers write it, the mirror reads it, this uploads it —
     * the same one array everywhere, so "I am at this location" stays answerable). Call
     * BEFORE the per-item configure loop: growth reallocates buffers and rebuilds the
     * kernel, which drops previously uploaded tables.
     * @param {?Float32Array} arr - length ≥ 3 × field slot count, or null to disable
     */
    setDisplacements(arr) {
        if (!arr || arr.length === 0) {
            this._u.dispEnabled.value = 0;
            return;
        }
        if (arr.length > this.displacements.value.array.length) {
            this._dispCapacity = arr.length;
            this._allocate(this.maxSlots, this.maxLines, this.maxItems);
        }
        this.displacements.value.array.set(arr);
        this.displacements.value.needsUpdate = true;
        this._u.dispEnabled.value = 1;
    }

    /**
     * One thread per FIELD-GLOBAL slot: resolve the item (binary search itemStarts), then the
     * line within that item's line-table range, then fold. All items in the field dispatch in
     * ONE pass — the item table carries per-item params; field-level params are uniforms.
     *
     * Out-of-range threads write nothing — `.compute(count)` generates
     * `if (instanceIndex >= count) return;` against a uniform three refreshes from
     * `computeNode.count`, so the guard costs no recompile when totalSlots moves.
     *
     * @private
     * @returns {import('three/webgpu').ComputeNode}
     */
    _buildKernel() {
        const u = this._u;
        const fold = this._buildFold();
        const it = this.itemTable;
        const lt = this.lineTable;
        const starts = this.itemStarts;

        return Fn(() => {
            const globalSlot = instanceIndex;

            // ── Item search: largest item whose bufferStartIndex ≤ globalSlot. ──
            const item = uint(0).toVar('item');
            {
                const lo = uint(0).toVar('ilo');
                const hi = u.itemCount.sub(uint(1)).toVar('ihi');
                Loop(BINARY_SEARCH_STEPS, () => {
                    If(lo.greaterThanEqual(hi), () => { Break(); });
                    const mid = lo.add(hi).add(uint(1)).div(uint(2)).toVar('imid');
                    If(starts.element(mid).lessThanEqual(globalSlot), () => {
                        lo.assign(mid);
                    }).Else(() => {
                        hi.assign(mid.sub(uint(1)));
                    });
                });
                item.assign(lo);
            }
            const localSlot = globalSlot.sub(starts.element(item)).toVar('localSlot');
            const itemBase = item.mul(uint(ITEM_STRIDE)).toVar('itemBase');
            const lineOff = uint(it.element(itemBase.add(uint(5)))).toVar('lineOff');   // lineTableOffset
            const lineCnt = uint(it.element(itemBase.add(uint(4)))).toVar('lineCnt');   // lineCount

            // ── Line search within the item's range [lineOff, lineOff+lineCnt). ──
            // Largest L with lineTable[lineOff+L] ≤ localSlot. The result is an ABSOLUTE index
            // into the concatenated table (lineOff + L), so lineTable[line] / lineStartRow[line]
            // read this item's data directly.
            const line = lineOff.toVar('line');
            {
                const lo = lineOff.toVar('llo');
                const hi = lineOff.add(lineCnt).sub(uint(1)).toVar('lhi');
                Loop(BINARY_SEARCH_STEPS, () => {
                    If(lo.greaterThanEqual(hi), () => { Break(); });
                    const mid = lo.add(hi).add(uint(1)).div(uint(2)).toVar('lmid');
                    If(lt.element(mid).lessThanEqual(localSlot), () => {
                        lo.assign(mid);
                    }).Else(() => {
                        hi.assign(mid.sub(uint(1)));
                    });
                });
                line.assign(lo);
            }

            const p = fold(localSlot, line, item, globalSlot);

            // Field-global write — globalSlot IS the output index (no outBase add).
            this.positions.element(globalSlot).assign(vec4(p, float(0)));
        })().compute(1).setName('GlyphLayoutKernel');
    }

    /**
     * Reconfigure inputs for ALL items in a field — one configure, one dispatch.
     *
     * Field-level params (wrap, scroll, lineSpacing, zStep, pagination geometry) come from
     * `items[0].params` — they are identical across items (the adapter builds them from the same
     * shared metrics/layout bag). Per-item params (origin, outBase, pagination stride) go into the
     * item table.
     *
     * @param {Object} cfg
     * @param {Array<{slotCount:number, lineTable:Uint32Array, lineStartRow:Uint32Array,
     *   advances:Float32Array, outBase:number, params:GlyphLayoutParams}>} cfg.items
     * @param {number} cfg.totalSlots - Σ items' slotCount (the dispatch width)
     * @returns {this}
     */
    configure({ items, totalSlots }) {
        if (!Array.isArray(items) || items.length === 0) {
            throw new Error('GlyphLayoutKernel: configure needs a non-empty items array');
        }
        const itemCount = items.length;
        let sumSlots = 0, sumLines = 0;
        for (const it of items) {
            if (!(it.lineTable instanceof Uint32Array) || !(it.lineStartRow instanceof Uint32Array) ||
                !(it.advances instanceof Float32Array)) {
                throw new Error('GlyphLayoutKernel: each item needs lineTable/lineStartRow (Uint32Array) + advances (Float32Array)');
            }
            if (it.lineTable.length !== it.lineStartRow.length) {
                throw new Error(`GlyphLayoutKernel: item lineTable/lineStartRow length mismatch (${it.lineTable.length} vs ${it.lineStartRow.length})`);
            }
            if (it.lineTable[0] !== 0) {
                throw new Error(`GlyphLayoutKernel: item lineTable[0] must be 0, got ${it.lineTable[0]}`);
            }
            sumSlots += it.slotCount;
            sumLines += it.lineTable.length;
        }
        if (sumSlots !== totalSlots) {
            throw new Error(`GlyphLayoutKernel: items sum to ${sumSlots} slots, totalSlots is ${totalSlots}`);
        }

        // Field-level params from items[0] (identical across items — same metrics/layout bag).
        const p = resolveParams(items[0].params);
        const axis = resolveAxis(p.axis);
        const wrapCols = Math.max(0, Math.trunc(p.wrapWidth));
        // pageHeight is PER-ITEM-MODIFIED (paginate ? pageRows : 0) — items[0] might be the
        // filename (short, never paginates → 0). The FIELD-LEVEL pageRows is the max across
        // items: the paginating item carries the real value; non-paginating items carry 0.
        // A single uniform serves all items; the per-item `paginated` flag gates the fold.
        let pageRows = 0;
        for (const it of items) pageRows = Math.max(pageRows, Math.max(0, Math.trunc(it.params?.pageHeight || 0)));
        const fieldGapX = p.pageGapXWorld;

        // Grow before writing. Capacity is the one input the kernel is compiled against.
        // An external output cannot grow — its capacity is the field's buffer, full stop.
        if (totalSlots > this.maxSlots || sumLines > this.maxLines || itemCount > this.maxItems) {
            if (this._externalOut && totalSlots > this.maxSlots) {
                throw new Error(`GlyphLayoutKernel: totalSlots ${totalSlots} exceeds external capacity ${this.maxSlots}`);
            }
            this._allocate(
                Math.max(totalSlots, this.maxSlots),
                Math.max(sumLines, this.maxLines),
                Math.max(itemCount, this.maxItems),
            );
        }

        this.slotCount = totalSlots;
        this.lineCount = sumLines;
        this.itemCount = itemCount;
        this.params = p;

        // ── Concatenate tables + write field-global xOffsets + populate item table ──
        const lt = this.lineTable.value.array;
        const lsr = this.lineStartRow.value.array;
        const xo = this.xOffsets.value.array;
        const itBuf = this.itemTable.value.array;
        const starts = this.itemStarts.value.array;
        let lineOff = 0;

        for (let i = 0; i < itemCount; i++) {
            const it = items[i];
            const { slotCount, lineTable, lineStartRow, advances, outBase, params } = it;

            // Concatenate this item's line tables at the running line offset.
            lt.set(lineTable, lineOff);
            lsr.set(lineStartRow, lineOff);

            // Field-global xOffsets: the prefix-sum scan at GLOBAL slot indices (base + localSlot).
            // Reset at every line start AND every wrap — the running sum of REAL advances, exactly
            // as the builder's inner loop computes it. See the prior configure's note on why this
            // is a lookup, not a multiply, and why the reset-at-wrap keeps it exact.
            for (let L = 0; L < lineTable.length; L++) {
                const end = L + 1 < lineTable.length ? lineTable[L + 1] : slotCount;
                let acc = 0, onSegment = 0;
                for (let s = lineTable[L]; s < end; s++) {
                    if (wrapCols > 0 && onSegment >= wrapCols) { acc = 0; onSegment = 0; }
                    xo[outBase + s] = acc;
                    acc += advances[s];
                    onSegment++;
                }
            }

            // Item table: per-item params that vary across items.
            const pageStrideX = (params?.pageWidthWorld || 0) + fieldGapX;
            const paginated = (params?.pageHeight || 0) > 0 ? 1 : 0;
            const o = params?.origin || { x: 0, y: 0, z: 0 };
            const ib = i * ITEM_STRIDE;
            itBuf[ib + 0] = o.x;  itBuf[ib + 1] = o.y;  itBuf[ib + 2] = o.z;
            itBuf[ib + 3] = outBase;
            itBuf[ib + 4] = lineTable.length;
            itBuf[ib + 5] = lineOff;
            itBuf[ib + 6] = pageStrideX;
            itBuf[ib + 7] = paginated;

            // Item starts: bufferStartIndex per item (the item-search key).
            starts[i] = outBase;

            lineOff += lineTable.length;
        }

        this.lineTable.value.needsUpdate = true;
        this.lineStartRow.value.needsUpdate = true;
        this.xOffsets.value.needsUpdate = true;
        this.itemTable.value.needsUpdate = true;
        this.itemStarts.value.needsUpdate = true;

        // ── Field-level uniforms (set once — identical across items) ──
        const u = this._u;
        u.itemCount.value = itemCount;
        u.wrapWidth.value = wrapCols;
        u.scrollRows.value = Math.trunc(p.scrollOffset);
        u.lineSpacing.value = p.lineSpacing;
        u.zStep.value = p.zWrapStep;
        u.pagAxis.value = axis;
        u.pagesWide.value = Math.max(1, Math.trunc(p.pagesWide));  // it divides — 0 would fault
        u.pageRows.value = pageRows;
        u.pageStrideY.value = pageRows * p.lineSpacing + p.pageGapYWorld;
        u.pageDepthWorld.value = p.pageDepthWorld;

        // Drives both the dispatch grid and the generated bounds check; three re-derives the
        // workgroup count when it changes, so this is not a recompile.
        this._kernel.count = totalSlots;

        return this;
    }

    /**
     * Dispatch the kernel.
     *
     * Resolves when the work is QUEUED, not when the GPU has finished — `computeAsync` submits
     * and returns. Ordering against a later readback is the queue's guarantee, not this promise's.
     *
     * @returns {Promise<void>}
     */
    async compute() {
        if (!this._kernel) throw new Error('GlyphLayoutKernel: disposed');
        if (this.slotCount === 0) return;
        await this.renderer.computeAsync(this._kernel);
        this._dispatched = true;
    }

    /**
     * Encode + submit NOW — the fire-and-forget integration path. Uniforms are read at
     * encode time, so sequential configure→computeSync per item on ONE kernel is safe with
     * no awaits between them; the async compute() defers a microtask, which would race the
     * next configure's uniform writes. Requires an already-initialized renderer (the live
     * app's always is; a cold one should use compute()).
     */
    computeSync() {
        if (!this._kernel) throw new Error('GlyphLayoutKernel: disposed');
        if (this.slotCount === 0) return;
        this.renderer.compute(this._kernel);
        this._dispatched = true;
    }

    /**
     * Read back the computed positions as a tight Float32Array of slotCount×3 (x,y,z per slot).
     *
     * Test and debug path. The render path consumes `positions.toAttribute()` instead and never
     * pays this round trip. De-interleaves the vec4 stride the GPU actually stores.
     *
     * @returns {Promise<Float32Array>}
     */
    async readPositions() {
        const n = this.slotCount;
        const out = new Float32Array(n * 3);
        if (n === 0) return out;
        if (!this._dispatched) {
            throw new Error('GlyphLayoutKernel: readPositions() before compute() — no GPU buffer exists yet');
        }

        const raw = await this.renderer.getArrayBufferAsync(
            this.positions.value,
            null,
            0,
            n * POSITION_STRIDE * Float32Array.BYTES_PER_ELEMENT,
        );
        const src = new Float32Array(raw);
        for (let i = 0; i < n; i++) {
            const s = i * POSITION_STRIDE;
            const d = i * 3;
            out[d] = src[s];
            out[d + 1] = src[s + 1];
            out[d + 2] = src[s + 2];
        }
        return out;
    }

    /**
     * Free the storage buffers.
     *
     * three r184 has no public free for a standalone storage attribute: dispose listeners are
     * registered for geometry- and texture-owned data, never for compute-only buffers, so
     * `attribute.dispose()` fires an event nobody hears. `Attributes.delete()` is the only route
     * and it lives on the renderer's private field.
     *
     * @private
     */
    _releaseBuffers() {
        const attributes = this.renderer?._attributes;
        for (const node of [this.xOffsets, this.lineTable, this.lineStartRow, this.itemTable, this.itemStarts, this.displacements]) {
            if (node && attributes) attributes.delete(node.value);
        }
        // An owned positions buffer is ours to free; an external attribute is the FIELD's —
        // its geometry keeps rendering from it after this kernel is gone.
        if (this.positions && !this._externalOut && attributes) attributes.delete(this.positions.value);
        this.positions = null;
        this.xOffsets = null;
        this.lineTable = null;
        this.lineStartRow = null;
        this.itemTable = null;
        this.itemStarts = null;
        this.displacements = null;

        // Drops the compute pipeline, its bind groups and its node cache (Renderer registers this
        // listener the first time the node is dispatched).
        this._kernel?.dispose();
        this._kernel = null;
    }

    dispose() {
        this._releaseBuffers();
        this._dispatched = false;
        this.slotCount = 0;
        this.lineCount = 0;
    }
}
