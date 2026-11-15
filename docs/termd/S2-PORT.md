# S2: the relay in Rust

S2 rewrites `glyph3d-cli` (the Go relay, `cli/*.go`, 8.6k lines plus 4.6k of tests) as the
Rust crate `crates/glyph3d-cli`. It is a parity port: every byte a browser, a controller or a
sensor device receives stays the same, including the legacy big-endian `0x01` OUTPUT and `0x02`
RPC-binary frames. The proof is a **wire tape**: scripted sessions recorded against the Go relay
and diffed against the Rust one.

This page is the plan that 4–5 agents port from in parallel. It fixes what has to be decided
before they fan out:
- the crate layout;
- the shared seams, and the Go behaviours every component would otherwise reinvent differently;
- the work items and their gates;
- the tape harness;
- the merge order.

Read [DESIGN.md](./DESIGN.md) and [PROTOCOL.md](./PROTOCOL.md) first. S2 builds on S1 as built
(termd, `g3d-wire`, the `g3d` client library). Plan decisions D1–D12 stand. D10 puts the relay at
`crates/glyph3d-cli`, replacing `cli/`.

## What changes, and what doesn't

**Unchanged on every wire:**
- **Browser:** the WebSocket messages, JSON shapes and key order, the `0x01`/`0x02` frames, the
  four display planes and their loss policies.
- **Controllers:** handshake, replies, `ERR:` texts, `log.follow` pushes.
- **Sensor devices:** handshake and provenance stamping.
- **HTTP:** the static app.
- **The `glyph3d-cli` client:** stdout, stderr and exit codes for every verb and client
  command. Tools and agents parse them.

**Changes:**
- **The adapters dissolve into the relay.** Today the relay forks a `glyph3d-cli attach <id>` per
  terminal, and that adapter dials back as a controller. In Rust each terminal gets a **virtual
  controller**: a `ctrl-N` entry in the same controller table, drawing its id from the same
  counter. It runs as a task inside the relay that holds its own termd connection.
  - The display sees exactly what a forked adapter produced: `client_connected`,
    `{"cmd":"terminal.create …","from":"ctrl-N"}`, the 2 s `terminal.ping`, `0x01` frames,
    `terminal.close`, `client_disconnected`. Ownership and input routing are unchanged.
  - The `attach` subcommand is deleted, not kept as a dual path.
- **Process-level logs** (pids of adapters that no longer exist) change. Two log lines are a
  contract because `tools/termd-relay-check.mjs` greps them:
  - `[attach] <id> adopted in termd namespace "<ns>" (<daemon>, pid N): <argv>`
  - `[attach] <id>: LOST termd (namespace "<ns>")…`

  Both stay byte for byte, and so does the `in use` wording of the bind retry (which
  `tools/lib/wall-relay.mjs` reads).
- **The build:** `make` builds the relay with cargo. Go leaves the repo at cutover.

## Crate and module layout

```
Cargo.toml                       workspace (unchanged members = crates/*); S2-0 adds the deps below
crates/
  g3d-wire/                      S1: termd frames/ops/filter (unchanged)
  g3d-termd/                     S1: the daemon (unchanged)
  g3d/                           S1: paths, blocking client, start; S2-D adds `aclient` (tokio)
  glyph3d-cli/
    Cargo.toml                   bin `glyph3d-cli` + lib (for integration tests)
    web/                         gitignored: `make prep` stages app/dist here (rust-embed)
    src/
      main.rs                    S2-0  subcommand dispatch: serve | version | client verbs
      lib.rs                     S2-0  module tree
      config.rs                  S2-0  ServeConfig, the relay-wide settings (termd ns/bin, record dir, debug)
      go/                        S2-0  the Go-compat layer (below): json, fmt, err, flag, log, utf8, b64
      wire/                      S2-0  legacy.rs (0x01, 0x02), call.rs (`call` bundle), rpc.rs (JSON-RPC types)
      bus.rs                     S2-0  the seams: DisplayPort, ControllerSink, RpcService, RelayVerb,
                                       RelayMessage, TerminalHost, LogSink, Reach, DisplayLifecycle
      children.rs                S2-0  the spawner thread, the kill-on-signal registry, Pdeathsig
      relay/                     S2-A  mod (state, ids, roles), conn, display (4 planes + priority
                                       writer), sources, controllers (routing, verb dispatch),
                                       relay_msg (atlas.*, log.follow), rpc_dispatch (timeouts),
                                       http (static FileServer, bind retry, banner), record, git_recent
      fs/                        S2-B  mod (FSHandler, roots, resolve_path, uri_to_path), read, tree,
                                       write, atomic_{unix,windows}, git_diff, search, regex_go, filter
      agents/                    S2-C  events (followers, batching), sessions (poll, resolve), tail,
                                       gomux (export watcher, tree), gomux_screens (attach/resize/pane sizes)
      terminals/                 S2-D  #[cfg(unix)] adapter (virtual controller), host (spawn,
                                       recover, readopt, seed ids), seed_history; a non-unix stub
                                       answering "terminals need g3d-termd, which runs on unix only"
      logstore.rs                S2-E
      lsp/                       S2-E  mod (supervisor, servers, docs), framing (Content-Length JSON-RPC)
      client/                    S2-E  session, render (records/table/stats), screenshot,
                                       log_follow, repl, fullsnapshot
    tests/                       integration tests per item (fake `agent`/`tmux` scripts, private termd)
```

**Ownership rule.** Each directory or file above has exactly one owning item. These are S2-0's,
and nobody else edits them after fan-out:
- the workspace `Cargo.toml` and `Cargo.lock`;
- `main.rs`, `lib.rs`, `bus.rs`;
- `go/`, `wire/`, `children.rs`.

