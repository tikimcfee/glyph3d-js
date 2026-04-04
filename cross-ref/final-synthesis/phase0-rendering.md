# Phase 0: Grapheme-Correct Rendering + TextBuffer Foundation

Implementation plan for fixing charCodeAt iteration and introducing the
StringBuffer abstraction. Every change is additive; nothing breaks existing
ASCII-only content.

---

## 1. Intl.Segmenter Compatibility Audit

### Browser support (verified March 2026)

| Browser        | Version | Released   | Notes                              |
|----------------|---------|------------|------------------------------------|
| Chrome         | 87+     | Nov 2020   | First to ship. Stable.             |
| Edge           | 87+     | Nov 2020   | Chromium-based, same as Chrome.    |
| Safari         | 15.4+   | Mar 2022   | macOS + iOS.                       |
| Firefox        | 125+    | Apr 2024   | Bug 1883914. Was behind flag before.|
| Chrome Android | 87+     | Nov 2020   |                                    |
| Safari iOS     | 15.4+   | Mar 2022   |                                    |

**Baseline 2024 "Newly available"** -- MDN marks it as working across
latest devices and browser versions since April 2024. Global coverage
is well above 90% of active browser installs.

### Web Worker support

`Intl.Segmenter` is part of the ECMAScript `Intl` namespace, which is
available in `DedicatedWorkerGlobalScope`. The builders run in Web
Workers; `Intl.Segmenter` works there in Chrome, Firefox, and Safari.
No polyfill needed for the worker path.

### Known gotchas

1. **Large strings (>40-50K chars)**: V8's implementation can hit
   "maximum call stack exceeded" due to internal recursion. Mitigation:
   chunk text at newline boundaries before segmenting. Our content is
   already line-oriented; the builder processes per-item text, typically
   single files < 500 KB. Real risk is low but chunk if needed.
2. **Performance on non-ASCII-heavy text**: Segmentation slows with
   dense emoji/CJK. For code (99%+ ASCII), segmentation is < 1 ms for
   500 KB. unicode-segmenter is 2-5x faster but adds a dependency.
3. **Firefox 124 and below**: No support. Firefox 125 shipped Apr 2024;
   users on older Firefox are a shrinking minority. Acceptable gap.

### Fallback strategy

```js
const HAS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
```

If `Intl.Segmenter` is unavailable, fall back to `codePointAt()` iteration
(correct for surrogate pairs, not for ZWJ/combining marks). This is
strictly better than the current `charCodeAt()` and covers the one
real gap (Firefox < 125). We do NOT add unicode-segmenter as a
dependency in Phase 0; the native API covers "recent browsers" fully.

---

## 2. The charCodeAt -> Grapheme Fix

### What is broken today

`src/workers/builders/index.js` lines 97 and 322:
```js
const charCode = text.charCodeAt(i);  // yields surrogate halves for emoji
```

Consequences:
- Supplementary plane chars (emoji, math symbols, CJK-B) emit TWO '?' glyphs
- `lineSlotOffsets` counts surrogate halves as separate characters
- `getVisibleCharCount()` returns wrong values for lines with emoji
- `highlightRange()` highlights wrong columns after any emoji on a line

### The fix: `segmentGraphemes()` utility

New file: `src/workers/builders/segmentGraphemes.js`

```js
/**
 * Segment text into grapheme clusters.
 * Uses Intl.Segmenter when available, falls back to codePointAt iteration.
 * Worker-safe: no DOM or Three.js imports.
 *
 * @param {string} text
 * @returns {string[]} Array of grapheme cluster strings
 */
const HAS_SEGMENTER = typeof Intl !== 'undefined'
    && typeof Intl.Segmenter === 'function';

let _segmenter = null;
function getSegmenter() {
    if (!_segmenter && HAS_SEGMENTER) {
        _segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    }
    return _segmenter;
}

export function segmentGraphemes(text) {
    const seg = getSegmenter();
    if (seg) {
        return Array.from(seg.segment(text), s => s.segment);
    }
    // Fallback: codePointAt iteration (handles surrogates, not ZWJ)
    const result = [];
    for (let i = 0; i < text.length; ) {
        const cp = text.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        result.push(ch);
        i += ch.length;  // 1 for BMP, 2 for supplementary
    }
    return result;
}

/**
 * Iterate grapheme clusters without allocating the full array.
 * Yields {segment, isWhitespace, codepoint} for single-codepoint clusters.
 */
export function* iterateGraphemes(text) {
    const seg = getSegmenter();
    if (seg) {
        for (const { segment } of seg.segment(text)) {
            yield segment;
        }
    } else {
        for (let i = 0; i < text.length; ) {
            const cp = text.codePointAt(i);
            const ch = String.fromCodePoint(cp);
            yield ch;
            i += ch.length;
        }
    }
}
```

