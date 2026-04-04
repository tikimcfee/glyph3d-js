# Round 1 — Transfer Reviews Shaping + Caching

Reviewer: Transfer agent (serialization / worker transfer specialist)
Reviewed: phase0-Shaping.md, phase0-Caching.md

---

## Errors Found

### 1. Shaping `shapeDirect` references non-existent API surface

The `shapeDirect()` example (Shaping §5) accesses `this._hb._exports` and `this._hb.Module`:

```js
const infosPtr = this._hb._exports.hb_buffer_get_glyph_infos(buffer.ptr, 0) / 4;
const heapU = this._hb.Module.HEAPU32;
```

Neither `_exports` nor `Module` is exposed by `hbjs()`. The return object at hbjs.js:1445-1457 exports only `createBlob`, `createFace`, `createFont`, `createFontFuncs`, `createBuffer`, `shape`, `shapeWithTrace`, `version`, `version_string`, `otTagToScript`, `otTagToLanguage`. The `exports` (WASM exports) and `Module` (Emscripten module) are closure-private variables inside `hbjs()`. Implementing `shapeDirect` as written would fail with `TypeError: Cannot read properties of undefined`.

**To make this work**: Either (a) modify hbjs.js to expose `Module` and `exports` in its return object (safe -- we vendor this file), or (b) add a new method directly on the buffer object inside `createBuffer()` (hbjs.js:987) alongside the existing `getGlyphInfosAndPositions`, where closure access is available. Option (b) is cleaner.

### 2. Shaping `getGlyphInfos`/`getGlyphPositions` described as separate from `getGlyphInfosAndPositions`

Shaping §5 proposes using `buffer.getGlyphInfos()` and `buffer.getGlyphPositions()` as the "direct memory path." These methods do exist (hbjs.js:1136, 1161) and do read from HEAP directly -- but they still allocate JS objects per glyph (`infos.push({codepoint, cluster})`, `positions.push({x_advance, ...})`). The proposal's first code example (Shaping §5, "Proposed replacement") iterates `infos[i].codepoint`, `positions[i].x_advance` etc., which means it creates 2N objects per line then reads 4 fields from them. This is better than `buffer.json()` but not the "zero intermediate objects" claimed for the raw HEAP path. The doc conflates the two approaches in the same section.

### 3. Caching assumes `cl` equals character index for monospace

Caching §2: "cl = cluster index ... trivially reconstructible as it equals the character index for 1:1 mappings." This is true for ASCII but not for supplementary-plane codepoints (U+10000+). A single emoji codepoint is one UTF-16 surrogate pair but HarfBuzz operates on Unicode codepoints -- `cl` from HarfBuzz is the **byte offset in the UTF-8 input** or the **codepoint index** depending on how `addText` was called. In hbjs.js, `addText` writes UTF-16 via `_string_to_utf16_ptr` (hbjs.js:111-119) and calls `hb_buffer_add_utf16`, so clusters are UTF-16 code unit indices. For supplementary-plane characters, `cl` increments by 2, not 1. The Caching agent's `shapeLine` loop (§8 Tier 1) uses `codePointAt(i)` correctly but increments `i` by 1, which would break on surrogate pairs. The `cl` reconstruction as `i` would be wrong.

**Impact**: Low for typical source code (supplementary plane chars are rare), but the claim "trivially reconstructible" is incorrect for the general case.

### 4. Caching overstates postMessage payload as "~30MB"

