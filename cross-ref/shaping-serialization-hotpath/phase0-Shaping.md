# Phase 0 — Shaping Agent Analysis

## Executive Summary

The main-thread shaping bottleneck has two separable costs: the WASM `hb_shape()` call itself (~23%) and the `buffer.json()` serialization round-trip (~20% + ~15%). The serialization cost is avoidable — harfbuzzjs exposes direct WASM memory reads (`getGlyphInfosAndPositions`) that bypass serialize→JSON.parse entirely. The "glyphToJson" in the profiler is **not** the outline extractor — it's `buffer.json()` calling `buffer.serialize("JSON")` then `JSON.parse()`, which runs 951 times during load. Two dedicated shaping workers at ~32MB total would pipeline shaping off the main thread. The main thread can be reduced to a pure dispatcher.

---

## 1. Current Architecture: Where Shaping Runs

### Call chain (per file load)

```
GlyphCollection.flush()                          # src/collections/GlyphCollection.js:638
  → WorkerBridge.buildBatchBuffers(items, ...)    # src/workers/WorkerBridge.js:118
    → items.map(item => shapeText(shaper, text))  # WorkerBridge.js:132-134  ← MAIN THREAD, SERIAL
      → shapeText() splits on '\n'                # src/shaping/shapeText.js:28-42
        → shaper.shape(lineText)                  # shapeText.js:37
          → hb.shape(font, buffer)                # HarfBuzzShaper.js:92  ← WASM shape()
          → buffer.json()                         # HarfBuzzShaper.js:93  ← serialize + JSON.parse
    → worker.postMessage({items: shapedItems})     # WorkerBridge.js:139
      → buildBatchBuffers() in worker             # GlyphWorker.js:35
```

The shaping loop at **WorkerBridge.js:132-134** runs synchronously on the main thread for every item in the batch. For 951 files, this is 951 `shapeText()` calls, each of which calls `shaper.shape()` once per non-empty line. A typical source file has ~50-200 lines, so this is roughly **50,000-190,000** individual `hb_shape()` + `buffer.json()` calls on the main thread.

### Why it moved to main thread (history)

Previously, every worker had its own HarfBuzzShaper instance. With `navigator.hardwareConcurrency - 1` workers (up to 31), each allocating ~16MB WASM heap, this caused 500MB+ OOM on large repos. The fix (current state) was to consolidate to a single main-thread WASM instance. This solved OOM but created a serial bottleneck.

---

## 2. The `buffer.json()` Problem — The Hidden 35% Cost

### Profile attribution is misleading

The profiler shows:
- `shape (HarfBuzz WASM)`: 23.1%
- `json/glyphToJson`: 20.5%
- `serialize`: 15.6%

The `json/glyphToJson` entry is **not** `SlugEncoder._encodeGlyph()` calling `this._shaper.glyphOutline()`. It's `buffer.json()` at **HarfBuzzShaper.js:93**, which is called on every `shape()` invocation. Here's why:

**`buffer.json()` call chain** (hbjs.js:1302-1311):
```js
json: function () {
    var buf = this.serialize(null, 0, null, "JSON", ["NO_GLYPH_NAMES", "GLYPH_FLAGS"]);
    var json = JSON.parse(buf);
    json.forEach(function (glyph) {
        glyph.flags = glyph.fl || 0;
        delete glyph.fl;
    });
    return json;
}
```

This does three expensive things per call:
1. **`serialize()`** (hbjs.js:1256): Calls `hb_buffer_serialize()` in WASM, builds a JSON string by concatenating UTF-8 chunks from WASM memory. Mallocs 32KB per call.
2. **`JSON.parse(buf)`**: Parses that string back into JS objects.
3. **`.forEach()` + `delete`**: Iterates all glyphs, renames `fl` to `flags`, deletes the old key (deoptimizes V8 hidden classes).

For a 100-character line, that's: WASM→string (serialize) + string→objects (parse) + object mutation (delete). Multiply by ~100,000 lines across 951 files.

### The direct memory path exists and is unused

harfbuzzjs already exposes `buffer.getGlyphInfosAndPositions()` (hbjs.js:1186-1215) which reads directly from WASM HEAP32/HEAPU32 memory — no serialize, no JSON.parse, no string allocation:

```js
getGlyphInfosAndPositions: function () {
    var infosPtr32 = exports.hb_buffer_get_glyph_infos(ptr, 0) / 4;
    var infosArray = Module.HEAPU32.subarray(infosPtr32, ...);
    var positionsPtr32 = exports.hb_buffer_get_glyph_positions(ptr, 0) / 4;
    var positionsArray = Module.HEAP32.subarray(positionsPtr32, ...);
    // Direct struct reads: infosArray[i] = codepoint, infosArray[i+2] = cluster
    // positionsArray[i] = x_advance, [i+1] = y_advance, [i+2] = x_offset, [i+3] = y_offset
}
```

