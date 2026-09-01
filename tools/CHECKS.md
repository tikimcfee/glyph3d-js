# Dev checks & drive-loop tools

Repeatable verification tools. The rule: **when a debug probe proves useful, it
graduates into a saved tool here** rather than being retyped next time. They don't
need rigorous shape — just be runnable and documented. Build the set up over time.

All run under Bun (the repo runtime). The dev loop must be up for browser tools:
`tools/dev.sh` (Vite :5173 + relay :8080), `tools/dev.sh vite` to restart + clear cache
after editing core, `make dev-status` to check.

## What is NOT covered

A gate list reads as a coverage claim, so the gaps belong beside it — otherwise clean
numbers imply the coverage nobody wrote.

- **THREE fixtures ingest repo source files that we edit, so they drift on regeneration.**
  `real-kernels.pipe.bin` reads `glyphPipelineKernels.js`; `bake-repo-file.bake.bin` and
  `bake-repo-small-k.bake.bin` read `glyphPipelineScan.js`. Every change to those files
  moves the corpus, so a regeneration diff can never distinguish "the pipeline's output
  changed" from "the input file changed" without someone reasoning it out by hand — which
  is a check that depends on remembering to perform it. Same family as the vendoring rule
  already paid for (an untracked input makes a fixture a snapshot of an accident): here
  the input is tracked but MUTABLE, which fails the same way more slowly. The fix is to
  vendor a frozen slice, as `minified-sample.js` already is. **Decision pending.**
- **No regeneration check runs `gen-bake.mjs`.** Recorded once before and not closed, and
  it recurred: 3da6542 removed `trieLaneValue`, `gen.mjs` was updated, `gen-bake.mjs` was
  not, and it broke outright — invisible to all fifteen engine suites, because they read
  COMMITTED fixtures and a dead generator changes nothing they can see. Caught by stamping
  mtimes to 2020 before regenerating. Until some check runs all three generators, that
  stamp is the only instrument that sees this class.
- **The `glyph` pick channel past 2²⁴.** `pick-id-gpu-check` drives the `flat` channel,
  where the ID *is* the uniform. The glyph channel adds `baseId.add(instanceIndex)` on top
  of that same uniform — checked at source level, never rendered at a large base.
- **Switching grid-layout MODES on a live scene is untested.** `layout.test.mjs` covers
  the layout primitives (flowBoxes / squareWrap); `layout-kernel-check` computes each
  mode standalone and compares against the CPU fold. Neither exercises the TRANSITION —
  column → newspaper → z-pages on a scene that already has state. Observed 2026-08-30:
  auto-layout glitches on mode switch that resolve after further UI interaction, i.e.
  shell/panel state rather than layout math. Not reproduced in a harness, so it is
  recorded as a gap rather than a bug.
- **`cli/fs_test.go`'s sandbox tests INVERT if the checkout lives under a temp dir.**
  Found by render-bender, 2026-08-31, verified here. `outsideDir(t)` builds its directory
  with `os.MkdirTemp(".", ...)` — relative to the package dir, so *inside the checkout* —
  while `NewFSHandler`'s reach set always contains `os.TempDir()`, `/tmp` and `/var/tmp`
  (`cli/fs.go:482`, so agent scratch stays reachable). Put the checkout under a temp dir
  and the "outside" directory falls inside the always-on reach hatch, so it resolves
  BEFORE `addRoot` and four tests fail on a premise that is no longer true —
  `TestHandleAddRoot_MakesResolvable` and friends, all reporting "outside dir should not
  resolve before addRoot". **Nothing is broken when this happens.** It is a red that means
  something other than what it says, and it cost an hour before a control run at a clean
  tip failed the same four. If CI or a scratch worktree ever lands in `$TMPDIR`, read this
  entry before believing the failure.
- **The far regen's LOAD-path cost was never measured either** (my claim, 1d2359e). I
  reported that deleting the far tier removed a 4MB `readFarPacked` GPU→CPU readback plus
  a texture blit per macrotask window during colorized loading, since every
  `setGlyphColorRange` / `setGlyphPaletteRange` called `markFarDirty`. That is a correct
  reading of the deleted code and an UNMEASURED claim about its cost. render-bender
  correctly refused to let it be credited against Ivan's live symptom — that symptom is
  camera motion, and this is the load path; a fix credited to the wrong symptom is how the
  stutter survives being "fixed". Ivan has since confirmed he sees the stutter on both
  :5173 and :8080, so it is not a dev-mode artifact either. The relay log store holds 48
  `[load]` records but they are ad-hoc traces across different corpora, NOT a controlled
  differential, so they cannot settle it. Whoever measures it wants 15452e3 vs 1d2359e on
  one corpus via `load.stats` / `bun tools/loadstorm-check.mjs`. Until then it stays a
  reading of code, not a number. **Still open after the perf pass** — `frame-tail`'s
  negative result for uploads (65B/frame against a ~70B baseline) is a STILL-FRAME
  measurement and says nothing about the load path, which is where this claim lives. Do
  not let that number retire this one; an adjacent-looking number is exactly how an
  unmeasured claim gets quietly settled.
