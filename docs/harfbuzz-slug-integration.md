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

- **Package**: `harfbuzzjs` on npm (v0.8.0, Feb 2026)
- **Size**: ~180KB gzipped WASM
- **API**:
  ```javascript
  const blob = hb.createBlob(fontArrayBuffer);
  const face = hb.createFace(blob, 0);
  const font = hb.createFont(face);
  const buffer = hb.createBuffer();
  buffer.addText("Hello");
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  const glyphs = buffer.json();
  // [{g: glyphId, ax: advanceX, ay: advanceY, dx: offsetX, dy: offsetY}, ...]
  ```
- **Outline extraction**: `font.glyphToPath(glyphId)` returns SVG path data
- **What it provides over Canvas 2D measureText()**:
  - Per-glyph positioning (not just aggregate string width)
  - Kerning from OpenType GPOS tables
  - Ligature formation from GSUB tables
  - Complex script shaping (Arabic joining, Devanagari reordering, Thai)
  - Bidirectional text support
  - OpenType feature control (small caps, oldstyle figures, etc.)

- **HarfBuzz 14.0** (April 2026): New `libharfbuzz-gpu` library implements Slug internally, ships GLSL/WGSL/MSL/HLSL shaders. The live demo at harfbuzz.github.io/hb-gpu-demo/ runs on WebGL 2.

### Slug Algorithm (GPU Bezier Rendering)

- **Patent**: Placed in public domain March 17, 2026 by Eric Lengyel
- **Reference shaders**: github.com/EricLengyel/Slug (MIT license, HLSL)
- **How it works**:
  1. Glyph outlines (quadratic bezier curves) extracted from font
  2. Curves organized into horizontal/vertical "bands" for efficient lookup
  3. Packed into two GPU textures: `curveTexture` (control points) and `bandTexture` (curve indices)
  4. Fragment shader casts rays against curves, computes winding number
  5. Winding number determines inside/outside → antialiased coverage

- **Why Slug > MSDF**:
  | Aspect | MSDF/SDF | Slug |
  |--------|----------|------|
  | Magnification quality | Degrades, corner rounding | Mathematically exact at any scale |
  | Offline tooling | Requires atlas generation | None — loads TTF/OTF directly |
  | Memory | Texture atlas per font | Curve data only (~50% smaller) |
  | Perspective/3D | Artifacts under extreme angles | Perfect from any perspective |
  | Complex glyphs | Edge cases with many curves | Handles arbitrary complexity |

- **Existing implementations**:
  - **JSlug** (github.com/manthrax/JSlug) — Three.js, WebGL 2, ShaderMaterial. Already renders JS files.
  - **slug-webgpu** (github.com/diffusionstudio/slug-webgpu) — WebGPU/WGSL port
  - **GLyphy** (github.com/behdad/glyphy) — C++/GLSL, deprecated in favor of HarfBuzz GPU module
  - **@slug-text/three** — Discussed on Three.js #33215, approved by maintainers (March 2026)

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

### Discussions
- [Robust text rendering in Three.js (harfbuzzjs #30)](https://github.com/harfbuzz/harfbuzzjs/discussions/30)
- [Three.js Slug integration (#33215)](https://github.com/mrdoob/three.js/issues/33215)
- [GPU text rendering with vector textures — Will Dobbie](https://wdobbie.com/post/gpu-text-rendering-with-vector-textures/)
