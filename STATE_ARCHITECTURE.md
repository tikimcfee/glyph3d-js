# State Architecture — One Declarative World-State Model + One Idempotent Reconciler

**Status:** DEFINITIVE PLAN — Ivan Lugo, lead architect
**Date:** 2026-06-13
**Synthesized from:** a parallel state-ownership audit (persistence, workspace-model, terminal-geometry, codegrid-view, dock-scale, control-state, registry-legacy, + a separately-recovered **camera/two-ctx lane** that died on a socket error and was re-run), a reviewed DRAFT, and three adversarial critiques (completeness, classification, feasibility) — every high/med finding resolved below.
**Verified against source this session:** `WorkspaceModel.js` (full), `SessionStore.js:1-70,248-307`, `repoCommands.js:18-29` (`ctx.workspace?.clear?.()` is a no-op — `WorkspaceModel` has no `clear()`), `AgentGrid.js:89` (raw `grid.scale.setScalar`, no ScaleModel), `CameraDock.js:150-168` (`spotlight`/`homePosition`), `annotationCommands.js` + `gridVisualState.js` + `CommandProvider.jsx:140` (annotation/visual-state Maps, registry-bound, unpersisted).

---

## 1. Executive Summary

### The thesis

State in glyph3d-js is **peppered**: one fact lives in up to six live copies across the scene graph, four+ registry/manager maps, two persistence sinks, and a flat session blob — and the blob is **reconstructed by replaying imperative verbs against a concurrently-mutating scene**. `SessionStore.capture()` is a *scrape of live three.js objects at capture time* (it reads `grid.position`, `grid.getWindow()`, `grid.cols/rows`, `cameraDock.list()`, `camera.quaternion`, `dock.toJSON()` — all live, all concurrently mutable, `SessionStore.js:86-198`). A save landing mid-restore or mid-readopt scrapes a half-built scene; a restore replays size/frame/dock verbs in a documented load-bearing order against terminals that re-adopt on an independent clock. **That is the structural origin of the terminal-resize-lost-on-reload race and its whole family.**

### The dissolution

A **race exists only because there is a window in which the live scene and the durable intent disagree, and the code tries to *merge* them imperatively.** Remove the merge:

1. **Declarative world-state model.** Grow `WorkspaceModel` into the single home of *intent* — one record per surface, each carrying a declarative `view` (the per-surface geometry/placement/dock intent), plus field-level intent (source, packing scheme, camera, focus). Intent is a value, not a side-effect on a live object.
2. **One idempotent reconciler.** A single `live ← model` projection loop runs on every registry-or-model change. For each surface record it asks "does a live object exist?" — if yes, project the `view` onto it with **guarded set-to-target** writes (re-running is a no-op once converged); if no, leave the record and try again next change. No pending lists, no carry-forward merge, no ordering.
3. **Persistence-as-serialization.** `SessionStore.capture()` collapses to `serialize(model)`; `restore()` collapses to `deserialize(blob)` + one `reconcile()`. No scrape, no replay.

