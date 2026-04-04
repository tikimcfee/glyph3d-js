# GPU-Accelerated Unicode Grapheme Segmentation & Text-to-Glyph Mapping

Research into fixing glyph3d-js's `charCodeAt(i)` UTF-16 code unit iteration
so that surrogate pairs, ZWJ sequences, and complex scripts render correctly
while preserving the instanced-quad GPU rendering architecture.

---

## 1. The Current Problem in glyph3d-js

The builder pipeline (`src/workers/builders/index.js`, `textToGlyphs.js`,
`InstanceBuffer.js`) iterates text with `charCodeAt(i)`, which yields
**UTF-16 code units**, not codepoints or grapheme clusters.

Consequences:

- A surrogate pair like U+1F600 (grinning face) is two code units
  (0xD83D, 0xDE00). Each gets its own instanced quad pointing at a
  nonexistent atlas entry. Result: two `?` glyphs instead of one emoji.
- A ZWJ family emoji like (U+1F469 U+200D U+1F469 U+200D U+1F467 U+200D U+1F466)
  is 11 code units / 7 codepoints / 1 grapheme. Current code emits 7+ quads.
- Flag sequences (Regional Indicator pairs) emit two quads instead of one flag.
- Arabic/Devanagari contextual shaping is absent -- each codepoint renders
  its isolated form rather than the shaped ligature.

The GlyphAtlas uses Canvas 2D `fillText` per codepoint, which works for
BMP characters but produces no atlas entry for surrogate halves.

---

## 2. The Swift/Metal Sibling: What It Does and Doesn't Solve

The Metal compute pipeline (documented in `cross-ref/metal-gpu-layout-analysis.md`)
runs three GPU passes:

1. **utf8ToUtf32KernelAtlasMapped** -- one thread per byte, decodes UTF-8
   to codepoints, looks up atlas UVs via hash. One thread per byte position;
   non-start bytes early-return.
2. **utf32GlyphMap_FastLayout** -- backtracking layout (each thread walks
   backwards up to 128 positions to compute its X/Y offset).
3. **utf32GlyphMap_FastLayout_Paginate** -- page-break transforms.

What Metal does NOT do:
- **No grapheme segmentation.** It maps individual codepoints to atlas entries.
  ZWJ sequences, flag pairs, and combining marks are not handled.
- **No text shaping.** Arabic contextual forms require HarfBuzz or CoreText;
  the Metal shader treats each codepoint independently.
- The UTF-8 decode is byte-level parallel (clever) but the output is still
  one glyph per codepoint, not one glyph per grapheme cluster.

The Metal approach gives us a template for GPU-parallel codepoint extraction
but does not address the harder problem of grapheme cluster segmentation.

---

## 3. UAX #29: The Grapheme Cluster Break Algorithm

Unicode Standard Annex #29 defines extended grapheme cluster boundaries via
16 break property categories and 13 active rules (GB1--GB999).

### Break Property Categories (16)

CR, LF, Control, Extend, ZWJ, Regional_Indicator, Prepend, SpacingMark,
L, V, T, LV, LVT, Extended_Pictographic, InCB (Indic Conjunct Break), Any.

### Rules Summary

| Rule | Pattern | Notes |
|------|---------|-------|
| GB3 | CR x LF | Never break between CR and LF |
| GB4-5 | Control / CR / LF | Always break before/after |
| GB6-8 | Hangul jamo composition | L, V, T, LV, LVT sequences |
| GB9 | x (Extend / ZWJ) | Never break before Extend or ZWJ |
| GB9a | x SpacingMark | Never break before SpacingMark |
| GB9b | Prepend x | Never break after Prepend |
| GB9c | InCB Consonant x [InCB Extend InCB Linker]* InCB Consonant | Indic conjunct |
| GB11 | ExtPict (Extend*) ZWJ x ExtPict | Emoji ZWJ sequences |
| GB12-13 | RI x RI (odd count) | Regional indicator pairs |
| GB999 | Any / Any | Break everywhere else |

### DFA Complexity

The UAX #29 spec explicitly states the rules "can be easily converted into
fast, deterministic finite-state machines." Implementations confirm this is
small:

- **ugrapheme** (C/Cython): implements rules as an LL(1) grammar with "a
  very small number of DFA states." Achieves ~337 ns per operation.
