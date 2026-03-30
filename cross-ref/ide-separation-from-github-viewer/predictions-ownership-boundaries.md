# Predictions from ownership-boundaries Agent

**Date:** 2026-03-30
**Author:** ownership-boundaries agent
**Context:** Written BEFORE reading other agents' Phase 0 outputs.

---

## Prediction 1: server-socket Agent

I expect the server-socket agent concluded that the WebSocket relay (`ws-relay.mjs`, `ws-relay.py`), the CLI tool (`cli/glyph-cli.mjs` and its supporting files like `CliConnection.mjs`, `AgentWindow.mjs`, `AgentWindowManager.mjs`), and the `CommandRouter.js` should all **remain co-located with the viewer** rather than moving to IDE-specific territory. The reasoning: these are all viewer-command infrastructure -- CommandRouter dispatches commands that manipulate the 3D scene (camera, grids, layouts, colors), and the WebSocket bridge + CLI exist to control the viewer from external tools. None of them depend on IDEShell or CommandBar.

Their key concern was likely the `CommandBar.js` dependency on `commands/encoding.js` -- CommandBar imports from the websocket commands directory, which means if CommandBar moves to `examples/ide/`, it creates a cross-example import reaching back into `examples/github-viewer/websocket/commands/encoding.js`. The server-socket agent probably flagged this as the one coupling point that needs resolution, either by extracting `encoding.js` to a shared location or by having the IDE import it across the boundary.

I also expect they concluded that `ws-relay.mjs` and `ws-relay.py` are deployment-agnostic Node/Python servers that could theoretically live anywhere (project root, a `server/` directory, etc.), but that moving them is low priority since they serve the viewer's command system regardless of whether an IDE shell wraps it.

---

## Prediction 2: migration-path Agent

I expect the migration-path agent proposed a **minimal-move, maximum-reuse** migration plan -- moving only 2-3 files physically (`IDEShell.js`, `CommandBar.js`, and `ide.html`) into `examples/ide/`, while keeping the 40+ shared files in `examples/github-viewer/` and having the IDE example import them via relative paths (`../github-viewer/...`). They likely argued against duplicating or extracting shared code into `src/` as premature -- the viewer is the primary consumer and the shared code is not general-purpose library code.

Their concrete plan probably has 3-4 phases: (1) create `examples/ide/` directory with its own entry point, (2) move `IDEShell.js` and `CommandBar.js` there, (3) update import paths so the IDE entry point reaches back into `github-viewer/` for shared components like `Drawer.js`, `platform.js`, `DiffPanel.js`, and `LogCapturePanel.js`, and (4) verify both `index.html` (standalone viewer) and the new `examples/ide/index.html` work independently.

Their key concern was likely the Drawer.js coupling -- specifically that `ide.html` currently patches `viewer.drawer` with `ide.asDrawer()`, which is a runtime monkey-patch that creates an implicit interface contract. The migration-path agent probably recommended formalizing this into an explicit DrawerController interface or adapter pattern so the IDE can provide its own drawer implementation without patching the viewer post-init. They may have also flagged the `ide.html` inline script block (lines 185-327 based on my analysis) as something that needs to become a proper module in the new `examples/ide/` directory.
