# Round 3: migration-integration convergence

## Settled

1. **No fallback shaping path.** HarfBuzz WASM init is a startup gate. If it fails, the app does not start. No `fallbackShape()`, no `if (hbReady)` branches. All three agents retracted or never proposed a dual path. Project policy (no compat shims) governs.

2. **Vendor the harfbuzzjs JS wrapper.** Copy ~200-line `hb.js` into `src/shaping/harfbuzz-wasm.js`. Workers import by relative path. Bare-specifier imports (`import hb from 'harfbuzzjs'`) fail without a bundler or import map, neither of which this project has.

3. **Shaping code lives in `src/shaping/`.** shaping-pipeline retracted the `src/workers/builders/` location. shader-rendering's "worker-safe zone" argument is a convention, not an enforcement mechanism -- a file in `src/workers/builders/` can import Three.js just as easily. `src/shaping/` is the domain-correct location. The constraint (no DOM, no Three.js) is enforced by code review and a module-level comment.

4. **Per-worker `_hbReady` flag, not a global promise.** Mirrors the `_hasUVMap` pattern at `WorkerBridge.js` line 107. Font ArrayBuffer transferred once per worker. `INIT_FONT` message, `FONT_READY` response. Pre-warm during loading screen.

5. **`try/finally` on `hb.createBuffer()` / `buffer.destroy()`.** Non-negotiable WASM memory safety. All agents agreed from Round 1.

6. **`WorkerBridge.dispose()` sends `CLEANUP` before `worker.terminate()`.** Workers call `hbFont.destroy()`, `hbFace.destroy()`, `hbBlob.destroy()`.

7. **Whitespace detection via cluster index.** `text.codePointAt(sg.cluster) === 32`. Not via missing UV entry (fragile -- HarfBuzz assigns valid glyph IDs to space). Matches current builder's `cp === 32` at `builders/index.js` line 381.

8. **`getGlyphIdMap()` produces `Map<glyphId, uvEntry>`.** Shape each codepoint once through HarfBuzz, map the resulting glyph ID to its UV rect. Ligature limitation documented (single-codepoint shaping never produces ligature glyph IDs). Acceptable for Cousine (no ligatures).

9. **Delete `textToGlyphs.js`, `layoutText.js`, `buildBuffers.js` in Phase A.** All have zero live importers (confirmed by grep). `buildBuffers.js` was superseded by `buildGlyphBuffers` in `index.js`. No deprecated-but-kept files.

10. **Deprecate `BUILD` single-item path in `GlyphWorker.js`.** Route through `BUILD_BATCH` with a one-item array internally. One shaped code path is better than two. shaping-pipeline and I agreed; shader-rendering did not contest.

11. **`applyPrebuiltBuffers` fallback (`GlyphRenderer.js` lines 1364-1380) must be removed.** The `iterGraphemes` recount produces wrong `bufferStartIndex` if glyph counts diverge from grapheme counts (ligatures, future fonts). Shaped builders always emit `itemMeta`. The fallback is dead code in the shaped pipeline and a silent corruption risk if it ever triggers. Remove it, add a throw if `!itemMeta` for shaped buffers.

12. **`atlasMapTexture` lookup: switch from `texture()` to `texelFetch()`.** Not a correctness bug (NearestFilter + texel-center sampling is correct today), but a cleanup that removes float-division UV arithmetic and two uniforms (`atlasMapWidth`, `atlasMapHeight`). Zero risk, one-line shader change.

13. **Font at `/assets/fonts/Cousine-Regular.ttf`.** Not `/fonts/`. Committed to repo (Apache 2.0). WASM at `assets/wasm/hb.wasm`, `.gitignore`'d, populated by `make prep-wasm`.

14. **Phase B requires `opentype.js` for outline extraction.** `harfbuzzjs` does not expose `glyphToPath()`. Phase B prototype must verify glyph ID correspondence between harfbuzzjs and opentype.js. `opentype.js` should sit behind a `GlyphOutlineProvider` interface so it is replaceable if `libharfbuzz-gpu` stabilizes.

15. **Phase B requires a standalone prototype before integration.** Build in `examples/slug-prototype/`. Load font, extract curves, pack textures, evaluate winding shader in one instanced draw. 10K quads at 60fps on M1 + mid-range Android or stop. Phase A is the stable fallback.

16. **`instanceCodepoint` rename to `instanceGlyphId` deferred to Phase B.** Rename + glyph-mode picking removal in one atomic commit.

17. **`MAX_BANDS` compile-time cap in Slug fragment shader.** For GPU divergence control on mobile (Mali, Adreno), not GLSL ES 3.0 conformance (which permits dynamic loops).

