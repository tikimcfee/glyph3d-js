# Phase 0: Legacy vs Grapheme — Glyph Dimension Pipeline Analysis

Agent: Legacy vs Grapheme
Date: 2026-03-31
Focus: Which assumptions changed during the grapheme migration, what was left behind, and
whether active code paths mix old and new width conventions.

---

## 1. Active vs Dead Code Paths

### Active path (IDE viewer, CodeGrid, all real usage)

```
CodeGrid.loadTextAsync()
  → GlyphCollection.addText() / addTexts()
  → GlyphCollection.flushAsync()
    → WorkerBridge.buildBatchBuffers(items, {metrics, uvMap, glyphWidths}, atlas)
      → worker: buildBatchBuffers() in src/workers/builders/index.js
      → uses iterGraphemes() + per-glyph glyphWidths map
  → GlyphRenderer.applyPrebuiltBuffers(buffers, items)
```

`GlyphCollection.flush()` (sync path) follows the same worker builder eventually — it
also calls `buildBatchBuffers` via the sync fallback in WorkerBridge
(`_buildBatchBuffersSync`), which calls the same `buildBatchBuffers` export from
`builders/index.js`.

### Also active (direct renderer usage, examples)

```
GlyphRenderer.render() / renderBatch()
  → GlyphRenderer._textToGlyphs()
    → GlyphLayout.layoutText()  ← UNIFORM width only
    → iterGraphemes() for UV lookup
    → glyph.size = { width: metrics.charWidth * scale, ... }  ← UNIFORM width
```

This path is still live. `render()` and `renderBatch()` are public API on
`GlyphRendererV15` and are called directly from examples and any code that creates a
renderer without a `GlyphCollection` wrapper. They use `_textToGlyphs()`, which calls
`GlyphLayout.layoutText()`.

### Dead code (safe to delete)

- `src/layout/GlyphBatcher.js` — self-labeled `@deprecated`, no callers found. Uses
  `metrics.charWidth` uniformly. Dead.
- `src/core/InstanceBuffer.js` — no callers in active paths. Uses `atlas.getCharSize()`
  divided by a hardcoded `50` for world unit conversion, uniform width per character.
  Exported from `src/index.js` but never imported anywhere except that barrel. Dead.
- `src/workers/builders/textToGlyphs.js` — not imported by anything in active paths.
  Describes itself as "extracted from GlyphRendererV15._textToGlyphs() for Web Worker
  usage" but the actual worker path uses `buildGlyphBuffers` / `buildBatchBuffers` from
  `builders/index.js` instead. Dead.
- `src/workers/builders/layoutText.js` — also not called from any active path. The
  active builder (`builders/index.js`) does its own inline layout, not this function.

---

## 2. Width Assumption Mismatches in Active Paths

### Inconsistency A: `_textToGlyphs` in GlyphRenderer (active, uniform width)

`GlyphRenderer._textToGlyphs()` (line 1120) still uses the two-step old path:

1. `GlyphLayout.layoutText(text, position, options.alignment)` — advances cursor by
   `metrics.charWidth + metrics.letterSpacing` per character (uniform, from `'M'`).
2. Returns glyph objects with `size: { width: metrics.charWidth * scale, height: ... }` —
   the quad rendered on GPU is sized to the uniform `charWidth`, not the actual glyph
   advance.

This path is reached via `GlyphRenderer.render()` and `renderBatch()`. Any caller
going through the renderer directly (not via `GlyphCollection`) gets uniform-width
layout. The picking quads will match the layout positions, so picking is internally
consistent — but the positions will be wrong relative to what a proportional-font renders
visually for characters narrower or wider than `'M'`.

### Inconsistency B: `textToGlyphs.js` (dead, but instructive)

`textToGlyphs.js` uses `metrics.charWidth * scale` for all glyph sizes — uniform. It
also skips spaces by incrementing `posIndex` without advancing `x` itself (the positions
array from `layoutText` already includes space positions). This is structurally incompatible
with the new builder which skips spaces and advances `x` inline. A caller trying to use
`textToGlyphs` with positions from `buildGlyphBuffers` would misalign.

### Inconsistency C: `GlyphLayout.layoutText` (active, uniform width)

`GlyphLayout.layoutText()` iterates `text[i]` (char-by-char, not grapheme-by-grapheme)
and advances by `metrics.charWidth + metrics.letterSpacing` uniformly. No call to
`iterGraphemes`, no per-glyph width lookup. This is the layout engine used by
`_textToGlyphs`. It produces positions that are correct only for monospace glyphs at
the 'M' cell width.

The new builder in `builders/index.js` does not use `GlyphLayout` at all. It inlines
its own cursor advance per grapheme using `glyphWidths[grapheme] * ws`.

### Inconsistency D: `applyPagination` in `builders/index.js` (active, uniform width)

