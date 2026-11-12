//! One terminal: its PTY, its program and its libghostty `Terminal`, all on one owner
//! thread (DESIGN.md, "Threading"). The socket side talks to it only through `Cmd`s.

use crate::blob;
use crate::hold::{Exit, Held, Hold, Marks};
use crate::out::{ConnOut, Kind, LOSSY_MAX, SubShared, Wake};
use crate::repaint;
use crate::spawn;
use g3d_wire::frame::{self, REPAINT_FLAG_VIEW, RepaintHead, ty};
use g3d_wire::msg::*;
use libghostty_vt::Terminal;
use libghostty_vt::color::Rgb;
use libghostty_vt::grid_ref::TrackedGridRef;
use libghostty_vt::mode::Mode as VtMode;
use libghostty_vt::point::{Coordinate, Point, Space};
use libghostty_vt::screen::Screen;
use libghostty_vt::terminal::CompressionMode;
use libghostty_vt::terminal::CompressionResult;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fd::OwnedFd;
use rustix::process::Signal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

pub type ConnId = u64;

const READ_CHUNK: usize = 64 * 1024;
const INPUT_MAX: usize = 1 << 20;
const CONTINUATION_MAX: usize = 64 * 1024;
const COMPRESS_IDLE: Duration = Duration::from_secs(30);
/// An `INPUT` of exactly these bytes panics the owner thread, when the daemon runs with
/// `G3D_TERMD_TEST_HOOKS=1`. It exists for the panic-boundary test.
pub const TEST_PANIC_INPUT: &[u8] = b"\x00g3d-termd-test-panic\x00";
/// With test hooks on, an `INPUT` of these bytes stops the brain's heartbeat (the watchdog test).
pub const TEST_WEDGE_INPUT: &[u8] = b"\x00g3d-termd-test-wedge\x00";

/// Daemon-wide settings every terminal reads.
pub struct Config {
    /// `None` when the daemon was started on an explicit `--socket`.
    pub ns: Option<String>,
    pub socket: PathBuf,
    pub default_scrollback: u64,
    pub max_scrollback: u64,
    pub test_hooks: bool,
    /// Zero: no crash snapshots.
    pub snapshot_interval: Duration,
    pub kill_grace: Duration,
    /// The engine a snapshot restores into: libghostty's version and its snapshot format.
    pub engine: String,
}

/// Every live terminal, by id and by handle.
pub struct Registry {
    inner: Mutex<RegInner>,
    pub cfg: Config,
    pub hold: Arc<Hold>,
    pub marks: Arc<Marks>,
    /// Owner threads restored at start wait on this until the holder says `go`.
    go: Arc<(Mutex<bool>, Condvar)>,
    /// An upgrade is cutting: `create` waits it out (`busy`).
    pub upgrading: AtomicBool,
}

struct RegInner {
    by_id: HashMap<String, Arc<TermRef>>,
    by_handle: HashMap<u32, Arc<TermRef>>,
}

impl Registry {
    pub fn new(cfg: Config, hold: Arc<Hold>, marks: Arc<Marks>) -> Arc<Self> {
        Arc::new(Registry {
            inner: Mutex::new(RegInner { by_id: HashMap::new(), by_handle: HashMap::new() }),
            cfg,
            hold,
            marks,
            go: Arc::new((Mutex::new(false), Condvar::new())),
            upgrading: AtomicBool::new(false),
        })
    }

    /// Lets every restored owner thread start reading its PTY.
    pub fn go(&self) {
        let (m, cv) = &*self.go;
        *m.lock().unwrap() = true;
        cv.notify_all();
    }

    fn wait_go(&self) {
        let (m, cv) = &*self.go;
        let mut g = m.lock().unwrap();
        while !*g {
            g = cv.wait(g).unwrap();
        }
    }

    fn insert(&self, t: Arc<TermRef>) {
        let mut g = self.inner.lock().unwrap();
        g.by_id.insert(t.id.clone(), t.clone());
        g.by_handle.insert(t.handle, t);
    }

    pub fn by_id(&self, id: &str) -> Option<Arc<TermRef>> {
        self.inner.lock().unwrap().by_id.get(id).cloned()
    }

    pub fn by_handle(&self, h: u32) -> Option<Arc<TermRef>> {
        self.inner.lock().unwrap().by_handle.get(&h).cloned()
    }

    pub fn all(&self) -> Vec<Arc<TermRef>> {
        let g = self.inner.lock().unwrap();
        let mut v: Vec<_> = g.by_handle.values().cloned().collect();
        v.sort_by_key(|t| t.handle);
        v
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().by_id.len()
    }

    fn remove(&self, t: &TermRef) {
        let mut g = self.inner.lock().unwrap();
        if g.by_handle.get(&t.handle).is_some_and(|x| std::ptr::eq(x.as_ref(), t)) {
            g.by_handle.remove(&t.handle);
            g.by_id.remove(&t.id);
        }
    }
}

/// The socket side's handle on a terminal.
pub struct TermRef {
    pub id: String,
    pub handle: u32,
    tx: mpsc::Sender<Cmd>,
    wake: Arc<Wake>,
    pub info: Mutex<TermInfo>,
}

impl TermRef {
    /// Posts a command to the owner thread. Fails when the terminal is gone.
    pub fn send(&self, cmd: Cmd) -> Result<(), Cmd> {
        self.tx.send(cmd).map_err(|e| e.0)?;
        self.wake.wake();
        Ok(())
    }
}

/// A request for the owner thread. It answers `req` on `out` itself (so a reply and the
/// frames it causes are queued in order) and then completes `done` with success.
pub struct Cmd {
    pub conn: ConnId,
    pub out: Arc<ConnOut>,
    pub req: u64,
    pub op: TermOp,
    pub done: Option<oneshot::Sender<bool>>,
}

pub enum TermOp {
    Subscribe(Subscribe),
    Unsubscribe,
    Take {
        cols: Option<u16>,
        rows: Option<u16>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Repaint {
        history_rows: u32,
    },
    View {
        delta: Option<i64>,
        live: bool,
    },
    Capture(Capture),
    Input(Vec<u8>),
    /// `kill` (with a reply) or part of `stop` (`reply: false`).
    Kill {
        signal: Signal,
        reply: bool,
    },
    /// The connection closed: drop its subscription.
    Detach,
    /// The holder reaped the program.
    Exited(Exit),
    /// An upgrade's cut: stop reading the PTY and hand the terminal over in a blob, made a
    /// libghostty snapshot when the candidate's engine is ours, else a VT repaint.
    Cut {
        snapshot: bool,
    },
    /// The upgrade failed: read again.
    Resume,
}

pub fn reply_ok<T: Serialize>(out: &ConnOut, req: u64, body: &T) {
    out.frame(frame::encode_json(ty::REPLY, 0, &ReplyOk { req, ok: true, body }));
}

pub fn reply_err(out: &ConnOut, req: u64, code: &str, message: impl Into<String>) {
    out.frame(frame::encode_json(ty::REPLY, 0, &ReplyErr { req, ok: false, error: WireError::new(code, message) }));
}

fn ms_since_epoch() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn parse_hex(s: &str) -> Option<Rgb> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(Rgb { r: (v >> 16) as u8, g: (v >> 8) as u8, b: v as u8 })
}

pub fn valid_size(cols: u16, rows: u16) -> bool {
    (1..=4096).contains(&cols) && (1..=4096).contains(&rows)
}

/// What `create` asked for, validated.
pub struct CreateSpec {
    pub id: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<BTreeMap<String, Option<String>>>,
    pub cols: u16,
    pub rows: u16,
    pub scrollback: u64,
    pub colors: Colors,
    pub cell_px: [u32; 2],
}

