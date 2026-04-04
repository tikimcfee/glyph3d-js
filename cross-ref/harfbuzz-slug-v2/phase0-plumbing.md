# Phase 1 Plumbing: Vendor harfbuzzjs, WASM Loading, Font Delivery, Worker Init

## Decisions

1. **Vendor, don't npm-depend.** Copy 3 files from `node_modules/harfbuzzjs/` into `src/shaping/vendor/`: `hb.js`, `hbjs.js`, `hb.wasm`. Total ~430 KB on disk (~180 KB gzipped over the wire). These are the complete runtime -- no other harfbuzzjs files needed. The `hb.js` Emscripten glue auto-locates `hb.wasm` relative to its own URL via `locateFile()`.
2. **ES module wrapper.** `hb.js` uses CJS/UMD. Write a thin `src/shaping/vendor/harfbuzz.js` ESM wrapper that default-exports the init function. Workers and main thread import the same module.
3. **Font file.** Copy `Cousine-Regular.ttf` into `src/fonts/Cousine-Regular.ttf`. Go embed picks it up via existing Makefile `ASSETS` (which copies `src/`). No font embedding changes needed.
4. **Single HarfBuzzShaper class** in `src/shaping/HarfBuzzShaper.js` owns the WASM instance, blob, face, font. Main thread creates one. Workers each create their own (WASM instances are per-thread in browsers).
5. **Font buffer transfer.** Main thread fetches font once, sends `ArrayBuffer` to each worker via `INIT_FONT` message. Worker creates its own HarfBuzz instance from that buffer. No redundant font fetches.
6. **glyphToJson for Phase 2.** `font.glyphToJson(glyphId)` returns `[{type:'M',values:[x,y]}, {type:'Q',values:[cx,cy,x,y]}, ...]`. SlugEncoder consumes this directly. No second font parser needed.

## File Layout

```
src/shaping/
├── HarfBuzzShaper.js          # WASM init, font load, shape(), outlines
├── index.js                   # re-exports
└── vendor/
    ├── harfbuzz.js            # ESM wrapper (10 lines)
    ├── hb.js                  # Emscripten glue (vendored, untouched)
    ├── hbjs.js                # JS API layer (vendored, untouched)
    └── hb.wasm                # WASM binary (vendored, untouched)

src/fonts/
└── Cousine-Regular.ttf        # Apache 2.0 monospace font
```

## ESM Wrapper: `src/shaping/vendor/harfbuzz.js`

```js
// ESM wrapper for harfbuzzjs (CJS/UMD).
// hb.js exports createHarfBuzz via CJS module.exports.
// We re-export it as ESM default for clean import.
import createHarfBuzz from './hb.js';
import hbjs from './hbjs.js';

/**
 * Initialize HarfBuzz WASM and return the hbjs API object.
 * @param {string} [wasmUrl] - Override URL for hb.wasm (for workers).
 * @returns {Promise<object>} hbjs API: createBlob, createFace, createFont, createBuffer, shape
 */
export default async function initHarfBuzz(wasmUrl) {
    const moduleArgs = {};
    if (wasmUrl) {
        moduleArgs.locateFile = (path) => {
            if (path.endsWith('.wasm')) return wasmUrl;
            return path;
        };
    }
    const instance = await createHarfBuzz(moduleArgs);
    return hbjs(instance);
}
```

**Note on hb.js import compatibility:** The `hb.js` Emscripten output already has `module.exports = createHarfBuzz` at the bottom with a UMD guard. In an ES module context with `"type": "module"`, Node and modern bundlers handle CJS-to-ESM interop. For raw browser ES module serving (our case), we may need to patch the last 2 lines of the vendored `hb.js` to add `export default createHarfBuzz;` or use a dynamic import trick. Verify this at integration time -- the fix is mechanical.

Similarly, `hbjs.js` uses `module.exports = hbjs` -- needs `export default hbjs;` appended for ESM.

