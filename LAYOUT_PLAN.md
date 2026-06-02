# LAYOUT_PLAN.md — the `LayoutDescription` seam

Split **layout** (a pure, analytic map from source `(line,col)` → local 3D position,
plus queries) from **buffer construction** (filling instance arrays). Make line/column
data authoritative + queryable; make the two layout shapes *params* not code paths; make
the eventual GPU compute kernel a transcription with the CPU layout as its oracle.

Status: **design approved 2026-06-01, starting Step 1.** Supersedes the parked
`experiment/layout-substrate` proposal (reconstructed here from the subsystem map).

## Decisions locked (Ivan)

- **Windowing is a re-architecture, not an extension.** Today it windows by *truncating
  source input* before layout — that is the disease (see below). We invert it to
  *post-layout framing*. Atomic rewrite, no compat shims (project convention).
- **Full-load first.** Files load *fully* by default. Get the seam provably correct with
  the whole file materialized ("load it all, does it still work"), *then* bring in partial
  windows + on-demand loads. Windowing/virtualization is a later step, not the baseline.
- **Row-snapped scroll** (re-materialize visible rows, like the terminal) for v1; pixel-smooth
  (shader clip) is a later upgrade behind the same seam.
- **Glyph-count wrap** (wrap at 200 glyphs) stays — close enough to terminal-width wrap for
  the monospace font; width-based wrap deferred to when proportional fonts matter.

## What the subsystem map found (the real problems)

1. **Windowing truncates the wrong layer.** `setWindow → _renderWindow`
   (`CodeGrid.js`) does `src.slice(first, first+rows).map(l => l.slice(0, cols))` and feeds
   *that* to the builder, **overwriting `this.lines` with the visible window**. After a
   scroll: intra-line wrap never fires (input capped below the 200-glyph threshold),
   `lineSlotOffsets`/`wrapColsPerLine` describe the window not the file, the caret persists
   onto the *wrong* source line, highlight ranges break. This is why line/col is "no longer
   bearing."
2. **Three coordinate systems conflated with no names or conversions:** SOURCE `(line,col)`
   in the file, VISUAL (visual row after wrap+page), WORLD `(x,y,z)` — plus BUFFER slot as a
   leaky cache.
3. **Edge-overlap bug** (`builders/index.js:57`): `pageWidthWorld = 200 × charAdvance` is a
   char-count guess computed *before* layout; glyphs actually sit at summed HarfBuzz
   advances, so per-glyph drift accumulates over 200 glyphs → pages overlap (or gap).
4. **Pagination math is duplicated** — `applyPagination` (buffer) and
   `CodeGrid._resolveCaretWorldPosition` (caret) re-implement the same formula; fixes must
   land twice.
5. Layout is computed *imperatively as a buffer byproduct* — no persistent, queryable
   product. Consumer fields are hand-threaded through `applyPrebuiltBuffers`; fields of
   omission keep getting dropped (the recurring caret bugs).

## Coordinate systems (named, with conversions)

- **SOURCE** `(srcLine, srcCol)` — position in the original file. The ONLY namespace
  consumers speak. Authoritative.
- **VISUAL** `(visualRow, …)` — row after intra-line wrap + pagination. *Derived.*
- **WORLD** `(x,y,z)` — grid-local position. *Derived.*
- **BUFFER** `slot` — flat instance index. A *cache*, never authoritative. (Invariant kept:
  slot offset within a line == codepoint index.)

Inverse (WORLD→SOURCE, i.e. click/hit-test) is already served by the GPU picking pass
(`PickingSystem.resolveGlyph`), so the seam exposes **forward queries only**.

## The `LayoutDescription` (the design)

The authoritative product of a build: positions + the line/wrap/slot tables + query
methods, computed once from the full source, consumed by both the buffer fill and every
consumer. `core/LayoutDescription.js` — pure, worker-compatible (no Three.js/DOM).

Query surface (forward; synchronous; pure math over flat arrays):
- `positionAt(srcLine, srcCol) → {x,y,z}` — caret.
- `slotForChar(srcLine, srcCol) → slot` + `lineSlotOffsets` (Int32Array) — highlight.
- `rectsForRange(sL,sC,eL,eC) → rect[]` — selection (folds in wrap+page correctly).
- `spansForRows(firstVisualRow, lastVisualRow) → {startLine,endLine}` — culling/windowing.
- `contentBounds → Box`; authoritative `lineStartRow` / `lineWrapCols` tables.
- **Shared `metrics` + `params`** — one struct the buffer builder AND the queries read, so
  page width comes from the *actual* per-page max-x extent (kills the overlap), and the
  caret reads the same pagination math (kills the duplication).

