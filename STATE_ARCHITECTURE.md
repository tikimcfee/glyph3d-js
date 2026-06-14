# App State — One Serializable Tree, One `apply()`

**Status:** plan — Ivan Lugo
**Date:** 2026-06-13
**Supersedes** the earlier reconciler-heavy draft of this file. Same destination, honest framing: the concept is "set app state from the saved blob"; the only real work is collapsing today's duplicate copies into one home and writing the function that pushes state onto the (deliberately non-React) live objects.

---

## 1. The model

It is just app state. Some state is children inside the app state. On reload, set app state from the serialized save.

```js
appState = {
  surfaces: { [id]: { kind, source, view } },   // view = the per-surface intent (below)
  field:    { source, layout, camera, focus },  // the workspace-level intent
}

save() = writeFile(JSON.stringify(appState))           // serialize
load() = { appState = JSON.parse(read()); apply() }    // deserialize + push to the scene
```

`WorkspaceModel` **already is `appState`** — `sheets` is `surfaces`, and each sheet's reserved-but-unused `view` field (`WorkspaceModel.js:32,81`) is where the per-surface intent goes. Fields already carry `source`/`camera`/`activeSheetId` slots (`:36`). The work is to *fill `view`*, move today's scattered copies into it, and write `apply()`.

## 2. Why `apply()` exists at all (the one wrinkle)

In a pure React app, `setState(saved)` is enough — the framework re-renders everything from state for free. We deliberately kept `@glyph3d/core` **out of React**: grids/terminals are vanilla `three/webgpu` objects mutated by command verbs and `scene.add`-ed, not `<CodeGrid/>` JSX. Nothing auto-applies state to them, so **we own the push-state-onto-objects step**.

You'd own it in React too — nobody re-creates a 10k-instance GPU mesh on every `setState`; you reach for a ref + imperative update in a `useEffect`. The push step is unavoidable whenever state drives something heavier than a DOM node. React hides it for `<div>`s; nobody hides it for a glyph field. So `apply()` is *the* job, and it is small:

```js
function apply() {
  for (const [id, s] of Object.entries(appState.surfaces)) {
    const live = registry.get(id);
    if (!live) continue;                 // not in the scene yet — re-run when it appears
    applyView(live, s.view);             // guarded writes: if (live.cols !== v.cols) live.resize(...)
  }
  applyField(appState.field);            // layout scheme, camera (load/move only), focus
}
```

`apply()` runs in exactly two situations:
- **After any state-mutating verb** — synchronously, in the same call. `terminal.resize` does `appState.surfaces[id].view.cols = c; apply()`. This keeps read-after-write intact: the live object has changed by the time the verb returns, so the CLI, tests, and chained handlers still see it. (No deferred event bus — that would silently break every read-after-write caller.)
- **On registry change** — `registry.onChange(apply)`. This is the *entire* fix for the reload race: a terminal re-adopts on the Go relay's own clock, lands in the registry, `apply()` re-runs and sizes it from `view`. No pending queue, no load-bearing order — `apply()` is idempotent (guarded writes) so re-running is free, and order stops mattering because it just re-runs until everything's converged.

That idempotent + re-run-on-change pair is the whole content of the word "reconciler." It is two properties, not a subsystem.

## 3. The one discipline: store inputs, not outputs

App state holds what the operator *chose*; never what the scene *computed* from those choices. Persisting an output means it goes stale the moment an input changes.

**Inputs → live in `view`/`field` and serialize:**

```js
view = {
  position : {x,y,z} | null,  // terminals + manually-moved grids only (tree grids omit — derived)
  zoom     : number,          // ScaleModel.user (the readability zoom)
  cols, rows : number,        // terminals — the resized cell grid
  window     : {cols,rows,firstLine} | null,   // code grid viewport
  frameRows  : number,                          // code grid clip height
  scrollOffset : number,
  fold       : LayoutParams | null,             // code grid newspaper/z-page/wall
  dock       : { member, slotOrder, focused } | null,
}
field = {
  source : {type:'local',dir} | {type:'repo',ref} | null,
  layout : {scheme, opts} | null,   // ContentTree packing — governs every tree grid's position
  camera : {pos, target, fov?} | null,
  focus  : {primary, key} | null,
}
```

**Outputs → recomputed, never stored:** a tree-laid grid's `position` (comes from `field.layout` + tree path), `ScaleModel.placement` (= home gridScale XOR dock tile-fit), `obj.scale` (= placement·user), the dock `slot` integer (recomputed from order), `home.scale/quat/bounds`, `LayoutDescription`, line tables, `getBounds`, `_modified` (= `contentHash` vs `_savedTextHash`).

**Ephemeral → thrown away:** hover, the caret/cursor mesh, in-flight `flyTo` tweens, relayout mutexes, frustum-cull visibility, `attention.hover`, the live PTY process, the visitor roster (mirrors live agent processes), input accumulators.

The boundary is the same one `InteractionContext` already nails (it owns nothing, derives focus/edit nodes on demand — keep it exactly as is). That's the reference for "derived done right."

## 4. What the live shell is (the genuinely-external child)

