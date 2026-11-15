//! The holder's loop (DESIGN.md, "Holder and brain"). Everything here runs on one thread.
//!
//! Responsibilities, and nothing else:
//! 1. the namespace: the lock (`<socket>.lock`, holding the holder's pid), the listening socket,
//!    an hourly re-stamp of both, daemonizing;
//! 2. the shells: spawn on a PTY when the brain asks, reap, keep each master fd and exit status
//!    until the brain releases the terminal, signal on `kill` (`SIGKILL` after the grace);
//! 3. the store: each terminal's newest two snapshots and the `seq_marks` page, handed to every
//!    brain that starts;
//! 4. the brain: start it, restart it after a crash (systemd's rate limit), mark it failed and
//!    answer connections with `ERROR brain_failed` while it is, its watchdog, and the upgrade
//!    handshake between a running brain and a candidate;
//! 5. the end: `SIGTERM`, a brain's `exit_namespace`, or idle while no brain runs.

use crate::link::{self, Fill, Reader};
use crate::log::log;
use crate::record::{self, Record};
use crate::tree::{Proc, Tree, Trees};
use crate::{HOLD, MARK_BYTES, shm, spawn};
use rustix::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::ffi::{CString, OsString};
use std::io::{Read, Seek, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Everything the holder is told at start. Each value is a `g3d-termd` flag (DESIGN.md,
/// "Defaults" gives the reasons).
pub struct Config {
    pub ns: Option<String>,
    pub socket: PathBuf,
    pub log: PathBuf,
    pub daemon: bool,
    /// The holder's own version, as `WELCOME` reports it (`g3d-termd/x.y.z`).
    pub version: String,
    /// Arguments every brain gets after `--brain --hold-fd N`.
    pub brain_args: Vec<OsString>,
    /// With no brain running and no terminals, exit after this long (0 = never). A running
    /// brain applies the same setting itself.
    pub idle_exit: Duration,
    pub restart_delay: Duration,
    pub start_burst: usize,
    pub start_interval: Duration,
    pub failed_backoff: Duration,
    pub failed_backoff_max: Duration,
    /// While the brain is failed, a refused connection stays open this long after its `ERROR`,
    /// its input read and discarded (a lingering close), so the client's `HELLO` write succeeds
    /// and its read finds the `ERROR` instead of `EPIPE`.
    pub refused_linger: Duration,
    /// At most this many refused connections linger; past it the oldest is closed.
    pub refused_max: usize,
    /// Zero turns the watchdog off.
    pub watchdog: Duration,
    pub upgrade_deadline: Duration,
    /// The close rule (DESIGN.md, "Process trees"): the asked signal (`SIGHUP`) to the whole tree
    /// at once, `SIGTERM` to what is left after `kill_term_after`, `SIGKILL` after `kill_grace`.
    pub kill_term_after: Duration,
    pub kill_grace: Duration,
    /// The systemd user service this holder runs as (`g3d-termd --daemon` asks for one with
    /// `Delegate=yes`): its cgroup is this namespace's process trees.
    pub unit: Option<String>,
    pub max_terminals: usize,
    /// Rotate the namespace's log past this many bytes (0 = never).
    pub log_max_bytes: u64,
}

fn die(msg: &str) -> ! {
    // Not eprintln!: it panics on an unwritable stderr, and the exit below must happen.
    let _ = std::io::Write::write_all(&mut std::io::stderr(), format!("g3d-termd: {msg}\n").as_bytes());
    std::process::exit(1);
}

fn ms_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ── setup ───────────────────────────────────────────────────────────────────────────────────

fn ensure_private_dir(dir: &Path) {
    use std::os::unix::fs::DirBuilderExt;
    if !dir.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .unwrap_or_else(|e| die(&format!("create {}: {e}", dir.display())));
    }
}

/// The socket's directory must be ours and closed to writers but us: under the shared `/tmp`
/// another user could have made it first, and a writer could swap the socket (tmux checks the
/// same of `/tmp/tmux-<uid>`).
fn check_socket_dir(dir: &Path) {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(dir).unwrap_or_else(|e| die(&format!("stat {}: {e}", dir.display())));
    let uid = rustix::process::getuid().as_raw();
    if !m.is_dir() || m.uid() != uid || m.mode() & 0o022 != 0 {
        die(&format!(
            "{} must be a directory owned by uid {uid} that only it can write (it is owned by uid {}, mode {:o})",
            dir.display(),
            m.uid(),
            m.mode() & 0o7777
        ));
    }
}

fn take_lock(socket: &Path) -> std::fs::File {
    use rustix::fs::{FlockOperation, Mode, OFlags};
    let path = PathBuf::from(format!("{}.lock", socket.display()));
    let fd: OwnedFd =
        rustix::fs::open(&path, OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC, Mode::from_raw_mode(0o600))
            .unwrap_or_else(|e| die(&format!("open {}: {e}", path.display())));
    let mut f = std::fs::File::from(fd);
    if let Err(e) = rustix::fs::flock(&f, FlockOperation::NonBlockingLockExclusive) {
        let mut s = String::new();
        let _ = f.read_to_string(&mut s);
        let holder = s.trim();
        die(&format!(
            "another g3d-termd{} serves {} ({e})",
            if holder.is_empty() { String::new() } else { format!(" (pid {holder})") },
            socket.display()
        ));
    }
    f
}

/// Double-forks into the background (DESIGN.md, "Who starts it"). Runs before anything else.
fn daemonize(log_path: &Path, keep: &[i32]) {
    use std::os::unix::fs::PermissionsExt;
    // SAFETY: called before any other thread exists, so fork is safe; the intermediate
    // processes only make plain syscalls.
    unsafe {
        match libc::fork() {
            -1 => die(&format!("fork: {}", std::io::Error::last_os_error())),
            0 => {}
            child => {
                let mut status = 0;
                libc::waitpid(child, &mut status, 0);
                std::process::exit(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 1 });
            }
        }
        if libc::setsid() == -1 {
            die(&format!("setsid: {}", std::io::Error::last_os_error()));
        }
        match libc::fork() {
            -1 => die(&format!("fork: {}", std::io::Error::last_os_error())),
            0 => {}
            _ => libc::_exit(0),
        }
        libc::umask(0o077);
        let _ = std::env::set_current_dir("/");
        let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
        if let Some(dir) = log_path.parent() {
            ensure_private_dir(dir);
        }
        let log = std::fs::OpenOptions::new().create(true).append(true).open(log_path);
        if let Ok(f) = &log {
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        libc::dup2(null, 0);
        match &log {
            Ok(f) => {
                libc::dup2(f.as_raw_fd(), 1);
                libc::dup2(f.as_raw_fd(), 2);
            }
            Err(_) => {
                libc::dup2(null, 1);
                libc::dup2(null, 2);
            }
        }
        drop(log);
        for fd in 3..1024 {
            if !keep.contains(&fd) {
                libc::close(fd);
            }
        }
    }
}

// ── signals: a self-pipe ────────────────────────────────────────────────────────────────────

static mut SIG_WR: i32 = -1;

extern "C" fn on_signal(sig: libc::c_int) {
    // SAFETY: write(2) is async-signal-safe; SIG_WR is set once before handlers are installed.
    unsafe {
        let b = sig as u8;
        libc::write(SIG_WR, (&raw const b).cast(), 1);
    }
}

fn install_signals() -> OwnedFd {
    let (rd, wr) = crate::pipe(true).unwrap_or_else(|e| die(&format!("signal pipe: {e}")));
    // SAFETY: SIG_WR is written before any handler that reads it is installed; the handlers
    // only write one byte to it. Leaked on purpose: it lives as long as the process.
    unsafe {
        SIG_WR = wr.as_raw_fd();
        std::mem::forget(wr);
        for sig in [libc::SIGCHLD, libc::SIGHUP, libc::SIGTERM] {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_signal as *const () as usize;
            sa.sa_flags = libc::SA_RESTART | libc::SA_NOCLDSTOP;
            libc::sigemptyset(&mut sa.sa_mask);
            libc::sigaction(sig, &sa, std::ptr::null_mut());
        }
        for sig in [libc::SIGINT, libc::SIGQUIT, libc::SIGTSTP, libc::SIGPIPE] {
            libc::signal(sig, libc::SIG_IGN);
        }
    }
    rd
}

/// Raises the soft fd limit to the hard one and returns the original, which children get back.
fn raise_nofile() -> libc::rlim_t {
    // SAFETY: getrlimit/setrlimit on a struct we own.
    unsafe {
        let mut rl: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) != 0 {
            return 1024;
        }
        let orig = rl.rlim_cur;
        rl.rlim_cur = rl.rlim_max;
        libc::setrlimit(libc::RLIMIT_NOFILE, &rl);
        orig
    }
}

