# CLAUDE.md — Project Guide for AI Assistants

## What this is

glyph3d-js renders thousands of text glyphs in 3D at 60fps via GPU instancing on a
WebGPU renderer — built for navigating source code, directory trees, and live
terminals in 3D space. The repo is organized as **a package, an app, and a cli**:

- **`packages/glyph3d-core`** (`@glyph3d/core`) — the publishable rendering library:
  glyph atlas + shaping, the `GlyphField` WebGPU renderer, `CodeGrid` / `TerminalGrid`,
  layout managers, picking, tree-sitter parsing, and the command/interaction services.
- **`packages/glyph3d-r3f`** (`@glyph3d/r3f`) — react-three-fiber bindings for the core.
- **`app/`** — the IDE: a react-three-fiber client on the core. File tree + 3D code
  grids + terminals + dockable panels, driven by a command bus. `app/client/` holds the
  shared chrome (CommandProvider, CanvasInteraction, HudPanel, CommandBar, SessionStore,
  WorkspaceModel); `app/commands/` holds the command spine (handlers).
- **`cli/`** — a Go single binary that bakes in the built app and serves it alongside a
  WebSocket relay, sandboxed filesystem RPC, tmux-backed terminals, and an LSP supervisor.

## Tech stack

- **JavaScript** (ES modules), **JSDoc** for types — no TypeScript.
- **Three.js via `three/webgpu`**; shaders are **TSL** (Three.js Shading Language)
  NodeMaterials, not GLSL.
- **Bun workspace** (`packages/*`, `app`); **Vite** builds the app. The Go binary
  builds with `make`.
- **React 19 + @react-three/fiber 9** for the app. CodeMirror (`@uiw/react-codemirror`)
  backs the 2D text-editor panel.
- Glyph shaping: **HarfBuzz** + **Slug** GPU bezier coverage, with a font fallback
  chain and color-emoji support.
- Code intelligence: **tree-sitter** (`web-tree-sitter`, grammars for js/ts/go/python/json)
  for syntax coloring + a semantic model; **LSP** servers hosted by the Go binary for
  definition/references.

The IDE shell is a react-three-fiber application on a framework-agnostic rendering
core: `@glyph3d/core` is vanilla `three/webgpu` with no UI-framework dependency; the
shell is **React 19 + react-three-fiber 9**; the two meet at the thin `@glyph3d/r3f`
binding. New shell code is React/r3f; new rendering code is `three/webgpu` + TSL.

## Structure

```
packages/
  glyph3d-core/src/        @glyph3d/core
    GlyphField.js          WebGPU / TSL renderer (one instanced draw call)
    GlyphAtlas.js          font atlas (shaping → glyph metrics); GlyphAtlasLoader.js
    collections/           the 3D objects + layouts:
                             CodeGrid, TerminalGrid (TerminalEmulator), FrameGrid,
                             FramedGlyphField, AgentGrid, AgentTrail, FieldVisitor,
                             ContentTree (+Arrows/Markers/Probes) directory view,
                             ScaleModel (readability zoom), BoundedObject3D,
                             GridVirtualizer (frustum culling), toolRegistry
      (layout managers)      Grid, Hierarchical, Spiral, Stack, Treemap, Strata,
                             Structure + layouts/ (district, flow, jellyfish, packed,
                             walkTree, StackContainer)
    core/                  LayoutDescription (layout seam), constants, renderOrder, types
    parsing/               tree-sitter: TreeSitterEngine, SyntaxColorizer, SemanticModel,
                             languageRegistry, parse{Auto,FileRef,LogLine,StackTrace}
    semantic/              SemanticInfoMap, GlyphEvents (per-glyph semantic overlay)
    services/
      interaction/           AttentionManager, EntityKeystrokeRouter
      camera/                ViewerCameraController
      orchestration/         CommandRouter, WebSocketBridge
      state/                 StateController (localStorage), FileStateManager, DiffParser
      spatial/               SpatialWindowManager, WindowGroup, SpatialAnimator, sceneBounds
      tour/                  TourSequencer, TourResolver, TourAnnotator
      data/  visual/  utils/  (+ services/index.js aggregator)
    memory/                MemoryEdges/Viz/Legend, hexView, memoryGridView (memory-map view)
    annotations/           ConnectionRenderer (between-entity connectors)
    components/            Button3D, MinimapOverlay
    picking/  shaping/  workers/  hand/  fonts/  utils/
  glyph3d-r3f/src/         GlyphCanvas, ViewerCamera, CodeGrid, Minimap,
                           SceneEnvironment, useGlyphEngine, glyphEngine, context
app/
  main.jsx index.html vite.config.js   the IDE entry (Vite)
  client/                CommandProvider, CanvasInteraction, HudPanel, CommandBar,
                         SessionStore, WorkspaceModel, keymap, gestureResolver,
                         settings, statusChannel, palette/ (command-palette ranking)
  commands/handlers/     ~45 verb modules (file.*, grid.*, edit.*, terminal.*, camera.*,
                         structure.*, trail.*, memory.*, tour.*, lsp.*, repo.*, dock.*,
                         panel.*, view.*, frame.*, semantic.*, settings.* …) → index.js
  *.jsx                  dockview panels: FileTree, TerminalsPanel, EditorPanel,
                         FieldVisitorsPanel, SettingsPanel, RepoPanel, LayoutPanel,
                         LspResultsPanel, IdeDock, ButtonBar, StatusBar, ContextBreadcrumb
cli/
  main.go relay.go fs.go embed.go     serve + WebSocket relay + sandboxed fs-RPC
  lsp.go logstore.go                  LSP supervisor + in-memory SQLite log store
  attach_*.go fs_atomic_*.go filelock_*.go   terminals + durable atomic writes (per-OS)
  hook.go fullsnapshot.go             session hook + full-state snapshot subcommands
Makefile  tools/   _experiments/   docs/   STATE_ARCHITECTURE.md
```