`applyPagination()` in `builders/index.js` computes:

```js
const charAdvance = metrics.charWidth + metrics.letterSpacing;
const pageWidthWorld = Z_WRAP_CONFIG.maxLineWidth * charAdvance;
```

This uses the uniform 'M' width to calculate horizontal page widths, even though the
glyphs it is repositioning were laid out with per-glyph widths. For proportional fonts
the actual width of `maxLineWidth` graphemes will differ from `maxLineWidth *
charAdvance`. Pagination boundaries will be slightly wrong for mixed-width content.

---

## 3. The `metrics.worldScale` Derivation

### Where it comes from

`GlyphCollection._getMetrics()` (line 110–127):

```js
const atlasCharSize = this.atlas.getCharSize();  // { width, height } of 'M' in pixels
const scale = this.config.worldScale || 0.025;

this._metricsCache = {
    charWidth:     atlasCharSize.width * scale,   // 'M' pixel width × worldScale
    charHeight:    atlasCharSize.height * scale,
    letterSpacing: atlasCharSize.width * scale * 0.05,
    lineSpacing:   atlasCharSize.height * scale * 1.2,
    worldScale:    scale,   // stored explicitly for builder use
    pixelWidth:    atlasCharSize.width,
    pixelHeight:   atlasCharSize.height
};
```

`worldScale` is therefore a pure scalar: `world units per pixel`. It is NOT derived from
`charWidth / pixelWidth` at runtime — it is set as a config constant (default `0.025`)
and `charWidth` is derived from it.

However, `GlyphRenderer` constructor uses `this.config.worldScale || 0.1` (default
`0.1`), while `GlyphCollection._getMetrics()` defaults to `0.025`. Both read from
`options.worldScale` when provided. When `GlyphCollection` creates a renderer it passes
`worldScale: this.config.worldScale`, so they agree — but only when `GlyphCollection` is
used. If `GlyphRenderer` is constructed standalone with its own `options.worldScale`, the
default of `0.1` is four times larger than the collection default of `0.025`.

### How the builder uses it

In `builders/index.js`:

```js
const ws = metrics.worldScale || (metrics.charWidth / 30);  // fallback
const glyphWidth = glyphWidths && glyphWidths[grapheme]
    ? glyphWidths[grapheme] * ws
    : defaultWidth;
```

`glyphWidths[grapheme]` is a pixel width (from `atlas.metrics.get(grapheme).width`).
Multiplying by `ws` (= `worldScale`) converts it to world units. This is the correct
conversion, identical to how `charWidth` is derived.

The fallback `metrics.charWidth / 30` is a hardcoded approximation. It assumes the 'M'
character is 30 pixels wide. For the default 48px font atlas, 'M' measures approximately
28–32px, so the fallback is close — but it is not guaranteed to be correct and should not
survive in production code. If a caller constructs `metrics` without `worldScale`, the
fallback fires silently and may produce layout drift.

---

## 4. `countGlyphs()` Overcounting Analysis

`countGlyphs()` counts any grapheme with `codePointAt(0) > 32`. The build loop skips:

- Newline (cp === 10)
- Space (cp === 32) — advances cursor, no buffer slot
- CR (cp === 13) — skipped entirely, no cursor advance
- Tab (cp === 9) — skipped entirely, no cursor advance
- Glyphs missing from atlas and with no '?' fallback — skips and advances cursor

`countGlyphs` includes CR (cp 13) and tab (cp 9) in its count because both have
`codePointAt(0) > 32` is false for CR (13 < 32) but TRUE for tab (9 < 32... wait: 9 < 32,
so tab is NOT counted). CR is 13, which is also < 32. So neither CR nor tab is counted
by `countGlyphs`.

Corrected: `countGlyphs` counts graphemes with cp > 32. Space is 32 (excluded). CR is
13 (excluded). Tab is 9 (excluded). Newline is 10 (excluded). So `countGlyphs` counts
everything above space — including any character that the build loop later skips due to
a missing atlas entry with no '?' fallback.

**The overcount scenario**: If a grapheme has cp > 32, passes `countGlyphs`, but the
atlas has no entry for it AND has no '?' fallback, the build loop hits:

```js
if (!resolvedEntry) {
    x += glyphWidth * scale + metrics.letterSpacing;
    continue;  // cursor advances, but idx does NOT increment
}
```

`idx` ends up smaller than `glyphCount` (the pre-allocated buffer size). The returned
`count: idx` is correct, but the tail of the buffers (from `idx` to `glyphCount`) is
left as zero-initialized Float32Array. This means the glyph mesh receives zero-position
instances at the origin. With alpha discard in the fragment shader these may be invisible
— but they consume instance slots and can affect picking ID numbering.

