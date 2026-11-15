//! The brain: its start (the hold link's handshake, restoring every terminal), the socket side
//! (accepting connections, the handshake, routing requests and input to owner threads), and
//! the upgrade handoff. No terminal state lives here (DESIGN.md, "Threading").

use crate::env;
use crate::hold::{self, Exit, Hold};
use crate::out::ConnOut;
use crate::owner::{self, Cmd, CreateSpec, Registry, Restored, TermOp, TermRef, reply_err, reply_ok};
use crate::status::{self, Hub};
use g3d_wire::frame::{self, Frame, FrameDecoder, FrameError, ty};
use g3d_wire::msg::*;
use rustix::process::Signal;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot, watch};

/// The emulator: libghostty's version.
pub const ENGINE: &str = "libghostty-vt/1.0.1";
/// What a snapshot restores into: the engine plus its snapshot format (outside libghostty's ABI
/// promise, so a snapshot restores only into exactly this).
pub const SNAPSHOT_ENGINE: &str = "libghostty-vt/1.0.1 snapshot/1";

/// Test hook: the brain's heartbeat to the holder stops (the watchdog test).
pub static WEDGED: AtomicBool = AtomicBool::new(false);

pub struct Server {
    pub reg: Arc<Registry>,
    hold: Arc<Hold>,
    conns: AtomicUsize,
    next_conn: AtomicU64,
    create_lock: tokio::sync::Mutex<()>,
    uid: u32,
    /// Every open connection's queue, for the upgrade's `ERROR restart`.
    outs: Mutex<HashMap<u64, Arc<ConnOut>>>,
    accepting: watch::Sender<bool>,
    /// The running upgrade's inbox for the holder's `candidate`, `commit`, `upgrade_abort`.
    upgrade_tx: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    upgrade_deadline: Duration,
    /// The status document: followers, rates, errors.
    pub hub: Arc<Hub>,
    /// Connections that only follow status (and ping): they don't keep an empty daemon alive.
    passive: AtomicUsize,
    env: Arc<env::Policy>,
}

impl Server {
    /// Client connections that keep the namespace alive: all but the status-only ones.
    fn active_conns(&self) -> usize {
        self.conns.load(SeqCst).saturating_sub(self.passive.load(SeqCst))
    }

    fn status_doc(&self) -> Status {
        self.hub.build(&self.reg, self.conns.load(SeqCst) as u64, self.env.status(), false)
    }
}

