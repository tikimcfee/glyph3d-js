//! The JSON payloads: handshake, requests, replies, events, errors. PROTOCOL.md is the
//! contract; field names and defaults here follow it. Both sides ignore fields they don't
//! know (no `deny_unknown_fields`), which is how 1.x minors add things.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The protocol version this crate speaks: `[major, minor]`.
pub const PROTO: [u32; 2] = [1, 1];
/// The features of the 1.0 core.
pub const FEATURES: [&str; 3] = ["raw", "view", "capture"];
/// The features this daemon announces: the core plus `status` and `upgrade` (1.1).
pub const DAEMON_FEATURES: [&str; 5] = ["raw", "view", "capture", "status", "upgrade"];

/// `HELLO`, the first frame a client sends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub proto: [u32; 2],
    pub client: String,
}

/// `WELCOME`, the daemon's answer to a `HELLO` of the same major.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Welcome {
    pub proto: [u32; 2],
    pub daemon: String,
    pub engine: String,
    /// The namespace; absent when the daemon serves an explicit `--socket`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ns: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub features: Vec<String>,
    pub max_frame: u64,
    /// (1.1) The namespace's identity: random, fixed for the holder's life. The same instance
    /// after a reconnect means the same terminals may still be there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// (1.1) Which brain this is in the holder's life: 1 for the first, +1 per restart or upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    /// (1.1) The holder: its pid and version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<HolderInfo>,
}

/// `WELCOME.holder`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HolderInfo {
    pub pid: u32,
    pub version: String,
}

/// An `ERROR` frame's payload, and a failed `REPLY`'s `error`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireError {
    pub code: String,
    pub message: String,
}

impl WireError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into() }
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WireError {}

/// Error codes. Request-level ones ride a `REPLY`; connection-level ones an `ERROR`.
pub mod code {
    pub const BAD_REQUEST: &str = "bad_request";
    pub const UNKNOWN_OP: &str = "unknown_op";
    pub const UNSUPPORTED: &str = "unsupported";
    pub const NO_TERMINAL: &str = "no_terminal";
    pub const EXISTS: &str = "exists";
    pub const NOT_SUBSCRIBED: &str = "not_subscribed";
    pub const ALREADY_SUBSCRIBED: &str = "already_subscribed";
    pub const READ_ONLY: &str = "read_only";
    pub const NOT_OWNER: &str = "not_owner";
    pub const ALT_SCREEN: &str = "alt_screen";
    pub const SPAWN_FAILED: &str = "spawn_failed";
    pub const TOO_LARGE: &str = "too_large";
    /// (1.1) Another op of its kind is running (`upgrade`).
    pub const BUSY: &str = "busy";
    // Connection-level (ERROR frames).
    pub const BAD_FRAME: &str = "bad_frame";
    pub const VERSION: &str = "version";
    pub const AUTH: &str = "auth";
    /// (1.1) The engine is being replaced on purpose: reconnect now.
    pub const RESTART: &str = "restart";
    /// (1.1) The holder answered: no brain is running. The message says why.
    pub const BRAIN_FAILED: &str = "brain_failed";
    // `error` events.
    /// An `INPUT` the program's unread-input buffer had no room for.
    pub const INPUT_FULL: &str = "input_full";
    /// The terminal failed inside termd; `exit` and `closed` follow.
    pub const PANIC: &str = "panic";
}

/// A `REQUEST`: the client's `req` plus one op.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub req: u64,
    #[serde(flatten)]
    pub op: Op,
}

/// Every op 1.0 knows. Serialized with its name in `op`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Create(Create),
    List,
    Kill(Kill),
    Subscribe(Subscribe),
    Unsubscribe(HandleOnly),
    Take(Take),
    Resize(Resize),
    Repaint(RepaintOp),
    View(View),
    Capture(Capture),
    Ping,
    Stop,
    Upgrade(Upgrade),
    /// (1.1) The daemon's state as one document.
    Status,
    /// (1.1) Follow the status document: pushed on change, no sooner than the interval.
    StatusFollow(StatusFollow),
    /// (1.1) Stop following it.
    StatusUnfollow,
}

/// The op names `Op` decodes, so a daemon can tell `unknown_op` from `bad_request`.
pub const KNOWN_OPS: [&str; 16] = [
    "create",
    "list",
    "kill",
    "subscribe",
    "unsubscribe",
    "take",
    "resize",
    "repaint",
    "view",
    "capture",
    "ping",
    "stop",
    "upgrade",
    "status",
    "status_follow",
    "status_unfollow",
];