If a seam has to change, the integrator lands that change on `termd` first, and the items rebase
onto it.

**No item adds a dependency.** S2-0 adds them all up front, so `Cargo.lock` never conflicts. An
item that finds it needs another crate asks the integrator.

Planned `crates/glyph3d-cli/Cargo.toml` (S2-0 writes it; versions pinned exactly, as the workspace does):

```toml
[package]
name = "glyph3d-cli"              # version/edition/rust-version/license/publish from the workspace

[[bin]]
name = "glyph3d-cli"
path = "src/main.rs"

[dependencies]
g3d-wire.workspace = true
g3d = { workspace = true, features = ["tokio"] }   # the async termd client (S2-D)
serde.workspace = true
serde_json.workspace = true      # NEVER the `preserve_order` feature anywhere in the workspace
tokio.workspace = true           # + "process", "fs" features at the workspace level
rustix.workspace = true
axum = { version = "0.8.9", features = ["ws"] }    # server + WebSocket upgrade
tokio-tungstenite = "…"          # the client; the same tungstenite axum pulls in (one copy)
rusqlite = { version = "…", features = ["bundled"] }  # FTS5 trigram; see "SQLite version" below
regex = "1.13.1"
regex-syntax = "0.8.11"          # the Go-dialect translator's parser
rust-embed = "8.13.0"
base64 = "0.22.1"
walkdir = "2.5.0"
tempfile = "3.27.0"              # the atomic replace (renameio's semantics)
chrono = "0.4.45"                # local-time renders, RFC3339Nano, the recording names
lsp-types = "…"
```

Not clap: `glyph3d-cli` keeps Go's `flag` grammar (below).

**SQLite version.**
- The Go relay's modernc build is **SQLite 3.53.2**.
- rusqlite 0.37 bundles **3.50.2** (DESIGN.md probe).
- **Fix:** S2-0 pins the newest rusqlite whose bundled SQLite is ≥ 3.53. If none exists yet, the
  tape masks `log.stats.bytes` (page count depends on the version), recorded as a named
  divergence.

## The Go-compat layer (`go/`): what every component would otherwise get wrong

The Go relay's bytes come from `encoding/json`, `fmt`, `os` error strings and `flag`. Any of
these reimplemented ad hoc in five worktrees gives five different results. These behaviours were
measured on the Go relay's toolchain (go1.27, module `go 1.26.1`):

