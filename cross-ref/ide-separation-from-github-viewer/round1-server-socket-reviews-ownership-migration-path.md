# Round 1: server-socket reviews ownership-boundaries, migration-path

## Errors Found

### 1. MinimapOverlay is NOT IDE-only (migration-path, line 76)

migration-path lists `MinimapOverlay.js` under "IDE-Specific (MOVE)" and proposes `git mv` to `examples/ide/`. This is factually wrong. `GitHubRepoViewer.js` imports and instantiates it:

- **Line 24**: `import { MinimapOverlay } from './components/MinimapOverlay.js';`
- **Line 324**: `this.minimapOverlay = new MinimapOverlay({...})`

The standalone viewer at `index.html` loads `GitHubRepoViewer`, which creates a `MinimapOverlay`. Moving this file to `examples/ide/` would break `examples/github-viewer/index.html`. ownership-boundaries correctly classifies it as Viewer (line 28 of its table), contradicting migration-path. **ownership-boundaries is correct.**

### 2. IDEShell.js has 4 import paths, not 13 (migration-path, line 88)

migration-path states "13 relative imports in IDEShell.js" that need rewriting. Actual count from the source:

```
import { repoPanelHTML, ... } from './components/Drawer.js';      // 1 (multi-line)
import { logCapturePanelHTML } from './components/LogCapturePanel.js'; // 2
import { diffPanelHTML } from './components/DiffPanel.js';            // 3
import { primaryMod } from './platform.js';                           // 4
```

That is 4 import statements, 4 paths to rewrite. The "Phase 2" rewrite table (lines 128-131) is correct despite the summary overcounting. Minor error, but it signals the summary was not verified against the code.

### 3. TUIFormatter.js omitted from dependency graph (ownership-boundaries, Section 6)

The dependency graph lists `TUIWindow.js`, `TUIFocusManager.js`, `TUIWindowManager.js` under websocket/ but omits `TUIFormatter.js`. This file is imported by **12 of the 13 command modules** (every one except `windowCommands.js`). It provides `box()`, `table()`, and `kvLines()` formatters. It is heavily coupled infrastructure, not an optional module. The dependency graph should list it alongside the other TUI* files.

### 4. "No IDE-specific commands" is misleading (ownership-boundaries, line 191)

The dependency graph states "No IDE-specific commands; all are viewer operations." While technically true (no command file imports IDEShell), the TUI window system (`TUIWindow`, `TUIWindowManager`, `TUIFocusManager`) is fundamentally IDE infrastructure -- it provides terminal panes, cursor tracking, focus management, and keystroke routing. These are closer to IDE concerns than to "standalone repo viewer" concerns. The statement conflates "imported by IDE code" with "serves IDE purposes."

## Gaps

### What I covered that others missed

1. **AgentWindow/AgentWindowManager/CliConnection** (`cli/` directory): Neither ownership-boundaries nor migration-path mentions these three files. They are the Node.js-side counterparts that create and manage 3D text panels over the WebSocket relay. AgentWindowManager imports CliConnection and AgentWindow. These are critical to the IDE workflow (cross-ref analysis uses them) and their ownership must be decided. migration-path says CLI stays in github-viewer but does not separately analyze the Agent* files.

2. **ws-relay protocol ownership**: My Phase 0 concluded ws-relay stays with github-viewer (display-side responsibility). migration-path proposes moving it to `examples/ide/` (line 115). This is a substantive disagreement -- see Tensions below.

### What others covered that I missed

1. **DOM element ID coupling** (ownership-boundaries, lines 196-236): Thorough DOM structure analysis showing which IDs are IDE-specific (`#editor-tab-bar`, `#statusbar`) vs viewer-agnostic (`#canvas`). My server-socket analysis did not address DOM coupling.

2. **DrawerController shim pattern** (ownership-boundaries/dependency-graph): The `ide.html` lines 207-216 monkey-patch `viewer.drawer = ide.asDrawer()` after init. This is the key integration seam. Neither my work nor migration-path adequately analyzes whether this pattern survives separation cleanly.

## Tensions

### 1. ws-relay.mjs ownership: IDE vs github-viewer

- **migration-path (line 115)**: `git mv examples/github-viewer/ws-relay.mjs examples/ide/ws-relay.mjs` -- treats relay as "IDE infrastructure."
- **My Phase 0 conclusion**: ws-relay stays with github-viewer because it is a display-side relay that routes messages to the browser viewer. The relay has zero IDE awareness -- it routes between "display" and "controller" roles.

