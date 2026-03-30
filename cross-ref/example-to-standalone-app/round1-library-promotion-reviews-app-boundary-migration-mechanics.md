# Round 1: library-promotion reviews app-boundary + migration-mechanics

---

## Errors Found

### 1. app-boundary: Summary count is wrong (self-acknowledged, still wrong)

The summary table says "PROMOTE: 6" then immediately corrects to 8. The actual list of PROMOTE items is: MinimapOverlay, TouchController, TUIWindow, TUIWindowManager, TUIFormatter, TUIFocusManager, encoding.js, spatialHelpers.js. That is 8 files. The table header should have been corrected inline, not left as a contradictory pair of statements.

### 2. migration-mechanics: TUIWindow.js import rewrite is incomplete

The manifest lists `app/websocket/TUIWindow.js` as having 1 rewrite (the `CodeGrid.js` import). But TUIWindow.js likely also imports from Three.js via a bare specifier or references `CHAR_DIMENSIONS` from `src/core/constants.js`. I need to verify this directly, but the manifest should have traced all imports, not just the `src/` ones it spotted.

### 3. app-boundary: spatialHelpers.js promotion is questionable

app-boundary classifies `spatialHelpers.js` as PROMOTE to `src/utils/spatialHelpers.js`, calling it "pure spatial math over Three.js primitives." But the file contains `resolveGrid()` and `resolveGridByIdOrIndex()` which take a `grids` array and a `registry` context object -- these are application-level grid resolution functions, not pure spatial math. The file is a mix: some functions (AABB computation, camera framing) are genuinely reusable, while others (grid resolution by registry ID) are app-specific. Promoting the whole file blindly would leak app concepts into src/.

### 4. migration-mechanics: Missing `agentLayoutCommands.js` from zero-change list

