//! Where a namespace's socket and log live (docs/termd/DESIGN.md, "One daemon per
//! namespace"). The glyph3d relay (cli/termd.go) follows the same rule.
//!
//! - socket: `$G3D_TERMD_DIR/termd-<ns>.sock`, else `$XDG_RUNTIME_DIR/g3d/termd-<ns>.sock`,
//!   else `<temp>/g3d-<uid>/termd-<ns>.sock`
//! - log: `$G3D_TERMD_DIR/termd-<ns>.log`, else `$XDG_STATE_HOME/g3d/termd-<ns>.log`, else
//!   `~/.local/state/g3d/termd-<ns>.log`
//!
//! `G3D_TERMD_DIR` keeps a test's daemons, sockets and logs in its own scratch directory.

use std::path::PathBuf;

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

/// The directory sockets live in.
pub fn socket_dir() -> PathBuf {
    if let Some(d) = env_dir("G3D_TERMD_DIR") {
        return d;
    }
    if let Some(d) = env_dir("XDG_RUNTIME_DIR") {
        return d.join("g3d");
    }
    std::env::temp_dir().join(format!("g3d-{}", rustix::process::getuid().as_raw()))
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