- **RESOLVED — the far-tier deletion's fragment cost, measured.** It was recorded here as
  an unmeasured debt: I deleted the three-tier LOD (1d2359e) for failing its VISUAL
  purpose and never measured its COST, which render-bender correctly called out as two
  separable claims. They then measured it, and the entry is kept as a resolution rather
  than deleted because the number is the point: **the deleted three-tier LOD is ~2x
  throughput uncapped at 300k glyphs, ~5% at real scale, and capped, both builds hold a
  flat 60.** So the concern was real, bounded, and does not matter in practice — and the
  three-line footprint early-out that was on the table is NOT worth writing. The lever at
  real scale turned out to be elsewhere entirely: frame time is linear in instances DRAWN
  (~4.11ms/million), so the fix was drawing fewer instances per file at distance
  (`0131cd8`, overview 80.4ms → 16.7ms), not making each fragment cheaper.
- **The headless layout suites cannot see the layout KERNEL at all.** Measured 2026-08-30,
  not inferred: a real defect in `GlyphLayoutKernel`'s item mapping that puts 96.56% of
  slots beyond eps on the GPU leaves `layout`, `layout-fuzz`, `layout-mirror` and
  `scan-layout` **all green**. They exercise the layout primitives and the CPU fold; only
  `layout-kernel-check` (GPU) executes the kernel. The same holds for the byte pipeline —
  the headless suites drive the reference oracle, and `glyph-pipeline-check` is the only
  thing that runs the TSL. Treat a headless green as evidence about the SPEC, never about
  a kernel.
- **No arena has been staged past 16MB on GPU.** `arena-capacity.test.mjs` covers the
  seams headlessly; the ceiling (`ARENA_MAX_BYTES`, 42.7MB) is buildable in principle and
  no test builds one.

Add to this list when you find a gap, and delete from it when you close one — an entry
that outlives its gap is the same defect as a deviation that outlives its debt.

## Browser drive-loop

- **`smoke.mjs`** — boot the app in a real (WebGPU) browser, capture every console
  error + uncaught exception, optionally drive command-bus verbs and screenshot, exit
  non-zero on real errors. The "does the UI boot and run" gate; catches render-crash
  bugs (an undefined variable in a component) before they reach the browser by hand.
  **Pass `--relay 8080` for anything that touches files or terminals.** Without it the
  page derives the relay from its own host (:5173, where nothing is listening) and every
  file verb answers `No repository loaded` — which reads like an app bug and is not one.
  A boot-only run needs no relay.
  ```
  bun tools/smoke.mjs                                   # headless: report boot errors
  bun tools/smoke.mjs --headed --shot /tmp/app.png      # real GPU render + screenshot
  bun tools/smoke.mjs --headed --relay 8080 \
      --cmd 'file.open path/to/file.js' --shot /tmp/x.png     # with the live tree
  ```
  A PASS here means "booted without errors", NOT "drew anything" — the crash that put
  grids on screen with no glyphs in them still exits 0 if it happens inside a draw. LOOK
  at the screenshot.
  Drives via `window.__glyphClient.router.execute(...)` — same command bus as the CLI.
  Use `--headed` on a GPU box when the screenshot must show real pixels; headless still
  catches all JS errors (GPU-init noise is reported but not counted as failure).

- **`loadcurve.mjs`** — survival probe for bulk loads at scale: samples JS heap / grid
  count every 500ms while a `file.openDir` runs, detects renderer crashes, measures
  post-load FPS. The companion to `profile-bulkload.mjs` (CPU time) — this answers
  "does it survive, and what's resident afterward". Point it at a relay serving the
  BUILT app (`glyph3d-cli serve --local --port 8099 <project>`) — a Vite restart
  mid-run reloads the page, and dev mode retains ~17x more heap than the build.
  A gap in the sample stream means the main thread was blocked for that span.
  ```
  bun tools/loadcurve.mjs --dir static/app/views --relay 8099
  ```

- **`glance.mjs`** — one-shot screenshot of the **LIVE** display (the window a human is
  watching), not a fresh browser. Dials the running relay over WS, optionally issues bus
  verb(s), then sends the bus-native `screenshot` verb and writes the returned PNG. This
  is how a headless agent (a plain Bash tool) closes its own pixel loop: it can SEE its
  WebGPU/dock/layout work instead of verifying by math + asking the human. One-shot by
  design (connect → command(s) → capture → exit) so the harness can't reap it mid-run.
  ```
  bun tools/glance.mjs --shot /tmp/glance.png                    # capture current scene
  bun tools/glance.mjs --cmd 'dock.list' --shot /tmp/glance.png  # issue a verb, then capture
  bun tools/glance.mjs --cmd 'camera.frame all' --wait 500 --shot /tmp/x.png
  ```
  Contrast `smoke.mjs`, which launches its OWN headless browser (an empty display) — use
  `glance` when you need to see what's actually on screen right now.

