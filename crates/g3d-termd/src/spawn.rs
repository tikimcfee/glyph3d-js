//! Starting a program on a new PTY (DESIGN.md, "Spawning a terminal").

use rustix::fd::{AsFd, BorrowedFd, OwnedFd};
use rustix::fs::{Mode, OFlags};
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{Winsize, tcsetwinsize};
use std::collections::BTreeMap;
use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

pub struct Spawned {
    pub master: OwnedFd,
    pub child: Child,
}

pub struct SpawnArgs<'a> {
    pub argv: &'a [String],
    pub cwd: Option<&'a str>,
    /// Set (`Some`) or removed (`None`), after the daemon's own environment.
    pub env: Vec<(String, Option<String>)>,
    pub cols: u16,
    pub rows: u16,
}

pub fn winsize(cols: u16, rows: u16) -> Winsize {
    Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 }
}

/// Opens a PTY at the given size and starts `argv` on it as a session leader whose
/// controlling terminal is the PTY. Returns the non-blocking master and the child.
pub fn spawn(a: &SpawnArgs) -> io::Result<Spawned> {
    let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC)?;
    grantpt(&master)?;
    unlockpt(&master)?;
    let name = ptsname(&master, Vec::new())?;
    let slave = rustix::fs::open(name.as_c_str(), OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC, Mode::empty())?;
    tcsetwinsize(&master, winsize(a.cols, a.rows))?;

    let mut cmd = Command::new(&a.argv[0]);
    cmd.args(&a.argv[1..])
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    for (k, v) in &a.env {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    if let Some(dir) = a.cwd {
        cmd.current_dir(dir);
    }
    // SAFETY: runs in the child between fork and exec; setsid and the TIOCSCTTY ioctl are
    // async-signal-safe raw syscalls and allocate nothing. std has already put the slave
    // on fds 0/1/2 and reset the signal mask.
    unsafe {
        cmd.pre_exec(|| {
            rustix::process::setsid()?;
            rustix::process::ioctl_tiocsctty(BorrowedFd::borrow_raw(0))?;
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    rustix::fs::fcntl_setfl(master.as_fd(), OFlags::NONBLOCK)?;
    Ok(Spawned { master, child })
}

/// The environment PROTOCOL.md specifies, on top of the daemon's own: `TERM`,
/// `COLORTERM`, `G3D_TERMD_ID`, `G3D_TERMD_SOCKET`, no `TMUX`/`TMUX_PANE`, then the
/// request's own `env`.
pub fn child_env(
    id: &str,
    socket: &str,
    user: Option<&BTreeMap<String, Option<String>>>,
) -> Vec<(String, Option<String>)> {
    let mut env: Vec<(String, Option<String>)> = vec![
        ("TERM".into(), Some("xterm-256color".into())),
        ("COLORTERM".into(), Some("truecolor".into())),
        ("G3D_TERMD_ID".into(), Some(id.into())),
        ("G3D_TERMD_SOCKET".into(), Some(socket.into())),
        ("TMUX".into(), None),
        ("TMUX_PANE".into(), None),
    ];
    if let Some(u) = user {
        env.extend(u.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    env
}

/// A signal's name without `SIG`.
pub fn signal_name(sig: i32) -> String {
    let name = match sig {
        libc::SIGHUP => "HUP",
        libc::SIGINT => "INT",
        libc::SIGQUIT => "QUIT",
        libc::SIGILL => "ILL",
        libc::SIGTRAP => "TRAP",
        libc::SIGABRT => "ABRT",
        libc::SIGBUS => "BUS",
        libc::SIGFPE => "FPE",
        libc::SIGKILL => "KILL",
        libc::SIGUSR1 => "USR1",
        libc::SIGSEGV => "SEGV",
        libc::SIGUSR2 => "USR2",
        libc::SIGPIPE => "PIPE",
        libc::SIGALRM => "ALRM",
        libc::SIGTERM => "TERM",
        libc::SIGCHLD => "CHLD",
        libc::SIGCONT => "CONT",
        libc::SIGSTOP => "STOP",
        libc::SIGTSTP => "TSTP",
        libc::SIGTTIN => "TTIN",
        libc::SIGTTOU => "TTOU",
        libc::SIGXCPU => "XCPU",
        libc::SIGXFSZ => "XFSZ",
        libc::SIGWINCH => "WINCH",
        _ => return sig.to_string(),
    };
    name.to_owned()
}
