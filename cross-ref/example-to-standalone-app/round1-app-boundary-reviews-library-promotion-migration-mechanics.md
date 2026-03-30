# Round 1: app-boundary reviews library-promotion and migration-mechanics

Reviewer: **app-boundary**
Reviewed: **phase0-library-promotion.md**, **phase0-migration-mechanics.md**

---

## Errors Found

### 1. migration-mechanics places MinimapOverlay and TouchController in `app/components/` without noting any promotion potential

migration-mechanics lists `MinimapOverlay.js` and `TouchController.js` under "Files with ZERO import changes" and places them in `app/components/` as simple moves. This is not an error in the migration plan itself, but it treats these files as settled decisions when they are genuinely contested: app-boundary classifies both as PROMOTE, library-promotion classifies both as DEFER. migration-mechanics does not acknowledge the question at all. This is a gap in the analysis, not a factual error.

### 2. library-promotion's PROMOTE count is 5, not 8 -- missing spatialHelpers.js

library-promotion promotes encoding.js but does not mention spatialHelpers.js. This is a material omission. spatialHelpers.js is pure spatial math (grid resolution, AABB computation, camera framing) with zero app-specific logic. It imports only `three` and exports pure functions. app-boundary classified it as PROMOTE to `src/utils/spatialHelpers.js`. library-promotion's silence on this file means it was either missed or implicitly left as app code, but no rationale is given.

### 3. migration-mechanics claims 35 import rewrites across 11 files -- this undercounts

The manifest lists specific files and counts but does not account for promotions. If even the consensus-PROMOTE files (TUI system, encoding.js) move to `src/`, then every command file importing from `../TUIFormatter.js`, `../TUIWindowManager.js`, or `./encoding.js` would need rewrites to point at `src/tui/` and `src/utils/`. The 35-statement count is accurate only for the zero-promotion scenario. The document does not acknowledge this dependency on the promotion decision.

### 4. library-promotion says TouchController is "tightly coupled to CameraController internals"

Verified: TouchController calls `this.cam._applyDragTranslation(dx, dy)` -- a private (underscore-prefixed) method. This is a legitimate coupling concern and library-promotion is correct to flag it. However, calling it "tight coupling" overstates the issue. It's a single private-method call that could be resolved by making `_applyDragTranslation` part of CameraController's public API (it arguably should be). The DEFER verdict is defensible but not the only reasonable conclusion.

---

## Gaps

### 1. No agent addresses `package.json` exports for `./tui`

library-promotion mentions adding `"./tui": "./src/tui/index.js"` to package.json exports at the very end, but none of the three analyses verifies what the current package.json exports map looks like or whether the existing `./collections`, `./workers`, `./utils` entries need updating after file additions.

### 2. No agent addresses the `ws-relay.mjs` and `ws-relay.py` relay servers

migration-mechanics moves them to `app/` but marks `ws-relay.py` as "low risk, no file paths." Neither analysis considers whether the relay servers have path assumptions (e.g., `--serve` flags, static file serving roots) that would break when moved. These files should be read and verified.

### 3. No analysis of `examples/word-wall/` imports

All three agents correctly leave `examples/word-wall/` unchanged, but none verifies that it has zero imports from `examples/github-viewer/`. If it does, the migration breaks it.

### 4. The `src/tui/index.js` barrel file is mentioned but not specified

library-promotion says to create a barrel export but does not define what it exports. Should it be `{ TUIWindow, TUIWindowManager, TUIFocusManager, TUIFormatter }`? Does `src/index.js` (the main library entry) re-export it?

---

## Tensions

### The Central Tension: Should TUI, encoding, and spatialHelpers be promoted NOW or stay in app/?

This is the key disagreement the task asks me to address.

**migration-mechanics** keeps everything in `app/websocket/` -- TUI files at `app/websocket/TUIWindow.js` etc., encoding.js at `app/websocket/commands/encoding.js`, spatialHelpers.js at `app/websocket/commands/spatialHelpers.js`. No promotions whatsoever. The rationale is implicit: the migration is a structural move, not a refactoring.

**library-promotion** promotes TUI (4 files) to `src/tui/` and encoding.js to `src/utils/`. Defers MinimapOverlay and TouchController. Silent on spatialHelpers.

**app-boundary** promotes TUI (4 files) to `src/tui/`, encoding.js and spatialHelpers.js to `src/utils/`, MinimapOverlay to `src/components/`, and TouchController to `src/services/interaction/`.

