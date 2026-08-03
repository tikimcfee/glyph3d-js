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
     *   (vec3; three repacks it to a 16-byte stride, which is also WGSL's vec3-array stride, so
     *   both sides index identically). With an external target, configure()'s outBase places each
     *   item at its bufferStartIndex range, and dispose() leaves the attribute alone — the field
     *   owns it.
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

        /** Slots the last configure() armed — the dispatch width and the readback width. */
        this.slotCount = 0;
        /** Lines the last configure() armed. */
        this.lineCount = 0;
        /** Resolved params from the last configure(), for inspection. */
        this.params = resolveParams();

        // Uniforms are size-independent, so they outlive buffer reallocation and the kernel is
        // never rebuilt just to retune the fold.
        this._u = {
            outBase:         uniform(0, 'uint'),
            dispEnabled:     uniform(0, 'int'),
            lineCount:       uniform(0, 'uint'),
            wrapWidth:       uniform(0, 'uint'),
            scrollRows:      uniform(0, 'int'),
            lineSpacing:     uniform(0, 'float'),
            zStep:           uniform(0, 'float'),
            origin:          uniform(new THREE.Vector3(0, 0, 0)),
            pagEnabled:      uniform(0, 'int'),
            pagAxis:         uniform(LAYOUT_AXIS.xy, 'int'),
            pagesWide:       uniform(1, 'int'),
            pageRows:        uniform(0, 'int'),     // H / lineSpacing — see the fold's note
            pageStrideX:     uniform(0, 'float'),   // Wp + Gx
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
     */
    _allocate(maxSlots, maxLines) {
        this._releaseBuffers();

        this.maxSlots = maxSlots;
        this.maxLines = maxLines;

        // Owned output is vec4 (visible stride); an external target is the field's OWN vec3
        // attribute wrapped as a storage node — same 16-byte stride either way.
        // External attribute uses itemSize=4 (shader reads as vec4), owned buffer also uses vec4.
        this.positions = this._externalOut
            ? storage(this._externalOut, 'vec4', maxSlots).setName('GlyphLayoutPositionsExt')
            : instancedArray(maxSlots, 'vec4').setName('GlyphLayoutPositions');
        this.xOffsets     = instancedArray(maxSlots, 'float').setName('GlyphLayoutXOffsets');
        this.lineTable    = instancedArray(maxLines, 'uint').setName('GlyphLayoutLineTable');
        this.lineStartRow = instancedArray(maxLines, 'uint').setName('GlyphLayoutLineStartRow');
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
     * The fold: (slot, line) → world position.
     *
     * Kept as its own Fn so a new fold is a new function, not a new kernel — the line search and
     * the write around it never change.
     *
     * @private
     * @returns {Function} TSL fn (slotNode:uint, lineNode:uint) → vec3
     */
    _buildFold() {
        const u = this._u;

        return Fn(([slot, line]) => {
            const j = slot.sub(this.lineTable.element(line)).toVar('j');

            // Intra-line wrap — the Z staircase. A source line spills into wrapWidth-wide
            // segments that step down in Y and back in Z. wrapWidth counts SLOTS, not columns:
            // a double-advance emoji still costs exactly one against the budget.
            const seg = uint(0).toVar('seg');
            If(u.wrapWidth.greaterThan(uint(0)), () => {
                seg.assign(j.div(u.wrapWidth));
            });

            // x is a lookup, not a multiply: xOffsets holds each slot's distance from its visual
            // row's left edge — the running sum of REAL advances, which a nominal cell width
            // would miss by a whole cell after every double-advance emoji. The scan itself is a
            // prefix sum and so cannot be per-slot pure (spec §5.4); configure() pays it once on
            // the CPU in f64, exactly as the builder does. Replacing that with a scan kernel
            // later changes nothing here.
            const x = this.xOffsets.element(slot).add(u.origin.x).toVar('x');

            // Visual row = the line's row prefix (CPU-supplied: rows every earlier line consumed,
            // wraps included) + this glyph's own wrap segment. The conveyor shifts content up by
            // scrollOffset rows, so the page fold sees screenRow — which may be negative for
            // content scrolled above the origin.
            const visualRow = this.lineStartRow.element(line).add(seg).toInt().toVar('visualRow');
            const screenRow = visualRow.sub(u.scrollRows).toVar('screenRow');
            const y = u.origin.y.sub(screenRow.toFloat().mul(u.lineSpacing)).toVar('y');

            const z = u.origin.z.sub(seg.toFloat().mul(u.zStep)).toVar('z');

            // Page fold — a pure remap of (x, y, z) by the glyph's distance below the origin.
            // Rows before the first break (including every negative screenRow) pass through
            // untouched, which is the CPU's early return.
            //
            // The page split runs in INTEGER ROW SPACE, not on world distances. The CPU's
            // `vPage = floor(relY / pageHeightWorld)` cannot be ported literally: WGSL does not
            // require f32 division to be correctly rounded (up to 2.5 ULP), and a page boundary
            // is ALWAYS an exact multiple — relY = row·lineSpacing, H = pageRows·lineSpacing — so
            // the quotient lands just under the integer (measured: relY/H = 0.99999994 for
            // relY == H) and floor() drops the glyph a whole page back. Row counts divide
            // exactly, and pageRows·lineSpacing == pageHeightWorld by construction.
            If(u.pagEnabled.equal(int(1)), () => {
                If(screenRow.greaterThanEqual(u.pageRows), () => {
                    const page = screenRow.div(u.pageRows).toVar('page');
                    const rowOff = screenRow.sub(page.mul(u.pageRows))
                        .toFloat().mul(u.lineSpacing).toVar('rowOff');

                    If(u.pagAxis.equal(int(LAYOUT_AXIS.z)), () => {
                        y.assign(u.origin.y.sub(rowOff));
                        z.subAssign(page.toFloat().mul(u.pageDepthWorld));
                    }).Else(() => {
                        const hSlot = page.mod(u.pagesWide);
                        const yRow = page.div(u.pagesWide);
                        x.addAssign(hSlot.toFloat().mul(u.pageStrideX));
                        y.assign(u.origin.y.sub(rowOff.add(yRow.toFloat().mul(u.pageStrideY))));
                    });
                });
            });

            // Arranger displacement — CPU-authored per-slot xyz, added AFTER wrap and page
            // folds (an arranged block moves relative to its laid-out home, exactly as the
            // CPU arrangers baked it). Indexed field-globally: arrangers think in whole-field
            // slots, items don't renumber them.
            If(u.dispEnabled.equal(int(1)), () => {
                const d = u.outBase.add(slot).mul(uint(3));
                x.addAssign(this.displacements.element(d));
                y.addAssign(this.displacements.element(d.add(uint(1))));
                z.addAssign(this.displacements.element(d.add(uint(2))));
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
            this._allocate(this.maxSlots, this.maxLines);
        }
        this.displacements.value.array.set(arr);
        this.displacements.value.needsUpdate = true;
        this._u.dispEnabled.value = 1;
    }

    /**
     * One thread per slot: resolve the line by binary search, then fold.
     *
     * Out-of-range threads write nothing — `.compute(count)` generates
     * `if (instanceIndex >= count) return;` against a uniform three refreshes from
     * `computeNode.count`, so the guard costs no recompile when slotCount moves.
     *
     * @private
     * @returns {import('three/webgpu').ComputeNode}
     */
    _buildKernel() {
        const u = this._u;
        const fold = this._buildFold();

        return Fn(() => {
            const slot = instanceIndex;

            // Largest L with lineTable[L] <= slot. The upper-mid form is what makes "largest" the
            // tiebreak, which is exactly right for empty lines: they repeat the previous start
            // index and own no slots, so the slot must land on the LAST such line.
            const lo = uint(0).toVar('lo');
            const hi = u.lineCount.sub(uint(1)).toVar('hi');
            Loop(BINARY_SEARCH_STEPS, () => {
                If(lo.greaterThanEqual(hi), () => {
                    Break();
                });
                const mid = lo.add(hi).add(uint(1)).div(uint(2)).toVar('mid');
                If(this.lineTable.element(mid).lessThanEqual(slot), () => {
                    lo.assign(mid);
                }).Else(() => {
                    hi.assign(mid.sub(uint(1)));
                });
            });

            const p = fold(slot, lo);

            // outBase places this dispatch at its item's range in a shared output (a field's
            // bufferStartIndex); owned buffers dispatch at 0. External vec3 writes leave the
            // stride-padding lane alone (WGSL pads vec3 arrays to 16 bytes); the owned vec4
            // Both paths write vec4 with zero padding to match the stride-4 buffer.
            const out = u.outBase.add(slot);
            this.positions.element(out).assign(vec4(p, float(0)));
        })().compute(1).setName('GlyphLayoutKernel');
    }

    /**
     * Reconfigure inputs.
     *
     * @param {Object} cfg
     * @param {number} cfg.slotCount - glyph slots to lay out
     * @param {Uint32Array} cfg.lineTable - ascending line-start slot indexes; first entry 0, last
     *   entry ≤ slotCount. Repeats are legal and mean an empty line. (`itemMeta.lineSlotOffsets`,
     *   rebased to the item.)
     * @param {Uint32Array} cfg.lineStartRow - visual row each line's first row occupies, i.e.
     *   `Σ_{k<L} (1 + wrapColsPerLine[k].length)`. Same length as lineTable.
     * @param {Float32Array} cfg.advances - world advance per slot (the builder's `sizes` x column).
     *   At least slotCount long.
     * @param {GlyphLayoutParams} [cfg.params] - overrides on LAYOUT_PARAM_DEFAULTS
     * @returns {this}
     */
    configure({ slotCount, lineTable, lineStartRow, advances, params, outBase: cfgOutBase }) {
        if (!Number.isInteger(slotCount) || slotCount < 0) {
            throw new Error(`GlyphLayoutKernel: slotCount must be a non-negative integer, got ${slotCount}`);
        }
        if (!(lineTable instanceof Uint32Array)) {
            throw new Error('GlyphLayoutKernel: lineTable must be a Uint32Array');
        }
        if (!(lineStartRow instanceof Uint32Array)) {
            throw new Error('GlyphLayoutKernel: lineStartRow must be a Uint32Array');
        }
        if (!(advances instanceof Float32Array)) {
            throw new Error('GlyphLayoutKernel: advances must be a Float32Array');
        }
        const lineCount = lineTable.length;
        if (lineCount === 0) {
            throw new Error('GlyphLayoutKernel: lineTable must hold at least one line');
        }
        if (lineStartRow.length !== lineCount) {
            throw new Error(`GlyphLayoutKernel: lineStartRow has ${lineStartRow.length} entries, lineTable has ${lineCount}`);
        }
        if (advances.length < slotCount) {
            throw new Error(`GlyphLayoutKernel: advances has ${advances.length} entries, need ${slotCount}`);
        }
        if (lineTable[0] !== 0) {
            throw new Error(`GlyphLayoutKernel: lineTable[0] must be 0, got ${lineTable[0]}`);
        }
        if (lineStartRow[0] !== 0) {
            throw new Error(`GlyphLayoutKernel: lineStartRow[0] must be 0, got ${lineStartRow[0]}`);
        }
        for (let i = 1; i < lineCount; i++) {
            if (lineTable[i] < lineTable[i - 1]) {
                throw new Error(`GlyphLayoutKernel: lineTable must ascend; [${i}]=${lineTable[i]} < [${i - 1}]=${lineTable[i - 1]}`);
            }
            if (lineStartRow[i] <= lineStartRow[i - 1]) {
                throw new Error(`GlyphLayoutKernel: lineStartRow must strictly ascend (every line owns ≥1 visual row); [${i}]=${lineStartRow[i]} ≤ [${i - 1}]=${lineStartRow[i - 1]}`);
            }
        }
        if (lineTable[lineCount - 1] > slotCount) {
            throw new Error(`GlyphLayoutKernel: lineTable ends at ${lineTable[lineCount - 1]}, past slotCount ${slotCount}`);
        }

        const p = resolveParams(params);
        const axis = resolveAxis(p.axis);
        const outBase = cfgOutBase ?? 0;
        if (!Number.isInteger(outBase) || outBase < 0) {
            throw new Error(`GlyphLayoutKernel: outBase must be a non-negative integer, got ${outBase}`);
        }

        // Grow before writing. Capacity is the one input the kernel is compiled against.
        // An external output cannot grow — its capacity is the field's buffer, full stop.
        if (outBase + slotCount > this.maxSlots || lineCount > this.maxLines) {
            if (this._externalOut) {
                throw new Error(`GlyphLayoutKernel: outBase ${outBase} + slotCount ${slotCount} exceeds external capacity ${this.maxSlots}`);
            }
            this._allocate(Math.max(outBase + slotCount, this.maxSlots), Math.max(lineCount, this.maxLines));
        }

        this.slotCount = slotCount;
        this.lineCount = lineCount;
        this.params = p;

        this.lineTable.value.array.set(lineTable);
        this.lineStartRow.value.array.set(lineStartRow);

        // The x scan. This is the builder's own inner loop (`builders/index.js:317-355`) with the
        // glyph writes stripped out: accumulate the real advances in f64, store f32 per slot,
        // reset to 0 at every line start AND every wrap — so xOffsets[slot] IS the CPU's
        // `positions[slot].x − pos.x`, to the bit, including the wide-glyph steps that make a
        // column-times-cell-width formula wrong.
        //
        // Resetting at the wrap (rather than keeping the offsets line-relative and subtracting
        // the segment start on the GPU) is what keeps this exact: two f32 offsets deep into a
        // long line each carry ~half an ulp of that line's full extent, and their difference
        // inherits both — ~5e-4 by column 4000, past any sane epsilon. A segment-relative offset
        // starts from 0 and has no such history. The cost is that the scan depends on wrapWidth,
        // so retuning the wrap rebuilds it — which configure() does anyway.
        const wrapCols = Math.max(0, Math.trunc(p.wrapWidth));
        const xo = this.xOffsets.value.array;
        for (let L = 0; L < lineCount; L++) {
            const end = L + 1 < lineCount ? lineTable[L + 1] : slotCount;
            let acc = 0, onSegment = 0;
            for (let i = lineTable[L]; i < end; i++) {
                if (wrapCols > 0 && onSegment >= wrapCols) { acc = 0; onSegment = 0; }
                xo[i] = acc;
                acc += advances[i];
                onSegment++;
            }
        }

        this.lineTable.value.needsUpdate = true;
        this.lineStartRow.value.needsUpdate = true;
        this.xOffsets.value.needsUpdate = true;

        // A page height is a ROW count, and the shader splits pages by integer division on rows —
        // see the fold's note on WGSL f32 division. `pageHeightWorld` never exists as a number
        // the GPU divides by; it only shows up folded into the y stride.
        const pageRows = Math.max(0, Math.trunc(p.pageHeight));

        const u = this._u;
        u.outBase.value = outBase;
        u.lineCount.value = lineCount;
        u.wrapWidth.value = wrapCols;
        u.scrollRows.value = Math.trunc(p.scrollOffset);
        u.lineSpacing.value = p.lineSpacing;
        u.zStep.value = p.zWrapStep;
        u.origin.value.set(p.origin.x, p.origin.y, p.origin.z);
        u.pagEnabled.value = pageRows > 0 ? 1 : 0;
        u.pagAxis.value = axis;
        u.pagesWide.value = Math.max(1, Math.trunc(p.pagesWide));  // it divides — 0 would fault
        u.pageRows.value = pageRows;
        u.pageStrideX.value = p.pageWidthWorld + p.pageGapXWorld;
        u.pageStrideY.value = pageRows * p.lineSpacing + p.pageGapYWorld;
        u.pageDepthWorld.value = p.pageDepthWorld;

        // Drives both the dispatch grid and the generated bounds check; three re-derives the
        // workgroup count when it changes, so this is not a recompile.
        this._kernel.count = slotCount;

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
        for (const node of [this.xOffsets, this.lineTable, this.lineStartRow, this.displacements]) {
            if (node && attributes) attributes.delete(node.value);
        }
        // An owned positions buffer is ours to free; an external attribute is the FIELD's —
        // its geometry keeps rendering from it after this kernel is gone.
        if (this.positions && !this._externalOut && attributes) attributes.delete(this.positions.value);
        this.positions = null;
        this.xOffsets = null;
        this.lineTable = null;
        this.lineStartRow = null;
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
