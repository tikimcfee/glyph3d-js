# Plan: Layer 2 wiring — PRECEDED by the load-regression investigation

**Phase 0 comes first.** Ivan's live session shows root loads degrading through the day:
openDir build stage 2.7s (15:08) → 3.2s (15:37) → 5.0–9.4s (16:54–16:56), same corpus,
plus THREE full restores in 20s at 16:56 (vite auto-reloads from the shared moving tree).
This work is designed to make loads faster; before Layer 2 wiring begins, we find and kill
the regression.

## Phase 0 — cold-reload restore performance: instrument, attribute, fix

**The repro (confirmed with Ivan): the 10s is a FRESH-RELOAD restore, not steady-state
openDir.** That reframes the physics. A cold page pays three compounding costs:
(a) **cold atlas** — the Slug atlas restarts at v1 and re-encodes the whole working set
mid-restore (the log shows v1→v6 grows per reload; one grow adds +402 glyphs of which ~378
encode as `.blank` — a second smell to identify);
(b) **the hot-swap multiplier** — every grow hot-swaps textures into EVERY registered field,
and the FieldLabel commit turned every nameplate into a field (the log shows 200→606 fields
swapped per grow, several grows per load);
(c) **restore stacking** — the shared tree's vite reloads re-fired his page 3 times in 20s
at 16:56, stacking 5.5s restores back to back.

**The numbers (relay log store, 2026-08-04, root openDir, 480 files):**
- 15:08 (post-sync-path, pre-branch): build 2734ms, settle 420ms, total ~3.1s
- 15:37 (branch + FieldLabel landed): build 2.7–3.2s, settle ~700ms, totals 3.5–5.6s
- 16:54–16:56 (all of today's commits + reload storms): build 3.1–9.4s, totals 5.2–9.7s
- `[frames]` long-task lines: repeated 80–150ms main-thread blocks "after fetch" during loads
- settleMs (my sync-path fan-out): 0.4–1.2s of the build stage — real, but not the villain;
  the old sync path's own estimate (480 × 4-5ms ≈ 2.2s) says the fan-out is roughly a wash.

**Suspects, ranked:** (1) atlas-grow × hot-swap-all-fields during restore (FieldLabel made
the field count balloon — the multiplier is structural); (2) cold-atlas re-encode per reload,
plus the blank storm (378 of 402 glyphs in one grow encode as .blank — who requests them?);
(3) restore stacking on reload — no dedup: a reload mid-restore starts another full restore;
(4) the fan-out settle shape (~1s).

**Instrumentation to add (small, permanent, loadTrace-native):**
1. `LiveSlugAtlas` grow log gains: duration ms, fields hot-swapped, blank count, active-load
   attribution (the `[frames]` precedent — installFrameWatch already attributes long tasks).
2. loadTrace marks inside the build stage: `seat`, `pour` (count + ms), `settle`, `dispatch`
   (kernel count + ms), `atlas` (grows during this load + total ms). One line per load,
   queryable via `log.search load` / `load.stats`.
3. Restore-level marks: per-source restore begin/end, atlas phase inside restore, and a
   restore-storm detector (log when a restore starts while another is in flight).
4. A repeatable profiler: `tools/load-profile.mjs` — fresh headless page + relay, session
   restore of a target dir, prints the full staged trace as JSON. COLD page each run.

**Attribution runs** (profiler, cold page, local relay):
- A: current tree. B: pre-FieldLabel (second worktree, VITE_PORT 5174 — vite.config supports
  it). C: pre-sync-path (`0ad399f~1`) if B is clean. Answer: which commit moved cold restore
  from ~3s to 5–10s, and whether the atlas storm is the multiplier.

**Fixes by indictment (expected shapes):**
- Hot-swap: grow freely during bulk loads, swap ONCE at settle (not per grow per field).
- Blank storm: find the requester; uncoverable codepoints resolve blank WITHOUT encoding or
  re-entering miss flows.
- Restore stacking: a restore request while one is in flight coalesces (latest-wins), never
  queues a second full restore.
- Fan-out settle: tune only if the numbers still call for it after the above.

**Exit criterion:** cold restore of the repo root measurably back under its pre-today time
(~3s by the 15:08 number), profiler-verified, three consecutive runs. THEN Layer 2 M1 starts.

## Phase 1+ — the Layer 2 wiring plan (kept as written below, unchanged)

---

# Plan: wire Layer 2 in — the byte-in GPU pipeline becomes the live CodeGrid engine

**The goal (unchanged since the start):** the GPU pipeline IS the layout engine. A load is
`TextEncoder` → `setFile(bytes)` → three dispatches → positions + bounds on GPU. No string
split, no line table, no worker shaping round-trip, no CPU layout walk on the load path.

**Where we actually are (no spin):** the pipeline is proven on hardware
(tools/glyph-pipeline-check.mjs, 21/21 lanes) but wired to nothing. The live app runs Layer 1:
builder tables → GlyphLayoutKernel → closed-form extent. This plan is the wiring.

**Key facts from the integration survey (all verified against source):**
- The render seam survives: `GlyphField` needs per-instance `instancePosition` (stride-4
  storage attr), `instanceSize`, `instanceGlyphId`, `instanceColor`, `instanceGroupId`. The
  stride-11 slots buffer CANNOT alias the vec4 position attribute — so kernels write the
  field's attributes directly as extra kernel outputs (kernel 1 → size+glyphId attrs, kernel
  3 → position attr). GlyphField is otherwise UNCHANGED. Non-leader byte slots get size (0,0)
  → invisible + unpickable by the established zero-area mechanism (glyphVertex.js:120).
