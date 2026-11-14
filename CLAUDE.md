# CLAUDE.md — Project Guide for AI Assistants

## What this is

glyph3d-js renders thousands of text glyphs in 3D at 60fps via GPU instancing on
Three.js (WebGL2) — built for navigating source code, directory trees, and live
terminals in 3D space. The repo is organized as **packages, two apps, a cli and a terminal daemon**:

- **`packages/glyph3d-core`** (`@glyph3d/core`) — the publishable rendering library:
  glyph atlas + shaping, the `InstancedField` / `InstancedSlotBuffer` renderer, `CodeGrid` / `TerminalGrid`,
  layout managers, picking, the command/interaction services.
- **`packages/glyph3d-r3f`** — react-three-fiber bindings for the core.
- **`app/`** — the IDE: a react-three-fiber client on the core. File tree + 3D code
  grids + terminals, driven by a command bus. `app/client/` holds the shared chrome
  (CommandProvider, CanvasInteraction, HudPanel, CommandBar, SessionStore,
  WorkspaceModel); `app/commands/` holds the command spine (handlers).
- **`wall/`** — the wall: an infinite flat (orthographic) canvas of terminals on the same
  core and relay (Vite :5180, `?relay=PORT`, default 8080 — a relay takes ONE display, so beside
  the IDE the wall needs its own relay). Pan, zoom, type, resize, hide/close, lasso-select and
  group terminals; chords are ⌘ on macOS, Ctrl+Alt elsewhere (`wall/chord.js`). A right-click
  opens the wall's menu for what's under it (`wall/contextMenu.js`); a second right-click,
  Shift+right-click, text fields and DOM chrome keep the browser's own. Every action is
  a `wall.*` verb (`wall/wallCommands.js`) that buttons, chords, palette, sidebar, status window,
  the right-click menu and CLI all run; knobs live in `wall/wallConfig.js` (`wall.config`); per-relay state in
  `WallStore`; `TerminalWall` is the composition root (start/stop symmetric). Gate:
  `bun tools/wall-e2e.mjs` (own relay, termd namespace and terminals; `--reuse-relay`).
  The canvas is drafting paper (`WallPaper`; moves and resizes snap to it: `wallSnap`, chord+' /
  Ctrl held mid-drag inverts), and every knob is searchable in the settings panel (chord+,; one
  schema, `wallSettings`; dialled knobs persist per relay).
  Details: `docs/architecture/wall.md`.
- **`cli/`** — a Go single binary that bakes in the built app and serves it alongside
  a WebSocket relay + sandboxed filesystem RPC.