/// Leaves: the holder gives the namespace's name up at once (the socket goes, the lock is
/// released), status followers get their last document (`exiting`), and the holder ends the rest
/// once this brain has gone.
async fn end_namespace(srv: &Server, why: &str) -> ! {
    crate::log(&format!("exiting: {why}"));
    // Nothing new is served by a namespace that is leaving: a connection made now waits in the
    // backlog and sees the end, never a terminal created in a namespace about to go.
    let _ = srv.accepting.send(false);
    // The holder removes the socket and releases the namespace now, not when this brain has gone:
    // a client after this point finds nothing (ENOENT) and may start a new daemon at once.
    srv.hold.send(&json!({"m": "exit_namespace", "why": why}), &[]);
    if srv.hub.has_followers() {
        srv.hub.farewell(&srv.reg, srv.conns.load(SeqCst) as u64, srv.env.status());
        let until = Instant::now() + Duration::from_secs(1);
        while srv.hub.has_followers() && Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    std::process::exit(0);
}

/// `g3d-termd --brain`: take what the holder hands over, restore every terminal, serve.
pub fn brain(args: crate::Args, fd: i32, ns: Option<String>, socket: PathBuf, log_path: PathBuf) -> ! {
    g3d_hold::log::set_role("brain");
    g3d_hold::log::set_file(&log_path, args.log_max_bytes);
    // SAFETY: plain signal dispositions, set before any other thread exists.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: PR_SET_NAME with a NUL-terminated name of at most 16 bytes.
        unsafe { libc::prctl(libc::PR_SET_NAME, c"g3d-termd-brain".as_ptr()) };
        // The restartable process is the one the kernel's OOM killer should pick.
        let cur: i32 =
            std::fs::read_to_string("/proc/self/oom_score_adj").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let want = (cur + args.brain_oom_score_adj).clamp(-1000, 1000);
        if let Err(e) = std::fs::write("/proc/self/oom_score_adj", want.to_string()) {
            crate::log(&format!("oom_score_adj {want}: {e}"));
        }
    }
    #[cfg(feature = "test-hooks")]
    let test_hooks = crate::test_hooks_armed();
    #[cfg(feature = "test-hooks")]
    if test_hooks
        && let Ok(p) = std::env::var("G3D_TERMD_TEST_BRAIN_FAIL_FILE")
        && std::path::Path::new(&p).exists()
    {
        crate::log(&format!("test hook: {p} exists; this brain exits at start"));
        std::process::exit(3);
    }
    #[cfg(feature = "test-hooks")]
    let engine = match std::env::var("G3D_TERMD_TEST_ENGINE_FILE") {
        Ok(p) if test_hooks => {
            std::fs::read_to_string(&p).map(|s| s.trim().to_owned()).unwrap_or_else(|_| SNAPSHOT_ENGINE.into())
        }
        _ => SNAPSHOT_ENGINE.into(),
    };
    #[cfg(not(feature = "test-hooks"))]
    let engine: String = SNAPSHOT_ENGINE.into();
    let mut start = hold::start(fd, &engine);
    let w = &start.hold.welcome;
    crate::log(&format!(
        "{} brain (generation {}{}) for holder pid {}; {} terminal(s) to restore",
        crate::VERSION,
        w.generation,
        if w.candidate { ", upgrade candidate" } else { "" },
        w.holder_pid,
        start.terms.len()
    ));
    let candidate = w.candidate;
    crate::out::set_limits(args.lossy_queue, args.block_high, args.block_low);
    let locale_fill = env::locale_fill(args.fill_locale);
    let mut warnings = Vec::new();
    if args.fill_locale && locale_fill.is_none() {
        warnings.push("no UTF-8 locale loads here: terminals that set none get none".to_owned());
    }
    let env_policy = env::Policy::new(
        args.env_source,
        env::Settings {
            scrub: env::SCRUB.iter().map(|s| s.to_string()).chain(args.env_scrub.iter().cloned()).collect(),
            shell: args.shell.clone(),
            login_shell: args.login_shell,
            locale_fill,
            login_path: env::login_path(),
            config: args.config.clone(),
            term: args.term.clone(),
            socket: socket.display().to_string(),
            version: crate::VERSION.to_owned(),
        },
        Duration::from_millis(args.env_manager_timeout_ms),
        warnings,
    );
    let env_policy = Arc::new(env_policy);
    let errors = Arc::new(status::Errors::new(args.status_errors));
    let reg = Registry::new(
        owner::Config {
            ns,
            default_scrollback: args.scrollback.min(args.max_scrollback),
            max_scrollback: args.max_scrollback,
            #[cfg(feature = "test-hooks")]
            test_hooks,
            snapshot_interval: Duration::from_millis(args.snapshot_interval_ms),
            kill_grace: Duration::from_secs(args.kill_grace),
            engine,
            input_max: args.input_buffer,
            env: env_policy.clone(),
        },
        start.hold.clone(),
        start.marks.clone(),
        errors.clone(),
    );
    let terms = std::mem::take(&mut start.terms);
    let exited: Vec<String> = terms.iter().filter(|t| t.exit.is_some()).map(|t| t.id.clone()).collect();
    let restored = owner::restore(&reg, terms);
    let mut counts = [0usize; 3];
    let mut unseen_total = 0u64;
    let mut not_exact = Vec::new();
    for (id, r) in &restored {
        match r {
            Ok((how, unseen)) => {
                counts[*how as usize] += 1;
                unseen_total += unseen;
                if *how != Restored::Exact && !exited.contains(id) {
                    not_exact.push(id.clone());
                }
            }
            Err(e) => {
                crate::log(&format!("terminal {id}: could not be restored: {e}"));
                errors.record("restore", Some(id), format!("could not be restored: {e}"));
                not_exact.push(id.clone());
            }
        }
    }
    if !restored.is_empty() {
        crate::log(&format!(
            "restored {} terminal(s): {} exact, {} from snapshots, {} blank; {unseen_total} B unseen",
            restored.len(),
            counts[Restored::Exact as usize],
            counts[Restored::Snapshot as usize],
            counts[Restored::Blank as usize]
        ));
    }
    let restored_counts = RestoredCounts {
        exact: counts[Restored::Exact as usize] as u64,
        snapshot: counts[Restored::Snapshot as usize] as u64,
        blank: counts[Restored::Blank as usize] as u64,
    };
    let last_start = BrainStart {
        reason: w.reason.clone(),
        at: w.at,
        exit: w.exit.clone(),
        failed_at: w.failed_at,
        restored: restored_counts,
        unseen: unseen_total,
    };
    if let Some(since) = w.failed_at {
        let secs = w.at.saturating_sub(since) / 1000;
        errors.record_at(
            "brain_failed",
            None,
            format!(
                "no termd engine ran for {secs} s: the brain kept failing and was marked failed (the shells were \
                 frozen once their output filled); see the log"
            ),
            w.at,
        );
    }
    if matches!(w.reason.as_str(), "crash" | "watchdog") {
        let how = match &w.exit {
            Some(ExitStatus { signal: Some(s), .. }) => format!(" (SIG{s})"),
            Some(ExitStatus { code: Some(c), .. }) => format!(" (code {c})"),
            _ => String::new(),
        };
        let what = if w.reason == "watchdog" { "was killed by the watchdog" } else { "crashed" };
        errors.record_at(
            &format!("brain_{}", w.reason),
            None,
            format!(
                "termd's engine {what}{how}; screens restored: {} exact, {} from snapshots, {} blank; {unseen_total} B unseen",
                restored_counts.exact, restored_counts.snapshot, restored_counts.blank
            ),
            w.at,
        );
    }
    let info = status::BrainInfo {
        ns: reg.cfg.ns.clone(),
        socket: socket.display().to_string(),
        log: log_path.display().to_string(),
        instance: w.instance.clone(),
        holder_started_at: w.started_at,
        holder_pid: w.holder_pid,
        holder_version: w.holder_version.clone(),
        hold: w.hold,
        generation: w.generation,
        started_at: status::ms_now(),
        restarts: w.restarts,
        last_start,
        snapshot_interval_ms: args.snapshot_interval_ms,
    };
    let hub = Hub::new(
        info,
        status::Settings {
            interval: Duration::from_millis(args.status_interval_ms),
            min: Duration::from_millis(args.status_min_interval_ms),
            max: Duration::from_millis(args.status_max_interval_ms.max(args.status_min_interval_ms)),
            keepalive: Duration::from_millis(args.status_keepalive_ms),
            rate_window: Duration::from_millis(args.status_rate_window_ms.max(1)),
        },
        errors,
    );
    if candidate {
        if !not_exact.is_empty() {
            let why = format!("terminals not handed over exactly: {}", not_exact.join(", "));
            crate::log(&format!("upgrade candidate refuses: {why}"));
            start.hold.send(&json!({"m": "upgrade_abort", "why": why}), &[]);
            std::process::exit(1);
        }
        start.hold.send(&json!({"m": "ready"}), &[]);
        // Test hook: a candidate that dies after the running brain was told to commit.
        #[cfg(feature = "test-hooks")]
        if test_hooks
            && let Ok(p) = std::env::var("G3D_TERMD_TEST_CANDIDATE_DIES_FILE")
            && std::path::Path::new(&p).exists()
        {
            crate::log(&format!("test hook: {p} exists; this candidate dies 100 ms after ready"));
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(100));
                // SAFETY: ending this process on purpose.
                unsafe { libc::raise(libc::SIGKILL) };
            });
        }
    }
    let to_owner = {
        let reg = reg.clone();
        move |h: u32, e: Exit| {
            if let Some(t) = reg.by_handle(h) {
                let _ = t.send(Cmd { conn: 0, out: ConnOut::new(), req: 0, op: TermOp::Exited(e), done: None });
            }
        }
    };
    start.wait_go(&to_owner);
    reg.go();
    let listener = std::os::unix::net::UnixListener::from(std::mem::replace(&mut start.listener, dup_null()));
    let (hold, ctl) = start.spawn_reader(Box::new(to_owner));
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("termd-io")
        .enable_all()
        .build()
        .unwrap_or_else(|e| {
            crate::log(&format!("runtime: {e}"));
            std::process::exit(1)
        });
    let heartbeat = if args.brain_watchdog == 0 {
        Duration::from_secs(5)
    } else {
        Duration::from_millis((args.brain_watchdog * 1000 / 6).clamp(100, 5000))
    };
    rt.block_on(run(
        listener,
        reg,
        hold,
        ctl,
        Duration::from_secs(args.idle_exit),
        heartbeat,
        Duration::from_secs(args.upgrade_deadline),
        hub,
        env_policy,
    ));
    std::process::exit(0);
}

