# glyph3d-native: the browser was the first host

*Companion to `mojo-native-gpu-peer.md`. That doc asked "how does a native GPU peer
help the web app." This one asks the deeper question: is the web app the product, or
is it the first host of an engine that wants to exist natively — our own rendering,
our own controls, no DOM, no SwiftUI, with the JS reduced to a curve cache or to
nothing at all.*

## The eviction list

Enumerate what the browser still actually provides to this system. The list is
shorter than it has any right to be, because the codebase has been quietly evicting
the browser for a long time:

| Browser service | Status in this codebase |
|---|---|
| Hit testing / DOM events | Evicted. GPU picking is the single source of truth; input is funneled to exactly two seams (`keyboardRouter`, `gestureResolver`) — both pure logic. |
| Widget behavior | Evicted. HUD is one-way state→view; every action is a bus verb. The DOM chrome *reflects*, it never *owns*. |
| Text shaping / fonts | Emulated. HarfBuzz is a C library; the WASM build is the workaround for being inside a browser, not the natural form. |
| Layout / rendering semantics | Owned outright. The pipeline has its own executable specs (oracle → scan); TSL is a *backend* of the spec, not the source of truth. |
| WGSL compilation, render pipeline, swapchain, compositor | Still the browser's. This is the real dependency. |
| The sandbox | The thing we *pay* for: device-loss reload loops, sessionStorage guards, layout-suspension machinery, worker/postMessage gymnastics, no mmap, no threads, storage-buffer limits negotiated one descriptor at a time. |

Every hard-won discipline in CLAUDE.md — no CPU fallback, integer rows, byte-addressed
particles, fail loud at substrate seams — is engine discipline, not web-app
discipline. The device-loss-recovery apparatus is compensation for being a guest in
someone else's process. Native, we're the host, and that entire subsystem stops
needing to exist.

## The rendering question, honestly

Mojo's GPU model is compute-only: no graphics pipeline, no render passes, no
swapchain. For a general engine that is disqualifying. For *this* engine it is nearly
free, and it pays twice:

- **Glyphs are analytic coverage, not triangle soup.** Slug already evaluates bezier
  winding/coverage per pixel in a fragment shader; the hardware rasterizer
  contributes only quad coverage and depth. A tile-based compute rasterizer is the
  textbook shape for exactly this: bin glyph quads to screen tiles → order within the
  tile → evaluate coverage per pixel from the curve cache → write a storage image.
  MSAA is irrelevant (coverage is analytic). We lose nothing the hardware raster was
  giving us.
- **Picking falls out for free.** Today picking is a whole second ID render pass
  (`picking/`). A compute rasterizer writes glyph ID and grid ID into side channels
  of the same tile pass. One traversal, both answers.
- **Z-order/transparency gets easier, not harder.** The standing transparency reorg
  (`z-order-transparency-reorg.md`) fights three.js renderOrder. Per-tile ordered
  composition *is* the transparency answer in a compute rasterizer — the problem
  becomes a sort we control instead of a convention we negotiate.

The unglamorous seam is **presentation**: Mojo fills a storage image; something must
put it on glass. Stage 0 is a CPU readback blit through a minimal C shim (SDL3 +
Metal/Vulkan) — ~33MB/frame at 4K, trivially fine for a prototype, near-free on Apple
unified memory. Stage 1 is per-platform shared-surface interop (CUDA↔Vulkan external
memory on NVIDIA, Metal texture on Apple). This shim is the only genuinely new
engineering with no existing spec in this repo, and it should stay under a few
hundred lines of C on principle.

## The spine survives: DISPLAY is an ABI

The relay's display handshake is the string `DISPLAY` on a WebSocket
(`cli/relay.go`), then JSON verbs in, responses and log records out, binary terminal
frames, `source.frame` events. The relay is already substrate-blind. A native engine
that speaks that handshake **is** the display — the CLI, controllers, terminals, log
store, and the sensor plane all keep working, byte for byte, with no idea Chrome
left the building.

So nothing forks. The Go binary stays the spine. The command bus stays the one source
of truth. The browser demotes from *the* display to *a* display.

## What the JS becomes

Three honest endpoints, and "data → glyph curve cache" is not quite any of them —
natively, HarfBuzz and FreeType are home, so even shaping doesn't want to stay in JS:

1. **The conformance suite.** `glyphPipelineReference` and `glyphPipelineScan` are
   executable specs. They stop shipping and start *judging*: every native kernel is
   proven against them, forever. What's irreplaceable in the JS was never the code —
   it's the proofs.
2. **The reach display.** The web build keeps existing as the zero-install remote
   frontend — native engine at the desk, browser on the iPad, both speaking DISPLAY
   to the same relay. This is the likely steady state.
3. **Gone**, with only the specs surviving. Also legitimate.

## What native unlocks

- **mmap the workspace.** "One slot per byte" becomes literal: the byte pipeline
  folds over page-cache pointers. `file.open` is an mmap plus a fold — no socket, no
  copy, no load storm to instrument.
- **Own the device.** VRAM pressure is a resize we handle, not a page reload with a
  once-a-minute loop guard. The occlusion fault guard, the reload recovery, the
  suspension machinery — deleted, not ported.
- **Persistent residency.** The glyph arena outlives any tab; a workspace stays warm
  on the GPU for days. Sessions become attach/detach (the tmux model, applied to the
  scene itself).
- **Real threads.** WorkerBridge and its DOM-free-builder discipline dissolve into
  ordinary shared-memory parallelism.
- **Real profiling.** The long-task watcher and load-storm heuristics become perf
  counters and GPU timestamps.

## Milestones

Each one shippable, each one falsifiable:

