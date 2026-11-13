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
    pub kill_grace: Duration,
    pub max_terminals: usize,
    /// Rotate the namespace's log past this many bytes (0 = never).
    pub log_max_bytes: u64,
}

fn die(msg: &str) -> ! {
    eprintln!("g3d-termd: {msg}");
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
    let (rd, wr) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC | rustix::pipe::PipeFlags::NONBLOCK)
        .unwrap_or_else(|e| die(&format!("signal pipe: {e}")));
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
    /// `kill` asked: when, the groups signalled, whether `SIGKILL` has followed.
    kill: Option<(Instant, Vec<i32>, bool)>,
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

struct Holder {
    cfg: Config,
    exe: PathBuf,
    listener: OwnedFd,
    lock: std::fs::File,
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
    /// Connections answered with `ERROR brain_failed`, lingering until the client closes or the
    /// deadline (`refused_linger`).
    refused: VecDeque<(OwnedFd, Instant)>,
    backoff: Duration,
    last_exit: String,
    /// The brain asked to end the namespace (idle exit, `stop`).
    exiting: Option<String>,
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
        crate::log::set_file(&cfg.log, cfg.log_max_bytes);
    }
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
    let max = cfg.max_terminals as u32;
    let mut h = Holder {
        exe,
        listener,
        lock,
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
        refused: VecDeque::new(),
        backoff: cfg.failed_backoff,
        last_exit: String::new(),
        exiting: None,
        shutdown_at: None,
        idle_since: None,
        restamped: Instant::now(),
        cfg,
    };
    h.run()
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
            if listening && fds.last().is_some_and(|f| f.revents & libc::POLLIN != 0) {
                self.refuse_connections();
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
        let mut at: Vec<Instant> = Vec::new();
        at.extend(self.restart_at);
        at.extend(self.failed.as_ref().map(|f| f.1));
        at.extend(self.refused.front().map(|r| r.1));
        at.extend(self.shutdown_at);
        at.extend(self.upgrade.as_ref().map(|u| u.deadline));
        for t in self.terms.values() {
            if let Some((when, _, false)) = &t.kill {
                at.push(*when + self.cfg.kill_grace);
            }
        }
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
        if self.restart_at.is_some_and(|t| now >= t) && self.brain.is_none() {
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
            self.finish("SIGTERM (the brain did not shut down in time)");
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
        let grace = self.cfg.kill_grace;
        for t in self.terms.values_mut() {
            if let Some((when, groups, escalated)) = &mut t.kill
                && !*escalated
                && now.duration_since(*when) >= grace
                && t.exit.is_none()
            {
                log(&format!("terminal {}: program outlived its hangup; SIGKILL", t.id));
                for g in groups.iter() {
                    // SAFETY: signalling a process group we started.
                    unsafe { libc::kill(-*g, libc::SIGKILL) };
                }
                *escalated = true;
            }
        }
        if now.duration_since(self.restamped) >= Duration::from_secs(3600) {
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
                self.finish(&format!("no terminals and no brain for {:?}", self.cfg.idle_exit));
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
                    match &mut self.brain {
                        Some(b) if b.hello => {
                            b.queue(json!({"m": "shutdown"}), vec![]);
                            self.shutdown_at = Some(Instant::now() + self.cfg.kill_grace + Duration::from_secs(2));
                        }
                        _ => self.finish("SIGTERM"),
                    }
                }
                _ => {}
            }
        }
    }

    // ── the brain ──────────────────────────────────────────────────────────────────────────

    fn fork_brain(&self, binary: &Path, candidate: bool) -> std::io::Result<Peer> {
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
        let (err_r, err_w) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)?;
        let (child_fd, err_fd, nofile) = (theirs.as_raw_fd(), err_w.as_raw_fd(), self.nofile);
        // SAFETY: one thread; the child makes only async-signal-safe calls before execv.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if pid == 0 {
            unsafe {
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
        let msg = json!({
            "m": "welcome", "hold": HOLD, "instance": self.instance,
            "generation": self.generation + 1, "holder_pid": std::process::id(),
            "holder_version": self.cfg.version, "started_at": self.started_at,
            "candidate": candidate, "max_terminals": self.cfg.max_terminals,
            "log": self.cfg.log.display().to_string(),
            "restarts": restarts.json(), "last_start": last_start,
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
                        // The asker learns why: only a new holder runs this brain, and the
                        // holder's re-exec (`g3d upgrade --holder`) is not built.
                        self.abort_upgrade(&format!(
                            "the candidate speaks hold protocol {theirs} and this holder {}.x; a new holder \
                             takes a namespace restart (g3d stop ends its shells)",
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
                if let Some(t) = self.terms.get_mut(&handle)
                    && t.exit.is_none()
                {
                    let mut groups = vec![t.pid];
                    if let Some(fg) = t.master.as_ref().and_then(|m| rustix::termios::tcgetpgrp(m).ok()) {
                        let fg = fg.as_raw_nonzero().get();
                        if fg != t.pid {
                            groups.push(fg);
                        }
                    }
                    for g in &groups {
                        // SAFETY: signalling process groups we started.
                        unsafe { libc::kill(-*g, sig) };
                    }
                    t.master = None;
                    t.kill = Some((Instant::now(), groups, false));
                }
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
                if self.upgrade.as_ref().is_some_and(|u| u.stage == Stage::Cutting) && self.candidate.is_some() {
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
        let (master, pid) = spawn::spawn(&plan, self.nofile).map_err(|e| e.to_string())?;
        self.free_slots.pop();
        let handle = self.next_handle;
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
                kill: None,
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
        log(&format!("upgrade: starting candidate {}", binary.display()));
        match self.fork_brain(&binary, true) {
            Ok(p) => {
                log(&format!("upgrade: candidate pid {}", p.pid));
                self.candidate = Some(p);
                self.upgrade =
                    Some(Upgrade { deadline: Instant::now() + self.cfg.upgrade_deadline, stage: Stage::Starting });
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
            if self.brain.as_ref().is_some_and(|b| b.pid == pid) {
                self.brain_exited(&text, status);
            } else if self.candidate.as_ref().is_some_and(|c| c.pid == pid) {
                self.candidate = None;
                if self.upgrade.is_some() {
                    self.abort_upgrade(&format!("the candidate exited ({text})"));
                } else {
                    log(&format!("upgrade: candidate pid {pid} ended ({text})"));
                }
            } else if let Some(t) = self.terms.values_mut().find(|t| t.pid == pid) {
                t.exit = Some(st.clone());
                let handle = t.handle;
                let (known, released) = (t.known, t.released);
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
        }
    }

    fn brain_exited(&mut self, text: &str, status: i32) {
        let old = self.brain.take().expect("a brain");
        let generation = self.generation;
        if let Some(why) = self.exiting.take() {
            self.finish(&why);
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
        if self.shutdown_at.is_some() {
            self.finish("SIGTERM");
        }
        let watchdog = old.aborted.is_some();
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
        if self.upgrade.is_some() {
            self.upgrade = None;
            if let Some(c) = self.candidate.take() {
                // SAFETY: our own child.
                unsafe { libc::kill(c.pid, libc::SIGKILL) };
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

    /// Ends the namespace: every program is hung up (SIGKILL after the grace), the brain and any
    /// candidate are killed, the socket is removed.
    fn finish(&mut self, why: &str) -> ! {
        log(&format!("exiting: {why}"));
        let mut groups = Vec::new();
        for t in self.terms.values_mut() {
            if t.exit.is_none() {
                groups.push(t.pid);
                if let Some(fg) = t.master.as_ref().and_then(|m| rustix::termios::tcgetpgrp(m).ok()) {
                    groups.push(fg.as_raw_nonzero().get());
                }
            }
            t.master = None;
        }
        for p in [&self.brain, &self.candidate].into_iter().flatten() {
            // SAFETY: our own children.
            unsafe { libc::kill(p.pid, libc::SIGKILL) };
        }
        for g in &groups {
            // SAFETY: process groups we started.
            unsafe { libc::kill(-*g, libc::SIGHUP) };
        }
        let until = Instant::now() + self.cfg.kill_grace;
        let pids: Vec<i32> = self.terms.values().filter(|t| t.exit.is_none()).map(|t| t.pid).collect();
        let alive = |pid: i32| {
            let mut st = 0;
            // SAFETY: reaping our own children.
            unsafe { libc::waitpid(pid, &mut st, libc::WNOHANG) == 0 }
        };
        let mut left: Vec<i32> = pids;
        while !left.is_empty() && Instant::now() < until {
            left.retain(|&p| alive(p));
            std::thread::sleep(Duration::from_millis(10));
        }
        for g in &groups {
            // SAFETY: as above.
            unsafe { libc::kill(-*g, libc::SIGKILL) };
        }
        let _ = std::fs::remove_file(&self.cfg.socket);
        let _ = &self.lock;
        std::process::exit(0);
    }
}
