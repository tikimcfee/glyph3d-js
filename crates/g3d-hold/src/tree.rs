//! A terminal's processes, as one tree (DESIGN.md, "Process trees"): everything its program
//! started, however it forked, so a close or the namespace's end can reach all of it and termd can
//! say what is still running.
//!
//! Two ways to know the tree, one interface:
//!
//! - **cgroup** (Linux, the namespace started as a systemd user service with `Delegate=yes`, which
//!   is what `g3d-termd --daemon` asks for): the holder owns its service's cgroup v2 subtree, keeps
//!   itself in the leaf `holder`, each brain in `brain-<n>` and each terminal in `term-<handle>`.
//!   A program enters its leaf in the forked child before `exec`, so nothing it forks escapes
//!   (`setsid`, double forks, `nohup` included). Members are the leaf's `cgroup.procs`; the end is
//!   `cgroup.kill` (atomic: a fork can't race it); the leaf's `cgroup.events` says when it empties,
//!   which the holder watches with inotify. systemd-run's `--scope`, tmux built with systemd
//!   (`tmux-spawn-<uuid>.scope`) and Ghostty (`app-ghostty-surface-transient-<pid>.scope`) put each
//!   terminal in its own cgroup the same way; a delegated subtree gives the holder the same per
//!   terminal cgroups with no D-Bus call per terminal and no race between a spawn and its move.
//! - **session** (macOS, which has no cgroups; Linux without a systemd user manager): the terminal's
//!   session, the processes whose session id is the program's pid (it is a session leader). A
//!   process that leaves the session (`setsid`) leaves the tree: the session is the best a process
//!   can know of its descendants without cgroups (tmux and screen kill no more than this either).

use std::ffi::CString;
use std::io;
use std::path::PathBuf;

/// One process in a tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proc {
    pub pid: i32,
    pub comm: String,
}

impl Proc {
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({"pid": self.pid, "comm": self.comm})
    }
}

/// Where a terminal's tree is: its cgroup leaf's name, or its session id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tree {
    Leaf(String),
    Session(i32),
}

impl Tree {
    pub fn json(&self) -> serde_json::Value {
        match self {
            Tree::Leaf(l) => serde_json::json!({"leaf": l}),
            Tree::Session(s) => serde_json::json!({"session": s}),
        }
    }

    pub fn from_json(v: &serde_json::Value) -> Option<Tree> {
        if let Some(l) = v.get("leaf").and_then(serde_json::Value::as_str) {
            return Some(Tree::Leaf(l.to_owned()));
        }
        v.get("session").and_then(serde_json::Value::as_i64).map(|s| Tree::Session(s as i32))
    }
}

/// How this namespace knows its trees.
#[derive(Clone, Debug)]
pub enum Trees {
    /// The holder's delegated cgroup: its directory under `/sys/fs/cgroup`, and the unit.
    Cgroup { root: PathBuf, unit: String },
    /// No cgroup of its own: sessions, and why not a cgroup.
    Session { why: String },
}

/// The cgroup v2 mount.
#[cfg(target_os = "linux")]
const CGROUP_FS: &str = "/sys/fs/cgroup";

impl Trees {
    /// The cgroup this process runs in when it is the systemd service `unit` asked for (so its
    /// subtree is delegated to it), else sessions, saying why.
    pub fn detect(unit: Option<&str>) -> Trees {
        #[cfg(target_os = "linux")]
        {
            let Some(unit) = unit else {
                return Trees::Session {
                    why: "not started as a systemd user service (g3d-termd --daemon asks the user manager for one)"
                        .into(),
                };
            };
            let own = std::fs::read_to_string("/proc/self/cgroup").unwrap_or_default();
            let Some(path) = own.lines().find_map(|l| l.strip_prefix("0::")) else {
                return Trees::Session { why: "no cgroup v2 hierarchy (/proc/self/cgroup has no 0:: line)".into() };
            };
            if !path.ends_with(&format!("/{unit}")) {
                return Trees::Session { why: format!("started as {unit}, but running in the cgroup {path}") };
            }
            let root = PathBuf::from(format!("{CGROUP_FS}{path}"));
            if let Err(e) = std::fs::metadata(root.join("cgroup.procs")) {
                return Trees::Session { why: format!("{}: {e}", root.display()) };
            }
            Trees::Cgroup { root, unit: unit.to_owned() }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = unit;
            Trees::Session { why: "this system has no cgroups".into() }
        }
    }

