//! Log lines, shared by the holder and the brain (they write one file):
//! `2026-11-12T15:25:13.751-06:00 holder[1230122] message` (DESIGN.md, "Defaults", log line).
//!
//! Rotation (a daemonized namespace's log only): past `--log-max-bytes` the holder renames the
//! log to `<log>.1` (replacing the previous one) and reopens it on stdout and stderr; the brain,
//! which shares the file, notices before its next line that the path names another file and
//! reopens it too. logrotate's and journald's size cap, one previous file kept.

use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static ROLE: OnceLock<&'static str> = OnceLock::new();
/// The log this process writes to on stderr, and the size the holder rotates it at (0 = never).
static FILE: OnceLock<(PathBuf, u64)> = OnceLock::new();
static ROTATE: Mutex<()> = Mutex::new(());

/// Rotates and follows `path` from now on, if stderr is that file (a daemonized namespace).
pub fn set_file(path: &Path, max: u64) {
    let at = std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()));
    if at.is_some() && stderr_id() == at {
        let _ = FILE.set((path.to_owned(), max));
    }
}

/// The file stderr writes to, as (device, inode).
fn stderr_id() -> Option<(u64, u64)> {
    // SAFETY: fstat of fd 2 into a stat we own.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(2, &mut st) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some((st.st_dev as u64, st.st_ino as u64))
}

fn reopen(path: &Path) {
    let f = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(path);
    if let Ok(f) = f {
        // SAFETY: dup2 onto stdout and stderr of a file we just opened.
        unsafe {
            libc::dup2(f.as_raw_fd(), 1);
            libc::dup2(f.as_raw_fd(), 2);
        }
    }
}

/// Before a line: when the log's path names another file than stderr (the holder rotated it, or
/// someone removed it), write to the path's file.
fn follow() {
    let Some((path, _)) = FILE.get() else { return };
    let at = std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()));
    if stderr_id() != at {
        reopen(path);
    }
}

/// The holder's part, from its timer: past the size cap, move the log to `.1` and start anew.
pub fn rotate_if_due() {
    let Some((path, max)) = FILE.get() else { return };
    if *max == 0 {
        return;
    }
    let _g = ROTATE.lock().unwrap();
    follow();
    if std::fs::metadata(path).is_ok_and(|m| m.len() >= *max) {
        let mut old = path.clone().into_os_string();
        old.push(".1");
        if std::fs::rename(path, &old).is_ok() {
            reopen(path);
            drop(_g);
            log(&format!("log rotated at {max} bytes; the previous one is {}", Path::new(&old).display()));
        }
    }
}

/// Names this process in every line it logs (`holder`, `brain`).
pub fn set_role(role: &'static str) {
    let _ = ROLE.set(role);
}

/// Local time with its offset, to the millisecond (RFC 3339).
pub fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as libc::time_t;
    // SAFETY: localtime_r writes into the tm we own; a zeroed tm is a valid starting value.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
        return format!("{}.{:03}", now.as_secs(), now.subsec_millis());
    }
    let off = tm.tm_gmtoff / 60;
    let (sign, off) = if off < 0 { ('-', -off) } else { ('+', off) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{sign}{:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        now.subsec_millis(),
        off / 60,
        off % 60
    )
}

/// One line on stderr (the namespace's log once daemonized).
pub fn log(msg: &str) {
    follow();
    eprintln!("{} {}[{}] {msg}", now_rfc3339(), ROLE.get().copied().unwrap_or("termd"), std::process::id());
}