fn dup_null() -> rustix::fd::OwnedFd {
    rustix::fs::open("/dev/null", rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::CLOEXEC, rustix::fs::Mode::empty())
        .expect("/dev/null")
}

#[allow(clippy::too_many_arguments)]
async fn run(
    listener: std::os::unix::net::UnixListener,
    reg: Arc<Registry>,
    hold: Arc<Hold>,
    mut ctl: hold::Ctl,
    idle_exit: Duration,
    heartbeat: Duration,
    upgrade_deadline: Duration,
    hub: Arc<Hub>,
    env: Arc<env::Policy>,
) {
    listener.set_nonblocking(true).expect("nonblocking listener");
    let listener = tokio::net::UnixListener::from_std(listener).expect("tokio listener");
    let (accepting, mut accepting_rx) = watch::channel(true);
    let srv = Arc::new(Server {
        reg,
        hold,
        conns: AtomicUsize::new(0),
        next_conn: AtomicU64::new(1),
        create_lock: tokio::sync::Mutex::new(()),
        uid: rustix::process::getuid().as_raw(),
        outs: Mutex::new(HashMap::new()),
        accepting,
        upgrade_tx: Mutex::new(None),
        upgrade_deadline,
        hub,
        passive: AtomicUsize::new(0),
        env,
    });

    // The status tick: rate samples always; with followers, one document per tick to each one due.
    {
        let srv = srv.clone();
        tokio::spawn(async move {
            loop {
                let next = srv.hub.tick(&srv.reg, srv.conns.load(SeqCst) as u64, || srv.env.status());
                tokio::select! {
                    _ = tokio::time::sleep(next) => {}
                    _ = srv.hub.joined() => {}
                }
            }
        });
    }
    // The session environment's source, found before the first terminal asks for it (so the
    // status document names it, and an unreachable user manager shows up at once).
    {
        let env = srv.env.clone();
        tokio::task::spawn_blocking(move || env.probe());
    }

    // The heartbeat: the holder's watchdog aborts a brain that goes quiet.
    {
        let srv = srv.clone();
        tokio::spawn(async move {
            loop {
                if !WEDGED.load(SeqCst) {
                    srv.hold.send(&json!({"m": "alive"}), &[]);
                }
                tokio::time::sleep(heartbeat).await;
            }
        });
    }

    // The holder's word: shutdown (SIGTERM to the holder), and an upgrade's steps.
    {
        let srv = srv.clone();
        tokio::spawn(async move {
            while let Some(m) = ctl.recv().await {
                match g3d_hold::link::name(&m) {
                    "shutdown" => {
                        crate::log(&format!(
                            "the holder is ending the namespace: killing {} terminal(s)",
                            srv.reg.len()
                        ));
                        owner::kill_all(&srv.reg).await;
                        end_namespace(&srv, "SIGTERM").await;
                    }
                    "candidate" | "commit" | "upgrade_abort" => {
                        if let Some(tx) = srv.upgrade_tx.lock().unwrap().as_ref() {
                            let _ = tx.send(m);
                        }
                    }
                    other => crate::log(&format!("hold link: unexpected {other:?}")),
                }
            }
        });
    }

    if !idle_exit.is_zero() {
        let srv = srv.clone();
        tokio::spawn(async move {
            let mut idle_since: Option<Instant> = None;
            loop {
                tokio::time::sleep(Duration::from_millis(500).min(idle_exit)).await;
                if srv.reg.len() == 0 && srv.active_conns() == 0 {
                    let since = *idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= idle_exit {
                        end_namespace(
                            &srv,
                            &format!("no terminals and no connections but status followers for {idle_exit:?}"),
                        )
                        .await;
                    }
                } else {
                    idle_since = None;
                }
            }
        });
    }

    loop {
        if !*accepting_rx.borrow_and_update() {
            // An upgrade's cut: new connections wait in the backlog for the next brain.
            let _ = accepting_rx.changed().await;
            continue;
        }
        tokio::select! {
            r = listener.accept() => match r {
                Ok((stream, _)) => {
                    let srv = srv.clone();
                    srv.conns.fetch_add(1, SeqCst);
                    tokio::spawn(async move {
                        conn_task(&srv, stream).await;
                        srv.conns.fetch_sub(1, SeqCst);
                    });
                }
                Err(e) => {
                    crate::log(&format!("accept: {e}"));
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            _ = accepting_rx.changed() => {}
        }
    }
}

struct Conn {
    id: u64,
    out: Arc<ConnOut>,
    hello: bool,
    subs: HashMap<u32, Arc<TermRef>>,
    /// The peer's pid, from its credentials.
    pid: Option<u32>,
    /// Counted in `Server::passive`: it follows status and has done nothing but status and ping.
    passive: bool,
    /// It has asked for something other than status or ping.
    active: bool,
    /// Per terminal, the last paste chunk sent on: answered once its bytes are in the input
    /// buffer. The next chunk waits for it, so at most one chunk per terminal waits in termd.
    pasting: HashMap<u32, oneshot::Receiver<bool>>,
}

enum Flow {
    Continue,
    Close,
}

fn fatal(out: &ConnOut, code: &str, message: impl Into<String>) -> Flow {
    out.frame(frame::encode_json(ty::ERROR, 0, &WireError::new(code, message)));
    out.close_after_drain();
    Flow::Close
}

async fn conn_task(srv: &Arc<Server>, stream: UnixStream) {
    let out = ConnOut::new();
    let pid = match stream.peer_cred() {
        Ok(c) if c.uid() == srv.uid => c.pid().and_then(|p| u32::try_from(p).ok()),
        Ok(c) => {
            crate::log(&format!("refused a connection from uid {}", c.uid()));
            fatal(&out, code::AUTH, "this daemon serves its own user only");
            let (_, wr) = stream.into_split();
            out.run_writer(wr).await;
            return;
        }
        // macOS answers getpeereid with ENOTCONN once the client has closed (a probe that only
        // connects); Linux's SO_PEERCRED still answers. Either way there is no one to serve.
        Err(e) if e.raw_os_error() == Some(libc::ENOTCONN) => return,
        Err(e) => {
            crate::log(&format!("peer credentials: {e}"));
            return;
        }
    };
    let (mut rd, wr) = stream.into_split();
    let writer = {
        let out = out.clone();
        tokio::spawn(async move { out.run_writer(wr).await })
    };
    let mut c = Conn {
        id: srv.next_conn.fetch_add(1, SeqCst),
        out: out.clone(),
        hello: false,
        subs: HashMap::new(),
        pid,
        passive: false,
        active: false,
        pasting: HashMap::new(),
    };
    srv.outs.lock().unwrap().insert(c.id, out.clone());
    let mut dec = FrameDecoder::default();
    let mut buf = vec![0u8; 64 * 1024];
    'conn: loop {
        let n = match rd.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        dec.feed(&buf[..n]);
        loop {
            match dec.next_frame() {
                Ok(None) => break,
                Ok(Some(f)) => {
                    if let Flow::Close = handle_frame(srv, &mut c, f).await {
                        break 'conn;
                    }
                }
                Err(e @ FrameError::TooLarge { .. }) => {
                    fatal(&out, code::TOO_LARGE, e.to_string());
                    break 'conn;
                }
                Err(e) => {
                    fatal(&out, code::BAD_FRAME, e.to_string());
                    break 'conn;
                }
            }
            if out.is_closed() {
                break 'conn;
            }
        }
    }
    srv.outs.lock().unwrap().remove(&c.id);
    srv.hub.conn_closed(c.id);
    if c.passive {
        srv.passive.fetch_sub(1, SeqCst);
    }
    for t in c.subs.values() {
        owner::detach(t, c.id);
    }
    out.close_after_drain();
    let _ = tokio::time::timeout(Duration::from_secs(5), writer).await;
}

async fn handle_frame(srv: &Arc<Server>, c: &mut Conn, f: Frame) -> Flow {
    if !c.hello {
        if f.ty != ty::HELLO {
            return fatal(&c.out, code::BAD_FRAME, format!("frame type {:#04x} before HELLO", f.ty));
        }
        let hello: Hello = match serde_json::from_slice(&f.payload) {
            Ok(h) => h,
            Err(e) => return fatal(&c.out, code::BAD_FRAME, format!("HELLO: {e}")),
        };
        if hello.proto[0] != PROTO[0] {
            return fatal(
                &c.out,
                code::VERSION,
                format!("daemon speaks {}.x; client sent {}.{}", PROTO[0], hello.proto[0], hello.proto[1]),
            );
        }
        c.hello = true;
        srv.hub.conn_open(c.id, &hello.client, c.pid);
        let hw = &srv.hold.welcome;
        let w = Welcome {
            proto: PROTO,
            daemon: crate::VERSION.into(),
            engine: ENGINE.into(),
            ns: srv.reg.cfg.ns.clone(),
            pid: Some(std::process::id()),
            features: DAEMON_FEATURES.iter().map(|s| s.to_string()).collect(),
            max_frame: frame::DEFAULT_MAX_FRAME as u64,
            instance: Some(hw.instance.clone()),
            generation: Some(hw.generation),
            holder: Some(HolderInfo { pid: hw.holder_pid, version: hw.holder_version.clone() }),
        };
        c.out.frame(frame::encode_json(ty::WELCOME, 0, &w));
        return Flow::Continue;
    }
    match f.ty {
        ty::REQUEST => handle_request(srv, c, &f.payload).await,
        ty::INPUT => {
            let err = |code: &str, msg: String| {
                c.out.frame(frame::encode_json(ty::EVENT, f.stream, &Event::Error { code: code.into(), message: msg }));
            };
            match c.subs.get(&f.stream) {
                Some(t) => {
                    let cmd = Cmd { conn: c.id, out: c.out.clone(), req: 0, op: TermOp::Input(f.payload), done: None };
                    if t.send(cmd).is_err() {
                        c.subs.remove(&f.stream);
                        err(code::NO_TERMINAL, format!("handle {} is closed", f.stream));
                    }
                }
                None if srv.reg.by_handle(f.stream).is_some() => {
                    err(code::NOT_SUBSCRIBED, format!("INPUT for handle {} without a subscription", f.stream))
                }
                None => err(code::NO_TERMINAL, format!("no terminal with handle {}", f.stream)),
            }
            Flow::Continue
        }
        ty::HELLO => fatal(&c.out, code::BAD_FRAME, "a second HELLO"),
        other => fatal(&c.out, code::BAD_FRAME, format!("unknown frame type {other:#04x}")),
    }
}

/// Sends `op` to a terminal's owner thread and waits until it has answered.
async fn to_owner(c: &Conn, t: &TermRef, req: u64, op: TermOp) -> bool {
    let (tx, rx) = oneshot::channel();
    let cmd = Cmd { conn: c.id, out: c.out.clone(), req, op, done: Some(tx) };
    if t.send(cmd).is_err() {
        reply_err(&c.out, req, code::NO_TERMINAL, format!("terminal {} is gone", t.id));
        return false;
    }
    match rx.await {
        Ok(ok) => ok,
        Err(_) => {
            reply_err(&c.out, req, code::NO_TERMINAL, format!("terminal {} failed while handling the request", t.id));
            false
        }
    }
}

/// The terminal a handle-addressed op names, if this connection subscribes to it.
fn subscribed<'a>(srv: &Server, c: &'a Conn, req: u64, handle: u32) -> Option<&'a Arc<TermRef>> {
    match c.subs.get(&handle) {
        Some(t) => Some(t),
        None => {
            if srv.reg.by_handle(handle).is_some() {
                reply_err(&c.out, req, code::NOT_SUBSCRIBED, format!("not subscribed to handle {handle}"));
            } else {
                reply_err(&c.out, req, code::NO_TERMINAL, format!("no terminal with handle {handle}"));
            }
            None
        }
    }
}