- **unicode-segmenter** (JS): uses 14 categories, 8 state variables
  (cursor, catBefore, catAfter, risCount, emoji flag, consonant flag,
  linker flag, index). Lookup tables total 7.6 KB. BMP characters (99%+
  of real text) resolve in O(1) via packed 4-bit tables. ASCII is inlined.
- The full DFA has approximately **20-30 states** depending on how rules
  are merged. This is small enough for GPU monoid-based parallel evaluation.

### Performance of CPU Implementations

| Implementation | Performance | Notes |
|----------------|-------------|-------|
| `Intl.Segmenter` (V8 native) | Baseline | Native ICU, allocates iterator objects |
| unicode-segmenter (JS) | 2-5x faster than Intl.Segmenter | 3.1 KB gzipped, 7.6 KB lookup tables |
| graphemer (JS) | ~8x slower than unicode-segmenter | 95 KB minified |
| Rust unicode-segmentation (WASM) | 1.5-3x slower than unicode-segmenter | WASM overhead |

---

## 4. Parallelizing DFA Evaluation on GPU

### The Monoid Homomorphism Technique

Raph Levien (xi-editor, Druid, Vello) demonstrated that sequential state
machine evaluation can be parallelized via **prefix scan over a monoid
homomorphism**. The technique:

1. Map each input symbol to a **function from state to state**.
   For a DFA with N states, this is a length-N tuple encoding destination
   states. For N=4: a quote maps to (1, 0, 1, _), a backslash to (3, 2, 1, _).
2. These functions compose associatively: applying function b to outputs
   of function a gives `(b[a[0]], b[a[1]], ..., b[a[N-1]])`. This forms a
   **monoid** (associative + identity element).
3. Run a **parallel prefix scan** over the composed functions. This reveals
   every position's state in O(log n) parallel depth with O(n) total work.

For the grapheme break DFA with ~20-30 states, each "function" is a tuple
of 20-30 values. At 1 byte per state index, that's 20-30 bytes per input
element for the monoid representation. The prefix scan composition step
involves N table lookups per composition.

### Practical GPU Performance

Levien's prototype for JSON string unescaping (4 DFA states) on CUDA
achieved **~4 GB/s** vs 200 MB/s sequential CPU -- a 20x speedup on a
GTX 1060. The bottleneck was global memory bandwidth, not computation.

For grapheme segmentation with ~25 states, the monoid element is larger
(25 bytes vs 4 bytes) but the approach scales. A 100 KB source file has
~100K characters; at 4 GB/s throughput, GPU segmentation completes in
~25 microseconds. This is far below the threshold where GPU dispatch
overhead dominates (~50-100 us for WebGPU).

### Verdict: GPU Grapheme Segmentation Is Theoretically Sound but Impractical

For our use case (code files, typically < 500 KB), CPU-side grapheme
segmentation via unicode-segmenter completes in **< 1 ms**. The GPU
dispatch overhead alone (buffer creation, shader compilation, readback)
dwarfs the actual computation time. GPU DFA evaluation makes sense for
multi-gigabyte text streams, not code visualization.

---

## 5. How GPU-Accelerated Terminals Actually Handle This

Every major GPU-accelerated terminal does grapheme segmentation on the CPU.
The GPU handles rasterization only. Here is the universal architecture:

### The Industry-Standard Pipeline

```
Text Input
    |
    v
[CPU] Grapheme Segmentation (UAX #29)
    |-- Intl.Segmenter, ICU, or custom DFA
    |-- Groups codepoints into grapheme clusters
    |-- Determines display width (wcwidth / UAX #11)
    v
[CPU] Text Shaping (HarfBuzz / CoreText)
    |-- Maps grapheme clusters to glyph IDs
    |-- Applies contextual substitution (Arabic, Devanagari)
    |-- Computes glyph advances and positions
    |-- Handles ligatures, combining marks, ZWJ
    v
[CPU] Glyph Rasterization (FreeType / CoreText / Canvas 2D)
    |-- Renders shaped glyphs to bitmaps
    |-- One atlas entry per shaped glyph (not per codepoint)
    |-- Color emoji get RGBA entries; text glyphs get alpha-only
    v
[GPU] Atlas Upload + Instanced Rendering
    |-- Texture atlas with all rasterized glyphs
    |-- One quad per shaped glyph with position + UV + color
    |-- Single draw call via instancing
```

