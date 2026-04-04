# Phase 0 -- Transfer: Serialize Cost, Structured Clone, and Zero-Copy Strategies

Agent perspective: main thread <-> worker communication overhead in the shaping/buffer pipeline.

## 1. What Exactly Is Being Serialized?

### The postMessage payload (WorkerBridge.js:139-151)

```js
worker.postMessage({
    type: 'BUILD_BATCH',
    jobId,
    payload: {
        items: shapedItems,       // <-- the big one
        shared: {
            metrics: shared.metrics,
            defaultColor: shared.defaultColor,
            upem: this._upem,
            emptyGlyphs: shared.emptyGlyphs || null,
        }
    }
});
```

Each `shapedItem` is built at WorkerBridge.js:132-135:
```js
const shapedItems = items.map(item => {
    const shapedResult = shapeText(this._shaper, item.text || '');
    return { ...item, shaped: shapedResult };
});
```

### Per-item structure after spreading

Each item sent to the worker carries:
- `text`: string (the full source file text -- kept for no reason the worker uses)
- `position`: `{x, y, z}` -- 3 properties
- `color`: `{r, g, b}` -- 3 properties
- `scale`: number
- `groupId`: number
- `id`: number/string (collection ID)
- `options`: object (redundant with the flattened color/scale/groupId)
- `shaped`: the shapeText() result (the expensive part)

### The shaped result structure (shapeText.js:27-43, HarfBuzzShaper.js:87-108)

`shapeText()` returns:
```js
{ lines: Array<{ shaped: Array<{g, cl, ax, ay, dx, dy, flags}>, text: string }>, totalGlyphs: number }
```

Each glyph object has **7 properties** (g, cl, ax, ay, dx, dy, flags). These are plain JS objects produced by `buffer.json()` in hbjs.js:1302-1312, which internally calls `JSON.parse(this.serialize(..., "JSON", ...))`. So HarfBuzz serializes to a JSON string, parses it into objects, then structured clone deep-copies those objects again for the worker transfer.

### Data volume estimate for 951 files

Assuming an average source file has ~150 lines, ~40 characters per line = ~6000 glyphs/file:

- **Per glyph**: 7 numeric properties on a plain object. V8 structured clone: ~56 bytes for the 7 doubles + object header overhead (~32 bytes for hidden class pointer, property storage) = ~88 bytes/glyph conservatively.
- **Per line**: `{ shaped: [...], text: "..." }` -- the `text` string is also cloned (average ~40 chars = ~80 bytes UTF-16).
- **Per file shaped result**: 6000 glyphs * 88 bytes + 150 lines * 80 bytes = ~540 KB shaped data.
- **Per file total payload**: shaped data + `text` string (~12 KB) + position/color/options = ~552 KB.
- **951 files**: ~525 MB of structured clone traffic total.

Even if files are batched (which they are -- `_pendingAdds` accumulates and `flushAsync` sends them all), the single `postMessage` must structured-clone ~525 MB of nested JS objects. This is not one postMessage per file; it is one massive postMessage containing all 951 items. That is the 15.6% serialize cost.

### Redundant data in the payload

The `text` string is spread into each shapedItem (WorkerBridge.js:134 `{ ...item, shaped }`), but `buildBatchBuffers` (builders/index.js:95-324) **never reads `item.text`**. It reads only `item.shaped`, `item.position`, `item.color`, `item.scale`, `item.groupId`. The original text strings are dead weight in the transfer -- ~12 KB per file, ~11 MB total for 951 files.

Similarly, `item.id` and `item.options` are not used by the builder. They add overhead for no reason.

## 2. The "serialize" Function

There is no custom `serialize` function. The 15.6% cost is the browser's built-in **structured clone algorithm** invoked by `postMessage`. Structured clone must:

1. Walk every reachable JS object recursively
2. Serialize each object's properties and values
3. Allocate equivalent objects in the worker's heap
4. Deserialize into those objects

