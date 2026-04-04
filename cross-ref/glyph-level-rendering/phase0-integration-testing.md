# Glyph-Level Rendering: Integration Testing Strategy

Agent: integration-testing
Date: 2026-03-30

---

## 1. Phase Dependency Graph

```
Phase 1: instanceBufferIndex
  - GlyphRenderer emits instanceBufferIndex per glyph
  - Worker builders emit it alongside other attributes
  - Shader receives it as a passthrough varying
  - No visual change — identity verification only
  BLOCKS: Phase 2 (picking needs a stable buffer index to return)

Phase 2: Picking Texture
  - Second render pass writes instanceBufferIndex into RGBA offscreen texture
  - readPixels() on click/hover returns index
  - Index resolves to (gridId, glyphIndex) via GlyphRegistry
  BLOCKS: Phase 3 (highlight needs a resolved glyph to colorize)
  BLOCKS: Phase 4 (SemanticInfoMap lookup needs a glyph index)

Phase 3: Additive Color Attribute
  - New instanceColorAdd (vec3) per-instance attribute
  - Fragment shader adds it after base color multiply
  - updateGlyphHighlight(index, {r,g,b}) writes directly to buffer
  PARALLEL with Phase 2 progress — can be visually stubbed with
  hard-coded index before picking is wired

Phase 4: SemanticInfoMap
  - Constructed at file load time from syntax token annotations
  - Maps glyphIndex ranges to token type + metadata
  - Picking result → SemanticInfoMap.lookup() → highlight + event
  REQUIRES: Phase 2 resolved identity, Phase 3 highlight path
```

Phases 1 and 2 are strictly sequential. Phase 3 can be developed and
tested visually in parallel with Phase 2, using a hard-coded glyph index
stub. Phase 4 cannot be meaningfully tested until 2 and 3 are stable.

---

## 2. Phase 1 Test Plan: instanceBufferIndex

**What is being verified:** Every glyph's buffer slot index is correctly
written into `instanceBufferIndex`, both via the sync path
(`GlyphRenderer._rebuildAllInstances`) and the worker path
(`buildBatchBuffers` in `src/workers/builders/`).

**What you see in the browser:**

Open a dedicated test page at `examples/picking-test/index.html`.
After a CodeGrid loads, the page runs this snippet in DevTools or in the
page itself:

```js
const geometry = grid.getCollection().getRenderer().instanceMesh.geometry;
const attr = geometry.attributes.instanceBufferIndex;
// Should be: attr.array[i] === i for every valid instance
let valid = true;
for (let i = 0; i < geometry.instanceCount; i++) {
  if (attr.array[i] !== i) { valid = false; break; }
}
console.log('Phase 1 OK:', valid, 'instances:', geometry.instanceCount);
```

Pass condition: console prints `Phase 1 OK: true` with a nonzero instance
count. The scene renders identically to before — no visual change is
expected.

**Regression signal:** If `instanceBufferIndex` is missing or all-zero
after a flush, the attribute was not added to the geometry or the builder
does not emit it. Check `GlyphRenderer._createInstanceMesh` and
`buildBatchBuffers` return values.

---

## 3. Phase 2 Test Plan: Picking Texture

**What is being verified:** A second render pass writes buffer indices
into an offscreen `WebGLRenderTarget`. On mouse click, `readPixels()`
returns the correct buffer index, which resolves to a grid and a glyph
slot.

**Picking texture debug view:**

The test page renders the picking texture as a small overlay in the
bottom-right corner of the canvas (similar to a shadow-map debug view
in game engines). This makes the picking pass directly observable without
any interaction required:

```
+----------------------------------+
|                                  |
|  Main 3D Scene                   |
|                                  |
|                     +----------+ |
|                     | picking  | |
|                     | texture  | |
|                     | (debug)  | |
|                     +----------+ |
+----------------------------------+
```

