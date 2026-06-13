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

- **`capture.mjs`** — cinematic/media capture (per-frame CDP screenshots → ffmpeg loop).
- **`cdp-shot.mjs`** + **`web-preview.sh`** — attach to an already-running browser via
  CDP and grab a PNG (works headed on a busy desktop). See `PREVIEW.md`.

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

## Build / serve

- `cd app && bun run build` — production Vite build (static gate: imports, assets, syntax).
- `make build` — full self-contained binary; `make prep-tree-sitter` / `prep-wasm` —
  refresh vendored WASM after dep upgrades.
- Verify Vite serves a fresh module (the stale-transform trap):
  `curl -s http://localhost:5173/@fs/<abspath> | rg <token>`
