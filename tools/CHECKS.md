# Dev checks & drive-loop tools

Repeatable verification tools. The rule: **when a debug probe proves useful, it
graduates into a saved tool here** rather than being retyped next time. They don't
need rigorous shape — just be runnable and documented. Build the set up over time.

All run under Bun (the repo runtime). Run them through the runner below; by hand, the
browser tools want the dev loop up: `tools/dev.sh` (Vite :5173 + relay :8080),
`tools/dev.sh vite` to restart + clear cache after editing core, `make dev-status` to check.

## The runner — `check.mjs`

One manifest (`tools/check-manifest.mjs`) declares every check: its command, tier, scopes,
what it needs, which checks it can't run beside, what it compares and what it is blind to.
`check.mjs` runs a selection of it in parallel and ends on ONE verdict line.

```
bun tools/check.mjs --tier inner           after each change: fast headless (~4 s at -j32)
bun tools/check.mjs                        all headless (tier full = inner + full)
bun tools/check.mjs books render           only checks scoped to books or render
bun tools/check.mjs flat-root layering     checks by name (any tier)
bun tools/check.mjs --tier browser         needs a browser on the app's Vite (+ a private relay)
bun tools/check.mjs --tier gpu             real-GPU pixel compares, the wall end to end, GPU timing
bun tools/check.mjs --tier all             full + browser + gpu
bun tools/check.mjs --tier parked          the parked hand tests (no other tier includes them)
bun tools/check.mjs --list [--tier T]      each check: command, needs, compares, blind to
```

- **Tiers.** `inner` = every fast headless check; `full` adds code form and vendored
  inputs (type imports, saved ast-grep rules, knip, the tree-sitter grammars); `browser` and
  `gpu` need Vite + a browser (+ a private relay, + a real GPU); `parked` holds the hand
  tests (hand tracking is parked — `hand-cloud` alone was 53 s of a 65 s headless run).
- **Scopes** answer "I changed X, what should I run": render, layout, books, agents, desk,
  camera, persist, terminal, shell, relay, wall, form, corpus, hand. A positional argument is
  a scope or a check name; anything else is refused.
