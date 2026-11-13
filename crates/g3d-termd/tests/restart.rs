//! termd-ready gates for the holder/brain split (docs/termd/DESIGN.md, "termd-ready gates"): a
//! brain crash under a flood, an upgrade under a flood, a brain that never returns, the
//! watchdog, and the holder's death. Each on a private daemon.

mod common;

use common::*;
use g3d::Client;
use g3d_wire::frame;
use g3d_wire::*;
use std::time::{Duration, Instant};

fn pid_alive(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => !s.split(") ").nth(1).is_some_and(|r| r.starts_with('Z')),
        Err(_) => false,
    }
}

fn wait_until(secs: u64, what: &str, mut f: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn kill(pid: u32, sig: i32) {
    // SAFETY: signalling a process this test started (or its child).
    unsafe { libc::kill(pid as i32, sig) };
}

/// The numbers a `seq` printed, from terminal bytes: escape sequences, CRs and the spaces a
/// cursor left mid-row are not text, and an unterminated last line is not a line yet.
fn numbers(bytes: &[u8]) -> Vec<u64> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::new();
    let mut lines: Vec<&str> = text.split('\n').collect();
    lines.pop();
    for line in lines {
        let mut clean = String::new();
        let mut esc = false;
        for ch in line.chars() {
            if esc {
                if ch.is_ascii_alphabetic() || ch == '~' {
                    esc = false;
                }
                continue;
            }
            match ch {
                '\x1b' => esc = true,
                '\r' => {}
                c => clean.push(c),
            }
        }
        let clean = clean.trim();
        if !clean.is_empty() && clean.bytes().all(|b| b.is_ascii_digit()) {
            out.push(clean.parse().unwrap());
        }
    }
    out
}

/// Whether `v` counts up by one from its first element.
fn consecutive(v: &[u64]) -> bool {
    v.windows(2).all(|w| w[1] == w[0] + 1)
}

fn capture(c: &mut Client, id: &str) -> String {
    let r: CaptureReply = c
        .request(Op::Capture(Capture {
            id: id.into(),
            format: Some(CaptureFormat::Vt),
            history_rows: Some(0),
            unwrap: None,
        }))
        .unwrap();
    r.text
}

/// A shell showing a marker, quiet afterwards (on its own connection, so none of its frames
/// reach the caller's).
fn idle_shell(d: &Daemon, id: &str, marker: &str) -> CreateReply {
    let c = &mut d.client();
    let r = create(c, id, &["sh"], 60, 8);
    let s = subscribe(c, id, Role::Attach, None);
    c.input(s.handle, format!("printf '\\033[1;32m{marker}\\033[0m\\n'\r").as_bytes()).unwrap();
    let mut seen = Seen::default();
    read_until(c, &mut seen, 10, |s| contains(&s.output, format!("{marker}\x1b[0m").as_bytes()));
    let _: Empty = c.request(Op::Unsubscribe(HandleOnly { handle: s.handle })).unwrap();
    r
}

/// Narrow so the whole flood fits in the history (about 100 B a row at 10 columns): the
/// terminal's own scrollback is the record of what termd read.
const FLOOD_COLS: u16 = 10;
const FLOOD_HISTORY: u64 = 64 << 20;
const FLOOD_ARGS: [&str; 4] = ["--idle-exit", "0", "--max-scrollback", "67108864"];

fn flood_terminal(c: &mut Client, id: &str) -> CreateReply {
    c.request(Op::Create(Create {
        id: id.into(),
        argv: Some(vec!["sh".into()]),
        cols: FLOOD_COLS,
        rows: 5,
        scrollback_bytes: Some(FLOOD_HISTORY),
        ..Default::default()
    }))
    .unwrap()
}