| Area | Go behaviour the wire depends on | `go::` provides |
|---|---|---|
| Map keys | `map[string]any` marshals with keys **sorted** (bytes): `{"cmd":…,"from":…}`, `{"id":…,"jsonrpc":"2.0","result":…}`. Structs keep their declared order. | `serde_json::Map` (a BTreeMap, sorted) is right **only** while no crate enables `preserve_order`. A test asserts it. Structs: declare fields in Go's order. |
| String escaping | `<` `>` `&` → `<` `>` `&`; U+2028/2029 escaped; `\b` `\f` `\n` `\r` `\t` short; other controls `\u00XX` lowercase; DEL raw. | `go::json::to_vec` with a custom `serde_json::ser::Formatter`. |
| Invalid UTF-8 | Each invalid **byte** becomes U+FFFD, written raw rather than escaped. Hits git diff output, search lines, agent lines, `{"cmd": raw}`. | `GoStr(Vec<u8>)`: a byte string that serializes the Go way. Any wire string that didn't come from validated UTF-8 uses it. |
| `json.RawMessage` | Re-emitted **compacted, HTML-escaped**. A device's pretty JSON arrives at the display compacted. The same goes for `agent sessions` output, log `attrs`, RPC `id`s and `source.frame` `data`. Invalid raw makes `Marshal` fail: Go logs and drops that reply. | `GoRaw(Box<[u8]>)`: compact + escape on serialize, error on invalid. |
| Numbers | Floats: shortest digits, `'f'` form for 1e-6 ≤ \|x\| < 1e21, else `1e+21` / `1e-7`. Recording timestamps (`"t"`) are floats. | `go::json` `write_f64`. |
| nil vs empty | `[]string(nil)` → `null`, `[]string{}` → `[]`. The Go code picks one at each site (for example `recovered := []string{}`). | A port rule: mirror the Go site. Option → `null`, Vec → `[]`. |
| `WriteJSON` | gorilla's `ws.WriteJSON` (controller `{"relay":…}` replies, `display already connected`) **appends `\n`**. `sendToDisplay(json.Marshal(…))` doesn't. | `go::json::to_line` versus `to_vec`. Each reply site is named in the item's notes. |
| Decoding | Field names match **case-insensitively**, and the last occurrence in input order wins. `null` into a non-pointer leaves the zero value. A lone `\ud800` decodes to U+FFFD. Invalid UTF-8 decodes to U+FFFD. Unknown fields are ignored. serde derive does **none** of this: it rejects duplicates and `null` into `String`, and it rejects lone surrogates. | `go::json::decode::<T>()`: a streaming key-canonicalizing pass against `T`'s JSON names (a small `go_fields!` macro), then serde. |
| Error text on the wire | `open /x: no such file or directory` (a PathError with Go's own errno table); `exit status 1` / `signal: killed`; base64's `illegal base64 data at input byte N`; `%q` / `strconv.Quote`. | `go::err` (errno table from Go's `zerrors_{linux,darwin}`, PathError, exec status) and `go::fmt` (`quote`, `%g`, `Duration` formatting such as `10s` / `1m0s` / `300ms`). |
| base64 decode | `StdEncoding` ignores `\r` / `\n` in the input. `parseCallLine` also takes base64url and unpadded input. | `go::b64`. |
| Runes | `utf8.RuneCount` and `DecodeRune` count an invalid byte as one rune. Search `col` / `length` and `capRunes` depend on that. | `go::utf8`. |
| Flags | `flag`: `-x` and `--x`, `-x=v`, bool flags without a value, `time.ParseDuration` (`5s`, `300ms`, `1m30s`), repeatable string lists. Global flags go before the verb. | `go::flag`, a ~150-line parser. Usage text need not match byte for byte; behaviour must. |
| Logs | `log.Printf` writes to stderr with the prefix `2006/01/02 15:04:05 `. | `golog!`. |
| SQLite errors | modernc: `SQL logic error: no such column: nope (1)`, that is `<errstr>: <errmsg> (<code>)`. Column values from `log.query` are strings: integers in decimal, floats through Go's `'g'` (`1e+21`, `0.30000000000000004`), NULL → `null`. | `go::sql` (`errstr` via `sqlite3_errstr`), used by `logstore`. |

S2-0 proves this layer against Go itself: a small Go program (scratch only, never committed)
marshals a corpus of values. The expected bytes are committed as
`crates/glyph3d-cli/tests/fixtures/gojson.jsonl`, and `cargo test` checks `go::json` against
every line. The same applies to `go::err` (errno strings), `go::fmt` (durations, `%g`, quote) and
`go::flag`.

## The seams (`bus.rs`): what must exist before fan-out

Each component talks to the relay core only through these seams. S2-0 writes them with
working-but-empty registrations, so each item compiles and tests alone.

```rust
/// The connected display, as the four planes of relay.go (startDisplayWriter's priorities).
pub trait DisplayPort: Send + Sync {
    fn current(&self) -> Option<DisplayId>;
    /// Control (JSON text): non-blocking; a full queue (64) drops it with
    /// "[relay] display write queue full, dropping message".
    fn send_control(&self, msg: Vec<u8>);
    /// JSON-RPC notification {"jsonrpc","method","params"} on the control plane.
    fn notify(&self, method: &str, params: &dyn erased_serde::Serialize);
    /// RPC binary result (0x02) on the control queue: waits for room, or the display leaving.
    async fn send_rpc_binary(&self, frame: Vec<u8>);
    /// Terminal OUTPUT (0x01): lossless; waits (backpressure) or returns when the display goes.
    async fn send_terminal_bytes(&self, frame: Vec<u8>);
    /// Sensor frame: drop-oldest at depth 4. Never blocks.
    fn send_sensor_frame(&self, envelope: Vec<u8>) -> FrameOutcome;
    /// agentEvents/*: lossless; waits up to `wait` (0 = while that display stays).
    async fn push_agent_event(&self, to: DisplayId, method: &str, params: &dyn erased_serde::Serialize,
                              wait: Duration) -> Result<(), PushError /* Gone | Stalled */>;
}

/// A controller endpoint: a WebSocket's writer task, or a terminal's virtual controller.
pub trait ControllerSink: Send + Sync { fn send_text(&self, msg: Vec<u8>); }

/// One JSON-RPC request from the display. Replies through the context (text or 0x02).
pub struct RpcCtx { pub id: GoRaw, pub display: DisplayId, pub port: Arc<dyn DisplayPort> }
impl RpcCtx { fn result(&self, v: &impl Serialize); fn error(&self, code: i64, msg: &str, data: Option<&impl Serialize>);
              async fn binary(&self, hdr: &impl Serialize, payload: &[u8]); }

/// fs/*, agentSessions/*, agentEvents/*, gomux/list (10 s budget), lsp/* (30 s budget).
pub trait RpcService: Send + Sync {
    fn methods(&self) -> &'static [&'static str];
    async fn handle(&self, method: &str, params: GoRaw, ctx: RpcCtx);
}

/// Controller plain-text verbs answered relay-side (log.*, git.recent, source.list, source.record).
pub trait RelayVerb: Send + Sync {
    fn name(&self) -> &'static str;
    async fn run(&self, rest: &str) -> Result<VerbReply /* {text, data} */, String /* "ERR: …" */>;
}

/// {"relay": "<name>", …} messages from any role: atlas.*, terminal.spawn/recover,
/// gomux.attach/resize, log.follow/unfollow. The reply goes to the display's queue or the
/// controller's socket (WriteJSON: trailing \n).
pub trait RelayMessage: Send + Sync {
    fn names(&self) -> &'static [&'static str];
    async fn handle(&self, msg: RelayMsg, from: Origin /* role + client id */, reply: Replier);
}

/// The terminals (S2-D), as others need them: gomux screens (S2-C) and seed-history.
pub trait TerminalHost: Send + Sync {
    async fn list(&self) -> Result<Vec<TermdTerminal>, String>;   // "unknown is not empty"
    async fn start(&self, id: &str, cols: u16, rows: u16, argv: Vec<String>) -> Result<(), String>;
    async fn screen_live(&self, id: &str) -> bool;                // gomuxScreenLive, 15 s fork grace
}

pub trait LogSink: Send + Sync { fn ingest(&self, rec: LogRec) -> Result<LogRec, String>; }
pub trait Reach: Send + Sync { fn add_root(&self, resolved: &Path) -> bool; }
pub trait DisplayLifecycle: Send + Sync { fn connected(&self, d: DisplayId); fn gone(&self, d: DisplayId); }
```

(The trait syntax is a sketch: async methods may take the `async-trait` form or return boxed
futures. S2-0 picks one and uses it everywhere.)

`children.rs` (S2-0) is shared by agents, gomux and LSP:
- **One long-lived spawner thread** forks every `agent` / `tmux` / language-server child, with
  the tokio runtime handle entered. `PR_SET_PDEATHSIG` fires when the **forking thread** exits,
  and tokio's blocking-pool threads retire after about 10 s idle (the plan's Pdeathsig trap).
- Policies:
  - `DieWithRelay`: SIGTERM on Linux, plus the kill-on-signal registry;
  - `KillWithRelay`: SIGKILL, for LSP, not registered;
  - `Detached`: termd's `--daemon` start. Never pdeathsig'd, never registered.
- **The SIGINT/SIGTERM watcher:** kill the registered children, log
  `[relay] <sig>: stopped N agent child(ren), exiting`, exit 130/143.
- Ports `children_test.go` and `children_linux_test.go`. A helper relay that is SIGKILLed takes
  its `agent` children with it.

## Work items

Sizes are Rust lines excluding tests. Every item's gate also includes:
- `cargo fmt --check` and `cargo clippy -p glyph3d-cli -- -D warnings`;
- `cargo test --workspace --features g3d-termd/test-hooks`;
- every tape scenario already merged still at zero diffs.

Build with `CARGO_BUILD_JOBS=8`, with target dirs in scratch. Heavy runs follow the machine rule:
`free -g` available ≥ 16, wrapped in `flock` on the shared heavy lock, one at a time.

### S2-0 `foundation` (serial, first)

- **Go files:** `call.go`, `children.go`, `children_linux.go`, `children_other.go`, `embed.go`,
  `main.go` (the dispatch skeleton only), the frame encoders from `attach_unix.go`
  (`encodeOutputFrame`) and `fs.go` (`sendRPCBinaryResult`).
  `filelock_unix.go` / `filelock_windows.go` have **no caller**: they're deleted, not ported.
- **Builds:**
  - the crate skeleton and all dependencies;
  - `go/`, `wire/`, `bus.rs`, `children.rs`, `config.rs`;
  - `main.rs` dispatching to the module entry points. Unported entry points fail loud
    (`not ported yet: <what>`) on the branch only; none survive to cutover;
  - the `web/` staging and `rust-embed` wiring.
- **Size:** ~1.8k.
- **Tests:**
  - from `call_test.go`: `TestCallLineRoundTrip`, `TestParseCallLineForms`;
  - the children tests;
  - the Go-generated `go::` corpora;
  - the `0x01` / `0x02` vectors of `terminal-frame-format-check.mjs` and `bridge-binary.test.mjs`
    as Rust tests.
- **Gate:** the above, plus `cargo check -p glyph3d-cli --target x86_64-pc-windows-gnu` (the
  unix-only seams compile out).

### S2-T `tape` (parallel with S2-0, JavaScript only)

- **Go files:** none. All of `cli/` is its oracle.
- **Builds:**
  - the wire-tape harness (below);
  - every scenario;
  - the fake `agent` and `tmux` scripts;
  - the golden tapes, recorded from the Go relay at the S2 base commit;
  - `--cli` honoured by `tools/lib/wall-relay.mjs` and `tools/termd-relay-check.mjs`. Both hardcode
    `./glyph3d-cli`; they take `G3D_CLI`, which `tools/check.mjs` sets from `--cli`;
  - a `relay-tape` entry in `tools/check-manifest.mjs`: tier full, scope relay, needs
    `own-relay` + `termd`.
- **Size:** ~1.2k JS plus fixtures.
- **Gate:**
  - every scenario recorded **twice** against Go normalizes to identical tapes (the harness is
    deterministic before it judges Rust);
  - a lint: no tracked tape holds a home path, username or hostname;
  - `check --cli ./glyph3d-cli` (Go) passes;
  - pointed at a Rust binary, it lists the scenarios in `PENDING`.

### S2-A `relay-core`

- **Go files:**
  - `relay.go`, except the terminal half (S2-D) and the gomux handlers (S2-C):
    `Relay`, `handleConnection`, the planes and `startDisplayWriter`, sources and
    `parseSourceHandshake`, the controller and display routing, `handleRelayMessage` (atlas.*,
    log.follow), `splitRelayVerb` / `handleRelayCommand` and their dispatch (`parseLogSearchArgs`,
    `parseSinceDuration`), `gitRecent`, `wireFS`, `RunServer` / `RunRelay`, `listenAndServe`,
    `isWebSocketUpgrade`, `getLANAddresses`;
  - `record.go`;
  - the serve half of `main.go` (`serveCmd`, `versionCmd`);
  - `embed.go`'s serving.
- **Notes:**
  - **WebSocket limits:** no message or frame size limit (gorilla has none: atlas PNGs and 10 MB
    writes arrive in one frame) and no compression.
  - **Writers:** every WebSocket has exactly one writer task (gorilla forbade concurrent writes;
    Go mostly obeyed, except `pushLogToFollowers`).
  - **Close behaviour:** a dropped connection closes TCP without a close frame (peer sees 1006),
    as `defer ws.Close()` did.
  - **Ids:** `ctrl-N` and `src-<kind>-N` share one counter.
  - **First message:** a `{"relay":…}` first message is answered before any role is assigned.
  - **The display's RPC dispatch:**
    - `fs/*` and the agents methods get a 10 s timeout that sends `request timed out` while the
      late result is **still** sent;
    - `lsp/*` gets 30 s;
    - `filesystem not enabled …` / `LSP not enabled …` (-32003) when no service is registered.
  - **Static HTTP** mirrors `http.FileServer` for what the app ships:
    - `/` → `index.html`; `/index.html` → 301 `./`; a directory → its listing; a missing file →
      `404 page not found\n`;
    - Content-Type from the overrides plus Go's builtin extension table;
    - `Accept-Ranges: bytes`; no `Last-Modified` (embed has none);
    - a non-upgrade request in `--relay-only` → gorilla's 400 text.
- **Size:** ~1.7k.
- **Tests:**
  - `relay_source_test.go` (11);
  - `record_test.go` (3);
  - `TestSplitRelayVerbUnwrapsCall` (call_test.go).
- **Gate:**
  - the tests above;
  - tapes `roles`, `routing`, `sources`, `relay-verbs`, `atlas`, `http` at zero diffs;
  - `bun tools/hand-source-check.mjs --relay <port>` against the Rust relay (parked tier, but it
    is the sensor plane end to end);
  - `bun tools/check.mjs relay --cli target/release/glyph3d-cli`.

### S2-B `fs`

- **Go files:** `fs.go`, `fssearch.go`, `fs_atomic_unix.go`, `fs_atomic_windows.go`.
- **Notes:**
  - **Walk order:** walks are lexical by byte name (WalkDir); use `walkdir` with
    `sort_by_file_name`.
  - **Path resolution:** `resolvePath`'s three-candidate precedence and the `..` string rule are
    ported verbatim, with their tests.
  - **Atomic replace (unix):** temp in the target dir, fsync, rename, the existing mode kept,
    parent dir fsynced best-effort.
  - **Search regexes use Go's RE2 dialect.** `regex_go.rs` translates `\d \w \s \b \B` (inside
    and outside classes) to their ASCII forms, because Rust's are Unicode and Go's are ASCII.
    `(?i)` stays Unicode simple folding, as in Go. Matching runs on bytes (`regex::bytes`).
    `col` / `length` are counted with `go::utf8`.
  - **Search order:** the match order out of the worker pool is nondeterministic in Go too. The
    `fs/searchDone` single-done guarantee, cancel and refine semantics and caps are ported
    exactly.
  - **Git diff:** `git diff` output goes on the wire as `GoStr` (it can be invalid UTF-8).