Worker-safe (no DOM). Lazy-creates one `Intl.Segmenter` instance per
thread. The generator form avoids allocating an array in the hot builder
loop.

---

## 3. String-Keyed Atlas

### Current state

`GlyphAtlas.uvMap` is `Map<number, UV>`. The atlas map DataTexture uses
the numeric codepoint as a flat index into a 1024-wide RGBA Float texture.
The vertex shader resolves `instanceCodepoint` (a float) to UV via
`texelFetch(atlasMapTexture, codepoint)`.

### What changes

Multi-codepoint graphemes (ZWJ emoji, combining marks) cannot be
represented as a single numeric codepoint. The atlas needs to store them
by string key.

**However**: the GPU lookup path (`instanceCodepoint` -> DataTexture)
only works with numeric indices. We cannot send a string to the shader.

**Solution: synthetic codepoint IDs.**

For single-codepoint graphemes (99%+ of code text), the "synthetic ID"
is just the codepoint itself -- zero overhead, no change to the GPU path.

For multi-codepoint graphemes (ZWJ emoji, flag sequences, combining
marks), assign a synthetic ID starting at a high range (e.g., 0x110000,
one past the Unicode max). The atlas stores the mapping:

```
graphemeString -> { syntheticId, uv }
```

The DataTexture is extended to cover the synthetic range. The builder
emits the syntheticId into the `codepoints` buffer. The shader is
unchanged -- it sees a number, looks it up, gets UV.

### Changes to GlyphAtlas.js

- `uvMap`: remains `Map<number, UV>` -- keys are now syntheticIds
- New: `_graphemeToId: Map<string, number>` -- grapheme string -> syntheticId
- New: `_nextSyntheticId = 0x110000`
- `_packGlyph(charCodeOrString)`: accepts string, calls `fillText(string)`,
  assigns syntheticId for multi-codepoint graphemes
- `ensureGraphemes(graphemeStrings)`: replaces `ensureCodepoints()`.
  For single-codepoint strings, the ID is just `str.codePointAt(0)`.
  For multi-codepoint, allocates a syntheticId.
- `ensureCodepoints()`: thin wrapper that calls `ensureGraphemes()` with
  `String.fromCodePoint(cp)` for each -- backward compat.
- `getSerializableUVMap()`: keys are syntheticIds (numbers), unchanged format
- `getGraphemeId(graphemeString)`: returns the syntheticId for a grapheme

### Why this preserves the GPU path

The shader sees `instanceCodepoint = syntheticId` (a float). The
DataTexture at index `syntheticId` stores the UV rect. No shader change.
The DataTexture regrow mechanism already exists (`_regrowAtlasMap`).

---

## 4. Builder Pipeline Changes

### `src/workers/builders/index.js`

Both `buildGlyphBuffers` and `buildBatchBuffers` get the same treatment:

**Before** (line 96-97, 321-322):
```js
for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
```

**After**:
```js
import { iterateGraphemes } from './segmentGraphemes.js';

// Pre-pass: segment text into graphemes (one array, reused for counting + building)
const graphemes = segmentGraphemes(text);

// ... countGlyphs now counts graphemes, skipping whitespace graphemes
// ... main loop iterates graphemes[], not text[i]
```

