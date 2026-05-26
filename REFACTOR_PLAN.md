# Refactor: audit, then recompose the IDE around the visualizer substrate

> This doc bootstraps a fresh session. Read it end-to-end before doing
> anything else. It encodes both the goal (where we're going), the
> method (how we get there without making it worse), and the state
> (what's already done so we don't redo it).

## Intent

Two abstractions are currently tangled inside `app/` and conflated by
`GitHubRepoViewer`:

- **Visualizer (substrate)** — a 3D canvas full of addressable objects.
  Atlas, shape, slug, CodeGrid, layout primitives, camera, picking,
  reference space, command router, WebSocket relay. Stable, composable,
  ECS-shaped: every named thing has an id, components attach to it,
  systems iterate without owning lifecycles. Almost everything in
  `src/` is already substrate-quality.

- **IDE (application + chrome)** — file tree, tabs, breadcrumbs, status
  bars, repo loading, diff panels, hand-tracking, agent integration,
  settings. Application logic that *consumes* the visualizer. Currently
  fused into the 2,380-line `GitHubRepoViewer` + `IDEShell` + a fleet
  of `app/components/*` that reach into the viewer.

The work: separate them. Treat `app/home/` (the recent landing page
+ layout kit + reference space + camera framing) as the **substrate
crystal** — the shape the visualizer wants to be. Then refactor the
IDE into thin consumers of that substrate. **Cannibalize, never
rebuild in parallel.**

The dependency graph we want:

    chrome  →  application  →  substrate
    (panels)   (ProjectMount,  (Viewer3D, layout kit,
                glue, demos)    camera, picking, atlas)

Anything that flows the wrong way is a refactor target.

## Why this matters (predictions worth testing)

- The per-glyph iteration glitches on the v4 backend, the InstancedMesh
  measurement gap (fixed by `CodeGrid.layoutBounds()`), the awkward
  `_lineSlotBase` + highlight indexing — these probably aren't
  fundamental complexity. They're accumulated coupling, surfacing as
  rendering bugs. Once separation is clean, the renderer's job shrinks
  and these likely become testably correct rather than empirically
  iterated.
- The user feedback Ivan quoted ("middle-click+drag doesn't pan when an
  object's in the way", "scrollwheel can only pan up/down", "minimap is
  too coarse") reads exactly like the IDE's input/selection logic
  fighting the visualizer's pan/zoom. After separation the visualizer
  says "drag = pan", and the IDE opts into hijacking that under
  specific conditions (e.g. shift-click on a grid = select).

## Method (the part where I behave)

1. **Read full files. No summaries. No grep-as-reading.** JS lacks
   AST/LSP query tooling here; we substitute by reading completely.
   When auditing a file, the assistant reads it top to bottom — no
   `sed -n`, no `grep` substituting for the prose comments that carry
   the original intent. Grep is fine for *locating* a starting point,
   not for "knowing" what a file says.

2. **Bucket every concern.** For each meaningful chunk of code (a
   method, a wired event, a piece of state), tag it as:
   - **substrate** — belongs in `src/`, consumed by everything
   - **application** — IDE-specific glue, consumes substrate
   - **chrome** — DOM/UI widget, listens to events, owns no scene
     state
   Note the dependency direction. Anything chrome→substrate or
   application↔chrome direct is a refactor target.

3. **Surface intent before structure.** For each concern, write down
   what it WANTS to do, not just what it does. The leapfrog opportunity
   is to express that intent through a cleaner primitive once we know
   what the primitive is. Example: `_lineSlotBase` wants "given a
   character position, where in the buffer is its glyph?" — that's an
   addressable-glyph query, not a free-floating array.

4. **Let the map tell us the order.** Don't pre-decide which cut to
   make first. The map will reveal:
   - Which concern is *most isolated already* → easiest first win
   - Which is *most depended-upon* → highest leverage, riskier
   - Which is *most tangled* → save for after substrate is established

## Deliverable: the Audit Map

A single document (suggested path: `AUDIT.md` in repo root, or
`audit/MAP.md` if it grows multiple files) with this shape per
concern:

    ### <concern name> — <short description>
    **File(s):** `path/to/file.js:line-range`
    **Bucket:** substrate | application | chrome
    **Reaches into:** [other concerns it touches]
    **Intent:** what it wants to do, in 1-2 sentences
    **Current shape:** how it's actually implemented
    **Refactor note:** what should change, or "leave alone"

Cheap to scan, expensive to skip. Without it we make local cuts that
look right and find the global graph still tangled.

## State of play (don't redo this stuff)

### What's already substrate-quality (mostly in `src/`)

- **Rendering** — `GlyphAtlas`, `CodeGrid`, `GlyphRenderer` (WebGL),
  `GlyphField` (WebGPU; not currently used by IDE), `GridVirtualizer`
- **Shaping** — `HarfBuzzShaper`, `MonospaceShapeCache`, `SlugEncoder`
- **Camera** — `ViewerCameraController` + `SceneContext` (the home page
  now uses this — same controls as IDE)
- **Picking** — `PickingSystem` (GPU material-swap, character-level)
- **Data access** — `RemoteFileSystemProvider`, `RepositoryAdapter`,
  `GitHubRepositorySource`, `RepositoryContentCache`,
  `textFileFilter`
- **Layout managers (older subsystem)** —
  `GridLayoutManager`, `HierarchicalLayoutManager`, `SpiralLayoutManager`,
  `TreemapLayoutManager`, `StackLayoutManager`. These predate the
  home-page layout kit; some are still useful (treemap for big repos),
  others may be superseded.
- **Layout kit (new)** — `app/home/layout/` —
  `Layout`, `Center`, `HStack`, `VStack`, `ZStack`, `Spacer`, `Anchor`,
  `measure`, `viewport.frameBox`/`frameNodes`. SwiftUI-flavored,
  composes Object3Ds, depth-first `layout()` pass. **This is what we
  want the IDE to use too.**
- **Command system** — `CommandRouter` + `app/commands/handlers/*` —
  modular, dot-namespaced, async-aware. The handlers are already
  separated; the *context bag they consume* is where IDE coupling lives.
- **Bridge** — `WebSocketBridge` — auto-reconnect, JSON-RPC,
  controller channel, console forwarding.
- **Registry** — `SceneRegistry` — stable id ↔ Object3D mapping.
  Already the ECS-flavored "addressable" piece.
- **Reference space** — `app/home/ReferenceSpace.js` — coarse+fine
  grid + fog + far-points. Drafting-paper substrate.

### What's tangled (the refactor targets)

- **`app/GitHubRepoViewer.js`** (2,380 lines) — the god class. Mixes
  scene setup, atlas boot, repo loading, grid creation, picking,
  selection, shortcuts, drawer creation, panel wiring, status bar
  feeding, hand-tracking adapter, source-mode switching. Almost
  everything in here wants to be either pure substrate boot
  (deduplicated with HomeShell) or a thin application-layer module.

- **`app/IDEShell.js`** — the DOM orchestrator. Creates the activity
  bar, sidebar, status bar, command palette, panel content, breadcrumb
  bar. Tightly coupled to GitHubRepoViewer.

- **`app/components/*`** — Drawer, CommandBar, DiffPanel, GroupsPanel,
  InstallerPanel, LogCapturePanel, SpatialNavigator, StatePanel,
  TouchController, AppShell. Mix of chrome (good — listen to events)
  and chrome-that-mutates-viewer (bad — refactor toward passive).

- **`app/commands/index.js`** — `buildContext(viewer)` packs all
  viewer.* references into a giant context bag. Handlers receive
  this and reach into it. The handler files themselves are mostly
  clean — the bag is the coupling.

### What we just built (and committed, on `main`)

Six commits ahead of `origin/main`. None pushed. (Push only on user
request.) Recent log:

    9c71434 home: engine-showcase demos (layoutmorph, repo) + cluster redraw
    dab5cf0 home: viewport framing + IDE camera controller
    7e4f377 home: new landing surface — visitor cluster, layout kit, reference space
    20996c6 cli: add fullsnapshot subcommand — Firefox BiDi captureScreenshot
    de66a59 CodeGrid: add layoutBounds() — local AABB for composable layouts
    faf1967 ide.html: don't treat the shell's own /ide/app/* URL as a repo path

The home page is the substrate crystal. It boots cleanly without IDE
chrome. It uses the kit we want the IDE to use. It uses the camera
controller we want the IDE to use. **Don't touch it during the
refactor except to consume new substrate it gains.**

### What's deferred (don't restart these)

- **demo.colors** — per-glyph iteration on the v4 GPU backend is flaky
  for end-of-line glyphs. File was deleted. Will return naturally if
  the rendering simplification predicted above lands.
- **demo.constellation, demo.orbit** — pending tasks, deferred. Pick
  these up only after the refactor delivers visible wins; they're
  polish, not foundation.

## Where to read, in order

Read these completely. No grep substitutes. Track findings as you go.

1. **`app/GitHubRepoViewer.js`** — the big one. ~2380 lines. Read top
   to bottom in one pass. Every constructor field, every method, every
   inline event handler. Note: each `case X:` in subsystem dispatch is
   its own concern.
2. **`app/IDEShell.js`** — the DOM orchestrator.
3. **`app/commands/index.js`** — especially `buildContext` and
   `_installEntityKeystrokeDelivery`.
4. **`app/commands/handlers/index.js`** — registry; then sample a
   handful of handlers (one per namespace) to confirm the modular
   shape and find the coupling: `cameraCommands.js`,
   `gridCommands.js`, `highlightCommands.js`, `spatialCommands.js`,
   `attentionCommands.js`, `editCommands.js`.
5. **`app/components/*.js`** — every file. They're small (each <500
   lines, mostly).
6. **`app/ide.html`** — the bootstrap. Important: it's where the
   orchestrator calls things; reveals what the IDE *actually* does at
   boot vs. what GitHubRepoViewer claims.
7. **`src/services/orchestration/CommandRouter.js`** — context bag
   consumer surface.
8. **`src/services/orchestration/WebSocketBridge.js`** — already used
   by home page; confirm assumptions.
9. **`src/services/SceneContext.js`** — what subsystems expect to see.
10. **`src/services/camera/ViewerCameraController.js`** — the camera
    home page already uses; understand its full surface so we know
    what IDE-specific bits to add (focus-lock, attention probe).
11. **`src/collections/CodeGrid.js`** — substrate, already mostly
    clean, but big. Read all of it; it's the most important entity.
12. **`src/services/data/*`** — all of them.
13. **`src/services/interaction/*`** — `SelectionManager`,
    `ShortcutManager`, `AttentionManager`, `CodeColorManager`,
    `ReaderCompass`, `EntityInputRouter`.

That's the audit corpus. Expect ~6,000-8,000 lines of careful reading.

## Candidate first cuts (don't pick until the map is done)

These are guesses, listed only so we know what shape the refactor
takes. The map may reorder them or introduce others.

1. **Extract `Viewer3D` core** — substrate-level scene/atlas/HarfBuzz/
   slug bootstrap. Both `HomeShell` (already does this inline) and a
   future `ProjectViewer` (refactored GitHubRepoViewer) consume it.
   Deletes ~150 lines of duplicate init from the IDE.

2. **Replace `buildContext` with a leaner substrate context.** The
   current bag couples handlers to the IDE. Substrate context exposes:
   scene, camera, renderer, atlas, registry, bridge, getGrids,
   attentionManager, layoutKit, frameNodes. Application/chrome state
   (fileStateManager, codeColorManager, spatialManager,
   layoutManagers, diffController) moves into application-layer
   plug-ins that handlers opt into.

3. **`ProjectMount` module** — what the home page demos.repo prototyped.
   Loads a repo via `RepositoryAdapter`, creates CodeGrids, hands them
   to a `LayoutStrategy` (hierarchical/treemap/etc — strategies, not
   inline calls), mounts into scene. Replaces the relevant ~400 lines
   in GitHubRepoViewer.

4. **Panels become passive widgets.** Drawer, sidebar, status bar
   listen to substrate events (`camera-changed`, `grid-registered`,
   `selection-changed`) and render. They stop reaching into the
   viewer. Each is its own file under `app/components/` consuming
   only the substrate event bus + Bridge.

5. **The `app/components/CommandBar.js`** (the 28px IDE one) becomes
   a styled instance of the home page's `HomeCommandBar.js`. One bar
   type, two skins.

6. **GitHubRepoViewer disappears** — replaced by a thin `ProjectViewer`
   that composes `Viewer3D` + `ProjectMount` + the panel registry.
   The 2,380 lines shrink to ~300, and that 300 is mostly wiring.

## Principles (the parts we keep reminding ourselves of)

- **Quiet craft** — small effects, restrained, beautiful. The work is
  the offering. See `feedback_aesthetic_quiet_craft.md`.
- **Cannibalize, don't rebuild.** Before any new app-level module,
  search `src/services/` for an existing primitive. See
  `feedback_cannibalize_existing_infra.md`.
- **No compat shims, no aliases.** Atomic rewrites surface intent
  mismatches. See `feedback_no_compat_shims.md` and
  `feedback_no_aliases_atomic_renames.md`.
- **Compose, don't configure.** Prefer small composable types over
  big flag-driven ones.
- **Addressable objects.** Every named thing has a stable id. Systems
  iterate without owning lifecycle.
- **No half-done state.** Each refactor cut leaves both the substrate
  and the consumer in a coherent state. If we can't ship the cut
  cleanly, we don't make it yet.

## Live dev loop (already working, keep using)

- **Server:** `./glyph3d-cli serve --local --port 9876` running in
  background. Log at `/tmp/home-serve.log`. PID at
  `/tmp/home-serve.pid`.
- **Firefox launch (WebGPU):** use `tools/dev-firefox.sh` — do NOT launch
  Firefox plain. The app renders via `THREE.WebGPURenderer` (GlyphField),
  and on this dual-GPU box (NVIDIA dGPU + AMD iGPU) a plain launch crashes
  Firefox's WebRender compositor (SIGSEGV on `WRRenderBackend`). The helper
  pins the process to the NVIDIA GPU (`VK_ICD_FILENAMES` + `__NV_*`) and
  forces the WebGPU prefs via a dedicated profile's `user.js` (BiDi on
  `9222` included).
  ```
  tools/dev-firefox.sh                 # home.html on :9876
  tools/dev-firefox.sh app/ide.html    # a different page
  ```
- **Send commands:** `echo "<cmd>" | ./glyph3d-cli --port 9876`
- **Snapshot the live page (DOM + canvas):**
  `./glyph3d-cli fullsnapshot -o /tmp/snap.png`
- **Trigger reload (livereload doesn't watch new dirs created after
  server start):** `echo "reload" | ./glyph3d-cli --port 9876`
- **Read forwarded logs:** `tail -30 /tmp/home-serve.log` — browser
  console + uncaught errors land here as `[browser:level]` lines.

The home page is served at `http://localhost:9876/app/home.html`.
The IDE is at `http://localhost:9876/app/ide.html`. **Read both at
the bootstrap level when doing the audit.**

## Anti-patterns to avoid this round

- Don't read a file and then "remember" it from grep output. Read it.
- Don't propose a refactor before the map is mostly complete — local
  cuts compound the tangle.
- Don't rebuild a substrate primitive that already exists in `src/`.
  (RepoLoader was this trap last session.)
- Don't ship a refactor cut that leaves the IDE in a half-state. Each
  cut is atomic: substrate gains a primitive, consumer is migrated,
  old path is deleted, working tree is green.
- Don't decide ordering before the map. The map's job is to reveal it.

## Open thread: "leapfrog from intent"

Ivan's specific framing: the refactor isn't just recompose, it's
*iterate from core intents surfaced by the original code to harder
implementations with specific use cases*. As we read, note when a
concern's WHY suggests a sharper primitive than its current HOW. The
audit-map entry's **Intent** line is where this gets captured.

Example: "selection state" currently lives across `SelectionManager`,
`fileStateManager.selected`, `CodeColorManager` selection layer, and
`AttentionManager`. The intent is "what entity is the user focused on,
and how does the visualizer signal that?" — that's one concept, four
implementations. The leapfrog move is a single
`AttentionManager`-or-successor primitive everything else consumes.

## After this plan: the next session

1. New session reads this doc first.
2. New session reads the audit corpus in the listed order, in full.
3. New session writes `AUDIT.md` (or `audit/MAP.md`) as it goes.
4. We meet at the map and pick first cut together.
5. Then we cut, ship, repeat.

The map IS the contract for the refactor. Don't start cutting before
it's mostly done.
