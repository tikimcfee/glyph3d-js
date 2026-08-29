# CLAUDE.md — Project Guide for AI Assistants

## What this is

glyph3d-js renders thousands of text glyphs in 3D at 60fps via GPU instancing on a
WebGPU renderer — built for navigating source code, directory trees, and live
terminals in 3D space. The repo is organized as **a package, an app, and a cli**:

- **`packages/glyph3d-core`** (`@glyph3d/core`) — the publishable rendering library:
  glyph atlas + shaping, the `GlyphField` WebGPU renderer, `CodeGrid` / `TerminalGrid`,
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
- **Three.js via `three/webgpu`**; shaders are **TSL** (Three.js Shading Language)
  NodeMaterials, not GLSL.
- **Bun workspace** (`packages/*`, `app`); **Vite** builds the app. The Go binary
  builds with `make`.
- **React 19 + @react-three/fiber 9** for the app.
- Glyph shaping: **HarfBuzz** + **Slug** GPU bezier coverage, with a font fallback
  chain and color-emoji support.

The IDE shell is a react-three-fiber application on a framework-agnostic rendering
core: `@glyph3d/core` is vanilla `three/webgpu` with no UI-framework dependency; the
shell is **React 19 + react-three-fiber 9**; the two meet at the thin `@glyph3d/r3f`
binding. New shell code is React/r3f; new rendering code is `three/webgpu` + TSL.

## Structure

```
packages/
  glyph3d-core/src/        @glyph3d/core
    GlyphField.js          WebGPU / TSL renderer
    GlyphAtlas.js          font atlas (shaping → glyph metrics)
    collections/           CodeGrid, TerminalGrid, layout managers
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
engine/
  glyph_pipeline.mojo conformance.mojo fixtures/   native (Mojo) pipeline port — the
                         4th layer of the pipeline contract, proven bit-exact against
                         the JS oracle (see engine/README.md + docs/plans/)
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
`log-brake` summary warn every 500 (locked by `tools/log-storm-brake.test.mjs`). The
occlusion culler carries the matching fault guard: a failed GPU query resolve logs
once and disables culling instead of storming unhandled rejections per frame
(`tools/occlusion-resolve-guard.test.mjs`). Device loss itself (VRAM exhaustion —
a bulk load + resize churn can OOM the device) is a queued-reload recovery:
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
  are computed by the GPU compute engine (`compute/GlyphLayoutKernel.js`) — one fold over
  CPU-authored tables + params + displacements, with no CPU fallback; `layout.verify
  <grid>` asserts the live scene.
- **GPU picking** (`picking/`) is a multi-channel ID render pass (separate glyph and
  grid channels) — the single source of truth for hover/click resolution.
- **Frustum culling** is three's built-in per-object cull fed the real instance extent —
  `GlyphField._updateGeometryBounds` writes `geometry.boundingBox/Sphere` after every
  position/count mutation, so `frustumCulled = true` is safe. (The old `GridVirtualizer`
  class is deleted; culling covers draws, not GPU memory.)
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
- Shaders are **TSL**. Worker-compatible code in `workers/builders/` stays free of
  DOM/Three.js imports.
- **One render path** — no sync/async split; the worker-compatible builder is the way
  text renders.
- **No compatibility shims, no aliases.** Refactor cleanly and update every caller in
  the same change — an atomic rename surfaces intent mismatches. No re-export
  forwarders, no dual code paths, no backward-compat flags.
- **Command-bus-native.** A missing action means a missing verb — add it rather than
  reaching around the bus.
- **A green must be earned, not structural.** Before trusting a passing check, ask
  what would have to break for it to fail — then *break it* and watch it fail. Three
  separate times this repo shipped a test that could not fail: a gate asserting on
  float noise, a ceiling constant no test protected (reverting it left 48 files
  green), and a fixture checksum that compared bytes guaranteed identical before the
  command ran. Every one was caught by execution; not one was caught by inspection,
  and in each case the reasoning had already concluded the test was fine. A pass is a
  claim about a counterfactual, so test the counterfactual. Mutation is the part that
  is not optional.
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