- **`capture.mjs`** — cinematic/media capture (per-frame CDP screenshots → ffmpeg loop).
- **`cdp-shot.mjs`** + **`web-preview.sh`** — attach to an already-running browser via
  CDP and grab a PNG (works headed on a busy desktop). See `PREVIEW.md`.

- **`arena-realloc-check.mjs`** — the arena-realloc render gate: kernels realloc (growth /
  trie rebuild) must not strand render bind groups on the destroyed `GlyphSlots` buffer
  (three's bind-group cache is texture-keyed; the `rebindByteSlots` seam in
  `core/glyphVertex.js` re-inits the byte materials). Lanes watched via
  `device.uncapturederror`, then `verifyItem` (exact) + a pixel non-blank assert.
  Client-only (fake in-page provider, no relay).
  ```
  bun tools/arena-realloc-check.mjs [--url http://localhost:5273/]
  ```
  (`--url` on this and `glyph-pipeline-check.mjs` points a gate at a worktree's own Vite.)

- **`storm-probe.mjs`** — N-file synthetic storm with full forensics: real device limits,
  per-second heartbeat (arena live/capacity/items, mega capacity/views, GPU error count +
  first sample, JS heap), page-crash detection, notable console tail. THE tool for
  "loads N files then wedges" — it caught the highlight-texture dimension storm at
  arena > 8MB and the corrupt half-realloc at the f32-ordinal wall (2^24 bytes), both
  invisible to the fixed-size gates. Client-only (fake provider, no relay).
  ```
  bun tools/storm-probe.mjs 1000
  ```

- **`arena-compaction-check.mjs`** — the free-list gate: a 150×120KB adopt-restage
  storm (18MB staged — past the f32-ordinal wall that killed it pre-compaction) must
  complete with the high-water mark pinned at ~2× the window, plus size-churn
  split/coalesce lanes, an exact tail-recede assert, `verifyItem` teeth over recycled
  ranges, resolveSlot coherence, and 0 GPU errors. Client-only (fake provider).
  ```
  bun tools/arena-compaction-check.mjs [--url http://localhost:5273/]
  ```

- **`pick-id-gpu-check.mjs`** — the pick-ID hardware gate: an ID past 2²⁴ must survive
  the RGBA8 round trip and resolve to the object it was aimed at. Drives the real
  `PickingSystem` on the app's live WebGPU renderer, reserving ID space through the real
  first-fit allocator (never by writing `pickStartId` by hand, which would skip both the
  allocator and its guard), then rendering a channel pass and decoding the pixel.
  IDs are chosen to break a wrong carrier: 2²⁴+1 (collapses in f32), `ARENA_MAX_BYTES`
  (44,739,242 → 44,739,240), 2³¹ (a signed `shiftRight` sign-extends into ALPHA), and
  near 2³². `tools/pick-identity.test.mjs` covers the arithmetic and the source-level
  carriers headlessly; only this file can say the SHADER carries them.
  Mutation-verified: restoring `uniform(0)` (an f32 carrier) fails 11 teeth, and the
  failures read `token="reservation"` — the pick resolving to the WRONG OBJECT, which is
  the real symptom and the reason a warning was never enough.
  ```
  bun tools/pick-id-gpu-check.mjs
  ```

## Performance armory

The measurement stack, cheapest first. The standing law: **pixels and wire-level
measurement over code reasoning** — a change gate that "reads correct" can still be
re-uploading megabytes per frame (it did, for months). Run these before AND after a
perf change; the numbers are the review.

**The adapter law: a number from a software adapter is not a measurement.** Every
tool here calls `assertRealGpu` (`itest/driver.mjs`) after boot and refuses to
report if the page landed on SwiftShader — the failure is otherwise silent, because
the page boots, the scene renders, and every probe reads healthy. Each run prints
its adapter (`[gpu] apple/metal-3`); if you don't see that line, you're reading
something else's output. `GLYPH_ALLOW_SOFTWARE=1` overrides, loudly, for a
GPU-less CI box checking that a tool still runs at all.

**The clean-boot law: measurement pages carry no session.** Every tool here opens
with `?session=off` — no restore, no autosave (`isEphemeralSession` in
`app/client/SessionStore.js`). Both halves are load-bearing:

- **Restore poisons the baseline.** The saved roster lives in `fieldSources`, and
  any run that opens a directory re-arms it on autosave — so clearing the field
  does not make the NEXT page boot clean. A load test then measures its corpus on
  top of a restored one, and a clean boot and a doubled boot are indistinguishable
  from outside. Measured here: an armed session restores 219 grids before a single
  verb runs; the same URL with `?session=off` boots 0. That doubling is what drove
  a whole-repo load past the f32-ordinal wall (2²⁴ B) into ~3GB of heap and locked
  the browser.
- **Autosave destroys the human's workspace.** A headless run that opens 500 files
  otherwise writes that roster over the session a person left behind.

If you drive a page by hand for measurement, add `?session=off` yourself — and if a
number looks impossible, check the grid count at boot BEFORE blaming the change.

Corollary — **headless is platform-dependent, and macOS headless is software.**
Linux headless reaches the real GPU *because of* the ANGLE/Vulkan flags in
`webgpuArgs()`; macOS has no equivalent (the headless shell has no Metal surface)
and ANGLE falls to `--use-angle=swiftshader-webgl`. Measured on an M-series box,
same build minutes apart: headless `google/swiftshader` at **~1 rAF/s**, headed
`apple/metal-3` at **61**. So measurement tools launch through
`launchGpuBrowser()`, which resolves headed-vs-headless **by platform** — you do
not pass a flag, and a tool author cannot forget the rule. Correctness gates
(kernel-vs-oracle, does-it-boot) keep using `launchBrowser()` and stay headless
everywhere: they assert behavior, not speed, and SwiftShader is fine for that.

- **`gpu-traffic.mjs`** — per-frame GPU upload attribution: wraps
  `device.queue.writeBuffer`/`writeTexture`, counts display frames, reports a
  per-label bytes/frame histogram plus a greppable verdict line. The law it enforces:
  **a still scene uploads ~0 bytes/frame** (current baseline: ~70B/frame — the
  camera/time binding uniforms). Found the group-table 1.28MB/frame silent re-upload
  and the minimap's 652KB/frame.
  ```
  bun tools/gpu-traffic.mjs                                # boot, settle, sample idle
  bun tools/gpu-traffic.mjs --cmd 'file.openDir app' --seconds 6
  bun tools/gpu-traffic.mjs --stacks GlyphGroups           # who WRITES a label (stack histogram)
  ```
  Deeper probes when the histogram isn't enough (run via `smoke.mjs --eval` or devtools):
  - who MARKS an attribute dirty → `Object.defineProperty(attr, 'needsUpdate', { set(v){ console.log(new Error().stack); } })`
  - which MESH owns an unlabeled attr → wrap `renderer._geometries.updateForRender(renderObject)` and log `renderObject.object.name`
  - big uniform bindings → wrap `renderer.backend.updateBinding`
  - which SCENES render each frame → wrap `renderer.render` and collect `scene.name` (the minimap lives in a second scene)

- **`frame-anatomy.mjs`** — attribute a steady-state frame: FPS percentiles, per-render-
  call triangle/draw-call deltas, scene/mesh census, mega-field instance census, and the
  CPU/GPU split (the floor has a name). Found the transparent+DoubleSide double pass
  (62M→31M tris) and the minimap's ~3000-draw proxy pool.
  ```
  bun tools/frame-anatomy.mjs                    # against :5173 + scratch relay :8099
  ANATOMY_URL=http://localhost:5174/ bun tools/frame-anatomy.mjs
  ```

  **THREE TRAPS IN THIS TOOL, all of which produced confident wrong answers on
  2026-08-30. Read before quoting a number from it.**

  - **`renderMsPerFrame` is ONE PASS, not a frame.** It accumulates
    `gl.info.render.timestamp` once per 250ms poll (~12 samples over 3s) and divides by
    the FRAME count (thousands). At 250-500fps with 2 renders/frame that is 500-1000
    passes per window, and the query pool overflows (this file's own comment says so).
    It reported **0.04ms while the GPU was doing real work**, and that number was used —
    by two people, independently — to rule out the fragment shader. Do not quote it as a
    per-frame GPU cost. Fix it or delete it; a number that reads healthy while measuring
    almost nothing is worse than no number.

  - **`ANATOMY_UNCAPPED=1` perturbs the whole machine, and changes the REGIME.**
    `--disable-gpu-vsync --disable-frame-rate-limit` makes the page render flat out and
    pin the GPU. On unified memory that starves the window server: the human at the desk
    sees their desktop stutter, and may reasonably report it as an app bug (that is
    exactly what happened). It also measures THROUGHPUT — how fast the loop spins against
    a saturated queue — not whether a frame fits in 16.7ms. A profile taken there is full
    of `submit` / `getCurrentTexture`, which is the signature of the saturated queue, not
    of the app. Use it only in short bursts, only when HEADROOM is the question, and say
    so out loud before running it beside a human.

  - **Under vsync, `p50` is worthless.** It is 16.7ms by construction whether there is 4x
    headroom or none. Measured capped, two builds with a real 2x GPU-cost difference both
    reported a flat 60fps and identical p50. **Stutter lives in the tail**: report p95/p99
    and the COUNT of frames past 16.7ms, or the check cannot see the thing it exists for.

- **A camera verb that silently does not take.** `camera.focus <n>` no-opped on one run
  of a near/far comparison with no error; only a `nearestDist` column logged beside the
  timing caught it — the row read as a clean NEAR result at the FAR distance. **Log the
  scene state you INTEND next to every number you measure**, or a mis-set-up run is
  indistinguishable from a finding.

- **`frame-tail.mjs`** — **DOES IT HOLD 60?** The capped counterpart to `frame-anatomy`.
  Reports p50/p95/p99/max, the COUNT of frames past 16.7ms, instances actually DRAWN, and
  ms-per-million. Capped by construction — there is deliberately no uncapped flag to reach
  for. Found the overview frame cost on 2026-08-30 after a day of instruments that could
  not: `frame-anatomy` only measures a STILL frame, and uncapped only measures throughput.
  ```
  bun tools/frame-tail.mjs --url http://localhost:5174/ --dir . --label mybranch
  ```
  **The law it establishes:** overview frame time is LINEAR in instances actually drawn,
  at **~4.11ms per million** — so the 60fps budget is **~4.0M drawn instances**. That is
  the number a render change should be argued against.

  **`drawn` comes from the INDIRECT buffer, not `geometry.instanceCount`.** The mega field
  draws indirect (`MegaGlyphField._cullRanges`), so `instanceCount` is ignored at
  draw-encode time — it reads 19.5M at every pose while the real drawn count swings 10x
  between near and overview. An experiment that sets `instanceCount` changes a number the
  draw never reads and returns a confident null result; that happened here.

  **What came back NEGATIVE**, so nobody re-runs them: fragment/LOD shading cost, the
  vertex alpha-cull (it degenerates clipPos AFTER the vertex shader has already run, so
  the work is spent), draw-call count (inversely correlated), JS heap (7.5GB, but GC never
  appears in the profile), and per-frame uploads/dispatches (65B/frame, zero dispatches).
  With every glyph culled the main thread is **84% idle** — the cost is GPU-side per
  instance, and the only lever is drawing FEWER instances.

- **`loadstorm-check.mjs`** — the LOAD STORM invariant gate: a launch-shaped burst of
  sequential `file.openDir`s must hold the batching laws (one relayout per bulk load,
  coalesced registry notification). `STORM_RELAY=<port>` to point it elsewhere —
  NEVER the live display's relay (autosave).
  ```
  bun tools/loadstorm-check.mjs                  # relay :8099, the scratch fixture
  ```

- **`load-profile.mjs`** / **`profile-bulkload.mjs`** — CDP sampling profile of a bulk
  load, aggregated self-time by function and module. `load-profile` is the whole-repo
  one-shot; `profile-bulkload` takes `--relay/--dir/--top/--out`. Pair with the app's
  own staged trace: every load prints `[load]` stage lines + `[frames]` long-task
  attribution into the relay log store — `./glyph3d-cli load.stats` aggregates them.
  ```
  bun tools/load-profile.mjs                     # STORM_DIR / STORM_RELAY to redirect
  bun tools/profile-bulkload.mjs --relay 8099 --dir packages --top 30
  ```

- **`perf-hover.mjs`** — CPU-profile the hover/picking path: synthetic pointer sweep
  across loaded grids, reports hot functions + worst long task.
- **`perf-attach.mjs`** — attach to the RUNNING browser (page-level CDP socket) and
  profile a hover window on the LIVE display — the exact lagging scene, not a repro.
- **`prof-tree.mjs`** — summarize any `.cpuprofile` by CALL TREE (total time rolled up,
  heaviest root→leaf spines): `bun tools/prof-tree.mjs out.cpuprofile --depth 4`.
- **`trace-capture.mjs`** — full Chrome trace (CPU stacks + GPU process + the app's
  `performance.measure` stage marks) around any bus command; open the artifact in
  DevTools Performance or ui.perfetto.dev.
  ```
  bun tools/trace-capture.mjs --cmd 'file.openDir fake' --synthetic 450
  ```

## Integration tests

As panels and startup push command-bus verbs and mutate state, that's headless-browser
integration-test territory: drive verbs, then assert on the resulting state/buffers.

- **`itest.mjs`** — runs every `tools/itests/*.itest.mjs` against the live app (one fresh
  page per test), reports pass/fail, exits non-zero on failure.
  ```
  bun tools/itest.mjs                 # headless
  bun tools/itest.mjs --headed        # real WebGPU (needed for render-dependent asserts)
  bun tools/itest.mjs coloring        # filter by name
  ```
- **`itest/driver.mjs`** — shared browser driver (also backs `smoke.mjs`): `launchBrowser`,
  `openApp` (booted, error-capturing; `.cmd` / `.evalPage` / `.shot` / `.waitFor` /
  `.booted` / `.errors`), and `makeAssert` (`ok` / `equal` / `atLeast` / `noErrors`).
- A test default-exports `async ({ app, assert, url }) => { ... }`. Assert via the command
  bus + `evalPage` (read state/buffers back). Seeds: `boot` (clean init, no errors — the
  render-crash guard) and `coloring` (tree-sitter writes distinct theme colors into
  `instanceColor`, data-level). Add one per panel/flow as the UI lands.

Note: tests that `repo.load` reach GitHub (network). A relay-served local project avoids
that — prefer it for deterministic CI once wired.

- **`layout-kernel-check.mjs`** — per-slot equivalence gate for the GPU layout kernel
  (`compute/GlyphLayoutKernel.js`) against the CPU builder. Boots the app **client-only**, runs
  the REAL `buildBatchBuffers` with the LIVE atlas (metrics via `computeCellMetrics` — no
  hardcoded character dimensions), runs the kernel on a **second, offscreen WebGPURenderer** so
  the live scene's renderer is untouched, and diffs every slot: max |Δ| per component, count
  beyond epsilon, and the first 5 mismatches with codepoint/line/col.
  Five folds, all run by default: `flat` · `column` (wrapWidth 200) · `wrap4` (wrapWidth 4, the
  spec's Fixture A shape) · `newspaper` (pagination fanning in x) · `z-pages` (pages receding in z).
  ```
  bun tools/layout-kernel-check.mjs                      # all five folds, torture text
  bun tools/layout-kernel-check.mjs --mode newspaper --ascii
  bun tools/layout-kernel-check.mjs --text-file <path> --wrap-width 40 --mode column
  bun tools/layout-kernel-check.mjs --selftest           # prove the HARNESS with no kernel
  ```
  The kernel gets `configure({ slotCount, lineTable, lineStartRow, advances, params })` —
  `lineTable` from `itemMeta[0].lineSlotOffsets`, `advances` the per-slot `sizes[2i]`,
  `lineStartRow` the exclusive scan the check computes itself (and then checks against the CPU
  build's y, so the scan formula is under test too).

  Coverage teeth run before the diff (two empty arrays compare equal): slots > 0, lines > 3,
  finite positions, >1 distinct x AND y, one slot per codepoint, a line table starting at 0 that
  never decreases, an empty line, cellWidth reproducing line 0, cellHeight being the row pitch,
  the lineStartRow scan reproducing line y; wrapping folds add "a line exceeds wrapWidth" + a real
  z-staircase, paginating folds add "pagination fired (`pageContentWidth` > 0)" + pages actually
  separating. `--selftest` swaps a CPU reference model in for the kernel module through the same
  constructor/configure/compute/readPositions surface, so the harness proves itself — that model
  matches the builder **bit-exactly (max |Δ| = 0) on all five folds**, which makes it the
  executable spec for what the GPU must reproduce, and proves those inputs are *sufficient*.

  Three things it measured that any kernel work has to respect:
  - **cellWidth is the builder's advance, NOT `metrics.charWidth`.** `getCharSize().width` is
    CEIL'd to whole pixels; the builder steps by `ax / upem × (worldScale × pixelHeight)`. On the
    current font those differ by 12.5% — the check takes the modal advance out of the builder's
    own `sizes` buffer and warns when the metric-derived number disagrees.
  - **…but the PAGE GAP multiplies `charWidth`, not that advance.** `paginationGeometry` uses
    `charAdvance = metrics.charWidth + letterSpacing` for `gapXWorld` and for the `pageWidthWorld`
    fallback. Two different cell widths in one builder; the check passes the gap unit as its own
    `pageGapUnit` param (plus world-unit `pageGapXWorld` / `pageGapYWorld` / `pageDepthWorld`).
  - **The builder ACCUMULATES x** (f32 rounding per store), so a closed-form `col × cellWidth`
    drifts ~3e-7 per column and breaks a 1e-4 epsilon past ~340 columns. A prefix sum over
    `advances` reproduces it exactly instead. The check reports the per-column rate and the
    column budget it implies.

## Log store (relay SQLite)

The relay keeps every browser log record in an in-memory SQLite store (FTS5-indexed).
**`buslog.mjs`** is the client. Store verbs answer **page-less** — only the relay needs
to be up — while `log.tail` / `log.level` are ring verbs living in the page (reach those
via `./glyph3d-cli`, or `--level-set` from buslog).

Three-command smoke (relay on :8080):
```
bun tools/buslog.mjs errors                            # recent error/warn records
bun tools/buslog.mjs search <expr> --since 5m          # FTS5 (LIKE under 3 chars)
bun tools/buslog.mjs q "SELECT level, count(*) FROM logs GROUP BY level"
```

Live follow — a push subscription (lossless, no polling), "tail -f for the app":
```
bun tools/buslog.mjs                                   # everything, rendered
bun tools/buslog.mjs --filter attention --level debug,trace
bun tools/buslog.mjs --json                            # raw records as JSONL
```

Also: `stats` (store shape), `dump [path]` (VACUUM INTO snapshot, default
`/tmp/glyph3d/logs-<ts>.db`), `search <expr> --fuzzy <query>` (client-side fzf rank).
`tools/itests/logstore.itest.mjs` locks in ingest + search/query/stats end-to-end
(skips loudly when no relay answers on :8080).

## Headless checks (no browser)

- **`hand-source-check.mjs`** — the SENSOR PLANE end to end: a real relay binary, a
  real `SOURCE hand` handshake, real ARKit-shaped frames on the wire, feeding the
  real SourceStream → HandPresence → HandRenderer chain. No browser (the render path
  is CPU-side three), so it runs in bun in a few seconds. Needs a relay up:
  `./glyph3d-cli serve --local --port 8099 .`
  ```
  bun tools/hand-source-check.mjs [--relay 8099]
  ```
  The unit tests (`source-stream.test.mjs`, `hand-presence.test.mjs`) stub the bridge;
  this covers what only exists BETWEEN the parts, each of which has actually bitten:
  a device classed as a controller because its greeting wasn't first on the wire;
  frames arriving but decoding to nothing; geometry that updates forever and never
  draws (parented to a camera, and `render(scene, camera)` walks only the scene); a
  hand inside the near plane, clipped while every probe reads healthy; a hand drawing
  at 2px and read as "not rendering". Two teeth worth keeping:
  - **near-invariance** — placement is in near-plane units, so the check sweeps
    `camera.near` 0.5 → 12 and asserts apparent size doesn't move (and clears the
    plane at both ends). The test camera uses **near=4**, the app's dial, not three's
    0.1 — an earlier version passed at 0.1 while the real app showed nothing.
  - **cross-wire frame accounting** — drop counts live on the RELAY, arrivals on the
    display, so it asks `source.list` and reconciles the two. Frames vanishing between
    them would otherwise be invisible from either side alone.


- **`cli-flag-order.test.mjs`** — argument parsing on the REAL Go binary (it builds one
  per run and refuses a build older than its sources). Go's `flag` stops at the first
  non-flag token, so `serve <dir> --port 8121 --relay-only` parsed nothing: the port and
  mode the operator typed were dropped and the **8080 default bound in their place**,
  banner and all — a silent fallback at the port seam, and `tools/dev.sh` carried the
  same ordering, so `RELAY_PORT=9000 tools/dev.sh relay` served 8080. The gate drives
  the binary (a unit test on `parseServeArgs` still passes if `serveCmd` stops calling
  it) and runs dev.sh's invocation lifted verbatim from the script. Ports 8121-8123
  only; every case that must REFUSE leads with a scratch `--port` so a regressed build
  binds that instead of reaching for the operator's live relay.
  ```
  bun tools/cli-flag-order.test.mjs
  cd cli && go test -run 'TestParse|TestGlobalFlag' .   # the parse-level half
  ```

- **`verify-tree-sitter.mjs`** — load each vendored grammar, compile its highlight
  query, parse a snippet, report captures. Run after upgrading web-tree-sitter / a
  grammar, adding a language, or editing a query. Catches ABI mismatches, query-compile
  errors, and zero-capture regressions.
  ```
  bun tools/verify-tree-sitter.mjs
  ```

- **`scan-layout.test.mjs`** — the byte pipeline's ALGEBRA gate: the segmented monoid scan
  (`compute/glyphPipelineScan.js`, the GPU's dispatch structure in JS) against the serial
  oracle (`compute/glyphPipelineReference.js`). Associativity fuzz over random leaf cuts,
  chunk/group-size invariance (integer lanes bit-exact at every grouping; fold>0 x
  bit-exact — resolveX re-sums in the oracle's f32 order), the item-reset law (every
  item's first leader is row0/col0/ord0 even when chunks straddle boundaries), content
  isolation, and a randomized corpora sweep. Run after touching the monoid, the scan
  spec, or the fold semantics.
  ```
  bun tools/scan-layout.test.mjs
  ```

- **`contenttree.test.mjs`** — unit-tests the directory recursion in `ContentTree`
  (the dir-mirroring scene graph: `insert(path)` builds the dir-node chain, `remove`,
  two-pass `relayout`). Pure `three` (no WebGPU) with synthetic leaves, so it's fast and
  deterministic. Covers the directory gotchas: substring-path collisions (`b` vs `bc`),
  create-once node reuse, deep empty-intermediate chains, dirs-first ordering, removal /
  prune, and **insert-order independence** (forward vs reversed insertion → identical
  tree). Run after touching `ContentTree` or its layout.
  ```
  bun tools/contenttree.test.mjs
  ```

- **`layout-mirror.test.mjs`** — the fold-mirror parity CONTRACT: `LayoutDescription.positionAt`
  and `evaluateFold` against the real builder, per slot, across flat/wrap/scroll/newspaper/
  z-pages plus arranger displacements (EOL rides the last glyph's D; empty lines take none).
  Pure node, no GPU. The GPU kernel is bound to the same builder by `layout-kernel-check.mjs`,
  so all three evaluators of the one fold stay provably equal. Run after touching
  `LayoutDescription`, `foldEvaluate`, the builder's layout math, or the kernel's fold.
  ```
  bun tools/layout-mirror.test.mjs
  ```

- **`layout-fuzz.test.mjs`** — adversarial randomized parity over the same three evaluators:
  random texts (empty-line runs, emoji at wrap boundaries, 300-col lines), random params
  (wrap widths ON line-length boundaries, page heights AT row-count boundaries, both axes),
  random origins, scroll sequences. Deterministic PRNG — replay any failure with
  `--seed <n> --seeds 1` (which also dumps forensics: layout, geom, builder-vs-mirror-vs-bulk
  triplets, the exact relY quotient). STRUCTURAL threshold: it hunts cell/page-stride
  divergence; tight-epsilon parity is layout-mirror's job (the builder stores f32 — noise
  scales with |value| and column). Day one it caught the page-boundary ghost machine
  (applyPagination's raw gate), the absolute-vs-f32-relative nudge, and the unfired-geom
  caret shift. Run it whenever pixels show residue, stacking, or page-scale misplacement.
  ```
  bun tools/layout-fuzz.test.mjs                    # 200 seeds
  bun tools/layout-fuzz.test.mjs --seeds 300 --seed 77000
  ```

## Build / serve

- `cd app && bun run build` — production Vite build (static gate: imports, assets, syntax).
- `make build` — full self-contained binary; `make prep-tree-sitter` / `prep-wasm` —
  refresh vendored WASM after dep upgrades.
- Verify Vite serves a fresh module (the stale-transform trap):
  `curl -s http://localhost:5173/@fs/<abspath> | rg <token>`

## Second machine setup (the macOS perf testbed)

The whole harness is machine-portable; a second box (different GPU, smaller memory,
its own filesets) runs the same tools and compares numbers.

Prereqs: `bun` · `bunx playwright install chromium` (the drive-loop browser) · Go +
`make` for the relay (or grab a released `glyph3d-cli` darwin binary — `tools/install.sh`
detects the platform) · `tmux` (terminals; `brew install tmux`).

Boot: `bun install` at the repo root, then `tools/dev.sh` (Vite :5173 + relay :8080 —
`pid_on_port` uses `lsof` where `ss` doesn't exist). For measurement runs prefer the
BUILT app on a scratch relay: `make build && ./glyph3d-cli serve --local --port 8099 .`
(dev mode retains ~17x more heap and reloads on Vite restarts).

Platform notes:
- **GPU flags are centralized** in `itest/driver.mjs` `webgpuArgs()` — Linux forces
  ANGLE onto Vulkan (headless would otherwise fall to SwiftShader); macOS rides
  ANGLE's native Metal backend and must NOT get the Vulkan flags. Every
  self-launching tool imports this — never inline browser args in a new tool.
- **Headless on macOS is SwiftShader, and that is not fixable with flags** — the
  headless shell has no Metal surface, so ANGLE falls to software (`google/
  swiftshader`, ~1 rAF/s) while headed gets `apple/metal-3` at 61. This is why
  measurement tools launch via `launchGpuBrowser()` (platform-resolved: headless
  on Linux, headed on macOS) and assert `assertRealGpu()` before printing. A
  headed run opens a real window on your desktop — that is the cost of a real
  number here, not a bug. `bunx playwright install chromium` installs BOTH the
  full browser and the headless shell; headed needs the former.
- `tools/dev-firefox.sh` / `dev-gpu.sh` are Linux/NVIDIA-specific (driver pinning);
  irrelevant on macOS — Chrome/Chromium there has WebGPU on Metal out of the box.
- Filesets are parameters everywhere (`--dir`, `--url`, `STORM_DIR`, `--text-file`);
  defaults derive from the repo location, not a hardcoded home.
- Expect DIFFERENT baselines (that's the point of the testbed): re-measure
  `gpu-traffic` idle, `frame-anatomy` FPS/floor, and `storm-probe`/`loadcurve`
  ceilings on the new hardware before judging any regression, and record them in the
  comparison notes rather than assuming this box's numbers.
- The relay is single-operator and unauthenticated — scratch relays on a laptop are
  fine; the shared-socket terminal hazard (two relays adopting each other's tmux
  terminals) applies per-machine exactly as documented in the repo memory.