## How it runs

**Dev loop** (the `webgpu-dev-loop` skill): `tools/dev.sh` runs Vite (`:5173`) + the Go
relay (`:8080`). Open `http://localhost:5173` and **hard-reload** (Ctrl-Shift-R) after
a Vite restart. Use a WebGPU browser — Chromium-based (Vivaldi/Chrome) or the
NVIDIA-pinned `tools/dev-firefox.sh`; plain Firefox on Linux crashes on WebGPU.

- `tools/dev.sh vite` restarts Vite + clears its `.vite` cache. **Source** edits to
  CommandProvider / handlers / the router only need a hard browser reload (handlers
  register once per page load — a hot-swap leaves the live router holding stale
  handlers); the cache-wipe is only for dependency changes. Verify a transform with
  `curl http://localhost:5173/@fs/<abspath> | rg <token>`.
- `tools/dev.sh relay` rebuilds + restarts the Go relay (**kills live terminals**).
- `tools/dev.sh refresh` does relay then vite; `status` / `stop` manage both.

**Build / serve**: `make build` runs the app's Vite production build, stages
`app/dist/` into `cli/web/`, and bakes it into the binary. `./glyph3d-cli serve
~/project` then serves the built IDE + relay + fs-RPC from one binary at `/`. The app
bundles its deps at build (no importmap). `make all` cross-compiles all platforms.
`make prep-wasm` / `prep-tree-sitter` stage the HarfBuzz + tree-sitter wasm assets.

**Drive it from the CLI** — the same command bus the UI uses:
`./glyph3d-cli grid.list`, `./glyph3d-cli file.open path/to/file.js`. Global flags go
*before* the subcommand (e.g. `--port 8099`). Other subcommands: `hook`, `screenshot`,
`attach`, `fullsnapshot`, `version`.

**Tests & checks** live in `tools/`: `*.test.mjs` / `*.itest.mjs` are node/bun unit and
integration tests; `*-check.mjs` + `cdp-shot.mjs` / `capture.mjs` are Playwright/CDP
browser smoke checks against a running dev loop; `bun tools/buslog.mjs` tails the relay
log store. Playwright/Chromium is pre-installed — never run `playwright install`.

## Command bus

Every action is a verb. `CommandRouter.execute(input)` dispatches to a handler in
`app/commands/handlers/` (aggregated by `index.js`); UI clicks, the command palette,
and CLI/RPC hit the same handlers (one source of truth). The relay forwards CLI
commands to the browser display over WebSocket, and keeps a structured in-memory SQLite
store of every browser log record — `log.query` / `log.search` / `log.errors` /
`log.stats` / `log.dump` answer relay-side (page-less), with live follow via
`bun tools/buslog.mjs`.

- **AttentionManager** (`services/interaction`) owns three slots: `hover`, `primary`
  (sticky focus), `key` (keyboard target). One writer per slot; `attention.set <slot>
  <id|none>`.
- **EntityKeystrokeRouter** delivers keystrokes to the `key`-slot entity's handler
  (`grid` → edit ops, `terminal` → PTY bytes), and yields when a DOM input is focused.
- **HUD is one-way state→view** — it reflects attention/registry/edit state and issues
  verbs; it owns no behavior.

