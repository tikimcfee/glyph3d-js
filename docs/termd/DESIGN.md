# g3d-termd: design

`g3d-termd` replaces the private tmux server (`tmux -L glyphd`) that holds glyph3d's
terminals. It owns every terminal's PTY and process plus one libghostty-vt `Terminal`
per terminal, so it holds the canonical screen and exact scrollback. It outlives relay
restarts and page reloads. Clients reach it over the public socket protocol in
[PROTOCOL.md](./PROTOCOL.md): the relay's adapters today, `g3d attach` from any real
terminal, and later gomuxai.

This page is what stage S1 builds against: the daemon, the `g3d` client and the Go
adapter's move off `tmux attach`. S2 (the relay in Rust) and S3 (packed cells to the
browser) build on it and are only sketched here.

## Measured ground (2026-11-12)

Each line was checked on the build machine against libghostty-vt 1.0.1 (Ghostty tag
`vt-1.0.1`, commit `108cacb1`) through libghostty-rs at rev `cd4d497e` (its "vt-sys:
update to vt-1.0.1" commit), built with Zig 0.17.0 and Rust 1.98.1.

| Question | Answer | Evidence |
|---|---|---|
| Does it build here, offline? | Yes. The release source tarball plus the `-deps` tarball, passed as `GHOSTTY_SOURCE_DIR` / `GHOSTTY_ZIG_SYSTEM_DIR`, build with no network fetch. About 90 s cold. | Probe crate built and ran. Zig 0.17.0 (ziglang.org SHA-256 and minisign verified); both libghostty tarballs and `SHA256SUMS` minisign-verified against the key in `PACKAGING-LIBGHOSTTY.md`. |
| Is a `Terminal` thread-safe? | No, and the bindings enforce it. Upstream: "calls on one handle are never thread-safe. But calls across multiple handles are." `Terminal` and `RenderState` are `!Send + !Sync`. | `dist/doxygen/pages/conventions.md` "Threads"; a `fn need_send::<Terminal>()` probe fails to compile (raw `NonNull<TerminalImpl>` and `*mut VTable`). |
| Can the formatter emit a VT repaint? | Yes. VT format with every extra except the palette, restricted by a selection to the active area, replayed into a fresh terminal gives an identical active area, cursor and modes (bracketed paste survived). It includes `CSI ? 1049 h` and the alternate screen's contents when a TUI is up. | Probe: 100k scrolled lines, active-area repaint 1,368 B built in 8 µs, replay equal. Without a selection it emits all scrollback too (145 KB in 0.7 ms for 2,567 rows). |
| What doesn't the repaint carry? | The title (termd appends OSC 2 itself); the primary screen while the alternate is shown (the viewer has a blank primary after `?1049l`); unfinished input. | Probe: replayed title empty; after `?1049l` the viewer's row 0 is empty, termd's is `PRIMARY TEXT`. |
| Is a repaint safe mid-escape-sequence? | Yes, with the continuation API: enable `set_continuation_max_bytes`, append `continuation_write` output to the repaint. | Probe: a cut after `ESC [ 3` replays equal with the continuation and prints `1mRED` without it. |
| Palette noise | `Extras::ALL` emits all 256 palette entries (5,522 B) even when unchanged, and would override a viewer's own theme. Emit only entries that differ from the default (zmx does the same). | Probe. |
| What does `snapshot.h` carry? | Everything: both screens with pages, cursor and saved cursor, charsets, Kitty keyboard stack, all three mode sets (current, saved, default), palette and overrides, title, pwd, scrolling region, tab stops, Kitty images, and the parser's unfinished input. Ordered so the screen is usable before history arrives. The byte format is outside the ABI promise ("format version 1 is a work in progress"). | `dist/doxygen/pages/guides/snapshots.md`, `src/terminal/snapshot/terminal.zig`; probe: a 3,961 B snapshot restored alt screen, cursor, title and bracketed paste. |
| Does the static lib need a C++ runtime? | No. simdutf's and Highway's C++ symbols resolve inside `libghostty-vt.a`, which defines its own `__cxa_pure_virtual` stub. The probe binary links only `libc` and `libgcc_s` (Rust's unwinder). | `nm -u` on the 22 MB archive, `ldd` on the probe. |
| Default scrollback | 10,000 bytes, rounded up to one page (about 400 KB). The 10 MB the spike saw was ghostty-web's wasm build. termd sets it explicitly anyway. | `scrollback_max_bytes()` on a new terminal = `Some(10000)`; the Rust doc says the same. |
| Are DA/DSR answered? | Yes, through `on_pty_write`: DA1 `ESC[?62;22c`, CPR `ESC[2;6R`, DA2, XTVERSION (`libghostty`), DECRQM. OSC 10/11 are answered **only** once default colours are set, and `CSI 18 t` only with an `on_size` handler. | Probe. |
| Dirty rows | `RenderState::update` + `next_dirty`: a fresh terminal reports Full/24 rows, a 2-line write Partial/2, one character Partial/1, a resize Full/30. | Probe (for S3's packer). |
| rusqlite bundled FTS5 (S2) | Yes. rusqlite 0.37 (SQLite 3.50.2): an FTS5 table answers `MATCH`, `PRAGMA compile_options` lists `ENABLE_FTS5`. | Probe, native and cross-built. |
| cargo-zigbuild with Zig 0.17 | Works. cargo-zigbuild 0.24.1 + Zig 0.17.0 builds `aarch64-unknown-linux-musl` through its zig-cc wrapper, including rusqlite's C; both run under qemu-aarch64. `aarch64-unknown-linux-gnu` was not tried (its rustup target isn't installed here), nor libghostty itself for arm64. | Probe. |
| Parse speed, native | 100,000 coloured lines (about 5 MB) through `vt_write` in 10.6 ms. The ghostty wasm build measured 69–80 MB/s in the spike. | Probe (single run). |

## Prior art taken, and not

- **phux** (Rust, libghostty-rs, the closest relative). Taken:
  - the `!Send` terminal owned by one task;
  - a bootstrap profile that is "synthesized VT, then raw PTY bytes", cut at an inclusive `base_seq` (our `seq`);
  - the server answering each terminal query once while clients suppress replica replies;
  - versioning where only a major refuses, minors add fields that old peers skip and features are announced;
  - fence-and-recut instead of an unbounded backlog for a lagging consumer.

  Its hot upgrade (re-exec, re-adopt live PTYs, a frozen upgrade blob) is our later path (below). Not taken:
  - structured key input encoded server-side (our input is the bytes a keyboard sends; that is what a tty attach client has, and what the browser's `keyEncoding` already produces);
  - its "smallest view wins" size rule;
  - a single current-thread runtime for every terminal (a flood in one would stall the rest; the spike's load is 14 terminals flooding at once).
- **zmx** (Zig, one daemon per session, libghostty). Taken:
  - leave synchronized output (2026) out of a repaint;
  - restore colour overrides, not the whole palette;
  - print scrollback before clearing and repainting the screen, so it lands in the viewer's own scrollback (`history_rows`);
  - a capture verb with a row count;
  - a fixed header carrying a protocol version.

  Lesson taken the other way: zmx's `Info` record is a frozen C struct that "breaks `zmx list` against running daemons" if it grows. Our control payloads are JSON objects that grow by adding fields. zmx's leader is "the last client to type" and it filters terminal replies out of non-leader input heuristically. Ours is explicit (`own` / `take`), and query answering is termd's alone.
- **gomuxai's Mechanism B** (own the PTY, fan out). Taken: the daemon sees every byte before the PTY, so input provenance (which connection, which role) and any future arbitration live in one place. Its warning stands: we reimplement the boring part of tmux (resize, signals, the alternate screen), so S1's gates aim at those.
- **tmux**. The adapter's long fight with it (copy-mode traps, `refresh-client` hitting the wrong client, lines dropped under load, `?1049h` pinned for the whole session) is why termd exists. One behaviour is kept on purpose: scrolling back is per viewer and freezes that viewer's output, as copy-mode did. That is `view`.

## Process model

### One daemon per namespace

A namespace is a name (`default`, a test's random name). Its socket is
`$XDG_RUNTIME_DIR/g3d/termd-<ns>.sock`. Off Linux, or when that variable is unset, it is
a `g3d-<uid>` directory under the system temp directory, created `0700`.
`g3d-termd --ns <name>` or `--socket <path>` picks it.

The namespace replaces `--tmux-socket`. `glyph3d-cli serve --termd-ns <name>` points a
relay, and every adapter it forks, at that namespace, so a second relay can neither see
nor kill the first's terminals. Tests always pass `--socket` with a path in their own
scratch directory, never a namespace someone might use.

Single instance: the daemon holds an exclusive `flock` on `<socket>.lock` for its whole
life. Only the lock holder may unlink a stale socket file and bind. A second daemon on
the same namespace fails at the lock and exits non-zero, naming the holder's pid.

### Who starts it

The relay. On its first terminal operation (spawn, recover, list), the relay connects to
the namespace's socket. If that fails, it starts `g3d-termd --ns <ns> --daemon`, then
retries the connection with backoff for up to 3 s, and fails loud with the daemon log's
tail if the daemon still isn't up.

`--daemon` detaches properly:

1. fork; the parent waits only for the child's exit status;
2. `setsid` (a new session, no controlling terminal);
3. fork again and exit the middle process, so the daemon can never reacquire a terminal
   and is reparented to init (or the subreaper);
4. `chdir("/")`, `umask(077)`, stdin from `/dev/null`, stdout and stderr to the log
   (`$XDG_STATE_HOME/g3d/termd-<ns>.log`, else `~/.local/state/...`), close other fds.

The relay must **never** set `PR_SET_PDEATHSIG` on it and never registers it in
`children.go`'s kill-on-exit set: outliving the relay is the point. The relay doesn't
`Wait` on it either (the double fork means there is nothing to wait for). An operator
can also start it by hand, or `g3d attach` can start it the same way.

The relay finds the binary next to its own executable, then on `PATH`, or at
`serve --termd <path>`. If none is found it fails loud with all three places it looked.
There is no tmux fallback.

### Lifetime, crash, upgrade

- **Idle exit.** With no terminals and no connections for `--idle-exit` (default 5 min;
  0 = never), the daemon removes its socket and exits, as tmux does with no sessions.
  The next relay operation starts a fresh one.
- **A child exits.** termd reaps it (`waitpid` once the PTY reads EOF, so no output is
  lost), sends `exit` + `closed`, and forgets the terminal. The relay's adapter sees
  `closed` and tears down the grid, as it does today on PTY EOF.
- **termd crashes.** Every PTY master closes, so every terminal's session gets `SIGHUP`
  from the kernel: all shells in the namespace die, as with `tmux kill-server`. This is
  D3's accepted cost. Relay-side, every adapter's socket drops, every adapter exits, and
  the grids close. The next spawn starts a new daemon. `terminal.recover` lists termd's
  (empty) live set, and displays prune their spots against it. A Rust panic in one
  terminal's owner thread doesn't crash the daemon: the thread's `catch_unwind` closes
  that terminal (its shell gets `SIGHUP`), logs the panic, and every other terminal
  carries on. Undefined behaviour or an abort inside libghostty does crash the daemon.
- **Upgrade, v1.** Replacing termd means `stop` (every shell dies) and starting the new
  binary. `WELCOME` carries the daemon version, and the relay logs a mismatch between
  its bundled termd and the running one. It refuses a different protocol major loud
  rather than talking past it, and never replaces a running daemon on its own.
- **Upgrade, later: keep the shells.** Hot upgrade as phux does it:
  1. the old daemon writes a handoff record (per terminal: id, handle, pid, argv, size,
     seq, the PTY master's fd number);
  2. it clears `FD_CLOEXEC` on the PTY masters and the listening socket;
  3. it `exec`s the new binary, which re-adopts the fds.

  The process tree, PTYs and child pids survive, because `exec` keeps them. Screen state
  crosses as a libghostty snapshot when both binaries share a libghostty version.
  Snapshots aren't stable across versions, so when the version changes it crosses as
  the formatter's VT repaint with `history_rows` (exact screen, styled-text history).
  The handoff record is a format; every shape a release wrote stays decodable. This is
  outside S1.

### Spawning a terminal

For each `create`, the daemon:

- opens a PTY with `posix_openpt`, `grantpt`, `unlockpt` (rustix `pty`) and sets the size
  (`TIOCSWINSZ`) before the child starts;
- forks the child from the terminal's owner thread. In the child, before `exec`, only
  async-signal-safe calls: `setsid`, `TIOCSCTTY` on the PTY slave, `dup2` it onto
  0/1/2, close everything else, reset the signal mask and dispositions, `chdir`, then
  `execvpe` with the environment PROTOCOL.md specifies. The child gets no pdeathsig;
  its lifetime is its PTY's;
- on `kill`, signals the process group (`kill(-pgid, SIGHUP)`), closes the master, and
  reaps.

## Threading

`Terminal` is `!Send`, so it is created and used on exactly one thread. That thread is
the terminal's **owner thread**, and it does everything that touches the terminal:

```
                    ┌──────────── owner thread (one per terminal) ────────────┐
 PTY master ──read──▶ vt_write ─▶ effects: WRITE_PTY ─▶ PTY (DA/DSR answers)  │
                    │    │                 title/bell/pwd ─▶ events           │
                    │    └─▶ fan-out: Arc<[u8]> chunk + seq ─▶ each sub queue  │
 command queue ─────▶ create/kill/resize/subscribe/repaint/view/capture/input │
 (+ wake fd)        └──────────────────────────────────────────────────────────┘
                              ▲ commands                 │ per-subscription queues
                    ┌─────────┴─────── socket side (tokio) ▼─────────────────────┐
                    │ accept · per connection: frame reader, frame writer        │
                    └────────────────────────────────────────────────────────────┘
```

- The owner thread `poll`s two fds: the PTY master and a wake `eventfd` (a pipe off
  Linux). The socket side posts a command on a channel, then writes the wake fd.
- On readable PTY: read up to 64 KiB, `vt_write` it, hand the chunk (shared, not
  copied) with its `seq` to every raw subscriber's queue, then compare the few modes
  `modes` reports and emit an event if any changed. `vt_write` runs the effect
  callbacks synchronously on this thread. `on_pty_write` appends query answers to the
  thread's PTY write buffer, which goes to the PTY after the read is handled (callbacks
  can't re-enter the terminal).
- Input from clients goes through the same command queue, so all PTY writes come from
  one thread and keep their order. Writes are non-blocking with a buffer. A program that
  stops reading its input fills a capped buffer (1 MiB), and further input is refused
  with an `error` event (zmx drops silently; we say so).
- Ordered operations (resize, repaint, view) run between reads, so each lands at an
  exact `seq`. That ordering makes the resize event exact and retires the adapter's
  drain-and-restamp dance.
- The socket side is a tokio runtime holding no terminal state: it parses frames, routes
  commands by handle, and drains each subscription's queue into its connection's writer.
  A `Terminal` never crosses into it.
- Blocking flow (`own` with `flow: "block"`): the owner thread stops polling the PTY for
  reads while the owner's queue is over its high mark, and the socket side wakes it when
  the queue drains below the low mark.
- The Pdeathsig trap in the plan (tokio's blocking pool retires the forking thread)
  doesn't arise: children are forked from owner threads, which live as long as their
  terminal, and pdeathsig isn't used.

## Bounded memory

| What | Bound |
|---|---|
| Primary-screen scrollback | `scrollback_bytes`, default 2 MiB, clamped to `--max-scrollback` (default 16 MiB). Always set explicitly, never the library default. |
| Alternate screen | One screen, no scrollback (about one 400 KB page). |
| Idle history | After 30 s with no output, `compress(Incremental)` in steps until complete, restarted when `compression_activity` changes. Resident memory drops; contents don't change. |
| Unfinished input | `set_continuation_max_bytes(64 KiB)`. Needed for mid-sequence repaints. |
| Kitty images | `kitty_image_storage_limit` 0 in S1 (termd draws no images, and the browser can't either yet). |
| Per subscription | Lossy queue 4 MiB, then drop + `lagged` + repaint. Blocking owner: pause PTY reads at 1 MiB, resume at 256 KiB. |
| PTY input buffer | 1 MiB per terminal. |
| Frames | 16 MiB payload. |

At the defaults, a busy terminal costs about 2–3 MiB of emulator memory (the probe's
terminal with a 2 MiB cap and 100k scrolled lines held about 1.9 MB resident on the
primary screen, plus one alternate page), so 50 terminals stay well under 200 MiB. S1's
flood gate checks daemon RSS with a ceiling, so a regression of the spike's 44 GB kind
fails a test, not the machine.

## Engine configuration (per terminal)

- `set_default_fg_color` / `bg` / `cursor` from `create.colors`, else daemon defaults
  matching the browser's terminal palette (`terminalPalette.js`). Without them,
  OSC 10/11 queries go unanswered, and programs that ask for the background colour to
  choose a light or dark theme (vim, Claude Code) wait for a timeout.
- `on_size` answers XTWINOPS from the size and `cell_px`. `on_xtversion` answers
  `g3d-termd <version>`. `set_terminfo_name("xterm-256color")` matches the `TERM` the
  child sees.
- `TERM=xterm-256color` while the browser parses raw bytes with xterm.js. Advertising
  `xterm-ghostty` would invite sequences (Kitty graphics, Kitty keyboard) the browser
  doesn't parse. Revisit at S3, when the browser draws termd's cells instead of parsing.
- `set_title_report_enabled(false)` (title reports are a known injection vector).
  Clipboard writes (OSC 52) are refused in S1: no handler is installed.

## The Go adapter moves to termd (S1)

`glyph3d-cli attach` stays a forked adapter (S2 dissolves it into the relay). It stops
driving `tmux attach` through a PTY and becomes a termd client on the socket. The
browser and the relay protocol are untouched: the same `terminal.create` /
`terminal.bytes` / `terminal.resize` / `terminal.scroll` / `terminal.refresh` /
`terminal.shutdown` verbs, and the same `0x01` OUTPUT frames, byte for byte in format.

| Today (`cli/attach_unix.go`) | With termd |
|---|---|
| `ensureTmuxSession`: `new-session`, then neutralize status, prefix and keytables | `create {id, argv, cols, rows, if_exists: "adopt"}`. Nothing to neutralize. |
| `startTmuxAttach`: a PTY running `tmux attach`, `TERM=xterm-256color` | `subscribe {mode: "raw", role: "own", cols, rows}`: the adapter owns the size, because the display does (D11) |
| PTY reader → 16 ms coalescer → `0x01` frames | `OUTPUT` payloads (bytes after `seq`) → the same coalescer → the same `0x01` frames |
| Size stamped on frames, `resizeCh` drain on resize | Each frame is stamped with the size from the last `size` event. termd places that event at the exact byte, so the old-size/new-size boundary is exact with no drain |
| `terminal.bytes` → PTY write; `exitScroll` first | `INPUT`; termd snaps a scrolled view to live itself |
| `terminal.resize` → `pty.Setsize` | `resize` |
| `terminal.refresh` → OSC 2 from `#{pane_title}` + `refresh-client -t <our client>` | `repaint` (the title is part of every repaint). The adapter writes the `REPAINT` bytes into the `0x01` stream at the repaint's size |
| `terminal.scroll` → copy-mode `scroll-up`/`scroll-down`, cancel at bottom | `view {delta}`; the browser gets the viewed rows as repaint bytes, as copy-mode's redraw did. Alt screen: unchanged `forwardWheelToApp`, deciding from the last `modes` event instead of `display-message` |
| `terminal.shutdown` → `kill-session` | `kill` |
| PTY EOF → teardown | `closed` event → teardown. `terminal.close` to the display is unchanged. A dropped termd socket → teardown without kill (detach), as today |
| liveness `terminal.ping`, re-adopt by `terminal.create` | unchanged. A re-adopting adapter re-`subscribe`s, and its `REPAINT` fills the fresh grid |

What the browser sees differently: **pane-raw bytes** instead of tmux's redraw stream.
No permanent `?1049h`, no dropped lines, a TUI's own alternate screen arriving as its
own. The depth-history capture (gated on `!this._altActive`) starts working, and query
answers come from termd, as they came from tmux. That is a visible change, for the
operator to judge on the live display. `seed-history` becomes the adoption repaint's
`history_rows` (the adapter can ask for the grid's depth worth of rows); its tmux
`capture-pane` path is deleted.

Relay changes in the same commit (no dual path, no flag):

- `liveTerminalIDs` → `list` (termd's ids); `seedTermSeq` is unchanged.
- `recoverTerminals`' "already adopted?" check (`list-clients`) → `subscribers.own > 0`
  in `list`. Recovered adapters take the size from `list`.
- `spawnTerminalAdapter` forks the same `attach <id>` with `--termd-ns`.
  `terminal.spawn` gains an optional argv (`-- cmd...`), so an agent or any program can
  be started in a new terminal.
- `gomuxScreenLive` and gomux's `has-session` check on glyphd → `list`.
- `--tmux-socket` (serve, attach, seed-history) → `--termd-ns`. `tmuxCmd`,
  `paneScrollPosition`, `paneScreenMode`, `ensureTmuxSession`, `startTmuxAttach`, the
  copy-mode logic and its tests are deleted. CLAUDE.md's terminal paragraph is rewritten
  to match.

## Cutover: the terminals already running in tmux

Terminals live in `tmux -L glyphd` sessions (`glyph-<id>`), some with work in them. A
running process can't be moved to another PTY, so nothing migrates them, and the S1
relay no longer reads that socket at all.

- They keep running, headless, in tmux. From any terminal,
  `tmux -L glyphd attach -t glyph-term-3` reaches one to finish its work. Nothing kills
  them.
- To keep one on the wall in the meantime, run tmux's own client **inside** a termd
  terminal: `glyph3d-cli terminal.spawn -- tmux -L glyphd attach -t glyph-term-3`. It is
  an ordinary program in an ordinary termd terminal, not a compatibility path. It
  carries tmux's redraw stream, quirks included, until the work ends.
- The wall's names and spots are keyed by terminal id and pruned against the relay's
  live list, so old ids drop off the wall at the first S1 connect. The operator should
  know this before cutting over.

## The gomux screens (`gx-<name>`)

A gx screen is a glyph terminal running `gomuxScreenScript`:

1. `capture-pane` on gomuxai's own tmux server, each row positioned;
2. the cursor placed where the agent's pane has it;
3. `exec tail -F` of the agent's pipe-pane log.

It never attaches a tmux client to gomuxai's server. Under termd it is the same argv in a
termd terminal (`create {id: "gx-<name>", argv: ["sh", "-c", script, ...]}`). The script
talks to gomuxai's default tmux server exactly as before (`env -u TMUX` is now a no-op,
since termd removes `TMUX`), and its output reaches the browser through the same adapter
path. `gomux.resize` keeps resizing the agent's own tmux window; the gx terminal's size
is still the display's. Nothing about gomuxai changes until it grows a termd backend
(S7). Then the screens become ordinary `subscribe {role: "watch"}` streams of the
agent's own terminal, and could even take input.

## `g3d`: attach from any terminal

`g3d attach <id> [--take] [--ns <ns>]` and `g3d watch <id>`:

- put the local tty in raw mode, `subscribe {mode: "raw", role: attach | own | watch}`,
  write the repaint, then the bytes; send stdin as `INPUT` (not for `watch`);
- remove query sequences from output before writing to the tty (PROTOCOL.md, "Terminal
  queries"). The filter lives in `g3d-wire` so every Rust client gets the same one:
  DA1/2/3, DSR/CPR, DECRQM, XTVERSION, the Kitty keyboard query, OSC 4/10/11/12 `?`
  queries, DECRQSS and XTGETTCAP;
- detach on `Ctrl-\ Ctrl-\` (configurable): restore the tty, leave the alternate screen,
  soft-reset, clear;
- by default (`attach`), the display keeps the size. If the local tty is smaller than the
  terminal, `g3d` says so on stderr before attaching and suggests `--take`. Raw bytes
  can't be clipped, so a smaller window shows broken wrapping. `--take` makes this tty
  the owner: its `SIGWINCH` resizes the terminal for everyone, and the display follows
  the `size` events. A later version can draw a clipped or letterboxed view by running
  its own libghostty terminal and rendering it.
- `g3d ls`, `g3d new <id> -- cmd...`, `g3d kill <id>`, `g3d stop` are thin wrappers over
  the ops.

Run inside a tmux pane, `g3d attach` gives tmux users tmux back with no tmux server of
ours.

## Build and vendoring (D7, D8)

- `libghostty-vt` comes from libghostty-rs by git rev (`cd4d497e`, which pins Ghostty
  `vt-1.0.1`) until a 1.0-based crates.io release exists.
- The Ghostty source and its dependencies come from the **release tarballs**
  (`libghostty-vt-1.0.1.tar.gz` and `-deps.tar.gz` from release.files.ghostty.org),
  never a git fetch at build time. A `tools/termd-vendor.sh` (S1) downloads them,
  verifies each against `SHA256SUMS` and its minisign signature (Ghostty's published
  key), and unpacks them into a gitignored `vendor/` directory. `.cargo/config.toml`
  points `GHOSTTY_SOURCE_DIR` and `GHOSTTY_ZIG_SYSTEM_DIR` there with
  `relative = true`, so no tracked file holds an absolute path.
- Zig 0.17.x is required (libghostty's `minimum_zig_version` is 0.17.0; any 0.17 patch
  works, 0.16 and 0.18 don't). The same script fetches and verifies it
  (ziglang.org minisign key), or uses `ZIG` if set.
- Linux amd64/arm64: cargo-zigbuild with that Zig. Proven here for musl arm64 with a C
  dependency. S1 must still prove libghostty itself for arm64, with the hedge of
  building `libghostty-vt.a` with `zig build -Dtarget=…` and pointing the crate at it.
- macOS: built on the Mac. termd is unix-only. The Windows relay has no terminals,
  as today.
- Builds are capped (`CARGO_BUILD_JOBS=8`) and `target/` is gitignored.

## Workspace layout (D10)

```
Cargo.toml              workspace: members crates/*, shared versions, libghostty pin
crates/
  g3d-wire/             the protocol: frame codec, op/event types, the query filter.
                        No I/O, no libghostty. TCEL types join it at S3.
  g3d-termd/            the daemon: owner threads, PTYs, libghostty, the socket server
  g3d/                  the client binary: attach, watch, ls, new, kill, stop
```

S2's relay joins as `crates/glyph3d-cli` and replaces `cli/`. S3's packer goes in
`g3d-termd` and its types in `g3d-wire`.

## S1 gates

Every test runs its own daemon on a socket under its scratch directory, and kills it
(and every child) on success or failure. Heavy runs follow the memory rule (16 GiB
available, `flock` on the shared heavy lock, one at a time).

- **`g3d-wire`:** round-trip every frame type; decode the hex examples in PROTOCOL.md
  byte for byte. The examples are the test vectors.
- **termd unit:**
  - create/list/kill;
  - `if_exists`;
  - a subscribe cut mid-escape-sequence (the continuation case);
  - a repaint replayed into a fresh libghostty terminal equals termd's active area,
    cursor and modes, primary and alternate;
  - resize ordering (no byte after the `size` event's `seq` was produced at the old size);
  - each query answered exactly once;
  - `view` across new output;
  - lossy lag → `lagged` + repaint;
  - blocking owner → no gap in `seq`;
  - a child that ignores `SIGHUP`;
  - a panic in one owner thread leaves the others running.
- **Fidelity:** the spike's 29 conformance snippets and its recorded streams, through
  termd and into xterm-headless via raw mode, final screens equal.
- **Flood:** `seq 1 300000` in N terminals: every line arrives at the owner (no `seq`
  gaps), and daemon RSS stays under a stated ceiling.
- **Lifecycle:**
  - relay restart: terminals survive, `terminal.recover` re-adopts them;
  - display reload: re-adoption repaints the grid;
  - termd killed: adapters exit cleanly and the next spawn starts a fresh daemon;
  - idle exit;
  - the lock refuses a second daemon.
- **The existing suites, unchanged:** `tools/terminal-readopt.test.mjs`,
  `tools/wall-e2e.mjs`, `wall-text-perf` via `tools/check.mjs`.
- **`g3d attach`** in a real terminal against a shell and vim: no stray query replies
  typed into the shell, detach restores the tty, `--take` resizes the display's grid.

## Risks carried into S1

- **One daemon, one blast radius.** A libghostty abort kills every shell in the
  namespace (D3). Mitigations: the panic boundary per owner thread, an explicit
  scrollback cap, and the hot-upgrade path for planned restarts. Revisit with a
  process per terminal if libghostty ever crashes in practice.
- **Resize clearing prompt lines.** zmx found that libghostty's resize clears prompt
  lines in anticipation of the shell's redraw, and turns that off in its Zig code. That
  switch isn't in the C API. termd feeds the shell's redraw into the same terminal, so
  it should converge, but S1 must test a resize at a live prompt (with shell
  integration markers) and compare against the browser's emulator.
- **Query filter coverage.** A tty client's terminal can answer a query the filter
  missed. The gate runs vim, a shell and Claude Code under `g3d attach` and watches for
  stray input.
- **libghostty-rs is pre-1.0** ("bindings expected to move with the pinned Ghostty
  source"). The pin holds it still. A bump is a deliberate change with the full gate
  suite.
- **Snapshot format instability** limits a hot upgrade across libghostty versions to the
  VT repaint (above).
