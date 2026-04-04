# Round 3: Caching convergence

## Settled

1. **Per-codepoint cache is the highest-leverage change.** All three agents agree. For Cousine-Regular (monospace), `hb_shape()` is a pure function from codepoint to `{glyphId, advance}`. A `Map<number, {g, ax}>` primed with ~256 codepoints at init eliminates ~100% of runtime WASM calls, ~100% of `buffer.json()` serialization, and ~100% of the `delete glyph.fl` V8 deopt. Total estimated savings: ~58% of load time. Memory cost: ~3KB.

2. **`cl` (cluster) is not used by `buildBatchBuffers` but the field cannot be silently dropped.** Shaping's round 1 review corrected my Phase 0 claim that `cl` is "dead weight through the entire pipeline." The builder does not read it, but `collectUniqueGlyphIds()` and future semantic-info consumers index by cluster. The cache's `shapeLine()` output does not include `cl` because the builder does not need it. If downstream consumers need cluster indices in the future, they can reconstruct them from the text (they are just UTF-16 code unit offsets for monospace 1:1 mappings).

3. **`monospaceAdvance` is not a universal constant.** Shaping's round 1 review correctly identified that zero-width glyphs (soft hyphen, zero-width space, combining marks) have `ax = 0`. The cache stores per-codepoint `ax`, not a single constant. The builder's `_emptyGlyphs.has(glyphId)` check at `builders/index.js:213` still applies -- the cache must map space (U+0020) to its correct glyph ID so the builder can skip rendering it while still advancing the cursor.

4. **Surrogate pairs require `codePointAt()` + variable increment.** My Phase 0 `shapeLine()` loop used `i++` unconditionally, which is wrong for supplementary-plane characters. The correct iteration is: `const cp = lineText.codePointAt(i); i += cp > 0xFFFF ? 2 : 1;`. HarfBuzz clusters from `hb_buffer_add_utf16` are UTF-16 code unit indices, so the priming pass must use `codePointAt(cluster)` to extract the actual codepoint.

5. **`shapeDirect()` replaces `buffer.json()` for all HarfBuzz calls.** This applies to both the cache priming pass and the fallback path for unknown codepoints. The method must be added inside `hbjs.js createBuffer()` where it has closure access to `exports` and `Module`. Transfer correctly identified that `this._hb._exports` does not exist on the public API surface.

6. **Strip dead fields from `postMessage` immediately.** Replace `{ ...item, shaped }` at `WorkerBridge.js:132-134` with explicit picks: `{ position, color, scale, groupId, shaped }`. This drops `text`, `id`, `options` from structured clone. Independent of the cache, ships today.

7. **Transfer's Float32Array packing is the fallback strategy.** For monospace fonts, sending raw text + glyph map to workers (my Tier 3) is strictly better than pre-packing shaped data into typed arrays. Transfer's approach becomes relevant only if the project adds variable-width fonts where the cache cannot serve 100% of codepoints.

8. **Dedicated shaping workers are deferred.** Shaping's 2-worker architecture is well-designed but unnecessary when the cache eliminates WASM calls. The 32MB memory cost (2 x 16MB WASM heaps) has no justification when HarfBuzz is called ~0 times after init.

9. **WASM module stays alive.** The ~16MB WASM heap is retained for the fallback path (unknown codepoints during cache miss). Do not free it after priming. Acceptable cost for correctness.

10. **Cache invalidation is noted but not built.** Cousine-Regular is hardcoded. If font switching is added later, `MonospaceShapeCache.invalidate()` clears the map and re-primes. No plumbing needed now.

## Implementation Plan

### File 1: `src/shaping/vendor/hbjs.js` (MODIFY ~line 1312)

Add `shapeDirect()` to the buffer object inside `createBuffer()`. This is the only way to access `exports` and `Module` without modifying the API surface.

