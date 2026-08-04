# Handoff: GPU bounds, and the byte-in pipeline behind it

**Branch:** `claude/gpu-glyph-layout-cleanup-tewfk0`, rebased on `main` @ `0ad399f`
(your "one load path" — this sits cleanly on top of it).

There are **two independent layers** here and they land at different times. Read the split
first; most of the confusion risk is treating them as one thing.

| | Layer 1 — bounds as a closed form | Layer 2 — the byte-in pipeline |
|---|---|---|
| touches | the CURRENT fold path (builder + `GlyphLayoutKernel`) | nothing wired in yet |
| state | **complete, tested, app builds** | spec proven; **TSL never executed** |
| lands | now, if you want it | after a GPU harness run |
| risk | ordinary refactor risk | unknown until hardware |

---

## The one thing to know before touching Phase 2 of your plan

**Do not build the atomics bounds reduce as `one-load-path-gpu-bounds.md` Phase 2 describes
it.** Not because atomics are wrong — your read of them was better than mine, see below —
but because on the current fold path the number it computes is a **closed form**, and
measuring it back out of the buffer costs a GPU readback stall to recover something that
takes 128 nanoseconds of arithmetic.

Measured, 390,777 glyphs, newspaper mode:

```
layoutScan  (O(glyphs), runs either way)        0.863 ms
foldExtent  (O(1), what atomics would replace)    128 ns
```

The fold places glyphs by formula from CPU-authored tables, so the *edges* of the result are
computable by formula too. `core/foldGeometry.js:foldExtent` is that formula. It is exact
where it can be, provably conservative where it cannot, and both are asserted.

**Two corrections to my own earlier criticism, which you should have:**

- Your atomics were fine. `atomicMin`/`atomicMax` early-out before any compare-exchange, so
  contention collapses once the box converges — it is not 390k threads serialising on six
  cells, and fusing them onto a pass that already touches every glyph makes them ~free. That
  critique of mine was wrong.
- The forward-progress worry was also wrong for the look-back walk: it never spins. A thread
  that cannot inherit just does the work itself, so it needs no forward-progress guarantee.

Atomics **are** the right answer in Layer 2, where positions come from a racing GPU walk and
no closed form exists. `glyphPipelineKernels.js` uses exactly your shape.

**What to keep from your Phase 2:** step 6, the `layout.verify` extension. Asserting the GPU
readback's min/max against `grid._getContentBounds()` turns "the closed form is correct" from
a test-time claim into a live-scene one. That is worth having regardless of which layer wins.

---

## Layer 1 — what changed, and what you'll trip over

### API changes you may touch

| gone | replacement |
|---|---|
| `GlyphField._updateGeometryBounds(precomputed)` | `GlyphField.setLayoutExtent(box \| null)` — **stated**, never walked |
| `GlyphField.getTextBounds(id)` | deleted — zero callers, and returned all-zeros on an engine field |
| `GlyphField.measureSlotRange(...)` | deleted — returned `null` under `gpuLayout` anyway |
| `CodeGrid.setEngineBounds(box)` | `CodeGrid.setDisplacements(table, extent)` — one call, can't arm a table without stating where it lands |
| `CodeGrid._workerBoundsCache` | gone; `_getContentBounds()` derives on read |
| `buffers.bounds`, `itemMeta.bounds`, `itemMeta.pageContentWidth`, `itemMeta.wrapColsPerLine` | gone from the builder's output |
| `emitPositions` (builder/worker/bridge) | gone — the builder no longer folds |
| `paginationGeometry` / `paginationShift` / `applyPagination` | `foldGeometry.pageFold` / `pageShift` — integer rows, no epsilon nudge |

`BoundedObject3D`'s world-box cache is deleted. It cached the **world** box and needed a
16-float matrix snapshot to police it; the local box is now O(1), so the world box is derived
per call (eight corners) and nothing needs invalidating. Local box is memoisable on three
inputs — bytes, layout params, displacements — if it ever needs to be.

### Two bugs fixed on the way

- **`kernel._version` was read but never written.** `(undefined || 0) !== 2` is always true,
  so the layout kernel was disposed and fully rebuilt — buffers *and* pipeline — on **every
  flush**. Stamped at construction now. Worth knowing if you have perf numbers from before.