- The trie's glyphId IS the shader's glyph id (glyph-map texture slot, FontChain global).
  Real trie = build from `atlas._shapeCache` keys with the builder's exact font-units→world
  formula, after `ensureCodepoints`; misses flow readMisses → cache.lookup →
  ensureGlyphsEncoded → trie patch/rebuild → re-run.
- Two parity gaps the pipeline must close before pixels match: **zWrapStep** (wrapped
  segments step in z; the default long-column preset uses it) and **scroll** (kernel 3 has no
  scrollRows param). Plus `pageStrideX` wants the measured max row extent (from the mirror).
- Every CodeGrid consumer speaks (line, col) codepoint-space and can KEEP speaking it:
  LayoutDescription's API survives; its internals become byte-backed (newline byte-offset
  index + codepoint→byte walk + mirror slot read). Picking slot == byte offset is a BETTER
  fit for tree-sitter (byte ranges) — highlights become contiguous byte-range paints.
- The CPU mirror = the reference pipeline itself (per-slot self-completing queries). It is
  the oracle, not the authority — the three-evaluator law holds.
- Deferred explicitly: arrangers (Structure/Strata — need displacement re-index + hide
  channel; opt-in views, will throw loudly), groups (CodeGrid never uses them), windowed
  mode (superseded by conveyor), DiffController's addText bypass, multi-file batching,
  per-item scale (already scale-1-only under Layer 1).

## M1 — close the pipeline's parity gaps (core only, nothing live yet)

Files: `compute/glyphPipelineReference.js` (first — spec-is-right law), then
`compute/glyphPipelineKernels.js`, then `tools/glyph-pipeline-check.mjs` lanes.

1. **zWrapStep**: kernel 2 learns `z = origin.z − seg·zWrapStep` where seg = the glyph's wrap
   segment (floor(col/wrap) when wrapping; 0 otherwise). Reference `layout()` first, TSL
   second. New harness lane asserting z-step on wrapped corpora vs the live fold's value
   (0.15 × charHeight).
2. **scrollRows uniform in kernel 3**: `screenRow = row − scrollRows` before the page gate
   and y reconstruction; bounds atomics run on final positions so they stay honest. Reference
   `paginate()` takes it too. New harness lane: scrolled newspaper vs reference.
3. **totalRows lane**: bounds buffer grows 6 → 8 cells (add `atomicMax` of row+1, and of
   baseX for maxRowExtent) — `getMaxScroll` and `pageStrideX` read these.
4. **Real-atlas trie builder** (`compute/liveTrie.js` or a method on the pipeline): from
   `atlas._shapeCache` + `atlas._shaper.upem` + `computeCellMetrics`, the builder's exact
   `ax/upem × worldScale × pixelHeight` formula, constant charHeight; known-uncoverable
   codepoints (g===0) map blank-resolved (no miss spam); pre-reserved block capacity so
   growth is append + blockIndex patch (no kernels rebuild).
5. **Miss flow**: after run(), `readMisses()` → `cache.lookup` →
   `LiveSlugAtlas.ensureGlyphsEncoded` → trie patch → re-run affected dispatches. Emoji draw
   rides the existing ensure path (Canvas2D, main-thread).
6. Gate: harness gains z-wrap/scroll/real-trie lanes; all green on hardware, 3 runs.

## M2 — the render bridge (pipeline writes the field's attributes)

Files: `compute/glyphPipelineKernels.js`, `GlyphField.js` (minimal), new
`compute/GlyphFieldPipeline.js` (the adapter that replaces GlyphLayoutCompute for grids).

1. Kernel 1 gains two outputs: writes `instanceSize` (advance, height; (0,0) for
   non-leaders) and `instanceGlyphId` (0 for non-leaders) into the field's attributes
   (external-attribute mode, the GlyphLayoutKernel precedent).