fn random_hex() -> String {
    let mut b = [0u8; 8];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn describe_status(status: i32) -> (Value, String) {
    if libc::WIFSIGNALED(status) {
        let s = libc::WTERMSIG(status);
        (json!({ "signal": s }), format!("signal {s}"))
    } else {
        let c = libc::WEXITSTATUS(status);
        (json!({ "code": c }), format!("exit code {c}"))
    }
}

// ── state ───────────────────────────────────────────────────────────────────────────────────

struct Term {
    handle: u32,
    slot: u32,
    id: String,
    pid: i32,
    /// The holder's copy; closed by `kill` (so the brain's close hangs the PTY up).
    master: Option<OwnedFd>,
    meta: Value,
    exit: Option<Value>,
    /// Its processes: a cgroup leaf or its session (tree.rs).
    tree: Tree,
    /// `kill` asked: the close rule runs on its tree (`Holder::closing`).
    killed: bool,
    /// Newest first, at most two.
    snaps: VecDeque<OwnedFd>,
    /// The brain released it; it goes once its program has been reaped.
    released: bool,
    /// The current brain (or the candidate) knows this terminal.
    known: bool,
}

/// A brain process (the running brain, or an upgrade's candidate) and its link.
struct Peer {
    pid: i32,
    /// Its cgroup leaf, removed once it has been reaped.
    leaf: Option<String>,
    sock: OwnedFd,
    rd: Reader,
    out: VecDeque<(Vec<u8>, Vec<OwnedFd>, usize)>,
    eof: bool,
    hello: bool,
    engine: String,
    last_alive: Instant,
    /// The watchdog sent `SIGABRT` at this time.
    aborted: Option<Instant>,
}

impl Peer {
    fn queue(&mut self, msg: Value, fds: Vec<OwnedFd>) {
        let bytes = link::encode(&msg, fds.len());
        self.out.push_back((bytes, fds, 0));
        self.flush();
    }

    fn flush(&mut self) {
        while let Some((bytes, fds, off)) = self.out.front_mut() {
            let sent = if *off == 0 {
                link::send_some(self.sock.as_fd(), bytes, &link::borrow(fds))
            } else {
                link::send_some(self.sock.as_fd(), &bytes[*off..], &[])
            };
            match sent {
                Ok(n) => {
                    *off += n;
                    fds.clear(); // sent with the first byte
                    if *off == bytes.len() {
                        self.out.pop_front();
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(_) => {
                    self.out.clear();
                    self.eof = true;
                    return;
                }
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Who {
    Brain,
    Candidate,
}

#[derive(PartialEq, Eq)]
enum Stage {
    /// (`--holder`) The new binary is reading a trial record of this holder (`--check-holder-
    /// record`); the brain waits for `candidate`.
    HolderTrial,
    /// The candidate is starting; the brain waits for `candidate`.
    Starting,
    /// The brain is handing off (it was told `candidate`).
    Cutting,
    /// The candidate has the terminals and is validating them.
    Validating,
    /// The candidate said `ready`; the brain was told `commit` and is exiting.
    Committing,
}

struct Upgrade {
    deadline: Instant,
    stage: Stage,
    /// `g3d upgrade --holder`: the binary this holder re-execs into. No candidate brain: the new
    /// holder starts its own brain from the handoff.
    holder: Option<PathBuf>,
}

/// A `--check-holder-record` run of a holder upgrade's binary: its pid, its answer (stdout and
/// stderr) as it arrives, and its end.
struct Check {
    pid: i32,
    out: OwnedFd,
    buf: Vec<u8>,
    eof: bool,
    status: Option<i32>,
    /// The final record (after the handoff), whose check commits; else the trial.
    last: bool,
}

#[derive(Clone, Copy, Default)]
struct Restarts {
    crash: u64,
    watchdog: u64,
    upgrade: u64,
}

impl Restarts {
    fn json(self) -> Value {
        json!({"crash": self.crash, "watchdog": self.watchdog, "upgrade": self.upgrade})
    }
}

/// A terminal's tree being ended by the close rule: the asked signal, then `SIGTERM`, then
/// `SIGKILL`, until nothing of it is left.
struct Closing {
    handle: u32,
    id: String,
    tree: Tree,
    at: Instant,
    /// 0: the asked signal sent; 1: `SIGTERM`; 2: `SIGKILL`.
    stage: u8,
    /// Each step: the signal and who got it.
    steps: Vec<(&'static str, Vec<Proc>)>,
}

/// Processes left in a terminal's tree after its program exited on its own (a `nohup` job): kept
/// running, as a terminal leaves them, reported, and ended with the namespace.
struct Leftover {
    handle: u32,
    id: String,
    pid: i32,
    tree: Tree,
    since: u64,
}

fn sig_name(sig: i32) -> &'static str {
    match sig {
        libc::SIGHUP => "HUP",
        libc::SIGTERM => "TERM",
        libc::SIGKILL => "KILL",
        libc::SIGINT => "INT",
        libc::SIGQUIT => "QUIT",
        _ => "?",
    }
}

fn procs_text(p: &[Proc]) -> String {
    p.iter().map(|p| format!("{} {}", p.pid, p.comm)).collect::<Vec<_>>().join(", ")
}

struct Holder {
    cfg: Config,
    /// How this namespace knows each terminal's processes (tree.rs).
    trees: Trees,
    /// inotify on every leaf's `cgroup.events` (cgroup mode): a leaf emptying is an event.
    inotify: Option<OwnedFd>,
    closing: Vec<Closing>,
    leftovers: Vec<Leftover>,
    /// The namespace is ending (why, and the latest it waits for its trees): it exits once every
    /// tree is gone.
    ending: Option<(String, Instant)>,
    /// Brains started, for their leaves' names.
    brain_leaves: u64,
    /// The holder upgrade's record check, while it runs.
    check: Option<Check>,
    /// Times this namespace's holder has re-exec'd (`g3d upgrade --holder`).
    upgrades: u64,
    /// A holder upgrade that failed after the old brain handed over (its exec): the next brain's
    /// welcome says why, so the asker hears it.
    upgrade_failed: Option<String>,
    exe: PathBuf,
    listener: OwnedFd,
    /// The namespace's lock, held until the namespace leaves ([`Holder::leave_path`]).
    lock: Option<std::fs::File>,
    marks: OwnedFd,
    sig: OwnedFd,
    nofile: libc::rlim_t,
    instance: String,
    started_at: u64,
    terms: BTreeMap<u32, Term>,
    next_handle: u32,
    free_slots: Vec<u32>,
    brain: Option<Peer>,
    candidate: Option<Peer>,
    upgrade: Option<Upgrade>,
    /// Brains started (1 for the first); the running brain's generation.
    generation: u64,
    /// Brains replaced, by cause: crashed (exited without a handoff), killed by the watchdog, or
    /// handed over by an upgrade. The status document's `brain.restarts`.
    restarts: Restarts,
    /// Why the next brain starts, and how the last one ended: its welcome's `last_start`.
    next_start: Value,
    starts: VecDeque<Instant>,
    restart_at: Option<Instant>,
    /// The brain is failed: why, and when the next try is.
    failed: Option<(String, Instant)>,
    /// When the brain was last marked failed (epoch ms), until a brain is welcomed: the next
    /// brain's `last_start.failed_at`, so the episode is on record once it is over.
    failed_since: Option<u64>,
    /// Connections answered with `ERROR brain_failed`, lingering until the client closes or the
    /// deadline (`refused_linger`).
    refused: VecDeque<(OwnedFd, Instant)>,
    backoff: Duration,
    last_exit: String,
    /// The brain asked to end the namespace (idle exit, `stop`).
    exiting: Option<String>,
    /// The candidate died after the running brain committed its handoff: how it ended (its text
    /// and wait status). The brain exits having handed over, and the next brain starts from the
    /// handoff as after a crash.
    candidate_lost: Option<(String, i32)>,
    /// SIGTERM: the brain was asked to shut down; past this, the holder does it itself.
    shutdown_at: Option<Instant>,
    /// When the namespace last had no brain and no terminals.
    idle_since: Option<Instant>,
    restamped: Instant,
}

/// Starts the holder: takes the namespace, starts the first brain, runs until the namespace ends.
pub fn run(cfg: Config) -> ! {
    crate::log::set_role("holder");
    // A holder that unwinds would take every shell down half-way through something; abort is
    // the honest end, after the panic is logged.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        log(&format!("holder panicked: {info}; aborting"));
        std::process::abort();
    }));

    if let Some(dir) = cfg.socket.parent() {
        ensure_private_dir(dir);
        check_socket_dir(dir);
    }
    if cfg.socket.as_os_str().len() > 100 {
        die(&format!("socket path {} is too long for a Unix socket", cfg.socket.display()));
    }
    let exe = std::env::current_exe().unwrap_or_else(|e| die(&format!("own executable: {e}")));
    let mut lock = take_lock(&cfg.socket);
    // We hold the lock, so a socket file left here is stale.
    let _ = std::fs::remove_file(&cfg.socket);
    let listener = std::os::unix::net::UnixListener::bind(&cfg.socket)
        .unwrap_or_else(|e| die(&format!("bind {}: {e}", cfg.socket.display())));
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&cfg.socket, std::fs::Permissions::from_mode(0o600));
    }
    let listener: OwnedFd = listener.into();
    rustix::fs::fcntl_setfl(&listener, rustix::fs::OFlags::NONBLOCK).unwrap_or_else(|e| die(&format!("listener: {e}")));
    if cfg.daemon {
        daemonize(&cfg.log, &[listener.as_raw_fd(), lock.as_raw_fd()]);
    } else if cfg.unit.is_some() {
        // A systemd user service: the manager made it a daemon (its own session, no terminal, the
        // log on stdout and stderr); what it doesn't set, the holder does.
        // SAFETY: plain umask(2).
        unsafe { libc::umask(0o077) };
        let _ = std::env::set_current_dir("/");
    }
    crate::log::set_file(&cfg.log, cfg.log_max_bytes);
    let _ = lock.set_len(0);
    let _ = lock.rewind();
    let _ = writeln!(lock, "{}", std::process::id());
    let nofile = raise_nofile();
    let sig = install_signals();
    let marks = shm::create("g3d-termd seq_marks", cfg.max_terminals * MARK_BYTES)
        .unwrap_or_else(|e| die(&format!("seq_marks: {e}")));
    #[cfg(target_os = "linux")]
    // SAFETY: PR_SET_NAME with a NUL-terminated name of at most 16 bytes.
    unsafe {
        libc::prctl(libc::PR_SET_NAME, c"g3d-termd".as_ptr());
    }
    let serving = cfg.ns.as_ref().map_or_else(|| "its own socket".to_owned(), |n| format!("namespace {n:?}"));
    log(&format!("{} holder serving {serving} at {}", cfg.version, cfg.socket.display()));
    let (trees, inotify) = process_trees(cfg.unit.as_deref());
    #[cfg(target_os = "linux")]
    // SAFETY: PR_SET_CHILD_SUBREAPER on this process: a terminal's orphans are reparented to the
    // holder, which reaps them and hears each one end (a session tree's end is an event).
    unsafe {
        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1);
    }
    let max = cfg.max_terminals as u32;
    let mut h = Holder {
        trees,
        inotify,
        closing: Vec::new(),
        leftovers: Vec::new(),
        ending: None,
        brain_leaves: 0,
        check: None,
        upgrades: 0,
        upgrade_failed: None,
        exe,
        listener,
        lock: Some(lock),
        marks,
        sig,
        nofile,
        instance: random_hex(),
        started_at: ms_now(),
        terms: BTreeMap::new(),
        next_handle: 1,
        free_slots: (0..max).rev().collect(),
        brain: None,
        candidate: None,
        upgrade: None,
        generation: 0,
        restarts: Restarts::default(),
        next_start: json!({"reason": "first"}),
        starts: VecDeque::new(),
        restart_at: Some(Instant::now()),
        failed: None,
        failed_since: None,
        refused: VecDeque::new(),
        backoff: cfg.failed_backoff,
        last_exit: String::new(),
        exiting: None,
        candidate_lost: None,
        shutdown_at: None,
        idle_since: None,
        restamped: Instant::now(),
        cfg,
    };
    h.run()
}

/// Resumes a holder that re-exec'd into this binary (`g3d upgrade --holder`): the same process,
/// its shells still its children, every fd the record names still open. It takes the record's
/// state, reaps what ended during the exec, and starts a brain of its own binary, which restores
/// every terminal from the handoff.
pub fn resume(cfg: Config, fd: i32) -> ! {
    use rustix::fd::FromRawFd;
    crate::log::set_role("holder");
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        log(&format!("holder panicked: {info}; aborting"));
        std::process::abort();
    }));
    crate::log::set_file(&cfg.log, cfg.log_max_bytes);
    // SAFETY: the fd the previous image passed on its command line; nothing else owns it.
    let rfd = unsafe { OwnedFd::from_raw_fd(fd) };
    let rec = shm::read(&rfd)
        .map_err(|e| e.to_string())
        .and_then(|b| record::decode(&b))
        .unwrap_or_else(|e| die(&format!("--holder-resume: {e}")));
    drop(rfd);
    // SAFETY (each): an fd number the record names, open across the exec; owned from here.
    let own = |fd: i32| {
        let f = unsafe { OwnedFd::from_raw_fd(fd) };
        let _ = rustix::io::fcntl_setfd(&f, rustix::io::FdFlags::CLOEXEC);
        f
    };
    let listener = own(rec.listener);
    let lock = (rec.lock >= 0).then(|| std::fs::File::from(own(rec.lock)));
    let marks = own(rec.marks);
    let exe = std::env::current_exe().unwrap_or_else(|e| die(&format!("own executable: {e}")));
    let _ = raise_nofile();
    let sig = install_signals();
    #[cfg(target_os = "linux")]
    // SAFETY: as in run().
    unsafe {
        libc::prctl(libc::PR_SET_NAME, c"g3d-termd".as_ptr());
        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1);
    }
    let trees = Trees::from_json(&rec.trees).unwrap_or_else(|| die("--holder-resume: the record's process trees"));
    #[cfg(target_os = "linux")]
    let inotify = trees
        .is_cgroup()
        .then(|| {
            rustix::fs::inotify::init(
                rustix::fs::inotify::CreateFlags::CLOEXEC | rustix::fs::inotify::CreateFlags::NONBLOCK,
            )
            .ok()
        })
        .flatten();
    #[cfg(not(target_os = "linux"))]
    let inotify = None;
    let tree = |v: &Value| Tree::from_json(v).unwrap_or_else(|| die("--holder-resume: a terminal's tree"));
    let mut terms = BTreeMap::new();
    for t in &rec.terms {
        terms.insert(
            t.handle,
            Term {
                handle: t.handle,
                slot: t.slot,
                id: t.id.clone(),
                pid: t.pid,
                master: t.master.map(own),
                meta: t.meta.clone(),
                exit: t.exit.clone(),
                tree: tree(&t.tree),
                killed: t.killed,
                snaps: t.snaps.iter().map(|&s| own(s)).collect(),
                released: t.released,
                known: false,
            },
        );
    }
    let used: Vec<u32> = terms.values().map(|t| t.slot).collect();
    let max = rec.max_terminals as u32;
    let now = Instant::now();
    let name = |s: &str| -> &'static str {
        match s {
            "HUP" => "HUP",
            "TERM" => "TERM",
            "KILL" => "KILL",
            "INT" => "INT",
            "QUIT" => "QUIT",
            _ => "?",
        }
    };
    let closing = rec
        .closing
        .iter()
        .map(|c| Closing {
            handle: c.handle,
            id: c.id.clone(),
            tree: tree(&c.tree),
            at: now.checked_sub(Duration::from_millis(c.elapsed_ms)).unwrap_or(now),
            stage: c.stage,
            steps: c
                .steps
                .iter()
                .map(|s| {
                    let procs = s
                        .procs
                        .iter()
                        .map(|p| Proc {
                            pid: p.get("pid").and_then(Value::as_i64).unwrap_or(0) as i32,
                            comm: p.get("comm").and_then(Value::as_str).unwrap_or("").to_owned(),
                        })
                        .collect();
                    (name(&s.signal), procs)
                })
                .collect(),
        })
        .collect();
    let leftovers = rec
        .leftovers
        .iter()
        .map(|l| Leftover { handle: l.handle, id: l.id.clone(), pid: l.pid, tree: tree(&l.tree), since: l.since })
        .collect();
    log(&format!(
        "{} holder resumed from {} (hold {}.{}): {} terminal(s), instance {}, brain generation {} next",
        cfg.version,
        rec.version,
        rec.hold[0],
        rec.hold[1],
        terms.len(),
        rec.instance,
        rec.generation + 1
    ));
    let mut h = Holder {
        trees,
        inotify,
        closing,
        leftovers,
        ending: None,
        brain_leaves: rec.brain_leaves,
        check: None,
        upgrades: rec.upgrades,
        upgrade_failed: None,
        exe,
        listener,
        lock,
        marks,
        sig,
        nofile: rec.nofile,
        instance: rec.instance.clone(),
        started_at: rec.started_at,
        terms,
        next_handle: rec.next_handle,
        free_slots: (0..max).rev().filter(|s| !used.contains(s)).collect(),
        brain: None,
        candidate: None,
        upgrade: None,
        generation: rec.generation,
        restarts: Restarts {
            crash: rec.restarts.crash,
            watchdog: rec.restarts.watchdog,
            upgrade: rec.restarts.upgrade,
        },
        next_start: json!({"reason": "upgrade"}),
        starts: VecDeque::new(),
        restart_at: Some(now),
        failed: None,
        failed_since: None,
        refused: VecDeque::new(),
        backoff: cfg.failed_backoff,
        last_exit: String::new(),
        exiting: None,
        candidate_lost: None,
        shutdown_at: None,
        idle_since: None,
        restamped: now,
        cfg,
    };
    let leaves: Vec<String> = h
        .terms
        .values()
        .map(|t| &t.tree)
        .chain(h.leftovers.iter().map(|l| &l.tree))
        .chain(h.closing.iter().map(|c| &c.tree))
        .filter_map(|t| if let Tree::Leaf(l) = t { Some(l.clone()) } else { None })
        .collect();
    for l in leaves {
        h.watch_leaf(&l);
    }
    // What ended while no holder ran: its SIGCHLD was discarded across the exec, its zombie wasn't.
    h.reap();
    h.check_trees();
    h.run()
}

