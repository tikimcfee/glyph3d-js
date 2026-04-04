# Phase 0 Analysis: Caching — Shaping/Serialization Hot Path

Agent perspective: data repetition, caching shaped results, glyph ID reuse, deduplication opportunities.

## 1. What shapeText Returns (and What Is Cacheable)

`shapeText()` (`src/shaping/shapeText.js`, lines 27-43) splits text on `\n`, calls `shaper.shape(lineText)` per non-empty line, and returns:

```js
{ lines: [{ shaped: [{g, cl, ax, ay, dx, dy, flags}], text }], totalGlyphs: number }
```

`shaper.shape()` (`src/shaping/HarfBuzzShaper.js`, lines 87-108) creates a WASM buffer, calls `buffer.addText()`, `buffer.guessSegmentProperties()`, `this._hb.shape()`, then `buffer.json()`. That JSON parse (`src/shaping/vendor/hbjs.js`, lines 1302-1311) serializes the WASM buffer to a JSON string, parses it back, and patches the `fl` -> `flags` field. This is the WASM round-trip that costs 23.2% of total time across 951 files.

**Key insight**: For Cousine-Regular (monospace), the shape() output is **entirely determined by the input string**. There are no contextual shaping features that depend on surrounding text -- no ligatures, no kerning pairs, no GSUB/GPOS substitutions that change output per context. Every character maps 1:1 to a fixed glyph ID with a fixed advance.

## 2. Per-Character Caching: The Nuclear Option

For a monospace font, each Unicode codepoint always produces:
- Same `g` (glyph ID)
- Same `ax` (advance width -- identical for all visible glyphs in a monospace font)
- `ay` = 0 always (horizontal text)
- `dx` = 0 always (no positioning offsets in monospace)
- `dy` = 0 always
- `cl` = cluster index (position-dependent, not cacheable from shape output -- but trivially reconstructible as it equals the character index for 1:1 mappings)
- `flags` = typically 0

**Proposed: `Map<codepoint, {g, ax}>` lookup table.**

After shaping ~128 representative characters (ASCII + common Latin-1) during font init, we have a complete lookup table. For the 95 printable ASCII characters that dominate source code, the table is **95 entries x ~16 bytes = ~1.5KB**.

This means for every subsequent `shapeText()` call, we can:
1. Split on `\n` (unchanged)
2. For each line, iterate codepoints and look up `{g, ax}` from the table
3. For any unknown codepoint (rare: emoji, CJK), fall back to `shaper.shape()` for just that character, cache the result
4. Reconstruct `cl` as the running character index
5. Set `ay=0, dx=0, dy=0` (monospace invariant)

**Elimination rate**: ~100% of HarfBuzz WASM calls after init. The 951 `shape()` calls (one per file, one per line within each file) drop to ~0.

## 3. Per-Line Caching: The Practical Middle Ground

Even without the per-character optimization, line-level dedup is highly effective. Source code files share enormous numbers of identical lines:

- Empty lines (very common -- probably 15-25% of all lines)
- `}` (closing braces alone)
- `import` statements (many repos have near-identical import blocks)
- Common patterns: `export default`, `return null;`, `break;`, `case:`
- Indentation-only differences make this less effective than per-character, but still valuable

**Proposed: `Map<string, shaped[]>` line cache.**

`shapeText()` already iterates per-line (line 32). Insert a cache check:

```js
// shapeText.js line 32-39 currently:
for (const lineText of rawLines) {
    if (lineText.length === 0) { lines.push({ shaped: [], text: lineText }); continue; }
    const shaped = shaper.shape(lineText, features);
    lines.push({ shaped, text: lineText });
    totalGlyphs += shaped.length;
}
// With line cache:
for (const lineText of rawLines) {
    if (lineText.length === 0) { lines.push({ shaped: [], text: lineText }); continue; }
    let shaped = lineCache.get(lineText);
    if (!shaped) { shaped = shaper.shape(lineText, features); lineCache.set(lineText, shaped); }
    lines.push({ shaped, text: lineText });
    totalGlyphs += shaped.length;
}
```