## HarfBuzzShaper: `src/shaping/HarfBuzzShaper.js`

```js
import initHarfBuzz from './vendor/harfbuzz.js';

export default class HarfBuzzShaper {
    constructor() {
        this._hb = null;       // hbjs API object
        this._blob = null;
        this._face = null;
        this._font = null;
        this._upem = 0;        // units per em
        this._ready = false;
    }

    /**
     * Initialize WASM + load font from ArrayBuffer.
     * @param {ArrayBuffer} fontBuffer - Raw .ttf/.otf bytes
     * @param {string} [wasmUrl] - Override path to hb.wasm
     */
    async init(fontBuffer, wasmUrl) {
        this._hb = await initHarfBuzz(wasmUrl);
        this._blob = this._hb.createBlob(fontBuffer);
        this._face = this._hb.createFace(this._blob, 0);
        this._font = this._hb.createFont(this._face);
        this._upem = this._face.upem;  // typically 2048 for TrueType
        this._ready = true;
    }

    /** @returns {boolean} */
    get ready() { return this._ready; }

    /** @returns {number} Font units per em */
    get upem() { return this._upem; }

    /**
     * Shape a text string. Returns shaped glyph array.
     * @param {string} text
     * @param {string} [features] - Comma-separated OpenType features, e.g. "liga,kern"
     * @returns {Array<{g: number, cl: number, ax: number, ay: number, dx: number, dy: number}>}
     *   g = glyph ID, cl = cluster index, ax/ay = advance, dx/dy = offset
     */
    shape(text, features) {
        const buffer = this._hb.createBuffer();
        try {
            buffer.addText(text);
            buffer.guessSegmentProperties();
            this._hb.shape(this._font, buffer, features);
            return buffer.json();
        } finally {
            buffer.destroy();
        }
    }

    /**
     * Extract outline curves for a glyph (for Phase 2 SlugEncoder).
     * @param {number} glyphId - HarfBuzz glyph ID from shape() output
     * @returns {Array<{type: string, values: number[]}>}
     *   M=[x,y], L=[x,y], Q=[cx,cy,x,y], C=[c1x,c1y,c2x,c2y,x,y], Z=[]
     */
    glyphOutline(glyphId) {
        return this._font.glyphToJson(glyphId);
    }

    /**
     * Get glyph horizontal advance in font units.
     * @param {number} glyphId
     * @returns {number}
     */
    glyphAdvance(glyphId) {
        return this._font.glyphHAdvance(glyphId);
    }

    /**
     * Get font vertical extents (ascender, descender, lineGap) in font units.
     * @returns {{ascender: number, descender: number, lineGap: number}}
     */
    fontExtents() {
        return this._font.hExtents();
    }

    destroy() {
        if (this._font) { this._font.destroy(); this._font = null; }
        if (this._face) { this._face.destroy(); this._face = null; }
        if (this._blob) { this._blob.destroy(); this._blob = null; }
        this._hb = null;
        this._ready = false;
    }
}
```

## WASM Loading: Main Thread + Workers

### Main Thread

```
app startup
  │
  ├── fetch('/src/fonts/Cousine-Regular.ttf')  →  fontBuffer (ArrayBuffer)
  ├── new HarfBuzzShaper()
  │     └── .init(fontBuffer)  →  loads hb.wasm via import, creates blob/face/font
  │
  └── workerBridge.initFont(fontBuffer)         →  sends buffer to all workers
```

The WASM binary loads once per thread (browser requirement -- `WebAssembly.instantiate` creates a per-thread instance). The font file loads once on main thread, then the same `ArrayBuffer` is transferred to workers.

### Worker Thread

Workers cannot use `import.meta.url`-relative WASM loading easily. Strategy: main thread computes the absolute WASM URL and sends it alongside the font buffer.

