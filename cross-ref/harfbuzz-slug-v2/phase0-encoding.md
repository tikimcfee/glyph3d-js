# Phase 2 Analysis: SlugEncoder — Curve/Band/GlyphMap Textures

## Correction from Round 1

The previous cross-ref concluded `font.glyphToPath()` does not exist in harfbuzzjs. This is wrong. Verified at `node_modules/harfbuzzjs/hbjs.js` lines 453-487 and 630-636: both `glyphToPath(glyphId)` and `glyphToJson(glyphId)` exist, backed by `hb_font_draw_glyph()`. No second font library (opentype.js) is needed. One library, one WASM, one font parse.

---

## 1. glyphToJson() Output Format

```js
font.glyphToJson(glyphId)
// Returns: [{type, values}, ...]
// type: 'M' | 'L' | 'Q' | 'C' | 'Z'
// values: number[] (coordinates in font units)
```

### Curve type handling

| Type | Values | Action |
|------|--------|--------|
| M | [x, y] | Set contour start, update current point |
| L | [x, y] | Convert to degenerate quadratic: Q(mid, mid, end) |
| Q | [cx, cy, x, y] | Native quadratic bezier -- use directly |
| C | [c1x, c1y, c2x, c2y, x, y] | Cubic -- approximate as quadratics |
| Z | [] | Close contour (implicit line to contour start if needed) |

**Cubics**: TrueType fonts (Cousine, most code fonts) emit only M/L/Q/Z. CFF fonts emit C. Throw on C at launch; future: midpoint subdivision (fonttools `cu2quPen`).

**Lines**: L(x,y) becomes degenerate quadratic Q(P, midpoint, end). Fragment shader treats all curves uniformly.

**Close path**: If current point differs from contour start, emit implicit closing line as degenerate quadratic.

---

## 2. Coordinate Normalization

HarfBuzz returns coordinates in font design units (typically upem = 1000 or 2048). SlugEncoder normalizes all coordinates to [0, 1] within the glyph's bounding box before packing.

```js
// Per-glyph normalization
const bbox = computeBBox(curves); // {xMin, yMin, xMax, yMax}
const w = bbox.xMax - bbox.xMin || 1;
const h = bbox.yMax - bbox.yMin || 1;
// For each control point:
nx = (x - bbox.xMin) / w;
ny = (y - bbox.yMin) / h;
```

The bbox is stored in the glyphMapTexture so the fragment shader can map from local quad UV space to normalized glyph space. Normalization to [0,1] keeps Float16 precision uniform across the glyph -- no wasted mantissa bits on large integer coordinates.

---

## 3. Band Organization Algorithm

Bands are horizontal or vertical strips across the glyph's [0, 1] normalized bounding box. Each curve is assigned to every band it overlaps. Curves within a band are sorted by their maximum coordinate in the band's axis direction, enabling early-exit in the fragment shader.

### Algorithm

```js
function organizeBands(curves, bandCount) {
  const hBands = Array.from({ length: bandCount }, () => []);
  const vBands = Array.from({ length: bandCount }, () => []);
  const bandSize = 1.0 / bandCount;

  for (let ci = 0; ci < curves.length; ci++) {
    const c = curves[ci];
    const { yMin, yMax, xMin, xMax } = curveBBox(c);

    // Assign to horizontal bands (Y-axis strips)
    const hStart = Math.max(0, Math.floor(yMin / bandSize));
    const hEnd = Math.min(bandCount - 1, Math.floor(yMax / bandSize));
    for (let b = hStart; b <= hEnd; b++) {
      hBands[b].push({ curveIndex: ci, sortKey: xMax });
    }

    // Assign to vertical bands (X-axis strips)
    const vStart = Math.max(0, Math.floor(xMin / bandSize));
    const vEnd = Math.min(bandCount - 1, Math.floor(xMax / bandSize));
    for (let b = vStart; b <= vEnd; b++) {
      vBands[b].push({ curveIndex: ci, sortKey: yMax });
    }
  }

  // Sort each band by sortKey (max coordinate) for early-exit
  for (const band of [...hBands, ...vBands]) {
    band.sort((a, b) => a.sortKey - b.sortKey);
  }

  return { hBands, vBands };
}
```

### Band count selection

For a code font with ~15-25 curves per glyph, 8 bands per axis is a good default. More bands = fewer curves per band (faster shader) but more band metadata. The Slug reference uses a heuristic: `bandCount = ceil(sqrt(curveCount))`, clamped to [2, 16]. For Cousine at ~20 curves/glyph, that gives ~5 bands.

Compile-time cap in shader: `MAX_BANDS = 16`. Runtime band count stored per-glyph in glyphMapTexture.

---

## 4. Curve Texture Format

