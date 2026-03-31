# Round 1: rendering reviews parsing, orchestration

## Errors Found

### 1. `clearAllHighlights()` is broken — orchestration relies on it for tour teardown

`TourAnnotator.remove()` and `TourSequencer.clear()` depend on highlights being
cleared when a tour step is torn down. The orchestration doc describes cleanup via
`grid.clearAllHighlights()` (idempotency table, "Highlights" row).

**The actual method is broken.** `CodeGrid.clearAllHighlights()` (line 636) reads:

```js
const attr = renderer.instanceMesh.geometry.attributes.instanceAddedColor;
if (!attr) return;      // ← silently exits here, every time
```

`GlyphRenderer.js` line 270 documents exactly why this will be `undefined`:

```js
// instanceAddedColor removed — highlight is now via highlightTexture (RGBA8 DataTexture)
```

Highlights live in `_highlightTexture`, written via `setGlyphHighlight()` (line 634).
`clearAllHighlights()` must be rewritten to zero out the DataTexture slice belonging
to this grid's buffer slots, the same way `clearLineHighlight()` (line 620) calls
`renderer.setGlyphHighlight(base + i, null)` per slot. Any tour teardown path that
calls the current `clearAllHighlights()` leaves stale highlight colors on screen.

**File**: `src/collections/CodeGrid.js:633-640`

---

### 2. `TourConnector` creates per-connection `THREE.Line` objects — O(N) draw calls

`TourConnector._createLine()` (orchestration doc, line 848) creates a new
`THREE.Line` per connection, each with its own `BufferGeometry` and
`LineBasicMaterial`. A 10-step tour visiting pairs of grids produces 10 separate
draw calls. More critically, these are `THREE.Line` (line strip), not
`THREE.LineSegments`, and they have no arrowheads.

The rendering design has a `ConnectionRenderer` with a single pre-allocated
`LineSegments` geometry (1 draw call, arrowheads included, `addUpdateRange` partial
uploads). Orchestration wrote a parallel, weaker implementation that ignores it.

**File**: orchestration doc `TourConnector.js` sketch, `_createLine()` method.

---

### 3. `TourAnnotator` calls `highlightRange` with 1-based line numbers from parsed refs