### Terminal-Specific Details

| Terminal | Shaping | Grapheme Seg | GPU Role |
|----------|---------|-------------|----------|
| **Ghostty** (Zig) | HarfBuzz / CoreText | Full UAX #29, Unicode 17 | Final quad draw only (OpenGL/Metal) |
| **Kitty** (C/Python) | HarfBuzz | Full, Unicode 16 | Sprite atlas in 3D texture array |
| **Warp** (Rust) | HarfBuzz-compat | Full | Textured quads, sub-pixel atlas |
| **Zed** (Rust) | OS-native / harfrust | Full, cached runs | Atlas assembly on GPU |
| **Alacritty** (Rust) | Minimal (crossfont) | Limited | Known emoji issues |

**Key insight: No shipping GPU terminal or editor does grapheme segmentation
on the GPU.** Every one segments and shapes on CPU, rasterizes to an atlas,
and hands the GPU pre-positioned textured quads.

---

## 6. Slug Library: GPU Bezier Text (Now Public Domain)

As of March 2026, Eric Lengyel dedicated the Slug patent to the public
domain. Slug renders text from Bezier curves directly on GPU without
texture atlases. Relevant to our problem:

- Accepts UTF-8 strings, performs layout including kerning, ligature
  replacement, combining mark placement, and character composition.
- Handles skin tone modifiers and ZWJ emoji sequences.
- Renders color emoji with resolution independence.
- Works with Vulkan, Metal, OpenGL 3.0+, and WebGL2.

Slug does text shaping and grapheme handling on the CPU side, then
generates vertex buffers for GPU rendering. The GPU shader evaluates
Bezier curves per pixel -- a very different approach from texture atlas
instancing. Not directly applicable to our architecture but proves that
proper Unicode handling can coexist with GPU rendering.

---

## 7. The Canvas 2D getTextClusters() API

A new browser API (Chrome 128+ behind flag, shipping in Canary 132+)
provides exactly what we need for grapheme-aware atlas building:

```javascript
const metrics = ctx.measureText(text);
const clusters = metrics.getTextClusters(0, text.length);
// Returns: [{x, y, begin, end, align, baseline}, ...]
```

Each `TextCluster` represents one grapheme cluster with:
- `begin`, `end`: character indices in the original string
- `x`, `y`: position accounting for shaping and advances
- Companion `ctx.fillTextCluster(cluster, x, y)` renders individual
  clusters with correct shaping context preserved

This API handles ZWJ sequences, combining marks, bidirectional text,
and complex scripts because the browser's text engine does the shaping.
When available, it would let our atlas render one texture region per
grapheme cluster rather than per codepoint, solving the problem at the
source.

**Status**: Behind experimental flag. Not yet stable in any browser.
Not available in OffscreenCanvas or Web Workers currently.

---

## 8. WebGPU Compute Shader State of Play

### Browser Support (March 2026)

- **Chrome**: Shipping since v113 (2023). Stable, mature.
- **Firefox**: Windows (v141), macOS Apple Silicon (v145). Linux/Android in progress.
- **Safari**: macOS/iOS/iPadOS/visionOS 26+. Full support.
- **Global coverage**: ~70% as of late 2024, growing.
- **Mobile**: Fragmented. Chrome Android works on recent hardware. iOS 26 solid.

### Prefix Sum in WGSL

Working implementations exist:
- **GPUPrefixSums** (b0nes164): comprehensive collection in CUDA, D3D12,
  Unity, and WGPU. Includes "Decoupled Fallback" for devices without
  forward progress guarantees.
- **Subgroup operations**: WGSL provides `subgroupExclusiveAdd` for
  hardware-accelerated intra-warp scans. Not yet universally available.
- Tree reduction achieves ~48 G elements/s on AMD 5700 XT.

### Why GPU Compute Doesn't Help Us Here

The grapheme segmentation problem for a typical source file (10-100 KB)
is too small for GPU compute dispatch overhead. The CPU completes
segmentation before the GPU could even begin its first workgroup.

Where GPU compute WOULD help: if we moved the entire text-to-buffer
pipeline (segmentation + layout + buffer writing) to the GPU, processing
thousands of files in a single dispatch. This is a WebGPU-only future
that requires the full Metal-style compute pipeline ported to WGSL.

