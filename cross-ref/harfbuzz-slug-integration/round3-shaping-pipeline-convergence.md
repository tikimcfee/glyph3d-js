# Round 3: shaping-pipeline convergence

## Settled

1. **No fallback shaping path.** HarfBuzz WASM must initialize before any rendering. If init fails, the app does not start. No `fallbackShape()`, no dual-mode builders, no deprecated-but-kept files.

2. **Vendor the harfbuzzjs JS wrapper.** Copy the ~200-line `hb.js` into `src/shaping/harfbuzz-wasm.js`. Workers import by relative path. Bare specifiers cannot resolve without a bundler.

3. **Shaping code lives in `src/shaping/`.** `shapeText.js` is a domain concept, not a builder implementation detail. The constraint is worker-safety (no DOM, no Three.js), not directory location. `src/shaping/index.js` opens with `// Worker-safe: no DOM or Three.js imports allowed in this module`. Workers import via `../../shaping/shapeText.js`.

4. **Per-worker `_hbReady` flag.** Mirrors the existing `_hasUVMap` pattern at `WorkerBridge.js` line 107. Font buffer transferred to each worker via `INIT_FONT` message. Workers respond `FONT_READY`. No job dispatched until the target worker's `_hbReady` is true.

5. **`try/finally` on `hb.createBuffer()`.** Non-negotiable. Every `shapeText()` call creates and destroys a buffer in a try/finally block.

6. **`WorkerBridge.dispose()` sends `CLEANUP` before `worker.terminate()`.** Workers destroy `hbFont`, `hbFace`, `hbBlob` on `CLEANUP`.

7. **Whitespace detection via cluster-based codepoint check.** `text.codePointAt(sg.cluster) === 32`. Not glyph-ID heuristics, not missing-UV-entry detection.

8. **Shape-first allocation.** Shape all items in a batch, count glyphs from shaped results, allocate typed arrays once, fill once. Shaped results stored in a reusable flat pool per dispatch to minimize heap allocations.

9. **Font URL: `/assets/fonts/Cousine-Regular.ttf`.** File committed at `assets/fonts/Cousine-Regular.ttf`. WASM binary at `assets/wasm/hb.wasm`, populated by `make prep-wasm`, `.gitignore`'d.

10. **`instanceCodepoint` keeps its name in Phase A.** The numeric value changes from grapheme-derived ID to HarfBuzz glyph ID, but the shader attribute name stays. Rename to `instanceGlyphId` deferred to Phase B alongside glyph-mode picking removal.

11. **Delete `textToGlyphs.js`, `layoutText.js`, `buildBuffers.js` in Phase A.** All three have zero live importers (confirmed via grep). `buildBuffers.js` has zero import statements pointing to it; `_buildBuffersSync` calls `buildGlyphBuffers` from `index.js`.

12. **Deprecate `BUILD` single-item path.** Route through `BUILD_BATCH` with a one-item array internally. One shaped code path, not two.

13. **`applyPrebuiltBuffers` fallback (GlyphRenderer.js line 1364-1380) removed.** The shaped builder always emits `itemMeta`. The `iterGraphemes`-based recount is a silent corruption source for any font with ligatures. Remove it; add a `throw` if `itemMeta` is missing from shaped output.

14. **Switch `atlasMapTexture` lookup to `texelFetch()`.** Low-priority cleanup. Removes two float uniforms (`atlasMapWidth`, `atlasMapHeight`). Shader intent becomes explicit. Not a correctness fix — NearestFilter + centering is already correct.

15. **`.ttf` MIME type in `relay.go`.** Add `case strings.HasSuffix(path, ".ttf"):` → `font/sfnt` alongside existing `.wasm` case at line 389.

16. **Phase B requires standalone prototype before integration.** `examples/slug-prototype/`: opentype.js loads font, extracts curves, packs HALF_FLOAT DataTexture, winding-number fragment shader, instanced draw. 10K quads at 60fps or Phase A is the stable endpoint.

17. **Phase B outline extraction uses `opentype.js`.** `font.glyphToPath()` does not exist in harfbuzzjs. `opentype.js` is isolated behind a `GlyphOutlineProvider` interface so it can be swapped if `libharfbuzz-gpu` stabilizes.

18. **`MAX_BANDS` compile-time cap in Phase B Slug shader.** For GPU divergence control on mobile drivers, not GLSL spec conformance.

---

## Implementation Plan

Phase A only. File-by-file, in execution order. Each step is a committable unit.

### Step 0: Prerequisites (cleanup before HarfBuzz touches anything)

**`src/GlyphRenderer.js`** — Remove the `iterGraphemes` fallback at lines 1364-1380.
```javascript
// REPLACE lines 1364-1380 with:
if (!itemMeta && items && items.length > 0) {
    throw new Error('applyPrebuiltBuffers: itemMeta is required for shaped output');
}
```