One surface kind has a part that is **not in the blob**: a terminal's PTY/tmux process lives in the Go relay. You can't deserialize a running shell — it re-adopts from the relay roster on its own clock. The model holds the terminal's *geometry intent* (`cols/rows/position/dock/zoom`); the relay owns the process. This is the only reason `apply()` must be re-runnable on registry change rather than once at load — and it's the source of the reload race we already half-fixed. `apply()` makes it a non-event: the re-adopted terminal appears, `apply()` sizes it.

---

## 5. Where state lives today (the audit — the useful payload)

This is why it isn't *already* a one-liner: the facts are smeared across copies, so "one home" doesn't exist yet. Collapsing these is the migration.

| Fact | Copies today (file:line) | Canonical home to keep | Store? |
|---|---|---|---|
| **terminal cols/rows** | **6 + file**: `TerminalGrid.cols` (`TerminalGrid.js:67`) · `TerminalEmulator.cols` (`:34`) · xterm buffer · registry `meta.cols` (create, `terminalCommands.js:162`) · registry `entry.cols` (resize, **diff key**, `:240`) · adapter `cfg.cols` (frozen at spawn, `attach.go:31`) · PTY winsize · session file (`SessionStore.js:149`) | `view.cols/rows`; `grid.resize` is the one applier (fans to emulator+PTY) | **store** — adapter always re-spawns 80×24, so the file is the only record on the normal reload path |
| **grid window/frame/scroll** | `CodeGrid._win*`/`_frameRows`/`_scrollOffset` (`CodeGrid.js:139,152,148`) + LayoutDescription mirrors (D) + file | `view.{window,frameRows,scrollOffset}` | **store** |
| **grid fold** (layout mode) | `CodeGrid.config.layout` (`:66`) — **captured nowhere**, resets to default on reload | `view.fold` | **store (GAP today)** |
| **window zoom** | `ScaleModel.user` (`ScaleModel.js:31`); `dock3d.tiles[].zoom` (docked only) | `view.zoom` (one home, docked or loose) | **store** — loose-grid zoom persisted nowhere today (GAP) |
| **window placement** | `ScaleModel.placement`; `config.gridScale`; `DockEntry.home.scale` | — (recompute: home scale XOR dock fit) | **derive** |
| **grid/terminal position** | scheme writes `leaf.position` (`packedLayout.js:112`); `CameraDock.home.pos`; file `entry.x/y/z` | `view.position` for terminals/manual moves only | **store (terminals/manual) / derive (tree grids)** — `file.open`'s `[x y z]` args are never consumed (`fileCommands.js:178`) |
| **terminal depth / terminal.scale** | `TerminalGrid._depthMax` etc; `ScaleModel.placement` via `setScale` | `view.depth`, `view.scale` | **store (GAPs today)** |
| **dock membership** | **4 + file**: `CameraDock.entries` · `AttentionManager.docks` (mislabeled "record of truth", `AM.js:70`) · `CameraDock.tiles` Set · scene parent · `dock3d` | `view.dock.member` (the rest become `apply()` outputs) | **store** |
| **dock slot order** | `DockEntry.slot` (recomputed, `CameraDock.js:412`) + `docks[].offset.slot` | `view.dock.slotOrder` (relative order only) | **store order / derive the int** |
| **dock spotlight** | `CameraDock.focusedId` (`:109`) — set only by an explicit gesture, no re-derivation source, lost on reload | `view.dock.focused` | **store** — it can be lost, therefore it's intent, not derived |
| **field source** | `ctx.fieldSource` (local) **or** `fileProvider._currentRepo` (repo) — two homes | `field.source` (unified) | **store** |
| **ContentTree scheme** | `ContentTree.layout/layoutOpts` (`ContentTree.js:54`) — **persisted nowhere**; resets whole field to packed on reload | `field.layout` | **store (biggest GAP — governs every grid's position)** |
| **camera** | live THREE camera; `snap.camera`; `field.camera` (null) | `field.camera` | **store** (see camera bugs §7) |
| **focus** (`attention.primary/key`) | `AttentionManager.state` — **not persisted**; re-derived by accident of last replayed verb | `field.focus` | **store** (tolerate `dir:`/`agent:` ids — not surface-only) |

## 6. Dead / unwired (delete; don't model)

- **Dead camera stack:** `camera/CameraController.js` + `camera/InputManager.js` (+ likely `Camera.js`) — zero `new` sites, reachable only via `index.js:58-59` barrel re-exports (the forwarder anti-pattern). Live controller is `services/camera/ViewerCameraController.js` (`ViewerCamera.jsx:44`). Also dead: VCC's DOM-slider glue (`ViewerCameraController.js:276-299,616-667` — targets `cam-speed`/`reset-camera`/`*-sensitivity` elements absent in `app/`).
- **Null in the r3f client:** `SelectionManager`, `SpatialWindowManager`+`WindowGroup`, `FileStateManager`, `CodeColorManager`, `EntityInputRouter` (`CommandProvider.jsx:110-115`); `select.*`/`group.*` silently no-op; the `groups` localStorage blob is write-only. Don't model until groups actually ship.
- **Dead writes:** registry `entry.cols/rows` + stale `meta.cols/rows`, `SceneRegistry.removeById` alias, `CodeGrid._markBoundsDirty()` stub, the `file-selected` CustomEvent (0 listeners), `WorkspaceModel`'s phantom `change:active` event (`:41`, never emitted), phantom camera settings (`rotateSensitivity`, `invertDragX/Y`).

## 7. Real bugs the audit found (shippable now, independent of the refactor)

- **`camera.speed` drifts 20×.** Ctor reads `g3d.camera.speed` raw into `cameraSpeed` (`ViewerCameraController.js:94`); `setSpeed` writes `value*20` to the same key (`:887`); the session path writes raw (`SessionStore.js:413`). Two unit conventions on one key. Pick one.
- **`camera.lookat` is silently a one-frame no-op.** It writes `camera.quaternion` (`cameraCommands.js:29`), but VCC's `pitch`/`yaw` overwrite the quaternion every frame (`_applyRotation:454`). Orientation intent is **pitch/yaw**; the fix is to sync them (as `camera.aim` already does).
- **FOV is captured but never restored** (`SessionStore.js:212` vs `:406-414`), and has no live writer (boot constant). Wire `apply` to set it or drop the dead capture.

---

## 8. Migration — collapse the copies into `view`, in order

Vertical slices: each moves one fact's copies into the model, points its verb at the model, and deletes the old copies/glue **in the same change** (no dual path for one fact across slices — honors no-compat-shims). Verify each with a deterministic headless bus-driven check (the `tools/dock-persist-check.mjs` style: drive verbs → save → simulate reload → `apply()` → assert live == intent, with re-adopt order fuzzed to prove order-independence).

- **Slice 0 — schema-tolerant restore + `WorkspaceModel.clear()` (prerequisite).** `SessionStore.restore` currently **wipes** on version mismatch (`:254`), and `repo.load`'s `ctx.workspace?.clear?.()` is a no-op (`WorkspaceModel` has no `clear()`). Until both are fixed, every "read old / write new" slice silently no-ops and a code rollback destroys the session. Make restore forward-additive (read old keys, default new ones); add `clear()`. *Pure de-risking; nothing else is safe without it.*
- **Slice 1 — terminal geometry** (the proven-broken fact, self-contained for loose terminals). `view.{cols,rows,position}`; `terminal.create/resize/move` write the model; `apply()` sizes grid+emulator+PTY. Delete `pendingTerminals`/`_placePendingTerminals`/`_applyDock3d`/`_reconcileSurfaces`, the dead registry `entry/meta.cols`, and **fix the Go side**: `attach_unix.go:485` must write `ev.Data.Cols` back into `cfg.cols` so re-create/wheel stop using the stale spawn size. Docked terminals finish in Slice 2.
- **Slice 2 — dock membership + zoom + spotlight.** `view.dock = {member, slotOrder, focused}`, `view.zoom` as the single zoom home (closes loose-grid zoom gap). Collapse the 4 membership copies + `AttentionManager.docks` into `apply()` outputs.
- **Slice 3 — code-grid viewport + scheme.** `view.{window,frameRows,scrollOffset,fold}`, `field.layout`. Kills the load-bearing `file.open→window→frame→scroll` replay order; closes the fold + scheme gaps.
- **Slice 4 — field source + camera + focus.** `field.{source,camera,focus}`. Fix the three camera bugs (§7); restore orientation via pitch/yaw; delete the dead camera stack. (Camera is heavier than the others — it fights the 60Hz input loop — so consider splitting field-source+focus from camera.)
- **Slice 5 — `SessionStore` → `serialize`/`deserialize`.** `capture()`→`serialize(appState)`, `restore()`→`deserialize + apply()`. Delete the last scrape/replay glue. Atomic cut, test-gated before commit (no runtime flag).

## 9. Gotchas to hold

- **`apply()` after a verb must be synchronous** (verb → mutate state → `apply()` → return), or read-after-write breaks for the CLI/tests/chained handlers. The grid relayout methods are async behind a `_relayout` mutex, so `apply()` awaits per-surface and its guards read post-await state.
- **Camera orientation is pitch/yaw, not the quaternion** — anything that writes `camera.quaternion`/`lookAt` is stomped next frame (`_applyRotation:454`). Apply camera on load/explicit-move only; the input integrator owns it per-frame.
- **Tree-laid positions are outputs** — never store a tree grid's xyz; recompute from `field.layout` + tree path. The discriminator (`type==='grid'` AND a live ContentTree leaf) is the one subtle helper to build + test first.
- **Two SceneContexts** — VCC runs on its own `SceneContext`, bridged into the app ctx one-shot in a `[relay]`-keyed effect (`CommandProvider.jsx:349-371`) that doesn't re-run on a VCC remount. `apply()` lives app-side; reach camera only through bridged fields and tolerate `cameraController` being null during mount.

**Bottom line:** app state is a serializable tree; `save` serializes it, `load` deserializes it and calls `apply()`; `apply()` pushes state onto the vanilla-three objects with guarded writes and re-runs on scene change. Everything above §5 is that. Everything from §5 down is just *where the copies are today* and *the order to collapse them*.
