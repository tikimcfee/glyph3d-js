# AUDIT_DREAM.md — a fresh-eyes reframe, not a continuation

> Companion to `AUDIT.md`. The audit reads the codebase honestly and
> prescribes in-place cuts. This file does the opposite job: forgets
> what's there, asks what *should* be there, and names specific
> libraries, papers, and primitives that already exist in the world
> that would replace whole subsystems of glyph3d-js.
>
> Spirit: "monolithic gadget → composable set of extremely powerful
> primitives and tools." The dream is not a refactor plan. It's a
> reality-check on which of the codebase's 15,500 lines are actually
> *the work* and which are reinventions of solved problems.

---

## Thesis in one paragraph

glyph3d-js is, at its core, **three small ideas** that the current
codebase has scattered across ~70 named concerns:

1. **Text as a GPU-addressable spatial primitive** — atoms (glyphs)
   that you can paint, hit-test, group, and animate at instance level.
2. **An attention/intent kernel** — one universal "what is the user
   pointed at, what is being typed at, what is being looked at"
   substrate, plus a generic event-routed input pipeline.
3. **A data-loading pipeline that materializes files into 3D bodies**
   — providers, caches, layout strategies, mounts.

Everything else — the four layout managers, the four-way camera-fit
math, the deferred batching, the worker pool, the command router, the
context bag, the shell-as-DOM-orchestrator — is either (a) an existing
library reinvented, (b) glue that an ECS or a signal graph would
make disappear, or (c) chrome that doesn't need to be code at all
(it should be JSX or markup).

If we believe that, then "split the codebase" is not the move. The
move is **shrink the codebase by ~60% by replacing internal
abstractions with off-the-shelf primitives**, and let the remaining
~6,000 lines be the *actually novel* parts: the glyph-rendering core
and the attention kernel.

---

## What's genuinely novel and worth keeping handwritten

Before naming what to delete, name what we'd never delete:

- **Slug bezier text rendering + atlas/shape pipeline.** The
  `HarfBuzzShaper + Slug winding-number shader + RGBA16UI texture`
  stack (per `project_slug_rendering` memory) is the asset. Not
  msdfgen, not three-msdf-text, not BatchedMesh-with-bitmap-fonts.
  This is where the codebase earns its 60fps@thousands-of-files.
- **The attention kernel** (AttentionManager) as it currently
  exists — 190 lines, three slots, idempotent writes, monotonic
  timestamps. This is small and load-bearing and *correct*. It
  should be the seed crystal that the rest of the architecture
  re-crystallizes around.
- **The single-drain camera input pipeline** (VCC's
  `_makeInputState() → applyCamera(dt)` shape). The audit calls
  this "the most clearly architected substrate file." Agreed. This
  is the *pattern* the rest of the input system should converge on,
  not a thing to replace.
- **The GPU picking system.** Two-pass material-swap with 24-bit
  encoding. Three.js doesn't ship this. Off-the-shelf alternatives
  (`three-mesh-bvh`, raycaster, three-pathtracer's picking) all have
  worse cost characteristics at 1500-file scale. Keep.

Everything below is on the table.

---

## The reinventions, named

### 1. Layout managers → graph-layout libraries

The four layout managers (hierarchical / spiral / treemap / stack) are
*screaming* for existing graph-layout primitives. The audit treats them
as a strategy-pattern problem; that frames them as four custom
algorithms that need a switchboard. The truer frame: **three of them
are widely-implemented graph layouts and one of them isn't really a
layout.**

- **HierarchicalLayoutManager** → `d3-hierarchy` (`tree`, `cluster`, or
  `partition` depending on whether you want indented, radial, or
  treemap-as-tree presentation). 800 lines collapses to ~80 lines of
  config + a worker that runs d3 off-main-thread.
- **TreemapLayoutManager** → `d3-hierarchy.treemap` literally. Or
  `squarify` from `d3-treemap` directly. The "treemap labels" overlay
  is also solved (see `react-treemap` / `nivo/treemap` for label
  collision conventions).
- **SpiralLayoutManager** → degenerate case of `d3-force` with a
  custom radial constraint, or just `cytoscape.js`'s `concentric`
  layout. Or, frankly: a closed-form spiral function — 12 lines.
  The current implementation is 600+ lines because it's also
  computing the guide-line geometry and the camera-fit math and
  re-projecting bounds for the minimap. **All of those are separate
  concerns the layout shouldn't own.**
- **StackLayoutManager** is the odd one out. It's not a graph
  layout; it's an *interactive presentation mode* (z-stacked cards
  that fan on hover). This is `react-stacked-card-carousel` or
  `framer-motion`'s `LayoutGroup` shape. Or honestly: a tiny custom
  animator on top of `popmotion` (~50 lines).

