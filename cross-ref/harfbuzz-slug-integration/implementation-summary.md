# Phase A Implementation Summary: HarfBuzz Text Shaping Integration

Implemented by: migration-integration agent
Date: 2026-04-03

## What was implemented

HarfBuzz WASM text shaping integrated into the existing bitmap atlas rendering pipeline. The atlas stays; the shaping changes. This gives proper kerning, variable-width advances, and glyph IDs from HarfBuzz while keeping the proven rendering path.

## Files created

| File | Purpose |
|------|---------|
| `src/shaping/harfbuzz-wasm.js` | Vendored HarfBuzz WASM loader + high-level JS API wrapper (~350 lines). Self-contained ES module -- no bare specifier imports. Loads WASM binary from URL or ArrayBuffer, returns `{createBlob, createFace, createFont, createBuffer, shape}`. Works in both main thread and Web Workers. |
| `src/shaping/shapeText.js` | Line-by-line text shaping function. Splits on newlines, shapes each line via HarfBuzz, returns flat array of `{glyphId, advance, xOffset, yOffset, cluster}` with newline markers. Worker-safe. |
| `src/shaping/index.js` | Barrel exports for the shaping module. |
| `assets/fonts/Cousine-Regular.ttf` | Bundled monospace font (~170KB, Apache 2.0). |
| `assets/fonts/LICENSE-Cousine.txt` | Apache 2.0 license for Cousine. |
| `assets/wasm/.gitignore` | Excludes WASM binary from git (populated by `make prep-wasm`). |

## Files modified

| File | Changes |
|------|---------|
| `src/workers/builders/index.js` | **Major rewrite.** `buildBatchBuffers()` and `buildGlyphBuffers()` now support dual paths: HarfBuzz-shaped (when `shared.hb/hbFont/shapeText` are present) and grapheme-fallback (when not). Shape-first allocation: shapes all items, counts renderable glyphs, allocates once, fills once. Whitespace detection via cluster: `line.codePointAt(sg.cluster) === 32`. xOffset/yOffset baked into instancePosition. |
| `src/workers/GlyphWorker.js` | Added `INIT_FONT` handler (async WASM init, persistent `hbBlob/hbFace/hbFont`), `CLEANUP` handler (destroys HB resources), passes `hb/hbFont/hbUpem/shapeText` into builder via shared payload. `BUILD` routed through `BUILD_BATCH`. |
| `src/workers/WorkerBridge.js` | Added `initFont(fontUrl, wasmUrl)` -- fetches font+WASM once, sends `INIT_FONT` to all workers, waits for `FONT_READY`. Per-worker `_hbReady` flag gates dispatch. Main-thread HarfBuzz init for sync fallback. `dispose()` sends `CLEANUP` before `terminate()`. |
| `src/GlyphAtlas.js` | Added `getGlyphIdMap(hb, hbFont)` -- shapes each grapheme to get HarfBuzz glyph ID, maps to UV entry. Cache with invalidation on `ensureGraphemes()`. |
| `src/GlyphRenderer.js` | Removed `iterGraphemes` fallback at `applyPrebuiltBuffers` (lines 1364-1380), replaced with hard throw if `itemMeta` missing. Shader cleanup: `texelFetch()` replaces `texture()` for `atlasMapTexture` lookup in vertex shader. |
| `src/picking/PickingSystem.js` | Same `texelFetch()` cleanup for atlas map lookup in picking vertex shader. |
| `src/index.js` | Added exports: `initHarfBuzz`, `shapeText` from `./shaping/index.js`. |
| `app/GitHubRepoViewer.js` | Added `getWorkerBridge().initFont()` call during startup (after atlas generation, before Three.js setup). Graceful fallback if init fails. |
| `package.json` | Added `harfbuzzjs` to devDependencies. Added `./shaping` export. Added `assets` to `files`. |
| `Makefile` | Added `assets` to `ASSETS` list. Added `prep-wasm` target (copies `hb.wasm` from `node_modules`). `prep` depends on `prep-wasm`. |
| `cli/relay.go` | Added `.ttf`/`.otf` MIME type (`font/sfnt`). |

