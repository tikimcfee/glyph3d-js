# Phase 0: Atlas Measurement Pipeline Analysis

**Perspective**: Atlas Measurement — how pixel widths flow from `_packGrapheme` through `getSerializableGlyphWidths` into the builder's advance calculation.

---

## Primary Findings

### Finding 1: `Math.ceil` Introduces Per-Character Variation in a Nominally Monospace Font

`_packGrapheme` (GlyphAtlas.js line 247):
```js
const glyphWidth = Math.ceil(glyphMetrics.width);
```

`canvas.measureText()` returns a floating-point advance width even for monospace fonts. Monospace fonts are not perfectly monospace at the subpixel level — the browser's text shaping engine returns values like `28.8`, `29.0`, `28.95` for different characters at 48px Monaco. `Math.ceil` converts these to integers, but those integers are not necessarily equal. For a given font at a given size you may see:

- Most ASCII characters ceil to the same value (e.g., 29)
- Some characters ceil to 30 (e.g., 'M', 'W', wide box-drawing chars)
- Some might ceil to 28

This creates a per-character `metrics.width` that varies by 1–2px. Each character in the atlas gets an independently-measured `Math.ceil(measureText(grapheme).width)` stored in `metrics.set(grapheme, { width: glyphWidth, ... })`.

### Finding 2: `getCharSize()` Uses Only 'M' as Reference

`getCharSize()` (GlyphAtlas.js lines 330–334):
```js
getCharSize() {
    const m = this.metrics.get('M');
    return m ? { width: m.width, height: m.height } : { width: this.fontSize, height: this.fontSize };
}
```

This returns `Math.ceil(measureText('M').width)` as the canonical `charWidth`. 'M' is typically the widest alphabetic character, so `getCharSize().width` is at or near the maximum of the per-character widths.

### Finding 3: The Two Width Sources Are Not Guaranteed Equal for the Same Character

`GlyphCollection._getMetrics()` (GlyphCollection.js lines 113–127) and the equivalent in `GlyphRenderer` constructor (GlyphRenderer.js lines 50–66) both derive `charWidth` from `getCharSize()`:

```js
const atlasCharSize = atlas.getCharSize();  // Math.ceil(measureText('M').width) * scale
const scale = this.config.worldScale;
this.metrics = {
    charWidth: atlasCharSize.width * scale,   // e.g., 29px * 0.025 = 0.725
    worldScale: scale,
    ...
};
```

The builder receives this metrics object and uses it two ways (builders/index.js lines 88–90, 124–126):

```js
const ws = metrics.worldScale;              // e.g., 0.025
const defaultWidth = metrics.charWidth;     // e.g., 0.725 (M's width * scale)

const glyphWidth = glyphWidths && glyphWidths[grapheme]
    ? glyphWidths[grapheme] * ws            // e.g., 28px * 0.025 = 0.700  ← differs from M
    : defaultWidth;                         // e.g., 0.725
```

`glyphWidths[grapheme]` is `atlas.metrics.get(grapheme).width` — the per-character `Math.ceil(measureText(grapheme).width)`. For 'M' itself these are equal. For any character whose `measureText` ceils to a different integer than 'M' — even by 1px — the per-glyph width diverges from `charWidth`.

At `worldScale = 0.025`, a 1px difference is `0.025` world units. With a `charWidth` of ~0.725, that is ~3.4% per character. Across a 40-character line this accumulates to 1.0 world units of drift — enough to shift the hover highlight by 1–2 character widths by the end of the line.

### Finding 4: UV Rect Width vs Layout Advance Width Are Derived from the Same Source

The atlas UV rect spans from `x` (draw origin) to `x + glyphWidth` (where `glyphWidth = Math.ceil(measureText(grapheme).width)`). The `instanceSize.x` written by the builder is also `glyphWidth * ws`. So the rendered quad width and the layout advance are consistent with each other — neither one is the source of the drift.

The drift comes from per-character variation in the `Math.ceil(measureText)` values themselves. Since each character gets an independently measured width, the advance on character N differs from what a uniform-advance monospace layout would produce, and these per-character errors compound left-to-right.

### Finding 5: `getSerializableGlyphWidths()` Faithfully Transmits the Raw Ceiled Values

