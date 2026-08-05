/**
 * GlyphFieldPipeline — the adapter between a byte-mode GlyphField and the byte-in
 * GPU pipeline. This is the Layer 2 replacement for GlyphLayoutCompute: where that
 * marshals builder tables into the fold kernel, this hands the GPU the file's BYTES
 * and lets the pipeline decode, walk, and paginate them.
 *
 * Per-GRID today (one pipeline per field). The field reads positions/sizes/glyphIds
 * straight from the pipeline's slot buffer (GlyphField._fieldSlots seam); slotBase is
 * the multi-file hoist point — when one pipeline serves a whole load storm, each field
 * gets a base offset instead of its own buffers.
 *
 * The CPU mirror (glyphPipelineReference.runPipeline) runs on the same bytes at load and
 * is the ORACLE: extents and point queries come from it synchronously, and layout.verify
 * diffs the GPU slots against it. The GPU is the authority the gates check; the mirror is
 * how the CPU answers questions without a readback.
 *
 * The trie comes from the live atlas (liveTrie.js): decode resolves codepoint → the
 * FontChain slot id the vertex shader's glyph-map texture is keyed by. Misses (codepoints
 * the atlas has never shaped) flow back: encode → rebuild trie → rebuild kernels → re-run.
 */

import GlyphPipelineKernels from './glyphPipelineKernels.js';
import { runPipeline, paginate as refPaginate, boundsReduce as refBoundsReduce } from './glyphPipelineReference.js';
import { buildLiveTrie, encodeMisses } from './liveTrie.js';

const encoder = new TextEncoder();

export default class GlyphFieldPipeline {
    /**
     * @param {import('three/webgpu').WebGPURenderer} renderer - the compute renderer
     * @param {import('../GlyphField.js').default} field - a bytePipeline-constructed field
     * @param {Object} atlas - the live GlyphAtlas (shape cache + shaper + Slug encoder)
     * @param {Object} opts
     * @param {number} opts.maxBytes - slot capacity (one slot per byte)
     * @param {number} opts.worldScale - the grid's world scale
     */
    constructor(renderer, field, atlas, { maxBytes, worldScale }) {
        if (!field?._bytePipeline) throw new Error('GlyphFieldPipeline: field must be bytePipeline-constructed');
        this.renderer = renderer;
        this.field = field;
        this.atlas = atlas;
        this.worldScale = worldScale;
        this.maxBytes = Math.max(1024, maxBytes | 0);
        this.byteLength = 0;
        this._trie = buildLiveTrie(atlas, worldScale);
        this._kernels = new GlyphPipelineKernels(renderer, { maxBytes: this.maxBytes, trie: this._trie });
        this._mirror = null;   // runPipeline output from the last setText — the CPU oracle
        this._bytes = null;
        this._params = null;
    }

    /** The CPU oracle (runPipeline output) from the last setText — slots + bounds. */
    get mirror() { return this._mirror; }