**Correct position**: The relay should stay in github-viewer or move to a shared location. Rationale: `ws-relay.mjs` (line 29-30) manages `display` and `controllers` -- these are viewer-facing concepts. The relay works identically whether the display is ide.html or index.html. Moving it to `examples/ide/` wrongly implies it is IDE-specific. If it must move, `examples/shared/` or project root is better than `examples/ide/`.

### 2. CommandRouter: shared infrastructure vs viewer-specific

- **ownership-boundaries (line 68)**: Lists CommandRouter under "Shared" in the websocket table, but then says (line 191) "No IDE-specific commands; all are viewer operations."
- **My Phase 0**: CommandRouter is protocol-agnostic shared infrastructure.
- **migration-path (line 79)**: Keeps all websocket/ in github-viewer.

These are not contradictory but the framing is confused. CommandRouter is shared infrastructure that happens to live in github-viewer. If a third example ever needs command dispatch, it would need to import from `../github-viewer/websocket/CommandRouter.js`, which is architecturally wrong. The dependency graph should flag this as a future extraction candidate.

### 3. CommandBar initialization: who owns it?

- **ownership-boundaries (line 189)**: "IDEShell does NOT import CommandBar. The command bar is currently initialized inside GitHubRepoViewer for IDE environments, creating a layering violation."
- **Actual code** (`ide.html` lines 227-235): CommandBar is initialized in `ide.html`'s script block, not inside GitHubRepoViewer. `GitHubRepoViewer.js` has zero imports of CommandBar (verified via grep).

**ownership-boundaries is wrong here.** There is no layering violation. The init script in ide.html creates CommandBar after `viewer.init()`, grabs `viewer._commandRouter`, and mounts the bar. This is clean separation -- ide.html is the composition root that wires IDE components to viewer internals.

## Recommendations

1. **Do NOT move MinimapOverlay.js.** Remove it from migration-path's move list. It is a viewer component imported by GitHubRepoViewer.js line 24.

2. **Do NOT move ws-relay.mjs to examples/ide/.** Either keep it in github-viewer/ or move to project root / `examples/shared/`. It serves any display client, not just IDE.

3. **Add TUIFormatter.js to the dependency graph.** It is imported by 12 command modules and is core websocket infrastructure.

4. **Decide ownership of cli/AgentWindow*.mjs and cli/CliConnection.mjs.** These 3 files are Node.js-side IDE infrastructure (they create remote 3D panels for cross-ref agents). Propose: keep in github-viewer/cli/ but document as "IDE tooling that operates over the relay protocol."

5. **Fix the import count in migration-path.** IDEShell.js has 4 import paths to rewrite, not 13. Update the summary to match the detailed table.

6. **Correct the CommandBar layering claim in ownership-boundaries.** Remove the statement that CommandBar is "initialized inside GitHubRepoViewer." It is initialized in ide.html's script block (lines 227-235), which is correct architecture.

7. **Flag CommandRouter as a future extraction candidate.** It is protocol-agnostic dispatch with no viewer-specific logic. If a third example needs commands, it should not import from `../github-viewer/websocket/`.

8. **Reclassify TUI* modules.** They are currently labeled "Shared" but serve terminal/IDE purposes (cursor, focus, window management). Label them "Shared (IDE-leaning)" to signal they may need extraction if IDE grows.

9. **Add the DrawerController shim to the migration risk list.** The monkey-patch at ide.html line 215 (`viewer.drawer = ide.asDrawer()`) depends on init() creating a DrawerController first, then replacing it. If viewer.init() changes, this breaks silently. Document the contract.

10. **Test the standalone viewer after any move.** migration-path's validation checklist (line 247) correctly includes this, but given the MinimapOverlay error, add an explicit step: `grep -r "from '\./components/MinimapOverlay" examples/github-viewer/` to verify no broken imports.

## Key Insight

The single most dangerous assumption across both reviewed documents is treating file location as ownership signal. migration-path proposes moving MinimapOverlay because it "seems IDE-ish" (responsive minimap commits are recent), but the import graph proves it is core viewer infrastructure. ownership-boundaries correctly identifies this by tracing imports, but then makes its own assumption error about CommandBar initialization by describing a layering violation that does not exist in the code. The lesson: every ownership claim must be verified against `import` statements and actual call sites, not inferred from naming or conceptual affinity. The codebase has clean separation already -- IDEShell imports 4 shared modules, viewer imports 0 IDE modules, and ide.html is a proper composition root. The migration is simpler than either document suggests precisely because the boundaries are already well-drawn.
