//! Log lines, shared by the holder and the brain (they write one file):
//! `2026-11-12T15:25:13.751-06:00 holder[1230122] message` (DESIGN.md, "Defaults", log line).

use std::sync::OnceLock;

static ROLE: OnceLock<&'static str> = OnceLock::new();

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
    eprintln!("{} {}[{}] {msg}", now_rfc3339(), ROLE.get().copied().unwrap_or("termd"), std::process::id());
}
