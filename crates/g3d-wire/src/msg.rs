//! The JSON payloads: handshake, requests, replies, events, errors. PROTOCOL.md is the
//! contract; field names and defaults here follow it. Both sides ignore fields they don't
//! know (no `deny_unknown_fields`), which is how 1.x minors add things.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The protocol version this crate speaks: `[major, minor]`.
pub const PROTO: [u32; 2] = [1, 5];
/// The features of the 1.0 core.
pub const FEATURES: [&str; 3] = ["raw", "view", "capture"];
/// The features this daemon announces: the core plus `status`, `upgrade` and `env` (1.1), `key`
/// and `paste` (1.2), `option_as_alt` (1.3), `mouse` (1.4), `paste_stream` (1.5).
pub const DAEMON_FEATURES: [&str; 11] =
    ["raw", "view", "capture", "status", "upgrade", "env", "key", "paste", "option_as_alt", "mouse", "paste_stream"];

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
    /// (1.2) A `paste` whose text could run commands (a line break the program would read as
    /// Enter, or the bracketed-paste end), refused without `allow_unsafe`.
    pub const UNSAFE_PASTE: &str = "unsafe_paste";
    /// (1.5) A chunk of a streamed paste termd ended because its writer sent no next chunk within
    /// the paste timeout (`--paste-timeout-ms`).
    pub const PASTE_TIMEOUT: &str = "paste_timeout";
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
    /// (1.1) A terminal's environment as it started, each variable with its source.
    Env(EnvQuery),
    /// (1.2) A key event, encoded by termd against the terminal's live keyboard modes.
    Key(Key),
    /// (1.2) Text pasted: bracketed when the program asked for bracketed paste.
    Paste(Paste),
    /// (1.4) A pointer event, encoded by termd against the terminal's live mouse modes.
    Mouse(Mouse),
}

/// The op names `Op` decodes, so a daemon can tell `unknown_op` from `bad_request`.
pub const KNOWN_OPS: [&str; 20] = [
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
    "env",
    "key",
    "paste",
    "mouse",
];

/// (1.2) `key`: one key event, with W3C `KeyboardEvent` semantics (PROTOCOL.md, "`key`").
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Key {
    pub handle: u32,
    /// The physical key, a W3C `KeyboardEvent.code` value (`"KeyA"`, `"Enter"`, `"ArrowLeft"`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    /// The logical key, a W3C `KeyboardEvent.key` value (`"a"`, `"A"`, `"Enter"`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key: String,
    /// The modifiers held, as W3C modifier key names: `Shift`, `Control`, `Alt`, `Meta`,
    /// `CapsLock`, `NumLock` (and `AltGraph`, which only ever made `text`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mods: Vec<String>,
    /// The text the key produced in the client's layout, after Shift, AltGr, dead keys, IME and
    /// Option-as-character; empty when it produced none (Enter, an arrow).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// `press` (the default), `repeat` or `release`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<KeyAction>,
    /// (1.3, feature `option_as_alt`) Whether Alt is Alt when it also made `text` (macOS Option).
    #[serde(default, skip_serializing_if = "OptionAsAlt::is_auto")]
    pub option_as_alt: OptionAsAlt,
}

/// (1.3) `key.option_as_alt`: Ghostty's `macos-option-as-alt`, chosen per key event. On the wire
/// `"auto"` (the default), `true` or `false`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OptionAsAlt {
    /// Alt is Alt unless it made `text` (Option typed a character): then the character wins, as
    /// with Ghostty's default (`false`).
    #[default]
    Auto,
    /// Alt is Alt: the program gets Alt and the key's own character, never Option's.
    True,
    /// Alt is a character modifier (Ghostty's default): no ESC prefix, not counted by
    /// modifyOtherKeys, and Kitty's associated text kept.
    False,
}

impl OptionAsAlt {
    pub fn is_auto(&self) -> bool {
        *self == OptionAsAlt::Auto
    }
}