In practice, the '?' fallback almost always fires before this happens, since `'?'` (cp
63) is in the initial charset. The case only arises if the entire atlas is corrupted or
`generate()` was never called.

---

## 5. Convention Summary: `charWidth` vs `glyphWidths`

| Property | Source | Units | Used by |
|---|---|---|---|
| `metrics.charWidth` | `atlas.getCharSize().width * worldScale` | world | GlyphRenderer sync path, GlyphLayout, applyPagination, letterSpacing calculation, defaultWidth fallback |
| `glyphWidths[g]` | `atlas.metrics.get(g).width` | pixels | buildGlyphBuffers, buildBatchBuffers (converted via `* ws`) |
| `metrics.worldScale` | `options.worldScale` (config scalar) | world/pixel | builder per-glyph width conversion |

Both are needed. `charWidth` is used as the advance for the sync layout path (uniform)
and as the fallback default width in the async path. `glyphWidths` is the per-character
override in the async path. The two are numerically consistent: `charWidth =
glyphWidths['M'] * worldScale` (by construction).

The mismatch is not numeric — it is behavioral. The async builder uses `glyphWidths` and
produces proportional layout. The sync path (`render()` / `renderBatch()` via
`_textToGlyphs`) ignores `glyphWidths` entirely and uses `charWidth` for every character.
If the same text is rendered through both paths (e.g., an example that calls
`renderer.render()` directly vs a `CodeGrid` that uses `flushAsync()`), the glyph
positions will diverge for any character narrower or wider than 'M'.

---

## 6. Root Cause of Hover Position Misalignment

The picking system resolves a hover to `{ renderer, slotIndex }` from `GlyphRenderer`,
then maps `slotIndex` to a character via `lineSlotOffsets`. The slot boundaries come from
`buildBatchBuffers` (async path) which uses per-glyph widths. The visual positions also
come from the async builder with per-glyph widths. These are consistent.

The misalignment is more likely to originate from one of:

1. **`countGlyphs` uses `iterGraphemes` but the space treatment differs**: `countGlyphs`
   excludes spaces (cp 32, not > 32). The builder ALSO excludes spaces from slots. So
   slot counting is consistent for spaces.

2. **Tab characters**: `countGlyphs` also excludes tabs (cp 9, not > 32). The builder
   skips tabs (`if (cp === 13 || cp === 9) continue`) without advancing cursor and
   without incrementing `idx`. Consistent.

3. **`lineSlotOffsets` records `idx` at newline, not `bufferOffset`**: In
   `buildGlyphBuffers` (single-text path), `lineSlotOffsets.push(idx)` is correct —
   `idx` is the next slot. In `buildBatchBuffers`, `itemLineSlotOffsets.push(bufferOffset)`
   is used — `bufferOffset` is the combined-buffer absolute index, which means the
   slot offsets are global rather than item-relative. Any consumer using these offsets
   to index into per-item positions would need to subtract `itemStartOffset`. If
   `CodeGrid._lineSlotBase` receives raw `lineSlotOffsets` without this subtraction,
   line-to-slot mapping is off by `itemStartOffset` for every item except the first.

   This is the most likely source of "off by 1-2 positions" hover errors for files
   after the first in a batch.

4. **`glyphWidths` cache sent to worker is stale after `ensureGraphemes`**: WorkerBridge
   only resends `glyphWidths` when `needsUVMap` is true (i.e., on the first dispatch to
   each worker). If new graphemes are added via `ensureGraphemes()` after a worker's
   initial warm-up, the worker retains stale widths for the new graphemes. Missing widths
   fall back to `defaultWidth = metrics.charWidth`, which is the 'M' width. Any
   newly-added proportional character will be laid out at 'M' width, causing misalignment
   for that character and all subsequent characters on the same line.

---

## 7. Files and Their Status

| File | Status | Width convention |
|---|---|---|
| `src/workers/builders/index.js` | Active (primary GPU path) | Per-glyph (correct) |
| `src/GlyphAtlas.js` | Active | String-keyed metrics, per-glyph widths |
| `src/utils/grapheme.js` | Active | Intl.Segmenter grapheme clusters |
| `src/collections/GlyphCollection.js` | Active | Delegates to builder; worldScale default 0.025 |
| `src/GlyphRenderer.js` (`_textToGlyphs`) | Active (sync path) | Uniform charWidth via GlyphLayout |
| `src/layout/GlyphLayout.js` | Active (used by sync path) | Uniform charWidth, char-by-char |
| `src/workers/builders/layoutText.js` | Dead | Uniform charWidth, char-by-char |
| `src/workers/builders/textToGlyphs.js` | Dead | Uniform charWidth |
| `src/layout/GlyphBatcher.js` | Dead (self-labeled deprecated) | Uniform charWidth |
| `src/core/InstanceBuffer.js` | Dead (no callers) | Uniform, hardcoded /50 scale |