For deeply nested structures (array of objects containing arrays of objects with 7 numeric fields each), this is maximally expensive per byte -- far worse than cloning flat typed arrays.

## 3. Strategy: Transferable ArrayBuffers (Pre-Pack on Main Thread)

### The core idea

Instead of posting `Array<{g, cl, ax, ay, dx, dy, flags}>` per line, pack shaped results into a single `Float32Array` on the main thread, then **transfer** (zero-copy) to the worker.

### Concrete layout

Per glyph, the worker needs 4 values from shaped data: `g`, `ax`, `dx`, `dy` (builders/index.js:195-199). `cl` and `ay` and `flags` are unused by the buffer builder. So:

```
Float32Array shapedBuffer: [g0, ax0, dx0, dy0, g1, ax1, dx1, dy1, ...]
```

4 floats * 4 bytes = **16 bytes/glyph** (vs ~88 bytes/glyph for JS objects).

For 951 files * ~6000 glyphs = ~5.7M glyphs:
- Current: ~500 MB of structured clone
- Proposed: 5.7M * 16 bytes = **91 MB** as a typed array, transferred in **O(1)** (pointer swap, zero copy)

### Line boundaries

The builder iterates `shaped.lines[lineIdx]`. We need a parallel `Int32Array` of line-start offsets into the packed buffer:

```
Int32Array lineOffsets: [0, lineLen0, lineLen0+lineLen1, ...]
```

Both arrays are Transferable. Total overhead for the transfer itself: ~0.

### Implementation sketch

In WorkerBridge.js, after shaping:
```js
// Pack all shaped results into a single transferable buffer
let totalGlyphs = 0;
const lineOffsetArrays = [];
for (const item of items) {
    const shaped = shapeText(this._shaper, item.text || '');
    let itemGlyphs = 0;
    const offsets = [0];
    for (const line of shaped.lines) {
        itemGlyphs += line.shaped.length;
        offsets.push(itemGlyphs);
    }
    lineOffsetArrays.push(offsets);
    totalGlyphs += itemGlyphs;
}

const shapedBuf = new Float32Array(totalGlyphs * 4);
let cursor = 0;
for (const item of items) {
    for (const line of item._shaped.lines) {
        for (const sg of line.shaped) {
            shapedBuf[cursor++] = sg.g;
            shapedBuf[cursor++] = sg.ax;
            shapedBuf[cursor++] = sg.dx;
            shapedBuf[cursor++] = sg.dy;
        }
    }
}

worker.postMessage({
    type: 'BUILD_BATCH', jobId,
    payload: {
        shapedBuffer: shapedBuf,         // Transferable
        lineOffsets: lineOffsetsFlat,     // Transferable
        itemPositions: positionsFlat,     // Transferable (vec3 * N items)
        itemColors: colorsFlat,          // Transferable (vec3 * N items)
        itemScales: scalesFlat,          // Transferable (float * N items)
        itemGroupIds: groupIdsFlat,      // Transferable (float * N items)
        itemGlyphCounts: glyphCountsFlat,// Transferable
        shared: { metrics, defaultColor, upem, emptyGlyphs }
    }
}, [shapedBuf.buffer, lineOffsetsFlat.buffer, positionsFlat.buffer, ...]);
```

The `shared` object is small (~200 bytes) and can remain structured-cloned.

### Savings

| What | Before | After | Reduction |
|------|--------|-------|-----------|
| Shaped glyph data | ~500 MB structured clone | 91 MB zero-copy transfer | **100% of clone cost eliminated** |
| Item metadata (text, id, options) | ~15 MB structured clone | ~30 KB flat arrays | **99.8%** |
| postMessage wall time | 15.6% of total | Near zero | **~15% total time saved** |

## 4. Strategy: Eliminate the Worker Hop

If shaping + buffer building both run on the main thread, there is no serialization cost at all. The sync fallback path already does this (WorkerBridge.js:205-217).

**Tradeoff**: Buffer building for 951 files * 6000 glyphs takes measurable time (~100-300ms based on the single-pass builder). This blocks the UI thread, causing frame drops during loading.

