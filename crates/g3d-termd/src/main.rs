//! g3d-termd: keeps terminals alive (docs/termd/DESIGN.md, PROTOCOL.md). One binary, two roles:
//!
//! - `g3d-termd [--ns NAME | --socket PATH] [--daemon] …` is the namespace's **holder**
//!   (crates/g3d-hold): the shells' parent, keeper of their PTY fds and the snapshot store. It
//!   starts the brain itself and restarts it after a crash.
//! - `g3d-termd --brain --hold-fd N …` is the **brain**: one libghostty-vt emulator per terminal
//!   on its owner thread, and the socket protocol. Never started by hand.
//!
//! Every holder flag is passed on to the brain it starts, so both read one set of settings.

mod blob;
mod env;
mod hold;
mod keys;
mod mouse;
mod out;
mod owner;
mod paste;
mod repaint;
mod server;
mod spawn;
mod status;

use clap::Parser;
use std::path::PathBuf;
use std::time::Duration;

pub const VERSION: &str = concat!("g3d-termd/", env!("CARGO_PKG_VERSION"));

#[derive(Parser, Clone)]
#[command(name = "g3d-termd", version, about = "The glyph3d terminal daemon")]
pub struct Args {
    /// The namespace: its socket is <runtime dir>/g3d/termd-<ns>.sock.
    #[arg(long)]
    ns: Option<String>,
    /// An explicit socket path instead of a namespace's.
    #[arg(long, conflicts_with = "ns")]
    socket: Option<PathBuf>,
    /// Detach from the terminal and run in the background, logging to the namespace's log.
    #[arg(long)]
    daemon: bool,
    /// Exit after this many seconds with no terminals and no connections (0 = never).
    #[arg(long, default_value_t = 300)]
    pub idle_exit: u64,
    /// Default primary-screen scrollback per terminal, in bytes (Ghostty's scrollback-limit).
    #[arg(long, default_value_t = 10_000_000)]
    pub scrollback: u64,
    /// The most scrollback a create may ask for, in bytes.
    #[arg(long, default_value_t = 64 << 20)]
    pub max_scrollback: u64,
    /// Input a terminal's program hasn't read yet, per terminal, in bytes; a whole INPUT frame
    /// past it is refused.
    #[arg(long, default_value_t = 16 << 20)]
    pub input_buffer: usize,
    /// A lossy subscriber's queue past this many bytes is dropped and resynced.
    #[arg(long, default_value_t = 4 << 20)]
    pub lossy_queue: usize,
    /// A blocking owner's queue past this many bytes pauses the terminal's output...
    #[arg(long, default_value_t = 1 << 20)]
    pub block_high: usize,
    /// ...until it drains below this many.
    #[arg(long, default_value_t = 256 << 10)]
    pub block_low: usize,
    /// Where a terminal whose creator sends no environment looks the session's variables up: the
    /// platform's session source (auto: the systemd user manager, launchd), each name it lacks
    /// from the daemon's start values; or only those (daemon: hermetic, for tests).
    #[arg(long, value_enum, default_value_t = env::SessionSource::Auto, env = "G3D_TERMD_ENV_SOURCE")]
    pub env_source: env::SessionSource,
    /// How long to wait for the session source, in milliseconds.
    #[arg(long, default_value_t = 1000)]
    pub env_manager_timeout_ms: u64,
    /// Also remove these variables (NAME, or PREFIX*) from every base environment. Repeatable.
    #[arg(long, value_name = "NAME")]
    pub env_scrub: Vec<String>,
    /// The termd.toml to read (default: $XDG_CONFIG_HOME/g3d/termd.toml, the session's
    /// XDG_CONFIG_HOME, else ~/.config from passwd). Re-read on create when it changes.
    #[arg(long, value_name = "PATH", env = "G3D_TERMD_CONFIG")]
    pub config: Option<PathBuf>,
    /// The shell a terminal with no argv runs, for every terminal (default: the passwd entry's).
    #[arg(long)]
    pub shell: Option<String>,
    /// Start that shell as a login shell (argv[0] "-<name>").
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    pub login_shell: bool,
    /// Set LANG to a UTF-8 locale the system has when a terminal's environment sets no locale.
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    pub fill_locale: bool,
    /// TERM for every terminal, and the terminfo name its emulator answers with.
    #[arg(long, default_value = "xterm-256color")]
    pub term: String,
    /// Rotate the daemon's log past this many bytes, keeping one previous file (.1); 0 = never.
    #[arg(long, default_value_t = 10 << 20)]
    pub log_max_bytes: u64,
    /// How often a terminal with new output saves a crash snapshot, in milliseconds (0 = never).
    #[arg(long, default_value_t = 2000)]
    pub snapshot_interval_ms: u64,
    /// After a brain crash, wait this long before starting the next (systemd's RestartSec).
    #[arg(long, default_value_t = 100)]
    brain_restart_delay_ms: u64,
    /// At most this many brain starts within --brain-start-interval; past it the brain is failed.
    #[arg(long, default_value_t = 5)]
    brain_start_burst: usize,
    /// The window --brain-start-burst counts in, in seconds.
    #[arg(long, default_value_t = 10)]
    brain_start_interval: u64,
    /// A failed brain is retried after this many seconds, doubling...
    #[arg(long, default_value_t = 30)]
    brain_failed_backoff: u64,
    /// ...to at most this many.
    #[arg(long, default_value_t = 600)]
    brain_failed_backoff_max: u64,
    /// While the brain is failed, a refused connection stays open this long after its ERROR, its
    /// input discarded, so a client's HELLO write succeeds and its read finds the ERROR, in ms.
    #[arg(long, default_value_t = 2000)]
    brain_failed_linger_ms: u64,
    /// At most this many refused connections linger at once; past it the oldest is closed.
    #[arg(long, default_value_t = 64)]
    brain_failed_linger_max: usize,
    /// Abort a brain that sends the holder nothing for this many seconds (0 = off).
    #[arg(long, default_value_t = 30)]
    pub brain_watchdog: u64,
    /// A candidate brain must be ready within this many seconds or the upgrade fails.
    #[arg(long, default_value_t = 10)]
    pub upgrade_deadline: u64,
    /// After `kill`'s signal, SIGKILL a program still running this many seconds later.
    #[arg(long, default_value_t = 2)]
    pub kill_grace: u64,
    /// The most terminals one namespace holds (the size of the seq_marks page).
    #[arg(long, default_value_t = 8192)]
    max_terminals: usize,
    /// The brain's oom_score_adj above the holder's (Linux).
    #[arg(long, default_value_t = 300)]
    pub brain_oom_score_adj: i32,
    /// A status follower that names no interval gets a document at most this often, in ms.
    #[arg(long, default_value_t = 1000)]
    pub status_interval_ms: u64,
    /// The shortest interval a status follower may ask for, in ms.
    #[arg(long, default_value_t = 250)]
    pub status_min_interval_ms: u64,
    /// The longest interval a status follower may ask for, in ms.
    #[arg(long, default_value_t = 60_000)]
    pub status_max_interval_ms: u64,
    /// With nothing changing, a status follower still gets a document this often, in ms.
    #[arg(long, default_value_t = 30_000)]
    pub status_keepalive_ms: u64,
    /// A terminal's output and input rates are bytes over this window, in ms.
    #[arg(long, default_value_t = 5_000)]
    pub status_rate_window_ms: u64,
    /// The status document keeps this many distinct recent errors.
    #[arg(long, default_value_t = 32)]
    pub status_errors: usize,
    /// Internal: run as the brain on this hold-link fd.
    #[arg(long, hide = true)]
    brain: bool,
    #[arg(long, hide = true, requires = "brain")]
    hold_fd: Option<i32>,
    /// Internal: this brain is an upgrade's candidate.
    #[arg(long, hide = true, requires = "brain")]
    pub candidate: bool,
}

