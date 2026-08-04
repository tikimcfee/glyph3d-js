# Plan: delete the sync load path (standalone, parallel-safe)

**Scope.** ONLY the synchronous-load-path removal. No bounds work, no branch landing, no
scroll fast path — the other agent is investigating those in parallel. This change enforces
existing project law (CLAUDE.md: "One render path — no sync/async split") against a fossil.

**Base:** `main` (the bounds branch is unlanded; it leaves the sync path structurally
unchanged, so this work applies to either side — expect a small rebase around
`CodeGrid._layoutContent`/`_buildLayoutDescription` if the branch lands first).

**Why it's safe to delete (verified):**
- The async path is already the real one: edits were force-routed through `loadTextAsync`
  because the sync path overflows the renderer's initial `maxInstances` cap on content growth
  (comment at CodeGrid.js:2203-2210) — the sync path is documented-broken for the real use case.
- The highlight-ordering dependency ("highlights applied immediately after load") is satisfied
  in the async path by awaiting — proven in production by AgentBooks (`loadFileAsync(...).then`
  → `_decorateSnapshot`, AgentBooks.js:747-748,804).
- No test, itest, or script calls sync `loadText`; the only CodeGrid mock in tools/ doesn't
  load at all.

## Steps

1. **Migrate the nine caller sites** (inventory verified complete by two independent sweeps):
   - `packages/glyph3d-core/src/services/visual/NameplateManager.js:179` — fire-and-forget
     `loadTextAsync` (nothing after the call reads the grid; wrapper positioning uses the
     directory node's position). Update the "synchronous is fine" comment at :178.
   - `packages/glyph3d-core/src/services/tour/TourAnnotator.js:123` — fire-and-forget (label
     position comes from the TARGET grid's bounds).
   - `app/commands/handlers/gridCommands.js:211` (`grid.create`) and `:304` (`grid.text`) —
     make handlers `async`, `await grid.loadTextAsync(...)`; the OK message reads
     `grid.getGlyphCount()` (:223-224, :306-307), which is only non-zero after the flush
     commits. Router already supports async handlers (memoryCommands.js:35 precedent).
   - `app/commands/handlers/memoryCommands.js:53` (mem.view hexdump) and `:73` (legend) —
     handlers already async; `await` the loads before `decorateMemoryGrid` (:62 — uses
     `highlightRange` + `_layout.positionAt`) and the legend `highlightRange` loop + placement
     `getBounds()` (:74-82). Delete the now-stale "no frame defer / saves ~16ms" comment
     at :58-61.
   - `app/commands/handlers/annotationCommands.js:61` (label.create) and `:353` (annot.create),
     `app/commands/handlers/navigationCommands.js:77` (tour annotation) — fire-and-forget
     (only caller-supplied `position.set` + scene.add + registry follow).
   - `packages/glyph3d-r3f/src/CodeGrid.jsx:83` — switch to the async load, `void` the promise
     (fire-and-forget inside useEffect, as today).
   - `app/commands/handlers/fileLoader.js:114-122` — the one deliberate MEASURED sync decision
     (comment :117-119: warm main-thread build 4-5ms vs 23-40ms worker round-trip; the bulk
     path slices these under a frame budget). Convert `registerFileGrid` to async
     (`await grid.loadFileAsync(path, body)` before `seatFileGrid`) with a post-settle
     content-tree relayout — AgentBooks `_settle` → `_requestRelayout` (AgentBooks.js:676-714)
     is the working template; ContentTree.insert doesn't measure, so grids insert unlaid and
     ONE relayout runs after the batch settles. **Then re-measure bulk open. If it genuinely
     regresses, STOP and report — do not invent a workaround.**
2. **Atomic renames (no aliases, per project law):**
   - `loadTextAsync` → `loadText`, `loadFileAsync` → `loadFile` (public API; the sync versions
     are deleted, the async ones take the canonical names). Update every caller repo-wide,
     incl. `AgentBooks.js:747`.
   - Private: `_layoutContentAsync` → `_layoutContent`, `_flushAsync` → `_flush`.
   - Update all docstrings ("synchronous render path", "using Web Workers (async)").
3. **Delete the sync bodies** (CodeGrid.js:409-425 `loadText`/`loadFile`, :1352-1381 `_flush`,
   :1503-1540 `_layoutContent`), keeping exactly ONE main-thread capability in the surviving
   `_flush`:
   - The worker-**error** catch (old :1408-1413) builds via
     `getWorkerBridge().buildBatchBuffersSync(...)` and commits, instead of requeueing into the
     deleted sync flush.
   - The `!isWorkersSupported()` early-out (old :1392-1393) is deleted as redundant —
     `buildBatchBuffers` already falls back to `buildBatchBuffersSync` internally when the pool
     is empty (WorkerBridge.js:173-175). `isWorkersSupported` itself stays (WorkerBridge:62
     uses it).
   - `buildBatchBuffersSync` STAYS on WorkerBridge (the fallback above + direct use by
     tools/layout-kernel-check.mjs:182,586,667). This plan deletes NO builder machinery and
     does not touch `emitPositions`.
4. **`setFilenameLabel` / `showFilename`** (CodeGrid.js:583, 597) — route through the async
   relayout (fire-and-forget; zero external callers repo-wide, verified).
5. **Comment sweep within touched files:** CodeGrid.js:1345-1351 (the old `_flush` docstring),
   :1370-1371, :1383-1388, :2203-2210 (the "routes through loadTextAsync because sync is
   broken" comment — now simply "routes through the worker pipeline"), NameplateManager.js:178,
   fileLoader.js:117-119 (replace with the async rationale after re-measurement).

## Verification (the "make sure it's clean" gate)

1. `bun tools/layout-mirror.test.mjs`, `bun tools/layout-fuzz.test.mjs`,
   `bun tools/device-loss-recovery.test.mjs` — green (they don't use the sync path; confirms
   no collateral damage).
2. `bun tools/layout-kernel-check.mjs` — green (uses `buildBatchBuffersSync` directly, which
   stays).
3. Repo-wide grep: zero remaining references to `loadTextAsync`/`loadFileAsync`/
   `_layoutContentAsync`/`_flushAsync`; `loadText(`/`loadFile(` callers all migrated.
4. App smoke (via the running app / CLI bus): `mem.view` (highlights land on the hexdump),
   `grid.create` + `grid.text` (OK-message counts honest), `file.open` on a fat file, bulk
   directory open (settle + relayout correct, timing measured vs the 4-5ms baseline), tour
   labels, nameplates, `file.save` flow (disk-mtime token path in seatFileGrid unaffected).
5. Report back with the bulk-open measurements before this lands.

## Explicitly NOT in this change

- Bounds/foldGeometry/branch landing, GPU anything.
- The scroll/param-only fast path, `_scheduleAnalyze` gating.
- `emitPositions`, builder internals, `isGpuLayoutEnabled`, `buildBatchBuffersSync` deletion.
- Memory-file updates (deferred until the parallel work settles).
