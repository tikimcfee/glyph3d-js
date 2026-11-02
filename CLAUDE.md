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
  gomux.go agentevents.go                           gomuxai: hub tree, agent sessions + events
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
*before* the subcommand (e.g. `--port 8099`). It is the ONE relay client: a one-shot goes
as a typed line when its args are plain tokens (or the verb arg is itself a quoted line)
and as a `call` bundle when an arg carries spaces/quotes/newlines (handlers take raw text —
no per-verb base64), log replies render as records, and `screenshot [--cmd 'verb …']… [-o out.png]` / `log.follow` /
`seed-history` are its client commands. JS that genuinely needs JS (Playwright, simulated
displays) dials through `tools/lib/relay.mjs`.

**Agent transcripts come from gomuxai**: the relay runs the installed `agent` CLI
(`agent sessions --json`, `agent transcript … --follow`) and moves its lines to the display
(`cli/agentevents.go`); nothing in this repo reads a harness transcript. `serve
--sessions-interval` (10s) paces the session list, `--max-followers` (64) caps live
followers, `--no-gomuxai` turns all of it off, `--debug` logs each session-list push's size.
Every `agent` child dies with the relay (`cli/children.go`): Pdeathsig on Linux, however the
relay dies; elsewhere the SIGINT/SIGTERM handler kills them (a SIGKILLed relay off Linux
still orphans its `agent export`).

## Command bus

Every action is a verb. `CommandRouter.execute(input)` dispatches to a handler in
`app/commands/handlers/`; UI clicks and CLI/RPC hit the same handlers (one source of
truth). The relay forwards CLI commands to the browser display over WebSocket, and
keeps a structured in-memory SQLite store of every browser log record — `log.query` /
`log.search` / `log.errors` / `log.stats` / `log.dump` answer relay-side (page-less),
with live follow via `./glyph3d-cli log.follow` (the CLI renders log replies as records). Page-side, `emitLogRecord` runs a storm
brake: an identical error/warn signature past 5 is dropped + counted, with a
`log-brake` summary warn every 500 (locked by `tools/log-storm-brake.test.mjs`).
Device loss itself (VRAM exhaustion — a bulk load + resize churn can OOM the device)
is a queued-reload recovery:
`onDeviceLost` stops the loop, the layout engine suspends dispatches
(`tools/device-loss-recovery.test.mjs`), and the page reloads once a minute at most
(the loop guard lives in sessionStorage) so the substrate can re-seat the session.