---

## 9. Recommended Architecture for glyph3d-js

### Phase 1: Fix Iteration (Immediate, WebGL2)

Replace `charCodeAt(i)` with proper grapheme cluster iteration.
Two options, use together:

**Option A: `Intl.Segmenter` (zero dependencies)**
```javascript
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
for (const { segment } of segmenter.segment(text)) {
    // segment is one grapheme cluster (string)
    // Use it as the atlas key instead of individual charCodes
}
```
Available in all modern browsers. Slower than unicode-segmenter but
zero bundle cost. For our file sizes (< 500 KB), even at the slower
speed, segmentation is < 5 ms -- negligible vs atlas generation (200 ms).

**Option B: unicode-segmenter (3 KB gzipped, 2-5x faster)**
```javascript
import { graphemeSegments } from 'unicode-segmenter/grapheme';
for (const { segment } of graphemeSegments(text)) {
    // Same interface as Intl.Segmenter
}
```
Better if segmenting in Web Workers where Intl.Segmenter may be slower
or if targeting React Native / embedded runtimes.

### Phase 2: Grapheme-Aware Atlas (Immediate, WebGL2)

Change the atlas key from `charCode` (number) to `graphemeString` (string):

```javascript
// Before: atlas maps charCode -> UV rect
this.uvMap = new Map(); // Map<number, {u0, v0, u1, v1}>

// After: atlas maps grapheme string -> UV rect
this.uvMap = new Map(); // Map<string, {u0, v0, u1, v1}>
```

For each unique grapheme cluster encountered:
1. Use `ctx.measureText(grapheme)` to get its width.
2. Use `ctx.fillText(grapheme, x, y)` to rasterize it into the atlas.
3. Store the UV rect keyed by the grapheme string.

Canvas 2D `fillText` already handles:
- Surrogate pairs (renders the full emoji)
- ZWJ sequences (renders the composed emoji if font supports it)
- Combining marks (renders the composed character)
- But NOT contextual shaping (Arabic/Devanagari need surrounding context)

For contextual shaping (Arabic, Devanagari), `fillText` of an isolated
character produces the wrong glyph. See Phase 3.

### Phase 3: Text Shaping via Canvas Context (Medium-term, WebGL2)

For scripts requiring contextual shaping, render the full shaped run
and extract individual grapheme positions:

**If getTextClusters() is available:**
```javascript
const metrics = ctx.measureText(fullLine);
const clusters = metrics.getTextClusters(0, fullLine.length);
for (const cluster of clusters) {
    // cluster.begin/end gives character range
    // Rasterize each cluster using fillTextCluster()
    // This preserves shaping context
}
```

**Fallback without getTextClusters():**
Render the full line to a temporary canvas, then for each grapheme
cluster, measure its advance width and extract the sub-rectangle from
the rendered line. This is slower but works today.

For code visualization (primarily ASCII + occasional emoji), Phase 2
handles 99%+ of content. Phase 3 is only needed for Arabic/Devanagari
source files.

### Phase 4: WebGPU Compute Pipeline (Long-term)

When targeting WebGPU, port the Metal-style multi-pass pipeline to WGSL:
grapheme property classification per thread, parallel prefix scan over
the break DFA (monoid elements ~25 bytes each), stream compaction of
cluster boundaries, then layout + atlas UV lookup. Only justified at
scale (1000+ files, millions of characters in a single dispatch).

---

## 10. Concrete Changes to the Codebase

### Files to Modify

| File | Change |
|------|--------|
| `src/GlyphAtlas.js` | `uvMap`: `Map<number>` to `Map<string>`. `ensureCodepoints()` becomes `ensureGraphemes()`. `fillText` per grapheme string. `getUV()` accepts string. |
| `src/workers/builders/index.js` | Replace `charCodeAt(i)` loop with grapheme iteration. `countRenderableChars()` counts clusters. Width lookup by grapheme string. |
| `src/workers/builders/textToGlyphs.js` | Iterate grapheme clusters. UV lookup by string key. |
| `src/core/InstanceBuffer.js` | Same: iterate graphemes, string-keyed UV lookup. |
| `src/GlyphRenderer.js` | `_ensureAtlasHasChars()` scans grapheme strings. `_processTextItem()` iterates graphemes. |
| `src/collections/CodeGrid.js` | `_countGlyphsInLine()` counts grapheme clusters. |
| `src/workers/WorkerBridge.js` | Serialized UV map keys: numbers to strings. |