`RGBA16F` (Float16, 4 channels per texel). Width: 256 (power of 2, fits most fonts). Height: grows as needed.

### Packing scheme

Each quadratic bezier has 3 control points (P0, P1, P2), each with (x, y) = 6 floats. Packed into texels:

```
Texel N:   [P0.x, P0.y, P1.x, P1.y]   -- RGBA
Texel N+1: [P2.x, P2.y,  _  ,  _  ]   -- RG used, BA unused
```

Each curve costs 2 texels = 16 bytes. For 200 glyphs x 20 curves average = 4000 curves = 8000 texels.

At width 256: height = ceil(8000 / 256) = 32 rows. Total: 256 x 32 x 8 bytes = 65 KB.

### Shared-endpoint optimization

Adjacent curves in a contour share endpoints (P2 of curve N = P0 of curve N+1). We do NOT exploit this for packing. Reason: band organization reorders curves, breaking adjacency. The 2-texel-per-curve layout is simple, cache-friendly, and random-access safe. The memory cost (doubling P0 storage) is ~16 KB for a full code font -- negligible.

Three.js: `new THREE.DataTexture(uint16Data, w, h, THREE.RGBAFormat, THREE.HalfFloatType)`, NearestFilter, no mipmaps. Write Float16 values via `DataView.setFloat16()` (Baseline 2025) into a Uint16Array backing buffer.

---

## 5. Band Texture Format

`RGBA16UI` (Uint16, integer format). Two regions packed into one texture:

**Band table region**: per-band headers as (entryStart, entryCount) Uint16 pairs.
**Entry region**: flat array of Uint16 curve indices into curveTexture (index = texel offset / 2).

Width 256, height grows as needed. For 200 glyphs x 20 curves x ~3 band overlaps = ~12,000 entries. RGBA16UI packs 4 entries/texel = 3000 texels, height = 12 rows. Total: ~24 KB.

```js
const texture = new THREE.DataTexture(
  new Uint16Array(width * height * 4), width, height,
  THREE.RGBAIntegerFormat, THREE.UnsignedShortType
);
texture.internalFormat = 'RGBA16UI';
texture.minFilter = THREE.NearestFilter;
texture.magFilter = THREE.NearestFilter;
texture.needsUpdate = true;
```

Shader: `usampler2D` + `texelFetch`.

---

## 6. GlyphMapTexture Design

Per-glyph metadata. `RGBA32F`, width 256. 4 texels per glyph (columns `glyphId*4` .. `glyphId*4+3`):

```
Texel 0: [curveStart, curveCount, hBandCount, vBandCount]
Texel 1: [bboxXMin, bboxYMin, bboxW, bboxH]    -- font units, for UV mapping
Texel 2: [hBandTableStart, vBandTableStart, 0, 0]
Texel 3: reserved (advance width, future use)
```

### 2-level lookup chain (chosen over 1-level and 3-level alternatives)

1. Vertex shader: `texelFetch(glyphMapTexture, glyphId*4)` -- pass as `flat out int` varyings
2. Fragment shader, per pixel in hBand `b`: `texelFetch(bandTexture, hBandTableStart + b)` -- get (entryStart, entryCount)
3. Loop entries: `texelFetch(bandTexture, entryStart + j)` -- get curveIndex
4. Fetch curve: `texelFetch(curveTexture, curveStart + curveIndex*2)` -- get control points

1-level (all band data in glyphMap) requires too many texels per glyph. 3-level (separate bandHeaderTexture) adds latency for minimal memory savings. 2-level is the right tradeoff.

---

## 7. SlugEncoder Class API

```js
// src/shaping/SlugEncoder.js

export default class SlugEncoder {
  /**
   * @param {object} hbFont - harfbuzzjs font object (has glyphToJson, glyphName)
   * @param {object} hbFace - harfbuzzjs face object (has getGlyphCount, etc.)
   * @param {object} options
   * @param {number} options.bandCount - bands per axis per glyph (default: 8)
   * @param {number} options.textureWidth - DataTexture width (default: 256)
   */
  constructor(hbFont, hbFace, options = {}) { ... }

  /**
   * Encode all glyphs in the font's charset.
   * Call once at font-load time on the main thread.
   *
   * @param {number[]} glyphIds - glyph IDs to encode (from shaping pass or full charset)
   * @returns {{
   *   curveTexture: THREE.DataTexture,    // RGBA16F, quadratic bezier control points
   *   bandTexture: THREE.DataTexture,     // RGBA16UI, band table + curve index entries
   *   glyphMapTexture: THREE.DataTexture, // RGBA32F, per-glyph metadata
   *   stats: { glyphCount, totalCurves, totalBandEntries, memoryBytes }
   * }}
   */
  encode(glyphIds) { ... }

  /**
   * Encode a single glyph. Returns raw data (no Three.js dependency).
   * @param {number} glyphId
   * @returns {{ curves: QuadBezier[], hBands: Band[], vBands: Band[], bbox: BBox }}
   */
  encodeGlyph(glyphId) { ... }
}
```

