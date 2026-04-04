# Round 3: Transfer convergence

## Settled

1. **Per-codepoint cache eliminates the structured clone bottleneck at its source.** The 15.6% serialize cost in my Phase 0 analysis exists because `postMessage` deep-copies millions of shaped glyph objects. The cache reduces shaped data volume by ~99.9% -- there is almost nothing left to clone. My Transferable `Float32Array` strategy is the correct fallback for non-monospace fonts but is secondary to the cache for the current Cousine-Regular case.

2. **Strip dead fields immediately.** All three agents agree. The spread `{ ...item, shaped }` at `WorkerBridge.js:132-134` copies `text` (~12KB/file), `id`, `options` -- none read by `buildBatchBuffers`. Replace with explicit picks. Five minutes, ~15MB less structured clone for 951 files, orthogonal to all other work.

3. **My structured clone volume estimate was inflated.** Both Shaping and Caching round 1 reviews corrected the ~88 bytes/glyph figure. V8 structured clone serialization is closer to ~64 bytes/glyph (tagged values, compact property key references, smaller object headers). Total for 5.7M glyphs is ~365MB, not ~500MB. The qualitative conclusion (too much) was right; the numbers were ~25% high.

4. **Round-robin description was muddled.** Shaping and Caching correctly noted that `_getNextWorker()` picks one worker per `buildBatchBuffers()` call, not per-item. The round-robin only helps when multiple collections flush independently. A single flush of 951 items goes to exactly one worker. Splitting batches across N workers for parallel buffer building remains a valid follow-up optimization.

5. **`shapeDirect()` must live inside `hbjs.js createBuffer()`.** My Phase 0 correctly identified that the JSON serialize pipeline must be replaced, but the Shaping agent's code example referenced `this._hb._exports` and `this._hb.Module`, which are closure-private inside `hbjs()`. The fix is to add `shapeDirect()` as a method on the buffer object returned by `createBuffer()`, where `exports` and `Module` are in scope.

6. **Worker return path is already Transferable.** `GlyphWorker.js:39-47` passes `[positions.buffer, sizes.buffer, glyphIds.buffer, colors.buffer, groupIds.buffer]` as the transfer list. The `itemMeta` array (plain objects with bounds and `lineSlotOffsets`) is still structured-cloned, but at ~951 items this is minor (~50-100KB). Flattening `itemMeta` into typed arrays is a valid follow-up but not blocking.

7. **Workers receive glyph map once, do local lookup later.** Caching's Tier 3 is strictly better than my Float32Array packing approach for monospace. The glyph map is ~3KB transferred once at init. Workers can eventually reconstruct glyph IDs from raw text + the map, eliminating all shaped data from `postMessage`. My packing strategy applies if/when variable-width fonts are needed.

8. **SharedArrayBuffer is deferred.** COOP/COEP headers add deployment friction for the public Caddy-served site. Transferable ArrayBuffers get 95%+ of the benefit. Not needed when the cache eliminates most of the data volume anyway.

9. **UV map transfer is a real cost I missed.** Shaping round 1 correctly identified that `WorkerBridge` also transfers the atlas UV map to workers (via `_ensureUVMapSerialized`). For large charsets this can be 100KB+. It is structured-cloned on first dispatch and on atlas version changes. This should be converted to a Transferable typed array in a follow-up pass.

10. **`emptyGlyphs` should become a bitmap.** The `Set.has()` check in the builder inner loop (`builders/index.js:213`) runs per-glyph. A `Uint8Array` bitmap indexed by glyph ID is O(1) without hash overhead and is trivially Transferable. Not blocking but a clean follow-up.

## Implementation Plan

### File 1: `src/workers/WorkerBridge.js` (MODIFY -- immediate)

Strip dead fields from the shaped items before posting. This is the 5-minute quick win.

```js
// Replace lines 132-135:
//   const shapedItems = items.map(item => {
//       const shapedResult = shapeText(this._shaper, item.text || '');
//       return { ...item, shaped: shapedResult };
//   });
// With:
    const shaperOrCache = this._shapeCache || this._shaper;
    const shapedItems = items.map(item => ({
        position: item.position,
        color: item.color,
        scale: item.scale,
        groupId: item.groupId,
        shaped: shapeText(shaperOrCache, item.text || ''),
    }));
```

Fields dropped: `text` (string, ~12KB/file, never read by builder), `id` (never read), `options` (never read). Fields kept: `position`, `color`, `scale`, `groupId` (all read by `buildBatchBuffers`), `shaped` (the glyph data).

### File 2: `src/workers/WorkerBridge.js` (MODIFY -- Phase 1)

