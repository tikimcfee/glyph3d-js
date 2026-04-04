# Round 3: shader-rendering convergence

## Settled

All positions below are either unanimous across all three agents or represent a clear majority with the minority retracted.

1. **No fallback shaping path.** `fallbackShape()` must not exist. If HarfBuzz WASM init fails, the application does not start. The per-worker `_hbReady` flag (mirroring `_hasUVMap`) gates dispatch. (shaping-pipeline retracted fallback; migration-integration and shader-rendering agreed throughout.)

2. **Vendor the harfbuzzjs JS wrapper.** Bare-specifier imports fail in this project's module resolution (no bundler, no import map, embedded FS). The ~200-line `hb.js` goes in `src/shaping/harfbuzz-wasm.js`, imported by relative path everywhere it is used.

3. **Shaping code location: `src/shaping/`.** All three agents converged here. The "worker-safe zone" enforcement argument for `src/workers/builders/` was incorrect — directory convention does not enforce import safety, code review does. `src/shaping/HarfBuzzShaper.js` is a domain concept, not a builder implementation detail. Top comment on `src/shaping/index.js`: `// Worker-safe: no DOM or Three.js imports allowed in this module`.

4. **`buildBuffers.js` is dead code; delete it in Phase A.** migration-integration verified: `WorkerBridge._buildBuffersSync` (line 309) calls `buildGlyphBuffers` from `src/workers/builders/index.js`, not from `buildBuffers.js`. Zero live importers. shader-rendering's Round 1 error on this was retracted.

5. **Delete `textToGlyphs.js` and `layoutText.js` in Phase A.** No deprecated-but-kept files. No fallback path means these are dead on arrival.

6. **Deprecate `BUILD` single-item message type.** Route `GlyphWorker.js`'s `BUILD` handler through `BUILD_BATCH` with a one-element array. One shaped builder function, not two diverging paths.

7. **Cluster-based whitespace detection.** `text.codePointAt(sg.cluster) === 32`, not `!entry && sg.advance > 0`. Matches current builder's `cp === 32` logic.

8. **`xOffset`/`yOffset` baked into `instancePosition` at buffer-build time.** No new shader attribute. No shader change required for Phase A.

9. **`applyPrebuiltBuffers` fallback (`iterGraphemes` recount) must be removed before Phase A ships.** The fallback at `GlyphRenderer.js:1364-1380` produces wrong `bufferStartIndex` values whenever ligature counts differ from grapheme counts. With Cousine (no ligatures) Phase A appears safe, but leaving the code in place means any future ligature font or Phase B silently corrupts highlight and picking offsets. Remove it; add a hard throw if `itemMeta` is absent from shaped output (`if (!itemMeta) throw new Error('shaped build must include itemMeta')`).

10. **Font URL: `/assets/fonts/Cousine-Regular.ttf`.** The Go binary embeds from `cli/web/`; Makefile copies `assets/` to `cli/web/assets/`. `/fonts/` would 404.

11. **`WorkerBridge.dispose()` with `CLEANUP` message before `worker.terminate()`.** Required for HarfBuzz WASM memory safety (`hbFont.destroy()`, `hbFace.destroy()`, `hbBlob.destroy()`).

12. **`try/finally` on `hb.createBuffer()` / `buffer.destroy()` in every `shapeText()` call.** Non-negotiable. Buffer leaks are the primary WASM memory failure mode.

13. **SlugEncoder runs on main thread at font-load time, not in workers.** Curve/band textures are font-level, built once. Workers do HarfBuzz shaping and instance-buffer building only.

14. **Phase B requires `opentype.js` for outline extraction.** `font.glyphToPath()` does not exist in harfbuzzjs. This is not negotiable — harfbuzzjs is a shaping library, not an outline library.

15. **`GlyphMapTexture` lookup in vertex shader, passed as `flat` varyings.** Per-instance lookup, uniform across the quad — belongs in vertex, not fragment. `flat out int vCurveStart`, `flat out int vCurveCount`, `flat out int vBandStart`, `flat out int vBandCount`.

16. **`MAX_BANDS` compile-time cap in Slug fragment shader.** Rationale: GPU warp divergence control and driver robustness on Mali/Adreno, not GLSL ES 3.0 spec conformance (dynamic loop bounds are valid in GLSL ES 3.0). `const int MAX_BANDS = 64; for (int bi = 0; bi < min(vBandCount, MAX_BANDS); bi++)`.

17. **Phase B prototype required before any integration work.** Standalone HTML page in `examples/slug-prototype/`. One font, one glyph, winding shader, instanced draw. Must sustain 60fps at 10K instanced quads on M1 + mid-range Android before proceeding.

