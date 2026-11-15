//! A terminal's processes as one tree (DESIGN.md, "Process trees"): a close, the holder's death and
//! the namespace's end leave nothing of it running, and the status document says what runs.
//! cgroup mode needs a systemd user manager (a `--daemon` namespace runs as a user service): those
//! tests say so and stop when none answers. Session mode runs everywhere.

mod common;

use common::*;
use g3d::Client;
use g3d_wire::*;
use std::time::{Duration, Instant};

fn alive(pid: u32) -> bool {
    ps_field(pid, "stat").is_some_and(|s| !s.starts_with('Z'))
}

fn wait_until(secs: u64, what: &str, mut f: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Whether a systemd user manager answers (`systemctl --user`), read-only.
fn user_manager() -> bool {
    std::process::Command::new("systemctl")
        .args(["--user", "show", "--property=Version"])
        .output()
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).starts_with("Version="))
}

/// The pids of every process whose command line holds `tag` (this test's sleeps).
fn tagged(tag: &str) -> Vec<u32> {
    let ps = std::process::Command::new("ps").args(["-eo", "pid=,args="]).output().unwrap();
    String::from_utf8_lossy(&ps.stdout)
        .lines()
        .filter(|l| l.contains(tag) && !l.contains("sh -c"))
        .filter_map(|l| l.split_whitespace().next()?.parse().ok())
        .collect()
}

/// A program that ignores SIGHUP and SIGTERM, with a child that does too in its own process group
/// (`set -m`) and, unless `same_session`, another that left the session (`setsid`): the ones a
/// tty hangup and a process-group kill don't reach.
fn stubborn(tag: &str, same_session: bool) -> Vec<String> {
    let away =
        if same_session { String::new() } else { format!("setsid sh -c 'trap \"\" HUP TERM; exec sleep 1{tag}3' & ") };
    let script = format!(
        "set -m; trap '' HUP TERM; (trap '' HUP TERM; exec sleep 1{tag}1) & {away}sleep 0.1; echo READY; exec sleep 1{tag}2"
    );
    vec!["sh".into(), "-c".into(), script]
}

fn start_stubborn(c: &mut Client, id: &str, tag: &str, same_session: bool, want: usize) -> Vec<u32> {
    let r: CreateReply = c
        .request(Op::Create(Create {
            id: id.into(),
            argv: Some(stubborn(tag, same_session)),
            cols: 80,
            rows: 24,
            ..Default::default()
        }))
        .unwrap();
    let mut pids = Vec::new();
    wait_until(10, "the program and its children", || {
        pids = tagged(&format!("sleep 1{tag}"));
        pids.len() == want
    });
    assert!(pids.contains(&r.pid), "{pids:?} has the program {}", r.pid);
    pids
}

fn status(c: &mut Client) -> Status {
    c.request::<StatusReply>(Op::Status).unwrap().status
}

#[test]
fn a_close_ends_the_whole_tree_in_its_cgroup() {
    if !user_manager() {
        eprintln!("no systemd user manager answers: cgroup mode is not tested here");
        return;
    }
    let d = Daemon::start_daemonized(&["--idle-exit", "0"]);
    let mut c = d.client();
    let st = status(&mut c);
    let trees = st.daemon.trees.clone().expect("the document says how it knows a terminal's processes");
    assert_eq!(trees.mode, "cgroup", "{trees:?}\n{}", d.log());
    let pids = start_stubborn(&mut c, "t", "71", false, 3);
    let st = status(&mut c);
    assert_eq!(st.terminals[0].processes, Some(3), "the program, its child, and the one that left the session");
    let _: Empty = c.request(Op::Kill(Kill { id: "t".into(), signal: None })).unwrap();
    wait_until(5, "every process of the tree to end", || pids.iter().all(|&p| !alive(p)));
    wait_until(5, "the close's report", || !status(&mut c).daemon.closes.is_empty());
    let st = status(&mut c);
    let close = &st.daemon.closes[0];
    let signals: Vec<&str> = close.steps.iter().map(|s| s.signal.as_str()).collect();
    assert_eq!(signals, ["HUP", "TERM", "KILL"], "{close:?}");
    assert_eq!(close.steps[2].procs.len(), 3, "all three outlived SIGHUP and SIGTERM: {close:?}");
    assert!(st.errors.iter().any(|e| e.code == "killed" && e.id.as_deref() == Some("t")), "{:?}", st.errors);
    assert!(d.log().contains("terminal t closed: SIGHUP →"), "{}", d.log());
}

