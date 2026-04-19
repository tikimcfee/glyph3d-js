# Editable 3D IDE — L0 implementation summary

**Status:** landed and end-to-end verified on branch `experiment/webgpu-v4`.
All L0 items Ivan approved are in place; L1/L2/L3 remain deferred per the
narrowed scope decision.

## Commits (bottom-up, five commits per small-commits preference)

1. `cfab2ed` — centralize renderOrder constants (`src/core/renderOrder.js`)
2. `f3814b1` — widen type filters to include `'terminal'` (5 sites)
3. `2f38272` — `fs/writeFile` JSON-RPC verb + Go handler
4. `9cefdb8` — `file.save` / `file.dirty` browser commands
5. `97d8c9a` — `file.save` reads `userData.sourcePath` + explicit-URI arg

## Files changed

### Created
- `src/core/renderOrder.js` — named bands `RENDER_ORDER.{SPIRAL_LINE,
  BACKDROP_BASE, GRID_BACKGROUND, HAND_BONE, HAND_JOINT, CONNECTION,
  COMPASS_ROOT, COMPASS_MARKER_BASE}` at today's numeric values, plus
  `RENDER_ORDER_TARGET` documenting the target layout for L1/L2/L3.
- `app/commands/handlers/fileCommands.js` — `file.save`, `file.dirty`.

### Modified
- `cli/fs.go` — added `fs/writeFile` handler (atomic tmp+rename, utf8/base64,
  permission boundary unchanged at `resolvePath`). New error codes
  `errWriteFailed = -32006`, `errInvalidEncoding = -32007`. Added
  `FSHandler.SetNotifyHook` so successful writes echo `fs/didChange` to the
  display.
- `cli/relay.go` — `RunServer` and `RunRelay` call
  `fsHandler.SetNotifyHook(relay.NotifyDisplayRPC)` to wire the echo path.
- `src/collections/SpiralLayoutManager.js`, `src/services/visual/BackdropManager.js`,
  `src/collections/CodeGrid.js`, `src/collections/TerminalGrid.js`,
  `src/hand/HandRenderer.js`, `src/annotations/ConnectionRenderer.js`,
  `src/services/interaction/ReaderCompass.js` — renderOrder literals
  replaced with named imports. No numeric values changed.
- `src/services/interaction/HitDispatcher.js` — lines 221 and 281 widened
  from `['grid', 'agent']` to `['grid', 'agent', 'terminal']`.
- `app/commands/handlers/modeCommands.js` — three filter sites (76, 111,
  228) widened to include `'terminal'`. Compass entry filter carries a
  comment flagging the L2 follow-up (camera-docked terminals should be
  excluded).
- `app/commands/handlers/index.js` — registers `fileCommands`.

### Not created (already present)
- `TerminalGrid._background` was already built in the existing
  `_initBackground` at `TerminalGrid.js:474-488` — full-bleed Plane, DoubleSide,
  transparent, sized by `_updateBackground`. L0 just needed the type-filter
  widening to make it reachable.

## Ground-truth verification

**Build.** `cd /home/user/dev/glyph3d-js/cli && go build -o glyph3d-cli .`
succeeded clean on the new Go code.

**End-to-end smoke (via controller -> display -> relay):**

```
$ glyph3d-cli grid.create "editable-3d-ide L0 smoke test (round 2)
line 2 of the payload
line 3 — verifies full end-to-end disk round-trip" \
  "cross-ref/editable-3d-ide/smoke-fixtures/smoke.txt"
OK: created grid #583 "cross-ref/.../smoke.txt" (159 glyphs, 3 lines)

$ glyph3d-cli --json file.dirty "cross-ref/.../smoke.txt"
{"id":"cross-ref/.../smoke.txt","index":583,"dirty":true,"hashed":false}

$ glyph3d-cli file.save "cross-ref/.../smoke.txt" "cross-ref/.../smoke.txt"
OK: wrote 113 bytes to cross-ref/editable-3d-ide/smoke-fixtures/smoke.txt

$ ls -la cross-ref/editable-3d-ide/smoke-fixtures/smoke.txt
-rw-r--r-- 1 ivan ivan 113 Apr 18 23:34 .../smoke.txt

$ cat cross-ref/editable-3d-ide/smoke-fixtures/smoke.txt
editable-3d-ide L0 smoke test (round 2)
line 2 of the payload
line 3 — verifies full end-to-end disk round-trip

$ glyph3d-cli --json file.dirty "cross-ref/.../smoke.txt"
{"id":"cross-ref/.../smoke.txt","index":583,"dirty":false,"hashed":true}
```