impl CreateSpec {
    pub fn from_request(c: Create, cfg: &Config) -> Result<Self, WireError> {
        g3d::paths::validate_name("id", &c.id).map_err(|m| WireError::new(code::BAD_REQUEST, m))?;
        if !valid_size(c.cols, c.rows) {
            return Err(WireError::new(code::BAD_REQUEST, "cols and rows must be 1 to 4096"));
        }
        let argv = match c.argv {
            Some(a) if a.is_empty() => return Err(WireError::new(code::BAD_REQUEST, "argv is empty")),
            Some(a) => a,
            None => vec![std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())],
        };
        let colors = c.colors.unwrap_or_default();
        for v in [&colors.fg, &colors.bg, &colors.cursor].into_iter().flatten() {
            if parse_hex(v).is_none() {
                return Err(WireError::new(code::BAD_REQUEST, format!("colour {v:?} is not #rrggbb")));
            }
        }
        let cell_px = c.cell_px.unwrap_or([8, 16]);
        if cell_px[0] == 0 || cell_px[1] == 0 {
            return Err(WireError::new(code::BAD_REQUEST, "cell_px must be positive"));
        }
        Ok(CreateSpec {
            id: c.id,
            argv,
            cwd: c.cwd,
            env: c.env,
            cols: c.cols,
            rows: c.rows,
            scrollback: c.scrollback_bytes.unwrap_or(cfg.default_scrollback).min(cfg.max_scrollback),
            colors,
            cell_px,
        })
    }
}

/// What a terminal was created with, kept by the holder for the next brain (opaque to it).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Meta {
    pub argv: Vec<String>,
    pub cwd: String,
    pub created_at: u64,
    pub scrollback: u64,
    pub colors: Colors,
    pub cell_px: [u32; 2],
}

/// How an owner thread gets its terminal.
enum Init {
    /// `create`: the holder has just started the program.
    New { cols: u16, rows: u16 },
    /// A brain start: the holder's terminal and its stored blobs (newest first).
    Restore { blobs: Vec<OwnedFd>, exit: Option<Exit> },
}

/// How a terminal came back at this brain's start (DESIGN.md "Screens after a crash").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Restored {
    /// Its newest blob is at the high-water mark: nothing was lost (an upgrade's handoff, or a
    /// crash while the terminal was quiet since its last snapshot).
    Exact,
    /// From a snapshot, with `unseen` bytes the crashed brain read and never saved.
    Snapshot,
    /// No usable blob: the program's own redraw is all there is.
    Blank,
}

/// Starts a terminal: the holder starts the program, then a new owner thread adopts its PTY.
pub async fn create(reg: &Arc<Registry>, spec: CreateSpec) -> Result<(Arc<TermRef>, u32), WireError> {
    let cwd = spec
        .cwd
        .clone()
        .unwrap_or_else(|| std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default());
    let meta = Meta {
        argv: spec.argv.clone(),
        cwd,
        created_at: ms_since_epoch(),
        scrollback: spec.scrollback,
        colors: spec.colors.clone(),
        cell_px: spec.cell_px,
    };
    let env = spawn::child_env(&spec.id, &reg.cfg.socket.display().to_string(), spec.env.as_ref());
    let req = json!({"id": spec.id, "argv": spec.argv, "env": env, "cwd": spec.cwd, "cols": spec.cols,
        "rows": spec.rows, "meta": meta});
    let (handle, slot, pid, master) = reg
        .hold
        .spawn(req)
        .await
        .map_err(|e| WireError::new(code::SPAWN_FAILED, format!("start {:?}: {e}", spec.argv)))?;
    reg.marks.set(slot, 0);
    let held = Held {
        handle,
        slot,
        id: spec.id.clone(),
        pid,
        meta: serde_json::Value::Null,
        exit: None,
        master,
        blobs: vec![],
    };
    let init = Init::New { cols: spec.cols, rows: spec.rows };
    let (tref, started) = start_owner(reg, held, meta, init, false)?;
    match started.await {
        Ok(Ok(_)) => Ok((tref, pid)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(WireError::new(code::SPAWN_FAILED, "owner thread died while starting")),
    }
}

/// A brain start: an owner thread per terminal the holder keeps, each restoring its screen from
/// its newest usable blob. They wait for [`Registry::go`] before reading. Returns each
/// terminal's id, how it came back and its unseen byte count.
pub fn restore(reg: &Arc<Registry>, held: Vec<Held>) -> Vec<(String, RestoreResult)> {
    let mut waits = Vec::new();
    for h in held {
        let id = h.id.clone();
        let meta: Meta = match serde_json::from_value(h.meta.clone()) {
            Ok(m) => m,
            Err(e) => {
                crate::log(&format!("terminal {id}: the holder's record is unreadable ({e}); hanging it up"));
                reg.hold.send(&json!({"m": "kill", "handle": h.handle, "signal": libc::SIGHUP}), &[]);
                reg.hold.send(&json!({"m": "release", "handle": h.handle}), &[]);
                continue;
            }
        };
        let exit = h.exit;
        let blobs = h.blobs.iter().map(|b| b.try_clone().expect("dup")).collect();
        let init = Init::Restore { blobs, exit };
        let held = Held { blobs: vec![], ..h };
        match start_owner(reg, held, meta, init, true) {
            Ok((_, rx)) => waits.push((id, rx)),
            Err(e) => waits.push((id, {
                let (tx, rx) = oneshot::channel();
                let _ = tx.send(Err(e));
                rx
            })),
        }
    }
    waits
        .into_iter()
        .map(|(id, rx)| {
            let r = rx
                .blocking_recv()
                .unwrap_or_else(|_| Err(WireError::new(code::PANIC, "owner thread died while restoring")));
            (id, r)
        })
        .collect()
}

/// How a terminal came back and its unseen byte count, or why it could not.
pub type RestoreResult = Result<(Restored, u64), WireError>;

type Started = oneshot::Receiver<RestoreResult>;

fn start_owner(
    reg: &Arc<Registry>,
    held: Held,
    meta: Meta,
    init: Init,
    wait_go: bool,
) -> Result<(Arc<TermRef>, Started), WireError> {
    let wake = Arc::new(Wake::new().map_err(|e| WireError::new(code::SPAWN_FAILED, format!("wake fd: {e}")))?);
    let (tx, rx) = mpsc::channel();
    let tref = Arc::new(TermRef {
        id: held.id.clone(),
        handle: held.handle,
        tx,
        wake: wake.clone(),
        info: Mutex::new(TermInfo {
            id: held.id.clone(),
            handle: held.handle,
            pid: held.pid,
            argv: meta.argv.clone(),
            cwd: meta.cwd.clone(),
            cols: 0,
            rows: 0,
            title: String::new(),
            alt: false,
            seq: 0,
            created_at: meta.created_at,
            subscribers: SubscriberCounts::default(),
        }),
    });
    reg.insert(tref.clone());
    let (started_tx, started_rx) = oneshot::channel();
    let reg2 = reg.clone();
    let tref2 = tref.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("term:{}", held.id))
        .spawn(move || owner_thread(reg2, tref2, rx, wake, held, meta, init, wait_go, started_tx));
    if let Err(e) = spawned {
        reg.remove(&tref);
        return Err(WireError::new(code::SPAWN_FAILED, format!("owner thread: {e}")));
    }
    Ok((tref, started_rx))
}

/// What libghostty's effect callbacks leave for the owner thread to act on after a write.
#[derive(Default)]
struct Fx {
    replies: RefCell<Vec<u8>>,
    title: Cell<bool>,
    bells: Cell<u32>,
    pwd: Cell<bool>,
    /// cols, rows, cell width px, cell height px.
    size: Cell<(u16, u16, u32, u32)>,
}

struct ViewState {
    anchor: TrackedGridRef,
}

