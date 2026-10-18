# CLAUDE.md — Project Guide for AI Assistants

## What this is

glyph3d-js renders thousands of text glyphs in 3D at 60fps via GPU instancing on
Three.js (WebGL2 & WebGPU) — built for navigating source code, directory trees, and live
terminals in 3D space. The repo is organized as **a package, an app, and a cli**:

- **`packages/glyph3d-core`** (`@glyph3d/core`) — the publishable rendering library:
  glyph atlas + shaping, the `InstancedField` / `InstancedSlotBuffer` renderer, `CodeGrid` / `TerminalGrid`,
  layout managers, picking, the command/interaction services.
- **`packages/glyph3d-r3f`** — react-three-fiber bindings for the core.
- **`app/`** — the IDE: a react-three-fiber client on the core. File tree + 3D code
  grids + terminals, driven by a command bus. `app/client/` holds the shared chrome
  (CommandProvider, CanvasInteraction, HudPanel, CommandBar, SessionStore,
  WorkspaceModel); `app/commands/` holds the command spine (handlers).
- **`cli/`** — a Go single binary that bakes in the built app and serves it alongside
  a WebSocket relay + sandboxed filesystem RPC.

## Tech stack

- **JavaScript** (ES modules), **JSDoc** for types — no TypeScript.
- **Three.js (WebGL2 & WebGPU)**; shaders are GLSL 3.00 ES and InstancedField materials
  with WebGPU fallback.
- **Bun workspace** (`packages/*`, `app`); **Vite** builds the app. The Go binary
  builds with `make`.
- **React 19 + @react-three/fiber 9** for the app.
- Glyph shaping: **HarfBuzz** + **Slug** GPU bezier coverage, with a font fallback
  chain and color-emoji support.

The IDE shell is a react-three-fiber application on a framework-agnostic rendering
core: `@glyph3d/core` is vanilla Three.js with no UI-framework dependency; the
shell is **React 19 + react-three-fiber 9**; the two meet at the thin `@glyph3d/r3f`
binding. New shell code is React/r3f; new rendering code is Three.js + GLSL/TSL.

## Structure

```
packages/
  glyph3d-core/src/        @glyph3d/core
    collections/           InstancedField, CodeGrid, TerminalGrid, layout managers
    atlas/ / shaping/      GlyphAtlas, HarfBuzz shaper, Slug curve textures
    core/                  LayoutDescription (layout seam), constants, renderOrder, types
    services/              interaction (AttentionManager, keyEncoding),
                           camera (ViewerCameraController), data, orchestration
                           (CommandRouter, WebSocketBridge), state, visual
    picking/  shaping/  workers/  annotations/  parsing/  hand/  fonts/
  glyph3d-r3f/src/         GlyphCanvas, ViewerCamera, useGlyphEngine, useGridRegistry
app/
  main.jsx index.html vite.config.js   the IDE entry (Vite)
  client/                CommandProvider, CanvasInteraction, HudPanel, CommandBar,
                         SessionStore, WorkspaceModel
  commands/handlers/     command verbs (file.*, grid.*, edit.*, terminal.*, camera.*, …)
  ButtonBar IdeDock FileTree TerminalsPanel AgentsPanel CarrelsPanel   dockview panels
cli/
  main.go relay.go fs.go embed.go attach_unix.go   serve + relay + fs-RPC + terminals
Makefile  tools/dev.sh
```

## How it runs

**Dev loop** (the `webgpu-dev-loop` skill): `tools/dev.sh` runs Vite (`:5173`) + the Go
relay (`:8080`). Open `http://localhost:5173` and **hard-reload** (Ctrl-Shift-R) after
a Vite restart. Use a WebGPU browser — Chromium-based (Vivaldi/Chrome) or the
NVIDIA-pinned `tools/dev-firefox.sh`; plain Firefox on Linux crashes on WebGPU.

- `tools/dev.sh vite` restarts Vite + clears its cache (do this after editing
  core/handlers — the watcher can serve stale transforms; verify with
  `curl http://localhost:5173/@fs/<abspath> | rg <token>`).
- `tools/dev.sh relay` rebuilds + restarts the Go relay.

**Build / serve**: `make build` runs the app's Vite production build, stages
`app/dist/` into `cli/web/`, and bakes it into the binary. `./glyph3d-cli serve
~/project` then serves the built IDE + relay + fs-RPC from one binary at `/`. The app
bundles its deps at build (no importmap). `make all` cross-compiles all platforms.