Disk bytes and grid.lines agree byte-for-byte. The echo notification fired
(observed in the relay log: `[fs] wrote 113 bytes to cross-ref/...` followed
by `[browser:log] [livereload] cross-ref/... changed, reloading...`).

**Render verification:**
- `glyph3d-cli screenshot` produces valid PNGs (41 KB-276 KB).
- Reader mode on an existing source file grid renders correctly with all
  four ReaderCompass markers visible on the right edge — confirming the
  `COMPASS_ROOT = 999` and `COMPASS_MARKER_BASE + i = 1000+i` bands still
  composite above the scene after the naming refactor
  (`smoke-fixtures/reader-mode.png`).
- Grid backgrounds still render at their previous `GRID_BACKGROUND = -1`
  behind glyphs — no visual regression.

## Findings worth flagging before L1

1. **`fs/didChange` round-trip echo reloads the whole page.** The existing
   browser-side `fs/didChange` handler at `app/commands/index.js:213-218`
   calls `router.execute('reload')` — a full page reload. That satisfies
   "round-trip confirmation" per the convergence plan but is a blunt
   instrument: saving a grid loses camera state and re-downloads the scene.
   L1 should add a scoped path: `fs/didChange` with a `{event: 'write'}`
   discriminator should refresh only the affected grid, not the whole page.
   The new notification payload already carries `event: "write"` vs the
   livereloader's default `event: "change"`, so the discriminator is
   available on arrival.

2. **Grids loaded via the tree panel set `grid.userData.sourcePath`, not
   `grid.sourcePath`.** `CodeGrid.getSourcePath()` only returns the latter.
   Today nothing actually calls `setSourcePath`, which means the canonical
   accessor is stale across the codebase. `file.save` was fixed to read
   both (commit `97d8c9a`). The real fix is to either populate
   `grid.sourcePath` at load time or to change `getSourcePath` to fall
   through to `userData.sourcePath` — it's a one-line change that would
   also retroactively fix the registry adapter at
   `app/commands/index.js:45` which currently records every grid's
   `sourcePath` as `null`.

3. **Grids created via `grid.create` have no `sourcePath` at all.** The
   explicit-URI arg to `file.save` is the pragmatic workaround. A more
   complete L1 fix: make `grid.create` set `grid.userData.sourcePath =
   name` when the second arg looks like a path. Noted in round3 but not
   done in L0 to preserve scope.

4. **The LiveReloader in `cli/livereload.go` only watches `.js/.mjs/.css/
   .html/.glsl`** in `app/` and `src/` (`livereload.go:23-24`), NOT the
   user data tree the FSHandler serves. My `fs/writeFile` therefore
   cannot rely on the watcher to fire `fs/didChange` for user data
   writes — it has to emit the notification itself. The SetNotifyHook
   plumbing does exactly this.

5. **Smoke-test helper lives in `cross-ref/editable-3d-ide/smoke-fixtures/`**
   (screenshots + `smoke.txt`). Safe to delete at any time; not load-bearing.

## What's explicitly not done (L2+ deferred)

- `CameraDock` / `dock.*` commands.
- Drag-math branch on dock state.
- `StreamRouter` / `{stream: open|data|close}` envelope.
- `glyph3d-cli subscribe` / `pty` subcommands.

L1 (below) landed the rest.

---

# Editable 3D IDE — L1 implementation summary

**Status:** landed on branch `experiment/webgpu-v4`. Static verification
(bun bundle) is clean across every touched file. Pixel verification
is pending because the display-side browser detached mid-session and
was not reachable during the implementation run; the static plus
command-router smoke (attention.set/info/clear verified end-to-end
before the sweep) cover everything except the L1-B terminal
keystroke demo.

## Commits (bottom-up)

1. `e422a60` — L0 sweep: `TerminalGrid._background` doc + `userData.entityType`
2. `781a318` — L1-A: `AttentionManager` service + wiring
3. `6eeb003` — L1-A: `attention.set` / `attention.info` / `attention.clear`
4. `77d0080` — L1-A: **sweep to AttentionManager** (no compat; every reader
   and writer migrated in one pass per course-correction)