18. **`texelFetch` for `atlasMapTexture` lookup.** Low-priority Phase A cleanup. Removes dependency on `atlasMapWidth`/`atlasMapHeight` float uniforms. Not a correctness fix (NearestFilter + +0.5 centering is already correct), but makes intent explicit and pays forward for Phase B which uses `texelFetch` throughout.

19. **`instanceCodepoint` rename to `instanceGlyphId` deferred to Phase B.** Atomic commit: rename + drop `'glyph'` mode picking in the same change. No interim dual naming.

20. **Glyph ID correspondence between harfbuzzjs and opentype.js must be verified in the prototype.** Both derive from the font's `cmap`+`glyf` tables and should agree, but this must be confirmed empirically for Cousine before the `glyphMapTexture` indexing chain is committed to.

---

## Implementation Plan

### Prerequisites (before Phase A work begins)

These are blocking correctness issues, not features.

**`src/workers/WorkerBridge.js`** — verify `_buildBuffersSync` (line 309) calls `buildGlyphBuffers` from `index.js` and not `buildBuffers.js`. If it does (confirmed), no change needed. Delete `buildBuffers.js`.

**`src/GlyphRenderer.js`** — remove `applyPrebuiltBuffers` fallback (lines 1364-1380). Replace the `if (!itemMeta)` branch body with:
```js
if (!itemMeta) throw new Error('[GlyphRenderer] shaped build missing itemMeta — worker version mismatch?');
```
This turns a silent corruption into a loud failure.

---

### Phase A: HarfBuzz shaping + bitmap atlas

**New files:**

`assets/fonts/Cousine-Regular.ttf` + `assets/fonts/LICENSE-Cousine.txt` — committed to repo.

`assets/wasm/` — directory only, `.gitignore`'d. Populated by `make prep-wasm` (downloads `hb.wasm` from harfbuzzjs release).

`src/shaping/harfbuzz-wasm.js` — vendored harfbuzzjs JS wrapper (~200 lines). No modifications. This is the WASM init + HarfBuzz JS API surface.

`src/shaping/HarfBuzzShaper.js`:
```js
// Worker-safe: no DOM or Three.js imports.
import initHarfBuzz from './harfbuzz-wasm.js';

let hb = null;
export async function initShaper(wasmUrl) {
  hb = await initHarfBuzz({ locateFile: () => wasmUrl });
}

/**
 * @param {object} hbFont  — persistent HarfBuzz font object (owned by caller)
 * @param {string} text
 * @returns {{ glyphId, advance, xOffset, yOffset, cluster }[]}
 */
export function shapeText(hbFont, text) {
  const buf = hb.createBuffer();
  try {
    buf.addText(text);
    buf.guessSegmentProperties();
    hb.shape(hbFont, buf);
    return buf.json();   // returns array of glyph info objects
  } finally {
    buf.destroy();
  }
}
```

`src/shaping/index.js` — barrel: `export { initShaper, shapeText } from './HarfBuzzShaper.js';`

**Modified files:**

`src/workers/GlyphWorker.js`:
- Add `INIT_FONT` message handler: receives `{ fontBuffer: ArrayBuffer, wasmUrl: string }`, calls `initShaper(wasmUrl)`, creates persistent `hbBlob`, `hbFace`, `hbFont`. Responds with `{ type: 'FONT_READY' }`.
- Add `CLEANUP` handler: calls `hbFont.destroy()`, `hbFace.destroy()`, `hbBlob.destroy()`.
- Change `BUILD` handler: wrap single item in array, delegate to `buildBatchBuffers`, respond identically. Mark as deprecated in comment.
- Import `shapeText` from `../../shaping/HarfBuzzShaper.js`. Pass `hbFont` and `shapeText` into `buildBatchBuffers` as additional params.

`src/workers/WorkerBridge.js`:
- Add per-worker `_hbReady = false` flag (same pattern as `_hasUVMap` at line 107).
- On `FONT_READY` message from a worker, set `_hbReady = true` for that worker.
- `initFont(fontBuffer)`: fetch font ArrayBuffer once, send `INIT_FONT` to every worker with a `Transferable` copy. Called during loading screen.
- Do not dispatch `BUILD_BATCH` to a worker until its `_hbReady` is true.
- Add `dispose()`: send `CLEANUP` to each worker, then `worker.terminate()`.

`src/GlyphAtlas.js`:
- Add `getGlyphIdMap(hbFont, shapeText)`: iterate the atlas's character set, shape each grapheme via `shapeText(hbFont, char)`, take `glyphId` from first shaped glyph result, map `glyphId → {u0, v0, u1, v1}`. Returns `Map<number, uvRect>`.
- This replaces the codepoint-keyed atlas map for Phase B; in Phase A, both maps exist in parallel until Phase B removes the codepoint path.
- Document the ligature limitation: `// Note: single-grapheme shaping never produces ligature glyph IDs. Ligatures require multi-character shaping context.`