Trade-off: d3-hierarchy and cytoscape both assume 2D and a DOM/SVG
output. We're 3D and instanced. So we don't take their renderers — we
take their **layout outputs** (x,y per node) and lift to 3D. That's
~30 lines of adapter glue per library. The win: ~2,000 lines of
in-house geometry math vanishes, and we get treemap-with-padding,
cluster-vs-tree, radial-vs-indented for free as configuration.

What we'd give up: the spiral that knows about z-wrap pagination
and the hierarchical layout that knows about backdrop+nameplate
overlays. **The overlays should never have been the layout's
problem.** They're decorators that subscribe to "node X is at
position Y." Detach them.

### 2. Color/state layering → ECS, signals, or both

`FileStateManager + CodeColorManager + SelectionManager +
HeatmapProvider + AttentionManager` is, exactly as the audit
hints, "an ECS in trench coat." But the audit recommends merging
SelectionManager into AttentionManager and keeping the rest as
separate managers. The dream version is more aggressive:

**Replace the lot with `miniplex` or `bitECS`.** Three components:

- `Attention { slots: 'hover' | 'primary' | 'key' | 'selected' }`
- `Color { layer: string, value: RGB, priority: number }`
- `Metadata { lineCount, sourcePath, heat, ... }`

Systems become:
- `AttentionInputSystem` — reads pointer/keyboard, writes Attention.
- `ColorResolveSystem` — reads Color components in priority order,
  writes a final `RenderColor` per entity.
- `MetricSystem` — reads file content, writes Metadata. Other systems
  (`HeatmapColorSystem`) read Metadata, write Color layers.

This is **idiomatic for game/render engines** and it's exactly the
shape `r3f` consumers use via `koota` (the spiritual successor to
miniplex, made by the same crew, integrated with R3F). The watch-
properties pattern in CodeColorManager is a worse, hand-rolled
version of ECS reactivity.