impl std::fmt::Display for OptionAsAlt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            OptionAsAlt::Auto => "auto",
            OptionAsAlt::True => "true",
            OptionAsAlt::False => "false",
        })
    }
}

impl std::str::FromStr for OptionAsAlt {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "auto" => Ok(OptionAsAlt::Auto),
            "true" => Ok(OptionAsAlt::True),
            "false" => Ok(OptionAsAlt::False),
            _ => Err(format!("option_as_alt is auto, true or false, not {s:?}")),
        }
    }
}

impl Serialize for OptionAsAlt {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            OptionAsAlt::Auto => s.serialize_str("auto"),
            OptionAsAlt::True => s.serialize_bool(true),
            OptionAsAlt::False => s.serialize_bool(false),
        }
    }
}

impl<'de> Deserialize<'de> for OptionAsAlt {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = OptionAsAlt;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(r#""auto", true or false"#)
            }
            fn visit_bool<E: serde::de::Error>(self, b: bool) -> Result<OptionAsAlt, E> {
                Ok(if b { OptionAsAlt::True } else { OptionAsAlt::False })
            }
            fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<OptionAsAlt, E> {
                match s {
                    "auto" => Ok(OptionAsAlt::Auto),
                    _ => Err(E::invalid_value(serde::de::Unexpected::Str(s), &self)),
                }
            }
        }
        d.deserialize_any(V)
    }
}

/// (1.2) `key.action`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyAction {
    #[default]
    Press,
    Repeat,
    Release,
}

/// (1.2) `paste`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paste {
    pub handle: u32,
    pub text: String,
    /// Paste text that could run commands (Ghostty's `clipboard-paste-protection` answered yes).
    /// Read from a paste's first chunk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_unsafe: Option<bool>,
    /// (1.5, feature `paste_stream`) More chunks of this paste follow: the paste stays open (one
    /// bracket, one set of rules) until a chunk without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub more: Option<bool>,
}

/// (1.4) `mouse`: one pointer event on the terminal's cells (PROTOCOL.md, "`mouse`").
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Mouse {
    pub handle: u32,
    /// `press` (the default), `release` or `move`.
    #[serde(default)]
    pub action: MouseAction,
    pub button: MouseButton,
    /// Where the pointer is, in cells from the terminal's top-left corner: column 3.5 is the
    /// middle of the fourth column. The cell is the whole part; SGR-pixels reports read the
    /// fraction too. Clamped to the screen.
    pub col: f64,
    pub row: f64,
    /// The modifiers held, as W3C names (`Shift`, `Control`, `Alt`, `Meta`), as for `key`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mods: Vec<String>,
}

/// (1.4) `mouse.action`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseAction {
    #[default]
    Press,
    Release,
    Move,
}

/// (1.4) `mouse.button`: a name, or X11's number for the buttons past the wheel (8 back, 9
/// forward, 10, 11). 1–7 go by their names.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    /// No button: a move with none held (any-event tracking reports it).
    #[default]
    None,
    WheelUp,
    WheelDown,
    WheelLeft,
    WheelRight,
    /// X11 buttons 8–11.
    Extra(u8),
}

impl MouseButton {
    pub fn is_wheel(self) -> bool {
        matches!(self, MouseButton::WheelUp | MouseButton::WheelDown | MouseButton::WheelLeft | MouseButton::WheelRight)
    }
}

impl std::fmt::Display for MouseButton {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            MouseButton::Left => "left",
            MouseButton::Middle => "middle",
            MouseButton::Right => "right",
            MouseButton::None => "none",
            MouseButton::WheelUp => "wheel-up",
            MouseButton::WheelDown => "wheel-down",
            MouseButton::WheelLeft => "wheel-left",
            MouseButton::WheelRight => "wheel-right",
            MouseButton::Extra(n) => return write!(f, "{n}"),
        })
    }
}