Accept `MonospaceShapeCache` in `setShaper()`. Transfer glyph map to all workers.

```js
/**
 * Register the main-thread HarfBuzz shaper and optional monospace cache.
 * @param {import('../shaping/HarfBuzzShaper.js').default} shaper
 * @param {import('../shaping/MonospaceShapeCache.js').default} [shapeCache]
 */
setShaper(shaper, shapeCache) {
    this._shaper = shaper;
    this._shapeCache = shapeCache || null;
    this._upem = shaper ? shaper.upem : 0;
    console.debug(`[WorkerBridge] Shaper registered (upem=${this._upem}, cached=${!!shapeCache})`);

    // Transfer glyph map to all workers for future local reconstruction
    if (shapeCache) {
        this._ensureInitialized();
        const glyphMapArr = shapeCache.toTransferArray();
        for (const w of this.workers) {
            // Each worker needs its own copy since transfer neuters the buffer
            const copy = new Uint32Array(glyphMapArr);
            w.postMessage({ type: 'GLYPH_MAP', glyphMap: copy }, [copy.buffer]);
        }
        console.debug(`[WorkerBridge] Glyph map transferred to ${this.workers.length} workers (${glyphMapArr.byteLength}B each)`);
    }
}
```

### File 3: `src/shaping/vendor/hbjs.js` (MODIFY -- inside `createBuffer()`, after `json()`)

Add `shapeDirect()` method with closure access to `exports` and `Module`.

```js
      /**
       * Read shaped glyph data directly from WASM HEAP memory.
       * Replaces json() — no hb_buffer_serialize, no JSON.parse, no delete.
       * Returns the same {g, cl, ax, ay, dx, dy} shape as json() minus flags.
       */
      shapeDirect: function () {
        var len = exports.hb_buffer_get_length(ptr);
        if (len === 0) return [];
        // hb_glyph_info_t: 5 x uint32 {codepoint, mask, cluster, var1, var2}
        var iPtr = exports.hb_buffer_get_glyph_infos(ptr, 0) / 4;
        // hb_glyph_position_t: 5 x int32 {x_advance, y_advance, x_offset, y_offset, var}
        var pPtr = exports.hb_buffer_get_glyph_positions(ptr, 0) / 4;
        var HU = Module.HEAPU32;
        var HI = Module.HEAP32;
        var out = new Array(len);
        for (var i = 0; i < len; i++) {
          var ib = iPtr + i * 5;
          var pb = pPtr + i * 5;
          out[i] = {
            g:  HU[ib],        // glyph ID (after shaping)
            cl: HU[ib + 2],    // cluster index (UTF-16 code unit offset)
            ax: HI[pb],        // x_advance (font units)
            ay: HI[pb + 1],    // y_advance
            dx: HI[pb + 2],    // x_offset
            dy: HI[pb + 3],    // y_offset
          };
        }
        return out;
      },
```

### File 4: `src/shaping/HarfBuzzShaper.js` (MODIFY line 93)

One-line swap: `buffer.json()` -> `buffer.shapeDirect()`.

```js
    shape(text, features) {
        const buffer = this._hb.createBuffer();
        try {
            buffer.addText(text);
            buffer.guessSegmentProperties();
            this._hb.shape(this._font, buffer, features);
            const result = buffer.shapeDirect();  // was: buffer.json()

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

### File 5: `src/shaping/MonospaceShapeCache.js` (NEW)

```js
/**
 * MonospaceShapeCache - Per-codepoint glyph lookup table for monospace fonts.
 *
 * For monospace fonts, HarfBuzz shaping is a pure function: each codepoint maps
 * to exactly one glyph ID with a constant advance. This class caches those
 * mappings after a single priming pass, eliminating all runtime WASM calls.
 *
 * Unknown codepoints (emoji, combining marks) fall back to HarfBuzz on first
 * encounter and are cached for subsequent hits.
 */
export default class MonospaceShapeCache {
    /**
     * @param {import('./HarfBuzzShaper.js').default} shaper - Initialized HarfBuzzShaper
     */
    constructor(shaper) {
        /** @private @type {Map<number, {g: number, ax: number}>} */
        this._map = new Map();
        /** @private */
        this._shaper = shaper;
    }

    get size() { return this._map.size; }

    /**
     * Prime cache from a representative string (one HarfBuzz call total).
     * @param {string} probeText - All characters to pre-cache
     */
    prime(probeText) {
        const shaped = this._shaper.shape(probeText);
        for (let i = 0; i < shaped.length; i++) {
            const cluster = shaped[i].cl;   // UTF-16 code unit index
            const cp = probeText.codePointAt(cluster);
            if (cp !== undefined && !this._map.has(cp)) {
                this._map.set(cp, { g: shaped[i].g, ax: shaped[i].ax });
            }
        }
    }

