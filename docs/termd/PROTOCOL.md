# The termd wire, version 1.0

`g3d-termd` keeps terminals alive: it owns each terminal's pseudo-terminal (PTY), its
process and a libghostty-vt emulator holding the terminal's screen and scrollback.
Clients connect over a Unix socket to create terminals, type into them and watch them.
The glyph3d relay is one client, `g3d attach` is another, and anything you write from
this page is a third. This page is the whole contract. If the daemon and this page
disagree, the daemon has a bug.

The protocol is public and versioned. Nothing in it is specific to glyph3d.

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

## Transport

The daemon listens on a Unix stream socket (`SOCK_STREAM`). Its path is chosen by
whoever starts the daemon. The usual path is
`$XDG_RUNTIME_DIR/g3d/termd-<namespace>.sock`, with namespace `default`. A namespace is
an independent daemon with its own terminals; tests and second relays use their own.

The socket's directory is mode `0700` and the socket `0600`. The daemon checks the
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

## Handshake

The first frame a client sends is `HELLO`:

```json
{"proto": [1, 0], "client": "example/0.1"}
```

- `proto`: `[major, minor]` the client speaks. Required.
- `client`: a free-form name for logs. Required.

The daemon replies `WELCOME`:

```json
{"proto": [1, 0], "daemon": "g3d-termd/0.1.0", "engine": "libghostty-vt/1.0.1",
 "ns": "default", "pid": 41200, "features": ["raw", "view", "capture"],
 "max_frame": 16777216}
```

- `proto`: the daemon's `[major, minor]`.
- `features`: what this daemon supports beyond the 1.0 core. A client checks a feature
  before using it. Known features: `raw`, `view`, `capture` (all in 1.0), `cells`
  (packed cells, reserved).
- `max_frame`: the largest payload either side may send.

If the majors differ, the daemon sends `ERROR` with code `version` instead and closes.
Minors never cause a refusal: a newer minor only adds fields, events and features, and
an older peer ignores them. Until `WELCOME`, the only frame a client may send is
`HELLO`.

## Requests and replies

Every `REQUEST` payload has `req` (a client-chosen integer, unique among the requests
that connection has in flight) and `op`. The daemon answers each with one `REPLY`
carrying the same `req`:

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
| `bad_request` | a field is missing, has the wrong type, or is out of range |
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
| `argv` | the daemon's `$SHELL`, else `/bin/sh` | program and arguments, run directly (no shell) |
| `cols`, `rows` | required | initial size, 1 to 4096 each |
| `cwd` | the daemon's working directory | |
| `env` | `{}` | added to the environment (below); a `null` value removes a variable |
| `if_exists` | `"error"` | `"adopt"` returns the live terminal with this id instead of failing |
| `scrollback_bytes` | daemon default (2 MiB) | primary-screen history cap; the daemon clamps it to its own maximum |
| `colors` | daemon defaults | the default foreground, background and cursor colours termd reports when the program asks (OSC 10/11/12). Set them to what your renderer draws |
| `cell_px` | `[8, 16]` | cell size in pixels, reported to programs that ask for the window size in pixels (`CSI 14 t`, `CSI 16 t`) |

The program's environment is the daemon's own, then `TERM=xterm-256color`,
`COLORTERM=truecolor`, `G3D_TERMD_ID=<id>` and `G3D_TERMD_SOCKET=<socket path>`, then
`env`. `TMUX` and `TMUX_PANE` are removed: the program is not inside tmux.

Reply:

```json
{"req": 1, "ok": true, "id": "t1", "handle": 7, "pid": 41234, "created": true,
 "cols": 80, "rows": 24}
```

`created` is `false` when `if_exists: "adopt"` returned a live terminal; then `cols` and
`rows` are its current size, not the requested one. `create` does not subscribe.

### `list`

```json
{"req": 2, "op": "list"}
```

```json
{"req": 2, "ok": true, "terminals": [
  {"id": "t1", "handle": 7, "pid": 41234, "argv": ["bash", "-l"], "cwd": "/some/dir",
   "cols": 80, "rows": 24, "title": "~/src", "alt": false, "seq": 18211,
   "created_at": 1794480000123, "subscribers": {"own": 1, "attach": 0, "watch": 2}}]}
```

`created_at` is Unix epoch milliseconds. `title` is the last OSC 0/2 title. Only live
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
  **takes** it: the previous owner is demoted to `attach` and gets a `role` event.

Reply, then frames, in this order:

1. `REPLY` `{"req": 4, "ok": true, "handle": 7, "role": "attach", "seq": 18211, "cols": 80, "rows": 24}`
2. With `mode: "raw"`, one `REPAINT` at that `seq`.
3. `OUTPUT` from that `seq` on, and events as they happen.

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
after replying. Every shell in the namespace dies. It exists for tests and for
replacing the daemon.

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
`OUTPUT`.

| `ev` | fields | when |
|---|---|---|
| `size` | `cols`, `rows`, `seq` | the owner resized; bytes from `seq` on are at the new size |
| `title` | `title` | the program set its title (OSC 0 or 2) |
| `modes` | `alt`, `mouse`, `mouse_sgr`, `bracketed_paste`, `app_cursor`, `focus` (all bool) | any of these changed. `mouse` is true when the program asked for any mouse reporting (1000, 1002 or 1003) |
| `bell` | | BEL |
| `pwd` | `pwd` | the program reported its directory (OSC 7) |
| `role` | `role` | your role changed (another client took ownership) |
| `lagged` | `dropped` (bytes), `seq` | you fell behind and were resynced (see [Flow control](#flow-control)) |
| `exit` | `code` or `signal`, `seq` | the program exited; `seq` is the end of its output. `signal` is the signal's name without `SIG` (`"HUP"`) |
| `closed` | | the terminal is gone; the handle is dead. Always last |
| `error` | `code`, `message` | something with no reply went wrong: an `INPUT` refused (`not_subscribed`, `read_only`, `no_terminal`, or `input_full` when the program has 1 MiB of unread input), or the terminal failed inside termd (`panic`; `exit` and `closed` follow) |

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

termd never lets one slow subscriber stall a terminal or the other subscribers. Each
subscription has an output queue.

- **`flow: "lossy"`** (the default for `watch` and `attach`): if a subscriber's queue
  passes 4 MiB, termd drops what is queued, sends `EVENT` `lagged` with the number of
  bytes dropped, and then a `REPAINT` at the current `seq`. The subscriber's screen is
  right again; the dropped bytes' scrollback is missing from its emulator only.
- **`flow: "block"`** (the default for `own`): when the owner's queue passes 1 MiB,
  termd stops reading the PTY until it drains below 256 KiB. The program blocks on its
  writes, as it would with a slow real terminal, and nothing is dropped. Other
  subscribers keep their own lossy queues.

## Errors and closing

A malformed frame (bad `len`, `len` over `max_frame`, a JSON payload that doesn't parse,
`REQUEST` before `WELCOME`) gets `ERROR` `{"code": "...", "message": "..."}` and the
daemon closes the connection. Codes: `bad_frame`, `too_large`, `version`, `auth`.
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

`WELCOME` (daemon → client):

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