The picking texture should show colored regions where glyphs are. Hover
over a glyph — the pixel under the cursor should be non-black. The
overlay is toggled with a keyboard shortcut (e.g., `P`) so it does not
clutter production use.

**Interactive validation:**

Click a glyph. The test page logs to a DOM overlay:

```
Picked: bufferIndex=1247, grid="src/GlyphRenderer.js", glyphSlot=1247
Char: 'R', line: 24, col: 8
```

Pass condition: bufferIndex matches the char at the visual position
clicked. Move the camera — picking must remain consistent after any
transform.

**Grid identity resolution:**

Each `GlyphRenderer` instance registers itself with a module-level
`PickingRegistry` (a `Map<pickingId, renderer>`). The picking color
encodes `pickingId` in the high bits and `bufferIndex` in the low bits
of the RGBA value. On readback, the two fields are decoded separately.

This avoids per-scene raycasting and works regardless of how many grids
are loaded.

---

## 4. Phase 3 Test Plan: Additive Color

**What is being verified:** A `instanceColorAdd` attribute is added to
the instanced geometry. `GlyphRenderer.setGlyphHighlight(bufferIndex, color)`
writes to it directly (no rebuild). The fragment shader adds the highlight
color on top of the base glyph color without destroying it.

**Visual validation:**

On the test page, a slider controls a "highlight sweep" that walks
`instanceColorAdd` through all instances sequentially at ~100 glyphs per
frame. The result is a visible wave of cyan tint moving left-to-right
across the text. Speed and color are adjustable via the UI.

Pass condition: the sweep is smooth and color returns to normal when
`setGlyphHighlight(idx, {r:0,g:0,b:0})` is called (zero additive = no
change to base color).

**Stub for Phase 4 pre-integration:**

Before Phase 2 picking is wired, a mousedown handler in the test page
converts the canvas click coordinates to a hard-coded buffer index
(e.g., first glyph of a named section). This lets Phase 3 be validated
interactively without depending on the picking texture.

---

## 5. Phase 4 Test Plan: Semantic Hover/Highlight

**Full pipeline end-to-end:**

```
mousemove on canvas
  → readPixels at (x, y) from picking render target
  → decode (pickingId, bufferIndex)
  → PickingRegistry.resolve(pickingId) → GlyphRenderer
  → renderer.getGlyphMeta(bufferIndex) → { gridId, charIndex }
  → SemanticInfoMap.lookup(charIndex) → SemanticInfo | null
  → if SemanticInfo: dispatch GlyphHoverEvent
  → listener: highlight token range via setGlyphHighlight()
```

**What you see in the browser:**

Hover over any identifier in a loaded file. A tooltip appears with:
- Token type: `function`, `class`, `variable`, etc.
- Token name: the actual text of the token
- Source location: line and column

All glyphs belonging to the same token are highlighted simultaneously
(additive color, e.g., soft yellow for variables, cyan for functions).
When the cursor moves off, highlight clears.

Pass condition: hovering `function` keyword highlights all characters of
that keyword. Hovering an identifier that spans multiple glyphs
highlights the full span, not just the character under the cursor.

**Regression signal for Phase 4:** If highlighting shows only one
character instead of a full token span, SemanticInfoMap token ranges are
not being applied correctly. If hovering shows nothing, the picking
texture or the SemanticInfoMap population is broken.

---

## 6. SemanticInfoMap Design

**Where it lives:** `src/semantic/SemanticInfoMap.js` — library code, not
app code. It has no DOM or Three.js imports (pure data structure). The
app layer in `app/GitHubRepoViewer.js` constructs and holds instances,
one per loaded file.

**Data structures:**