18. **SlugEncoder runs on main thread at font-load time.** Curve/band textures are font-level data (one set per ~400 glyphs), built once. Workers never touch outline data. All startup extraction < 50ms for Cousine's charset.

---

## Implementation Plan

Phase A target: HarfBuzz shaping replaces grapheme iteration. Bitmap atlas stays. Shaders unchanged except `texelFetch` cleanup.

### Step 0: Prerequisites (before Phase A branch)

**Reroute `BUILD` to `BUILD_BATCH` in `GlyphWorker.js`:**
```javascript
case 'BUILD': {
    // Deprecated: route single-item through batch path
    const shared = { metrics: payload.metrics, defaultColor: payload.color,
                     uvMap: cachedUVMap, glyphWidths: cachedGlyphWidths };
    const items = [{ text: payload.text, position: payload.position,
                     color: payload.color, scale: payload.scale,
                     alignment: payload.alignment, groupId: payload.groupId }];
    const result = buildBatchBuffers(items, shared);
    self.postMessage({ type: 'RESULT', jobId, buffers: result }, [...transferables]);
    break;
}
```

**Remove `applyPrebuiltBuffers` fallback** at `GlyphRenderer.js:1364-1380`:
Replace the `iterGraphemes` recount with a throw:
```javascript
if (!itemMeta && items && items.length > 0) {
    throw new Error('applyPrebuiltBuffers: itemMeta required (shaped pipeline)');
}
```

**Delete `buildBuffers.js`** (zero importers confirmed).

### Step 1: Font + WASM assets

| Action | Path |
|--------|------|
| Commit | `assets/fonts/Cousine-Regular.ttf` (~170KB, Apache 2.0) |
| Commit | `assets/fonts/LICENSE-Cousine.txt` |
| Create | `assets/wasm/.gitignore` containing `*` + `!.gitignore` |

### Step 2: Makefile changes

Modify `/home/user/dev/glyph3d-js/Makefile`:
```makefile
ASSETS := src app examples assets index.html package.json

prep: prep-wasm
    # ... existing body unchanged ...

prep-wasm:
    @mkdir -p assets/wasm
    @if [ -f node_modules/harfbuzzjs/hb.wasm ]; then \
        cp node_modules/harfbuzzjs/hb.wasm assets/wasm/hb.wasm; \
    else \
        echo "Warning: harfbuzzjs not installed (run npm install). WASM not bundled."; \
    fi
```

Add `"harfbuzzjs": "^0.8.0"` to `package.json` devDependencies.

### Step 3: `relay.go` MIME type

Add to the MIME switch in `relay.go`:
```go
case strings.HasSuffix(path, ".ttf"), strings.HasSuffix(path, ".otf"):
    w.Header().Set("Content-Type", "font/ttf")
```

### Step 4: New files in `src/shaping/`

**`src/shaping/harfbuzz-wasm.js`** -- Vendored harfbuzzjs JS wrapper (~200 lines). Copy from `node_modules/harfbuzzjs/hb.js`, adjust WASM URL to absolute `/assets/wasm/hb.wasm`.

**`src/shaping/shapeText.js`** -- Worker-safe pure function:
```javascript
// Worker-safe: no DOM or Three.js imports allowed in this module
/**
 * Shape a text string using HarfBuzz.
 * @param {Object} hbFont - HarfBuzz font object
 * @param {Object} hb - HarfBuzz module
 * @param {string} text - Text to shape
 * @returns {Array<{glyphId, advance, xOffset, yOffset, cluster}>}
 */
export function shapeText(hbFont, hb, text) {
    const buffer = hb.createBuffer();
    try {
        buffer.addText(text);
        buffer.guessSegmentProperties();
        hb.shape(hbFont, buffer);
        return buffer.json(hbFont);  // [{g, ax, ay, dx, dy, cl}]
    } finally {
        buffer.destroy();
    }
}
```

**`src/shaping/index.js`** -- Barrel:
```javascript
// Worker-safe: no DOM or Three.js imports allowed in this module
export { shapeText } from './shapeText.js';
```

### Step 5: Modify `GlyphWorker.js`

Add persistent WASM state and `INIT_FONT` handler:
```javascript
import { shapeText } from '../shaping/shapeText.js';

let hb = null, hbBlob = null, hbFace = null, hbFont = null;

case 'INIT_FONT': {
    const { wasmBinary, fontBuffer } = payload;
    const hbjs = await import('../shaping/harfbuzz-wasm.js');
    hb = await hbjs.default(wasmBinary);
    hbBlob = hb.createBlob(fontBuffer);
    hbFace = hb.createFace(hbBlob, 0);
    hbFont = hb.createFont(hbFace);
    self.postMessage({ type: 'FONT_READY', jobId });
    break;
}

case 'CLEANUP': {
    if (hbFont) hbFont.destroy();
    if (hbFace) hbFace.destroy();
    if (hbBlob) hbBlob.destroy();
    hb = hbFont = hbFace = hbBlob = null;
    self.postMessage({ type: 'CLEANED', jobId });
    break;
}
```

