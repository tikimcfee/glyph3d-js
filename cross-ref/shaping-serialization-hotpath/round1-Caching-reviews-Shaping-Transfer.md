# Round 1: Caching Reviews Shaping + Transfer

Agent: Caching | Reviewing: Shaping (phase0-Shaping.md) + Transfer (phase0-Transfer.md)

---

## Errors Found

### E1. Transfer: "round-robin sends the entire batch to one worker" is misleading

Transfer section 6 states: "round-robin dispatch (WorkerBridge.js:159-163) sends the entire batch to one worker." This is technically correct -- `_getNextWorker()` returns a single worker per `buildBatchBuffers()` call -- but the phrasing implies a design flaw in the round-robin system. The round-robin is per-`buildBatchBuffers` invocation, not per-item. When `flushAsync()` calls `bridge.buildBatchBuffers(items, ...)` at GlyphCollection.js:638, the entire pending batch goes to one worker because it is one call. The round-robin only helps when multiple collections flush independently. The recommendation to "split batches across workers" (Transfer section 6) is valid, but the framing misattributes the cause to the round-robin algorithm rather than the call-site granularity.

### E2. Transfer: structured clone volume estimate is inflated

Transfer section 1 estimates ~88 bytes/glyph for structured clone (56 bytes for 7 doubles + 32 bytes object header). V8's structured clone does not store each numeric property as a 64-bit double with a separate hidden class pointer per object in the serialized stream. The actual serialized format is more compact -- roughly 8 bytes per double + 1-2 bytes per property key reference + ~8 bytes per object header in the serialization wire format. Realistic per-glyph cost is closer to ~64 bytes (7 x 8 + ~8 header). The 525 MB total is therefore more like ~365 MB. Still terrible, but the 500 MB figure should not be taken as precise.

### E3. Shaping: `getGlyphInfos`/`getGlyphPositions` still allocate JS objects

Shaping section 2 correctly notes that `getGlyphInfosAndPositions` "still allocates JS objects per glyph" but then proposes an intermediate step (section 5) using `getGlyphInfos()` and `getGlyphPositions()` which allocates two separate arrays of JS objects. At hbjs.js:1140-1147 and 1168-1177, these functions `push()` new objects in a loop. The "quick win" code at section 5 (the first code block) would create `len` info objects + `len` position objects + `len` result objects = 3x object allocation vs. the current 1x from `buffer.json()`. The allocation count per glyph would actually increase, partially offsetting the JSON.parse savings. The `shapeDirect` variant (second code block) using raw HEAP reads is the correct approach -- the intermediate step should be skipped entirely.

### E4. Shaping: profile percentage overlap

Shaping section 2 attributes "~23%" to `hb_shape()`, "~20%" to `json/glyphToJson`, and "~15.6%" to `serialize`, totaling ~58.6%. But the `serialize` call is invoked from within `buffer.json()`, so the 20% and 15.6% are not additive -- serialize is a child of json. The actual breakdown is: `hb_shape()` ~23% + `buffer.json()` total ~35% (of which ~15% is serialize, ~15% is JSON.parse, ~5% is the forEach/delete). The "total 58%" figure in section 7 may be correct if the profiler shows exclusive (self) time rather than inclusive, but the document's presentation conflates the two. This matters for setting expectations on the "~35% reduction" claim -- it is valid only if the 35% is the full inclusive cost of `buffer.json()`.

---

## Gaps

### G1. Neither document addresses the `flags` property deletion deopt

Shaping section 2 mentions `delete glyph.fl` as a V8 deoptimization but neither document quantifies it. The `delete` operator on line 1309 of hbjs.js forces V8 to transition the object to dictionary mode (slow properties). Every glyph object produced by `buffer.json()` is in dictionary mode for its entire lifetime -- including during structured clone serialization and the builder's inner loop. This compounds both the serialize cost (Transfer) and the builder iteration cost. The per-character cache (my proposal) eliminates this entirely, but if Shaping's `shapeDirect` is implemented as a standalone first step, the `delete` deopt disappears too. Both documents should note that even a trivial patch -- replacing `delete glyph.fl` with simply not calling `buffer.json()` at all -- yields a V8 hidden-class win independent of the larger refactor.

### G2. Transfer does not account for the UV map transfer

WorkerBridge sends a serialized UV map to workers (referenced in GlyphCollection.js:616-617 comment about `_hasUVMap` flags and version counter). This is an additional structured clone payload per worker that Transfer does not mention. For large atlas character sets it could be non-trivial. The Transferable ArrayBuffer strategy should include the UV map.

### G3. Neither document addresses surrogate pair / multi-codepoint handling in the typed array layout

My phase 0 (Caching) proposed `codePointAt()` for the per-character cache, but Shaping's `shapeDirect` reads glyph count from `buffer.getLength()`, which returns the number of shaped glyphs -- not the number of input codepoints. For characters outside the BMP (e.g., emoji), one codepoint may produce multiple glyphs, or multiple codepoints may merge into one glyph (ligatures). The flat `Float32Array` layout in both Shaping and Transfer proposals uses `len * 4` stride, where `len` comes from the buffer. This is correct for the typed array, but the line-offset bookkeeping needs to track glyph count per line, not character count. Neither document specifies this distinction clearly.

### G4. Transfer omits the `emptyGlyphs` set handling