    pub fn json(&self) -> serde_json::Value {
        match self {
            Trees::Cgroup { root, unit } => {
                serde_json::json!({"mode": "cgroup", "root": root.display().to_string(), "unit": unit})
            }
            Trees::Session { why } => serde_json::json!({"mode": "session", "why": why}),
        }
    }

    pub fn from_json(v: &serde_json::Value) -> Option<Trees> {
        match v.get("mode")?.as_str()? {
            "cgroup" => Some(Trees::Cgroup {
                root: PathBuf::from(v.get("root")?.as_str()?),
                unit: v.get("unit")?.as_str()?.to_owned(),
            }),
            "session" => Some(Trees::Session { why: v.get("why")?.as_str()?.to_owned() }),
            _ => None,
        }
    }

    pub fn is_cgroup(&self) -> bool {
        matches!(self, Trees::Cgroup { .. })
    }

    /// A terminal's tree: the leaf `term-<handle>`, or the session its program leads.
    pub fn tree_of(&self, handle: u32, pid: i32) -> Tree {
        match self {
            Trees::Cgroup { .. } => Tree::Leaf(format!("term-{handle}")),
            Trees::Session { .. } => Tree::Session(pid),
        }
    }

    /// The members of several trees at once (one scan of the system's processes for sessions).
    pub fn members_many(&self, trees: &[Tree]) -> Vec<Vec<Proc>> {
        if trees.iter().all(|t| matches!(t, Tree::Leaf(_))) {
            return trees.iter().map(|t| self.members(t)).collect();
        }
        let sids: Vec<i32> =
            trees.iter().filter_map(|t| if let Tree::Session(s) = t { Some(*s) } else { None }).collect();
        let by_sid = sessions(&sids);
        trees
            .iter()
            .map(|t| match t {
                Tree::Session(s) => by_sid.iter().filter(|(sid, _)| sid == s).map(|(_, p)| p.clone()).collect(),
                Tree::Leaf(_) => self.members(t),
            })
            .collect()
    }

    /// A leaf's directory.
    pub fn leaf_dir(&self, leaf: &str) -> Option<PathBuf> {
        match self {
            Trees::Cgroup { root, .. } => Some(root.join(leaf)),
            Trees::Session { .. } => None,
        }
    }