### What Does NOT Change

- **Instance attributes**: same format (position vec3, size vec2, UV vec4,
  color vec3). One quad per grapheme cluster instead of per code unit.
- **GPU shaders**: untouched. The change is entirely in CPU-side text
  processing and atlas building.
- **Quad count**: decreases for emoji text, unchanged for ASCII (99% of use).
- **Performance**: segmentation < 5 ms for 500 KB via `Intl.Segmenter`,
  < 1 ms via unicode-segmenter. Negligible vs 200 ms atlas generation.
  `Intl.Segmenter` works in Web Workers.

---

## 11. Summary: Effort vs Impact

| Change | Effort | Impact | Phase |
|--------|--------|--------|-------|
| Replace `charCodeAt` with grapheme iteration | Low | Fixes all surrogate pair issues | 1 |
| String-keyed atlas (`Map<string, UV>`) | Low | Fixes emoji rendering | 2 |
| Per-grapheme `measureText` for widths | Low | Correct glyph sizing | 2 |
| `getTextClusters()` for shaped runs | Medium | Fixes Arabic/Devanagari | 3 |
| WebGPU compute pipeline | High | Massive scale only | 4 |

Phase 1+2 solve the immediate problem (emoji, ZWJ, flags) with ~200 lines
of code changes across 6 files. No new dependencies if using `Intl.Segmenter`,
or a 3 KB dependency for unicode-segmenter. No architectural changes to the
instanced rendering pipeline. No GPU shader modifications.

---

## Sources

- [UAX #29: Unicode Text Segmentation](http://www.unicode.org/reports/tr29/)
- [unicode-segmenter (npm)](https://github.com/cometkim/unicode-segmenter)
- [ugrapheme (C/Cython)](https://github.com/Z4JC/ugrapheme)
- [GPU string unescaping via monoid prefix scan (Raph Levien)](https://raphlinus.github.io/personal/2018/04/25/gpu-unescaping.html)
- [Portable prefix sum on GPU compute (Raph Levien)](https://raphlinus.github.io/gpu/2021/11/17/prefix-sum-portable.html)
- [GPUPrefixSums - WGPU implementations (b0nes164)](https://github.com/b0nes164/GPUPrefixSums)
- [Ghostty grapheme clusters in terminals (Mitchell Hashimoto)](https://mitchellh.com/writing/grapheme-clusters-in-terminals)
- [Ghostty font system architecture](https://deepwiki.com/ghostty-org/ghostty/4.2-font-rendering)
- [Kitty font rendering system](https://deepwiki.com/kovidgoyal/kitty/3.1-font-rendering-system)
- [Zed GPUI text rendering](https://zed.dev/blog/videogame)
- [Zed text coordinate systems](https://zed.dev/blog/zed-decoded-text-coordinate-systems)
- [Warp text rendering: kerning and glyph atlases](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases)
- [GPUI-wgpu text rendering pipeline](https://deepwiki.com/mdeand/gpui-wgpu/2.5-text-rendering)
- [Slug font rendering library (now public domain)](https://sluglibrary.com/)
- [GPU-driven text rendering](https://jorenjoestar.github.io/post/gpu_driven_text/gpu_driven_text/)
- [WebGPU text rendering from font file (tchayen)](https://tchayen.com/drawing-text-in-webgpu-using-just-the-font-file)
- [Canvas getTextClusters() API explainer (Igalia)](https://github.com/Igalia/explainers/blob/main/canvas-formatted-text/text-metrics-additions.md)
- [DFAGE: GPU-based DFA engine](https://github.com/vqd8a/DFAGE)
- [WebGPU browser support status](https://caniuse.com/webgpu)
- [WebGPU prefix sum tutorial](https://shi-yan.github.io/webgpuunleashed/Compute/prefix_sum.html)
- [Intl.Segmenter MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter/Segmenter)
- [JavaScript string length and Unicode (hsivonen)](https://hsivonen.fi/string-length/)
- [glyph3d-js Metal GPU layout analysis](../metal-gpu-layout-analysis.md)