```js
// src/semantic/SemanticInfoMap.js

export class SemanticInfo {
  constructor({ tokenType, text, glyphStart, glyphEnd, line, col }) {
    this.tokenType = tokenType;  // 'function' | 'class' | 'variable' | 'keyword' | ...
    this.text = text;            // raw token text
    this.glyphStart = glyphStart; // inclusive buffer index of first glyph
    this.glyphEnd = glyphEnd;     // exclusive buffer index past last glyph
    this.line = line;
    this.col = col;
  }
}

export class SemanticInfoMap {
  constructor() {
    // Primary: glyph index → SemanticInfo (one entry per glyph slot)
    // Built as flat array for O(1) lookup by buffer index
    this._glyphIndex = [];        // Float32Array-backed or plain Array

    // Category buckets: tokenType → SemanticInfo[]
    this.functions = [];
    this.classes = [];
    this.variables = [];
    this.keywords = [];
    this.strings = [];
    this.comments = [];
  }

  // Called once at file load time, O(N) across all tokens
  populate(tokens, glyphOffsets) { ... }

  // O(1) by buffer index — called on every hover frame
  lookup(glyphBufferIndex) {
    return this._glyphIndex[glyphBufferIndex] ?? null;
  }

  // Returns all glyph indices for the same token as the given index
  getTokenRange(glyphBufferIndex) {
    const info = this.lookup(glyphBufferIndex);
    if (!info) return null;
    return { start: info.glyphStart, end: info.glyphEnd };
  }
}
```

**Population:** `SemanticInfoMap.populate(tokens, glyphOffsets)` takes
a flat array of token descriptors (produced by a lightweight tokenizer
or language server annotations, not TreeSitter for now) and an array of
per-character buffer offsets produced during the flush. The flush path in
`GlyphCollection.flush()` needs to return or emit a `glyphOffsets` array
alongside the normal flush result. This is a required addition to Phase 1.

**What does NOT live here:** syntax highlighting colors, UI tooltip HTML,
event dispatch. Those stay in `app/`.

---

## 7. Event API Design

**Where it lives:** `src/semantic/GlyphEvents.js`

```js
export const GlyphEventType = {
  HOVER_ENTER: 'glyph:hover:enter',
  HOVER_EXIT:  'glyph:hover:exit',
  CLICK:       'glyph:click',
};

// Event shape — all three event types share this structure
// { type, bufferIndex, glyphMeta, semanticInfo }
// where glyphMeta = { gridId, charIndex, char, line, col }
// and semanticInfo = SemanticInfo | null
```

**Subscription surface:**

```js
// Application code wires this once at init
glyphEventBus.on(GlyphEventType.HOVER_ENTER, (event) => {
  if (event.semanticInfo) {
    highlightTokenRange(event.semanticInfo.glyphStart, event.semanticInfo.glyphEnd);
    showTooltip(event.semanticInfo);
  }
});

glyphEventBus.on(GlyphEventType.HOVER_EXIT, (event) => {
  clearHighlights();
  hideTooltip();
});
```

**`GlyphEventBus`** is a thin `EventTarget` wrapper or a plain
`Map<type, Set<listener>>`. It lives in `src/semantic/GlyphEventBus.js`.
It is not a singleton — each viewer instance owns one.

**What dispatches events:** A `PickingController` (new class in
`src/semantic/PickingController.js`) drives the render-to-texture pass
each frame, performs readback on mouse events, and dispatches
`GlyphEvents` through the bus. `GitHubRepoViewer.js` constructs
`PickingController` and wires it to `GlyphEventBus`.

---

## 8. Test Page Design

**File:** `examples/picking-test/index.html`

This page is the integration test environment for all four phases. It is
self-contained — no dependency on the full viewer app.

**What it loads:**

- A single `GlyphAtlas` and one `CodeGrid` populated with
  `src/GlyphRenderer.js` (the renderer's own source, providing a known
  text payload).
- A minimal Three.js scene with a static camera (no fly controls, less
  state to debug).
- A `PickingController` that can be toggled on/off.
- A `SemanticInfoMap` pre-populated with fake token data (5-10 manually
  defined tokens) before Phase 4's tokenizer exists.

**Controls panel (DOM overlay):**