**Who is right?**

migration-mechanics is right about one thing: combining a structural move with refactoring increases risk. A pure move with import rewrites is mechanically verifiable. Adding promotions multiplies the import rewrite surface.

However, migration-mechanics is wrong to defer promotion indefinitely. The TUI files have zero app-specific logic -- I verified every import chain. TUIWindow imports only CodeGrid (already in `src/`). TUIWindowManager imports only TUIWindow. TUIFocusManager imports only `platform.js` and `constants.js` (both in `src/`). TUIFormatter has zero imports. These are clean promotions with no refactoring required.

**My recommendation**: Do the migration in two commits within the same PR:

1. **Commit 1**: Pure structural move to `app/` with import rewrites. Zero promotions. This matches migration-mechanics exactly. The app works after this commit.
2. **Commit 2**: Promote TUI (4 files) to `src/tui/`, encoding.js to `src/utils/`, spatialHelpers.js to `src/utils/`. Update imports in `app/` to point at new `src/` locations. The app still works after this commit.

This gives migration-mechanics' safety (each commit is independently valid) while achieving the promotions that library-promotion and app-boundary agree on. The two commits are both in the same PR, so they ship together.

### MinimapOverlay and TouchController: PROMOTE vs DEFER

library-promotion says DEFER both. app-boundary says PROMOTE both. migration-mechanics is silent.

library-promotion's DEFER rationale for MinimapOverlay ("needs config abstraction") is weak. The component already takes `{THREE, camera, getGrids}` via DI -- that IS the config API. There is nothing to abstract.

library-promotion's DEFER rationale for TouchController ("tightly coupled to CameraController internals") is stronger. The `_applyDragTranslation` private method dependency is real. But the fix is trivial (make it public) and could be done in the same promotion commit.

**My recommendation**: Promote MinimapOverlay now. Defer TouchController until CameraController exposes `_applyDragTranslation` as a public method (or add a `pan(dx, dy)` public method).

### Command handlers: unanimous agreement

All three agents agree that command handlers are app-specific. No tension here.

---

## Recommendations (10)

1. **Execute migration in two commits, one PR**: Commit 1 = pure move (migration-mechanics plan). Commit 2 = promotions (TUI + encoding + spatialHelpers + MinimapOverlay).

2. **Promote TUI system to `src/tui/` in commit 2**: All four files (TUIWindow, TUIWindowManager, TUIFocusManager, TUIFormatter) have clean dependency chains pointing entirely into `src/`. No refactoring needed.

3. **Promote encoding.js to `src/utils/encoding.js`**: Zero dependencies. Pure utility. All three agents agree (two explicitly, one by omission since it's not contested).

4. **Promote spatialHelpers.js to `src/utils/spatialHelpers.js`**: library-promotion missed this. It is pure math over Three.js primitives. The file's own header says "pure functions -- no command router, no DOM, no side effects."

5. **Promote MinimapOverlay to `src/components/MinimapOverlay.js`**: library-promotion's DEFER rationale is unconvincing. The DI pattern is already clean.

6. **Defer TouchController**: library-promotion is correct that `_applyDragTranslation` is private API coupling. Promote after CameraController exposes a public `pan()` method.

7. **Verify `examples/word-wall/` has no imports from `examples/github-viewer/`** before executing the migration. If it does, those imports break.

8. **Add `src/tui/index.js` barrel exporting all four TUI classes**, and register `"./tui": "./src/tui/index.js"` in package.json exports.

9. **Read `ws-relay.mjs` and `ws-relay.py` for path assumptions** before moving. migration-mechanics dismissed this as low risk without reading the files.

10. **Update CLAUDE.md project structure** in the same PR. All three agents' outputs will be stale documentation otherwise.

---

## Key Insight

The three analyses are more complementary than contradictory. migration-mechanics provides the mechanical execution plan but deliberately avoids architectural judgment. library-promotion provides the architectural judgment but stops at the promotion boundary. app-boundary provides the full classification but does not specify execution mechanics. The real work is combining them: migration-mechanics' commit strategy (atomic, verifiable) with library-promotion's + app-boundary's promotion list (TUI, encoding, spatialHelpers, MinimapOverlay), executed as a two-commit PR where each commit leaves the app in a working state. The only genuine disagreement -- whether to promote now or later -- resolves by doing both in sequence within the same PR, eliminating migration-mechanics' valid concern about risk while still achieving the architectural goal.