/// The flood's lines as the terminal holds them (history and screen): the longest run counting
/// up from 1, and the longest run counting up to 300000. Between them is what termd never read
/// into its emulator (at most one partial line besides).
fn flood_history(c: &mut Client, id: &str) -> (Vec<u64>, Vec<u64>) {
    let r: CaptureReply = c
        .request(Op::Capture(Capture {
            id: id.into(),
            format: Some(CaptureFormat::Plain),
            history_rows: Some(400_000),
            unwrap: Some(true),
        }))
        .unwrap();
    let all = numbers(r.text.as_bytes());
    let start = all
        .iter()
        .position(|&n| n == 1)
        .unwrap_or_else(|| panic!("line 1 is not in the history: {:?}", &r.text[..r.text.len().min(300)]));
    let all = &all[start..];
    let mut pre = 1;
    while pre < all.len() && all[pre] == all[pre - 1] + 1 {
        pre += 1;
    }
    let mut post = all.len() - 1;
    while post > 0 && all[post] == all[post - 1] + 1 {
        post -= 1;
    }
    (all[..pre].to_vec(), all[post..].to_vec())
}

#[test]
fn brain_crash_under_a_flood_keeps_every_shell_and_restores_screens() {
    let mut args = FLOOD_ARGS.to_vec();
    args.extend(["--snapshot-interval-ms", "300"]);
    let d = Daemon::start_with(&args);
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    let brain1 = c.welcome.pid.unwrap();
    let quiet = idle_shell(&d, "quiet", "QUIET-MARKER");
    let before_quiet = capture(&mut c, "quiet");
    let flood = flood_terminal(&mut c, "flood");
    let s = c.request::<SubscribeReply>(sub_req("flood", Mode::Raw, Role::Own, Some(Flow::Block), None)).unwrap();
    // Let the quiet terminal's snapshot land (interval 300 ms) before the crash.
    std::thread::sleep(Duration::from_millis(800));
    c.input(s.handle, b"seq 1 300000; echo FLOOD-$((1+1))-DONE\r").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 30, |s| s.output.len() > 300_000);
    // Stop reading: the blocking owner holds the program back, and a snapshot lands mid-flood.
    std::thread::sleep(Duration::from_millis(800));
    let at = seen.output.len();
    read_until(&mut c, &mut seen, 30, |s| s.output.len() > at + 1_500_000);
    kill(brain1, libc::SIGKILL);
    let until = Instant::now() + Duration::from_secs(10);
    while let Ok(f) = c.next_frame() {
        seen.take(&f);
        assert!(Instant::now() < until, "the connection outlived its brain");
    }
    let end_before = seen.next_seq.unwrap();
    assert!(pid_alive(flood.pid) && pid_alive(quiet.pid), "a shell died with the brain");
    let pre = numbers(&seen.output);
    assert!(pre.len() > 1000 && pre[0] == 1 && consecutive(&pre), "before the crash: lines in order from 1");

    // Same namespace, a new brain; the terminals and their handles are still there.
    let mut c = d.reconnect(&instance);
    assert_eq!(c.welcome.generation, Some(2));
    assert_ne!(c.welcome.pid, Some(brain1));
    let l: ListReply = c.request(Op::List).unwrap();
    let ids: Vec<(&str, u32, u32)> = l.terminals.iter().map(|t| (t.id.as_str(), t.handle, t.pid)).collect();
    assert!(
        ids.contains(&("flood", flood.handle, flood.pid)) && ids.contains(&("quiet", quiet.handle, quiet.pid)),
        "{ids:?}"
    );

    // The quiet terminal had been snapshotted since its last output: it comes back exactly.
    assert_eq!(capture(&mut c, "quiet"), before_quiet, "the quiet screen came back exactly");

    // seq never repeats: the flood continues at or past where this subscriber stopped.
    let s2 = c.request::<SubscribeReply>(sub_req("flood", Mode::Raw, Role::Own, Some(Flow::Block), None)).unwrap();
    assert!(s2.seq >= end_before, "seq repeated: resubscribed at {} after {end_before}", s2.seq);
    let mut after = Seen::default();
    read_until(&mut c, &mut after, 60, |s| tail_contains(&s.output, b"FLOOD-2-DONE"));
    assert!(after.gaps.is_empty(), "gaps after the restart: {:?}", after.gaps);

    // The terminal's own record: every line up to the last snapshot, every line after the high-
    // water mark, and between them exactly the bytes the brain says it never saw.
    let (head, tail) = flood_history(&mut c, "flood");
    assert_eq!(*tail.last().unwrap(), 300000);
    let log = d.log();
    assert!(log.contains("brain CRASHED"), "the holder says so: {log}");
    // "terminal flood: restored from a snapshot at seq B; the last brain read to seq H: N B unseen"
    let line = log
        .lines()
        .find(|l| l.contains("terminal flood: restored from a snapshot at seq"))
        .unwrap_or_else(|| panic!("{log}"));
    let nums: Vec<u64> =
        line.split(|c: char| !c.is_ascii_digit()).filter(|w| !w.is_empty()).map(|w| w.parse().unwrap()).collect();
    let (bseq, hw, unseen) = (nums[nums.len() - 3], nums[nums.len() - 2], nums[nums.len() - 1]);
    assert_eq!(hw - bseq, unseen);
    // Where the flood starts in seq: the subscriber's stream before the crash knows.
    let first = seen.output.windows(9).position(|w| w == b"1\r\n2\r\n3\r\n").expect("the flood's start") as u64;
    let flood_start = s.seq + first;
    // The line holding a seq position, and how far into it.
    let line_at = |seq: u64| -> (u64, u64) {
        let mut off = flood_start;
        let mut n = 1;
        loop {
            let len = n.to_string().len() as u64 + 2;
            if seq < off + len {
                return (n, seq - off);
            }
            off += len;
            n += 1;
        }
    };
    let (lb, ob) = line_at(bseq);
    let (lh, oh) = line_at(hw);
    eprintln!(
        "crash: snapshot at line {lb}+{ob}, high-water at line {lh}+{oh}; history {}..{} | {}..",
        head[0],
        head.last().unwrap(),
        tail[0]
    );
    // Every line before the snapshot's is whole, and every line after the high-water's.
    // The line the snapshot cut through is whole only when the cut fell after its digits and the
    // resumed bytes start a line; a cut line merges with the first resumed fragment otherwise.
    let h = *head.last().unwrap();
    assert!(
        h == lb - 1 || (h == lb && ob > 0),
        "the history keeps every line up to the snapshot (line {lb}+{ob}), not {h}"
    );
    // The mark may overstate by one read's worth (a kill between marking and reading): then
    // the next brain reads those bytes, and more lines are kept than the report counts. It
    // never understates: every line after the mark arrives.
    let want_tail = if ob == 0 && oh == 0 { lh } else { lh + 1 };
    assert!(
        tail[0] <= want_tail,
        "every line after the high-water mark (line {lh}+{oh}) arrives; the history resumes at {}",
        tail[0]
    );
    let screen = capture(&mut c, "flood");
    assert!(screen.contains("FLOOD-2-"), "{screen}");
}