fn by_id(srv: &Server, c: &Conn, req: u64, id: &str) -> Option<Arc<TermRef>> {
    let t = srv.reg.by_id(id);
    if t.is_none() {
        reply_err(&c.out, req, code::NO_TERMINAL, format!("no terminal {id:?}"));
    }
    t
}

async fn handle_request(srv: &Arc<Server>, c: &mut Conn, payload: &[u8]) -> Flow {
    let v: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v @ serde_json::Value::Object(_)) => v,
        Ok(_) => return fatal(&c.out, code::BAD_FRAME, "REQUEST payload is not a JSON object"),
        Err(e) => return fatal(&c.out, code::BAD_FRAME, format!("REQUEST: {e}")),
    };
    let Some(req) = v.get("req").and_then(|r| r.as_u64()) else {
        return fatal(&c.out, code::BAD_FRAME, "REQUEST without an integer req");
    };
    let Some(op) = v.get("op").and_then(|o| o.as_str()).map(str::to_owned) else {
        reply_err(&c.out, req, code::BAD_REQUEST, "REQUEST without an op");
        return Flow::Continue;
    };
    if !KNOWN_OPS.contains(&op.as_str()) {
        reply_err(&c.out, req, code::UNKNOWN_OP, format!("unknown op {op:?}"));
        return Flow::Continue;
    }
    let r: Request = match serde_json::from_value(v) {
        Ok(r) => r,
        Err(e) => {
            reply_err(&c.out, req, code::BAD_REQUEST, format!("{op}: {e}"));
            return Flow::Continue;
        }
    };
    if !matches!(r.op, Op::Ping | Op::Status | Op::StatusFollow(_) | Op::StatusUnfollow) && !c.active {
        c.active = true;
        if c.passive {
            c.passive = false;
            srv.passive.fetch_sub(1, SeqCst);
        }
    }
    match r.op {
        Op::Ping => reply_ok(&c.out, req, &Empty {}),
        Op::Status => reply_ok(&c.out, req, &StatusReply { status: srv.status_doc() }),
        Op::StatusFollow(f) => {
            let interval = srv.hub.clamp(f.interval_ms);
            reply_ok(&c.out, req, &StatusFollowReply { interval_ms: interval.as_millis() as u64 });
            srv.hub.follow(c.id, c.out.clone(), interval);
            if !c.active && !c.passive {
                c.passive = true;
                srv.passive.fetch_add(1, SeqCst);
            }
        }
        Op::StatusUnfollow => {
            srv.hub.unfollow(c.id);
            if c.passive {
                c.passive = false;
                srv.passive.fetch_sub(1, SeqCst);
            }
            reply_ok(&c.out, req, &Empty {});
        }
        Op::List => {
            let terminals = srv.reg.all().iter().map(|t| t.info.lock().unwrap().clone()).collect();
            reply_ok(&c.out, req, &ListReply { terminals });
        }
        Op::Create(cr) => {
            let adopt = cr.if_exists == Some(IfExists::Adopt);
            let spec = match CreateSpec::from_request(cr, &srv.reg.cfg) {
                Ok(s) => s,
                Err(e) => {
                    reply_err(&c.out, req, &e.code, e.message);
                    return Flow::Continue;
                }
            };
            let _g = srv.create_lock.lock().await;
            if srv.reg.upgrading.load(SeqCst) {
                reply_err(&c.out, req, code::BUSY, "termd is upgrading; create after it");
                return Flow::Continue;
            }
            if let Some(t) = srv.reg.by_id(&spec.id) {
                if adopt {
                    let i = t.info.lock().unwrap().clone();
                    reply_ok(
                        &c.out,
                        req,
                        &CreateReply {
                            id: i.id,
                            handle: i.handle,
                            pid: i.pid,
                            created: false,
                            cols: i.cols,
                            rows: i.rows,
                            argv: i.argv,
                            login: t.login,
                            cwd: i.cwd,
                        },
                    );
                } else {
                    reply_err(&c.out, req, code::EXISTS, format!("terminal {:?} exists", spec.id));
                }
                return Flow::Continue;
            }
            let (id, cols, rows) = (spec.id.clone(), spec.cols, spec.rows);
            match owner::create(&srv.reg, spec).await {
                Ok((t, pid)) => {
                    let i = t.info.lock().unwrap().clone();
                    reply_ok(
                        &c.out,
                        req,
                        &CreateReply {
                            id,
                            handle: t.handle,
                            pid,
                            created: true,
                            cols,
                            rows,
                            argv: i.argv,
                            login: t.login,
                            cwd: i.cwd,
                        },
                    )
                }
                Err(e) => {
                    crate::log(&format!("create {id}: {e}"));
                    srv.hub.errors.record(&e.code, Some(&id), e.message.clone());
                    reply_err(&c.out, req, &e.code, e.message);
                }
            }
        }
        Op::Kill(k) => {
            let signal = match k.signal.as_deref() {
                None | Some("HUP") => Signal::HUP,
                Some("TERM") => Signal::TERM,
                Some("KILL") => Signal::KILL,
                Some(s) => {
                    reply_err(&c.out, req, code::BAD_REQUEST, format!("signal {s:?} is not HUP, TERM or KILL"));
                    return Flow::Continue;
                }
            };
            if let Some(t) = by_id(srv, c, req, &k.id) {
                to_owner(c, &t, req, TermOp::Kill { signal, reply: true }).await;
                c.subs.remove(&t.handle);
            }
        }
        Op::Subscribe(s) => {
            if let Some(t) = by_id(srv, c, req, &s.id) {
                if c.subs.contains_key(&t.handle) {
                    reply_err(&c.out, req, code::ALREADY_SUBSCRIBED, format!("already subscribed to {}", t.id));
                } else if to_owner(c, &t, req, TermOp::Subscribe(s)).await {
                    c.subs.insert(t.handle, t);
                }
            }
        }
        Op::Unsubscribe(h) => {
            if let Some(t) = subscribed(srv, c, req, h.handle).cloned() {
                to_owner(c, &t, req, TermOp::Unsubscribe).await;
                c.subs.remove(&h.handle);
            }
        }
        Op::Take(tk) => {
            if let Some(t) = subscribed(srv, c, req, tk.handle).cloned() {
                to_owner(c, &t, req, TermOp::Take { cols: tk.cols, rows: tk.rows }).await;
            }
        }
        Op::Resize(rz) => {
            if let Some(t) = subscribed(srv, c, req, rz.handle).cloned() {
                to_owner(c, &t, req, TermOp::Resize { cols: rz.cols, rows: rz.rows }).await;
            }
        }
        Op::Repaint(rp) => {
            if let Some(t) = subscribed(srv, c, req, rp.handle).cloned() {
                to_owner(c, &t, req, TermOp::Repaint { history_rows: rp.history_rows.unwrap_or(0) }).await;
            }
        }
        Op::View(vw) => {
            if vw.delta.is_none() && vw.live != Some(true) {
                reply_err(&c.out, req, code::BAD_REQUEST, "view needs delta or live: true");
                return Flow::Continue;
            }
            if let Some(t) = subscribed(srv, c, req, vw.handle).cloned() {
                to_owner(c, &t, req, TermOp::View { delta: vw.delta, live: vw.live == Some(true) }).await;
            }
        }
        Op::Env(q) => {
            if let Some(t) = by_id(srv, c, req, &q.id) {
                reply_ok(&c.out, req, &EnvReply { id: t.id.clone(), env: t.env.clone() });
            }
        }
        Op::Key(k) => {
            if let Some(t) = subscribed(srv, c, req, k.handle).cloned() {
                match crate::keys::spec(&k) {
                    Ok(spec) => {
                        to_owner(c, &t, req, TermOp::Key(Box::new(spec))).await;
                    }
                    Err((code, message)) => reply_err(&c.out, req, code, message),
                }
            }
        }
        Op::Mouse(m) => {
            if let Some(t) = subscribed(srv, c, req, m.handle).cloned() {
                match crate::mouse::spec(&m) {
                    Ok(spec) => {
                        to_owner(c, &t, req, TermOp::Mouse(Box::new(spec))).await;
                    }
                    Err((code, message)) => reply_err(&c.out, req, code, message),
                }
            }
        }
        Op::Paste(p) => {
            if let Some(t) = subscribed(srv, c, req, p.handle).cloned() {
                // A chunk's reply comes once its bytes are in the input buffer (the program reads
                // them): that is a paste's flow control. Other requests go on meanwhile; a client
                // that sends the next chunk before that reply waits here, its socket backing up.
                if let Some(prev) = c.pasting.remove(&p.handle) {
                    let _ = prev.await;
                }
                let op = TermOp::Paste {
                    text: p.text,
                    allow_unsafe: p.allow_unsafe == Some(true),
                    more: p.more == Some(true),
                };
                let (tx, rx) = oneshot::channel();
                if t.send(Cmd { conn: c.id, out: c.out.clone(), req, op, done: Some(tx) }).is_err() {
                    reply_err(&c.out, req, code::NO_TERMINAL, format!("terminal {} is gone", t.id));
                } else {
                    c.pasting.insert(p.handle, rx);
                }
            }
        }
        Op::Capture(cp) => {
            if let Some(t) = by_id(srv, c, req, &cp.id) {
                to_owner(c, &t, req, TermOp::Capture(cp)).await;
            }
        }
        Op::Stop => {
            crate::log(&format!("stop requested: killing {} terminal(s)", srv.reg.len()));
            let _ = srv.accepting.send(false);
            owner::kill_all(&srv.reg).await;
            reply_ok(&c.out, req, &Empty {});
            c.out.close_after_drain();
            let srv = srv.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                end_namespace(&srv, "stop").await;
            });
            return Flow::Close;
        }
        Op::Upgrade(u) => {
            if u.holder == Some(true) {
                reply_err(
                    &c.out,
                    req,
                    code::UNSUPPORTED,
                    "replacing the holder (g3d upgrade --holder) is not built yet",
                );
                return Flow::Continue;
            }
            if let Some(b) = &u.binary {
                use std::os::unix::fs::PermissionsExt;
                let ok = std::fs::metadata(b).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
                if !ok {
                    reply_err(&c.out, req, code::BAD_REQUEST, format!("{b:?} is not an executable file"));
                    return Flow::Continue;
                }
            }
            let _g = srv.create_lock.lock().await;
            if srv.reg.upgrading.swap(true, SeqCst) {
                reply_err(&c.out, req, code::BUSY, "an upgrade is running");
                return Flow::Continue;
            }
            reply_ok(&c.out, req, &UpgradeReply { generation: srv.hold.welcome.generation });
            let (srv, out) = (srv.clone(), c.out.clone());
            tokio::spawn(async move { upgrade(srv, u.binary, out).await });
        }
    }
    Flow::Continue
}