- **`crates/`** — the Rust workspace: `g3d-termd`, the terminal daemon (PTYs + one libghostty-vt
  emulator per terminal; outlives the relay) in two processes, the holder (`g3d-hold`: the shells'
  parent and their PTY fds) and the brain (everything else, restartable), `g3d` (attach to / watch /
  list / start / upgrade terminals and read termd's status from any real terminal) and `g3d-wire`
  (the public protocol, `docs/termd/PROTOCOL.md`).

## Tech stack

- **JavaScript** (ES modules), **JSDoc** for types — no TypeScript.
- **Three.js (WebGL2)**, `THREE.WebGLRenderer` (`packages/glyph3d-r3f/src/GlyphCanvas.jsx`);
  shaders are GLSL 3.00 ES.
- **Bun workspace** (`packages/*`, `app`); **Vite** builds the app. The Go binary
  builds with `make`.
- **React 19 + @react-three/fiber 9** for the app.
- Glyph shaping: **HarfBuzz** + **Slug** GPU bezier coverage, with a font fallback
  chain and color-emoji support.

The IDE shell is a react-three-fiber application on a framework-agnostic rendering
core: `@glyph3d/core` is vanilla Three.js with no UI-framework dependency; the
shell is **React 19 + react-three-fiber 9**; the two meet at the thin `@glyph3d/r3f`
binding. New shell code is React/r3f; new rendering code is Three.js + GLSL.

## Structure

```
packages/
  glyph3d-core/src/        @glyph3d/core
    collections/           InstancedField, CodeGrid, TerminalGrid, layout managers
    atlas/ / shaping/      GlyphAtlas, HarfBuzz shaper, Slug curve textures
    core/                  LayoutDescription (layout seam), constants, renderOrder, types
    services/              interaction (AttentionManager, keyEncoding),
                           camera (ViewerCameraController), data, orchestration
                           (CommandRouter, WebSocketBridge), state, visual,
                           terminal (the terminal.* verbs + TerminalHost)
    picking/  shaping/  workers/  annotations/  parsing/  hand/  fonts/
  glyph3d-r3f/src/         GlyphCanvas, ViewerCamera, useGlyphEngine, useGridRegistry
app/
  main.jsx index.html vite.config.js   the IDE entry (Vite)
  client/                CommandProvider, CanvasInteraction, HudPanel, CommandBar,
                         SessionStore, WorkspaceModel
  commands/handlers/     command verbs (file.*, grid.*, edit.*, camera.*, …)
  ButtonBar IdeDock FileTree TerminalsPanel AgentsPanel CarrelsPanel   dockview panels
wall/
  main.jsx TerminalWall.js            the wall entry + composition root (Vite :5180)
  WallCamera WallPointer WallKeys WallNames WallStore   one job each
  WallGroups GroupFrame BarButtons SelectionOverlay Sidebar StatusWindow Panel Palette wallCommands
cli/
  main.go relay.go fs.go embed.go attach_unix.go   serve + relay + fs-RPC + terminal adapters
  termd.go                                          the relay's g3d-termd client (start, list, …)
  gomux.go agentevents.go                           gomuxai: hub tree, agent sessions + events
crates/
  g3d-wire/  g3d-hold/  g3d-termd/  g3d/            protocol · termd's holder · the daemon · its client
docs/termd/  PROTOCOL.md DESIGN.md                  the termd wire (public) and its design
Makefile  tools/dev.sh  tools/termd-vendor.sh
```

## How it runs

**Dev loop**: `tools/dev.sh` runs Vite (`:5173`) + the Go relay (`:8080`). Open
`http://localhost:5173` and **hard-reload** (Ctrl-Shift-R) after a Vite restart.
`tools/dev.sh wall …` does the same for the wall: Vite `:5180` + its own relay `:8180` in termd
namespace `wall` (page `http://localhost:5180/?relay=8180`); both can run at once.

- `tools/dev.sh vite` restarts Vite + clears its cache (do this after editing
  core/handlers — the watcher can serve stale transforms; verify with
  `curl http://localhost:5173/@fs/<abspath> | rg <token>`).
- `tools/dev.sh relay` rebuilds (Go + termd) + restarts the Go relay. Terminals live in
  `g3d-termd` and survive it; `./g3d upgrade` hands every terminal to the rebuilt `g3d-termd`
  without ending a shell (`./g3d stop` ends the namespace: every shell in it dies).

**Build / serve**: `make build` runs the app's Vite production build, stages
`app/dist/` into `cli/web/`, and bakes it into the binary; `make termd` (part of it) builds
`g3d-termd` and `g3d` beside it (Linux; first run `tools/termd-vendor.sh`, which fetches and
verifies libghostty-vt's release tarballs and Zig into `vendor/`). `./glyph3d-cli serve
~/project` then serves the built IDE + relay + fs-RPC from one binary at `/`. The app
bundles its deps at build (no importmap). `make all` cross-compiles all platforms.

**Drive it from the CLI** — the same command bus the UI uses:
`./glyph3d-cli grid.list`, `./glyph3d-cli file.open path/to/file.js`. Global flags go
*before* the subcommand (e.g. `--port 8099`). It is the ONE relay client: a one-shot goes
as a typed line when its args are plain tokens (or the verb arg is itself a quoted line)
and as a `call` bundle when an arg carries spaces/quotes/newlines (handlers take raw text —
no per-verb base64), log replies render as records, and `screenshot [--cmd 'verb …']… [-o out.png]` / `log.follow` /
`seed-history` are its client commands. JS that genuinely needs JS (Playwright, simulated
displays) dials through `tools/lib/relay.mjs`.

**Agent transcripts come from gomuxai** (the installed `agent` CLI, run by the relay; nothing
in this repo reads a harness transcript). Relay flags, RPCs and the IDE's agent books:
`docs/architecture/agents.md`.

## Command bus

Every action is a verb. `CommandRouter.execute(input)` dispatches to a handler in
`app/commands/handlers/`; UI clicks and CLI/RPC hit the same handlers (one source of
truth). The `terminal.*` verbs live in core (`services/terminal/terminalCommands.js`); what
differs per app is its `TerminalHost` (`ctx.terminalHost`; IDE `app/client/terminalHost.js`,
wall `TerminalWall._terminalHost`). The relay forwards CLI commands to the browser display over
WebSocket and keeps an in-memory SQLite store of every browser log record (`log.query` /
`log.search` / `log.errors` / `log.stats` / `log.dump`, page-less; `./glyph3d-cli log.follow`
live). Loads self-report (`[load]` lines, `load.stats`). Terminal re-adoption, the log storm
brake, device-loss recovery and the load trace: `docs/architecture/command-bus.md`.

- **AttentionManager** (`services/interaction`) owns three slots: `hover`, `primary`
  (sticky focus), `key` (keyboard target). One writer per slot; `attention.set <slot>
  <id|none>`.
- **Keyboard responder chain** (`app/client/keyboardRouter.js`, the keyboard twin of
  `gestureResolver`) is the one capture-phase listener: an ordered, composable tier list
  (entity typing → Esc/context pop → nav keymap; camera WASD is the bubble fallthrough).
  The first tier to claim a key consumes it; it yields wholesale when a DOM input is focused.
  A terminal's keys leave as W3C key events from `keyEncoding` (`services/interaction`) and its
  pastes as text; termd encodes both in the program's live modes (docs/termd/PROTOCOL.md `key`,
  `paste`).
- **HUD is one-way state→view** — it reflects attention/registry/edit state and issues
  verbs; it owns no behavior.

## Key concepts

Each line is an index entry; the detail lives in the named doc. Read the doc before changing
that subsystem.

- **Rendering** (`docs/architecture/rendering.md`): text is one instanced draw per field
  (`InstancedField`, `InstancedSlotBuffer`); cells — a background pass for fills, SGR styles
  (`core/cellAttrs.js`), box/block/braille/powerline sprites generated to the cell
  (`shaping/cellSprites.js`), seamless at shared edges; `CodeGrid` (a source file as an `Object3D`);
  layout through the `LayoutDescription` seam (`core/LayoutGenerator.js`, `core/foldGeometry.js`);
  GPU picking (`picking/`, multi-channel ID pass, async readback); frustum culling on stated
  extents (`InstancedField.setLayoutExtent`); the flat render root
  (`collections/FlatRenderRoot.js`); colour (three's colour management end to end: the
  specified sRGB is what the canvas holds, ink opaque); glyph tiers (Slug → greek bars → far-LOD box,
  `collections/GlyphFarLod.js`); panel batching (`collections/PanelBatch.js`); glyph batching
  (`collections/GlyphBatch.js`); scene transforms (`collections/SceneTransforms.js`, installed
  with the flat root as one `SceneSystems`); incremental atlas texture uploads
  (`core/TextureUploads.js`).
- **Terminals** (`docs/architecture/terminals.md`; the daemon itself: `docs/termd/DESIGN.md`,
  wire `docs/termd/PROTOCOL.md`): terminals live in `g3d-termd` (holder + restartable brain,
  one daemon per namespace, outlives the relay); the relay's forked adapters turn termd's events
  into size-stamped frames; `TerminalGrid`s render them through the frame-pulled
  `TerminalScreenQueue`; what a cell draws (attributes, fonts, `tools/term-test-pattern.sh`) is
  its "Cells" section.
- **Agents** (`docs/architecture/agents.md`): agent sessions and events over relay↔display
  JSON-RPC (`cli/agentevents.go`), agent books (`app/client/SessionBooks.js`), the agents desk,
  hidden agents, the gomuxai hub (`app/client/GomuxHub.js`, `cli/gomux.go`).
- **IDE desks and books** (`docs/architecture/ide-desks-and-books.md`): `Book`
  (`collections/Book.js`) decks, sheets and forms; per-instance knobs (`app/client/tuning.js`).
- **Hand tracking** (`docs/architecture/hand-tracking.md`, wire `docs/hand-wire-v2.md`): the
  sensor plane (`SOURCE` clients on the relay), `hand/HandModel.js`, `hand/HandSpace.js`,
  `hand/HandStabilizer.js`, recordings and replay.
- **All glyph metrics come from the atlas at runtime** — never hardcode character
  dimensions.

For internals that move (the Slug shaping pipeline, texture formats, the layout
substrate), read the code and the agent memory rather than trusting a prose snapshot.

## Conventions

- **ES modules** + **JSDoc**. Default exports for classes, named for utilities/constants.
- Shaders are **GLSL 3.00 ES**. Worker-compatible code in `workers/` stays free of
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
  bug as an environment failure and misdirects debugging.
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

`make build` produces the self-contained binary (and `g3d-termd` + `g3d` beside it, which it
needs for terminals); `make all` cross-compiles
linux/macOS × amd64/arm64 + windows-amd64 (no terminals on Windows: `attach_windows.go` is a stub;
`g3d-termd` is built for Linux so far — amd64 natively, arm64 through cargo-zigbuild; macOS is TODO in `docs/termd/DESIGN.md`); `make release VERSION=vX.Y.Z` cuts a GitHub release
(`RELEASE_NOTES.md`). The single binary is a single-operator tool — shared relay state,
no auth, trusts the operator. The product/demo web page is a separate repo.