The "Files with ZERO import changes" section lists `agentLayoutCommands.js` implicitly (it's not in the rewrite manifest). But this file should be verified -- it likely imports from `../TUIWindowManager.js` or `../TUIFormatter.js` internally, which would indeed be zero-change, but the omission from explicit verification is a gap.

---

## Gaps

### 1. Neither agent addresses the package.json exports map

My analysis recommended adding `"./tui": "./src/tui/index.js"` to the package.json exports. app-boundary mentions a `src/tui/` destination but never discusses the package.json change. migration-mechanics mentions "Update `package.json` if it references examples/ paths" as a checklist item but never specifies what the actual change would be. If we promote TUI to src/, the exports map needs updating in the same commit.

### 2. migration-mechanics doesn't discuss the importmap in HTML files

Browser ES modules in this project use an importmap (in the HTML files) to resolve bare specifiers like `'three'`. When moving HTML files from `examples/github-viewer/` to `app/`, the importmap's relative paths to `node_modules/` will change. This is not mentioned anywhere in the rewrite manifest. This is a silent breakage risk.

### 3. No agent addresses the word-wall example

`examples/word-wall/` is mentioned only in passing. If we create `src/tui/` and update `src/index.js` exports, does word-wall still work? Does it import from `src/index.js`? This needs verification.

### 4. migration-mechanics doesn't address the ws-relay servers' working directory assumptions

`ws-relay.mjs` and `ws-relay.py` are moved to `app/`. If they serve static files or reference relative paths for any purpose, those would break. The risk assessment says "no file paths" but this should be confirmed by reading the files.

---

## Tensions

### Tension 1: MinimapOverlay and TouchController -- DEFER vs PROMOTE

**My position (DEFER)**: I deferred both because they have coupling issues. TouchController calls `cameraController._applyDragTranslation` (underscore-prefixed private method) and reads `cameraController.ctx.camera`. MinimapOverlay requires `getLayoutBounds` which is an app-supplied callback whose contract is undefined in the library.

**app-boundary's position (PROMOTE)**: They argue both use DI, have no app-specific assumptions, and follow the same pattern as already-promoted services.

**Verdict: I partially retract.** MinimapOverlay is a reasonable promote -- its DI surface (`{THREE, camera, getGrids, getLayoutBounds, onNavigate}`) is clean and the contract is straightforward (return a Box3, return an array of grids). Any consumer of CodeGrid could use it. However, TouchController should remain DEFERRED. It reaches into `_applyDragTranslation` which is a private method on ViewerCameraController. Promoting TouchController into src/ while it depends on a private API of another src/ class creates an internal coupling smell. The right fix: first make `_applyDragTranslation` a public method (or expose a proper `applyDragDelta(dx, dy)` API), then promote TouchController. This is a one-line refactor + promote, but it should happen deliberately.

### Tension 2: TUI placement -- src/tui/ vs app/websocket/

**My position (src/tui/)**: TUI files are generic 3D terminal infrastructure with clean dependency chains. They should be library code.

**migration-mechanics' position (app/websocket/)**: Keep everything in app/websocket/ as-is, preserving internal structure. No promotion at all.

**Verdict: I maintain src/tui/.** migration-mechanics is a pure move-and-rewrite plan -- it explicitly does not make promotion decisions. Its job is to describe the mechanics of moving files, not to judge what deserves library status. The fact that it places TUI in app/websocket/ is not an argument against promotion; it's the absence of an opinion. app-boundary independently agrees with me that TUI belongs in src/tui/. The dependency chain is clean (TUIWindow -> CodeGrid, TUIFocusManager -> constants.js + platform.js, TUIFormatter -> nothing). These are library primitives.

However, there is a sequencing question: should TUI promotion happen in the same commit as the app extraction? migration-mechanics makes a strong argument for one atomic commit that is purely mechanical (move + fix imports). Mixing promotion into that commit adds conceptual complexity. **Recommendation: two commits.** Commit 1: mechanical move to app/ (migration-mechanics' plan). Commit 2: promote TUI/encoding/MinimapOverlay from app/ to src/.

### Tension 3: spatialHelpers.js -- PROMOTE vs APP

**app-boundary says PROMOTE.** I said nothing about it (I didn't analyze commands/ internals beyond "app-specific"). On inspection, it's a mixed file. `resolveGrid` and `resolveGridByIdOrIndex` are app-level (they take a registry context). `computeAABB`, `frameCameraOnBounds` are pure spatial math.

**Verdict: Split, don't promote whole.** The pure spatial functions could go to `src/utils/spatialMath.js`. The grid-resolution functions stay in app/. Promoting the whole file would put app concepts (`registry`, `grids` array semantics) into the library.

---

## Recommendations

1. **Do the migration in two commits.** Commit 1: pure mechanical move (migration-mechanics' plan). Commit 2: promote TUI + encoding + MinimapOverlay to src/. This keeps each commit reviewable and independently valid.

2. **Promote MinimapOverlay to src/components/MinimapOverlay.js.** Its DI surface is clean. Retract my DEFER on this one.

3. **Keep TouchController deferred.** Promote it only after `_applyDragTranslation` is made public or wrapped in a proper API on ViewerCameraController.

4. **Split spatialHelpers.js before promoting.** Extract `computeAABB` and `frameCameraOnBounds` to `src/utils/spatialMath.js`. Leave `resolveGrid` and `resolveGridByIdOrIndex` in `app/commands/`.

5. **Add importmap verification to migration-mechanics' validation checklist.** The HTML importmap paths for bare specifiers (`'three'`) will change depth when the HTML moves from `examples/github-viewer/` to `app/`.

6. **Update package.json exports map** in the promotion commit: add `"./tui": "./src/tui/index.js"`.

7. **Verify word-wall example** still works after src/index.js changes from adding TUI exports.

8. **Create src/tui/index.js barrel** that re-exports TUIWindow, TUIWindowManager, TUIFocusManager, TUIFormatter.

9. **Fix app-boundary's summary count** -- the PROMOTE count is 8, not 6. The self-correction is there but the table still reads wrong.

10. **migration-mechanics should read TUIWindow.js and TUIFocusManager.js imports exhaustively** -- the current manifest may have missed some import paths.

---

## Key Insight

All three agents agree on the big picture: TUI is library, commands are app, the mechanical move is straightforward. The real risk is not the move itself but the **sequencing of promotion vs. extraction**. migration-mechanics' instinct to do a pure mechanical move first is correct -- it preserves git history, creates a working intermediate state, and keeps the diff reviewable. Promotion should be a follow-up commit that moves files from `app/` into `src/`, not a simultaneous restructuring. This two-phase approach also means the promotion commit can be reverted independently if it breaks something, without unwinding the entire app extraction.