struct Sub {
    conn: ConnId,
    out: Arc<ConnOut>,
    shared: Arc<SubShared>,
    role: Role,
    mode: Mode,
    flow: Flow,
    /// The flow it asked for at subscribe; an owner's flow is this, else `block`.
    want_flow: Option<Flow>,
    view: Option<ViewState>,
    /// Where its stream stands after the last data frame queued for it.
    sent_end: u64,
    /// Lagging (lossy only): where delivery stopped. Resynced once its queue drains.
    lag: Option<u64>,
}

struct Owner {
    reg: Arc<Registry>,
    tref: Arc<TermRef>,
    wake: Arc<Wake>,
    rx: mpsc::Receiver<Cmd>,
    term: Terminal<'static, 'static>,
    fx: Rc<Fx>,
    master: Option<OwnedFd>,
    slot: u32,
    /// The program's end, once the holder has reaped it.
    exit: Option<Exit>,
    seq: u64,
    subs: Vec<Sub>,
    input: Vec<u8>,
    modes: Modes,
    title: String,
    pwd: String,
    eof: bool,
    last_output: Instant,
    compress_pending: bool,
    /// The `seq` of the newest snapshot handed to the holder, and when.
    snap_seq: u64,
    last_snap: Instant,
    /// An upgrade's cut: the PTY is not read and nothing changes until `Resume`.
    cut: bool,
    /// `kill` was asked at this time; `finish` follows the holder's `exited`.
    killing: Option<Instant>,
    kill_replies: Vec<(Arc<ConnOut>, u64)>,
    pending_done: Vec<oneshot::Sender<bool>>,
    /// Set when the terminal is finished: the thread exits after this iteration.
    done: bool,
}

/// Builds a terminal's emulator settings and effect callbacks (new and restored alike).
fn configure(
    term: &mut Terminal<'static, 'static>,
    fx: &Rc<Fx>,
    meta: &Meta,
    cols: u16,
    rows: u16,
    fresh: bool,
) -> Result<(), String> {
    let e = |what: &str, e: &dyn std::fmt::Display| format!("{what}: {e}");
    fx.size.set((cols, rows, meta.cell_px[0], meta.cell_px[1]));
    let c = &meta.colors;
    let fg = c.fg.as_deref().and_then(parse_hex).unwrap_or(Rgb { r: 0xcc, g: 0xcc, b: 0xcc });
    let bg = c.bg.as_deref().and_then(parse_hex).unwrap_or(Rgb { r: 0x10, g: 0x12, b: 0x14 });
    let cursor = c.cursor.as_deref().and_then(parse_hex).unwrap_or(fg);
    if fresh {
        term.set_continuation_max_bytes(CONTINUATION_MAX).map_err(|x| e("continuation", &x))?;
    }
    term.set_scrollback_max_bytes(Some(meta.scrollback as usize))
        .and_then(|t| t.set_default_fg_color(Some(fg)))
        .and_then(|t| t.set_default_bg_color(Some(bg)))
        .and_then(|t| t.set_default_cursor_color(Some(cursor)))
        .and_then(|t| t.set_terminfo_name("xterm-256color"))
        .and_then(|t| t.set_title_report_enabled(false))
        .and_then(|t| t.set_kitty_image_storage_limit(0))
        .map_err(|x| e("terminal options", &x))?;
    term.resize(cols, rows, meta.cell_px[0], meta.cell_px[1]).map_err(|x| e("terminal size", &x))?;
    let f = fx.clone();
    term.on_pty_write(move |_, d| f.replies.borrow_mut().extend_from_slice(d)).map_err(|x| e("callback", &x))?;
    let f = fx.clone();
    term.on_title_changed(move |_| f.title.set(true)).map_err(|x| e("callback", &x))?;
    let f = fx.clone();
    term.on_bell(move |_| f.bells.set(f.bells.get() + 1)).map_err(|x| e("callback", &x))?;
    let f = fx.clone();
    term.on_pwd_changed(move |_| f.pwd.set(true)).map_err(|x| e("callback", &x))?;
    let f = fx.clone();
    term.on_size(move |_| {
        let (c, r, w, h) = f.size.get();
        Some(libghostty_vt::report::SizeReportSize { rows: r, columns: c, cell_width: w, cell_height: h })
    })
    .map_err(|x| e("callback", &x))?;
    term.on_xtversion(|_| Some(concat!("g3d-termd ", env!("CARGO_PKG_VERSION")))).map_err(|x| e("callback", &x))?;
    Ok(())
}

/// The newest usable blob as an emulator: a snapshot of our own engine decoded, or a VT repaint
/// replayed into a fresh terminal. Returns the terminal, the blob's seq, and its pending input
/// when it is an upgrade's handoff.
fn from_blobs(
    reg: &Registry,
    id: &str,
    fx: &Rc<Fx>,
    meta: &Meta,
    blobs: &[OwnedFd],
    cols: u16,
    rows: u16,
) -> Option<(Terminal<'static, 'static>, u64, bool, Vec<u8>)> {
    for (i, fd) in blobs.iter().enumerate() {
        let b = match blob::read(fd) {
            Ok(b) => b,
            Err(e) => {
                crate::log(&format!("terminal {id}: blob {i} unusable: {e}"));
                continue;
            }
        };
        if b.id != id {
            crate::log(&format!("terminal {id}: blob {i} is {:?}'s; skipped", b.id));
            continue;
        }
        let term = match b.kind {
            blob::KIND_SNAPSHOT if b.engine == reg.cfg.engine => {
                let decoded = libghostty_vt::snapshot::Decoder::new_buf(&b.payload).and_then(|mut d| {
                    d.set_retain_continuation(true)?.set_max_continuation_bytes(CONTINUATION_MAX)?;
                    d.decode()
                });
                match decoded {
                    Ok(mut t) => match configure(&mut t, fx, meta, cols, rows, false) {
                        Ok(()) => t,
                        Err(e) => {
                            crate::log(&format!("terminal {id}: restored snapshot: {e}"));
                            continue;
                        }
                    },
                    Err(e) => {
                        crate::log(&format!("terminal {id}: snapshot {i} did not decode: {e}"));
                        continue;
                    }
                }
            }
            blob::KIND_SNAPSHOT => {
                crate::log(&format!(
                    "terminal {id}: snapshot {i} is from {:?}, not {:?}; skipped",
                    b.engine, reg.cfg.engine
                ));
                continue;
            }
            _ => {
                let Ok(mut t) = Terminal::new(cols, rows) else { continue };
                if configure(&mut t, fx, meta, cols, rows, true).is_err() {
                    continue;
                }
                t.vt_write(&b.payload);
                // The repaint's own answers to queries are not the program's.
                fx.replies.borrow_mut().clear();
                t
            }
        };
        return Some((term, b.seq, b.handoff, b.input));
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn owner_thread(
    reg: Arc<Registry>,
    tref: Arc<TermRef>,
    rx: mpsc::Receiver<Cmd>,
    wake: Arc<Wake>,
    held: Held,
    meta: Meta,
    init: Init,
    wait_go: bool,
    started: oneshot::Sender<Result<(Restored, u64), WireError>>,
) {
    let (handle, pid) = (held.handle, held.pid);
    let setup = catch_unwind(AssertUnwindSafe(|| Owner::new(reg.clone(), tref.clone(), rx, wake, held, &meta, init)));
    let (mut owner, restored, unseen) = match setup {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            crate::log(&format!("terminal {}: {e}; hanging up its program", tref.id));
            reg.hold.send(&json!({"m": "kill", "handle": handle, "signal": libc::SIGHUP}), &[]);
            reg.hold.send(&json!({"m": "release", "handle": handle}), &[]);
            reg.remove(&tref);
            let _ = started.send(Err(e));
            return;
        }
        Err(_) => {
            reg.hold.send(&json!({"m": "kill", "handle": handle, "signal": libc::SIGHUP}), &[]);
            reg.hold.send(&json!({"m": "release", "handle": handle}), &[]);
            reg.remove(&tref);
            let _ = started.send(Err(WireError::new(code::SPAWN_FAILED, "panic while starting the terminal")));
            return;
        }
    };
    if wait_go {
        let _ = started.send(Ok((restored, unseen)));
        reg.wait_go();
        if restored != Restored::Exact {
            owner.nudge();
        }
    } else {
        crate::log(&format!("terminal {} (handle {handle}) started: pid {pid}, {:?}", tref.id, meta.argv));
        let _ = started.send(Ok((restored, unseen)));
    }
    let run = catch_unwind(AssertUnwindSafe(|| owner.run()));
    if let Err(p) = run {
        let msg = p
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| p.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "?".into());
        crate::log(&format!("terminal {} owner thread panicked: {msg}; closing it, other terminals carry on", tref.id));
        owner.abandon();
    }
}