Concrete changes to the main loop:
1. Iterate `graphemes[]` instead of `text.charCodeAt(i++)`
2. For each grapheme, look up `graphemeToId[grapheme]` to get the syntheticId
3. Use syntheticId for `uvMap` lookup (atlas validation) and `codepoints[idx]` write
4. Use `glyphWidths[syntheticId]` for width lookup
5. Single-codepoint ASCII graphemes (charCode 0-126) fast-path unchanged

The `countGlyphs()` function changes from charCodeAt to grapheme counting:
```js
function countGlyphs(text, graphemes) {
    let count = 0;
    for (const g of graphemes) {
        if (g !== ' ' && g !== '\n' && g !== '\r' && g !== '\t') count++;
    }
    return count;
}
```

`lineSlotOffsets` now tracks grapheme-cluster positions, not code-unit
positions. This automatically fixes `highlightRange` and `getSlotForChar`.

### Worker serialization

`WorkerBridge.getSerializedUVMap()` already serializes as `{[id]: uv}`.
Since syntheticIds are numbers, the format is unchanged. Add a new
`getSerializedGraphemeMap()` that sends `{[graphemeString]: syntheticId}`.

Workers receive both the uvMap (id->UV) and graphemeMap (string->id)
on their first job. The graphemeMap is cached alongside the uvMap with
the same versioning mechanism.

---

## 5. GlyphRenderer Changes

Three `charCodeAt` sites in `GlyphRenderer.js`:

### Line 1100: `_ensureGlyphsInAtlas`
```js
// Before:
const code = item.text.charCodeAt(i);
// After:
for (const grapheme of iterateGraphemes(item.text)) {
    if (grapheme === ' ' || grapheme === '\n') continue;
    const id = this.atlas.getGraphemeId(grapheme);
    if (id === undefined) missing.push(grapheme);
}
// Then: this.atlas.ensureGraphemes(missing);
```

### Line 1150: `_textToGlyphs` (sync path)
Same grapheme iteration.

### Line 1360: `applyPrebuiltBuffers` fallback itemMeta computation
Same grapheme iteration for counting.

---

## 6. StringBuffer (Phase 1: Read-Only)

### `src/collections/StringBuffer.js` (NEW)

Minimal implementation -- storage only, no editing logic:

```js
export class StringBuffer {
    constructor(text = '') {
        this._text = text;
        this._lineOffsets = null;  // lazy
    }

    getText() { return this._text; }

    getLine(n) {
        const offsets = this._getLineOffsets();
        if (n < 0 || n >= offsets.length) return '';
        const start = offsets[n];
        const end = n + 1 < offsets.length ? offsets[n + 1] - 1 : this._text.length;
        return this._text.substring(start, end);
    }

    getLineCount() { return this._getLineOffsets().length; }

    getLines() { return this._text.split('\n'); }

    _getLineOffsets() {
        if (this._lineOffsets) return this._lineOffsets;
        const offsets = [0];
        for (let i = 0; i < this._text.length; i++) {
            if (this._text.charCodeAt(i) === 10) offsets.push(i + 1);
        }
        this._lineOffsets = offsets;
        return offsets;
    }
}
```

No `applyEdits()`. No inverse computation. No treeSitterDescs. Those
come in Phase 1+ when editing is actually built. The read-only buffer
is ~30 lines of code.

---

## 7. CodeGrid API Migration

### `src/collections/CodeGrid.js` (MODIFY)

```js
import { StringBuffer } from './StringBuffer.js';

// In constructor:
this._buffer = new StringBuffer('');

// Replace direct content/lines usage:
get content() { return this._buffer.getText(); }
set content(text) { this._buffer = new StringBuffer(text); }
get lines() { return this._buffer.getLines(); }
```

Methods that change:

| Method | Change |
|--------|--------|
| `loadText()` | `this._buffer = new StringBuffer(text);` instead of `this.content = text; this.lines = text.split('\n');` |
| `loadTextAsync()` | Same buffer creation |
| `clear()` | `this._buffer = new StringBuffer('');` |
| `getLineCount()` | `return this._buffer.getLineCount();` |
| `getMaxLineWidth()` | Iterate via `_buffer.getLine(n).length` |
| `getVisibleCharCount()` | Use grapheme iteration on `this._buffer.getLine(line)` |

