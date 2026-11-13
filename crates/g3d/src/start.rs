//! Reaching a namespace's daemon, starting it when none is running (DESIGN.md, "Who
//! starts it").

use crate::client::{Client, ClientError};
use crate::paths;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// Which daemon: a namespace (its socket by the paths rule) or an explicit socket path.
#[derive(Clone, Debug)]
pub enum Target {
    Ns(String),
    Socket(PathBuf),
}

impl Target {
    pub fn socket(&self) -> PathBuf {
        match self {
            Target::Ns(ns) => paths::socket_path(ns),
            Target::Socket(p) => p.clone(),
        }
    }

    fn termd_args(&self) -> Vec<String> {
        match self {
            Target::Ns(ns) => vec!["--ns".into(), ns.clone()],
            Target::Socket(p) => vec!["--socket".into(), p.display().to_string()],
        }
    }

    fn log(&self) -> PathBuf {
        match self {
            Target::Ns(ns) => paths::log_path(ns),
            Target::Socket(p) => PathBuf::from(format!("{}.log", p.display())),
        }
    }
}

/// `g3d-termd` next to this executable, else on `PATH`.
pub fn find_termd() -> Result<PathBuf, String> {
    let mut looked = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let p = dir.join("g3d-termd");
        if p.is_file() {
            return Ok(p);
        }
        looked.push(p.display().to_string());
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join("g3d-termd");
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    looked.push("$PATH".into());
    Err(format!("no g3d-termd binary (looked at {})", looked.join(", ")))
}

/// Connects to the target's daemon, without starting one.
pub fn connect(target: &Target, name: &str) -> Result<Client, ClientError> {
    Client::connect(&target.socket(), name)
}

fn not_running(e: &ClientError) -> bool {
    matches!(e, ClientError::Io(io) if matches!(io.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused))
}

/// Connects, starting the daemon (`g3d-termd <target> --daemon`) if nothing listens, then
/// retrying for up to 3 s. Fails loud with the daemon log's tail.
pub fn connect_or_start(target: &Target, name: &str, termd: Option<&Path>) -> Result<Client, String> {
    match connect(target, name) {
        Ok(c) => return Ok(c),
        Err(e) if not_running(&e) => {}
        Err(e) => return Err(format!("termd at {}: {e}", target.socket().display())),
    }
    let bin = match termd {
        Some(p) => p.to_path_buf(),
        None => find_termd()?,
    };
    let out = Command::new(&bin)
        .args(target.termd_args())
        .arg("--daemon")
        .output()
        .map_err(|e| format!("start {}: {e}", bin.display()))?;
    // A daemon that lost the race to another starter fails at the lock; the winner serves.
    let started_msg = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut wait = Duration::from_millis(20);
    loop {
        match connect(target, name) {
            Ok(c) => return Ok(c),
            Err(e) if not_running(&e) && Instant::now() < deadline => {
                std::thread::sleep(wait);
                wait = (wait * 2).min(Duration::from_millis(250));
            }
            Err(e) => {
                let log = target.log();
                let tail = std::fs::read_to_string(&log)
                    .map(|s| {
                        s.lines().rev().take(10).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
                    })
                    .unwrap_or_default();
                return Err(format!(
                    "termd did not come up at {} ({e}); {} exited {}{}; log {}:\n{tail}",
                    target.socket().display(),
                    bin.display(),
                    out.status,
                    if started_msg.is_empty() { String::new() } else { format!(": {started_msg}") },
                    log.display()
                ));
            }
        }
    }
}

/// How long a client rides a restart of termd's engine before giving up (DESIGN.md, "Riding a
/// restart": 30 s covers a crash restart and the first crash-loop retries).
pub const RECONNECT_WINDOW: Duration = Duration::from_secs(30);

/// Reconnects after a connection to the brain ended, by the one rule every client follows
/// (PROTOCOL.md "Restarts"): after `ERROR restart` (`planned`) at once, with up to 100 ms of
/// jitter; after a dropped connection with backoff, 100 ms doubling to 2 s; for up to `window`.
/// Nothing listening means the namespace is gone; a different `instance` is a new namespace.
/// Both end the ride (`Err`, a sentence for a person). The caller re-subscribes by id.
pub fn reconnect(
    target: &Target,
    name: &str,
    planned: bool,
    instance: Option<&str>,
    window: Duration,
) -> Result<Client, String> {
    let until = Instant::now() + window;
    let jitter = Duration::from_nanos(
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos() as u64)
            % 100_000_000,
    );
    let mut wait = if planned { jitter } else { Duration::from_millis(100) };
    loop {
        std::thread::sleep(wait);
        match connect(target, name) {
            Ok(c) if instance.is_some() && c.welcome.instance.as_deref() != instance => {
                return Err("a different namespace answers: the terminals this followed are gone".into());
            }
            Ok(c) => return Ok(c),
            Err(e) if not_running(&e) => {
                return Err("nothing listens any more: the namespace and its terminals are gone".into());
            }
            Err(e) if Instant::now() >= until => return Err(format!("no termd engine answered for {window:?}: {e}")),
            Err(_) => {}
        }
        wait = (wait * 2).clamp(Duration::from_millis(100), Duration::from_secs(2));
    }
}