/// Sends every terminal's owner thread one op and waits for each answer.
async fn to_all(reg: &Registry, op: impl Fn() -> TermOp) -> Vec<(String, bool)> {
    let mut waits = Vec::new();
    for t in reg.all() {
        let (tx, rx) = oneshot::channel();
        let cmd = Cmd { conn: 0, out: ConnOut::new(), req: 0, op: op(), done: Some(tx) };
        if t.send(cmd).is_ok() {
            waits.push((t.id.clone(), rx));
        }
    }
    let mut out = Vec::new();
    for (id, rx) in waits {
        out.push((id, rx.await.unwrap_or(false)));
    }
    out
}

/// `upgrade` (DESIGN.md, "Screens after an upgrade"): the holder starts the candidate; this brain
/// stops accepting, cuts every terminal between reads into a handoff blob, and waits. On
/// `commit` it closes every connection with `ERROR restart` and exits; the candidate continues
/// each terminal at exactly its cut. On failure everything resumes and the asker hears why.
async fn upgrade(srv: Arc<Server>, binary: Option<String>, asker: Arc<ConnOut>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    *srv.upgrade_tx.lock().unwrap() = Some(tx);
    let mut msg = json!({"m": "upgrade"});
    if let Some(b) = &binary {
        msg["binary"] = json!(b);
    }
    crate::log(&format!("upgrade requested ({})", binary.as_deref().unwrap_or("the holder's binary")));
    srv.hold.send(&msg, &[]);
    let wait = srv.upgrade_deadline + Duration::from_secs(5);
    let Some(m) = next(&mut rx, wait).await else {
        srv.hold.send(&json!({"m": "upgrade_cancel", "why": "no candidate in time"}), &[]);
        return upgrade_failed(&srv, &asker, "the holder started no candidate in time".into()).await;
    };
    if g3d_hold::link::name(&m) != "candidate" {
        let why = m.get("why").and_then(Value::as_str).unwrap_or("?").to_owned();
        return upgrade_failed(&srv, &asker, why).await;
    }
    let engine = m.get("engine").and_then(Value::as_str).unwrap_or("").to_owned();
    let same = engine == srv.reg.cfg.engine;
    crate::log(&format!(
        "upgrade: candidate pid {} ({engine}); handing over {} terminal(s) as {}",
        m.get("pid").and_then(Value::as_u64).unwrap_or(0),
        srv.reg.len(),
        if same { "snapshots" } else { "VT repaints (another engine)" }
    ));
    let _ = srv.accepting.send(false);
    let cut = to_all(&srv.reg, || TermOp::Cut { snapshot: same }).await;
    let bad: Vec<String> = cut.into_iter().filter(|(_, ok)| !ok).map(|(id, _)| id).collect();
    if !bad.is_empty() {
        let why = format!("could not hand over {}", bad.join(", "));
        srv.hold.send(&json!({"m": "upgrade_cancel", "why": why}), &[]);
        return upgrade_failed(&srv, &asker, why).await;
    }
    srv.hold.send(&json!({"m": "handoff_done"}), &[]);
    let Some(m) = next(&mut rx, wait).await else {
        srv.hold.send(&json!({"m": "upgrade_cancel", "why": "no commit in time"}), &[]);
        return upgrade_failed(&srv, &asker, "the candidate was not ready in time".into()).await;
    };
    if g3d_hold::link::name(&m) != "commit" {
        let why = m.get("why").and_then(Value::as_str).unwrap_or("?").to_owned();
        return upgrade_failed(&srv, &asker, why).await;
    }
    let outs: Vec<Arc<ConnOut>> = srv.outs.lock().unwrap().values().cloned().collect();
    crate::log(&format!("upgrade: handed over; closing {} connection(s) with ERROR restart", outs.len()));
    for o in &outs {
        o.frame(frame::encode_json(
            ty::ERROR,
            0,
            &WireError::new(code::RESTART, "termd's engine is being replaced; reconnect now"),
        ));
        o.close_after_drain();
    }
    let until = Instant::now() + Duration::from_secs(1);
    while srv.conns.load(SeqCst) > 0 && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    std::process::exit(0);
}

async fn next(rx: &mut mpsc::UnboundedReceiver<Value>, wait: Duration) -> Option<Value> {
    tokio::time::timeout(wait, rx.recv()).await.ok().flatten()
}

/// The upgrade didn't happen: every terminal reads again, connections are accepted again, and
/// the asker hears why on stream 0.
async fn upgrade_failed(srv: &Arc<Server>, asker: &Arc<ConnOut>, why: String) {
    *srv.upgrade_tx.lock().unwrap() = None;
    to_all(&srv.reg, || TermOp::Resume).await;
    let _ = srv.accepting.send(true);
    srv.reg.upgrading.store(false, SeqCst);
    crate::log(&format!("upgrade failed: {why}; carrying on"));
    srv.hub.errors.record(
        "upgrade_failed",
        None,
        format!("an upgrade did not happen: {why}; the running engine carries on"),
    );
    asker.frame(frame::encode_json(ty::EVENT, 0, &Event::UpgradeFailed { message: why }));
}