### When it runs

Main thread, once per font load, before any rendering. Produces three DataTextures that are set as uniforms on GlyphRenderer's material. Workers never touch SlugEncoder -- they only do HarfBuzz shaping + instance buffer packing.

### Estimated cost

For Cousine (~400 glyphs): ~200 `glyphToJson()` calls (skip .notdef, space, etc.) x ~20 curves each = ~4000 curves. JSON parsing + band organization + texture packing: < 30ms on modern hardware. Not blocking -- but runs synchronously since it is a one-time startup cost that must complete before the first frame.

---

## 8. Encoding Pipeline (Code Sketch)

```js
encode(glyphIds) {
  // 1. encodeGlyph() each ID → collect curves[], hBands[], vBands[], bbox
  // 2. Track cumulative curveStart per glyph
  // 3. _packBands() → flatten band tables + entries into Uint16 arrays
  // 4. _buildCurveTexture(), _buildBandTexture(), _buildGlyphMapTexture()
  // 5. Return { curveTexture, bandTexture, glyphMapTexture, stats }
}

encodeGlyph(glyphId) {
  const segments = this.hbFont.glyphToJson(glyphId);
  if (!segments || segments.length === 0) {
    return { curves: [], hBands: [], vBands: [], bbox: {xMin:0,yMin:0,xMax:0,yMax:0} };
  }

  // Parse segments into quadratic beziers
  const curves = [];
  let cx = 0, cy = 0;        // current point
  let sx = 0, sy = 0;        // contour start

  for (const seg of segments) {
    switch (seg.type) {
      case 'M':
        sx = seg.values[0]; sy = seg.values[1];
        cx = sx; cy = sy;
        break;
      case 'L': {
        const ex = seg.values[0], ey = seg.values[1];
        // Degenerate quadratic: control point at midpoint
        curves.push({ p0x:cx, p0y:cy, p1x:(cx+ex)/2, p1y:(cy+ey)/2, p2x:ex, p2y:ey });
        cx = ex; cy = ey;
        break;
      }
      case 'Q': {
        const [cpx, cpy, ex, ey] = seg.values;
        curves.push({ p0x:cx, p0y:cy, p1x:cpx, p1y:cpy, p2x:ex, p2y:ey });
        cx = ex; cy = ey;
        break;
      }
      case 'C':
        throw new Error(`Cubic bezier in glyph ${glyphId} -- CFF fonts not yet supported`);
      case 'Z':
        if (cx !== sx || cy !== sy) {
          // Implicit closing line
          curves.push({ p0x:cx, p0y:cy, p1x:(cx+sx)/2, p1y:(cy+sy)/2, p2x:sx, p2y:sy });
        }
        cx = sx; cy = sy;
        break;
    }
  }

  // Compute bbox, normalize to [0,1]
  const bbox = computeBBox(curves);
  const normalized = normalizeCurves(curves, bbox);

  // Organize into bands
  const { hBands, vBands } = organizeBands(normalized, this.bandCount);

  return { curves: normalized, hBands, vBands, bbox };
}
```

---

## 9. Memory Budget (Cousine, ~200 renderable glyphs)

| Texture | Format | Dimensions | Size |
|---------|--------|-----------|------|
| curveTexture | RGBA16F | 256 x 32 | 65 KB |
| bandTexture | RGBA16UI | 256 x 16 | 32 KB |
| glyphMapTexture | RGBA32F | 256 x 4 | 16 KB |
| **Total** | | | **~113 KB** |

Compare: current bitmap atlas = 2048x2048 RGBA8 = 16 MB. This is a **140x reduction**.

---

## 10. Decisions

1. **No opentype.js.** harfbuzzjs has `glyphToJson()`. One library.
2. **No cubic support at launch.** Cousine is TrueType (quadratic only). Throw on C segments.
3. **No shared-endpoint optimization.** 2 texels per curve, simple random access.
4. **Float16 via DataView.setFloat16().** Baseline 2025, no polyfill needed.
5. **Band count: 8 per axis default**, capped at MAX_BANDS=16 in shader.
6. **2-level indirection**: glyphMap -> bandTable -> curveEntries. Not 1-level (too much per-glyph data) or 3-level (extra texture).
7. **Coordinate normalization to [0,1]** before packing. BBox stored in glyphMap for shader reconstruction.
8. **Main thread, synchronous, once per font.** < 30ms for Cousine.