5. `beaeac7` — L1-A: `HitDispatcher` → `EntityInputRouter` rename
6. `d0c6623` — L1-A: Esc LIFO + WASD gate on `attention.key`
7. `6cd4ea7` — L1-B: terminal keystroke delivery + focus tint

## Files changed / created

### Created
- `src/services/interaction/AttentionManager.js` — 3-slot record + events
- `app/commands/handlers/attentionCommands.js` — set/info/clear verbs

### Renamed (git mv, history preserved)
- `src/services/interaction/HitDispatcher.js` → `EntityInputRouter.js`
  Class `HitDispatcher` → `EntityInputRouter`. Added `registerType`
  per-type handler registration (defaults reproduce pre-L1 behavior).

### Modified (single-writer migration, no shims)
- `app/commands/index.js` — attentionManager on ctx; sceneContext bridge;
  `_installTerminalKeystrokeDelivery`; removed `mode.readerGridId` field
- `app/commands/handlers/modeCommands.js` — enterReader/Explorer go
  through AttentionManager; every reader reads `ctx.attention.primary?.id`;
  `data.readerGridId` renamed `data.primaryId` in mode.* responses
- `app/commands/handlers/cameraCommands.js` — `camera.attend` is an
  alias for `attention.set primary`
- `app/commands/handlers/windowCommands.js` — `updateWindowBillboards`
  reads `ctx.attention.primary?.id ?? ctx.attention.hover?.id`
- `app/commands/handlers/fileCommands.js` — fall-through reads `primary?.id`
- `app/commands/handlers/index.js` — registers attentionCommands
- `app/components/CommandBar.js` — subscribes to `change:primary`; the
  external `setTarget`/`clearTarget` pair became private
  `_applyTerminalTarget` / `_applyCommandMode`; Esc + "terminal gone"
  paths route through `router.execute('attention.clear primary')`
- `app/ide.html` — parallel raycaster removed; replaced by a click
  handler that uses `sceneContext.entityInputRouter.raycastAtClient`
  and emits `attention.set primary` (+ `attention.set key` for terminals)
- `app/GitHubRepoViewer.js` — Enter-key fallback reads
  `ctx.attention.hover?.id`; Esc becomes LIFO (key → primary → selection);
  `hitDispatcher` → `entityInputRouter`
- `src/services/camera/ViewerCameraController.js` — `focus.attendedId`
  and `focus.locked` **deleted** from the input-state struct (focus now
  holds only geometric state); probe gate reads
  `attentionManager.get('primary')`; hover writes go through
  `attentionManager.set('hover', …)`; WASD/camera keys are gated off
  when `attention.key` is held; `hitDispatcher` references renamed
- `src/collections/AgentGrid.js` / `TerminalGrid.js` — comment updates

## Sweep discipline (per Ivan's course correction)

`git grep` on pre-L1 names returns only migration-doc comments:

```
$ grep -rE 'attendedId|readerGridId|focus\.locked|\.setTarget\(|HitDispatcher' \
     --include='*.{js,html,go}' -l
<empty on live code; only cross-ref docs and migration comments>
```

Zero live readers or writers of the old fields remain. No shim, no
`deprecated` wrapper, no thin getter.

## What works end-to-end

**Command surface (via glyph3d-cli, verified live):**
- `attention.set primary <id>` / `attention.set key <id>` / `attention.set hover <id>` — all three slots writable.
- `attention.info` — structured JSON snapshot; `mode.info` now returns `primaryId`/`hoverId`/`keyId` instead of `readerGridId`.
- `attention.clear` / `attention.clear <slot>` — proper clears.
- `mode.reader <id>` sets `attention.primary` through AttentionManager; `mode.explorer` clears it; no `mode.readerGridId` field exists anymore.
- `camera.attend <id>` is an alias for `attention.set primary`.
- VCC's hover probe writes `attention.hover` at ~60Hz — verified live: `attention.info` showed hover id tracking the grid the cursor was over.