    /**
     * Look up a codepoint. Falls back to HarfBuzz + caches on miss.
     * @param {number} codepoint
     * @returns {{g: number, ax: number}}
     */
    lookup(codepoint) {
        let entry = this._map.get(codepoint);
        if (entry !== undefined) return entry;

        const ch = String.fromCodePoint(codepoint);
        const shaped = this._shaper.shape(ch);
        entry = shaped.length > 0
            ? { g: shaped[0].g, ax: shaped[0].ax }
            : { g: 0, ax: 0 };
        this._map.set(codepoint, entry);
        return entry;
    }

    /**
     * Shape an entire line using cached lookups.
     * @param {string} lineText - Single line, no newlines
     * @returns {Array<{g: number, ax: number, dx: number, dy: number}>}
     */
    shapeLine(lineText) {
        const result = [];
        for (let i = 0, len = lineText.length; i < len; ) {
            const cp = lineText.codePointAt(i);
            const entry = this.lookup(cp);
            result.push({ g: entry.g, ax: entry.ax, dx: 0, dy: 0 });
            i += cp > 0xFFFF ? 2 : 1;
        }
        return result;
    }

    /**
     * Export as Uint32Array for Transferable worker init.
     * Layout: [cp0, g0, ax0, cp1, g1, ax1, ...]
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
     * Rebuild Map from Uint32Array (worker-side).
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

    invalidate() { this._map.clear(); }
}
```

### File 6: `src/shaping/shapeText.js` (MODIFY)

Duck-type on `shapeLine` to support both `MonospaceShapeCache` and `HarfBuzzShaper`.

```js
export function shapeText(shaperOrCache, text, features) {
    const rawLines = text.split('\n');
    const lines = [];
    let totalGlyphs = 0;

    // MonospaceShapeCache has shapeLine(); HarfBuzzShaper has shape()
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

### File 7: `src/workers/GlyphWorker.js` (MODIFY)

Handle `GLYPH_MAP` message. Store for future worker-side reconstruction.

```js
// Module scope
let glyphMap = null;

// In onmessage switch, add before default:
case 'GLYPH_MAP': {
    const arr = event.data.glyphMap;
    glyphMap = new Map();
    for (let i = 0; i < arr.length; i += 3) {
        glyphMap.set(arr[i], { g: arr[i + 1], ax: arr[i + 2] });
    }
    console.debug(`[GlyphWorker] Glyph map received: ${glyphMap.size} entries`);
    break;
}
```

### File 8: `app/GitHubRepoViewer.js` (MODIFY)

Prime cache after shaper init, pass to bridge.

```js
import MonospaceShapeCache from '../src/shaping/MonospaceShapeCache.js';

// After shaper.init(fontBuffer), before first use:
let probe = '';
for (let cp = 0x20; cp <= 0x7E; cp++) probe += String.fromCodePoint(cp);   // ASCII
for (let cp = 0xA0; cp <= 0xFF; cp++) probe += String.fromCodePoint(cp);   // Latin-1
for (let cp = 0x2500; cp <= 0x257F; cp++) probe += String.fromCodePoint(cp); // Box-drawing

const shapeCache = new MonospaceShapeCache(shaper);
shapeCache.prime(probe);

bridge.setShaper(shaper, shapeCache);
```

### Sequencing

| Phase | Files | Time | Savings |
|-------|-------|------|---------|
| 0 (now) | WorkerBridge.js: strip dead fields | 5 min | ~15MB less clone (~3% of load) |
| 1 | hbjs.js + HarfBuzzShaper.js: `shapeDirect()` replaces `buffer.json()` | 30 min | ~35% of load (all callers benefit) |
| 2 | MonospaceShapeCache.js + shapeText.js + WorkerBridge.js + GitHubRepoViewer.js: cache | 2-3 hours | ~58% of load (eliminates WASM calls) |
| 3 | GlyphWorker.js: store glyph map (plumbing only, no behavior change) | 15 min | 0 (future Tier 3 prep) |
| Validate | Shape 1000 lines via HarfBuzz and cache, diff `g` and `ax` per glyph | 30 min | Confidence |
| Future | Worker-side reconstruction (workers shape from text + map, no shaped objects in postMessage) | 2-4 hours | Eliminates remaining clone cost |

## Implementer Vote

**Caching** -- the entire optimization hinges on the per-codepoint cache being correct. Caching agent has the deepest understanding of the monospace invariant, the surrogate pair handling, the `emptyGlyphs` interaction, and the `cl` reconstruction semantics. They should own the implementation to ensure the cache contract is right.