Pass `hbFont` and `hb` into `buildBatchBuffers` via `shared`.

### Step 6: Modify `WorkerBridge.js`

- Add `_hbReady` per-worker flag (parallels `_hasUVMap`).
- On first dispatch to each worker: send `INIT_FONT` with WASM binary + font ArrayBuffer (transferred). Wait for `FONT_READY` before dispatching jobs.
- Add `dispose()` method: send `CLEANUP` to all workers, then `terminate()`.
- Pre-warm: call `_ensureFontReady()` for all workers during app startup.

### Step 7: Modify `GlyphAtlas.js`

Add `getGlyphIdMap(hbFont, hb)`:
```javascript
/**
 * Build glyph-ID-keyed UV map for HarfBuzz-shaped output.
 * Shapes each codepoint individually to get its glyph ID,
 * then maps that ID to the existing UV entry.
 * Limitation: ligature glyph IDs are not produced (single-codepoint shaping).
 */
getGlyphIdMap(hbFont, hb) {
    const glyphIdUvMap = {};
    for (const [grapheme, uvEntry] of this.uvMap) {
        const cp = grapheme.codePointAt(0);
        if (cp <= 32) continue;
        const shaped = shapeText(hbFont, hb, grapheme);
        if (shaped.length > 0) {
            glyphIdUvMap[shaped[0].g] = uvEntry;
        }
    }
    return glyphIdUvMap;
}
```

This replaces `getSerializableUVMap()` for the worker transfer path (keyed by integer glyph ID instead of grapheme string).

### Step 8: Modify `src/workers/builders/index.js`

Replace `iterGraphemes` loop in `buildBatchBuffers` with shaped glyph iteration:
- Call `shapeText(hbFont, hb, text)` to get `[{g, ax, dx, dy, cl}]`
- First pass: shape all items, count renderable glyphs (skip `text.codePointAt(sg.cl) === 32` and control chars)
- Allocate typed arrays based on count
- Second pass: fill buffers. Position: `x += sg.ax * worldScale`, bake `sg.dx`/`sg.dy` into `instancePosition`. Codepoint buffer emits `glyphIdUvMap[sg.g].numericId`.
- `lineSlotOffsets` computed from newline detection via cluster back-reference into source text.

### Step 9: Shader cleanup

In `GlyphRenderer._getVertexShader()` (line 360-365), replace:
```glsl
float mapCol = mod(cp, atlasMapWidth);
float mapRow = floor(cp / atlasMapWidth);
float tx = (mapCol + 0.5) / atlasMapWidth;
float ty = (mapRow + 0.5) / atlasMapHeight;
vec4 uvRect = texture(atlasMapTexture, vec2(tx, ty));
```
with:
```glsl
int icp = int(cp);
ivec2 mapCoord = ivec2(icp % int(atlasMapWidth), icp / int(atlasMapWidth));
vec4 uvRect = texelFetch(atlasMapTexture, mapCoord, 0);
```

Same change in `PickingSystem.js` picking vertex shader.

### Step 10: Delete dead files

- `src/workers/builders/textToGlyphs.js`
- `src/workers/builders/layoutText.js`
- `src/workers/builders/buildBuffers.js`

### Step 11: Update exports

Add to `src/index.js`:
```javascript
export { shapeText } from './shaping/index.js';
```

Add `"./shaping"` to `package.json` exports map.

### Files unchanged

`GlyphRenderer.js` (shaders except `texelFetch` cleanup), `PickingSystem.js` (except `texelFetch`), `GridVirtualizer.js`, `SemanticInfoMap.js`, `GlyphEvents.js`, highlight texture system, group texture system, `CodeGrid.js` (constructor unchanged -- still takes `atlas`), `GlyphCollection.js` (internal calls change but API stable).

---

## Implementer Vote

**shaping-pipeline** should implement Phase A.

Rationale: shaping-pipeline's Phase 0 code is closest to the converged plan in the builder rewrite (the critical path). Their `shapeText()` function structure, shape-first-then-allocate approach, and understanding of the `buildBatchBuffers` internals (grapheme iteration replacement, `lineSlotOffsets` computation, whitespace detection) are the most implementation-ready. They also demonstrated the strongest grasp of the worker message protocol changes (`INIT_FONT`/`FONT_READY`/`CLEANUP`) and retracted their own errors cleanly (fallback shaping, bare imports, space detection), which indicates they will implement the converged plan rather than their original proposal. shader-rendering's strength is the GPU pipeline (Phase B territory), not the WASM/worker/builder plumbing that dominates Phase A.