/// A terminal restored from an older snapshot saves a new one of what it now shows, even while
/// quiet: the next crash restores that (exact), and the loss is reported once, not at every crash.
#[test]
fn a_terminal_restored_from_a_snapshot_snapshots_again() {
    let d = Daemon::start_with(&["--idle-exit", "0", "--snapshot-interval-ms", "1500"]);
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    create(&mut c, "cat", &["cat"], 40, 5);
    let s = subscribe(&mut c, "cat", Role::Attach, None);
    c.input(s.handle, b"first\n").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| tail_contains(&s.output, b"first\r\nfirst"));
    // Its snapshot lands (1.5 s), then more output and a crash before the next one.
    std::thread::sleep(Duration::from_millis(2000));
    c.input(s.handle, b"second\n").unwrap();
    read_until(&mut c, &mut seen, 10, |s| tail_contains(&s.output, b"second\r\nsecond"));
    kill(c.welcome.pid.unwrap(), libc::SIGKILL);
    let mut c = d.reconnect(&instance);
    let st: StatusReply = c.request(Op::Status).unwrap();
    let t = st.status.terminals.iter().find(|t| t.id == "cat").unwrap();
    assert_eq!(t.restored.as_deref(), Some("snapshot"));
    assert!(st.status.daemon.brain.last_start.unseen > 0);
    // The loss is the terminal's own, too (its only terminal: the namespace's total).
    assert_eq!(t.unseen, Some(st.status.daemon.brain.last_start.unseen));
    // Quiet now; past an interval the restored screen is saved, so the next crash loses nothing.
    std::thread::sleep(Duration::from_millis(2500));
    kill(c.welcome.pid.unwrap(), libc::SIGKILL);
    let mut c = d.reconnect(&instance);
    let st: StatusReply = c.request(Op::Status).unwrap();
    let t = st.status.terminals.iter().find(|t| t.id == "cat").unwrap();
    assert_eq!(t.restored.as_deref(), Some("exact"), "the stale snapshot was restored again\n{}", d.log());
    assert_eq!(st.status.daemon.brain.last_start.unseen, 0);
    assert_eq!(t.unseen, Some(0));
    assert_eq!(d.log().matches("terminal cat: restored from a snapshot").count(), 1, "{}", d.log());
}

