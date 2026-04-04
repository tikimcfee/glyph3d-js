# Phase A: HarfBuzz Shaping Pipeline — Concrete Changes

Agent: `shaping-pipeline`
Scope: HarfBuzz WASM integration, font loading, worker compatibility, shaped output through buffer builders, codepoint-to-glyphId transition, DataTexture format changes.

---

## Decision Summary

1. **`textToGlyphs.js` is eliminated.** HarfBuzz provides glyph IDs + advances directly; no separate grapheme-to-glyph mapping step.
2. **`layoutText.js` is eliminated.** HarfBuzz x_advance replaces fixed-width cursor math. Newline/Z-wrap logic moves into the builder.
3. **`buildGlyphBuffers()` and `buildBatchBuffers()` absorb shaping.** They call the HarfBuzz shaper inline, consume shaped output, and write buffers in one pass.
4. **`instanceCodepoint` stays as an attribute name for Phase A.** The numeric ID changes from `graphemeId` to HarfBuzz `glyphId`, but the shader lookup mechanism (atlasMapTexture) is unchanged. Rename to `instanceGlyphId` deferred to Phase B.
5. **Font file delivered as `ArrayBuffer` via `postMessage` (transferable).** One copy per worker, cached alongside the uvMap.
6. **HarfBuzz WASM loaded once per worker via `hb.createBlob/createFace/createFont`.** Persistent across jobs; destroyed only on worker termination.

---

## Font File Delivery

```
Main thread                          Worker
───────────                          ──────
fetch('/fonts/Cousine-Regular.ttf')
  → ArrayBuffer
  → postMessage({type:'INIT_FONT',   onmessage: INIT_FONT
     fontBuffer}, [fontBuffer])         hbBlob = hb.createBlob(fontBuffer)
                                        hbFace = hb.createFace(hbBlob, 0)
                                        hbFont = hb.createFont(hbFace)
                                        // cached for all future jobs
```

