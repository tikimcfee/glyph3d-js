# IDE-as-Client Plan — the r3f rebuild

**Status:** decided 2026-05-27. This is the active plan for the next phase of the
overhaul. Supersedes the vaguer "build IDE chrome in r3f" line in `AUDIT_DREAM.md`.

## The decision

Rebuild the IDE as a **react-three-fiber client on top of `@glyph3d/core` +
`packages/glyph3d-r3f`**, replacing the vanilla-JS god-class IDE
(`app/GitHubRepoViewer.js` + `app/IDEShell.js` + `app/components/`).

This is **not a third implementation** and **not a from-scratch rewrite**:

- The **core is not rebuilt.** `@glyph3d/core` is the stable, fast, done
  foundation (the perf work — virtualizer, worker-side shaping, content-sized
  renderers, adaptive reload budget — all lives here and is shell-agnostic).
- The **old IDE is a blueprint we read while building, then delete at parity.**
  Implementation count goes 2 → 1, not 2 → 3. It stays running the whole time;
  there is no no-man's-land.
- The **migration rides the command bus.** `CommandRouter` + `WebSocketBridge` +
  the ~28 handlers operate on a *context bag*, not the render loop — they port by
  re-wiring, not rewriting. The new client speaks the same protocol from day one,
  so the old IDE and the new client are driven by identical commands during the
  transition.

## The one good way (the principle that ends the discordance)

```
@glyph3d/core  →  glyph3d-r3f  →  { apps/home, apps/ide }
```

Everything is a thin app over the **single substrate** `glyph3d-r3f`. Today's
discordance (two render loops, `/home` reimplementing atlas/shaper/slug boot) is
*transition debt*, not a competing pattern:

- `/home` predates `glyph3d-r3f`, so it hand-rolls the engine boot. **Folding
  `/home` onto the bindings (useGlyphEngine/GlyphCanvas) removes that
  reimplementation** — part of establishing the shared substrate.
- The IDE is a sibling app on the same bindings, using `/home`'s structure as the
  *structural blueprint* and the old IDE as the *feature/command blueprint*.

The two-shell tax disappears the moment the old IDE is deleted.

## v1 North Star (the acceptance test)

> "Please take me on a tour of this repository."
> → the new client loads the repo, lays it out, highlights text, and flies the
> camera — driven by Claude over the RPC/CLI command bus.

If that works end-to-end on the new client, the architecture is proven. It
exercises the full vertical slice:

- **command bus** (WebSocketBridge + CommandRouter, CLI → browser RPC)
- **load** (repo/fs source → grid creation → the optimized load/evict/reload path)
- **layout** (hierarchical/treemap/etc. via `layout.*` / `grid.*`)
- **highlight** (`highlight.token|range|lines|glyph`)
- **camera** (`camera.*`, spatial nav)
- **tour** (`tour.*` sequencing, or Claude orchestrating raw commands)

## What ports / rebuilds / drops (from the 2026-05-27 inventory)

- **Port as-is (~42%, the spine):** all of `app/commands/` — the ~28 handlers +
  `CommandRouter`/`WebSocketBridge`/`ViewerAPI` (already in core, DOM-free). Zero
  viewer coupling (one benign stray `ctx._agentGrids`). The thing we value most
  (RPC into the browser) is the most portable piece. **The handlers are finished —
  we do NOT rewrite or update them.** `registerAllCommands(router)` registers all
  of them verbatim in one call. The *only* iterative work is on the **context-bag
  provider**: a command runs the moment its context deps are satisfied, errors
  before that — so a failing command means "the provider hasn't supplied field X
  yet," never "the handler is broken." Build the socket (context), not the plugs.
- **Rebuild as React (~23%, chrome):** the DOM panels — file tree, editable
  fields, configuration, state UI, command bar, drawer/layout shell. These only
  *issue commands and read state*; rebuild them as components.
- **Drop free (cruft):** the **grouping** feature (~600 lines: `groupCommands.js`
  + `GroupsPanel.js`, isolated; `SpatialWindowManager` stays in core — grouping is
  reproducible via command sets) and the **Node Graph / "substrate" tab** (~60
  lines in IDEShell + iframe markup — it's an embedded *external* `llm-experiments`
  nodegraph server, no coupling; re-addable later as a ~20-line iframe component).

## Hard edges (size carefully — mostly already in core)

1. **In-grid editing** — ~80% core (CodeGrid edit ops + caret). App side is ~28
   lines of keystroke routing → becomes a React keydown hook. Watch React's event
   model.
2. **Claude activity window + highlighting** — `agentLayoutCommands` +
   `attentionCommands` + `highlightCommands` are ~85% core/context. App side is the
   "currently-dimmed grids" state → a React context/hook. This is the "almost
   there, rough edges" piece worth sharpening.
3. **State persistence** — `StateController` is portable; `StatePersistence.js`'s
   real work is unbinding ~200 lines from raw `document.getElementById` refs →
   callback/context-based.

## Migration order

1. **Capture** (this doc + memory). ✅
2. **Linchpin:** an **app-context provider** in the r3f client that supplies what
   `buildContext()` needs (scene/camera/renderer via `useThree`; registry +
   managers instantiated in the provider). Register ALL handlers as-is
   (`registerAllCommands`), wire `CommandRouter` + `WebSocketBridge`, connect to
   the relay, then **round-trip `glyph3d-cli grid.list`** CLI → browser. `grid.list`
   needs only `ctx.registry`, so it's the first to light up; richer commands light
   up as the context grows — no handler edits. Proves the spine end-to-end. ✅
   **DONE `6b7563a`:** `keystone/CommandCenter.jsx` (the provider) + `keystone/main.jsx`
   (`<TrackedCodeGrid>` registers grids into the core `SceneRegistry`). Verified:
   `grid.list`/`grid.info 0`/`registry.types`/`help` all round-trip; the Claude
   Code hook registers its `claude-activity` window through the same registry
   (independent confirmation). One enabling change: `@glyph3d/core` exports gained
   `"./*": "./src/*"` so Vite resolves deep subpaths like the browser importmap
   prefix does — the app's handlers reach paths the curated barrels don't cover.
   NB the relay is the Go server on :8080; keystone is served by Vite on :5173, so
   `CommandCenter` targets :8080 explicitly (`?relay=PORT` overrides).
3. **Substrate consolidation:** fold `/home` onto `glyph3d-r3f` (remove its boot
   reimplementation), confirming the bindings are a real app substrate.
4. **Scaffold `apps/ide`** as the new client on the bindings.
5. **Grow the context + wire the load path** until the v1 tour slice works
   (handlers are already registered; this is populating context fields —
   cameraController, layoutManagers, etc. — so load/layout/highlight/camera light
   up). Not "porting commands"; they're already ported.
6. **Rebuild chrome** panel-by-panel from the blueprint (file tree, command bar,
   config, state, editable fields).
7. **Sharpen the hard edges** (editing hook, activity/dim state, state persistence).
8. **Retire the old IDE** at parity; delete grouping + graph tab.

## Out of scope for v1 (future)

Live floating terminals, streaming inputs, the nodegraph embed. The command bus
+ entity model already anticipate these; they come after the tour slice lands.