    /// Makes a leaf and answers its `cgroup.procs`, which a forked child writes `0` to (itself)
    /// before `exec`. `None` in session mode.
    pub fn make_leaf(&self, leaf: &str) -> io::Result<Option<CString>> {
        let Some(dir) = self.leaf_dir(leaf) else { return Ok(None) };
        match std::fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io::Error::new(e.kind(), format!("mkdir {}: {e}", dir.display()))),
        }
        let procs = dir.join("cgroup.procs");
        Ok(Some(CString::new(procs.as_os_str().as_encoded_bytes()).map_err(io::Error::other)?))
    }

    /// Moves this process into `leaf` (the holder into `holder`).
    pub fn enter(&self, leaf: &str) -> io::Result<()> {
        if self.make_leaf(leaf)?.is_none() {
            return Ok(());
        }
        let path = self.leaf_dir(leaf).expect("a cgroup").join("cgroup.procs");
        std::fs::write(&path, b"0").map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))
    }

    /// Removes an empty leaf.
    pub fn remove_leaf(&self, leaf: &str) {
        if let Some(dir) = self.leaf_dir(leaf) {
            let _ = std::fs::remove_dir(dir);
        }
    }

    /// Every live process in a tree (zombies are not: they have ended).
    pub fn members(&self, t: &Tree) -> Vec<Proc> {
        match t {
            Tree::Leaf(l) => {
                let Some(dir) = self.leaf_dir(l) else { return Vec::new() };
                let text = std::fs::read_to_string(dir.join("cgroup.procs")).unwrap_or_default();
                text.lines()
                    .filter_map(|p| p.trim().parse::<i32>().ok())
                    .filter_map(|pid| proc_info(pid).filter(|(_, zombie)| !zombie).map(|(comm, _)| Proc { pid, comm }))
                    .collect()
            }
            Tree::Session(sid) => in_session(*sid),
        }
    }

    /// Whether a leaf still holds a process (its `cgroup.events`: `populated`). A session: whether
    /// it has a live member.
    pub fn populated(&self, t: &Tree) -> bool {
        match t {
            Tree::Leaf(l) => self.leaf_dir(l).is_some_and(|d| {
                std::fs::read_to_string(d.join("cgroup.events"))
                    .map(|e| e.lines().any(|l| l.trim() == "populated 1"))
                    .unwrap_or(false)
            }),
            Tree::Session(_) => !self.members(t).is_empty(),
        }
    }

    /// Sends `sig` to every process in a tree and answers who got it. `SIGKILL` to a leaf is its
    /// `cgroup.kill`, which no fork can race (Linux 5.14; one signal per process before that).
    pub fn signal(&self, t: &Tree, sig: i32) -> Vec<Proc> {
        let who = self.members(t);
        if sig == libc::SIGKILL
            && let Tree::Leaf(l) = t
            && let Some(dir) = self.leaf_dir(l)
            && std::fs::write(dir.join("cgroup.kill"), b"1").is_ok()
        {
            return who;
        }
        for p in &who {
            // SAFETY: a plain kill(2) of a pid read from the tree just now.
            unsafe { libc::kill(p.pid, sig) };
        }
        who
    }
}

/// A process's name and whether it is a zombie, `None` once it is gone.
#[cfg(target_os = "linux")]
fn proc_info(pid: i32) -> Option<(String, bool)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (comm, state, _) = parse_stat(&stat)?;
    Some((comm, state == 'Z'))
}

/// `/proc/<pid>/stat`: the name (between the first `(` and the last `)`, which may hold anything),
/// the state, and the session id.
#[cfg(target_os = "linux")]
fn parse_stat(stat: &str) -> Option<(String, char, i32)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat.get(open + 1..close)?.to_owned();
    let mut rest = stat.get(close + 1..)?.split_ascii_whitespace();
    let state = rest.next()?.chars().next()?;
    let _ppid = rest.next()?;
    let _pgrp = rest.next()?;
    let session: i32 = rest.next()?.parse().ok()?;
    Some((comm, state, session))
}

/// The live processes of session `sid`.
pub fn in_session(sid: i32) -> Vec<Proc> {
    sessions(&[sid]).into_iter().map(|(_, p)| p).collect()
}

/// The live processes of any of `sids`, with their session: one scan of `/proc`.
#[cfg(target_os = "linux")]
fn sessions(sids: &[i32]) -> Vec<(i32, Proc)> {
    let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
    let mut out = Vec::new();
    for e in dir.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        if let Some((comm, state, session)) = parse_stat(&stat)
            && sids.contains(&session)
            && state != 'Z'
        {
            out.push((session, Proc { pid, comm }));
        }
    }
    out.sort_by_key(|p| p.1.pid);
    out
}

/// A process's name and whether it is a zombie (`proc_pidinfo(PROC_PIDTBSDINFO)`).
#[cfg(not(target_os = "linux"))]
fn proc_info(pid: i32) -> Option<(String, bool)> {
    // SAFETY: proc_pidinfo fills a proc_bsdinfo we own, of exactly the size we pass.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    if n != size {
        return None;
    }
    let comm: Vec<u8> = info.pbi_comm.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    Some((String::from_utf8_lossy(&comm).into_owned(), info.pbi_status == libc::SZOMB))
}