/// (1.1) `status_follow`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusFollow {
    /// The least time between two pushes, in milliseconds (clamped to the daemon's range).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
}

/// (1.1) The `status_follow` reply: the interval in effect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusFollowReply {
    pub interval_ms: u64,
}

/// (1.1) The `status` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusReply {
    pub status: Status,
}

/// (1.1) The status document (PROTOCOL.md, "`status_follow`"): the daemon, every terminal and
/// its subscribers, and recent errors. Times are Unix epoch milliseconds, sizes bytes. A client
/// renders what it knows and ignores the rest; the document only grows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub at: u64,
    pub daemon: StatusDaemon,
    pub terminals: Vec<StatusTerminal>,
    pub errors: Vec<StatusError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusDaemon {
    pub version: String,
    pub engine: String,
    pub proto: [u32; 2],
    /// Absent when the daemon serves an explicit `--socket`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ns: Option<String>,
    pub socket: String,
    pub log: String,
    /// Only in the last document before an empty namespace leaves (idle exit, `stop`).
    pub exiting: bool,
    pub instance: String,
    /// When the holder started: the namespace's age.
    pub started_at: u64,
    pub connections: u64,
    pub holder: StatusHolder,
    pub brain: StatusBrain,
    pub snapshots: StatusSnapshots,
    pub env: StatusEnv,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusHolder {
    pub pid: u32,
    pub version: String,
    /// The holder/brain protocol version.
    pub hold: [u64; 2],
    /// Resident memory, when it could be measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rss: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusBrain {
    pub pid: u32,
    pub generation: u64,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rss: Option<u64>,
    pub restarts: BrainRestarts,
    pub last_start: BrainStart,
}

/// Brain starts after the first, by cause.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrainRestarts {
    pub crash: u64,
    pub watchdog: u64,
    pub upgrade: u64,
}

/// Why the current brain started, and how the terminals came back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrainStart {
    /// `"first"`, `"crash"`, `"watchdog"` or `"upgrade"`.
    pub reason: String,
    pub at: u64,
    /// How the previous brain ended (absent for the first, and after an upgrade's handoff).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<ExitStatus>,
    pub restored: RestoredCounts,
    /// Output the previous brain read and never saved.
    pub unseen: u64,
}