- **Four pagination gates collapsed to one.** The float gate, the ULP nudge, the
  `pageContentWidth` witness doing double duty as page-width *and* did-it-fire boolean, and
  the max-across-items `pageRows` uniform. What remains is `screenRow >= pageRows`, in the
  shader and the CPU mirror alike. Content exactly one page tall no longer paginates on one
  side and not the other — there's a fixture pinning that.

### Conventions worth not re-breaking

- **The extent spans ROWS, blank ones included.** A file ending in two empty lines is two rows
  taller than its last glyph. That is the document's size, not slack — the caret sits there
  and the panel must cover it. A test that measures laid-out *glyphs* will find the box larger
  by exactly the leading/trailing blank rows; that is correct, not a bug.
- **Two faces over-cover under pagination, by construction.** `maxX` fans by the widest row
  even if that row isn't in the last column; axis-`z` `minZ` combines the deepest wrap segment
  with the deepest page even if no glyph is at both. Both are bounded by one page stride and
  asserted. Tightening costs an O(rows) array; it was judged not worth it.

---

## Layer 2 — the byte-in pipeline

Three modules, none wired into the app:

- `compute/GlyphTrie.js` — codepoint → glyph metrics as a two-level Unicode trie (ICU's UTrie
  shape). Two dependent loads, no hashing, so no collisions and no aliasing. Content-deduped
  blocks; a Latin + box-drawing + CJK + emoji working set is **37 KB uploaded once at boot**.
  A miss is a *value*: it still occupies its advance so the layout stays right, and is
  appended to a miss list for the CPU to encode.
- `compute/glyphPipelineReference.js` — **the executable spec.** Each kernel written as one
  thread's body so the JS and the WGSL stay line-comparable. When they disagree, this is right
  until a test says otherwise.
- `compute/glyphPipelineKernels.js` — the TSL. **Has never executed.**

### The shape

Upload the file's UTF-8 **bytes**. Nothing else per load; the trie is a boot-time upload.
No string is built, no newline split happens, no line table exists.

```
dispatch 1  decodeAndResolve   bytes → codepoint → trie. Pure per-slot.
dispatch 2  layout             the backward walk (see below).
dispatch 3  paginateAndBounds  page remap on exact integer lanes; bounds reduce fused on.
```

Three per load, not per frame. Decode does **not** fuse into layout: re-decoding a predecessor
during the walk costs the decode plus two trie loads per step against ONE load to read a
pre-decoded `advance` lane — at window 128 + wrap 200 that's ~328 re-decodes per thread, more
memory traffic than the dispatch it saves.

Pagination stays its own dispatch because that's what it buys: switching
newspaper/column/z-page, or scrolling, re-runs **only** kernel 3 over positions that already
exist. `repaginate()` is that path. No decode, no walk, no reparse.

### Byte-indexed throughout

One slot per **byte**. Continuation bytes stay non-leaders and every later pass skips them.
That buys no compaction pass and no prefix sum — and it makes a slot index **identical to a
source byte offset**, so picking hits, tree-sitter ranges and the cursor all address one space
with no mapping table. Asserted against `TextDecoder` on real files.

### The walk, and why it's split

One dispatch, one thread, **two loops back to back** (not two passes — the word "phase" was
retired from the code for exactly this confusion):

- **loop 1, integer walk** → `row`, `col`. Bounded by the inherit. Integer adds are cheap, so
  walking far is survivable.
- **loop 2, advance sum** → `x`. Exists separately for one reason: it can't know how far to
  walk until loop 1 produces `col`. Bounded **unconditionally** by `wrapWidth`.

**Wrap is the cost bound, not a feature.** Without it a minified JSON blob is one line of
millions of glyphs, nothing severs the accumulation, and every thread that can't inherit walks
the whole file. Measured on a 40k single-line corpus: unwrapped x reaches 48006 world units in
one row; wrapped at 200 it caps at 238.8 across 201 rows.

### The rule that matters most

**Every discrete decision reads the exact integer lanes, never the float position.**

