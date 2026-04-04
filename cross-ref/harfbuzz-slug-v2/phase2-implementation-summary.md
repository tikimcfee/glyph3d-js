# Phase 2 Implementation Summary: SlugEncoder

## Files Created

### `src/shaping/SlugEncoder.js`
The main encoder class. Takes an initialized `HarfBuzzShaper` instance and encodes a set of glyph IDs into three RGBA16UI DataTextures for the Slug vector text rendering algorithm.

**Public API:**
- `constructor(shaper)` -- takes an initialized HarfBuzzShaper
- `encode(glyphIds)` -- takes a Set or Array of glyph IDs, returns `{ curveTexture, bandTexture, glyphMapTexture, stats }`

**Internal pipeline:**
1. `_encodeGlyph(glyphId)` -- extracts outline, converts to quadratic beziers, normalizes, organizes into bands
2. `_parseSegments(glyphId, segments)` -- M/L/Q/Z -> quadratic beziers. L segments become degenerate quadratics (control point at midpoint). Z emits closing line if current != start. C throws (TrueType only).
3. `_computeBBox(curves)` -- control-point hull bounding box for validation
4. `_computeBandCount(curveCount)` -- `clamp(ceil(sqrt(curveCount)), 2, 16)`
5. `_organizeBands(curves, bandCount)` -- assigns curves to horizontal Y-strips, sorts ascending by minX
6. `_createSlugTexture(data, width, height)` -- RGBA16UI DataTexture with NearestFilter, no mipmaps

### `src/shaping/slug-constants.js`
Shared constants between encoder (CPU) and future shader (GPU):
- `MAX_BANDS = 16`
- `MAX_CURVES_PER_BAND = 64`
- `CURVE_TEXELS_PER_CURVE = 2`
- `TEXTURE_WIDTH = 1024`
- `SLUG_TEXTURE_FORMAT` -- internalFormat, format, type strings
- `packUint16(value)` / `unpackUint16(bits)` -- [0,1] <-> uint16 conversion

### `src/shaping/validate-slug.js`
Validation script. Call from browser console:
```js
import('/src/shaping/validate-slug.js').then(m => m.validateSlugEncoder())
```

Tests:
1. Initializes HarfBuzzShaper, shapes "Hello, World!", collects unique glyph IDs
2. Runs SlugEncoder.encode() on those glyphs
3. Verifies all three textures are valid RGBA16UI DataTextures
4. Round-trip precision test: packUint16 -> unpackUint16 within 1/65535 tolerance
5. Verifies glyphMap entries point to valid curveTexture and bandTexture ranges
6. Walks band structure and verifies entries are sorted ascending by minX
7. Extended test: encodes full printable ASCII and reports total memory

## Files Modified

### `src/shaping/index.js`
Added `SlugEncoder` default export to the shaping module's public API.

## Texture Layout Details

### curveTexture (RGBA16UI, width 1024)
- 2 texels per quadratic bezier curve
- Texel 0: `[P0.x, P0.y, P1.x, P1.y]` as uint16 (packed from [0,1])
- Texel 1: `[P2.x, P2.y, 0, 0]`
- Curves packed sequentially across all glyphs

### bandTexture (RGBA16UI, width 1024)
- Per-glyph layout: band headers first (contiguous), then band entries
- Header texel: `[entryStart, entryCount, 0, 0]`
  - `entryStart` = absolute texel index into bandTexture where this band's entries begin
  - `entryCount` = number of curve entries in this band
- Entry texel: `[curveIndex, 0, 0, 0]`
  - `curveIndex` = glyph-local curve index (shader computes absolute texel as `(vCurveStart + curveIndex) * 2`)
- Headers are contiguous so the shader can address them as `bandHeaderStart + bandIdx`

### glyphMapTexture (RGBA16UI, width 1024)
- 1 texel per glyph ID slot (indexed directly by glyphId)
- `[curveStart, curveCount, bandHeaderStart, bandCount]`
  - `curveStart` = curve index (not texel offset); shader multiplies by 2 for texel addressing
  - `bandHeaderStart` = absolute texel index into bandTexture

## Coordinate Normalization
- X: `[0, advance]` -> `[0, 1]` where advance = `glyphAdvance(id)`
- Y: `[descender, ascender]` -> `[0, 1]` from `fontExtents()`
- Build-time warning if bbox exceeds advance width (1% tolerance)

## Shader Compatibility
The texture layout matches the fragment shader in round3-rendering-convergence.md:
```glsl
int bandIdx = clamp(int(p.y * float(vBandCount)), 0, vBandCount - 1);
int hdrTexel = vBandHeaderStart + bandIdx;
uvec4 hdr = texelFetch(bandTexture, ivec2(hdrTexel % 1024, hdrTexel / 1024), 0);
int entryStart = int(hdr.x);
int entryCount = int(hdr.y);
// ...
int ci = (vCurveStart + int(entry.x)) * 2;
```

## Files NOT Modified (per spec)
- GlyphRenderer.js (Phase 3)
- Any shader code (Phase 3)
- builders/index.js (Phase 3)
- GlyphAtlas.js (Phase 3 deletion)
