# Phase 0 — Segmenter: _iterSegmenter / iterGraphemes Elimination

Agent: Segmenter  
Target: `_iterSegmenter` at 6.2% of total time during text loading  
Status: IMPLEMENTED

---

## What the Profiler Was Showing

Firefox profiler attributed 6.2% of total load time to `_iterSegmenter`, the generator
inside `src/utils/grapheme.js`. This function is the hot-path implementation of
`Intl.Segmenter`-based grapheme cluster iteration. It is called exclusively through
`iterGraphemes()`.

---

## Call Sites Found

### 1. `GlyphCollection.flushAsync()` — src/collections/GlyphCollection.js:619-634

The hot path. Called once per `flushAsync()` invocation, which is triggered for every
batch of pending text during repository load.

The block iterated every character of every pending text item using `Intl.Segmenter` to
find grapheme clusters not yet in `atlas.uvMap`, then called `atlas.ensureGraphemes()`
to rasterize missing glyphs into the Canvas 2D atlas.

At 1500 files, each ~5-80 KB of source text, this is tens of megabytes of character
data fed through `Intl.Segmenter`. That is where the 6.2% was coming from.

### 2. `CodeGrid.getVisibleCharCount()` — src/collections/CodeGrid.js:719-727

Lower frequency. Called from `highlightRange()` for each line in the highlighted range
to count visible (non-space, non-control) buffer slots. At highlight time this is only
called for a handful of lines per highlight command, so it is not the primary profiler
target. However it was still using `Intl.Segmenter` unnecessarily.

---

## Why It Was Dead Work in the Slug/HarfBuzz Path

The grapheme-ensure block in `flushAsync()` was correct for the old atlas-based rendering
path where:

- Workers received a serialized `uvMap` (grapheme string → UV rect)
- Workers used that map to look up per-character atlas coordinates
- If a grapheme was not in the atlas, the worker silently used '?' fallback

In that path, `ensureGraphemes()` had to run before workers were dispatched so the
atlas was fully populated.

**The Slug/HarfBuzz path works completely differently:**

- `WorkerBridge.buildBatchBuffers()` shapes all text on the main thread using
  `MonospaceShapeCache.shapeLine()` or `HarfBuzzShaper.shape()`
- Shaping produces `item.shaped` — an array of `{g, ax, dx, dy}` structs (HarfBuzz
  glyph IDs + advances)
- Workers receive `item.shaped` and do only position/color buffer math
- Workers never look at `atlas.uvMap`; the `atlas` parameter to
  `WorkerBridge.buildBatchBuffers()` is explicitly documented as "Unused"
- The vertex shader indexes into `SlugEncoder`'s `glyphMapTexture` using the HarfBuzz
  glyph ID directly — the Canvas 2D atlas plays no role at all

So the entire `missingGraphemes` computation was scanning tens of MB of text per load
cycle to populate a data structure that no downstream code consumed.

---

## Fix 1: Skip Segmenter Scan When Shaper Is Configured

**File:** `src/collections/GlyphCollection.js`  
**Change:** Wrapped the `missingGraphemes` block in `if (!this.config.shaper)`.

```js
// Before: always ran O(all text × Intl.Segmenter) per flushAsync()
{
    const missingGraphemes = new Set();
    for (let i = 0; i < itemCount; i++) {
        for (const grapheme of iterGraphemes(text)) {  // _iterSegmenter hot
            if (cp > 32 && !this.atlas.uvMap.has(grapheme)) {
                missingGraphemes.add(grapheme);
            }
        }
    }
    if (missingGraphemes.size > 0) this.atlas.ensureGraphemes(...);
}

// After: skipped entirely in the Slug/HarfBuzz path
if (!this.config.shaper) {
    // ... same block unchanged ...
}
```

`this.config.shaper` is set by `GlyphCollection` constructor and `setSlugData()` when
the caller provides a HarfBuzz shaper. In all Slug-mode CodeGrids (the production path),
this is always set. In legacy atlas-only mode (examples that don't use HarfBuzz), the
block runs as before, so correctness is preserved.

Expected profiler improvement: the 6.2% disappears entirely for Slug-mode loads.

---

## Fix 2: Replace Segmenter in `getVisibleCharCount()`

**File:** `src/collections/CodeGrid.js`  
**Change:** Replaced `iterGraphemes()` with a direct `codePointAt()` loop.

```js
// Before
for (const grapheme of iterGraphemes(text)) {
    if (grapheme.codePointAt(0) > 32) count++;
}

// After
for (let i = 0; i < len; ) {
    const cp = text.codePointAt(i);
    if (cp > 32) count++;
    i += cp > 0xFFFF ? 2 : 1;
}
```

Rationale: source code lines are essentially always ASCII/Latin-1. There are no
multi-codepoint grapheme clusters (ZWJ sequences) in identifiers, operators, or
string literals. Even if there were emoji in string literals, the buffer builder
(`MonospaceShapeCache.shapeLine()`) also iterates by codepoint (not grapheme cluster),
so the slot counts would match regardless.

The `import { iterGraphemes }` line in CodeGrid.js was removed as it became unused.

---

## What Was NOT Changed

- `src/utils/grapheme.js` — `iterGraphemes` and `_iterSegmenter` are preserved intact.
  They are still used in the non-shaper path inside `GlyphCollection.flushAsync()`.
- `GlyphCollection.flush()` (sync path) — never called `iterGraphemes`; no change.
- `GlyphAtlas.ensureGraphemes()` — unchanged; still works correctly for the atlas path.

---

## Conflict Check

- No overlap with other agents' domains. Buffer builders, shader code, group
  DataTexture, and instance attributes are untouched.
- The fix is purely at the GlyphCollection pre-dispatch layer — between `_pendingAdds`
  normalization and `bridge.buildBatchBuffers()`.
- No build step needed. Changes take effect on browser refresh.

---

## Files Changed

- `src/collections/GlyphCollection.js` — guard around `missingGraphemes` block
- `src/collections/CodeGrid.js` — `getVisibleCharCount()` rewritten, import removed