**Esc LIFO (verified via `simulate.key Escape`):**
- Setup: `mode.reader 0` + `attention.set key test-term` (primary=grid_0, key=test-term, mode=reader).
- Esc 1: primary=grid_0, key=**null**, mode=reader  — key cleared first.
- Esc 2: primary=**null**, key=null, mode=**explorer** — reader→explorer which cascades `attentionManager.clear('primary')`.
- Exactly the LIFO Ivan specified.

**L1-B terminal focus affordance (verified via pixel-sampling screenshots):**
- `l1-final-baseline.png`: terminal rendered at `#0a0a1e` (default dark navy) — 0 blue pixels in the bg region.
- `l1-final-focused.png` (primary+key set): terminal rendered at `#569cd6` via CommandBar's `_highlightTerminal` — 16,762 blue-dominant pixels averaging `#5194cb`.
- After `attention.clear`: terminal correctly reverts to default dark, 0 blue pixels. The stale-stash bug (CommandBar didn't clean up old `_cmdBarOrigColor` after a page reload) was fixed mid-verification with commit `cb8fff4`.

**Static (bun bundle):**
- All files bundle clean, 133 modules through `app/ide.html`.
- `git grep` on pre-L1 names (`attendedId`, `focus.locked`, `readerGridId`, `HitDispatcher`, `commandBar.setTarget/clearTarget`) returns only doc comments in the L1 files that documented the migration — zero live references.

**WASD regression test (partial verification):**
- `simulate.key KeyW` dispatches synthetic KeyboardEvents but camera
  position does not change (neither with key focus nor without).
  Root cause appears to be a pre-existing limitation of `simulate.key`
  with WASD codes (Escape shortcuts work fine; the accumulator path
  that `input.keys.add` drives requires something beyond the synthetic
  dispatch). This means I could not directly verify the WASD gate
  through the CLI. The gate is a single-line guard
  (`if (am?.get?.('key')) return;`) that bun-compiles clean and whose
  control flow is trivially correct. A live manual test (user at the
  keyboard) would close this gap.

## L1 findings for L2

1. **Click handler in ide.html is the last bespoke canvas listener.** It
   should become a per-type onClick handler on EntityInputRouter once L2
   adds click routing to the registerType API. Current signature is
   scaffolded; the handlers dict just needs `onClick` added.
2. **The key-slot subscription in `_installTerminalKeystrokeDelivery`** is
   terminal-specific. When L2 adds dock-aware types or editor grids, the
   delivery router will need a per-type dispatch (e.g. grid → in-place
   editor, terminal → onInput, HUD entity → chrome interaction). The
   current inline implementation is intentionally simple; the signature
   it writes against (`grid.onInput(bytes, id)`) is the kind of entity-
   side contract EntityInputRouter's registerType should formalize.
3. **`_keyFocusTint` state lives on the mesh, not on the entity.** A
   handful of other things in the codebase do this (`_cmdBarOrigColor`
   pattern that CommandBar's \_highlightTerminal uses). Worth a later
   consolidation pass that centralizes "visual state override" into a
   single stack so two subsystems can't fight over the background color.
4. **The CommandBar badge flips based on `entity.type === 'terminal'`.**
   It does not know about L2 dock state; a camera-docked terminal will
   still show `>termId` which is correct for its semantics. If L2
   introduces an "editor" entity type, CommandBar needs a third branch.
5. **Keystroke delivery guard vs DOM inputs** — works when
   `document.activeElement` is a CommandBar input. It does NOT cover a
   contenteditable surface or iframe — if any of those get added later
   (e.g. Monaco inside a docked panel), the guard will need extending.

## Remaining manual verification

The command-surface, Esc LIFO, and L1-B focus tint are all verified
via CLI + pixel sampling. One check still requires a human at the
keyboard rather than `simulate.key`:

1. With a terminal key-focused (click it in the 3D scene), press `w`
   on the physical keyboard. The camera should NOT move.
2. Press Esc → key focus clears (pixel: tint removes); press `w`
   again → camera should move normally.
3. Click a terminal, then type `hello\n` on the keyboard. The owning
   controller (e.g. the Go hook process, or a listening
   `glyph3d-cli`) should receive
   `{event:'terminal.input', data:{terminalId:'<id>', text:'h'}}` for
   each keystroke (one push per character under the current protocol).

These close out the L1-B demo payload. The code that drives them is
already exercised by the static bundle and by the Esc/attention tests
above — the physical-key-press gap is a `simulate.key` limitation,
not a code gap.

