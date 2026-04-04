# Round 1 -- Shaping Reviews Caching + Transfer

Reviewer: **Shaping agent**
Reviewed: **phase0-Caching.md**, **phase0-Transfer.md**

---

## Errors Found

### 1. Caching: `sg.cl` listed as "not used" -- incorrect for highlight/picking pipelines

Caching (section 4) states that `sg.cl` (cluster), `sg.ay`, and `sg.flags` are "dead weight through the entire pipeline." This is true within `buildBatchBuffers` (builders/index.js:194-241), but `cl` is consumed downstream by `CodeGrid._lineSlotBase` bookkeeping and the semantic info map's token-to-glyph resolution (`SemanticInfoMap`). The builder does not read `cl` directly, but the shaped output is also used by `collectUniqueGlyphIds` (shapeText.js:54-62) and callers that index shaped results by cluster. Eliminating `cl` from the shaped representation would break the per-character cache's `shapeLine()` contract if any consumer outside the builder ever reads it. Low severity today, but the claim "never read" is scoped too narrowly.

### 2. Caching: 32KB malloc claim is per-`serialize()` call, not per-line

Caching (section 6) says `serialize()` creates 100 JS objects with 7 properties "per line." The 32KB allocation cited in my own Phase 0 (section 2, step 4) comes from hbjs.js:1259 (`var bufLen = 32 * 1024`). That 32KB is a single reusable C heap buffer for the serialize loop -- it is allocated and freed once per `serialize()` call, not per glyph. Caching's section 6 conflates the 32KB with per-glyph object cost. The real per-glyph cost is the JS object allocation (7 properties each), not the WASM-side buffer.

### 3. Transfer: Round-robin claim is wrong -- entire batch goes to one worker

Transfer (section 6) says "round-robin dispatch sends the entire batch to one worker" and proposes splitting across N workers. This is **correct as a factual observation** -- `buildBatchBuffers()` (WorkerBridge.js:126) calls `this._getNextWorker()` once and sends the full batch to that single worker. However, the framing "If we split the batch across N workers" implies round-robin already distributes; it does not. The current code picks one worker per `buildBatchBuffers()` call. Multiple concurrent `flushAsync()` calls would hit different workers, but a single flush of 951 items goes to exactly one worker. The fix Transfer proposes is valid; the description of the status quo is slightly muddled.

### 4. Transfer: Data volume estimate uses wrong per-glyph overhead

Transfer (section 1) estimates structured clone at ~88 bytes/glyph (56 bytes for 7 doubles + 32 bytes object header). V8's structured clone serialization format for small plain objects is closer to ~64-72 bytes (tagged values, not raw doubles, plus a 2-byte property count header -- no full hidden class pointer is serialized). The total for 5.7M glyphs would be ~365-410 MB, not ~500 MB. The qualitative conclusion (too expensive) remains valid, but the numbers are inflated by ~25%.

### 5. Caching: `monospaceAdvance` assumption is too strong

Caching (section 2) states "ax is identical for all visible glyphs in a monospace font." This is true for most printable characters, but Cousine-Regular has zero-width glyphs (e.g., soft hyphen U+00AD, zero-width space U+200B, combining marks) where `ax = 0`. The current builder already handles this via `_emptyGlyphs.has(glyphId)` at builders/index.js:213. A `monospaceAdvance` constant would still be correct for the common path, but the cache must not assume ALL `ax` values are equal -- the `_emptyGlyphs` set handles the exceptions today, and the cache lookup table must preserve per-codepoint `ax` for correctness.

---

## Gaps

### 1. Neither doc addresses the `buffer.destroy()` lifecycle in a caching world

If per-codepoint caching eliminates all runtime `hb_shape()` calls, the WASM buffer/font objects become init-only resources. Neither doc discusses when/whether to call `font.destroy()` or free the WASM module after priming the cache. For the 2-shaping-worker architecture I proposed, workers that never call `hb_shape()` after init don't need to keep the ~16MB WASM heap alive. This is a potential ~32MB memory saving that nobody mentions.

### 2. Transfer doc ignores atlas UV map transfers

`WorkerBridge` (line 638 in GlyphCollection.js, and the `_ensureUVMapSerialized` path) also transfers the atlas UV map to workers. For large charsets this can be 100KB+. The Transfer doc focuses exclusively on shaped data but the UV map is also structured-cloned on first dispatch and whenever the atlas version changes. With per-codepoint caching, workers would also need the `codepoint -> glyphId` map, adding another small transfer. Neither doc accounts for this.

### 3. Caching doc doesn't address cache invalidation for font changes

The caching strategy assumes one font for the lifetime of the app. If the user ever switches fonts (which the architecture supports via `HarfBuzzShaper.setFont()`), the entire per-codepoint cache is invalid. No invalidation hook is proposed.

### 4. Transfer doc omits the return path