#[test]
fn upgrade_under_a_flood_loses_no_byte() {
    let d = Daemon::start_with(&FLOOD_ARGS);
    // A rebuilt binary is a different file at another path.
    let next = d.dir.join("g3d-termd-next");
    std::fs::copy(bin(), &next).unwrap();
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    let brain1 = c.welcome.pid.unwrap();
    idle_shell(&d, "quiet", "QUIET-MARKER");
    let before_quiet = capture(&mut c, "quiet");
    flood_terminal(&mut c, "flood");
    let s = c.request::<SubscribeReply>(sub_req("flood", Mode::Raw, Role::Own, Some(Flow::Block), None)).unwrap();
    c.input(s.handle, b"seq 1 300000; echo FLOOD-$((1+1))-DONE\r").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 30, |s| s.output.len() > 400_000);

    let mut asker = d.client();
    let r: UpgradeReply =
        asker.request(Op::Upgrade(Upgrade { binary: Some(next.display().to_string()), holder: None })).unwrap();
    assert_eq!(r.generation, 1);
    // Every frame up to the cut, then ERROR restart.
    let err = loop {
        match c.next_frame() {
            Ok(f) => seen.take(&f),
            Err(e) => break e,
        }
    };
    assert_eq!(err.code(), Some(code::RESTART), "{err}");
    assert_eq!(asker.next_frame().unwrap_err().code(), Some(code::RESTART));
    assert!(seen.gaps.is_empty());
    let cut = seen.next_seq.unwrap();

    let mut c = d.reconnect(&instance);
    assert_eq!(c.welcome.generation, Some(2));
    assert_ne!(c.welcome.pid, Some(brain1));
    assert!(!pid_alive(brain1), "the old brain exited");
    let log = d.log();
    assert!(log.contains("restored 2 terminal(s): 2 exact") && log.contains("(generation 2) serves"), "{log}");
    // The new brain read on from the cut while nobody subscribed; we join at its seq.
    let s2 = c.request::<SubscribeReply>(sub_req("flood", Mode::Raw, Role::Own, Some(Flow::Block), None)).unwrap();
    assert!(s2.seq >= cut);
    let mut after = Seen::default();
    read_until(&mut c, &mut after, 60, |s| tail_contains(&s.output, b"FLOOD-2-DONE"));
    assert!(after.gaps.is_empty(), "no byte skipped after the upgrade: {:?}", after.gaps);
    // The terminal's own record holds every line, across the handoff.
    let (head, tail) = flood_history(&mut c, "flood");
    assert_eq!((head.len(), tail.len()), (300000, 300000), "every line of the flood, in order, across the upgrade");
    assert_eq!(capture(&mut c, "quiet"), before_quiet, "the same screen");
}

