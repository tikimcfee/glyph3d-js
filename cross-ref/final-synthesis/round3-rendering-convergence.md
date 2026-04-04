# Round 3: rendering convergence

## Settled

1. **Synthetic codepoint IDs must NOT start at 0x110000.** All three reviews flagged the 17MB DataTexture regression. The atlas map uses `charCode * 4` as a dense flat index. IDs at 0x110000 force `ceil(1114113 / 1024) = 1089` rows = 17MB. Resolution: allocate synthetic IDs densely starting at `max(existingKeys) + 1`, not at a fixed Unicode-past-max offset. Typical charsets top out around U+2606 (~9734). Synthetic IDs start at ~9735 and grow contiguously. The DataTexture stays compact (~10-15 rows). A hard cap of 4096 synthetic IDs is enforced with a console.warn at 3072.

2. **`textToGlyphs.js` line 44 is in scope.** Foundation and my own re-review both caught this omission. The file iterates via `text[i]` (splits surrogates) then calls `char.charCodeAt(0)`. Fix: iterate graphemes, look up syntheticId via `graphemeToId`. File count becomes 10: 2 new, 8 modified.

3. **`countGlyphs` (builders/index.js line 27) must match the builder's skip logic.** Editing correctly flagged that checking only four named whitespace chars misses control characters 0-8, 11-12, 14-31. The existing builder skips `charCode === 13` and `charCode === 9` explicitly, and the main loop only emits glyphs for non-whitespace. The grapheme version of `countGlyphs` must use a predicate that matches the builder's emit logic: skip single-codepoint graphemes where `codePoint <= 32`. Multi-codepoint graphemes are always counted (they are never control characters).

4. **CRLF in StringBuffer.getLine().** Editing correctly flagged that `offsets[n+1] - 1` strips `\n` but leaves `\r` for CRLF files. Resolution: normalize on construction. `this._text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')`. The builder already skips charCode 13 (line 118 of builders/index.js), so CRLF content renders correctly today -- the bug is only in StringBuffer's line extraction. Normalizing on construction is consistent with the builder's behavior and costs nothing for LF-only files (no match = no allocation).

5. **"Character" coordinate space: grapheme indices internally, UTF-16 at the LSP boundary.** All three reviews converged on this. The wire protocol (editing, Tier 2) uses UTF-16 code unit offsets per LSP convention. The renderer uses grapheme-cluster slot indices. Translation happens in one place: `CodeGrid.applyEdits()` (Tier 2 scope, not Phase 0). Phase 0 needs only to document the contract: `getSlotForChar(line, col)` expects `col` as a grapheme index. A `utf16ColToGraphemeCol(lineText, utf16Col)` adapter function is defined now (in `segmentGraphemes.js`) but not wired into any call site until editing lands.

6. **`graphemeToId` uses Map.get(), not bracket notation.** Foundation caught the Map-vs-object typo. The builder receives the grapheme map as a plain object from worker serialization (JSON keys are strings), so bracket notation is actually correct for the worker path. But `GlyphAtlas._graphemeToId` on the main thread is a Map and must use `.get()`. Both forms are correct in their respective contexts; the Phase 0 document was ambiguous. Clarified: worker path uses object bracket notation, main thread uses Map.get().

7. **StringBuffer lives at `src/collections/StringBuffer.js`.** All three agents agreed. Editing extends it with `applyEdits()` in Tier 2. Constructor signature: `new StringBuffer(text: string)`. No change from Phase 0.

8. **`charCodeAt` fix is rendering scope, not a separate PR.** Foundation defers it; rendering owns it. Both editing and foundation confirmed rendering is correct. The fix is inseparable from grapheme iteration and StringBuffer -- splitting them creates a window where line counts disagree between buffer and builder.

9. **Version field: ship as optional/nullable in Tier 1, implement conflict logic in Tier 2.** Foundation and editing both have valid points. Add `version: number | null` to `FileContent` and `FileStat` type shapes. Go relay sends `0` for Tier 1. No version-comparison logic until Tier 2.

10. **Generator vs array form in builder hot path.** Foundation recommended benchmarking `iterateGraphemes` (generator) vs `segmentGraphemes` (array). Decision: use the array form (`segmentGraphemes`) in the builder. The array is needed anyway for `countGlyphs` (pre-pass), and reusing it in the main loop avoids double-segmentation. The generator form remains exported for one-off iteration (e.g., `_ensureGlyphsInAtlas` where the array is not reused).

11. **`loadTextAsync` must preserve lazy line behavior.** Editing flagged this. `StringBuffer` already lazy-computes `_lineOffsets`. The async path calls `new StringBuffer(text)` without triggering `_getLineOffsets()`. Confirmed: no eager materialization.

## Implementation Plan

