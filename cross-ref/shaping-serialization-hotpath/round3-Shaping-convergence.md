# Round 3: Shaping convergence

## Settled

1. **Per-codepoint cache is the primary optimization.** All three agents converged: for a monospace font, `hb_shape()` is a pure `codepoint -> {glyphId, advance}` lookup. A `Map<number, {g, ax}>` primed once at init eliminates ~100% of runtime WASM calls (~58% of total load time). The 2-shaping-worker architecture I proposed in Phase 0 is deferred indefinitely -- it solves a problem that the cache makes nonexistent.

2. **`shapeDirect()` is the cache-miss fallback, not the primary optimization.** My Phase 0 recommended replacing `buffer.json()` with direct HEAP reads as step 1. The round 1 reviews correctly reordered this: the cache ships first, and `shapeDirect()` becomes the rare-path fallback for unknown codepoints (emoji, combining marks, future non-monospace fonts). The HEAP read approach must be added as a method on the buffer object inside `hbjs.js createBuffer()` (Transfer's recommendation), not as an external method on `HarfBuzzShaper`, because `exports` and `Module` are closure-private.

3. **`buffer.json()` must never be called in the hot path.** The serialize-parse-delete pipeline (`hb_buffer_serialize` -> `JSON.parse` -> `delete glyph.fl`) costs ~35% of load time and forces every glyph object into V8 dictionary mode. The cache eliminates it for cached codepoints; `shapeDirect()` eliminates it for misses.

4. **Strip dead fields from `postMessage` immediately.** The spread at `WorkerBridge.js:132-134` (`{ ...item, shaped }`) copies `text`, `id`, `options` -- none of which `buildBatchBuffers` reads. Replace with explicit property picks. This is orthogonal and ships independently.

5. **Workers receive raw text + glyph map, not pre-shaped objects.** Caching Tier 3 is strictly better than Transfer's Float32Array packing for monospace. Workers do their own trivial `codepoint -> glyphId` lookup from a transferred `Uint32Array`. Shaped data disappears from `postMessage` entirely.

6. **Surrogate pairs must be handled correctly.** The `addText` path uses `hb_buffer_add_utf16`, so HarfBuzz clusters are UTF-16 code unit indices. The cache lookup must use `codePointAt()` and advance by 2 for supplementary-plane characters (U+10000+). The Caching agent's original `shapeLine()` loop incremented `i` by 1 unconditionally -- this is wrong for surrogate pairs.

7. **`emptyGlyphs` check still applies.** The per-codepoint cache must produce glyph IDs that the builder's `_emptyGlyphs.has(glyphId)` check at `builders/index.js:213` handles correctly. Space (U+0020) maps to a glyph ID with 0 curves -- the cache must preserve this mapping, not skip it.

8. **Profile percentages are inclusive, not additive.** `serialize` (15.6%) is a child call of `buffer.json()` (20.5%). The true breakdown is `hb_shape()` ~23% + `buffer.json()` ~35% (inclusive). Total shaping cost is ~58%, not ~59.2%.

9. **Return path is already Transferable.** `GlyphWorker.js:39-47` passes a transfer list with all Float32Array buffers. However, `itemMeta` (array of plain objects with bounds, lineSlotOffsets) is structured-cloned on the return. This is a minor cost (~951 items) but should be flattened in a follow-up.

10. **WASM module stays alive.** Do not free the HarfBuzz WASM heap after priming the cache. The fallback path needs it for unknown codepoints. The ~16MB cost is acceptable for correctness insurance. Cache invalidation on font change (`HarfBuzzShaper.setFont()`) is noted but not needed today -- Cousine-Regular is hardcoded.

## Implementation Plan

### File 1: `src/shaping/MonospaceShapeCache.js` (NEW)

The core cache class. Primed once at init with ASCII + Latin-1. Falls back to HarfBuzz for unknown codepoints via `shapeDirect()` on the buffer object.

```js
/**
 * MonospaceShapeCache - Per-codepoint glyph lookup for monospace fonts.
 *
 * For a monospace font, each Unicode codepoint always maps to the same
 * glyph ID with the same advance width. This cache eliminates all runtime
 * HarfBuzz WASM calls after a one-time priming pass.
 *
 * Cache miss fallback: shapes the single codepoint via HarfBuzz, caches
 * the result, returns it. This handles emoji, combining marks, and any
 * future non-ASCII codepoints without breaking.
 */
export default class MonospaceShapeCache {
    /**
     * @param {import('./HarfBuzzShaper.js').default} shaper
     */
    constructor(shaper) {
        /** @private codepoint -> {g: glyphId, ax: xAdvance} */
        this._map = new Map();
        /** @private HarfBuzz shaper for fallback */
        this._shaper = shaper;
    }

    /** @returns {number} Number of cached codepoints */
    get size() { return this._map.size; }

    /**
     * Prime the cache by shaping representative text.
     * Call once after HarfBuzzShaper.init().
     *
     * @param {string} probeText - Text containing all characters to cache
     *   (e.g. ASCII 0x20-0x7E + Latin-1 0xA0-0xFF + box-drawing)
     */
    prime(probeText) {
        const shaped = this._shaper.shape(probeText);
        for (let i = 0; i < shaped.length; i++) {
            const cluster = shaped[i].cl;
            const cp = probeText.codePointAt(cluster);
            if (cp !== undefined && !this._map.has(cp)) {
                this._map.set(cp, { g: shaped[i].g, ax: shaped[i].ax });
            }
        }
    }

    /**
     * Look up a single codepoint. Falls back to HarfBuzz on miss.
     * @param {number} codepoint
     * @returns {{g: number, ax: number}}
     */
    lookup(codepoint) {
        let entry = this._map.get(codepoint);
        if (entry) return entry;

        // Cache miss -- shape single character, cache result
        const ch = String.fromCodePoint(codepoint);
        const shaped = this._shaper.shape(ch);
        if (shaped.length > 0) {
            entry = { g: shaped[0].g, ax: shaped[0].ax };
        } else {
            // Fallback for zero-length shape result (shouldn't happen)
            entry = { g: 0, ax: 0 };
        }
        this._map.set(codepoint, entry);
        return entry;
    }

    /**
     * Shape an entire line using cached lookups.
     * Returns array compatible with builder's inner loop expectations.
     *
     * @param {string} lineText - Single line (no newlines)
     * @returns {Array<{g: number, ax: number, dx: number, dy: number}>}
     */
    shapeLine(lineText) {
        const result = new Array(lineText.length);
        let outIdx = 0;
        for (let i = 0; i < lineText.length; ) {
            const cp = lineText.codePointAt(i);
            const entry = this.lookup(cp);
            result[outIdx++] = { g: entry.g, ax: entry.ax, dx: 0, dy: 0 };
            // Advance past surrogate pair if supplementary plane
            i += cp > 0xFFFF ? 2 : 1;
        }
        // Trim if surrogate pairs shortened the array
        if (outIdx < result.length) result.length = outIdx;
        return result;
    }

    /**
     * Export the cache as a flat Uint32Array for worker transfer.
     * Layout: [codepoint0, glyphId0, advance0, codepoint1, glyphId1, advance1, ...]
     * advance is stored as the raw integer from HarfBuzz (font units).
     *
     * @returns {Uint32Array}
     */
    toTransferArray() {
        const arr = new Uint32Array(this._map.size * 3);
        let i = 0;
        for (const [cp, entry] of this._map) {
            arr[i++] = cp;
            arr[i++] = entry.g;
            arr[i++] = entry.ax;
        }
        return arr;
    }

    /**
     * Rebuild cache from a transferred Uint32Array (worker side).
     * @param {Uint32Array} arr
     * @returns {Map<number, {g: number, ax: number}>}
     */
    static fromTransferArray(arr) {
        const map = new Map();
        for (let i = 0; i < arr.length; i += 3) {
            map.set(arr[i], { g: arr[i + 1], ax: arr[i + 2] });
        }
        return map;
    }

    /**
     * Clear the cache (e.g. on font change).
     */
    invalidate() {
        this._map.clear();
    }
}
```

### File 2: `src/shaping/shapeText.js` (MODIFY)

Replace per-line `shaper.shape()` with cache lookup. The function signature stays the same for call-site compatibility.

```js
// NEW import at top:
// import MonospaceShapeCache from './MonospaceShapeCache.js';

/**
 * Shape a multi-line text block using the per-codepoint cache.
 * Falls back to HarfBuzz for unknown codepoints automatically.
 *
 * @param {MonospaceShapeCache|import('./HarfBuzzShaper.js').default} shaperOrCache
 * @param {string} text
 * @param {string} [features]
 * @returns {{ lines: Array<{shaped, text}>, totalGlyphs: number }}
 */
export function shapeText(shaperOrCache, text, features) {
    const rawLines = text.split('\n');
    const lines = [];
    let totalGlyphs = 0;

    // If we receive a MonospaceShapeCache, use fast path
    const isCache = shaperOrCache && typeof shaperOrCache.shapeLine === 'function';

    for (const lineText of rawLines) {
        if (lineText.length === 0) {
            lines.push({ shaped: [], text: lineText });
            continue;
        }
        const shaped = isCache
            ? shaperOrCache.shapeLine(lineText)
            : shaperOrCache.shape(lineText, features);
        lines.push({ shaped, text: lineText });
        totalGlyphs += shaped.length;
    }

    return { lines, totalGlyphs };
}
```

### File 3: `src/workers/WorkerBridge.js` (MODIFY)

Two changes: (a) accept and store a `MonospaceShapeCache`, (b) strip dead fields from `postMessage`, (c) transfer glyph map to workers once at init.

```js
// At setShaper(), also accept a cache:
setShaper(shaper, shapeCache) {
    this._shaper = shaper;
    this._shapeCache = shapeCache || null;
    this._upem = shaper ? shaper.upem : 0;
    // Transfer glyph map to all workers once
    if (shapeCache) {
        this._ensureInitialized();
        const glyphMapArr = shapeCache.toTransferArray();
        for (const worker of this.workers) {
            // Each worker gets a copy (small -- ~1-3KB)
            const copy = new Uint32Array(glyphMapArr);
            worker.postMessage(
                { type: 'GLYPH_MAP', glyphMap: copy },
                [copy.buffer]
            );
        }
    }
}

// In buildBatchBuffers(), replace the shaping + posting block:
async buildBatchBuffers(items, shared, atlas) {
    this._ensureInitialized();

    if (this.workers.length === 0) {
        return this._buildBatchBuffersSync(items, shared);
    }

    const worker = this._getNextWorker();
    const jobId = String(this.nextJobId++);

    // Shape using cache (fast) or shaper (fallback)
    const shaperOrCache = this._shapeCache || this._shaper;
    const shapedItems = items.map(item => {
        const shapedResult = shapeText(shaperOrCache, item.text || '');
        return {
            // Only the fields buildBatchBuffers actually reads:
            position: item.position,
            color: item.color,
            scale: item.scale,
            groupId: item.groupId,
            shaped: shapedResult,
        };
    });

    return new Promise((resolve, reject) => {
        this.pendingRequests.set(jobId, { resolve, reject });
        worker.postMessage({
            type: 'BUILD_BATCH',
            jobId,
            payload: {
                items: shapedItems,
                shared: {
                    metrics: shared.metrics,
                    defaultColor: shared.defaultColor,
                    upem: this._upem,
                    emptyGlyphs: shared.emptyGlyphs || null,
                }
            }
        });
    });
}
```

### File 4: `src/workers/GlyphWorker.js` (MODIFY)

Handle the `GLYPH_MAP` message. For now the glyph map is stored but the Phase 1 change only uses cache-based shaping on the main thread; worker-side reconstruction (Tier 3) comes after validation.

```js
// Add at module scope:
let glyphMap = null;

// Add case in onmessage switch:
case 'GLYPH_MAP': {
    // Rebuild Map from transferred Uint32Array
    // Layout: [codepoint, glyphId, advance, ...]
    const arr = payload.glyphMap;
    glyphMap = new Map();
    for (let i = 0; i < arr.length; i += 3) {
        glyphMap.set(arr[i], { g: arr[i + 1], ax: arr[i + 2] });
    }
    break;
}
```

### File 5: `src/shaping/vendor/hbjs.js` (MODIFY)

Add `shapeDirect()` method on the buffer object inside `createBuffer()`. This has closure access to `exports` and `Module`, avoiding the API surface problem Transfer identified.

```js
// Inside createBuffer(), after the json() method (~line 1312), add:

/**
 * Read shaped glyph data directly from WASM HEAP memory.
 * Returns flat array of {g, ax, dx, dy} with no JSON serialization.
 * Used as fallback for per-codepoint cache misses.
 */
shapeDirect: function () {
    var len = exports.hb_buffer_get_length(ptr);
    var infosPtr32 = exports.hb_buffer_get_glyph_infos(ptr, 0) / 4;
    var posPtr32 = exports.hb_buffer_get_glyph_positions(ptr, 0) / 4;
    var heapU = Module.HEAPU32;
    var heapI = Module.HEAP32;
    var result = new Array(len);
    for (var i = 0; i < len; i++) {
        // hb_glyph_info_t: {codepoint, mask, cluster, var1, var2} (5 uint32s)
        // hb_glyph_position_t: {x_advance, y_advance, x_offset, y_offset, var} (5 int32s)
        var base_i = infosPtr32 + i * 5;
        var base_p = posPtr32 + i * 5;
        result[i] = {
            g: heapU[base_i],           // glyph ID
            cl: heapU[base_i + 2],      // cluster
            ax: heapI[base_p],          // x_advance
            ay: heapI[base_p + 1],      // y_advance
            dx: heapI[base_p + 2],      // x_offset
            dy: heapI[base_p + 3],      // y_offset
        };
    }
    return result;
},
```

### File 6: `src/shaping/HarfBuzzShaper.js` (MODIFY)

Use `buffer.shapeDirect()` instead of `buffer.json()` for the fallback path. This eliminates the serialize-parse-delete pipeline for cache misses.

```js
// In shape() method, replace `const result = buffer.json();` with:
shape(text, features) {
    const buffer = this._hb.createBuffer();
    try {
        buffer.addText(text);
        buffer.guessSegmentProperties();
        this._hb.shape(this._font, buffer, features);
        const result = buffer.shapeDirect();  // Direct HEAP reads, no JSON

        if (!this._firstShapeLogged) {
            this._firstShapeLogged = true;
            const preview = text.length > 30 ? text.substring(0, 30) + '...' : text;
            console.log(`[HarfBuzz] Shaped "${preview}" -> ${result.length} glyphs`);
        }

        return result;
    } finally {
        buffer.destroy();
    }
}
```

### File 7: Init site (e.g., `app/GitHubRepoViewer.js`) (MODIFY)

After `HarfBuzzShaper.init()`, create and prime the cache, then pass it to WorkerBridge.

```js
// After shaper init and before first flush:
import MonospaceShapeCache from '../src/shaping/MonospaceShapeCache.js';

// Build probe string: printable ASCII + Latin-1 supplement + box drawing
let probe = '';
for (let cp = 0x20; cp <= 0x7E; cp++) probe += String.fromCodePoint(cp);
for (let cp = 0xA0; cp <= 0xFF; cp++) probe += String.fromCodePoint(cp);
// Add box-drawing range if used:
for (let cp = 0x2500; cp <= 0x257F; cp++) probe += String.fromCodePoint(cp);

const shapeCache = new MonospaceShapeCache(shaper);
shapeCache.prime(probe);
console.log(`[MonospaceShapeCache] Primed ${shapeCache.size} codepoints`);

// Pass to worker bridge
bridge.setShaper(shaper, shapeCache);
```

### Sequencing

1. **Immediate (5 min):** Strip dead fields from `postMessage` in `WorkerBridge.js:132-134`. Drop `text`, `id`, `options` from the spread.
2. **Phase 1 (2-4 hours):** Add `MonospaceShapeCache`, modify `shapeText()` to accept it, add `shapeDirect()` to hbjs.js, replace `buffer.json()` with `shapeDirect()` in `HarfBuzzShaper.shape()`, prime cache at init, pass to `WorkerBridge.setShaper()`.
3. **Phase 2 (1-2 hours):** Transfer glyph map to workers. Validate by shaping 1000 random lines via HarfBuzz vs. cache, assert equivalence.
4. **Phase 3 (deferred):** Worker-side reconstruction (workers receive only raw text + glyph map, do local lookup instead of receiving shaped objects). Requires modifying `buildBatchBuffers` inner loop to accept the glyph map directly.
5. **Deferred indefinitely:** 2 dedicated shaping workers, SharedArrayBuffer, pipeline streaming.

## Implementer Vote

**Caching** -- the per-codepoint cache is the architectural insight that makes the entire optimization possible. Without it, we would be optimizing transport of data that should never be computed. Caching agent should implement.
