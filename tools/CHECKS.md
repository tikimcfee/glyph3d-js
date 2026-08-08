# Dev checks & drive-loop tools

Repeatable verification tools. The rule: **when a debug probe proves useful, it
graduates into a saved tool here** rather than being retyped next time. They don't
need rigorous shape — just be runnable and documented. Build the set up over time.

All run under Bun (the repo runtime). The dev loop must be up for browser tools:
`tools/dev.sh` (Vite :5173 + relay :8080), `tools/dev.sh vite` to restart + clear cache
after editing core, `make dev-status` to check.

## Browser drive-loop

- **`smoke.mjs`** — boot the app in a real (WebGPU) browser, capture every console
  error + uncaught exception, optionally drive command-bus verbs and screenshot, exit
  non-zero on real errors. The "does the UI boot and run" gate; catches render-crash
  bugs (an undefined variable in a component) before they reach the browser by hand.
  ```
  bun tools/smoke.mjs                                   # headless: report boot errors
  bun tools/smoke.mjs --headed --shot /tmp/app.png      # real GPU render + screenshot
  bun tools/smoke.mjs --cmd 'repo.load owner/repo' --cmd 'file.open path.js' --shot /tmp/x.png
  ```
  Drives via `window.__glyphClient.router.execute(...)` — same command bus as the CLI.
  Use `--headed` on a GPU box when the screenshot must show real pixels; headless still
  catches all JS errors (GPU-init noise is reported but not counted as failure).

- **`loadcurve.mjs`** — survival probe for bulk loads at scale: samples JS heap / grid
  count every 500ms while a `file.openDir` runs, detects renderer crashes, measures
  post-load FPS. The companion to `profile-bulkload.mjs` (CPU time) — this answers
  "does it survive, and what's resident afterward". Point it at a relay serving the
  BUILT app (`glyph3d-cli serve --local --port 8099 <project>`) — a Vite restart
  mid-run reloads the page, and dev mode retains ~17x more heap than the build.
  A gap in the sample stream means the main thread was blocked for that span.
  ```
  bun tools/loadcurve.mjs --dir static/app/views --relay 8099
  ```

- **`glance.mjs`** — one-shot screenshot of the **LIVE** display (the window a human is
  watching), not a fresh browser. Dials the running relay over WS, optionally issues bus
  verb(s), then sends the bus-native `screenshot` verb and writes the returned PNG. This
  is how a headless agent (a plain Bash tool) closes its own pixel loop: it can SEE its
  WebGPU/dock/layout work instead of verifying by math + asking the human. One-shot by
  design (connect → command(s) → capture → exit) so the harness can't reap it mid-run.
  ```
  bun tools/glance.mjs --shot /tmp/glance.png                    # capture current scene
  bun tools/glance.mjs --cmd 'dock.list' --shot /tmp/glance.png  # issue a verb, then capture
  bun tools/glance.mjs --cmd 'camera.frame all' --wait 500 --shot /tmp/x.png
  ```
  Contrast `smoke.mjs`, which launches its OWN headless browser (an empty display) — use
  `glance` when you need to see what's actually on screen right now.

- **`capture.mjs`** — cinematic/media capture (per-frame CDP screenshots → ffmpeg loop).
- **`cdp-shot.mjs`** + **`web-preview.sh`** — attach to an already-running browser via
  CDP and grab a PNG (works headed on a busy desktop). See `PREVIEW.md`.

