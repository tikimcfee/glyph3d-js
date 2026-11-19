//! Where a namespace's socket and log live (docs/termd/DESIGN.md, "One daemon per
//! namespace"). The glyph3d relay (cli/termd.go) follows the same rule.
//!
//! - socket: `$G3D_TERMD_DIR/termd-<ns>.sock`, else `/run/user/<uid>/g3d/termd-<ns>.sock` when
//!   that runtime directory is the user's, else `/tmp/g3d-<uid>/termd-<ns>.sock`. Found from the
//!   uid, never from `$XDG_RUNTIME_DIR` or `$TMPDIR`: a relay or daemon started from a stripped
//!   environment (`env -i`, cron, a service manager) must find the socket the desktop's `g3d`
//!   finds, as tmux's `/tmp/tmux-<uid>` doesn't vary with the session either.
//! - log: `$G3D_TERMD_DIR/termd-<ns>.log`, else `$XDG_STATE_HOME/g3d/termd-<ns>.log`, else
//!   `~/.local/state/g3d/termd-<ns>.log`
//!
//! `G3D_TERMD_DIR` keeps a test's daemons, sockets and logs in its own scratch directory.

use std::path::{Path, PathBuf};

pub const DEFAULT_NS: &str = "default";

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Checks a namespace name: 1 to 64 bytes of `[A-Za-z0-9._-]`, like a terminal id.
pub fn validate_name(what: &str, name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok { Ok(()) } else { Err(format!("{what} {name:?} must be 1 to 64 bytes of [A-Za-z0-9._-]")) }
}

fn is_owned_private_dir(dir: &Path, uid: u32) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let Ok(m) = std::fs::symlink_metadata(dir) else {
        return false;
    };
    m.file_type().is_dir() && m.uid() == uid && m.permissions().mode() & 0o077 == 0
}

/// logind's (pam_systemd's) runtime directory for this user, `/run/user/<uid>`, when it exists and
/// is this user's alone (owned, nothing for group or others): found from the uid, never from
/// `$XDG_RUNTIME_DIR`, so a client or daemon started from a stripped environment (`env -i`, cron,
/// a service manager) finds what the desktop's do.
pub fn user_runtime_dir() -> Option<PathBuf> {
    let uid = rustix::process::getuid().as_raw();
    let dir = PathBuf::from(format!("/run/user/{uid}"));
    is_owned_private_dir(&dir, uid).then_some(dir)
}

/// The directory sockets live in: `$G3D_TERMD_DIR` (an explicit choice, as tmux's
/// `TMUX_TMPDIR`), else [`socket_dir_for`] this user.
pub fn socket_dir() -> PathBuf {
    env_dir("G3D_TERMD_DIR").unwrap_or_else(|| socket_dir_for(user_runtime_dir(), rustix::process::getuid().as_raw()))
}

/// The rule without the override: the user's runtime directory's `g3d`, else `/tmp/g3d-<uid>`.
pub fn socket_dir_for(runtime: Option<PathBuf>, uid: u32) -> PathBuf {
    runtime.map(|d| d.join("g3d")).unwrap_or_else(|| PathBuf::from(format!("/tmp/g3d-{uid}")))
}

/// The socket of namespace `ns`.
pub fn socket_path(ns: &str) -> PathBuf {
    socket_dir().join(format!("termd-{ns}.sock"))
}

/// The daemon log of namespace `ns`.
pub fn log_path(ns: &str) -> PathBuf {
    let dir = env_dir("G3D_TERMD_DIR")
        .or_else(|| env_dir("XDG_STATE_HOME").map(|d| d.join("g3d")))
        .or_else(|| env_dir("HOME").map(|h| h.join(".local/state/g3d")))
        .unwrap_or_else(socket_dir);
    dir.join(format!("termd-{ns}.log"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_directory_comes_from_the_uid() {
        assert_eq!(socket_dir_for(Some("/run/user/1000".into()), 1000), PathBuf::from("/run/user/1000/g3d"));
        assert_eq!(socket_dir_for(None, 501), PathBuf::from("/tmp/g3d-501"));
    }

    #[test]
    fn runtime_dir_must_be_real_0700_dir_owned_by_uid() {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let uid = rustix::process::getuid().as_raw();
        let base = std::env::temp_dir().join(format!("g3d-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&base).unwrap();

        let ok = base.join("ok");
        std::fs::DirBuilder::new().mode(0o700).create(&ok).unwrap();
        assert!(is_owned_private_dir(&ok, uid));
        assert!(!is_owned_private_dir(&ok, uid.wrapping_add(1)));

        let link = base.join("link");
        std::os::unix::fs::symlink(&ok, &link).unwrap();
        assert!(!is_owned_private_dir(&link, uid));

        let open = base.join("open");
        std::fs::DirBuilder::new().mode(0o700).create(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!is_owned_private_dir(&open, uid));

        let _ = std::fs::remove_dir_all(&base);
    }
}
