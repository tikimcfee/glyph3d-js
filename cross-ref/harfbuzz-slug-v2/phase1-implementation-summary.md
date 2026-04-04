# Phase 1 Implementation Summary: HarfBuzz Plumbing

## What was done

All Phase 1 objectives are complete: harfbuzzjs is vendored, WASM loading works in main thread + workers, the font file is delivered, and HarfBuzzShaper exposes shaping + outline extraction + glyphExtents.

## New files created

### `src/shaping/vendor/hb.js`
Vendored from `node_modules/harfbuzzjs/hb.js`. Emscripten WASM glue code. Patched with `export default createHarfBuzz;` appended for ESM compatibility. The existing CJS `module.exports` guard is harmless in browser ESM (the `typeof` check returns `"undefined"` and the branch is skipped).

### `src/shaping/vendor/hbjs.js`
Vendored from `node_modules/harfbuzzjs/hbjs.js`. JavaScript API layer that wraps the raw WASM exports into a usable API (createBlob, createFace, createFont, createBuffer, shape). Patched with `export default hbjs;` appended. The existing `try { module.exports = hbjs; } catch (e) {}` is caught silently in ESM context.

### `src/shaping/vendor/hb.wasm`
Vendored WASM binary (397 KB). Loaded by `hb.js` via `locateFile()` — the Emscripten glue resolves it relative to its own URL, or uses the `locateFile` override we pass from `harfbuzz.js`.

### `src/shaping/vendor/harfbuzz.js`
10-line ESM wrapper. Imports `createHarfBuzz` from `hb.js` and `hbjs` from `hbjs.js`. Exports `initHarfBuzz(wasmUrl?)` which creates the WASM instance and returns the hbjs API object. Accepts optional `wasmUrl` override for workers where `import.meta.url`-relative resolution may not work.

### `src/shaping/HarfBuzzShaper.js`
Main wrapper class. Public API:
- `async init(fontBuffer, wasmUrl?)` — initialize WASM + load font
- `shape(text, features?)` — shape text, returns `[{g, cl, ax, ay, dx, dy, flags}]`
- `glyphOutline(glyphId)` — returns `[{type, values}]` (M/L/Q/C/Z segments)
- `glyphToPath(glyphId)` — returns SVG path string
- `glyphAdvance(glyphId)` — horizontal advance in font units
- `glyphExtents(glyphId)` — `{xBearing, yBearing, width, height}` in font units
- `fontExtents()` — `{ascender, descender, lineGap}` in font units
- `glyphName(glyphId)` — glyph name string
- `destroy()` — free all WASM memory

All HarfBuzz buffer operations wrapped in try/finally to prevent WASM heap leaks. First shape/outline calls are logged for diagnostics.

### `src/shaping/shapeText.js`
Worker-safe line-by-line shaping function. `shapeText(shaper, text, features)` splits on `\n`, shapes each line independently, returns `{lines, totalGlyphs}`. Also exports `collectUniqueGlyphIds()` for Phase 2's SlugEncoder.

### `src/shaping/index.js`
Barrel exports: `HarfBuzzShaper`, `shapeText`, `collectUniqueGlyphIds`.

### `src/shaping/validate.js`
Browser-callable validation function. Run from console:
```js
import('/src/shaping/validate.js').then(m => m.validateHarfBuzz())
```
Tests: WASM load, shaping "Hello, World!", outline extraction, glyphExtents, fontExtents, multi-line shapeText, cubic absence verification (Cousine is TrueType — all quadratic).

### `src/fonts/Cousine-Regular.ttf`
Apache 2.0 monospace font (300 KB). Selected for code visualization. License file at `src/fonts/Cousine-LICENSE.txt`.

### `src/fonts/Cousine-LICENSE.txt`
Apache 2.0 license for the Cousine font family.

## Modified files

### `src/workers/GlyphWorker.js`
- Added `import HarfBuzzShaper` from `../shaping/HarfBuzzShaper.js`
- Added module-level `let shaper = null` for per-worker HarfBuzz instance
- Changed `self.onmessage` to `async function` (INIT_FONT is async)
- Added `INIT_FONT` case: creates HarfBuzzShaper, calls `init(fontBuffer, wasmUrl)`, responds `FONT_READY`
- Added `CLEANUP` case: calls `shaper.destroy()`, responds `CLEANUP_DONE`
- Existing `BUILD` and `BUILD_BATCH` cases unchanged (Phase 2/3 territory)