```js
// After the json() method, before destroy():

      /**
       * Read shaped results directly from WASM HEAP.
       * No JSON serialization, no string allocation, no property deletion.
       * Returns array of {g, cl, ax, ay, dx, dy} matching json() contract.
       */
      shapeDirect: function () {
        var len = exports.hb_buffer_get_length(ptr);
        if (len === 0) return [];
        var infosPtr32 = exports.hb_buffer_get_glyph_infos(ptr, 0) / 4;
        var posPtr32 = exports.hb_buffer_get_glyph_positions(ptr, 0) / 4;
        var heapU = Module.HEAPU32;
        var heapI = Module.HEAP32;
        var out = new Array(len);
        for (var i = 0; i < len; i++) {
          // hb_glyph_info_t: 5 x uint32 (codepoint, mask, cluster, var1, var2)
          var ii = infosPtr32 + i * 5;
          // hb_glyph_position_t: 5 x int32 (x_advance, y_advance, x_offset, y_offset, var)
          var pi = posPtr32 + i * 5;
          out[i] = {
            g:  heapU[ii],          // glyph ID
            cl: heapU[ii + 2],      // cluster (UTF-16 code unit index)
            ax: heapI[pi],          // x_advance (font units)
            ay: heapI[pi + 1],      // y_advance
            dx: heapI[pi + 2],      // x_offset
            dy: heapI[pi + 3],      // y_offset
          };
        }
        return out;
      },
```

### File 2: `src/shaping/HarfBuzzShaper.js` (MODIFY line 93)

Replace `buffer.json()` with `buffer.shapeDirect()`. This change applies to every HarfBuzz call -- both priming and fallback.

```js
    // In shape(), replace:
    //   const result = buffer.json();
    // With:
        const result = buffer.shapeDirect();
```

One-line change. The `shapeDirect()` return format matches `json()` except it omits `flags` (which no consumer reads) and the objects are in monomorphic hidden class state (no `delete` operator applied).

### File 3: `src/shaping/MonospaceShapeCache.js` (NEW)