- **M0 — the scan twin** (P1 of the companion doc). Reframed: not a test rig, the
  engine's first module.
- **M1 — the headless frame.** A Mojo binary: file bytes → pipeline → native
  HarfBuzz curve cache → compute rasterizer → PNG. Diff it against a browser
  screenshot of the same file. No window, no input, no protocol — and it proves the
  entire vertical: shaping, layout, raster, the curve cache format. This is the
  milestone to aim the first real effort at; it is shockingly small relative to what
  it settles, and it *measures* the compute-raster cost instead of trusting it.
- **M2 — glass.** The C present shim + a frame loop + the keyboard responder chain
  ported (it's pure logic; it ports as-is, tier list and all).
- **M3 — become the display.** Speak `DISPLAY` to the relay. `glyph3d-cli file.open`
  drives the native engine. Terminals adopt. The sensor plane streams in.
- **M4 — chrome as grids.** CommandBar as an input grid, the tree as grids, HUD as
  glyphs — the project's own thesis, finally applied to its own chrome. Dockview
  world retires, or stays web-side as the reach display.

## Risks, plainly

- **We'd be first.** Mojo's open compiler is a week old; its graphics-adjacent
  ecosystem is zero. C interop is `external_call`/`DLHandle`-grade — the present shim
  and the HarfBuzz binding are hand-rolled. For a single-operator tool this is play
  space; it is still true.
- **Apple GPU support is "initial"** (macOS 15+, basic kernels, Metal via AIR
  bitcode). NVIDIA/Linux is the strong path today — which matches the dev box.
- **Compute-raster perf is a claim until M1 measures it.** Analytic coverage per
  pixel is more ALU than Slug-behind-hardware-raster; tiling fixes locality, but the
  number decides, not the argument.
- **Surface area.** Engine + shim + shell is a lot of first-party code. The
  mitigations are structural: the specs already exist, the protocol already exists,
  and every milestone leaves the current system fully working.

The through-line: nothing in this plan is a rewrite of glyph3d. The pipeline specs,
the command bus, the relay, the attention model, the responder chain — all of it
carries over untouched, because none of it was ever web-specific. The only thing that
gets rewritten is the one layer that was always rented: the host.

## The residue: what stays bound to the display

If rendering becomes a consumer, what — if anything — remains genuinely bound to the
browser or to a display at all? Interrogating every candidate leaves four real
residues and one latent binding. None of them is the render pipeline.

**1. The millisecond loop is bound to display-adjacent silicon. Physics, not
architecture.** Photons come off the GPU wired to the panel, and the interactions
that must close in ~10ms — hover, caret, camera, pick — must close *there*. If a
display consumed rendered frames from remote compute, every hover would ride a
network round trip and the instrument would die. The repo already holds the answer,
and it's the sharpest consequence of "rendering is a consumer": **ship seeds, not
scenes.** `glyphBake` proves the entire layout is recoverable from bytes + trie +
checkpoint records — kilobytes of monoid summaries standing in for megabytes of
positions — and the fold is cheap and pure enough to re-run on *any* display's
silicon. The wire protocol is bytes + bakes + verbs, which is what the relay already
carries; the browser display already works this way (loads bytes, folds locally).
So the residue at each display is small and fixed: the fold, the coverage raster, the
pick, the present. Everything upstream — bake, semantics, orchestration, recognition,
placement — runs on whatever silicon is lying around. Any silicon, exactly: the fold
was designed to not care.

**2. Text composition (IME) — the one surrendered subsystem.** `keyboardRouter`'s own
header confesses it: "when a real `<input>`/`<textarea>` holds focus the whole chain
yields." Raw keys are solved (`keyEncoding`), but *composition* — dead keys, CJK
IMEs, the emoji picker, voice input — is a conversation with the host OS's input
method, conducted in the host's locale, rendered near the caret. The browser provides
it through DOM inputs; a native glyph-rendered CommandBar must either re-own it
(per-platform IME APIs: serious, unglamorous work) or keep delegating it (a host text
field floated over the scene during composition — the same yield, made explicit).
This is the single biggest thing the browser still does for us that nothing in the
repo replaces.

**3. Accessibility — pixels carry no semantics.** A glyph-particle UI has no a11y
tree; the DOM's broken-but-present one is a browser service we'd silently lose.
The honest fix is the same reframe again: the engine already *is* the semantic tree —
registry, attention slots, cursor ranges, verbs — so a11y becomes an exporter from
engine state to each host's accessibility API, a presentation adapter beside the
raster consumer, not a redesign. It has to be chosen, though; it will not fall out.

**4. The URL as installer.** The browser's one unassailable property is social, not
technical: zero-install reach. `make build` hands anyone a workspace at a link. That
argues for keeping the web build alive as the reach display — never as the reference
implementation.

**The latent binding: rAF is currently the only scheduler.** Everything beats at the
render loop's rate today — layout dispatches, attention, `HandPresence` sampling all
ride vsync because the browser gives one clock. Unbinding rendering means the engine
owns its own tick and *vsync demotes to each consumer's sampling rate*. The codebase
already models the right shape in miniature: `HandPresence` samples sources
"pull-style once per rendered frame" — presentation pulling from state, never state
pushed by presentation. Generalize that and the frame clock stops being the system's
heartbeat and becomes what it always should have been: one subscriber's refresh rate.

Answer to the question, compressed: nothing of the *system* is bound to the browser.
What's bound to a display is what was always bound to a display — photons, fingers,
and the locale of the person touching it — and the repo's own math (the fold, the
bake, the bus) makes that residue a consumer kernel plus two host adapters (IME,
a11y) instead of an application.