```
GlyphWorker.js receives INIT_FONT message:
  {
    type: 'INIT_FONT',
    fontBuffer: ArrayBuffer,       // transferred (zero-copy)
    wasmUrl: 'http://localhost:8080/src/shaping/vendor/hb.wasm'
  }
  │
  └── new HarfBuzzShaper().init(fontBuffer, wasmUrl)
      └── stores on worker-global `shaper` variable
```

## Worker Integration: INIT_FONT Protocol

### GlyphWorker.js changes

```js
import HarfBuzzShaper from '../shaping/HarfBuzzShaper.js';
import { buildGlyphBuffers, buildBatchBuffers } from './builders/index.js';

let shaper = null;          // initialized on INIT_FONT
let cachedUVMap = null;     // (retained for transition; removed in Phase 3)
let cachedGlyphWidths = null;

self.onmessage = async function(event) {
    const { type, jobId, payload } = event.data;
    try {
        switch (type) {
            case 'INIT_FONT': {
                shaper = new HarfBuzzShaper();
                await shaper.init(payload.fontBuffer, payload.wasmUrl);
                self.postMessage({ type: 'FONT_READY', jobId });
                break;
            }

            case 'BUILD_BATCH': {
                if (!shaper?.ready) throw new Error('Font not initialized');
                // ... existing batch logic, but builders now receive `shaper`
                // to call shaper.shape(text) instead of iterGraphemes()
                // ...
                break;
            }
            // ... PING, etc.
        }
    } catch (error) {
        self.postMessage({ type: 'ERROR', jobId, error: error.message });
    }
};
```

### WorkerBridge changes

```js
/**
 * Initialize all workers with font data.
 * Must be called before any build operations.
 * @param {ArrayBuffer} fontBuffer
 */
async initFont(fontBuffer) {
    this._ensureInitialized();
    const wasmUrl = new URL(
        '../shaping/vendor/hb.wasm',
        import.meta.url
    ).href;

    const readyPromises = this.workers.map((worker, i) => {
        return new Promise((resolve, reject) => {
            const jobId = `init-font-${i}`;
            this.pendingRequests.set(jobId, { resolve, reject });
            worker.postMessage(
                { type: 'INIT_FONT', jobId, payload: { fontBuffer, wasmUrl } },
                [fontBuffer.slice(0)]  // each worker gets a copy
            );
        });
    });

    await Promise.all(readyPromises);
    this._fontReady = true;
}
```

**Note:** `fontBuffer.slice(0)` creates a copy for each worker's Transferable. The first transfer takes the original; subsequent workers need copies. Alternative: send as structured clone (no transfer) -- only ~100KB for Cousine, negligible.

## Font File Delivery

### Placement
`src/fonts/Cousine-Regular.ttf` -- inside `src/` which is already in Makefile's `ASSETS` list.

### Serving
- **Embedded binary:** `make prep` copies `src/` into `cli/web/src/`, Go embeds it. Served at `/src/fonts/Cousine-Regular.ttf`.
- **Local dev:** `--local` flag serves from disk. Same path.
- **MIME type:** Go's `http.FileServer` auto-detects `.ttf` → `font/sfnt`. If not, add to relay.go's MIME switch:
  ```go
  case strings.HasSuffix(path, ".ttf"):
      w.Header().Set("Content-Type", "font/sfnt")
  ```
- **Static site (Caddy):** Caddy auto-serves with correct MIME. No config needed.

### Fetch in main thread

```js
// In app bootstrap (e.g., GitHubRepoViewer.js or a new FontLoader)
const fontResp = await fetch('/src/fonts/Cousine-Regular.ttf');
const fontBuffer = await fontResp.arrayBuffer();
```

## Builder Pipeline Changes

### Current flow (grapheme iteration)
```
text → iterGraphemes() → per-grapheme: lookup uvMap[grapheme] → numericId
     → write position (fixed charWidth advance), size, codepoint, color
```