**`src/workers/GlyphWorker.js`** — Route `BUILD` through `BUILD_BATCH`:
```javascript
case 'BUILD': {
    // Deprecated: route single item through batch path
    const batchPayload = {
        shared: {
            metrics: payload.metrics,
            defaultColor: payload.color,
            uvMap: cachedUVMap,
            glyphWidths: cachedGlyphWidths,
        },
        items: [{
            text: payload.text,
            position: payload.position,
            color: payload.color,
            scale: payload.scale,
            groupId: payload.groupId,
        }],
    };
    // ... dispatch to BUILD_BATCH handler, post single-item result
}
```

**Delete** `src/workers/builders/textToGlyphs.js`, `src/workers/builders/layoutText.js`, `src/workers/builders/buildBuffers.js`.

### Step 1: Vendor HarfBuzz + font asset

**`assets/fonts/Cousine-Regular.ttf`** — Commit the font file. Add `assets/fonts/LICENSE-Cousine.txt` (Apache 2.0).

**`assets/wasm/.gitignore`** — Contains `*` and `!.gitignore`. WASM binary not committed.

**`Makefile`** — Add `assets` to `ASSETS` list. Add `prep-wasm` target:
```makefile
ASSETS := src app examples assets index.html package.json

prep-wasm:
	@mkdir -p assets/wasm
	@cp node_modules/harfbuzzjs/hb.wasm assets/wasm/hb.wasm
	@echo "Prepared HarfBuzz WASM"

build: prep-wasm prep
```

**`cli/relay.go`** — Add MIME type at line ~391:
```go
case strings.HasSuffix(path, ".ttf"):
    w.Header().Set("Content-Type", "font/sfnt")
```

### Step 2: Shaping module

**Create `src/shaping/shapeText.js`** (~50 lines). Worker-safe. No DOM, no Three.js.
```javascript
// src/shaping/shapeText.js
// Worker-safe: no DOM or Three.js imports allowed.

/**
 * Shape a text string using a pre-loaded HarfBuzz font.
 * Splits on newlines (HarfBuzz shapes one line at a time).
 * Returns a flat array of positioned glyphs with newline markers.
 *
 * @param {Object} hb - HarfBuzz module
 * @param {Object} hbFont - Persistent HarfBuzz font object
 * @param {string} text - Raw text (may contain newlines)
 * @param {number} upem - Units per em from hbFace.upem
 * @param {number} worldScale - World units per em
 * @returns {Array<{glyphId, advance, xOffset, yOffset, cluster}|{newline: true}>}
 */
export function shapeText(hb, hbFont, text, upem, worldScale) {
    const result = [];
    const lines = text.split('\n');
    const scale = worldScale / upem;

    for (let i = 0; i < lines.length; i++) {
        if (i > 0) result.push({ newline: true });
        const line = lines[i];
        if (line.length === 0) continue;

        const buffer = hb.createBuffer();
        try {
            buffer.addText(line);
            buffer.guessSegmentProperties();
            hb.shape(hbFont, buffer);
            const glyphs = buffer.json();
            for (const g of glyphs) {
                result.push({
                    glyphId: g.g,
                    advance: g.ax * scale,
                    xOffset: g.dx * scale,
                    yOffset: g.dy * scale,
                    cluster: g.cl,
                });
            }
        } finally {
            buffer.destroy();
        }
    }
    return result;
}
```

**Create `src/shaping/harfbuzz-wasm.js`** — Vendored copy of harfbuzzjs JS wrapper (~200 lines). Exports a factory function that takes a WASM URL and returns the `hb` module.

**Create `src/shaping/index.js`** — Barrel export:
```javascript
// Worker-safe: no DOM or Three.js imports allowed in this module.
export { shapeText } from './shapeText.js';
export { default as createHarfBuzz } from './harfbuzz-wasm.js';
```

### Step 3: Worker integration

**`src/workers/GlyphWorker.js`** — Add `INIT_FONT` and `CLEANUP` handlers. New persistent state:
```javascript
import { createHarfBuzz } from '../shaping/harfbuzz-wasm.js';

let hb = null;
let hbBlob = null, hbFace = null, hbFont = null;
let hbUpem = 0;

// In onmessage switch:
case 'INIT_FONT': {
    hb = await createHarfBuzz(payload.wasmUrl);
    if (hbFont) { hbFont.destroy(); hbFace.destroy(); hbBlob.destroy(); }
    hbBlob = hb.createBlob(payload.fontBuffer);
    hbFace = hb.createFace(hbBlob, 0);
    hbFont = hb.createFont(hbFace);
    hbUpem = hbFace.upem;
    self.postMessage({ type: 'FONT_READY', jobId });
    break;
}
case 'CLEANUP': {
    if (hbFont) { hbFont.destroy(); hbFace.destroy(); hbBlob.destroy(); }
    hbFont = hbFace = hbBlob = hb = null;
    break;
}
case 'BUILD_BATCH': {
    // Pass hb, hbFont, hbUpem into shared for the builder
    const shared = {
        ...payload.shared,
        uvMap: cachedUVMap,
        glyphWidths: cachedGlyphWidths,
        hb, hbFont, hbUpem,
    };
    const result = buildBatchBuffers(payload.items, shared);
    // ... transfer as before
}
```