- **Size:** ~2.0k.
- **Tests:** `fs_test.go` (32), `fssearch_test.go` (10), plus a regex differential corpus. The
  expected matches come from Go at S2-0 time and are committed as a fixture.
- **Gate:**
  - the tests above;
  - tapes `fs-read`, `fs-tree`, `fs-write`, `fs-search`, `fs-git` at zero diffs;
  - `bun tools/bridge-binary.test.mjs`.

### S2-C `agents`

- **Go files:**
  - `agentevents.go`;
  - `gomux.go` (the export watcher, the tree, `gomux/list`, `gomux.attach` / `gomux.resize`,
    pane-size polling, `gomuxScreenScript`).
- **Notes:**
  - **Spawning:** every `agent` and `tmux` child goes through `children.rs`.
  - **Followers:** shared per (transcript, from) and refcounted by (display, session). Batches of
    ≤ 50 ms or 256 KB; a 10 s stall drops the subscription with an `ended` code -1, sent after
    the queued lines.
  - **`agentSessions/changed`:** pushed only when the shown fields change. `sessionShape` is
    internal; the pushed `sessions` is the raw output through `GoRaw` (compacted).
  - **tmux:** runs with `TMUX` removed from the environment and never attaches a client.
  - **Screens:** `gomux.attach` starts a screen through `TerminalHost::start`. Until S2-D lands,
    that path is the one tape step in `PENDING` for this item.
