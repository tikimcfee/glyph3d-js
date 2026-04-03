# HarfBuzz + Slug Integration Plan for glyph3d-js

## Research Date: April 3, 2026

## Executive Summary

Two recently-available technologies can transform glyph3d-js's text rendering:

1. **HarfBuzz** — the industry-standard text shaping engine, available as WASM (`harfbuzzjs` on npm)
2. **Slug Algorithm** — GPU bezier curve rasterization, placed in public domain March 17, 2026

Together they replace the current Canvas 2D bitmap atlas pipeline with vector-based, resolution-independent text rendering that supports proper kerning, ligatures, and complex scripts — while maintaining the single-draw-call instanced architecture.

---

## Current Pipeline (What Gets Replaced)

```
Text String
    │
    ▼
┌──────────────────┐
│  GlyphAtlas.js   │  Canvas 2D rasterizes glyphs at 48px → 2048×2048 bitmap
│  (shelf-packing)  │  Stores UV map + metrics per grapheme cluster
└────────┬─────────┘
         │
    ▼
┌──────────────────┐
│  layoutText.js   │  Fixed monospace grid: every char same width
│  textToGlyphs.js │  1:1 grapheme → glyph mapping, no kerning/ligatures
└────────┬─────────┘
         │
    ▼
┌──────────────────┐
│  buildBuffers.js │  Packs Float32Arrays: position, size, codepoint, color
└────────┬─────────┘
         │
    ▼
┌──────────────────┐
│  GlyphRenderer   │  Vertex: lookup codepoint → atlas UV in DataTexture
│  (instanced)     │  Fragment: sample bitmap texture, alpha-test discard
└──────────────────┘
```

### Current Limitations
- **No kerning** — every glyph has identical spacing regardless of neighbors
- **No ligatures** — "fi" renders as two separate glyphs
- **Fixed cell dimensions** — monospace layout only
- **Bitmap quality tradeoff** — 48px rasterization pixelates at high zoom
- **Canvas 2D dependency** — requires browser Canvas API
- **200ms atlas generation** — blocking startup cost

### Detailed Per-File Analysis

#### GlyphAtlas.js (~550 lines) — Font Texture Atlas

**Current approach:** Canvas 2D bitmap atlas with shelf-packing.
- Renders glyphs at 48px font size into a 2048×2048 texture using `ctx.fillText(grapheme, x, y)`
- **Grapheme-cluster aware**: stores by grapheme string (e.g., "A", "😀", "👨‍👩‍👧"), not codepoints
- Shelf packing: places glyphs in horizontal rows with vertical padding to prevent bilinear filtering bleed

**Key data structures:**
- `uvMap: Map<string, {u0, v0, u1, v1}>` — grapheme → normalized UV coordinates in atlas texture
- `_graphemeIds: Map<string, number>` — grapheme → numeric DataTexture ID (single-codepoint = codepoint, multi-codepoint = synthetic dense ID starting at 0x3000)
- `metrics: Map<string, {width, height, advance}>` — pixel-level glyph metrics
- `atlasMapTexture`: 1024-wide RGBA Float DataTexture mapping numeric ID → (u0, v0_webgl, u1, v1_webgl)

**What HarfBuzz/Slug replaces:**
- Remove Canvas 2D rendering entirely
- HarfBuzz provides per-glyph IDs that ARE the shaped indices (not grapheme strings)
- Slug stores glyph outlines as bezier curve segments instead of rasterized pixels
- No pre-generated texture needed; outlines loaded from font file at runtime

#### GlyphRenderer.js (~700+ lines) — Core GPU Instanced Renderer

**Current approach:** THREE.js InstancedBufferGeometry with 5 instance attributes per glyph.

**Instance attributes (10 floats = 40 bytes/glyph):**
- `instancePosition`: vec3 [x, y, z] — world position (left edge of glyph)
- `instanceSize`: vec2 [width, height] — bounding box dimensions
- `instanceCodepoint`: float — numeric DataTexture ID (glyph identifier)
- `instanceColor`: vec3 [r, g, b] — per-glyph color
- `instanceGroupId`: float — group transform index

**Vertex shader pipeline (GPU-lookup path):**
```glsl
1. Load instanceCodepoint → lookup row in atlasMapTexture
2. Fetch (u0, v0_webgl, u1, v1_webgl) from DataTexture
3. Interpolate UV across unit quad using uv attribute
4. Output vUV to fragment shader
5. Apply group transform (position, scale) + instance position
```

