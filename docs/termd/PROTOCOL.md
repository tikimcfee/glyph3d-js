# The termd wire, version 1.1

`g3d-termd` keeps terminals alive: it owns each terminal's pseudo-terminal (PTY), its
process and a libghostty-vt emulator holding the terminal's screen and scrollback.
Clients connect over a Unix socket to create terminals, type into them and watch them.
The glyph3d relay is one client, `g3d attach` is another, and anything you write from
this page is a third. This page is the whole contract. If the daemon and this page
disagree, the daemon has a bug.

The protocol is public and versioned. Nothing in it is specific to glyph3d.

Version 1.1 is the first release. What is marked **(1.1)** is new in it. The daemon on branch
`termd` speaks all of 1.1 and announces `proto` `[1, 1]`: the restarts (`WELCOME.instance`,
`generation` and `holder`, `ERROR` `restart` and `brain_failed`, the `busy` code, `upgrade` with
its `upgrade_failed` event), `create`'s environment, `env_base`, defaults and reply fields, and the
status document (`status`, `status_follow`, `status_unfollow`, the `status` event).

## At a glance

- A Unix stream socket. Every message is a **frame**: a 12-byte little-endian header,
  then a payload.
- **Control** frames (handshake, requests, replies, events) carry one UTF-8 JSON
  object. **Data** frames (input, output, repaint) carry raw bytes behind a small fixed
  binary prefix. Bytes are never base64'd or JSON-escaped.
- A connection says `HELLO`, gets `WELCOME`, then sends `REQUEST`s. Each request gets
  exactly one `REPLY`, matched by `req`.
- To see a terminal you **subscribe**. The daemon answers with a `REPAINT` that redraws
  the current screen, then streams the terminal's PTY output byte for byte.
- termd answers the program's terminal queries (device attributes, cursor position,
  colours) itself, exactly once. Clients must never forward their own emulator's
  answers.
- One subscriber at a time **owns** a terminal's size. Everyone else sees the size the
  owner picked.