This still allocates JS objects per glyph (push to `out[]`), but skips the WASM→string→parse pipeline entirely. A further optimization would read directly into a flat typed array — no object allocation at all.

### Is `glyphToJson` called during load? VERDICT: NO (for outlines)

`SlugEncoder.encode()` is called **once** at startup (**GitHubRepoViewer.js:271-272**) for ~95 ASCII glyph IDs. That calls `_encodeGlyph()` which calls `shaper.glyphOutline()` → `font.glyphToJson()` (hbjs.js:630). This is a one-time cost of 95 calls, not per-file.

The 20.5% `json/glyphToJson` in the profiler is the `buffer.json()` method (hbjs.js:1302) called from `HarfBuzzShaper.shape()` at line 93, which runs ~100K times during the 951-file load. The profiler conflates `json` (the method name) with `glyphToJson` because Firefox groups by function name. These are two different functions on two different objects (`buffer.json` vs `font.glyphToJson`).

---

## 3. Per-Call Cost Breakdown

For a single `HarfBuzzShaper.shape(lineText)` call on a typical 80-char line:

| Step | Operation | Approx cost |
|------|-----------|-------------|
| 1 | `createBuffer()` + `addText()` | ~5us (WASM malloc + UTF-8 copy) |
| 2 | `guessSegmentProperties()` | ~1us |
| 3 | `hb_shape()` — the actual shaping | ~20-50us (depends on script complexity) |
| 4 | `serialize("JSON")` — WASM→string | ~15-30us (malloc 32KB, hb_buffer_serialize, UTF-8 decode) |
| 5 | `JSON.parse()` — string→objects | ~10-20us |
| 6 | `.forEach` + `delete fl` | ~5us |
| 7 | `buffer.destroy()` | ~2us |

Steps 4-6 are the serialization overhead: ~30-55us per line, or **roughly equal to the WASM shape() itself**. For 100K lines, that's 3-5.5 seconds of pure serialization waste.

The WASM `hb_shape()` at step 3 is irreducible — it's the actual shaping work. But steps 4-6 can be replaced by direct HEAP32 reads at ~5us per line (subarray + typed read loop), saving ~25-50us per call = **2.5-5 seconds** on the 951-file load.

---

## 4. Dedicated Shaping Workers — Architecture

### Proposal: 2 shaping workers

```
Main Thread (dispatcher only)
  ├── ShapingWorker 0  (HarfBuzz WASM, ~16MB)
  ├── ShapingWorker 1  (HarfBuzz WASM, ~16MB)
  ├── BufferWorker 0   (no WASM, buffer math only)
  ├── BufferWorker 1   (no WASM, buffer math only)
  └── BufferWorker 2   (no WASM, buffer math only)
```

Memory budget: 2 × ~16MB = ~32MB. Acceptable. The OOM was at 31 × 16MB = 500MB.

### Pipeline flow

```
Phase A (parallel shaping):
  Main thread splits 951 items into 2 batches (~475 each)
  → posts to ShapingWorker 0 and 1
  → each worker: for each item, shape all lines, return shaped arrays

Phase B (parallel buffer packing):
  Shaped results stream back to main thread
  → main thread round-robins shaped items to BufferWorker 0/1/2
  → workers pack Float32Arrays, transfer back

Phase C (GPU upload):
  Main thread applies buffers to GlyphRenderer
```

### What the main thread does today vs. proposed

**Today** (WorkerBridge.js:132-134):
```js
const shapedItems = items.map(item => {
    const shapedResult = shapeText(this._shaper, item.text || '');
    return { ...item, shaped: shapedResult };
});
```
This is synchronous, serial, blocking. 100% of shaping cost on the main thread.

**Proposed**: Main thread becomes a pure dispatcher:
1. Split items into N chunks (N = shaping worker count)
2. `postMessage` each chunk to a shaping worker
3. On shaped result, `postMessage` to a buffer-packing worker
4. On buffer result, apply to GPU

The main thread does zero WASM calls. Zero JSON.parse. Zero serialization.

### Transfer cost consideration

Shaped results need to cross the worker→main boundary. Currently, `shapeText()` returns:
```js
{ lines: [{ shaped: [{g, cl, ax, ay, dx, dy}, ...], text: "..." }, ...], totalGlyphs: N }
```

These are plain objects — structured clone cost scales with `totalGlyphs`. For a 500-line file with 40 chars/line = 20K glyphs × ~6 fields × ~8 bytes = ~960KB structured clone per file. With 475 files per worker, that's ~450MB of structured clone data. **This is too expensive.**

**Better approach**: Shaping workers return **flat typed arrays** instead of object arrays:
```js
// Per item: Float32Array of [g, cl, ax, ay, dx, dy] × totalGlyphs
// + Int32Array of line break offsets
// Transferable — zero-copy across worker boundary
```

