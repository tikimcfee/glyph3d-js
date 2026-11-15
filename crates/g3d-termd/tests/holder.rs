//! The holder replacing itself (`g3d upgrade --holder`, DESIGN.md "Upgrading the holder"): an
//! exec in place, keeping its pid and every fd, so no shell notices. Gated as the brain's upgrade
//! is: under a flood, a candidate that fails, one that refuses the record, and repeated upgrades
//! with the holder's fds and RSS flat. Each on a private daemon.

mod common;

use common::*;
use g3d::Client;
use g3d_wire::frame;
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

fn holder_upgrade(binary: &std::path::Path) -> Op {
    Op::Upgrade(Upgrade { binary: Some(binary.display().to_string()), holder: Some(true) })
}

fn status(c: &mut Client) -> Status {
    c.request::<StatusReply>(Op::Status).unwrap().status
}

/// What a process's parent and controlling terminal are (`ps`): a shell that noticed nothing has
/// both as they were.
fn parent_and_tty(pid: u32) -> (String, String) {
    (ps_field(pid, "ppid").unwrap_or_default(), ps_field(pid, "tty").unwrap_or_default())
}

/// The holder's open fds.
fn fds(pid: u32) -> usize {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_dir(format!("/proc/{pid}/fd")).map(|d| d.count()).unwrap_or(0)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let o = std::process::Command::new("lsof").args(["-p", &pid.to_string()]).output().unwrap();
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|l| l.split_whitespace().nth(3).is_some_and(|f| f.starts_with(char::is_numeric)))
            .count()
    }
}

/// A shell that writes `HUP` into `file` if it is ever hung up, then idles.
fn hup_watcher(c: &mut Client, id: &str, file: &std::path::Path) -> CreateReply {
    let script = format!("trap 'echo HUP > {}' HUP; echo WATCHING; while :; do sleep 1; done", file.display());
    create(c, id, &["sh", "-c", &script], 40, 5)
}

#[test]
fn a_holder_upgrade_under_a_flood_loses_no_byte_and_no_shell_notices() {
    let d = Daemon::start_with(&["--idle-exit", "0", "--max-scrollback", "67108864"]);
    let next = d.dir.join("g3d-termd-next");
    std::fs::copy(bin(), &next).unwrap();
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    let holder = d.pid();
    let hup = d.dir.join("hup");
    let w = hup_watcher(&mut c, "watcher", &hup);
    let f: CreateReply = c
        .request(Op::Create(Create {
            id: "flood".into(),
            argv: Some(vec!["sh".into()]),
            cols: 10,
            rows: 5,
            scrollback_bytes: Some(64 << 20),
            ..Default::default()
        }))
        .unwrap();
    let before = [(w.pid, parent_and_tty(w.pid)), (f.pid, parent_and_tty(f.pid))];
    assert_eq!(before[0].1.0.trim(), holder.to_string(), "the holder is the shells' parent");
    let s = c.request::<SubscribeReply>(sub_req("flood", Mode::Raw, Role::Own, Some(Flow::Block), None)).unwrap();
    c.input(s.handle, b"seq 1 300000; echo FLOOD-$((1+1))-DONE\r").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 30, |s| s.output.len() > 400_000);

    let mut asker = d.client();
    let r: UpgradeReply = asker.request(holder_upgrade(&next)).unwrap();
    assert_eq!(r.generation, 1);
    let err = loop {
        match c.next_frame() {
            Ok(f) => seen.take(&f),
            Err(e) => break e,
        }
    };
    assert_eq!(err.code(), Some(code::RESTART), "{err}");
    assert!(seen.gaps.is_empty());
    let cut = seen.next_seq.unwrap();

    let mut c = d.reconnect(&instance);
    wait_until(15, "the new holder's brain", || {
        c = d.reconnect(&instance);
        c.welcome.generation == Some(2)
    });
    assert_eq!(c.welcome.holder.as_ref().map(|h| h.pid), Some(holder), "the same holder pid: an exec in place");
    let st = status(&mut c);
    assert_eq!(st.daemon.holder.upgrades, 1);
    assert_eq!(st.daemon.brain.last_start.reason, "upgrade");
    assert_eq!(st.daemon.brain.last_start.restored.exact, 2, "every terminal back exact\n{}", d.log());
    let log = d.log();
    assert!(log.contains("holder resumed from") && log.contains("re-execs into"), "{log}");
    // No shell noticed: the same pids, the same parent, the same terminal, no hangup.
    for (pid, pt) in &before {
        assert!(alive(*pid));
        assert_eq!(&parent_and_tty(*pid), pt);
    }
    // The flood runs on from the cut, every byte of it in the terminal's history.
    let s2 = c.request::<SubscribeReply>(sub_req("flood", Mode::Raw, Role::Own, Some(Flow::Block), None)).unwrap();
    assert!(s2.seq >= cut);
    let mut after = Seen::default();
    read_until(&mut c, &mut after, 60, |s| tail_contains(&s.output, b"FLOOD-2-DONE"));
    assert!(after.gaps.is_empty(), "{:?}", after.gaps);
    let r: CaptureReply = c
        .request(Op::Capture(Capture {
            id: "flood".into(),
            format: Some(CaptureFormat::Plain),
            history_rows: Some(400_000),
            unwrap: Some(true),
        }))
        .unwrap();
    let lines: Vec<u64> = r.text.lines().filter_map(|l| l.trim().parse().ok()).collect();
    let from = lines.iter().position(|&n| n == 1).expect("line 1 in the history");
    assert_eq!(lines[from..].len(), 300000, "every line of the flood, across the holder's upgrade");
    assert!(lines[from..].windows(2).all(|w| w[1] == w[0] + 1), "in order");
    assert!(!hup.exists(), "a shell was hung up");
    // A terminal made by the new holder works, and the old ones still take input.
    let t = create(&mut c, "new", &["cat"], 40, 5);
    assert!(alive(t.pid));
}

