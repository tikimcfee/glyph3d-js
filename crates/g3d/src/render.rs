//! The status document as text: `g3d status`'s reference rendering (DESIGN.md, "Status"). A header
//! (the daemon, its holder and brain), one row per terminal, the recent errors. Every number comes
//! from the document; nothing here asks the daemon anything.

use g3d_wire::{Role, Status, StatusSubscriber, StatusTerminal};

/// How to colour: `attention` (what needs a look: blocked, lagging, queued input, an error) and
/// `dim` (anything secondary). Plain when both are empty.
#[derive(Clone, Copy)]
pub struct Style {
    pub attention: &'static str,
    pub dim: &'static str,
    pub reset: &'static str,
}

impl Style {
    pub const PLAIN: Style = Style { attention: "", dim: "", reset: "" };
    /// SGR: yellow for attention, faint for secondary.
    pub const SGR: Style = Style { attention: "\x1b[33m", dim: "\x1b[2m", reset: "\x1b[0m" };
}

/// A byte count for people: `512 B`, `3.1 KB`, `41 MB` (powers of 1000, as `ls -h --si` and
/// macOS do).
pub fn bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1000.0 && u < UNITS.len() - 1 {
        v /= 1000.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else if v < 10.0 {
        format!("{v:.1} {}", UNITS[u])
    } else {
        format!("{v:.0} {}", UNITS[u])
    }
}

/// A span for people: `45s`, `12m`, `3h 12m`, `2d 4h`.
pub fn span(ms: u64) -> String {
    let s = ms / 1000;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m", s / 60),
        3600..86400 => format!("{}h {}m", s / 3600, s % 3600 / 60),
        _ => format!("{}d {}h", s / 86400, s % 86400 / 3600),
    }
}

/// `HH:MM` in local time, for a time today; `Mon DD HH:MM` otherwise.
pub fn clock(at_ms: u64, now_ms: u64) -> String {
    let lt = |ms: u64| {
        let t = (ms / 1000) as libc::time_t;
        // SAFETY: localtime_r fills a tm we own from a time_t we own.
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&t, &mut tm) };
        tm
    };
    let (a, n) = (lt(at_ms), lt(now_ms));
    if (a.tm_year, a.tm_yday) == (n.tm_year, n.tm_yday) {
        format!("{:02}:{:02}", a.tm_hour, a.tm_min)
    } else {
        const MON: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        format!("{} {} {:02}:{:02}", MON[a.tm_mon.clamp(0, 11) as usize], a.tm_mday, a.tm_hour, a.tm_min)
    }
}

/// `g3d-termd/0.2.0` → `g3d-termd 0.2.0`.
fn name_version(s: &str) -> String {
    s.replacen('/', " ", 1)
}

/// The program a terminal runs, as a name: `argv[0]`'s basename, a login shell's `-` dropped.
pub fn program(argv: &[String]) -> String {
    let a0 = argv.first().map(String::as_str).unwrap_or("");
    a0.rsplit('/').next().unwrap_or(a0).trim_start_matches('-').to_owned()
}

/// Who watches a terminal: `own · 2 watch`, `—` for no one.
pub fn subscribers(subs: &[StatusSubscriber]) -> String {
    let n = |r: Role| subs.iter().filter(|s| s.role == r).count();
    let mut parts = Vec::new();
    if n(Role::Own) > 0 {
        parts.push("own".to_owned());
    }
    for (r, word) in [(Role::Attach, "attach"), (Role::Watch, "watch")] {
        match n(r) {
            0 => {}
            k => parts.push(format!("{k} {word}")),
        }
    }
    if parts.is_empty() { "—".to_owned() } else { parts.join(" · ") }
}

/// What a terminal is doing: its output rate, or how long it has been quiet.
pub fn activity(t: &StatusTerminal, now_ms: u64) -> String {
    if t.out_bps > 0 {
        format!("{}/s", bytes(t.out_bps))
    } else if let Some(at) = t.last_output_at {
        format!("idle {}", span(now_ms.saturating_sub(at)))
    } else {
        String::new()
    }
}

/// What needs a look, then what is merely so: `(attention, quiet)` notes.
pub fn notes(t: &StatusTerminal) -> (Vec<String>, Vec<String>) {
    let mut loud = Vec::new();
    let mut quiet = Vec::new();
    match t.flow.as_str() {
        "blocked" => loud.push("blocked".to_owned()),
        "paused" => quiet.push("paused".to_owned()),
        _ => {}
    }
    if t.subscribers.iter().any(|s| s.lagging) {
        loud.push("lagging".to_owned());
    }
    if t.input_queued > 0 {
        loud.push(format!("{} input queued", bytes(t.input_queued)));
    }
    if t.alt {
        quiet.push("alt".to_owned());
    }
    if let Some(r) = &t.restored {
        match t.unseen.filter(|&n| n > 0) {
            Some(n) => quiet.push(format!("restored: {r}, {} unseen", bytes(n))),
            None => quiet.push(format!("restored: {r}")),
        }
    }
    (loud, quiet)
}

