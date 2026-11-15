//! `g3d-termd --daemon` on Linux: the namespace runs as a transient systemd user service, started
//! by `systemd-run --user` (DESIGN.md, "Process trees"). The service manager is what a per-user
//! daemon that owns processes normally runs under (shpool ships a user unit; Ghostty runs as one
//! and puts each surface in a scope), and it gives termd two things a double fork can't:
//!
//! - **its own cgroup, delegated** (`Delegate=yes`): each terminal's tree is a leaf of it
//!   (g3d-hold's tree.rs), so a close reaches everything a program started, however it forked;
//! - **the holder's death ends the trees**: the holder is the service's main process, so when it
//!   dies (a `SIGKILL` included) the manager stops the unit and ends every process left in its
//!   cgroup (`KillMode=control-group`: `SIGTERM` with `SendSIGHUP=yes`'s `SIGHUP` right after, then
//!   `SIGKILL` after `TimeoutStopSec=`, which is `--kill-grace`): no shell outlives its holder.
//!
//! When there is no user manager to ask (a container, a session without logind, `--cgroups off`),
//! or it doesn't start the unit within `--service-start-timeout-ms`, `--daemon` double-forks as it
//! always has and each terminal's session is its tree.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Starts the holder as a transient user service and returns once the manager has started it
/// (`Type=exec`: its binary is running), or why it didn't.
pub fn start(args: &crate::Args, ns: Option<&str>, socket: &Path, log: &Path) -> Result<(), String> {
    let run = ["/usr/bin/systemd-run", "/bin/systemd-run"]
        .iter()
        .map(Path::new)
        .find(|p| p.is_file())
        .map(Path::to_path_buf)
        .or_else(|| {
            std::env::var_os("PATH")
                .and_then(|p| std::env::split_paths(&p).map(|d| d.join("systemd-run")).find(|c| c.is_file()))
        })
        .ok_or("no systemd-run")?;
    let exe = std::env::current_exe().map_err(|e| format!("its own executable: {e}"))?;
    // The log exists, private, before the manager appends to it.
    if let Some(dir) = log.parent() {
        use std::os::unix::fs::DirBuilderExt;
        let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir);
    }
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(log)
            .map_err(|e| format!("{}: {e}", log.display()))?;
    }
    let unit = unit_name(ns, socket);
    let mut cmd = Command::new(&run);
    cmd.args(["--user", "--quiet", "--collect", "--unit", &unit])
        .arg(format!(
            "--description=g3d-termd {}",
            ns.map_or_else(|| socket.display().to_string(), |n| format!("namespace {n}"))
        ))
        .args(["--property=Type=exec", "--property=Delegate=yes", "--property=KillMode=control-group"])
        .arg("--property=SendSIGHUP=yes")
        .arg(format!("--property=TimeoutStopSec={}s", args.kill_grace.max(1)))
        .arg(format!("--property=StandardOutput=append:{}", log.display()))
        .arg(format!("--property=StandardError=append:{}", log.display()));
    // The holder's environment is its starter's, as after a fork (the brain composes each
    // terminal's from it by the policy, DESIGN.md "Environment"); a name systemd can't carry is
    // left out, as `g3d new` leaves it out of a create.
    for (k, _) in std::env::vars_os() {
        if let Some(k) = k.to_str()
            && !k.is_empty()
            && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && !k.as_bytes()[0].is_ascii_digit()
        {
            cmd.arg(format!("--setenv={k}"));
        }
    }
    cmd.arg("--").arg(&exe);
    let mut it = std::env::args_os().skip(1);
    while let Some(a) = it.next() {
        if a == "--daemon" || a.to_string_lossy().starts_with("--socket=") {
            continue;
        }
        if a == "--socket" {
            it.next();
            continue;
        }
        cmd.arg(a);
    }
    if ns.is_none() {
        cmd.arg("--socket").arg(socket);
    }
    cmd.args(["--systemd-unit", &unit]);
    // The user manager's bus, found from the uid as busctl's is (env.rs): a starter without
    // XDG_RUNTIME_DIR (env -i, cron) reaches it all the same.
    if let Some(dir) = g3d::paths::user_runtime_dir() {
        cmd.env("XDG_RUNTIME_DIR", dir).env_remove("DBUS_SESSION_BUS_ADDRESS");
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("{}: {e}", run.display()))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(Duration::from_millis(args.service_start_timeout_ms)) {
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => Err(format!(
            "systemd-run {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim().replace('\n', "; ")
        )),
        Ok(Err(e)) => Err(format!("systemd-run: {e}")),
        Err(_) => {
            // SAFETY: the systemd-run this function started.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            Err(format!("the user manager didn't start {unit} within {} ms", args.service_start_timeout_ms))
        }
    }
}

/// `g3d-termd-<ns>-<pid>.service`, or for an explicit socket its path's hash: unique per start,
/// so a unit still being stopped after a holder's death never blocks the next one.
fn unit_name(ns: Option<&str>, socket: &Path) -> String {
    let id = match ns {
        Some(n) => n.to_owned(),
        None => {
            // FNV-1a: a short stable name for a path.
            let h = socket
                .as_os_str()
                .as_encoded_bytes()
                .iter()
                .fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3));
            format!("sock-{:08x}", h as u32)
        }
    };
    format!("g3d-termd-{id}-{}.service", std::process::id())
}