```js
/**
 * MonospaceShapeCache - Eliminates runtime HarfBuzz WASM calls for monospace fonts.
 *
 * Maps each Unicode codepoint to its {glyphId, xAdvance} by shaping representative
 * text once at init. All subsequent shapeText() calls become O(n) Map lookups.
 * Unknown codepoints fall back to HarfBuzz automatically and are cached on first hit.
 *
 * Memory: ~256 entries x ~40 bytes (Map overhead) = ~10KB. Trivial.
 */
export default class MonospaceShapeCache {
    /**
     * @param {import('./HarfBuzzShaper.js').default} shaper - Initialized HarfBuzzShaper
     */
    constructor(shaper) {
        /** @private @type {Map<number, {g: number, ax: number}>} codepoint -> glyph info */
        this._map = new Map();
        /** @private */
        this._shaper = shaper;
    }

    /** @returns {number} Number of cached codepoints */
    get size() { return this._map.size; }

    /**
     * Prime the cache by shaping a representative string.
     * The string should contain every character the app commonly renders.
     *
     * @param {string} probeText - Characters to cache (order does not matter)
     */
    prime(probeText) {
        // Shape the whole string at once -- one WASM call for all probe chars
        const shaped = this._shaper.shape(probeText);
        for (let i = 0; i < shaped.length; i++) {
            const cluster = shaped[i].cl;  // UTF-16 code unit index
            const cp = probeText.codePointAt(cluster);
            if (cp !== undefined && !this._map.has(cp)) {
                this._map.set(cp, { g: shaped[i].g, ax: shaped[i].ax });
            }
        }
    }

    /**
     * Look up a single codepoint. Falls back to HarfBuzz on cache miss.
     * @param {number} codepoint - Unicode codepoint
     * @returns {{g: number, ax: number}}
     */
    lookup(codepoint) {
        let entry = this._map.get(codepoint);
        if (entry !== undefined) return entry;

        // Cache miss: shape the single character via HarfBuzz, cache result
        const ch = String.fromCodePoint(codepoint);
        const shaped = this._shaper.shape(ch);
        entry = shaped.length > 0
            ? { g: shaped[0].g, ax: shaped[0].ax }
            : { g: 0, ax: 0 };
        this._map.set(codepoint, entry);
        return entry;
    }

    /**
     * Shape an entire line via cached lookups.
     * Returns an array compatible with the builder's inner loop:
     *   for (const sg of line.shaped) { sg.g, sg.ax, sg.dx, sg.dy }
     *
     * @param {string} lineText - Single line of text (no newlines)
     * @returns {Array<{g: number, ax: number, dx: number, dy: number}>}
     */
    shapeLine(lineText) {
        const len = lineText.length;
        const result = [];
        for (let i = 0; i < len; ) {
            const cp = lineText.codePointAt(i);
            const entry = this.lookup(cp);
            result.push({ g: entry.g, ax: entry.ax, dx: 0, dy: 0 });
            i += cp > 0xFFFF ? 2 : 1;  // Skip surrogate pair high+low
        }
        return result;
    }

    /**
     * Export cache as a Uint32Array for zero-copy worker transfer.
     * Layout: [codepoint0, glyphId0, advance0, cp1, g1, ax1, ...]
     *
     * @returns {Uint32Array}
     */
    toTransferArray() {
        const arr = new Uint32Array(this._map.size * 3);
        let idx = 0;
        for (const [cp, entry] of this._map) {
            arr[idx++] = cp;
            arr[idx++] = entry.g;
            arr[idx++] = entry.ax;
        }
        return arr;
    }

    /**
     * Rebuild a lookup Map from a transferred Uint32Array (worker-side).
     * @param {Uint32Array} arr - Flat array from toTransferArray()
     * @returns {Map<number, {g: number, ax: number}>}
     */
    static fromTransferArray(arr) {
        const map = new Map();
        for (let i = 0; i < arr.length; i += 3) {
            map.set(arr[i], { g: arr[i + 1], ax: arr[i + 2] });
        }
        return map;
    }

    /** Clear the cache. Call if the font changes. */
    invalidate() { this._map.clear(); }
}
```

### File 4: `src/shaping/shapeText.js` (MODIFY)

Accept either a `MonospaceShapeCache` or a raw `HarfBuzzShaper`. Duck-type on the `shapeLine` method.

```js
export function shapeText(shaperOrCache, text, features) {
    const rawLines = text.split('\n');
    const lines = [];
    let totalGlyphs = 0;

    const useCache = typeof shaperOrCache.shapeLine === 'function';

    for (const lineText of rawLines) {
        if (lineText.length === 0) {
            lines.push({ shaped: [], text: lineText });
            continue;
        }
        const shaped = useCache
            ? shaperOrCache.shapeLine(lineText)
            : shaperOrCache.shape(lineText, features);
        lines.push({ shaped, text: lineText });
        totalGlyphs += shaped.length;
    }

    return { lines, totalGlyphs };
}
```

### File 5: `src/workers/WorkerBridge.js` (MODIFY)

(a) Accept cache in `setShaper()`. (b) Strip dead fields. (c) Transfer glyph map to workers for future Tier 3.