#[test]
fn failed_holder_candidates_leave_the_holder_serving() {
    let d = Daemon::start_with(&["--idle-exit", "0", "--upgrade-deadline", "2"]);
    let mut c = d.client();
    let (holder, brain) = (d.pid(), c.welcome.pid.unwrap());
    let hup = d.dir.join("hup");
    let w = hup_watcher(&mut c, "watcher", &hup);
    create(&mut c, "a", &["cat"], 40, 5);
    let s = subscribe(&mut c, "a", Role::Attach, None);
    let dies = d.dir.join("dies.sh");
    let hangs = d.dir.join("hangs.sh");
    std::fs::write(&dies, "#!/bin/sh\necho 'not a holder' >&2\nexit 3\n").unwrap();
    std::fs::write(&hangs, "#!/bin/sh\nexec sleep 100\n").unwrap();
    for p in [&dies, &hangs] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    for (bin, why) in [(&dies, "not a holder"), (&hangs, "not ready")] {
        let _: UpgradeReply = c.request(holder_upgrade(bin)).unwrap();
        let mut seen = Seen::default();
        let mut failed = None;
        let until = Instant::now() + Duration::from_secs(15);
        while failed.is_none() {
            assert!(Instant::now() < until, "no upgrade_failed");
            let f = c.next_frame().unwrap();
            if f.stream == 0 && f.ty == frame::ty::EVENT {
                if let Ok(Event::UpgradeFailed { message }) = serde_json::from_slice(&f.payload) {
                    failed = Some(message);
                }
            } else {
                seen.take(&f);
            }
        }
        let msg = failed.unwrap();
        assert!(msg.contains(why), "{msg}");
        // The same holder, the same brain, the same connection, and the terminal still answers.
        c.input(s.handle, b"still here\r").unwrap();
        read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"still here\r\nstill here"));
    }
    assert!(alive(holder) && alive(brain) && alive(w.pid));
    assert_eq!(d.client().welcome.generation, Some(1));
    assert_eq!(status(&mut c).daemon.holder.upgrades, 0);
    assert!(!hup.exists());
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_candidate_that_reads_another_record_format_is_refused() {
    let d = Daemon::start_env(&["--idle-exit", "0"], &[("G3D_TERMD_TEST_RECORD_MAJOR_FILE", "next-major")]);
    std::fs::write(d.dir.join("next-major"), "").unwrap();
    let next = d.dir.join("g3d-termd-next");
    std::fs::copy(bin(), &next).unwrap();
    let mut c = d.client();
    let r = create(&mut c, "a", &["cat"], 40, 5);
    let _: UpgradeReply = c.request(holder_upgrade(&next)).unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    let msg = loop {
        assert!(Instant::now() < until, "no upgrade_failed");
        let f = c.next_frame().unwrap();
        if f.stream == 0
            && f.ty == frame::ty::EVENT
            && let Ok(Event::UpgradeFailed { message }) = serde_json::from_slice(&f.payload)
        {
            break message;
        }
    };
    assert!(msg.contains("holder record format 1.0; this build reads 2.x"), "{msg}");
    assert!(alive(r.pid));
    assert_eq!(status(&mut c).daemon.holder.upgrades, 0);
    assert_eq!(c.welcome.generation, Some(1));
}