- **Size:** ~1.6k.
- **Tests:**
  - `agentevents_test.go` (19). Its `fakeAgentScript` is reused verbatim as a test fixture;
  - `gomux_test.go` (5).
- **Gate:**
  - the tests above;
  - tapes `agents` and `gomux` at zero diffs, with fake `agent` and `tmux`;
  - `bun tools/agent-events.test.mjs` and `bun tools/session-books.test.mjs`;
  - the live read-only check from CHECKS.md ("Agent sessions + events"), against the real
    `agent`:
    - a scratch relay with its own port, termd namespace and `CLAUDE_CONFIG_DIR`, run with
      `--no-gomuxai` off but `gomux.autoScreens` off and no `gomux.attach`;
    - follow, read and close;
    - then SIGKILL the relay: no `agent` child outlives it.

### S2-D `terminals`

- **Go files:**
  - `termd.go`, `attach.go`, `attach_unix.go`, `attach_windows.go`;
  - relay.go's terminal half: `spawnTerminalAdapter`, `startAdapter`, `readoptOrphan`,
    `adapterArgs`, `liveTerminalIDs`, `seedTermSeqFromTermd`, `seedTermSeq`, `recoverTerminals`;
  - `client.go`'s `seedHistoryCmd`.
- **Builds:**
  - **`g3d::aclient`:** a tokio termd client in crate `g3d` behind a `tokio` feature, beside the
    blocking one and sharing `paths` and `start`. gomuxai's future backend gets it for free.
  - **The virtual adapter.** Everything `runTerminal` did, as a relay task:
    - `terminal.create <id> <c> <r> --scale <%g>`, sent as `ctrl-N`;
    - create-or-adopt, then subscribe `own`;
    - the 16 ms / 16 KiB coalescer;
    - size stamps from `size` events, plus a repaint on each;
    - `terminal.bytes` / `key` / `paste` / `mouse` / `resize` / `scroll` / `refresh` / `shutdown`;
    - the wheel on the alt screen (termd `mouse` wheel notches at the pointer's cell);
    - the 2 s ping and its `ERR: no terminal` → recreate, at most once per 2 s, with repaints at
      150 / 500 / 1200 ms;
    - detach-not-kill;
    - `terminal.close` on teardown.
  - **Readopt.** A forked adapter used to die by signal or crash. Now a virtual adapter whose
    task panics or ends with an unexpected error is re-adopted:
    - only once termd lists it with `own == 0`;
    - at most 3 times a minute, with the same log text.

    A clean end (`closed`, kill, LOST termd, relay shutdown) is not re-adopted. Test hook,
    mirroring termd's: with `G3D_RELAY_TEST_HOOKS=1`, a `terminal.bytes` carrying a magic string
    panics that adapter's task.
  - **termd ready.** S2 ports whichever relay is current when it starts. If termd ready (DESIGN.md:
    holder and brain, protocol 1.1) has landed in the Go relay by then, the port carries it too: the
    reconnect rule of "Riding a restart" in each virtual adapter (`LOST termd` only when the
    window ends or `instance` changed), the per-namespace status connection (`cli/termdstatus.go`:
    its six states, the grace, the redial, re-adoption when a brain answers again), the
    `termd/status` notification on its one-slot latest-wins display plane and request, and the
    `termd.status` verb. The tape gains a `termd/status` scenario (with `at`, pids and the gauges
    masked).
- **Rewritten checks:**
  - `tools/termd-relay-check.mjs`'s "adapter killed" step finds no process to `ps`; it uses the
    hook instead;
  - its other steps and the two contract log lines stay.
- **Size:** ~1.3k (relay side) + ~0.3k (`aclient`).
- **Tests:**
  - `relay_terminals_test.go` (5, against a private termd under scratch);
  - `attach_unix_test.go` (2: `TestWheelBytes`, and `TestHandleInboundRoutesOnlyItsOwnTerminal`
    as the virtual adapter's inbound router);
  - new: panic → readopt; recreate debounce; the ping cadence.
- **Gate:**
  - the tests above;
  - tape `terminals` at zero diffs;
  - `bun tools/termd-relay-check.mjs` and `bun tools/terminal-readopt.test.mjs`;
  - then, heavy (memory check, flock, alone):
    `bun tools/check.mjs wall-e2e wall-text-perf --cli target/release/glyph3d-cli`.

### S2-E `logs-lsp-client`

- **Go files:**
  - `logstore.go`;
  - `lsp.go`, `lsp_linux.go`, `lsp_other.go`;
  - `client.go` (all but `seedHistoryCmd`);
  - the client half of `main.go`;
  - `fullsnapshot.go`. It has no caller in the repo. Port it unless the operator drops it, which would
    be a named removal.
- **Notes:**
  - **Log store:** the schema, coalescing, prune, the FTS5 trigram search with a LIKE fallback,
    and `VACUUM INTO`. Error text goes through `go::sql`.
  - **LSP:** a Content-Length JSON-RPC framer plus `lsp-types` replace `go.lsp.dev`. The
    server-facing traffic may differ; `lsp/*` replies to the display must not.
  - **The client:** a tokio-tungstenite controller covering:
    - the handshake;
    - `session` redial after a failed exchange;
    - `oneShotLine`;
    - `printResponse` with its renders (the 120-rune clip, `∅`, `─` rules);
    - REPL and pipe modes;
    - `screenshot`, `log.follow`;
    - exit codes 0/1/2.
- **Size:** ~1.9k.
- **Tests:**
  - `logstore_test.go` (12);
  - `lsp_test.go` (1; skips without `typescript-language-server`);
  - `client_test.go` (3);
  - `TestParseReplySkipsPushedEvents` and `TestRenderLogRec` (call_test.go).
- **Gate:**
  - the tests above;
  - tapes `logs` (browser.log ingest, log.* verbs, log.follow pushes), `lsp` (status, shutdown,
    definition and references when tsls is installed) and `cli` (below) at zero diffs.

### S2-Z `cutover` (serial, last)

- **Go files:** all remaining. `cli/` is deleted.
- **Does:**
  - **Makefile:** `make build` = `prep` (app/dist → `crates/glyph3d-cli/web/`) + termd +
    `cargo build --release -p glyph3d-cli`, copied to `./glyph3d-cli`. The version is stamped
    through env (`G3D_VERSION`, `G3D_BUILD_DATE`, `G3D_PLATFORM` via `option_env!`).
  - **`make all`:**
    - linux amd64 natively, linux arm64 via cargo-zigbuild (rusqlite's C included, proven in S1);
    - `x86_64-pc-windows-gnu` relay, with no terminals;
    - darwin built on the Mac (TODO, as in DESIGN.md).
  - **Dev loop:** `tools/dev.sh relay` builds with cargo.
  - **Docs:** CLAUDE.md (the cli/ tree, "Go single binary", deployment), CHECKS.md (`go test` →
    `cargo test`), README / RELEASE_NOTES mentions; `.gitignore` (`cli/` entries →
    `crates/glyph3d-cli/web/`).
- **Gate:**
  - the whole tape suite at zero diffs, with `PENDING` empty;
  - `cargo test --workspace --features g3d-termd/test-hooks`;
  - `bun tools/check.mjs --tier full`, then `--tier browser`, then `--tier gpu` (memory rule,
    flock, one at a time), all on `./glyph3d-cli`;
  - `make all` artifacts build;
  - `grep -r` finds no `cli/` path or `go test` left in tracked docs or tools;
  - finally the operator's own look at the live display on the Rust relay (they judge; the checks only
    prove function).

## The wire-tape harness

**What it proves:** for a scripted session, every client receives from the Rust relay what it
received from the Go relay. Frame boundaries and cross-plane interleaving are timing, not
contract, so they are normalized.

### Pieces

- **`tools/lib/relay.mjs`** gains a role-generic dial, `dialRole(port, hello, {tape})`, with
  hello = `DISPLAY`, `SOURCE <kind>` or the controller `ping`. It gives raw `send` /
  `sendBinary` / `next(pred, ms)` / `close`. Every frame, both directions, is recorded into the
  tape: `{conn, dir, kind: text|binary, data (utf8 or base64), step}`. `dialRelay` (controllers)
  becomes a thin layer on it; it stays the one JS dial.
- **`tools/relay-tape.mjs`:**
  - `record --cli <go binary> [--scenario s]` writes `tools/fixtures/relay-tapes/<scenario>.tape.jsonl`;
  - `check --cli <binary>` replays every scenario against that binary and diffs;
  - `--keep` saves both normalized tapes under `out/check/kept/` on a diff.
- **The sandbox for every scenario** (DESIGN.md's isolation rules):
  - a **private relay**: `serve --listen 127.0.0.1 --port <free> --termd-ns tape-<n>` with
    `G3D_TERMD_DIR` a scratch directory (`tools/lib/termd.mjs`);
  - `HOME`, `XDG_CACHE_HOME` and `TMPDIR` pointed into scratch (the atlas cache, recordings and
    `log.dump` land there);
  - `PATH` with the fake `agent` and fake `tmux` first, so a tape never touches gomuxai, real
    tmux or a person's termd;
  - a copied fixture root with **pinned mtimes** (`touch -d`) and a fixture git repo with fixed
    author and committer dates;
  - never ports 5173/5174/5180/8080/8099;
  - everything killed on exit, including on failure.

### Record, then replay

Sends come in two kinds:
- **Scripted sends:** what the scenario does. They are recorded and replayed verbatim, with live
  ids substituted for their labels (`ctrl#2` → whatever `ctrl-N` the Rust relay minted).
- **Reactive sends:** the fake display's rules, running in both record and replay. They answer
  `terminal.create` / `terminal.ping` / `terminal.close` the way the browser does, and `screenshot`
  with a fixed PNG for the `cli` tape.

Each step ends at a **barrier**: the recording saw N normalized items per (connection, plane).
The replay waits for the same N, up to a timeout. A missing item is a diff, as is an extra one
that arrives within a 300 ms settle.

### Planes and normalization (Rust and Go tapes alike)

What the display receives is split into planes. Ordering is compared **within** a plane, and
within a plane only by origin:

| Plane | How it is compared |
|---|---|
| control text | Per step, a multiset over origins. Within one origin (the envelope's `from`, an event's `clientId`, the JSON-RPC `id` or method, otherwise `relay`) the order is exact. `terminal.ping` envelopes and their replies are dropped (their count is timing); D's unit test pins the 2 s cadence. |
| terminal `0x01` | Per terminal id: payloads **concatenated**. The size stamps become a list of (cols, rows, byte offset where that size starts), which must be equal. termd places resizes at exact bytes, so the offsets are deterministic. Scenarios run deterministic programs (`sh -c 'printf …; cat'`, a fixed `PS1`, typing only after the previous echo arrived). Repaint bytes come from the same termd binary. |
| RPC binary `0x02` | Per id: whole frames, exact. |
| sensor frames | Per source: exact order. The tape never saturates the plane; drop-oldest is pinned by the ported unit tests. |
| agentEvents | Per (display, session): `lines` arrays **concatenated**; `ended` exact, and after the last line. |
| search pushes | Per search id: matches concatenated, then sorted by (path, line, col). `fs/searchDone` exact, except that a capped run compares `matched` and `truncated`, not which matches. |
| `*/changed` pushes | In `gen` order, exact. |

Each controller, source and HTTP request is its own exact-order stream. Controller replies are
compared byte for byte, including `WriteJSON`'s trailing `\n`.

**Substitutions** (the same on both sides):
- `ctrl-N` / `src-<kind>-N` → labels by first appearance;
- pids → `<pid>`;
- the relay's clock fields → `<ts>`: `rts`, `uptimeMs`, `lastFrameTs`, a recording's `t` /
  `started` / `seconds`, `log.*` `ts` and `rts`;
- `log.stats.bytes` → masked, only while the SQLite versions differ (a named divergence);
- the scratch root → `{root}`, `HOME` → `{home}`, the scratch dir → `{scratch}`.

Tracked tapes therefore hold no home path, username or hostname, and S2-T's lint enforces it.
Nothing else is normalized: `term-N`, `gen`, mtimes and sizes are deterministic by construction.

### Scenarios (one tape each)

| Tape | Covers | Owner |
|---|---|---|
| `roles` | DISPLAY / SOURCE / controller handshakes; a second display refused (with `\n`); `whoami`; `ping`; `ERR: no display connected`; disconnect events | A |
| `routing` | controller → display envelopes; display → controller `response` / `data` and `event` pushes; an unknown target; invalid JSON; browser.log ingest | A |
| `sources` | `SOURCE hand` / `SOURCE camera` / an unsafe kind; pretty JSON compacted; non-JSON ignored; `source.list`; the `sources` list in a reloaded display's ack | A |
| `relay-verbs` | `source.record start/status/stop` (an explicit name); `git.recent 3`; `call` bundles naming relay verbs and display verbs | A |
| `atlas` | `atlas.get` miss / `cache` / hit / `clear`, from a controller (`\n`) and from the display | A |
| `http` | every file in app/dist, `/`, `/index.html`, `/assets/`, a 404, a non-upgrade request on `--relay-only`. Compared: status, Content-Type, Content-Length, Location, Accept-Ranges, body | A |
| `fs-read`, `fs-tree`, `fs-write`, `fs-search`, `fs-git` | every `fs/*` method, success and each error code; the `0x02` plane; the write barriers; `fs/didChange`; a search with grid coordinates on wide/emoji/invalid-UTF-8 lines, a refine, a cancel, a cap; git diff of fixed refs, plus a path filter and a bad ref | B |
| `agents` | `agentSessions/list|changed`; follow, shared, refcount, from another byte; `read` with from / until / tail; `ended`; a display disconnect; validation errors; `--no-gomuxai` errors | C |
| `gomux` | an export snapshot / spawned / changed / removed / store / host; `gomux/list`; `gomux.attach` errors and success (fake tmux and pane log); `gomux.resize`; `gomux/paneSize` | C (success: after D) |
| `terminals` | spawn with argv; typing; resize at a quiet prompt (the repaint); scroll on the primary screen; the wheel on a mouse-reporting alt screen; refresh; kill; a display reload → `ERR: no terminal` → recreate; `terminal.recover` (`live`, `ids`); a relay restart inside the tape (re-adopt, old screen repainted, the next spawn mints past every id) | D |
| `logs` | browser.log records (coalescing); `log.search` FTS and the LIKE fallback; `log.errors`; `log.query` (values, a bad SQL error); `log.stats`; `log.dump <scratch path>`; `log.follow` pushes; follow refused for a non-controller | E |
| `lsp` | `lsp/status`; `lsp/shutdown`; no language for the extension; definition and references on a fixture `.js` when tsls is installed (otherwise recorded as skipped on both sides) | E |
| `cli` | not a WebSocket tape: the `glyph3d-cli` binary run as a client against the fake display. One-shot (plain, quoted → `call`), pipe mode, `--json`, `log.query` table, `log.stats` render, `screenshot -o`, `log.follow --level`, and exit codes. Compared: stdout, stderr (with the clock-field substitutions) and exit status | E |

**Goldens.**
- Tapes are recorded from the Go relay at the S2 base commit and tracked. After cutover `cli/`
  is gone, and the goldens are the only record of Go's behaviour.
- To re-record: `git worktree add <scratch>/s2-base <base>`, `make build` there, then
  `bun tools/relay-tape.mjs record --cli <scratch>/s2-base/glyph3d-cli`. Always record twice and
  require the two to be equal.
- `tools/fixtures/relay-tapes/PENDING` lists scenarios (or single steps) not expected to pass
  yet. Each merge removes its own lines; cutover requires the file empty.

**Named divergences** (`tools/fixtures/relay-tapes/DIVERGENCES.json`). Each entry names its
scenario, its step, the field it masks and why; the normalizer masks exactly that. An entry
needs the operator's OK at the merge that adds it. The starting candidates:
1. A text frame with invalid UTF-8 closes the connection (RFC 6455 requires it, and tungstenite
   enforces it); Go forwarded it with U+FFFD. Not taped; listed so nobody "fixes" it.
2. `fs/search`'s `bad pattern: …` message text. The code (-32602) and `data` are identical; RE2's
   parser messages aren't reproducible.
3. `log.stats.bytes`, only while the SQLite versions differ.
4. The `attach` subcommand removed (the adapters dissolved), and `fullsnapshot` if the operator drops it.

## Merge order

All branches are local worktrees off `termd`, never pushed: `s2-foundation`, `s2-tape`,
`s2-relay`, `s2-fs`, `s2-agents`, `s2-terminals`, `s2-logs-client`, `s2-cutover`. The
integrator merges into `termd`.

1. **S2-0 `foundation` and S2-T `tape`**, in parallel. They touch disjoint files (crates/ against
   tools/). Tape merges as soon as its determinism gate passes; foundation when its gates pass.
   The five items below fan out from the merge of both.
2. **S2-A `relay-core` first** of the five. Every other item's tape gate needs its routing,
   planes and RPC dispatch. Until A merges, the other items gate on their ported unit tests and
   run their tapes against a local merge of A.
3. **Then S2-E, S2-B, S2-C, S2-D**, each as soon as it passes:
   - E and B are leaves;
   - C needs only seams;
   - D goes last of the four. It carries the heaviest gates (termd, the browser e2e) and
     unblocks C's `gomux.attach` success step.
4. **S2-Z `cutover`**: `PENDING` is empty, the Go relay is deleted, and the build, the docs and
   the full check tiers move.

| Phase | Agents at once | Items |
|---|---|---|
| 1 | 2 | foundation, tape |
| 2 | 5 | relay-core, fs, agents, terminals, logs-lsp-client |
| 3 | 1 | cutover |

Phase 2's five worktrees conflict only through the seams, and those are the integrator's.

## Risks

- **Go JSON is the long tail.** The compat layer and its Go-generated corpus are the defence,
  and the tapes catch what the corpus missed. The likeliest misses: `RawMessage` compaction,
  HTML escaping, per-byte U+FFFD, sorted keys broken by a stray `preserve_order`, and `nil` vs
  `[]`.
- **Dissolving the adapters moves timing:** no process hop and no extra WebSocket. That is
  better for latency, but it can expose ordering the forked adapters hid, such as a
  `terminal.create` racing a display reload. D's recreate and repaint fallbacks are ported as
  they are, and the `terminals` tape drives the reload path.
- **The relay is no longer cgo-free.** rusqlite's C and every target need a C toolchain.
  cargo-zigbuild covers linux (proven in S1). Windows-gnu and darwin are unproven for this crate
  until cutover.
- **Regex dialect.** Translating `\d \w \s \b` to ASCII covers the classes. Leftmost-first
  semantics already match. Rarer RE2 syntax that Rust lacks surfaces as an error (divergence
  2), never a silent mismatch.