```js
// setShaper() -- accept optional cache, transfer glyph map to workers
setShaper(shaper, shapeCache) {
    this._shaper = shaper;
    this._shapeCache = shapeCache || null;
    this._upem = shaper ? shaper.upem : 0;
    console.debug(`[WorkerBridge] Main-thread shaper registered (upem=${this._upem})`);

    if (shapeCache && this.workers.length > 0) {
        const glyphMapArr = shapeCache.toTransferArray();
        for (const w of this.workers) {
            const copy = new Uint32Array(glyphMapArr);
            w.postMessage({ type: 'GLYPH_MAP', glyphMap: copy }, [copy.buffer]);
        }
    }
}

// buildBatchBuffers() -- use cache, strip dead fields
async buildBatchBuffers(items, shared, atlas) {
    this._ensureInitialized();
    if (this.workers.length === 0) {
        return this._buildBatchBuffersSync(items, shared);
    }

    const worker = this._getNextWorker();
    const jobId = String(this.nextJobId++);
    const shaperOrCache = this._shapeCache || this._shaper;

    // Shape + strip to only the fields buildBatchBuffers reads
    const shapedItems = items.map(item => ({
        position: item.position,
        color: item.color,
        scale: item.scale,
        groupId: item.groupId,
        shaped: shapeText(shaperOrCache, item.text || ''),
    }));

    return new Promise((resolve, reject) => {
        this.pendingRequests.set(jobId, { resolve, reject });
        worker.postMessage({
            type: 'BUILD_BATCH', jobId,
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

### File 6: `src/workers/GlyphWorker.js` (MODIFY)

Store glyph map for future worker-side reconstruction (Tier 3).

```js
// Module-scope:
let glyphMap = null;  // Map<codepoint, {g, ax}> -- transferred once from main

// In onmessage switch, add:
case 'GLYPH_MAP': {
    const arr = event.data.glyphMap;
    glyphMap = new Map();
    for (let i = 0; i < arr.length; i += 3) {
        glyphMap.set(arr[i], { g: arr[i + 1], ax: arr[i + 2] });
    }
    break;
}
```

### File 7: Init site -- `app/GitHubRepoViewer.js` (MODIFY)

Create and prime the cache after shaper init.

```js
import MonospaceShapeCache from '../src/shaping/MonospaceShapeCache.js';

// After: await this._shaper.init(fontBuffer);
// Before: bridge.setShaper(this._shaper);

// Build probe text: printable ASCII + Latin-1 supplement + box-drawing
let probe = '';
for (let cp = 0x20; cp <= 0x7E; cp++) probe += String.fromCodePoint(cp);
for (let cp = 0xA0; cp <= 0xFF; cp++) probe += String.fromCodePoint(cp);
for (let cp = 0x2500; cp <= 0x257F; cp++) probe += String.fromCodePoint(cp);

const shapeCache = new MonospaceShapeCache(this._shaper);
shapeCache.prime(probe);
console.log(`[ShapeCache] Primed ${shapeCache.size} codepoints (~${shapeCache.size * 40}B)`);

// Pass both shaper (for fallback) and cache to bridge
this._bridge.setShaper(this._shaper, shapeCache);
```

### Sequencing

1. **Now (5 min):** Strip dead fields from `postMessage` in `WorkerBridge.js`. One line change.
2. **Phase 1 (2-3 hours):** Add `shapeDirect()` to hbjs.js. Replace `buffer.json()` in `HarfBuzzShaper.shape()`. This immediately benefits all callers including the cache priming pass.
3. **Phase 2 (1-2 hours):** Create `MonospaceShapeCache`. Modify `shapeText()` to duck-type. Prime at init. Pass to `WorkerBridge.setShaper()`.
4. **Validation (30 min):** Shape 1000 random source lines via HarfBuzz and via cache. Assert `shaped[i].g` and `shaped[i].ax` match for every glyph. Log any mismatches (expected: 0 for monospace).
5. **Phase 3 (deferred):** Worker-side reconstruction. Workers use `glyphMap` to produce glyph IDs from raw text locally, eliminating shaped data from `postMessage` entirely.
6. **Deferred:** Shaping workers, SharedArrayBuffer, `emptyGlyphs` bitmap conversion.

## Implementer Vote

**Transfer** -- the postMessage strip and Transferable array expertise are needed for the Phase 1 quick-win and the Phase 3 worker-side reconstruction. Transfer agent understands the structured clone cost model and can validate that the stripped payloads and glyph map transfers are correct.