```js
getSerializableGlyphWidths() {
    const widths = {};
    for (const [grapheme, m] of this.metrics) {
        widths[grapheme] = m.width;   // raw Math.ceil(measureText) value
    }
    return widths;
}
```

No rounding, no normalization. Whatever `_packGrapheme` stored is what the builder sees. The WorkerBridge comment (WorkerBridge.js line 129) acknowledges this: "Stored in canvas pixels — the builder multiplies by worldScale." The pipeline is faithful; the problem is upstream in the measurement.

---

## The Core Invariant Violation

A true monospace font has a single cell width. Every character occupies exactly that cell. The correct model is:

1. Measure one reference character (conventionally 'M' or '0')
2. Use that width as the advance for every character, regardless of what `measureText` returns for individuals

The current code violates this by giving each character its own advance derived from its own `measureText` result. `canvas.measureText` does not guarantee equal widths even for monospace fonts because:
- Subpixel rendering paths differ per character
- Font hinting varies by glyph
- The browser's float result (`28.8`, `29.0`, etc.) ceils to different integers

The atlas UV rect can legitimately use per-character measured width (it should fit the actual ink). The layout advance should not.

---

## Code Reference Summary

| Location | Line(s) | What Happens |
|---|---|---|
| `GlyphAtlas._packGrapheme` | 246–247 | `Math.ceil(measureText(grapheme).width)` → `metrics.set(grapheme, {width})` |
| `GlyphAtlas.getCharSize` | 330–334 | Returns `metrics.get('M').width` — single-char reference |
| `GlyphAtlas.getSerializableGlyphWidths` | 383–394 | Copies `m.width` verbatim; no normalization |
| `GlyphCollection._getMetrics` / `GlyphRenderer constructor` | GC:113–127 / GR:50–66 | `charWidth = getCharSize().width * scale` — M-based |
| `builders/index.js` (single) | 88–90, 124–126 | `ws = metrics.worldScale`; `glyphWidth = glyphWidths[g] * ws` if present, else `charWidth` |
| `builders/index.js` (batch) | 265, 359–362 | Same pattern |

---

## What the Fix Should Be

**For monospace fonts (the only font currently used), use a single uniform advance for all characters.**

The options, in order of correctness:

**Option A (recommended): Uniform advance — ignore per-glyph widths for layout, keep them for UV only**

In `_getMetrics` / renderer constructor, add `cellWidth: getCharSize().width` (already there as `charWidth`). In the builder, remove the per-glyph width lookup for the X advance. Use `metrics.charWidth` for every character unconditionally. Keep `instanceSize.x = metrics.charWidth * scale` for consistent picking quads.

This is the right model for monospace: every cell is the same width. UV rects can still span only the actual ink area (narrower for 'i', wider for 'M') — that only affects which texels are sampled, not where the next character starts.

**Option B: Normalize all per-glyph widths to a single reference**

In `getSerializableGlyphWidths`, replace each `m.width` with `this.metrics.get('M')?.width ?? m.width`. This makes the builder's per-glyph lookup always return the reference width. Functionally equivalent to Option A but adds indirection for no gain.

**Option C: Round to a single value at ceil time**

After measuring 'M' in `generate()`, store `this.referenceWidth = Math.ceil(measureText('M').width)`. In `_packGrapheme`, use `this.referenceWidth` as `glyphWidth` for the metrics entry (but still measure per-character for the UV rect placement). This preserves variable-width UV rects while producing uniform advance values.

**Option A is preferred** because it is explicit about the contract ("this is a monospace renderer") and avoids touching `_packGrapheme` which is also responsible for atlas packing geometry (where variable widths are correct and desirable to avoid wasted space).

**For genuinely variable-width scenarios** (if a proportional font is ever introduced), per-glyph advance is correct. The current per-glyph path should be preserved as the proportional-font code path, gated on a `metrics.proportional` flag or similar.

---

## Does `advance` Differ from `width` in the Metrics Map?

No. `_packGrapheme` stores `advance: glyphWidth` with the same value as `width` (line 284–287). They are always equal. `getSerializableGlyphWidths` uses `m.width`, and no code currently reads `m.advance` from the serialized form. The `advance` field in the stored metrics object is dead weight at this time.