Agent sessions and their events ride relay↔display JSON-RPC (`cli/agentevents.go`), the
relay moving gomuxai's lines without reading them: `agentSessions/list` (the latest
`agent sessions --json`, re-run while a display is connected) and the `agentSessions/changed`
push, sent only when a session appears or leaves or a field a display shows changes (status and end reason,
title, workgroup, parent, agent name, harness, cwd/project) — size/mtime/status_at ride the
next push and the list. Follow and read name a session through ONE resolver over that list
(exact session_id, exact path, a workgroup agent's name = its newest non-subagent session, a
unique id prefix; a miss re-polls once; unknown/ambiguous is an RPC error) and hand `agent`
the path. `agentEvents/follow {session, from?}` / `unfollow`: one `agent transcript --follow`
per transcript and byte, shared, killed when no subscription holds it — a display
disconnecting drops its own — at most `--max-followers`. `agentEvents/lines` batches (≤50 ms
or 256 KB, in order, whole lines, on their own display plane behind control traffic; a display
that leaves a push waiting 10 s loses the subscription rather than the relay buffering).
`agentEvents/ended` (a follower exited, code + stderr; or code -1, the display stalled) waits
on that plane as long as the display stays, behind the lines queued before it — a display
always learns. Followers' stderr lands in the relay log as `[agent-transcript]`.
`agentEvents/read {session, from?, until?, tail?}` → `{lines, size}` is a bounded one-shot
ending at min(until, size) (a running session's not-yet-written transcript reads as
`{lines: [], size: 0}`; an ended one's missing file is an error); `tail` (not with `from`) starts at the first line start at/after
`end - tail` (`--from` the line before), so `{until, tail}` pages back without the prefix.

The LOAD FLOW self-reports: every load runs a staged trace (`[load]` console lines →
the relay log store; `load.stats` answers with stage aggregates + the worst
main-thread blocks, which an always-on long-task watcher attributes to the load they
interrupted as `[frames]` lines). `bun tools/loadstorm-check.mjs` asserts the batching
invariants headlessly — one relayout per bulk load, coalesced registry notification.

- **AttentionManager** (`services/interaction`) owns three slots: `hover`, `primary`
  (sticky focus), `key` (keyboard target). One writer per slot; `attention.set <slot>
  <id|none>`. Attention is the person's: `attention.set|clear|capture` (and `point.go`) refuse an
  IDENTIFIED caller (`glyph3d-cli --as`, default `AGENT_NAME` — the per-call `ctx.caller`, nested
  calls included); an agent points (`point.show`) or waits (`agent.waiting`) instead. Agents are
  PRESENT at desks (`carrel.attach|detach|who`, `app/client/Participants.js`: listed in their hue
  in the Carrels panel, what they seat there carries their name; ephemeral — dropped when gomuxai
  reports them ended or the desk folds). Gate: `tools/carrel-session.test.mjs`.
- **Keyboard responder chain** (`app/client/keyboardRouter.js`, the keyboard twin of
  `gestureResolver`) is the one capture-phase listener: an ordered, composable tier list
  (entity typing → Esc/context pop → nav keymap; camera WASD is the bubble fallthrough).
  The first tier to claim a key consumes it; it yields wholesale when a DOM input is focused.
  Terminal/grid byte+edit translation comes from `keyEncoding` (`services/interaction`).
  `keys.trace on|off` logs each key event the router sees (key, code, modifiers, repeat, the tier that
  claimed it, the plane state it met) as a `[keys]` record in the log store.
  A verb a key runs that fails (ERR, a throw, a rejection) or answers with a `notice` shows on the status
  line (`keyVerb` → `ctx.status.notice` → the StatusBar, fading after `keys.noticeMs`); the command bar
  and the CLI never pass there (`tools/key-notice.test.mjs`).
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
- **Flat render root** (`collections/FlatRenderRoot.js`): the view camera renders a flat list of the
  drawables it can see — rebuilt only when visibility, scene membership or layers move (layer writes are
  watched; go through the `Layers` methods) — not the scene tree: three's walk visits what draws, not
  every container (~6.5k visits a frame → ~1k on the hub). The frame's main pass renders it
  (`app/client/FramePasses.js` — the ONE render owner, `<RenderPasses/>`: one `useFrame(…, 1)`, passes
  main → overlay → cloud → minimap declared with `ctx.renderPasses.add`, never a second
  positive-priority useFrame nor a scene onAfterRender hook; a second loop owner is logged loudly and
  shown FAIL in `scene.render`; screenshots draw through it, `screenshot --passes main[,…]` just the named
  passes); cameras off layer 0 (overlay, cards) take
  the scene, picks their own lists (`pick.flatRoot`). What three must walk itself (a Group with renderOrder, lights, LODs) goes in whole; a
  drawable whose own onBeforeRender may read the scene, or a shadow-casting light, switches it off
  loudly (named) until the scene changes. `render.flatRoot` (on) is the A/B; `scene.render [time n]`
  reports it and checks it against a fresh walk. Gates: `tools/flat-root.test.mjs`, `tools/flat-root-check.mjs`,
  `tools/render-passes.test.mjs`, `tools/render-passes-check.mjs`.
- **Glyph tiers** by on-screen size, nothing in between: exact Slug coverage (counted once,
  premultiplied); under `glyph.greekPx` (default 8 px tall) a glyph is a bar through the
  x-height where its ink would be (`core/glyphMaterial.js`, about as much light as the text);
  under far-LOD's size, one box per file.
- **Far-LOD** (`collections/GlyphFarLod.js`): a culled field whose tallest row measures
  under `glyph.showGlyphsPx` (default 1 px, at its box's nearest view DEPTH — what the row
  projects to, not its distance) stops drawing its glyphs — it leaves the view camera's
  layer 0, so `visible` keeps its owners — and one instanced quad of its mean ink colour
  (`InstancedField.farTint`; alpha = ink cover × `glyph.backdropGain`) stands in. All
  backdrops are one draw. Gates: `tools/glyph-far-lod.test.mjs` (the decision + tint) and
  `tools/far-lod-check.mjs` (pixels).
- **Panel batching** (`collections/PanelBatch.js`): the backdrop surfaces — flat panels (window
  backgrounds, page faces, label plates), box fills and box outlines (book covers, directory
  prisms) — stay real objects their owners pose, paint and register for picking, but draw as
  instances: `enrollPanel(obj)` marks one, and a `PanelBatch` refreshes from `scene.onBeforeRender`
  (this frame's matrices; never on pick passes) into one draw per kind × render state, taking each
  object off the view camera's layer 0. Buckets cull per instance, sort translucent instances as
  three sorts objects, and draw just before their render-order band (panels, then fills, then
  outlines). Gates: `tools/panel-batch.test.mjs`, `tools/panel-batch-check.mjs`.
- **Glyph batching** (`collections/GlyphBatch.js`): labels (every FieldLabel — book tabs,
  nameplates, dock titles) stay real InstancedFields their owners write and pose, but draw from
  ONE arena field: `enrollGlyphField(field)` marks one; a `GlyphBatch` refreshes from
  `scene.onBeforeRender`, copies each label's glyphs into a range (in three's far → near order;
  recopied only when text, colour, membership or that order changes) with its own group-table
  row, writes each row's pose from the label mesh's matrixWorld (camera-relative) every frame,
  and zeroes the alpha of hidden or off-frustum labels. A sheared pose or a glyph outside group 0
  draws itself; batched labels skip far-LOD. Gates: `tools/glyph-batch.test.mjs`,
  `tools/glyph-batch-check.mjs`.
- **Scene transforms** (`collections/SceneTransforms.js`): world matrices are recomputed where
  something moved, not across the whole tree every frame. A node joining the scene gets
  `TrackedVector3` position/scale (its old vectors are frozen — a write through a reference held
  from before throws) and hooked quaternion/rotation; a write that changes a value marks the node
  and flags its ancestors, and the scene's `updateMatrixWorld` (taken over) enters only flagged
  subtrees. At rest it visits the root and stops. Cameras, `matrixAutoUpdate = false` nodes (a
  hand-written `.matrix`) and pivots are handed to three's forced update every walk, judged as they
  join (the module header lists the changes the walk can't see on a node already in the scene).
  The same marks answer "in this scene, and shown?": `Object3D.prototype.visible` is an accessor
  (loaded with the module), and `rootOf(obj)` / `isShown(obj)` re-walk an object's ancestors only
  when the show generation moves (a `visible` flip, a tracked node gaining or losing a child) —
  PanelBatch, GlyphBatch and GlyphFarLod read them, and need a SceneTransforms on their scene.
  `scene.transforms` reports the last walk and checks every world matrix against a fresh
  recompute; `scene.transforms who [ms]` names the moving nodes that started the recomputes over a
  window (the "who never rests" probe — an ease must LAND on its target, never approach it forever:
  `Carrel.update`'s member turns do). Gate: `tools/scene-transforms.test.mjs`.
- **Agent sessions** (`app/client/SessionBooks.js`, `services/data/AgentSessionProvider.js`):
  gomuxai is the ONE reader of agent transcripts (its docs/EVENTS.md); the relay runs
  `agent sessions --json` (pushed whole as `agentSessions/changed`; `agentSessions/list`) and
  `agent transcript <session>` per followed session, and only moves lines
  (`agentEvents/follow|unfollow|read` RPCs; `agentEvents/lines|ended` pushes). Every agent book
  opens through SessionBooks: `read {tail}` (doubling until it holds the book's cap) → hydrate →
  `follow {from: the last at}` → each pushed batch through `AgentEventReader` → `applyEvents`
  (an add is a sheet, an update rebuilds its sheet in place; a file sheet shows the event's
  `file` text — what the call read, or the file as it left it — else reads its target joined
  to the session's cwd, and a refused read says why on the page); paging back reads
  `read {until, tail}` windows before each oldest `at`. A FOLLOW only while the session runs
  (not ended — a follower is a relay process, and the relay caps them; `setLive` as the status
  moves); every follow drops the book's provisional replies first, and `agentEvents/ended` (or a
  reconnect) re-follows from the last `at`, backing off. A result far from its call (a
  background call's, megabytes on) is read or followed BEFORE its call: the lane holds it as an
  orphan and the call adopts it when it pages in. A failed open keeps its book and retries; a
  refused follow or a failed open says so on the book (its notice, also in the Agents panel). A
  live call that lands ok taps the delta books' watch lane with its event record (meta carries
  an edit's patch), and an Edit / Write LANDS in the file if it's open (`app/client/AgentEdits.js`:
  the file as the call left it, swapped in place; the row you're reading — a framed grid's top row,
  else the plane view's center line — keeps its screen row; a grid you're editing is left alone;
  never from a history read). Lane ids: a workgroup agent's gomuxai name (its main session — its
  subagents carry its workgroup too), else the session id (`laneForSession`). The **agents
  desk** (`app/client/SessionDesk.js`) is the `agents` cylinder: the local sessions (no
  workgroup) live or written within `gomux.historyHours` — the newest `agents.maxBooks`
  (default 24) — get books, a session's subagents sit on its own `agents/<session id>` team
  desk (DeskTree, the hub's rule), older sessions open on demand (`agent.open
  <session|prefix|name>`, the Agents panel's history — the whole session list) and are seated
  there too — a workgroup's subagent (a hub agent's, opened from history) sits on its agent's
  team desk at the hub instead; a team desk whose helpers' books have all closed folds. Restore
  reopens saved books (by session) through the same path, parents before subagents; a session
  that ended before the `gomux.historyHours` window stays closed unless its book was pinned or
  tuned (the Agents panel's history opens it). **Hidden agents** (`app/client/AgentVisibility.js`,
  `ctx.agentVisibility`) get no book at all — no read, no follower, no seat, no screen — yet stay
  listed (dimmed) in the Agents panel: an agent's own override (`agent.hide` / `agent.show`;
  `agent.open` shows) else its group's rule (`agent.group <gomux|local> <shown|hidden|ended>` —
  `ended`: only running agents get books; a new agent follows its group). It is the ONE "stays
  closed" memory: `agent.clear` on a book the hub or the agents desk opened hides it (one opened
  from history just closes), and a hidden session keeps its `agents.maxBooks` slot. The hub and
  the desk converge on the rule (every push, every change) and wait on `agentVisibility.ready`
  before opening anything; the set is the durable `agents:visibility` surface (Visibility
  component), saved as the snapshot's `agentVisibility` and restored in stage 1, so a reload
  never opens a hidden agent. `agent.hidden` reports it. Gates: `tools/session-books.test.mjs`,
  `tools/agent-events.test.mjs`, `tools/agent-visibility.test.mjs`.
- **gomuxai hub** (`app/client/GomuxHub.js`, relay `cli/gomux.go`): the relay keeps one
  `agent export --json --follow --all` running (gomuxai's own read-only feed of every store it can
  find; `--gomuxai <dir>` adds a `--store`), folds its lines into the agent tree, and pushes it
  (`gomux/changed`; `gomux/list`). Each agent shown (live, or finished within
  `gomux.historyHours`) is an agent book whose lane id is its gomuxai name, opened from its
  current session (the node's `sessionId`, else its transcript's path) through SessionBooks
  (`agentEvents/*`: gomuxai's events, never the transcript itself); an
  agent that moves on to a new session keeps its book. The tree is desks (`app/client/DeskTree.js`): the world-managed
  `gomux` carrel — born a CYLINDER by default (`gomux.hubForm`: a natural-seat ring whose rows
  stack up to `carrel.cylinderMaxRows` before it widens past `carrel.cylinderRadius`; everything
  around you is a camera turn away); an agent with helpers OR a live screen gets its own
  `gomux/<name>` desk seated in its parent's desk (its book first, then its helpers), titled
  `<name>` (`· N helpers` with helpers), born `gomux.gap` apart and in `gomux.teamMode` — a PLANE
  by default, so its book and its screen are pins side by side and entering it reads the agent's
  terminal at your terminal's size.
  Desks seat a Book by `getSeatBounds()` — the room it draws in (cover pad, tab ruler, nameplate)
  — while framing and the tree keep its page box (`getLocalBounds`). An agent book RESERVES its
  room (`Book.setReserve`, at its sheet cap): its frame (`frameBounds` — the spread, the deck
  at the cap, the full rise; set by its settings, never by what's on screen) is what the cover
  wraps, the nameplate (bottom pinned, `book.labelGap` above; its band only grows), tabs and
  aside anchor to, and the seat measures — sheets landing and pages turning move none of it.
  Seats are CALM (`Carrel`): a member that claims its room (`claimsSeat` — a framed book, a
  desk) is seated as stated; any other (a grid, a terminal) by a seat that only GROWS (the
  union of its sizes), so a shrink never pulls its neighbors in. Seats are also STICKY: a desk
  remembers them (in seat order, in its durable layout record — `carrelPanes.js`), so a member
  leaving (hidden, ended, closed) leaves a GHOST seat that keeps its room and nobody moves; one
  coming back takes its own seat; a newcomer takes the first ghost, else appends (a centered ring
  then re-centers rigidly — the arrangement holds); only `carrel.settle [name]` repacks (ghosts
  go, seat order, sizes re-learned). Hub desks are `derived` —
  rebuilt from the tree, never saved — yet a value set on one is its own and comes back with it
  (per-instance knobs, below). Status rides `lane.meta.gomux` (the agent's own status wins
  over what a live batch did to the book). The relay names a claude agent's session by its
  transcript's file name when export reports none. `gomux.attach <name>`
  shows the agent's live tmux screen as terminal `gx-<name>`, riding beside its book (the book's
  aside — `Book.setAside`: right of the cover, height-fit to it, in its seat box) — with NO
  tmux client on gomuxai's server (any client there, even read-only, becomes the default target of
  every tmux command and broke gomuxai's send-keys): a capture-pane snapshot, then `tail -F` of the
  pane's pipe-pane log, inside our own terminal session; input goes nowhere (`gomux.detach`
  closes only ours). One adapter per screen: the relay answers a repeat ask (a reload re-asking
  before its adapters re-adopt) with the live one. A screen reads its agent's pane size (the relay
  pushes `gomux/paneSize` when it moves) and a resize writes back (`gomux.resize` → tmux
  `resize-window` on the agent's session — a server command, no client — and its CLI reflows).
  With `gomux.autoScreens` (default on) every live agent's screen opens beside its book; a
  detached one stays closed. Seating converges (`GomuxHub._seatScreens`, on every tree push, book
  open and terminal registration): a screen up but not riding its book is given to it, whichever
  arrived first — a reload re-adopts screens before their books open.
  Once per load (`gomux.centerOnLoad`) the camera stands at the hub's center (`carrel.enter`)
  when the tree, the books and the desks have stopped moving — polled to the same answer three
  times, since the load is part events, part state.
  Verbs: `gomux.list`, `gomux.status`, `gomux.refresh`, `gomux.attach`, `gomux.detach`.
  Nothing here starts or stops an agent. Answering is opt-in (Settings ▸ gomuxai `gomux.input`,
  off by default — read-only): `agent.say <name> <text>` / `agent.approve [name] [--expect <tool>]` /
  `agent.deny [name]` run gomuxai's own `send` / `approve --expect` / `deny` through the relay
  (`agent/*` RPCs, `cli/agentinput.go`; never a tmux client), approve only for the tool gomuxai
  reports pending (unknown → refused); the person's verbs (an identified caller is refused). A
  printable key on a focused agent screen opens the CommandBar as `agent.say <name> …` (the reply
  line); the plane prefix's `y` / `n` answer the agent in focus. Gates: `tools/agent-input.test.mjs`,
  `cli/agentinput_test.go`.
- **Plane view** (`services/camera/planeView.js`, `ViewerCameraController.enterPlane|leavePlane|
  setPlaneFov|setPlaneFan|setPlaneBlend`, `services/camera/PlaneCamera.js`, verbs `plane.enter <target>
  [cellPx]` / `plane.leave` / `plane.fov` / `plane.fan` / `plane.blend` / `plane.aim` / `plane.state`): READING a surface pixel-exact. A perspective camera squared to a plane shows it at
  one uniform scale, so the camera eases (one continuous lens tween — a dolly zoom) to a narrow fov
  (`plane.fov`, 1°) at the depth where a text column is `plane.cellPx` whole device pixels (8 → the
  8×15 cell), the surface's cell-grid origin (`pixelOrigin()`, else its top-left) snapped to a
  device-pixel corner, near/far a SLAB around the
  surface (`plane.front`/`plane.back`) so nothing in front of it draws. The view camera is a PlaneCamera (`app/main.jsx`): three's PerspectiveCamera, its own matrix, at blend
  λ = 1, so the open world is bit-identical, and every system handles it (picking, culling, far-LOD,
  batches). `plane.ortho` (off by default) makes the endpoint ORTHOGRAPHIC instead: the camera keeps the
  open-world fov, stops where that lens shows the plane at its scale (d₀ ≈ 60–70 units, not ~5000), and
  blends λ 1 → 0 in the same ease, d₀ pinned to the referent's depth each frame. Layers behind the
  page then stand 1:1, and the fan slides each history page rigidly by whole px. On the flat plane the two endpoints differ only
  in the anti-aliased inner edge of the focus border, which stands in front of the plane
  (`tools/plane-ortho-check.mjs`). Every reading of a camera's scale goes through `spatialMath`
  (`clipW` / `pxPerUnitAt` / `viewHeightAt` / `worldPerPixel` read the projection matrix;
  `rayFromCamera` replaces three's setFromCamera, which is wrong below λ = 1). No other file takes trig
  of a fov; a gate in plane-camera.test checks it. The ease SOLVES the eye
  each frame (`_stepLens` on `planeView.dollyAt`): a referent — the surface point you were looking
  at (`plane.enter`), or a caller's `referent` — holds its screen spot (< 1 px; the end aim follows
  from it) at exactly the eased scale k(t); an explicit `aim` glides to the view center instead.
  Entering another plane while entered is a CUT to its endpoint (`plane.switchMs` 0; a slide above),
  home kept. A plane that moves while it's read follows: `enterPlane`'s `track` (carrel.enter: the desk's
  `getPlaneRect`) is read every frame, and a moved, grown or rescaled board keeps its top-left on the same
  device pixel (`_followPlane`; `tools/plane-follow.test.mjs`). Inside, drag pans 1:1, the wheel scrolls the surface under the cursor (else the plane),
  flight/look/dolly are off; a fly (`flyTo`: camera.focus, agent.focus, a ring desk's enter) first
  eases back to home, then flies — framed at the home lens; a restore cuts home; `getState` answers
  with the pose it was entered from (a save mid-plane restores to the open world). The FAN (`plane.fan on|off`, the held pane prefix) spreads layers behind the page: on the
  perspective endpoint a wider lens (`layers.fanFov`, keeping the scale: parallax); on the orthographic
  one the history pages slide rigidly, page i right by i·n whole device px (`layers.fanPx`, `plane.fan <px>`;
  `setPlaneFan` eases its own tween and tells `addPlaneFanListener` listeners — the camera never moves),
  while the member, its backdrop, focus border and suggest strips stay still.
  `plane.blend <0..1|default>` holds a blend (a test handle). Its life is a
  listener set (`addPlaneListener` / `removePlaneListener`): `enterPlaneView` installs one per
  controller that suppresses space-layer chrome (the tree's ownership traces) for exactly that span.
  `planeViewport()` → `{width, height, dpr, exact, box, why}`: exact = the drawing buffer IS the
  canvas's observed device-pixel box; entering an inexact one still enters, with a `⚠ NOT
  pixel-exact` notice in the OK line and a console.warn. `pick.at <x> <y>` (the GPU pick) and `scene.at <x> <y>` (a
  raycast naming every object under a point, all layers) say what is on screen where. Gates:
  `tools/plane-view.test.mjs` (the math vs three's projection), `tools/plane-camera.test.mjs` (the
  controller, frame by frame; PlaneCamera's matrix against three's at λ = 1 and 0; the open world
  bit-identical; the fov-trig gate), `tools/plane-oblique.test.mjs` (fanned layers on whole device
  px), `tools/plane-ortho-check.mjs` (GPU: before/after 0 px, ortho vs 1°, picking at λ = 0). Text is MONOSPACE on its cell grid (`core/LayoutGenerator.js`): the
  pen steps whole cells of `charWidth` (a wide glyph two, a combining mark none) while each quad keeps
  the glyph's true advance (ax/upem × `metrics.emWorld`), so at a whole-pixel cell every column
  starts at the same pixel phase (`tools/layout-cells.test.mjs`; `tools/pixel-check.mjs` measures
  pitch, stem crispness, stillness and advance on a screenshot or the live display). `tools/agent-display.mjs` is a self-healing headless display (real
  GPU) for agents to drive and screenshot while no person has the app open.
- **Plane desks** (`Carrel` mode `plane` — beside `ring` and `grid`; `carrel.create` makes one by
  default, `carrel.createMode`): a desk ENTERED and read flat, pixel-exact. It stands in the world
  exactly as it reads entered — a flat board at z=−R facing the doorway, its top-left a fixed point of
  the desk — and its layout NEVER depends on the viewport or the dpr: its unit is the atlas's
  (`Carrel.setPlaneUnit` from `planeUnitOf`: one text column every member is scaled to, `plane.cellPx`
  device px per column when entered). `carrel.enter <name>` eases the camera into the plane view
  squared to the board at that scale, aimed at the focused member, attention there at t = 0;
  `carrel.leave` eases back; `carrel.back` returns to the previous plane desk; Esc steps out.
  Arrangement (`planeArrange`, per desk): PINS (default) — every member at its natural size (a
  239-column screen is 239 columns wide, never clipped) on shelves `shelfCols` columns wide in seat
  order, `paneGapPx` gutters, every pin and cell origin on whole device pixels; a newcomer APPENDS (no
  earlier pin moves), a pin only grows (a grower moves only the pins after it), a leaver's slot stays a
  ghost until `carrel.settle` repacks (in seat order); a book pins with its headline one plane row (`planeRowHeight`;
  else `bookCols` wide); a gomuxai agent's screen is its own
  pin right after its book (not the book's aside). TILES — a tiling window manager over a desk-sized
  frame (`tileCols × tileRows` cells): a PaneTree of panes, each a stack of members (tabs), a joiner
  lands in the INBOX pane, reflowable members take their pane's cols × rows and lend out their header.
  `pane.*` act on the entered plane (pins: `pane.focus` by direction slides the aim to the neighbor
  pin; tiles: split/focus/resize/close/swap/zoom/tab/place/layout), else the CameraDock frame. Keys:
  the plane PREFIX (Ctrl+Space, above terminal typing) then h/j/k/l focus, Tab back, f fan (toggle),
  z/]/[/x/e/m/s on tiles, q leave; unprefixed, with nothing holding the keyboard, h/j/k/l and the arrows hop pins too
  (`keymap.js` PLANE_BINDINGS — never the open world's tree walk). A click inside a plane focuses
  and never moves the camera (`gestureResolver.js`, `planeReading`): primary, a terminal's keyboard,
  the desk's pin (`pane.focus <id> --keep-view`), never `camera.focus`. The layout is durable (the Panes component on `carrel:<name>`, `carrelPanes.js`);
  so is the plane being read (the Entered component, `planeEntered.js` — re-entered after a reload
  once the desk stands, the hub's load centering standing down meanwhile). A save records a member's
  OWN view, never its holder's (`Holding.ownViewOf`). Gates: `tools/carrel-plane.test.mjs`,
  `tools/plane-keys.test.mjs`.
- **Depth as time** (`collections/LayerStack.js`, `app/client/layerSources.js`, `app/client/LayerStacks.js`,
  verbs `layer.show|hide|list|where`, `pane.layer`, `pane.blink`, `grid.history`): a member's past as PAGES standing
  behind it on its own cell grid (`layerFrameOf`: a code grid's text, a scroll book's body, a terminal's screen) — a
  file's revisions (the relay's read-only `fs/gitLog`: `git log --follow` + each revision's text, `cli/gitlog.go`;
  leading copies of what's shown skipped), an agent scroll's turns (`AgentBooks.turnLayers`), a terminal's
  scrollback by screen (`terminalPageLayers`). History at z = −rank·pitch (`layers.pitchRows`, floored so page text
  never pokes through), raised `layers.riseRows` per rank so each page's top row peeks over the one in front —
  counted from the member's frame top, title included (`layers.riseFrom`), so page 1's shows above the title; suggest
  strips in front, exactly over the lines they'd replace. Every page and the member itself get an opaque backing
  exactly the member's width (a page's glyphs clip to its columns; the member's reaches up through its title band), so
  a translucent member never shows what's behind. `pane.layer <id> <n>` fronts a page at EXACTLY z = 0 (the member's
  glyph meshes hide meanwhile); `now` restores the member. The fan is the plane's (`plane.fan`): holding the pane prefix
  (Ctrl+Space) past key-repeat sends `plane.fan on`, release `plane.fan off`; the prefix then `f` toggles
  it (`plane.fan toggle`), with no key-repeat needed. A desk the plane view reads
  (entered, or holding the member read) draws live, never as its card, so its members' pages stand in
  the scene. `layer.where` says where the pages stand, in the world and on screen. Stacks are saved
  (`LayerStacks.serialize` → the snapshot's `layerStacks`) and re-shown once each member stands up again. Gates:
  `tools/layer-stack.test.mjs`, `tools/layer-fan.test.mjs`, `cli/gitlog_test.go`.
- **Per-instance knobs** (`app/client/tuning.js`): Settings are the values a desk or a shelf book
  is BORN with — a Settings change never pushes onto a live one. A value set on ONE instance
  (`carrel.set <name> <knob> <v>`, `book.set [id] <knob> <v>`, `book.form`) is its own and wins:
  no owner re-stamps it (the hub's tree push, the agents desk's sweep, a shelf's Settings
  re-apply — `Book.setDeckDefaults` passes a book's own deck values by); `default` hands a knob
  back (a desk to `Carrel.born`, a book to its shelf's default); `carrel.get` / `book.get` read
  value · born · own. Own values are the workspace model's durable `Tuning` component
  (`view.tune`, keyed by registry id: `carrel:<name>`, `agent:book:<id>`, `delta:book:<id>`),
  saved as the snapshot's `tunings` and restored FIRST — so a saved desk (whose `serialize()`
  holds what it was born as) and a derived hub desk (rebuilt each boot) both stand up wearing
  them, and anything registering later is projected. The HUD's collapsible **Desk** section (the
  desk the focused thing sits at) and **Book** section (the focused agent/delta book) show and
  edit them through those verbs. The hub and the agents desk are born cylinders
  (`cylinderForm`: `carrel.cylinderRadius`, `carrel.cylinderMaxRows`).
  Gate: `tools/desk-tuning.test.mjs`.
- **Books** (`collections/Book.js`) — library volumes, agent runs, delta sets: a deck of
  sheets whose one nav state is the head. The open sheet fronts at z = 0, the sheets still
  ahead recede a pitch each — and RISE a step each (`deck.rise`, the first `riseRows`; agent
  books `book.deckRise`), so every headline ahead peeks over the page in front like a list
  row and a run's rhythm reads at a glance — the sheets turned past lie pressed in a block
  at the deck's back — the deck's box never depends on the head. A turn CUTS the sheets changing sides
  and slides the reading deck at most `books.turnSlide` pitches: nothing flies through the
  deck. Shift+wheel / two-finger drag page through a detent (`app/client/wheelDetent.js`,
  `books.wheel*`); bare `book.*` verbs and the `, . < >` keys page the book in focus
  (`app/client/bookFocus.js`). An agent sheet is a spread: the verso (`[verb]` headline,
  the call's remaining lines, info rows) and the recto (prose, a file snapshot, an output,
  an image). Each side has a text size (a world row height: `versoTextSize` is the
  headline's, `rectoTextSize` prose's — the other blocks keep a ratio of it) and a break
  (`wrap` to the page | `natural`, the text's own lines): Settings ▸ Agent Books holds the
  deck defaults, `book.set <id> <knob>` (the HUD's Book section) gives one book its own.
  ONE sizing rule (`fitTextStack`, `collections/ActionPage.js`): a block's size is the most
  it's set at; too big for its page, it scales DOWN — a natural long line shrinks its block
  (left to right), wrapped text shrinks only if still too tall; nothing is upscaled.
  Gate: `tools/book-page-text.test.mjs`. An agent book's tabs are its timeline (each sheet's number in
  the run, hued by action kind, the open one raised); the HUD reads turn · sheet · live|held
  (the turn = the open sheet's event's prompt). Fed by gomuxai's event stream
  (`collections/agentEvents.js` reads it; `AgentBooks.applyEvents`), a book is one sheet per
  EVENT, never grouped: prompts of every origin are first-class sheets (tagged by whose words —
  `[you]`, `[you · queued]`, `[delivered]`, `[notification]`, `[peer]`, `[command]`,
  `[harness]` — in the prompt hue), bookkeeping tool calls are sheets too, set in a dim noise
  hue (`book.showNoise` off hides them), every sheet carries its turn id + index, and an event's
  update (a tool's result, a confirmed reply) rebuilds its sheet IN PLACE (`Book.replaceSheet`).
  An agent book is a fixed-size WINDOW (its cap of sheets) sliding over its whole run
  (`AgentBooks.setHistory` — SessionBooks gives it the session's `agentEvents/read`): pushing past its
  oldest sheet slides it one sheet back (the older one materializes at the front, the newest
  waits as a parsed record), past its newest slides it forward, `book.page last` slides it to the
  live end. Sheets outside the window are records, not GPU objects; every record carries its
  source line's byte offset (`at`), and paging within `historyLead` of the oldest sheet prefetches
  older records: `read {until, tail}` — the last ~`historySliceBytes` before the oldest record
  (doubling until it holds `historyTurns`), reading `historyOverlapBytes` past it so an edge call
  pairs with its result (a farther one is an adopted orphan). Sheet numbers are an estimate
  until paging reaches the run's start, which makes them exact; a page whose read fails says so
  (`headState.failed`) and isn't re-read on every page. While the window is held away from the live end, live sheets wait beyond it (the HUD's
  `+N newer`) — the book never grows or shifts under the reader.
  Gates: `tools/book-deck.test.mjs`, `tools/book-controls.test.mjs`, `tools/agent-book-history.test.mjs`,
  `tools/agent-events.test.mjs` (gomuxai's corpus).
  The third form, **scroll** (`book.form <id> scroll`; an agent book seated at a plane desk is born
  one — `book.planeForm`, told by Carrel's `onDeskMode` — until given its own form), reads the run as ONE document at one size
  (`collections/ScrollDocument.js`): a title row (name, a status lamp, `turn · step · live|held`,
  `+N newer`) over a headline row per event (`[verb] head` in the action hue) and its body indented
  under it — the call's other lines and info rows dimmed, prose lifted toward white, an output or a
  file's text plainer; hue, never size, carries the hierarchy. Rows wrap to `book.scrollCols` by the
  layout's own cell rule (`wrapCells`; nothing dropped — a break keeps its space). An output or a
  file longer than `book.scrollCollapseRows` lines is one summary row (`▸ output · 214 lines`) until
  a click on that row (or `book.expand`) opens it — the gesture resolver's pre-empt asks
  `AgentBooks.scrollHit` what the pointer ray meets, so the click never flies the camera off the page. The sheets
  stay as light placeholders (no cards), so the deck's window machinery is the scroll's
  (`book.scrollMaxRecords` events; older/newer buffers; slides; in-place updates), each window
  change mirrored as a block op; the document lays out once a frame from its first changed block
  (a live batch: just its tail — `InstancedField.writeTail` uploads that range), an evicted head
  goes dead (clipped) until a memmove compaction, and scrolling is the body group's offset + clip
  (no layout). Following, it rides the end; scrolled up it is held, anchored to the event it
  shows (live events wait as `+N newer`; reaching the end brings them in). The plain wheel scrolls
  rows (`book.rows`), Shift+wheel / `book.scroll` / `book.page` move by events (past the top,
  older history slides in). `book.view` / `AgentBooks.scrollView` give (session, at, row) and
  `applyScrollView` stands on it again (sliding or reading it back in). On a plane desk it pins
  like a terminal: `Book.metrics` / `pixelOrigin()` are the document's cell grid; its seat is its
  frame (`claimsSeat`). A view handed over before its book opens is held for the lane (a reload
  restoring the hub's books). Its body is reserved for the window up front (`book.scrollReserveSlotsPerEvent` × the cap, plus the dead head a
  compaction waits for), so a following book never grows — growth re-sends the whole body. `book.cost` reads what live batches cost it (applyEvents + the flush that lays each;
  `tools/scroll-cost-check.mjs` live, against the headless number). Gate: `tools/scroll-form.test.mjs` (corpus text == shown text, row
  widths, held stillness, reload, one id, click-to-expand, the per-batch cost at the cap with teeth).
- **Terminals** are tmux-backed (socket `tmux -L glyphd` — `serve --tmux-socket` gives a second
  relay its own, so it can't adopt or kill the first's — sessions `glyph-<id>`) via
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
  rendered frame — for the device the hand model follows, the MODEL's hand (repaired,
  skin-corrected metric joints through `HandSpace.toView`, the one phone → view mapping the
  stages share: his right → +x, up → +y, away → into the view), tipped back by `hand.tilt`;
  any other device, its image-space landmarks. Verbs: `hand.list` / `hand.status` / `hand.show` / `hand.hide` /
  `hand.place`, plus relay-resident `source.list` (answers with no display
  connected). **Hand-wire v2** is the face-down phone (Leap Motion's geometry: the
  phone on the desk, its depth camera looking up at the hand): `decodeHandFrame` reads
  metric `points` (meters, PHONE frame: +y toward its top edge, +z up out of its back)
  with per-joint `confidence` (null = unseen), and a `device` block on every frame,
  `hands: []` included (mount, gravity, ceiling, `sentAt`) — `SourceState.device` /
  `.latency`. **The live hand model** (core `hand/HandModel.js`, app `client/HandCalib.js` =
  `ctx.handCalib`) is always on, like XR tracking: every frame of the followed device teaches it
  — hands are TRACKED by continuity and left/right is a running vote over a track's life (the
  palm's anatomy while it faces down, Vision's label a little; an undecided or blink-long track
  feeds nothing, so no ghost hands); per hand, each estimate a decaying histogram (online
  quantiles that forget): the SKIN depth (points are skin — palm length regressed on
  (1 − cos²θ)/range gives r; every point is un-offset before anything learns), bone lengths as
  palm length × ratio × (1 + δ) on a reference skeleton (each bone's δ admitted by its evidence:
  weighted 1 − (bone·ray)², counted in independent poses — so repair works from the first
  second)
  (and `repair`: a joint seen in 2-D with no depth, or off its bone, is rebuilt along its `ray`
  at the bone length, the root chosen within joint limits), palm length (the scale), pinch modes → thresholds, the volume's
  percentile bounds, rest noise from still moments it finds itself, the palm template (Kabsch →
  yaw/pitch/roll from a learned neutral); a phone BUMP (attitude/gravity jump) re-learns the
  phone-frame parts (a slide, invisible to attitude, from `userAcceleration`). Each quantity reports value · weight · drift · settled/settling/idle/unknown.
  Its snapshot saves itself (client store `hand.model`, per browser) as a WARM START only.
  `hand/HandSpace.js` is the pass-through stage chain raw → spike gate → 1€ (rest cutoffs solved
  from the measured noise, its lag shown) → dead zone (k × the jitter left after the filter) → the volume through ONE
  isotropic gain, frozen once it settles (re-learned only on a bump / reset) → app axes, reading
  the model (Settings ▸
  Hand space / Hand model); the pinch tracker also keeps a stabilized pinch point (thumb → index at
  0.2) and, at onset, where it was 100 ms before (the closing motion moves it — Wolf 2020).
  **The displayed hand is ONE stabilized hand** (`hand/HandStabilizer.js`, `HandCalib.displayHand`):
  the merged joints (cloud fit / ray repair) filtered in the palm's own frame — palm pose, then
  each joint palm-local — every joint's One Euro tuned from its OWN measured noise, with a speed
  deadband at that noise; the scene hand, desk view, panel and cloud view all draw it. Its
  acceptance numbers (`hand/handMetrics.js`, live in calib.status and the panel): per-joint still
  jitter p95 (target < 0.5 mm, tips included) and lag while moving. Real sessions are RECORDED by
  the relay (`source.record start [name] | stop | status` → JSONL in the user cache dir, or
  `serve --record-dir`) and replayed headlessly through the same code (`bun tools/hand-replay.mjs
  <file> [--variant "name:hand.stab.k=v"]…`). Verbs `calib.status|inspect|reset|save|forget|pin|view`; the Hand dock panel is the convergence board.
  It polls `calib.status` only while a hand device is attached (`app/client/handsOn.js`
  pollWhileHands), and the hand cloud's picture-in-picture (`cloud.view`, born off) draws only then
  (`HandCloud.renderPip`). `hand/HandSim.js` is a face-down hand with known truth
  that just wanders (`hand.simulate on [mode] | bump`); gates `tools/hand-model.test.mjs`,
  `tools/hand-calib-app.test.mjs`. Gesture→verb and hand→camera binding are not built yet.
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