/// A process's end, as in the `exit` event: a code, or a signal by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExitStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoredCounts {
    pub exact: u64,
    pub snapshot: u64,
    pub blank: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusSnapshots {
    pub interval_ms: u64,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusEnv {
    /// Where new terminals' environments start: `"systemd-user"` or `"daemon"`.
    pub source: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusTerminal {
    pub id: String,
    pub handle: u32,
    pub pid: u32,
    pub argv: Vec<String>,
    pub login: bool,
    pub cwd: String,
    /// The directory the program last reported (OSC 7).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pwd: Option<String>,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
    pub alt: bool,
    pub created_at: u64,
    pub seq: u64,
    /// Output and input bytes per second over the last 5 s.
    pub out_bps: u64,
    pub in_bps: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output_at: Option<u64>,
    /// `"live"`, `"blocked"` (a blocking owner is behind; the program waits) or `"paused"` (an
    /// upgrade's cut).
    pub flow: String,
    pub input_queued: u64,
    pub scrollback_rows: u64,
    pub memory: TermMemory,
    /// How it came back at this brain's start: `"exact"`, `"snapshot"`, `"blank"`; absent when
    /// it started under this brain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored: Option<String>,
    /// With `restored`: the bytes of this terminal's output the previous brain read and never
    /// saved (0 when exact).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unseen: Option<u64>,
    pub subscribers: Vec<StatusSubscriber>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TermMemory {
    pub resident: u64,
    pub compressed: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusSubscriber {
    pub conn: u64,
    pub client: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub role: Role,
    pub mode: Mode,
    pub flow: Flow,
    pub queued: u64,
    pub lagging: bool,
    pub lags: u64,
    pub view: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusError {
    pub code: String,
    pub message: String,
    pub first_at: u64,
    pub at: u64,
    pub count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// (1.1) `upgrade`: replace the daemon's engine without ending a terminal.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Upgrade {
    /// The new binary (default: the path the daemon was started from).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    /// Replace the holder too (`g3d upgrade --holder`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeReply {
    /// The generation of the brain that accepted the upgrade.
    pub generation: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Create {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Added to the environment; a `null` value removes the variable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, Option<String>>>,
    /// (1.1) What the environment starts from: the session's (the default) or nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_base: Option<EnvBase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_exists: Option<IfExists>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scrollback_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colors: Option<Colors>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_px: Option<[u32; 2]>,
}

/// `create.env_base` (1.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvBase {
    /// The user's session environment, scrubbed (PROTOCOL.md, "The program's environment").
    #[default]
    Session,
    /// Nothing but the account variables, the request's `env` and termd's own.
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IfExists {
    Error,
    Adopt,
}

/// Colours as `#rrggbb`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Colors {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kill {
    pub id: String,
    /// `"HUP"` (default), `"TERM"` or `"KILL"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Raw,
    None,
    Cells,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Watch,
    Attach,
    Own,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Watch => "watch",
            Role::Attach => "attach",
            Role::Own => "own",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Flow {
    Lossy,
    Block,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subscribe {
    pub id: String,
    pub mode: Mode,
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_rows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<Flow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandleOnly {
    pub handle: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Take {
    pub handle: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resize {
    pub handle: u32,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepaintOp {
    pub handle: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_rows: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct View {
    pub handle: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureFormat {
    Plain,
    Vt,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capture {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<CaptureFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_rows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unwrap: Option<bool>,
}

/// A successful `REPLY`: `req`, `ok: true`, then the op's own fields.
#[derive(Clone, Debug, Serialize)]
pub struct ReplyOk<'a, T: Serialize> {
    pub req: u64,
    pub ok: bool,
    #[serde(flatten)]
    pub body: &'a T,
}

/// A failed `REPLY`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReplyErr {
    pub req: u64,
    pub ok: bool,
    pub error: WireError,
}

/// What a client reads first from any `REPLY`.
#[derive(Clone, Debug, Deserialize)]
pub struct ReplyHead {
    pub req: u64,
    pub ok: bool,
    #[serde(default)]
    pub error: Option<WireError>,
}

/// An op whose reply carries nothing but `req` and `ok`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Empty {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateReply {
    pub id: String,
    pub handle: u32,
    pub pid: u32,
    pub created: bool,
    pub cols: u16,
    pub rows: u16,
    /// (1.1) What runs: the resolved program path first, then its arguments.
    pub argv: Vec<String>,
    /// (1.1) Whether it was started as a login shell (`argv[0]` is `-<name>`).
    pub login: bool,
    /// (1.1) Where it started.
    pub cwd: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListReply {
    pub terminals: Vec<TermInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TermInfo {
    pub id: String,
    pub handle: u32,
    pub pid: u32,
    pub argv: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub title: String,
    pub alt: bool,
    pub seq: u64,
    pub created_at: u64,
    pub subscribers: SubscriberCounts,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriberCounts {
    pub own: u32,
    pub attach: u32,
    pub watch: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscribeReply {
    pub handle: u32,
    pub role: Role,
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TakeReply {
    pub role: Role,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewReply {
    pub offset: u64,
    pub max: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureReply {
    pub text: String,
    pub rows: u64,
}

/// The modes a `modes` event reports.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Modes {
    pub alt: bool,
    pub mouse: bool,
    pub mouse_sgr: bool,
    pub bracketed_paste: bool,
    pub app_cursor: bool,
    pub focus: bool,
}

/// An `EVENT` payload. Unknown events decode as `Unknown` and are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    Size {
        cols: u16,
        rows: u16,
        seq: u64,
    },
    Title {
        title: String,
    },
    Modes(Modes),
    Bell,
    Pwd {
        pwd: String,
    },
    Role {
        role: Role,
    },
    Lagged {
        dropped: u64,
        seq: u64,
    },
    Exit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        /// The signal's name without `SIG` (`"HUP"`), when a signal ended the program.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
        seq: u64,
    },
    Closed,
    Error {
        code: String,
        message: String,
    },
    /// (1.1) On stream 0, to the connection that asked for an `upgrade` that did not happen.
    UpgradeFailed {
        message: String,
    },
    /// (1.1) On stream 0, to a `status_follow`er: the status document.
    Status(Box<Status>),
    #[serde(other)]
    Unknown,
}