- **`arena-realloc-check.mjs`** — the arena-realloc render gate: kernels realloc (growth /
  trie rebuild) must not strand render bind groups on the destroyed `GlyphSlots` buffer
  (three's bind-group cache is texture-keyed; the `rebindByteSlots` seam in
  `core/glyphVertex.js` re-inits the byte materials). Lanes watched via
  `device.uncapturederror`, then `verifyItem` (exact) + a pixel non-blank assert.
  Client-only (fake in-page provider, no relay).
  ```
  bun tools/arena-realloc-check.mjs [--url http://localhost:5273/]
  ```
  (`--url` on this and `glyph-pipeline-check.mjs` points a gate at a worktree's own Vite.)

- **`storm-probe.mjs`** — N-file synthetic storm with full forensics: real device limits,
  per-second heartbeat (arena live/capacity/items, mega capacity/views, GPU error count +
  first sample, JS heap), page-crash detection, notable console tail. THE tool for
  "loads N files then wedges" — it caught the highlight-texture dimension storm at
  arena > 8MB and the corrupt half-realloc at the f32-ordinal wall (2^24 bytes), both
  invisible to the fixed-size gates. Client-only (fake provider, no relay).
  ```
  bun tools/storm-probe.mjs 1000
  ```

- **`arena-compaction-check.mjs`** — the free-list gate: a 150×120KB adopt-restage
  storm (18MB staged — past the f32-ordinal wall that killed it pre-compaction) must
  complete with the high-water mark pinned at ~2× the window, plus size-churn
  split/coalesce lanes, an exact tail-recede assert, `verifyItem` teeth over recycled
  ranges, resolveSlot coherence, and 0 GPU errors. Client-only (fake provider).
  ```
  bun tools/arena-compaction-check.mjs [--url http://localhost:5273/]
  ```

## Integration tests

As panels and startup push command-bus verbs and mutate state, that's headless-browser
integration-test territory: drive verbs, then assert on the resulting state/buffers.

- **`itest.mjs`** — runs every `tools/itests/*.itest.mjs` against the live app (one fresh
  page per test), reports pass/fail, exits non-zero on failure.
  ```
  bun tools/itest.mjs                 # headless
  bun tools/itest.mjs --headed        # real WebGPU (needed for render-dependent asserts)
  bun tools/itest.mjs coloring        # filter by name
  ```
- **`itest/driver.mjs`** — shared browser driver (also backs `smoke.mjs`): `launchBrowser`,
  `openApp` (booted, error-capturing; `.cmd` / `.evalPage` / `.shot` / `.waitFor` /
  `.booted` / `.errors`), and `makeAssert` (`ok` / `equal` / `atLeast` / `noErrors`).
- A test default-exports `async ({ app, assert, url }) => { ... }`. Assert via the command
  bus + `evalPage` (read state/buffers back). Seeds: `boot` (clean init, no errors — the
  render-crash guard) and `coloring` (tree-sitter writes distinct theme colors into
  `instanceColor`, data-level). Add one per panel/flow as the UI lands.

Note: tests that `repo.load` reach GitHub (network). A relay-served local project avoids
that — prefer it for deterministic CI once wired.

- **`layout-kernel-check.mjs`** — per-slot equivalence gate for the GPU layout kernel
  (`compute/GlyphLayoutKernel.js`) against the CPU builder. Boots the app **client-only**, runs
  the REAL `buildBatchBuffers` with the LIVE atlas (metrics via `computeCellMetrics` — no
  hardcoded character dimensions), runs the kernel on a **second, offscreen WebGPURenderer** so
  the live scene's renderer is untouched, and diffs every slot: max |Δ| per component, count
  beyond epsilon, and the first 5 mismatches with codepoint/line/col.
  Five folds, all run by default: `flat` · `column` (wrapWidth 200) · `wrap4` (wrapWidth 4, the
  spec's Fixture A shape) · `newspaper` (pagination fanning in x) · `z-pages` (pages receding in z).
  ```
  bun tools/layout-kernel-check.mjs                      # all five folds, torture text
  bun tools/layout-kernel-check.mjs --mode newspaper --ascii
  bun tools/layout-kernel-check.mjs --text-file <path> --wrap-width 40 --mode column
  bun tools/layout-kernel-check.mjs --selftest           # prove the HARNESS with no kernel
  ```
  The kernel gets `configure({ slotCount, lineTable, lineStartRow, advances, params })` —
  `lineTable` from `itemMeta[0].lineSlotOffsets`, `advances` the per-slot `sizes[2i]`,
  `lineStartRow` the exclusive scan the check computes itself (and then checks against the CPU
  build's y, so the scan formula is under test too).

  Coverage teeth run before the diff (two empty arrays compare equal): slots > 0, lines > 3,
  finite positions, >1 distinct x AND y, one slot per codepoint, a line table starting at 0 that
  never decreases, an empty line, cellWidth reproducing line 0, cellHeight being the row pitch,
  the lineStartRow scan reproducing line y; wrapping folds add "a line exceeds wrapWidth" + a real
  z-staircase, paginating folds add "pagination fired (`pageContentWidth` > 0)" + pages actually
  separating. `--selftest` swaps a CPU reference model in for the kernel module through the same
  constructor/configure/compute/readPositions surface, so the harness proves itself — that model
  matches the builder **bit-exactly (max |Δ| = 0) on all five folds**, which makes it the
  executable spec for what the GPU must reproduce, and proves those inputs are *sufficient*.

  Three things it measured that any kernel work has to respect:
  - **cellWidth is the builder's advance, NOT `metrics.charWidth`.** `getCharSize().width` is
    CEIL'd to whole pixels; the builder steps by `ax / upem × (worldScale × pixelHeight)`. On the
    current font those differ by 12.5% — the check takes the modal advance out of the builder's
    own `sizes` buffer and warns when the metric-derived number disagrees.
  - **…but the PAGE GAP multiplies `charWidth`, not that advance.** `paginationGeometry` uses
    `charAdvance = metrics.charWidth + letterSpacing` for `gapXWorld` and for the `pageWidthWorld`
    fallback. Two different cell widths in one builder; the check passes the gap unit as its own
    `pageGapUnit` param (plus world-unit `pageGapXWorld` / `pageGapYWorld` / `pageDepthWorld`).
  - **The builder ACCUMULATES x** (f32 rounding per store), so a closed-form `col × cellWidth`
    drifts ~3e-7 per column and breaks a 1e-4 epsilon past ~340 columns. A prefix sum over
    `advances` reproduces it exactly instead. The check reports the per-column rate and the
    column budget it implies.

## Log store (relay SQLite)

The relay keeps every browser log record in an in-memory SQLite store (FTS5-indexed).
**`buslog.mjs`** is the client. Store verbs answer **page-less** — only the relay needs
to be up — while `log.tail` / `log.level` are ring verbs living in the page (reach those
via `./glyph3d-cli`, or `--level-set` from buslog).

Three-command smoke (relay on :8080):
```
bun tools/buslog.mjs errors                            # recent error/warn records
bun tools/buslog.mjs search <expr> --since 5m          # FTS5 (LIKE under 3 chars)
bun tools/buslog.mjs q "SELECT level, count(*) FROM logs GROUP BY level"
```

Live follow — a push subscription (lossless, no polling), "tail -f for the app":
```
bun tools/buslog.mjs                                   # everything, rendered
bun tools/buslog.mjs --filter attention --level debug,trace
bun tools/buslog.mjs --json                            # raw records as JSONL
```

Also: `stats` (store shape), `dump [path]` (VACUUM INTO snapshot, default
`/tmp/glyph3d/logs-<ts>.db`), `search <expr> --fuzzy <query>` (client-side fzf rank).
`tools/itests/logstore.itest.mjs` locks in ingest + search/query/stats end-to-end
(skips loudly when no relay answers on :8080).

## Headless checks (no browser)

- **`verify-tree-sitter.mjs`** — load each vendored grammar, compile its highlight
  query, parse a snippet, report captures. Run after upgrading web-tree-sitter / a
  grammar, adding a language, or editing a query. Catches ABI mismatches, query-compile
  errors, and zero-capture regressions.
  ```
  bun tools/verify-tree-sitter.mjs
  ```

- **`scan-layout.test.mjs`** — the byte pipeline's ALGEBRA gate: the segmented monoid scan
  (`compute/glyphPipelineScan.js`, the GPU's dispatch structure in JS) against the serial
  oracle (`compute/glyphPipelineReference.js`). Associativity fuzz over random leaf cuts,
  chunk/group-size invariance (integer lanes bit-exact at every grouping; fold>0 x
  bit-exact — resolveX re-sums in the oracle's f32 order), the item-reset law (every
  item's first leader is row0/col0/ord0 even when chunks straddle boundaries), content
  isolation, and a randomized corpora sweep. Run after touching the monoid, the scan
  spec, or the fold semantics.
  ```
  bun tools/scan-layout.test.mjs
  ```

- **`contenttree.test.mjs`** — unit-tests the directory recursion in `ContentTree`
  (the dir-mirroring scene graph: `insert(path)` builds the dir-node chain, `remove`,
  two-pass `relayout`). Pure `three` (no WebGPU) with synthetic leaves, so it's fast and
  deterministic. Covers the directory gotchas: substring-path collisions (`b` vs `bc`),
  create-once node reuse, deep empty-intermediate chains, dirs-first ordering, removal /
  prune, and **insert-order independence** (forward vs reversed insertion → identical
  tree). Run after touching `ContentTree` or its layout.
  ```
  bun tools/contenttree.test.mjs
  ```

- **`layout-mirror.test.mjs`** — the fold-mirror parity CONTRACT: `LayoutDescription.positionAt`
  and `evaluateFold` against the real builder, per slot, across flat/wrap/scroll/newspaper/
  z-pages plus arranger displacements (EOL rides the last glyph's D; empty lines take none).
  Pure node, no GPU. The GPU kernel is bound to the same builder by `layout-kernel-check.mjs`,
  so all three evaluators of the one fold stay provably equal. Run after touching
  `LayoutDescription`, `foldEvaluate`, the builder's layout math, or the kernel's fold.
  ```
  bun tools/layout-mirror.test.mjs
  ```

- **`layout-fuzz.test.mjs`** — adversarial randomized parity over the same three evaluators:
  random texts (empty-line runs, emoji at wrap boundaries, 300-col lines), random params
  (wrap widths ON line-length boundaries, page heights AT row-count boundaries, both axes),
  random origins, scroll sequences. Deterministic PRNG — replay any failure with
  `--seed <n> --seeds 1` (which also dumps forensics: layout, geom, builder-vs-mirror-vs-bulk
  triplets, the exact relY quotient). STRUCTURAL threshold: it hunts cell/page-stride
  divergence; tight-epsilon parity is layout-mirror's job (the builder stores f32 — noise
  scales with |value| and column). Day one it caught the page-boundary ghost machine
  (applyPagination's raw gate), the absolute-vs-f32-relative nudge, and the unfired-geom
  caret shift. Run it whenever pixels show residue, stacking, or page-scale misplacement.
  ```
  bun tools/layout-fuzz.test.mjs                    # 200 seeds
  bun tools/layout-fuzz.test.mjs --seeds 300 --seed 77000
  ```

## Build / serve

- `cd app && bun run build` — production Vite build (static gate: imports, assets, syntax).
- `make build` — full self-contained binary; `make prep-tree-sitter` / `prep-wasm` —
  refresh vendored WASM after dep upgrades.
- Verify Vite serves a fresh module (the stale-transform trap):
  `curl -s http://localhost:5173/@fs/<abspath> | rg <token>`