#[test]
fn repeated_holder_upgrades_keep_its_fds_and_memory_flat() {
    let d = Daemon::start();
    let next = d.dir.join("g3d-termd-next");
    std::fs::copy(bin(), &next).unwrap();
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    let holder = d.pid();
    let a = create(&mut c, "a", &["cat"], 40, 5);
    let b = create(&mut c, "b", &["sh"], 40, 5);
    drop(c);
    let mut counts = Vec::new();
    for n in 1..=6u64 {
        let mut c = d.reconnect(&instance);
        let was = c.welcome.generation.unwrap();
        let _: UpgradeReply = c.request(holder_upgrade(&next)).unwrap();
        wait_until(15, "the next holder's brain", || {
            d.reconnect(&instance).welcome.generation.is_some_and(|g| g > was)
        });
        let st = status(&mut d.reconnect(&instance));
        assert_eq!(st.daemon.holder.upgrades, n);
        assert_eq!(st.daemon.holder.pid, holder);
        counts.push((fds(holder), rss_kb(holder)));
    }
    assert!(alive(a.pid) && alive(b.pid));
    // The first upgrade gives the store its handoff blobs; from then on nothing grows.
    let (f1, r1) = counts[1];
    for &(f, r) in &counts[2..] {
        assert_eq!(f, f1, "the holder's fds: {counts:?}");
        assert!(r <= r1 + 512, "the holder's RSS grew: {counts:?}");
    }
}

/// In a systemd user service (cgroup mode) the holder keeps its leaf and the terminals theirs
/// across the exec, and a close after it still ends the whole tree.
#[test]
fn a_holder_upgrade_in_its_service_keeps_every_tree() {
    let user_manager = std::process::Command::new("systemctl")
        .args(["--user", "show", "--property=Version"])
        .output()
        .is_ok_and(|o| o.status.success());
    if !user_manager {
        eprintln!("no systemd user manager answers: cgroup mode is not tested here");
        return;
    }
    let mut d = Daemon::start_daemonized(&["--idle-exit", "0"]);
    let next = d.dir.join("g3d-termd-next");
    std::fs::copy(bin(), &next).unwrap();
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    let holder = d.pid();
    let script = "setsid sh -c 'trap \"\" HUP TERM; exec sleep 1881' & echo READY; exec sleep 1882";
    let t = create(&mut c, "t", &["sh", "-c", script], 40, 5);
    wait_until(10, "the tree", || status(&mut c).terminals.first().and_then(|t| t.processes) == Some(2));
    let _: UpgradeReply = c.request(holder_upgrade(&next)).unwrap();
    let mut c = d.reconnect(&instance);
    wait_until(15, "the new holder's brain", || {
        c = d.reconnect(&instance);
        c.welcome.generation == Some(2)
    });
    let st = status(&mut c);
    assert_eq!((st.daemon.holder.pid, st.daemon.holder.upgrades), (holder, 1));
    assert_eq!(st.daemon.trees.as_ref().map(|t| t.mode.as_str()), Some("cgroup"));
    assert_eq!(st.terminals[0].processes, Some(2), "the tree, across the exec");
    let cg = std::fs::read_to_string(format!("/proc/{holder}/cgroup")).unwrap();
    assert!(cg.trim_end().ends_with("/holder"), "the holder in its leaf: {cg}");
    let away: Vec<u32> = {
        let ps = std::process::Command::new("ps").args(["-eo", "pid=,args="]).output().unwrap();
        String::from_utf8_lossy(&ps.stdout)
            .lines()
            .filter(|l| l.contains("sleep 188") && !l.contains("sh -c"))
            .filter_map(|l| l.split_whitespace().next()?.parse().ok())
            .collect()
    };
    assert_eq!(away.len(), 2);
    let _: Empty = c.request(Op::Kill(Kill { id: "t".into(), signal: None })).unwrap();
    wait_until(5, "the whole tree to end", || away.iter().all(|&p| !alive(p)) && !alive(t.pid));
    let _: Empty = c.request(Op::Stop).unwrap();
    d.detached = None;
}