#[test]
fn a_failed_upgrade_leaves_the_running_brain_serving() {
    let d = Daemon::start_with(&["--idle-exit", "0", "--upgrade-deadline", "2"]);
    let mut c = d.client();
    let brain1 = c.welcome.pid.unwrap();
    create(&mut c, "a", &["cat"], 40, 5);
    let s = subscribe(&mut c, "a", Role::Attach, None);
    let dies = d.dir.join("dies.sh");
    let hangs = d.dir.join("hangs.sh");
    std::fs::write(&dies, "#!/bin/sh\nexit 3\n").unwrap();
    std::fs::write(&hangs, "#!/bin/sh\nexec sleep 100\n").unwrap();
    for p in [&dies, &hangs] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    for (bin, why) in [(&dies, "exited"), (&hangs, "not ready")] {
        let _: UpgradeReply =
            c.request(Op::Upgrade(Upgrade { binary: Some(bin.display().to_string()), holder: None })).unwrap();
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
        // The same brain, the same connection, the terminal still answers.
        c.input(s.handle, b"still here\r").unwrap();
        read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"still here\r\nstill here"));
    }
    assert!(pid_alive(brain1));
    assert_eq!(d.client().welcome.generation, Some(1));
    // A binary that isn't one is refused at once.
    let e = c
        .request::<UpgradeReply>(Op::Upgrade(Upgrade { binary: Some("/nonexistent".into()), holder: None }))
        .unwrap_err();
    assert_eq!(e.code(), Some(code::BAD_REQUEST));
}

#[cfg(feature = "test-hooks")]
#[test]
fn an_upgrade_to_another_engine_hands_over_by_repaint() {
    let d = Daemon::start_env(&["--idle-exit", "0"], &[("G3D_TERMD_TEST_ENGINE_FILE", "engine")]);
    let file = d.dir.join("engine");
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    let r = idle_shell(&d, "quiet", "VT-MARKER");
    let before = capture(&mut c, "quiet");
    std::fs::write(&file, "some-other-engine/9.9").unwrap();
    let _: UpgradeReply = c.request(Op::Upgrade(Upgrade::default())).unwrap();
    let err = loop {
        if let Err(e) = c.next_frame() {
            break e;
        }
    };
    assert_eq!(err.code(), Some(code::RESTART), "{err}");
    let mut c = d.reconnect(&instance);
    assert_eq!(c.welcome.generation, Some(2));
    assert_eq!(capture(&mut c, "quiet"), before, "the VT handoff reproduces the screen");
    assert!(d.log().contains("VT repaints (another engine)"), "{}", d.log());
    // The program is the same one, and it still answers.
    let l: ListReply = c.request(Op::List).unwrap();
    assert_eq!(l.terminals[0].pid, r.pid);
    let s = subscribe(&mut c, "quiet", Role::Attach, None);
    c.input(s.handle, b"echo again-$((2+2))\r").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"again-4"));
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_brain_that_never_returns_leaves_the_shells_frozen_and_says_so() {
    let d = Daemon::start_env(
        &[
            "--idle-exit",
            "0",
            "--brain-start-burst",
            "3",
            "--brain-restart-delay-ms",
            "50",
            "--brain-failed-backoff",
            "600",
        ],
        &[("G3D_TERMD_TEST_BRAIN_FAIL_FILE", "brain-fails")],
    );
    let fail = d.dir.join("brain-fails");
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    let brain1 = c.welcome.pid.unwrap();
    let t = create(&mut c, "a", &["sh"], 40, 5);
    std::fs::write(&fail, "").unwrap();
    kill(brain1, libc::SIGKILL);
    drop(c);
    // Every restart exits at once: past the burst the brain is failed, and the holder answers.
    let mut refusal = None;
    wait_until(15, "brain_failed", || match Client::connect(&d.socket, "test") {
        Err(e) if e.code() == Some(code::BRAIN_FAILED) => {
            refusal = Some(e.to_string());
            true
        }
        _ => false,
    });
    let msg = refusal.unwrap();
    assert!(msg.contains(&format!("holder pid {}", d.pid())) && msg.contains("SIGHUP"), "{msg}");
    // A client that follows the handshake (connect, HELLO, read) while the holder has already
    // answered: its HELLO lands and its read finds the ERROR, never EPIPE (a lingering close).
    for _ in 0..3 {
        use std::io::{Read, Write};
        let mut raw = std::os::unix::net::UnixStream::connect(&d.socket).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let hello = Hello { proto: PROTO, client: "doc-client".into() };
        raw.write_all(&g3d_wire::frame::encode_json(g3d_wire::frame::ty::HELLO, 0, &hello))
            .expect("HELLO to a failed namespace's holder failed: it closed before reading");
        raw.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut got = Vec::new();
        raw.read_to_end(&mut got).unwrap();
        let mut dec = FrameDecoder::default();
        dec.feed(&got);
        let f = dec.next_frame().unwrap().expect("no frame before the close");
        assert_eq!(f.ty, g3d_wire::frame::ty::ERROR);
        let e: WireError = serde_json::from_slice(&f.payload).unwrap();
        assert_eq!(e.code, code::BRAIN_FAILED, "{}", e.message);
    }
    // The reference client says why too, however late it writes.
    let e = Client::connect(&d.socket, "test").err().expect("a failed brain answered WELCOME");
    assert_eq!(e.code(), Some(code::BRAIN_FAILED), "{e}");
    assert!(pid_alive(t.pid), "the shell is alive while no brain runs");
    assert!(d.log().contains("brain FAILED"), "{}", d.log());
    // A fixed brain, and SIGHUP: it comes back at once, with the terminal.
    std::fs::remove_file(&fail).unwrap();
    kill(d.pid(), libc::SIGHUP);
    let mut c = d.reconnect(&instance);
    let l: ListReply = c.request(Op::List).unwrap();
    assert_eq!(l.terminals.iter().map(|x| (x.id.as_str(), x.pid)).collect::<Vec<_>>(), vec![("a", t.pid)]);
    let s = subscribe(&mut c, "a", Role::Attach, None);
    c.input(s.handle, b"echo back-$((5*5))\r").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"back-25"));
}