`src/workers/builders/index.js` (`buildBatchBuffers`):
- Receive `hbFont` and `shapeText` function as parameters (injected from GlyphWorker).
- Replace `iterGraphemes` loop with `shapeText(hbFont, item.text)` per item.
- Shape-first pass: shape all items into a pre-allocated flat result pool, record per-item glyph counts.
- Count pass: compute total glyph count from pool.
- Allocate typed arrays once (right-sized).
- Fill pass: iterate pool to write `instancePosition` (baking `xOffset`/`yOffset` into x/y), `instanceSize` (HarfBuzz advance → world units), `instanceUV` (lookup shaped `glyphId` in atlas glyph map), `instanceColor`, `instanceGroupId`.
- Whitespace: `text.codePointAt(sg.cluster) === 32`.
- Always include `itemMeta` in output (`lineSlotOffsets`, shaped glyph counts per item).

`relay.go` — add `.ttf` to the MIME type switch:
```go
case ".ttf":
    return "font/ttf"
```

`Makefile`:
- Add `assets/fonts/Cousine-Regular.ttf` to `ASSETS` copy list.
- Add `prep-wasm` target: downloads `hb.wasm` from harfbuzzjs npm release to `assets/wasm/hb.wasm`.

**Deleted files:**
- `src/workers/builders/textToGlyphs.js`
- `src/workers/builders/layoutText.js`
- `src/workers/builders/buildBuffers.js`

**Low-priority cleanup (same PR or follow-up):**

`src/GlyphRenderer.js` `_getVertexShader()` line ~365: replace `texture(atlasMapTexture, ...)` with `texelFetch(atlasMapTexture, ivec2(int(cp) % mapW, int(cp) / mapW), 0)`. Remove `atlasMapWidth`/`atlasMapHeight` float uniforms.

---

### Phase B: Slug vector rendering (prototype gate first)

**Standalone prototype: `examples/slug-prototype/index.html`**

Load `Cousine-Regular.ttf` via `opentype.js`. Extract quadratic beziers for 5 glyphs (`A`, `e`, `g`, `i`, `space`). Verify that `opentype.js` glyph IDs match harfbuzzjs glyph IDs for each character. Pack curves into a `HALF_FLOAT` DataTexture (256-wide). Pack band→curve index into a `RG16UI` DataTexture (or `RGBA16UI` if `THREE.RGIntegerFormat` is unavailable in the project's Three.js version — verify at implementation time). Render 10K instanced quads, all the same glyph, with the winding-number fragment shader. Measure fps on M1 + mid-range Android.

**Success gate**: 60fps at 10K quads. If it fails, Phase A is the stable endpoint.

**New files (Phase B, after prototype passes):**

- `src/shaping/SlugEncoder.js` — takes `opentype.js` Font, extracts quadratic beziers per glyph, packs `curveData` and `bandData` Float32/Uint16 arrays. Main-thread only. Implement behind a `GlyphOutlineProvider` interface so `opentype.js` is swappable.
- `src/shaping/CurveTexture.js` — builds `HALF_FLOAT` DataTexture from SlugEncoder curve data.
- `src/shaping/BandTexture.js` — builds `RG16UI` DataTexture from SlugEncoder band data.
- `src/shaping/GlyphMapTexture.js` — builds RGBA Float DataTexture, 1024-wide, indexed by glyph ID, stores `(curveStart, curveCount, bandStart, bandCount)`.

**Modified files (Phase B):**

- `src/GlyphRenderer.js` — new vertex shader replaces `atlasMapTexture` lookup with `glyphMapTexture` texelFetch, adds `flat out int` varyings. New fragment shader replaces atlas sample with winding-number evaluation. Drop `atlasTexture`, `atlasMapTexture` uniforms. Add `curveTexture`, `bandTexture`, `glyphMapTexture`, `curveTextureDims`, `bandTextureDims`. Rename `instanceCodepoint` → `instanceGlyphId` in same commit.
- `src/picking/PickingSystem.js` — drop `'glyph'` mode (atlas alpha-test incompatible with Slug). `'cell'` mode is unchanged and becomes the only picking mode.

---

## Implementer Vote

**migration-integration** should implement Phase A.

Rationale: migration-integration's Phase 0 and Round 2 synthesis most closely match the converged plan — it correctly placed `src/shaping/` as the directory, correctly identified the font URL path, correctly verified `buildBuffers.js` import chains from source, and produced the most accurate ordered Phase A ship list. It also identified the `opentype.js` glyph ID correspondence risk, which is the most important non-obvious validation step in the prototype. The builder rewrite in `src/workers/builders/index.js` is the heaviest Phase A change, and migration-integration's Phase 0 already has the most detailed treatment of that file's structure. shader-rendering's Phase 0 is Phase B material — the texture format design, shader sketches, and winding math belong to the implementation that follows the prototype gate.