The orchestration `TourAnnotator.apply()` (line 687) passes `ref.line` directly to
`grid.highlightRange()`. The parsing layer outputs **1-based** line numbers
(parsing doc, Section 7 edge-cases table, row "1-based vs 0-based": "Parsers output
1-based; resolver converts in one place"). `CodeGrid.highlightRange()` expects
**0-based** line indices (parameter comment at line 597: "0-based exclusive").

The orchestration's `ParsedReference` typedef (line 39) shows `line` as 0-based
("0-based line number"), but this contradicts the parsing doc's explicit statement
that parsers output 1-based. The conversion never happens: neither the resolver
nor the annotator adjusts. Off-by-one errors on every highlighted range.

**Files**: orchestration doc lines 39, 687; parsing doc Section 7 (edge-case table).

---

### 4. `TourSequencer._animateToStep` imports Three.js with `await import('three')`

Line 415 of the orchestration doc:

```js
const THREE = await import('three');
```

This is inside an `async` method that runs on every `goto()`. Dynamic import is
deferred and asynchronous; while it will resolve from module cache after the first
call, it adds unnecessary microtask overhead in a timing-sensitive animation path.
`THREE` is already available in every app-layer file as a static import. The
sequencer lives in `src/services/tour/` and imports from
`app/commands/handlers/spatialHelpers.js` (line 240), which already has
`import * as THREE from 'three'` at the top. A simple static import on the sequencer
resolves this.

**File**: orchestration doc `TourSequencer._animateToStep`, line 415.

---

### 5. `_refreshDrawRange` in `ConnectionRenderer` counts vertices incorrectly in the
   section header comment

Phase0-rendering Section 1, Buffer layout text (line 55) says:

> `geometry.setDrawRange(0, activeSegments * 2)` controls how many vertices Three.js
> submits

`activeSegments * 2` is the vertex count for a `LineSegments` shaft (2 verts per
segment), but each connection uses `VERTS_PER_CONNECTION = 6` vertices (shaft + 2
arrowhead segments). The comment is misleading. The actual `_refreshDrawRange()`
implementation (line 279) uses `(maxSlot + 1) * VERTS_PER_CONNECTION` which is
correct. The introductory comment should say `activeConnections * VERTS_PER_CONNECTION`.

**File**: phase0-rendering.md lines 55-56 (comment only, implementation is correct).

---

## Gaps

- **Rendering** covered: `ConnectionRenderer` (single draw call, pre-allocated buffers,
  `addUpdateRange`, arrowheads, frustum visibility refresh via `grid.parent` check).
  Not covered: how `ConnectionRenderer` integrates with a registry or gets held on `ctx`.

- **Parsing** covered: the full parser stack (file-ref, stack trace, log-line, auto).
  Not covered: any rendering or orchestration concerns. Pure data layer — appropriate.
  Notable gap: no guidance on how `ParseResult` flows into a `TourData` structure the
  sequencer accepts. The parsing doc ends at "resolver (Phase 1)" with no bridge.

- **Orchestration** covered: resolver, annotator, connector, sequencer, command integration.
  Not covered: that `ConnectionRenderer` exists in the rendering design. Orchestration
  wrote its own `TourConnector` from scratch, duplicating lower-quality functionality.

- **Both parsing and orchestration** missed: the GridVirtualizer `entry.active` flag
  distinction. The virtualizer tracks `entry.active` and `_active` set separately.
  `grid.parent !== null` (rendering doc, line 367) is a correct off-screen test, but
  there is also the budget culling path: a grid can have `parent !== null` yet
  `entry.active = false` transiently during the budget sort (lines 213-220 of
  `GridVirtualizer.js`). In practice this is sub-frame, but the comment in the
  rendering doc should note it.

---

## Tensions

### T1: 1-based vs 0-based line numbers across the layer boundary

- **Parsing doc** (Section 7): parsers output 1-based, "resolver converts in one place".
- **Orchestration doc** (ParsedReference typedef, line 39): `line` is 0-based.
- **Orchestration doc** (TourAnnotator.apply, line 687): passes `ref.line` directly to
  `grid.highlightRange()` with no conversion.
- **CodeGrid.highlightRange** (line 600): expects 0-based.

**Correct position**: parsing doc is right that parsers should output what they see in
source (1-based), and a single conversion point is the clean approach. But the
orchestration typedef must match. The resolver is the right conversion site. Currently
neither the resolver sketch nor the annotator converts. One of these must own it —
resolver is cleaner because it keeps the annotator free of coordinate concerns.

### T2: `TourConnector` vs `ConnectionRenderer` for line drawing

- **Rendering** designed a pooled, single-draw-call `ConnectionRenderer` with typed arrays,
  `addUpdateRange`, arrowheads, and frustum-aware hide/show.
- **Orchestration** wrote `TourConnector` creating individual `THREE.Line` objects per
  connection, no pooling, no arrowheads, no frustum awareness.

**Correct position**: `ConnectionRenderer` is architecturally correct for this codebase.
The entire library's performance philosophy is single draw calls and pre-allocated typed
arrays. `TourConnector` should be a thin wrapper that holds one `ConnectionRenderer`
instance on `ctx` and delegates to its `set()`/`remove()`/`clear()` API.

### T3: Where `ConnectionRenderer` lives

- **Rendering**: `src/annotations/ConnectionRenderer.js`, new `annotations/` directory,
  registered in `src/index.js`.
- **Orchestration**: `TourConnector` placed in `src/services/tour/`, tight coupling to tour.

**Correct position**: `ConnectionRenderer` belongs at `src/annotations/` as rendering
proposed. It is a reusable GPU primitive with no tour-specific knowledge. `TourConnector`
at `src/services/tour/` should import it, not reimplement it.

---

## Recommendations

1. **Fix `clearAllHighlights()`** in `src/collections/CodeGrid.js`. Rewrite to iterate the
   grid's buffer slot range and call `renderer.setGlyphHighlight(slot, null)` per slot,
   exactly as `clearLineHighlight()` does. This is the only correct path to zeroing the
   DataTexture entries for a specific grid without disturbing other grids sharing the
   same renderer.

2. **Delete `TourConnector._createLine()`** and replace the entire class with a thin
   wrapper around `ConnectionRenderer`. Store `ConnectionRenderer` on `ctx` (e.g.
   `ctx.connectionRenderer`) so it persists across steps. `TourConnector.apply()` calls
   `ctx.connectionRenderer.set(id, from, to, color)`; `TourConnector.remove()` calls
   `ctx.connectionRenderer.remove(id)`.

3. **Decide the 1-based/0-based ownership** and enforce it in one place. Recommended:
   parsing doc is the spec — parsers emit 1-based. The resolver subtracts 1 on `line`,
   `col`, `endLine`, `endCol` before populating `ResolvedReference`. Update the
   orchestration's `ParsedReference` typedef comment to say 1-based to match parsing doc.

4. **Replace `await import('three')` in `TourSequencer._animateToStep`** with a static
   import at the top of `TourSequencer.js`. The dynamic import buys nothing here.

5. **Wire `ConnectionRenderer.refreshVisibility()`** into the application animate loop
   after `virtualizer.update()`. Without this hook, connections to off-screen grids
   leave orphan line segments pointing at stale world-space positions.

6. **Bridge parsing output to `TourData` format.** The parsing layer produces
   `ParseResult { refs: ParsedRef[] }`. The orchestration's `TourData` expects
   `{ steps: [{ refs: ParsedReference[] }] }`. A small adapter (possibly in
   `tourCommands.js`) should convert `ParsedRef` (which has `ref.filePath`, 1-based
   `ref.line`) to `ParsedReference` (which has `file`, 0-based `line`). This adapter
   is the single coordinate-conversion point recommended in item 3.

7. **Add `ConnectionRenderer` to `src/index.js` exports** and `package.json` exports map
   at `glyph3d-js/annotations`. It is reusable beyond tours (e.g., call graph display,
   diff annotation).

8. **`TourAnnotator._highlightToken` accesses `grid.lines` directly** (orchestration doc,
   line 751). `grid.lines` is empty after the async load path (`loadTextAsync`) until
   `getLineCount()` is called. Replace with `grid.getLineCount()` + `grid.lines[i]`
   after ensuring population, or use `grid.content.split('\n')` as a fallback.

9. **Orchestration `_findBySuffix` confidence formula** produces values between 0.5 and
   0.9. The baseline of 0.5 means a single-character suffix match ("a" matching "b/a")
   gets 0.5 + 0.4 * (1/3) ≈ 0.63, which ranks above basename-only at 0.4. This seems
   intentional but may cause false-positive matches. Consider a minimum suffix length
   threshold (e.g., require the ref to be at least 3 chars or include a path separator
   to qualify for suffix match at all).

10. **`setDrawRange` introductory comment in rendering doc** (line 55) says
    `activeSegments * 2`; correct to `activeConnections * VERTS_PER_CONNECTION` to avoid
    confusing future readers about segment vs vertex counts.

---

## Key Insight

The most consequential gap between the three designs is that orchestration's
`TourConnector` and rendering's `ConnectionRenderer` solve the same problem
independently, but only `ConnectionRenderer` is architecturally sound. Worse, the
`clearAllHighlights()` method that orchestration relies on for teardown silently does
nothing because it targets a buffer attribute that was removed from the geometry in favor
of the RGBA8 DataTexture highlight system. Both bugs — duplicate line renderer and broken
highlight cleanup — stem from the same root cause: orchestration was designed without
reading the current GPU state of the renderer, specifically that `instanceAddedColor` was
removed (`GlyphRenderer.js` line 270) and that highlights are now DataTexture writes via
`setGlyphHighlight()`. Any implementation pass must audit the concrete renderer API before
writing cleanup and annotation paths.