f32 addition isn't associative, so the racing walk is order-independent as *mathematics* but
not bit-for-bit. Harmless for placement. Fatal for a decision: `floor(y / pageHeight)` at a
page boundary flips a glyph a whole page on a one-ULP wobble. Measured — **119 slots** on the
torture corpus landed on different pages depending on dispatch order, before `row`/`col`
existed. That is the same instability the old CPU path carried `q0*3e-7 + 1e-6` to hide. An
integer row can't wobble.

If you add anything to this pipeline that branches on a position, key it off `S_ROW`/`S_COL`.

---

## Gates

All headless, all green, none need a GPU:

```
bun tools/glyph-pipeline.test.mjs        # 104 — trie, decode, walk, paginate, bounds
bun tools/backtrack-layout.test.mjs      #  43 — the walk's race, every dispatch order
bun tools/layout-mirror.test.mjs         # 126 — Layer 1 fold parity + extent
bun tools/layout-fuzz.test.mjs           # randomized; --seeds 2000 for a real sweep
```

What each actually proves:

- **glyph-pipeline** — trie resolution *and* correct missing-ness exhaustively over the BMP
  plus astral samples (aliasing would surface as a false hit); decode against `TextDecoder` on
  three real repo files plus a torture corpus of adjacent 1/2/3/4-byte sequences; the walk
  against a wrap-aware forward oracle at wrap 0/24/200 over 32 dispatch orders each, asserting
  `row`/`col` match **and** are bit-identical order-to-order; pagination's page assignment
  bit-exact; bounds equal to a naive walk and containing every quad.
- **backtrack-layout** — the walk is a deliberate data race. This dispatches it in forward,
  **reverse** (nothing ever ready, so every thread walks to zero) and random orders, and
  asserts every order converges. It exists because a real bug hid here.
- **layout-mirror / layout-fuzz** — Layer 1. The oracle is `evaluateFold`, not the builder;
  the builder no longer produces positions to compare against.

**GPU gate, unrun:** `tools/layout-kernel-check.mjs` (Layer 1, rebased but needs a device).
Layer 2 has no GPU harness yet — that's the next piece of work.

### If you add a wrap width, add two

`wrap=200` failed while `wrap=24` passed clean, because the coherence window (128) outran the
wrap width at 24 and the newline-inherit path never became the inherit point. A single wrap
width structurally cannot see that class of bug.

---

## Open questions that need hardware

Nobody can answer these in a headless container. They are the whole point of the first GPU run:

1. **Does TSL's `Loop`/`Break` express the walk?** It has a loop containing a nested search
   loop with breaks out of both. If not, `wgslFn` is the escape hatch.
2. **The coherence window.** Apple's empirical answer was ~128 — the distance at which a
   neighbour's write is reliably visible. Ours is unknown. Correctness holds at 0 (proven), so
   this is purely a visibility number, and it is a real risk: WGSL has no acquire/release, so a
   stale `rendered=0` is fail-safe but a stale position behind `rendered=1` is not.
3. **Real per-thread walk cost.** The CPU sim says ~window steps in forward order; only real
   scheduling tells.

The check is `readSlots()` against `runPipeline()` on the same bytes. Any mismatch is the
shader's bug, not the spec's.

---

## Explicitly not in scope, and why

- **Multiple files in one buffer / one field.** Would collapse the dispatch count from 3-per-
  file to 3-per-load, and `createGroup()`/`_groupTexture` already exist to support it
  (`ContentTreeLabels` spans a whole tree from one mesh today). Deliberately deferred: fields
  need to work well before they get batched.
- **Cluster-aware shaping.** `FontChain.shape` currently loops codepoints and calls the shaper
  on `String.fromCodePoint(cp)` — one character in isolation — then overrides the advance with
  a fixed cell. That is why complex scripts can't work. HarfBuzz already returns `cl` per
  glyph, so the fix is additive once slots stop being codepoints; the byte-indexed design
  already assumes they might.
- **The re-dispatch.** I had planned to run kernel 2 twice so stragglers inherit instead of
  walking far. Dropped: it's insurance against a pathology no measurement has shown. Add it if
  the numbers ask.
- **Scroll fast path.** Scroll still re-runs the whole load path. Under Layer 2 it becomes
  `repaginate()`; under Layer 1 it becomes `_resyncEngineLayout` plus a description rebuild.
  Either way it's a follow-up, not this branch.