Modes are params: `{ wrapWidth(=200 glyphs), columnHeight, columnsWide, gaps }`. Tall
column = `columnHeight:∞, columnsWide:1`; newspaper = finite height, N wide; wall = a flat
embedding. No `if(mode)` branches.

**Compute-ready:** the whole thing is a pure per-glyph function over flat typed arrays + a
params struct, so the future compute kernel is a mechanical transcription and the CPU
layout doubles as its test oracle (run both, assert position buffers match).

## Windowing, re-architected (later step) — output-framing, not input-truncation

Layout always runs on the **full source** (macro line table is `O(lines)`, cheap even at
200k; micro per-glyph x only for materialized rows). A window is `{firstVisualRow, rows,
scrollOffset}` that selects which rows to *materialize* into the buffer + a frame transform.
The macro table is **scroll-stable** (so caret/highlight stay correct across scrolls — the
bug class disappears). Scroll = re-window (pick rows, row-snapped); resize = re-macro
(params change). This is the terminal's `applyScreen` model with the layout as the source —
same windowed-surface object: `{ placement(tree), frame, source, scrollOffset }`.

## Staged migration (atomic per step; full-load throughout Steps 1–2)

**Step 1 — ✅ DONE** (f550da4, 983be1a, c5dbece, beb0215). extract the seam, full-load, fix the bug.
- New `core/LayoutDescription.js`: the analytic layout (positions + line/wrap/slot tables)
  + the query methods. Layout becomes the authoritative product; the GPU buffer is derived.
- Unify pagination into one function both the buffer fill and `positionAt` call (kills the
  duplicate caret math).
- Fix `pageWidthWorld` to use the *actual* per-page max-x extent, not `200×charAdvance`
  (kills the edge overlap). Tight bounds from `position+advance`, not `+charWidth`.
- *No windowing yet — the whole file materializes.* Baseline: load-it-all, render correct.

**Step 2 — ✅ DONE** (c5dbece, beb0215; caret confirmed by hand — move + edit). route consumers through the seam; retire the hand-plumbing.
- Caret (`_resolveCaretWorldPosition`), highlight (`highlightRange`/`slotForChar`),
  selection rects read the `LayoutDescription` snapshot, not buffer-curated fields.
- Retire the fragile `_buildLineSlotBase` fallback + the `wrapColsPerLine` hand-threading
  through `applyPrebuiltBuffers`; formalize `lineSlotOffsets`/`wrapColsPerLine` in the
  `GlyphBufferItemMeta` typedef. Caret shakiness fixed as a side effect.

**Step 3 (later) — output-framing windowing.** Rip out `_renderWindow` input-truncation;
window = frame + scrollOffset + partial materialization (row-snapped). Wire to wheel-scroll
(reuse the terminal scroll path) + resize-reflow. Restores source-authoritative line/col.

**Step 4 (later) — compute kernel** fills the bulk position buffer behind the same seam;
CPU stays the oracle + the query engine. Kernel-flags = the params struct.

## Anchors (from the map)

- `packages/glyph3d-core/src/workers/builders/index.js` — `buildBatchBuffers` (96–340),
  `applyPagination` (54–78), Z-wrap (217–228), wrap-cols (175–204, 294), bounds (268–287).
- `packages/glyph3d-core/src/collections/CodeGrid.js` — metrics (827–836), caret +
  duplicate pagination (1284–1336), `_buildLineSlotBase` (1186–1227), `_buildLayoutWrapIndex`
  (1252–1267), windowing `_renderWindow`/`setWindow` (128–138, 230–286), `highlightRange`
  (1387), `getSlotForChar` (1349).
- `packages/glyph3d-core/src/GlyphField.js` — `applyPrebuiltBuffers` (1109–1148).
- `packages/glyph3d-core/src/picking/PickingSystem.js` — `resolveGlyph` (782, inverse path).

## Test strategy

- **Oracle test:** run a sample file through the old builder and the new seam; assert
  position buffers match (modulo the intentional overlap fix). Doubles as the compute
  kernel's oracle later.
- **Live milestones (test with Ivan):** Step 1 → a large file (e.g. a big `.json`) loads
  fully + renders with no edge overlap; Step 2 → caret/click/highlight/selection correct on
  full files; Step 3 → wheel-scroll a windowed slice, camera fixed.