#[test]
fn the_holders_death_ends_every_tree_in_its_cgroup() {
    if !user_manager() {
        eprintln!("no systemd user manager answers: cgroup mode is not tested here");
        return;
    }
    let mut d = Daemon::start_daemonized(&["--idle-exit", "0"]);
    let mut c = d.client();
    let pids = start_stubborn(&mut c, "t", "72", false, 3);
    let holder = d.detached.take().unwrap();
    // SAFETY: SIGKILL to the holder this test started: no cleanup of its own runs.
    unsafe { libc::kill(holder as i32, libc::SIGKILL) };
    wait_until(10, "nothing of the terminal to survive its holder", || pids.iter().all(|&p| !alive(p)));
}

#[test]
fn stop_ends_every_tree_and_what_ended_terminals_left_running() {
    if !user_manager() {
        eprintln!("no systemd user manager answers: cgroup mode is not tested here");
        return;
    }
    let mut d = Daemon::start_daemonized(&["--idle-exit", "0"]);
    let mut c = d.client();
    let pids = start_stubborn(&mut c, "t", "73", false, 3);
    // A program that leaves a job running when it exits: the terminal ends, the job stays and is
    // reported, as a terminal leaves a nohup job.
    let r: CreateReply = c
        .request(Op::Create(Create {
            id: "nohup".into(),
            argv: Some(vec!["sh".into(), "-c".into(), "nohup sleep 1799 >/dev/null 2>&1 & sleep 0.2".into()]),
            cols: 80,
            rows: 24,
            ..Default::default()
        }))
        .unwrap();
    wait_until(10, "the leftover in the status document", || {
        status(&mut c).daemon.leftovers.iter().any(|l| l.id == "nohup" && l.processes.iter().any(|p| p.comm == "sleep"))
    });
    let left = tagged("sleep 1799");
    assert_eq!(left.len(), 1);
    let st = status(&mut c);
    assert!(st.terminals.iter().all(|t| t.id != "nohup"), "the terminal itself ended");
    assert_eq!(st.daemon.leftovers[0].pid, r.pid);
    let _: Empty = c.request(Op::Stop).unwrap();
    wait_until(10, "every tree and the leftover to end with the namespace", || {
        pids.iter().chain(&left).all(|&p| !alive(p))
    });
    d.detached = None;
}

#[test]
fn a_close_ends_the_whole_session() {
    let d = Daemon::start();
    let mut c = d.client();
    let st = status(&mut c);
    assert_eq!(st.daemon.trees.as_ref().map(|t| t.mode.as_str()), Some("session"), "a foreground daemon: sessions");
    let pids = start_stubborn(&mut c, "t", "74", true, 2);
    let _: Empty = c.request(Op::Kill(Kill { id: "t".into(), signal: None })).unwrap();
    wait_until(5, "every process of the session to end", || pids.iter().all(|&p| !alive(p)));
    wait_until(5, "the close's report", || !status(&mut c).daemon.closes.is_empty());
}

#[test]
fn the_holders_death_ends_every_session() {
    let mut d = Daemon::start();
    let mut c = d.client();
    let pids = start_stubborn(&mut c, "t", "75", true, 2);
    let mut holder = d.child.take().unwrap();
    holder.kill().unwrap(); // SIGKILL: no cleanup of its own runs
    holder.wait().unwrap();
    wait_until(10, "nothing of the session to survive its holder", || pids.iter().all(|&p| !alive(p)));
    assert!(d.log().contains("the holder is gone: ending 1 terminal tree"), "{}", d.log());
}

#[test]
fn stop_ends_every_session() {
    let mut d = Daemon::start();
    let mut c = d.client();
    let pids = start_stubborn(&mut c, "t", "76", true, 2);
    let _: Empty = c.request(Op::Stop).unwrap();
    let mut holder = d.child.take().unwrap();
    holder.wait().unwrap();
    wait_until(5, "every process of the session to end with the namespace", || pids.iter().all(|&p| !alive(p)));
}
