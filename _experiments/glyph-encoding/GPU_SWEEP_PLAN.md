# GPU sweep — plan (the next phase)

## Why this exists / the pivot

The glyph-encoding work to date optimized **running (CPU/JS) memory**: a compact
resident "map" (whole repo = ~8 MB) that drives the real WebGPU renderer
pixel-identically. Proven, measured (~36× vs holding everything rendered), but it
does **not** reduce **GPU/VRAM**, which was the real goal — the thing that tips
over a low-VRAM netbook. Rendering still builds the same fat instance buffer.

**The GPU sweep = shrink the per-drawn-glyph GPU instance attributes themselves**
(~40 B → ~6–8 B), by deriving most of them in the TSL shader instead of storing
them per instance. This is the FIRST deliberate edit to core; everything before
it left `packages/glyph3d-core` untouched.

## Current per-instance GPU layout (GlyphField.js, ~40–44 B/glyph)

| attribute | type | bytes | recoverable? |
|---|---|--:|---|
| `instancePosition` | vec3 f32 | 12 | derive from cell (col,row) + grid uniforms |
| `instanceSize` (advance,height) | vec2 f32 | 8 | advance from a per-slot metrics texture; height = uniform |
| `instanceGlyphId` (FontChain slot) | f32 | 4 | keep, but as **u16** |
| `instanceColor` | vec3 f32 | 12 | **palette index** (u8) → CLUT texture |
| `instanceGroupId` | f32 | 4 | **u8** |
| `instancePickingId` | f32 | 4 | already derivable (baseId + instanceIndex) → drop |

## Target packed layout (~6–8 B/glyph)

- `cell` : u32 (col:12 / row:20) = 4 B  *(or 0 B if derived from instanceIndex + a per-line offset table)*
- `slot` : u16 = 2 B
- `colorIdx` : u8 = 1 B
- `groupIdx` : u8 = 1 B

→ **~8 B/glyph (5×), or ~4 B (10×) if position comes from instanceIndex.**

## Recovery in the TSL vertex shader (GlyphField)

- **position** = `gridOrigin + col*advance*right + row*lineHeight*down`, with
  origin/advance/lineHeight as uniforms. MUST replicate the layout fold
  (wrap/pagination/scroll) — aligns with the layout-substrate refactor already
  moving the fold shader-side ([[project_layout_substrate_refactor]]).
- **advance/height**: per-slot metrics texture (advance can ride spare channels
  of the existing `glyphMapTexture`, which is already keyed by slot) + a height
  uniform. ("no hardcoded dimensions" — metrics from the atlas.)
- **glyph curves**: `glyphMapTexture[slot]` lookup — unchanged.
- **color** = `paletteTex[colorIdx] * groupColor[groupIdx]` (CLUT texture).
- **picking id** = `baseId + instanceIndex` — already how PickingSystem works.

## Files the sweep touches (the whole surface)

1. `packages/glyph3d-core/src/GlyphField.js` — InstancedBufferGeometry attribute
   layout (packed int formats) + the TSL vertex node that unpacks/derives.
2. `packages/glyph3d-core/src/workers/builders/index.js` — emit packed attributes
   (it already tracks col/row via `lineColIdx`; write cell instead of accumulated
   position; color → palette index; group → u8).
3. Per-slot **metrics texture** (advance) + a **palette/CLUT texture** — likely in
   the slug/atlas setup (`shaping/slugData.js` / `LiveSlugAtlas` / `GlyphAtlas`).
4. Color palette source: the render-neutral highlight product (commit c307520,
   `getHighlights()`) → per-token palette indices (today color is per-item).

## Staged plan (each stage validated on the bench before the next)

1. **Easy wins, no position derivation:** slot u16 (−2), group u8 (−3), drop
   stored pickingId (−4), color → palette u8 (−11). 40 → ~24 B.
2. **size → per-slot metrics texture** (−8). → ~16 B.
3. **position → cell index + shader derivation** (−8, the hard one: layout fold).
   → ~8 B.
4. **GPU compute-expand (endgame):** keep the map in a GPU storage buffer; a
   compute pass expands only the visible window into packed instances → neither
   CPU nor GPU holds a fat buffer.

## Test strategy (reuse the bench)

- `app/glyph-bench.jsx` side-by-side: old path (green) vs new packed path (cyan)
  must stay pixel-identical. Add the in-browser readback diff for a number.
- `measure.js`: real packed-buffer byteLength vs 40 B/glyph = the actual VRAM cut.
- Headless harnesses (`run.js`/`validate_picking.js`) guard encoding + picking.

## Risks / sharp spots

- **TSL packed int attributes + textures**: confirm three/webgpu supports u16/u8/
  u32 vertex formats + bit extraction; honor [[reference_tsl_webgpu_gotchas]]
  (32-bit int textures only, `textureLoad` not sample).
- **Position-from-cell must replicate the layout fold** — couples to the layout
  substrate; do the no-wrap case first.
- **Color palette depends on the highlights product** (per-glyph color is per-item
  today). Stage 1's color win needs token→palette-index wiring.
- Verify the **derived pickingId** still resolves under the packed layout.

## Status

Not started. Core still untouched. The map work (codec/index/bench) is the
feedstock: codepoint→slot stream, line/col→cell, color spans, and the pixel-diff
test harness all feed this sweep. See [[project_glyph_encoding_experiment]].