- **Output.** `PASS` / `FAIL` / `KNOWN` / `SKIP` per check as it finishes, `NOTE` lines
  (report-only checks, what was skipped and why), a `TIME` line (wall, summed, slowest), then
  the verdict: `ALL GREEN — n of m ran (tier, scope)`, `RED — k failed: …`, or
  `NOTHING RAN — not a pass` (a selection that ran nothing is never green). A failed check
  keeps its whole output (and its relay's log) in `out/check/kept/<ts>-<name>/`; every run
  writes `out/check/last-run.json`. `out/` is gitignored.
- **Known reds** are declared, not skipped: an entry's `known` names the reason and the
  failure's signature. The run stays green only while the failure matches it; a different
  failure is RED, and so is an unexpected pass (remove the entry). Today:
  `agent-events` (one corpus prompt event has no sheet, 31/33 — red on the-backport too) and
  `itests` (semantic.itest probes every package.json the repo load brought in; only the one
  it opened builds structure).
- **Floors.** `tools/check-floors.json` holds, per tier, how many checks an unscoped run must
  RUN; fewer is RED ("checks went missing"). `--ratchet` raises a floor to what a green run
  ran and never lowers it.
- **Coverage.** Every `tools/*.test.mjs`, `*-check.mjs`, `*.itest.mjs` and `wall-*.mjs` must
  appear in the manifest, or the run is RED before anything starts. Instruments that judge
  nothing (`frame-profile`, `gpu-traffic`, the profilers) stay out of it.
- **What it starts.** For browser/gpu checks the runner starts its own Vite on a free port
  (config wrapped so its cache is `out/check/vite-cache/`, never the dev server's), warms it
  once, and gives each relay-needing check a fresh PRIVATE relay —
  `glyph3d-cli serve --listen 127.0.0.1 --port <free> --relay-only --termd-ns c<n> --no-gomuxai <scratch root>`
  with `G3D_TERMD_DIR` a scratch directory (`$G3D_TEST_RUN_DIR/ck-<pid>`, else `out/termd/ck-<pid>`;
  `tools/lib/termd.mjs`) — serving a copy of the fixture (the core's sources as `src/`, plus a
  generated `mixed/emoji_tabs_wide.txt`), killed with its termd daemon (and every shell in it)
  when the check ends. It never takes 5173/5174/5180/8080/8099, a person's termd namespace, or
  gomuxai. What it can't start
  (no `./glyph3d-cli` — `make build` or `--cli PATH`; no `./g3d-termd` beside it; no chromium; no GPU render
  node; no network for the GitHub-loading itests) is a `NOTE` and those checks `SKIP`.
- **Concurrency.** `-j N` (default: every core). Checks sharing an `apart` token never
  overlap (`display`: the browser/gpu checks run one at a time); `*` runs alone, after the
  rest (the GPU timing instruments).

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

- **`glyph3d-cli screenshot`** — one-shot screenshot of the **LIVE** display (the window a
  human is watching), not a fresh browser. Dials the running relay, optionally runs verb
  line(s) in order on the one connection, lets them settle, then sends the bus-native
  `screenshot` verb and writes the returned PNG (and warns when it is suspiciously small —
  a blank canvas). This is how a headless agent (a plain Bash tool) closes its own pixel
  loop: it can SEE its WebGPU/dock/layout work instead of verifying by math + asking the
  human. One-shot by design (connect → command(s) → capture → exit) so the harness can't
  reap it mid-run. Global flags (`--port`, `--json`, `--timeout`) go before `screenshot`.
  ```
  ./glyph3d-cli screenshot -o /tmp/shot.png                          # capture current scene
  ./glyph3d-cli screenshot --cmd 'dock.list' -o /tmp/shot.png        # run a verb, then capture
  ./glyph3d-cli --port 8199 --json screenshot --cmd 'camera.fitall' --wait 500ms -o /tmp/x.png
  ```
  Contrast `smoke.mjs`, which launches its OWN headless browser (an empty display) — use
  `glyph3d-cli screenshot` when you need to see what's actually on screen right now.

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

- **`flat-root.test.mjs`** (headless) and **`flat-root-check.mjs`** (GPU) — the flat render root
  (`collections/FlatRenderRoot.js`): the view camera renders a flat list of the drawables it sees,
  rebuilt only when visibility, membership or layers move. The test locks the list against a fresh walk
  of the scene, rebuild counts (none at rest; one per visible / layer-0 / membership change), the
  three-walks-it-whole cases (a Group with renderOrder, lights, LODs) and the loud refusals (a drawable
  whose own onBeforeRender may read the scene, a shadow-casting light → the full scene, named). The
  check renders frames through the list and through the full scene — byte-identical across camera
  distances, mid-flight poses and the library layout; a half-list render must differ.
  `scene.render [time <n>]` reports it live.
  ```
  bun tools/flat-root.test.mjs
  bun tools/flat-root-check.mjs
  ```

- **`pick-flat-root.test.mjs`** (headless) and **`pick-flat-root-check.mjs`** (GPU) — each pick
  channel draws its own short list of the meshes on its layer (`pick.flatRoot`, on) instead of three
  walking the whole scene per channel: the test locks each list against a fresh walk, rebuilds per
  layer bit (registering a glyph field rebuilds only the glyph list; the pick camera's own per-pass
  layer change rebuilds nothing); the check compares pick results list vs full scene over pointer
  sweeps of glyphs, batched panels, resize handles, volumes and the library layout — identical, while
  removing a hit mesh always changes them.
  ```
  bun tools/pick-flat-root.test.mjs
  bun tools/pick-flat-root-check.mjs
  ```

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
  bun tools/frame-profile.mjs … --vram                  # CENSUS + GPU bytes by type
  bun tools/frame-profile.mjs … --ledger scratch-src    # + this host's perf ledger, compared
  ```
  `--vram` loads **webgl-memory** into the page before the app (`openApp(…, { webglMemory:
  true })` in `itest/driver.mjs`, read back by the driver's `glMemory()`): the census gains
  buffer / texture / renderbuffer / drawingbuffer bytes and live object counts beside
  renderer.info's (measured on the core's collections/ at fit-all: 84 MB — 23 MB textures,
  27 MB buffers, 34.5 MB drawing buffer; 58 textures vs renderer.info's 54). It wraps EVERY
  GL call of the context, which moved main-thread work per frame from 0.2 to 0.3 ms there,
  so a `--vram` run's timing says `skewedBy` and its ledger rows go under `<scenario>+vram`.

- **`perf-ledger.mjs`** — one append-only ledger of measurements per host, and a compare
  against that host's own history. Rows are `{ts, commit, dirty, scenario, metric, median,
  p95, n, adapter, load}` (load = the 1-minute load average per core when written).
  ```
  bun tools/perf-ledger.mjs compare [--scenario S] [--window 20]   # exit 1 on a regression past its band
  bun tools/perf-ledger.mjs show [--scenario S] [--last 20]
  bun tools/perf-ledger.mjs add --scenario S --metric M --median X [--p95 Y] [--n N]
  bun tools/perf-ledger.mjs host                                    # this machine's key + file
  ```
  The ledger lives in the MAIN checkout's `perf/` (git's common dir, so every worktree shares
  one history; `GLYPH_PERF_DIR` moves it) and is gitignored: rows are one machine's, appends
  from two branches would conflict, and the repo is public. The host key is the GPU's name
  plus 6 hex of a hash of the hostname — `nvidia-geforce-rtx-5090-3fa9c1` — so two machines
  with one GPU model stay apart and no key spells a hostname (`GLYPH_PERF_HOST` names it
  yourself). `compare` reads each metric's latest row against the rolling median of the rows
  before it, with a band of `max(rel × base, abs, k × MAD)` per metric from
  `tools/perf-bands.json` (`abs` is the resolution floor: timings print to 0.01 ms).
  Producers: `frame-profile.mjs --ledger SCENARIO` (frame gap, main-thread work, the main
  pass's CPU/GPU ms, draws per frame across passes, upload bytes, + VRAM with `--vram`). A
  tool adds its own with
  `import { appendRows } from './perf-ledger.mjs'; appendRows({ scenario, adapter, rows: [{ metric, median, p95, n }] })`
  — `adapter` is the page's `UNMASKED_RENDERER` (the key is derived from it); the wall's
  instruments (wall-text-perf's per-stage ms and bytes/s, wall-gpu-attribution's per-layer
  GPU ms) are the next producers.

- **`glyph-cull-truth.mjs`** — three culls by each field's STATED bounds; this checks every
  live quad, built the way the vertex shader builds it (emoji width), against its mesh's
  `geometry.boundingBox` — across a dir load, every layout preset, an arranged grid, and an
  in-page terminal (fed bytes; no termd). Run after touching `setLayoutExtent`, any extent
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
- **`agent-book-history.test.mjs`** (headless) — an agent book's sliding window over a synthetic
  100-turn event stream and a mock `agentEvents/read {until, tail}`: records carry their line's
  byte offset; paging near
  the oldest sheet prefetches records (no sheets); pushing past it slides the window one turn back
  (same size, the deck parallel to the entries, the head on the turn paged to, the newest waiting
  as a record); a slide wider than the buffer waits for reads (bounded windows, never the whole
  prefix) and completes; a call at a window edge pairs with its result (the overlap read); numbers
  stay an estimate until the start makes them exact; live
  turns while held wait beyond the window; `live` slides to the end and resumes following; the
  run's start ends history. Mutation-checked (no evict, no freeze, no pending slide).
- **`agent-events.test.mjs`** (headless) — agent books fed by gomuxai's event stream
  (`collections/agentEvents.js` → `AgentBooks.applyEvents`), driven from gomuxai's conformance
  corpus (`$GOMUXAI_DIR/internal/transcript/testdata/corpus/**/*.events.jsonl`, default
  `~/dev/gomuxai`; FAILS when it is missing). The reader folds any chunking (1-byte, mid-codepoint)
  to the same events, one per id, an update replacing its event and keeping the add's position;
  off-contract frames throw. One sheet per event (noise too, in its dim hue; `book.showNoise` off hides it), live ==
  hydrated; prompts of every origin are sheets tagged by whose words they are, in the prompt hue;
  a tool's pending → result rebuilds its sheet in place (count, index, deck node, head unchanged —
  also across a resumed reader that never saw the add); statuses, an errored file action's error,
  a provisional final reply confirmed; turn ids/indexes on every sheet and in `headState`; a
  stream's events land in its own book (a subagent's stream in the subagent's — its events'
  `agent` is not its session id; an old transcript's sidechain records in a book named by their
  agent); a redacted thought says so; the sliding-window history pages back by `at` over
  `agentEvents/read {until, tail}` windows of a long corpus-derived stream (every paged record
  equals the full fold — results paired across window edges; exact numbers at the start), and
  updates to buffered records replace them there.
  Mutation-checked (12 mutants: no in-place replace, position lost, generic tag, no subagent
  routing, orphan update as add, no overlap read, turn dropped, buffered update ignored, …).
  ```
  bun tools/agent-events.test.mjs
  GOMUXAI_DIR=/path/to/gomuxai bun tools/agent-events.test.mjs
  ```
- **`session-books.test.mjs`** (headless) — agent books over the relay's event wire, end to end:
  the real AgentSessionProvider over a fake bridge playing the relay (agentSessions/list|changed,
  agentEvents/read|follow|unfollow, agentEvents/lines|ended), real AgentBooks, Carrel, Holding,
  SessionBooks, GomuxHub, SessionDesk, agent.open and SessionStore. Open = a tail read (doubled
  to the cap) → hydrate → follow from the last `at` (only a session that hasn't ended — the hub's
  departed agents and ended local sessions open as records; a status turning live follows,
  exiting unfollows); live lines append, a result update rebuilds its sheet in place, lines that
  beat the follow's {ok} are taken; every follow drops the provisional replies (the open's
  included); ended (code -1 too) says "not live" on the book and re-follows from the last
  non-provisional `at`; paging back reads {until, tail} windows up to the start (exact numbers);
  a failed page read is marked, not re-read every page; results far from their calls (in the
  tail, followed live, or met in an older window) are held and adopted when the call pages in,
  and the cap's older records wait buffered as their window folded them; the hub's book is the
  agent's name, its status wins over a live batch, a new session opens into the same book (the
  old unfollowed, history sealed), a live edit taps the delta books with its patch; the agents
  desk opens live + recent local sessions (not old, not workgroup) up to `agents.maxBooks`,
  seats a subagent on its parent's team desk, rebuilds nothing on a re-push that changes nothing
  shown, leaves a cleared book closed (hidden — it keeps its maxBooks slot); agent.open by prefix / workgroup name (its main session,
  never a subagent; a workgroup subagent opens into its own book); a failed open keeps its book,
  says so and retries; a refused follow says so; close always unfollows; a reconnect re-opens a
  stuck open; restore reopens saved books (limit, head), a vanished one stays closed, no list
  quarantines; capture saves books by session, never the hub's. Mutation-checked with
  agent-events and agent-book-history (35 mutants across two rounds — among them: resume from a
  provisional reply, routing by agent id, ended keeping provisionals, delta tap on pending
  calls, follow from the start, clear still following, desk rebuild every push, no teams, batch
  status winning, no overlap read, orphans dropped (window / followed / older window) or never
  adopted, page back reading the whole prefix, failed page re-read, no book cap, ended sessions
  followed, subagent into the agent's book, open never retried, reconnect skipping stuck opens,
  close unfollowing only when live, silent notices). The relay side is `cd cli && go test -run Gomux` (export's tree) and
  `go test -run 'AgentEvents|TailFrom|Children'` (the event wire, tail math, child cleanup).
  ```
  bun tools/session-books.test.mjs
  ```
- **`agent-visibility.test.mjs`** (headless) — hidden agents (client/AgentVisibility.js) over the
  same fake relay with the real hub, desk, verbs and SessionStore: before the saved set is known
  the hub and the desk open nothing (no read, no book); the restore's first stage opens the gate
  and only shown agents open — a hidden one is never read, a stale roster entry included;
  agent.hide closes the book, its stream and a hub agent's screen, and tree pushes keep it
  closed; agent.show reopens (a session outside the desks' windows too); agent.open shows;
  agent.clear hides a desk's/hub's book but only closes one opened from history; capture saves
  the set and a fresh page restoring it opens none of it; agent.group hidden keeps a new agent
  closed, ended closes ended ones (and one that ends later), shown drops overrides; a hidden
  session keeps its maxBooks slot. Mutation-checked (gate open from birth, restore not skipping
  hidden).
  ```
  bun tools/agent-visibility.test.mjs
  ```
- **`desk-tuning.test.mjs`** (headless) — per-instance knobs (client/tuning.js): a Settings ▸
  Carrel default reaches only desks born after it; `carrel.set` tunes one desk, `carrel.get`
  reads value · born · own, `default` returns to what the desk was born as; the gomuxai hub's
  desks are born in its form (cylinder hub, wall teams) and an own value survives the next tree
  push, the agents desk's survives the sweep; capture saves desks born-as-they-were plus every
  own value (`tunings`, derived hub desks included) and restore puts them back — onto a hub desk
  built before the restore ran, and into one built after; dissolve forgets; a shelf book's own
  deck value survives its shelf's re-apply, `book.form` records a shelf book's form, a book
  registering later is projected; deskOf finds a seated card's desk. Mutation-checked (no tune
  at birth, the hub re-stamping, a Settings push, the deck restamp ignoring own values, serialize
  saving live values, no `tunings` capture, no projector).
- **`scene-transforms.test.mjs`** (headless) — SceneTransforms on a random 400-node tree: after
  every kind of pose write (vector writes, rotations, three's transform helpers, attach / add /
  detached moves, a subtree built off-scene, a hand-written matrix, a camera, a pivot) every world
  matrix equals three's forced walk over an untracked clone, bit for bit; at rest the walk visits
  the root only, a write its chain; unchanged writes (position, rotation, quaternion) aren't
  changes; a vector held from before its node joined throws; clones are plain Vector3s; rootOf /
  isShown follow visible flips (ancestor, root, an own `visible` converted at join) and the tree's
  shape, while poses and walks leave the show generation alone; force,
  serialization, dispose. Each hook was removed in turn and the test failed. In the app,
  `./glyph3d-cli --port 8099 scene.transforms` verifies the live scene the same way.
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


## Relay client

**`glyph3d-cli`** is the one client for "dial the relay, run verbs, render the results".
Global flags (`--port N` / `--host url`, `--json`, `--timeout`) go before the verb. A
one-shot whose args are all plain tokens goes as the typed line (`whoami`, `ping` and
`call <b64>` reach whoever answers them as typed), and so does one whose verb arg is
itself a quoted line (`./glyph3d-cli "camera.move 0 0 300"`). When an arg carries
spaces, quotes, backslashes, newlines or is empty, the argv rides the `call` bundle
byte-identical — `./glyph3d-cli grid.create "two words" notes.txt` needs no quoting
discipline or base64. REPL and piped lines go as typed. A request that outlives
`--timeout` costs only itself: the client redials for the next one. Client commands beside the verbs:
`screenshot` (above), `log.follow` (below), and `seed-history [--lines 300] [id ...]` —
each terminal's termd scrollback (`capture`) into its depth-history ring via `terminal.depth.seed`
(the ring is in-memory: re-run after a reload).

A JS harness that genuinely needs JS (a Playwright page, a simulated display/sensor)
dials through **`tools/lib/relay.mjs`** (`dialRelay(port)` → `request(line)` / `close()`)
rather than hand-rolling the socket.

## Agent sessions + events (relay side)

`cd cli && go test -run 'AgentEvents|TailFrom'` drives `cli/agentevents.go` against a fake
`agent` script (sessions from a file; `transcript --follow` behaving by the path's name): one
follower shared by two displays and stopped only when the last unsubscribes (no ended for an
unfollow); a display leaving drops its subscriptions; following again from another byte
swaps the follower (`--from`); 2000 burst lines arrive whole and in order, no push over the
batch cap, a line longer than the cap alone; the follower cap fails loud and frees on
unfollow; a follower exiting pushes its lines, then `ended` with its exit code and stderr
(also logged); a stalled display is unsubscribed with `ended` code -1, not buffered;
`tailFrom`'s line-start rule (table + 300 random files across the scan chunk against a plain
re-statement); read windows (`--until` clamped to the size seen, an unlisted session or one
with no transcript fails loud, a new session found by asking again, the output cap); the
session poll pushes only changes, keeps the last good list through a failing run, and stops
with the last display; and one run through a real relay socket (follow → lines → close the
socket → follower killed); the one resolver (exact id, path, a workgroup name's newest
non-subagent session, a unique prefix; ambiguous / unknown / no-transcript errors; a miss
re-polls once, an ambiguity doesn't); follow resolving first (an unknown name starts nothing;
two names for one transcript share its follower, each hearing its own name); `{until, tail}`
reads the last bytes before until; the session poll pushes on arrive / leave / a shown field,
never on size/mtime/status_at or order alone; `ended` (stall or exit) waits with no deadline.
Mutation-checked (no pre-flush on the batch cap; no stop at zero subscribers; push on any
change; tail against the size, not until; no re-poll on a miss; ended with a deadline). `go test -run Children`: a helper relay process (the export watcher + a
follower, started as the relay starts them) SIGKILLed takes its `agent` children with it
(Linux, Pdeathsig — fails with Pdeathsig off), and the SIGINT/SIGTERM path's
`killChildren` stops and forgets them.

Live, against the real `agent`: a scratch relay (`CLAUDE_CONFIG_DIR=<scratch>/claude
./glyph3d-cli serve --relay-only --port 8199 --termd-ns scratch-cutover <dir>`,
killed by PID after) with a real transcript copied under `<scratch>/claude/projects/<p>/`,
a bun DISPLAY that follows it while the rest of the original is appended (lines split
across writes): the pushed event lines equal `agent transcript <copy>`'s; `read {tail}` then
`follow {from: last at}` equals the matching one-shot windows. Then `kill -9` (and,
separately, `kill -TERM`) the scratch relay's PID: its `agent export` and `agent transcript`
children are gone a second later.

## Log store (relay SQLite)

The relay keeps every browser log record in an in-memory SQLite store (FTS5-indexed).
**`glyph3d-cli`** is the client: it renders log replies — records as
`HH:MM:SS.mmm level [scope] msg ×N` lines, `log.query` as a table, `log.stats` as a
summary (the reply's count line goes to stderr; `--json` prints the raw data). Store
verbs answer **page-less** — only the relay needs to be up — while `log.tail` /
`log.level` are ring verbs living in the page.

Three-command smoke (relay on :8080):
```
./glyph3d-cli log.errors --since 10m                   # recent error/warn records
./glyph3d-cli log.search <expr> --since 5m             # FTS5 (LIKE under 3 chars); --level --scope --page --limit
./glyph3d-cli log.query "SELECT level, count(*) FROM logs GROUP BY level"
```

Live follow — a push subscription (lossless, no polling), "tail -f for the app":
```
./glyph3d-cli log.follow                               # everything, rendered
./glyph3d-cli log.follow --filter attention --level debug,trace
./glyph3d-cli log.follow --level-set DEBUG             # also raise the page's verbosity once
./glyph3d-cli --json log.follow                        # raw records as JSONL
```

Also: `log.stats` (store shape), `log.dump [path]` (VACUUM INTO snapshot, default
`/tmp/glyph3d/logs-<ts>.db`). Fuzzy-rank a wide search by piping the rendered lines:
`./glyph3d-cli log.search <expr> --limit 500 | fzf -f <query>`.
`tools/itests/logstore.itest.mjs` locks in ingest + search/query/stats end-to-end
(skips loudly when no relay answers on :8080).

## Headless checks (no browser)

- **Layering — dependency-cruiser** (`.dependency-cruiser.cjs`; the runner's `layering`, tier
  inner). CLAUDE.md's layering as rules over the static import graph: the core imports
  neither `app/` nor `wall/` nor the r3f binding nor react/@react-three; `workers/` imports no
  three; `wall/` imports nothing from `app/`; no import cycle inside the core. ~0.6 s, 372
  modules / 990 edges, zero violations today, so every rule is an error.
  ```
  bunx depcruise --config .dependency-cruiser.cjs packages app wall
  ```
  node_modules is `doNotFollow`, not `exclude`: an excluded path drops the edge INTO it too,
  and core-no-react could never fire. Teeth, verified on a scratch copy: a planted core → app
  import, core → react, core → r3f, a workers → three import, wall → app, and a two-file core
  cycle each fail it (46 errors: the core → app plant also closes cycles through the app).
  Blind to dynamic `import()` of computed strings, workers spawned by URL, DOM globals, JSDoc
  `import()` types — and to any edge resolved through a path under `.claude/` (the excluded
  agent worktrees), so run it from the checkout it checks.

- **Dead code — knip** (`knip.jsonc`; the runner's `knip`, tier full, REPORT-ONLY: a `NOTE`
  with counts, never a failure). Entries: `tools/**/*.mjs`, `app/*.html` (+
  `app/glyph-bench.jsx`, whose root-absolute `src` knip doesn't follow), `wall/index.html`.
  `bunx knip` lists the findings: unused exports in app/ and wall/, the core's named +
  default double exports, devDependencies nothing imports. Blind to the core's own unused
  exports: its `exports` map publishes `./*`, so every core file is public API to knip.

- **`ast-grep` rules** (`tools/sg/`; the runner's `sg-rules`, tier full). Saved structural
  rules, one per file in `tools/sg/rules/`. Hints print for review; a rule raised to
  `severity: error` fails the run. Today: `group-table-alias-write` (a write through a local
  alias of `_groupData`, which a table grow strands on the old array — 3 hits, all in
  GlyphBatch, whose arena is allocated at its full row count and replaced, never grown, and
  which marks the rows it uploads itself).
  ```
  bunx ast-grep scan -c tools/sg/sgconfig.yml packages app wall
  ```

- **`type-imports-check.mjs`** — the JSDoc seam guard. tsc over `jsconfig.json` with
  checkJs on, reporting ONLY the codes where a type silently degrades to `any`: a dead
  `import('…')` path (TS2307), a typedef-only script that isn't a module (TS2306), a
  missing export/typedef (TS2305/2614/2724/2694), a `.jsx` import without `"jsx"` in
  jsconfig (TS6142), and a JSDoc type NAME the file never imports (TS2304/2552/2503, counted
  only inside block comments; in code those codes are runtime globals). It also fails any
  JS file of a bun workspace (root `package.json` `workspaces`) that jsconfig's `include`
  leaves out of the program: such a file is checked by nothing here, and tsserver gives it an
  inferred project where every `@glyph3d/core/…` import types as `any` (TS7016). Baseline is
  zero, so any hit is a regression. ~4s.
  ```
  bun tools/type-imports-check.mjs
  ```
  Teeth, verified: a planted dead `CommandRouter.js` path, a missing typedef, a missing
  export, and an un-imported `{CodeGrid}` / `{THREE.Vector3}` each fail it, while an unknown
  runtime global does not; dropping `"jsx"` from jsconfig fails it 124 times; dropping
  `"wall"` from its `include` fails it once per wall file (23).

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

- **Code navigation: four lanes, each with a blind spot.** Ask the one built for the
  question, and say which you used:
  - **lsp.mjs — types.** hover, def, typed refs/impl. Sees a call only through a receiver
    whose type it knows (an untyped `ctx.x.getBounds()` is invisible to it).
  - **srcwalk — callers and access by NAME** (tree-sitter, no types; `bunx srcwalk …`).
    `trace callers <name>`, `trace callees`, `deps <file>`, `discover <text>`, `context
    <symbol|file:line>`. Fast (~40 ms) and receiver-blind: callers of `execute` are every
    method called `execute` (135 sites), and it walks `tools/` too. Its output is budgeted —
    a `+N more` line means pass `--no-budget` or `--offset N` before counting.
  - **ast-grep — structural match and saved rules** (`bunx ast-grep run -p '<pattern>' -l js`,
    rules in `tools/sg/`). Matches syntax, never strings or comments; a pattern says exactly
    what it means and nothing more (`$R.register($NAME, $$$)` also matches
    `registry.register(id, grid)` — constrain `NAME` to a string literal for verbs). Byte
    offsets in its JSON are UTF-8 bytes, not JS string indices.
  - **rg — raw text, the completeness check.** Every occurrence, including strings, comments,
    computed names and table rows the structural lanes can't see.
- **`verb.mjs`** — where a command-bus verb is handled and what it touches, structurally
  (ast-grep under the hood):
  ```
  bun tools/verb.mjs grid.move        # handler file:line, its ctx.* / host.* surface, helpers handed ctx
  bun tools/verb.mjs 'carrel.*'       # every verb under a prefix
  bun tools/verb.mjs --list           # every verb registered by a literal name (294 today)
  ```
  The surface is the handler's own span: `ctx.holding.lift`, `const { registry } = ctx`,
  one member past the receiver. Blind to verbs registered under a computed name
  (`panelCommands`' `verb(name, …)`, the layout overlay table — it then shows where the
  string appears, by rg, and says so), to what a helper does with `ctx` (named, not
  followed), and to aliases (`const c = ctx`).

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


- **`hand-model.test.mjs`** — the live hand model converges to the TRUTH from a cold start
  while the hand just wanders, and re-converges after the phone moves. `HandSim` (core) emits
  hand-wire v2 frames of a person using it (roaming, pausing, pinching, resting flat, moving
  fast, tilting — nothing announced) with known truth per frame; each goes through the real
  `decodeHandFrame` into `HandModel`. Asserts every quantity settles on the truth: bones
  (< 4 mm), palm length and hand size (< 2 %), the volume against the sim path's own
  percentiles, rest noise at the 5-joint centroid's σ/√5 from still moments it found itself,
  pinch modes with thresholds between them, palm orientation (< 6° raw); depthless tips
  rebuilt near the true joint; a bump detected within 1.5 s, the volume re-learned in the new
  frame, the bones kept, and a still phone never bumping; a warm start useful at once and a
  wrong one outweighed; two hands at once; which hand — a mislabelled burst and a palm-up
  stretch grow no ghost, a consistently mirrored label is reported (and fails with the anatomy
  vote off), a 2-frame blip never becomes a hand, a brief hand stays out of the warm start, an
  unseen hand reads idle; one held pose settles no bone; pinch learned from a real-use
  distribution (open spread 0.7–1.5 × palm length, 2 % pinches — what a variance split misses)
  and not from none; the skin depth learned from heights (the sim emits skin points); a hand
  off the reference skeleton (phalanges × 1.12) learned to < 4 mm; depthless curled tips rebuilt
  within joint limits (p90 below limits-off); a noisy joint's learned residual singled out; a
  pure slide caught by the accelerometer and desk rest never; the metrics on tracks with known
  jitter and delay; the stabilizer on realistic (depth-dominated) noise — a still hand < 0.5 mm p95
  at every joint vs ~13 mm raw, lag reported moving and tilting; range-aware bone evidence beating
  range-blind under range-growing noise; the pinch onset point rewound to before the closing
  motion; plus the numerics (decaying histogram forgetting +
  its split, Drift, Kabsch, ray–sphere) and the HandSpace stages on the model (auto 1€ hits its
  target jitter and states its lag, the spike gate (1 % 3 cm spikes held, a real step accepted),
  dead zone sized after the filter, one isotropic gain frozen once settled and
  re-learned on a new volume epoch, axes) and pinch hysteresis + release dwell.
  ```
  bun tools/hand-model.test.mjs
  ```
- **`hand-cloud.test.mjs`** — the LiDAR hand tracker (`hand/cloud/`) against KNOWN truth.
  `DepthSim` renders `HandSim`'s pose as the depth crop a phone sends: sphere-capsule hand +
  forearm under the ceiling in a 320×240 map, depth noise growing with range, a slow correlated
  bias, flying pixels and dropouts along edges, per-pixel confidence — in the exact wire form
  (`depthWire.js`, base64 u16 inside the handFrame), with Vision blind outside the image. Each
  frame goes through JSON, `decodeHandFrame` and `HandCloudTracker`. Asserts the wire
  (base64/u16 round-trip, project ∘ unproject, malformed blocks throw); segmentation against
  per-pixel part labels (hand precision ≥ 97 %, recall ≥ 90 %, no ceiling, the forearm cut at the
  wrist); the fitted palm normal (median ≤ 4°, p90 ≤ 7°, beats Vision's at the tail) and the raw
  plane (≤ 8°); every in-view fingertip named and near its tip; fitted in-view joints (median
  ≤ 3.5 mm, p90 ≤ 6 mm, ≥ 3× better than Vision's, in flat/tilt/pinch/wander); pinch closed ≥ 95 %
  and never open-wrong, the enclosed hole alone ≥ 80 % of closed frames and never on an open
  hand; without Vision, segmentation and the hole still work; the warmed per-frame cost.
  ```
  bun tools/hand-cloud.test.mjs
  ```
- **`hand-cloud-pipeline.test.mjs`** — the tracker's page side: `CloudPipeline` spawns the real
  module worker; its simulated phone's frames go through JSON + `decodeHandFrame` and back into
  the worker. Asserts results carry every stage, latest-wins replacement while busy (a burst of
  10 tracks the first and the newest), view planes come back as typed arrays and `CloudView`
  draws each layer (and nothing with every layer off), a knob reaches the worker.
  ```
  bun tools/hand-cloud-pipeline.test.mjs
  ```
- **`hand-replay.test.mjs`** — a recording round trip through the whole live hand pipeline: a
  simulated session in the relay's `source.record` JSONL format, replayed through the app's
  HandCalib (decode → model → merge → stabilizer → metrics → HandSpace). Asserts the acceptance
  target on the DISPLAYED hand over a mixed session — every joint's still jitter < 0.5 mm p95,
  lag while moving reported — that the stabilizer-off run jitters by millimetres, that variants
  compare side by side, and that the model still learns. `tools/hand-replay.mjs` is the tool
  itself (`--synth <s>` writes a simulated recording; real ones come from the relay).
  ```
  bun tools/hand-replay.test.mjs
  bun tools/hand-replay.mjs <recording.jsonl> [--variant "name:hand.stab.targetJitter=0.0003"] [--joints]
  ```
- **`hand-calib-app.test.mjs`** — the app's live hand model controller (`app/client/HandCalib.js`)
  on the real seams: simulated v2 frames through `SourceStream.injectFrame`, HandPresence's rig,
  nothing started. Before the model knows, the model-fed stages pass through and say why; after
  two minutes of wandering they run on the measured noise and volume; the warm start saves
  itself and a fresh controller (a reload) starts from it; `forget` drops it; a second device
  gets its own model; a Space knob reaches the live chain; the in-scene view rides the hand rig.
  ```
  bun tools/hand-calib-app.test.mjs
  ```
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

## The wall (`wall/`)

The wall's own Vite serves on :5180 (`cd wall && bunx vite`); its browser tools want a
PRIVATE relay (`--relay`), never the one a person's display is on.

- **`wall-layout.test.mjs`** / **`wall-labels.test.mjs`** (headless, `bun test`) — the wall's
  pure geometry (flow placement, framing, border grabs, cycling, border-drag resize) and its
  map-style label placement (no overlaps, preferred side, sticky, strict-then-relaxed, leader
  lines only when detached).
  ```
  bun test tools/wall-layout.test.mjs tools/wall-labels.test.mjs
  ```
- **`wall-store.test.mjs`** / **`wall-groups.test.mjs`** / **`wall-panels.test.mjs`** /
  **`wall-keys.test.mjs`** (headless, `bun test`) — the wall's per-relay memory (names, spots,
  hidden terminals, groups, the sidebar and the status window's place, pruned against the live
  set), its groups on a stand-in wall, its two side panels (where the sidebar and the status window
  dock, side by side on one edge; the status window's knobs checked as `wall.config`'s), and its
  keyboard on a stand-in wall (every key carries the `optionAsAlt` knob as it is when sent).
  ```
  bun test tools/wall-store.test.mjs tools/wall-groups.test.mjs tools/wall-panels.test.mjs tools/wall-keys.test.mjs
  ```
- **`wall-e2e.mjs`** — the wall end to end in a real-GPU browser: spawn, typing (Enter runs the
  line: the shell's output, not its echo), a real Shift+Enter running a line in a plain shell and
  reaching a Kitty-keyboard program as `CSI 13;2u`, and a real paste event arriving
  bracketed (termd encodes the browser's key events), ⌘[ ⌘]
  cycling, border and top-edge resize, title-bar drag vs body press, names, scrollback under
  the wheel, wheel zoom about the pointer, pinch zoom, map labels, the core terminal verbs,
  termd's status (the chip, the window by chord listing the wall's terminals, a brain restart held
  by stopping the holder: the amber restarting notice, then unreachable, both clearing, the shell
  typing after; docking and closing by verb), the hovered bar's hide and hold-to-close, hiding
  across a reload, the palette revealing a hidden terminal, lasso groups (tile, header drag,
  freeform, a killed member leaving), the sidebar (lists, folds, docks, persists), and the two
  panels together (docked on one edge side by side with the topbar clear of both, the status
  window's knobs in `wall.config`, a status row revealing a hidden terminal). Starts its own relay
  (`--relay-only`, termd namespace `glyph-wall-e2e` in a scratch dir, no gomuxai) if nothing
  listens on `--relay`, and stops it and its termd daemon at the end. `--shots DIR` saves the
  status window normal, restarting and unreachable, the bar buttons, a held close, the lasso, the
  groups, the sidebar, and both panels docked right.
  ```
  bun tools/wall-e2e.mjs --url http://localhost:5180/ --relay 8099 [--shots DIR]
  ```
- **`wall-gpu-attribution.mjs`** — where the wall's GPU frame goes: one layer toggled at a
  time (glyph fields, panels, scrollback depth) at OVERVIEW and FRAMED, timing the main pass
  with `EXT_disjoint_timer_query_webgl2`. Needs a relay already holding terminals.
- **`wall-text-perf.mjs`** — the terminal text path timed stage by stage (OUTPUT frame →
  parse → readScreen → applyScreen → GL uploads → GPU fence) in four passes: IDLE, FLOOD
  (direct and shell sources, 1/4/14 terminals), COLD (atlas misses), PROFILE. Needs a relay
  already holding max(--scale) terminals.
  ```
  bun tools/wall-gpu-attribution.mjs --url http://localhost:5180/ --relay 8099
  bun tools/wall-text-perf.mjs --url http://localhost:5180/ --relay 8099 --mode idle,flood
  ```
  The runner (tier gpu) gives both a fresh private relay, which holds no terminals, so both
  are recorded as known reds until they start their own.

## The terminal daemon (`crates/`, `g3d-termd`)

- **`cargo test --workspace --features g3d-termd/test-hooks`** — the Rust side (the daemon's test
  hooks exist only in a `test-hooks` build, so a release binary has none; without the feature the
  daemon's test binaries fail loud saying so): `g3d-wire` decodes and re-encodes
  PROTOCOL.md's hex examples byte for byte (read straight out of the spec) and filters terminal
  queries split at every byte; `g3d-hold`'s units (no fd of the holder's reaches a program, with
  close-on-exec or without; a shared-memory object reads back what was written); the daemon tests
  each on a private socket (`CARGO_TARGET_TMPDIR`; process state and RSS read with `ps`, so they
  measure on macOS too):
  repaints replayed into a fresh libghostty equal the live screen (primary and alternate, modes,
  cursor, title), one `INPUT` of 256 KiB reaching a raw program whole (past the kernel's PTY input
  queue), a subscribe cut mid-escape-sequence, the resize event's exact seq, queries
  answered once, `view` anchoring, history rows, a lossy subscriber resynced (one `lagged`, its
  repaint, the state), two stalled clients beside a BEL+title flood (daemon RSS bounded, the
  terminal keeps its pace), `take` freeing a wedged blocking owner (and the frame order of `take`
  and subscribe-as-own), a late subscriber told `modes` and the title, a blocking owner and
  a 4-terminal `seq 1 300000` flood with no seq gaps under an RSS ceiling (the brain's), a
  HUP-ignoring child, a panicking owner thread, the namespace lock, idle exit (also with an
  unwritable log), stop, a daemonized
  log rotating with the brain following it; the holder and
  brain (`tests/restart.rs`): a brain SIGKILLed under a flood (shells and handles kept, a quiet
  screen back exactly, the flood's history whole up to the snapshot and from the high-water mark,
  the gap exactly the reported unseen bytes), `upgrade` under a flood (all 300000 lines in the
  history across it, screens identical, ERROR restart at the exact cut), failed upgrades leaving
  the brain serving, a candidate dying after the commit (the next brain restores from the
  handoff, logged as that), a VT handoff across engines, a crash loop to `brain_failed` (a client
  that writes `HELLO` late still reads the `ERROR`, never `EPIPE`) and back on SIGHUP (the episode
  in `last_start.failed_at` and a `brain_failed` error), a terminal restored from a snapshot saving
  a new one while quiet (the next crash restores it exact), the watchdog, the holder's death hanging every shell up; the blob format's fixtures;
  the environment (`src/env.rs` unit tests, and `tests/env.rs`: a daemon started from a stripped
  environment with a stale `DISPLAY`, Terminal.app's and tmux's identity, a parent shell's state,
  `SIGINT` ignored, a low fd limit, a Claude Code shell's, atuin's, a unit's and launchd's variables
  and a scratch `HOME`; its programs' environ, argv and cwd (`tests/common/procinfo.rs`: `/proc` on
  Linux, `KERN_PROCARGS2` and `proc_pidinfo` on macOS, which withholds a platform binary's
  environment, so the program is the test binary itself), the signal masks and fd limit the
  program reports itself (`probe`: macOS can't show them from outside), and the `env` op's tags
  match the policy: a no-caller base of only the allowlisted names, each from the session source
  else the starter's value for that name (an app's `XPC_*` never), the account and `PATH` from the
  fill, a set non-UTF-8 locale kept and named in the status document, the passwd shell as
  `-<name>`, home, the locale filled only when none is set, reserved names, a malformed `env_base`
  and bad cwds refused, a caller's odd environment (stale `DISPLAY`, `REX_SESSION`, `FOO`) as the
  base minus its markers beside a no-caller terminal's fresh session `DISPLAY`, a stripped creator
  getting the session's handles, `termd.toml`'s `pass`/`drop`/`set`, a bad file failing creates
  naming its line and the status saying so, the session source re-read per create (a file standing
  in for the platform's source), and the real source beating a stale starter when one answers (the
  systemd user manager; on macOS launchd in a GUI session: its agent socket, `TMPDIR` and the
  `AppleLocale` locale, skipped outside one));
  the status document (`tests/status.rs`: its keys and types against
  `tests/fixtures/status-shape.json`, and PROTOCOL.md's example parsed field for field in
  `g3d-wire`; `status_follow`'s throttling — at once, then on change no sooner than the interval,
  quiet between keepalives, every interval while output flows, a rate crossing zero, one burst of
  output one change (not a window of them); a status-only follower doesn't hold an idle daemon and
  gets its `exiting` document, by which time the socket is gone and a new daemon can take the name; `stop`'s last document; a
  crash and an upgrade counted in the next brain's document);
  keys and paste (`src/keys.rs` unit tests and `tests/keys.rs`: a program that sets a keyboard or
  paste mode and prints what it reads in hex gets Shift+Enter as `CSI 13;2u` under Kitty flags and
  `\r` without (xterm's legacy chords: Ctrl+Enter `\r`, Ctrl+Shift+A `0x01`, Ctrl+Backspace `^W`;
  a NumLock-off keypad key navigates), modifyOtherKeys and DECCKM honoured, a paste bracketed
  exactly under mode 2004, a line break without it refused unless `allow_unsafe`, a `\r\n` one
  `\r` outside a bracket, a pasted `ESC [201~` unable to close the bracket; PROTOCOL.md's key table
  equal to the encoder's output);
  `g3d send`/`key`/`paste` against a private daemon, a 17 MB paste refused unsent as `too_large`
  (`crates/g3d/tests/input.rs`);
  and `g3d attach`/`watch`/`--take` driven through a real PTY (repaint, typing, no query reaching
  the outer terminal, detach; both riding an upgrade and a brain crash), `g3d new` sending its
  environment as the base (a stale `DISPLAY` and `FOO` arrive, `REX_SESSION` doesn't; `-e`;
  `--clean` taking the session's fresh `DISPLAY`; `-e NAME` with a non-UTF-8 value refused; a
  `PATH` holding `.` finding a program in the caller's directory) and `g3d env`'s tags, and the
  socket path the
  same from `env -i` as from a desktop environment. Cap the build: `CARGO_BUILD_JOBS=8` (`.cargo/config.toml`).
  ```
  tools/termd-vendor.sh [DIR]   # once: libghostty-vt + Zig, minisign-verified, into vendor/
  cargo test --workspace --features g3d-termd/test-hooks
  ```
- **`termd-relay-check.mjs`** (tier full) — the relay on termd with a simulated display: spawn +
  typing, a spawn with no argv from a relay carrying another terminal's identity (the account's
  shell as a login shell in the served root, termd's `TERM_PROGRAM`, none of the relay's identity,
  and `g3d env` tagging nothing `caller`: the relay sends no environment), `seq 1 300000` through termd → adapter → relay → display whole and in order, a relay
  restart (terminal survives, `terminal.recover` re-adopts it, the repaint carries the old
  screen, stopping the relay logs no termd loss, the adapter names the terminal's own program),
  `terminal.key` Shift+Enter and Ctrl+C reaching a Kitty-keyboard program as `CSI 13;2u` and
  `CSI 99;5u`, `terminal.paste` bracketed with an embedded `ESC` made a space,
  the wheel reaching a mouse-reporting alt-screen program before and after re-adoption, a
  SIGKILLed adapter (the relay re-adopts its terminal, typing works), a SIGKILLed termd brain and
  a `g3d upgrade` (every adapter rides them: no grid closes, no `LOST termd`, the repaint brings the
  screen back, `terminal.recover` mid-restart never answers empty), a SIGKILLed termd holder
  (adapters close their grids, the relay log says `LOST termd`, the next spawn starts a fresh
  daemon); termd's status reaching the simulated display with no per-terminal query (a
  `termd/status` push for each state the run passes through: absent, ok with the document and
  `relay.lacks` empty, one at registration after the relay restart, restarting then ok on
  generation 2 across the brain crash, lost when the holder dies; the display's `termd/status`
  request; the CLI's `termd.status`); and a second relay started from a stripped environment (a
  stale `DISPLAY` and bus address, `XDG_RUNTIME_DIR=/nonexistent`, another terminal's identity,
  `TZ`, a scratch `XDG_CONFIG_HOME`, `LC_ALL=C`) whose daemon asks the session source: its terminal
  gets the systemd user manager's handles (read-only; tagged `session (systemd-user)`) and none of
  the rest, or, with no manager answering, the relay's `DISPLAY` by name; on macOS (a stale
  `SSH_AUTH_SOCK` too) launchd's agent socket and `TMPDIR` (tagged `session (launchd)`), the
  relay's `DISPLAY` by name, and no `LC_ALL`, the environment read from `g3d env`.
- **`termd-fidelity-check.mjs`** (tier full) — the 29 vt conformance snippets
  (`tools/fixtures/vt-conf`) through termd: raw output byte-exact, and a late subscriber's repaint
  parsed by xterm equal to xterm fed the snippet (28/29; invalid UTF-8 differs because libghostty
  keeps U+FFFD where xterm drops the bytes).
- Go: `cd cli && go test ./...` runs the relay's termd client against a private daemon (it needs
  `cargo build -p g3d-termd`, or `G3D_TERMD_BIN`; `G3D_TEST_RUN_DIR` keeps its sockets out of the
  system temp dir): the holder's death is loud, a brain restart is ridden, and the relay's status
  connection (`TestTermdStatus*`) reads every state from its side of the socket (absent, ok,
  restarting across a crash, unreachable past the grace with the holder stopped, ok again with the
  orphans re-adopted, absent after `stop`, lost when the holder dies) and its display plane keeps
  only the latest notification; `termd_paths_test.go`: the socket directory found from the uid,
  the same with and without `XDG_RUNTIME_DIR` and `TMPDIR`.

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
detects the platform) · `g3d-termd` for terminals (built on Linux by `make termd`; macOS is TODO in
`docs/termd/DESIGN.md`).

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
  fine; give each its own `--termd-ns` (two relays in one namespace adopt each other's
  terminals).