/// The test hooks (owner.rs, server.rs, env.rs) exist only in a build with the `test-hooks`
/// feature, which only the tests turn on, and are armed only with `G3D_TERMD_TEST_HOOKS=1`.
#[cfg(feature = "test-hooks")]
pub fn test_hooks_armed() -> bool {
    std::env::var("G3D_TERMD_TEST_HOOKS").as_deref() == Ok("1")
}

#[cfg(not(feature = "test-hooks"))]
pub const fn test_hooks_armed() -> bool {
    false
}

/// One log line (the namespace's log once daemonized).
pub fn log(msg: &str) {
    g3d_hold::log::log(msg);
}

fn die(msg: &str) -> ! {
    // Not eprintln!: it panics on an unwritable stderr, and the exit below must happen.
    let _ = std::io::Write::write_all(&mut std::io::stderr(), format!("g3d-termd: {msg}\n").as_bytes());
    std::process::exit(1);
}

/// The namespace (when not an explicit socket), the socket and the log.
fn paths(args: &Args) -> (Option<String>, PathBuf, PathBuf) {
    let (ns, socket) = match (&args.ns, &args.socket) {
        (_, Some(p)) => {
            let abs = if p.is_absolute() { p.clone() } else { std::env::current_dir().unwrap_or_default().join(p) };
            (None, abs)
        }
        (ns, None) => {
            let ns = ns.clone().unwrap_or_else(|| g3d::paths::DEFAULT_NS.to_owned());
            g3d::paths::validate_name("namespace", &ns).unwrap_or_else(|m| die(&m));
            let path = g3d::paths::socket_path(&ns);
            (Some(ns), path)
        }
    };
    let log = match &ns {
        Some(ns) => g3d::paths::log_path(ns),
        None => PathBuf::from(format!("{}.log", socket.display())),
    };
    (ns, socket, log)
}