The `content` and `lines` getters provide backward compatibility.
External code reading `grid.content` or `grid.lines` is unaffected.

---

## 8. slotToPos: Grapheme-Aware Slot Mapping

`lineSlotOffsets` already tracks "which buffer slot starts each line."
The builder produces this in the same pass that builds geometry. With
grapheme iteration, the offsets automatically count grapheme clusters
instead of code units. No separate fix needed.

`getSlotForChar(line, col)` where `col` is "visible character index" now
means "visible grapheme index." This is the correct semantic for cursor
positioning (one arrow-key press = one grapheme cluster).

`getVisibleCharCount(line)` must switch from `charCodeAt` to grapheme
iteration to count grapheme clusters instead of code units. This is a
2-line change using `segmentGraphemes()`.

---

## 9. File Change Summary

| File | Action | What Changes |
|------|--------|-------------|
| `src/workers/builders/segmentGraphemes.js` | NEW | `segmentGraphemes()`, `iterateGraphemes()`, fallback logic |
| `src/workers/builders/index.js` | MODIFY | Replace `charCodeAt(i)` loops with grapheme iteration; `countGlyphs()` counts graphemes; `lineSlotOffsets` counts graphemes |
| `src/GlyphAtlas.js` | MODIFY | `_graphemeToId` map, `ensureGraphemes()`, `getGraphemeId()`, `_packGlyph()` accepts string, syntheticId allocation |
| `src/GlyphRenderer.js` | MODIFY | 3 `charCodeAt` sites -> grapheme iteration in `_ensureGlyphsInAtlas`, `_textToGlyphs`, `applyPrebuiltBuffers` fallback |
| `src/workers/WorkerBridge.js` | MODIFY | Serialize `graphemeToId` map alongside uvMap; same versioning |
| `src/workers/GlyphWorker.js` | MODIFY | Cache `graphemeToId` alongside uvMap/glyphWidths |
| `src/collections/StringBuffer.js` | NEW | Read-only flat-string buffer with lazy line index |
| `src/collections/CodeGrid.js` | MODIFY | `_buffer` field, property getters, `getVisibleCharCount()` uses graphemes |
| `src/collections/index.js` | MODIFY | Export StringBuffer |

**9 files total: 2 new, 7 modified.**

---

## 10. What NOT To Build Yet

- **Cursor / caret rendering** -- no editing means no cursor
- **EditorInputManager** -- keystroke handling deferred to editing phase
- **EditHistory / undo-redo** -- requires editing
- **StringBuffer.applyEdits()** -- the method signature can be stubbed but
  the implementation is deferred; no consumers exist yet
- **treeSitterDescs** -- premature optimization for a non-existent consumer;
  the adversarial review correctly flagged TextEncoder allocations as waste
- **PieceTableBuffer / CRDTBuffer** -- Phase 4-5 fantasy; build when needed
- **unicode-segmenter dependency** -- `Intl.Segmenter` covers all target
  browsers; add the npm package only if a real gap emerges
- **getTextClusters() API** -- experimental, not stable in any browser
- **Arabic/Devanagari contextual shaping** -- Phase 3, requires shaped runs
- **WebGPU compute pipeline** -- Phase 4, requires full architecture port

---

## 11. Verification Plan

1. **ASCII-only regression**: existing content must render identically.
   Single-codepoint ASCII graphemes fast-path through unchanged logic.
2. **Emoji test**: render a file containing U+1F600 (grinning face),
   ZWJ family emoji, flag sequences. Should produce one glyph per
   grapheme cluster, not two '?' per surrogate pair.
3. **lineSlotOffsets correctness**: highlight a range on a line
   containing emoji. The highlighted columns should align with visual
   grapheme positions.
4. **Worker path**: verify graphemeToId map is serialized and cached
   correctly. Worker builds should produce identical output to sync path.
5. **Atlas regrow**: synthetic IDs above 0x110000 trigger DataTexture
   regrow. Verify the regrow path handles the larger range.
6. **Firefox < 125 fallback**: disable `Intl.Segmenter` manually, verify
   `codePointAt` fallback produces correct surrogate-pair handling (emoji
   render as single replacement glyph, not two '?').
