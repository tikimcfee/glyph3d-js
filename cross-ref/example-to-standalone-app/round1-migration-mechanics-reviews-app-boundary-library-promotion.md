# Round 1: migration-mechanics reviews app-boundary + library-promotion

---

## Errors Found

1. **app-boundary summary count is wrong.** The table says PROMOTE = 6, then the correction below says 8, listing MinimapOverlay, TouchController, TUIWindow, TUIWindowManager, TUIFormatter, TUIFocusManager, encoding.js, spatialHelpers.js. That is 8 files, but the table body only shows 6 rows. The inline counts disagree with each other in the same section.

2. **library-promotion omits `spatialHelpers.js` from promotion list.** app-boundary classifies it as PROMOTE to `src/utils/spatialHelpers.js`. library-promotion does not mention it at all -- not in Tier 2, not in "defer", not in "app-specific". This is a gap, not a conscious decision. The file is pure spatial math with a clean JSDoc contract and zero app coupling in its function signatures (it takes `grids`, `camera`, `bounds` -- all library types). However, `resolveGridByIdOrIndex` does take a `ctx` bag, which is the app's context shape. So the file is *partially* promotable -- some functions are pure (`box3ToAABB`, `getWorldBounds`, `zDistanceForFit`, `resolveAnchor`) while others couple to the command context (`resolveGridByIdOrIndex`, `frameBounds`, `animateCamera`). Neither agent caught this split.

3. **app-boundary proposes `app/commands/handlers/` but the current `websocket/commands/index.js` is not just a handler registry.** It re-exports all command registration functions. Renaming the directory from `commands/` to `handlers/` would change every import path within the command files. This is unnecessary churn -- the parent rename from `websocket/` to `commands/` already communicates intent. Having `commands/handlers/` is redundant nesting.

---

## Gaps

1. **Neither agent addresses `colorConstants.js` promotion.** app-boundary marks it APP ("app-level design tokens"). But the color palette (named semantic colors for annotations, highlights, phases) is arguably useful to any TUI consumer. If TUIFormatter is promoted, a consumer writing formatted terminal output might want the same color vocabulary. Not critical, but worth noting.

2. **Neither agent addresses the `agentLayoutCommands.js` complexity.** This file orchestrates multi-agent window placement with phase-based coloring. It is deeply coupled to the CLI agent workflow. If TUI is promoted to `src/tui/`, this command handler would import from both `src/tui/` and `app/commands/` -- a clean cross-boundary import. But neither agent traced this specific path.

3. **library-promotion does not address what happens to the barrel export (`src/index.js`).** If 5 files move into `src/tui/`, the main `src/index.js` entry point and `package.json` exports map both need updating. library-promotion mentions `package.json` exports briefly but does not trace the barrel re-export chain.

4. **My own plan (migration-mechanics) has no concept of partial promotion.** I treated the move as a bulk operation: everything from `examples/` goes to `app/`. The other two agents correctly identified that some files should fork off toward `src/` during the migration. My plan would need a two-destination move step, not a single `app/` target.

---

## Tensions

### T1: TUI promotion to `src/tui/` vs. keeping in `app/websocket/`

Both app-boundary and library-promotion want TUIWindow, TUIWindowManager, TUIFormatter, and TUIFocusManager promoted to `src/tui/`. My plan keeps them in `app/websocket/`.

**Assessment: They are right.** The TUI files have clean DI, depend only on types already in `src/` (CodeGrid, constants, platform), and represent a coherent subsystem. A third-party consumer wanting terminal windows in 3D would need these. The "TUI window backed by CodeGrid" concept is as library-grade as CodeGrid itself -- it is a higher-level composition primitive.

**Migration impact: Minimal.** Instead of one `git mv` destination, we have two. The TUI files currently import from `../../../src/` (depth 3). Moving them into `src/tui/` would change those to sibling `../` imports within `src/`. The command files that currently import `../TUIFormatter.js` and `../TUIWindowManager.js` would need to import from `../../../src/tui/` instead. This adds ~6-8 import rewrites to my manifest but does not change the overall structure of the migration.

**Verdict: Accept. Promote TUI to `src/tui/`.** Add a barrel `src/tui/index.js` and a `"./tui"` entry in `package.json` exports.

### T2: Rename `websocket/` to `commands/`

app-boundary wants `app/commands/` instead of `app/websocket/`. My plan preserves `app/websocket/`.

**Assessment: `commands/` is better.** The directory's primary content is command handlers. The WebSocket transport is handled by `WebSocketBridge` in `src/services/orchestration/` -- the app directory just registers command vocabularies and bootstraps the context. With TUI files promoted out, what remains in `websocket/` is literally `index.js` (context builder) and `commands/` (handlers). The `websocket/` name describes the transport mechanism, not the intent. However, app-boundary's proposed `commands/handlers/` nesting is one level too deep. I would use:

```
app/commands/
  index.js              (was websocket/index.js -- context builder + init)
  handlers/             (was websocket/commands/ -- the actual command modules)
    index.js
    gridCommands.js
    ...
```

Wait -- that is exactly what app-boundary proposed. On reflection the nesting is fine because `commands/index.js` (the bootstrapper) is distinct from `commands/handlers/index.js` (the registry). The alternative flat layout would put 22+ files alongside the bootstrapper, which is messy.

**Verdict: Accept the rename to `commands/`.** Accept the `handlers/` subdirectory.

### T3: Promote `encoding.js` and `spatialHelpers.js` to `src/utils/`

Both agents want `encoding.js` promoted. app-boundary also wants `spatialHelpers.js` promoted. My plan keeps both in `app/websocket/commands/`.

**`encoding.js`: Promote.** Zero dependencies, pure functions, 40 lines, UTF-8 base64 encode/decode. This is textbook utility code. Any WebSocket consumer needs it. Promotion cost: change ~2-3 import paths. Trivial.

**`spatialHelpers.js`: Split, do not promote wholesale.** The file has two layers. Functions like `box3ToAABB`, `getWorldBounds`, `getWorldBox3`, `unionBounds`, `resolveAnchor`, `zDistanceForFit`, `fmtVec`, and `resolveGrid` are pure spatial math over Three.js types. But `resolveGridByIdOrIndex` takes a `ctx` bag (the app's command context), `frameBounds` calls `ctx._cancelCameraAnimation` and `ctx.cameraController`, and `animateCamera` uses `ctx.camera` and `ctx._cancelCameraAnimation`. These functions couple to the app's context shape. Promoting the whole file puts app-coupled functions into `src/utils/`. The clean solution: extract the pure math functions into `src/utils/spatialMath.js` and leave the context-dependent functions in `app/commands/spatialHelpers.js`. But this adds complexity to an already large migration. I recommend deferring the split -- keep the whole file in `app/commands/` for now and extract the pure math later.

**Verdict: Promote `encoding.js` to `src/utils/`. Defer `spatialHelpers.js`.**

### T4: MinimapOverlay and TouchController promotion

app-boundary wants both promoted. library-promotion defers both.

**Assessment: Agree with library-promotion's deferral.** MinimapOverlay and TouchController are plausible library components, but they are not blocking the migration and they are not as cleanly decoupled as the TUI system. Promoting them now adds scope to an already large move. Promote them in a follow-up pass.

**Verdict: Defer. Keep in `app/components/` for now.**

---

## Recommendations

1. **Adopt the two-destination migration**: `app/` for app code, `src/tui/` + `src/utils/encoding.js` for promoted code. Single atomic commit.

2. **Rename `websocket/` to `commands/` with `handlers/` subdirectory** per app-boundary's proposal. This reflects intent, not transport.

3. **Promote TUI (4 files) to `src/tui/`** with a barrel export and package.json entry. Update my import manifest to account for ~8 additional rewrites.

4. **Promote `encoding.js` to `src/utils/encoding.js`.** Update 2-3 import paths.

5. **Defer `spatialHelpers.js` promotion.** The file has app-coupled functions mixed with pure math. A clean split is warranted but should be a separate commit.

6. **Defer MinimapOverlay and TouchController promotion.** They are reusable but not urgent. Reduce migration scope.

7. **Drop the redundant `commands/handlers/` nesting concern.** On review, the two-level structure (bootstrapper at `commands/index.js`, registry at `commands/handlers/index.js`) is justified.

8. **Delete `BLUETOOTH_NOTES.md`** during the migration. Both agents agree.

9. **Delete `cli/__pycache__/`** and add `__pycache__/` to `.gitignore`. Both agents agree, my plan also flagged this.

10. **Update my import rewrite manifest** to reflect the new destinations. The total rewrite count increases from ~35 to ~45 due to TUI promotion and directory rename.

---

## Key Insight

My migration-mechanics plan treated the move as a monolithic relocation: everything in `examples/` goes to `app/`, preserving internal structure. The other two agents correctly identified that the migration is actually a *classification event* -- the moment where we sort code into library vs. application. Doing the sort during the move (rather than after) is cheaper because we are already touching every import path. Promoting TUI and encoding.js during the migration adds ~10 import rewrites but saves an entire second round of import surgery later. The marginal cost of sorting now is low; the cost of sorting later is a full second pass through the import graph. The migration should be a sort, not just a move.