    /**
     * Load text: encode → mirror → dispatch → attach. The mirror runs FIRST so its
     * maxRowExtent can feed a snug pageStrideX in the same breath.
     *
     * @param {string} text
     * @param {Object} p
     * @param {number} [p.window] - walk coherence window (default 128)
     * @param {number} [p.wrapWidth] - visual columns before wrapping (0 = off)
     * @param {number} p.lineHeight - world y per row
     * @param {number} [p.zStep] - depth per wrap segment (zWrapSpacing × charHeight)
     * @param {{x,y,z}} [p.origin]
     * @param {Object} [p.page] - { pageRows, pageCols, pagesWide, pageGapX, depthPerBand,
     *   depthPerColumn, scrollRows } — pageGapX is world units BETWEEN page columns
     * @returns {Promise<{bounds: ?Object, misses: number[]}>}
     */
    async setText(text, p = {}) {
        const bytes = encoder.encode(text);
        if (bytes.length > this.maxBytes) {
            throw new Error(`GlyphFieldPipeline: ${bytes.length} bytes exceeds capacity ${this.maxBytes}`);
        }
        const pageIn = p.page || {};
        const mirrorOpts = {
            // The mirror is SERIAL — the race it simulates on the GPU doesn't exist here,
            // so the coherence window is pure cost: window 0 inherits from the immediate
            // predecessor (provably the same result — every order converges, tested).
            window: 0, wrapWidth: p.wrapWidth || 0, lineHeight: p.lineHeight,
            zStep: p.zStep || 0, scrollRows: pageIn.scrollRows || 0, origin: p.origin,
            page: p.page ? { ...pageIn } : null,
        };
        // The mirror first: the walk's widest row is the page column stride (plus the gap),
        // measured — never a nominal cell width.
        this._mirror = runPipeline(bytes, this._trie, mirrorOpts);
        const page = p.page ? { ...pageIn } : {};
        if (page.pageRows > 0) {
            page.pageStrideX = (this._mirror.bounds?.maxRowExtent ?? 0) + (page.pageGapX || 0);
        }
        delete page.pageGapX;
        this._bytes = bytes;
        this._params = { window: p.window ?? 128, wrapWidth: p.wrapWidth || 0,
            lineHeight: p.lineHeight, zStep: p.zStep || 0, origin: p.origin, page };
        this.byteLength = bytes.length;

        this._kernels.setFile(bytes, this._params);
        this._kernels.run();
        this.field.attachBytePipeline(this._kernels, bytes.length);
        // The mirror paginated with pageStrideX unset; re-paginate it in place with the
        // FINAL page params (the remap is reconstructive — exact) so mirror == GPU.
        this.field.setLayoutExtent(this.getExtent(page));

        // Miss flow, OFF the load path: the readback stalls on the GPU queue, and the
        // layout is already correct (missing entries occupy their advance) — so encode +
        // re-run happens as a background continuation that paints the new glyphs in. The
        // generation guard drops the continuation if a newer setText already ran.
        const gen = (this._missGen = (this._missGen || 0) + 1);
        Promise.resolve()
            .then(() => this._kernels.readMisses())
            .then((misses) => {
                if (gen !== this._missGen || !misses.length || !this._kernels) return;
                const res = encodeMisses(this.atlas, misses);
                if (!res?.grew || gen !== this._missGen) return;
                this._trie = buildLiveTrie(this.atlas, this.worldScale);
                this._kernels.dispose();
                this._kernels = new GlyphPipelineKernels(this.renderer, { maxBytes: this.maxBytes, trie: this._trie });
                this._kernels.setFile(this._bytes, this._params);
                this._kernels.run();
                this.field.attachBytePipeline(this._kernels, this.byteLength);
            })
            .catch(() => {});
        return { bounds: this._mirror.bounds, misses: [] };
    }

    /**
     * Page/mode/scroll retune — kernel 3 alone re-runs over the base positions. The remap
     * is reconstructive, so this is safe to call on every scroll tick. NOT for pageCols
     * changes (those change the walk — full setText).
     */
    setPage(p = {}) {
        const page = { ...p };
        if (page.pageRows > 0 && page.pageStrideX == null) {
            page.pageStrideX = (this._mirror?.bounds?.maxRowExtent ?? 0) + (page.pageGapX || 0);
        }
        delete page.pageGapX;
        this._kernels.setPage(page);
        this._kernels.repaginate();
        this.field.setLayoutExtent(this.getExtent(page));
    }

    /**
     * The field's content extent, synchronously — from the mirror's bounds. On a
     * page/scroll retune the mirror re-paginates IN PLACE (the remap is reconstructive,
     * so re-running it on the same slots is exact) and re-reduces — no walk, no decode.
     * @param {Object} [pageOverride]
     */
    getExtent(pageOverride) {
        if (!this._mirror) return null;
        if (pageOverride !== undefined) {
            const page = { ...pageOverride, wrap: this._params.wrapWidth, origin: this._params.origin,
                zStep: this._params.zStep, lineHeight: this._params.lineHeight };
            const { slots } = this._mirror;
            const n = this.byteLength;
            for (let id = 0; id < n; id++) refPaginate(slots, id, page);
            const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, 0]);
            for (let id = 0; id < n; id++) refBoundsReduce(slots, id, box);
            this._mirror.bounds = box[0] === Infinity ? null : {
                min: { x: box[0], y: box[1], z: box[2] },
                max: { x: box[3], y: box[4], z: box[5] },
                totalRows: box[6], maxRowExtent: box[7],
            };
        }
        const b = this._mirror.bounds;
        return b ? { min: b.min, max: b.max } : null;
    }

    /** GPU slots vs the mirror, per leader — the live-scene assertion. */
    async verify(eps = 1e-3) {
        const gpu = await this._kernels.readSlots();
        const ref = this._mirror?.slots;
        if (!ref) return { ok: false, reason: 'no mirror' };
        let worst = 0, badRows = 0;
        const STRIDE = 11;
        for (let id = 0; id < this.byteLength; id++) {
            const b = id * STRIDE;
            if ((ref[b + 9] & 1) === 0) continue;
            if (gpu[b + 7] !== ref[b + 7] || gpu[b + 8] !== ref[b + 8]) badRows++;
            for (const l of [4, 5, 6, 10]) {
                const d = Math.abs(gpu[b + l] - ref[b + l]);
                if (d > worst) worst = d;
            }
        }
        return { ok: badRows === 0 && worst <= eps, worst, badRows };
    }

    dispose() {
        this._kernels?.dispose();
        this._kernels = null;
        this._mirror = null;
    }
}