impl Owner {
    fn new(
        reg: Arc<Registry>,
        tref: Arc<TermRef>,
        rx: mpsc::Receiver<Cmd>,
        wake: Arc<Wake>,
        held: Held,
        meta: &Meta,
        init: Init,
    ) -> Result<(Self, Restored, u64), WireError> {
        let fail = |what: &str, e: &dyn std::fmt::Display| WireError::new(code::SPAWN_FAILED, format!("{what}: {e}"));
        rustix::fs::fcntl_setfl(&held.master, rustix::fs::OFlags::NONBLOCK).map_err(|e| fail("master fd", &e))?;
        let fx = Rc::new(Fx::default());
        let hw = reg.marks.get(held.slot);
        let (term, seq, restored, unseen, input, exit) = match init {
            Init::New { cols, rows } => {
                let mut t = Terminal::new(cols, rows).map_err(|e| fail("terminal", &e))?;
                configure(&mut t, &fx, meta, cols, rows, true).map_err(|e| fail("terminal", &e))?;
                (t, 0, Restored::Blank, 0, Vec::new(), None)
            }
            Init::Restore { blobs, exit } => {
                // The kernel's size is the truth: the last brain may have died mid-resize.
                let ws = rustix::termios::tcgetwinsize(&held.master).map_err(|e| fail("window size", &e))?;
                let (cols, rows) = (ws.ws_col.max(1), ws.ws_row.max(1));
                match from_blobs(&reg, &held.id, &fx, meta, &blobs, cols, rows) {
                    Some((t, bseq, handoff, input)) => {
                        let unseen = hw.saturating_sub(bseq);
                        let exact = unseen == 0;
                        // Input is at most once: only an exact handoff's pending input is the
                        // program's still.
                        let input = if exact && handoff { input } else { Vec::new() };
                        if !exact {
                            crate::log(&format!(
                                "terminal {}: restored from a snapshot at seq {bseq}; the last brain read to seq {hw}: {unseen} B unseen",
                                held.id
                            ));
                        }
                        (t, hw.max(bseq), if exact { Restored::Exact } else { Restored::Snapshot }, unseen, input, exit)
                    }
                    None => {
                        crate::log(&format!("terminal {}: no usable snapshot; blank from seq {hw}", held.id));
                        let mut t = Terminal::new(cols, rows).map_err(|e| fail("terminal", &e))?;
                        configure(&mut t, &fx, meta, cols, rows, true).map_err(|e| fail("terminal", &e))?;
                        (t, hw, Restored::Blank, hw, Vec::new(), exit)
                    }
                }
            }
        };
        reg.marks.set(held.slot, seq);
        let title = repaint::clean_title(term.title().unwrap_or(b""));
        let pwd = String::from_utf8_lossy(term.pwd().unwrap_or(b"")).into_owned();
        let mut o = Owner {
            reg,
            tref,
            wake,
            rx,
            term,
            fx,
            master: Some(held.master),
            slot: held.slot,
            exit,
            seq,
            subs: Vec::new(),
            input,
            modes: Modes::default(),
            title,
            pwd,
            eof: false,
            last_output: Instant::now(),
            compress_pending: restored != Restored::Blank,
            snap_seq: seq,
            last_snap: Instant::now(),
            cut: false,
            killing: None,
            kill_replies: Vec::new(),
            pending_done: Vec::new(),
            done: false,
        };
        o.modes = o.current_modes();
        let (cols, rows) = o.cols_rows();
        {
            let mut info = o.tref.info.lock().unwrap();
            info.cols = cols;
            info.rows = rows;
            info.seq = o.seq;
            info.alt = o.modes.alt;
            info.title.clone_from(&o.title);
        }
        Ok((o, restored, unseen))
    }

    /// After a crash restore: `SIGWINCH` to the PTY's foreground group, so a full-screen program
    /// redraws everything and a shell its prompt (dtach's `winch`, shpool's `simple`).
    fn nudge(&self) {
        if let Some(fg) = self.master.as_ref().and_then(|m| rustix::termios::tcgetpgrp(m).ok()) {
            let _ = rustix::process::kill_process_group(fg, Signal::WINCH);
        }
    }

    /// Hands the holder a crash snapshot (or, `handoff`, an upgrade's blob) at the current seq.
    fn save(&mut self, kind: u8, handoff: bool) -> Result<(), String> {
        let raw = match kind {
            blob::KIND_SNAPSHOT => self
                .term
                .encode_snapshot_alloc(None)
                .map_err(|e| format!("snapshot: {e}"))?
                .map(|b| b.to_vec())
                .unwrap_or_default(),
            _ => repaint::live(&mut self.term, u32::MAX),
        };
        let input = if handoff { self.input.as_slice() } else { &[] };
        let fd = blob::write(kind, handoff, self.seq, &self.reg.cfg.engine, &self.tref.id, &raw, input)
            .map_err(|e| format!("blob: {e}"))?;
        self.reg
            .hold
            .send(&json!({"m": "snapshot", "handle": self.tref.handle, "seq": self.seq, "handoff": handoff}), &[fd]);
        self.snap_seq = self.seq;
        self.last_snap = Instant::now();
        Ok(())
    }

    fn cols_rows(&self) -> (u16, u16) {
        let (c, r, _, _) = self.fx.size.get();
        (c, r)
    }

    fn reading(&self) -> bool {
        !self.eof
            && !self.cut
            && self.master.is_some()
            && !self.subs.iter().any(|s| s.flow == Flow::Block && s.shared.paused.load(SeqCst))
    }

    fn snapshot_due(&self) -> Option<Duration> {
        let every = self.reg.cfg.snapshot_interval;
        if every.is_zero() || self.cut || self.seq == self.snap_seq || self.master.is_none() {
            return None;
        }
        Some(every.saturating_sub(self.last_snap.elapsed()))
    }

