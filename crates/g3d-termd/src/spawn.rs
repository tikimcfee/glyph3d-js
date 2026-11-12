//! What a terminal's program is started with. The holder starts it (crates/g3d-hold, DESIGN.md
//! "Spawning a terminal"); the brain decides the environment it gets.

use std::collections::BTreeMap;

pub fn winsize(cols: u16, rows: u16) -> rustix::termios::Winsize {
    rustix::termios::Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 }
}

/// The program's whole environment: the daemon's own, then `TERM`, `COLORTERM`, `G3D_TERMD_ID`,
/// `G3D_TERMD_SOCKET`, without `TMUX`/`TMUX_PANE`, then the request's own `env` (`None` removes).
pub fn child_env(id: &str, socket: &str, user: Option<&BTreeMap<String, Option<String>>>) -> Vec<(String, String)> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    for k in
        ["TMUX", "TMUX_PANE", "G3D_TERMD_TEST_HOOKS", "G3D_TERMD_TEST_BRAIN_FAIL_FILE", "G3D_TERMD_TEST_ENGINE_FILE"]
    {
        env.remove(k);
    }
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.insert("G3D_TERMD_ID".into(), id.into());
    env.insert("G3D_TERMD_SOCKET".into(), socket.into());
    if let Some(u) = user {
        for (k, v) in u {
            match v {
                Some(v) => env.insert(k.clone(), v.clone()),
                None => env.remove(k),
            };
        }
    }
    env.into_iter().collect()
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