**Why this dissolves the race class:** the model is the durable buffer. A surface whose intent exists before its live projection (a terminal re-adopting async, a dock tile whose bridge hasn't registered) is no longer a special case requiring a pending queue and a load-bearing drain order — it is just a record the reconciler hasn't projected *yet*, and will, idempotently, the instant the live object appears, **in any order**. Capture reads a consistent intent snapshot even mid-restore because it reads model Maps, not a half-built scene. The "armed-too-late listener" race disappears because the reconciler is the model's first and only subscriber, live from construction — there is no separate "now start reconciling" step.

### Why it's low-risk to attempt

The seam is **already reserved and the discipline already exists three times, cleanly and locally**:
- `WorkspaceModel.sheets[].view` (`WorkspaceModel.js:32,81`), `field.camera` (`:36`), `field.activeSheetId` (`:36`) are forward-built intent slots — initialized null, *not* dead code (the model's own JSDoc, `:17-19`, says later steps are "thin verb additions, not model surgery").
- `ScaleModel.resolve()` is the **sole writer** of `obj.scale` *for model-backed grids* (`ScaleModel.js:60`); `AttentionManager.set()` is the **one-writer-per-slot** primitive; `InteractionContext` is a **derived read-model that owns nothing** (`InteractionContext.js:1-21`). The plan generalizes those three into one global loop.

The work is to *grow* `view`, *generalize* the three disciplines into one projector, and *collapse* the scrape-and-replay into (de)serialization — vertical slice by vertical slice, terminal geometry first.

---

## 2. State-Ownership Audit — the de-duplicated atom table

`I` = intent (serialize). `D` = derived (recompute, never store). `E` = ephemeral (throw away).
"Shadow" counts distinct *live* copies beyond the canonical home (the session-file copy is noted separately as `+file`).

### 2.1 Per-surface view atoms (the heart of the peppering)

| Atom | Canonical home (file:line) | Shadow copies (count + locations) | Writers | Persisted | Class + reason |
|---|---|---|---|---|---|
| **terminal cols/rows** | `TerminalGrid.cols/rows` (`TerminalGrid.js:67`) | **6 +file**: `TerminalEmulator.cols/rows` (`TerminalEmulator.js:34`) · xterm buffer dims (`TerminalEmulator.js:45`) · registry `meta.cols/rows` (create-time, `terminalCommands.js:162`) · registry `entry.cols/rows` (resize-time, **different key**, `:240`) · adapter `cfg.cols/rows` (frozen at startup, `attach.go:31`) · PTY/tmux winsize (`attach_unix.go:439`) · session file (`SessionStore.js:149`) | `terminal.resize` → `grid.resize` (`:233`); the one bus writer fans to 6 by side-effect | **partial** | **I** — operator-resized; the session file is the *only* record on the normal reload path (adapter re-spawns 80×24, `attach.go:42-43`). |
| **grid window** `{cols,rows,firstLine}` | `CodeGrid._windowed/_winCols/_winRows/_winFirstLine` (`CodeGrid.js:139`) | **1 +file**: `this.content` rendered slice (D); session `entry.window` (`SessionStore.js:109`) | `setWindow`/`scrollLines` (`CodeGrid.js:253,276`); `grid.window` verb | **yes** | **I** — operator viewport over a file. |
| **grid scrollOffset** (visual rows) | `CodeGrid._scrollOffset` (`CodeGrid.js:148`) | **2 +file**: `LayoutDescription.scrollOffset` (D, `CodeGrid.js:1650`) · builder opts (D); session `entry.scrollOffset` (`SessionStore.js:117`) | `setScrollOffset`/`scrollBy`; `grid.scroll`; wheel; async clamp (`CodeGrid.js:1443`) | **yes** | **I** — operator scroll through a framed grid. |
| **grid frameRows** (clip height) | `CodeGrid._frameRows` (`CodeGrid.js:152`) | **2 +file**: renderer `setClipYRange` (D, `CodeGrid.js:905`) · frame band geom (D); session `entry.frameRows` (`SessionStore.js:115`) | `setFrameRows`; `grid.frame` | **yes** | **I** — operator "clip to N rows". |
| **grid fold** (`config.layout`) | `CodeGrid.config.layout` (`CodeGrid.js:66`) | builder `shared` channel + `LayoutDescription` (both D) | `setLayout` (`CodeGrid.js:823`); `grid.layout` | **NO — GAP** | **I** — operator's chosen newspaper/z-page/wall. Captured nowhere; resets to `DEFAULT_LAYOUT` on reload. |
| **window user-zoom** (`ScaleModel.user`) | `ScaleModel.user` (`ScaleModel.js:31`) | **1 +file(partial)**: `dock3d.tiles[].zoom` (`SessionStore.js:181`) — **docked only** | `setZoom` (`ScaleModel.js:40`, sole mutator); `window.scale` | **partial — GAP** | **I** — "the persisted ZOOM" (`ScaleModel.js:14`). Loose-grid zoom persisted *nowhere* (`window.scale` calls `scheduleSave` but capture has no slot, `windowCommands.js:50`). |
| **window placement** (`ScaleModel.placement`) | `ScaleModel.placement` (`ScaleModel.js:29`) | **3**: `config.gridScale`/`_gridScale` (stale while docked, `CodeGrid.js:472`, `TerminalGrid.js:908`) · `DockEntry.home.scale` (`CameraDock.js:245`) · `obj.scale` (=placement·user, D) | `setScale`; dock via `SpatialAnimator` (`:150`); ctor | **no** | **D** — context scale: home `gridScale` (const 1.0) XOR dock tile-fit; recomputable. |
| **grid/terminal world position** | grids: scheme writes `leaf.position` (`packedLayout.js:112`). terminals/manual: `TerminalGrid.position` / `CodeGrid.position` | **3 +file**: `CameraDock entry.home.pos` (real home while docked, `CameraDock.js:244`) · `node.userData.size` footprint (D); session `entry.x/y/z` (`SessionStore.js:106,147`) | scheme relayout; `grid.move`/`terminal.move`; dock | **partial** | **D for tree-laid grids** (re-derived every relayout; `file.open`'s `[x y z]` args **never consumed**, `fileCommands.js:178`) / **I for terminals + manual moves**. Persisting a tree-grid's XYZ is an anti-pattern. |
| **terminal depth config** (`_depthMax`/shape/on-off) | `TerminalGrid._depthMax` etc (`TerminalGrid.js:85`) | `_depthYStep`/`_depthZStep` (D); `_totalCount`=renderer maxInstances (D) | `setDepthMax`/`setDepthShape`/`resize`; `terminal.depth` | **NO — GAP** | **I** — operator display choice; reverts on reload. (`_history` ring itself = **D/E**, re-seedable from tmux scrollback.) |
| **terminal placement scale** (`terminal.scale`) | `ScaleModel.placement` via `TerminalGrid.setScale` (`:601`) | `cfg.scale` (adapter `--scale`, default 2.0, re-asserted at spawn) | `terminal.scale` (`terminalCommands.js:483`) | **NO — GAP** | **I** — a non-default `terminal.scale` applied after spawn is lost on reload; adapter `--scale` overrides it. |
| **grid cursor** `{line,col}` + caret mesh | `CodeGrid._cursor` (`CodeGrid.js:1818`) | caret mesh (D); InteractionContext edit-node (D read) | edit ops; `_relayout` re-clamp | **no** | **E** — null when not editing; re-clamped each relayout. |
| **grid `_modified`** (dirty) | `CodeGrid._modified` (`CodeGrid.js:84`) | — (cheap-derivation cache: `grid._savedTextHash`, `fileCommands.js:368`) | edit sets (`:2081`); `markSaved` clears (`:1864`) | **no** | **D** — `contentHash(lines)` vs `_savedTextHash` (a maintained content-hash cache, set on load/save — no disk re-read). |

### 2.2 Field-level atoms

| Atom | Canonical home | Shadow / gaps | Persisted | Class + reason |
|---|---|---|---|---|
| **field source** (`{type:'local',dir}` / repo ref) | `ctx.fieldSource` ad-hoc (`fileCommands.js:309`) | **2 homes**: local→`ctx.fieldSource`; repo→`fileProvider._currentRepo` (`SessionStore.js:134`). Saved as `snap.field` | **yes** | **I** — the deliberate bulk-load. A registry *census* self-armed a whole-repo death loop; this explicit atom is the fix. |
| **ContentTree packing scheme** (`layout`+`layoutOpts`) | `ContentTree.layout/layoutOpts` (`ContentTree.js:54`) | every leaf `position` + `userData.size` (all D) | **NO — GAP** (grep-confirmed) | **I** — governs *every* grid's home position; the single biggest unpersisted fact. Reload resets the whole field to `packedLayout`. |
| **camera position** | live THREE `camera.position` (r3f, `main.jsx:125`); saved `snap.camera.pos` (`SessionStore.js:206`) | `WorkspaceModel.field.camera` (null, intended home, `:36`) | **partial** | **I** — where the operator parked; restored via `camera.move`. ~9 writers incl. the 60Hz integrator (`_panBy`/`_zoomBy`/`_stepTween`). |
| **camera orientation** | **VCC `pitch`/`yaw`** (`ViewerCameraController.js:88`) — the AUTHORITATIVE Euler; `camera.quaternion` is a per-frame DERIVED shadow (`_applyRotation:454` overwrites it EVERY frame from pitch/yaw) | saved lossily as a look-`target` 100u ahead (`SessionStore.js:207`), restored via `camera.aim`→pitch/yaw | **partial** | **I (pitch/yaw)** / **D (quaternion)** — the reconciler MUST write pitch/yaw (or `camera.aim`/`flyTo`), NEVER `quaternion`/`lookAt`: a raw quaternion write is stomped next frame. The `camera.lookat` verb (`cameraCommands.js:29`) is ALREADY silently broken by exactly this (R-12). |
| **camera fov** | `ctx.camera.fov` boot-constant (`main.jsx:125`, fov:70) — **no live writer exists** | captured `snap.camera.fov` (`:212`) but **NEVER restored** (`_restoreCamera:406-414`) — a dead snapshot field | **partial** | **constant today / I if ever settable** — persisting fov is premature until a `camera.fov` writer exists; Slice 4 either wires `applyCamera` to set it or drops the dead capture. |
| **camera speed** | **units-corrupting, 4 homes**: `VCC.cameraSpeed` (`:94`) · `VCC.settings.cameraSpeed` (`:77`) · localStorage `g3d.camera.speed` · session `camera.speed` (`:213`) · settings-schema (`settings.js:19`) | ctor reads `g3d.camera.speed` **raw** into `cameraSpeed` (`:94`) but `setSpeed` persists `value*20` to the same key (`:887`) → a settings-panel write reloads 20× too fast; the session path writes raw (`:413`) — **two unit conventions on one persisted key** | **yes (×2 sinks)** | **I** — input-feel pref. Collapse to ONE home + ONE unit (R-13). |
| **camera lock** | `VCC.locked` (`:114`); `camera.lock` verb (`cameraCommands.js:70`) | — | **NO — GAP** | **I or E (decide in Slice 4)** — a user choice gating every frame (`:324-332`), thrown away on reload. |
| **field active sheet** | `field.activeSheetId` (`WorkspaceModel.js:36`) | overlaps `attention.primary` (the *actually-read* focus), not synced | **no** | **I (write-only)** — 4 writers, **0 readers**; reserved active-tab seam. Wire a reader (Slice 4) or delete. |

### 2.3 Dock atoms

| Atom | Canonical home | Shadow copies (count) | Persisted | Class + reason |
|---|---|---|---|---|
| **dock membership** | `CameraDock.entries` Map (full `DockEntry`, `CameraDock.js:114`) | **4 +file**: `AttentionManager.docks` (thin mirror, *mislabeled* "record of truth", `AM.js:70`) · `CameraDock.tiles` Set (identity, for VCC, `:120`) · scene parent (`grid.parent===cameraDock`) · session `dock3d.tiles[]` (`SessionStore.js:176`) | **yes** | **I** — "this window lives in the dock". |
| **dock slot** (order) | `DockEntry.slot`, assigned in ONE place (`_relayout`, `CameraDock.js:412`) | **1**: `AttentionManager.docks[id].offset.slot` (5 hand-synced sites) | **partial** | **D** — recomputed from Map insertion order every relayout; intent (relative order) is captured by `dock3d.tiles` array order only. |
| **dock home.pos** (release target) | `DockEntry.home.pos` (`CameraDock.js:244`) | the *only* copy of true placement while docked → forces every saver to branch on `cameraDock.has()` (`SessionStore.js:106,146`). **For a docked tree-laid grid this is a FROZEN snapshot of a derived position** (not re-derived while docked) | **partial** | **I (pos)** — the operator's world placement; the rest of `home` (scale/quat/bounds/dims) is **D** lock-time measurement. On restore the reconciler re-derives a tree grid's home from `field.layout` + tree path and re-docks; it must NOT trust a stale `home.pos` if the scheme changed between save and reload. |
| **dock focus/spotlight** | `CameraDock.focusedId` (`CameraDock.js:109`) | **3 encodings**: `focusedId` · `attention.primary` (`dockCommands.js:118`) · `docks[id].offset.slot==='focus'` (`CameraDock.js:373`) | **NO — GAP** | **I** — *reclassified from the draft's "derived"*. `focusedId` is written ONLY by an explicit `spotlight()` gesture (`CameraDock.js:150-156`); there is **no re-derivation source** and SessionStore never reads it (grep-confirmed). A truly derived atom cannot be "lost"; this one is — so the spotlit tile is operator intent, lost on reload. |
| **dock layout mode** (linear/radial) | `CameraDock.layoutMode` (`CameraDock.js:105`) | `dock3d.layout` (`SessionStore.js:185`) | **yes** | **I** — bar arrangement. |
| **dock layout params** (distance, boxFrac, …14 knobs) | `CameraDock` instance fields (`CameraDock.js:88`) | defaults declared **TWICE** (ctor + `settings.js:72`); persisted via the **settings store**, not the session — a 2nd channel for one subsystem | **yes (settings sink)** | **I** — tuned knobs. Stays in localStorage (see Out of Scope). |

### 2.4 Control-state atoms

| Atom | Canonical home | Shadow copies | Persisted | Class + reason |
|---|---|---|---|---|
| **attention.primary** (focus) | `AttentionManager.state.primary` (`AM.js:64`) | `FileTree.activePath` (React read-cache); `WorkspaceModel.focused` correctly **derived** | **NO — GAP** | **I** — deliberate focus *should* survive reload; re-derived accidentally by the last replayed verb today. 12+ writers, all through `set()` (discipline holds, order-clobberable). **Restored focus may point at a `dir:`/`agent:` id with no surface record — see §6 Risk R-6.** |
| **attention.key** (keyboard/edit target) | `AttentionManager.state.key` (`AM.js:64`) | InteractionContext edit/key node (D) | **NO — GAP** | **I** — edit-target-on-a-grid is intent (terminal capture is arguably E). |
| **attention.hover** | `AttentionManager.state.hover` (`AM.js:64`) | `CanvasInteraction.s.hoverId` dedup cache (`CI.jsx:254`) | **no** | **E** — per-frame GPU pick. |
| **interaction-context nodes** | computed on-demand (`IC.js:49`) | — | **no** | **D** — pure projection of primary+key+cursor; the "derived done right" exemplar. Keep as-is. |

### 2.5 Registry / identity / entity-kind atoms

| Atom | Canonical home | Shadow copies | Persisted | Class + reason |
|---|---|---|---|---|
| **registry entries** (id→{grid,type,meta}) | `SceneRegistry._entries` (`SR.js:21`) | `_gridToId` + `_typeCache` (D) · **`ctx.terminals` Map** (parallel terminal census, `terminalCommands.js:35`) · scene graph | **no** | **D** — live scene census, rebuilt from intent each load. |
| **terminal owner** (adapter ctrl-id) | registry `meta.owner` (`terminalCommands.js:163`) | onInput closure capture | **no** | **E** — live WS address; re-stamped per connection. |
| **registry meta.sourcePath** | `grid.userData.sourcePath` (CodeGrid) | `meta.sourcePath` register snapshot (`context.jsx:34`) | **no** | **D** — O(n)-`findByMeta` dedup cache of a fact the grid owns. |
| **annotation/label entities** | `ctx.annotations` Map `{type,grid,text,position,color}` (`annotationCommands.js:68,357`) — **registered into SceneRegistry** (`:71,360`) | — | **NO — GAP** | **I (deferred)** — a deliberate label placed in space is intent. **The reconciler WILL walk these registry entries.** Resolution: §7 scopes them out of the *initial* model with a defined reconciler no-op (`projectView` ignores kinds it has no record for); a `kind:'label'` surface is a clean later addition. They must not be silently orphaned at Slice 5. |
| **gridVisualState** (`{originalZ,originalScale,originalColor}` per index) | `ctx.gridVisualState` Map (`gridVisualState.js:24`, `CommandProvider.jsx:140`) | a **third** `_originalZ`/scale undo map alongside `SelectionManager._originalZ` + `SpatialWindowManager._groupOriginalZ`; writes `grid.position.z` + `grid.scale.setScalar` **raw** (`:46-47`) | **no** | **E/D** — undo-snapshot of scene Z/scale/color, re-derivable. Named in §7 so Slice 5 doesn't orphan it; it is also a **raw position.z/scale writer the reconciler must coexist with** (R-3). |
| **'dir' nodes** | registry `dir:<path>` (`navigationCommands.js:154`) | first-class **focus** targets (`focusTreeNode` → `attention.primary`) | **no** | **D entity / I focus** — directories are *already* live focus entities (not future). Persisted focus can reference them; see R-6. |
| **'agent' / visitor grids** | `FieldVisitorManager.visitors` Map (`FVM.js:32`) | per-visitor state on each `FieldVisitor`; `followId` slot (`FVM.js:35`) | **no** | **E** — mirror live agent processes; re-created as agents act. **Nuance:** `agent.stop` doc says a "done" visitor "PERSISTS" (`agentVisitorCommands.js:12`) — this means *session-runtime-until-cleared*, NOT reload-durable. A "done" visitor is dropped on reload; that is intentional (it has no live process to re-adopt). The verb doc wording is misleading and should be corrected — flagged, not modeled. |
| **settings** (atlas/relay/theme/camera-feel) | localStorage `g3d.*` via StateController | applied value mirrored into each subsystem | **yes (settings sink)** | **I** — user prefs; stays in localStorage. |
| **command history** | localStorage `glyph3d.cmdHistory` (`CommandBar.jsx:41`) | — | **yes (own sink)** | **I** — un-namespaced, bypasses StateController. Scoped out (named in §7 for inventory completeness). |

### 2.6 Dead / unwired (do NOT model; decide fate first)

`SelectionManager`, `SpatialWindowManager`+`WindowGroup`, `FileStateManager`, `CodeColorManager`, `EntityInputRouter` are **all `null` in the r3f client** (`CommandProvider.jsx:110-115`, grep-verified no `new` site). `select.*`/`group.*` verbs silently no-op. Their `groups` localStorage blob is **write-only** (`deserialize` has zero callers, `SpatialWindowManager.js:406`). Group membership *would be* persistable intent **if groups ship** — until wired, they stay entirely out of the model. **Confirm "is groups a shipped feature" before treating its blob as intent-bearing.** Pure dead writes to delete (not model): registry `entry.cols/rows` + stale `meta.cols/rows`, `SceneRegistry.removeById` alias, `CodeGrid._markBoundsDirty()` no-op stub, the `file-selected` CustomEvent (0 listeners), `WorkspaceModel`'s phantom `change:active` event (documented `:41`, never emitted).

**Dead camera stack (recovered camera lane, grep-confirmed):** `packages/glyph3d-core/src/camera/CameraController.js` + `camera/InputManager.js` (+ almost certainly `camera/Camera.js`) — **zero `new` sites**, reachable ONLY through the `index.js:58-59` barrel re-exports (the forwarder anti-pattern the repo's own rules ban). The LIVE controller is `services/camera/ViewerCameraController.js` (instantiated once, `ViewerCamera.jsx:44`). Also dead in the r3f client: VCC's own DOM-slider glue `_bindSlider`/`_restoreUI`/`resetBtn`/`fitAllBtn` (`ViewerCameraController.js:276-299,616-667`) — targets `cam-speed`/`reset-camera`/`fit-all`/`*-sensitivity` elements that do not exist in `app/` (the live settings writer is SettingsPanel→`setSpeed`). And phantom settings: `rotateSensitivity` is read (`:477`) but never in defaults/schema/persist; `invertDragX/Y`/`invertScroll`/`dynamicSpeed` are persisted but have no r3f writer. Delete the dead stack + the two barrel re-exports in Slice 4 (it touches camera) per no-compat-shims.

---

## 3. Peppering Hotspots (ranked)

### By "one fact in the most places"

1. **Terminal cols/rows — 6 live copies + 1 file. THE EXEMPLAR (already proven broken + fixed).**
   `grid.cols` (`TerminalGrid.js:67`) · `TerminalEmulator.cols` (`TerminalEmulator.js:34`) · xterm buffer dims (`:45`) · registry `meta.cols` (create, `terminalCommands.js:162`) · registry `entry.cols` (resize — **a different key**, `:240`) · adapter `cfg.cols` (frozen at startup, `attach.go:31`) · PTY/tmux winsize (`attach_unix.go:439`) · session file (`SessionStore.js:149`).
   **Two of the registry copies are write-only dead** (resize writes `entry.cols`, create wrote `entry.meta.cols`, no authoritative reader reads either — SessionStore reads `grid.cols`).
   **Proven broken:** the adapter ALWAYS re-spawns at `--cols 80 --rows 24` (`attach.go:42-43`); the session file is the only record of the resized size on the normal reload path. Terminals re-adopt DURING restore via an independent adapter ping loop, *before* the registry-change listener that sizes them is armed (`_armAutosave` runs *after* restore). The fix today is a hand-rolled catch-up (`_reconcileSurfaces` at end-of-restore, `SessionStore.js:332`) plus a `grid.cols !== t.cols` idempotency guard (`:370`) — i.e. reconcile-glue papering over order-dependence. **This is the bug class the whole plan dissolves; it is Slice 1.**
   **Also a real Go-side defect to fix in the same slice:** `attach_unix.go:485-488` resizes the PTY on `terminal.resize` but never writes `ev.Data.Cols` back into `cfg.cols`, so `recreate()` (`:146`) re-sends the *startup* size and `forwardWheelToApp` (`:271`) aims at a stale center.

2. **Dock membership — 4 live copies + 1 file.** `CameraDock.entries` (full data) · `AttentionManager.docks` (thin mirror, *mislabeled* "record of truth", `CameraDock.js:32`) · `CameraDock.tiles` Set · scene parent · `dock3d`. Hand-maintained in `lock()`/`release()`; drop one write and they diverge.

3. **Group membership — 5 copies** (`memberIds` · `_gridToGroup` · `userData._windowGroup` · `FileStateManager.groupId` · localStorage `groups`) — *but the subsystem is unwired*, so this is **dead peppering** (do not model; see §2.6).

### By "most writers of one atom"

1. **`attention.primary` — 12+ writers** across handlers + gesture resolver. All funnel through `set()`, so the slot discipline holds — but order-clobberable, and **not persisted**.
2. **`camera.speed` — 3 writers, 2 persisted homes** (`VCC.saveSettings` + settings schema + SessionStore restore).
3. **`ScaleModel.placement` — 3 writers** (`grid.setScale` / dock animator / ctor), time-disjoint by *convention* only. **Plus a hard counterexample: `AgentGrid.setScale` writes `grid.scale.setScalar` directly with no ScaleModel** (`AgentGrid.js:89`) — and `gridVisualState`/annotation undo paths also write `grid.scale` raw. The "resolve() is the sole writer" precedent holds **only for model-backed grids** (CodeGrid/TerminalGrid). See R-3.

### By "most reconcile-glue / load-bearing order"

1. **`SessionStore._reconcileSurfaces` (`SessionStore.js:350`)** — the de-facto hand-rolled reconciler: `_placePendingTerminals` → `_applyDock3d`, in a load-bearing order ("terminals size FIRST so `dock.lock` captures the restored home", `:346`), fired from *both* the registry listener and a one-shot end-of-restore catch-up — and the listener **isn't armed during the exact window terminals re-adopt**. The proto-controller-loop to absorb.
2. **`SessionStore.restore()` tab loop (`:281-308`)** — rebuilds the sheets map as a *side-effect of replaying* `file.open` → `grid.window` → `grid.frame` → `grid.scroll`, each an async await in a comment-documented mandatory order, racing the bulk field load.
3. **The `cameraDock.has()` position branch (`:106,146`)** — every saver special-cases docked vs loose placement; reconcile-glue leaked into the scrape.

---

## 4. Target Architecture

### 4.1 World-state model — the entity table

`WorkspaceModel.sheets` becomes the **surface table**, keyed by a stable id. Terminals join it for *persisted intent* while their live shell stays server-side (the "registry vs tree = 2 sources of truth" split is preserved — the model holds geometry/placement *intent*, the relay owns the running process).

```
Surface (one record per code grid / terminal / future kind):
  id        : string   stable key — "sheet:<path>" (files), "term:<adapterId>" (terminals)
  kind      : 'file' | 'terminal'        // present kinds the model represents
  source    : { path?, uri? } | { adapterId? }   // identity (intent)
  title     : string                     // intent metadata
  fieldId   : string                     // which field it belongs to
  view      : View | null                // THE declarative view (below)
  // panelId is NOT a stored field — it is DERIVED (registry.has join). See triple().
```

`id` keying is already path-canonicalized (`'sheet:'+key`, strip leading slashes, `WorkspaceModel.js:76-77`), so the path-keyed seams (SessionStore, `file.open` dedup, `findByMeta('sourcePath')`) stay untouched — `panelId === registry id` remains the whole join design.

**Entity kinds the model does NOT represent (resolved from the completeness critique):** `'label'`/`'annotation'` (registry-bound, intent — a clean *later* surface kind; see §7), `'dir'` (a derived navigation entity, never a surface), `'agent'`/visitor (ephemeral, mirrors a live process). The reconciler's `projectView` is **keyed by the surface record, not by registry type** — it iterates `model.surfaces()` and projects onto the matching registry entry, so a `dir:`/`label:`/`agent:` registry entry with *no* surface record is simply never projected. There is no "unhandled kind" path.

### 4.2 The declarative `view` shape — grown from `sheet.view`

One record absorbing every per-surface atom that is today scraped off the live object. Every field is tagged I/D/E.

```js
View = {
  // ── placement & scale ───────────────────────────────────────────
  // position is INTENT only for surfaces NOT laid out by the tree scheme
  // (terminals, manual grid.move). Tree-laid code grids OMIT position →
  // the reconciler derives XYZ from field.layout + the tree path. (D for grids)
  position : { x, y, z } | null,   // I (terminals/manual) / null→D (tree grids)
  zoom     : number | {x,y,z},     // I  — ScaleModel.user (the persisted readability zoom)
  // placement is NEVER stored — D, recomputed: home gridScale XOR dock tile-fit

  // ── code-grid viewport (null/absent for terminals) ──────────────
  fold       : LayoutParams | null,               // I — config.layout (newspaper/z-page/…)
  window     : { cols, rows, firstLine } | null,  // I
  frameRows  : number,                            // I (0 = no frame)
  scrollOffset : number,                          // I (visual rows; omit when 0)

  // ── terminal geometry (null/absent for code grids) ──────────────
  cols : number, rows : number,                   // I — the resized cell grid
  depth : { max, yFactor, zFactor, enabled } | null,  // I (currently a gap)
  scale : number | null,                          // I — terminal.scale placement (currently a gap)

  // ── dock membership (null when loose) ───────────────────────────
  dock : { member: true, slotOrder: int, focused: bool } | null,
  //   member    : I  — "this surface is docked"
  //   slotOrder : I as RELATIVE order ONLY (the int slot is D, recomputed by _relayout)
  //   focused   : I  — the spotlit tile (reclassified intent; was a gap)
  //   zoom folds into View.zoom — dock is NOT a 2nd zoom home

  // ── NOT in the view (all D/E) ───────────────────────────────────
  // caret/cursor (E), _modified (D=contentHash vs _savedTextHash), LayoutDescription (D),
  // line tables (D), getBounds world box (D), dock home.scale/quat/bounds (D),
  // dock slot integer (D), obj.scale (D = placement·user).
};
```

**Field record** absorbs the field-level intent:

```js
Field = {
  id, name,
  sheetIds : string[],          // ordered open set (I)
  activeSheetId : string|null,  // I — per-field active tab (wire a reader, Slice 4)
  source : { type:'local', dir } | { type:'repo', ref } | null,  // I — was ctx.fieldSource
  layout : { scheme, opts } | null,        // I — ContentTree packing scheme (was a GAP)
  camera : { pos, target, fov } | null,    // I — was snap.camera; fov MUST be applied (Slice 4)
  focus  : { primary, key } | null,        // I — was unpersisted attention slots
};
```

### 4.3 The reconciler — one idempotent loop

A single `live ← model` projector, the model's first real subscriber (today the model's `change:*` bus has **zero subscribers**, `WorkspaceModel.js:42-54`). It is **async-serialized**: the underlying grid methods (`setWindow`/`setLayout`/`setScrollOffset`/`setFrameRows`) are all `async` and funnel through a shared `_relayout` mutex, so the reconciler **awaits each projection per grid** and its convergence guards read *post-await* state (resolves the feasibility critique's async/idempotency hazard).

```js
// Reconciler — the SINGLE live←model projector. Idempotent. Order-free. Async-serialized.
async reconcile(registry, scene) {
  // 1. Field-level: ensure packing scheme + camera + focus match intent (idempotent).
  const field = model.getActiveField();
  if (field.layout)  contentTree.setLayout(field.layout.scheme, field.layout.opts);
  if (field.camera)  await cameraController.applyCamera(field.camera);   // pos+target+FOV
  if (field.focus)   { attention.set('primary', field.focus.primary);   // tolerate non-surface ids
                       attention.set('key',     field.focus.key); }

  // 2. Per-surface: project each record onto its live object IF it exists. Per-grid serialized.
  for (const s of model.surfaces()) {
    const live = registry.get(s.panelId ?? s.id);
    if (!live) continue;                  // no projection yet — try again next change
    await projectView(live, s.view);      // guarded set-to-target writes, awaited
  }
  // 3. Derived self-heal: null any panelId whose registry entry vanished.
  model.reconcile(registry);              // already exists (WorkspaceModel.js:153)
}

async projectView(entry, view) {          // idempotent: each write is a guarded set-to-target
  const grid = entry.grid, kind = entry.type;
  if (kind !== 'grid' && kind !== 'terminal') return;   // dir/label/agent: no surface record → skip
  if (view.window      && !eq(await getWindow(grid), view.window)) { await grid.setWindow(view.window.cols, view.window.rows); await grid.scrollToLine(view.window.firstLine); }
  if (view.frameRows   !== grid.getFrameRows())   await grid.setFrameRows(view.frameRows);
  if (view.scrollOffset!== grid.getScrollOffset())await grid.setScrollOffset(view.scrollOffset);
  if (view.fold        && !eq(grid.getLayout(), view.fold)) await grid.setLayout(view.fold);
  if (view.zoom        !== grid.zoom)             grid.setZoom(view.zoom);   // → ScaleModel.user → resolve()
  if (kind === 'terminal' && (grid.cols!==view.cols || grid.rows!==view.rows)) grid.resize(view.cols, view.rows);
  if (view.position && !isTreeLaidOut(entry))     setGridPosition(grid, view.position);  // NOT for tree grids
  // tree-grid position is contentTree.relayout's output, set in step 1, never here.
  if (view.dock?.member  && !cameraDock.has(entry.id)) cameraDock.lock(entry.id);   // has()-guarded
  if (!view.dock?.member &&  cameraDock.has(entry.id)) cameraDock.release(entry.id); // inverse, symmetric
  if (view.dock?.focused && cameraDock.focusedId !== entry.id) cameraDock.spotlight(entry.id);
}
```

Every branch is a **guarded set-to-target**, so re-running is a no-op once converged — the generalization of the `grid.cols !== t.cols` and `cameraDock.has()` guards the code hand-rolls today.

**Unbudgeted primitives the pseudocode assumes — now explicit deliverables (resolving the feasibility critique):** none of `cameraController.applyDesired`, `grid.isTreeLaidOut`, `grid.setWorldPosition` (on CodeGrid), `grid.id`, `grid.isTerminal` exist today. They are renamed/built as named work:
- `isTreeLaidOut(entry)` — defined concretely as **`entry.type === 'grid'` AND the grid is a live ContentTree leaf** (a free/manual grid or terminal is not). Built + unit-tested against a docked grid, a manually-moved grid, and a terminal **before** any `projectView` branch depends on it (Slice 1 deliverable; consumed in Slice 3).
- `cameraController.applyCamera(field.camera)` — a thin idempotent wrapper over the existing `camera.move`/`camera.aim` + a **new FOV apply** (closes the captured-but-unrestored fov gap). Slice 4 deliverable.
- `setGridPosition(grid, pos)` / `entry.id` / `kind` — read id/type from the **registry entry**, not the grid; position via the kind-appropriate setter. No grid API invented.

### 4.4 Writer discipline — one writer per atom; verbs write the model

The rule: **verbs write the model; projection follows.** A verb never reaches into the live object directly; it mutates the model record and the reconciler projects. This generalizes the three clean local precedents — `ScaleModel.resolve()` (sole `obj.scale` writer, *model-backed grids only*), `AttentionManager.set()` (one-writer-per-slot), the single `e.slot = i` site (`CameraDock.js:412`).

Verbs flip from *mutate-then-maybe-save* to *mutate-model*:
- `terminal.resize id c r` → `model.setView(id, {cols, rows})`; reconciler resizes grid+emulator+PTY. The 6-copy fan-out becomes one model write + one idempotent projection.
- `grid.window` / `grid.frame` / `grid.scroll` / `grid.layout` → write `view.{window,frameRows,scrollOffset,fold}`.
- `window.scale` → write `view.zoom`; reconciler projects (and the dock reflows tile).
- `dock.lock/release/toggle/spotlight` → write `view.dock`; reconciler projects. **The four membership copies collapse to one** (`view.dock.member`); `CameraDock.entries`, `tiles` Set, scene parent, and `AttentionManager.docks` become reconciler outputs, not hand-maintained writes.
- `camera.move/aim/focus` → write `field.camera` / `field.focus`; reconciler applies.

### 4.5 Persistence-as-serialization

`SessionStore.capture()` (the 110-line scrape, `:86-198`) **collapses to `serialize(model)`**. `restore()` (the imperative replay, `:252-336`) **collapses to `deserialize(blob)` + one `reconcile()`**:
- **No scrape** — capture reads model Maps, not live three.js objects → a save mid-restore/mid-readopt reads a *consistent intent snapshot*. The scrape race is gone by construction.
- **No replay** — restore deserializes the Maps; it does not re-run `file.open`/`grid.window`/`grid.frame`/`grid.scroll` in a load-bearing order. The reconciler projects whatever is live, whenever.
- **No carry-forward merge** (`:182-184,164-166`) — the model already holds not-yet-projected surfaces; nothing to merge.
- **No `_lastSavedCmp` order-sensitivity** — serialize Maps in stable key order.

`_reconcileSurfaces`/`_placePendingTerminals`/`_applyDock3d`/`_maybeApplyDock` are **deleted**; their job is the one reconciler loop.

### 4.6 The collapse of the four pending-buffers

Today four mechanisms exist solely because **a surface's intent can exist before its live projection does**:

- `pendingTerminals[]` (`:63`) → `_placePendingTerminals`
- `_pendingDock3d` (`:61`) → `_applyDock3d`
- `_pendingDock` (`:60`) → `_maybeApplyDock` (dockview layout)
- `_reconcileSurfaces` (`:350`) → the single drain entry, fired from the registry listener AND the end-of-restore catch-up

**In the target, all four become the same thing: a surface whose model record has no live projection yet.** The reconciler walks the model on every registry change and projects each surface that has a live object, idempotently, in any order. There is **no pending list, no carry-forward merge, no load-bearing order** — the model *is* the durable buffer, projection is a pure function of (record, live presence). The terminal that re-adopts at any time gets projected when its registry entry appears, exactly as the dock tile does, exactly as the dockview panel does. The armed-too-late race disappears: the reconciler is the model's first subscriber, live from construction.

---

## 5. Migration Plan

Ordered, **reversible vertical slices**. Each: writes intent into the model AND makes the model-write the new source of truth, with the reconciler running alongside the existing scrape until that slice's old glue is deleted at the close of the slice. Honor **no-compat-shims / atomic-rename**: within a slice we cut the old path and update every caller in the same change; incrementality is *per-atom*, never a dual path *across* slices for the *same atom*.

Verification is **deterministic and tools-driven** (the `tools/dock-persist-check.mjs` style): a headless script drives verbs over the bus, captures+restores, and asserts the live object matches intent — with **re-adopt ordering fuzzed** to prove order-independence.

### Slice 0 — Schema-tolerant restore + `WorkspaceModel.clear()` (PREREQUISITE)

*Resolves the two feasibility-critique blockers that would otherwise make every later slice's "additive read old / write new" impossible and destroy sessions on rollback.*

- **Goal:** stop the wipe-on-mismatch so additive migration and code rollback are actually safe; add the missing `clear()` so a repo switch can't strand stale sheets.
- **Files/verbs touched:** `SessionStore.restore` (`:254-257`) — change the version gate from **wipe-on-mismatch** to **forward-additive** (read old keys, default new ones, re-serialize at the current version; only wipe on the one truly-incompatible v1→v2 `files`-means-field shape, which is already past). `WorkspaceModel` — add `clear()` (empty `sheets` + reset each field's `sheetIds`/`activeSheetId`); wire `repo.load` (`repoCommands.js:26`, today a silent no-op) and `clearScene` to it.
- **Model fields added:** none (schema-handling only).
- **Shadow-state deleted:** none yet.
- **Verify (`tools/session-schema-tolerance-check.mjs`):** load a literal current-version blob with an *unknown future key* → assert it survives (not wiped) and the known fields restore. `repo.load A` → `repo.load B` → assert `sheets` holds only B's. Assert reverting to a prior code shape over a new-shape file does not wipe (old code tolerates/ignores unknown keys).
- **Reversible:** pure policy change; trivially revertible, and it is what *makes* every later slice reversible at the persisted-file level.

### Slice 1 — Terminal geometry (FIRST: proven-broken, implementable next with NO further design)

- **Goal:** terminal `cols/rows` (+ `position`) survive reload via the model, not via replay-after-readopt. Kills the just-fixed race *structurally*.
- **Model fields added:** `Surface.view.{cols, rows, position}` for `kind:'terminal'`; a surface record created on `terminal.create`. Plus the **`isTreeLaidOut(entry)` discriminator** (built + unit-tested here; consumed in Slice 3).
- **Verbs/files touched:** `terminalCommands.js` (`terminal.create/resize/move` write the model record), new `Reconciler.projectTerminal()` (resize grid+emulator+PTY from `view`), `SessionStore.serialize/deserialize` for the terminal slice only.
- **Shadow-state deleted:** registry `entry.cols/rows` (write-only, `terminalCommands.js:240`) and stale `meta.cols/rows` (`:162`) — collapse to one `register({})` that omits geometry; `pendingTerminals[]` + `_placePendingTerminals` (`SessionStore.js:360`); the `cols!==t.cols` guard. **Go-side fix in the same change:** `attach_unix.go:485-488` writes `ev.Data.Cols` back into `cfg.cols` so `recreate()`/`forwardWheelToApp` stop using the stale startup size.
  *Pre-delete check (feasibility critique): TerminalsPanel reads `e.grid?.cols ?? e.meta?.cols` — verify the `meta` fallback is unreachable (grid always present) before removing `meta.cols`.*
- **Verify — two-sided (resolving the "no teeth at the Go boundary" critique):**
  - `tools/term-geom-persist-check.mjs` (JS): spawn → `terminal.resize 100 40` → capture → simulate reload (clear display, replay adapter re-adopt at 80×24) → reconcile → assert `grid.cols===100 && grid.rows===40` **regardless of re-adopt timing** (reconcile before AND after the registry entry appears — both converge; fuzz the order).
  - `tools/term-geom-relay-check.mjs` (full relay round-trip, the Go seam the JS test can't reach): drive a real adapter (built relay on `:8099`), resize, force `recreate()`, assert the rebuilt grid returns at the resized cols/rows **and** a wheel event maps to the resized center. Name the seam explicitly: `cfg→recreate`, `cfg→forwardWheel`.
- **Docked-terminal scope (resolving the "Slice 1 not self-contained" critique):** Slice 1 covers **loose terminals only**. A docked terminal's geometry restore is entangled with dock-home capture (`_applyDock3d` reads a home the new path now owns), so docked-terminal restore is **knowingly deferred to Slice 2** — the slice test gates on loose terminals and states this explicitly. We do *not* claim full self-containment for docked terminals; we sequence the entangled atom (terminal home) into the slice that owns the dock (Slice 2), so there is never a cross-slice dual path for one atom.
- **Reversible:** the model write is additive; deletions revert as one change (Slice 0 already made the file rollback-safe).

### Slice 2 — Dock membership + zoom + spotlight (collapse the 4-copy + 2-zoom mess)

- **Goal:** one `view.dock` record; membership/slot-order/zoom/**spotlight** restore via the reconciler; loose-grid zoom *also* persists (closes the asymmetry gap). Completes docked-terminal restore from Slice 1.
- **Model fields added:** `view.dock = {member, slotOrder, focused}`; `view.zoom` becomes the single zoom home (docked or loose).
- **Verbs/files touched:** `dockCommands.js` (`dock.lock/release/toggle/spotlight` write `view.dock`), `windowCommands.js` (`window.scale` writes `view.zoom` always), `CameraDock` membership/focus writes become reconciler outputs.
- **Shadow-state deleted:** `AttentionManager.docks` Map (the mislabeled "record of truth", `AM.js:70` — fold into model or drop); `_pendingDock3d` + `_applyDock3d` (`SessionStore.js:385`); the `cameraDock.has()` position branch in the saver (`:106,146` — `home.pos` becomes `view.position`). `CameraDock.tiles` Set stays (a derived perf index, rebuilt by the reconciler).
- **Docked tree-grid home (resolving the classification critique):** on restore the reconciler **re-derives** a docked tree-laid grid's home from `field.layout` + tree path and re-docks — it does NOT restore a frozen `home.pos` as authoritative, so a scheme change between save and reload leaves no stale release target. (Terminals/manual grids keep `view.position` as intent.)
- **Verify (`tools/dock-persist-check.mjs`, extended):** dock 3 surfaces (incl. one terminal from Slice 1), set distinct zooms (one loose), reorder, spotlight one → capture → reload → reconcile → assert membership set, slot *order*, **all** zooms (incl. the loose one), and the **spotlit tile**. Reconcile with surfaces appearing in shuffled order; assert no order-dependence.
- **Reversible:** `view.dock` is additive; the `dock3d` blob shape falls back via Slice 0's tolerant restore.

### Slice 3 — Code-grid viewport (window/frame/scroll/fold) + the scheme gap

- **Goal:** the load-bearing `file.open → window → frame → scroll` replay ordering dies; **close the two silent gaps** (per-grid `fold`, field `layout` scheme).
- **Model fields added:** `view.{window, frameRows, scrollOffset, fold}`; `Field.layout = {scheme, opts}`.
- **Verbs/files touched:** `gridCommands.js` (`grid.window/frame/scroll/layout` write the view), `layoutCommands.js` (`layout.scheme` writes `field.layout`), reconciler projects via `setWindow/setFrameRows/setScrollOffset/setLayout` + `contentTree.setLayout`. Consumes the `isTreeLaidOut` discriminator from Slice 1.
- **Shadow-state deleted:** the `SessionStore.restore()` tab-replay loop (`:281-308`) for these atoms; `entry.x/y/z` persistence for **tree-laid grids** (position becomes a reconciler output of `field.layout` + tree path, never stored for grids); `file.open`'s dead `[x y z]` args + their dead replay (`:293`).
- **Verify (`tools/grid-view-persist-check.mjs`):** open file → `grid.window 80 30 / grid.frame 20 / grid.scroll 100 / grid.layout newspaper` → `layout.scheme district` → capture → reload → reconcile → assert window/frame/scroll/fold AND that grid positions match a fresh `district` relayout (not saved-under-`packed` coords). Fire two reconciles back-to-back on one grid mid-relayout; assert a single settled result (idempotency under async).
- **Reversible:** additive view fields; `field.layout` defaults to `packed` if absent.

### Slice 4 — Field source + camera + control-state focus (the recovered-lane slice)

- **Goal:** lift ad-hoc `ctx.fieldSource`, the flat `snap.camera`, and the *unpersisted* `attention.primary`/`attention.key` into the model; collapse the **units-corrupting 4-home `camera.speed`** (R-13); restore orientation through **pitch/yaw, never the quaternion** (R-12); delete the **dead camera stack** (§2.6).
- **Model fields added:** `Field.source` (unify local + repo, kill the two-home branch), `Field.camera = {pos, target, fov?}` applied via `camera.move` + `camera.aim` (pitch/yaw-safe) + an optional FOV set, `Field.focus = {primary, key}`. *(FOV is a boot constant today — `applyCamera` wires the path but there's no `camera.fov` writer yet; persist it only once one exists, else drop the dead capture.)*
- **Verbs/files touched:** `fileCommands.js`/`repoCommands.js`/`sceneCommands.js` (write `field.source`; `repo.load` clear is real via Slice 0), `cameraCommands.js` (write `field.camera`; **fix `camera.lookat` to sync pitch/yaw**), `CommandProvider.jsx` (wire `applyGroupSettings('Camera')` at boot — today only `'Dock'` runs, `:271`), focus writers continue through `AttentionManager.set` but the slots are now serialized.
- **Shadow-state deleted:** `ctx.fieldSource` ad-hoc property → `field.source`; `snap.camera` flat field → `field.camera`; the `fileProvider._currentRepo`-vs-`ctx.fieldSource` capture branch (`:134`); **the dead camera stack** (`camera/CameraController.js`, `camera/InputManager.js`, `camera/Camera.js`, their `index.js:58-59` barrel re-exports, and VCC's dead DOM-slider glue `:276-299,616-667`); the duplicate `camera.speed` homes collapse to one (`g3d.camera.speed` stays boot-feel only; the `×20`/raw unit split is fixed; the session is no longer a second authority). **Decide `camera.lock`** (intent → `Field.camera.locked`, or accept ephemeral).
- **Verify (`tools/field-state-persist-check.mjs`):** openDir → pan+look to a distinct pose → set `camera.speed` via the settings panel → focus a grid → key-target another → capture → reload → reconcile → **then advance one frame** and assert: field source replays; camera position + orientation hold (orientation proves it went through pitch/yaw — a quaternion-only restore would drift on that frame, R-12); `camera.speed` round-trips at the SAME magnitude (no 20× drift, R-13); focus/key re-assert (today an accident of last-replayed-verb). Assert `repo.load` clears prior sheets. **Focus-on-non-surface (R-6):** focus a `dir:` node → capture → reload → assert the reconciler tolerates a `field.focus.primary` resolving to a non-surface registry entity (re-asserts focus, no throw, no dangling).
- **Reversible:** additive; flat readers fall back via Slice 0. The dead-stack deletion is independently revertible (it has zero callers).

### Slice 5 — SessionStore → thin serialize/deserialize (close-out)

- **Goal:** `capture()`/`restore()` become `serialize(model)`/`deserialize(blob)` + one `reconcile()`. Delete the last glue.
- **Verbs/files touched:** `SessionStore.js` shrinks to schedule/dedup/write + `serialize`/`deserialize` delegation to `WorkspaceModel`; wire the reconciler as the model's `change:*` + registry-change subscriber (the bus's first consumer).
- **Shadow-state deleted:** `_reconcileSurfaces`, `_maybeApplyDock`/`_filterDockOrphans` (dockview orphan-drop becomes a reconciler self-heal), the carry-forward merges, `_lastSavedCmp` order-sensitivity, the `_armAutosave` race window (reconciler always live).
- **Annotation/gridVisualState guard (resolving the completeness critique):** before deleting the scrape, assert the close-out does not silently orphan registry-bound state the model has no record for — annotations/labels and `gridVisualState` are **explicitly out of the initial model** (§7); the reconciler's `projectView` skips their registry entries by design, and the serializer ignores them. Document that annotation *intent* is a known follow-on (`kind:'label'` surface), not a regression introduced here.
- **No forbidden dual path (resolving the feasibility critique):** the old `capture/restore` is **NOT kept behind a runtime flag**. The cut is atomic: run `tools/session-roundtrip-check.mjs` green against the new path **in the working tree before commit**; gate the commit on the test, not a shipped flag.
- **Verify (`tools/session-roundtrip-check.mjs`):** full scene (grids + terminals + dock + camera + focus) → assert `deserialize(serialize(model))` is structurally equal → reload → reconcile → assert the live scene matches intent across **all** prior slice checks combined. Fuzz re-adopt ordering to prove order-independence.
- **Reversible:** Slice 0 made the file forward-tolerant, so a code revert is safe; no flag.

### Sequencing rationale

Slice 0 first because **wipe-on-mismatch + the missing `clear()` would silently sabotage every later slice** (each "additive read" never runs; each rollback destroys the session). Slice 1: proven-broken, self-contained for loose terminals, highest-confidence win, exercises the full model→reconciler→serialize path on one narrow atom. Slice 2: highest peppering payoff (4→1 membership copies), closes the zoom + spotlight gaps, completes docked-terminal restore. Slice 3: largest correctness payoff (kills load-bearing replay order, closes the two biggest unpersisted gaps). Slice 4: lifts the remaining intent atoms + fixes FOV. Slice 5: deletes the glue — only safe once 1–4 have moved every atom off the scrape.

---

## 6. Risk Register

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| **R-1** | **Schema migration / blast radius.** Wipe-on-mismatch destroys the session on any version bump; "additive read old / write new" is impossible until that's fixed, and code rollback over a new-shape file also wipes. | `SessionStore.js:254-257` (wipe), `:31` `SCHEMA_VERSION=2` | **Slice 0 prerequisite**: forward-additive restore + a test that loads a prior-shape blob and asserts survival. Rollback story stated explicitly (old code ignores unknown keys). |
| **R-2** | **Tree-laid position is derived, but terminals/manual moves are intent.** The reconciler must not stomp a terminal's `view.position` with a scheme relayout, nor store a tree grid's XYZ. The `isTreeLaidOut` discriminator does not exist and must be built; getting it wrong = grids fight the scheme or terminals drift. | `fileCommands.js:178` (XYZ args unconsumed); `packedLayout.js:112` (scheme writes position) | `isTreeLaidOut(entry)` = `type==='grid'` AND a live ContentTree leaf; **built + unit-tested in Slice 1** against docked/manual/terminal cases before any branch depends on it. |
| **R-3** | **`ScaleModel.resolve` is NOT the sole `obj.scale` writer.** `AgentGrid.setScale` writes `grid.scale.setScalar` directly (no ScaleModel); `gridVisualState` + annotation undo paths also write `grid.scale`/`position.z` raw. Generalizing "resolve is sole writer" inherits an un-modeled exception class. | `AgentGrid.js:89`; `gridVisualState.js:46-47`; `annotationCommands.js:193` | Qualify the precedent to **model-backed grids (CodeGrid/TerminalGrid) only**. Exclude agent grids and the undo paths from `projectView`'s scale branch (`projectView` skips non-`grid`/`terminal` kinds). Give `AgentGrid` a ScaleModel *before* agents ever become model surfaces. |
| **R-4** | **Async projection vs idempotency.** Grid relayout methods are async behind a `_relayout` mutex; firing guarded writes without awaiting interleaves two relayouts, and a guard can read pre-commit state — re-running is then NOT a no-op. | `CodeGrid.js:253/822/840/884` async; shared mutex | Reconciler is **async-serialized** (await each projection per grid); guards read post-await state. Slice 3 test fires two reconciles back-to-back mid-relayout, asserts a single settled result. |
| **R-5** | **Reconciler vs camera-follow multi-writer.** `FieldVisitorManager._applyFollow` writes `cam.position` each frame, already fighting VCC. The reconciler must not become a third per-frame camera writer. | `FVM.js:187,193` | `field.camera` is applied on restore/explicit-move only, **never per-frame**. Follow stays a separate per-frame concern outside the reconciler. |
| **R-6** | **Persisted focus can point at a non-surface entity.** `dir:<path>` nodes and `agent:` grids are first-class focus targets with no Surface record; restoring `attention.primary` to a `dir:` id breaks a `panelId===surface` join. | `navigationCommands.js:154` (dir focus); `modeCommands.js:80` (agent kind) | Focus is **NOT join-restricted to surfaces**: the reconciler re-asserts `field.focus` against the *registry* (which holds dir/agent entities), tolerating ids with no surface record. Slice 4 test covers `dir:` focus round-trip. |
| **R-7** | **Nested Terminals dockview sub-layout is unpersisted and unacknowledged.** TerminalsPanel hosts a *second* dockview (each shell a draggable sub-tab) with no `onDidLayoutChange→scheduleSave` and no `toJSON` capture — the terminal tab arrangement is dropped every reload. | `TerminalsPanel.jsx:2-23` (nested DockviewReact); no persist wiring | Named here as a **distinct unpersisted atom**. Decide its home in a follow-on: either relative tab-order/split in `view.dock`/`Surface`, or a nested dock blob analogous to the outer one. Out of the initial five slices; Slice 5's "thin serialize" must not assume one dockview. |
| **R-8** | **`ScaleModel.placement` single-writer is convention, not enforced.** Three time-disjoint writers; a stray `grid.setScale` while docked could stomp the tile-fit. | `ScaleModel.js:5-13` | Folding placement into the reconciler is the chance to *enforce* it (placement = pure function of dock membership). Watch in Slice 2; placement stays derived. |
| **R-9** | **Two-SceneContext topology, one-shot bridge.** App `ctx` and VCC's core `SceneContext` are different objects (`ViewerCamera.jsx:32` vs `CommandProvider.jsx:40`), sharing only `camera`/`scene`/`renderer` by reference. The app→VCC bridge (`attentionManager` assign + `isGripPress`/`tryScrollHovered`/`dockTiles` getters) runs **once** in an effect keyed `[relay]` (`:349-371,425`) — it does NOT re-run if VCC remounts (its own deps differ), leaving a fresh VCC ctx unbridged. | `CommandProvider.jsx:349-371` | Reconciler lives app-side, uses only bridged fields, never assumes one ctx, and tolerates `cameraController` being `null` during the mount window (the ref is filled by a sibling effect). Called out per camera/dock slice. |
| **R-10** | **Settings remain a separate sink.** `g3d.*` localStorage is a different channel, never reconciled with the session; dock-param defaults declared twice and can drift. | `settings.js:72`; `CameraDock.js:88` | The plan does **not** force settings into the model (see §7). Flag the double-declared defaults; do not fix here. |
| **R-11** | **"Done"-visitor verb wording is misleading.** `agent.stop` doc says the visitor "PERSISTS"; it means session-runtime-until-cleared, not reload-durable. | `agentVisitorCommands.js:12` | Clarify the verb doc; visitors stay ephemeral (no model slot). A "done" visitor is dropped on reload by design (no live process to re-adopt). |
| **R-12** | **Camera orientation split-brain (recovered lane).** VCC's `pitch`/`yaw` is authoritative and overwrites `camera.quaternion` EVERY frame (`_applyRotation:454`). A reconciler (or model) that writes `quaternion`/`rotation`/`lookAt` is silently stomped on the next frame — the `camera.lookat` verb already is. | `ViewerCameraController.js:88,450-454`; `cameraCommands.js:29` | Orientation intent is pitch/yaw, NOT quaternion. The reconciler restores via `camera.aim`/`flyTo` (which decompose to pitch/yaw), never a raw quaternion set. Fix `camera.lookat` to sync pitch/yaw in the same slice. Verify by advancing a frame post-reconcile and asserting orientation held (Slice 4). |
| **R-13** | **`camera.speed` is units-corrupting across 4 homes (recovered lane).** Ctor reads `g3d.camera.speed` raw into `cameraSpeed` (`:94`); `setSpeed` writes `value*20` to the same key (`:887`); the session path writes raw (`:413`). Two unit conventions on one persisted key → 20× speed drift depending on who wrote last. | `ViewerCameraController.js:77,94,887`; `SessionStore.js:213,413`; `settings.js:19` | Slice 4 collapses to ONE home + ONE unit: pick the `cameraSpeed`-scale, kill the `×20` (or the raw read), and make session-vs-settings agree. Round-trip test asserts no drift across reload. Also: `applyGroupSettings` runs only for `'Dock'` (`CommandProvider.jsx:271`), never `'Camera'` — wire the Camera group at boot. |

---

## 7. Out of Scope — stays ephemeral/derived, never enters the model

**The live shell (PTY + tmux session)** — server-side intent, re-adopted from the relay roster, not resurrected from the model. The model holds the terminal's *geometry/placement intent*; the running process is the relay's. `tmux` pane geometry is a server-side 2nd size home that only survives relay-restart-with-living-tmux; the file is the authority on the normal reload path.

**The font-atlas disk cache** (`cli/relay.go:429`, font/size-keyed) — a real, used cache, but not session/workspace state.

**Settings** (`g3d.*` localStorage via StateController) — user prefs / boot-feel, a deliberately separate channel. Dock *params* stay here (dock *membership/order/zoom/mode* are session/model). Not forced into the model (R-10).

**Command history** (`glyph3d.cmdHistory`, `CommandBar.jsx:41`) — un-namespaced localStorage, bypasses StateController. Scoped out; named for inventory completeness.

**Annotations / labels / tour overlays** (`ctx.annotations`, `annotationCommands.js:68,357`) — *intent* (a label placed in space), but **out of the INITIAL model**. They register into the registry, so the reconciler will encounter them; `projectView` is keyed by surface record and **skips registry entries it has no record for** (no unhandled-kind path). A `kind:'label'` surface with `view.{text,position,color}` is a clean follow-on, NOT in the five slices. Slice 5 must not silently orphan them — that is a documented known follow-on, not a regression.

**gridVisualState** (`ctx.gridVisualState`, `gridVisualState.js:24`) — an undo-snapshot of scene Z/scale/color, re-derivable → **ephemeral/derived**. It is also a third raw `position.z`/`scale` writer the reconciler must coexist with (R-3). Named so Slice 5 doesn't orphan it.

**Ephemeral runtime:** `attention.hover`, interaction-context nodes (keep `InteractionContext` exactly as-is — the derived-read-model exemplar), the caret/cursor mesh, relayout mutexes (`_relayoutBusy`/`_relayoutPending`), `_scrollClampGuard`, all three `_originalZ`/scale undo maps (`SelectionManager._originalZ`, `SpatialWindowManager._groupOriginalZ`, `gridVisualState`), terminal `meta.owner`, the `FieldVisitor` roster (mirrors live agent processes; "done" markers are session-runtime, not reload-durable — R-11), `ctx` itself (a reference bag of live singletons).

**Derived geometry:** LayoutDescription, line tables, `getBounds` world boxes, `obj.scale`, dock `slot` integers, dock `home.scale/quat/bounds`, grid positions for tree-laid grids, `_modified` (`contentHash` vs `_savedTextHash`) — all recomputed, never stored.

**Dead / unwired subsystems (do NOT model; decide fate first):** `SelectionManager`, `SpatialWindowManager`+`WindowGroup`, `FileStateManager`, `CodeColorManager`, `EntityInputRouter` — all `null` in the r3f client (`CommandProvider.jsx:110-115`). Group membership *would be* persistable intent **if** groups ship; until wired, out of the model entirely. Confirm "is groups a shipped feature" before treating its write-only `groups` blob as intent-bearing.

---

**Bottom line:** the model already reserves every slot this plan fills (`sheet.view`, `field.camera`, `field.layout`, `field.activeSheetId` — all null today, all forward-built). The reconciler pattern already exists three times locally and cleanly (`ScaleModel.resolve` for model-backed grids, `AttentionManager.set`, `InteractionContext`). The work: *grow* `WorkspaceModel.view` into the declarative per-surface record, *generalize* those three disciplines into one async-serialized `live ← model` projection loop, and *collapse* `SessionStore`'s scrape-and-replay into model (de)serialization — Slice 0's schema-tolerant restore first, then terminal geometry, slice by slice.

**Relevant files:** `/home/ivan/dev/glyph3d-js/app/client/WorkspaceModel.js`, `/home/ivan/dev/glyph3d-js/app/client/SessionStore.js`, `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/collections/ScaleModel.js`, `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/services/interaction/CameraDock.js`, `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/collections/TerminalGrid.js`, `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/collections/AgentGrid.js`, `/home/ivan/dev/glyph3d-js/app/commands/handlers/terminalCommands.js`, `/home/ivan/dev/glyph3d-js/app/commands/handlers/repoCommands.js`, `/home/ivan/dev/glyph3d-js/app/commands/handlers/annotationCommands.js`, `/home/ivan/dev/glyph3d-js/app/commands/handlers/gridVisualState.js`, `/home/ivan/dev/glyph3d-js/cli/attach_unix.go`, `/home/ivan/dev/glyph3d-js/app/client/CommandProvider.jsx`.