    fn run(&mut self) {
        let mut buf = vec![0u8; READ_CHUNK];
        while !self.done {
            while let Ok(cmd) = self.rx.try_recv() {
                self.handle(cmd);
                if self.done {
                    return;
                }
            }
            self.resync_drained();
            if let Some(e) = self.exit
                && !self.cut
            {
                // The program exited. Take what it left in the PTY, then close.
                while !self.eof && self.read_once(&mut buf) == Some(true) {}
                self.finish(Some(e));
                return;
            }
            if let Some(at) = self.killing
                && at.elapsed() > self.reg.cfg.kill_grace + Duration::from_secs(3)
            {
                crate::log(&format!(
                    "terminal {}: the holder never reported the program's end; closing it",
                    self.tref.id
                ));
                self.finish(None);
                return;
            }
            let reading = self.reading();
            let want_write = !self.input.is_empty() && !self.eof && self.master.is_some();
            let mut timeout = Duration::from_millis(500);
            if self.eof {
                timeout = Duration::from_millis(50);
            }
            if self.compress_pending {
                let idle = self.last_output.elapsed();
                timeout = timeout.min(COMPRESS_IDLE.saturating_sub(idle).max(Duration::from_millis(10)));
            }
            if let Some(d) = self.snapshot_due() {
                timeout = timeout.min(d.max(Duration::from_millis(1)));
            }
            let ts = Timespec { tv_sec: timeout.as_secs() as _, tv_nsec: timeout.subsec_nanos() as _ };
            let (wake_ready, pty_flags) = {
                let mut pf = PollFlags::empty();
                if reading {
                    pf |= PollFlags::IN;
                }
                if want_write {
                    pf |= PollFlags::OUT;
                }
                let wake = PollFd::new(self.wake.fd(), PollFlags::IN);
                let mut fds = match self.master.as_ref() {
                    Some(m) if !pf.is_empty() => vec![wake, PollFd::new(m, pf)],
                    _ => vec![wake],
                };
                match poll(&mut fds, Some(&ts)) {
                    Ok(_) => {}
                    Err(rustix::io::Errno::INTR) => continue,
                    Err(e) => panic!("poll: {e}"),
                }
                (fds[0].revents().contains(PollFlags::IN), fds.get(1).map_or(PollFlags::empty(), |f| f.revents()))
            };
            if wake_ready {
                self.wake.drain();
            }
            if pty_flags.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) && reading {
                // A few reads per wakeup, then back to commands so resizes and input
                // aren't starved by a flood.
                for _ in 0..8 {
                    match self.read_once(&mut buf) {
                        Some(true) => {
                            if !self.reading() {
                                break;
                            }
                        }
                        _ => break,
                    }
                }
            }
            if pty_flags.contains(PollFlags::OUT) {
                self.flush_input();
            }
            if self.compress_pending && self.last_output.elapsed() >= COMPRESS_IDLE {
                self.compress_step();
            }
            if self.snapshot_due() == Some(Duration::ZERO)
                && let Err(e) = self.save(blob::KIND_SNAPSHOT, false)
            {
                crate::log(&format!("terminal {}: {e}", self.tref.id));
                self.last_snap = Instant::now();
            }
        }
    }

    /// One read from the PTY. `Some(true)` = got bytes, `Some(false)` = nothing ready,
    /// `None` = EOF (every slave closed).
    fn read_once(&mut self, buf: &mut [u8]) -> Option<bool> {
        use std::os::fd::AsRawFd;
        let master = self.master.as_ref()?;
        // The high-water mark covers what this read can take BEFORE it runs: a SIGKILL that
        // lands inside the read syscall (the kernel has dequeued the bytes; this thread never
        // runs again) must not lose them uncounted. The read takes at most what FIONREAD said,
        // so the mark is exact unless the kill falls between the store and the syscall; then it
        // overstates by bytes the next brain still reads (seq skips ahead; nothing is lost).
        // Measured: without this, a SIGKILL mid-flood lost ~100 uncounted bytes in 1 run of 4.
        let mut avail: libc::c_int = 0;
        // SAFETY: FIONREAD into a c_int we own, on an fd we hold.
        let ok = unsafe { libc::ioctl(master.as_raw_fd(), libc::FIONREAD as _, &mut avail) } == 0;
        // Nothing queued: a one-byte read still tells EOF from EAGAIN, and a byte that races in
        // between the ioctl and the read stays covered.
        let want = match (ok, avail) {
            (true, n) if n > 0 => (n as usize).min(buf.len()),
            (true, _) => 1,
            (false, _) => buf.len(),
        };
        self.reg.marks.set(self.slot, self.seq + want as u64);
        match rustix::io::read(master, &mut buf[..want]) {
            Ok(0) => {
                self.reg.marks.set(self.slot, self.seq);
                self.eof = true;
                None
            }
            Ok(n) => {
                self.reg.marks.set(self.slot, self.seq + n as u64);
                let chunk: Arc<[u8]> = Arc::from(&buf[..n]);
                self.process(chunk);
                Some(true)
            }
            Err(rustix::io::Errno::AGAIN) | Err(rustix::io::Errno::INTR) => {
                self.reg.marks.set(self.slot, self.seq);
                Some(false)
            }
            Err(_) => {
                // EIO: the slave side is gone.
                self.reg.marks.set(self.slot, self.seq);
                self.eof = true;
                None
            }
        }
    }

    fn process(&mut self, chunk: Arc<[u8]>) {
        self.term.vt_write(&chunk);
        let start = self.seq;
        self.seq += chunk.len() as u64;
        self.last_output = Instant::now();
        self.compress_pending = true;
        for i in 0..self.subs.len() {
            let s = &self.subs[i];
            if s.mode != Mode::Raw || s.view.is_some() {
                continue;
            }
            let head = frame::output_head(self.tref.handle, start, chunk.len());
            self.send(i, false, head, Some(chunk.clone()), Some(self.seq));
        }
        self.flush_replies();
        self.emit_effects();
    }

    fn flush_replies(&mut self) {
        let r = std::mem::take(&mut *self.fx.replies.borrow_mut());
        if !r.is_empty() {
            // Answers go ahead of anything typed later: the program is waiting for them.
            self.input.splice(0..0, r);
            self.flush_input();
        }
    }

    fn flush_input(&mut self) {
        let Some(master) = self.master.as_ref() else { return };
        while !self.input.is_empty() {
            match rustix::io::write(master, &self.input) {
                Ok(n) => {
                    self.input.drain(..n);
                }
                Err(rustix::io::Errno::INTR) => {}
                Err(_) => break, // AGAIN: wait for POLLOUT; EIO: the program is gone
            }
        }
    }

    fn current_modes(&self) -> Modes {
        let m = |x| self.term.mode(x).unwrap_or(false);
        Modes {
            alt: matches!(self.term.active_screen(), Ok(Screen::Alternate)),
            mouse: m(VtMode::X10_MOUSE) || m(VtMode::NORMAL_MOUSE) || m(VtMode::BUTTON_MOUSE) || m(VtMode::ANY_MOUSE),
            mouse_sgr: m(VtMode::SGR_MOUSE),
            bracketed_paste: m(VtMode::BRACKETED_PASTE),
            app_cursor: m(VtMode::DECCKM),
            focus: m(VtMode::FOCUS_EVENT),
        }
    }

    fn emit_effects(&mut self) {
        if self.fx.title.take() {
            let t = repaint::clean_title(self.term.title().unwrap_or(b""));
            if t != self.title {
                self.title = t.clone();
                self.event_all(false, &Event::Title { title: t });
            }
        }
        // One `bell` for however many BELs this read held: a bell is a nudge, not a count.
        if self.fx.bells.replace(0) > 0 {
            self.event_all(false, &Event::Bell);
        }
        if self.fx.pwd.take() {
            self.pwd = String::from_utf8_lossy(self.term.pwd().unwrap_or(b"")).into_owned();
            self.event_all(false, &Event::Pwd { pwd: self.pwd.clone() });
        }
        let m = self.current_modes();
        if m != self.modes {
            self.modes = m;
            self.event_all(false, &Event::Modes(m));
        }
        let mut info = self.tref.info.lock().unwrap();
        info.seq = self.seq;
        info.alt = self.modes.alt;
        info.title.clone_from(&self.title);
    }

    /// Queues a frame for subscription `i` under its flow (PROTOCOL.md, "Flow control").
    /// `end` is where a data frame leaves the subscriber's stream (an `OUTPUT`'s end, a
    /// `REPAINT`'s `seq`), `None` for an event. `keep` frames (`role`, `lagged`, `exit`,
    /// `closed`, `error`) are never dropped. A lossy subscriber whose queue would pass
    /// `LOSSY_MAX` starts lagging: its queued frames go, nothing but `keep` frames is
    /// queued for it, and `resync_drained` catches it up once it has read what was left.
    /// An empty queue always takes the frame, so one large repaint can't start a lag.
    fn send(&mut self, i: usize, keep: bool, head: Vec<u8>, body: Option<Arc<[u8]>>, end: Option<u64>) {
        let s = &mut self.subs[i];
        if s.lag.is_some() && !keep {
            return;
        }
        let len = head.len() + body.as_ref().map_or(0, |b| b.len());
        let queued = s.shared.queued.load(SeqCst);
        if s.flow == Flow::Lossy && !keep && queued > 0 && queued + len > LOSSY_MAX {
            let stop = s.out.drop_sub_frames(&s.shared);
            s.lag = Some(stop.unwrap_or(s.sent_end));
            s.shared.lagging.store(true, SeqCst);
            // It may have drained already; otherwise written() wakes us when it does.
            self.wake.wake();
            return;
        }
        let kind = match (keep, end) {
            (true, _) => Kind::Keep,
            (false, Some(_)) => Kind::Data { prev_end: s.sent_end },
            (false, None) => Kind::Event,
        };
        s.out.sub_frame(&s.shared, kind, head, body);
        if let Some(e) = end {
            s.sent_end = e;
        }
        if s.flow == Flow::Block {
            s.shared.maybe_pause();
        }
    }

    /// Catches up every lagging subscriber that has read all it was left: one `lagged`,
    /// then a `REPAINT` (raw) or a `size` event (`mode: "none"`), then the state events.
    fn resync_drained(&mut self) {
        for i in 0..self.subs.len() {
            let Some(from) = self.subs[i].lag else { continue };
            if self.subs[i].shared.queued.load(SeqCst) != 0 {
                continue;
            }
            self.subs[i].lag = None;
            self.subs[i].shared.lagging.store(false, SeqCst);
            let dropped = self.lag_dropped(i, from);
            self.event_to(i, true, &Event::Lagged { dropped, seq: self.seq });
            if self.subs[i].mode == Mode::Raw {
                match self.view_top(i) {
                    Some(top) => self.push_view_repaint(i, top),
                    None => self.push_live_repaint(i, 0),
                }
            } else {
                let (cols, rows) = self.cols_rows();
                self.event_to(i, false, &Event::Size { cols, rows, seq: self.seq });
            }
            self.send_state(i);
        }
    }

    /// The `OUTPUT` bytes a subscriber lagging since `from` did not get: none for one
    /// that gets no output (`mode: "none"`, or scrolled back).
    fn lag_dropped(&self, i: usize, from: u64) -> u64 {
        let s = &self.subs[i];
        if s.mode == Mode::Raw && s.view.is_none() { self.seq.saturating_sub(from) } else { 0 }
    }

    /// The terminal's state as events, for a subscriber that has none of it yet or lost
    /// some: `modes`, then `title` and `pwd` when the program set them.
    fn send_state(&mut self, i: usize) {
        self.event_to(i, false, &Event::Modes(self.modes));
        if !self.title.is_empty() {
            self.event_to(i, false, &Event::Title { title: self.title.clone() });
        }
        if !self.pwd.is_empty() {
            self.event_to(i, false, &Event::Pwd { pwd: self.pwd.clone() });
        }
    }

    fn event_to(&mut self, i: usize, keep: bool, ev: &Event) {
        let bytes = frame::encode_json(ty::EVENT, self.tref.handle, ev);
        self.send(i, keep, bytes, None, None);
    }

    fn event_all(&mut self, keep: bool, ev: &Event) {
        let bytes = frame::encode_json(ty::EVENT, self.tref.handle, ev);
        for i in 0..self.subs.len() {
            self.send(i, keep, bytes.clone(), None, None);
        }
    }

    fn push_live_repaint(&mut self, i: usize, history_rows: u32) {
        if self.subs[i].lag.is_some() {
            return; // its resync repaints it
        }
        let vt = repaint::live(&mut self.term, history_rows);
        let (cols, rows) = self.cols_rows();
        let head = RepaintHead { seq: self.seq, cols, rows, flags: 0 };
        self.send(i, false, frame::encode_repaint(self.tref.handle, head, &vt), None, Some(self.seq));
    }

    fn update_counts(&self) {
        let mut c = SubscriberCounts::default();
        for s in &self.subs {
            match s.role {
                Role::Own => c.own += 1,
                Role::Attach => c.attach += 1,
                Role::Watch => c.watch += 1,
            }
        }
        self.tref.info.lock().unwrap().subscribers = c;
    }

    fn sub_index(&self, conn: ConnId) -> Option<usize> {
        self.subs.iter().position(|s| s.conn == conn)
    }

    /// Makes subscription `i` the owner, with the flow it asked for at subscribe, else
    /// `block`. Any other owner is demoted first.
    fn make_owner(&mut self, i: usize) {
        self.demote_owners(Some(i));
        let s = &mut self.subs[i];
        s.role = Role::Own;
        s.flow = s.want_flow.unwrap_or(Flow::Block);
    }

    /// Demotes the owner (unless it is `except`) to an `attach` subscriber, which is lossy:
    /// a wedged owner stops holding the PTY back the moment someone takes the terminal.
    /// It hears so in a `role` event.
    fn demote_owners(&mut self, except: Option<usize>) {
        for j in 0..self.subs.len() {
            if Some(j) != except && self.subs[j].role == Role::Own {
                let s = &mut self.subs[j];
                s.role = Role::Attach;
                s.flow = Flow::Lossy;
                s.shared.paused.store(false, SeqCst);
                self.event_to(j, true, &Event::Role { role: Role::Attach });
            }
        }
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        if self.cols_rows() == (cols, rows) {
            return;
        }
        // Bytes the program wrote before the resize were written at the old size.
        if self.reading() {
            let mut buf = vec![0u8; READ_CHUNK];
            while self.read_once(&mut buf) == Some(true) {}
        }
        let (_, _, cw, ch) = self.fx.size.get();
        if let Err(e) = self.term.resize(cols, rows, cw, ch) {
            crate::log(&format!("terminal {}: resize {cols}x{rows}: {e}", self.tref.id));
            return;
        }
        if let Some(m) = &self.master {
            let _ = rustix::termios::tcsetwinsize(m, spawn::winsize(cols, rows));
        }
        self.fx.size.set((cols, rows, cw, ch));
        {
            let mut info = self.tref.info.lock().unwrap();
            info.cols = cols;
            info.rows = rows;
        }
        self.event_all(false, &Event::Size { cols, rows, seq: self.seq });
        for i in 0..self.subs.len() {
            if self.subs[i].view.take().is_some() {
                self.push_live_repaint(i, 0);
            }
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        let Cmd { conn, out, req, op, mut done } = cmd;
        let ok = self.handle_op(conn, &out, req, op, &mut done);
        if let Some(d) = done {
            let _ = d.send(ok);
        }
    }

    fn handle_op(
        &mut self,
        conn: ConnId,
        out: &Arc<ConnOut>,
        req: u64,
        op: TermOp,
        done: &mut Option<oneshot::Sender<bool>>,
    ) -> bool {
        let handle = self.tref.handle;
        match op {
            TermOp::Subscribe(s) => {
                if self.sub_index(conn).is_some() {
                    reply_err(out, req, code::ALREADY_SUBSCRIBED, format!("already subscribed to {}", self.tref.id));
                    return false;
                }
                if s.mode == Mode::Cells {
                    reply_err(out, req, code::UNSUPPORTED, "mode \"cells\" is not in this daemon (feature `cells`)");
                    return false;
                }
                let flow = s.flow.unwrap_or(if s.role == Role::Own { Flow::Block } else { Flow::Lossy });
                if flow == Flow::Block && s.role != Role::Own {
                    reply_err(out, req, code::BAD_REQUEST, "only role \"own\" may ask for flow \"block\"");
                    return false;
                }
                let size = match (s.cols, s.rows) {
                    (Some(c), Some(r)) if s.role == Role::Own => {
                        if !valid_size(c, r) {
                            reply_err(out, req, code::BAD_REQUEST, "cols and rows must be 1 to 4096");
                            return false;
                        }
                        Some((c, r))
                    }
                    (None, None) => None,
                    (Some(_), Some(_)) => {
                        reply_err(out, req, code::NOT_OWNER, "only role \"own\" sets the size at subscribe");
                        return false;
                    }
                    _ => {
                        reply_err(out, req, code::BAD_REQUEST, "give both cols and rows, or neither");
                        return false;
                    }
                };
                // The old owner hears `role`, then `size`. The new subscriber joins after
                // the resize: its reply and repaint carry the size.
                if s.role == Role::Own {
                    self.demote_owners(None);
                }
                if let Some((c, r)) = size {
                    self.resize(c, r);
                }
                self.subs.push(Sub {
                    conn,
                    out: out.clone(),
                    shared: Arc::new(SubShared::new(self.wake.clone())),
                    role: s.role,
                    mode: s.mode,
                    flow,
                    want_flow: s.flow,
                    view: None,
                    sent_end: self.seq,
                    lag: None,
                });
                let i = self.subs.len() - 1;
                self.update_counts();
                let (cols, rows) = self.cols_rows();
                reply_ok(out, req, &SubscribeReply { handle, role: s.role, seq: self.seq, cols, rows });
                if s.mode == Mode::Raw {
                    self.push_live_repaint(i, s.history_rows.unwrap_or(0));
                }
                self.send_state(i);
                true
            }
            TermOp::Unsubscribe => match self.sub_index(conn) {
                Some(i) => {
                    self.subs.remove(i);
                    self.update_counts();
                    reply_ok(out, req, &Empty {});
                    true
                }
                None => {
                    reply_err(out, req, code::NOT_SUBSCRIBED, format!("not subscribed to handle {handle}"));
                    false
                }
            },
            TermOp::Detach => {
                if let Some(i) = self.sub_index(conn) {
                    self.subs.remove(i);
                    self.update_counts();
                }
                true
            }
            TermOp::Take { cols, rows } => {
                let Some(i) = self.sub_index(conn) else {
                    reply_err(out, req, code::NOT_SUBSCRIBED, format!("not subscribed to handle {handle}"));
                    return false;
                };
                if self.subs[i].role == Role::Watch {
                    reply_err(out, req, code::READ_ONLY, "a watch subscription can't take the terminal");
                    return false;
                }
                let size = match (cols, rows) {
                    (Some(c), Some(r)) if valid_size(c, r) => Some((c, r)),
                    (None, None) => None,
                    _ => {
                        reply_err(out, req, code::BAD_REQUEST, "cols and rows must both be 1 to 4096, or both absent");
                        return false;
                    }
                };
                // The old owner hears `role`, then `size`; the taker gets its reply, then `size`.
                self.make_owner(i);
                self.update_counts();
                reply_ok(out, req, &TakeReply { role: Role::Own });
                if let Some((c, r)) = size {
                    self.resize(c, r);
                }
                true
            }
            TermOp::Resize { cols, rows } => {
                let Some(i) = self.sub_index(conn) else {
                    reply_err(out, req, code::NOT_SUBSCRIBED, format!("not subscribed to handle {handle}"));
                    return false;
                };
                if self.subs[i].role != Role::Own {
                    reply_err(out, req, code::NOT_OWNER, "only the owner resizes; use take");
                    return false;
                }
                if !valid_size(cols, rows) {
                    reply_err(out, req, code::BAD_REQUEST, "cols and rows must be 1 to 4096");
                    return false;
                }
                if self.cut {
                    reply_err(out, req, code::BUSY, "termd is upgrading; resize after it");
                    return false;
                }
                self.resize(cols, rows);
                reply_ok(out, req, &Empty {});
                true
            }
            TermOp::Repaint { history_rows } => {
                let Some(i) = self.sub_index(conn) else {
                    reply_err(out, req, code::NOT_SUBSCRIBED, format!("not subscribed to handle {handle}"));
                    return false;
                };
                if self.subs[i].mode != Mode::Raw {
                    reply_err(out, req, code::UNSUPPORTED, "repaint needs mode \"raw\"");
                    return false;
                }
                reply_ok(out, req, &Empty {});
                if let Some(top) = self.view_top(i) {
                    self.push_view_repaint(i, top);
                } else {
                    self.push_live_repaint(i, history_rows);
                }
                true
            }
            TermOp::View { delta, live } => self.view(conn, out, req, delta, live),
            TermOp::Capture(c) => {
                let (text, rows) = repaint::capture(
                    &self.term,
                    c.format == Some(CaptureFormat::Vt),
                    c.history_rows.unwrap_or(0),
                    c.unwrap.unwrap_or(false),
                );
                if text.len() + 256 > g3d_wire::frame::DEFAULT_MAX_FRAME {
                    reply_err(
                        out,
                        req,
                        code::TOO_LARGE,
                        format!("{} B of text is over max_frame; ask for fewer rows", text.len()),
                    );
                    return false;
                }
                reply_ok(out, req, &CaptureReply { text, rows });
                true
            }
            TermOp::Input(bytes) => {
                let err = |code: &str, msg: String| {
                    out.frame(frame::encode_json(ty::EVENT, handle, &Event::Error { code: code.into(), message: msg }));
                };
                let Some(i) = self.sub_index(conn) else {
                    err(code::NOT_SUBSCRIBED, format!("INPUT for handle {handle} without a subscription"));
                    return false;
                };
                if self.subs[i].role == Role::Watch {
                    err(code::READ_ONLY, format!("INPUT on a watch subscription to {}", self.tref.id));
                    return false;
                }
                if self.reg.cfg.test_hooks && bytes == TEST_PANIC_INPUT {
                    panic!("test hook: panic requested by INPUT");
                }
                if self.reg.cfg.test_hooks && bytes == TEST_WEDGE_INPUT {
                    crate::server::WEDGED.store(true, SeqCst);
                    crate::log("test hook: the heartbeat stops");
                    return true;
                }
                if self.cut {
                    // At most once: input the handoff didn't carry is dropped, and said so.
                    err(
                        code::BUSY,
                        format!("termd is upgrading; {} B of input to {} dropped", bytes.len(), self.tref.id),
                    );
                    return false;
                }
                if self.subs[i].view.take().is_some() {
                    self.push_live_repaint(i, 0);
                }
                if self.input.len() + bytes.len() > INPUT_MAX {
                    err(
                        code::INPUT_FULL,
                        format!(
                            "{} has {} B of unread input; {} B refused",
                            self.tref.id,
                            self.input.len(),
                            bytes.len()
                        ),
                    );
                    return false;
                }
                self.input.extend_from_slice(&bytes);
                self.flush_input();
                true
            }
            TermOp::Kill { signal, reply } => {
                if self.cut && reply {
                    reply_err(out, req, code::BUSY, "termd is upgrading; kill after it");
                    return false;
                }
                if reply {
                    self.kill_replies.push((out.clone(), req));
                }
                if self.killing.is_none() {
                    self.kill(signal);
                }
                // Answered (and `done` completed) once the holder reports the program's end.
                self.pending_done.extend(done.take());
                true
            }
            TermOp::Exited(e) => {
                if self.exit.is_none() {
                    self.exit = Some(e);
                }
                true
            }
            TermOp::Cut { snapshot } => {
                self.flush_input();
                self.cut = true;
                let kind = if snapshot { blob::KIND_SNAPSHOT } else { blob::KIND_VT };
                match self.save(kind, true) {
                    Ok(()) => true,
                    Err(e) => {
                        crate::log(&format!("terminal {}: handoff: {e}", self.tref.id));
                        false
                    }
                }
            }
            TermOp::Resume => {
                self.cut = false;
                true
            }
        }
    }

    /// The screen row a subscription's view starts at, if it is scrolled back.
    fn view_top(&self, i: usize) -> Option<u32> {
        let v = self.subs[i].view.as_ref()?;
        let rows = u32::from(self.cols_rows().1);
        let total = self.term.total_rows().ok()? as u32;
        let top = v
            .anchor
            .snapshot(&self.term)
            .ok()
            .flatten()
            .and_then(|g| self.term.point_from_grid_ref(&g, Space::Screen).ok().flatten())
            .map(|c| c.y)
            .unwrap_or(0);
        Some(top.min(total.saturating_sub(rows)))
    }

    fn push_view_repaint(&mut self, i: usize, top: u32) {
        if self.subs[i].lag.is_some() {
            return; // its resync repaints it
        }
        let vt = repaint::view(&self.term, top);
        let (cols, rows) = self.cols_rows();
        let head = RepaintHead { seq: self.seq, cols, rows, flags: REPAINT_FLAG_VIEW };
        self.send(i, false, frame::encode_repaint(self.tref.handle, head, &vt), None, Some(self.seq));
    }

    fn view(&mut self, conn: ConnId, out: &Arc<ConnOut>, req: u64, delta: Option<i64>, live: bool) -> bool {
        let Some(i) = self.sub_index(conn) else {
            reply_err(out, req, code::NOT_SUBSCRIBED, format!("not subscribed to handle {}", self.tref.handle));
            return false;
        };
        if self.subs[i].mode != Mode::Raw {
            reply_err(out, req, code::UNSUPPORTED, "view needs mode \"raw\"");
            return false;
        }
        if self.modes.alt {
            reply_err(
                out,
                req,
                code::ALT_SCREEN,
                "the alternate screen has no scrollback; send the wheel to the program",
            );
            return false;
        }
        let rows = u32::from(self.cols_rows().1);
        let total = self.term.total_rows().unwrap_or(0) as u32;
        let max = total.saturating_sub(rows);
        let cur = self.view_top(i).map_or(0, |top| max - top.min(max));
        let want = if live { 0 } else { (i64::from(cur) + delta.unwrap_or(0)).clamp(0, i64::from(max)) as u32 };
        reply_ok(out, req, &ViewReply { offset: u64::from(want), max: u64::from(max) });
        if want == cur && (want != 0 || self.subs[i].view.is_none()) {
            return true;
        }
        if want == 0 {
            self.subs[i].view = None;
            self.push_live_repaint(i, 0);
        } else {
            let top = max - want;
            match self.term.track_grid_ref(Point::Screen(Coordinate { x: 0, y: top })) {
                Ok(anchor) => {
                    self.subs[i].view = Some(ViewState { anchor });
                    self.push_view_repaint(i, top);
                }
                Err(e) => crate::log(&format!("terminal {}: view anchor at row {top}: {e}", self.tref.id)),
            }
        }
        true
    }

    fn compress_step(&mut self) {
        for _ in 0..16 {
            match self.term.compress(CompressionMode::Incremental) {
                Ok(CompressionResult::Pending) => {}
                _ => {
                    self.compress_pending = false;
                    return;
                }
            }
        }
    }

    /// Asks the holder to signal the program's process groups (it sends `SIGKILL` after the
    /// grace), takes what the program prints on its way out, and closes our copy of the PTY;
    /// with the holder's closed too, the kernel hangs the session up. `finish` follows the
    /// holder's `exited`.
    fn kill(&mut self, signal: Signal) {
        self.killing = Some(Instant::now());
        self.reg.hold.send(&json!({"m": "kill", "handle": self.tref.handle, "signal": signal.as_raw()}), &[]);
        let mut buf = vec![0u8; READ_CHUNK];
        let until = Instant::now() + Duration::from_millis(100);
        while Instant::now() < until && self.exit.is_none() {
            while let Ok(cmd) = self.rx.try_recv() {
                if let TermOp::Exited(e) = cmd.op {
                    self.exit = Some(e);
                } else {
                    self.handle(cmd);
                }
            }
            match self.read_once(&mut buf) {
                Some(true) => {}
                Some(false) => std::thread::sleep(Duration::from_millis(5)),
                None => break,
            }
        }
        while self.read_once(&mut buf) == Some(true) {}
        self.master = None;
    }

    /// The terminal is over: tell every subscriber, leave the registry, release it to the
    /// holder, end the thread.
    fn finish(&mut self, exit: Option<Exit>) {
        self.master = None;
        let code = exit.and_then(|e| e.code);
        let signal = exit.and_then(|e| e.signal).map(spawn::signal_name);
        let mut how = match (code, &signal) {
            (Some(c), _) => format!("code {c}"),
            (None, Some(s)) => format!("signal {s}"),
            (None, None) => "unknown status".to_owned(),
        };
        how.push_str(&format!(" at seq {}", self.seq));
        crate::log(&format!("terminal {} ended: {how}", self.tref.id));
        for i in 0..self.subs.len() {
            if let Some(from) = self.subs[i].lag.take() {
                let dropped = self.lag_dropped(i, from);
                self.event_to(i, true, &Event::Lagged { dropped, seq: self.seq });
            }
        }
        self.event_all(true, &Event::Exit { code, signal, seq: self.seq });
        self.event_all(true, &Event::Closed);
        self.subs.clear();
        self.reg.remove(&self.tref);
        self.reg.hold.send(&json!({"m": "release", "handle": self.tref.handle}), &[]);
        for (out, req) in self.kill_replies.drain(..) {
            reply_ok(&out, req, &Empty {});
        }
        for d in self.pending_done.drain(..) {
            let _ = d.send(true);
        }
        self.done = true;
        // Commands that raced the end get a no_terminal answer.
        while let Ok(cmd) = self.rx.try_recv() {
            self.refuse(cmd);
        }
    }

    fn refuse(&self, cmd: Cmd) {
        if !matches!(
            cmd.op,
            TermOp::Detach | TermOp::Input(_) | TermOp::Exited(_) | TermOp::Resume | TermOp::Cut { .. }
        ) && !matches!(cmd.op, TermOp::Kill { reply: false, .. })
        {
            reply_err(&cmd.out, cmd.req, code::NO_TERMINAL, format!("terminal {} is gone", self.tref.id));
        }
        if let Some(d) = cmd.done {
            let _ = d.send(matches!(cmd.op, TermOp::Kill { .. }));
        }
    }

    /// After a panic: hang up the program, wait for the holder to reap it, tell subscribers,
    /// leave the registry. The libghostty terminal is not touched again.
    fn abandon(&mut self) {
        self.reg.hold.send(&json!({"m": "kill", "handle": self.tref.handle, "signal": libc::SIGHUP}), &[]);
        self.master = None;
        let until = Instant::now() + self.reg.cfg.kill_grace + Duration::from_secs(3);
        while self.exit.is_none() {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match self.rx.recv_timeout(left) {
                Ok(Cmd { op: TermOp::Exited(e), .. }) => self.exit = Some(e),
                Ok(cmd) => self.refuse(cmd),
                Err(_) => break,
            }
        }
        let message = format!("termd's owner thread for {} failed; the terminal is closed", self.tref.id);
        self.event_all(true, &Event::Error { code: code::PANIC.into(), message });
        let exit = self.exit;
        self.finish(exit);
    }
}

/// Sends `Detach` for a closed connection without waiting.
pub fn detach(t: &TermRef, conn: ConnId) {
    let _ = t.send(Cmd { conn, out: ConnOut::new(), req: 0, op: TermOp::Detach, done: None });
}

/// The `stop` op and a clean shutdown: kill every terminal and wait for each to end.
pub async fn kill_all(reg: &Registry) {
    let mut waits = Vec::new();
    for t in reg.all() {
        let (tx, rx) = oneshot::channel();
        let cmd = Cmd {
            conn: 0,
            out: ConnOut::new(),
            req: 0,
            op: TermOp::Kill { signal: Signal::HUP, reply: false },
            done: Some(tx),
        };
        if t.send(cmd).is_ok() {
            waits.push(rx);
        }
    }
    for w in waits {
        let _ = w.await;
    }
}
