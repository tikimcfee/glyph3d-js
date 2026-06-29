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
 * @property {Float32Array} positions  - vec3 per glyph (x, y, z). Length: count * 3
 * @property {Float32Array} sizes      - vec2 per glyph (width, height from atlas metrics). Length: count * 2
 * @property {Float32Array} codepoints - numeric DataTexture ID per glyph for GPU-side UV lookup
 *   via atlasMapTexture. For single-codepoint graphemes this equals the Unicode codepoint;
 *   for multi-codepoint graphemes (ZWJ sequences) it is a synthetic ID assigned by GlyphAtlas.
 *   Length: count
 * @property {Float32Array} colors     - vec3 per glyph (r, g, b, 0-1 range). Length: count * 3
 * @property {Float32Array} groupIds   - group texture row per glyph. Length: count
 * @property {number} count            - number of populated glyph slots (excludes spaces and
 *   control characters — codepoint <= 32 advances cursor but does not emit a buffer slot)
 * @property {Object|null} bounds      - combined bounding box, or null if no glyphs were emitted.
 *   Shape: {min: {x,y,z}, max: {x,y,z}, width: number, height: number, depth: number}
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
 *   Multiply by attribute stride (3 for positions, 2 for sizes, 1 for codepoints/groupIds/colors)
 *   to get the Float32Array offset.
 * @property {number} glyphCount       - number of glyph slots occupied by this item
 * @property {Object|null} bounds      - item-local bounding box, or null if item had no renderable glyphs.
 *   Shape: {min: {x,y,z}, max: {x,y,z}, width: number, height: number, depth: number}
 * @property {number[]} lineSlotOffsets - maps line index → absolute buffer slot of the first glyph
 *   on that line. lineSlotOffsets[0] equals bufferStartIndex. Built in the same pass as the buffer
 *   fill; used by CodeGrid.highlightRange() to map source line numbers to highlight texture slots.
 *   Stored as a plain Array (not Int32Array) in the builder output.
 * @property {number[][]} wrapColsPerLine - per source line, the source-col indices where the
 *   builder wrapped that line into a new visual row (empty for lines that fit). Backs the
 *   LayoutDescription's visual-row mapping for the caret. REQUIRED for cursor-accurate layout —
 *   must be preserved through applyPrebuiltBuffers, not dropped.
 * @property {number} pageContentWidth - the page column width (world units) used when this item
 *   paginated, or 0 if unpaginated. The LayoutDescription/caret pass the SAME width to pagination
 *   so the caret aligns with glyphs (never a second char-count guess).
 */

/**
 * Minimal GPU contract specification (requirements doc, NOT a runtime interface).
 * Documents what glyph3d-js needs from any graphics backend.
 * Use as a checklist when implementing a new backend (wgpu, Metal, etc.)
 *
 * Hard requirements:
 * - Instanced drawing with gl_InstanceID (ES 3.0 / WebGL 2 hard floor)
 * - 5 instance attributes:
 *     instancePosition  vec3  (x, y, z world position)
 *     instanceSize      vec2  (width, height of the quad)
 *     instanceGlyphId   float (HarfBuzz glyph ID, indexes glyphMapTexture)
 *     instanceColor     vec3  (r, g, b, 0-1)
 *     instanceGroupId   float (row index into group DataTexture)
 * - 4 texture bindings:
 *     curveTexture     RGBA16UI nearest  — quadratic bezier control points (2 texels/curve)
 *     glyphMapTexture  RGBA16UI nearest  — glyph ID → curve range (start, count)
 *     groupTexture     RGBA32F  nearest  — per-group offset/color/scale
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