Transfer analyzes the outbound `postMessage` (main -> worker) but never discusses the worker -> main return transfer. `buildBatchBuffers` returns `{positions, sizes, codepoints, colors, count}` as Float32Arrays. These are already Transferable (WorkerBridge.js:169+ likely uses transfer list). If not, that's another structured clone cost. Neither doc checks whether the return path currently uses Transferable.

---

## Tensions

### 1. Per-codepoint cache vs. dedicated shaping workers

Caching proposes eliminating ~100% of WASM calls via a lookup table. My Phase 0 proposes 2 dedicated shaping workers to parallelize WASM calls. These are **mutually exclusive** at full implementation: if the cache eliminates all WASM calls, the shaping workers have nothing to do. The correct resolution is: implement per-codepoint cache first (Caching's Tier 1); if cache hit rate is <99% (non-monospace future fonts, complex scripts), then add shaping workers as a fallback path. The 2-worker architecture becomes a Phase 2 insurance policy, not a Phase 1 deliverable.

### 2. Transfer's Float32Array packing vs. Caching's "just send text"

Transfer proposes packing shaped data into `Float32Array` + `Int32Array` and transferring them. Caching (section 7, Tier 3) proposes sending only raw text strings plus a 1.5KB lookup table, with workers reconstructing shaped data locally. The Caching approach is strictly better for monospace: zero transfer cost for shaped data, and workers do trivial table lookups instead of receiving pre-packed arrays. Transfer's approach is the correct fallback for non-monospace fonts where the cache can't be used. These should be presented as two tiers of the same strategy, not competing alternatives.

### 3. "Quick win" overlap: both propose different first steps

My Phase 0 recommends replacing `buffer.json()` with direct HEAP reads as step 1 (~35% savings). Transfer recommends stripping dead fields before `postMessage` as step 1 (~20% savings). Caching implicitly recommends the per-codepoint cache as step 1 (which obsoletes both). The per-codepoint cache is actually the smallest code change (a ~40-line class + 3-line edit to `shapeText.js`) with the largest impact (~58% savings by eliminating all WASM calls). The HEAP read optimization only matters if we keep calling HarfBuzz at all.

---

## Recommendations

1. **Implement per-codepoint cache first** (Caching Tier 1). This is the highest-impact, lowest-risk change. It eliminates `hb_shape()` + `buffer.json()` entirely for monospace. Add a validation pass: shape 1000 random lines via HarfBuzz, compare against cache output, assert equivalence.

2. **Keep `buffer.json()` -> direct HEAP read replacement as the fallback path** for cache misses (rare codepoints, future non-monospace fonts). My Phase 0 `shapeDirect()` becomes the slow path inside `MonospaceShapeCache` for unknown codepoints, not the primary optimization.

3. **Strip dead fields from postMessage immediately** (Transfer quick win). This is a 5-minute change at WorkerBridge.js:132-135 -- drop `text`, `id`, `options` from the spread. Do this regardless of other work.

4. **Send raw text + lookup table to workers** (Caching Tier 3) rather than pre-packed Float32Arrays (Transfer section 3). For monospace, this eliminates shaped data from the transfer entirely. Workers reconstruct glyph IDs from the table locally.

5. **Verify the return path uses Transferable**. Check if `GlyphWorker.js` calls `postMessage(result, [transferList])` for the Float32Array buffers it sends back. If not, fix it -- this is potentially another large structured clone cost that nobody has profiled.

6. **Add cache invalidation on font change**. `HarfBuzzShaper.setFont()` (or a new `MonospaceShapeCache.invalidate()`) must clear the lookup table.

7. **Defer the 2-shaping-worker architecture** until a non-monospace font is needed. The per-codepoint cache makes dedicated shaping workers unnecessary for Cousine-Regular.

8. **Profile after cache implementation** before pursuing SharedArrayBuffer or further transfer optimizations. The cache may reduce total shaping+serialize time from ~58% to <1%, making the remaining transfer cost (~2-3% of a much smaller payload) not worth optimizing.

9. **Account for `_emptyGlyphs` in the cache**. The `MonospaceShapeCache.shapeLine()` must produce glyph IDs that the builder's `_emptyGlyphs.has(glyphId)` check at builders/index.js:213 handles correctly. Spaces and .notdef glyphs must map to the right glyph IDs, not be skipped by the cache.

10. **Do not free the WASM module after priming**. Keep it alive for the fallback path (unknown codepoints, validation). The ~16MB cost is acceptable for correctness insurance.

---

## Key Insight

The three agents independently converged on the same bottleneck (WASM serialize round-trip) but proposed solutions at three different layers: I proposed fixing the serialization itself (HEAP reads), Caching proposed bypassing HarfBuzz entirely (lookup table), and Transfer proposed fixing the worker transfer format (Float32Array). **These are not competing -- they are three layers of the same onion.** The correct ordering is inside-out: eliminate the WASM calls first (cache), fix the serialization for the remaining calls (HEAP reads), then fix the transfer for whatever data still crosses the worker boundary (Transferable arrays). Implemented in this order, each subsequent layer has dramatically less data to optimize, and the total code change is smaller than any single proposal executed in isolation.
