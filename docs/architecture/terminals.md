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

## Cells

What a terminal's cell draws (the renderer's side: `docs/architecture/rendering.md` "Cells").
`TerminalEmulator.readScreen` fills one reused `TerminalScreen` from xterm's buffer — per cell its
content, the colour the text draws in, the fill, the attributes word and the underline's own
colour (`cp`, `fg`, `bg`, `at`, `ul`: typed arrays, nothing allocated). A cell's content is its
codepoint, or — where xterm holds a base and its combining marks in the cell (`e` + U+0301) — the
cluster's id (`core/cellClusters.js`: interned once per distinct cluster, then one Map read on
the string xterm already holds; a plain cell pays one bit test). The attributes are
`core/cellAttrs.js`'s flags, one bit per SGR attribute: bold (1), dim (2), italic (3), blink
(5, held, not drawn), inverse (7), conceal (8), strikethrough (9), overline (53), the underline
style (4, `4:1` single, `4:2` or 21 double, `4:3` curly, `4:4` dotted, `4:5` dashed) and whether
SGR 58 named its colour (true colour or palette; 59 or none: the text's). Two are resolved in the
read: inverse swaps the drawn colours (the text takes the cell's background, or the terminal's
own panel colour where it names none — `setDefaultBackground`; the cell fills with the
foreground), and a concealed cell reads as a space (its fill and lines stay; `readText` still
has the text). Bold is the bold FACE and changes no colour — unless `boldIsBright` is on
(`setBoldIsBright`; off by default, as Ghostty's `bold-is-bright` / `bold-color` is): then a bold
cell in one of the eight standard colours (palette 0–7) draws in its bright twin (8–15). Most
cells carry no attribute at all and are read by one test.

Cell WIDTHS are termd's and the programs': xterm's own table (Unicode 6, every emoji one cell)
sits under a provider that answers two cells for East Asian Wide codepoints — every emoji with
an emoji presentation among them (`collections/terminalWidths.js`, Unicode 16). A wide glyph's
second cell reads as a space carrying the glyph's background; the glyph's quad lies over both.

`TerminalGrid` keeps those five per physical cell and writes what differs: the glyph (in the
cell's face — bold under SGR 1, italic under SGR 3, bold-italic under both; a cell sprite for
what a terminal draws itself; a cluster's precomposed or composite glyph), the colour and the
style byte into the slot (the style rides the group lane's spare bits — a changed attribute is one
slot, no extra upload), the fill into the highlight texel, an underline's colour into the
decoration texel (made when a cell first names one). The field's background pass draws while
some row has a fill (`_bgRows`), and not at all otherwise. Rows that scroll into history keep
their styles and drop their fills.

Fonts (docs/architecture/rendering.md "Fonts"): a terminal draws in ONE FONT FAMILY of the chain
(`packages/glyph3d-core/src/fonts/families.js`: Cousine, Monaspace Neon, Monaspace Argon — each
with its regular, bold, italic and bold-italic faces), then the fallbacks MesloLGS NF Mono and
DejaVu Sans; box drawing, blocks, braille, sextants/wedges and powerline separators are generated
to the family's cell, not taken from any of them. The family is the grid's `fontFamily` option
(its host's theme: the wall's `fontFamily` knob, Monaspace Neon by default; the IDE's
`terminal.fontFamily` setting, Cousine by default) and `setFontFamily(id)` changes it LIVE: the
grid takes the family's cell — its size on the canvas changes, cols × rows and the PTY do not —
rewrites every slot in the family (faces, sprites and clusters included), moves its lines to
where the family's font puts them, and fires its size-change tap so what is laid out around it
follows. Code, labels and books stay on the chain's default family.

Gates: `tools/cell-attrs.test.mjs` (the flags, the read), `tools/font-faces.test.mjs` (faces,
families, clusters, `boldIsBright`), `tools/terminal-text-path.test.mjs` (the grid's writes
against a reference — attributes, faces and a live family switch included),
`tools/wall-cells-check.mjs` (pixels: seams, runs, inverse, dim, a wide emoji on a fill, the bold
face, a letter with its combining mark, a live family switch). For the eye:
`sh tools/term-test-pattern.sh` in any terminal of 80 × 24 or more, and
`tools/font-faces-shots.mjs` for every family side by side.