/// The live processes of any of `sids`, with their session: every pid (`proc_listallpids`) whose
/// `getsid` is one of them.
#[cfg(not(target_os = "linux"))]
fn sessions(sids: &[i32]) -> Vec<(i32, Proc)> {
    let mut pids = vec![0 as libc::pid_t; 4096];
    let n = loop {
        let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        // SAFETY: proc_listallpids writes at most `bytes` into the buffer we own.
        let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if n < 0 {
            return Vec::new();
        }
        if (n as usize) < pids.len() {
            break n as usize;
        }
        pids.resize(pids.len() * 2, 0);
    };
    let mut out = Vec::new();
    for &pid in &pids[..n] {
        // SAFETY: getsid of any pid; -1 for one that is gone.
        let sid = if pid > 0 { unsafe { libc::getsid(pid) } } else { -1 };
        if sids.contains(&sid)
            && let Some((comm, false)) = proc_info(pid)
        {
            out.push((sid, Proc { pid, comm }));
        }
    }
    out.sort_by_key(|p| p.1.pid);
    out
}

/// Waits until none of `pids` is alive or `until` passes, on the processes' own exit (a pidfd
/// each on Linux, kqueue's `NOTE_EXIT` on macOS), for a process that isn't this one's child.
pub fn wait_gone(pids: &[i32], until: std::time::Instant) {
    #[cfg(target_os = "linux")]
    {
        use rustix::fd::{FromRawFd, OwnedFd};
        let fds: Vec<OwnedFd> = pids
            .iter()
            .filter_map(|&p| {
                // SAFETY: pidfd_open(2) of a pid; the fd is owned from here.
                let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, p, 0) };
                (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd as i32) })
            })
            .collect();
        let mut left: Vec<&OwnedFd> = fds.iter().collect();
        while !left.is_empty() {
            let wait = until.saturating_duration_since(std::time::Instant::now());
            if wait.is_zero() {
                return;
            }
            let mut pfds: Vec<rustix::event::PollFd> =
                left.iter().map(|f| rustix::event::PollFd::new(f, rustix::event::PollFlags::IN)).collect();
            let ts = rustix::event::Timespec { tv_sec: wait.as_secs() as _, tv_nsec: wait.subsec_nanos() as _ };
            if rustix::event::poll(&mut pfds, Some(&ts)).is_err() {
                return;
            }
            let done: Vec<bool> = pfds.iter().map(|p| !p.revents().is_empty()).collect();
            let mut k = 0;
            left.retain(|_| {
                k += 1;
                !done[k - 1]
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        // SAFETY: a kqueue of our own, one EVFILT_PROC NOTE_EXIT registration per pid.
        let kq = unsafe { libc::kqueue() };
        if kq < 0 {
            return;
        }
        let mut left = 0usize;
        for &p in pids {
            let mut ev: libc::kevent = unsafe { std::mem::zeroed() };
            ev.ident = p as usize;
            ev.filter = libc::EVFILT_PROC;
            ev.flags = libc::EV_ADD | libc::EV_ONESHOT;
            ev.fflags = libc::NOTE_EXIT;
            if unsafe { libc::kevent(kq, &ev, 1, std::ptr::null_mut(), 0, std::ptr::null()) } == 0 {
                left += 1;
            }
        }
        while left > 0 {
            let wait = until.saturating_duration_since(std::time::Instant::now());
            if wait.is_zero() {
                break;
            }
            let ts = libc::timespec { tv_sec: wait.as_secs() as _, tv_nsec: wait.subsec_nanos() as _ };
            let mut out: libc::kevent = unsafe { std::mem::zeroed() };
            let n = unsafe { libc::kevent(kq, std::ptr::null(), 0, &mut out, 1, &ts) };
            if n <= 0 {
                break;
            }
            left -= 1;
        }
        unsafe { libc::close(kq) };
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn stat_names_with_parens_and_spaces() {
        let (comm, state, sid) = parse_stat("42 (a (b) c) S 1 42 42 0 -1").unwrap();
        assert_eq!((comm.as_str(), state, sid), ("a (b) c", 'S', 42));
    }

    #[test]
    fn this_session_holds_this_process() {
        // SAFETY: getsid(0) is this process's session.
        let sid = unsafe { libc::getsid(0) };
        let me = std::process::id() as i32;
        assert!(in_session(sid).iter().any(|p| p.pid == me));
    }
}