### `src/workers/builders/segmentGraphemes.js` (NEW)
As specified in Phase 0 section 2, plus:
- Add `utf16ColToGraphemeCol(lineText, utf16Col)` -- iterates graphemes, accumulates UTF-16 lengths, returns the grapheme index where the accumulated length reaches `utf16Col`. Exported but unused until Tier 2.
- `countRenderableGraphemes(graphemes)` -- replaces inline `countGlyphs`. Skips graphemes where `grapheme.length === 1 && grapheme.codePointAt(0) <= 32`.

### `src/GlyphAtlas.js` (MODIFY)
- Add `_graphemeToId = new Map()` and `_nextSyntheticId` initialized to `max(...this.uvMap.keys()) + 1` after `generate()`.
- `ensureGraphemes(graphemeStrings)`: for single-codepoint graphemes, ID = codePointAt(0) (existing path). For multi-codepoint, allocate from `_nextSyntheticId++`, cap at `_nextSyntheticId > initialMax + 4096`.
- `getGraphemeId(str)`: returns `str.length === 1 ? str.codePointAt(0) : this._graphemeToId.get(str)`.
- `_packGlyph()`: accept string argument for `ctx.fillText()`. Measure width from string, not fromCharCode.
- `_updateAtlasMapEntry`: no change needed -- it already takes a numeric key.

### `src/workers/builders/index.js` (MODIFY)
- Import `segmentGraphemes, countRenderableGraphemes` from `./segmentGraphemes.js`.
- `countGlyphs(text)` replaced by: `const graphemes = segmentGraphemes(text); const count = countRenderableGraphemes(graphemes);`
- Main loop in `buildGlyphBuffers`: iterate `graphemes[j]` instead of `text.charCodeAt(i)`. Look up syntheticId via `graphemeToId[grapheme]` (plain object from worker serialization). Use syntheticId for uvMap lookup and codepoints buffer write. Width lookup: `glyphWidths[syntheticId]`.
- `lineSlotOffsets` increments by grapheme, not by code unit. A newline grapheme (`'\n'`) triggers line boundary. Unchanged semantics, different iteration unit.
- Same treatment for `buildBatchBuffers`.

### `src/workers/builders/textToGlyphs.js` (MODIFY)
- Import `segmentGraphemes` from `./segmentGraphemes.js`.
- Replace `for (let i = 0; i < text.length; i++) { const char = text[i]; ... char.charCodeAt(0) }` with grapheme iteration. Each grapheme looks up its syntheticId via the serialized graphemeToId map.

### `src/GlyphRenderer.js` (MODIFY)
- Three sites: `_ensureGlyphsInAtlas` (line ~1100), `_textToGlyphs` (line ~1150), `applyPrebuiltBuffers` fallback (line ~1360).
- All three: replace charCodeAt iteration with `iterateGraphemes()` (generator form -- no array reuse needed in these paths).
- `_ensureGlyphsInAtlas`: call `this.atlas.ensureGraphemes(missingGraphemes)`.
- `_textToGlyphs`: use `this.atlas.getGraphemeId(grapheme)` for UV lookup.

### `src/workers/WorkerBridge.js` (MODIFY)
- `getSerializedGraphemeMap()`: returns `Object.fromEntries(atlas._graphemeToId)` -- string keys, numeric values.
- Include graphemeMap in worker job payloads alongside uvMap. Same version-bump mechanism.

### `src/workers/GlyphWorker.js` (MODIFY)
- Cache `graphemeToId` alongside `uvMap` and `glyphWidths`. Same invalidation logic.

### `src/collections/StringBuffer.js` (NEW)
As specified in Phase 0 section 6, plus:
- Constructor normalizes CRLF: `this._text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');`
- `getLine()` logic unchanged after normalization (the `-1` correctly strips LF).

### `src/collections/CodeGrid.js` (MODIFY)
As specified in Phase 0 section 7. `_buffer` field, property getters for backward compat. `getVisibleCharCount()` uses `segmentGraphemes` + `countRenderableGraphemes`.

### `src/collections/index.js` (MODIFY)
Export `StringBuffer`.

**10 files total: 2 new, 8 modified.**

## Implementer Vote

**Foundation** should implement. The rendering changes are mechanical -- iterate graphemes instead of charCodeAt, look up IDs in a map. The hardest part is the atlas `_graphemeToId` bookkeeping and the DataTexture sizing discipline, both of which require understanding the atlas internals. Foundation's review demonstrated the deepest understanding of the DataTexture regrow mechanics, the 17MB regression math, and the sparse-vs-dense tradeoff. Foundation also owns WorkerBridge serialization changes that interleave with the graphemeMap transport. The rendering agent (me) defined the plan; the foundation agent should implement it, because the implementer who best understands the failure modes will write the most defensive code.