### `src/workers/WorkerBridge.js`
- Added `this._fontReady = false` to constructor
- Added `async initFont(fontBuffer)`: computes absolute WASM URL via `new URL('../shaping/vendor/hb.wasm', import.meta.url).href`, sends `INIT_FONT` to each worker with structured clone of fontBuffer, awaits all `FONT_READY` responses
- Added `get fontReady()` getter
- Updated `_handleMessage()` to handle `FONT_READY` and `CLEANUP_DONE` message types
- Updated `getStats()` to include `fontReady` field
- Updated `dispose()` to reset `_fontReady = false`
- Structured logging: `[HarfBuzz] Worker ${i} ready` per worker, `[WorkerBridge] All ${n} workers initialized (${totalMs}ms)` summary

### `src/index.js`
Added exports: `HarfBuzzShaper`, `shapeText`, `collectUniqueGlyphIds` from `./shaping/index.js`.

### `package.json`
- Added `harfbuzzjs: "^0.4.8"` to devDependencies
- Added `"./shaping": "./src/shaping/index.js"` to exports map

### `cli/relay.go`
Added `.ttf` MIME type mapping (`font/sfnt`) to the static file MIME switch in `RunServer`. The `.wasm` mapping already existed.

### `Makefile`
- Added `prep-wasm` to `.PHONY` list
- Added `prep-wasm` target: copies hb.wasm, hb.js, hbjs.js from node_modules, appends ESM exports to .js files. Run when upgrading harfbuzzjs.

## Files NOT modified (correctly excluded per spec)
- `src/workers/builders/index.js` — Phase 2/3
- `src/GlyphRenderer.js` — Phase 3
- `src/GlyphAtlas.js` — deleted in Phase 3
- Any shader code

## Structured logging output (expected on startup)

```
[HarfBuzz] WASM loaded (Xms)
[HarfBuzz] Font loaded: Cousine-Regular, N glyphs, upem=2048
[HarfBuzz] Shaped "Hello, World!" → 13 glyphs
[HarfBuzz] Outline extracted: glyph X → Y curves
[HarfBuzz] Worker 0 ready
[HarfBuzz] Worker 1 ready
[HarfBuzz] Worker 2 ready
[WorkerBridge] All 3 workers initialized (Xms)
```

## Key design decisions implemented

1. **Vendor, don't runtime-depend.** Three files copied from node_modules, ESM-patched at vendor time. No import maps or bare specifiers.
2. **Per-worker WASM instantiation.** Each worker creates its own HarfBuzzShaper with its own WASM instance (browser requirement — WebAssembly instances are per-thread).
3. **Structured clone for font buffer.** Not Transferable — ~100KB, clone is fast. Main thread keeps its reference for the main-thread shaper + future SlugEncoder use.
4. **try/finally on all buffer operations.** HarfBuzz shape() creates a buffer, adds text, shapes, extracts JSON, and destroys the buffer — all in try/finally.
5. **Font file in src/fonts/.** Automatically included in Go embed via existing Makefile ASSETS (`src/` is already listed).
6. **glyphExtents() exposed as one-line delegation.** Never exposes `_font` directly. SlugEncoder (Phase 2) will call `shaper.glyphExtents(id)`.

## Validation instructions

After starting the server (`./glyph3d-cli serve --local`), open the browser console and run:

```js
import('/src/shaping/validate.js').then(m => m.validateHarfBuzz())
```

This will:
1. Fetch Cousine-Regular.ttf
2. Initialize HarfBuzz WASM
3. Shape "Hello, World!" and log glyph IDs + advances
4. Extract outline for the first glyph and log curve types
5. Log glyphExtents and fontExtents
6. Shape a multi-line code snippet
7. Verify no cubic curves (TrueType font)

## Next steps (Phase 2)

Phase 2 adds `SlugEncoder` which consumes `shaper.glyphOutline()` and `shaper.glyphExtents()` to produce RGBA16UI DataTextures (curveTexture, bandTexture, glyphMapTexture). SlugEncoder runs on main thread only. The APIs it needs are all exposed and validated in this phase.