**Drive it from the CLI** — the same command bus the UI uses:
`./glyph3d-cli grid.list`, `./glyph3d-cli file.open path/to/file.js`. Global flags go
*before* the subcommand (e.g. `--port 8099`).

## Command bus

Every action is a verb. `CommandRouter.execute(input)` dispatches to a handler in
`app/commands/handlers/`; UI clicks and CLI/RPC hit the same handlers (one source of
truth). The relay forwards CLI commands to the browser display over WebSocket, and
keeps a structured in-memory SQLite store of every browser log record — `log.query` /
`log.search` / `log.errors` / `log.stats` / `log.dump` answer relay-side (page-less),
with live follow via `bun tools/buslog.mjs`. Page-side, `emitLogRecord` runs a storm
brake: an identical error/warn signature past 5 is dropped + counted, with a
`log-brake` summary warn every 500 (locked by `tools/log-storm-brake.test.mjs`).
Device loss itself (VRAM exhaustion — a bulk load + resize churn can OOM the device)
is a queued-reload recovery:
`onDeviceLost` stops the loop, the layout engine suspends dispatches
(`tools/device-loss-recovery.test.mjs`), and the page reloads once a minute at most
(the loop guard lives in sessionStorage) so the substrate can re-seat the session.

The LOAD FLOW self-reports: every load runs a staged trace (`[load]` console lines →
the relay log store; `load.stats` answers with stage aggregates + the worst
main-thread blocks, which an always-on long-task watcher attributes to the load they
interrupted as `[frames]` lines). `bun tools/loadstorm-check.mjs` asserts the batching
invariants headlessly — one relayout per bulk load, coalesced registry notification.

- **AttentionManager** (`services/interaction`) owns three slots: `hover`, `primary`
  (sticky focus), `key` (keyboard target). One writer per slot; `attention.set <slot>
  <id|none>`.
- **Keyboard responder chain** (`app/client/keyboardRouter.js`, the keyboard twin of
  `gestureResolver`) is the one capture-phase listener: an ordered, composable tier list
  (entity typing → Esc/context pop → nav keymap; camera WASD is the bubble fallthrough).
  The first tier to claim a key consumes it; it yields wholesale when a DOM input is focused.
  Terminal/grid byte+edit translation comes from `keyEncoding` (`services/interaction`).
- **HUD is one-way state→view** — it reflects attention/registry/edit state and issues
  verbs; it owns no behavior.

## Key concepts

- **Single instanced draw call.** Text becomes a `Float32Array` of per-glyph instance
  attributes (built single-pass, optionally in a Web Worker via `WorkerBridge`) and
  renders as one `InstancedBufferGeometry`.
- **CodeGrid** is a source file as an `Object3D` — cursor + in-place edit ops, highlight
  ranges, a windowing/framing layout, and a caret overlay. The edit path funnels
  through `_relayoutPreservingCursor()`.
- **Layout** flows through the `LayoutDescription` seam (`core/LayoutDescription.js`):
  modes are params, set via `grid.layout` / `grid.frame` / `grid.scroll`. Glyph positions
  are written on the CPU by `core/LayoutGenerator.js` into `InstancedSlotBuffer` slots;
  the page fold is `core/foldGeometry.js` (`pageFold` / `pageShift`), the same one
  `LayoutDescription` answers caret / pick / extent queries with
  (`tools/layout-generator-fold.test.mjs` binds them).
- **GPU picking** (`picking/`) is a multi-channel ID render pass (separate glyph and
  grid channels) — the single source of truth for hover/click resolution. `pick(channels,
  camera, scene, x, y)` draws each channel into one pixel through a camera narrowed to the
  cursor's pixel (`setViewOffset`, so culling drops all but what's under it) and reads them
  back together with three's fenced `readRenderTargetPixelsAsync` — the main thread never
  waits on the GPU. Hover picks run as fast as they land unless `pick.hoverHz` caps them.
- **Frustum culling** is three's built-in per-object cull, on by default for glyph fields
  and panels. three can't compute an instanced field's bounds (it sees only the base quad),
  so each field STATES them: `InstancedField.setLayoutExtent` takes the laid-out extent and
  adds the shader's right-side overdraw (an emoji quad is as wide as it is tall) before
  writing `geometry.boundingBox/Sphere` — the box three culls, depth-sorts, and raycasts by.
  `tools/glyph-cull-truth.mjs` checks every live quad against it. (Fields moved through the
  group table — the content-tree labels — opt out. Culling covers draws, not GPU memory.)