**`src/workers/WorkerBridge.js`** — Per-worker `_hbReady` flag, font init, dispose:
- On construction, fetch font: `fetch('/assets/fonts/Cousine-Regular.ttf').then(r => r.arrayBuffer())`.
- After each worker is created, `postMessage({ type: 'INIT_FONT', fontBuffer, wasmUrl })` (font buffer cloned, not transferred — each worker needs its own copy).
- On `FONT_READY` response, set `worker._hbReady = true`.
- `_getNextWorker()`: skip workers where `!_hbReady` (same guard as `_hasUVMap`).
- New `dispose()` method: sends `CLEANUP` to each worker, then `worker.terminate()`.
- Remove `glyphWidths` from serialization — HarfBuzz advances replace them.
- `getSerializedUVMap` returns glyphId-keyed map from `atlas.getGlyphIdMap()`.

### Step 4: Atlas glyph-ID mapping

**`src/GlyphAtlas.js`** — New method `getGlyphIdMap(hb, hbFont)`:
- Iterates existing `uvMap` entries (grapheme string -> UV data).
- Shapes each grapheme through HarfBuzz to get the glyph ID.
- Returns `Object<number, {u0, v0, u1, v1}>` keyed by glyph ID.
- For single-glyph results: direct mapping. Multi-glyph decompositions: map each sub-glyph (imperfect for Phase A, documented).
- Add JSDoc noting the ligature limitation: shaping individual graphemes will not produce ligature glyph IDs.

**`src/GlyphAtlas.js`** — New method `fillAtlasMapForGlyphIds(glyphIdMap, THREE)`:
- Replaces `getAtlasMapTexture()` for the shaped path.
- Finds max glyph ID, sizes DataTexture accordingly (1024-wide, ceil height).
- Fills RGBA Float data with `(u0, v0_webgl, u1, v1_webgl)` per glyph ID.
- Returns the DataTexture.

### Step 5: Builder rewrite

**`src/workers/builders/index.js`** — Core changes to `buildBatchBuffers`:
- Import `shapeText` from `../../shaping/shapeText.js`.
- Remove `import { iterGraphemes }` (no longer needed).
- Remove `countGlyphs()` function.
- **Shape-first allocation**: before the main loop, shape all items and cache results. Sum renderable glyph counts from shaped output (skip newline markers, skip whitespace via `text.codePointAt(sg.cluster) === 32`). Allocate typed arrays once.
- **Inner loop**: iterate cached shaped results instead of calling `iterGraphemes`. Use `sg.advance` for cursor advancement. Use `sg.glyphId` for codepoints buffer. Apply `sg.xOffset`/`sg.yOffset` to position. Whitespace detection: `text.codePointAt(sg.cluster) === 32`.
- `glyphWidths` parameter no longer used — remove from shared payload.

### Step 6: Shader cleanup (low priority, same commit or follow-up)

**`src/GlyphRenderer.js`** vertex shader (~line 360-365) — switch `atlasMapTexture` from `texture()` to `texelFetch()`:
```glsl
// BEFORE:
float tx = (mapCol + 0.5) / atlasMapWidth;
float ty = (mapRow + 0.5) / atlasMapHeight;
vec4 uvRect = texture(atlasMapTexture, vec2(tx, ty));

// AFTER:
int icp = int(instanceCodepoint);
int mapW = int(atlasMapWidth);
ivec2 texCoord = ivec2(icp % mapW, icp / mapW);
vec4 uvRect = texelFetch(atlasMapTexture, texCoord, 0);
```

Same change in `PickingSystem.js` picking vertex shader (atlas map lookup path, if present).

Remove `atlasMapWidth`/`atlasMapHeight` float uniforms if `texelFetch` makes them unnecessary (verify: `mapW` could come from `textureSize(atlasMapTexture, 0).x` instead).

---

## Implementer Vote

**migration-integration** should implement Phase A.

Rationale: migration-integration's Phase 0 is closest to the converged plan in structure — it proposed `src/shaping/HarfBuzzShaper.js`, `INIT_FONT`/`FONT_READY` protocol, `getGlyphIdMap()` on the atlas, and the correct font URL path. The retractions it made (SlugEncoder in workers, triple-hop glyph mapping) were clean and fully accepted. Its perspective centers on integration plumbing — WorkerBridge lifecycle, GlyphWorker message protocol, atlas serialization — which is exactly what Phase A implementation requires. shader-rendering's strength is the Phase B shader pipeline; shaping-pipeline (me) is the analysis agent. migration-integration is the builder.