Caching §9 estimates current postMessage shaped payload at "~30MB est." My Phase 0 analysis estimated ~500MB based on 7 properties * ~88 bytes/glyph (V8 structured clone overhead for plain objects) * 5.7M glyphs. Even a conservative estimate with 3.8M glyphs (Caching's own number) * 88 bytes = ~334MB. The 30MB figure appears to confuse the raw numeric data volume (3.8M * 7 fields * 4 bytes = ~106MB) with the structured clone cost, which includes per-object overhead (hidden class pointers, property map allocation).

---

## Gaps

### 5. Neither doc addresses the return path (worker -> main thread)

Both Shaping and Caching focus on main-to-worker transfer. But `buildBatchBuffers` in the worker returns large typed arrays (positions, sizes, codepoints, colors, groupIds) plus `itemMeta` objects back via `postMessage`. The worker→main return path is already using Transferable arrays for the big buffers (builders/index.js returns Float32Arrays), but `itemMeta` is an array of plain objects with bounds, line slot offsets, etc. At 951 items, this is non-trivial structured clone traffic on the return path. Neither doc accounts for this.

### 6. Shaping does not address how shaping workers receive the font

Shaping §4 proposes 2 dedicated shaping workers but says only "Font is ~50KB, transfer once at init" in the risk table (§6). The actual init path requires `HarfBuzzShaper.init(fontBuffer, wasmUrl)` which loads the WASM binary (~2MB) and the font. Each shaping worker needs its own WASM instance (WASM is not shareable across threads). The startup cost per shaping worker is ~200ms (WASM compile + font load). This latency is not accounted for in the "Phase A" pipeline description and could delay the first batch if workers are not pre-warmed.

### 7. Caching does not address cache invalidation for font changes

The per-codepoint cache (Caching §8 Tier 1) is primed once and assumed permanent. If the font were ever swapped (e.g., user preference for a different monospace font), the entire cache is stale. This is not a current issue (Cousine-Regular is hardcoded) but the doc should note this assumption explicitly, since the caching layer would need a `font version` key if font switching were added.

---

## Tensions

### 8. Caching's "eliminate WASM entirely" vs. Shaping's "move WASM to workers"

Caching proposes making HarfBuzz calls nearly zero via per-codepoint lookup (§2: "~100% of HarfBuzz WASM calls after init... drop to ~0"). Shaping proposes moving HarfBuzz to 2 dedicated workers (§4). These are **mutually exclusive investments**. If caching eliminates WASM calls, shaping workers are wasted infrastructure. If shaping workers are built, caching provides diminishing returns.

**Recommendation**: Caching wins for monospace. Per-codepoint lookup is simpler, cheaper, and eliminates both the WASM cost AND the serialization cost in one move. Shaping workers become relevant only if the project adds variable-width or complex-script fonts where per-character caching is insufficient.

### 9. My Transferable ArrayBuffer strategy vs. Caching's worker-side reconstruction

My Phase 0 proposes pre-packing shaped data into Float32Arrays and transferring them. Caching §8 Tier 3 proposes sending only raw text + a 1.5KB lookup table, letting workers reconstruct shaped data locally. Caching's approach is strictly better for monospace: it transfers less data (just the text strings that are already in the payload) and eliminates the packing step on the main thread. My Transferable strategy remains the right fallback for non-monospace fonts where per-character caching is invalid.

---

## Recommendations

1. **Implement per-codepoint cache first** (Caching Tier 1). This is the highest-leverage single change: eliminates ~58% of total load time (WASM shape + json + serialize) for ~50 lines of code and ~3KB of memory. Validate by comparing cached output vs. HarfBuzz output for a sample of files.

2. **Strip dead fields from postMessage immediately** (my Phase 0 §7). Five minutes of work, ~20% reduction in structured clone volume. Do this regardless of caching strategy. Replace the spread at WorkerBridge.js:132-134 with explicit property picks.

3. **Add `shapeDirect()` to the buffer object inside hbjs.js `createBuffer()`**, not as an external method on HarfBuzzShaper. This gives closure access to `exports` and `Module`. Use it as the fallback for non-cached codepoints.

4. **For Tier 3 (worker-side reconstruction)**: Transfer the codepoint-to-glyphId map as a `Uint32Array` (pairs of [codepoint, glyphId]) rather than a `Map`. Maps are structured-cloned; typed arrays are Transferable. One transfer at init, zero cost.

5. **Defer shaping workers** (Shaping §4) until the project needs non-monospace fonts. The 2-worker architecture is well-designed but unnecessary if per-codepoint caching eliminates WASM calls.

6. **Fix the surrogate pair handling** in the Caching agent's `shapeLine()` loop. Use `for...of` or manual surrogate detection to correctly iterate codepoints, not `i++` on a string index.

7. **Account for worker→main return path**: Flatten `itemMeta` into typed arrays (bounds as Float32Array, lineSlotOffsets as Int32Array) and add them to the transfer list. This is a small but real cost that both docs missed.

8. **Pre-warm shaping workers** if they are implemented: start WASM compilation during font fetch, not after. Use `WebAssembly.compileStreaming()` in the worker and overlap with font network request.

9. **Preserve the monospace assumption explicitly**: Add a comment or config flag (`font.monospace = true`) that gates the per-codepoint cache. When this flag is false, fall back to full HarfBuzz shaping + Transferable transfer.

10. **Consider the `flags` field**: Both Shaping and Caching note `flags` is unused by the builder. However, `HB_GLYPH_FLAG_UNSAFE_TO_BREAK` (0x1) is relevant for line-breaking decisions. If the project ever adds word-wrap or hyphenation, this field will be needed. Document that it is intentionally dropped, not accidentally.

---

## Key Insight

All three agents converge on the same fundamental observation: **for a monospace font, HarfBuzz is a 58%-cost identity function**. Each codepoint maps to exactly one glyph with a constant advance, zero offsets, and no contextual substitutions. The entire WASM→JSON→parse→clone pipeline exists to compute what amounts to a static lookup table. The Caching agent's per-codepoint cache is the correct architectural response -- it collapses the shaping, serialization, and transfer costs into a single O(1) map lookup per character. My Transferable strategy and the Shaping agent's worker architecture are both valid but secondary: they optimize the transport of data that, for monospace, should never be computed in the first place.