- **Far-LOD** (`collections/GlyphFarLod.js`): a culled field whose tallest row measures under
  `glyph.showGlyphsPx` (default 1 px, at its box's point nearest the camera) stops drawing its
  glyphs — it leaves the view camera's layer 0, so `visible` keeps its owners — and one
  instanced quad of its mean ink colour (`InstancedField.farTint`; alpha = ink cover ×
  `glyph.backdropGain`) stands in. All backdrops are one draw. Gates:
  `tools/glyph-far-lod.test.mjs` (the decision + tint) and `tools/far-lod-check.mjs` (pixels).
- **Panel batching** (`collections/PanelBatch.js`): every flat panel — window backgrounds, page
  faces, label plates — stays a real mesh its owner poses, paints (`createPanelMaterial`) and
  registers for picking, but is drawn as an instance: `enrollPanel(mesh)` marks it, and a
  `PanelBatch` refreshes from `scene.onBeforeRender` (this frame's matrices; never on pick passes)
  into one InstancedMesh per render state, taking each panel off the view camera's layer 0.
  A bucket draws half a step before its panels' render order and sorts translucent instances as
  three sorts objects. Gates: `tools/panel-batch.test.mjs`, `tools/panel-batch-check.mjs`.
- **Terminals** are tmux-backed (socket `tmux -L glyphd`, sessions `glyph-<id>`) via
  forked adapter subprocesses; they render as `TerminalGrid`s and re-adopt across
  reloads. See the `saved-state` and `terminal-control-subsystem` memories.
- **Sensor plane** — capture devices (an iPhone running the `motion-source-ios`
  MotionSource app) connect to the relay with a `SOURCE <kind>` handshake, a third
  client role beside `DISPLAY` and controllers. **Many may attach at once**, each
  with its own id (`src-hand-0`). The relay is schema-blind: it stamps provenance
  and forwards `{event:'source.frame', source, kind, data}` on the display's
  existing socket, with **drop-oldest** backpressure (frames are perishable — queue
  depth is a latency ceiling, not a buffer). Browser side, `SourceStream`
  (`services/orchestration`) owns presence + decode + liveness, and `HandPresence`
  (`hand/`) draws one `HandRenderer` per device, sampled **pull-style** once per
  rendered frame. Verbs: `hand.list` / `hand.status` / `hand.show` / `hand.hide` /
  `hand.place`, plus relay-resident `source.list` (answers with no display
  connected). Gesture→verb binding is not built yet.
- **All glyph metrics come from the atlas at runtime** — never hardcode character
  dimensions.

For internals that move (the Slug shaping pipeline, texture formats, the layout
substrate), read the code and the agent memory rather than trusting a prose snapshot.

## Conventions

- **ES modules** + **JSDoc**. Default exports for classes, named for utilities/constants.
- Shaders are **GLSL 3.00 ES** / **TSL**. Worker-compatible code in `workers/` stays free of
  DOM/Three.js imports.
- **One render path** — no sync/async split; the worker-compatible builder is the way
  text renders.
- **No compatibility shims, no aliases.** Refactor cleanly and update every caller in
  the same change — an atomic rename surfaces intent mismatches. No re-export
  forwarders, no dual code paths, no backward-compat flags.
- **Command-bus-native.** A missing action means a missing verb — add it rather than
  reaching around the bus.
- **Fail loud at substrate seams.** Values handed to browser/GPU APIs (device limits,
  descriptors) are validated at the boundary, and any fallback path logs its true
  cause plus the exact request it degraded from — a silent fallback re-emits an app
  bug as an environment failure and misdirects debugging (see `_pipelineLimits` in
  `GlyphCanvas.jsx` for the template).
- Position objects are `{ x, y, z }`; colors are `{ r, g, b }` (0–1). 3D objects extend
  `THREE.Object3D`.

## Package exports

```javascript
import { ... } from '@glyph3d/core';               // main
import { ... } from '@glyph3d/core/collections';    // CodeGrid, TerminalGrid, layouts
import { ... } from '@glyph3d/core/workers';        // WorkerBridge
import { ... } from '@glyph3d/core/shaping';         // HarfBuzz + Slug
import { ... } from '@glyph3d/core/services/...';    // interaction, camera, data, orchestration
```

(Full `exports` map: `packages/glyph3d-core/package.json`.)

## Deployment

`make build` produces the self-contained binary; `make all` cross-compiles
linux/macOS/windows × amd64/arm64; `make release VERSION=vX.Y.Z` cuts a GitHub release
(`RELEASE_NOTES.md`). The single binary is a single-operator tool — shared relay state,
no auth, trusts the operator. The product/demo web page is a separate repo.
