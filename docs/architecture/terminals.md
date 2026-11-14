# Terminals

Terminals end to end: `g3d-termd`, the relay adapters, `TerminalGrid`. The daemon in depth: `docs/termd/DESIGN.md`; the wire: `docs/termd/PROTOCOL.md`.

## Terminals

**Terminals** live in **`g3d-termd`** (`crates/g3d-termd`, `docs/termd/DESIGN.md`): it owns each
terminal's PTY, program and a libghostty-vt emulator (the canonical screen and scrollback, a
bounded 10 MB by default) on one owner thread per terminal, and outlives the relay. One daemon
per namespace (`serve --termd-ns <ns>`, default `default`; socket
`$XDG_RUNTIME_DIR/g3d/termd-<ns>.sock`, or under `$G3D_TERMD_DIR`), so a second relay in its own
namespace can't adopt or kill the first's; the relay starts it on demand (`g3d-termd --daemon`,
found beside `glyph3d-cli`, on PATH, or `serve --termd`) and never kills it. Its socket speaks a
public, versioned protocol (`docs/termd/PROTOCOL.md`; `g3d-wire`) any client can use: the relay's
forked adapters (`glyph3d-cli attach <id>`) subscribe raw as the size's owner (the display owns
the size) and turn termd's OUTPUT/REPAINT/size events into the same 0x01 frames, each byte
stamped with the size it was written at; `./g3d attach <id> [--take]` / `./g3d watch <id>` attach
from a real terminal (Ghostty), Ctrl-\ twice to detach. termd answers the program's terminal
queries once; clients never forward their own replies (`g3d` filters them out of what it prints).
Scrollback is termd's per-subscriber `view` (`terminal.scroll`); the wheel goes to an
alternate-screen app. A relay restart leaves terminals running: `terminal.recover` re-adopts
every one with no owner and the adoption repaint redraws it; an adapter that dies under a live
relay (a signal, a crash) is replaced by the relay on its own. termd is a holder (`g3d-hold`: the
shells' parent, their PTY fds, the snapshot store) and a brain it restarts: a brain crash keeps
every shell (screens come back from 2 s snapshots, the unseen bytes are logged) and each adapter
rides it (reconnect, re-subscribe, repaint; `serve --termd-reconnect`); `./g3d upgrade` replaces
the brain losing no byte. The holder's death kills every shell in the namespace (adapters log
`LOST termd` and close their grids). termd publishes ONE status document (protocol 1.1:
`status`, `status_follow` — the daemon, holder and brain, every terminal and its subscribers,
recent errors; pushed on change, no sooner than the follower's interval, a 30 s keepalive):
`./g3d status [--json] [--follow]` renders it in a terminal; the relay follows it on one
connection of its own (`cli/termdstatus.go`: ok · absent · restarting · unreachable · failed ·
lost, from its side of the socket) and pushes `termd/status` to the display on its own plane
(one slot, latest wins), answers the display's `termd/status` request and the CLI's page-less
`./glyph3d-cli termd.status`, and re-adopts orphaned terminals when a brain answers again after
being unreachable or failed; the core model `services/terminal/TermdStatus.js` holds it for any
app. A status-only connection never keeps an idle daemon up. `terminal.spawn [cols] [rows]
[-- cmd…]` starts any program; with none, termd starts the account's shell (passwd) as a login
shell in the served root (else home). A terminal's environment is termd's, built per create
(DESIGN.md "Environment"): the systemd user manager's (else the daemon's own;
`--env-source daemon`, or `G3D_TERMD_ENV_SOURCE=daemon` as tests and tools set it), minus other
terminals'/multiplexers'/editors' identity and the parent shell's state, plus `TERM_PROGRAM=g3d-termd`.
Gates: `cargo test --workspace --features g3d-termd/test-hooks` (the test hooks exist only in that
build; `tests/status.rs` holds the document's shape and throttling), `cd cli && go test ./...`,
`tools/termd-relay-check.mjs`,
`tools/termd-fidelity-check.mjs`, `tools/wall-e2e.mjs`. Terminals render as `TerminalGrid`s and
re-adopt across reloads. See the `saved-state` and `terminal-control-subsystem` memories. The text path is
pulled by the frame: a parse only queues its grid on the scene's `TerminalScreenQueue`, and
`SceneSystems.update` (before the render) reads each queued screen once into a reused typed
`TerminalScreen` and applies it — so output is drawn by the next frame, never a frame later. A
grid's cells are a ring of `rows + depthMax` physical rows, each posed by its own group-table
row: a detected scroll moves the ring's head (scrolled-off rows become history without a
rewrite), and only the cells that differ from the slots are written and uploaded
(`InstancedField.markSlotsDirty` / `markHighlightDirty`: pooled ranges). No allocation per
update. Gate: `tools/terminal-text-path.test.mjs`.
