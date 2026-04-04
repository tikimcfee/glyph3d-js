# Phase 0: Builder Layout Analysis
## Glyph Dimension Pipeline — Builder Perspective

### Summary of Findings

There is one confirmed structural bug and two secondary drift sources. The confirmed bug causes a systematic half-width leftward shift on every glyph. The drift sources cause cumulative per-character error on lines with variable-width glyphs.

---

## Finding 1: Centered Quad vs Left-Edge instancePosition (CONFIRMED BUG)

**The vertex shader (`GlyphRenderer._getVertexShader()`, line 325):**
```glsl
vec3 scaled = position * vec3(instanceSize, 1.0);
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```

`position` is the PlaneGeometry vertex position, which ranges from `-0.5` to `+0.5` in X (centered quad). After scaling by `instanceSize.x`, the quad spans:
```
[ -instanceSize.x/2,  +instanceSize.x/2 ]
```

Then `instancePosition.x` is added as a translation. So the quad's screen extent is:
```
[ instancePosition.x - instanceSize.x/2,  instancePosition.x + instanceSize.x/2 ]
```

**But in the builder** (`src/workers/builders/index.js`, lines 151, 158, 173):
```js
positions[idx * 3] = x;          // LEFT EDGE of this glyph's layout cell
sizes[idx * 2] = glyphWidth * scale;
x += glyphWidth * scale + metrics.letterSpacing;
```

`x` before the write is the left edge of the glyph cell. `instancePosition.x = x` (left edge). After the shader applies the centered quad, the glyph renders centered at the left edge: it extends `glyphWidth/2` to the left of where it should start.

**Visual effect**: Every glyph is shifted left by `instanceSize.x / 2`. For a typical ASCII char at 48px font, `worldScale=0.1`, that is `48 * 0.1 / 2 = 2.4` world units of leftward shift per glyph.

**Picking quads have the same transform** (the picking vertex shader, `PickingSystem.js` line 52, is identical):
```glsl
vec3 scaled = position * vec3(instanceSize, 1.0);
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```

So picking quads are also centered on the left edge. The rendered glyph and the picking quad are consistently misaligned together — the visual is wrong but picking and rendering stay in sync with each other. This means picking works correctly for clicking but the visual highlight appears on the wrong column relative to the actual character column. Whether this manifests as off-by-N depends on how the UI maps a picked glyph ID back to a column number.

**The correct fix** (two equivalent options):

Option A — offset instancePosition by half width in the builder:
```js
// Write center of cell, not left edge
positions[idx * 3] = x + (glyphWidth * scale) / 2;
```

Option B — shift PlaneGeometry to be a 0-to-1 quad:
```js
// In _createInstanceMesh(): change PlaneGeometry(1,1) to a 0-to-1 quad
// by translating its geometry: geometry.translate(0.5, 0, 0)
// This makes the quad span [0, 1] * instanceSize instead of [-0.5, +0.5] * instanceSize
```

Option A is preferred because it is local to the builder and does not require changes to the shader or geometry. It also makes `positions[idx*3]` semantically clearer as "center of glyph cell."

---

## Finding 2: Per-Character Width Drift from Math.ceil

**In `GlyphAtlas._packGrapheme()` (line 247):**
```js
const glyphWidth = Math.ceil(glyphMetrics.width);
```

The atlas stores the **ceiling** of the Canvas 2D measured pixel width. `getSerializableGlyphWidths()` returns `m.width` from `metrics.set(grapheme, { width: glyphWidth, ... })` — the already-ceiled integer.

**In the builder (`index.js`, lines 89, 124-126):**
```js
const ws = metrics.worldScale || (metrics.charWidth / 30);
const glyphWidth = glyphWidths && glyphWidths[grapheme]
    ? glyphWidths[grapheme] * ws
    : defaultWidth;
```

Each character's world width is `Math.ceil(pixelWidth) * worldScale`. The `Math.ceil` introduces up to 1 pixel of extra width per character. For a proportional font with measured widths between integers, this is the dominant drift source.

**Drift math for an 80-character line:**

Assume `worldScale = 0.1`. The expected width of glyph `i` is `actualPixel_i * 0.1`. The stored width is `Math.ceil(actualPixel_i) * 0.1`. The overshoot per glyph is at most `0.1` world units. Plus `letterSpacing = charWidth * 0.05`.

For a monospace font (Monaco/Menlo), most ASCII characters report the same measured width as 'M', so `Math.ceil` typically adds 0 or 1 pixel. If it adds 1 pixel per character:
```
drift = 80 chars * 1px * 0.1 worldScale = 8.0 world units
```
With a character width of ~`28px * 0.1 = 2.8 world units`, that is a drift of about **2.85 character widths** over 80 chars — large enough to cause the "off by 1-2 positions" symptom described in the bug report.

