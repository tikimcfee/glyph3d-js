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

It is also the design termd is built to before S2 ("termd ready"): the [holder and
brain](#holder-and-brain) split, the [environment](#environment) a terminal gets, the
[defaults](#defaults) and the [status](#status) stream. "S1 as built", "Holder and brain as
built", "Environment and defaults as built" and "Status as built" below say what the branch has
today; the sections after them are the design.

## S1 as built (2026-11-12)

What exists on branch `termd`, and where it departs from the plan below:

- **Daemon** (`crates/g3d-termd`): everything in PROTOCOL.md 1.0 (`raw`, `view`,
  `capture`; `cells` answers `unsupported`). Paths: socket and log follow the namespace rule;
  `G3D_TERMD_DIR` overrides both (tests and the check runner keep their daemons in scratch
  directories with it). A socket path over 100 bytes is refused at start. `kill` signals the
  program's group and the PTY's foreground group, closes the PTY, and sends `SIGKILL` to both
  if the program outlives a 2 s grace. The test hooks exist only in a build with the cargo feature
  `test-hooks` (the tests' alone: `cargo test --features g3d-termd/test-hooks`; `make` and release
  builds have none), armed by `G3D_TERMD_TEST_HOOKS=1`: an `INPUT`
  of one magic string panics that terminal's owner thread (the panic-boundary test), another stops
  the brain's heartbeat (the watchdog test); `G3D_TERMD_TEST_BRAIN_FAIL_FILE` makes a brain exit at
  start while that file exists (the crash-loop test); `G3D_TERMD_TEST_ENGINE_FILE` names the engine
  a brain reports (the cross-engine handoff test); `G3D_TERMD_TEST_SESSION_ENV_FILE` stands in for
  the user manager (the environment test); `G3D_TERMD_TEST_CANDIDATE_DIES_FILE` makes an upgrade's
  candidate die 100 ms after it says `ready` (the died-after-commit test). The scrub removes these from programs' environments.
  `exit` carries a signal by name. `on_xtversion` answers `g3d-termd <version>`.
- **Client** (`crates/g3d`): `attach` (raw tty, query filter, `Ctrl-\` twice to detach,
  `--take` owns the size and follows `SIGWINCH`), `watch` (`Ctrl-C` or the detach chord
  quits), `ls`, `new` (starts the daemon if needed), `capture`, `kill`, `stop`. Attach
  subscribes `flow: "lossy"` even with `--take`, so a slow tty never stalls the program.
  When another client takes the terminal, `attach --take` ends (`[another client took
  <id>; attach again]`): its window no longer sets the size, so its raw view would wrap
  wrong. A plain `attach` stays through ownership changes.
- **Relay** (`cli/termd.go`, `cli/attach_unix.go`): as in "The Go adapter moves to termd"
  below, plus a repaint on every `size` event (below). There is no tmux code left in
  `cli/` except gomuxai's own tmux (the agents' screens and `gomux.resize`). Every adapter
  (spawned, recovered, gomux screen) starts through `startAdapter`, which watches it: an
  adapter killed by a signal or crashed (any exit but 0, or 1 for a failure it reported)
  leaves a live terminal with no owner, and the relay re-adopts it with a new adapter, at
  most 3 times a minute per terminal. An adapter logs `LOST termd` only when termd's
  connection drops under it, never when it is closing (the relay went, a signal). A
  re-adopting adapter logs the terminal's own argv from `list`.
- **Gates**: see `tools/CHECKS.md`, "The terminal daemon". The fidelity gate feeds the 29
  conformance snippets through termd and compares a late subscriber's repaint, parsed by
  xterm, to xterm fed the snippet (28/29 equal; invalid UTF-8 differs by design). The spike's
  recorded tmux client streams were not replayed: they are tmux's redraw protocol, which no
  longer reaches the browser.
- **Not done in S1**: the resize-at-a-live-prompt comparison against the browser's emulator
  (the "resize clearing prompt lines" risk below), and `g3d attach` under vim and Claude Code
  by hand (the query-filter coverage risk) — both are for the operator to try. Hot upgrade,
  packed cells and the Rust relay are later stages.
- **Designed after S1:** the holder/brain split is built ([below](#holder-and-brain-as-built-2026-11-12)),
  and so are the environment policy and the defaults audit's decisions
  ([below](#environment-and-defaults-as-built-2026-11-12)), and so is protocol 1.1's status stream
  with everything that renders it ([below](#status-as-built-2026-11-12)). Not built yet: the config
  file and `g3d config`, the cgroup scopes.
- **macOS (darwin-arm64)** builds and passes every gate on branch `termd-macos`, which is this design
  plus its platform seams ([Linux and macOS](#linux-and-macos); MACOS.md has what macOS does
  differently). The code lands with the merge.

## Holder and brain as built (2026-11-12)

What the branch has of [Holder and brain](#holder-and-brain), and where it departs from it.

**The holder** is `crates/g3d-hold`: 1,762 lines in six files (1,501 without comments and blank
lines): `holder.rs` (the loop, 1,087), `spawn.rs` (the PTY and the fork, 182), `link.rs` (the hold
link's framing and fd passing, 137), `shm.rs` (memfd / `shm_open`, 57), `log.rs` (30) and `lib.rs`.
It depends on `rustix`, `libc`, `g3d-wire` (the frame codec) and `serde_json`; Cargo keeps
libghostty and tokio out. That is more than "tiny": most of it is the brain's supervision and
the upgrade handshake, which have to live in the process that outlives the brain. Its whole job,
and nothing else:

1. the namespace: the lock (holding its pid), the listening socket, daemonizing, the hourly
   `utimes` re-stamp of both, `PR_SET_NAME` `g3d-termd`;
2. the shells: spawning on a PTY when the brain asks (`IUTF8`, the slave opened before
   `TIOCSWINSZ`, every signal disposition and the mask reset, the soft `RLIMIT_NOFILE` put back,
   `close_range`, `execve` with the brain's environment and `PATH` lookup in it, the exec error back
   through a close-on-exec pipe), reaping, keeping each master fd and exit status until the brain
   releases the terminal, `kill` (the program's group and the PTY's foreground group, `SIGKILL`
   after `--kill-grace`);
3. the store: each terminal's newest two blobs, and the `seq_marks` page, handed to every brain;
4. the brain: start, restart after a crash (`--brain-restart-delay-ms` 100, `--brain-start-burst`
   5 in `--brain-start-interval` 10 s), failed (retried after `--brain-failed-backoff` 30 s doubling
   to `--brain-failed-backoff-max` 600 s, at once on `SIGHUP`; while failed it answers every
   connection with `ERROR brain_failed` naming the last exit, the log and its pid), the watchdog
   (`--brain-watchdog` 30 s: `SIGABRT`, `SIGKILL` 5 s later), and the upgrade handshake
   (`--upgrade-deadline` 10 s);
5. the end: `SIGTERM` (the brain is asked to `shutdown`, so subscribers get `exit` + `closed`; the
   holder hangs every program up itself if the brain hasn't ended in `--kill-grace` + 2 s), a
   brain's `exit_namespace` (`stop`, idle exit), or idle with no brain and no terminals.

It ignores `SIGINT`, `SIGQUIT`, `SIGTSTP` and `SIGPIPE`. Its panic hook logs, then aborts.

**The hold link** is a `socketpair(AF_UNIX, SOCK_STREAM)`; the brain gets its end as an inherited
fd (`g3d-termd --brain --hold-fd N`, plus every flag the holder was started with). Each message is
one frame in the public header with `flags` = the number of fds it carries and one JSON object
(`{"m": …}`); fds ride `SCM_RIGHTS` on the `sendmsg` that carries the frame's first byte, and the
reader queues them in order. The holder's side is non-blocking with an outgoing queue (a wedged
brain cannot block it); the brain's is blocking. Messages, holder → brain: `welcome` (instance,
generation, holder pid and version, `candidate`; fds: the listener, `seq_marks`), `term` (handle,
slot, id, pid, the brain's opaque `meta`, the exit status if reaped; fds: the master, then the
stored blobs newest first), `terms_done`, `go`, `spawned`, `exited`, `candidate`, `commit`,
`upgrade_abort`, `shutdown`. Brain → holder: `hello` (hold `[2, 0]`, engine, version), `spawn` (the path to exec, argv, the whole environment, the cwd),
`kill`, `release`, `snapshot` (fd: the blob), `alive`, `upgrade`, `upgrade_cancel`, `handoff_done`,
`ready`, `upgrade_abort`, `exit_namespace`.

**Saving and restoring screens.**

- Each owner thread saves a blob (`crates/g3d-termd/src/blob.rs`) every `--snapshot-interval-ms`
  (2,000) while its `seq` has moved: a libghostty snapshot, LZ4-compressed (`lz4_flex`), in a new
  memfd sealed against writes, growth and shrinking (macOS: `shm_open` + `shm_unlink`). The header
  carries a magic, kind (snapshot, or VT repaint), the handoff flag, `seq`, the engine
  (`libghostty-vt/1.0.1 snapshot/1`), the terminal's id, the lengths and a CRC-32 (IEEE, from
  `crc32fast`; the design said CRC32C, and any CRC that catches a torn or wrong blob does). The
  format is frozen; `tests/fixtures/blob-v1-vt.bin` is its first fixture.
- **Departure: the holder creates `seq_marks` once**, at its start (8 bytes × `--max-terminals`
  8,192 = 64 KiB), and hands the same page to every brain, so a new brain reads the dead one's
  marks without a handoff. Slots are the holder's (a terminal keeps its slot for its life).
- **Finding: the mark goes before the read.** A brain `SIGKILL`ed while its owner thread is inside
  `read(2)` dies after the kernel has dequeued the bytes; a mark stored after the read would miss
  them, and they were lost uncounted (about 100 B in one run of four under a flood). Each read is
  now bounded by `FIONREAD` and the mark set to cover it first, then set exactly after. The count is
  exact unless the kill lands between the store and the syscall; then it overstates by bytes the
  next brain still reads (`seq` skips ahead, nothing is lost). The report never understates a loss.
- A starting brain restores each terminal from its newest blob that parses, passes the CRC, names
  the terminal and (for a snapshot) names its own engine; a VT repaint replays into a fresh
  emulator under any engine. `seq` resumes at `max(high-water, blob seq)`. A terminal is **exact**
  when its blob is at the high-water mark: an upgrade's handoff, and also a crash while the
  terminal had been quiet since its last snapshot. Only a terminal that is not exact gets the
  `SIGWINCH` nudge. Pending input rides only an exact handoff blob (at most once). The brain logs,
  per terminal, the snapshot's seq, the high-water mark and the unseen bytes, then a summary
  (`restored 3 terminal(s): 1 exact, 2 from snapshots, 0 blank; 512 B unseen`).

**Upgrade** works as designed, with these specifics: the old brain makes `create` answer `busy`
and stops accepting (connections wait in the backlog); an owner thread at its cut answers
`resize` and `kill` with `busy` and drops `INPUT` with an `error` event `busy` (at most once: input
the handoff did not carry is not kept). The candidate checks that every live terminal came back
exact and says `ready`, or `upgrade_abort` with the reason. After `commit` the old brain queues
`ERROR restart` behind everything already queued to each connection (so a subscriber's stream
ends exactly at the cut), gives the writers up to 1 s, and exits; the holder sends the candidate
`go` once it has reaped the old one. `commit` is the point of no return: a candidate that dies
after it is not a failed upgrade (the old brain has handed over and exits anyway) but a crash of
the next brain, which the holder restarts from the handoff blobs (every terminal exact); the log
says that, and `last_start` reads `crash` with the candidate's exit. On failure the asker gets an
`upgrade_failed` event on stream 0. `g3d upgrade [--binary PATH]` prints the new generation, or the failure; with the brain failed
it sends the holder `SIGHUP` instead and waits for a brain. The holder records for
`g3d upgrade --holder` are not built (`holder: true` answers `unsupported`).

**The relay** (`cli/attach_unix.go`, `cli/termd.go`): an adapter whose connection drops rides the
restart by [the rule](#riding-a-restart-relay-and-clients) (`serve --termd-reconnect`, 30 s,
passed to every adapter): it checks `instance`, re-subscribes by id as the owner, and the repaint
redraws the grid; nothing listening is `LOST termd` at once. `terminal.recover` skips a terminal
whose adapter this relay started is still alive: during a restart termd lists every terminal with
no owner for a moment, and a second adapter would fight the first. "Unknown is not empty" needed
no change: a listing that can't get a `WELCOME` (a brain restarting, `brain_failed`) is an error.

**Not built yet:** the cgroup scopes (programs, the brain and the holder stay in their starter's
cgroup; the brain's `oom_score_adj` +300 is set), the holder's re-exec (`--holder`, the holder
record and `--check-holder-record`), a fuzzed hold-link decoder. (The status stream, the relay's
status connection and its re-adopting of terminals whose adapters gave up are built: [Status as
built](#status-as-built-2026-11-12).)

**Gates** (`crates/g3d-termd/tests/restart.rs`, each on a private socket):

- a brain `SIGKILL`ed during `seq 1 300000`: both shells alive with their handles and pids; a quiet
  terminal's screen back exactly; the flood's history holds every line up to the snapshot's `seq`
  and every line from the high-water mark on, so the gap is exactly the reported unseen bytes
  (positions computed from the subscriber's own stream); output after the restart has no gaps;
- `g3d upgrade` to a copy of the binary during the same flood: each connection ends with
  `ERROR restart` exactly at the cut, the new generation restores both terminals exact, all
  300,000 lines are in the terminal's history, and the quiet screen is identical;
- upgrades that fail (a candidate that exits, one never ready, a path that isn't a binary) leave the
  same brain serving the same connections; an upgrade to another engine hands over by VT repaint
  and reproduces the screen;
- a brain that exits at every start: `ERROR brain_failed` naming the holder's pid, the shell alive,
  then `SIGHUP` brings a brain back with the terminal; the watchdog aborts a brain that stops
  sending `alive`; the holder's death hangs every shell up, the brain leaves saying why, and
  nothing listens;
- Go (`cli/relay_terminals_test.go`): the holder's death is loud; a brain restart is ridden (same
  instance, generation 2) and a listing in between is never an empty answer;
- `tools/termd-relay-check.mjs`: a brain crash and a `g3d upgrade` through the relay with a
  simulated display (no grid closes, no `LOST termd`, the screen comes back, typing works,
  `terminal.recover` mid-restart lists the terminals), then the holder's death.

## Environment and defaults as built (2026-11-12)

What the branch has of [Environment](#environment) and [Defaults](#defaults), and where it departs
from them.

**Who decides what.** The brain composes everything a program starts with (`crates/g3d-termd/src/env.rs`):
the base (the caller's, or the session's), the scrub, the fill, `termd.toml`, the request, termd's
own, the program's path and argv, the working directory. The holder execs exactly that: it no longer looks anything up in `PATH`, which
took a branch out of it. `argv[0]` without a slash is found in the composed environment's `PATH`,
or `confstr(_CS_PATH)` when it has none (what `execvp` does), an empty entry or a relative one
(`.`) being the program's working directory, as for `execvp` run there; not found is `spawn_failed` before
anything forks. The `create` reply and `list` show the resolved path first (`/usr/bin/sh`, not
`sh`), and the reply says `login` and `cwd`; a restored terminal keeps them in the holder's record
(`login` and `term` are new fields there, read with defaults from an older brain's record). The
record also keeps the terminal's tagged environment (`env`: each variable, its value and its
layer, what the `env` op answers; a few KB), so it survives a brain restart; a record an older
brain wrote has none, and `env` answers an empty list for it.

**Hold protocol 2.** `spawn` now carries the `path` to exec apart from `argv` (a login shell execs
`/bin/bash` as `-bash`), which a hold-1 holder would ignore and exec `-bash` from `PATH`: a changed
meaning, so a new major. A hold-1 holder stops a hold-2 candidate at its hello, and `g3d upgrade`
answers "upgrade failed; the running brain carries on" (tried: a namespace started by the previous
build, upgraded to this one; its shell kept running under the old brain). So a namespace started
before this change takes a restart (`g3d stop`, which ends its shells) to get the new environment,
until the holder's re-exec (`g3d upgrade --holder`) exists. A hold-2 holder now names the reason
in the `upgrade_failed` it sends.

**Settings** (flags on `g3d-termd`, passed to every brain):
`--env-source auto|daemon` (also `G3D_TERMD_ENV_SOURCE`, so a relay's tests and the check tools set
it through the environment the relay hands the daemon), `--env-manager-timeout-ms` 1000 (the
session source's wait, either platform's), `--env-scrub NAME|PREFIX*` (repeatable, adds to the
scrub), `--config PATH` (also `G3D_TERMD_CONFIG`; absolute; the tests and check tools point it into
their scratch directory so a person's own file never reaches them), `--shell PATH` (refused at start
unless an absolute path to an executable), `--login-shell true`, `--fill-locale true`, `--term
xterm-256color` (also the terminfo name the emulator answers with, stored per terminal). The
config file is `termd.toml`'s `[env]` only ([The config file](#the-config-file-termdtoml)); the
other settings stay flags. **One mechanism adds a name to the allowlist and exempts it from the
scrub: `termd.toml`'s `pass`** (no flag beside it), which a person edits without restarting the
daemon.

**Departures and details the design left open:**

- **The scrub's last group is `G3D_TERMD_*`**, a prefix, rather than `G3D_TERMD_DIR` and
  `G3D_TERMD_TEST_HOOKS` by name: it also covers `G3D_TERMD_ENV_SOURCE`, `G3D_TERMD_CONFIG` and
  every test hook's file variable. `G3D_TERMD_ID` and `G3D_TERMD_SOCKET` are layer 6's and set
  again after it.
- **Reaching the user manager from any starter.** `busctl --user` needs
  `DBUS_SESSION_BUS_ADDRESS` or `XDG_RUNTIME_DIR`; a daemon started without either (a relay run
  from `env -i`, cron) would never reach the manager, and one started with a stale address (a
  bus from an earlier login) would fail to, and both fall back to the daemon's start values,
  which is the case the policy exists for. So termd finds the user bus from the uid, where
  `pam_systemd` puts it: when `/run/user/<uid>` exists and is the user's alone
  (`g3d::paths::user_runtime_dir`, which the socket rule shares), `busctl` gets
  `XDG_RUNTIME_DIR=/run/user/<uid>` and no `DBUS_SESSION_BUS_ADDRESS`; only without that
  directory does the starter's address count. `busctl` is found in the daemon's `PATH`, then `/usr/bin`,
  `/bin`. Measured here: `env -i busctl --user …` fails with "$DBUS_SESSION_BUS_ADDRESS and
  $XDG_RUNTIME_DIR not defined"; with `XDG_RUNTIME_DIR=/run/user/<uid>` it answers.
- **The policy is logged once at brain start** (`terminal environment: a caller's own when it
  sends one; else <the allowlist>, each from <the source> at every create …`, and `termd.toml
  <path>: …`, after the session source is probed off the async threads), and **which source a
  no-caller `create` used is logged when it changes** (`terminal environment: the session's from
  the systemd user manager` / `the daemon's start values: <why>`). The status document's
  `daemon.env` names the source and the config file's state (with a warning while the session
  source is unreachable or the file is bad). A source that stops answering costs each no-caller
  `create` up to the timeout, then falls back; a caller's `create` never asks it.
- **`SHELL`.** With no `argv`, a request's `env` `SHELL` is the shell that runs (an absolute path
  to an executable, else `bad_request`), so `$SHELL` names the running shell as `login(1)` and tmux
  mean it (vim's `:sh` and scripts read it). Otherwise the shell is chosen as designed (`--shell`,
  else the passwd entry's when it is an executable, else the base's `$SHELL` when it is an absolute
  path to an executable, else `/bin/sh`). The chosen shell becomes `SHELL` for every terminal, an
  explicit `argv` included (`login(1)` sets it regardless of what runs); with an `argv`, a
  request's own `SHELL` is only the variable, as any layer-4 value.
- **The account** (`HOME`, `USER`, `LOGNAME`) is filled from the user database where the base
  has none (an empty value is none): a no-caller base never has them (the allowlist leaves them to
  the fill), so a terminal the wall opens always gets passwd's, whatever the daemon's starter had
  (a scratch harness's `HOME`); a caller's own are its subshell's, as in screen and tmux. `PATH`
  likewise: login(1)'s (`/etc/login.defs`' `ENV_PATH` on Linux, which shadow's and util-linux's
  `login` read, else util-linux's `/usr/local/bin:/bin:/usr/bin`; macOS `login`'s `_PATH_DEFPATH`,
  `/usr/bin:/bin`), never the session source's, which is the profile's job in the login shell
  (`pass = ["PATH"]` takes the session's instead).
- **The working directory.** A `cwd` with a `.` or `..` component (POSIX forbids them in `PWD`,
  and a shell that finds them discards `PWD`) becomes the directory's real path, in `PWD` and in
  the reply; any other keeps its spelling, so a symlink's name stays.
- **Limits** are counted as the kernel counts them: a value's limit (`MAX_ARG_STRLEN`, 128 KiB)
  is on the whole `NAME=value` string and its NUL, and the total adds a pointer per string and per
  list end, as `ARG_MAX` counts them (on macOS too). The total is this host's `ARG_MAX`
  (`sysconf(_SC_ARG_MAX)`, read once: on Linux a quarter of the stack limit, 2 MiB at the usual
  8 MiB, capped at the kernel's own ceiling of 6 MiB, `_STK_LIM / 4 * 3` in fs/exec.c; macOS's
  1 MiB), so whatever a shell here can exec, `g3d new` from it can start too, as screen and tmux
  started from that shell would. A value one byte under the old documented maximum used to pass
  the check and fail at `execve` with `E2BIG`.
- **A set locale that doesn't give UTF-8** (it doesn't load, or its charset isn't UTF-8: checked
  per `create` with `newlocale` and `nl_langinfo(CODESET)`) starts as asked, and is said: in the
  log when the problem changes, and in the status document's `daemon.env.warnings` while it is
  the last terminal's.
- **Locale.** "Set" means non-empty (POSIX treats an empty value as unset). A request whose `env`
  names `LANG`, `LC_ALL` or `LC_CTYPE`, even to remove it (`null`), gets no fill: it chose. The fill
  is checked once at brain start with `newlocale(LC_CTYPE_MASK, …)`; macOS asks
  `defaults read -g AppleLocale` (on the M2, `en_US` gives `en_US.UTF-8`), falling back to
  `C.UTF-8` when the user's locale doesn't load.
- **A missing home** starts the program in `/`, as `login(1)` does ("No home directory, logging in
  with HOME=/"), rather than failing the `create`.
- **`g3d new`** sends its own working directory unless `--cwd` (tmux's `new-session` starts in the
  client's directory too), and **its whole environment as `env_base`** (`g3d::env::caller_env`),
  leaving out, with a note on stderr, what the protocol can't carry (a name outside
  `[A-Za-z_][A-Za-z0-9_]*`, bash's exported functions among them; a name or value that isn't
  UTF-8; a variable over `execve`'s per-string limit). `--clean` sends none: the no-caller rule.
  `-e NAME=VALUE` sets a name in the request's `env`; `-e NAME` passes this shell's `NAME`, or
  removes it when this shell has none (docker's `-e NAME` passes; with no value here the
  terminal has none either); a `NAME` whose value here isn't UTF-8 is an error, since the
  person asked for it by name. A request larger than the daemon's `max_frame` is refused by
  `g3d` before it is sent (`too_large`), so a huge `g3d paste` says so rather than a broken pipe. `g3d env <id> [--json]` prints the effective environment, each line
  its source (and `via`) then `NAME=value`. `g3d` inside a termd terminal reaches that terminal's
  daemon through `G3D_TERMD_SOCKET` when given neither `--ns` nor `--socket`. The detach key also
  reads `G3D_DETACH_KEY`.
- **The relay** sends no `argv` for a plain new terminal and passes its served root as `cwd`
  (`attach --cwd`, which the relay sets when `serve` has a root); a hand-run `glyph3d-cli attach`
  with no `--cwd` starts at home. It sends **no `env_base` and no `env`** (`termdCreate` in
  `cli/attach_unix.go`, which `TestTermdCreateSendsNoEnvironment` holds): it is a creator with no
  shell, so its terminals get the desktop session's environment whatever started the relay
  (`termd-relay-check.mjs` starts a second relay from a stripped environment with a stale
  `DISPLAY`, a stale bus address, a missing runtime directory, another terminal's identity, a
  `TZ`, an `XDG_CONFIG_HOME` and `LC_ALL=C`, its daemon asking the real user manager read-only:
  the terminal gets the manager's handles, tagged `session (systemd-user)`, and none of the rest).

**Defaults applied** (the table's "change" and "new" rows): scrollback 10,000,000 bytes, clamp
64 MiB (`--scrollback`, `--max-scrollback`); the PTY input buffer 16 MiB (`--input-buffer`); the
lossy queue 4 MiB and the blocking owner's 1 MiB / 256 KiB marks, now settings (`--lossy-queue`,
`--block-high`, `--block-low`; `--block-low` must be below `--block-high`); the log rotated at
10 MiB keeping `.log.1` (`--log-max-bytes`, 0 = never): the holder renames it from its timer, the
brain, which shares the file, sees the path name another file before its next line and reopens it;
RFC 3339 lines with the role and pid, values printed as values (`ended: code 0`); the default
program, cwd, `TERM_PROGRAM`, locale fill and scrub as above. **Idle exit stays 300 s** ("keep"),
and status followers don't count toward it ([Status as built](#status-as-built-2026-11-12), with
the status interval and recent errors). The socket directory is found
from the uid on both sides (`g3d::paths::socket_dir`, `cli/termd.go` `termdSocketDir`):
`/run/user/<uid>/g3d`, else `/tmp/g3d-<uid>`, ignoring `$XDG_RUNTIME_DIR` and `$TMPDIR`
(`tests/attach.rs` and `cli/termd_paths_test.go` check that `env -i` and a desktop environment
find the same socket). The holder refuses a socket directory that is not a directory, is another
user's, or is writable by group or others (tmux's check of `/tmp/tmux-<uid>`). Not applied: the
cgroup scopes.

**The test hooks are compiled out** of every build but the tests': the cargo feature `test-hooks`
gates the magic `INPUT`s, the failing brain, the named engine and the user-manager stand-in, and
`cargo test` needs `--features g3d-termd/test-hooks` (each daemon test binary has a test that fails
saying so when it is missing, and the hook-driven tests are gated on it). `make termd`'s release
binary was checked to hold none of the hooks' strings.

**`make`.** `make build` (and `make termd`) builds `g3d-termd` and `g3d` and puts them beside
`glyph3d-cli`; `make linux-amd64` also puts them in `dist/`; `make linux-arm64` cross-builds them
with cargo-zigbuild when installed (it isn't on the build machine today, so the 2026-11-12 arm64
proof under qemu stands as the last one). A missing `vendor/` stops the build with what the vendor
step is and the command (`tools/termd-vendor.sh [DIR]`). `make release` ships the linux-amd64 pair
and requires it, and the linux-arm64 and darwin pairs when they were built. `make darwin-arm64` and
`make darwin-amd64` build their pair natively on a Mac of that architecture (arm64 proven on the M2);
no other host builds them. A bare `cargo build` with no `vendor/`
still fails inside libghostty-vt-sys's build script ("GHOSTTY_SOURCE_DIR does not contain
build.zig"), whose message we don't control; `.cargo/config.toml` says where that comes from.

**Gates** (all on private sockets and a scratch `--config`, `--env-source daemon` unless the test is
about the source): `src/env.rs`'s unit tests (the composition: each layer winning over the one
before and tagging what it set; the scrub and `pass` exempting from it; the fill only where the
base lacks; the no-caller base from the source, else the daemon's start value per allowlisted name
only, and `pass`/`drop`; the name-by-name expansion launchd is asked with and its answer's parser;
`termd.toml` parsing and every error naming its line; `${VAR}` expansion; the config path; login.defs'
`ENV_PATH`; the shell choice and login argv0, `PATH` resolution, the locale rule, the request's and
the caller's checks and limits, cwd checks, busctl's JSON); `crates/g3d/src/env.rs`'s (what `g3d
new` sends and leaves out, `-e`, `g3d env`'s lines); `tests/env.rs`, a daemon started with `env_clear`
plus a stale `DISPLAY`, Terminal.app's and tmux's identity, a parent shell's `SHLVL`/`PWD`/`COLUMNS`,
`SIGINT` ignored and a soft fd limit of 1000: each program's `/proc` environ, argv[0], cwd,
`SigIgn`/`SigBlk` and limits against the policy, and `env`'s tags against environ; an empty caller
environment composing exactly the fill and termd's own; reserved and malformed names refused (in
`env`, and the size and name rules in `env_base`); a caller's odd environment (a stale `DISPLAY`, a
Rex tab's `REX_SESSION`, a custom `FOO`) arriving but its markers, and the same daemon's no-caller
terminal getting the session's fresh `DISPLAY`; a stripped creator (the relay's case) getting the
session's handles and none of its other variables; the session source re-read at every create
through the stand-in (a changed `DISPLAY` reaches the next terminal, not the running one; a name it
lacks is the starter's; an unreadable one falls back to the start values, logged and warned);
`termd.toml`'s `pass`, `drop` and `set` reaching a terminal, a bad file failing creates naming its
line and the status saying so, a fixed one read again; and, when a user manager answers, the real
one beating the starter's `DISPLAY=:99` (read-only, into a terminal running `sleep`);
`crates/g3d/tests/attach.rs`, `g3d new` from a shell with that odd environment, with `-e`, then
`--clean`, and `g3d env`'s tags; `cli/attach_unix_test.go`, the relay's `create` carrying no
`env_base` or `env`; `tools/termd-relay-check.mjs`, a spawn with no `argv` from a relay carrying
Terminal.app's and tmux's identity: `-bash` (the passwd shell) in the served root with
`TERM_PROGRAM=g3d-termd`, none of the relay's identity, and `g3d env` tagging nothing `caller`;
`tests/daemon.rs`, a daemonized namespace's log rotated at 4 KiB, with the brain's next line in the
new file.

## Status as built (2026-11-12)

What the branch has of [Status](#status), and where it departs from it. Protocol 1.1 is whole: the
daemon announces `proto` `[1, 2]` (1.2 adds [keys and paste](#keys-and-paste-protocol-12)) and the
feature `status`.

**The daemon** (`crates/g3d-termd/src/status.rs`, the types in `g3d-wire`'s `Status`):

- Owner threads publish into each terminal's `TermStats` as things change: input bytes, the last
  output time, queued input, the snapshot store's two blob sizes (read from the restored blobs'
  `fstat` at a brain start), the `pwd`, the flow (`live`/`blocked`/`paused`), how it was restored,
  and every subscription's role, mode, flow and view offset after each command. Queue depth, lag
  and the resync count (`SubShared.lags`) are atomics the tick reads live. History rows and
  `memory_usage` (primary + alternate resident and compressed bytes) are sampled on the owner's own
  loop once a second; that loop wakes at least every 500 ms anyway, so no owner thread is woken for
  status.
- One tokio task ticks: it samples every terminal's `seq` and input count into a window of
  `--status-rate-window-ms` (5,000), and when anyone follows, builds the document once, serializes
  it once (`Arc<[u8]>`) and queues it to each follower that is due. A follower is due at once after
  `status_follow`; then when the change key moved (the document hashed with `at`, RSS, memory,
  `snapshots.bytes`, subscribers' `queued` zeroed and each rate reduced to zero-or-not) or any
  terminal's `seq` or input count moved between two samples since its last push (not "any rate is
  non-zero", which held for a whole rate window after one byte: an `echo` cost 20 documents at
  250 ms), no sooner than its interval; and at the keepalive regardless.
  A follower whose previous document is still queued is skipped (dropped, not queued). With no
  followers the tick only samples, once per `--status-interval-ms`. A terminal created under this
  brain gets a zero sample at its `created_at`, so a burst before the first tick counts in its rate.
- The holder tells each brain, in `welcome` (hold protocol 2.1, an additive minor), `restarts`
  (brains replaced by crash, watchdog, upgrade) and `last_start` (`first`/`crash`/`watchdog`/
  `upgrade`, when, and the dead brain's exit). The brain adds what came back how and the unseen
  bytes, in total and per terminal (`terminals[].unseen`, beside `restored`). A brain started
  after the brain was failed also gets `last_start.failed_at` (when the holder marked it failed,
  carried until a brain is welcomed) and opens its errors with `brain_failed`, so the outage is on
  record once it is over. A crash or watchdog start opens the errors with `brain_crash`/`brain_watchdog`.
- RSS: `/proc/<pid>/statm` on Linux, `proc_pidinfo(PROC_PIDTASKINFO)` on macOS (`status::rss`, the
  cfg seam; `tests/status.rs` reads it for the holder and the brain on both); absent where it can't be measured.
- Recent errors: the last `--status-errors` (32) distinct `(code, terminal)`, newest first, from
  `spawn_failed`, `input_full`, `panic`, `lagged`, `restore`, `upgrade_failed`. **Departure:** the
  ring is the current brain's: a restart starts it over (with the reason for the restart). Keeping
  it across a crash would mean the holder storing it; nothing yet needs that. **Departure:**
  environment warnings ride `daemon.env.warnings` only (no UTF-8 locale; the session source
  unreachable, while it is; a bad `termd.toml`, while it is), not the errors; the source and the
  config file are probed once at brain start, off the async threads, so the document names them
  before the first terminal.
- Idle exit counts connections that do anything but `status`, `status_follow`,
  `status_unfollow` and `ping`; a status-only follower is passive. Leaving (idle exit, `stop`,
  `SIGTERM`) first **stops accepting** (a connection made then waits in the backlog and sees the
  end, never a terminal created in a namespace about to go; `stop` did not do this before), then
  sends each follower a last document with `exiting: true` and no terminals, closes it, and waits
  up to 1 s for them to drain.
- Settings (flags, passed to every brain): `--status-interval-ms` 1000, `--status-min-interval-ms`
  250, `--status-max-interval-ms` 60000, `--status-keepalive-ms` 30000,
  `--status-rate-window-ms` 5000, `--status-errors` 32.

**`g3d status [--json] [--follow [--interval MS]]`** (`crates/g3d/src/render.rs`): a header
(daemon, engine, namespace, uptime; holder and brain with RSS and restarts; environment, snapshot
store, connections, log), one row per terminal (id, program, size, subscribers, rate or idle time,
then what needs a look in yellow and the rest faint), the errors. Colour only on a tty and never
with `NO_COLOR` set (the no-color.org convention). `--follow` redraws in place on a tty (home,
draw, clear to end: no flash), appends when piped, rides an engine restart by the client rule and
ends when the namespace leaves; `--json --follow` is one document per line.

**The relay** (`cli/termdstatus.go`): one status connection per relay, as designed (absent,
restarting, unreachable, failed, lost, ok), with these specifics:

- **Its own plane.** The display gets `termd/status` on a status plane: a one-slot queue the
  writer drains after control, where a newer notification replaces one not yet written (each
  carries the whole state). Never blocks, never queues history.
- **Departure: the document stays through a restart.** `status` is the last document while its
  terminals may still be there (`restarting`, `unreachable`, `failed`), so a window can keep its
  rows (dimmed); it is `null` only for `absent` and `lost`.
- A dial that lands in a leaving namespace's backlog after its `exiting` document stays `absent`
  (it is going, not restarting).
- When a spawn starts the namespace's daemon, the status connection is kicked to dial at once.
- A brain answering again after `unreachable` or `failed` (same instance) runs `terminal.recover`'s
  re-adoption, which skips terminals whose adapters are alive and riding.
- The notification is pushed when a display registers, answers the display's `termd/status`
  request, and the relay-resident `termd.status` answers the CLI page-less. `relay.bundled` is
  `g3d-termd --version` of the binary the relay would start.
- Settings: `serve --termd-status-interval` 1s, `--termd-status-redial` 5s,
  `--termd-status-grace` 5s.

**The app.** The core model `services/terminal/TermdStatus.js` (state, document, per-terminal
lookup, the lost latch, `upgradeAvailable`) follows the bridge's `termd/status` pushes and asks
once per registration; a dropped relay link makes it `unknown`, never empty. The wall renders it
(`wall/StatusWindow.jsx`; its verbs are `wall.*` verbs in `wall/wallCommands.js`, its knobs in
`wall/wallConfig.js`):

- the chip after the relay chip (`● termd 4`, `○ termd idle`, amber restarting, red otherwise);
- the window: chord + S (free among the wall's chords: `[ ] ↵ 0 - X G B K`), the chip, or
  `wall.status [toggle|open|close|left|right|float [x y]]`; floats (default: under the topbar at the
  right; drag its head) or docks to an edge (440 px), the placement persisted per relay in
  `WallStore` like the sidebar's. The two panels share their parts (`wall/Panel.jsx`: the dock
  buttons, the head drag, the dock layout): docked on the same edge, the sidebar keeps the edge and
  the window sits beside it, and the topbar and hint clear both. Rows use the wall's names; a click
  reveals the terminal (`wall.reveal`: shown if hidden, focused, framed); hovering shows the whole row (argv, cwd and `pwd`,
  pid, title, every subscriber). While the brain is away the rows stay, dimmed;
- the notice, centred under the topbar on the panel colour: **departure:** a brain restart says so
  in amber (`termd's engine is restarting · the shells are alive`) once it has lasted
  `restartNoticeMs` (400 ms; a blink shows only the chip), as the operator asked for a restart
  notice; `unreachable` counts the time since the brain went away; `failed` and `lost` as
  designed; `lost` until `wall.status.dismiss` (its ×) or a spawn;
- knobs `restartNoticeMs` 400 and `errorsShown` 3, beside the wall's own in `WALL_CONFIG`
  (`wall.config`).

**Gates:** `crates/g3d-termd/tests/status.rs` (the shape against `tests/fixtures/status-shape.json`,
keys and types; throttling: the first push at once, a clamped interval, quiet between keepalives, a
change within the interval, every interval and never sooner while output flows, a rate crossing
zero, then quiet; a status-only follower doesn't hold an idle daemon and hears it leave; `stop`'s
last document; a crash and an upgrade counted in the next brain's document); `g3d-wire`'s test that
PROTOCOL.md's example document is a `Status` field for field; `g3d`'s render unit test;
`cli/termdstatus_test.go` (every relay state from its side of the socket, re-adoption after
unreachable, the plane keeping only the latest); `tools/termd-relay-check.mjs` (the pushes a
simulated display gets through a run: absent, ok with the document, one at registration after a
relay restart, restarting and ok across a brain crash, lost; the request; `termd.status`);
`tools/wall-e2e.mjs` (the chip, the window by chord listing the wall's terminals, a brain restart
held by stopping the holder: the amber notice, then unreachable, both clearing; the shell typing
after; docking and closing by verb; `--shots DIR` saves the window normal, restarting and
unreachable).

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
| Snapshot cost (for crash restore) | 120×40, full 2 MiB history: 489 KB in 0.3 ms, decode 0.5 ms; full 10 MB history: 2.6 MB in 1.4 ms (16 MiB: 4.5 MB, 1.6 ms encode, 5 ms decode); an idle prompt: 1.2 KB in 8 µs. LZ4 on build-log text: 37 KB / 205 KB / 349 KB | Probe (`encode_snapshot_alloc`), single runs; `lz4 -1` on the encoded bytes |
| Rows per scrollback cap, and idle compression | 120 columns of build-log text: 2 MiB ≈ 1,600 rows, 10 MB ≈ 9,300, 16 MiB ≈ 15,800. `compress(Full)` takes 10 MB resident to 0.86 MB in 1.4 ms | Probe (`memory_usage`) |
| PTY output buffered with no reader | 13,824 bytes, then the writer blocks | Python `pty.openpty`, raw mode, non-blocking writes |
| `IUTF8` on a new PTY | off (Linux) | Python `termios` on `pty.openpty` |
| Parse speed, native | 100,000 coloured lines (about 5 MB) through `vt_write` in 10.6 ms. The ghostty wasm build measured 69–80 MB/s in the spike. | Probe (single run). |

## Prior art taken, and not

- **phux** (Rust, libghostty-rs, the closest relative). Taken:
  - the `!Send` terminal owned by one task;
  - a bootstrap profile that is "synthesized VT, then raw PTY bytes", cut at an inclusive `base_seq` (our `seq`);
  - structured key input encoded server-side, for the clients that have keys but no terminal (the browser; [Keys and paste](#keys-and-paste-protocol-12)), beside raw bytes for the ones that have one;
  - the server answering each terminal query once while clients suppress replica replies;
  - versioning where only a major refuses, minors add fields that old peers skip and features are announced;
  - fence-and-recut instead of an unbounded backlog for a lagging consumer.

  Its hot upgrade (hand the listening socket and PTY fds to the new image, a frozen upgrade blob the candidate parses first) shapes `g3d upgrade` ([Holder and brain](#holder-and-brain)). Not taken:
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
`/run/user/<uid>/g3d/termd-<ns>.sock` when logind's runtime directory `/run/user/<uid>` exists
and is the user's alone (owned, `0700`). Otherwise (always on macOS; on Linux without logind, as in
some containers) it is `/tmp/g3d-<uid>/termd-<ns>.sock`, tmux's rule (`/tmp/tmux-<uid>`). Both are
found **from the uid, never from the environment**: not `$XDG_RUNTIME_DIR`, which a relay or
daemon started from `env -i`, cron or a service manager doesn't have, so it would serve
`default` at `/tmp/g3d-<uid>` while the desktop's `g3d` looks in `/run/user/<uid>/g3d` (two
`default` daemons, and the relay's terminals invisible from the desktop; found by the verifier).
`$G3D_TERMD_DIR` is the one override, an explicit choice like tmux's `TMUX_TMPDIR`. Known limit:
a daemon started before the user's first login on a host without lingering (no
`/run/user/<uid>` yet) serves from `/tmp/g3d-<uid>`, and a later desktop client looks in
`/run/user/<uid>/g3d`. It ignores `$TMPDIR` on purpose: with `$TMPDIR` unset, Rust's `temp_dir()`
answers macOS's per-user `/var/folders/…/T/` while Go's `os.TempDir()` answers `/tmp`, so a relay
and the daemon it started would look in different places (measured on the M2); and macOS's
`$TMPDIR` is 49 bytes, which leaves too little of `sun_path`'s 104 for a 64-byte namespace (zellij
carries a hard-coded guard for the same reason). `g3d-termd --ns <name>` or `--socket <path>`
picks it.

Every directory the daemon serves from (`$G3D_TERMD_DIR`, `/run/user/<uid>/g3d`, `/tmp/g3d-<uid>`)
is created `0700` and refused, loudly, when it is not a directory, is owned by another user, or is
writable by group or others (tmux's check). Because `/tmp` is cleaned (macOS's `tmp_cleaner` deletes
regular files untouched for 3 days, systemd-tmpfiles' `/tmp` rule after 10), the holder re-stamps
its socket and lock with `utimes` every hour: a deleted lock would let a second daemon take the
namespace and unlink the live one's socket.

The namespace replaces `--tmux-socket`. `glyph3d-cli serve --termd-ns <name>` points a
relay, and every adapter it forks, at that namespace, so a second relay can neither see
nor kill the first's terminals. Tests always pass `--socket` with a path in their own
scratch directory, never a namespace someone might use.

Single instance: the holder holds an exclusive `flock` on `<socket>.lock` for its whole
life. Only the lock holder may unlink a stale socket file and bind. A second daemon on
the same namespace fails at the lock and exits non-zero, naming the holder's pid.

### Who starts it

The relay. To spawn a terminal (the relay before it forks an adapter, and the adapter
itself), it connects to the namespace's socket. If nothing listens, it starts
`g3d-termd --ns <ns> --daemon`, then retries the connection with backoff for up to 3 s, and
fails loud with the daemon log's tail if the daemon still isn't up. Listing and
`terminal.recover` start nothing: a namespace with no daemon has no live terminals.

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

### Lifetime

- **Idle exit.** When the namespace has no terminals and the brain has had no connections for
  `idle_exit` (default 300 s; 0 = never), the holder removes the socket and exits, and the brain
  with it. The name goes first: as the namespace starts leaving (idle exit, `stop`, `SIGTERM`)
  the holder removes the socket and releases the lock at once, before the followers' farewell,
  the shells' hangup grace and the brain's exit, so a client finds nothing (`ENOENT`) and may start
  a new daemon on the name right away (it used to meet, for about a second, a socket that accepted,
  hung and reset, and a start that failed with "another g3d-termd serves"). A connection that only follows status (or pings) does not count: the relay keeps a
  status connection to every namespace it serves ([Status](#status)), and an empty daemon must
  still be able to leave. Followers get a last `status` event with `daemon.exiting: true`, then
  the close. The next relay operation starts a fresh namespace. An empty daemon exiting is also the
  natural point where a new binary takes over.
- **A child exits.** The holder reaps it and tells the brain its status. The brain reads the PTY to
  EOF (so no output is lost), sends `exit` + `closed`, and releases the terminal. The relay's
  adapter sees `closed` and tears down the grid.
- **The brain crashes, or is upgraded.** The shells keep running. See [Holder and
  brain](#holder-and-brain).
- **The holder dies.** Every PTY hangs up and every shell in the namespace gets `SIGHUP`, as with
  `tmux kill-server`. See [If the holder dies](#if-the-holder-dies).

## Holder and brain

Until S1, one process held the PTYs and ran everything else, so a crash or an upgrade of termd
ended every shell. termd is now two processes per namespace:

```
            g3d-termd  (the HOLDER: one per namespace, the shells' parent)
            ┌──────────────────────────────────────────────────────────────┐
            │ <socket>.lock (flock) and the listening socket (re-stamped)  │
            │ per terminal: the PTY master fd, pid, argv, exit status      │
            │ the store: snapshot and handoff fds (FDSTORE-style, named)   │
            │ supervises the brain: start, restart, backoff, watchdog      │
            └───────┬─────────────────────────────────┬────────────────────┘
      fork + exec   │   socketpair: the hold protocol │  fork + exec
      each program  │   (frames + SCM_RIGHTS)         │  the brain
            ▼       │                                 ▼
     shells, each   └────────────────────▶ g3d-termd --brain  (the BRAIN)
     on its own PTY                        libghostty, the owner threads, the
                                           public protocol, clients, status
```

- The **holder** is the shells' parent and keeps a copy of every PTY master fd. It is small and
  changes rarely: no libghostty, no tokio, one thread, a `poll` loop. It does not read the PTYs.
- The **brain** is everything else: one libghostty `Terminal` per terminal on its owner thread,
  the public protocol, the clients, the status stream, the environment policy. It reads and writes
  its own copy of each master fd. It can crash, be killed, or be replaced, and no shell notices.
- The brain gets its fds from the holder over `SCM_RIGHTS`: the listening socket, every PTY master,
  and the stored snapshots and handoff record.

Both run from the one `g3d-termd` binary: `g3d-termd --ns <ns>` is the holder, which starts
`g3d-termd --brain` itself (the brain is never started by hand). The holder's code is its own crate,
`g3d-hold`, which depends on `rustix`, `libc`, `g3d-wire` (the frame codec) and `serde_json` and
nothing else, so Cargo itself keeps libghostty and tokio out of the holder. On Linux
the processes name themselves `g3d-termd` and `g3d-termd-brain` (`PR_SET_NAME`), so `ps` and the
status window tell them apart.

### What others do

| Tool | Who holds the PTY | What a crash or upgrade does | Taken / not |
|---|---|---|---|
| **tmux** | one server process holds every pane's PTY, grid and history | `kill-server`, a crash or an upgrade ends every pane. A new client against an older server refuses with a protocol version mismatch, so people keep the old binary running until their sessions end. One process keeps tmux simple: one event loop, one shared state, no cross-process consistency | Not taken: the single process is what this split removes |
| **dtach**, **abduco** | one tiny master process per session holds the PTY and serves attaches; no screen state | the master never upgrades; a reattach gets no screen, only a redraw nudge (dtach `-r none\|ctrl_l\|winch`, default `ctrl_l`) | Taken: the holder is dtach's master minus the serving; the redraw nudge after a crash (`winch`) |
| **zmx** | one daemon per session holds the PTY and a libghostty-vt beside the stream | the session's daemon is the session; restore on reattach is a libghostty snapshot | Taken: the snapshot as the way a screen comes back |
| **shpool** | one daemon holds every shell in a table, with an in-memory `shpool_vt100` render | shells are the daemon's children, so a daemon restart ends them; ships a systemd user service and socket | Taken: restore modes (`screen` = redraw from the render; `simple` = only `SIGWINCH`) |
| **hexe** | a `pod` process per pane owns the PTY and a 4 MiB raw byte ring; `ses` is the session authority | "SES can crash and be restarted, and the pods — and the shells inside them — do not notice"; reattach replays ≤ 1 MiB of the ring | Taken: the split itself. Not taken: the ring (below) and a process per pane |
| **phux** | one server process | "Hot upgrades re-exec and re-adopt live PTYs; cold restarts, crashes and reboots do not preserve PTYs." The upgrade blob is a frozen format and the candidate binary must parse it before the running one execs into it | Taken: the frozen handoff record, validated by the candidate first; the listening socket handed over |
| **systemd FD store** | the service manager keeps fds a service uploads (`sd_pid_notify_with_fds`, `FDSTORE=1`, `FDNAME=`), and hands them back on restart as `LISTEN_FDS` / `LISTEN_FDNAMES`; a stored fd that shows `POLLHUP`/`POLLERR` is dropped; state rides along in a memfd, saved "when state changes sufficiently" so it survives an abnormal exit | a restart job keeps the store; a stop clears it | Taken as the model: the holder is a per-namespace FD store with named fds, auto-drop on hangup, and state in memfds. Not used directly: the shells need a living parent that reports their exit status (keeping them alive under systemd needs `KillMode=process`, which systemd discourages, and loses exit statuses), macOS has no systemd, and one design serves both |
| **socket activation** | the manager owns the listening socket and passes it in (`LISTEN_FDS`) | connections queue in the backlog while the service restarts, so clients see no refusal | Taken: the holder owns the listening socket |
| **mosh** | `mosh-server` holds the PTY and a terminal emulator per connection | the server is the session; there is no restart that keeps the shell. Clients get the latest screen state, not a byte replay (no scrollback) | Taken: a reconnecting viewer gets the screen (a repaint), not a replay |
| **Eternal Terminal** | the server side keeps the shell across client reconnects | each side keeps a `BackedWriter` buffer of recent bytes and replays what the peer's byte count says it missed | Not taken for clients: a repaint is exact and cheaper than a replay buffer per connection |
| **WezTerm** | `wezterm-mux-server` holds the panes in one process; the GUI attaches over a unix domain | panes persist "until they are closed"; the docs want a compatible version on both ends; no restart keeps panes | Not taken (tmux's shape) |
| **kitty**, **Ghostty** | the app holds its own PTYs; no detached server | quitting the app ends the shells. Ghostty's contribution is libghostty-vt itself (which zmx, phux, hexe and termd build on), its environment practice and per-surface cgroup scopes (below) | Taken: the environment and cgroup practice |

### Does the holder read the PTY? No.

The holder keeps each master fd open and never reads it. The brain reads and writes its own copy.

- **While no brain reads, nothing is lost.** The program's output waits in the kernel's PTY buffer
  (13.8 KB on the build machine, measured with a raw-mode PTY and no reader), then the program
  blocks in `write` until a brain reads again. A restarted brain resumes at exactly the byte the
  old one had not read. The only bytes lost are those the crashed brain had read but not yet saved
  (below), and termd counts them.
- **No extra copy.** Reading in the holder would move every byte through a second process (one
  more copy and context switch per chunk) at flood rates of hundreds of MB/s.
- **Nothing for output to crash.** The holder parses nothing a program writes, so no escape
  sequence, flood or malformed UTF-8 can reach its code.
- **No ring to leak.** hexe's ring is replayed to whoever attaches, so it clears and pauses the
  ring while a password is typed. With no ring there is no such hazard.

The cost is that a program blocks while no brain reads: about 100 ms during a restart, and until a
brain returns if none does. A frozen program is the honest state of a terminal nobody is
processing. tmux behaves the same when its server is wedged.

### Screens after a crash

The brain saves each terminal while it runs, so a restarted brain can bring the screen back:

- **Snapshot.** Every `snapshot_interval` (default 2 s), each terminal with new output since its
  last save encodes a libghostty snapshot on its owner thread, compresses it with LZ4 and writes it
  into a new anonymous shared-memory object sized to fit (Linux: a `memfd`, then sealed against
  writes and growth; macOS: `shm_open` of a random name, `shm_unlink` at once, sized once, which is
  all macOS allows, and written and read through a mapping). It sends that fd to the holder, which keeps the newest two per terminal and
  closes the older. The object is complete before it is sent, so a crash mid-encode leaves the
  previous one whole; there are no slots to tear. Its header carries a magic, the engine
  (`libghostty-vt/1.0.1` plus the snapshot format version), the terminal's id, the `seq` the
  snapshot is at, the length and a CRC-32. Shared memory, not a file: screens can hold what was
  typed at a prompt, and RAM-backed objects never reach a disk (beyond swap). Measured: a 120×40 terminal with a full 2 MiB history snapshots to 489 KB in
  0.3 ms; with a 10 MB history, 2.6 MB in 1.4 ms (decode 5 ms). LZ4 shrinks those to 37 KB and
  205 KB on build-log text. An idle prompt is 1.2 KB in 8 µs. The cost to the owner thread is
  well under 0.1% at a 2 s interval.
- **The seq high-water mark.** One fixed-size shared page (`seq_marks`, 64 KiB: `max_terminals`
  8,192 × 8 bytes), created by the holder at its start and handed to every brain, holds each
  terminal's `seq` as one relaxed atomic store at the terminal's slot, set to cover each read
  before it runs (FIONREAD-bounded; [as built](#holder-and-brain-as-built-2026-11-12)). A restarted
  brain knows how many bytes the dead brain read after its last snapshot:
  `unseen = high-water − snapshot seq`.
- **Restore.** The new brain decodes the newest valid slot if its engine string matches its own
  exactly (the snapshot format is outside libghostty's ABI promise), resizes it to the PTY's
  current size (`TIOCGWINSZ`, the kernel's truth), and resumes `seq` at the high-water mark, so
  `seq` never repeats. With no matching snapshot the terminal starts blank.
- **Redraw nudge.** Then termd sends `SIGWINCH` to the PTY's foreground process group (dtach's
  `winch` method and shpool's `simple` mode). Full-screen programs redraw everything; a shell
  redraws its prompt line. Output from the unseen bytes is missing from the screen and history.
  The status stream reports, per terminal, how it came back (`snapshot` or `blank`) and the
  unseen byte count.
- **Saved again.** A terminal restored from a snapshot or blank shows a screen no stored blob
  holds at its `seq`, so its owner saves one at the next interval even if the program stays quiet
  (the "new output since its last save" test alone would never fire). Without it every later crash
  restored the same stale snapshot and reported the same loss again (the verifier's 20 crashes
  counted one terminal's 950,706 lost bytes as 1,240,548).

### Screens after an upgrade: `g3d upgrade`

A planned replacement loses nothing, because the old brain hands over at an exact cut.

1. `g3d upgrade [--ns NS] [--binary PATH]` sends `upgrade` to the running brain. The reply means
   "accepted"; the client then reconnects and waits for a `WELCOME` with a higher brain
   generation, or for the status stream's `last_start` to say the upgrade failed.
2. The old brain asks the holder to start the candidate: `PATH`, else the path the holder was
   started from (a new file installed there; the holder never uses `/proc/self/exe`, which would
   name the old, replaced inode). The candidate says hello to the holder with its engine and the
   handoff formats it reads.
3. The old brain stops accepting connections (the listening socket stays in the holder, so new
   connections wait in its backlog) and stops each owner thread at a cut between PTY reads. Each
   terminal is encoded at its cut: a libghostty snapshot when the candidate's engine is the same,
   else the formatter's VT repaint with all of its history (exact screen and modes, styled-text
   history). The handoff record (per terminal: id, handle, pid, argv, cwd, created time, seq,
   title, pwd, colours, cell size, scrollback cap; plus the recent errors and counters) and the
   blobs go to the holder as memfds.
4. The candidate decodes and validates everything and tells the holder it is ready. Only then does
   the old brain close each connection with `ERROR` `restart` and exit. The candidate becomes the
   brain, starts reading the PTYs at each cut's `seq`, and starts accepting. No byte is skipped and
   `seq` continues exactly.
5. If the candidate exits, or isn't ready within `upgrade_deadline` (10 s), the holder kills it and
   the old brain resumes: it reopens accept and its owner threads read again. Connections were
   never dropped. The failure is in the log and in the status stream.

The handoff record is a format: every shape a release wrote stays decodable, and an append-only
fixture set holds one sample per release (phux's rule). The same applies to the holder record
below.

`g3d upgrade` is the only upgrade command. `g3d stop` (every shell dies) remains for tests and for
ending a namespace on purpose.

### If the brain never returns

The holder restarts a brain that exits without a handoff (a crash, a kill, a failed upgrade's
leftover) the way systemd restarts a failing service, using systemd's own defaults:

- restart after `brain_restart_delay` (100 ms, systemd's `RestartSec` default);
- at most `brain_start_burst` (5) starts in `brain_start_interval` (10 s), systemd's
  `DefaultStartLimitBurst` / `DefaultStartLimitIntervalSec`;
- past that limit, the brain is **failed**. The holder keeps retrying, slowly: after 30 s, then
  doubling to at most 10 min, forever. A fixed binary installed meanwhile is picked up at the next
  try. `SIGHUP` to the holder (the usual "reload" signal; its pid is in the lock file) retries
  now and resets the backoff, and `g3d upgrade` sends it when it finds the brain failed.
- While failed, the holder accepts connections itself and answers each with `ERROR`
  `brain_failed`, whose message names the brain's last exit, the log path and the holder's pid,
  then closes. Clients never hang on a silent socket. The close **lingers** (as an HTTP server's
  lingering close after an error response): the holder half-closes its write side, reads and
  discards what the client sends, and closes on the client's EOF or after
  `brain_failed_linger` (2 s; at most `brain_failed_linger_max`, 64, at once, the oldest closed
  first). Without it the holder answered and closed before the client's `HELLO`, which then
  failed with `EPIPE`: the doc's own minimal client raised `BrokenPipeError` and never read the
  message, and a C client that doesn't ignore `SIGPIPE` died (found by the verifier). Both
  reference clients (`g3d::Client`, the relay's `dialTermd`) also read what is waiting after a
  failed `HELLO` write.
- The shells stay alive and freeze once their PTY buffers fill. The holder never kills a shell on
  its own. Idle exit still applies: a failed namespace with no terminals exits.
- **Watchdog.** The brain sends the holder `alive` every 5 s from its socket runtime. After
  `brain_watchdog` (30 s; 0 = off) without one, the holder sends `SIGABRT` (systemd's
  `WatchdogSignal` default, so a core dump shows where it hung), then `SIGKILL` 5 s later, and
  restarts the brain as after a crash.

### Riding a restart: relay and clients

A brain restart drops every client connection; the holder and the listening socket stay. One rule
for every client, written into PROTOCOL.md ("Restarts"):

- On `ERROR` `restart` (planned), reconnect at once (with up to 100 ms of jitter, so a hundred
  adapters don't arrive together). On a dropped connection, reconnect with backoff: 100 ms,
  doubling to 2 s, for up to `reconnect_window` (default 30 s, which covers a crash restart and the
  first crash-loop retries).
- `connect` succeeds while the holder lives, even before a brain accepts (the backlog). `ENOENT` or
  `ECONNREFUSED` means no holder: the namespace and its shells are gone.
- After `WELCOME`, compare `instance` with the one you had. The same instance means your terminals
  may still exist: re-`subscribe` by id (never `create … if_exists: adopt`, which would start a new
  program in a terminal that ended meanwhile). The `REPAINT` brings your screen back. `no_terminal`
  means that terminal ended. A different instance means a new namespace: your terminals are gone.
- Input is at most once. `INPUT` sent while disconnected is dropped, never replayed after the
  reconnect: a doubled command line is worse than a lost keystroke (hexe dedups input by
  `(epoch, seq)` for the same reason).
- The relay's terminals (forked adapters in S1, virtual controllers in S2) follow that rule; each
  keeps its grid during the window and logs `LOST termd` only when the window ends or the instance
  changed. A terminal whose adapter gave up is vacant, and the relay re-adopts vacant terminals
  itself when its status connection sees a brain again, so grids come back with no display action.
- **Unknown is not empty.** `terminal.recover`, and anything that lists terminals for a display to
  prune against, reports an error (not an empty list) when the holder answers but no brain does
  (`brain_failed`, a `WELCOME` timeout, the reconnect window). Only "nothing listens" is an empty
  namespace. Otherwise a brain restart would make the wall forget the names and spots of terminals
  that are still running.

### If the holder dies

Every master fd closes, the kernel hangs up each PTY, and every shell gets `SIGHUP`. The brain sees
the hold link close and exits; clients find nothing listening and report the namespace lost. This is
`tmux kill-server`. What makes it unlikely:

- **Little code, and no untrusted input.** The holder parses no program output and no client JSON.
  Its peers are the brain (over a socketpair, with a fuzzed decoder) and, only while the brain is
  failed, connections it answers with a fixed `ERROR` without reading them.
- **One thread, bounded state.** A `poll` loop over the hold link, the signal pipe, the listening
  socket (only while failed) and timers. Memory grows only with the terminal table.
- **Its own cgroup scope** (Linux, below). systemd-oomd kills whole cgroups, so the holder, the
  brain and each shell get their own scope: oomd's choice falls on the brain (restartable) or one
  runaway shell, never on the holder. The brain also raises its own `oom_score_adj` by
  `brain_oom_score_adj` (300) above the holder's, so the kernel's OOM killer prefers it too. Without
  this, termd and every shell live in the cgroup of whatever started the relay (on the build
  machine, a terminal window's transient scope), and a kill of that scope, or of that window's
  scope by oomd, ends them all.
- **Signals.** It ignores `SIGINT`, `SIGQUIT`, `SIGTSTP` and `SIGPIPE`. `SIGHUP` retries the brain.
  `SIGTERM` stops the namespace (every shell dies), as `tmux kill-server` on `SIGTERM`.
- **It changes rarely**, and it changes by re-exec (below), never by a restart.
- **Panics abort.** Unwinding can't help a process whose death ends every shell; the panic is
  logged first.

### Versions between holder and brain

- The **hold protocol** (holder ↔ brain) is internal and versioned `[major, minor]` in its own
  hello. It uses the public frame header, JSON control payloads and fds in `SCM_RIGHTS` ancillary
  data. Minors only add messages and fields. A brain speaks exactly one major (no compatibility
  paths). A brain whose major differs from the holder's exits at hello and says so in the log; the
  holder treats it as failed.
- **Upgrading the holder** is a re-exec: `exec` keeps the pid, so the shells stay its children and
  the fds stay open. `g3d upgrade --holder` does a brain upgrade with the holder's re-exec in the
  middle: the old brain hands off into the store and exits, the holder writes its own record
  (terminals, fds, pids, exit statuses, the store's names, counters, instance id) to a memfd,
  runs the candidate binary once as `g3d-termd --check-holder-record <fd>` (it must parse the
  record before anything irreversible happens), clears `FD_CLOEXEC` on what it keeps and execs
  `g3d-termd --holder-resume <fd>`, which starts the new brain from the handoff. `g3d upgrade`
  without `--holder` refuses, naming `--holder`, when the candidate's hold major differs from the
  running holder's.
- **Snapshots** restore only into the exact same engine. **Handoff and holder records** are
  frozen formats with append-only fixtures.
- `WELCOME` reports the daemon (brain) version, the holder's version and hold protocol, the
  `instance` (the holder's random id, fixed for its life, re-exec included) and the brain's
  `generation` (1 for the first brain, +1 per start).

### Spawning a terminal

The brain decides what to run ([Environment](#environment)): the resolved argv, the full
environment and the working directory. The holder runs it, because only the parent can reap a child
and report its status, and only the parent can signal a pid without racing its reuse. For each
spawn, the holder (single-threaded, so `fork` is safe):

- opens a PTY with `posix_openpt`, `grantpt`, `unlockpt`, sets `FD_CLOEXEC` on the master (macOS's
  `posix_openpt` takes no `O_CLOEXEC`), opens the slave, then sets `IUTF8` and the size
  (`TIOCSWINSZ`) before the child starts. The slave is opened first because macOS answers
  `TIOCSWINSZ` on a master whose slave was never opened with `ENOTTY` (found on the M2);
- forks. The child first waits on a pipe while the holder moves it into a new transient systemd
  scope (Linux, below). Then, using only async-signal-safe calls: `setsid`, `TIOCSCTTY` on the
  slave, `dup2` onto 0/1/2, every signal disposition back to default and the mask cleared (an
  ignored signal stays ignored across `exec`, so a holder that ignores `SIGINT` would otherwise
  hand every shell a dead Ctrl-C), the soft `RLIMIT_NOFILE` back to its value at the holder's
  start (the holder raises its own to the hard limit; programs using `select()` break above 1024,
  so children get the original), close every fd above 2 (Linux: `close_range(3, ~0, 0)`; macOS,
  which has none: the list of the holder's open fds, taken just before the fork, which is exact
  because the holder is one thread; not a loop to `getdtablesize()`, which is 61,440 `fcntl`s on
  the M2), `chdir`, `execve` the resolved path. An exec
  failure reaches the holder through a close-on-exec pipe, and `create` fails with `spawn_failed`
  naming the errno;
- replies to the brain with the pid and a dup of the master fd; it keeps its own copy;
- reaps on `SIGCHLD` (`waitpid(-1, WNOHANG)` in a loop) and reports `exited {id, code | signal}`.
  It keeps the fd and the status until the brain, having read the PTY to EOF, releases the
  terminal; a brain that restarts in between still gets both.

Signals go through the holder: `kill` asks it to send `SIGHUP` (or the requested signal) to the
program's process group and the PTY's foreground group, it closes its copy when the brain releases
its own (the last close hangs up the PTY), and `SIGKILL` follows after `kill_grace` (2 s) if the
program outlives it. Resize (`TIOCSWINSZ`) and I/O stay in the brain, on its own copy of the fd.

### Linux and macOS

One design; the platform seams are `cfg`-gated modules with one interface each. The macOS column is
proven on darwin-arm64 (macOS 27.2, the M2): `cargo test --workspace`, `termd-relay-check` and
`wall-e2e` pass there.

| Seam | Linux | macOS |
|---|---|---|
| socket directory | `/run/user/<uid>/g3d` when that is the user's, else `/tmp/g3d-<uid>`: from the uid, never the environment | `/tmp/g3d-<uid>` (there is no `/run/user`); one rule, no `cfg` |
| shared memory for snapshots, records and `seq_marks` | `memfd_create(MFD_CLOEXEC \| MFD_ALLOW_SEALING)`, sealed after writing | `shm_open` of a random name + `shm_unlink` at once, `ftruncate` once (macOS sizes a shm object only once), then `FD_CLOEXEC`. Bytes go in and out through a mapping: macOS refuses `pwrite`/`pread` on a shm object (`ESPIPE`). Its size reads back rounded up to a page (16 KiB), so a blob's length is its header's (`blob::read`) |
| close-on-exec at creation | atomic everywhere (`pipe2`, `accept4`, `SOCK_CLOEXEC`, `MSG_CMSG_CLOEXEC`) | none of those: set right after creation (`g3d_hold::pipe`, the PTY master, the hold link). Exact in the holder (one thread). The brain starts one program, `defaults` (the locale), once at start, while it is one thread and after the handoff's fds are close-on-exec, and no other |
| closing fds in a child | `close_range` | the pre-fork list ([Spawning a terminal](#spawning-a-terminal)) |
| `TIOCSWINSZ` on a fresh master | works at once | `ENOTTY` until the slave is opened: open the slave first, on both |
| process RSS (status) | `/proc/<pid>/statm` | `proc_pidinfo(PROC_PIDTASKINFO)`; tests use `ps -o rss=` on both and fail loud when it can't measure |
| cgroup scopes | one transient scope per process role, via `StartTransientUnit` on the user manager (below) | none |
| OOM preference | brain raises `oom_score_adj` | none |
| process names | `PR_SET_NAME` | none (no `prctl`) |
| parent death | not used: the brain sees the hold link close; shells see their PTY hang up | the same, so nothing to port |
| `SCM_RIGHTS` receive | `MSG_CMSG_CLOEXEC` | no `MSG_CMSG_CLOEXEC`: the hold link sets `FD_CLOEXEC` right after `recvmsg`, in the holder and in the brain (no race: the row above) |
| peer credentials | `SO_PEERCRED` | `getpeereid`, which answers `ENOTCONN` once the client has closed (Linux still answers): such a connection is dropped without a log line |
| bytes queued on a PTY master (a read's bound, so the high-water mark is exact) | `FIONREAD` | `TIOCOUTQ` on the master: `FIONREAD` there answers 0 whatever is queued, which made every read and every `OUTPUT` frame one byte (floods about 50× slower; found on the M2) |
| errno in a forked child | `__errno_location` | `__error` |
| PTY buffer with no reader | 13.8 KB (measured) | 1,024 bytes (measured: the slave's write blocks past it) |
| canonical-mode line limit (`MAX_CANON`) | 4,095 bytes | 1,023 bytes: the excess and the line's end are lost (BEL per byte), so a canonical reader (`read`, `head -n1`, Python's `input()`) waits. Kernel line discipline: termd writes what it was given, documents the limit, and does not split. Raw-mode programs (line editors, vim, Claude Code) take input of any size (the M2's 256 KiB `INPUT` gate) |
| the session source (a creator with no environment) | the systemd user manager's environment, filtered to the allowlist | `launchctl getenv <name>` per allowlisted name (one `sh`, about 90 ms for 20 names), which holds what was `setenv`'d and the agents' sockets; plus the two a Mac session has that `getenv` never answers: `TMPDIR` as launchd gives every job (`confstr(_CS_DARWIN_USER_TEMP_DIR)`), and `LANG` from the user's `AppleLocale` when launchd has no locale (as Terminal.app, iTerm2 and Ghostty make it; tagged `AppleLocale`). Either platform falls back per name to the daemon's start value; see [Environment](#environment). Proven on the M2 (`tests/env.rs`' launchd test, read only, in a GUI session; the stripped-relay gate of `termd-relay-check`; `launchctl setenv` reaching the next create, by hand) |
| `PATH` when the base has none | `/etc/login.defs`' `ENV_PATH`, else `/usr/local/bin:/bin:/usr/bin` (util-linux `login`) | `/usr/bin:/bin` (`login`'s `_PATH_DEFPATH`) |
| default locale when none is set | `C.UTF-8` | the `AppleLocale` preference `.UTF-8`, else `C.UTF-8` |
| Option on a Mac keyboard (a browser client) | no Option key | the browser resolves Option into `text` (`å`, `altKey` set); termd's encoder runs with `macos-option-as-alt` true and counts Alt as consumed by the text: `å` in legacy and Kitty-disambiguate modes, as Ghostty's default types it; Kitty all-keys and modifyOtherKeys 2 differ from Ghostty's default (MACOS.md, "Keys and paste"), open |

**cgroup scopes (Linux).** The normal practice for terminals: Ghostty moves each surface into
`app-ghostty-surface-transient-<pid>.scope`, VTE each child into `vte-spawn-<uuid>.scope`, and
tmux (built with systemd, as on the build machine) each pane into `tmux-spawn-<uuid>.scope` while
its server stays in its starter's scope. termd does the same for every process it starts:
`app-g3d-termd-holder-<pid>.scope` (the holder moves itself at start), `app-g3d-termd-brain-<pid>.scope`
and `app-g3d-termd-term-<pid>.scope` per program. The holder calls the user manager's
`StartTransientUnit` (with `PIDs=[pid]` and `CollectMode=inactive-or-failed`, so an emptied scope is
collected) through `busctl --user call`, systemd's own client, so the holder links no D-Bus library.
The child waits on its pipe until the move is done, which avoids the race tmux users hit when a
short-lived pane exits before its scope registers. Failure is soft, as Ghostty's default
(`linux-cgroup-hard-fail = false`): logged once, shown in the status stream, and the spawn goes on.
`cgroup_scopes = "auto" | "off"`; `auto` uses them when the user manager answers.

## Environment

**A new terminal carries its creator's environment. A creator with none gets the desktop
session's.** One rule on both platforms; the session's source is the only platform difference.

- A caller with a shell (`g3d new`, any CLI client) sends its environment with `create`
  (`env_base`), and that is the base: a terminal started from your shell behaves like a subshell,
  the multiplexer convention (screen, dtach and abduco, zellij, tmux's first session).
  `g3d new --clean` asks for the other rule.
- A creator with no shell (the wall's "+ terminal", the relay, agents, tests) sends none, and the
  base is the desktop session's: start empty, copy an allowlist of names, each looked up afresh at
  every `create` in the platform's session source (Linux: the systemd user manager; macOS:
  `launchctl getenv`), a name the source lacks taking the daemon's start value for that name only.
- **The daemon's own start environment is never a base.** Nothing about who started termd leaks
  into terminals. That was S1's defect: its programs inherited whatever process first started the
  daemon (a relay started from a dev shell handed every terminal that shell's virtualenv, its
  editor's IPC sockets, a `DISPLAY` from whenever it started; on the M2, Terminal.app's
  `TERM_PROGRAM=Apple_Terminal` and Rex's per-tab `REX_SESSION`/`REX_BLOCK`).

### What others do

- **Ghostty** (its `termio/Exec.zig` and apprt sources, vendored here): starts from its own
  process environment; on Linux removes what a desktop launch or systemd added
  (`GIO_LAUNCHED_DESKTOP_FILE[_PID]`, `DBUS_STARTER_*`, `INVOCATION_ID`, `JOURNAL_STREAM`,
  `NOTIFY_SOCKET`, its own GTK debug variables); removes `VTE_VERSION` "so children don't think
  they're under VTE"; sets `TERM`, `COLORTERM=truecolor`, `TERM_PROGRAM=ghostty`,
  `TERM_PROGRAM_VERSION`, and `PWD` to the working directory (as Konsole and kitty do, so a
  symlinked path keeps its name). `TERM=xterm-ghostty` only when its terminfo is found (it sets
  `TERMINFO` to its bundled copy), else `xterm-256color`. Its `+ssh` helper installs the terminfo
  on a remote host and otherwise falls back to `xterm-256color`, because "almost every system knows
  `xterm-256color`". The shell is `$SHELL` only when launched from a CLI, else the passwd entry;
  the working directory is home for a desktop launch. On macOS every terminal is a login shell
  through `/usr/bin/login -flp <user>` (with `-q` when `~/.hushlogin` exists), because macOS users
  keep their setup in `~/.bash_profile`; it also sets `LANG` from the system locale when it is
  unset. It sets `IUTF8` on every PTY ("NOT on by default on macOS"; on the build machine it is not
  on by default on Linux either).
- **tmux** (3.8 here): the server copies its start environment into a global environment; each
  session's environment comes from the client named in `update-environment` (default `DISPLAY
  KRB5CCNAME MSYSTEM SSH_ASKPASS SSH_AUTH_SOCK SSH_AGENT_PID SSH_CONNECTION WAYLAND_DISPLAY WINDOWID
  XAUTHORITY XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP XDG_SESSION_TYPE`), re-read at every attach for
  *new* windows only. `default-command` empty starts a **login** shell from `default-shell` (`$SHELL`,
  else `getpwuid`, else `/bin/sh`). It sets `TERM` from `default-terminal` (`tmux-256color`),
  `TERM_PROGRAM=tmux`, and `TMUX`. Running panes keep stale values, which tmux users work around by
  re-reading `show-environment -s` from a shell hook.
- **shpool**: `forward_env` copies `TERM`, `DISPLAY`, `LANG`, `SSH_AUTH_SOCK` from the attaching
  shell into **new** shells only; `SSH_AUTH_SOCK` becomes a per-session symlink re-pointed at each
  attach; `/etc/environment` is read; the initial `PATH` copies OpenSSH's; the default directory
  is home.
- **hexe**: a session's environment is captured from the shell that opened it and re-captured on
  every attach, for new panes; running panes keep theirs, "because a running process's environment
  cannot be rewritten from outside".
- **The Linux session.** PAM (`pam_systemd`, `pam_env`) sets up the login session; the systemd user
  manager's environment comes from `environment.d` plus what the desktop imports into it
  (`systemctl --user import-environment`, `dbus-update-activation-environment --systemd`). On the
  build machine (KDE Plasma, Wayland) it holds `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`,
  `DBUS_SESSION_BUS_ADDRESS`, `XDG_SESSION_*`, `XDG_CURRENT_DESKTOP`, the locale and the profile's
  variables. Units, and D-Bus-activated terminal servers such as GNOME Terminal's, start from it.
  `systemctl --user show-environment` prints it; reading it as JSON takes 11 ms with `busctl`.
- **mosh** refuses to start without a UTF-8 locale and passes the client's `LANG`/`LC_*` to the
  server. Debian's OpenSSH sends and accepts `LANG LC_*`.
- **A new session from a shell carries that shell's environment** in the multiplexers: screen and
  dtach/abduco fork the session from the client that asked, so its environment is the client's;
  zellij's server takes the environment of the client that starts a session; tmux's server copies
  its start environment (the first client's, which started it) into the global environment every
  session starts from. termd is long-lived and shared like tmux's server, so it gets the client's
  environment per `create`, not once at its own start.
- **A session built from nothing** in `login(1)`, `sshd` and sudo's `env_reset`: they clear the
  environment (login keeps only `TERM`; sudo keeps a short `env_keep` list), then set `HOME`,
  `SHELL`, `USER`, `LOGNAME` from passwd and a minimal `PATH` (`login.defs(5)`' `ENV_PATH`, read by
  shadow's and util-linux's `login`; macOS `login`'s `_PATH_DEFPATH`); the login shell's profile
  brings back the rest. termd's no-caller base is that, plus the desktop session's handles.
- **The session's handles, fresh**: `systemctl --user show-environment` (or busctl's read of the
  manager's `Environment`) on Linux; on macOS launchd holds the GUI session's variables, which
  `launchctl getenv NAME` reads one name at a time (`launchctl setenv` is how a person sets one for
  every GUI app). tmux's `update-environment` re-reads its list from the attaching client for the
  same reason: the handles change at each login.
- **`environment.d(5)`**: `NAME=value` lines with `${NAME}` (and `${NAME:-default}`,
  `${NAME:+alt}`) expanded from what came before, no shell; termd's `set` takes `${NAME}` only.
- **docker run `-e NAME`** passes the caller's `NAME`; `-e NAME=value` sets it. `g3d new -e`
  follows it.
- **The daemons that start shells** (from source, read by the macOS agent): tmux, WezTerm's mux
  server and shpool all start the default shell as a **login shell by argv0 `-<basename>`**, on
  every platform. WezTerm and shpool take the shell from the passwd entry (WezTerm drops `$SHELL`
  as possibly stale); WezTerm sets `TERM_PROGRAM=WezTerm` and removes `OLDPWD PWD SHLVL` (and by
  default the SSH variables, `mux_env_remove`); shpool starts from `env_clear()`.
- **macOS terminals**: Terminal.app, iTerm2 and Ghostty all start a login shell through
  `login -fpl <user>`, take the shell from passwd (via `login`), set their own `TERM_PROGRAM` and
  fill an unset `LANG` from the system locale.
- **Measured on macOS 27.2 (the M2)**, an interactive zsh's `env` in three cases. Terminal.app's
  shape (launchd's environment, then `login -pfl`): `PATH` from `path_helper` (`/etc/paths`,
  `/etc/paths.d`) plus `~/.zprofile` (Homebrew's `shellenv`), and `LANG=C.UTF-8`, which this macOS's
  `/etc/zprofile` sets when unset. S1 termd started with launchd's environment (a LaunchAgent, or
  anything a GUI app starts): a non-login shell, so `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` plus
  `.zshrc` (no Homebrew, no `paths.d`), and **no `LANG`**, so `locale charmap` is `US-ASCII` and zsh
  shows typed non-ASCII as `<…>` escapes. S1 termd started from a Terminal.app shell: that shell's
  everything, including `TERM_PROGRAM=Apple_Terminal`, so Apple's `/etc/zshrc` sources
  `/etc/zshrc_Apple_Terminal` and every termd shell installs Terminal.app's OSC 7 hook and (with
  its `TERM_SESSION_ID`) shares one Terminal tab's `~/.zsh_sessions` history. The same identity
  leak happens on Linux from Ghostty, Konsole or VS Code. `ssh-add -l` and the login keychain
  (`security find-generic-password`) work from a daemon inside the GUI session.

### The policy

A terminal's environment is built per `create`, in this order (later wins). Each variable keeps
the layer that set it, which `env` answers ([Seeing it](#seeing-it-g3d-env)).

| Layer | What | Why |
|---|---|---|
| 1. Base | **A caller's** (`create.env_base`, tag `caller`): its environment, as sent. **A creator with none** (tag `session`): start empty; copy the allowlist (`SESSION` in `env.rs`), no wider than the locale (`LANG`, `LC_*`) and the session's handles (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `XDG_SESSION_*`, `XDG_CURRENT_DESKTOP`, `SSH_AUTH_SOCK`, `TMPDIR`); `termd.toml`'s `pass` adds names and `drop` removes them. Each name is looked up at this `create` in the session source: **Linux**, the systemd user manager's environment (`busctl --user --json=short get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Environment`, filtered to the allowlist; via `systemd-user`); **macOS**, `launchctl getenv <name>` for each (one `sh` running them all; a prefix is asked as the names the daemon's start environment and POSIX's locale and XDG names give it; via `launchd`), `TMPDIR` as launchd gives each job (via `launchd`) and, when launchd has no locale, `LANG` from `AppleLocale` (via `AppleLocale`). **A name the source lacks takes the daemon's start value, for that name only** (via `daemon`), except the locale, which is one group: when the source has any of `LANG`, `LANGUAGE`, `LC_*`, none comes from the start values (a starter's `LC_ALL=C` under the session's `LANG` would make every terminal ASCII). A source that doesn't answer leaves every allowlisted name to the start values, warned. The account (`HOME`, `USER`, `LOGNAME`, `SHELL`) and `PATH` are the fill's (layer 3), not looked up | The multiplexer convention for a caller; `login(1)`'s for a creator with none, plus the desktop's handles fresh at every `create`, so a new terminal never carries a stale `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` or `SSH_AUTH_SOCK` (the desktop re-imports them at each login). An allowlist, because the daemon's starter is an accident (an agent's shell carries `GIT_EDITOR=true`, an IPC token and its session ids; a shell tool its session id; a unit its cgroup's pressure file) and so is whatever someone imported into the user manager (an argument-less `systemctl --user import-environment` from a terminal imports that terminal's everything): no denylist names all of it. The per-name fallback keeps a session handle the source doesn't hold (a headless host's user manager has no `DISPLAY`; an SSH-forwarded agent is only in the starter's) without making the starter the base. Because every allowlisted name falls back so, the list holds only the session's own handles: a name that is the person's rather than the session's (`TZ`, the proxies, `XDG_CONFIG_HOME` and the other base directories, `KRB5CCNAME`, `LANGUAGE`) is absent from the Linux user manager, so it would always come from whoever started the daemon (a harness's scratch `XDG_CONFIG_HOME` reaching every wall terminal, the hazard the passwd fill exists for); the login shell's profile sets those, as after `login(1)`, and `pass` brings one back. macOS's `__CF_USER_TEXT_ENCODING` and `COMMAND_MODE` are left off too, measured on the M2: CoreFoundation sets the first itself as a program loads it (from the uid and `~/.CFUserTextEncoding`, the same value launchd gives), and `pbcopy`/`pbpaste`, `defaults` and `open` with non-ASCII text are byte-identical with and without it; compat(5)'s default for the second is `unix2003`, and `ls`, `ps`, `pr` and `mv` behave the same unset as with it (MACOS.md). The status stream names the source |
| 2. Scrub | best effort: remove what points back at the creator's tab or process: another terminal, multiplexer, editor or agent (`TMUX`, `TMUX_PANE`, `STY`, `WINDOW`, `ZELLIJ*`, `VTE_VERSION`, `KONSOLE_*`, `ITERM_*`, `TERM_SESSION_ID`, `KITTY_*`, `WEZTERM_*`, `ALACRITTY_*`, `GHOSTTY_*`, `WT_SESSION`, `TERMINAL_EMULATOR`, `REX_*`, `VSCODE_*`, `NVIM`, `INSIDE_EMACS`, `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`, `TERM`, `COLORTERM`, `TERM_PROGRAM*`, `TERMINFO`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`, `COLORFGBG`, `WINDOWID`, `SHELL_SESSION_ID`, `TERMCAP`, GNOME Terminal's `GNOME_TERMINAL_*`, Windows Terminal's `WT_PROFILE_ID`, Tilix's `TILIX_ID`, Terminator's `TERMINATOR_*`, vim's `:terminal` `VIM_TERMINAL` and `VIM_SERVERNAME`, older Neovim's `NVIM_LISTEN_ADDRESS`); the creator's own terminal device (`SSH_TTY`, `GPG_TTY`); the app and launchd job that started it on macOS (`__CFBundleIdentifier`, `XPC_SERVICE_NAME`); launcher and unit state (systemd.exec(5)'s list: `INVOCATION_ID`, `JOURNAL_STREAM`, `NOTIFY_SOCKET`, `LISTEN_*`, `MANAGERPID`, `MANAGERPIDFDID`, `MAINPID`, `SYSTEMD_EXEC_PID`, `WATCHDOG_*`, `MEMORY_PRESSURE_*`, the `*_DIRECTORY` names, `FDSTORE`, `PIDFILE`, `TRIGGER_*`, `MONITOR_*`, `SERVICE_RESULT`, `EXIT_CODE`, `EXIT_STATUS`; and `DBUS_STARTER_*`, `GIO_LAUNCHED_DESKTOP_FILE*`, the startup tokens `DESKTOP_STARTUP_ID` and `XDG_ACTIVATION_TOKEN`); the parent shell's own state (`SHLVL`, `OLDPWD`, `PWD`, `_`, `COLUMNS`, `LINES`, atuin's per-shell `ATUIN_SESSION`, `ATUIN_HISTORY_ID`, `ATUIN_SHLVL`); termd's own controls (`G3D_TERMD_*`). Applies to both bases. Unlisted variables ride along | Ghostty's and WezTerm's lists plus the multiplexers' and editors' own markers, and the macOS agent's (iTerm2's `LC_TERMINAL*` is named `LC_` so that `ssh`'s `SendEnv LC_*` carries it; Terminal.app's `SHELL_SESSION_ID` keys its per-tab history; Rex's `REX_SESSION`/`REX_BLOCK` name its tab and block). A leaked `TERM_PROGRAM` makes Apple's `/etc/zshrc` install another terminal's integration (measured). A leaked `TMUX` makes programs talk to a tmux that isn't theirs; a leaked `VSCODE_IPC_HOOK_CLI` or `NVIM` points `code`/`nvim` at a dead socket; a leaked `CLAUDECODE` makes Claude Code think it is nested, and its `CLAUDE_CODE_MESSAGING_TOKEN` is a live IPC credential; a leaked `ATUIN_SESSION` makes every shell share the creator's history session (atuin's settings, `ATUIN_CONFIG_DIR` and the like, are the person's and ride along); a leaked `COLUMNS` overrides the real size; a startup token is single-use; `SSH_TTY` names the creator's terminal, and `GPG_TTY` sends pinentry there; a leaked `GNOME_TERMINAL_SCREEN` makes `gnome-terminal --tab` open its tab in the creator's window (Tilix's, Terminator's and Windows Terminal's ids the same), a leaked `VIM_SERVERNAME` or `NVIM_LISTEN_ADDRESS` sends `--remote` edits to the creator's editor, and screen's per-window `TERMCAP` describes screen, not this terminal. `TERMINFO` is set by kitty and Ghostty for their own children; a user's own terminfo goes in `~/.terminfo` or `TERMINFO_DIRS`, which a caller's base carries and a profile sets. A convenience, not the safety mechanism (the no-caller allowlist is): tmux and screen remove only their own markers and pass the rest. The list is a constant in code (`SCRUB` in `env.rs`); `--env-scrub` adds names and `termd.toml`'s `pass` exempts them (a name, or a prefix ending in `*`). A request's `env` may set any name but layer 6's |
| 3. Fill | where the base has none (empty is none): `HOME`, `USER`, `LOGNAME` from `getpwuid` (via `passwd`); `PATH` as `login(1)` sets it (via `login`); `LANG` when no locale is set ([Locale](#locale); via `locale`). And `SHELL`, always: the shell chosen ([below](#the-shell-and-login-or-not); via `passwd`, `setting`, `base` or `default`) | What `login(1)` provides. A caller's own `HOME` or `PATH` is its subshell's and stays; a creator with none gets passwd's whatever the daemon's starter had (a test harness's overridden `HOME` would send every login shell to the wrong dotfiles) |
| 4. File | `termd.toml`'s `[env.set]` ([below](#the-config-file-termdtoml)) | A person's own names for every terminal, without a profile |
| 5. Request | the `create` request's `env` (validated, below); `null` removes; `g3d new -e` | The caller knows what this terminal is for |
| 6. termd's own | `TERM`, `COLORTERM=truecolor`, `TERM_PROGRAM=g3d-termd`, `TERM_PROGRAM_VERSION=<version>`, `G3D_TERMD_ID=<id>`, `G3D_TERMD_SOCKET=<socket>`, `PWD=<cwd>` | They describe this terminal, so nothing else may set them |

`g3d` run inside a termd terminal reaches that terminal's daemon through `G3D_TERMD_SOCKET` when no
`--ns`/`--socket` is given, as tmux's client finds its server through `TMUX`.

**Running shells are never rewritten.** No mechanism pushes new values into live terminals, and
termd keeps no per-namespace environment that `create` mutates (each terminal's tagged record is
what it started with, for `env`, never a source for the next). tmux's `update-environment` is the
convention rejected here: it changes the next window's environment, not the running ones, and the
fix it needs (a prompt hook that re-reads `show-environment`) is the workaround. A fresh base per
`create` makes new terminals right, and a running shell's environment is its own, as hexe says.

### The config file, termd.toml

`$XDG_CONFIG_HOME/g3d/termd.toml`, with `XDG_CONFIG_HOME` the session source's when it is an
absolute path (the XDG base directory spec ignores a relative one), else `~/.config` with the home
from passwd: never the daemon's starter's environment. Resolved once per brain; `--config PATH`
(`G3D_TERMD_CONFIG`) names another. Parsed with the `toml` crate:

```toml
[env]
pass = ["EDITOR", "MY_*"]   # add to the no-caller allowlist; also exempt from the scrub
drop = ["TMPDIR"]           # take off the no-caller allowlist
[env.set]                   # every terminal, layer 4
GOPATH = "${HOME}/go"
```

- `pass` and `drop` take a `NAME` or a `PREFIX*` (`*` alone is refused: it would make the daemon's
  start environment the base). They adjust the allowlist only, so a caller's base is untouched
  (but for `pass`'s scrub exemption). On macOS a prefix passes the names the daemon's start
  environment holds: `launchctl getenv` takes exact names.
- `set` values take `${NAME}` and nothing else (no shell, no `$NAME`, no defaults), each from the
  environment as layers 1 to 3 left it; an unset name is empty (environment.d's rule). A layer-6
  name is refused.
- **Re-read on `create` when it changes** (its mtime, size or inode), so an edit reaches the next
  terminal without restarting anything; read nowhere else.
- **A bad file fails the create loudly**: `spawn_failed`, naming the file and the line (`termd.toml
  <path>: line 4: set TERM: termd's to set, …`), every `create` until it is fixed. A broken policy
  silently ignored would hand out environments the person didn't ask for; the status document's
  `daemon.env.config` (`state: "error"`, the `error`) and a warning say it until then.
- **termd logs its policy once at brain start**: the allowlist after the file, the source, the
  extra scrub, and the file (`none at <path>`, what it sets, or its error); and the file again
  whenever a `create` re-reads it.

### Seeing it: g3d env

`g3d env <id>` (the protocol's `env` op) prints the environment the terminal's program started
with, each variable tagged with its layer: `caller`, `session` (via `systemd-user`, `launchd`,
`AppleLocale` or `daemon`), `fill` (via `passwd`, `login`, `locale`, …), `file`, `request`, `termd`. termd keeps
that tagged list per terminal (a few KB, in the holder's record so it outlives a brain restart).
The status document's `daemon.env` says the policy's live state: the source, the config file and
the warnings.

### The shell, and login or not

- With no `argv`, the program is the user's shell: the passwd entry's shell (`getpwuid`, which on
  macOS reads the directory service, what `dscl . -read /Users/<user> UserShell` shows) when it
  names an executable, else the composed environment's `SHELL` when that is an absolute path to an
  executable, else `/bin/sh`. Whichever is chosen becomes `SHELL`, as `login(1)` sets it. The
  daemon setting `shell` (a path) overrides the passwd entry for a whole namespace.
  - Why passwd first: a daemon's `$SHELL` is whatever its starter had: an old value from before a
    `chsh`, or a `nix-shell`'s bash. The passwd entry is the account's truth, and a `chsh` takes
    effect at the next terminal without restarting anything. WezTerm's mux, shpool and Ghostty
    (outside a CLI launch) do the same; tmux's `$SHELL`-first order comes from a server started by
    the person's own shell, which a daemon started by a relay is not.
- **A login shell, on Linux and macOS: argv0 `-<basename>`** (`execve("/bin/zsh", ["-zsh"])`),
  the POSIX login convention that `login(1)` itself uses and every shell honours. This is what
  tmux, WezTerm's mux server and shpool do, the daemons that start shells, on every platform.
  - Why: termd is a daemon, and what it starts must not depend on who happened to start it (the
    macOS agent's third defect). The login shell runs the system's and the user's profile every
    time: on macOS `/etc/zprofile` runs `path_helper` (`/etc/paths`, `/etc/paths.d`) and fills
    `LANG`, and `~/.zprofile` holds Homebrew's `shellenv`; on a headless Linux host it is the only
    place the profile's `PATH` comes from. Every SSH login is a login shell too, so people's
    dotfiles already work this way.
  - The cost on a Linux desktop, where the session base already carries the profile: the profile
    runs a second time, and a profile that prepends without checking repeats `PATH` entries. That
    is cosmetic (the same entries, the same order of precedence), and many profiles guard against
    it (Arch's `/etc/profile` `append_path`, zsh's `typeset -U path`). A missing `PATH` entry, the
    failure a non-login shell gives on a headless host or under launchd, breaks commands. The
    lesser footgun wins. `login_shell = false` restores the Linux desktop terminals' non-login
    habit for a person who wants it.
  - Not `login -flp` (Ghostty's, Terminal.app's and iTerm2's macOS form): `login(1)` opens a login
    *session* (a utmp entry, `setlogin`, a PAM session, a "Last login" banner unless
    `~/.hushlogin`), which a GUI terminal window is and a daemon's terminal is not. The argv0 form
    gives the shell the same login behaviour without those.
- An explicit `argv` runs as given, never as a login shell and never wrapped, on both platforms. A
  caller that wants a login shell sends no `argv`.
- `argv[0]` without a slash is looked up in the composed environment's `PATH` (`execvpe`
  semantics: an empty or relative entry is the program's working directory), not the daemon's.
- **The relay sends no `argv`** for a plain new terminal (S1's `cli/attach.go` sends its own
  `$SHELL`, which bypasses all of the above), and `g3d new` sends none unless given a command.
  The daemon is the one place that knows the user's shell.

### TERM and friends

`TERM=xterm-256color`, `COLORTERM=truecolor`, and termd's emulator answers terminfo queries as
`xterm-256color` (`set_terminfo_name`). `TERM` names what parses the bytes, and in raw mode that is
downstream of termd: xterm.js in the browser today, or whatever terminal `g3d attach` runs in.
`xterm-ghostty` would invite sequences (Kitty keyboard, Kitty graphics) those parsers don't take,
and `ssh` carries `TERM` to hosts that lack its terminfo, which is the classic footgun Ghostty's own
`+ssh` helper exists to patch. `xterm-256color` is the fallback Ghostty itself chooses whenever the
terminfo is uncertain. At S3, when the browser draws termd's cells and termd is the only parser,
`TERM` is reconsidered under Ghostty's rule (ship the terminfo, set `TERMINFO`, fall back to
`xterm-256color` across `ssh`). `term` (daemon setting) changes it for a whole namespace; a
`create` cannot, because the emulator's answers have to match it.

`TERM_PROGRAM=g3d-termd` with its version, as tmux sets `TERM_PROGRAM=tmux`: programs that key
behaviour on `TERM_PROGRAM` (Claude Code, Neovim) then see an honest unknown terminal instead of the
starter's (`ghostty`, `vscode`), whose features the browser may not have.

### Locale

`LANG`, `LANGUAGE` and `LC_*` come from the base (a caller's; or the session's `LANG` and `LC_*`, taken as one group), the
config file and the client's `env`. When the
composed environment sets **none** of `LC_ALL`, `LC_CTYPE` and `LANG`, termd fills `LANG`:

- macOS: `<language>_<region>.UTF-8` from the user's locale (the `AppleLocale` preference, as
  Ghostty, iTerm2 and Terminal.app read it) when that locale is installed, else `C.UTF-8`;
- Linux: `C.UTF-8`.

The brain checks at start that the value loads (`newlocale(LC_CTYPE_MASK, …)`); if it doesn't, it
fills nothing and says so. `C.UTF-8` is built into glibc since 2.35, into musl, and into this
macOS (whose own `/etc/zprofile` sets it), so it is a locale the system has, not an invented one.
Filling matters for programs given as `argv` (no profile runs) and for a base with no locale (a
session source without one, a caller started from `env -i`); without
it the C locale is ASCII, and for a terminal that draws glyphs, an ASCII locale is the worst
default (zsh shows typed non-ASCII as `<…>` escapes; measured on the M2).

"Set" means non-empty, and a request whose `env` (or `termd.toml`'s `set`) names `LC_ALL`,
`LC_CTYPE` or `LANG` (even to remove it) has chosen, so nothing is filled.

A locale that **is** set is the person's choice and is never changed, even when it isn't UTF-8:
the terminal starts, and the status stream carries an environment warning. mosh refuses to start
in that case; a terminal that refuses to open is worse. `fill_locale = true` is a setting.

### SSH agent, display and bus variables

On a systemd desktop, `SSH_AUTH_SOCK` (when an agent runs), `DISPLAY`, `WAYLAND_DISPLAY` and
`DBUS_SESSION_BUS_ADDRESS` (`unix:path=$XDG_RUNTIME_DIR/bus`) are stable per login and come from
the session source, fresh at each no-caller `create`. The staleness tmux users hit comes from a
server that outlives the session it captured; here only running shells can hold old values, and
they are theirs.

A caller's terminal has the caller's own: `g3d new` from an SSH login hands the terminal that
login's agent socket, `DISPLAY` and `SSH_CONNECTION`, as `screen` or tmux's first session would,
and from a tmux pane below an old login, that pane's (possibly dead) ones, as a subshell there
would have. `g3d new --clean` is the way to the session's fresh values. A forwarded agent socket
dies with its SSH session, as in tmux; shpool's per-session symlink is the known remedy and is not
built while termd serves a local desktop.

Platform note, macOS: there is no user manager; launchd is the session source (`launchctl getenv`
per name, with `TMPDIR` and the locale as above; proven on the M2). launchd's `SSH_AUTH_SOCK` lives as long as the GUI login;
the login keychain is reachable from a daemon inside the GUI session (measured). A daemon first
started from an SSH login lives in that login's audit session, where the keychain is locked
(reported, not measured). termd is therefore started inside the GUI session: by the relay or a
Terminal shell today, and by a LaunchAgent in `gui/<uid>` (shpool's Homebrew service is one) if it
ever has to start on its own. Neither the start environment (never a base) nor the scrub lets a
Terminal-started daemon hand out Terminal.app's identity.

### Working directory

`create.cwd` when given (absolute, an existing searchable directory; anything else is
`bad_request` with the errno: a client that wants a fallback chooses it). Otherwise the account's
home directory from `getpwuid` (a new window opens at home, as Ghostty, shpool and Linux terminals
do), never the daemon's own (`/`); `/` only when that home doesn't exist, as `login(1)` does. `PWD` is set to it. The relay passes its served root when
`serve` has one and nothing otherwise; its own working directory says nothing about where a person
wants a shell.

### termios

`IUTF8` is set on every PTY before the program starts (Ghostty's practice; off by default on
Linux, measured here, and on macOS), so the kernel's line editor erases a whole UTF-8 character on
backspace in canonical mode (`cat`, `read`, password prompts). The rest stays the platform's
default (`VERASE` = `^?`, matching what the browser's key encoding and xterm send). Platform note:
macOS's bundled ncurses describes `xterm-256color` backspace as `^H`; the macOS agent checks
`kbs` against what the browser and `g3d attach` send.

### What a client supplies at `create`, and how it is checked

- `env`: names match `[A-Za-z_][A-Za-z0-9_]*`; values contain no NUL and are at most 128 KiB each
  (Linux's `MAX_ARG_STRLEN`); argv plus environment total at most the host's `ARG_MAX`. A violation is
  `bad_request` (or `too_large`) naming the variable. The layer-6 names are reserved: setting or
  removing one is `bad_request` (the terminal's type and identity are termd's to state).
- `env_base`: the caller's environment, `{name: value}`, under the same name and size rules (its
  own `TERM` or `PWD` may be there; layer 6 replaces them). Absent: the creator has none, and the
  base is the session's. `{}`: an `env -i`-like terminal (the fill and termd's own only), for
  hermetic tests and agents that want nothing inherited.
- `cwd`, `argv` as above. The `create` reply reports the `argv` actually run (the resolved path
  first), `login` (whether it was started as a login shell) and the `cwd`.

Tests always use a caller's `env_base`, a daemon with `--env-source daemon`, or the session
stand-in (a test hook), and a scratch `--config`, so a test terminal never picks up the real
desktop session's environment or the person's `termd.toml` (one read-only test reads the real user
manager, into a terminal running `sleep`).

### Rejected, and why

- **Inheriting the starter's environment** (S1): the environment of whatever started the daemon
  is an accident, and it stays for the daemon's whole life. Not even as a fallback base: only an
  allowlisted name the session source lacks takes its start value.
- **The session's base for a caller, with SSH variables forwarded only from a live login** (the
  termd-ready build's `g3d::forward`: `SSH_CONNECTION` set and fds 0 to 2 on the login's own
  `SSH_TTY`): a heuristic about which of the caller's variables are fresh, where the multiplexers'
  convention is that a new session from a shell is that shell's. The caller's environment is the
  base; `--clean` is the explicit way to the session's.
- **`--env-keep` beside `termd.toml`'s `pass`**: two ways to name the same allowlist addition.
- **`update-environment`-style session environments**: they make the next window right and the
  running ones silently wrong, and need a shell-hook workaround.
- **A non-login default shell**: what Linux desktop terminals do, because their session already
  ran the profile. termd's base doesn't always have (launchd, a headless host, a no-caller base's
  login(1) `PATH`, an empty caller), and the result is a missing `PATH` and an ASCII locale (both
  measured on the M2).
- **`login -flp` from a daemon**: opens a login session (utmp, `setlogin`, PAM, a banner) for
  something that isn't one; argv0 `-<shell>` is the daemons' form.
- **`$SHELL` before passwd**: a daemon's `$SHELL` is its starter's, and outlives a `chsh`.
- **`TERM=xterm-ghostty` now**: breaks over `ssh` and promises the browser's parser things it
  can't parse.
- **Inventing a locale**: termd fills only `C.UTF-8` (or the macOS user's own locale), only when
  nothing is set, and only after checking it loads; a guessed `en_US.UTF-8` can name a locale the
  system doesn't have, and perl and bash then warn at every start.

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
  `modes` reports and emit an event if any changed. A new subscriber, and one that
  resyncs after a lag, gets the current `modes`, title and pwd as events. `vt_write` runs the effect
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
- The brain forks nothing: programs are started by the holder, which is single-threaded
  ([Spawning a terminal](#spawning-a-terminal)). An owner thread adopts the master fd the
  holder returns. The Pdeathsig trap in the plan (tokio's blocking pool retires the forking
  thread) can't arise, and pdeathsig isn't used.
- Each owner thread also saves its terminal for crash restore ([Screens after a
  crash](#screens-after-a-crash)) and publishes the counters the status stream reads.

## Bounded memory

| What | Bound |
|---|---|
| Primary-screen scrollback | `scrollback_bytes`, default 10,000,000 bytes (Ghostty's default), clamped to `max_scrollback` (default 64 MiB). Always set explicitly, never the library default. |
| Alternate screen | One screen, no scrollback (about one 400 KB page). |
| Idle history | After 30 s with no output, `compress(Incremental)` in steps until complete, restarted when `compression_activity` changes. Resident memory drops; contents don't change. |
| Unfinished input | `set_continuation_max_bytes(64 KiB)`. Needed for mid-sequence repaints. |
| Kitty images | `kitty_image_storage_limit` 0 in S1 (termd draws no images, and the browser can't either yet). |
| Per subscription | Every frame counts: output, repaints and events. Lossy queue 4 MiB, then drop everything droppable, queue nothing until the subscriber has read what is left, then one `lagged` + repaint (or `size`) + state. Blocking owner: pause PTY reads at 1 MiB, resume at 256 KiB; a `take` demotes it to lossy. BELs coalesce to one `bell` per read. |
| PTY input buffer | 16 MiB per terminal (whole frames accepted or refused). |
| Crash snapshots | two LZ4-compressed slots per terminal in memfds the holder keeps; about a tenth of the history's resident size on text (measured). The status stream reports the store's total. |
| Frames | 16 MiB payload. |

At the defaults, a terminal that has filled its history holds about 10 MB while it is busy and
about 1 MB once idle compression has run (measured on build-log text), plus one alternate page,
so 50 terminals with full histories cost about 50–100 MiB at rest and 500 MiB only if all of them
flood at once. S1's
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
- `TERM=xterm-256color`; why, and when it is reconsidered, is in [TERM and
  friends](#term-and-friends).
- `set_title_report_enabled(false)` (title reports are a known injection vector).
  Clipboard writes (OSC 52) are refused in S1: no handler is installed.

## Defaults

Every default termd has, with its reason and the prior art it follows. Each is a setting: the
daemon reads `$XDG_CONFIG_HOME/g3d/termd.toml` (`~/.config/g3d/termd.toml` when unset, on macOS
too, as Ghostty does) at start, flags override the file, and the brain re-reads the file at every
start, so `g3d upgrade` applies changes without ending a shell (phux applies `[defaults]` the same
way). The holder's own settings (`[holder]`) are read once when it starts. `g3d config` prints every
setting with its value, its default and where the value came from. Settings that apply per
terminal are fixed when the terminal is created. Until the file exists (not built yet), every
setting is a `g3d-termd` flag, named below, which the holder passes to each brain; what is built is
in [Environment and defaults as built](#environment-and-defaults-as-built-2026-11-12).

| Setting | Default | Decision | Reason and prior art |
|---|---|---|---|
| namespace | `default` | keep | tmux's socket name is `default` |
| socket | `/run/user/<uid>/g3d/termd-<ns>.sock` when that runtime directory is the user's; else `/tmp/g3d-<uid>/termd-<ns>.sock`; found from the uid, never `$XDG_RUNTIME_DIR` or `$TMPDIR`; `G3D_TERMD_DIR` overrides; directories checked (owner, `0700`) | **change** (built for the path; the directory checks are the macOS branch's) | the XDG base-directory spec puts sockets in the runtime directory (shpool, hexe, zmx do), which logind makes `/run/user/<uid>`; read from the uid rather than `$XDG_RUNTIME_DIR` because a starter without that variable must find the same socket (tmux's rule doesn't vary with the session either); the fallback is tmux's `/tmp/tmux-<uid>` and its ownership check. `$TMPDIR` made Rust and Go disagree and was too long for `sun_path` on macOS ([One daemon per namespace](#one-daemon-per-namespace)) |
| socket and lock re-stamp | every hour (`utimes`), by the holder | **new** (from the macOS branch) | `/tmp` cleaners (macOS `tmp_cleaner`, 3 days; systemd-tmpfiles, 10 days) delete untouched regular files, and a lost lock means two daemons on one namespace. tmux survives the same cleaners because its socket's mtime moves with activity |
| lock | `<socket>.lock`, left in place after exit | keep | a lock file outliving its holder is harmless with `flock`; it now holds the holder's pid |
| log | `$XDG_STATE_HOME/g3d/termd-<ns>.log` (`~/.local/state/…`), on Linux and macOS | keep | XDG puts logs in state. `~/Library/Logs` (where Console looks) was considered for macOS; one rule on both systems is worth more, as the macOS agent argued and as Ghostty keeps `~/.config` on macOS. The status document and `g3d status` print the path, so nobody has to know it |
| log size | rotate at 10 MiB, keep one previous file (`.log.1`); `--log-max-bytes`, 0 = never | **new** (S1 appends forever) | size-capped rotation is what logrotate and journald do; one previous file keeps the last crash's context |
| log line | `2026-11-12T15:25:13.751-06:00 holder[1230122] message` | **change** (S1: `[termd 1794518713.751]`, raw epoch seconds) | RFC 3339 is the normal form (journalctl's `short-iso-precise`, the relay's recordings use RFC 3339 too); local time with its offset reads at a glance and is still unambiguous. The role (`holder`/`brain`) and pid tell the two processes apart in one file. Values print as values: S1's `ended: code Some(0) signal None` becomes `ended: code 0` |
| idle exit | 300 s with no terminals and no connections but status followers; 0 = never | keep (status followers newly don't count) | it works: the `default` namespace started 15:25:13, its `hello-world` exited 15:25:27, and the daemon logged `exiting: no terminals and no connections for 300s` at 15:30:27 (the log, the socket gone, the lock left). tmux's `exit-empty` exits at once; the 5 min grace absorbs a relay restart, and an empty exit is when a new binary takes over |
| scrollback | 10,000,000 bytes per terminal (`create.scrollback_bytes`, `--scrollback`); clamp `--max-scrollback` 64 MiB | **change** (S1: 2 MiB, clamp 16 MiB) | 10 MB is Ghostty's own `scrollback-limit` default. 2 MiB held only ~1.6k rows of 120-column text (measured), less than tmux's `history-limit` of 2000 lines; 10 MB holds ~9.3k (VTE and Alacritty keep 10,000 lines). Idle compression keeps it cheap: a full 10 MB history went from 9.9 MB to 0.86 MB resident (measured, build-log text). The clamp guards against a runaway request, not taste |
| idle compression | after 30 s with no output | keep | libghostty's incremental compression; contents unchanged |
| lossy queue | 4 MiB per subscription (`--lossy-queue`) | keep, now a setting | about a second of a flood at the browser's pace; hexe's ring and payload cap are 4 MiB too |
| blocking owner | pause reads at 1 MiB queued, resume at 256 KiB (`--block-high`, `--block-low`) | keep, now a setting | high/low watermarks; the 4:1 gap avoids flapping |
| PTY input buffer | 16 MiB per terminal (`--input-buffer`); a whole `INPUT` frame is accepted or refused (`input_full`) | **change** (S1: 1 MiB) | hexe grows its PTY write buffer to 16 MiB "rather than dropping input": a torn bracketed paste (a lost `ESC [201~`) leaves the shell swallowing every later key. 16 MiB matches `max_frame`, so any one paste fits; the memory is used only while a program stops reading |
| max frame | 16 MiB | keep | |
| read chunk | 64 KiB | keep | one Linux pipe's worth; keeps a flood's per-read latency small |
| continuation | 64 KiB | keep | needed for mid-sequence repaints and snapshots |
| kill grace | `SIGHUP` (or the asked signal), then `SIGKILL` after 2 s | keep | a kill always ends; systemd's stop timeout (90 s) is for services, not a closed window |
| default colours, `cell_px` | the browser's palette; `[8, 16]` | keep | OSC 10/11 and `CSI 14 t` must answer without waiting |
| `TERM` | `xterm-256color` (`--term`; also the emulator's terminfo name, kept per terminal) | keep | [Environment](#environment) |
| detach | `Ctrl-\` twice (`g3d attach`; `--detach-key`, `G3D_DETACH_KEY`) | keep | dtach, abduco and zmx detach on `Ctrl-\`; pressing it twice keeps a single `Ctrl-\` (the program's `SIGQUIT`) one key away: the first press is held, any other key sends both. Platform note: on some non-US macOS layouts `\` needs Option, so the macOS agent checks it is typeable and the setting is the escape hatch |
| start wait | a client that starts the daemon retries for 3 s, 20 ms doubling to 250 ms | keep | |
| brain restart | 100 ms; at most 5 starts in 10 s; then 30 s doubling to 10 min | **new** | systemd's `RestartSec`, `DefaultStartLimitBurst` and `DefaultStartLimitIntervalSec` |
| refused connection linger (brain failed) | 2 s after the `ERROR`, at most 64 at once (`--brain-failed-linger-ms`, `--brain-failed-linger-max`) | **new** | an HTTP server's lingering close after an error response: long enough for any client to write `HELLO` and read; bounded so a connect storm costs fds, not memory |
| brain watchdog | 30 s; `SIGABRT`, then `SIGKILL` 5 s later | **new** | systemd's `WatchdogSec` / `WatchdogSignal` practice; generous so a loaded machine doesn't trip it |
| brain OOM preference | `oom_score_adj` +300 over the holder (Linux); `--brain-oom-score-adj` | **new** | the restartable process should be the one the kernel picks |
| most terminals | 8,192 per namespace (`--max-terminals`; the `seq_marks` page is 8 B each, 64 KiB) | **new** | far above any wall or desk; the page stays one small fixed allocation the holder never grows |
| cgroup scopes | `auto` (Linux, soft failure) | **new** | Ghostty, VTE and tmux put each child in its own scope |
| snapshot interval | 2 s, terminals with new output only, LZ4 (`--snapshot-interval-ms`, 0 = never) | **new** | bounds what a crash loses to two seconds of parsed output, at < 0.1% of an owner thread (measured) |
| upgrade deadline | 10 s for the candidate to report ready | **new** | |
| client reconnect | 100 ms doubling to 2 s, for 30 s (the relay: `serve --termd-reconnect`) | **new** | covers a crash restart plus the first crash-loop retries |
| environment base | a caller's own (`create.env_base`; `g3d new` sends its environment, `--clean` none); for a creator with none, the session's allowlist, each name fresh from the session source, else the daemon's start value for that name | **new** | screen, dtach/abduco, zellij and tmux's first session start a session from the asking shell's environment; `login(1)`, `sshd` and sudo's `env_reset` build one from a known set; [Environment](#environment) |
| session source | `auto` (the systemd user manager on Linux, launchd on macOS); `--env-source auto\|daemon`, `G3D_TERMD_ENV_SOURCE` | **new** | [Environment](#environment) |
| session source wait | 1 s per no-caller `create` (`--env-manager-timeout-ms`), then the daemon's start values, logged | **new** | the D-Bus call takes 11 ms here; a source that hangs must not hang a `create` for long |
| config file | `$XDG_CONFIG_HOME/g3d/termd.toml` (`--config`, `G3D_TERMD_CONFIG`), `[env]` `pass`/`drop`/`set`; re-read on change; a bad file fails creates | **new** | the XDG base directory spec (tmux's `~/.config/tmux/tmux.conf`, zellij's `~/.config/zellij`); environment.d's `${NAME}`; [The config file](#the-config-file-termdtoml) |
| default program | the passwd shell, as a login shell (argv0 `-<basename>`); `--shell`, `--login-shell true` | **change** (S1: the daemon's `$SHELL`, non-login; the relay sent its own `$SHELL`) | tmux, WezTerm's mux and shpool; [The shell, and login or not](#the-shell-and-login-or-not) |
| locale fill | `LANG=C.UTF-8` (macOS: the user's locale) only when no locale is set and it loads; `--fill-locale true` | **new** | Ghostty, iTerm2, Terminal.app, and this macOS's own `/etc/zprofile`; [Locale](#locale) |
| environment scrub | Ghostty's, WezTerm's and the multiplexers' identity, the creator's tab and process, launcher and parent-shell variables; `--env-scrub` adds, `termd.toml` `pass` exempts | **new** | [The policy](#the-policy) |
| `TERM_PROGRAM` | `g3d-termd` + `TERM_PROGRAM_VERSION` | **new** (S1 left the starter's) | tmux, WezTerm, Ghostty each name themselves; [TERM and friends](#term-and-friends) |
| default cwd | the account's home | **change** (S1: the daemon's, `/`) | [Environment](#environment) |
| status interval | 1 s (a follower may ask for 250 ms to 60 s: `--status-interval-ms`, `--status-min-interval-ms`, `--status-max-interval-ms`); keepalive 30 s (`--status-keepalive-ms`) | **new** | one push a second is what `top` and `htop` refresh at by default and what a person reads; 250 ms bounds a follower's cost at four documents a second; a 30 s keepalive is the relay's adapters' ride window and keeps gauges from going stale. [Status](#status) |
| status rate window | bytes over the last 5 s (`--status-rate-window-ms`) | **new** | the load-average idea at a human scale: long enough that a prompt's echo doesn't flicker the rate, short enough that a finished flood reads idle within seconds |
| recent errors | the last 32 distinct, with counts (`--status-errors`) | **new** | the page-side log storm brake's coalescing, applied to the daemon |
| relay status connection | ask termd for 1 s; look again every 5 s while nothing listens or the brain is failed; `restarting` reads `unreachable` after 5 s (`serve --termd-status-interval`, `--termd-status-redial`, `--termd-status-grace`) | **new** | a failed `connect` costs a syscall; 5 s is the holder's own failed-retry scale and long past a crash restart (100 ms) and an upgrade's handoff, so `unreachable` means something |
| wall restart notice | after 400 ms of restarting (`restartNoticeMs`); 3 errors shown (`errorsShown`); `wall.config` | **new** | a crash restart that returns in a blink shows only the chip (no flash); one that lingers is said in words. 400 ms is four times the crash restart measured here (about 100 ms from `SIGKILL` to a `WELCOME`, the 100 ms restart delay included, two terminals restored) and under the half second a person reads as "something is happening" |

## Status

The daemon publishes one status document that any client can render as it is: no client lists
terminals, then asks each one for its state, then polls. The shape is PROTOCOL.md's ["Status"
(1.1)](./PROTOCOL.md#status-11); this is how it is made and carried.

### In the daemon

- Each owner thread keeps its terminal's counters where the socket side can read them without a
  command round trip: `seq`, input bytes, flow state, title, size, the alternate screen, memory
  use (sampled on its own idle tick). The socket side already knows every subscription's queue,
  role and lag count. A status tick reads those; it never wakes an idle owner thread.
- Rates (`out_bps`, `in_bps`) are byte deltas over the last 5 s, sampled at each tick.
- The brain builds the document once per tick and sends the same bytes to every follower. One
  serialization serves every client, at any number of clients.
- A push happens when something changed since the last one, and no sooner than the follower's
  interval (default 1 s). "Changed" means any field except the sampled gauges (RSS, memory,
  rates) changed, or a rate crossed zero; while any terminal is producing output, every interval
  counts as changed so its rate stays live. When nothing happens, a keepalive every 30 s carries
  fresh gauges. A quiet daemon therefore sends nothing but keepalives.
- RSS of the holder and the brain comes from `/proc/<pid>/statm` on Linux and `proc_pidinfo` on
  macOS (a `cfg` seam).
- Recent errors are a ring of the last 32 distinct `(code, terminal)` pairs with first and last
  times and a count: owner-thread panics, spawn failures, `input_full`, lags, brain restarts and
  why, failed upgrades, environment warnings, cgroup-scope failures.
- `g3d status [--json] [--follow]` renders it in a terminal: a header (daemon, holder, brain), one
  row per terminal, the recent errors.

### Through the relay

The relay keeps one status connection per namespace, separate from its terminals' connections,
with `status_follow`. A status follower doesn't keep an empty daemon alive ([Lifetime](#lifetime)). It never starts the daemon to do so: it dials at start and, while nothing
listens, re-dials every 5 s (a failed `connect` costs a syscall). It pushes to the display a JSON-RPC
notification on the control plane:

```json
{"jsonrpc": "2.0", "method": "termd/status", "params": {
  "relay": {"state": "ok", "since": 1794519100000, "ns": "default", "bundled": "g3d-termd/0.2.0", "lacks": []},
  "status": { …the daemon's status event, without "ev"… }}}
```

- `relay.state`, from the relay's side of the socket:
  - `ok`: a brain answers;
  - `absent`: nothing listens, and the last document the relay had listed no terminals or said
    `exiting` (or it never had one). Normal: an empty namespace that left by idle exit;
  - `restarting`: a holder is there but no brain yet, or a planned restart, within 5 s;
  - `unreachable`: the same, past 5 s;
  - `failed`: the holder answered `brain_failed` (shells alive, frozen);
  - `lost`: the last document listed terminals, had no `exiting`, and now nothing listens (the
    holder died and its shells with it).
- `status` is the last document received, or `null` while none is current.
- A state change is pushed at once. Status documents pass through at the daemon's own cadence.
- The relay keeps the last notification and answers the display's `termd/status` request with it
  (a reloaded page renders at once), and the relay-resident verb `termd.status` answers the CLI
  and agents page-less (`./glyph3d-cli termd.status`), as `log.query` does.
- `relay.bundled` is the termd the relay ships with. When it differs from the running daemon's
  version, the window says so and names `g3d upgrade`; the relay never upgrades a daemon itself.
- `relay.lacks` lists the input ops (`key`, `paste`) the brain answering now doesn't offer (its
  `WELCOME.features`), `[]` when it has them or while no brain answers: the display's typing
  can't reach a brain that lacks them, so the wall's notice says so and names `g3d upgrade`.

S2's Rust relay carries the same notification byte for byte; its wire tape gains a scenario for it.

### In the app

A core model, `services/terminal/TermdStatus.js`, holds the last `termd/status` and answers
`state`, the document, and per-terminal lookups by id. The wall renders it first; the IDE's HUD can
render the same model later. The operator judges the look on the live display: what follows is the starting point, small and
quiet, with every number from the document.

- **The chip.** Beside the topbar's `● relay`: `● termd 4` (the terminal count). The dot is the
  relay chip's green when `ok`, a dim ring with `termd idle` when `absent`, amber when
  `restarting`, red otherwise.
- **The window.** Clicking the chip, the chord + S, or the verb `wall.status [toggle|open|close|left|right|float]`
  opens a small panel under the topbar in the topbar's own style (`#141821`
  panel, `#2a303c` border, `#c8ced8` text, `#6b7383` for anything secondary), monospace, about
  12 px, sized to its content:

  ```
  g3d-termd 0.2.0 · libghostty-vt 1.0.1 · ns default                    up 3h 12m
  holder 1230122 · 3 MB      brain 1230130 · gen 2 · 41 MB      1 restart: crash 14:02
  build log    bash     120×40   own · 2 watch    1.2 MB/s
  claude       claude   100×30   own              idle 12m        alt
  gx-alice     sh        80×24   own              blocked 1.4s
  14:02  brain crashed (SEGV); 3 screens restored from snapshot, 512 B unseen
  ```

  Names come from the wall (`WallNames`), the program from `argv[0]`'s basename. Amber marks only
  what needs attention (blocked, lagging, a recent error); everything else stays muted. Hovering a
  row shows its full argv, cwd, pid, title and subscribers.
- **The termd-lost notice.** Loud, and only when something is actually wrong: a single line
  centred under the topbar, red text on the panel colour, no icon, no animation.
  - `unreachable`: `termd not answering · 12 s · retrying`;
  - `failed`: `termd's engine is down (crashed 5× in 10 s) · shells are alive, frozen · run g3d
    upgrade`;
  - `lost`: `termd lost: the shells in namespace "default" are gone · a new terminal starts a
    fresh termd`.

  `unreachable` and `failed` clear themselves when the brain returns. `lost` stays until
  dismissed or a terminal is spawned. A planned upgrade, or a crash restart within 5 s, shows only
  the amber chip.

## Keys and paste (protocol 1.2)

Two kinds of client, two input shapes; not a dual path:

- **A client that is a terminal** (`g3d attach` in Ghostty, kitty, WezTerm, tmux) sends the bytes
  its own keyboard encoding made: `INPUT`. It shows the program's raw output, so it sees `CSI > 1 u`,
  `CSI > 4 ; 2 m`, DECCKM and mode 2004 as the program sets them and encodes keys and pastes to
  match. Shift+Enter in Claude Code through `g3d attach` works because Ghostty sends what the program
  asked for.
- **A client with keys and no terminal** (the browser: the wall and the IDE) can't know those
  modes when a key is pressed: its emulator learns them a relay hop and a frame later, and a mode
  read there is stale by the time the bytes land. It sends what it does know, the key event
  ([`key`](./PROTOCOL.md#key-12)) and the pasted text ([`paste`](./PROTOCOL.md#paste-12)), and termd
  encodes them on the terminal's owner thread, against the `Terminal` that has parsed every byte
  the program wrote before the key arrived.

Prior art: WezTerm's multiplexer protocol sends key events from the GUI to the mux server, which
encodes them against the remote pane's modes (`SendKeyDown`), not bytes; phux keeps key input
structured to its server for the same reason; xterm, Ghostty and kitty are the encoders a program
expects, and termd uses Ghostty's.

**Keys.** A key event carries W3C `KeyboardEvent` semantics (`code`, `key`, modifiers, the text it
typed, press/repeat/release), the model Ghostty's own apprts hand its core (`KeyEvent`: the
physical key, mods, consumed mods, UTF-8, the unshifted codepoint, src/input/key.zig) and whose
physical keys Ghostty names by W3C `code` values. termd builds libghostty's `KeyEvent` from it and
encodes it with libghostty's `KeyEncoder` after `set_options_from_terminal` (Kitty flags,
modifyOtherKeys 2, DECCKM, DECKPAM, 1035, 1036, DECBKM), in `crates/g3d-termd/src/keys.rs`. The
client resolves what its OS knows and termd doesn't: the layout, dead keys, the input method,
Option-as-character (all into `text`), so termd encodes Alt as Alt on a macOS daemon too
(`macos_option_as_alt` true). termd derives what the W3C event leaves implicit: the unshifted
character (the client's `key` when it is unshifted, a shifted letter lowercased, else the US
layout's character for `code`, Ghostty's `Key.codepoint()` table) and the consumed modifiers (Shift
when it changed the text, Alt when it made another character). A keypad digit `code` whose `key` is
a navigation key (NumLock off: `Numpad8` with `ArrowUp`) is the keypad's navigation key
(`numpad_up`), as Ghostty's apprt gives it from the keysym `KP_Up`: the cursor key's bytes, Kitty's
`KP_UP`, never the digit. What comes out is Ghostty's byte for byte, but for a program that asked
for **no keyboard mode** (no Kitty flags, no modifyOtherKeys 2), which gets xterm's bytes with
modifyOtherKeys off where Ghostty's legacy encoding would speak a protocol the program never
asked for: Enter with Shift, Ctrl or Super is `\r` (Ghostty's
function-key table sends `CSI 27;2;13~` for every modified Enter whatever modifyOtherKeys says,
which bash runs as `;2;13~` and python reads as junk), with Alt `ESC \r`; Ctrl+Shift+letter is the
letter's C0 byte (Ghostty: fixterms' `CSI 97;6u`); Ctrl+`[`, Ctrl+I and Ctrl+M are `ESC`, `TAB`, `CR`
(Ghostty leaves them to fixterms on purpose); Ctrl+Backspace is `^W`, readline's and zsh's word
rubout, as VS Code's terminal binds it (`deleteWordLeft`), since a browser keeps Ctrl+W for itself
(Ghostty: `^H`). libghostty has no getter for modifyOtherKeys, so `keys.rs` asks the encoder, set
from the terminal: Ctrl+P is `0x10` unless state 2 is on. The lock modifiers ride as Ghostty sends
them: its `KittyMods.fromInput` carries caps_lock and num_lock into the Kitty modifiers (bits 64 and
128 in the Kitty spec), so Shift+Enter with NumLock on is `CSI 13;130u` to a Kitty program from the
wall as from Ghostty. PROTOCOL.md's table of keys is checked against the encoder by a unit test.

**Paste.** `paste` runs libghostty's `Terminal::paste`: bracketed in `ESC[200~`…`ESC[201~` when
mode 2004 is on, else each `\n` as `\r` (xterm); xterm's strip list (NUL, BS, ENQ, EOT, ESC, DEL
and the tty's control characters) made spaces in both, so pasted text can't close its bracket
early or carry an escape sequence. Text that could run commands (a line break without bracketed
paste; the bracket end with it) is refused with `unsafe_paste` unless `allow_unsafe`. Outside a
bracket a `\r\n` is one `\r` (WezTerm's `canonicalize_pasted_newlines`, and the wall's own paste
before termd encoded it): libghostty's `\n` → `\r` alone makes it `\r\r` (as xterm does), which
runs an empty line after each line of Windows-origin text; inside a bracket the text is the
program's, as it came. The refusal is Ghostty's
`clipboard-paste-protection` rule, with the confirmation left to the client. `g3d paste` refuses
it and says `--unsafe`; the browser's paste is the person's own paste chord in a focused terminal
and the display has no confirmation dialog, so the adapter sends `allow_unsafe` (as xterm and
WezTerm paste: the stripped bytes still protect the bracket). termd installs no clipboard-read
callback, so a program's Kitty paste events (mode 5522) are never offered: a paste is text.

**The browser.** `keyEncoding.js` (core, `services/interaction`) maps a `KeyboardEvent` to a key
event (`keyEventFor`) and encodes nothing: modifiers held, `text` the one character `key` names,
null for a bare modifier, a dead key's own keydown, an IME keystroke and the paste chord (so the
browser's `paste` event fires). AltGr on a Windows browser arrives as Ctrl+Alt with `AltGraph`
held: those made the character (German AltGr+Q is `@`), so they don't ride, as Shift doesn't make
`A` a chord. `TerminalGrid.sendKey` and `TerminalGrid.paste` hand them to the
grid's owner route, the relay pushes `terminal.key` / `terminal.paste`, and the adapter
(`cli/attach_unix.go`) sends `key` / `paste` on its termd connection, once it has checked them in
the brain's `WELCOME.features` (PROTOCOL.md asks a client to check before using anything newer than
1.0). A brain from an earlier build (a holder kept across `g3d upgrade`s) lacks them: the adapter
logs that once per connection, never sends the op, and the status follower puts the missing ops in
`relay.lacks`, which the wall shows as a red notice ("typing can't reach termd … g3d upgrade") and
`termd.status` as a line; before, every keystroke died as an `unknown_op` relay-log line and the
wall showed nothing (the version numbers alone can't tell: both builds say `g3d-termd/0.1.0`). A
request over the brain's `max_frame` (a paste of tens of MB, or a few MB of control characters,
six bytes each as JSON) is refused unsent and logged, so the adapter's connection, which the
daemon would end over it, stays. The wall (`WallKeys`) and the
IDE (`keyboardRouter`'s terminal tier and paste tier) both take this path: they share the core
grid and its owner route, so there is one. The wall also sends the release of a key whose press
it sent, to the terminal that got the press (Kitty's event reporting reads releases); the IDE's
chain is keydown-only and sends none. Raw bytes stay for clients that encode their own keys: the
IDE's 2D xterm companion (`TerminalView`, xterm.js's `onData`), the wheel's mouse reports from
the adapter, and scripted `sendInput`. The canvas has no editable element, so an input method's
composition never starts there (dead keys do resolve); a hidden text input for IME is not built.

## The Go adapter moves to termd (S1)

`glyph3d-cli attach` stays a forked adapter (S2 dissolves it into the relay). It stops
driving `tmux attach` through a PTY and becomes a termd client on the socket. The
browser and the relay protocol keep their verbs: `terminal.create` / `terminal.bytes` /
`terminal.resize` / `terminal.scroll` / `terminal.refresh` / `terminal.shutdown`, and the same
`0x01` OUTPUT frames, byte for byte in format; the browser's key events and pastes ride
`terminal.key` / `terminal.paste` to termd's `key` and `paste` ops
([Keys and paste](#keys-and-paste-protocol-12)).

| Today (`cli/attach_unix.go`) | With termd |
|---|---|
| `ensureTmuxSession`: `new-session`, then neutralize status, prefix and keytables | `create {id, argv, cols, rows, if_exists: "adopt"}`. Nothing to neutralize. |
| `startTmuxAttach`: a PTY running `tmux attach`, `TERM=xterm-256color` | `subscribe {mode: "raw", role: "own", cols, rows}`: the adapter owns the size, because the display does (D11) |
| PTY reader → 16 ms coalescer → `0x01` frames | `OUTPUT` payloads (bytes after `seq`) → the same coalescer → the same `0x01` frames |
| Size stamped on frames, `resizeCh` drain on resize | Each frame is stamped with the size from the last `size` event. termd places that event at the exact byte, so the old-size/new-size boundary is exact with no drain |
| `terminal.bytes` → PTY write; `exitScroll` first | `INPUT`; termd snaps a scrolled view to live itself |
| — | `terminal.key` → `key`, `terminal.paste` → `paste` (protocol 1.2): termd encodes them ([Keys and paste](#keys-and-paste-protocol-12)) |
| `terminal.resize` → `pty.Setsize` | `resize` |
| `terminal.refresh` → OSC 2 from `#{pane_title}` + `refresh-client -t <our client>` | `repaint` (the title is part of every repaint). The adapter writes the `REPAINT` bytes into the `0x01` stream at the repaint's size |
| `terminal.scroll` → copy-mode `scroll-up`/`scroll-down`, cancel at bottom | `view {delta}`; the browser gets the viewed rows as repaint bytes, as copy-mode's redraw did. Alt screen: unchanged `forwardWheelToApp`, deciding from the last `modes` event instead of `display-message` |
| `terminal.shutdown` → `kill-session` | `kill` |
| PTY EOF → teardown | `closed` event → teardown. `terminal.close` to the display is unchanged. A dropped termd socket → teardown without kill (detach), as today (S1; termd ready replaces this with [the reconnect rule](#riding-a-restart-relay-and-clients)) |
| liveness `terminal.ping`, re-adopt by `terminal.create` | unchanged. A re-adopting adapter re-`subscribe`s, and its `REPAINT` fills the fresh grid |

What the browser sees differently: **pane-raw bytes** instead of tmux's redraw stream.
No permanent `?1049h`, no dropped lines, a TUI's own alternate screen arriving as its
own. The depth-history capture (gated on `!this._altActive`) starts working, and query
answers come from termd, as they came from tmux. That is a visible change, for the
operator to judge on the live display. `seed-history` stays a client command and reads
termd's `capture` (its tmux `capture-pane` path is deleted). It does not become the
adoption repaint's `history_rows`: the browser's depth history finds scrolled-off rows by
diffing frames, and a repaint that prints hundreds of rows in one frame would not be
caught row by row.

Two browser-visible consequences of raw bytes, handled in S1:

- **An idle program doesn't redraw after a resize.** tmux always redrew on `SIGWINCH`, and
  the browser resizes its emulator only when bytes tagged with the new size arrive. The
  adapter asks termd for a `repaint` on every `size` event, so the grid follows even while a
  long command runs.
- **Paste.** tmux stripped bracketed-paste markers for programs that hadn't enabled mode
  2004; termd writes `INPUT` as is. A paste is termd's `paste` op, which frames it by the
  program's mode at the moment it lands ([Keys and paste](#keys-and-paste-protocol-12)).

Relay changes in the same commit (no dual path, no flag):

- `liveTerminalIDs` → `list` (termd's ids); `seedTermSeq` is unchanged.
- `recoverTerminals`' "already adopted?" check (`list-clients`) → `subscribers.own > 0`
  in `list`. Recovered adapters take the size from `list`. A terminal someone holds with
  `g3d attach --take` has an owner, so `terminal.recover` skips it until that attach ends;
  the display sees the terminal again on the next recover after that.
- `spawnTerminalAdapter` forks the same `attach <id>` with `--termd-ns`.
  `terminal.spawn` gains an optional argv (`-- cmd...`), so an agent or any program can
  be started in a new terminal.
- `gomuxScreenLive` and gomux's `has-session` check on glyphd → `list`.
- `--tmux-socket` (serve, attach, seed-history) → `--termd-ns`, plus `serve --termd <path>`. `tmuxCmd`,
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
- ride a restart of termd's engine by the client rule ([Riding a restart](#riding-a-restart-relay-and-clients)),
  as the relay's adapters and `g3d status --follow` do: on `ERROR restart` or a dropped
  connection, reconnect (`start::reconnect` in the `g3d` crate, the one implementation), check the
  instance, `subscribe` again by id with the same role (`--take` takes the size again), and let the
  `REPAINT` redraw. Keys typed meanwhile are dropped. It ends with `[<id> exited]` when the
  terminal ended meanwhile (`no_terminal`), and with a message when the namespace is gone or no
  engine answers within `--reconnect-window` (30 s, `G3D_RECONNECT_WINDOW`);
- `g3d ls`, `g3d new <id> -- cmd...`, `g3d kill <id>`, `g3d stop` are thin wrappers over
  the ops;
- `g3d send <id> [text]` types bytes as given (stdin when no text: tmux's `send-keys -l`),
  `g3d key <id> <chord>...` presses keys (`shift+enter`, `ctrl+c`, `alt+left`, `F5`, `a`; Ghostty's
  keybind syntax: `shift`, `ctrl`/`control`, `alt`/`opt`/`option`, `super`/`cmd`/`command`, `+`
  alone the plus key; a chord stands for a US keyboard, so `shift+1` is `!`) through the `key` op,
  and `g3d paste <id> [text]` (stdin when no text) pastes through the `paste` op, refusing what
  could run commands unless `--unsafe`. Each takes an input-only subscription (`mode: "none"`,
  `attach`) and ends with `unsubscribe`, whose reply means termd took the input (an `error` event
  about it arrives first, and `g3d` exits 1 with it).

Run inside a tmux pane, `g3d attach` gives tmux users tmux back with no tmux server of
ours.

## Build and vendoring (D7, D8)

- `libghostty-vt` comes from libghostty-rs by git rev (`cd4d497e`, which pins Ghostty
  `vt-1.0.1`) until a 1.0-based crates.io release exists.
- The Ghostty source and its dependencies come from the **release tarballs**
  (`libghostty-vt-1.0.1.tar.gz` and `-deps.tar.gz` from release.files.ghostty.org),
  never a git fetch at build time. `tools/termd-vendor.sh [DIR]` downloads them,
  verifies each against its minisign signature (Ghostty's published key) and a pinned
  SHA-256, and unpacks them into a gitignored `vendor/` directory (or into `DIR`, with
  `vendor/` a link to it, to keep toolchains out of the tree). `.cargo/config.toml`
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
- `libghostty-vt-sys` builds `ReleaseFast` in every profile (`[profile.dev.package]`): its
  Debug mode parses a flood slowly enough to stall the daemon's own tests.
- **What `make` builds** (see also [as built](#environment-and-defaults-as-built-2026-11-12): the
  missing-`vendor/` message, the test hooks compiled out, `make release`): `make termd` (part of `make build`) builds `g3d-termd`
  and `g3d` natively on a Linux host and copies them beside `glyph3d-cli`; on linux-amd64,
  `make linux-amd64` also puts them in `dist/`. `make linux-arm64` builds them as static
  `aarch64-unknown-linux-musl` binaries through cargo-zigbuild and the vendored Zig, when
  cargo-zigbuild is installed. Proven on 2026-11-12: libghostty itself cross-built in about
  90 s, and the arm64 daemon, run under qemu-aarch64, created a terminal, answered `list` and
  `capture` (styles intact) and stopped cleanly. Not yet run on arm64 hardware. TODO, in order:
  1. linux-arm64 on real hardware (and a glibc build if a target needs one);
  2. macOS darwin-amd64 (darwin-arm64 is done: built natively on the M2, every gate; MACOS.md):
     an Intel Mac, or rustup's `x86_64-apple-darwin` target on an arm64 one;
  3. `make release` shipping `g3d-termd`/`g3d` beside each `glyph3d-cli`: done for linux-amd64
     (required), and linux-arm64 and darwin when built;
  4. Windows: none (no PTYs; the relay has no terminals there).

## Workspace layout (D10)

```
Cargo.toml              workspace: members crates/*, shared versions, libghostty pin
crates/
  g3d-wire/             the protocol: frame codec, op/event types, the query filter.
                        No I/O, no libghostty. TCEL types join it at S3.
  g3d-hold/             the holder: PTY fds, spawning, reaping, the fd store, brain
                        supervision. rustix, libc, g3d-wire's frame codec, serde_json.
  g3d-termd/            the binary: holder entry (g3d-hold), and the brain (owner
                        threads, libghostty, the socket server, status)
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
  - lossy lag → one `lagged` + repaint + state; stalled subscribers under an event flood
    (BEL and title) keep the daemon small and the terminal's pace;
  - `take` from a wedged blocking owner frees the program;
  - a late subscriber gets `modes` and the title;
  - blocking owner → no gap in `seq`;
  - a child that ignores `SIGHUP`;
  - a panic in one owner thread leaves the others running.
- **Fidelity:** the spike's 29 conformance snippets and its recorded streams, through
  termd and into xterm-headless via raw mode, final screens equal.
- **Flood:** `seq 1 300000` in N terminals: every line arrives at the owner (no `seq`
  gaps), and daemon RSS stays under a stated ceiling.
- **Lifecycle:**
  - relay restart: terminals survive, `terminal.recover` re-adopts them, and stopping the
    relay logs no termd loss;
  - an adapter killed under a live relay: the relay re-adopts its terminal;
  - the wheel over a mouse-reporting alt-screen program reaches it after re-adoption;
  - display reload: re-adoption repaints the grid;
  - termd killed: adapters exit cleanly and the next spawn starts a fresh daemon;
  - idle exit;
  - the lock refuses a second daemon.
- **The existing suites, unchanged:** `tools/terminal-readopt.test.mjs`,
  `tools/wall-e2e.mjs`, `wall-text-perf` via `tools/check.mjs`.
- **`g3d attach`** in a real terminal against a shell and vim: no stray query replies
  typed into the shell, detach restores the tty, `--take` resizes the display's grid.

## termd-ready gates

Each runs its own namespace under a scratch directory with `env_source = "daemon"` (never the
desktop session's environment) and kills every process it started, holder first-to-last, on
success or failure. Kills target pids, never `pkill` patterns, which would match a person's
holder.

- **Brain crash under load.** `SIGKILL` the brain while N terminals flood: no shell dies; each
  screen returns from its snapshot; `seq` never repeats; the unseen byte count equals the
  high-water mark minus the snapshot's `seq`; every subscriber reconnects and repaints; the
  relay's grids stay and `terminal.recover` never reports an empty list meanwhile.
- **Crash loop.** A brain that exits at start: 5 starts in 10 s, then `brain_failed` answers,
  the shells alive; `SIGHUP` retries at once.
- **Watchdog.** A brain that stops answering the holder is aborted and restarted.
- **Upgrade.** `g3d upgrade` under a flood loses no byte (each subscriber's stream across the
  restart, repaint included, equals a fresh terminal fed the same bytes) and `seq` continues
  exactly; a candidate that fails to decode, or never reports ready, leaves the old brain serving
  with its connections open. Across engines (a fixture pair), the VT handoff reproduces the
  screen.
- **Records.** Every fixture of the handoff and holder records decodes; `--check-holder-record`
  refuses a corrupt one and the holder stays.
- **Holder death.** `SIGKILL` the holder: every shell gets `SIGHUP`, the brain exits, clients see
  nothing listening, the relay reports `lost`.
- **Environment.** A child's environment: scrubbed names absent, reserved names refused at
  `create`, `PWD` = `cwd`, the default cwd is home, the default program the passwd shell with
  argv0 `-<basename>` (a `$SHELL` naming another shell is ignored), `LANG=C.UTF-8` under an empty
  caller environment and an existing non-UTF-8 `LANG` left alone, `TERM_PROGRAM=g3d-termd` with a
  starter's `TERM_PROGRAM=Apple_Terminal` and `TERM_SESSION_ID` gone,
  `IUTF8` set, ignored signals reset (a holder with `SIGINT` ignored still gives its shell a
  working Ctrl-C), the soft fd limit restored. A caller's odd environment (a stale `DISPLAY`, a
  fake `REX_SESSION`, a custom `FOO`) arrives but its markers; with `--clean` the session's fresh
  `DISPLAY` wins; a stripped creator (the relay's case) gets the session's handles; `g3d env` tags
  each source. With a user manager present, the session source is read per `create` (a value
  changed with `systemctl --user set-environment` reaches the next terminal, not a running one).
  Built as `tests/env.rs` and `crates/g3d/tests/attach.rs`; the per-create read is driven through
  a file standing in for the manager (a test hook), so no test changes the person's session. The
  macOS lookup (`launchctl getenv`) and the Rex case on a Mac are the M2 agent's to prove.
- **cgroup scopes** (Linux, when a user manager answers): holder, brain and each program in their
  own scopes; with the manager unreachable, spawns still succeed and the status says why.
- **Status.** The document's shape against a golden file (keys and types); a quiet daemon sends
  only keepalives; a flood pushes at the interval with live rates; 100 followers get one
  serialization per tick.
- **Keys and paste** (`tests/keys.rs`, `src/keys.rs`, `crates/g3d/tests/input.rs`). A program
  that sets a mode and prints every byte it reads in hex: Shift+Enter is `CSI 13;2u` after
  `CSI > 1 u` and `\r` without it (Ctrl+Enter too; Ctrl+Shift+A `0x01`, Ctrl+Backspace `^W`, a
  NumLock-off keypad 8 `CSI A` and keypad `.` `CSI 3~`); Ctrl+P is `CSI 27;5;112~` under
  modifyOtherKeys 2; ArrowUp is `ESC O A` under DECCKM; a paste is bracketed exactly when mode 2004
  is on, a line break without it is refused (`unsafe_paste`) and with `allow_unsafe` arrives as
  `\r`, a `\r\n` as one `\r` (inside a bracket, as it came), and a pasted `ESC [201~` arrives as
  ` [201~` inside one bracket; `key` and `paste` need a writing subscription. PROTOCOL.md's key
  table equals the encoder's output. `g3d send`/`key`/`paste` against a private daemon, and a
  17 MB `g3d paste` refused as `too_large` before it is sent. The relay's adapter sends no `key` or
  `paste` to a brain whose features lack them, and refuses a request over `max_frame` unsent
  (`cli/termd_input_test.go`); the wall's notice says so (`wall-panels.test.mjs`). Through the relay
  (`termd-relay-check.mjs`): `terminal.key` Shift+Enter and Ctrl+C into a Kitty-mode program,
  `terminal.paste` bracketed with its `ESC` a space, `relay.lacks` empty for a current brain. In
  the browser (`wall-e2e.mjs`): Enter running a typed line (its output, not the echo), a real
  Shift+Enter running a line in a plain shell and reaching a Kitty-mode program as `CSI 13;2u`, and
  a real paste event.
- **Relay and wall.** `termd/status` reaches a simulated display with each `relay.state`
  (`absent` → `ok` → `restarting` → `ok`, then `lost` after a holder kill); the wall's chip,
  window and notice render in `tools/wall-e2e.mjs` (the operator judges the look on the live display).

## Risks carried into S1

- **One holder, one blast radius.** A libghostty abort now ends only the brain; the
  shells survive and their screens come back from snapshots. The holder's death still
  ends every shell in the namespace (D3), which is why it is small, parses no output, sits
  in its own cgroup scope and changes only by a validated re-exec ([If the holder
  dies](#if-the-holder-dies)).
- **Crash restore loses up to one snapshot interval of parsed output** (2 s by default),
  counted and reported. A restored terminal whose snapshot came from another engine version
  starts blank and relies on the program's redraw.
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
- **Snapshot format instability** limits an upgrade across libghostty versions to the VT
  repaint (exact screen, styled-text history) and a crash restore across versions to a blank
  screen plus the redraw nudge.
