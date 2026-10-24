# Dev checks & drive-loop tools

Repeatable verification tools. The rule: **when a debug probe proves useful, it
graduates into a saved tool here** rather than being retyped next time. They don't
need rigorous shape — just be runnable and documented. Build the set up over time.

All run under Bun (the repo runtime). The dev loop must be up for browser tools:
`tools/dev.sh` (Vite :5173 + relay :8080), `tools/dev.sh vite` to restart + clear cache
after editing core, `make dev-status` to check.

## Browser drive-loop

- **`smoke.mjs`** — boot the app in a real (WebGPU) browser, capture every console
  error + uncaught exception, optionally drive command-bus verbs and screenshot, exit
  non-zero on real errors. The "does the UI boot and run" gate; catches render-crash
  bugs (an undefined variable in a component) before they reach the browser by hand.
  ```
  bun tools/smoke.mjs                                   # headless: report boot errors
  bun tools/smoke.mjs --headed --shot /tmp/app.png      # real GPU render + screenshot
  bun tools/smoke.mjs --cmd 'repo.load owner/repo' --cmd 'file.open path.js' --shot /tmp/x.png
  ```
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

- **`storm-probe.mjs`** — N-file synthetic storm with full forensics: real device limits,
  per-second heartbeat (GPU error count + first sample, JS heap), page-crash detection,
  notable console tail. THE tool for "loads N files then wedges". Client-only (fake
  provider, no relay).
  ```
  bun tools/storm-probe.mjs 1000
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
(evaluator parity, does-it-boot) keep using `launchBrowser()` and stay headless
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

- **`frame-profile.mjs`** — where a steady-state WebGL2 frame goes, in three passes so the
  instrumentation never skews the timings: TIMING (frame gaps, main-thread rAF work, and per
  render PASS — the main camera vs the minimap vs a pick — CPU ms in three's `render()` and
  GPU ms via `EXT_disjoint_timer_query_webgl2`),
  CENSUS (draws per frame by program, GL calls by name, upload bytes per frame, scene census),
  PROFILE (CDP sampling, bucketed three.js / webgl driver submit / core / app / react — Vite's
  dep chunks mapped back to packages; `--callers FN` attributes a hot leaf to its call paths).
  `--hitch MS` lists what ran inside frames longer than MS (samples binned by page-clock
  frame stamps). `--cmd` / `--eval` set up the view or an A/B toggle. Found three's
  transparent+DoubleSide two-pass re-deriving 126 programs a frame (b231d6c) and our
  per-frame matrix walks. Caveats: `--uncapped` render-CPU numbers carry GPU-process
  backpressure (a per-frame fence alone moved them 4×), and a busy machine swings runs 3×
  — for small A/Bs interleave the conditions in ONE page and compare medians.
  ```
  bun tools/frame-profile.mjs --url http://localhost:5174/ --relay 8099 --dir /scratch/root/src --uncapped
  bun tools/frame-profile.mjs … --cmd 'camera.focus /scratch/root/src/a.js' --callers updateWorldMatrix
  ```

- **`glyph-cull-truth.mjs`** — three culls by each field's STATED bounds; this checks every
  live quad, built the way the vertex shader builds it (emoji width), against its mesh's
  `geometry.boundingBox` — across a dir load, every layout preset, an arranged grid, and an
  in-page terminal (fed bytes; no tmux). Run after touching `setLayoutExtent`, any extent
  producer, or the glyph vertex shader.
  ```
  bun tools/glyph-cull-truth.mjs --url http://localhost:5174/ --relay 8099 --dir /scratch/root/src
  ```

- **`glyph-far-lod.test.mjs`** (headless) — GlyphFarLod's near/far decision exactly at the
  threshold (perspective + orthographic, world scale), the nearest-point rule (a long file you
  stand at the end of keeps its glyphs), the backdrop quad over the laid-out box, the tint
  (mean LINEAR ink through the group tint, cover × group alpha, cached on buffer versions),
  opt-outs, hidden ancestors, a grow past capacity, dispose.

- **`far-lod-check.mjs`** — does a far file SHOW as its backdrop, and does nothing else move?
  Renders the live scene FULL (every glyph) / LOD / BARE (backdrops at gain 0) at fit-all and
  three closer poses; fails if a pixel outside the far rects moves or the backdrops lift the far
  rects' mean linear light under 5% (of FULL) over bare panels — the box must be visible, not a
  match for sub-pixel glyphs that add next to no light (the old straight-alpha backdrop lifted
  1–2% and fails here). Reports the TRANSITION BAND (far fields within 2× of the threshold) LOD
  and BARE against the glyphs, and the gain that would match them, as information.
  ```
  bun tools/far-lod-check.mjs --url http://localhost:5174/ --relay 8099 --dir /abs/dir --cmd 'layout.scheme library'
  ```

- **`glyph-batch.test.mjs`** (headless) — GlyphBatch: enrolment refusals, membership follows
  add/remove, each label's range in its own group row with every other lane verbatim, THE POSE (a
  batched glyph lands where its own mesh puts it, rotated, scaled, far from the origin), hidden
  and off-frustum labels go dark, ranges run in three's far → near order (and re-sort when it
  flips), repack only on a text/colour change, refusals (a glyph outside group 0, a sheared pose)
  draw themselves, far-LOD leaves batched fields alone, pick passes don't refresh, dispose.
- **`glyph-batch-check.mjs`** — the batched frame against every label drawing itself at the
  arena's render order (SHIFTED) and at its own (OWN), and with no labels (BARE), at fit-all and
  three closer poses; reports draws + render CPU. The SHIFTED compare is 3×3-blurred and counted
  past 24/255: the arena's transform order lands glyph edges a few hundredths of a pixel from their
  own draw's, which no eye sees but a raw diff counts. A planted neighbour-pose bug fails 3 of 4
  poses, a 2% scale error the closest. Fails when no pose has a visible label (vacuous).
  ```
  bun tools/glyph-batch-check.mjs --url 'http://localhost:5174/?relay=8099' --relay 8099 --dir /abs/dir --cmd 'layout.scheme library'
  ```
- **`panel-batch.test.mjs`** (headless) — PanelBatch: enrollPanel refuses what it can't batch,
  membership follows add/remove/material dispose, the refresh runs for view cameras and never
  pick passes, an instance carries the panel's uniforms + eye-relative world matrix, hidden
  ancestors draw nothing, off-view instances are culled, buckets split (and re-split) by render
  state, a translucent bucket sorts exactly as three sorts objects, real producers
  (GridBackground, flat page faces) enroll and warp faces don't, box fills + outlines (colour ×
  opacity, fill before outline, lines drawn as lines, fog → they draw themselves), grow, dispose.
- **`panel-batch-check.mjs`** — the batched frame against every panel drawing itself, at
  fit-all and three closer poses: draw calls and render CPU (interleaved medians) before →
  after; BATCHED vs SHIFTED (own draws at each bucket's order) must match to 1% of
  what removing the panels changes — the instancing's correctness; BATCHED vs OWN is the
  deliberate look change (panels no longer interleave by depth with the non-panels of their
  band), reported for a human. `--shots DIR` writes each frame as PNG.
  ```
  bun tools/panel-batch-check.mjs --url http://localhost:5174/ --relay 8099 --dir /abs/dir --cmd 'layout.scheme library'
  ```

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

- **`type-imports-check.mjs`** — the JSDoc seam guard. tsc over `jsconfig.json` with
  checkJs on, reporting ONLY the codes where a type silently degrades to `any`: a dead
  `import('…')` path (TS2307), a typedef-only script that isn't a module (TS2306), a
  missing export/typedef (TS2305/2614/2724/2694), a `.jsx` import without `"jsx"` in
  jsconfig (TS6142), and a JSDoc type NAME the file never imports (TS2304/2552/2503, counted
  only inside block comments; in code those codes are runtime globals). Baseline is zero,
  so any hit is a regression. ~4s.
  ```
  bun tools/type-imports-check.mjs
  ```
  Teeth, verified: a planted dead `CommandRouter.js` path, a missing typedef, a missing
  export, and an un-imported `{CodeGrid}` / `{THREE.Vector3}` each fail it, while an unknown
  runtime global does not; dropping `"jsx"` from jsconfig fails it 124 times.

- **`lsp.mjs`** — one-shot code intelligence from a shell: `hover`, `def`, `refs`,
  `impl`, `callers`, `callees`, `symbols <query>`, `outline <file>` via
  typescript-language-server. The same answers as Claude Code's LSP tool, for agents
  and sessions without it (cloud sessions don't start plugin language servers).
  Positions are `file:symbol` (found in the file's outline, dotted for a member, so it
  survives line drift), `file:line:name` (an rg hit + the identifier), or `file:line:col`.
  A target that fails to resolve is reported and skipped; the rest still run.
  ```
  bun tools/lsp.mjs refs packages/glyph3d-core/src/services/orchestration/CommandRouter.js:CommandRouter.execute
  bun tools/lsp.mjs hover app/commands/handlers/gridCommands.js:16:ctx
  bun tools/lsp.mjs symbols TerminalGrid
  ```
  It waits for the server's project-load progress `end` before asking. Answers given
  before that are partial: refs from only the open file, and `any` for types that
  cross modules. `refs` follow types, so a call through an untyped receiver is
  invisible; keep rg as the completeness check for dynamic call sites.

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


- **`verify-tree-sitter.mjs`** — load each vendored grammar, compile its highlight
  query, parse a snippet, report captures. Run after upgrading web-tree-sitter / a
  grammar, adding a language, or editing a query. Catches ABI mismatches, query-compile
  errors, and zero-capture regressions.
  ```
  bun tools/verify-tree-sitter.mjs
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
  Pure node, no GPU. Run after touching `LayoutDescription`, `foldEvaluate`, or
  `foldGeometry`.
  ```
  bun tools/layout-mirror.test.mjs
  ```

- **`layout-generator-fold.test.mjs`** — the RENDERED slots against the same fold: a
  headless `CodeGrid` through every `grid.layout` preset, each slot `LayoutGenerator`
  writes checked against `positionAt` (x/z exact, y on the cell's vertical center), plus
  a finite extent per preset and a wrapped line's widest-segment row extent. Run after
  touching `LayoutGenerator`, `CodeGrid._layoutContent`, or the cell metrics.
  ```
  bun tools/layout-generator-fold.test.mjs
  ```

- **`arrangers.test.mjs`** — the structural arrangers (`structure.grid` /
  `structure.strata`) on the slot buffer: a headless `CodeGrid` with a hand-built
  SemanticModel. Blocks move rigidly and don't overlap, stray glyphs hide, the content
  bounds and cull box are the arranged extent, the caret lands on moved glyphs, a re-fold
  or live strata dial never compounds, strata boxes center on their rows, and reset hands
  back the grid's own (paged) layout. Run after touching `StructureLayout`, `StrataLayout`,
  or `CodeGrid`'s arranger seam (`_applyArrangers` / `setDisplacements` / `foldSnapshot`).
  ```
  bun tools/arrangers.test.mjs
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