/// This namespace's process trees: its delegated cgroup when it runs as the systemd service it
/// asked for (the holder moved into its leaf, an inotify for the leaves' events), else sessions.
fn process_trees(unit: Option<&str>) -> (Trees, Option<OwnedFd>) {
    let trees = Trees::detect(unit);
    if let Trees::Cgroup { root, unit } = &trees {
        #[cfg(target_os = "linux")]
        let ino = rustix::fs::inotify::init(
            rustix::fs::inotify::CreateFlags::CLOEXEC | rustix::fs::inotify::CreateFlags::NONBLOCK,
        )
        .map_err(std::io::Error::from);
        #[cfg(not(target_os = "linux"))]
        let ino: std::io::Result<OwnedFd> = Err(std::io::Error::other("no inotify"));
        match (trees.enter("holder"), ino) {
            (Ok(()), Ok(ino)) => {
                log(&format!(
                    "process trees: each terminal its own cgroup under {} ({unit}, delegated)",
                    root.display()
                ));
                return (trees, Some(ino));
            }
            (Err(e), _) | (_, Err(e)) => {
                let why = format!("the service's cgroup {} can't be used: {e}", root.display());
                log(&format!("process trees: sessions ({why})"));
                return (Trees::Session { why }, None);
            }
        }
    }
    if let Trees::Session { why } = &trees {
        log(&format!("process trees: each terminal's session ({why})"));
    }
    (trees, None)
}