Alternatively: **signals**. `Solid.js` signals or `@preact/signals`
or `nanostores`. A grid's color is `computed(() => layers.value
.sort(byPriority).find(l => l.fn(grid))?.value ?? defaultColor)`.
Layers register by appending to a signal. CodeColorManager's
event-emitter machinery becomes implicit in the reactive graph.

Trade-off — ECS is heavier conceptually but maps perfectly to "many
entities, sparse properties, many systems." We have ~1500 grids,
each with ~10 conceivable property layers. ECS is *exactly* what
this is. Signals are lighter but topology-aware in ways that ECS
isn't (you can't easily "iterate all entities with this signal").
For glyph3d-js, **ECS first; signals for the chrome layer**.

Disagreement with the audit: it wants to merge SelectionManager
*into* AttentionManager. I'd merge them both into the ECS instead.
"Selection" as a permanent slot on AttentionManager bloats the
attention kernel with policy. As a `Selected` component or tag,
it's free and orthogonal. The attention kernel stays 80 lines.

### 3. Command router → mitt + nanoid + a 50-line parser

`CommandRouter.js` (225 lines), `WebSocketBridge.js` (529 lines),
the 24 handler modules, the context bag, `_installEntityKeystrokeDelivery`,
`_installConsoleForwarder` — this is a **JSON-RPC kernel with
autocomplete and shell parsing**, and the world has many of those.

The dream: replace the entire `app/commands/` directory + the
router + the bag with:

- **`mitt`** (200 bytes) for the event bus.
- **`nanoid`** for request IDs.
- **A 50-line shell parser** (or `shell-quote` from npm, 1KB) for
  argv splitting with quote handling.
- **`zod`** schemas per command for argument validation +
  autocomplete metadata.
- **JSON-RPC 2.0** as the wire format, exactly as it already is
  in WebSocketBridge — but treat that bridge as a transport, not
  a kernel.

A "command" becomes a typed function with a zod schema:

```
camera.move = command({
  args: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  needs: ['camera', 'cameraController'],
  handler: (args, deps) => { ... }
})
```

The kernel reads `needs` and supplies only those deps. The context
bag is gone — replaced by per-command dependency injection. Zod
gives us autocomplete metadata for free (the schema *is* the
introspection surface). `commander.js` or `citty` would also work,
but they're CLI-shaped; zod is more honest about the runtime
nature.

Trade-off: we lose the shell-flavored backslash/quote idioms unless
we keep `shell-quote`. We gain typed args, free autocomplete, free
validation errors, and the ability to call commands from JS without
parsing them ("router.execute" becomes "directly call the function").

What dies: the ~140-line `_installEntityKeystrokeDelivery` becomes
a few `mitt` listeners. The 30-line `_installConsoleForwarder` is
literally `console.log = pipe(originalLog, bridge.send)` — 3 lines.
The 504-line `app/commands/index.js` collapses to ~80.

### 4. Chrome (IDEShell, panels, drawer, command bar) → JSX (`r3f` + `leva` + `tweakpane`)

This is the most heretical claim in the document. Brace.

The whole `app/IDEShell.js + app/components/*` constellation — 2400+
lines — is **a DOM IDE that wraps a 3D canvas**. We are hand-rolling:

- An activity bar.
- A sidebar with resizable tabs.
- A bottom panel.
- A status bar.
- A command palette.
- A command bar (single-line input with history + autocomplete +
  attention-aware target).
- Settings panels (sliders for camera speed, drag sensitivity, atlas
  font size, layout spacing).
- A file tree.
- A search panel.
- A diff panel.
- An installer panel.
- A WS log panel.
- A state inspector.
- A groups panel with mini-map cards.
- A graph iframe wrapper.

Pick a UI library. **Any** UI library. The candidates:

- **`react-three-fiber` + `drei` + `leva`** — r3f wraps the 3D
  canvas as a React component; drei provides camera controls, HUD
  helpers, and (crucially) `<Html>` for placing DOM next to 3D
  positions; leva is a settings-panel library that *exactly* matches
  what VCC's sliders and the atlas controls do today. The 2400 lines
  of IDEShell + panels becomes ~600 lines of JSX. The "compat
  trinity" (`asDrawer / _hideOldUI / monkey-patch viewer.init`)
  doesn't exist because there's nothing to wrap — there's one
  React tree.
- **`shadcn/ui` + `react-arborist` (file tree) + `cmdk` (command
  palette) + `vaul` (drawer) + `react-resizable-panels`** — if we
  don't want r3f, we still get the entire DOM chrome for free.
  `cmdk` is what VS Code's command palette is built on. `react-
  arborist` is the canonical tree component. These are well-known
  solved problems.
- **`tweakpane`** alone could replace all the settings sliders
  (`#cam-speed`, `#drag-sensitivity`, `#scroll-sensitivity`, atlas
  font/size, layout spacing, minimap size). 5 lines per panel.
  No HTML factories needed.

Trade-off: we go from "no build step, plain ES modules, custom
shell" to "needs a bundler + framework dependency." That is a real
cost. It violates the `project_custom_shell_decision` memory ("keep
custom shell"). But that decision was made under the assumption
that the custom shell was a **small unique thing**. The audit
shows it's actually 2400+ lines of reinvented panels. The decision
deserves a fresh look.

**The harder question hiding here:** is glyph3d-js a *library* or
an *application*? If it's a library — and the package.json says
it is — then the IDE chrome shouldn't be in the repo at all. The
repo's job is to export `<GlyphCanvas>`, `<CodeGrid>`,
`<AttentionRoot>`. Consumers (the IDE deployment at
ivanlugo.dev/ide, the txtspc3d.space domain, the single-binary CLI)
build their *own* chrome with their preferred React/Vue/Svelte
toolchain. The IDE moves to `apps/ide/` (or out of the repo
entirely).

This is the **monorepo split**: `packages/glyph3d-core` (substrate,
~3000 lines), `packages/glyph3d-r3f` (React bindings,
JSX-friendly), `apps/ide` (the IDE deployment, all chrome).
<!--<!--HomeShell, GitHubRepoViewer, the home page — three apps consuming-->-->
one core.

### 5. The deferred-batch-and-flush pattern → reactive signals

`CodeGrid._addText / _removeText / _flush` plus `_pendingAdds /
_pendingRemovals / _pendingUpdates` is the **immediate-mode →
retained-mode bridge** pattern. It exists in every rendering library
ever. Three.js's own `BatchedMesh` (added 0.166+) does most of this.
But the per-glyph instance attributes are richer than BatchedMesh's
model, so direct adoption isn't easy.

The dream replacement: **fine-grained reactivity.** A `CodeGrid`
becomes a signal whose value is the current text content. Mutations
to text invalidate downstream computeds (buffer layout, line-slot
index, content bounds, caret position). The flush is implicit —
the next animation frame reads the computed buffer state, uploads
deltas. `Solid.js`'s `createMemo` + a custom `createGPUMemo` that
diffs and emits update ranges to `addUpdateRange`.

This eliminates:
- `_pendingAdds / _pendingRemovals / _pendingUpdates` maps
- The `_idMap / _reverseIdMap` machinery
- The dual `_flush / _flushAsync` paths
- The "in-flight + queued flags" coalescing in
  `_relayoutPreservingCursor`

What you write is "this is the text content as a function of
inputs." What runs is the minimal-diff buffer update. ~300 lines
collapses to ~80.

Trade-off: signals require a runtime (Solid, Preact signals,
`@maverick-js/signals`, ~5KB each). Worker boundary crossing
becomes more complex because signals are stateful on the main
thread. We'd likely keep the worker for the *initial* layout (where
the cost is) and have signals own the *incremental* update flow.

### 6. Worker pool → Comlink

`WorkerBridge.js` does round-robin job dispatch with promise-based
results and main-thread fallback. This is `comlink` (5KB, by the
Polymer team, ~10 years old, battle-tested). Every method on the
worker becomes a remote-callable function as if it were local.
Pool semantics (round-robin, hardware-concurrency sizing) become a
30-line wrapper around comlink. The fallback ("if Worker isn't
available, run inline") is a literal one-liner.

Trade-off: comlink uses postMessage with proxies; our current
WorkerBridge uses raw postMessage with structured-clone payloads.
For large transferable buffers (the Float32Arrays we ship around)
comlink supports transferables explicitly. Net zero perf cost.

### 7. State persistence → `nanostores` or `zustand`'s `persist`

`StatePersistence.js + stateController + watch-properties wiring +
localStorage event listening + STATE_DEFAULTS` is a hand-rolled
observable-store with persistence. `zustand` with the `persist`
middleware does this in 10 lines. `nanostores` with
`persistentAtom` does it in 5. Pinia, jotai, valtio — all solve
this.

Trade-off: a runtime dependency. Modest. Gain: cross-tab sync,
selective hydration, time-travel debug for free.

---

## Three patterns the audit treats as separate that I claim are one

The audit's 12 cross-cutting concerns are mostly accurate. But I
think it under-collapses three of them:

### "Selection" and "Attention" — these *should* merge, audit is right

The audit says: collapse SelectionManager into AttentionManager. I
agree. But going further: **drop the SelectionManager-as-Z-pop
behavior entirely**. The teal-tint + Z-pop on selection is a UI
convention from VS Code that doesn't necessarily belong in 3D. In a
3D code visualizer, "selected" might be better expressed as:
"focused-camera-target with a subtle outline halo." Three.js
`OutlinePass` from `postprocessing` does this in 5 lines.

In other words: don't *port* the desktop-IDE selection model.
Reimagine it for 3D. The audit assumes we're keeping selection-as-
desktop-IDE-thinks-of-it; the dream questions whether selection is
even the right primitive in 3D space.

### "Layout managers" and "Overlays" — overlays should never have been there

The audit puts overlays inside layout strategies ("overlays belong
to each layout strategy: hierarchical provides backdrops +
nameplates, spiral provides the guide line, treemap provides
labels"). I'd argue the opposite: **overlays are entirely
orthogonal to layout.** They're subscribers to "node X is at
position Y." A treemap label and a hierarchical-folder backdrop are
both `<Html position={node.position}>label</Html>` in r3f-land.

This shifts the substrate from "layout + overlay duo" to "layout
only, overlays self-mount based on metadata + subscribers." It's a
publish/subscribe model where the layout publishes positions and
the chrome subscribes per-feature.

### "Five capture-phase listeners" — not just consolidate, replace with intent

The audit says EntityInputRouter should own pointer priority,
ShortcutManager should own keyboard priority. Agreed. But the *real*
unification: **input becomes intents, not events**. Following the
VCC pattern: a frame-tick reducer that reads "what does the user
want" (drag-direction, pinch-amount, mod-keys-held) and writes
camera+attention deltas.

`use-gesture` (the React-flavored, framework-agnostic gesture
library) does this. `hammer.js` is the older sibling.
`@use-gesture/vanilla` works without React. We adopt it for the
pointer side, keep ShortcutManager-shaped for the keyboard side,
and the five-capture-listeners problem disappears because we have
two well-defined upstream sources (gesture + key) feeding one
intent stream.

---

## Where I disagree with the audit

A few specific places where AUDIT.md's recommendations feel
locally-correct but globally-suspect:

1. **The substrate/application/chrome trichotomy is artificially
   neat.** In practice, a *lot* of the code straddles. CommandBar is
   "substrate-quality chrome." VCC has slider UI embedded. The
   bucket assignment is informative but the *cleanup* doesn't have
   to honor it. In a JSX world, the substrate/chrome split happens
   at the package boundary (`@glyph3d/core` vs `apps/ide`), not at
   the file level. The "application" layer evaporates — there's
   substrate (libraries) and there's apps (chrome over substrate).
   Two layers, not three.

2. **The audit treats "Selection has four implementations" as a
   merge problem.** I think it's a *deletion* problem. Three of
   the four implementations exist because they were written before
   AttentionManager existed. Don't merge them; delete them and let
   AttentionManager be the only player. The Z-pop policy moves to
   chrome as an effect; the teal-tint is one Color component layer;
   the per-file `selected` boolean was always a misfit.

3. **The audit's "cut #1 — slice the bag" framing is sound but
   small.** It saves ~500 lines and clarifies coupling. The dream's
   cut #1 is "extract `@glyph3d/core` as a library, build the IDE
   in r3f on top." That saves ~5000 lines and changes the project's
   relationship to the world (other consumers can build their own
   3D code visualizers without inheriting our chrome).

4. **"CodeGrid is fine as is."** Agreed in terms of correctness.
   But CodeGrid is 1771 lines because it owns: content, batching,
   bounds, background, line-slot index, highlight, picking
   wiring, edit engine, caret rendering. That's not a class. That's
   a module. In the dream version, `<CodeGrid>` is a thin r3f
   component that composes `<TextContent>`, `<Background>`,
   `<Caret>`, `<HighlightLayer>`, each ~100 lines, each independently
   testable. Composition > god-object.

---

## The shape of the dream system

If you started from scratch today, what's the shape?

```
packages/
  glyph3d-core/              # ~3000 lines, pure substrate
    rendering/               # atlas, slug, shaper (KEEP — novel)
    instancing/              # CodeGrid as InstancedMesh manager
    picking/                 # GPU picking (KEEP — novel)
    workers/                 # comlink-wrapped builders
    attention/               # AttentionManager + ECS components
    layout/                  # adapters over d3-hierarchy / cytoscape
    providers/               # github / local / generic FS provider iface

  glyph3d-r3f/               # ~800 lines, R3F bindings
    <GlyphCanvas>            # the canvas + Scene + Camera
    <CodeGrid>               # composes core's renderer
    <AttentionProvider>      # context for attention slots
    <LayoutGroup>            # children get positions from a layout
    useAttention()           # hook for chrome
    useCommand()             # hook for command dispatch

  glyph3d-cli/               # ~500 lines, the Go binary (KEEP — already minimal)

apps/
  ide/                       # ~2000 lines down from 5000
    pages/ide.tsx            # r3f scene + cmdk palette + arborist tree
    panels/                  # leva for settings, tweakpane for atlas
    commands/                # zod-typed handlers
  home/                      # HomeShell, also r3f

shared/
  ecs/                       # miniplex world setup
  signals/                   # nanostores for cross-tab state
```

The Go binary stays exactly as is. It's already the simplest part of
the stack and does one thing well.

The big delta: about **9000 lines of JS code disappear into npm
dependencies**, replaced by maybe **2000 lines of new JSX/TS** and
maybe **300KB gzipped of well-tested libraries**. The novel
algorithmic content of the project — slug rendering, attention
kernel, picking system, GPU instance batching — survives at full
fidelity in `glyph3d-core` and gets *more* attention because it's no
longer drowning in chrome.

---

## What we give up if we do this

- **The no-build-step ethos.** ES modules served direct from the
  Go binary work today. r3f + zod + cmdk + arborist all assume a
  bundler. Mitigation: keep `glyph3d-core` no-build (it's library
  code, can be authored in plain JS), do `apps/ide` with vite. The
  Go binary serves the bundled output. We trade "edit a file,
  refresh" for "vite HMR" — arguably an upgrade.

- **Custom-shell pride.** The current shell is hand-rolled and
  bespoke. Switching to r3f means accepting React as a peer in the
  IDE. For a personal tool, this is fine. For "the project as a
  library other people use," it's actually *more* compositional —
  r3f's `<Canvas>` is a recognized entry point everyone already
  knows.

- **Some perf headroom.** Comlink has overhead vs raw postMessage.
  Signals have reactivity overhead. ECS has component-lookup
  overhead. In practice all three are well-optimized and our
  bottleneck is GPU bandwidth, not JS dispatch. But this is the
  honest trade — measure if it lands.

- **Familiarity.** The current author knows every file. After this
  reframe, ~60% of the behavior lives in libraries the author has
  to learn. The reading-list cost is real.

---

## What we gain

- **Composable primitives.** `<GlyphCanvas><CodeGrid>...</CodeGrid></GlyphCanvas>`
  is a primitive anyone can use. The audit's substrate/application/
  chrome distinction collapses to "library / app." Two layers, not
  three, and each is conventional.
- **Free features.** OutlinePass for selection halos. Pinch-zoom
  for free via use-gesture. Persistent state across tabs via
  nanostores. Treemap padding/spacing config via d3-hierarchy.
  Command-palette fuzzy search via cmdk's built-in fuse.
- **Less novel surface area to maintain.** The bus factor on the
  current router + bridge + bag + manager grid is ~1 (the author).
  The bus factor on mitt + zod + miniplex is the npm ecosystem.
- **Honest about what's load-bearing.** After the reframe, the
  remaining handwritten code is *specifically the GPU text
  rendering and attention kernel*. Those are the things that make
  glyph3d-js *glyph3d-js* and not "a 3D file browser." Everything
  else was incidental.

---

## What I'm least sure of

- **r3f vs vanilla.** R3F is the dominant pattern for "3D in
  React," but it has its own opinions (reconciler frame loop,
  ref-based imperative access) that may chafe against the existing
  single-drain camera input pipeline. If we want to keep VCC's
  shape exactly, vanilla Three.js + a chrome layer in
  Solid/Preact/htmx might be lighter. Personally I'd pick r3f for
  the ecosystem, but it's not obvious.

- **ECS vs signals.** Both work. ECS is more correct for "many
  entities, sparse properties." Signals are more correct for the
  chrome reactivity. I think the answer is *both*, with miniplex
  for the simulation/render layer and nanostores for the UI layer,
  but a single-paradigm approach (all signals, à la SolidJS) might
  be simpler.

- **Whether the IDE belongs in this repo at all.** Strongest
  version of this reframe: glyph3d-js *is* the library, and the
  IDE lives in a separate repo, a separate package, possibly a
  separate org. That clarifies the "library vs application"
  question by erecting a physical wall.

- **Whether the audit's `ProjectMount` and `LayoutController`
  primitives survive.** I think they do — they're shaped right —
  but they're application concerns, not substrate. They live in
  `apps/ide/`. The library exports the *building blocks*
  (`<LayoutGroup layout={hierarchical}/>` say), not the
  orchestrators.

---

## Closing

The audit is honest about what's in the codebase. This document is
honest about what *could replace* most of what's in the codebase.
Both are necessary; neither is sufficient alone.

The single sentence I'd want Ivan to carry forward:

> The novel ideas in glyph3d-js are the slug-bezier text rendering,
> the attention kernel, and the GPU-instanced picking. Everything
> else is reinventing libraries, and the leverage move is to lean
> on those libraries hard so that the novel parts have room to
> breathe.

If the reframe lands, the project changes from "a 3D IDE we built"
to "a primitive for 3D text rendering, and an IDE we built on top of
it that other people could build their own version of." Same
artifacts, different center of gravity. That's the dream.
