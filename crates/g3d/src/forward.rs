//! What `g3d new` forwards from the shell it runs in (DESIGN.md, "SSH agent, display and bus
//! variables"): only inside a live SSH login, the way tmux's `update-environment` does it.

use rustix::fs::Dev;
use std::collections::BTreeMap;
use std::os::fd::AsFd;

/// The default list: tmux's `update-environment` default, less `MSYSTEM` (Windows'), `WINDOWID`
/// (the outer terminal's own window) and the `XDG_*` desktop names (the session has them), plus
/// `SSH_CLIENT`, `SSH_CONNECTION`'s older twin, so "am I remote" checks agree.
pub const FORWARD_ENV: &str = "SSH_AUTH_SOCK,SSH_AGENT_PID,SSH_CONNECTION,SSH_CLIENT,SSH_ASKPASS,KRB5CCNAME,\
DISPLAY,WAYLAND_DISPLAY,XAUTHORITY";

/// Whether a process with `SSH_CONNECTION` set runs in that SSH login now, or only below a
/// process that once did (a tmux server started from SSH keeps it in every pane, long after the
/// login and its agent socket and display are gone):
/// - on a terminal (any of fds 0–2 is one): only when it is the login's own, `SSH_TTY`;
/// - on no terminal at all (no controlling terminal: `ssh host cmd`): yes;
/// - with a controlling terminal but fds 0–2 redirected: it can't be told, so no (the session's
///   fresh values are the safe side).
pub fn decide(std_ttys: &[Dev], ssh_tty: Option<Dev>, has_ctty: bool) -> bool {
    if !std_ttys.is_empty() {
        return ssh_tty.is_some_and(|t| std_ttys.contains(&t));
    }
    !has_ctty
}

fn rdev_of(fd: impl AsFd) -> Option<Dev> {
    rustix::fs::fstat(fd).ok().map(|st| st.st_rdev)
}

/// [`decide`] for this process.
pub fn in_ssh_login() -> bool {
    if std::env::var_os("SSH_CONNECTION").is_none_or(|v| v.is_empty()) {
        return false;
    }
    let std_ttys: Vec<Dev> = [std::io::stdin().as_fd(), std::io::stdout().as_fd(), std::io::stderr().as_fd()]
        .into_iter()
        .filter(|fd| rustix::termios::isatty(fd))
        .filter_map(rdev_of)
        .collect();
    let ssh_tty = std::env::var_os("SSH_TTY")
        .filter(|v| !v.is_empty())
        .and_then(|p| rustix::fs::stat(std::path::Path::new(&p)).ok())
        .map(|st| st.st_rdev);
    let has_ctty = rustix::fs::open(
        "/dev/tty",
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NOCTTY | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )
    .is_ok();
    decide(&std_ttys, ssh_tty, has_ctty)
}

/// The request's `env` for `list` (comma-separated names): inside a live SSH login, each name's
/// value here, and a removal for each name unset here (tmux's rule: a display the login doesn't
/// have must not come from the session); outside one, nothing (the session's values are fresh).
pub fn forwarded(list: &str, in_ssh: bool, get: impl Fn(&str) -> Option<String>) -> BTreeMap<String, Option<String>> {
    if !in_ssh {
        return BTreeMap::new();
    }
    list.split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(|k| (k.to_owned(), get(k).filter(|v| !v.is_empty())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_login_is_the_terminal_ssh_gave_or_none() {
        // In the login's own terminal.
        assert!(decide(&[34816, 34816], Some(34816), true));
        // In a tmux pane below an old login: another terminal.
        assert!(!decide(&[34820], Some(34816), true));
        assert!(!decide(&[34820], None, true));
        // `ssh host cmd`: no terminal at all.
        assert!(decide(&[], None, false));
        // Redirected, with a controlling terminal: can't tell, so no.
        assert!(!decide(&[], Some(34816), true));
    }

    #[test]
    fn a_name_unset_in_the_login_is_removed() {
        let get = |k: &str| match k {
            "SSH_AUTH_SOCK" => Some("/tmp/ssh-x/agent.1".to_owned()),
            "DISPLAY" => Some(String::new()),
            _ => None,
        };
        let f = forwarded("SSH_AUTH_SOCK, DISPLAY,XAUTHORITY,", true, get);
        assert_eq!(f.get("SSH_AUTH_SOCK"), Some(&Some("/tmp/ssh-x/agent.1".to_owned())));
        assert_eq!(f.get("DISPLAY"), Some(&None));
        assert_eq!(f.get("XAUTHORITY"), Some(&None));
        assert_eq!(f.len(), 3);
        assert!(forwarded("SSH_AUTH_SOCK", false, get).is_empty());
        assert!(forwarded("", true, get).is_empty());
    }
}