**Hybrid approach**: Use a single worker for buffer building but eliminate the structured clone. With Transferable arrays, the "single worker" path has near-zero transfer cost and still keeps the main thread responsive.

## 5. Strategy: SharedArrayBuffer

SharedArrayBuffer allows both threads to read the same memory without any transfer.

### How it would work
1. Main thread shapes text, writes results into a SharedArrayBuffer
2. Worker reads directly from the same buffer -- no postMessage data at all
3. Synchronization via `Atomics.notify()` / `Atomics.wait()`

### Constraints
- Requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers
- The Go CLI server would need to add these headers (relay.go)
- Third-party resources (fonts, WASM) must have CORS headers or be same-origin
- Since glyph3d-cli embeds everything, same-origin is already true -- just need the COOP/COEP headers

### Verdict
SharedArrayBuffer is the highest-performance option but adds deployment complexity. The Transferable ArrayBuffer approach gets 95%+ of the benefit with zero header requirements. I recommend Transferable first, SharedArrayBuffer as a Phase 2 optimization if needed.

## 6. Strategy: Batching Optimization

Currently, `flushAsync()` (GlyphCollection.js:570) already batches: it collects all `_pendingAdds` and sends them in one `postMessage`. This is correct. The problem is not the number of postMessage calls -- it is the size of the single message.

However, there is a sub-optimization: **round-robin dispatch** (WorkerBridge.js:159-163) sends the entire batch to one worker. If we split the batch across N workers, each worker processes a fraction:

```
951 items / 3 workers = 317 items per worker
```

This parallelizes buffer building but increases the number of postMessage calls from 1 to 3. With Transferable buffers, the transfer cost per message is O(1), so splitting is pure win for parallelism.

## 7. Quick Win: Strip Dead Data Before Posting

Even without the Transferable rewrite, stripping unused fields before postMessage would reduce clone volume by ~20%:

```js
// WorkerBridge.js:132-135, replace with:
const shapedItems = items.map(item => ({
    position: item.position,
    color: item.color,
    scale: item.scale,
    groupId: item.groupId,
    shaped: shapeText(this._shaper, item.text || '')
}));
```

This drops `text`, `id`, `options`, and any other properties from the transfer. Cost: 5 minutes of work. Savings: ~15 MB less structured clone for 951 files.

## 8. Double JSON.parse in the Shaping Path

A subtle cost in `HarfBuzzShaper.shape()` (line 93): `buffer.json()` calls `JSON.parse(this.serialize(..., "JSON", ...))` in hbjs.js:1303-1304. HarfBuzz serializes glyphs to a JSON string in WASM, then the JS binding parses that string into JS objects. These objects are then structured-cloned by postMessage.

The data path is: **WASM memory -> JSON string -> JS objects -> structured clone -> worker JS objects**.

With the Transferable approach, it becomes: **WASM memory -> JSON string -> JS objects -> Float32Array pack -> zero-copy transfer -> worker reads typed array**. The JSON parse still happens, but the structured clone is eliminated.

The ultimate optimization (future) would be a custom HarfBuzz binding that writes shaped results directly into a Float32Array from WASM memory, skipping JSON entirely. The harfbuzzjs `serialize()` function writes to a WASM buffer that could theoretically be read as a typed array view, but the current binding API does not expose this.

## 9. Recommendations (Priority Order)

1. **Strip dead fields** before postMessage (5 min, ~20% clone reduction)
2. **Pre-pack shaped data into Float32Array**, use Transferable transfer list (2-4 hours, eliminates ~100% of clone cost for shaped data)
3. **Split batches across workers** for parallel buffer building (1 hour, better CPU utilization)
4. **SharedArrayBuffer** for zero-copy shared memory (4-8 hours, marginal gain over Transferable, adds header requirements)
5. **Custom HarfBuzz typed-array binding** to skip JSON.parse entirely (research project, high risk)

The combination of (1) + (2) + (3) should reduce the 15.6% serialize cost to effectively 0%.