**Memory cost**: For 951 source files averaging ~100 lines each, worst case is ~95,000 unique lines. Realistic unique count is likely 30,000-50,000 (substantial overlap). Each cached shaped array for a 40-char average line is ~40 objects x 7 fields x 8 bytes = ~2.2KB. Total cache: ~66-110MB. **This is too expensive** for line-level caching of the full shaped objects.

However, if we use per-character caching (section 2), line caching becomes unnecessary -- per-character is strictly better for monospace.

## 4. What buildBatchBuffers Actually Consumes

`buildBatchBuffers()` (`src/workers/builders/index.js`, lines 95-324) consumes the shaped data in a tight inner loop (lines 193-239). For each shaped glyph `sg`, it reads:

| Field | Used at line | Purpose |
|-------|-------------|---------|
| `sg.g` | 195 | Glyph ID -- written to `glyphIdsArr[idx]` (line 228) |
| `sg.ax` | 196 | Advance width -- `sg.ax / upem * ws * scale` for position + size |
| `sg.dx` | 199 | X offset -- baked into position (line 223) |
| `sg.dy` | 199 | Y offset -- baked into position (line 224) |

**Not used**: `sg.cl` (cluster), `sg.ay` (vertical advance), `sg.flags`.

Three of the seven fields in each shaped glyph object are dead weight through the entire pipeline. They are serialized from WASM, parsed from JSON, transferred via structured clone to workers, iterated in the builder -- and never read.

**For monospace with per-character cache**: `dx` and `dy` are always 0. The builder only needs `g` and `ax`. And since `ax` is identical for all glyphs in a monospace font, it could be a single constant rather than per-glyph data.

## 5. SlugEncoder and Glyph Reuse

`SlugEncoder` (`src/shaping/SlugEncoder.js`) runs **once at init** (line 59-231), not per-file. It receives a `Set<number>` of unique glyph IDs and encodes each glyph's outline curves into GPU textures. It does not cache anything internally -- it processes each glyph ID exactly once via `_encodeGlyph()` (line 244).

The `collectUniqueGlyphIds()` helper (`src/shaping/shapeText.js`, lines 54-62) iterates all shaped lines to build a `Set<number>` of glyph IDs. Currently called once during init with a probe string (GitHubRepoViewer.js, lines 265-268). This is already efficient -- no caching needed here.

**No overlap with the hot path**. SlugEncoder is init-only. The shaping hot path is the 951 per-file calls.

## 6. The WASM Serialization Overhead

The `buffer.json()` call (`src/shaping/vendor/hbjs.js`, line 1302-1311) does:
1. `this.serialize()` -- WASM serializes buffer to a JSON **string** in WASM memory
2. `JSON.parse(buf)` -- Parse that string into JS objects
3. `.forEach()` -- Iterate to rename `fl` -> `flags` (allocating a new property per glyph)

For a 100-character line, this creates 100 JS objects with 7 properties each. For 951 files averaging 100 lines x 40 chars = ~3.8 million glyph objects created, GC'd, and never fully consumed (3 of 7 fields unused).

**With per-character caching, this entire path is eliminated.** The 95 ASCII lookups during init are the only WASM calls ever made.

## 7. The Structured Clone Cost

`WorkerBridge.buildBatchBuffers()` (lines 118-152) shapes on the main thread, then posts shaped results to workers via `postMessage()`. The shaped data is plain JSON (arrays of objects), so structured clone must deep-copy every object. For a file with 4,000 glyphs, that is 4,000 objects x 7 numeric fields being cloned.

**With per-character caching**: Instead of transferring shaped arrays, the worker could receive:
- The raw text string (already a single transferable string)
- The per-character lookup table (transferred once at init, ~1.5KB)
- Workers reconstruct shaped data locally from the lookup + text

This would **eliminate shaped data from postMessage entirely**. The payload shrinks from `{text, shaped: {lines: [{shaped: [{g,cl,ax,ay,dx,dy,flags}, ...]}]}}` to just `{text}`.