In practice, for a truly monospace font the drift is near zero because all characters have the same measured width. The problem appears most acutely for: (a) proportional fallback fonts, (b) box-drawing characters with different native widths, (c) emoji with wider measured widths.

---

## Finding 3: defaultWidth Unit Consistency

**When a glyph is absent from `glyphWidths`:**
```js
const defaultWidth = metrics.charWidth; // world units
const glyphWidth = glyphWidths && glyphWidths[grapheme]
    ? glyphWidths[grapheme] * ws          // pixel * (world/pixel) = world units
    : defaultWidth;                       // already world units
```

`defaultWidth = metrics.charWidth = atlasCharSize.width * worldScale` (computed in `GlyphCollection._getMetrics()`, line 117). That is already in world units.

The per-glyph path is `pixelWidth * ws` where `ws = worldScale`, also world units. The units match. No mismatch here.

However, there is a subtle inconsistency: `defaultWidth` uses the width of `'M'` (from `atlas.getCharSize()` which calls `this.metrics.get('M')`), which is the **ceil** of the 'M' measurement. If the missing glyph's actual width differs from 'M', the advance is wrong for that character. This is not a unit error but it will cause a single-character position jump that looks like a unit mismatch to the observer.

---

## Finding 4: letterSpacing Creates Dead Zones

```js
sizes[idx * 2] = glyphWidth * scale;                   // visual quad width
x += glyphWidth * scale + metrics.letterSpacing;       // advance
```

The picking quad is sized to `glyphWidth * scale`, not `glyphWidth * scale + letterSpacing`. This means there is a gap of `letterSpacing` world units between adjacent picking quads. That gap is `charWidth * 0.05` wide. For `charWidth = 2.8`, the gap is `0.14` world units.

These gaps are not pickable. If the cursor lands in a gap, the picking pass returns 0 (miss). This creates the perception that characters "don't register" at certain cursor positions, especially for users moving the cursor slowly across a line.

This is intentional spacing behavior, not a bug per se, but it contributes to the perceived picking inaccuracy alongside Finding 1.

---

## X Accumulation Trace (buildGlyphBuffers)

```
x = position.x                                        // line start
for each grapheme:
    glyphWidth = glyphWidths[g] * ws  OR  defaultWidth  // world units
    if space:  x += glyphWidth * scale + letterSpacing  ; continue
    positions[idx*3] = x                               // LEFT EDGE (bug: should be center)
    sizes[idx*2] = glyphWidth * scale
    x += glyphWidth * scale + letterSpacing            // advance past this glyph
```

The `scale` parameter from `item.scale || 1.0` applies uniformly to both the quad size and the advance. It does not introduce drift by itself. The issue is that `positions[idx*3] = x` is the left edge while the vertex shader interprets it as the center of the quad.

`buildBatchBuffers` has identical logic (lines 397–414) with the additional Z-wrap logic that resets `x = pos.x` and drops `y` when `glyphsOnSegment >= maxLineWidth`. The Z-wrap reset is clean; no drift is introduced there.

---

## Recommended Fix Priority

1. **Fix the centered quad offset** (Finding 1) — write `x + (glyphWidth * scale) / 2` to positions. This is the root cause of the systematic visual shift. One-line change in both `buildGlyphBuffers` (line 151) and `buildBatchBuffers` (line 397).

2. **Investigate letterSpacing dead zones** (Finding 4) — consider widening picking quads to include the spacing, or reducing `letterSpacing` to 0 for picking-only materials.

3. **Math.ceil drift** (Finding 2) — for the current monospace target font this is low impact. If proportional fonts are added, switch to `Math.round` or store float widths.

---

## File References

- `/home/user/dev/glyph3d-js/src/workers/builders/index.js` lines 89, 124–126, 151, 158, 173 — position write, width calculation, x advance
- `/home/user/dev/glyph3d-js/src/GlyphRenderer.js` line 325 — vertex shader quad scaling
- `/home/user/dev/glyph3d-js/src/picking/PickingSystem.js` line 52 — picking vertex shader (same transform as main shader)
- `/home/user/dev/glyph3d-js/src/GlyphAtlas.js` line 247 — `Math.ceil` in `_packGrapheme`
- `/home/user/dev/glyph3d-js/src/GlyphAtlas.js` lines 383–393 — `getSerializableGlyphWidths` returns already-ceiled integers
- `/home/user/dev/glyph3d-js/src/collections/GlyphCollection.js` lines 113–127 — `_getMetrics()` derives `charWidth`, `worldScale`, passes both to builder