2. Kernel 3 gains one output: final x/y/z → the field's stride-4 `instancePosition` storage
   attribute (`_gpuPosAttr`, GlyphField.js:1707-1716). Slots buffer remains the pipeline's
   own truth; the attribute is the render projection.
3. `instanceColor` = default color fill at alloc (CPU, once per resize); `instanceGroupId`
   zeros; highlight texture sized to byteLength.
4. The adapter owns: capacity (byteLength), `setFile/run/repaginate`, miss flow, extent
   (mirror-derived synchronously — see M3; GPU readBounds for verify only), and the
   displacement-free `setPage` surface.
5. Verify: a standalone harness page/itest renders a byte-indexed field and pixel-compares
   against a Layer 1 grid of the same file (screenshot diff), plus position diff
   (readPositions vs mirror) at byteLength scale.

## M3 — CodeGrid integration (the load path goes byte-in)

Files: `CodeGrid.js`, `core/LayoutDescription.js` (internals), `core/` new byte-index helper.

1. **Load**: `_beginLoad` → TextEncoder bytes (build the codepoint→byte prefix table in the
   same pass — the colorizer/caret mapping) → adapter `setFile(bytes, params)` → `run()`.
   The worker buildBatchBuffers path for CodeGrid content is bypassed (worker survives for
   nothing on this path; GlyphWorker/WorkerBridge stay for now — see M5).
2. **Newline byte-offset index** (one O(bytes) scan, Int32Array) owned by CodeGrid: backs
   lineCount, caret clamp, (line,col)→byte-offset.
3. **LayoutDescription internals** byte-backed behind the UNCHANGED API
   (`positionAt(line,col)`, `slotForChar`, `charForSlot`): (line,col) → byte offset via the
   index + prefix table → mirror slot read (reference pipeline, lazily per slot —
   self-completing walks; decode all at load, layout on demand).
4. **Extent**: synchronous from the mirror (closed over mirror slots — keeps `_updateBackground`
   and contain-fit synchronous as today); `readBounds()` used by `layout.verify` only.
5. **Colors**: `instanceColor` default fill + colorizer paints contiguous byte ranges
   (UTF-16 capture → byte via the prefix table; `setGlyphColorRange` already contiguous).
   `highlightRange` same mapping.
6. **Filename**: second pipeline instance (one line), own origin offset −1.5 rows, own color.
7. **Caret/picking**: pick slot == byte offset → `charForSlot` via index; caret world pos
   from mirror slot; decorations re-apply as today.
8. **registerArranger throws** "arrangers not yet on the byte pipeline" — loud, not silent.
9. Verify: ALL existing itests (click-caret! coloring, semantic, panel) + layout.verify
   (GPU slots vs mirror) + the full gate suite. Pixels reviewed on newspaper/z-pages/scroll.

## M4 — edit + scroll live

1. **Edit**: splice in `this.lines` (codepoint façade survives) → re-encode → setFile →
   run(). `_relayoutPreservingCursor` keeps its mutex; the worker/deferred-batch machinery
   (`_pendingAdds`, `_flush` build path) is bypassed for content edits.
2. **Scroll**: `setScrollOffset` → adapter.setPage({scrollRows}) + `repaginate()` — kernel 3
   only, the fast path the whole architecture was built for. `getMaxScroll` from the
   totalRows lane (readback, cached per dispatch).
3. Verify: scroll smoothness on a 400k-glyph file (before/after timings), caret/highlight
   alignment after edit+scroll interleaves, itests.

## M5 — retirement decisions (with Ivan, after bake)

- GlyphLayoutKernel / GlyphLayoutCompute / evaluateFold / foldGeometry: dormant after M3.
  Delete or keep-as-oracle? (The mirror/fuzz/kernel-check gates currently hinge on them.)
- WorkerBridge/GlyphWorker build path: nothing routes to it for grids after M3/M4 — retire
  or keep for… nothing? Terminals/labels never used it.
- Arrangers on the byte pipeline (displacement re-index is byte-native; hide needs a
  visibility lane).
- Multi-file batching (one buffer, N files — the Metal DoManyStream shape).

## Standing rules for every milestone

- Reference first, TSL second, harness lane third — the spec-is-right law.
- "Live" means: the app on :5173 does it, verified with layout.verify + itests + eyes on
  pixels. Harness-only is NOT live and I will not describe it as such.
- Gates green before each milestone closes: glyph-pipeline, backtrack, glyph-pipeline-check
  (hardware), mirror, fuzz, device-loss, node sweep, itests, vite build.
- The boot stamp (91de57b) tells us which code the page is running; use it.