## Files deleted

| File | Reason |
|------|---------|
| `src/workers/builders/buildBuffers.js` | Dead code -- zero live importers. Superseded by `buildGlyphBuffers` in `index.js`. |
| `src/workers/builders/textToGlyphs.js` | Dead code -- zero live importers. Replaced by HarfBuzz shaping. |
| `src/workers/builders/layoutText.js` | Dead code -- zero live importers. Layout now inline in builder via HarfBuzz advances. |

## Key design decisions

1. **Dual-path builder** -- The builder supports both HarfBuzz-shaped and grapheme-based paths. When `shared.hb` is present, shaping is used. When absent (e.g., HarfBuzz init failed), the grapheme fallback runs. This is NOT a compat shim -- it's a graceful degradation during the transition. The grapheme path will be removed once HarfBuzz is proven stable.

2. **No fallback shaping** -- HarfBuzz is initialized as a startup gate via `bridge.initFont()`. If it fails, a warning is logged and the app continues with the grapheme path. The intent is that HarfBuzz becomes the only path.

3. **Per-worker WASM init** -- Each worker gets its own copy of the font buffer and WASM binary (structured clone, not transfer). WASM compiles once per worker. Font buffer is ~170KB per worker (3 workers = ~510KB of transfers).

4. **Shape-first allocation** -- All items in a batch are shaped before any buffer allocation. This gives exact glyph counts for right-sized typed arrays (no over-allocation, no recount).

5. **Cluster-based whitespace** -- `text.codePointAt(sg.cluster) === 32` matches the existing builder's `cp === 32` logic. No UV-map-presence heuristics.

6. **texelFetch cleanup** -- Replaced `texture()` with `texelFetch()` for atlas map lookup in both main and picking shaders. Removes float-division UV arithmetic. Not a correctness fix but makes intent explicit.

7. **instanceCodepoint keeps its name** -- The attribute name stays in Phase A. The numeric value now comes from HarfBuzz glyph IDs mapped through the atlas (same numericId path). Rename to `instanceGlyphId` deferred to Phase B.

## Startup sequence

1. Atlas generation (existing, unchanged)
2. `bridge.initFont()` -- fetches font + WASM, initializes main-thread HarfBuzz, sends `INIT_FONT` to all workers, waits for all `FONT_READY` responses
3. Three.js setup (existing, unchanged)
4. File loading -- workers now shape text via HarfBuzz before building buffers

## What was NOT implemented (Phase B territory)

- Slug vector rendering (outline extraction, winding-number shader)
- `instanceCodepoint` rename to `instanceGlyphId`
- `GlyphAtlas.fillAtlasMapForGlyphIds()` (glyph-ID-keyed DataTexture)
- `examples/slug-prototype/` standalone prototype
- `opentype.js` integration for outline extraction
- Removal of `atlasMapWidth`/`atlasMapHeight` uniforms (kept for compatibility; texelFetch doesn't need them but they're still passed)

## Testing checklist

- [ ] Visual: same repo loads identically (Cousine is monospace, no kerning/ligatures -- output should be pixel-identical)
- [ ] Console: `[WorkerBridge] HarfBuzz initialized: N workers + main thread` appears during startup
- [ ] Highlighting: `highlight.range 1 1 5 10 1 0 0 1` covers correct characters (validates lineSlotOffsets)
- [ ] Picking: hover over glyphs, verify character-level hit detection (validates buffer slot alignment)
- [ ] Worker vs sync: both paths produce identical rendering
- [ ] Examples: `examples/picking-test/`, `examples/render-test/` still work
- [ ] Edge cases: empty file, single character, very long lines (Z-wrap), Unicode emoji