```
[P] Toggle picking texture debug view
[H] Highlight sweep (walk all instances)
[C] Clear all highlights
[1] Phase 1 self-test (logs to console)
[2] Phase 2 self-test (hover + log readback)
[3] Phase 3 self-test (sweep animation)
[4] Phase 4 self-test (fake tokens + hover)
```

**Self-test output:** Each keyed self-test writes PASS/FAIL lines to a
DOM `<pre>` element on the page. This replaces a test runner without
requiring one.

**How to run a regression check manually:**

1. `npm run serve`
2. Open `http://localhost:8000/examples/picking-test/`
3. Press `1` through `4` in sequence
4. All lines should read PASS

---

## 9. Regression Strategy

No automated test runner. The regression strategy is:

**Self-test assertions baked into the test page.** Each phase's self-test
checks the invariant most likely to silently break:

- Phase 1: `attr.array[i] === i` for all instances
- Phase 2: click at a known pixel position returns a known buffer index
  (seeded with a fixed camera position and a known glyph layout)
- Phase 3: after `setGlyphHighlight(0, {r:1,g:0,b:0})`, read back
  `instanceColorAdd.array[0]` and verify it equals 1.0
- Phase 4: lookup at `glyphBufferIndex=0` (which maps to a known fake token)
  returns the correct `SemanticInfo.tokenType`

**Visual diff discipline:** Before merging any change that touches
shaders, buffer builders, or the picking controller, load the test page
and verify the picking texture overlay looks the same as before (same
colored regions, same boundaries). No automated pixel comparison — just
the developer's eye using the always-visible overlay.

**Attribute count guard in `GlyphRenderer._createInstanceMesh`:**

Add a dev-mode assertion that counts all `InstancedBufferAttribute` entries
and logs them. If a phase adds or removes an attribute without updating
the count assertion, the log will flag it.

---

## 10. Risk Assessment

**Highest risk: picking texture readback latency.**
`gl.readPixels()` is a GPU sync point — it stalls the CPU until the GPU
finishes the frame. On a large scene (50+ grids, 500K glyphs), the
picking render pass itself may take 3-5ms, and the readback adds another
1-2ms. If done every frame this will break 60fps.

Mitigation: throttle readback to every-other frame for hover, only
do synchronous readback on click. Cache the last picked index and only
re-read when the mouse has moved more than N pixels.

**Second risk: buffer index stability across flushes.**
`GlyphRenderer._rebuildAllInstances` currently rebuilds the entire buffer
from `renderedTexts`, and buffer slot assignments can shift if any text
entry is removed and re-added. If the `SemanticInfoMap` holds buffer
indices and the user triggers a rebuild (e.g., by reloading a file), all
cached indices become stale.

Mitigation: `SemanticInfoMap` must be reconstructed alongside every
full rebuild, not cached across flushes that change the text set. The
`populate()` call should be wired into the flush completion callback, not
called once at load. This is a design constraint Phase 1 must enforce.

**Third risk: worker path buffer index continuity.**
The async path in `GlyphCollection.flushAsync()` calls
`WorkerBridge.buildBatchBuffers()`, which returns a combined
`Float32Array`. Buffer indices in the worker output must be globally
sequential (not per-item sequential) for the picking texture to decode
them correctly. The worker builder will need to receive a `startIndex`
parameter indicating where in the global buffer its batch begins.

**Fourth risk: multi-grid picking collision.**
If two `GlyphRenderer` instances write overlapping buffer indices into
the picking texture, readback is ambiguous. The `pickingId` encoding in
the RGBA value (described in Phase 2) must be assigned at renderer
construction time and must not collide. A module-level counter
in `PickingRegistry` ensures uniqueness, but it must survive hot-reload
in development. If it resets to 0 on hot-reload, old texels from the
previous render cycle will decode to the wrong renderer.

Mitigation: `PickingRegistry` uses a monotonically increasing counter
stored in `window.__pickingIdCounter` so hot-reload does not reset it.