## 8. Concrete Caching Strategy

### Tier 1: Per-Codepoint Lookup Table (eliminates ~100% of WASM calls)

```js
// In HarfBuzzShaper or a new ShapeCache class
class MonospaceShapeCache {
    constructor(shaper) {
        this._map = new Map();        // codepoint -> {g, ax}
        this._shaper = shaper;
        this._monospaceAdvance = 0;   // single advance for all glyphs
    }
    prime(text) {
        // Shape representative text once, populate map
        const shaped = this._shaper.shape(text);
        for (let i = 0; i < shaped.length; i++) {
            const cp = text.codePointAt(shaped[i].cl);
            if (!this._map.has(cp)) {
                this._map.set(cp, { g: shaped[i].g, ax: shaped[i].ax });
                if (!this._monospaceAdvance) this._monospaceAdvance = shaped[i].ax;
            }
        }
    }
    // Returns shaped-compatible array for a single line
    shapeLine(lineText) {
        const result = new Array(lineText.length);
        for (let i = 0; i < lineText.length; i++) {
            const cp = lineText.codePointAt(i);
            let entry = this._map.get(cp);
            if (!entry) {
                // Fallback: shape single char, cache it
                const shaped = this._shaper.shape(String.fromCodePoint(cp));
                entry = { g: shaped[0].g, ax: shaped[0].ax };
                this._map.set(cp, entry);
            }
            result[i] = { g: entry.g, cl: i, ax: entry.ax, ay: 0, dx: 0, dy: 0 };
        }
        return result;
    }
}
```

**Memory**: 256 entries (full ASCII + Latin-1) x 12 bytes = **3KB**. Trivial.

### Tier 2: Eliminate Shaped Object Allocation in Builder

Since `buildBatchBuffers` only reads `sg.g` and `sg.ax` (plus `sg.dx`/`sg.dy` which are always 0 for monospace), the builder could accept a more compact representation:

- A `Uint16Array` of glyph IDs (one per character)
- A single `monospaceAdvance` number

This replaces 7-field JS objects with a typed array -- dramatically reducing GC pressure and structured clone cost. The builder's inner loop (lines 193-239) would become:

```js
for (let ci = 0; ci < lineGlyphIds.length; ci++) {
    const glyphId = lineGlyphIds[ci];
    const advance = monospaceAdvance / upem * ws * scale;
    // ... write buffers (no sg.dx, sg.dy -- they're 0)
}
```

### Tier 3: Worker-Side Reconstruction

Transfer the codepoint->glyphId map once to each worker (1.5KB). Workers receive only raw text strings. Workers reconstruct glyph IDs locally from the map. This eliminates all shaped data from structured clone.

## 9. Estimated Impact

| Metric | Current (951 files) | With per-codepoint cache |
|--------|-------------------|------------------------|
| WASM shape() calls | ~95,000 (est. lines) | 95 (init only) |
| JS object allocations | ~3.8M glyph objects | 0 |
| JSON.parse calls in WASM | ~95,000 | 95 |
| postMessage payload (shaped) | ~30MB est. | ~0 (text only) |
| Main thread shaping time | 23.2% of total | <0.1% est. |
| Cache memory cost | 0 | ~3KB |

## 10. Risk Assessment

**Low risk**: Cousine-Regular is confirmed monospace (CLAUDE.md: "monospace font"). The 1:1 codepoint-to-glyph mapping is a font-level invariant. No OpenType features in the current pipeline produce context-dependent results.

**Edge case**: Surrogate pairs / multi-codepoint sequences (emoji, combining marks). The per-character cache uses `codePointAt()` which handles supplementary plane characters correctly. Combining marks (rare in source code) would need fallback to HarfBuzz for the combining sequence -- but these are <0.01% of source code characters.

**Validation**: After implementing, compare shaped output of the cache vs. HarfBuzz for a sample of files. Any mismatch indicates a non-monospace behavior that needs the fallback path.