The `.ttf` is fetched once on main thread (or embedded via the Go binary's static server), then transferred (zero-copy) to each worker. Workers cache `hbFont` for the session.

Main thread also needs the font for `GlyphAtlas.generate()` (Phase A keeps bitmap atlas). The atlas currently uses CSS font names (`fontFamily`). Two options:
- **Keep CSS font**: Load `.ttf` via `@font-face`, atlas continues using `ctx.fillText()` with the same font. HarfBuzz shaping happens in workers using the raw `.ttf` buffer.
- **Use `opentype.js` on main thread**: Parse the `.ttf` to extract metrics for the atlas. Overkill for Phase A.

**Decision**: Keep CSS `@font-face` for the atlas. Workers get the raw `.ttf` ArrayBuffer.

---

## HarfBuzz WASM in Worker Context

`harfbuzzjs` has zero DOM dependency. WASM instantiation works in `DedicatedWorkerGlobalScope`.

### GlyphWorker.js Changes

New message type `INIT_FONT` before any `BUILD`/`BUILD_BATCH`. New persistent state alongside the existing `cachedUVMap`/`cachedGlyphWidths`:

```javascript
// GlyphWorker.js — new state
import hb from 'harfbuzzjs'; // or dynamic import of the WASM module

let hbBlob = null;
let hbFace = null;
let hbFont = null;
let hbReady = false;

self.onmessage = function(event) {
    const { type, jobId, payload } = event.data;
    switch (type) {
        case 'INIT_FONT': {
            // payload.fontBuffer: ArrayBuffer (transferred, zero-copy)
            // payload.hbWasm: optional — URL or pre-fetched WASM bytes
            if (hbFont) { hbFont.destroy(); hbFace.destroy(); hbBlob.destroy(); }
            hbBlob = hb.createBlob(payload.fontBuffer);
            hbFace = hb.createFace(hbBlob, 0);
            hbFont = hb.createFont(hbFace);
            hbReady = true;
            self.postMessage({ type: 'FONT_READY', jobId });
            break;
        }
        case 'BUILD_BATCH': {
            // existing uvMap/glyphWidths caching stays
            const shared = { ...payload.shared, hbFont, hbReady };
            const result = buildBatchBuffers(payload.items, shared);
            // ... transfer as before
        }
    }
};
```

**Memory management**: `hbFont`/`hbFace`/`hbBlob` persist for the worker's lifetime. `hb.createBuffer()` is created and destroyed per `shape()` call inside the builder (see below). The per-call buffer is ~200 bytes — no leak concern if `destroy()` is always called.

---

## Data Flow: Text String to Instance Attributes

### Current Flow (per item in `buildBatchBuffers`)
```
text → iterGraphemes(text) → for each grapheme:
  uvMap[grapheme] → numericId
  glyphWidths[grapheme] → pixel width × worldScale
  write: position, size, codepoint=numericId, color, groupId
```

### New Flow (per item in `buildBatchBuffers`)
```
text → hbShape(hbFont, text) → [{g, ax, ay, dx, dy, cl}, ...]
  for each shaped glyph:
    glyphId = g
    advance = ax * fontScale (HarfBuzz units → world units)
    uvMap[glyphId] → existence check (fall back to '?' glyph)
    write: position, size(advance, lineHeight), codepoint=glyphId, color, groupId
```

The critical change: iteration is no longer over grapheme clusters. HarfBuzz handles grapheme segmentation, ligature substitution, and reordering internally. The output is a flat array of positioned glyphs.

### New Helper: `shapeText(hbFont, text, fontScale)`

Lives in `src/workers/builders/shapeText.js` (new file, worker-safe, no DOM):

```javascript
import hb from 'harfbuzzjs';

/**
 * Shape text using HarfBuzz and return positioned glyphs.
 * 
 * @param {Object} hbFont - HarfBuzz font object (persistent per worker)
 * @param {string} text - Raw text (may contain newlines)
 * @param {number} upem - Units per em from the font (hbFace.upem)
 * @param {number} worldScale - World units per font unit
 * @returns {Array<{glyphId: number, advance: number, xOffset: number, yOffset: number, cluster: number}>}
 */
export function shapeText(hbFont, text, upem, worldScale) {
    // Split on newlines — HarfBuzz shapes one line at a time
    // Return a structured result with line breaks preserved as markers
    const result = [];
    const lines = text.split('\n');
    
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (lineIdx > 0) result.push({ newline: true });
        
        const line = lines[lineIdx];
        if (line.length === 0) continue;
        
        const buffer = hb.createBuffer();
        buffer.addText(line);
        buffer.guessSegmentProperties();
        hb.shape(hbFont, buffer);
        const glyphs = buffer.json();
        buffer.destroy(); // CRITICAL: manual cleanup
        
        const scale = worldScale / upem;
        for (const g of glyphs) {
            result.push({
                glyphId: g.g,
                advance: g.ax * scale,
                xOffset: g.dx * scale,
                yOffset: g.dy * scale,
                cluster: g.cl
            });
        }
    }
    return result;
}
```

---

## Changes to `buildBatchBuffers()` (index.js lines 268-492)

The inner loop currently iterates graphemes via `iterGraphemes(text)`. Replace with shaped glyph iteration:

```javascript
// BEFORE (line 350): for (const grapheme of iterGraphemes(text)) {
// AFTER:
const shaped = shared.hbReady
    ? shapeText(shared.hbFont, text, shared.upem, ws)
    : fallbackShape(text, uvMap, glyphWidths, ws); // graceful degradation

for (const sg of shaped) {
    if (sg.newline) {
        // same newline handling as before (lines 353-362)
        if (x > pos.x) itemMaxX = Math.max(itemMaxX, x - metrics.letterSpacing);
        x = pos.x;
        y -= metrics.lineSpacing;
        z = startZ;
        itemMinY = y;
        glyphsOnSegment = 0;
        itemLineSlotOffsets.push(bufferOffset);
        continue;
    }
    
    const glyphWidth = sg.advance; // HarfBuzz provides this directly
    
    // Space detection: glyphId 3 is typically space in most fonts,
    // but better to check advance-only glyphs (glyphId with zero contours).
    // For Phase A, check against uvMap — if the glyphId has no atlas entry
    // and advance > 0, treat as whitespace.
    const entry = uvMap[sg.glyphId];  // NOTE: uvMap keying changes — see below
    if (!entry && sg.advance > 0) {
        // Whitespace-like glyph — advance cursor, no render
        x += glyphWidth + metrics.letterSpacing;
        glyphsOnSegment++;
        continue;
    }
    
    // Z-wrap logic stays (lines 371-379)
    
    const resolvedEntry = entry || fallbackEntry;
    if (!resolvedEntry) { x += glyphWidth + metrics.letterSpacing; continue; }
    
    positions[bufferOffset * 3] = x + sg.xOffset;
    positions[bufferOffset * 3 + 1] = y + sg.yOffset;
    positions[bufferOffset * 3 + 2] = z;
    
    sizes[bufferOffset * 2] = glyphWidth;
    sizes[bufferOffset * 2 + 1] = scaledHeight;
    
    codepoints[bufferOffset] = sg.glyphId;  // HarfBuzz glyph ID, not codepoint
    
    // color, groupId same as before
    
    bufferOffset++;
    x += glyphWidth + metrics.letterSpacing;
    glyphsOnSegment++;
}
```

**Key differences from current code**:
- No `iterGraphemes()` call — HarfBuzz handles segmentation
- No `glyphWidths[grapheme]` lookup — advance comes from shaped output
- `xOffset`/`yOffset` applied to position (diacritics, mark attachment)
- `codepoints` buffer now holds HarfBuzz glyph IDs, not grapheme-derived numeric IDs
- `countGlyphs()` pre-count needs adjustment — HarfBuzz may produce fewer glyphs than graphemes (ligatures) or more (decomposition)

### Pre-count Problem

`countGlyphs(text)` (line 37) counts renderable grapheme clusters to pre-allocate buffers. With HarfBuzz, the glyph count is only known after shaping. Two options:

1. **Shape first, allocate second**: Shape all items, sum glyph counts, then fill buffers. Costs one extra `shapeText()` call or caching the shaped results.
2. **Over-allocate**: Use `countGlyphs(text)` as upper bound (ligatures reduce count, decomposition is rare for code). Trim at the end with `subarray()`.

**Decision**: Shape first, cache results. The shaping cost is trivial (~0.1ms per 1000 chars). Store shaped results in a temporary array, sum counts, allocate once, fill once.

---

## uvMap Keying: Grapheme String to Glyph ID

### Current
`uvMap` is `Map<string, {u0, v0, u1, v1, numericId}>`, keyed by grapheme string (e.g., `"A"`, `"fi"`, `"😀"`). The `numericId` is the codepoint for single-codepoint graphemes or a synthetic dense ID for multi-codepoint graphemes.

Serialized for workers as `Object<string, {u0, v0, u1, v1, numericId}>`.

### Phase A Change
HarfBuzz returns integer glyph IDs (indices into the font's glyph table). The atlas must map glyph IDs, not grapheme strings.

**Two-layer approach** (backward compatible):
1. `GlyphAtlas` continues generating glyphs from grapheme strings (Canvas 2D `fillText`).
2. New method `atlas.getGlyphIdMap(hbFont)` builds a `Map<number, {u0, v0, u1, v1}>` by:
   - For each grapheme in the atlas, shape it through HarfBuzz to get its glyph ID
   - Map that glyph ID to the existing UV entry

```javascript
// GlyphAtlas.js — new method
getGlyphIdMap(hbFont, hb) {
    const map = {};
    for (const [grapheme, uv] of this.uvMap) {
        const buffer = hb.createBuffer();
        buffer.addText(grapheme);
        buffer.guessSegmentProperties();
        hb.shape(hbFont, buffer);
        const glyphs = buffer.json();
        buffer.destroy();
        if (glyphs.length === 1) {
            map[glyphs[0].g] = { ...uv, numericId: glyphs[0].g };
        }
        // Ligature graphemes (e.g., "fi" → single glyph): also mapped
        // Multi-glyph decomposition: each sub-glyph gets the same UV (imperfect but functional)
    }
    return map;
}
```

This runs once at init (after atlas generation + HarfBuzz font load), producing a `glyphIdUvMap` that replaces `uvMap` in the worker payload.

Workers receive `glyphIdUvMap` instead of `uvMap`. The builder indexes by `sg.glyphId` instead of by grapheme string.

---

## atlasMapTexture / DataTexture Changes

### Current
`atlasMapTexture` is a 1024-wide RGBA Float DataTexture. Texel at index `numericId` stores `(u0, v0_webgl, u1, v1_webgl)`. The vertex shader does:
```glsl
float cp = instanceCodepoint;       // numericId (codepoint or synthetic)
float mapCol = mod(cp, atlasMapWidth);
float mapRow = floor(cp / atlasMapWidth);
vec4 uvRect = texture(atlasMapTexture, vec2(tx, ty));
```

### Phase A
Same texture format. The only change: populate it with HarfBuzz glyph IDs instead of codepoint-based numericIds.

`GlyphAtlas.getAtlasMapTexture()` currently fills the texture by iterating `_graphemeIds` (grapheme → numericId). New path:

```javascript
// Fill atlasMapTexture using glyph IDs from HarfBuzz
fillAtlasMapForGlyphIds(glyphIdUvMap, THREE) {
    // Find max glyph ID to size the texture
    const maxId = Math.max(...Object.keys(glyphIdUvMap).map(Number));
    const width = 1024;
    const height = Math.ceil((maxId + 1) / width);
    const data = new Float32Array(width * height * 4);
    
    for (const [idStr, uv] of Object.entries(glyphIdUvMap)) {
        const id = Number(idStr);
        const idx = id * 4;
        data[idx + 0] = uv.u0;
        data[idx + 1] = 1.0 - uv.v0; // V-flip for WebGL
        data[idx + 2] = uv.u1;
        data[idx + 3] = 1.0 - uv.v1;
    }
    // Create DataTexture same as existing getAtlasMapTexture()
}
```

The vertex shader is **unchanged** — it still does `texelFetch(atlasMapTexture, ...)` using the value from `instanceCodepoint`. The semantic changes from "codepoint" to "glyphId" but the lookup mechanism is identical.

---

## What Stays the Same

- `GlyphAtlas` bitmap generation (Canvas 2D shelf-packing)
- `GlyphRenderer` instanced pipeline, attribute layout (10 floats/glyph)
- Vertex shader GPU-lookup path (atlasMapTexture)
- Fragment shader (bitmap sampling, alpha discard, highlight)
- `_highlightTexture` (RGBA8, per-instance)
- `_groupTexture` (per-group transforms)
- `PickingSystem` (material-swap second render pass)
- `WorkerBridge` pool management (round-robin, promise API)
- `GlyphWorker` message protocol structure (`BUILD`, `BUILD_BATCH`, transferables)
- Z-wrap, pagination, bounds tracking in builders

## What Breaks / Needs Migration

| Component | Change | Risk |
|-----------|--------|------|
| `iterGraphemes()` in builders | Replaced by HarfBuzz shaped output | Low — clean replacement |
| `uvMap` keying (grapheme string → glyph ID integer) | Workers receive `glyphIdUvMap` | Medium — must regenerate map |
| `countGlyphs()` pre-allocation | Shape-first approach needed | Low — minor restructure |
| `glyphWidths` worker cache | Eliminated — HarfBuzz provides advances | Low — remove dead code |
| `textToGlyphs.js` | Dead code | None — just remove import |
| `layoutText.js` | Dead code for shaped path | None — keep as fallback |
| `GlyphAtlas._graphemeIds` | Still used for atlas generation; new `glyphIdMap` for lookups | Low |
| `WorkerBridge.getSerializedUVMap()` | Must serialize `glyphIdUvMap` instead | Low |
| `applyPrebuiltBuffers` fallback `itemMeta` recount (line 1364) | Must use shaped glyph count, not `iterGraphemes` count | Medium — silent bug if missed |

---

## Memory Management Checklist

HarfBuzz WASM objects require manual `destroy()`:

| Object | Lifetime | Destroy When |
|--------|----------|-------------|
| `hbBlob` | Worker session | Worker terminated or font reloaded |
| `hbFace` | Worker session | Worker terminated or font reloaded |
| `hbFont` | Worker session | Worker terminated or font reloaded |
| `hb.createBuffer()` | Per `shapeText()` call | End of each `shapeText()` — **must be in finally block** |

```javascript
// shapeText() — safe cleanup
const buffer = hb.createBuffer();
try {
    buffer.addText(line);
    buffer.guessSegmentProperties();
    hb.shape(hbFont, buffer);
    return buffer.json();
} finally {
    buffer.destroy();
}
```

Worker termination (`WorkerBridge.dispose()`) should send a `CLEANUP` message so workers can call `hbFont.destroy()` etc. Currently `WorkerBridge` has no `dispose()` — add one.

---

## File Change Summary

| File | Action | Lines Changed (est.) |
|------|--------|---------------------|
| `src/workers/builders/shapeText.js` | **NEW** — HarfBuzz shape wrapper | ~60 |
| `src/workers/builders/index.js` | Import shapeText, modify `buildBatchBuffers` inner loop | ~80 |
| `src/workers/GlyphWorker.js` | Add `INIT_FONT` handler, persistent hb state | ~30 |
| `src/workers/WorkerBridge.js` | Font delivery, `glyphIdUvMap` serialization, `dispose()` | ~40 |
| `src/GlyphAtlas.js` | Add `getGlyphIdMap()`, `fillAtlasMapForGlyphIds()` | ~50 |
| `src/GlyphRenderer.js` | No changes for Phase A (shader + attributes unchanged) | 0 |
| `src/workers/builders/textToGlyphs.js` | Mark deprecated / remove import | ~2 |
| `src/workers/builders/layoutText.js` | Mark deprecated / keep as non-HarfBuzz fallback | ~2 |
| `src/workers/builders/buildBuffers.js` | Already unused by main path — no change | 0 |