This changes `shapeText()` to output `Float32Array` directly. The builder in the buffer-packing worker reads from the typed array instead of iterating objects. Zero structured clone — just buffer transfer.

---

## 5. Quick Win: Replace `buffer.json()` with Direct HEAP Reads

Before implementing dedicated workers, there's a ~35% reduction available by replacing `buffer.json()` with direct WASM memory reads in `HarfBuzzShaper.shape()`.

Current (HarfBuzzShaper.js:87-107):
```js
shape(text, features) {
    const buffer = this._hb.createBuffer();
    try {
        buffer.addText(text);
        buffer.guessSegmentProperties();
        this._hb.shape(this._font, buffer, features);
        const result = buffer.json();  // serialize→JSON.parse→delete
        return result;
    } finally {
        buffer.destroy();
    }
}
```

Proposed replacement:
```js
shape(text, features) {
    const buffer = this._hb.createBuffer();
    try {
        buffer.addText(text);
        buffer.guessSegmentProperties();
        this._hb.shape(this._font, buffer, features);
        // Direct HEAP reads — no serialize, no JSON.parse
        const infos = buffer.getGlyphInfos();
        const positions = buffer.getGlyphPositions();
        const len = infos.length;
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
            result[i] = {
                g: infos[i].codepoint,
                cl: infos[i].cluster,
                ax: positions[i].x_advance,
                ay: positions[i].y_advance,
                dx: positions[i].x_offset,
                dy: positions[i].y_offset,
            };
        }
        return result;
    } finally {
        buffer.destroy();
    }
}
```

Even better — a flat typed array version:
```js
shapeDirect(text, features) {
    const buffer = this._hb.createBuffer();
    try {
        buffer.addText(text);
        buffer.guessSegmentProperties();
        this._hb.shape(this._font, buffer, features);
        const len = buffer.getLength();
        // 4 values per glyph: glyphId, cluster, xAdvance, xOffset
        // (yAdvance and yOffset are always 0 for horizontal text)
        const out = new Float32Array(len * 4);
        // Read directly from WASM HEAP — zero intermediate objects
        const infosPtr = this._hb._exports.hb_buffer_get_glyph_infos(buffer.ptr, 0) / 4;
        const posPtr = this._hb._exports.hb_buffer_get_glyph_positions(buffer.ptr, 0) / 4;
        const heapU = this._hb.Module.HEAPU32;
        const heapI = this._hb.Module.HEAP32;
        for (let i = 0; i < len; i++) {
            out[i * 4]     = heapU[infosPtr + i * 5];      // glyphId
            out[i * 4 + 1] = heapU[infosPtr + i * 5 + 2];  // cluster
            out[i * 4 + 2] = heapI[posPtr + i * 5];         // xAdvance
            out[i * 4 + 3] = heapI[posPtr + i * 5 + 2];     // xOffset
        }
        return out;
    } finally {
        buffer.destroy();
    }
}
```

This eliminates:
- 32KB malloc per `serialize()` call (hbjs.js:1259)
- UTF-8 string building from WASM memory
- `JSON.parse()` of the entire buffer
- Object allocation per glyph
- `delete glyph.fl` property deletion (V8 deopt)

Expected savings: ~35% of total load time (the `json` + `serialize` profile entries).

---

## 6. Risks and Dependencies

| Risk | Mitigation |
|------|------------|
| `getGlyphInfos`/`getGlyphPositions` allocate JS objects internally | Use raw HEAP reads instead (shown in `shapeDirect` above) |
| harfbuzzjs internal API (`Module.HEAPU32`, `exports`) is not public | Vendor file is already local — we control it |
| Shaping workers need font buffer transfer | Font is ~50KB, transfer once at init |
| Flat typed arrays change the `shaped` contract | `buildBatchBuffers` (builders/index.js:194) reads `sg.g`, `sg.ax`, etc. — must adapt to flat array indexing |
| Monospace font simplifies things | Cousine-Regular is monospace — most ligatures/kerning features are no-ops, meaning `hb_shape()` is relatively fast. The serialization overhead is proportionally larger than for complex scripts. |

---

## 7. Recommended Priority Order

1. **Replace `buffer.json()` with direct HEAP reads** — Minimal code change (HarfBuzzShaper.js:shape method + builders/index.js inner loop). Expected ~35% reduction. Ship this first.

2. **Move shaping to 2 dedicated workers** — Requires new ShapingWorker.js, changes to WorkerBridge dispatch, typed-array transfer protocol. Expected additional ~20% reduction (parallelizes the remaining WASM cost across 2 cores).

3. **Pipeline shaping → buffer packing** — Shaped results stream directly to buffer workers without main-thread round-trip. Requires message forwarding or SharedArrayBuffer. Expected additional ~5-10% by hiding latency.

Total expected improvement: main-thread shaping blocked time drops from ~58% (shape + json + serialize) to near-zero — all shaping and serialization moves off main thread, and what remains is faster by ~60% from eliminating the serialize round-trip.