#[cfg(feature = "test-hooks")]
#[test]
fn the_watchdog_aborts_a_silent_brain() {
    let d = Daemon::start_with(&["--idle-exit", "0", "--brain-watchdog", "2"]);
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    let brain1 = c.welcome.pid.unwrap();
    let t = create(&mut c, "a", &["cat"], 40, 5);
    let s = subscribe(&mut c, "a", Role::Attach, None);
    c.input(s.handle, owner_hook(b"wedge")).unwrap();
    wait_until(15, "the watchdog to end the silent brain", || !pid_alive(brain1));
    let mut c = d.reconnect(&instance);
    assert_eq!(c.welcome.generation, Some(2));
    assert!(pid_alive(t.pid));
    let log = d.log();
    assert!(log.contains("watchdog: brain pid") && log.contains("killed by the watchdog"), "{log}");
    let s = subscribe(&mut c, "a", Role::Attach, None);
    c.input(s.handle, b"after\r").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"after\r\nafter"));
}

#[cfg(feature = "test-hooks")]
fn owner_hook(name: &[u8]) -> &'static [u8] {
    match name {
        b"wedge" => b"\x00g3d-termd-test-wedge\x00",
        _ => unreachable!(),
    }
}

#[test]
fn the_holders_death_ends_every_shell_loudly() {
    let mut d = Daemon::start();
    let mut c = d.client();
    let brain = c.welcome.pid.unwrap();
    let a = create(&mut c, "a", &["sh"], 40, 5);
    let b = create(&mut c, "b", &["sleep", "100"], 40, 5);
    let mut holder = d.child.take().unwrap();
    holder.kill().unwrap(); // SIGKILL: no cleanup runs
    holder.wait().unwrap();
    // Every PTY master closes: the brain's with the brain, the holder's with the holder.
    wait_until(5, "the brain to leave", || !pid_alive(brain));
    wait_until(5, "the shells to hang up", || !pid_alive(a.pid) && !pid_alive(b.pid));
    assert!(c.next_frame().is_err(), "clients are dropped");
    let e = Client::connect(&d.socket, "test").err().expect("nothing listens");
    assert!(
        matches!(&e, g3d::ClientError::Io(io) if matches!(io.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound)),
        "{e}"
    );
    assert!(d.log().contains("the holder closed the link"), "the brain says why it left: {}", d.log());
}