## Persistence & app state

Two layers, both serializable, both pushed onto the (deliberately non-React) live scene
objects:

- **`StateController`** (`services/state`) — namespaced `localStorage` (`g3d.{key}`), no
  in-memory blob; every `set`/`delete` fires a `state-changed` event so panels refresh
  without polling.
- **`WorkspaceModel`** (`app/client`) **is the app-state tree** — `surfaces` (per-id
  grid/terminal `view` intent) + workspace-level `field` (source, layout, camera, focus).
  The reload discipline: **store inputs the operator chose, never outputs the scene
  computed**, and converge with an idempotent `apply()` that runs after every
  state-mutating verb and on every registry change (re-adopted terminals land late and
  get sized then). See **`STATE_ARCHITECTURE.md`** for the full model before touching
  persistence or save/restore.

## Key concepts

- **Single instanced draw call.** Text becomes a `Float32Array` of per-glyph instance
  attributes (built single-pass, optionally in a Web Worker via `WorkerBridge`) and
  renders as one `InstancedBufferGeometry`.
- **CodeGrid** is a source file as an `Object3D` — cursor + in-place edit ops, highlight
  ranges, a windowing/framing layout, and a caret overlay. The edit path funnels
  through `_relayoutPreservingCursor()`.
- **Layout** flows through the `LayoutDescription` seam (`core/LayoutDescription.js`):
  modes are params, set via `grid.layout` / `grid.frame` / `grid.scroll`. Multi-grid
  arrangement uses the layout managers (Grid/Hierarchical/Spiral/Stack/Treemap/…).
- **ContentTree** renders a directory/repo as a navigable 3D tree (arrows, markers,
  probes). **Strata / Structure** views layer scope by Z-depth with border boxes.
- **GPU picking** (`picking/`) is a multi-channel ID render pass (separate glyph and
  grid channels) — the single source of truth for hover/click resolution.
- **Frustum culling** (`GridVirtualizer`) adds/removes grids from the scene by camera
  frustum, so only visible grids draw.
- **Terminals** are tmux-backed (socket `tmux -L glyphd`, sessions `glyph-<id>`) via
  forked adapter subprocesses; they render as `TerminalGrid`s and re-adopt across
  reloads. See the `saved-state` and `terminal-control-subsystem` memories.
- **Agent trail / FieldVisitor** project an agent's say/think conversation and traversal
  onto the field; **memory views** map process memory; **tours** sequence guided camera
  moves with annotations.
- **All glyph metrics come from the atlas at runtime** — never hardcode character
  dimensions.

For internals that move (the Slug shaping pipeline, texture formats, the layout
substrate), read the code and the agent memory rather than trusting a prose snapshot.

## Conventions

- **ES modules** + **JSDoc**. Default exports for classes, named for utilities/constants.
- Shaders are **TSL**. Worker-compatible code in `workers/builders/` stays free of
  DOM/Three.js imports.
- **One render path** — no sync/async split; the worker-compatible builder is the way
  text renders.
- **No compatibility shims, no aliases.** Refactor cleanly and update every caller in
  the same change — an atomic rename surfaces intent mismatches. No re-export
  forwarders, no dual code paths, no backward-compat flags.
- **Command-bus-native.** A missing action means a missing verb — add it rather than
  reaching around the bus.
- **Store inputs, not outputs** in persisted state (see above).
- Position objects are `{ x, y, z }`; colors are `{ r, g, b }` (0–1). 3D objects extend
  `THREE.Object3D`.

## Package exports

```javascript
import { ... } from '@glyph3d/core';                  // main
import { ... } from '@glyph3d/core/collections';       // CodeGrid, TerminalGrid, layouts
import { ... } from '@glyph3d/core/workers';           // WorkerBridge
import { ... } from '@glyph3d/core/shaping';            // HarfBuzz + Slug
import { ... } from '@glyph3d/core/parsing';            // tree-sitter engine + colorizer
import { ... } from '@glyph3d/core/annotations';        // ConnectionRenderer
import { ... } from '@glyph3d/core/services/...';       // interaction, camera, data,
                                                        // orchestration, state, visual, utils
```

(Full `exports` map: `packages/glyph3d-core/package.json`.)

## Deployment

`make build` produces the self-contained binary; `make all` cross-compiles
linux/macOS/windows × amd64/arm64; `make release VERSION=vX.Y.Z` cuts a GitHub release
(`RELEASE_NOTES.md`). The single binary is a single-operator tool — shared relay state,
no auth, trusts the operator. The product/demo web page is a separate repo.