/// The whole rendering.
pub fn status(doc: &Status, st: Style) -> String {
    let now = doc.at;
    let d = &doc.daemon;
    let mut out = String::new();
    let mut line = |s: String| {
        out.push_str(&s);
        out.push('\n');
    };
    let ns = d.ns.as_deref().map_or_else(|| d.socket.clone(), |n| format!("ns {n}"));
    line(format!(
        "{} · {} · {ns} · up {}{}",
        name_version(&d.version),
        name_version(&d.engine),
        span(now.saturating_sub(d.started_at)),
        if d.exiting { format!(" · {}exiting (empty){}", st.dim, st.reset) } else { String::new() }
    ));
    let rss = |r: Option<u64>| r.map_or_else(String::new, |r| format!(" · {}", bytes(r)));
    let b = &d.brain;
    let r = &b.restarts;
    let restarts = r.crash + r.watchdog + r.upgrade;
    let mut brain = format!("brain {} · gen {}{}", b.pid, b.generation, rss(b.rss));
    if restarts > 0 {
        let mut by = Vec::new();
        for (n, w) in [(r.crash, "crash"), (r.watchdog, "watchdog"), (r.upgrade, "upgrade")] {
            if n > 0 {
                by.push(format!("{n} {w}"));
            }
        }
        brain.push_str(&format!(
            " · {}restarts: {} (last: {} {}){}",
            st.dim,
            by.join(", "),
            b.last_start.reason,
            clock(b.last_start.at, now),
            st.reset
        ));
    }
    line(format!("holder {}{}   {brain}", d.holder.pid, rss(d.holder.rss)));
    line(format!(
        "{}env {} · snapshots {} every {} · {} connection{} · log {}{}",
        st.dim,
        d.env.source,
        bytes(d.snapshots.bytes),
        span(d.snapshots.interval_ms),
        d.connections,
        if d.connections == 1 { "" } else { "s" },
        d.log,
        st.reset
    ));
    for w in &d.env.warnings {
        line(format!("{}env: {w}{}", st.attention, st.reset));
    }
    line(String::new());
    if doc.terminals.is_empty() {
        line(format!("{}no terminals{}", st.dim, st.reset));
    }
    let rows: Vec<[String; 5]> = doc
        .terminals
        .iter()
        .map(|t| {
            [
                t.id.clone(),
                program(&t.argv),
                format!("{}×{}", t.cols, t.rows),
                subscribers(&t.subscribers),
                activity(t, now),
            ]
        })
        .collect();
    let width = |k: usize| rows.iter().map(|r| r[k].chars().count()).max().unwrap_or(0);
    let w: Vec<usize> = (0..5).map(width).collect();
    for (t, r) in doc.terminals.iter().zip(&rows) {
        let pad = |s: &str, n: usize| format!("{s}{}", " ".repeat(n.saturating_sub(s.chars().count())));
        let (loud, quiet) = notes(t);
        let mut tail = String::new();
        if !loud.is_empty() {
            tail.push_str(&format!("  {}{}{}", st.attention, loud.join(" · "), st.reset));
        }
        if !quiet.is_empty() {
            tail.push_str(&format!("  {}{}{}", st.dim, quiet.join(" · "), st.reset));
        }
        let size = format!("{}{}", " ".repeat(w[2].saturating_sub(r[2].chars().count())), r[2]);
        line(
            format!(
                "{}  {}  {size}  {}{}{}  {}{}",
                pad(&r[0], w[0]),
                pad(&r[1], w[1]),
                st.dim,
                pad(&r[3], w[3]),
                st.reset,
                pad(&r[4], w[4]),
                tail
            )
            .trim_end()
            .to_owned(),
        );
    }
    if !doc.errors.is_empty() {
        line(String::new());
        for e in &doc.errors {
            let times = if e.count > 1 { format!(" ×{}", e.count) } else { String::new() };
            let id = e.id.as_deref().map_or_else(String::new, |i| format!(" {i}:"));
            line(format!(
                "{}{}{}  {}{}{}{times}{id} {}",
                st.dim,
                clock(e.at, now),
                st.reset,
                st.attention,
                e.code,
                st.reset,
                e.message
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_spans_read_like_people_write_them() {
        assert_eq!(bytes(0), "0 B");
        assert_eq!(bytes(999), "999 B");
        assert_eq!(bytes(1_253_000), "1.3 MB");
        assert_eq!(bytes(41_943_040), "42 MB");
        assert_eq!(span(45_000), "45s");
        assert_eq!(span(12 * 60_000), "12m");
        assert_eq!(span((3 * 3600 + 12 * 60) * 1000), "3h 12m");
        assert_eq!(span((2 * 86400 + 4 * 3600) * 1000), "2d 4h");
        assert_eq!(program(&["/bin/bash".into()]), "bash");
        assert_eq!(program(&["-zsh".into()]), "zsh");
    }
}
