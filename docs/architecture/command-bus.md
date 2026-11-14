# Command bus

How verbs flow (`CommandRouter`, handlers, the relay) and what reports on itself.

## Verbs, terminal hosts, the log store, device loss

Every action is a verb. `CommandRouter.execute(input)` dispatches to a handler in
`app/commands/handlers/`; UI clicks and CLI/RPC hit the same handlers (one source of
truth). The `terminal.*` verbs live in core (`services/terminal/terminalCommands.js`) so every
app runs the same ones: what differs per app — where a terminal lands, what a finished spawn
shows, what focus means, what holds it, what persists its view — is the app's `TerminalHost`
(`ctx.terminalHost`; every member required, `assertTerminalHost` names a missing one at boot).
The IDE's is `app/client/terminalHost.js`, the wall's `TerminalWall._terminalHost`. A
`terminal.create` for a grid the display already shows re-adopts it: the sender becomes its owner
(registry meta, input route) and repaints it — a display that outlives a relay restart keeps
working (`tools/terminal-readopt.test.mjs`). The relay seeds its spawn ids past every live
`glyph-*` session at start and on `terminal.recover`, whose `terminal.recovered` reply lists them
all (`live`); an adapter answers `terminal.refresh` with the pane's title (OSC 2) and a repaint.
The relay forwards CLI commands to the browser display over WebSocket, and
keeps a structured in-memory SQLite store of every browser log record — `log.query` /
`log.search` / `log.errors` / `log.stats` / `log.dump` answer relay-side (page-less),
with live follow via `./glyph3d-cli log.follow` (the CLI renders log replies as records). Page-side, `emitLogRecord` runs a storm
brake: an identical error/warn signature past 5 is dropped + counted, with a
`log-brake` summary warn every 500 (locked by `tools/log-storm-brake.test.mjs`).
Device loss itself (VRAM exhaustion — a bulk load + resize churn can OOM the device)
is a queued-reload recovery:
`onDeviceLost` stops the loop, the layout engine suspends dispatches
(`tools/device-loss-recovery.test.mjs`), and the page reloads once a minute at most
(the loop guard lives in sessionStorage) so the substrate can re-seat the session.

## The load flow

The LOAD FLOW self-reports: every load runs a staged trace (`[load]` console lines →
the relay log store; `load.stats` answers with stage aggregates + the worst
main-thread blocks, which an always-on long-task watcher attributes to the load they
interrupted as `[frames]` lines). `bun tools/loadstorm-check.mjs` asserts the batching
invariants headlessly — one relayout per bulk load, coalesced registry notification.