impl std::str::FromStr for MouseButton {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        Ok(match s {
            "left" => MouseButton::Left,
            "middle" => MouseButton::Middle,
            "right" => MouseButton::Right,
            "none" => MouseButton::None,
            "wheel-up" => MouseButton::WheelUp,
            "wheel-down" => MouseButton::WheelDown,
            "wheel-left" => MouseButton::WheelLeft,
            "wheel-right" => MouseButton::WheelRight,
            n => match n.parse::<u64>() {
                Ok(n) => MouseButton::extra(n)?,
                Err(_) => return Err(format!("button is {}, not {s:?}", MouseButton::NAMES)),
            },
        })
    }
}

impl MouseButton {
    const NAMES: &'static str = "left, middle, right, none, wheel-up, wheel-down, wheel-left, wheel-right or 8..11";

    fn extra(n: u64) -> Result<Self, String> {
        match n {
            8..=11 => Ok(MouseButton::Extra(n as u8)),
            1..=7 => Err(format!("button {n} goes by its name ({})", MouseButton::NAMES)),
            _ => Err(format!("button is {}, not {n}", MouseButton::NAMES)),
        }
    }
}

impl Serialize for MouseButton {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            MouseButton::Extra(n) => s.serialize_u8(*n),
            b => s.serialize_str(&b.to_string()),
        }
    }
}

impl<'de> Deserialize<'de> for MouseButton {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = MouseButton;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(MouseButton::NAMES)
            }
            fn visit_u64<E: serde::de::Error>(self, n: u64) -> Result<MouseButton, E> {
                MouseButton::extra(n).map_err(E::custom)
            }
            fn visit_i64<E: serde::de::Error>(self, n: i64) -> Result<MouseButton, E> {
                MouseButton::extra(u64::try_from(n).unwrap_or(0)).map_err(E::custom)
            }
            fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<MouseButton, E> {
                // Names only: a number goes as a number.
                match s.parse::<MouseButton>() {
                    Ok(MouseButton::Extra(_)) | Err(_) => {
                        Err(E::custom(format!("button is {}, not {s:?}", MouseButton::NAMES)))
                    }
                    Ok(b) => Ok(b),
                }
            }
        }
        d.deserialize_any(V)
    }
}

/// (1.2) The `key`, `paste` and (1.4) `mouse` replies: how many bytes went to the program (0: the
/// event encodes to nothing in the terminal's modes, a release outside Kitty's event reporting or
/// a click the program didn't ask to hear, say).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrittenReply {
    pub written: u64,
}

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
    /// (1.5) How the daemon knows each terminal's processes (DESIGN.md, "Process trees").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trees: Option<StatusTrees>,
    /// (1.5) What terminals whose programs ended left running (a `nohup` job), until it ends.
    #[serde(default)]
    pub leftovers: Vec<StatusLeftover>,
    /// (1.5) The latest closes, newest first: each signal of the close rule and who it reached.
    #[serde(default)]
    pub closes: Vec<StatusClose>,
}

/// (1.5) `daemon.trees`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusTrees {
    /// `"cgroup"`: each terminal its own cgroup, a leaf of the daemon's systemd user service's;
    /// `"session"`: each terminal's session.
    pub mode: String,
    /// With `cgroup`: the service.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// With `session`: why not a cgroup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

/// (1.5) A process in a tree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusProc {
    pub pid: u32,
    pub comm: String,
}

/// (1.5) One of `daemon.leftovers`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusLeftover {
    pub id: String,
    /// The program's pid (its session id).
    pub pid: u32,
    /// When the program ended.
    pub since: u64,
    pub processes: Vec<StatusProc>,
}

