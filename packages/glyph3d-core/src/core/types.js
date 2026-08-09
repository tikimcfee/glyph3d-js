/**
 * Canonical type definitions for the glyph3d-js buffer contract.
 *
 * This file contains only JSDoc @typedef declarations — no runtime code.
 * It is the single source of truth for the portable data contract between
 * text processing (builders, workers) and GPU rendering (GlyphField).
 *
 * Import this file for type reference only:
 *   import './core/types.js'; // JSDoc only — no exports consumed at runtime
 *
 * Or reference via JSDoc in consuming files:
 *   @type {import('./core/types.js').GlyphBufferSet}
 */

/**
 * The portable buffer contract between text processing and GPU rendering.
 * Output of buildBatchBuffers(). Input to applyPrebuiltBuffers().
 * 10 floats = 40 bytes per glyph across 5 typed arrays.
 *
 * Note: `count` (not `glyphCount`) is the field name on the actual returned
 * object. Spaces (codepoint 32) advance the cursor but do not occupy a buffer
 * slot. Control characters (codepoint <= 32) are also excluded. The `count`
 * value equals the number of populated slots across all five arrays.
 *
 * @typedef {Object} GlyphBufferSet
 * @property {Float32Array} sizes      - vec2 per glyph (advance, height). Length: count * 2.
 *   The advance lane is also the layout scan's input: x offsets are the running sum of these
 *   REAL advances, never a column times a nominal cell width.
 * @property {Float32Array} codepoints - numeric DataTexture ID per glyph for GPU-side UV lookup
 *   via atlasMapTexture. For single-codepoint graphemes this equals the Unicode codepoint;
 *   for multi-codepoint graphemes (ZWJ sequences) it is a synthetic ID assigned by GlyphAtlas.
 *   Length: count
 * @property {Float32Array} colors     - vec3 per glyph (r, g, b, 0-1 range). Length: count * 3
 * @property {Float32Array} groupIds   - group texture row per glyph. Length: count
 * @property {number} count            - number of populated glyph slots (excludes spaces and
 *   control characters — codepoint <= 32 advances cursor but does not emit a buffer slot)
 * @property {GlyphBufferItemMeta[]} itemMeta - per-text-entry metadata, one entry per input item.
 *   Only present on output of buildBatchBuffers(); absent from buildGlyphBuffers() output.
 */

/**
 * Per-text-item metadata produced alongside buffer data by buildBatchBuffers().
 * Enables post-render operations (updatePosition, updateColor, highlight range lookup)
 * on individual text entries after the worker path.
 *
 * @typedef {Object} GlyphBufferItemMeta
 * @property {number} bufferStartIndex - first slot index in the combined buffer for this item.
 *   Multiply by the attribute's stride (2 for sizes, 1 for codepoints/groupIds, 3 for colors)
 *   to get the Float32Array offset. NOTE: the INSTALLED instancePosition attribute is stride-4
 *   (a storage buffer the layout kernel writes) — CPU readers of the live attribute must use
 *   attr.itemSize, never a hardcoded stride.
 * @property {number} glyphCount       - number of glyph slots occupied by this item
 * @property {number[]} lineSlotOffsets - maps line index → absolute buffer slot of the first glyph
 *   on that line. lineSlotOffsets[0] equals bufferStartIndex. THE layout table: the kernel binary-
 *   searches it to resolve a slot's source line, the layout scan derives the visual-row prefix and
 *   the row extents from it, and CodeGrid.highlightRange() maps source lines to highlight slots
 *   through it. Stored as a plain Array (not Int32Array) in the builder output.
 *
 * There is no `bounds` and no positional metadata here. The builder does not lay anything out:
 * positions are the kernel's (compute/GlyphLayoutKernel) and the extent is a closed form on the
 * line table (core/foldGeometry.foldExtent), recorded onto the renderedTexts entry at dispatch
 * as `fold` (the scan's scalars) + `extent` (the box).
 */

/**
 * Minimal GPU contract specification (requirements doc, NOT a runtime interface).
 * Documents what glyph3d-js needs from any graphics backend.
 * Use as a checklist when implementing a new backend (wgpu, Metal, etc.)
 *
 * Hard requirements:
 * - Instanced drawing with a vertex-stage instance index
 * - 5 instance attributes:
 *     instancePosition  vec4  (x, y, z world position + padding lane; stride-4 as bound)
 *     instanceSize      vec2  (width, height of the quad)
 *     instanceGlyphId   float (HarfBuzz glyph ID, indexes glyphMapTexture)
 *     instanceColor     vec4  (r, g, b, 0-1 + padding lane; stride-4 storage class —
 *                              the far-scatter kernel binds it as a compute view)
 *     instanceGroupId   float (row index into the group storage buffer)
 * - Read-only vertex-stage storage buffer: the group table (GROUP_STRIDE vec4
 *   rows — pose/color/scale/clip/far, schema in core/glyphVertex.js)
 * - 3 texture bindings:
 *     curveTexture     RGBA16UI nearest  — quadratic bezier control points (2 texels/curve)
 *     glyphMapTexture  RGBA16UI nearest  — glyph ID → curve range (start, count)
 *     highlightTexture RGBA8    nearest  — per-glyph additive highlight color
 * - RGBA32F textures with NearestFilter only (no OES_texture_float_linear dependency)
 * - Offscreen RGBA8 render target for the picking pass
 * - texelFetch in vertex+fragment shaders (usampler2D for Slug textures)
 * - Minimum 2048x2048 texture dimension support
 * - Partial buffer upload (addUpdateRange equivalent) for direct-write position/color paths
 * - Picking ID derivation as (uBasePickingId + instanceIndex) — no per-glyph picking attribute
 *
 * @typedef {Object} GlyphGPUSpec
 * @property {Function} createPipeline      - (vertexSrc: string, fragmentSrc: string, instanceLayout: Object, bindingLayout: Object) → Pipeline
 * @property {Function} createBuffer        - (byteSize: number) → Buffer
 * @property {Function} uploadBuffer        - (buf: Buffer, data: Float32Array) → void
 * @property {Function} uploadBufferRange   - (buf: Buffer, byteOffset: number, data: Float32Array) → void
 * @property {Function} createTexture       - (w: number, h: number, format: string, filter: string, mipmaps: boolean) → Texture
 * @property {Function} uploadTexture       - (tex: Texture, data: TypedArray) → void
 * @property {Function} createBitmapTexture - (pixels: HTMLCanvasElement|ImageData, mipmaps: boolean) → Texture
 * @property {Function} createBindGroup     - (pipeline: Pipeline, bindings: {textures: Object, uniforms: Object}) → BindGroup
 * @property {Function} drawInstanced       - (pipeline: Pipeline, bindGroup: BindGroup, vertexBuf: Buffer, instanceBufs: Buffer[], count: number) → void
 * @property {Function} createRenderTarget  - (w: number, h: number) → RenderTarget
 * @property {Function} setRenderTarget     - (target: RenderTarget|null) → void
 * @property {Function} clear               - (r: number, g: number, b: number, a: number) → void
 * @property {Function} readPixel           - (target: RenderTarget, x: number, y: number) → Promise<Uint8Array>
 */