### New flow (HarfBuzz shaping)
```
text → shaper.shape(text) → [{g, cl, ax, ay, dx, dy}, ...]
     → per-glyph: write position (ax advance), size, glyphId, color
```

Key differences in `buildGlyphBuffers`:
1. **No `iterGraphemes()`** -- HarfBuzz handles segmentation, ligatures, reordering.
2. **No `uvMap` lookup** -- glyph IDs come directly from shape output. (During transition Phase 1→2, we still need atlas rendering, so we'll map glyphId → atlas entry. Phase 3 removes this.)
3. **Variable advance** -- `ax` from shape output replaces fixed `charWidth`. Must scale from font units to world units: `worldAdvance = (ax / upem) * fontSize * worldScale`.
4. **Offsets** -- `dx`, `dy` from shape output adjust glyph position (diacritics, mark attachment). Added to base position.
5. **Newline handling** -- HarfBuzz doesn't emit glyphs for `\n`. The builder must split text on newlines, shape each line separately, and track line breaks for `lineSlotOffsets`.
6. **Space handling** -- HarfBuzz DOES emit a glyph for space (glyph ID typically 3 in most fonts). The builder must detect space glyphs (advance-only, no visible outline) and skip writing them to the render buffer while still advancing the cursor.

### Sketch: new `buildShapedBuffers` (replaces inner loop of `buildGlyphBuffers`)

```js
/**
 * @param {Object} input
 * @param {string} input.text
 * @param {{x,y,z}} input.position
 * @param {HarfBuzzShaper} input.shaper
 * @param {number} input.fontSize - target size in world units
 * @param {{r,g,b}} input.color
 * @param {number} [input.scale=1.0]
 * @param {number} [input.groupId=0]
 */
export function buildShapedBuffers(input) {
    const { text, position, shaper, fontSize, color, scale = 1.0, groupId = 0 } = input;
    const upem = shaper.upem;
    const scaleFactor = (fontSize / upem) * scale;
    const extents = shaper.fontExtents();
    const lineHeight = ((extents.ascender - extents.descender + extents.lineGap) / upem) * fontSize * scale;

    const lines = text.split('\n');
    const lineSlotOffsets = [];

    // Pre-count: shape all lines, count non-space glyphs
    const shapedLines = [];
    let totalGlyphs = 0;
    for (const line of lines) {
        const shaped = line.length > 0 ? shaper.shape(line) : [];
        // Filter: space glyph has zero outline but nonzero advance
        const visible = shaped.filter(g => {
            const outline = shaper.glyphOutline(g.g);
            return outline.length > 0;  // has path data = visible
        });
        shapedLines.push({ all: shaped, visible });
        totalGlyphs += visible.length;
    }

    // Allocate
    const positions = new Float32Array(totalGlyphs * 3);
    const sizes     = new Float32Array(totalGlyphs * 2);
    const glyphIds  = new Float32Array(totalGlyphs);
    const colors    = new Float32Array(totalGlyphs * 3);
    const groupIds  = new Float32Array(totalGlyphs);

    let idx = 0;
    let cursorY = position.y;

    for (let li = 0; li < shapedLines.length; li++) {
        lineSlotOffsets.push(idx);
        let cursorX = position.x;
        const { all } = shapedLines[li];

        for (const g of all) {
            const advance = g.ax * scaleFactor;
            const outline = shaper.glyphOutline(g.g);
            if (outline.length === 0) {
                cursorX += advance;
                continue; // space/control -- advance only
            }

            positions[idx * 3]     = cursorX + g.dx * scaleFactor;
            positions[idx * 3 + 1] = cursorY + g.dy * scaleFactor;
            positions[idx * 3 + 2] = position.z;

            sizes[idx * 2]     = advance;
            sizes[idx * 2 + 1] = lineHeight;

            glyphIds[idx] = g.g;

            colors[idx * 3]     = color.r;
            colors[idx * 3 + 1] = color.g;
            colors[idx * 3 + 2] = color.b;

            groupIds[idx] = groupId;

            idx++;
            cursorX += advance;
        }
        cursorY -= lineHeight;
    }

    return { positions, sizes, codepoints: glyphIds, colors, groupIds, count: idx, lineSlotOffsets };
}
```

**Performance note:** Calling `glyphOutline()` per glyph in the inner loop is expensive. Optimization: cache a `Set<glyphId>` of space/empty glyphs after first encounter. For Cousine (~200 glyphs), this set is tiny.

## Data Flow to Phase 2 (SlugEncoder)

Phase 2's `SlugEncoder` needs two things per unique glyph:
1. **Outline curves** -- `shaper.glyphOutline(glyphId)` returns `[{type, values}]`
2. **Glyph extents** -- `shaper.font.glyphExtents(glyphId)` returns `{xBearing, yBearing, width, height}`

The shaper collects unique glyph IDs during shaping. After all text is shaped:

```js
// Collect unique glyph IDs across all shaped text
const uniqueGlyphs = new Set();
for (const result of allShapedResults) {
    for (const g of result) uniqueGlyphs.add(g.g);
}

// Phase 2 entry point
const slugEncoder = new SlugEncoder();
for (const glyphId of uniqueGlyphs) {
    const curves = shaper.glyphOutline(glyphId);
    const extents = shaper.font.glyphExtents(glyphId);
    slugEncoder.addGlyph(glyphId, curves, extents);
}
slugEncoder.buildTextures(); // → curveTexture, bandTexture, glyphMapTexture
```

## Memory Management

HarfBuzz WASM allocates on its own heap. Every `create*` must have a matching `destroy()`.

**Pattern:** `try/finally` for per-shape buffers; `destroy()` method on HarfBuzzShaper for long-lived objects.

```js
// Per-shape (in shape() method) — buffer created and destroyed each call
const buffer = this._hb.createBuffer();
try {
    buffer.addText(text);
    buffer.guessSegmentProperties();
    this._hb.shape(this._font, buffer);
    return buffer.json();
} finally {
    buffer.destroy();  // always runs, even on exception
}
```

```js
// Long-lived (in HarfBuzzShaper.destroy()) — called on app teardown
destroy() {
    if (this._font) { this._font.destroy(); this._font = null; }
    if (this._face) { this._face.destroy(); this._face = null; }
    if (this._blob) { this._blob.destroy(); this._blob = null; }
    this._hb = null;
    this._ready = false;
}
```

Workers: each worker's `HarfBuzzShaper` is destroyed when the worker terminates. WorkerBridge already calls `worker.terminate()` in its `dispose()`.

## Makefile / Embedding Changes

None needed for `src/`. The existing `ASSETS` list already copies `src/` into `cli/web/src/`. The new `src/shaping/vendor/` and `src/fonts/` directories are automatically included.

WASM MIME type is already handled in `relay.go` line 389-390.

TTF MIME needs one line added to `relay.go`:
```go
case strings.HasSuffix(path, ".ttf"):
    w.Header().Set("Content-Type", "font/sfnt")
```

## Validation Plan

After vendoring + wiring:
1. **WASM loads on main thread:** `HarfBuzzShaper.init(fontBuffer)` resolves without error.
2. **Shaping works:** `shaper.shape("Hello")` returns 5 glyph objects with nonzero advances.
3. **Outline extraction works:** `shaper.glyphOutline(glyphId)` returns non-empty array with M/L/Q/C/Z segments.
4. **Workers initialize:** All workers respond with `FONT_READY` after `INIT_FONT`.
5. **Workers shape:** Worker-side `shaper.shape()` produces identical output to main thread.
6. **Existing rendering still works:** Until Phase 3 replaces the atlas, the old bitmap path remains functional alongside the new shaping path (parallel, not fallback -- Phase 3 deletes the old path).