The current `shared.emptyGlyphs` (WorkerBridge.js:148) is a Set, which structured clone handles. The Transferable strategy (Transfer section 3) moves everything to flat arrays but keeps `shared` as structured-clone. The `emptyGlyphs` Set is used by the builder at index.js:213 (`_emptyGlyphs.has(glyphId)`) in the inner loop. For peak performance, this should be a `Uint8Array` bitmap indexed by glyph ID, not a Set. Neither document suggests this.

---

## Tensions

### T1. Per-character cache (Caching) vs. shapeDirect HEAP reads (Shaping)

My per-character cache eliminates WASM calls entirely for monospace fonts. Shaping's `shapeDirect` keeps all WASM calls but makes each one cheaper. These are not competing -- they are complementary layers: the cache is the fast path, `shapeDirect` is the fallback for unknown codepoints. But the implementation order matters: if `shapeDirect` ships first, the per-character cache still eliminates 99.9%+ of calls. If the per-character cache ships first, `shapeDirect` becomes the rare fallback path and its optimization has minimal impact. The priority should be: per-character cache first, `shapeDirect` as the fallback implementation inside the cache miss path.

### T2. Shaping workers (Shaping section 4) vs. Transferable elimination (Transfer)

Shaping proposes 2 dedicated shaping workers (section 4) with 16MB WASM each. Transfer proposes Transferable ArrayBuffers to eliminate structured clone cost. If the per-character cache eliminates ~100% of WASM calls (my analysis), dedicated shaping workers become unnecessary -- there is nothing to parallelize. The 32MB memory budget for shaping workers would be wasted. The shaping worker proposal only makes sense if the per-character cache is rejected or insufficient.

### T3. "Quick win" ordering conflicts

Shaping recommends: (1) replace `buffer.json()` with HEAP reads, (2) shaping workers, (3) pipeline streaming. Transfer recommends: (1) strip dead fields, (2) Transferable arrays, (3) split batches. My analysis recommends: (1) per-character cache, (2) compact builder input format, (3) worker-side reconstruction. All three "step 1" items are different. They need a unified sequencing.

---

## Recommendations

1. **Ship per-character cache first.** It eliminates the WASM bottleneck at its source (~23% of total time) with ~50 lines of code and ~3KB memory. Shaping's `shapeDirect` becomes the cache-miss fallback path.

2. **Implement `shapeDirect` as the cache-miss path**, not as a standalone optimization. Use the raw HEAP read approach (Shaping section 5, second code block). Skip the intermediate `getGlyphInfos()`/`getGlyphPositions()` step -- it increases object allocation count.

3. **Strip dead fields immediately** (Transfer section 7). Five minutes of work, measurable clone reduction. Drop `text`, `id`, `options` from shapedItems before postMessage. This is orthogonal to everything else and can ship today.

4. **Move to Transferable `Float32Array` for shaped data** (Transfer section 3). With the per-character cache, the shaped data is already trivially packable -- the cache produces `{g, ax}` tuples, which pack directly into a typed array without the intermediate object step.

5. **Do not implement dedicated shaping workers** unless profiling after steps 1-4 shows remaining WASM cost. The per-character cache should reduce WASM calls to near-zero, making 2x16MB shaping workers an unnecessary memory cost.

6. **Convert `emptyGlyphs` to a `Uint8Array` bitmap** indexed by glyph ID. The builder's inner loop checks `_emptyGlyphs.has(glyphId)` per glyph (index.js:213). A bitmap lookup is O(1) with no hash overhead, and it is trivially transferable.

7. **Use `Uint16Array` for glyph IDs, not `Float32Array`**, in the packed transfer format. Glyph IDs for Cousine-Regular are well under 65535. `Uint16Array` halves the transfer size for the ID channel and avoids float-to-int conversion in the builder.

8. **Validate the monospace invariant at init.** Shape a representative string, verify all visible glyphs have identical `ax` values. If any differ, fall back to per-character cache with variable advance. If the font changes in the future, this guard prevents silent rendering bugs.

9. **Unify line-offset bookkeeping around glyph count, not character count.** Both Shaping and Transfer proposals use glyph-count-based offsets, which is correct. But the per-character cache implicitly assumes 1 glyph per codepoint (true for monospace ASCII, potentially false for combining marks). The cache's `shapeLine()` method should return a glyph count alongside the result array, and the line-offset array should use that count.

10. **Defer SharedArrayBuffer** (Transfer section 5). The COOP/COEP header requirement adds deployment friction for the public Caddy-served site at ivanlugo.dev/ide. Transferable ArrayBuffers get 95%+ of the benefit with zero header changes, as Transfer correctly notes.

---

## Key Insight

All three agents identified the same fundamental problem from different angles: the current pipeline shapes text into heavyweight JS objects on the main thread, then deep-copies those objects to workers, where only 2 of 7 fields are actually consumed. The Shaping agent focused on making the WASM-to-JS bridge cheaper. The Transfer agent focused on making the JS-to-worker bridge cheaper. My analysis (Caching) focused on eliminating the WASM-to-JS bridge entirely for the dominant case.

The critical realization is that **for a monospace font, shaping is a pure lookup table** -- the entire HarfBuzz pipeline is reducible to `codepoint -> {glyphId, advance}`. This means the Shaping agent's `shapeDirect` and the Transfer agent's Transferable arrays are both optimizing a pipeline that should not exist in the hot path at all. They are correct optimizations for the general case, but the monospace constraint makes them fallback-path optimizations. The correct architecture is: per-character cache as the primary path (~99.9% of glyphs), `shapeDirect` + Transferable arrays for the rare cache-miss path (combining marks, emoji, unknown codepoints), and dedicated shaping workers only if profiling shows the fallback path is still a bottleneck after the cache is in place.