**Fragment shader:**
```glsl
1. Sample atlasTexture at vUV (bitmap pixel)
2. Apply instance color + group color multiplier
3. Alpha-test discard if alpha < 0.01
4. Output final RGBA
```

**Other key structures:**
- `_groupTexture`: 4×maxGroups RGBA Float DataTexture (4 columns per group: position offset, quaternion, color, scale)
- `_highlightTexture`: 1024×height RGBA8 DataTexture for per-glyph highlighting (additive color overlay)
- PlaneGeometry (unit quad, -0.5 to 0.5) as geometry template

**What changes for Slug:**
- Keep instancing architecture but change data flow
- `instanceCodepoint` → `instanceGlyphId` (numeric ID from HarfBuzz shaped output)
- `instanceSize.x` → actual advance width from HarfBuzz (variable, not fixed)
- Replace bitmap texture uniform with `curveTexture` + `bandTexture` (bezier curve storage)
- Add `glyphMapTexture`: per-glyph pointer into curve buffer (start offset, count)
- New fragment shader path: loop over bezier curves, render filled region via winding number

#### textToGlyphs.js (~65 lines) — Text → Glyph Conversion

**Current approach:** Direct grapheme-to-glyph 1:1 mapping.
- Iterates via `iterGraphemes(text)` — one grapheme per iteration
- Skips newlines (not in positions array), skips spaces (in positions but don't render)
- Looks up grapheme in `uvMap` — fallback to '?' if missing
- Creates glyph object: `{position, size, uv, color, charCode: numericId}`

**Limitations:** No shaping, positions pre-computed by separate layoutText(), no kerning adjustment, fixed charWidth/charHeight.

**What HarfBuzz replaces:** This function is **eliminated entirely**. HarfBuzz does all of this:
- Input: text string + HarfBuzz shaper instance
- Output: array of `{glyph_id, cluster, x_advance, y_advance, x_offset, y_offset}`
- New function `harfbuzzToGlyphs()` maps shaped output → instanced glyph objects

#### layoutText.js (~122 lines) — Text Positioning

**Current approach:** Fixed-width character grid.
- Single-pass iteration through text, tracking cursor position (x, y, z)
- Handles newlines: reset x, advance y, reset z
- Z-wrap: when line exceeds maxLineWidth, go back in Z-depth + drop Y
- Assumes all characters same width (monospace)

**What HarfBuzz replaces:** Becomes much simpler — HarfBuzz provides advance widths per glyph. New flow:
1. Run HarfBuzz shaper → shaped glyphs with advance widths
2. Simple accumulation: `x += glyph.x_advance` (variable, not constant)
3. Handle `\n` by resetting x, advancing y
4. Z-wrap logic remains as optional layout stage

#### buildBuffers.js (~78 lines) — GPU Buffer Construction

**Current approach:** Converts glyph objects to typed arrays.
- `positions`: Float32Array(count × 3) — [x, y, z] per glyph
- `sizes`: Float32Array(count × 2) — [width, height] per glyph (fixed)
- `codepoints`: Float32Array(count) — numeric ID for atlasMapTexture lookup
- `colors`: Float32Array(count × 3) — [r, g, b]
- V-flip applied: `v = 1.0 - v` to convert Canvas (top-left) → WebGL (bottom-left)

**What changes for Slug:**
- `codepoints` → `glyphIds` (same format, numeric ID from HarfBuzz)
- `sizes` → advance widths from HarfBuzz (variable per glyph, not fixed)
- Remove UV flip logic (vector outlines don't use canvas coords)
- Input now comes from HarfBuzz shaped output

#### Shaders — textVertex.glsl (~76 lines) + textFragment.glsl (~32 lines)

**Current vertex shader (GPU-lookup path):**
```glsl
// Scale quad by instanceSize
vec3 scaled = position * vec3(instanceSize, 1.0);
// Lookup codepoint → UV rect from atlasMapTexture
vec4 uvRect = texelFetch(atlasMapTexture, ivec2(col, row), 0);
// Interpolate UV across quad
vUV = mix(uvRect.xy, uvRect.zw, uv);
// Apply group transform + instance position
gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
```

**Current fragment shader:**
```glsl
vec4 texColor = texture(atlasTexture, vUV);  // Sample bitmap
vec3 finalColor = texColor.rgb * vColor * vGroupAlpha;
finalColor += vAddedColor;  // Highlight overlay
if (texColor.a < 0.01) discard;  // Alpha test
```

**New Slug vertex shader:**
```glsl
// Scale quad by HarfBuzz advance width
vec3 scaled = position * vec3(instanceAdvance, lineHeight, 1.0);
// Lookup glyphId → curve/band offsets from glyphMapTexture
vec4 glyphInfo = texelFetch(glyphMapTexture, ivec2(col, row), 0);
vCurveOffset = glyphInfo.xy;  // (start, count) into curveTexture
vBandInfo = glyphInfo.zw;     // (start, count) into bandTexture
// Group transform + instance position (same as before)
```

**New Slug fragment shader:**
```glsl
// Iterate bezier curves in this glyph's bands
float winding = 0.0;
for (int i = bandStart; i < bandStart + bandCount; i++) {
    // Fetch curve indices from bandTexture
    // For each curve: evaluate quadratic bezier intersection
    // Accumulate winding number
}
float coverage = clamp(winding, 0.0, 1.0);  // Antialiasing
vec3 finalColor = vColor * coverage;
if (coverage < 0.01) discard;
```

#### GlyphWorker.js (~103 lines) — Worker Thread Entry Point

Dispatches messages to builder functions. The worker system stays the same — just the builder functions it calls change from `textToGlyphs + layoutText + buildBuffers` to `harfbuzzShape + buildBuffers`.

**Note:** HarfBuzz WASM can run in Web Workers (no DOM dependency), so the worker pool architecture is preserved.

---

## New Pipeline (HarfBuzz + Slug)

```
Font File (.otf/.ttf)
    │
    ▼
┌──────────────────┐
│  HarfBuzz WASM   │  shape("Hello") → [{glyphId:43, ax:600, dx:0, dy:0}, ...]
│  (harfbuzzjs)    │  Automatic kerning, ligatures, complex scripts
└────────┬─────────┘
         │  glyph IDs + positions
         ▼
┌──────────────────┐
│  Outline Extract │  glyphToPath(id) → quadratic bezier curves
│  + Band Packing  │  Organize curves into H/V bands → curve/band textures
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  buildBuffers.js │  Packs Float32Arrays: position, advance, glyphId, curveOffset, color
│  (modified)      │  Variable-width advances from HarfBuzz
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  GlyphRenderer   │  Vertex: position quad using HarfBuzz advance width
│  (instanced)     │  Fragment: evaluate bezier curves via Slug winding number
│                  │  Reads from curveTexture + bandTexture per glyph
└──────────────────┘
```

---

## Technology Details

### HarfBuzz (Text Shaping)

HarfBuzz is the dominant open-source text shaping engine — used in Android, Chrome, Firefox, Photoshop, Figma, and Unreal Engine. It describes itself as "the ffmpeg of text shaping."

#### harfbuzzjs (npm)

- **Package**: `harfbuzzjs` on npm (v0.8.0, Feb 2026)
- **Repo**: github.com/harfbuzz/harfbuzzjs
- **Size**: ~180KB gzipped WASM (compiled with `-DHB_TINY` via Emscripten)
- **Browser compatibility**: All modern browsers with WASM support
- **Worker compatible**: No DOM dependency — can run in Web Workers

**API surface:**
```javascript
// Full workflow
const blob = hb.createBlob(fontArrayBuffer);
const face = hb.createFace(blob, 0);   // index for font collections
const font = hb.createFont(face);
const buffer = hb.createBuffer();
buffer.addText("Hello");
buffer.guessSegmentProperties();        // infers script, language, direction
hb.shape(font, buffer);
const glyphs = buffer.json();
// Returns: [{g: glyphId, ax: advanceX, ay: advanceY, dx: offsetX, dy: offsetY}, ...]
//   g  = glyph ID (index into font's glyph set)
//   ax = horizontal advance (font units, typically 1/64th of a point)
//   ay = vertical advance (usually 0 for horizontal text)
//   dx = horizontal offset (for diacritics, mark positioning)
//   dy = vertical offset (for diacritics, mark positioning)

// Outline extraction for Slug curve data:
const svgPath = font.glyphToPath(glyphId);
// Returns SVG path string: "M 100 200 Q 150 300 200 200 Z"

// CRITICAL: manual memory management required
buffer.destroy(); font.destroy(); face.destroy(); blob.destroy();
```

**Alternative wrapper**: `harfbuzz-modern-wrapper` on npm adds TypeScript types and integrates the Unicode Bidirectional Algorithm via `bidi-js`. Auto-handles WASM loading with zero configuration.

**Size concern**: The ~180KB WASM is nearly the size of Three.js (~142KB gzipped). The harfbuzzjs Discussion #30 on Three.js text rendering recommends opt-in HarfBuzz support — let users who need advanced shaping explicitly enable it. For glyph3d-js (a code visualization tool, not a lightweight widget), this overhead is acceptable.

#### What HarfBuzz provides over Canvas 2D measureText()

| Capability | Canvas 2D | HarfBuzz |
|-----------|-----------|----------|
| String width | `measureText(str).width` (aggregate) | Per-glyph advance widths |
| Kerning | Not exposed | Automatic from GPOS tables |
| Ligatures | Browser may render them visually, but no API | GSUB table application, returns ligature glyph IDs |
| Complex scripts | Browser handles rendering, but no glyph IDs | Full Arabic joining, Devanagari conjuncts, Thai marks |
| Bidirectional | Not exposed | Proper glyph reordering for mixed LTR/RTL |
| OpenType features | Not exposed | Small caps, oldstyle figures, stylistic alternates, fractions |
| Glyph IDs | Not available | Direct access — needed for Slug curve lookup |
| Per-glyph offsets | Not available | x/y offsets for diacritics, mark attachment |
| Font subsetting | Not available | `libharfbuzz-subset` strips to needed glyphs only |

#### libharfbuzz-gpu (NEW — HarfBuzz 14.0, April 2026)

HarfBuzz 14.0 introduced `libharfbuzz-gpu`, an experimental library that implements the Slug algorithm directly inside HarfBuzz:

- Encodes glyph outlines on the CPU into compact blobs
- The GPU decodes and rasterizes directly in the fragment shader
- **No intermediate bitmap atlas needed**
- Provides shader sources in **GLSL, WGSL, MSL, and HLSL**
- Ships with `hb-gpu` command-line tool for interactive GPU text rendering
- Live web demo at harfbuzz.github.io/hb-gpu-demo/ runs on both **WebGL 2** and **WebGPU**

The demo is a full Emscripten-compiled application (C++ → WASM) featuring:
- WebGL 2 / WebGPU backend toggle
- Font file drag-and-drop loading (passed to `_web_load_font` via Emscripten memory)
- Custom text editing modal
- Animation, dark mode, gamma correction, stem darkening
- Debug heatmap visualization (shows per-pixel curve evaluation cost)
- FPS counter with requestAnimationFrame loop
- Touch/pinch/3-finger gestures for mobile

This proves the full HarfBuzz shaping + Slug rendering pipeline works end-to-end in the browser on WebGL 2.

### Slug Algorithm (GPU Bezier Rendering)

The Slug algorithm, invented by Eric Lengyel (Terathon Software), renders text and vector graphics **directly on the GPU from Bezier curve data** — no texture atlas, no SDF, no MSDF, no pre-rasterized bitmaps. It has been the professional standard in AAA games and used by Activision, Blizzard, id Software, Ubisoft, Insomniac, Zenimax, Adobe, and more. Individual licenses were $1,500.

#### Patent Status (Critical News)

On **March 17, 2026**, Eric Lengyel **permanently and irrevocably dedicated U.S. Patent #10,373,352 to the public domain**. This patent would have run until 2038. He stated: "Anybody can freely implement the Slug algorithm from this day forward without a license for whatever purpose they want, and they don't need to worry about infringing upon any intellectual property rights."

Reference vertex and fragment shaders released under **MIT + Apache-2.0 dual license** at github.com/EricLengyel/Slug.

#### How Slug Works (Detailed)

**Step 1 — Outline Extraction (CPU):**
Parse font file (.ttf/.otf), extract quadratic Bezier curves for each glyph. TrueType fonts use quadratic curves natively; OpenType/CFF fonts use cubic curves that must be approximated as quadratics.

**Step 2 — Band Organization (CPU):**
Curves are partitioned into horizontal and vertical "bands" — a spatial partitioning scheme. Each band covers a horizontal or vertical strip of the glyph's bounding box. Curves are sorted by maximum x or y coordinate within each band. This enables efficient early-exit during fragment shader evaluation.

**Step 3 — GPU Texture Packing (CPU → GPU):**
Two textures are generated:
- **Curve texture**: 4 channels of float16 holding control point coordinates (x1, y1, x2, y2). The first two control points for one quadratic Bezier curve are packed into one texel, and the third control point is stored in the first two channels of the next texel.
- **Band texture**: 2 channels of uint16 organizing curves into bands, sorted by maximum x or y coordinates.

**Step 4 — Vertex Shader (GPU):**
Each glyph renders as a quad (or tight polygon for large sizes). **Dynamic dilation** automatically expands vertex bounds using the MVP matrix and viewport dimensions to ensure partially-covered edge pixels are rasterized correctly.

**Step 5 — Fragment Shader (GPU):**
For each pixel:
1. Determine which horizontal and vertical bands the pixel falls in
2. Iterate curves in those bands (early exit when maximum coordinate exceeded)
3. Cast rays against quadratic Bezier curves
4. Compute winding number via Lengyel's equivalence class algorithm (numerically robust)
5. Winding number → inside/outside coverage → antialiased alpha

#### Why Slug > SDF/MSDF

| Aspect | SDF/MSDF | Slug |
|--------|----------|------|
| **Data pipeline** | Vector → rasterized distance field → GPU sampling | Vector → curve data → GPU evaluation |
| **Magnification quality** | Degrades — resolution ceiling, corner rounding | Mathematically exact at any scale |
| **Offline tooling** | Required (msdfgen, msdf-atlas-gen) | None — font parsed at runtime |
| **Memory** | Texture atlas per font/size (can be large) | Curve + band textures (~50% smaller than TTF) |
| **3D perspective** | Artifacts at oblique angles | No artifacts — per-pixel curve evaluation |
| **Sharp corners** | MSDF helps but not perfect | Exact — computed from actual outlines |
| **GPU cost per glyph** | One texture sample | Multiple curve intersections per pixel |
| **Atlas management** | Required (packing, regrowth, font-size variants) | Not needed |
| **Complex glyphs** | Edge cases with many curves | Handles arbitrary complexity |

The key insight: SDF/MSDF is an **approximation** that samples a precomputed field. Slug **evaluates the actual math** per pixel, eliminating the entire "vector → raster → screen" middle step.

#### Existing Implementations (Detailed)

**1. JSlug** (github.com/manthrax/JSlug) — Three.js integration by "manthrax":
- Works as `ShaderMaterial` or injected into `StandardMaterial` (with lighting/shadows!)
- Uses a `.sluggish` binary format for curve data
- Demo at manthrax.github.io/JSlug/demo/ renders an entire JS file as 3D text
- One geometry per text string currently; multi-string planned
- **WebGL 2 compatible** — proven working in Three.js
- Most directly relevant to glyph3d-js integration

**2. slug-webgpu** (github.com/diffusionstudio/slug-webgpu) — WebGPU TypeScript implementation:
- Uses `text-shaper` library for shaping (alternative to HarfBuzz)
- Ports reference HLSL shaders to WGSL
- 56% TypeScript, 43% WGSL
- Requires WebGPU (Chrome/Edge only), Bun v1.2+
- Four-stage pipeline: text shaping → curve extraction → band organization → GPU rendering

**3. @slug-text/three** (proposed by Jiwon Park on Three.js #33215):
- Uses `opentype.js` for font parsing (alternative to HarfBuzz glyphToPath)
- Stores curves in Float32/Uint16 textures
- Web Workers for data packing
- Custom `ShaderMaterial` with GLSL ES 3.0
- Three.js maintainers approved the approach; issue closed as completed March 23, 2026

**4. GLyphy** (github.com/behdad/glyphy) — Behdad Esfahbod's C++/GLSL implementation:
- 58% C++, 16% C, 14% GLSL
- Encodes glyph outlines into compact blobs stored in GPU buffer textures
- Fragment shader computes winding number by casting H/V rays against quadratic Bezier curves
- Curves organized into bands for efficient early exit
- Produces pixel-perfect rendering at any scale with proper antialiasing
- **Deprecated** in favor of HarfBuzz's GPU module (same author)
- Requires OpenGL 3.3+ (no WebGL version)

**5. Sluggish** (github.com/mightycow/Sluggish) — Toy CPU and GPU reference implementations:
- Includes tooling for generating required texture data
- Unlicense (public domain)
- Good learning reference

**6. three-text-renderer** (github.com/horizon-games/three-text-renderer) — HarfBuzz + MSDF + Three.js:
- 93% TypeScript, 7% GLSL
- Uses HarfBuzz WASM for shaping, converts bezier curves into MSDF bitmaps
- Seven-stage pipeline: Unicode text → HarfBuzz shaping → glyph extraction → MSDF generation → texture atlas → geometry → rendering
- Good reference for the HarfBuzz integration pattern, even though it uses MSDF not Slug

#### The Commercial Slug Library (sluglibrary.com)

For reference, the original commercial product supported Vulkan, D3D 10-12, OpenGL 3.0-4.6, Metal, and **WebGL 2**. It included full text layout (kerning, ligatures, diacritics, OpenType features). This confirms WebGL 2 is a fully viable target for Slug rendering.

---

## Integration Paths

### Path A: HarfBuzz Shaping + Keep Bitmap Atlas (Quick Win)

**What changes:**
- Add `harfbuzzjs` as dependency
- New `src/shaping/HarfBuzzShaper.js` wraps WASM init + font loading + shape()
- Modified `layoutText.js`: accumulate HarfBuzz advances instead of fixed charWidth
- Modified `textToGlyphs.js`: use shaped glyph IDs instead of grapheme lookup

**What stays the same:**
- GlyphAtlas bitmap rendering
- GlyphRenderer instanced pipeline
- Shaders unchanged
- Worker system unchanged

**Gains:** Proper kerning, ligatures, variable-width glyphs, complex script support
**Cost:** ~180KB WASM added to bundle
**Effort:** Low-medium

### Path B: HarfBuzz Shaping + Slug GPU Rendering (The Goal)

**What changes:**
- Everything from Path A
- New `src/shaping/SlugEncoder.js`: extracts outlines → packs curve/band textures
- New vertex shader: positions quad using advance width, passes curve offset
- New fragment shader: Slug algorithm — evaluates bezier curves, computes winding number
- `GlyphAtlas.js` replaced by `GlyphOutlineCache.js` (curve data, not bitmaps)
- `GlyphRenderer.js` modified: new uniforms (curveTexture, bandTexture), new shader

**The novel challenge:** Combining Slug with instanced rendering. Existing Slug implementations use one geometry per text string. We need per-instance curve-data lookup from shared textures — each instanced quad reads its own glyph's curves via `gl_InstanceID → glyphId → curveOffset`.

**Gains:** Resolution-independent rendering, no atlas generation, perfect at any zoom, smaller memory footprint
**Cost:** Complex shader rewrite, higher per-pixel ALU cost
**Effort:** Medium-high

### Path C: libharfbuzz-gpu via Emscripten (Bleeding Edge)

**What changes:**
- Compile HarfBuzz 14.0 with GPU module to WASM
- Use its built-in GLSL shaders and curve encoding
- Shaping + rendering in one library

**Gains:** Single dependency, battle-tested Slug implementation, maintained by HarfBuzz team
**Cost:** Complex Emscripten ↔ Three.js integration, large WASM binary, experimental API
**Effort:** High

---

## Recommended Approach: A → B

### Phase 1: HarfBuzz Shaping (Path A)

```
src/shaping/
├── HarfBuzzShaper.js    # WASM init, font loading, shape() wrapper
├── ShapedText.js        # Data structure for shaped glyph runs
└── index.js             # Exports
```

1. Install `harfbuzzjs`
2. Create `HarfBuzzShaper` class that loads WASM + font file
3. `shape(text)` returns array of `{glyphId, advance, xOffset, yOffset}`
4. Modify `layoutText.js` to accept variable advances
5. Modify `textToGlyphs.js` to use shaped glyph IDs
6. Keep atlas rendering — just better positions

### Phase 2: Slug Rendering (Path B)

```
src/shaping/
├── HarfBuzzShaper.js
├── ShapedText.js
├── SlugEncoder.js       # Outline extraction + curve/band texture packing
├── CurveTexture.js      # DataTexture for bezier control points
├── BandTexture.js       # DataTexture for band→curve index mapping
└── index.js
```

1. Extract glyph outlines via `font.glyphToPath()` or `opentype.js`
2. Convert cubic beziers to quadratic (if needed)
3. Organize curves into H/V bands per glyph
4. Pack into Float16 curve texture + Uint16 band texture
5. Port Slug fragment shader to GLSL ES 3.0 (reference: EricLengyel/Slug HLSL, JSlug GLSL)
6. New instance attribute: `instanceCurveOffset` (replaces `instanceCodepoint`)
7. Fragment shader: read curves from texture, evaluate winding number, antialias

### Phase 3: Instanced Slug (Novel Integration)

The key architectural insight: glyph3d-js already uses `instanceCodepoint` to index into a DataTexture for UV lookup. The same pattern works for Slug — replace the atlas-map DataTexture with a glyph-offset DataTexture that maps `glyphId → (curveStart, curveCount, bandStart, bandCount)`.

```glsl
// Current vertex shader (atlas path):
float codepointId = instanceCodepoint;
vec4 uvRect = texelFetch(atlasMapTexture, ivec2(col, row), 0);

// New vertex shader (Slug path):
float glyphId = instanceGlyphId;
vec4 glyphInfo = texelFetch(glyphMapTexture, ivec2(col, row), 0);
// glyphInfo.xy = curveOffset, curveCount
// glyphInfo.zw = bandOffset, bandCount
// Pass to fragment shader for curve evaluation
```

---

## Data Format Changes

### Instance Attributes (Current: 10 floats = 40 bytes/glyph)
```
instancePosition:  vec3  [x, y, z]
instanceSize:      vec2  [width, height]
instanceCodepoint: float [atlas DataTexture ID]
instanceColor:     vec3  [r, g, b]
instanceGroupId:   float [group transform index]
```

### Instance Attributes (Slug: 10 floats = 40 bytes/glyph — same budget!)
```
instancePosition:  vec3  [x, y, z]
instanceSize:      vec2  [advance, lineHeight]  ← variable width from HarfBuzz
instanceGlyphId:   float [glyph map DataTexture ID]  ← indexes into curve data
instanceColor:     vec3  [r, g, b]
instanceGroupId:   float [group transform index]
```

The attribute layout is identical in size — `instanceCodepoint` becomes `instanceGlyphId`, `instanceSize.x` becomes the actual advance width instead of a fixed cell width. The fragment shader changes completely, but the instancing infrastructure stays the same.

---

## GPU Texture Budget (Slug vs Atlas)

### Current Atlas Approach
- `atlasTexture`: 2048×2048 RGBA8 = 16MB (bitmap)
- `atlasMapTexture`: 1024×1 RGBA Float = ~16KB (UV lookup)
- Total: ~16MB

### Slug Approach (estimated for code font, ~200 glyphs)
- `curveTexture`: ~200 glyphs × ~20 curves avg × 8 bytes = ~32KB
- `bandTexture`: ~200 glyphs × ~16 bands avg × 4 bytes = ~13KB
- `glyphMapTexture`: ~200 glyphs × 16 bytes = ~3.2KB
- Total: ~50KB

That's a **300x reduction** in texture memory. The tradeoff is more ALU work per pixel in the fragment shader.

---

## Performance Considerations

### Slug ALU Cost vs Atlas Texture Cost

The fundamental tradeoff: bitmap atlas does one texture sample per pixel (cheap ALU, bandwidth-bound), while Slug evaluates multiple bezier curves per pixel (expensive ALU, compute-bound).

For **code visualization** (small glyphs, thousands visible):
- Most glyphs are small on screen (8-16 pixels tall) → fewer pixels per glyph = fewer curve evaluations
- Band organization provides early exit → most pixels only evaluate 2-4 curves
- The debug heatmap in the HarfBuzz GPU demo visualizes per-pixel cost — useful for profiling
- At small sizes, Slug may actually be faster than atlas because there's no texture cache pressure from a 16MB atlas

For **zoomed-in text** (large glyphs, few visible):
- More pixels per glyph = more curve evaluations per glyph
- But fewer total glyphs visible = fewer instances
- This is where Slug shines — no pixelation at any zoom level

### Key Performance Question

Can Slug handle 10,000 instanced glyphs at 60fps on mid-range GPUs?

**Evidence that it can:**
- The HarfBuzz GPU demo renders full paragraphs of text at 60fps in WebGL 2
- JSlug renders entire JS files as 3D text in Three.js
- The commercial Slug library was used in shipped AAA games (Activision, Blizzard, id Software)
- Band-based early exit is specifically designed for high glyph counts

**Mitigation strategies if needed:**
- LOD: use Slug for nearby/zoomed text, fall back to atlas for distant tiny text
- Hybrid: render visible glyphs with Slug, use atlas for glyphs below a pixel-size threshold
- The `GridVirtualizer` already culls ~97% of grids — only 10-50 visible grids get draw calls

### WebGL 2 Compatibility Checklist

All Slug requirements are available in WebGL 2 / GLSL ES 3.00:

| Feature | WebGL 2 Status | glyph3d-js Status |
|---------|---------------|-------------------|
| `texelFetch` | Native | Already used (atlasMapTexture) |
| Float16 textures | `EXT_color_buffer_half_float` or native `HALF_FLOAT` | Needs verification |
| Integer textures | Native | Not currently used, but supported |
| `gl_InstanceID` | Native | Already used (picking, highlight) |
| GLSL ES 3.00 | Native | Already used (`THREE.GLSL3`) |
| DataTexture | THREE.js abstraction | Already used extensively |

No SSBOs in WebGL 2 (that's WebGPU), so all curve data must go in textures — same pattern as current atlas map DataTexture, just different data.

---

## Available npm Packages

| Package | Purpose | Size | Status |
|---------|---------|------|--------|
| `harfbuzzjs` | Text shaping via WASM | ~180KB gzipped | Stable, official HarfBuzz project |
| `harfbuzz-modern-wrapper` | TypeScript wrapper + BiDi via bidi-js | wraps harfbuzzjs | Community maintained |
| `opentype.js` | Font parsing, glyph outline extraction | ~80KB | Stable, widely used |
| `three` | 3D rendering (peer dep) | ~142KB gzipped | Already used |
| No Slug npm package | JSlug is GitHub-only, not published | — | Would need to vendor or publish |
| `@slug-text/three` | Three.js Slug integration | — | Proposed, may exist by now |

---

## Open Questions

1. **HarfBuzz in workers**: Can `harfbuzzjs` WASM be initialized in a Web Worker? (Likely yes — no DOM dependency, but WASM instantiation in workers needs testing)
2. **Cubic → quadratic conversion**: OpenType/CFF fonts use cubic beziers. HarfBuzz's `glyphToPath()` returns SVG paths which may include cubic curves. Need to either:
   - Use only TrueType fonts (quadratic natively) — acceptable for code fonts
   - Add cubic-to-quadratic approximation (well-studied problem, libraries exist)
   - Check if `opentype.js` handles this automatically
3. **Float16 support**: Need to verify `HALF_FLOAT` texture support across target browsers for curve data
4. **Instanced Slug**: No existing implementation combines Slug with GPU instancing. The per-instance `glyphId → curveOffset` lookup is architecturally sound but untested at scale.
5. **Stem darkening**: At small sizes, thin strokes can disappear. The HarfBuzz GPU demo includes stem darkening as a toggle — worth investigating for code text.
6. **Gamma correction**: The demo also supports gamma correction toggle (2.2/none) — affects text contrast.

---

## References

### Official Sources
- [HarfBuzz GitHub](https://github.com/harfbuzz/harfbuzz)
- [harfbuzzjs on npm](https://www.npmjs.com/package/harfbuzzjs)
- [harfbuzzjs GitHub](https://github.com/harfbuzz/harfbuzzjs)
- [HarfBuzz GPU Demo (WebGL/WebGPU)](https://harfbuzz.github.io/hb-gpu-demo/)

### Slug Algorithm
- [Slug reference shaders (public domain, MIT)](https://github.com/EricLengyel/Slug)
- [Slug patent public domain announcement](https://hackaday.com/2026/03/20/slug-algorithm-for-on-gpu-rendering-of-fonts-with-bezier-curves-now-in-public-domain/)
- [Slug Library (commercial)](https://sluglibrary.com/)
- [A Decade of Slug — Eric Lengyel](https://terathon.com/blog/decade-slug.html)
- [GPU-Centered Font Rendering (I3D 2018 paper)](https://terathon.com/i3d2018_lengyel.pdf)
- [GPU Font Rendering: State of the Art](https://www.terathon.com/font_rendering_sota_lengyel.pdf)

### Existing Implementations
- [JSlug — Three.js Slug (WebGL 2)](https://github.com/manthrax/JSlug)
- [slug-webgpu — WebGPU/WGSL port](https://github.com/diffusionstudio/slug-webgpu)
- [GLyphy — C++/GLSL Slug (deprecated → HarfBuzz GPU)](https://github.com/behdad/glyphy)
- [three-text-renderer — HarfBuzz + MSDF + Three.js](https://github.com/horizon-games/three-text-renderer)
- [Sluggish — reference CPU/GPU implementations](https://github.com/mightycow/Sluggish)

### Discussions & Articles
- [Robust text rendering in Three.js (harfbuzzjs #30)](https://github.com/harfbuzz/harfbuzzjs/discussions/30)
- [Three.js Slug integration (#33215)](https://github.com/mrdoob/three.js/issues/33215)
- [THREE.SlugText GPU text renderer (Three.js forum)](https://discourse.threejs.org/t/three-slugtext-gpu-text-renderer/90599)
- [GPU text rendering with vector textures — Will Dobbie](https://wdobbie.com/post/gpu-text-rendering-with-vector-textures/)
- [SLUG'S OUT — Adafruit blog](https://blog.adafruit.com/2026/03/22/slugs-out-the-algorithm-that-made-text-look-perfect-is-now-free-or-how-to-give-away-a-patent/)
- [Unicode text rendering with FreeType and HarfBuzz — tchayen](https://tchayen.com/unicode-text-rendering-in-zig-with-freetype-and-harfbuzz)