/// (1.5) One of `daemon.closes`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusClose {
    pub id: String,
    /// When the tree was empty.
    pub at: u64,
    pub steps: Vec<StatusCloseStep>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusCloseStep {
    /// `"HUP"`, `"TERM"`, `"KILL"` (or the signal `kill` asked for).
    pub signal: String,
    pub procs: Vec<StatusProc>,
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
    /// (1.5) Times the holder has replaced itself in place (`upgrade` with `holder`): the same
    /// pid, a new binary.
    #[serde(default)]
    pub upgrades: u64,
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
    /// When the namespace's brain was failed before this one started (no brain ran from then until
    /// `at`); absent when it wasn't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_at: Option<u64>,
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
    /// Where a terminal created with no caller's environment looks its session's variables up:
    /// `"systemd-user"`, `"launchd"` or `"daemon"` (the daemon's start values: no session source
    /// answers, or `--env-source daemon`).
    pub source: String,
    /// The daemon's `termd.toml`: its path, whether it exists, and its error while it is bad.
    pub config: StatusEnvConfig,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusEnvConfig {
    pub path: String,
    /// `"absent"`, `"loaded"` or `"error"`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
    /// The `seq` a crash now would bring this terminal back to: its newest crash-restore save's
    /// (a crash loses `seq − saved_seq`). Absent while a restore that was not exact waits for its
    /// first save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_seq: Option<u64>,
    /// (1.5) Processes in its tree now (its program and everything it started); absent when it
    /// couldn't be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processes: Option<u64>,
    /// (1.5) The paste streaming into it now, absent when none is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paste: Option<StatusPaste>,
    pub subscribers: Vec<StatusSubscriber>,
}

/// (1.5) A paste streaming into a terminal: whose, since when, how far.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusPaste {
    /// The writer's connection (its `conn` among the subscribers).
    pub conn: u64,
    /// When its first chunk came (ms since the epoch).
    pub since: u64,
    /// Bytes of its text the program has been given so far.
    pub written: u64,
    /// When termd answered its last chunk and began waiting for the writer's next (ms since the
    /// epoch); absent while a chunk waits for room in the input buffer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_since: Option<u64>,
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
    /// (1.1) The caller's own environment, which the terminal's starts from (a shell's client
    /// sends it, as a multiplexer's does). Absent: the creator has none, and the base is the
    /// desktop session's (PROTOCOL.md, "The program's environment").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_base: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_exists: Option<IfExists>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scrollback_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colors: Option<Colors>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_px: Option<[u32; 2]>,
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

/// A name `create`'s `env` and `env_base` take: `[A-Za-z_][A-Za-z0-9_]*`.
pub fn env_name_ok(k: &str) -> bool {
    let mut b = k.bytes();
    b.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_') && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// One environment string's limit in `create`: `NAME=value` and its NUL as `execve` counts it
/// (Linux's `MAX_ARG_STRLEN`, 32 pages).
pub const ENV_VALUE_MAX: usize = 128 << 10;

/// (1.1) `env`: a terminal's environment as termd started its program.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvQuery {
    pub id: String,
}

/// Where one variable of a terminal's environment came from (PROTOCOL.md, "The program's
/// environment"), its layers in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvSource {
    /// The caller's own environment (`create.env_base`).
    Caller,
    /// The desktop session's, for a creator with no environment of its own.
    Session,
    /// What `login(1)` would set and the base lacked: the account, `SHELL`, `PATH`, the locale.
    Fill,
    /// The daemon's `termd.toml`.
    File,
    /// The request's `env`.
    Request,
    /// termd's own, describing the terminal.
    Termd,
}

/// One variable as the program started with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
    pub source: EnvSource,
    /// Within the source, where: a `session` variable's `"systemd-user"`, `"launchd"` or
    /// `"daemon"` (the daemon's start value, which the session source lacked); a `fill`'s
    /// `"passwd"`, `"login"` or `"locale"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvReply {
    pub id: String,
    /// Sorted by name. Empty for a terminal restored from a brain that kept no record of it.
    pub env: Vec<EnvVar>,
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