impl Holder {
    fn run(&mut self) -> ! {
        loop {
            self.tick();
            let timeout = self.next_timeout();
            let mut fds: Vec<libc::pollfd> = Vec::with_capacity(4);
            let pfd = |fd: BorrowedFd<'_>, ev: i16| libc::pollfd { fd: fd.as_raw_fd(), events: ev, revents: 0 };
            fds.push(pfd(self.sig.as_fd(), libc::POLLIN));
            let mut who = Vec::new();
            for (w, p) in [(Who::Brain, &self.brain), (Who::Candidate, &self.candidate)] {
                if let Some(p) = p
                    && !p.eof
                {
                    let ev = libc::POLLIN | if p.out.is_empty() { 0 } else { libc::POLLOUT };
                    fds.push(pfd(p.sock.as_fd(), ev));
                    who.push(w);
                }
            }
            let first_refused = fds.len();
            for (c, _) in &self.refused {
                fds.push(pfd(c.as_fd(), libc::POLLIN));
            }
            let listening = self.failed.is_some();
            if listening {
                fds.push(pfd(self.listener.as_fd(), libc::POLLIN));
            }
            let watching = self.inotify.is_some();
            if let Some(ino) = &self.inotify {
                fds.push(pfd(ino.as_fd(), libc::POLLIN));
            }
            let checking = self.check.as_ref().is_some_and(|c| !c.eof);
            if let Some(c) = self.check.as_ref().filter(|_| checking) {
                fds.push(pfd(c.out.as_fd(), libc::POLLIN));
            }
            let ms = timeout.map_or(-1, |t| t.as_millis().min(60_000) as i32);
            // SAFETY: poll over a vector of pollfds we own.
            let n = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, ms) };
            if n < 0 {
                continue; // EINTR
            }
            if fds[0].revents != 0 {
                self.signals();
            }
            for (i, w) in who.iter().enumerate() {
                let rev = fds[1 + i].revents;
                if rev & libc::POLLOUT != 0
                    && let Some(p) = self.peer(*w)
                {
                    p.flush();
                }
                if rev & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                    self.read_peer(*w);
                }
            }
            let ready: Vec<bool> =
                fds[first_refused..first_refused + self.refused.len()].iter().map(|f| f.revents != 0).collect();
            self.drain_refused(&ready);
            let ino_at = fds.len() - usize::from(watching) - usize::from(checking);
            if listening && fds[ino_at - 1].revents & libc::POLLIN != 0 {
                self.refuse_connections();
            }
            if watching && fds[ino_at].revents != 0 {
                self.leaf_events();
            }
            if checking && fds.last().is_some_and(|f| f.revents != 0) {
                self.read_check();
            }
        }
    }

    fn peer(&mut self, w: Who) -> Option<&mut Peer> {
        match w {
            Who::Brain => self.brain.as_mut(),
            Who::Candidate => self.candidate.as_mut(),
        }
    }

    fn next_timeout(&self) -> Option<Duration> {
        let now = Instant::now();
        if self.ending.is_some() && self.closing.is_empty() {
            return Some(Duration::ZERO);
        }
        let mut at: Vec<Instant> = Vec::new();
        at.extend(self.restart_at);
        at.extend(self.failed.as_ref().map(|f| f.1));
        at.extend(self.refused.front().map(|r| r.1));
        at.extend(self.shutdown_at);
        at.extend(self.upgrade.as_ref().map(|u| u.deadline));
        for c in &self.closing {
            if c.stage == 0 {
                at.push(c.at + self.cfg.kill_term_after);
            }
            if c.stage <= 1 {
                at.push(c.at + self.cfg.kill_grace);
            }
        }
        at.extend(self.ending.as_ref().map(|e| e.1));
        if !self.cfg.watchdog.is_zero() {
            for p in [&self.brain, &self.candidate].into_iter().flatten() {
                at.push(p.aborted.map_or(p.last_alive + self.cfg.watchdog, |a| a + Duration::from_secs(5)));
            }
        }
        if let Some(s) = self.idle_since
            && !self.cfg.idle_exit.is_zero()
        {
            at.push(s + self.cfg.idle_exit);
        }
        at.push(self.restamped + Duration::from_secs(3600));
        at.into_iter().min().map(|t| t.saturating_duration_since(now))
    }

    /// Timers: brain (re)starts, watchdog, kill grace, upgrade deadline, re-stamp, idle exit.
    fn tick(&mut self) {
        crate::log::rotate_if_due();
        let now = Instant::now();
        while self.refused.front().is_some_and(|r| now >= r.1) {
            self.refused.pop_front();
        }
        if self.restart_at.is_some_and(|t| now >= t) && self.brain.is_none() && self.ending.is_none() {
            self.restart_at = None;
            self.start_brain();
        }
        if let Some((_, at)) = &self.failed
            && now >= *at
            && self.brain.is_none()
        {
            self.failed = None;
            log("retrying the failed brain");
            self.start_brain();
        }
        if let Some(t) = self.shutdown_at
            && now >= t
        {
            self.shutdown_at = None;
            self.end("SIGTERM (the brain did not shut down in time)");
        }
        if let Some(u) = &self.upgrade
            && now >= u.deadline
            && u.stage != Stage::Committing
        {
            let why = format!("the candidate was not ready within {:?}", self.cfg.upgrade_deadline);
            self.abort_upgrade(&why);
        }
        if !self.cfg.watchdog.is_zero() {
            for w in [Who::Brain, Who::Candidate] {
                let wd = self.cfg.watchdog;
                let Some(p) = self.peer(w) else { continue };
                match p.aborted {
                    None if now.duration_since(p.last_alive) >= wd => {
                        log(&format!(
                            "watchdog: brain pid {} sent nothing for {wd:?}; SIGABRT (SIGKILL in 5 s)",
                            p.pid
                        ));
                        p.aborted = Some(now);
                        // SAFETY: signalling our own child.
                        unsafe { libc::kill(p.pid, libc::SIGABRT) };
                    }
                    Some(a) if now.duration_since(a) >= Duration::from_secs(5) => {
                        log(&format!("watchdog: brain pid {} outlived SIGABRT; SIGKILL", p.pid));
                        // SAFETY: as above.
                        unsafe { libc::kill(p.pid, libc::SIGKILL) };
                        p.aborted = Some(now + Duration::from_secs(3600));
                    }
                    _ => {}
                }
            }
        }
        self.advance_closings(now);
        if let Some((why, until)) = &self.ending
            && (self.closing.is_empty() || now >= *until)
        {
            if !self.closing.is_empty() {
                let left: Vec<String> = self.closing.iter().map(|c| c.id.clone()).collect();
                log(&format!(
                    "exiting with trees not yet empty: {} (the service manager ends the rest)",
                    left.join(", ")
                ));
            }
            log(&format!("exited: {why}"));
            std::process::exit(0);
        }
        if now.duration_since(self.restamped) >= Duration::from_secs(3600) && self.lock.is_some() {
            self.restamped = now;
            for p in [self.cfg.socket.clone(), PathBuf::from(format!("{}.lock", self.cfg.socket.display()))] {
                if let Ok(c) = CString::new(p.as_os_str().as_bytes()) {
                    // SAFETY: utimes(path, NULL) sets both times to now.
                    unsafe { libc::utimes(c.as_ptr(), std::ptr::null()) };
                }
            }
        }
        // Idle exit while no brain runs (a running brain applies it itself).
        if self.brain.is_none() && self.terms.is_empty() {
            let s = *self.idle_since.get_or_insert(now);
            if !self.cfg.idle_exit.is_zero() && now.duration_since(s) >= self.cfg.idle_exit {
                self.end(&format!("no terminals and no brain for {:?}", self.cfg.idle_exit));
            }
        } else {
            self.idle_since = None;
        }
    }

    fn signals(&mut self) {
        let mut buf = [0u8; 64];
        // SAFETY: reading the self-pipe into a buffer we own.
        let n = unsafe { libc::read(self.sig.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 {
            return;
        }
        for &s in &buf[..n as usize] {
            match s as i32 {
                libc::SIGCHLD => self.reap(),
                libc::SIGHUP => {
                    if self.brain.is_none() {
                        log("SIGHUP: starting the brain now");
                        self.failed = None;
                        self.restart_at = None;
                        self.starts.clear();
                        self.backoff = self.cfg.failed_backoff;
                        self.start_brain();
                    } else {
                        log("SIGHUP: the brain is running; nothing to retry");
                    }
                }
                libc::SIGTERM => {
                    if self.shutdown_at.is_some() {
                        continue;
                    }
                    log(&format!("SIGTERM: ending the namespace ({} terminal(s))", self.terms.len()));
                    self.leave_path();
                    match &mut self.brain {
                        Some(b) if b.hello => {
                            b.queue(json!({"m": "shutdown"}), vec![]);
                            self.shutdown_at = Some(Instant::now() + self.cfg.kill_grace + Duration::from_secs(2));
                        }
                        _ => self.end("SIGTERM"),
                    }
                }
                _ => {}
            }
        }
    }

    // ── the brain ──────────────────────────────────────────────────────────────────────────

    fn fork_brain(&mut self, binary: &Path, candidate: bool) -> std::io::Result<Peer> {
        self.brain_leaves += 1;
        let leaf = format!("brain-{}", self.brain_leaves);
        let cgroup = self.trees.make_leaf(&leaf)?;
        let (mine, theirs) = link::pair()?;
        let mut args: Vec<CString> = vec![
            CString::new("g3d-termd").expect("no NUL"),
            CString::new("--brain").expect("no NUL"),
            CString::new("--hold-fd").expect("no NUL"),
            CString::new(theirs.as_raw_fd().to_string()).expect("no NUL"),
        ];
        if candidate {
            args.push(CString::new("--candidate").expect("no NUL"));
        }
        for a in &self.cfg.brain_args {
            args.push(CString::new(a.as_bytes()).map_err(|_| std::io::Error::other("brain arg contains NUL"))?);
        }
        let path = CString::new(binary.as_os_str().as_bytes()).map_err(|_| std::io::Error::other("path has NUL"))?;
        let mut argv: Vec<*const libc::c_char> = args.iter().map(|a| a.as_ptr()).collect();
        argv.push(std::ptr::null());
        let (err_r, err_w) = crate::pipe(false)?;
        let (child_fd, err_fd, nofile) = (theirs.as_raw_fd(), err_w.as_raw_fd(), self.nofile);
        // SAFETY: one thread; the child makes only async-signal-safe calls before execv.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if pid == 0 {
            unsafe {
                if let Some(procs) = &cgroup
                    && let Err(e) = spawn::enter_cgroup(procs)
                {
                    libc::write(err_fd, (&raw const e).cast(), 4);
                    libc::_exit(127);
                }
                libc::fcntl(child_fd, libc::F_SETFD, 0);
                for sig in 1..32 {
                    if sig != libc::SIGKILL && sig != libc::SIGSTOP {
                        libc::signal(sig, libc::SIG_DFL);
                    }
                }
                let mut set: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut set);
                libc::sigprocmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
                let mut rl: libc::rlimit = std::mem::zeroed();
                if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) == 0 {
                    rl.rlim_cur = nofile;
                    libc::setrlimit(libc::RLIMIT_NOFILE, &rl);
                }
                libc::execv(path.as_ptr(), argv.as_ptr());
                let e = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                libc::write(err_fd, (&raw const e).cast(), 4);
                libc::_exit(127);
            }
        }
        drop(theirs);
        drop(err_w);
        let mut e = [0u8; 4];
        let mut f = std::fs::File::from(err_r);
        if f.read(&mut e).unwrap_or(0) == 4 {
            let mut st = 0;
            // SAFETY: reaping the child that failed to exec.
            unsafe { libc::waitpid(pid, &mut st, 0) };
            let err = std::io::Error::from_raw_os_error(i32::from_ne_bytes(e));
            return Err(std::io::Error::new(err.kind(), format!("exec {}: {err}", binary.display())));
        }
        rustix::fs::fcntl_setfl(&mine, rustix::fs::OFlags::NONBLOCK)?;
        let now = Instant::now();
        Ok(Peer {
            pid,
            leaf: cgroup.map(|_| leaf),
            sock: mine,
            rd: Reader::default(),
            out: VecDeque::new(),
            eof: false,
            hello: false,
            engine: String::new(),
            last_alive: now,
            aborted: None,
        })
    }

    fn start_brain(&mut self) {
        let now = Instant::now();
        self.starts.push_back(now);
        let exe = self.exe.clone();
        match self.fork_brain(&exe, false) {
            Ok(p) => {
                log(&format!("brain started: pid {} (generation {})", p.pid, self.generation + 1));
                self.brain = Some(p);
            }
            Err(e) => {
                self.last_exit = format!("could not start: {e}");
                log(&format!("brain: {}", self.last_exit));
                self.schedule_restart();
            }
        }
    }

    /// After a brain ends without a handoff: restart it (systemd's rate limit), or mark it failed.
    fn schedule_restart(&mut self) {
        let now = Instant::now();
        while self.starts.front().is_some_and(|t| now.duration_since(*t) > self.cfg.start_interval) {
            self.starts.pop_front();
        }
        if self.starts.len() >= self.cfg.start_burst {
            let retry = self.backoff;
            self.backoff = (self.backoff * 2).min(self.cfg.failed_backoff_max);
            let why = format!(
                "the brain failed {} times within {:?} (last: {})",
                self.starts.len(),
                self.cfg.start_interval,
                self.last_exit
            );
            log(&format!(
                "brain FAILED: {why}; shells stay alive (frozen once their output fills); retrying in {retry:?}, or now on SIGHUP to pid {}",
                std::process::id()
            ));
            self.failed = Some((why, now + retry));
            self.failed_since.get_or_insert_with(ms_now);
        } else {
            self.restart_at = Some(now + self.cfg.restart_delay);
        }
    }

    fn refuse_connections(&mut self) {
        let why = self.failed.as_ref().map(|f| f.0.clone()).unwrap_or_default();
        let msg = format!(
            "termd's brain is not running: {why}; the shells are alive; log {}; holder pid {} (SIGHUP retries now)",
            self.cfg.log.display(),
            std::process::id()
        );
        let bytes = g3d_wire::frame::encode_json(
            g3d_wire::frame::ty::ERROR,
            0,
            &g3d_wire::WireError::new(g3d_wire::code::BRAIN_FAILED, msg),
        );
        loop {
            match rustix::net::accept(&self.listener) {
                Ok(c) => {
                    let _ = rustix::io::fcntl_setfd(&c, rustix::io::FdFlags::CLOEXEC);
                    let _ = rustix::fs::fcntl_setfl(&c, rustix::fs::OFlags::NONBLOCK);
                    let _ = rustix::io::write(&c, &bytes);
                    // Not closed yet: a client that follows the handshake writes HELLO first, and
                    // a close now would turn that write into EPIPE (SIGPIPE in a C client that
                    // doesn't ignore it) before it reads the ERROR. Like an HTTP server's lingering
                    // close: half-close the write side, read and discard, close on EOF or deadline.
                    let _ = rustix::net::shutdown(&c, rustix::net::Shutdown::Write);
                    self.refused.push_back((c, Instant::now() + self.cfg.refused_linger));
                    while self.refused.len() > self.cfg.refused_max {
                        self.refused.pop_front();
                    }
                }
                Err(_) => return,
            }
        }
    }

    /// Reads and discards what refused connections sent (`ready`: which had events, in order);
    /// one that closed, or failed, is dropped.
    fn drain_refused(&mut self, ready: &[bool]) {
        let mut buf = [0u8; 4096];
        let mut i = 0;
        self.refused.retain(|(c, _)| {
            let r = ready.get(i).copied().unwrap_or(false);
            i += 1;
            if !r {
                return true;
            }
            loop {
                match rustix::io::read(c, &mut buf) {
                    Ok(0) => return false,
                    Ok(_) => continue,
                    Err(rustix::io::Errno::AGAIN) => return true,
                    Err(rustix::io::Errno::INTR) => continue,
                    Err(_) => return false,
                }
            }
        });
    }

    fn read_peer(&mut self, w: Who) {
        loop {
            let Some(p) = self.peer(w) else { return };
            if p.eof {
                return;
            }
            let fill = p.rd.fill(p.sock.as_fd());
            let mut msgs = Vec::new();
            loop {
                match p.rd.next_msg() {
                    Ok(Some(m)) => msgs.push(m),
                    Ok(None) => break,
                    Err(e) => {
                        log(&format!("brain pid {}: {e}; dropping its link", p.pid));
                        p.eof = true;
                        // SAFETY: signalling our own child, whose link is unusable.
                        unsafe { libc::kill(p.pid, libc::SIGKILL) };
                        break;
                    }
                }
            }
            let stop = match fill {
                Ok(Fill::Data) => false,
                Ok(Fill::Empty) => true,
                Ok(Fill::Eof) | Err(_) => {
                    p.eof = true;
                    true
                }
            };
            for (m, fds) in msgs {
                self.handle(w, m, fds);
            }
            if stop {
                return;
            }
        }
    }

    fn welcome(&self, candidate: bool) -> (Value, Vec<OwnedFd>) {
        let dup = |fd: &OwnedFd| rustix::io::fcntl_dupfd_cloexec(fd, 3).expect("dup");
        // A candidate becomes the brain only by an upgrade's handoff, which it is counted as.
        let (restarts, mut last_start) = if candidate {
            (Restarts { upgrade: self.restarts.upgrade + 1, ..self.restarts }, json!({"reason": "upgrade"}))
        } else {
            (self.restarts, self.next_start.clone())
        };
        last_start["at"] = json!(ms_now());
        if let Some(t) = self.failed_since.filter(|_| !candidate) {
            last_start["failed_at"] = json!(t);
        }
        let msg = json!({
            "m": "welcome", "hold": HOLD, "instance": self.instance,
            "generation": self.generation + 1, "holder_pid": std::process::id(),
            "holder_version": self.cfg.version, "started_at": self.started_at,
            "candidate": candidate, "max_terminals": self.cfg.max_terminals,
            "log": self.cfg.log.display().to_string(),
            "restarts": restarts.json(), "last_start": last_start,
            "trees": self.trees.json(),
            "upgrades": self.upgrades,
            "upgrade_failed": self.upgrade_failed,
            "leftovers": self.leftovers.iter().map(|l| json!({
                "handle": l.handle, "id": l.id, "pid": l.pid, "tree": l.tree.json(), "since": l.since,
            })).collect::<Vec<_>>(),
        });
        (msg, vec![dup(&self.listener), dup(&self.marks)])
    }

    /// Every terminal the holder keeps, as `term` messages, then `terms_done`.
    fn send_terms(&mut self, w: Who) {
        let mut out = Vec::new();
        for t in self.terms.values_mut() {
            let Some(master) = &t.master else {
                t.known = false; // killed under the last brain; it goes when reaped
                continue;
            };
            let mut fds = vec![rustix::io::fcntl_dupfd_cloexec(master, 3).expect("dup")];
            for s in &t.snaps {
                fds.push(rustix::io::fcntl_dupfd_cloexec(s, 3).expect("dup"));
            }
            let mut m =
                json!({"m": "term", "handle": t.handle, "slot": t.slot, "id": t.id, "pid": t.pid, "meta": t.meta});
            if let Some(e) = &t.exit {
                m["exit"] = e.clone();
            }
            t.known = true;
            out.push((m, fds));
        }
        let n = out.len();
        if let Some(p) = self.peer(w) {
            for (m, fds) in out {
                p.queue(m, fds);
            }
            p.queue(json!({"m": "terms_done", "count": n}), vec![]);
        }
    }

    fn handle(&mut self, w: Who, m: Value, fds: Vec<OwnedFd>) {
        let name = link::name(&m).to_owned();
        if let Some(p) = self.peer(w) {
            p.last_alive = Instant::now();
            p.aborted = None;
        }
        match name.as_str() {
            "hello" => {
                let major = m.get("hold").and_then(|h| h.get(0)).and_then(Value::as_u64);
                let engine = m.get("engine").and_then(Value::as_str).unwrap_or("").to_owned();
                let Some(p) = self.peer(w) else { return };
                if major != Some(HOLD[0]) {
                    let pid = p.pid;
                    let theirs = m.get("hold").map_or_else(|| "none".to_owned(), Value::to_string);
                    log(&format!(
                        "brain pid {pid} speaks hold protocol {theirs}; this holder speaks {}.x; stopping it",
                        HOLD[0]
                    ));
                    if w == Who::Candidate {
                        // The asker learns why: only a new holder runs this brain, and the holder
                        // replaces itself with `g3d upgrade --holder`.
                        self.abort_upgrade(&format!(
                            "the candidate speaks hold protocol {theirs} and this holder {}.x: upgrade the \
                             holder with it (g3d upgrade --holder)",
                            HOLD[0]
                        ));
                    }
                    // SAFETY: our own child.
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                    return;
                }
                p.hello = true;
                p.engine = engine.clone();
                let (msg, f) = self.welcome(w == Who::Candidate);
                if let Some(p) = self.peer(w) {
                    p.queue(msg, f);
                }
                if w == Who::Brain {
                    self.failed_since = None;
                    self.upgrade_failed = None;
                }
                match w {
                    Who::Brain => {
                        self.send_terms(Who::Brain);
                        if let Some(b) = &mut self.brain {
                            b.queue(json!({"m": "go"}), vec![]);
                        }
                        self.generation += 1;
                    }
                    Who::Candidate => {
                        let pid = self.candidate.as_ref().map_or(0, |c| c.pid);
                        if let Some(u) = &mut self.upgrade {
                            u.stage = Stage::Cutting;
                        }
                        if let Some(b) = &mut self.brain {
                            b.queue(json!({"m": "candidate", "engine": engine, "pid": pid}), vec![]);
                        }
                    }
                }
            }
            "alive" => {}
            "spawn" if w == Who::Brain => self.spawn(&m),
            "kill" if w == Who::Brain => {
                let handle = m.get("handle").and_then(Value::as_u64).unwrap_or(0) as u32;
                let sig = m.get("signal").and_then(Value::as_i64).unwrap_or(libc::SIGHUP as i64) as i32;
                self.close(handle, sig);
            }
            "release" if w == Who::Brain => {
                let handle = m.get("handle").and_then(Value::as_u64).unwrap_or(0) as u32;
                if let Some(t) = self.terms.get_mut(&handle) {
                    t.released = true;
                    t.master = None;
                    if t.exit.is_some() {
                        self.remove(handle);
                    }
                }
            }
            "snapshot" => {
                let handle = m.get("handle").and_then(Value::as_u64).unwrap_or(0) as u32;
                if let (Some(t), Some(fd)) = (self.terms.get_mut(&handle), fds.into_iter().next()) {
                    t.snaps.push_front(fd);
                    t.snaps.truncate(2);
                }
            }
            "upgrade" if w == Who::Brain => self.start_upgrade(&m),
            "handoff_done" if w == Who::Brain => {
                if self.upgrade.as_ref().is_some_and(|u| u.stage == Stage::Cutting && u.holder.is_some()) {
                    if let Some(u) = &mut self.upgrade {
                        u.stage = Stage::Validating;
                    }
                    if let Err(e) = self.run_check(true) {
                        self.abort_upgrade(&format!("the new holder's record check could not start: {e}"));
                    }
                } else if self.upgrade.as_ref().is_some_and(|u| u.stage == Stage::Cutting) && self.candidate.is_some() {
                    if let Some(u) = &mut self.upgrade {
                        u.stage = Stage::Validating;
                    }
                    self.send_terms(Who::Candidate);
                }
            }
            "ready" if w == Who::Candidate => {
                if let Some(u) = &mut self.upgrade
                    && u.stage == Stage::Validating
                {
                    u.stage = Stage::Committing;
                    log("upgrade: the candidate is ready; the running brain hands over");
                    if let Some(b) = &mut self.brain {
                        b.queue(json!({"m": "commit"}), vec![]);
                    }
                }
            }
            "upgrade_cancel" if w == Who::Brain => {
                let why = m.get("why").and_then(Value::as_str).unwrap_or("?").to_owned();
                self.abort_upgrade(&format!("the running brain cancelled it: {why}"));
            }
            "upgrade_abort" if w == Who::Candidate => {
                let why = m.get("why").and_then(Value::as_str).unwrap_or("?").to_owned();
                self.abort_upgrade(&format!("the candidate refused: {why}"));
            }
            "exit_namespace" if w == Who::Brain => {
                let why = m.get("why").and_then(Value::as_str).unwrap_or("?").to_owned();
                self.leave_path();
                self.exiting = Some(why);
            }
            other => log(&format!(
                "hold link: unexpected {other:?} from the {}",
                if w == Who::Brain { "brain" } else { "candidate" }
            )),
        }
    }

    fn spawn(&mut self, m: &Value) {
        let req = m.get("req").cloned().unwrap_or(Value::Null);
        let reply = match self.spawn_inner(m) {
            Ok((handle, slot, pid, fd)) => {
                (json!({"m": "spawned", "req": req, "handle": handle, "slot": slot, "pid": pid}), vec![fd])
            }
            Err(e) => (json!({"m": "spawned", "req": req, "error": e}), vec![]),
        };
        if let Some(b) = &mut self.brain {
            b.queue(reply.0, reply.1);
        }
    }

    fn spawn_inner(&mut self, m: &Value) -> Result<(u32, u32, i32, OwnedFd), String> {
        let s = |k: &str| m.get(k).and_then(Value::as_str);
        let id = s("id").ok_or("spawn without an id")?.to_owned();
        if self.terms.values().any(|t| t.id == id && !t.released) {
            return Err(format!("terminal {id:?} exists"));
        }
        let argv: Vec<String> = m
            .get("argv")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        let env: Vec<(String, String)> = m
            .get("env")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|kv| Some((kv.get(0)?.as_str()?.to_owned(), kv.get(1)?.as_str()?.to_owned())))
                    .collect()
            })
            .unwrap_or_default();
        let cols = m.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
        let rows = m.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
        let slot = *self
            .free_slots
            .last()
            .ok_or_else(|| format!("{} terminals is the most this daemon holds", self.cfg.max_terminals))?;
        let path = s("path").ok_or("spawn without a path")?;
        let plan = spawn::Plan::new(path, &argv, &env, s("cwd"), cols, rows).map_err(|e| e.to_string())?;
        let handle = self.next_handle;
        let leaf = format!("term-{handle}");
        let cgroup = self.trees.make_leaf(&leaf).map_err(|e| format!("its cgroup: {e}"))?;
        let (master, pid) = match spawn::spawn(&plan, self.nofile, cgroup.as_deref()) {
            Ok(x) => x,
            Err(e) => {
                self.trees.remove_leaf(&leaf);
                return Err(e.to_string());
            }
        };
        if cgroup.is_some() {
            self.watch_leaf(&leaf);
        }
        let tree = self.trees.tree_of(handle, pid);
        self.free_slots.pop();
        self.next_handle += 1;
        let dup = rustix::io::fcntl_dupfd_cloexec(&master, 3).map_err(|e| e.to_string())?;
        self.terms.insert(
            handle,
            Term {
                handle,
                slot,
                id,
                pid,
                master: Some(master),
                meta: m.get("meta").cloned().unwrap_or(Value::Null),
                exit: None,
                tree,
                killed: false,
                snaps: VecDeque::new(),
                released: false,
                known: true,
            },
        );
        Ok((handle, slot, pid, dup))
    }

    fn remove(&mut self, handle: u32) {
        if let Some(t) = self.terms.remove(&handle) {
            self.free_slots.push(t.slot);
        }
    }

    // ── upgrade ────────────────────────────────────────────────────────────────────────────

    fn start_upgrade(&mut self, m: &Value) {
        if self.upgrade.is_some() {
            if let Some(b) = &mut self.brain {
                b.queue(json!({"m": "upgrade_abort", "why": "another upgrade is running"}), vec![]);
            }
            return;
        }
        let binary = m.get("binary").and_then(Value::as_str).map(PathBuf::from).unwrap_or_else(|| self.exe.clone());
        if m.get("holder").and_then(Value::as_bool) == Some(true) {
            log(&format!("upgrade: the holder re-execs into {}; it reads a trial record first", binary.display()));
            self.upgrade = Some(Upgrade {
                deadline: Instant::now() + self.cfg.upgrade_deadline,
                stage: Stage::HolderTrial,
                holder: Some(binary),
            });
            if let Err(e) = self.run_check(false) {
                self.abort_upgrade(&format!("the new holder's record check could not start: {e}"));
            }
            return;
        }
        log(&format!("upgrade: starting candidate {}", binary.display()));
        match self.fork_brain(&binary, true) {
            Ok(p) => {
                log(&format!("upgrade: candidate pid {}", p.pid));
                self.candidate = Some(p);
                self.upgrade = Some(Upgrade {
                    deadline: Instant::now() + self.cfg.upgrade_deadline,
                    stage: Stage::Starting,
                    holder: None,
                });
            }
            Err(e) => {
                log(&format!("upgrade failed: {e}"));
                if let Some(b) = &mut self.brain {
                    b.queue(json!({"m": "upgrade_abort", "why": e.to_string()}), vec![]);
                }
            }
        }
    }

    /// The candidate failed: kill it, and the running brain carries on.
    fn abort_upgrade(&mut self, why: &str) {
        if self.upgrade.take().is_none() {
            return;
        }
        log(&format!("upgrade FAILED: {why}; the running brain carries on"));
        if let Some(c) = self.check.take() {
            // SAFETY: our own child, the record check; its reap is a stranger's then.
            unsafe { libc::kill(c.pid, libc::SIGKILL) };
        }
        if let Some(c) = &self.candidate {
            // SAFETY: our own child.
            unsafe { libc::kill(c.pid, libc::SIGKILL) };
        }
        if let Some(b) = &mut self.brain {
            b.queue(json!({"m": "upgrade_abort", "why": why}), vec![]);
        }
        // The brain keeps the terminals the candidate was shown.
        for t in self.terms.values_mut() {
            if t.master.is_some() {
                t.known = true;
            }
        }
    }

    // ── the holder's re-exec (`g3d upgrade --holder`) ───────────────────────────────────────

    /// This holder as a record (record.rs): what the next holder resumes from. `handoff`: every
    /// terminal has been handed over (the record it execs on).
    fn record(&self, handoff: bool) -> Record {
        let lock = self.lock.as_ref().map_or(-1, |l| l.as_raw_fd());
        Record {
            version: self.cfg.version.clone(),
            hold: HOLD,
            instance: self.instance.clone(),
            started_at: self.started_at,
            generation: self.generation,
            restarts: record::Restarts {
                crash: self.restarts.crash,
                watchdog: self.restarts.watchdog,
                upgrade: self.restarts.upgrade,
            },
            upgrades: self.upgrades,
            next_handle: self.next_handle,
            max_terminals: self.cfg.max_terminals,
            nofile: self.nofile,
            listener: self.listener.as_raw_fd(),
            lock,
            marks: self.marks.as_raw_fd(),
            trees: self.trees.json(),
            brain_leaves: self.brain_leaves,
            handoff,
            terms: self
                .terms
                .values()
                .map(|t| record::Term {
                    handle: t.handle,
                    slot: t.slot,
                    id: t.id.clone(),
                    pid: t.pid,
                    master: t.master.as_ref().map(|m| m.as_raw_fd()),
                    meta: t.meta.clone(),
                    exit: t.exit.clone(),
                    tree: t.tree.json(),
                    killed: t.killed,
                    snaps: t.snaps.iter().map(|s| s.as_raw_fd()).collect(),
                    released: t.released,
                })
                .collect(),
            closing: self
                .closing
                .iter()
                .map(|c| record::Closing {
                    handle: c.handle,
                    id: c.id.clone(),
                    tree: c.tree.json(),
                    elapsed_ms: c.at.elapsed().as_millis() as u64,
                    stage: c.stage,
                    steps: c
                        .steps
                        .iter()
                        .map(|(sig, p)| record::Step {
                            signal: (*sig).to_owned(),
                            procs: p.iter().map(Proc::json).collect(),
                        })
                        .collect(),
                })
                .collect(),
            leftovers: self
                .leftovers
                .iter()
                .map(|l| record::Leftover {
                    handle: l.handle,
                    id: l.id.clone(),
                    pid: l.pid,
                    tree: l.tree.json(),
                    since: l.since,
                })
                .collect(),
        }
    }

    /// Runs the upgrade's binary as `g3d-termd <this holder's flags> --check-holder-record <fd>`
    /// on a record of this holder (the trial before the cut, the final one after the handoff):
    /// it must read the record and find every fd it names before anything is irreversible. It
    /// inherits those fds (close-on-exec cleared in the child only); its answer comes on a pipe.
    fn run_check(&mut self, last: bool) -> std::io::Result<()> {
        let binary = self
            .upgrade
            .as_ref()
            .and_then(|u| u.holder.clone())
            .ok_or_else(|| std::io::Error::other("no holder upgrade"))?;
        let rec = self.record(last);
        let rfd = shm::create_from("g3d-termd holder record", &record::encode(&rec))?;
        let mut keep = rec.fds();
        keep.push(rfd.as_raw_fd());
        let mut args: Vec<CString> = vec![CString::new("g3d-termd").expect("no NUL")];
        for a in &self.cfg.brain_args {
            args.push(CString::new(a.as_bytes()).map_err(|_| std::io::Error::other("an argument holds NUL"))?);
        }
        args.push(CString::new("--check-holder-record").expect("no NUL"));
        args.push(CString::new(rfd.as_raw_fd().to_string()).expect("no NUL"));
        let mut argv: Vec<*const libc::c_char> = args.iter().map(|a| a.as_ptr()).collect();
        argv.push(std::ptr::null());
        let path =
            CString::new(binary.as_os_str().as_bytes()).map_err(|_| std::io::Error::other("the path holds NUL"))?;
        let (rd, wr) = crate::pipe(false)?;
        rustix::fs::fcntl_setfl(&rd, rustix::fs::OFlags::NONBLOCK)?;
        let (out_fd, nofile) = (wr.as_raw_fd(), self.nofile);
        // SAFETY: one thread; the child makes only async-signal-safe calls before execv.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if pid == 0 {
            unsafe {
                libc::dup2(out_fd, 1);
                libc::dup2(out_fd, 2);
                for &fd in &keep {
                    libc::fcntl(fd, libc::F_SETFD, 0);
                }
                for sig in 1..32 {
                    if sig != libc::SIGKILL && sig != libc::SIGSTOP {
                        libc::signal(sig, libc::SIG_DFL);
                    }
                }
                let mut set: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut set);
                libc::sigprocmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
                let mut rl: libc::rlimit = std::mem::zeroed();
                if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) == 0 {
                    rl.rlim_cur = nofile;
                    libc::setrlimit(libc::RLIMIT_NOFILE, &rl);
                }
                libc::execv(path.as_ptr(), argv.as_ptr());
                let msg = b"{\"ok\":false,\"error\":\"exec failed\"}\n";
                libc::write(1, msg.as_ptr().cast(), msg.len());
                libc::_exit(127);
            }
        }
        drop(wr);
        drop(rfd);
        log(&format!(
            "upgrade: {} reads the {} record (pid {pid})",
            binary.display(),
            if last { "final" } else { "trial" }
        ));
        self.check = Some(Check { pid, out: rd, buf: Vec::new(), eof: false, status: None, last });
        Ok(())
    }

    fn read_check(&mut self) {
        let Some(c) = &mut self.check else { return };
        let mut buf = [0u8; 4096];
        loop {
            match rustix::io::read(&c.out, &mut buf) {
                Ok(0) => {
                    c.eof = true;
                    break;
                }
                Ok(n) => {
                    // An answer is one line; anything past 64 KiB is noise.
                    if c.buf.len() < 64 << 10 {
                        c.buf.extend_from_slice(&buf[..n]);
                    }
                }
                Err(rustix::io::Errno::INTR) => {}
                Err(_) => break,
            }
        }
        self.check_done();
    }

    /// The check has answered and exited: on to the cut (trial), the commit (final), or abort.
    fn check_done(&mut self) {
        if !self.check.as_ref().is_some_and(|c| c.eof && c.status.is_some()) {
            return;
        }
        let c = self.check.take().expect("checked above");
        let text = String::from_utf8_lossy(&c.buf).into_owned();
        let answer: Option<Value> = text.lines().rev().find_map(|l| serde_json::from_str(l).ok());
        let ok = libc::WIFEXITED(c.status.unwrap_or(0))
            && libc::WEXITSTATUS(c.status.unwrap_or(0)) == 0
            && answer.as_ref().and_then(|a| a.get("ok")).and_then(Value::as_bool) == Some(true);
        if !ok {
            let why = answer
                .as_ref()
                .and_then(|a| a.get("error"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| text.trim().lines().last().unwrap_or("").to_owned());
            let (_, how) = describe_status(c.status.unwrap_or(0));
            return self.abort_upgrade(&format!("the new holder refused this holder's record ({how}): {why}"));
        }
        let a = answer.expect("ok above");
        let version = a.get("version").and_then(Value::as_str).unwrap_or("?").to_owned();
        if !c.last {
            let engine = a.get("engine").and_then(Value::as_str).unwrap_or("").to_owned();
            log(&format!("upgrade: {version} reads this holder's record; the brain hands over ({engine})"));
            if let Some(u) = &mut self.upgrade {
                u.stage = Stage::Cutting;
            }
            if let Some(b) = &mut self.brain {
                b.queue(json!({"m": "candidate", "engine": engine, "pid": c.pid, "holder": true}), vec![]);
            }
        } else {
            log(&format!("upgrade: {version} reads the handoff's record; the running brain hands over"));
            if let Some(u) = &mut self.upgrade {
                u.stage = Stage::Committing;
            }
            if let Some(b) = &mut self.brain {
                b.queue(json!({"m": "commit"}), vec![]);
            }
        }
    }

    /// Re-execs this process into `binary` with a record of itself (`--holder-resume <fd>`): the
    /// same pid, so every shell stays its child and every fd it keeps stays open. Returns only if
    /// the exec failed, and why, with every fd's close-on-exec flag back as it was.
    fn exec_holder(&mut self, binary: &Path, old_brain: i32) -> String {
        self.upgrades += 1;
        let rec = self.record(true);
        let rfd = match shm::create_from("g3d-termd holder record", &record::encode(&rec)) {
            Ok(f) => f,
            Err(e) => {
                self.upgrades -= 1;
                return format!("the record: {e}");
            }
        };
        let mut keep = rec.fds();
        keep.push(rfd.as_raw_fd());
        let mut args: Vec<CString> = vec![CString::new("g3d-termd").expect("no NUL")];
        for a in &self.cfg.brain_args {
            if let Ok(c) = CString::new(a.as_bytes()) {
                args.push(c);
            }
        }
        args.push(CString::new("--holder-resume").expect("no NUL"));
        args.push(CString::new(rfd.as_raw_fd().to_string()).expect("no NUL"));
        let mut argv: Vec<*const libc::c_char> = args.iter().map(|a| a.as_ptr()).collect();
        argv.push(std::ptr::null());
        let Ok(path) = CString::new(binary.as_os_str().as_bytes()) else {
            self.upgrades -= 1;
            return "the path holds NUL".into();
        };
        log(&format!(
            "upgrade: brain pid {old_brain} handed over; the holder (pid {}) re-execs into {} with {} terminal(s)",
            std::process::id(),
            binary.display(),
            rec.terms.len()
        ));
        for &fd in &keep {
            // SAFETY: fds this holder owns, kept open across the exec.
            unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
        }
        // SAFETY: execv with a NUL-terminated argv we own; on success this process image ends.
        unsafe { libc::execv(path.as_ptr(), argv.as_ptr()) };
        let e = std::io::Error::last_os_error();
        for &fd in &keep {
            // SAFETY: as above, put back.
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
        self.upgrades -= 1;
        format!("exec: {e}")
    }

    // ── reaping ────────────────────────────────────────────────────────────────────────────

    fn reap(&mut self) {
        loop {
            let mut status = 0;
            // SAFETY: waitpid on our own children, non-blocking.
            let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if pid <= 0 {
                return;
            }
            let (st, text) = describe_status(status);
            for p in [&self.brain, &self.candidate].into_iter().flatten() {
                if p.pid == pid
                    && let Some(l) = &p.leaf
                {
                    self.trees.remove_leaf(l);
                }
            }
            if self.check.as_ref().is_some_and(|c| c.pid == pid) {
                if let Some(c) = &mut self.check {
                    c.status = Some(status);
                }
                self.check_done();
            } else if self.brain.as_ref().is_some_and(|b| b.pid == pid) {
                self.brain_exited(&text, status);
            } else if self.candidate.as_ref().is_some_and(|c| c.pid == pid) {
                self.candidate = None;
                if self.upgrade.as_ref().is_some_and(|u| u.stage == Stage::Committing) {
                    // Past the point of no return: the running brain was told to commit and is
                    // handing over. Nothing to abort; once it has gone, a brain starts from the
                    // handoff it left.
                    self.upgrade = None;
                    log(&format!(
                        "upgrade: the candidate pid {pid} died ({text}) after the running brain committed; \
                         a new brain starts from the handoff once it has gone"
                    ));
                    self.candidate_lost = Some((text, status));
                } else if self.upgrade.is_some() {
                    self.abort_upgrade(&format!("the candidate exited ({text})"));
                } else {
                    log(&format!("upgrade: candidate pid {pid} ended ({text})"));
                }
            } else if let Some(t) = self.terms.values_mut().find(|t| t.pid == pid) {
                t.exit = Some(st.clone());
                let handle = t.handle;
                let (known, released) = (t.known, t.released);
                let (killed, tree, id) = (t.killed, t.tree.clone(), t.id.clone());
                if !killed {
                    self.program_ended(handle, &id, pid, tree);
                }
                let mut msg = json!({"m": "exited", "handle": handle});
                if let Some(o) = st.as_object() {
                    for (k, v) in o {
                        msg[k] = v.clone();
                    }
                }
                if known {
                    for p in [&mut self.brain, &mut self.candidate].into_iter().flatten() {
                        p.queue(msg.clone(), vec![]);
                    }
                }
                if released || !known {
                    self.remove(handle);
                }
            }
            // Anything else is an orphan of a terminal's (the holder is their subreaper), reaped
            // here; a session tree may have just emptied.
            if !self.trees.is_cgroup() {
                self.check_trees();
            }
        }
    }

    fn brain_exited(&mut self, text: &str, status: i32) {
        let old = self.brain.take().expect("a brain");
        let generation = self.generation;
        if let Some(why) = self.exiting.take() {
            self.end(&why);
        }
        if self.ending.is_some() {
            return;
        }
        if let Some(binary) =
            self.upgrade.as_ref().filter(|u| u.stage == Stage::Committing).and_then(|u| u.holder.clone())
        {
            // The old brain handed every terminal over and exited: the holder re-execs into the
            // new binary, which starts a brain of its own from the handoff. Only a failed exec
            // comes back here.
            self.upgrade = None;
            for t in self.terms.values_mut() {
                t.known = false;
            }
            self.restarts.upgrade += 1;
            let why = self.exec_holder(&binary, old.pid);
            log(&format!(
                "upgrade FAILED: the holder could not re-exec into {}: {why}; this holder carries on, and a brain \
                 of its own starts from the handoff",
                binary.display()
            ));
            self.upgrade_failed = Some(format!("the holder could not re-exec into {}: {why}", binary.display()));
            self.next_start = json!({"reason": "upgrade"});
            self.restart_at = Some(Instant::now());
            return;
        }
        if self.upgrade.as_ref().is_some_and(|u| u.stage == Stage::Committing) && self.candidate.is_some() {
            // The handoff: the candidate becomes the brain.
            self.upgrade = None;
            let mut c = self.candidate.take().expect("a candidate");
            self.generation += 1;
            self.restarts.upgrade += 1;
            self.next_start = json!({"reason": "upgrade"});
            c.queue(json!({"m": "go"}), vec![]);
            log(&format!(
                "upgrade: brain pid {} (generation {}) serves; pid {} handed over",
                c.pid, self.generation, old.pid
            ));
            self.brain = Some(c);
            return;
        }
        if self.shutdown_at.take().is_some() {
            self.end("SIGTERM");
            return;
        }
        let watchdog = old.aborted.is_some();
        if let Some((cand, cand_status)) = self.candidate_lost.take() {
            // It handed over and exited, as told; its successor is what crashed.
            self.last_exit = format!("the upgrade's candidate died after the handoff ({cand})");
            log(&format!(
                "upgrade: brain pid {} (generation {generation}) handed over and exited ({text}); its candidate died, \
                 so the next brain restores from the handoff",
                old.pid
            ));
            self.restarts.crash += 1;
            self.next_start = json!({"reason": "crash", "exit": describe_status(cand_status).0});
        } else {
            self.last_exit = format!(
                "pid {} (generation {generation}) {}{text}",
                old.pid,
                if watchdog { "killed by the watchdog: " } else { "exited without a handoff: " }
            );
            log(&format!("brain CRASHED: {}; the shells keep running", self.last_exit));
            if watchdog {
                self.restarts.watchdog += 1;
            } else {
                self.restarts.crash += 1;
            }
            self.next_start =
                json!({"reason": if watchdog { "watchdog" } else { "crash" }, "exit": describe_status(status).0});
        }
        if self.upgrade.take().is_some() {
            for pid in self.candidate.take().map(|c| c.pid).into_iter().chain(self.check.take().map(|c| c.pid)) {
                // SAFETY: our own children: a candidate brain, a holder upgrade's record check.
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
        for t in self.terms.values_mut() {
            t.known = false;
        }
        // A terminal killed under the dead brain, whose program has already gone, is done.
        let gone: Vec<u32> =
            self.terms.values().filter(|t| t.master.is_none() && t.exit.is_some()).map(|t| t.handle).collect();
        for h in gone {
            self.remove(h);
        }
        self.schedule_restart();
    }

    /// Ends the namespace: the socket goes, the brain and any candidate are killed, and every
    /// terminal's tree (and every leftover) gets the close rule; the holder exits once they are
    /// all gone, or `kill_grace` + 2 s on, whichever is first (a systemd service's manager then
    /// ends what is left of its cgroup).
    fn end(&mut self, why: &str) {
        if self.ending.is_some() {
            return;
        }
        log(&format!("exiting: {why}"));
        self.leave_path();
        self.ending = Some((why.to_owned(), Instant::now() + self.cfg.kill_grace + Duration::from_secs(2)));
        self.restart_at = None;
        self.failed = None;
        self.upgrade = None;
        let check = self.check.take().map(|c| c.pid);
        for pid in [&self.brain, &self.candidate].into_iter().flatten().map(|p| p.pid).chain(check) {
            // SAFETY: our own children.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let live: Vec<u32> = self.terms.values().filter(|t| t.exit.is_none() && !t.killed).map(|t| t.handle).collect();
        for h in live {
            self.close(h, libc::SIGHUP);
        }
        for t in self.terms.values_mut() {
            t.master = None;
        }
        for l in std::mem::take(&mut self.leftovers) {
            self.start_closing(l.handle, l.id, l.tree, libc::SIGHUP, None);
        }
    }

    // ── process trees ──────────────────────────────────────────────────────────────────────

    /// `kill`: the close rule on a terminal's tree. The asked signal goes to every process in it
    /// and to the PTY's foreground group, the holder's copy of the PTY closes (the brain closes
    /// its own: the last close hangs the PTY up), then `SIGTERM` to what is left after
    /// `kill_term_after`, `SIGKILL` after `kill_grace`.
    fn close(&mut self, handle: u32, sig: i32) {
        let Some(t) = self.terms.get_mut(&handle) else { return };
        if t.exit.is_some() || t.killed {
            return;
        }
        t.killed = true;
        let fg = t.master.as_ref().and_then(|m| rustix::termios::tcgetpgrp(m).ok()).map(|p| p.as_raw_nonzero().get());
        t.master = None;
        let (id, tree) = (t.id.clone(), t.tree.clone());
        self.start_closing(handle, id, tree, sig, fg);
    }

    fn start_closing(&mut self, handle: u32, id: String, tree: Tree, sig: i32, fg: Option<i32>) {
        if let Some(fg) = fg {
            // SAFETY: the PTY's foreground group, one of the tree's.
            unsafe { libc::kill(-fg, sig) };
        }
        let who = self.trees.signal(&tree, sig);
        self.closing.push(Closing {
            handle,
            id,
            tree,
            at: Instant::now(),
            stage: if sig == libc::SIGKILL { 2 } else { 0 },
            steps: vec![(sig_name(sig), who)],
        });
        self.check_trees();
    }

    /// The close rule's next steps for every tree being closed whose time has come.
    fn advance_closings(&mut self, now: Instant) {
        let (term_after, grace) = (self.cfg.kill_term_after, self.cfg.kill_grace);
        let mut stepped = false;
        for c in &mut self.closing {
            let elapsed = now.duration_since(c.at);
            if c.stage == 0 && elapsed >= term_after {
                c.stage = 1;
                let who = self.trees.signal(&c.tree, libc::SIGTERM);
                if !who.is_empty() {
                    c.steps.push(("TERM", who));
                }
                stepped = true;
            }
            if c.stage == 1 && elapsed >= grace {
                c.stage = 2;
                let who = self.trees.signal(&c.tree, libc::SIGKILL);
                if !who.is_empty() {
                    log(&format!("terminal {}: {} outlived SIGHUP and SIGTERM; SIGKILL", c.id, procs_text(&who)));
                    c.steps.push(("KILL", who));
                }
                stepped = true;
            }
        }
        if stepped {
            self.check_trees();
        }
    }

    /// Trees that have emptied: a close is done (reported), a leftover is gone.
    fn check_trees(&mut self) {
        let trees = &self.trees;
        let mut done = Vec::new();
        self.closing.retain(|c| {
            // A session's last SIGKILL is the end: the processes it reached are gone, and one that
            // left the session isn't the tree's.
            let over = !trees.populated(&c.tree) || (c.stage == 2 && !trees.is_cgroup());
            if over {
                done.push((c.handle, c.id.clone(), c.tree.clone(), c.steps.clone()));
            }
            !over
        });
        for (handle, id, tree, steps) in done {
            if let Tree::Leaf(l) = &tree {
                self.trees.remove_leaf(l);
            }
            let text: Vec<String> = steps
                .iter()
                .filter(|s| !s.1.is_empty())
                .map(|(sig, p)| format!("SIG{sig} → {}", procs_text(p)))
                .collect();
            log(&format!(
                "terminal {id} closed: {}",
                if text.is_empty() { "nothing was running".to_owned() } else { text.join("; ") }
            ));
            let steps: Vec<Value> = steps
                .iter()
                .map(|(sig, p)| json!({"signal": sig, "procs": p.iter().map(Proc::json).collect::<Vec<_>>()}))
                .collect();
            let msg = json!({"m": "killed", "handle": handle, "id": id, "at": ms_now(), "steps": steps});
            if let Some(b) = &mut self.brain {
                b.queue(msg, vec![]);
            }
        }
        let mut gone = Vec::new();
        self.leftovers.retain(|l| {
            let alive = trees.populated(&l.tree);
            if !alive {
                gone.push((l.handle, l.id.clone(), l.tree.clone()));
            }
            alive
        });
        for (handle, id, tree) in gone {
            if let Tree::Leaf(l) = &tree {
                self.trees.remove_leaf(l);
            }
            log(&format!("terminal {id}: what its program left running has ended"));
            if let Some(b) = &mut self.brain {
                b.queue(json!({"m": "leftover_gone", "handle": handle}), vec![]);
            }
        }
    }

    /// A terminal's program exited on its own: what it left running in its tree (a `nohup` job)
    /// keeps running, as a terminal leaves it, and is reported until it ends (with the namespace,
    /// at the latest).
    fn program_ended(&mut self, handle: u32, id: &str, pid: i32, tree: Tree) {
        let left = self.trees.members(&tree);
        if left.is_empty() {
            if let Tree::Leaf(l) = &tree {
                self.trees.remove_leaf(l);
            }
            return;
        }
        log(&format!("terminal {id}: its program ended, leaving {} running", procs_text(&left)));
        let since = ms_now();
        let msg = json!({"m": "leftover", "handle": handle, "id": id, "pid": pid, "tree": tree.json(), "since": since});
        for p in [&mut self.brain, &mut self.candidate].into_iter().flatten() {
            p.queue(msg.clone(), vec![]);
        }
        self.leftovers.push(Leftover { handle, id: id.to_owned(), pid, tree, since });
    }

    /// Watches a leaf's `cgroup.events`: it changes when the leaf empties.
    fn watch_leaf(&mut self, leaf: &str) {
        #[cfg(target_os = "linux")]
        if let (Some(ino), Some(dir)) = (&self.inotify, self.trees.leaf_dir(leaf)) {
            // The watch goes with the leaf when it is removed.
            if let Err(e) =
                rustix::fs::inotify::add_watch(ino, dir.join("cgroup.events"), rustix::fs::inotify::WatchFlags::MODIFY)
            {
                log(&format!("inotify on {}: {e}", dir.display()));
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = leaf;
    }

    /// inotify says leaves changed: check the trees.
    fn leaf_events(&mut self) {
        #[cfg(target_os = "linux")]
        if let Some(ino) = &self.inotify {
            let mut buf = [std::mem::MaybeUninit::<u8>::uninit(); 4096];
            let mut rd = rustix::fs::inotify::Reader::new(ino, &mut buf);
            while rd.next().is_ok() {}
        }
        self.check_trees();
    }

    /// The namespace is leaving: its name goes at once, before the shells are hung up and the
    /// brain has gone. The socket file is removed (a connect now finds nothing: `ENOENT`, the
    /// namespace is gone) and the lock released, so a client that wants a terminal can start a
    /// new daemon on the same name right away instead of meeting a socket that hangs and resets,
    /// and a start that says "another g3d-termd serves". What was already accepted finishes.
    fn leave_path(&mut self) {
        if self.lock.is_none() {
            return;
        }
        let _ = std::fs::remove_file(&self.cfg.socket);
        // Dropping the file closes it, which releases the flock; the lock file stays (a new
        // holder may already have opened it).
        self.lock = None;
    }
}