/// Settings that are wrong whatever the moment: refused before anything starts.
fn check(args: &Args) {
    if let Some(sh) = &args.shell {
        use std::os::unix::fs::PermissionsExt;
        let ok = sh.starts_with('/')
            && std::fs::metadata(sh).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
        if !ok {
            die(&format!("--shell {sh:?} is not an absolute path to an executable"));
        }
    }
    if args.term.is_empty() || !args.term.bytes().all(|b| b.is_ascii_graphic()) {
        die(&format!("--term {:?} is not a terminal name", args.term));
    }
    if let Some(c) = &args.config
        && !c.is_absolute()
    {
        die(&format!("--config {} is not an absolute path", c.display()));
    }
    if args.block_low >= args.block_high {
        die("--block-low must be below --block-high");
    }
}

fn main() {
    let args = Args::parse();
    check(&args);
    let (ns, socket, log_path) = paths(&args);
    if args.brain {
        let fd = args.hold_fd.unwrap_or_else(|| die("--brain needs --hold-fd"));
        server::brain(args.clone(), fd, ns, socket, log_path);
    }
    // The holder. Every brain gets the same flags (an explicit socket made absolute, so a brain
    // started from "/" after daemonizing finds it), minus --daemon.
    let mut brain_args = Vec::new();
    let mut it = std::env::args_os().skip(1);
    while let Some(a) = it.next() {
        if a == "--daemon" || a.to_string_lossy().starts_with("--socket=") {
            continue;
        }
        if a == "--socket" {
            it.next();
            continue;
        }
        brain_args.push(a);
    }
    if args.socket.is_some() {
        brain_args.push("--socket".into());
        brain_args.push(socket.clone().into_os_string());
    }
    let s = Duration::from_secs;
    g3d_hold::run(g3d_hold::Config {
        ns,
        socket,
        log: log_path,
        daemon: args.daemon,
        version: VERSION.to_owned(),
        brain_args,
        idle_exit: s(args.idle_exit),
        restart_delay: Duration::from_millis(args.brain_restart_delay_ms),
        start_burst: args.brain_start_burst.max(1),
        start_interval: s(args.brain_start_interval),
        failed_backoff: s(args.brain_failed_backoff.max(1)),
        failed_backoff_max: s(args.brain_failed_backoff_max.max(args.brain_failed_backoff.max(1))),
        refused_linger: Duration::from_millis(args.brain_failed_linger_ms),
        refused_max: args.brain_failed_linger_max,
        watchdog: s(args.brain_watchdog),
        upgrade_deadline: s(args.upgrade_deadline.max(1)),
        kill_grace: s(args.kill_grace),
        max_terminals: args.max_terminals.max(1),
        log_max_bytes: args.log_max_bytes,
    });
}
