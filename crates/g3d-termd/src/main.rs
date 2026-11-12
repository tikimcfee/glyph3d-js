//! g3d-termd: keeps terminals alive. Owns every terminal's PTY, program and libghostty-vt
//! emulator, and serves them over a Unix socket (docs/termd/PROTOCOL.md). One daemon per
//! namespace; it outlives its clients (docs/termd/DESIGN.md).
//!
//!   g3d-termd [--ns NAME | --socket PATH] [--daemon] [--idle-exit SECS]
//!             [--scrollback BYTES] [--max-scrollback BYTES]

mod out;
mod owner;
mod repaint;
mod server;
mod spawn;

use clap::Parser;
use rustix::fs::{FlockOperation, Mode, OFlags};
use std::io::{Read, Seek, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Parser)]
#[command(name = "g3d-termd", version, about = "The glyph3d terminal daemon")]
struct Args {
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
    idle_exit: u64,
    /// Default primary-screen scrollback per terminal, in bytes.
    #[arg(long, default_value_t = 2 << 20)]
    scrollback: u64,
    /// The most scrollback a create may ask for, in bytes.
    #[arg(long, default_value_t = 16 << 20)]
    max_scrollback: u64,
}

/// One log line on stderr (the log file, once daemonized).
pub fn log(msg: &str) {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    eprintln!("[termd {}.{:03}] {msg}", t.as_secs(), t.subsec_millis());
}

fn die(msg: &str) -> ! {
    eprintln!("g3d-termd: {msg}");
    std::process::exit(1);
}

fn ensure_private_dir(dir: &Path) {
    if !dir.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .unwrap_or_else(|e| die(&format!("create {}: {e}", dir.display())));
    }
}

/// Takes the namespace's lock (`<socket>.lock`) for the daemon's whole life.
fn take_lock(socket: &Path) -> std::fs::File {
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

fn write_pid(lock: &mut std::fs::File) {
    let _ = lock.set_len(0);
    let _ = lock.rewind();
    let _ = writeln!(lock, "{}", std::process::id());
}

/// Double-forks into the background (DESIGN.md, "Who starts it"). Runs before any thread
/// exists. The listener and lock fds survive; stdio goes to /dev/null and the log.
fn daemonize(log_path: &Path, keep: &[i32]) {
    // SAFETY: called from main before the runtime or any other thread starts, so fork is
    // safe; the children only make plain syscalls before continuing as the daemon.
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
        // Nothing the starter left open (a relay's sockets, a terminal) stays with us.
        for fd in 3..1024 {
            if !keep.contains(&fd) {
                libc::close(fd);
            }
        }
    }
}

fn main() {
    let args = Args::parse();
    let (ns, socket) = match (&args.ns, &args.socket) {
        (_, Some(p)) => {
            let abs = if p.is_absolute() { p.clone() } else { std::env::current_dir().unwrap_or_default().join(p) };
            let ns = abs
                .file_stem()
                .map(|s| s.to_string_lossy().trim_start_matches("termd-").to_owned())
                .unwrap_or_default();
            (ns, abs)
        }
        (ns, None) => {
            let ns = ns.clone().unwrap_or_else(|| g3d::paths::DEFAULT_NS.to_owned());
            g3d::paths::validate_name("namespace", &ns).unwrap_or_else(|m| die(&m));
            let path = g3d::paths::socket_path(&ns);
            (ns, path)
        }
    };
    let log_path = if args.socket.is_some() {
        PathBuf::from(format!("{}.log", socket.display()))
    } else {
        g3d::paths::log_path(&ns)
    };
    if let Some(dir) = socket.parent() {
        ensure_private_dir(dir);
    }
    if socket.as_os_str().len() > 100 {
        die(&format!("socket path {} is too long for a Unix socket", socket.display()));
    }

    let mut lock = take_lock(&socket);
    // We hold the lock, so a socket file left here is stale.
    let _ = std::fs::remove_file(&socket);
    let listener = std::os::unix::net::UnixListener::bind(&socket)
        .unwrap_or_else(|e| die(&format!("bind {}: {e}", socket.display())));
    let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));

    if args.daemon {
        daemonize(&log_path, &[listener.as_raw_fd(), lock.as_raw_fd()]);
    }
    write_pid(&mut lock);
    log(&format!(
        "g3d-termd {} (pid {}) serving namespace {ns:?} at {}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        socket.display()
    ));

    let reg = owner::Registry::new(owner::Config {
        ns,
        socket: socket.clone(),
        default_scrollback: args.scrollback.min(args.max_scrollback),
        max_scrollback: args.max_scrollback,
        test_hooks: std::env::var("G3D_TERMD_TEST_HOOKS").as_deref() == Ok("1"),
    });
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("termd-io")
        .enable_all()
        .build()
        .unwrap_or_else(|e| die(&format!("runtime: {e}")));
    rt.block_on(server::run(listener, reg, Duration::from_secs(args.idle_exit), socket));
    drop(lock);
}
