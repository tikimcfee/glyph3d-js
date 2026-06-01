# Terminal Viewport Plan — headless emulator + our GPU renderer

**Status:** decided 2026-06-01, **hardened against the code + tmux/xterm reality**
(adversarial review folded in). Active plan for the resizable-viewport work; the
CodeGrid file-windowing half (#6 coordinate seam) is deferred to Phase 3.

## The decision

Render terminals by feeding a shell's output through a **headless VT emulator**
and rendering the resulting **cell grid with our GPU glyph stack**. We do not write
a VT emulator, and we retire the tmux `capture-pane` snapshot model.

**Committed engine: `@xterm/headless`** — verified DOM-free, runs headless (VS Code
uses it server-side), exposes `term.write(bytes)` and a `buffer.active` read API
(`getLine(y).getCell(x)` → `getChars()`, `getCode()`, `getWidth()`, color/attrs).

**`ghostty-web` is a *candidate*, not a settled swap.** It's real and active
(v0.4.0, Dec 2025), aims for xterm.js API compatibility and ships Ghostty's VT100
parser in WASM — but its documented path requires `term.open(canvasParent)` and
bundles its own `CanvasRenderer`; **headless/buffer-only is "theoretically
possible," not a supported mode**, and its read-side cell shape
(`GhosttyCell{codepoint,fg,bg,flags}`) differs from xterm's `IBufferCell`. So the
"zero-rewrite swap" is conditional on those verifying. Build against the xterm.js
buffer API; treat ghostty-web as a later experiment, not a guarantee.

This turns the earlier "stateless snapshot vs. write-our-own-emulator" fork into
"embed a proven emulator, keep our renderer as the differentiator" — text in 3D.

## Why (what the current terminal stack can't do — from the subsystem map)

- `terminal.resize` resizes only the canvas grid; the shell is never told
  (`attach.go` spawns tmux at fixed `-x/-y`, no resize handler).
- **No scrollback** — `capture-pane` grabs only the visible pane (no `-S`).
- `parseCapturePaneAnsi` is a *snapshot* parser; it clips overflow and races resize.
  A real VT emulator correctly handles the *streaming* redraw protocol (cursor
  addressing, scroll regions, erase) that tmux emits — which snapshot parsing can't.

## The server model (tmux-backed, byte-streaming)

The enterprise pattern: a **session multiplexer** holds the persistent shell;
clients attach/detach. tmux stays — but mind exactly how a tmux *client* behaves.

```
shell ── tmux session on a dedicated socket (tmux -L glyphd)   ← persistence
              │  PTY (raw bytes both ways; creack/pty in the adapter)
         relay adapter (cli/attach.go, rewritten: byte pump, not snapshot pump)
              │  WS: terminal.bytes <id> <base64>  (coalesced; reuses roster/routing)
         browser: @xterm/headless  ── parses tmux's redraw stream into a cell grid
              │  buffer.active cells → translation adapter → ScreenBuffer
         TerminalGrid → GlyphField  ── our GPU 3D render
```

**The emulator behind tmux is a *screen mirror*, not an independent VT.** A `tmux
attach` client receives tmux's own internal-grid redraws sized to the client — not
the application's raw output stream. tmux owns the grid: it does **not** forward
alt-screen transitions (`?1049h/l`), so `less`/`vim` arrive as ordinary cell
redraws; `buffer.active` stays on `buffer.normal`, `buffer.alternate` is never
populated, and **the emulator accumulates no scrollback of its own** — it mirrors
whatever tmux paints. (The emulator still earns its place: it correctly parses
tmux's *streaming* redraw protocol into a cell grid, which the snapshot parser
can't.) True emulator-owned scrollback/alt-screen requires bypassing the tmux
client (raw shell PTY) — that's the Phase 3 fork, deliberately not Phase 1.

**Session lifecycle:**
- **Dedicated socket** `tmux -L glyphd` — isolates our sessions and lets us
  neutralize keymaps without touching the operator's own tmux.
- **Create-or-adopt is two steps, NOT `tmux new -A -d`** (that errors `rc=1 "open
  terminal failed: not a terminal"` on an existing session, because `-A` turns it
  into attach + `-d` supplies no TTY). Guard: `tmux -L glyphd has-session -t
  glyph-<id>` → if absent, `tmux -L glyphd new-session -d -s glyph-<id> -x C -y R
  <shell>`. Then `set -t … status off` (clean pane) and **neutralize the client
  keymap** so the PTY is a transparent byte-pipe: `set -t … prefix None; set -t …
  prefix2 None`, and on the socket clear the binding tables the client would
  otherwise intercept (`unbind -a -T prefix; -T root; -T copy-mode; -T
  copy-mode-vi` — plain `unbind -a` clears only the prefix table; root-table mouse
  + copy-mode bindings survive without the `-T` sweeps).
- **The adapter holds a real PTY** (`creack/pty`, a NEW Go dep — see Risks) running
  `tmux -L glyphd attach -t glyph-<id>` and streams the master both ways.

**I/O:**
- **Output:** PTY master → coalesce (~16 ms) → `terminal.bytes <id> <b64>` → browser
  → `term.write(decoded)`.
- **Input:** browser key → bytes → `terminal.bytes` → relay → PTY master write.
  Ordinary terminal input — *no `send-keys`* (today's hex `send-keys` translation
  retires). Verified on tmux 3.6b: echo+CR, arrows (`\x1b[A`), Ctrl-C (`\x03`),
  paste all flow verbatim. **Caveat:** with the prefix neutralized (above) the
  client is transparent; if the prefix were left live, `C-b` would be eaten by the
  client (writing `C-b d` *detaches*) and never reach the program. Neutralizing is
  mandatory, and it's why scroll is driven by tmux *commands*, not prefix keys
  (below).
- **Resize: SIGWINCH only — do NOT call `tmux resize-window`.** `terminal.resize` →
  `pty.Setsize` (TIOCSWINSZ → SIGWINCH to the client). With `window-size latest`
  (tmux's default, ≥2.9) the single attached client's SIGWINCH drives the window
  automatically. `tmux resize-window` flips `window-size` to `manual`, after which
  client SIGWINCH is *ignored* and the window pins — actively harmful. (Pin
  `window-size latest` at create as insurance against inherited user config.) The
  emulator also `term.resize(c,r)`.

**Scrollback — tmux-owned, driven by commands (not the prefix):** the emulator
mirrors the visible pane; "scroll back" is the adapter issuing tmux commands
directly — `copy-mode -t …` then `send-keys -X -t … scroll-up/scroll-down/page-up`
— which tmux repaints to the client and the emulator renders. This works *with the
prefix neutralized* (we don't route copy-mode through `C-b`). "Resize big" already
gives lots of live canvas immediately.
> Decision: tmux-owned scrollback to start. Emulator-owned smooth scrollback (raw
> shell PTY + server-side history ring + replay) is **Phase 3**, only if copy-mode
> UX proves insufficient.

**Persistence / re-adopt — needs a NEW trigger.** The tmux session survives a
browser reload, and a fresh `attach` repaints the current screen into a fresh
emulator. BUT today's self-heal fires only when the periodic `terminal.frame`
keepalive bounces `ERR: no terminal` (`attach.go:204-234, 289-293`) — and that
keepalive *is* the snapshot pump we're retiring. With a raw byte stream an **idle
shell emits nothing**, so nothing bounces and re-adoption never fires. Phase 1 must
add a **liveness ping decoupled from output** (a cheap periodic adapter→relay probe
whose `ERR: no terminal` reply triggers re-adopt + a tmux redraw), independent of
shell activity.

## Renderer integration

- **Cell-source swap + a translation adapter (not a bare swap).** TerminalGrid
  sources cells from `term.buffer.active` instead of `parseCapturePaneAnsi` (which
  retires for terminals). But `applyScreen` consumes `{codepoint:number,
  fg:{r,g,b 0..1}, bold}`, and xterm `IBufferCell` does **not** give `fg:{r,g,b}` —
  `getFgColor()` is mode-dependent (default / 0-255 palette / `0xRRGGBB` RGB),
  disambiguated by `isFgDefault()/isFgPalette()/isFgRGB()`; `getChars()` is a
  *string* (wide/combining), `getWidth()` is 1/2/0. So add an
  `emulatorScreen → ScreenBuffer` adapter that branches on color mode (palette →
  `ansi256toRGB`/`ansi16toRGB`, RGB → `/255`, default → reset), maps `!!isBold()`,
  and handles wide-cell trailing slots. **Lift the palette tables (`ANSI_16`,
  `ansi16toRGB`, `ansi256toRGB`, `RESET_FG`) out of `TerminalCapture.js` into a
  shared module** — the SGR snapshot parser retires, the palette doesn't.
- **Cheap steady-state.** Reuse TerminalGrid's in-place `_writeToInstanceBuffer`
  (cols×rows scalar writes, two `needsUpdate` flags, no realloc) for content frames.
  `TerminalGrid.resize()` is the expensive path (full `applyPrebuiltBuffers`
  realloc + background rebuild + `glyph` pick-channel re-register) — fire it only on
  an actual cols×rows change, committed once (see Interaction).

## The shared viewport abstraction

A *viewport* = a cols×rows cell window with a resize handle, screen anchor, and
wheel-routed scroll. The **interaction shell is shared**; the **content backend is
polymorphic** — emulator buffer (terminals), file slice (code-grid windows), or a
**graphics surface** (a GUI app as cells via `chafa`/term.everything now,
Kitty-Graphics-Protocol pixels later — see the Later kit). Terminals adopt it
first; CodeGrid windowing and the graphics backend come later.

## Interaction (#7 wheel-gate, #8 resize control)

- **#7 wheel-route gate — BUILT (commit `a1f171c`), verified end-to-end.** Gate at the
  top of `_applyWheel()`: `if (this.ctx?.tryScrollFocusedTerminal?.(wheel.dy)) { reset;
  return; }` before the zoom/pan path. The hook (defined on the client ctx, forwarded
  onto VCC's separate ctx by CommandProvider beside `isGripPress` — see
  [[two-scenecontext-topology]]) checks `attentionManager.get('key')` is a terminal,
  maps `dy`→lines (~30px/line, min 1, wheel-up = +back), and dispatches `terminal.scroll
  <id> <lines>`. A focused terminal eats the wheel AND keys (consistent); click empty
  space to release. Scrollback is tmux-owned: the adapter drives `copy-mode` +
  `send-keys -X scroll-up/-down`, repaint streams back on the byte lane (no client scroll
  state). **Two copy-mode traps fixed adapter-side** (the copy-mode keytable is unbound,
  so the user can't escape it and typing into it is swallowed): scroll-down doesn't
  auto-exit at the bottom → leave copy-mode at `scroll_position 0`; and a keystroke while
  scrolled snaps to live (`exitScroll` before the PTY write). Verified via tmux:
  back / partial-forward-stays / bottom-exits / no-op-when-live / type-to-exit. The one
  hands-on-only link is the wheel *event* → gate (can't generate a real wheel headlessly).
- **#8 resize control — a new `handle` pick channel.** Add small corner/edge
  sub-meshes per viewport on a new `flat` channel (next free layer ≥9) of the
  multi-channel `PickingSystem` (`defineChannel`/`register` — same pattern the
  `grid` channel uses for `_background`). Resolves distinctly from the whole-panel
  `grid` channel. Manage its lifecycle alongside the per-resize `glyph`-channel
  re-register. Drag math clones `ObjectDragger` (pointer-capture + view-plane
  delta) but maps Δscreen → **Δcols/Δrows snapped to cell stride** — add a helper
  exposing stride (`GlyphField.metrics`: `charWidth+letterSpacing`, `lineSpacing`,
  already world-scaled; today recomputed inline in ≥4 TerminalGrid spots).
- **Live-preview cheap; commit once on release.** During drag, only stretch the
  background panel mesh + draw a ghost outline at the snapped Δcols/Δrows — do NOT
  re-grid cells. The real `TerminalGrid.resize()` (expensive: realloc + pick
  re-register) fires exactly **once on pointerup** via the `terminal.resize` verb
  (which also drives `pty.Setsize` + `term.resize`). CLI↔canvas parity preserved.
- **Anchor & hit-test.** Lean in-scene mesh (the `SelectionIndicator` "Box3Helper
  tracks a grid" pattern), registered into the `handle` channel — `entityInputRouter`
  is **null** in the r3f client, so GPU picking is the only hit-test there.

### Resize — build state (picked up post-compaction 2026-06-01)

**FOUNDATION DONE** (commit `9881e18`): `handle` channel is live in `DEFAULT_CHANNELS`
(`{ layer: 9, kind: 'flat' }`, PickingSystem.js). Each `TerminalGrid` has a green
SE-corner grip mesh (`_initHandle`/`_positionHandle` — a child Object3D, visible
affordance AND pick target), registered into `handle` with token `{ grid, edge:'se' }`
in `setPickingSystem`, re-positioned + re-registered in `resize()`, disposed in
`dispose()`. `TerminalGrid.cellStride` → `{x,y}` world-units/cell (gridScale included).
Verified: the grip renders on a live terminal.

**ResizeDragger — BUILT** (`apps/ide/CanvasInteraction.jsx` `ResizeDragger` + `CanvasPicker`
hover loop; `ViewerCameraController.js` mousedown; `app/client/CommandProvider.jsx` forward).
Loads clean live; the grip-drag gesture itself awaits a hands-on pass. Shape:
- **Hover (in `CanvasPicker`, the ONE pick owner):** after the `grid` hover pick,
  `markDirty()` then `pickAsync('handle')` → `applyHandleHover(token, sampleX, sampleY)`
  sets `ctx.handleHover` (+ `ctx.handleHoverAt` = the SAMPLED pixel) + the `nwse-resize`
  cursor. `markDirty()` between the two picks is MANDATORY (one shared `_needsPick` latch).
- **Press authority = `ctx.isGripPress(x,y)`** (NOT the raw async flag). It gates
  `handleHover` on FRESHNESS — cursor still within `DRAG_PX` of `handleHoverAt` — so a
  press never resizes a grip the cursor has already left. ONE predicate, consulted by
  both `ResizeDragger.onDown` AND VCC mousedown.
- **Drag:** plain-LMB while `isGripPress` → capture `{grid,id,startCols,startRows,
  startBounds,startX,startY}` + pointer capture + `ctx.resizing=true`. Move maps the
  screen delta through the camera right/up basis (NOT raw dx/dy — first-person camera can
  view a panel rotated), depth probed at `startBounds` CENTER; `Δcols/Δrows` via
  `cellStride`, clamped to `MIN_COLS/ROWS`. Ghost `Box3Helper` (NW pinned, SE pushed,
  depthTest off); NO re-grid mid-drag.
- **`endDrag(e, commit)`** is the single teardown for pointerup (commit) AND
  pointercancel/lostpointercapture (no commit) AND unmount — resets `resizing`/
  `handleHover`, so an interrupted drag can't wedge the canvas. Commit = ONE
  `terminal.resize <id> <cols> <rows>` (drives grid + emulator + PTY SIGWINCH).
  `CanvasPicker.onUp` + its hover useFrame both early-return while `ctx.resizing`.

**Two gotchas this build surfaced (both load-bearing):**
1. **VCC runs on its OWN `SceneContext`** (built in `ViewerCamera.jsx`), NOT the client
   `ctx` the hover loop writes — only `attentionManager` was otherwise bridged across.
   So a flag the picker sets on `client.ctx` is invisible to VCC. Fix: `CommandProvider`
   forwards `isGripPress` onto the camera-controller ctx via a live getter
   (`Object.defineProperty(cc.ctx, 'isGripPress', {get:()=>state.ctx.isGripPress})`),
   next to the existing `attentionManager` share. The original "shared `handleHover` flag"
   design was wrong on this point — verify cross-ctx assumptions.
2. **Async pick vs sync gesture:** GPU pick is a fenced WebGPU readback (≥1 frame), the
   press is synchronous. `isGripPress` freshness-gating closes every *wrong-target* case;
   the residual is a blind fast-grab (press before the pick resolves) falling through to a
   pan — the documented contract is "settle on the grip (the cursor confirms), then drag."
   If that feel ever bites, the upgrade is a synchronous raycast against the grip meshes
   (deliberately NOT done — collides with this repo's "GPU pick is the one hit-test" rule).
- **Occlusion is by-design, not a bug:** the grip renders depthTest-off (always-on-top
  overlay), so "the grip you see is the grip you grab" even over another terminal's panel.
- Adversarial review (3 lenses × verify) drove the fixes above: stuck-`resizing`, the
  async race + stale flag, camera-orientation math, center-depth. 4 findings were refuted.

## Transport (load-bearing) — DECIDED: binary lane, data/control plane split

After a pattern audit (control mode vs raw-attach; ttyd/AttachAddon conventions),
the transport is **a binary WS lane**, not base64-in-text — base64 is a ~33% tax on
the hottest path and the de-facto tools (ttyd, xterm.js AttachAddon) send raw bytes.
"One and best way": a clean **data-plane / control-plane split**, no compat path.

**Control plane — JSON commands through the router (mechanism unchanged):**
`terminal.spawn/create/close/kill/focus/list/move/scale`, and `terminal.resize`
(low-rate; reuses the existing display→controller `push` path). These manipulate
grid lifecycle + scene, not byte streams.

**Data plane — the bytes:**
- **OUTPUT (adapter→display, the hot stream): binary frame.**
  `[type:u8=OUTPUT][idLen:u8][id:utf8][raw VT bytes]`. Coalesced ~16 ms in the
  adapter. The relay forwards controller→display binary frames verbatim (the frame
  self-describes via `id`; the display is singular so no routing lookup).
- **INPUT (display→adapter, sparse keystrokes): existing JSON `push`.**
  `push(owner, {event:'terminal.bytes', data:{terminalId, b64}})` → adapter decodes
  → writes PTY master. Base64 tax is nil on keystrokes, and it reuses owner-routing
  that already works — binary here would buy nothing. (Retires `terminal.input`'s
  `data.text` + the `send-keys -H` hex path.) Binary where it pays, the existing
  path where it doesn't — *not* two ways to do one thing.

**Losslessness + backpressure (the subtle part).** `sendToDisplay` today uses
`make(chan []byte, 64)` and **drops on full** — safe for self-correcting snapshots,
fatal for a VT stream (one dropped chunk desyncs the parser). And the channel is
**shared** (FS-RPC, livereload, command responses), so blocking it head-of-line
stalls *everything*. Therefore:
- Split the display writer into **two channels**: the existing `displayWrite`
  (control/JSON, non-blocking drop-OK — self-correcting, rare) and a new
  **`displayBytes`** (binary OUTPUT frames). One writer goroutine drains both with
  **control-priority** (a priority `select`: control first, else either).
- `displayBytes` forwarding is a **blocking send** → lossless. When full, the
  *controller's own goroutine* blocks → TCP backpressure to that adapter → adapter's
  output goroutine blocks → its PTY read pauses → kernel PTY buffer backpressures
  tmux/shell. Control traffic is never blocked (separate channel). No drop, no HOL.
- **Adapter MUST use separate output and input goroutines** — else a blocked
  output-write would also stall input processing (deadlock). Output goroutine:
  PTY→coalesce→WS binary. Input goroutine: WS→PTY master.
- Per-terminal byte channels (so a flooding terminal A doesn't throttle B) and
  explicit ttyd/tmux-style **PAUSE/RESUME** verbs (proactive, vs relying on TCP
  buffer) are **later refinements** — blocking-send + TCP backpressure is lossless
  on its own for the typical one-active-terminal case.

**Browser receive:** `socket.binaryType='arraybuffer'`; `_handleMessage` branches on
`ArrayBuffer` → parse the OUTPUT frame → `emulator.write(payload)`. JSON path
unchanged for everything else.

## Build — one coherent push, dependency-ordered (not gated phases)

The whole terminal viewport is one piece of work; the only real ordering is
*dependency* — the interaction can't drive a byte-pipe that doesn't exist yet, so the
pipe lands first. It is not a sequence of gated phases with acceptance ceremonies.

**The pipe (steps 1–2 DONE — commit `ed9d866`; step 3 in progress):**
1. **Relay binary lane** (`relay.go`): add the `displayBytes` channel + control-
   priority two-channel writer; forward controller→display binary frames (blocking
   send = lossless). Capture `ReadMessage` type; `BinaryMessage` from a controller →
   `displayBytes`. Control/JSON path unchanged.
2. **`attach.go` rewrite** (+ `attach_unix.go`/`attach_windows.go` build-tag split;
   `go get creack/pty`): create-or-adopt guard (`has-session` → `new-session -d`, NOT
   `new -A -d`, NOT kill-first) + `status off` + `window-size latest` + keymap-
   neutralize (`prefix None` + `unbind -a -T {prefix,root,copy-mode,copy-mode-vi}`,
   `// PHASE 3: tmux -CC deletes this`); `pty.Start(tmux -L glyphd attach)` with
   `TERM=xterm-256color`. **Two goroutines**: output (PTY→coalesce ~16 ms→WS binary
   OUTPUT frame), input (WS `terminal.bytes` event→PTY master). `terminal.resize`
   event → `pty.Setsize` (SIGWINCH only). Decoupled liveness ping (`terminal.ping`)
   so idle-shell re-adopt fires. Windows stub errors (keeps `CGO_ENABLED=0` green).
3. **Browser** (`bun add @xterm/headless` in `apps/ide`): `WebSocketBridge`
   `binaryType='arraybuffer'` + OUTPUT-frame parse → `emulator.write`. `terminal.create`
   spins up the `@xterm/headless` Terminal + a throttled `buffer.active → ScreenBuffer`
   pump (the color-mode/width/bold adapter) → `TerminalGrid.applyScreen`. Keystrokes:
   `onInput(bytes)` → `push(owner, {event:'terminal.bytes', data:{terminalId, b64}})`.
   Lift palette tables to a shared module; retire `terminal.frame`/`terminal.input`/
   `parseCapturePaneAnsi`/`parseCapturePanePlain`/`grid.write`.
4. **Acceptance: spawn a terminal, resize it large, run a program that fills it,
   type in it — all correct end-to-end; reload re-adopts.**

**The interaction it rides (same push, once the pipe works):**
5. #7 wheel-gate in `_applyWheel` → scroll the focused terminal (tmux copy-mode cmds).
6. #8 resize handle: `handle` pick channel + cell-stride helper + drag→snap + ghost
   preview + commit-once-on-release; persist viewport size in SessionStore.

## Later — pull from this only when a need actually shows up (a kit, not a roadmap)

7. Emulator-owned smooth scrollback (raw shell PTY + server history ring + replay).
8. `ghostty-web` evaluation (only if headless + cell-API verify).
9. Share the viewport shell with **CodeGrid windowing** (#6): the source↔visible
   coordinate seam, edit-in-window, the LayoutDescription question.
10. **Graphics-surface content backend** — the "terminal all the things" direction,
    a new viewport backend kind in two tiers:
    - *Free, Phase-1-compatible:* `mmulet/term.everything` is a Wayland/X11
      compositor that converts any GUI app's window to ANSI cells via `chafa` — a
      *producer* of the exact colored-cell stream our renderer already consumes. So
      `term.everything <app>` inside a `glyphd` terminal renders that app as a live
      3D glyph mosaic with **zero new protocol**. Caveats: constrain `chafa
      --symbols` to glyphs the font actually shapes (verify U+2580–259F block-element
      coverage); GUI mouse rides the SGR-mouse-reporting input path.
    - *Full-res, needs work:* the **Kitty Graphics Protocol** — image at grid points,
      composited as a texture over the cell rect in 3D. Conflicts with the tmux
      mirror (tmux doesn't forward graphics APC; `@xterm/headless` doesn't parse it),
      so it rides the raw-shell-PTY fork (#7) + a protocol-ingest pass +
      per-cell-rect texture compositing. Reference: **`orhun/ratty`** (GPU terminal,
      inline 3D + KGP). Underlying tech: `hpjansson/chafa`, `kovidgoyal/kitty`.
    North Star: terminals + windows + command bus → **the local OS in 3D, commands
    surfaced around the whole thing.**
11. **tmux control mode (`tmux -CC`)** — the multiplexing graduation (pattern audit,
    2026-06-01). It does NOT fix alt-screen/scrollback (tmux still owns the grid; you
    still need the emulator to interpret `%output`) and adds a `%begin/%end/%output`-
    unescape parser + pane/layout bookkeeping — wrong for Phase 1. But it **deletes
    the keymap-neutralization hack entirely** (a control client has no keymap to
    lobotomize) and is the correct substrate once we want **multiple panes/splits per
    session**. When the `prefix None`/`unbind -a -T` workaround gets flaky or
    multi-pane is needed, graduate: PTY runs `tmux -L glyphd -CC attach`, `id` becomes
    pane-scoped, the OUTPUT frame carries unescaped `%output` per pane. Ref:
    `atomicstack/gotmuxcc` (read its parser; likely write our own ~150 lines).

## What changes / retires

- `cli/attach.go`: snapshot frame pump → PTY byte pump + SIGWINCH resize + liveness ping.
- `terminal.frame` snapshot payload → `terminal.bytes` append chunks (envelope reused).
- `parseCapturePaneAnsi`/`parseCapturePanePlain`: **public `@glyph3d/core` exports**
  (`src/index.js`, `collections/index.js`) — retiring is a public-API removal. Only
  caller is `TerminalGrid.write()`. **Lift the palette tables out first**, then retire.
- `terminal.resize`: now resizes shell (SIGWINCH) + emulator + grid in lockstep.
- Input: today's `terminal.input` text + `send-keys -H` → raw bytes to the PTY.
- New dep: `@xterm/headless` (browser) + `creack/pty` (Go).

## Open decisions / risks (verify during build)

- **Two live frontends share the handler spine.** The Go binary embeds + serves the
  **legacy vanilla app** at `/app/ide.html`; the **r3f client** (`apps/ide`) runs
  only under Vite dev. `terminalCommands.js` / relay / `attach.go` are shared. The
  byte-pipe + `terminal.bytes` change affects BOTH — decide: gate the new path to
  the r3f client, or accept the legacy app's terminals break (it's the removal-wave
  branch; the old IDE is slated for retirement anyway). Do not assume only `apps/ide`.
- **Windows build.** `creack/pty`'s POSIX path is CGO-free, but the binary
  cross-compiles `windows-amd64` with `CGO_ENABLED=0` and `attachCmd` is registered
  unconditionally (`main.go`). Guard the PTY path behind build tags / a runtime
  capability check, or terminals become a non-Windows feature.
- **Resize race.** Order of relay `pty.Setsize` vs. browser `term.resize` matters;
  a mis-ordered frame parses new-size redraws against an old-size buffer. Name a
  single source of truth (the adapter's size) and tolerate a 1-frame reflow.
- **`@xterm/headless` per-frame read cost** at large cols×rows; and its bundle size.
- **Scrollback ownership** — re-evaluate tmux-copy-mode vs emulator-owned after Phase 1.

## Out of scope (for this plan)

CodeGrid windowing coordinate seam + edit-in-window (#6) until Phase 3; the
LayoutDescription/layout-substrate refactor; `ghostty-web` until its headless +
cell-API viability is verified.