- The daemon can restart its engine without ending any terminal. Connections close and clients
  reconnect ([Restarts](#restarts-11)). (1.1)
- One request follows the daemon's whole state as a document pushed on change
  ([`status_follow`](#status_follow-status_unfollow-11)). (1.1)

## Transport

The daemon listens on a Unix stream socket (`SOCK_STREAM`). A **namespace** is an
independent daemon with its own terminals (`default` unless you pick another; tests and
second relays use their own). A namespace's socket is `termd-<namespace>.sock` in the
first of these directories that applies:

1. `$G3D_TERMD_DIR`, when set and not empty;
2. `/run/user/<uid>/g3d`, when `/run/user/<uid>` (logind's per-user runtime directory, with the
   numeric user id) is a directory the user owns that group and others can't access;
3. `/tmp/g3d-<uid>` otherwise (always on macOS).

Only the uid decides between 2 and 3: neither `$XDG_RUNTIME_DIR` nor `$TMPDIR` is consulted,
because a client started from a stripped environment (`env -i`, cron, a service manager) must
find the socket a desktop shell's client finds, and different runtimes resolve an unset
`$TMPDIR` differently.

A namespace's name is 1 to 64 bytes of `[A-Za-z0-9._-]`. A daemon can also serve an
explicit socket path instead (`g3d-termd --socket <path>`); it then has no namespace.

If nothing listens there, a client that wants a daemon starts one:
`g3d-termd --ns <namespace> --daemon` (or `--socket <path> --daemon`) detaches into the
background and serves until it has had no terminals and no connections (other than status
followers) for 5 minutes. Then
retry the connection for a few seconds. (1.1) The process that listens is the namespace's
holder, which keeps the terminals alive across restarts of the daemon's engine; see
[Restarts](#restarts-11). Starting a second daemon on a socket that already
has one fails and leaves the first serving, so two clients racing to start one are safe.

The socket's directory is mode `0700` and the socket `0600`; the daemon refuses to serve from a
directory another user owns or that group or others can write. The daemon checks the
peer's uid (`SO_PEERCRED` on Linux, `getpeereid` elsewhere) and closes connections from
any other user. There is no other authentication: anyone who can open the socket can
run commands as its owner.

## Frames

Every frame, in both directions:

```
offset  size  field
0       4     len       u32 LE  number of bytes AFTER this field (8 + payload length)
4       1     type      u8      frame type (table below)
5       1     flags     u8      0 in 1.0; send 0, ignore on receipt
6       2     reserved  u16 LE  0; send 0, ignore on receipt
8       4     stream    u32 LE  terminal handle, or 0 for the connection itself
12      len-8 payload
```

This is the grammar of glyph3d's transport streams (`u32 len · u8 type · u8 flags ·
u16 reserved · u32 streamId · payload`). The type numbers below belong to this socket
only.

- `len` is at least 8. The largest payload is 16 MiB (16,777,216 bytes) unless
  `WELCOME.max_frame` says otherwise. A larger frame is a protocol error.
- The header is 12 bytes, so a payload starts 4-byte aligned in a buffer that starts
  aligned. Binary prefixes below are laid out so their fields are naturally aligned.
- A reader accumulates bytes until it holds `4 + len` of them, then handles one frame.
  Frames never interleave. TCP-style partial reads are normal; handle them.

### Frame types

| type | name | direction | stream | payload |
|---|---|---|---|---|
| `0x01` | `HELLO` | client → daemon | 0 | JSON |
| `0x02` | `REQUEST` | client → daemon | 0 | JSON |
| `0x03` | `INPUT` | client → daemon | handle | raw bytes for the PTY |
| `0x81` | `WELCOME` | daemon → client | 0 | JSON |
| `0x82` | `REPLY` | daemon → client | 0 | JSON |
| `0x83` | `OUTPUT` | daemon → client | handle | `u64 seq` + raw PTY bytes |
| `0x84` | `EVENT` | daemon → client | handle | JSON |
| `0x85` | `REPAINT` | daemon → client | handle | `u64 seq, u16 cols, u16 rows, u32 flags` + VT bytes |
| `0x86` | `CELLS` | daemon → client | handle | reserved for packed cells (feature `cells`, not in 1.0) |
| `0xFF` | `ERROR` | daemon → client | 0 | JSON; the daemon closes the connection after it |

A client that receives a frame type it does not know skips it (it has `len`) and
carries on. A daemon that receives an unknown type from a client sends `ERROR` with code
`bad_frame` and closes, because a client that sends what it doesn't understand cannot be
trusted to understand the reply.

### JSON payloads

A control payload is exactly one JSON object in UTF-8, with no trailing bytes. Field
names are `snake_case`. Integers fit in 53 bits. Both sides **ignore fields they do not
know**: that is how 1.x minors add things. A missing optional field takes the default
this page gives.

### Terminal ids and handles

A terminal has two names:

- **`id`**: a string chosen by whoever creates it (`term-3`, `gx-alice`). 1 to 64 bytes
  of `[A-Za-z0-9._-]`. Requests name terminals by `id`.
- **`handle`**: a `u32` the daemon assigns at creation, never 0 and never reused within
  one daemon's lifetime. Data frames and events carry it in `stream`, so a client routes
  them without parsing.

### `seq`: the output cursor

Each terminal counts the bytes its PTY has produced since it was created. `seq` is a
position in that count (a `u64`).

- An `OUTPUT` frame's `seq` is the position of its first byte. A subscriber's next
  `OUTPUT` starts where the previous one ended, so a jump means bytes were not delivered
  to you (see [Flow control](#flow-control)).
- A `REPAINT` frame's `seq` is the position of the first byte it does **not** include:
  the repaint shows the screen after every byte before `seq`, and output continues at
  `seq`.
- An `EVENT` that changes how bytes are read (`size`) carries the `seq` it takes effect
  at.
- (1.1) `seq` never repeats within a terminal's life, across daemon restarts too. After a crash
  it can jump forward past output the crashed engine read and never saved
  ([Restarts](#restarts-11)).

## Handshake

The first frame a client sends is `HELLO`:

```json
{"proto": [1, 0], "client": "example/0.1"}
```

- `proto`: `[major, minor]` the client speaks. Required.
- `client`: a free-form name for logs. Required.

The daemon replies `WELCOME`:

```json
{"proto": [1, 1], "daemon": "g3d-termd/0.2.0", "engine": "libghostty-vt/1.0.1",
 "ns": "default", "pid": 41200, "instance": "8c1f0e7a9b2d4c55", "generation": 2,
 "holder": {"pid": 41190, "version": "g3d-termd/0.2.0"},
 "features": ["raw", "view", "capture", "status", "upgrade"], "max_frame": 16777216}
```

- `proto`: the daemon's `[major, minor]`.
- `ns`: the namespace. Absent when the daemon serves an explicit `--socket`.
- `pid`: the process serving this connection (the brain, in 1.1).
- `instance` (1.1): the namespace's identity, a random hex string fixed for the holder's life.
  The same `instance` after a reconnect means the same terminals may still be there.
- `generation` (1.1): which brain this is in the holder's life: 1 for the first, +1 for each
  restart or upgrade.
- `holder` (1.1): the holder's `pid` and `version`.
- `features`: what this daemon supports beyond the 1.0 core. A client checks a feature
  before using it. Known features: `raw`, `view`, `capture` (all in 1.0), `status`,
  `upgrade` (1.1), `cells` (packed cells, reserved).
- `max_frame`: the largest payload either side may send.

If the majors differ, the daemon sends `ERROR` with code `version` instead and closes.
Minors never cause a refusal: a newer minor only adds fields, events and features, and
an older peer ignores them. Until `WELCOME`, the only frame a client may send is
`HELLO`.

## Requests and replies

Every `REQUEST` payload has `req` (a client-chosen integer, unique among the requests
that connection has in flight) and `op`. The daemon answers each with one `REPLY`
carrying the same `req`. A `REQUEST` without an integer `req` can't be answered, so it is
a malformed frame: `ERROR` `bad_frame`, and the connection closes (see
[Errors and closing](#errors-and-closing)).

```json
{"req": 5, "ok": true, ...}
{"req": 5, "ok": false, "error": {"code": "no_terminal", "message": "no terminal 't9'"}}
```

Replies to one connection come back in the order its requests were sent. A reply can
be preceded or followed by frames it causes (a `subscribe` reply comes before its
`REPAINT`), and the per-op text says which.

Error codes, the same for every op:

| code | meaning |
|---|---|
| `bad_request` | a field is missing (other than `req`), has the wrong type, or is out of range |
| `unknown_op` | the daemon does not know this `op` (an older daemon) |
| `unsupported` | the op is known but a mode or feature it names is not available |
| `no_terminal` | no live terminal has this `id` or `handle` |
| `exists` | `create` with `if_exists: "error"` named a live terminal |
| `not_subscribed` | the op needs a subscription this connection does not hold |
| `already_subscribed` | this connection already subscribes to that terminal |
| `read_only` | a `watch` subscription tried to write |
| `not_owner` | the op needs the `own` role |
| `alt_screen` | `view` on a terminal showing its alternate screen, which has no scrollback |
| `spawn_failed` | the program could not be started; `message` says why |
| `too_large` | a frame or a field exceeded a limit |
| `busy` | (1.1) the op can't run now: another one of its kind is running (`upgrade`), or an upgrade is handing the terminals over (`create`, `resize`, `kill` during the handoff) |

### `create`

Starts a program on a new PTY.

```json
{"req": 1, "op": "create", "id": "t1", "argv": ["bash", "-l"], "cols": 80, "rows": 24,
 "cwd": "/some/dir", "env": {"FOO": "bar"}, "if_exists": "adopt",
 "scrollback_bytes": 2097152,
 "colors": {"fg": "#cccccc", "bg": "#101214", "cursor": "#cccccc"}, "cell_px": [8, 16]}
```

| field | default | meaning |
|---|---|---|
| `id` | required | the terminal's name |
| `argv` | the user's shell, started as below | program and arguments, run directly (no shell). `argv[0]` without a `/` is looked up in the program's own `PATH` (the system's default search path when it has none), not the daemon's; not found is `spawn_failed` |
| `cols`, `rows` | required | initial size, 1 to 4096 each |
| `cwd` | the user's home directory (`/` if it doesn't exist, as `login(1)` does) | an absolute path to an existing directory the user can search; anything else is `bad_request`, naming why. It is used as given (`PWD` keeps a symlink's name), except that a path with a `.` or `..` component, which POSIX forbids in `PWD`, becomes the directory's real path (in `PWD` and the reply's `cwd`) |
| `env` | `{}` | added to the environment (below); a `null` value removes a variable |
| `env_base` | `"session"` | (1.1) `"session"`: start from the user's session environment (below). `"none"`: start from nothing but the account variables and termd's own |
| `if_exists` | `"error"` | `"adopt"` returns the live terminal with this id instead of failing |
| `scrollback_bytes` | daemon default (10,000,000) | primary-screen history cap, in bytes of the emulator's memory (not of output: 10,000,000 holds roughly 14,000 rows of 80 columns, whatever their text); the daemon clamps it to its own maximum |
| `colors` | daemon defaults | the default foreground, background and cursor colours termd reports when the program asks (OSC 10/11/12). Set them to what your renderer draws |
| `cell_px` | `[8, 16]` | cell size in pixels, reported to programs that ask for the window size in pixels (`CSI 14 t`, `CSI 16 t`) |

**The program's environment (1.1)** is built for each `create`, later layers winning:

1. the user's session environment: on Linux with a systemd user manager, that manager's
   environment as it is now (what a terminal opened from the desktop gets); otherwise the
   session's variables of the environment the daemon started with: the account and its paths
   (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `MAIL`, `TMPDIR`, `TZ`), the locale (`LANG`,
   `LANGUAGE`, `LC_*`), the desktop session (`XDG_*`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`,
   `DBUS_SESSION_BUS_ADDRESS`), the credential agents (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`,
   `GPG_AGENT_INFO`, `KRB5CCNAME`), the network proxies (`http_proxy` and its kin, both cases),
   `TERMINFO_DIRS`, and macOS's `__CF_USER_TEXT_ENCODING` and `COMMAND_MODE`; a daemon setting
   adds names. Nothing else the daemon's starter carried. Skipped with `env_base: "none"`;
2. minus what describes some other process: another terminal, multiplexer, editor or agent
   (`TMUX`, `STY`, `VTE_VERSION`, `KITTY_*`, `VSCODE_*`, `NVIM`, `CLAUDECODE`, …), the launcher or
   service unit (`INVOCATION_ID`, `NOTIFY_SOCKET`, `LISTEN_*`, `MEMORY_PRESSURE_*`, …) and the
   parent shell (`SHLVL`, `OLDPWD`, `COLUMNS`, `LINES`, …). The full list is `SCRUB` in
   `crates/g3d-termd/src/env.rs`, and DESIGN.md's policy table; it is the daemon's to extend, so
   a client relies on its shape (identity of other processes goes), not its exact contents;
3. the account, from the user database (passwd) whatever the base said, as `login(1)` sets them:
   `HOME`, `USER`, `LOGNAME`, and `SHELL` (below), for every program, an explicit `argv` included;
4. the request's `env`;
5. termd's own, which describe this terminal: `TERM=xterm-256color`, `COLORTERM=truecolor`,
   `TERM_PROGRAM=g3d-termd`, `TERM_PROGRAM_VERSION=<version>`, `G3D_TERMD_ID=<id>`,
   `G3D_TERMD_SOCKET=<socket path>`, `PWD=<cwd>`.

`env` names must match `[A-Za-z_][A-Za-z0-9_]*`, values may not contain NUL, each `NAME=value`
with its terminating NUL is at most 128 KiB (Linux's `MAX_ARG_STRLEN`, which counts the whole
string), and `argv` plus the environment total at most 1 MiB, counted as `execve` counts them
(each string with its NUL, plus a pointer for each) (`bad_request` or `too_large`, naming the
variable). The names in layer 5 are reserved: setting or removing one is
`bad_request`. Any other name may be set, including one layer 2 removes: the request knows what
its terminal is for.

With no `argv`, the program is a shell: the request's `env` `SHELL` when it gives one (an absolute
path to an executable, else `bad_request`: `SHELL` names the shell that runs, as `login(1)` and
tmux mean it), else the account's shell from the user database (passwd), else the base's `SHELL`
when it names an executable, else `/bin/sh`. `SHELL` is set to the account's choice for every
program, an explicit `argv` included (as `login(1)` sets it whatever runs); a request's own
`SHELL` wins there, as any layer-4 value does. It starts as a login shell (its `argv[0]` is `-` and the shell's name,
as `login(1)` and tmux start shells), on every platform, so the system's and the user's profile
run. Daemon settings can change the shell and turn login off. An explicit `argv` runs exactly as
given, never as a login shell.

When the environment sets none of `LC_ALL`, `LC_CTYPE` and `LANG` (an empty value is unset), the
daemon sets `LANG` to a UTF-8 locale the system has (`C.UTF-8`; on macOS the user's own locale
when installed). A locale that is set is left alone, and so is a request whose `env` names any of
the three, even to remove it. One that is set but doesn't load or isn't UTF-8 still starts; the
status document's `daemon.env.warnings` names it (the last such terminal) and the log says it.

Reply:

```json
{"req": 1, "ok": true, "id": "t1", "handle": 7, "pid": 41234, "created": true,
 "cols": 80, "rows": 24, "argv": ["/bin/bash"], "login": true, "cwd": "/srv/src"}
```

`created` is `false` when `if_exists: "adopt"` returned a live terminal; then `cols` and
`rows` are its current size, not the requested one. (1.1) `argv` is what actually runs (its
first element the resolved path), `login` whether it was started as a login shell, and `cwd`
where. `create` does not subscribe.

### `list`

```json
{"req": 2, "op": "list"}
```

```json
{"req": 2, "ok": true, "terminals": [
  {"id": "t1", "handle": 7, "pid": 41234, "argv": ["/usr/bin/bash", "-l"], "cwd": "/some/dir",
   "cols": 80, "rows": 24, "title": "~/src", "alt": false, "seq": 18211,
   "created_at": 1794480000123, "subscribers": {"own": 1, "attach": 0, "watch": 2}}]}
```

`argv` is what runs, as `create` answered it (the resolved path first). `created_at` is Unix epoch
milliseconds. `title` is the last OSC 0/2 title. Only live
terminals are listed: a terminal leaves the list when its program exits.

### `kill`

```json
{"req": 3, "op": "kill", "id": "t1"}
```

Sends `SIGHUP` to the terminal's process group, closes the PTY, and replies once the
terminal is gone. Its subscribers first get `exit` and `closed` events. `"signal":
"TERM"` or `"KILL"` sends that signal instead of `HUP`.

### `subscribe`

```json
{"req": 4, "op": "subscribe", "id": "t1", "mode": "raw", "role": "attach",
 "history_rows": 0, "flow": "lossy"}
```

| field | default | meaning |
|---|---|---|
| `mode` | required | `"raw"`: a repaint, then PTY bytes. `"none"`: no output at all (input-only, or events only). `"cells"`: reserved, answered `unsupported` in 1.0 |
| `role` | required | `"watch"`, `"attach"` or `"own"` (below) |
| `history_rows` | `0` | scrollback rows to include before the screen in the first repaint |
| `flow` | `"block"` for `own`, `"lossy"` otherwise | see [Flow control](#flow-control). Only `own` may ask for `"block"` |
| `cols`, `rows` | none | with `role: "own"`: resize to this as part of taking ownership |

Roles:

- **`watch`**: read-only. `INPUT` on this subscription is refused with `read_only`.
- **`attach`**: may send `INPUT`. May not resize.
- **`own`**: may send `INPUT` and is the only subscriber that can resize. A terminal has
  at most one owner. Subscribing as `own` while another connection owns the terminal
  **takes** it, as [`take`](#take) does: the previous owner is demoted to `attach` (and
  to `flow: "lossy"`) and gets a `role` event, then, if `cols`/`rows` changed the size,
  a `size` event.

Ownership can also be **vacant**: when the owner unsubscribes or its connection closes,
the terminal has no owner. Nothing else changes: the size stays what the owner last set,
no subscriber is sent anything, and nobody can `resize` until someone becomes the owner
with `take` or by subscribing as `own`. `list` shows `subscribers.own` = 0. (The glyph3d
relay reads a vacant, live terminal as one whose display adapter died and re-adopts it.)

Reply, then frames, in this order:

1. `REPLY` `{"req": 4, "ok": true, "handle": 7, "role": "attach", "seq": 18211, "cols": 80, "rows": 24}`
   (the size after any `cols`/`rows` you gave).
2. With `mode: "raw"`, one `REPAINT` at that `seq`.
3. The terminal's state as events, so a client learns it without waiting for a change:
   `modes`, then `title` if the program set one, then `pwd` if it reported one.
4. `OUTPUT` from that `seq` on, and events as they happen.

One connection holds at most one subscription per terminal. To switch modes,
`unsubscribe` and subscribe again. To become the owner, use `take`.

### `unsubscribe`

```json
{"req": 5, "op": "unsubscribe", "handle": 7}
```

No more frames for that handle reach this connection after the reply. Closing the
connection unsubscribes everything it held.

### `take`

```json
{"req": 6, "op": "take", "handle": 7, "cols": 120, "rows": 40}
```

Makes this connection's `attach` subscription the owner (a `watch` subscription gets
`read_only`). `cols`/`rows` are optional and resize in the same step. Reply:
`{"req": 6, "ok": true, "role": "own"}`.

The new owner's flow becomes the `flow` it asked for when it subscribed, else `"block"`.
The previous owner, if any, is demoted to `attach` with `flow: "lossy"`, so an owner that
stopped reading no longer holds the program back once someone takes the terminal.

Frames: the previous owner gets a `role` event, then a `size` event if the size changed.
The taker gets its `REPLY`, then the `size` event (every subscriber gets one).

### `resize`

```json
{"req": 7, "op": "resize", "handle": 7, "cols": 100, "rows": 30}
```

Only the owner. The daemon resizes its emulator (reflowing the primary screen) and the
PTY (the program gets `SIGWINCH`) as one step at one point in the byte stream, then
sends every subscriber of the terminal an `EVENT` `size` carrying that point's `seq`.
Every byte from that `seq` on was produced at the new size. A resize to the current
size does nothing and sends no event.

The size belongs to the owner. A subscriber whose own window is a different size sees
the owner's size in `size` events and draws within it: in raw mode, a bigger window
shows the terminal in its top-left corner, and a smaller one cuts it off.

### `repaint`

```json
{"req": 8, "op": "repaint", "handle": 7, "history_rows": 0}
```

Sends this subscriber a fresh `REPAINT`, ordered in its stream like any output: the
repaint is built at the current `seq`, after every `OUTPUT` the subscriber has already
been sent. Useful when a client has lost its own screen (a reloaded page). `mode: "raw"`
only.

### `view`

Feature `view`. Scrolls **this subscriber's** view into the terminal's scrollback. The
terminal and its other subscribers are not affected.

```json
{"req": 9, "op": "view", "handle": 7, "delta": 5}
{"req": 9, "op": "view", "handle": 7, "live": true}
```

- `delta` > 0 scrolls back that many rows, < 0 scrolls forward. `"live": true` returns
  to the live screen.
- Reply: `{"req": 9, "ok": true, "offset": 5, "max": 2310}`. `offset` is rows back from
  live (0 = live), `max` the deepest offset available now.
- While `offset` > 0, the subscriber gets no `OUTPUT`. Each change of view sends one
  `REPAINT` with `flags` bit 0 set (the viewed rows, with the cursor hidden). The view
  stays on the same content while new output arrives.
- Back at `offset` 0 the subscriber gets a live `REPAINT` (flag bit 0 clear) at the
  current `seq`, and `OUTPUT` resumes from there.
- An `INPUT` on a subscription with `offset` > 0 first returns it to live, then writes
  the bytes.
- On the alternate screen there is no scrollback, so `view` fails with `alt_screen`.
  Send the wheel to the program instead: the `modes` event says whether it asked for
  mouse reports.

### `capture`

Feature `capture`. Returns the screen as text without subscribing.

```json
{"req": 10, "op": "capture", "id": "t1", "format": "plain", "history_rows": 100, "unwrap": false}
```

`format` is `"plain"` (text only, trailing spaces trimmed) or `"vt"` (text with SGR
styles). `unwrap: true` joins rows the terminal soft-wrapped. Reply:
`{"req": 10, "ok": true, "text": "...", "rows": 124}`. The text is limited by
`max_frame`; ask for fewer rows if you get `too_large`.

### `ping`

`{"req": 11, "op": "ping"}` → `{"req": 11, "ok": true}`. The daemon never pings; a
client that wants liveness pings.

### `stop`

`{"req": 12, "op": "stop"}` kills every terminal (as `kill` does) and exits the daemon
after replying. Every shell in the namespace dies. It exists for tests and for ending a
namespace on purpose; to replace the daemon, use [`upgrade`](#upgrade-11).

### `status` (1.1)

Feature `status`. The daemon's state as one document: the daemon, every terminal and its
subscribers, and recent errors. It is built for rendering as is (a status window, `g3d status`),
so a client never lists terminals and then asks each one.

```json
{"req": 13, "op": "status"}
```

Reply: `{"req": 13, "ok": true, "status": {…}}`, the document below.

### `status_follow`, `status_unfollow` (1.1)

```json
{"req": 14, "op": "status_follow", "interval_ms": 1000}
{"req": 15, "op": "status_unfollow"}
```

`status_follow` replies `{"req": 14, "ok": true, "interval_ms": 1000}` (the interval in effect:
`interval_ms` is clamped to 250–60000; default 1000; the daemon's settings may move all three),
then sends an `EVENT` `status` on stream 0 at once, and again whenever the document has changed,
no sooner than the interval after the previous one. Changes are any field except the sampled
gauges (`at`, `rss`, `memory`, `snapshots.bytes`, a subscriber's `queued`, the `*_bps` rates), or
a rate crossing zero; while any terminal produces output or takes input, every interval counts as
a change, so its rate stays current. With nothing changing, a keepalive arrives every 30 s with
fresh gauges. A status event is dropped, not queued, when the connection is behind on its earlier
ones: the next one replaces it. `status_follow` again changes the interval; `status_unfollow`
stops them; closing the connection does too. A connection that only follows status (and pings)
doesn't keep an empty daemon alive ([Transport](#transport)): when the namespace leaves (idle
exit, `stop`), each follower gets a last document with `daemon.exiting: true` and no terminals,
then the connection closes.

The document (the `EVENT` carries it with `"ev": "status"` added; numbers are integers, times are
Unix epoch milliseconds, sizes are bytes):

```json
{"at": 1794519127407,
 "daemon": {
   "version": "g3d-termd/0.2.0", "engine": "libghostty-vt/1.0.1", "proto": [1, 1],
   "ns": "default", "socket": "/run/user/1000/g3d/termd-default.sock",
   "log": "/home/user/.local/state/g3d/termd-default.log", "exiting": false,
   "instance": "8c1f0e7a9b2d4c55", "started_at": 1794518713751, "connections": 4,
   "holder": {"pid": 41190, "version": "g3d-termd/0.2.0", "hold": [2, 1], "rss": 3145728},
   "brain": {"pid": 41200, "generation": 2, "started_at": 1794519100000, "rss": 41943040,
             "restarts": {"crash": 1, "watchdog": 0, "upgrade": 0},
             "last_start": {"reason": "crash", "at": 1794519100000, "exit": {"signal": "SEGV"},
                            "restored": {"exact": 0, "snapshot": 3, "blank": 0}, "unseen": 512}},
   "snapshots": {"interval_ms": 2000, "bytes": 1835008},
   "env": {"source": "systemd-user", "warnings": []}},
 "terminals": [
   {"id": "t1", "handle": 7, "pid": 41234, "argv": ["/bin/bash"], "login": true, "cwd": "/srv/src",
    "pwd": "/srv/src/app", "title": "~/src/app", "cols": 120, "rows": 40, "alt": false,
    "created_at": 1794480000123, "seq": 18211, "out_bps": 1253000, "in_bps": 12,
    "last_output_at": 1794519127390, "flow": "live", "input_queued": 0,
    "scrollback_rows": 1567, "memory": {"resident": 1986560, "compressed": 0},
    "restored": "snapshot",
    "subscribers": [
      {"conn": 12, "client": "glyph3d-cli/0.2.0", "pid": 5011, "role": "own", "mode": "raw",
       "flow": "block", "queued": 0, "lagging": false, "lags": 0, "view": 0}]}],
 "errors": [
   {"code": "brain_crash", "message": "brain exited on SIGSEGV; 3 screens restored from snapshots, 512 bytes unseen",
    "first_at": 1794519099900, "at": 1794519099900, "count": 1}]}
```

`daemon`:

| field | meaning |
|---|---|
| `version`, `engine`, `proto`, `ns`, `instance` | as in `WELCOME` |
| `socket`, `log` | where the daemon listens and logs (absolute paths) |
| `exiting` | `true` only in the last document a follower gets before an idle daemon exits; the connection then closes and nothing listens. An empty namespace leaving, not a failure |
| `started_at` | when the holder started: the namespace's age. Uptime is `at − started_at` |
| `connections` | client connections open now, status followers included |
| `holder` | `pid`, `version`, `hold` (the internal holder/brain protocol version), `rss` (absent when it can't be measured) |
| `brain` | `pid`, `generation`, `started_at`, `rss`; `restarts` counts brain starts by cause (`crash`: exited without a handoff; `watchdog`: killed for not answering; `upgrade`: replaced on purpose); `last_start`: why the current brain started (`"first"`, `"crash"`, `"watchdog"`, `"upgrade"`), when, how the previous one ended (`exit`: `code` or `signal`, as in the `exit` event), and how many terminals came back each way (`restored`, below). `unseen` is the total output the previous brain read but never saved (0 after an upgrade) |
| `snapshots` | crash-restore saving: the interval and the bytes held |
| `env` | `source` of the session environment new terminals start from (`"systemd-user"`, `"daemon"`), and `warnings` (strings: no UTF-8 locale to fill, the user manager unreachable while it is, the last terminal whose set locale doesn't load or isn't UTF-8) |

Each of `terminals` (one per live terminal; the count is the array's length):

| field | meaning |
|---|---|
| `id`, `handle`, `pid`, `argv`, `cwd`, `created_at`, `seq`, `title`, `alt` | as in `list` (`argv` is what actually ran) |
| `login` | started as a login shell, as in the `create` reply |
| `pwd` | the directory the program last reported (OSC 7), absent if none |
| `cols`, `rows` | the size now |
| `out_bps`, `in_bps` | output and input bytes per second over the last 5 s |
| `last_output_at` | when output last arrived |
| `flow` | `"live"` (termd reads the program's output as it comes), `"blocked"` (a `block` owner is behind and termd has stopped reading; the program waits), `"paused"` (an upgrade's cut) |
| `input_queued` | input bytes waiting for the program to read them |
| `scrollback_rows`, `memory` | history rows held; the emulator's `resident` and `compressed` bytes |
| `restored` | how this terminal came back at the current brain's start: `"exact"` (an upgrade's handoff, or a crash while it had been quiet since its last snapshot), `"snapshot"` (a crash, from a saved snapshot), `"blank"` (a crash with no usable snapshot: the program's own redraw is all there is), or absent (started under this brain) |
| `subscribers` | one per subscription: `conn` (the connection's number in this daemon), `client` (its `HELLO` name), `pid` (the peer's, from its credentials), `role`, `mode`, `flow`, `queued` (bytes waiting to be written to it), `lagging` (dropping until it catches up), `lags` (resyncs so far), `view` (its `view` offset, 0 = live) |

`errors`: the last 32 distinct errors (by `code` and terminal), newest first, each `code`,
`message`, `first_at`, `at` (the latest), `count`, and `id` when it concerns one terminal. Codes are
the request and event codes above (`spawn_failed`, `input_full`, `panic`) plus `lagged` (a lossy
subscriber fell behind and was resynced), `restore` (a terminal that could not come back),
`upgrade_failed`, `brain_crash` and `brain_watchdog` (why this brain started). The list is the
current brain's: a restart starts it over with the reason for the restart. They are for people;
nothing depends on reading them.

Like every payload, the document only grows: a client renders the fields it knows and ignores
the rest.

### `upgrade` (1.1)

Feature `upgrade`. Replaces the daemon's engine (the brain) without ending any terminal:

```json
{"req": 16, "op": "upgrade", "binary": "/opt/g3d/bin/g3d-termd"}
```

`binary` is optional (default: the path the daemon was started from, where a new build would be
installed). The reply `{"req": 16, "ok": true, "generation": 2}` means the upgrade has started;
`generation` is the current brain's. If the new engine takes over, every connection then gets
`ERROR` `restart` and closes, and a reconnect's `WELCOME` shows a higher `generation`. If it
doesn't, connections stay open and the status document's `errors` carries `upgrade_failed`.
`bad_request` when `binary` isn't an executable file; `busy` while another upgrade runs.

While the daemon hands its terminals over (a fraction of a second), `create`, `resize` and `kill`
answer `busy`, and `INPUT` is dropped with an `error` event `busy`: input is at most once, so what
the handoff didn't carry is not kept. New connections wait in the socket's backlog. When the
upgrade doesn't happen, the connection that asked gets an `EVENT` on stream 0:
`{"ev": "upgrade_failed", "message": "…"}`, and everything carries on.

Replacing the holder itself is `g3d upgrade --holder` (DESIGN.md); it will use the same op with
`"holder": true`, which the daemon on branch `termd` answers `unsupported`.

## Data frames

### `INPUT` (client → daemon)

`stream` is the handle; the payload is bytes to write to the PTY, as a keyboard would
send them. The connection must hold an `attach` or `own` subscription to that handle
(`mode: "none"` counts). Otherwise the daemon sends an `EVENT` `error` with code
`not_subscribed` or `read_only` and drops the bytes. `INPUT` has no reply.

termd writes input from all writers to the PTY in the order it receives it, without
merging or splitting a frame. Two writers typing at once interleave at frame boundaries.

### `OUTPUT` (daemon → client)

```
offset  size
0       8     seq   u64 LE
8       n     bytes exactly as the PTY produced them
```

The bytes are not filtered, translated or re-encoded, and frame boundaries mean
nothing: a frame can end in the middle of an escape sequence or a UTF-8 character. Feed
them to a VT emulator in order.

### `REPAINT` (daemon → client)

```
offset  size
0       8     seq    u64 LE  output continues at this position
8       2     cols   u16 LE  the size the repaint is drawn at
10      2     rows   u16 LE
12      4     flags  u32 LE  bit 0: a scrollback view (see `view`); other bits 0
16      n     VT bytes
```

Writing the VT bytes to an emulator (or a real terminal) of `cols` × `rows` makes it
show what termd's emulator shows, so the `OUTPUT` that follows parses correctly. A
repaint:

1. leaves the alternate screen (`CSI ? 1049 l`) and soft-resets (`CSI ! p`, which
   resets modes, styles and margins but not colours or scrollback), then puts back what a
   soft reset leaves alone: autowrap on (`CSI ? 7 h`), mouse reporting, focus events and
   bracketed paste off, Kitty keyboard flags 0 (`CSI = 0 ; 1 u`),
2. homes the cursor and clears the screen (`CSI H`, `CSI 2 J`),
3. with `history_rows` > 0, first prints that many scrollback rows (styled text) so
   they scroll into the client's own scrollback, then clears again,
4. redraws the screen: cell text and styles; the modes that differ from their defaults
   (including the alternate screen, cursor visibility, mouse and bracketed paste);
   scrolling margins, tab stops, character sets, keyboard modes and the cursor's
   position, style and hyperlink,
5. sets the colours the program changed (OSC 4 palette entries, OSC 10/11/12) and the
   title (OSC 2),
6. ends with the program's unfinished escape sequence, if `seq` fell in the middle of
   one, so the first `OUTPUT` byte continues it.

A repaint never turns on synchronized output (mode 2026), even if the program had it
on: a client would wait for an end that already happened.

A repaint can only rebuild the screen being shown. While a program is on the alternate
screen, the primary screen behind it is not in the repaint. When the program leaves the
alternate screen, your emulator shows an empty primary screen where termd's shows the
old one. Ask for another `repaint` then if that matters.

## Events

`EVENT` frames carry `{"ev": "<name>", ...}` with `stream` = the handle. Events reach
every subscriber of the terminal, including `mode: "none"`, in order with its
`OUTPUT`. (1.1) An event on stream 0 belongs to the connection, not a terminal (`status`).

| `ev` | fields | when |
|---|---|---|
| `size` | `cols`, `rows`, `seq` | the owner resized; bytes from `seq` on are at the new size |
| `title` | `title` | the program set its title (OSC 0 or 2); also sent when you subscribe |
| `modes` | `alt`, `mouse`, `mouse_sgr`, `bracketed_paste`, `app_cursor`, `focus` (all bool) | any of these changed; also sent when you subscribe and after a resync. `mouse` is true when the program asked for any mouse reporting (1000, 1002 or 1003) |
| `bell` | | the program rang the bell: one event for the BELs in one read of its output, however many |
| `pwd` | `pwd` | the program reported its directory (OSC 7); also sent when you subscribe |
| `role` | `role` | your role changed (another client took ownership) |
| `lagged` | `dropped` (bytes), `seq` | you fell behind and were resynced (see [Flow control](#flow-control)) |
| `exit` | `code` or `signal`, `seq` | the program exited; `seq` is the end of its output. `code` is its exit status; `signal`, the name of the signal that ended it, without `SIG` (`"HUP"`). Only the one that applies is present; the other is absent, not `null`. Both are absent if termd couldn't learn the status |
| `closed` | | the terminal is gone; the handle is dead. Always last |
| `error` | `code`, `message` | something with no reply went wrong: an `INPUT` refused (`not_subscribed`, `read_only`, `no_terminal`, or `input_full` when the program's input buffer is full), or the terminal failed inside termd (`panic`; `exit` and `closed` follow) |
| `status` | the status document | (1.1) on stream 0, to a connection that asked with `status_follow` |
| `upgrade_failed` | `message` | (1.1) on stream 0, to the connection that asked for an `upgrade` that did not happen |

The `error` event's codes are the request codes above (`busy`: an `INPUT` dropped during an
upgrade's handoff) plus two of its own:

| code | meaning |
|---|---|
| `input_full` | the program hasn't read its earlier input and the daemon's input buffer for it is full (16 MiB by default); this `INPUT` was dropped whole |
| `panic` | the terminal failed inside termd and is closing |

Clients must ignore events they don't know.

The title, alternate screen and mouse modes also travel inside the raw bytes. A raw
client that runs an emulator can read them from there. The events serve clients that
don't (a relay listing terminals, a status line).

## Terminal queries are termd's to answer

Programs ask their terminal questions: device attributes (`CSI c`, `CSI > c`), cursor
position (`CSI 6 n`), mode state (`CSI ? Ps $ p`), colours (`OSC 10/11/12 ; ?`), window
size (`CSI 18 t`), version (`CSI > q`). termd's emulator answers each one directly into
the PTY, once, the moment it parses the query. It answers colour queries with the
`colors` given at `create` (or the daemon's defaults).

The queries still pass through to raw subscribers, because raw output is the PTY's
bytes unchanged. So:

- **A client must never send its emulator's answers as `INPUT`.** If your emulator
  generates replies, drop them; the program already has its answer, and a second one
  arrives as stray keystrokes.
- **A client that hands raw output to a real terminal** (a `g3d attach` in Ghostty)
  can't tell that terminal's replies from typing. It must remove query sequences from
  the bytes before writing them to its terminal. `g3d-wire` provides that filter.

## Flow control

termd never lets one slow subscriber stall a terminal or the other subscribers, or grow
the daemon. Each subscription has a queue of the frames termd has yet to write to it:
`OUTPUT`, `REPAINT` and events alike.

- **`flow: "lossy"`** (the default for `watch` and `attach`): when a frame would take a
  subscriber's queue past 4 MiB, the subscriber **lags**. termd drops its queued `OUTPUT`,
  `REPAINT`, `title`, `modes`, `pwd`, `size` and `bell` frames (never `role`, `lagged`,
  `exit`, `closed` or `error`) and queues nothing more for it until it has read everything
  still on its way. Then it **resyncs**, in this order:
  1. one `lagged` event. Its `seq` is the current `seq`, where output resumes. `dropped`
     is the number of `OUTPUT` bytes you did not get: `seq` minus the end of the last
     `OUTPUT` you got (0 for `mode: "none"` and for a subscriber scrolled back with `view`,
     which get no output);
  2. with `mode: "raw"`, a `REPAINT` at that `seq` (a view repaint if you are scrolled
     back); with `mode: "none"`, a `size` event;
  3. the state events, as at subscribe: `modes`, then `title` and `pwd` when set.

  Your screen and state are right again; only the dropped bytes' scrollback is missing
  from your emulator. Each lag ends in exactly one `lagged`. A subscriber that keeps
  falling behind lags again, each time with its own `lagged` and repaint.
- **`flow: "block"`** (the default for `own`): when the owner's queue passes 1 MiB,
  termd stops reading the PTY until it drains below 256 KiB. The program blocks on its
  writes, as it would with a slow real terminal, and nothing is dropped. Other
  subscribers keep their own lossy queues. An owner that stops reading holds the program
  back until it reads again, unsubscribes, or someone `take`s the terminal (which makes
  it lossy).

## Restarts (1.1)

A namespace is two processes: a small **holder** that keeps every terminal's program and PTY alive
and owns the listening socket, and the **brain** that speaks this protocol. The brain can restart
(it crashed, or `upgrade` replaced it) while every terminal keeps running. Its connections close;
the socket does not. A client that wants to ride a restart:

1. **When to reconnect.** On `ERROR` `restart`: at once, after a random delay of up to 100 ms. On a
   connection that just closed: with backoff, 100 ms doubling to 2 s, for as long as you are
   willing to wait (the glyph3d relay waits 30 s).
2. **What `connect` says.** While the holder lives, `connect` succeeds even before a brain is
   accepting; `HELLO` is answered when one is. `ENOENT` or `ECONNREFUSED` means no holder: the
   namespace and every terminal in it are gone. `ERROR` `brain_failed` means the holder is alive
   (so are the programs, frozen once they fill their output buffers) but no brain is running; its
   `message` says why. Retry slowly or tell a person.
3. **Same namespace?** Compare `WELCOME.instance` with the one you had. If it is the same, your
   terminals may still exist: `subscribe` again by `id` (not `create` with `if_exists: "adopt"`,
   which would start a new program if the terminal ended meanwhile). The `REPAINT` brings your
   screen back; `no_terminal` means that terminal ended. A different `instance` is a new namespace.
4. **Input is at most once.** Don't resend `INPUT` you sent before the connection closed: it may
   or may not have reached the program, and a repeated command line is worse than a lost key.
5. **Unknown is not empty.** Until a brain answers, you don't know which terminals exist. Don't
   forget terminals on the strength of an empty answer you didn't get.

After a planned restart (`upgrade`), each terminal continues exactly: `seq` resumes where it was
and nothing was skipped. After a crash, each terminal's screen comes back from a snapshot the
daemon saved a few seconds earlier (or blank, when none fits), the program is sent `SIGWINCH` so
it redraws, and `seq` resumes past every byte the crashed brain read, so it never repeats. Output
the crashed brain read but never saved is missing from screens and history; the status document
counts it (`unseen`, `restored`).

## Errors and closing

A malformed frame gets `ERROR` `{"code": "...", "message": "..."}` and the daemon closes
the connection:

| code | when |
|---|---|
| `bad_frame` | `len` under 8; an unknown frame type; a control payload that isn't one JSON object; a `REQUEST` without an integer `req`; any frame but `HELLO` before `WELCOME`; a second `HELLO` |
| `too_large` | `len` over `max_frame` |
| `version` | `HELLO` with a different major |
| `auth` | the peer is another user |
| `restart` | (1.1) the daemon's engine is being replaced on purpose; reconnect now ([Restarts](#restarts-11)) |
| `brain_failed` | (1.1) the holder answered because no brain is running; `message` says why and where the log is |

Request-level failures are `REPLY` errors and the connection stays.

When a terminal's program exits, its subscribers get the last `OUTPUT`, then `exit`,
then `closed`. A client should close its connection when it is done. A connection
closing never affects terminals: they keep running for the next client.

## Example: one session, byte by byte

A client connects, creates a shell, subscribes, sees the prompt `$ `, and types `ls`.

`HELLO` (client → daemon):

```
0000  2e 00 00 00 01 00 00 00 00 00 00 00 7b 22 70 72   ............{"pr
0010  6f 74 6f 22 3a 5b 31 2c 30 5d 2c 22 63 6c 69 65   oto":[1,0],"clie
0020  6e 74 22 3a 22 65 78 61 6d 70 6c 65 2f 30 2e 31   nt":"example/0.1
0030  22 7d                                             "}
```

`len` = `0x2e` = 46 = 8 header bytes after `len` + 38 bytes of JSON. Type `0x01`, flags
0, reserved 0, stream 0.

`WELCOME` (daemon → client; a 1.0 daemon's: a 1.1 `WELCOME` adds fields, which a 1.0 client
ignores):

```
0000  96 00 00 00 81 00 00 00 00 00 00 00 7b 22 70 72   ............{"pr
0010  6f 74 6f 22 3a 5b 31 2c 30 5d 2c 22 64 61 65 6d   oto":[1,0],"daem
0020  6f 6e 22 3a 22 67 33 64 2d 74 65 72 6d 64 2f 30   on":"g3d-termd/0
0030  2e 31 2e 30 22 2c 22 65 6e 67 69 6e 65 22 3a 22   .1.0","engine":"
0040  6c 69 62 67 68 6f 73 74 74 79 2d 76 74 2f 31 2e   libghostty-vt/1.
0050  30 2e 31 22 2c 22 6e 73 22 3a 22 74 65 73 74 22   0.1","ns":"test"
0060  2c 22 66 65 61 74 75 72 65 73 22 3a 5b 22 72 61   ,"features":["ra
0070  77 22 2c 22 76 69 65 77 22 2c 22 63 61 70 74 75   w","view","captu
0080  72 65 22 5d 2c 22 6d 61 78 5f 66 72 61 6d 65 22   re"],"max_frame"
0090  3a 31 36 37 37 37 32 31 36 7d                     :16777216}
```

`REQUEST` `create`:

```
0000  52 00 00 00 02 00 00 00 00 00 00 00 7b 22 72 65   R...........{"re
0010  71 22 3a 31 2c 22 6f 70 22 3a 22 63 72 65 61 74   q":1,"op":"creat
0020  65 22 2c 22 69 64 22 3a 22 74 31 22 2c 22 61 72   e","id":"t1","ar
0030  67 76 22 3a 5b 22 62 61 73 68 22 2c 22 2d 6c 22   gv":["bash","-l"
0040  5d 2c 22 63 6f 6c 73 22 3a 38 30 2c 22 72 6f 77   ],"cols":80,"row
0050  73 22 3a 32 34 7d                                 s":24}
```

`REPLY`: `{"req":1,"ok":true,"id":"t1","handle":7,"pid":41234,"created":true,"cols":80,"rows":24}`.

By now bash has printed `$ ` (2 bytes, positions 0 and 1). The client subscribes with
`{"req":2,"op":"subscribe","id":"t1","mode":"raw","role":"attach"}` and gets its
`REPLY`, stream 0, cutting at `seq` 2:

```
0000  52 00 00 00 82 00 00 00 00 00 00 00 7b 22 72 65   R...........{"re
0010  71 22 3a 32 2c 22 6f 6b 22 3a 74 72 75 65 2c 22   q":2,"ok":true,"
0020  68 61 6e 64 6c 65 22 3a 37 2c 22 72 6f 6c 65 22   handle":7,"role"
0030  3a 22 61 74 74 61 63 68 22 2c 22 73 65 71 22 3a   :"attach","seq":
0040  32 2c 22 63 6f 6c 73 22 3a 38 30 2c 22 72 6f 77   2,"cols":80,"row
0050  73 22 3a 32 34 7d                                 s":24}
```

Then a `REPAINT` on stream 7: `seq` = 2, cols = 80 (`50 00`), rows = 24 (`18 00`),
flags = 0, then the VT bytes (shortened here to the soft reset, home, clear and the
prompt; a real repaint carries the whole screen and modes):

```
0000  25 00 00 00 85 00 00 00 07 00 00 00 02 00 00 00   %...............
0010  00 00 00 00 50 00 18 00 00 00 00 00 1b 5b 21 70   ....P........[!p
0020  1b 5b 48 1b 5b 32 4a 24 20                        .[H.[2J$
```

The client types `l`, `s`, Enter. One `INPUT` frame, stream 7:

```
0000  0b 00 00 00 03 00 00 00 07 00 00 00 6c 73 0d      ............ls.
```

bash echoes it. `OUTPUT` on stream 7, `seq` 2 (`02 00 00 00 00 00 00 00`), bytes
`l s \r \n`:

```
0000  14 00 00 00 83 00 00 00 07 00 00 00 02 00 00 00   ................
0010  00 00 00 00 6c 73 0d 0a                           ....ls..
```

The next `OUTPUT` will have `seq` 6. Later the owner resizes and every subscriber gets an
`EVENT` on stream 7:

```
0000  35 00 00 00 84 00 00 00 07 00 00 00 7b 22 65 76   5...........{"ev
0010  22 3a 22 73 69 7a 65 22 2c 22 63 6f 6c 73 22 3a   ":"size","cols":
0020  31 30 30 2c 22 72 6f 77 73 22 3a 33 30 2c 22 73   100,"rows":30,"s
0030  65 71 22 3a 34 30 39 36 7d                        eq":4096}
```

A client speaking a future major gets this `ERROR` and a closed socket:

```
0000  49 00 00 00 ff 00 00 00 00 00 00 00 7b 22 63 6f   I...........{"co
0010  64 65 22 3a 22 76 65 72 73 69 6f 6e 22 2c 22 6d   de":"version","m
0020  65 73 73 61 67 65 22 3a 22 64 61 65 6d 6f 6e 20   essage":"daemon
0030  73 70 65 61 6b 73 20 31 2e 78 3b 20 63 6c 69 65   speaks 1.x; clie
0040  6e 74 20 73 65 6e 74 20 32 2e 30 22 7d            nt sent 2.0"}
```

## A minimal client

This Python 3 client (standard library only) lists terminals, then watches one and
prints its output. It is the whole of a read-only client.

```python
import json, socket, struct, sys

def send(sock, ftype, payload, stream=0):
    sock.sendall(struct.pack('<IBBHI', 8 + len(payload), ftype, 0, 0, stream) + payload)

def recv(sock):
    def exactly(n):
        buf = b''
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise EOFError('daemon closed the connection')
            buf += chunk
        return buf
    (length,) = struct.unpack('<I', exactly(4))
    ftype, _flags, _res, stream = struct.unpack('<BBHI', exactly(8))
    return ftype, stream, exactly(length - 8)

def request(sock, req, **fields):
    send(sock, 0x02, json.dumps({'req': req, **fields}).encode())
    while True:
        ftype, stream, payload = recv(sock)
        if ftype == 0x82:
            reply = json.loads(payload)
            if reply['req'] == req:
                return reply

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(sys.argv[1])
send(sock, 0x01, json.dumps({'proto': [1, 0], 'client': 'watch.py'}).encode())
ftype, _, payload = recv(sock)
assert ftype == 0x81, payload
print('terminals:', [t['id'] for t in request(sock, 1, op='list')['terminals']])
sub = request(sock, 2, op='subscribe', id=sys.argv[2], mode='raw', role='watch')
assert sub['ok'], sub
while True:
    ftype, stream, payload = recv(sock)
    if ftype == 0x85:                       # REPAINT: seq, cols, rows, flags, VT bytes
        sys.stdout.buffer.write(payload[16:])
    elif ftype == 0x83:                     # OUTPUT: seq, bytes
        sys.stdout.buffer.write(payload[8:])
    elif ftype == 0x84:                     # EVENT
        ev = json.loads(payload)
        if ev['ev'] == 'closed':
            break
    sys.stdout.buffer.flush()
```

Run it as `python3 watch.py <socket> <id>` in a terminal at least as big as the watched
one. It never sends `INPUT`, so it never forwards your terminal's query replies. An
interactive client would also put its terminal in raw mode, filter queries out of what it
writes, and send keystrokes as `INPUT`.

## Changing this protocol

- A new optional field, event, `op` or feature is a minor change. Add it, document it
  here, and list it in `WELCOME.features` when clients need to know.
- A client checks `features` before using anything newer than 1.0. A daemon answers an
  `op` it doesn't know with `unknown_op` and keeps the connection.
- Changing the meaning, type or default of an existing field, or the frame header, is a
  major change: a new `proto` major, refused by older peers at `HELLO`.
- Frame types `0x04`–`0x7F` (client → daemon) and `0x87`–`0xFE` (daemon → client) are
  free for future minors.

## Versions

- **1.1** (the first release): `status`, `status_follow`, `status_unfollow`, `upgrade`; the
  `status` event; `WELCOME.instance`, `generation`, `holder`; `ERROR` `restart` and
  `brain_failed`; the `busy` code; `create.env_base` and the `argv`/`login`/`cwd` reply fields;
  [Restarts](#restarts-11). Before any release, `create`'s defaults changed: `argv` was the
  daemon's `$SHELL` as a non-login shell, `cwd` the daemon's working directory, `scrollback_bytes`
  2 MiB, the socket fallback `$TMPDIR/g3d-<uid>`, and the environment the daemon's own
  plus termd's variables (without `TERM_PROGRAM`), with only `TMUX`/`TMUX_PANE` removed and no
  reserved names. No released client depends on those.
- **1.0**: the branch-only first cut: the core above, without what is marked (1.1).
