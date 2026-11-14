//! termd's S1 unit gates (docs/termd/DESIGN.md, "S1 gates"), each against a private daemon.

mod common;

use common::*;
use g3d::Client;
use g3d_wire::frame::{self, ty};
use g3d_wire::*;
use std::time::{Duration, Instant};

fn pid_alive(pid: u32) -> bool {
    // A zombie is still listed; read its state.
    ps_field(pid, "stat").is_some_and(|s| !s.starts_with('Z'))
}

fn wait_dead(pid: u32, secs: u64) -> bool {
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn handshake_refuses_another_major() {
    let d = Daemon::start();
    let mut s = std::os::unix::net::UnixStream::connect(&d.socket).unwrap();
    use std::io::{Read, Write};
    s.write_all(&frame::encode_json(ty::HELLO, 0, &Hello { proto: [2, 0], client: "future".into() })).unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).unwrap();
    let mut dec = FrameDecoder::default();
    dec.feed(&buf);
    let f = dec.next_frame().unwrap().unwrap();
    assert_eq!(f.ty, ty::ERROR);
    let e: WireError = serde_json::from_slice(&f.payload).unwrap();
    assert_eq!(e, WireError::new(code::VERSION, "daemon speaks 1.x; client sent 2.0"));

    let c = d.client();
    assert_eq!(c.welcome.proto, PROTO);
    assert_eq!(
        c.welcome.features,
        vec!["raw", "view", "capture", "status", "upgrade", "env", "key", "paste", "option_as_alt"]
    );
    assert_eq!(c.welcome.proto, [1, 3]);
    // 1.1: the namespace's identity, the brain's generation, the holder.
    assert_eq!(c.welcome.instance.as_ref().map(String::len), Some(16));
    assert_eq!(c.welcome.generation, Some(1));
    let holder = c.welcome.holder.clone().unwrap();
    assert_eq!(holder.pid, d.pid());
    assert_ne!(c.welcome.pid, Some(d.pid()), "WELCOME.pid is the brain's");
    assert_eq!(c.welcome.engine, "libghostty-vt/1.0.1");
    // Started on an explicit --socket: there is no namespace to name.
    assert_eq!(c.welcome.ns, None);
}

#[test]
fn create_list_kill_and_if_exists() {
    let d = Daemon::start();
    let mut c = d.client();
    let r = create(&mut c, "t1", &["sh", "-c", "echo hi; exec sleep 100"], 80, 24);
    assert!(r.created && r.handle != 0 && r.pid != 0);
    let again =
        c.request::<CreateReply>(Op::Create(Create { id: "t1".into(), cols: 10, rows: 10, ..Default::default() }));
    assert_eq!(again.unwrap_err().code(), Some(code::EXISTS));
    let adopt: CreateReply = c
        .request(Op::Create(Create {
            id: "t1".into(),
            cols: 10,
            rows: 10,
            if_exists: Some(IfExists::Adopt),
            ..Default::default()
        }))
        .unwrap();
    assert_eq!((adopt.created, adopt.handle, adopt.pid, adopt.cols, adopt.rows), (false, r.handle, r.pid, 80, 24));

    let bad =
        c.request::<CreateReply>(Op::Create(Create { id: "bad id".into(), cols: 1, rows: 1, ..Default::default() }));
    assert_eq!(bad.unwrap_err().code(), Some(code::BAD_REQUEST));
    let nope = c.request::<CreateReply>(Op::Create(Create {
        id: "t2".into(),
        argv: Some(vec!["/nonexistent/program".into()]),
        cols: 80,
        rows: 24,
        ..Default::default()
    }));
    assert_eq!(nope.unwrap_err().code(), Some(code::SPAWN_FAILED));

    let l: ListReply = c.request(Op::List).unwrap();
    assert_eq!(l.terminals.len(), 1);
    let t = &l.terminals[0];
    assert_eq!((t.id.as_str(), t.handle, t.cols, t.rows), ("t1", r.handle, 80, 24));
    // What runs: `sh` resolved in the program's own PATH, then its arguments.
    assert!(t.argv[0].starts_with('/') && t.argv[0].ends_with("/sh"), "{:?}", t.argv);
    assert_eq!(t.argv[1..], ["-c", "echo hi; exec sleep 100"]);
    assert_eq!(t.argv, r.argv);

    // Unknown ops keep the connection.
    let raw = c.send_request(Op::Ping).unwrap();
    let _ = raw;
    c.send(&frame::encode(ty::REQUEST, 0, br#"{"req":99,"op":"teleport"}"#)).unwrap();
    loop {
        let f = c.next_frame().unwrap();
        if f.ty == ty::REPLY {
            let h: ReplyHead = serde_json::from_slice(&f.payload).unwrap();
            if h.req == 99 {
                assert_eq!(h.error.unwrap().code, code::UNKNOWN_OP);
                break;
            }
        }
    }

    let _: Empty = c.request(Op::Kill(Kill { id: "t1".into(), signal: None })).unwrap();
    assert!(wait_dead(r.pid, 3), "the program outlived kill");
    let l: ListReply = c.request(Op::List).unwrap();
    assert!(l.terminals.is_empty());
    let gone = c.request::<Empty>(Op::Kill(Kill { id: "t1".into(), signal: None }));
    assert_eq!(gone.unwrap_err().code(), Some(code::NO_TERMINAL));
}

#[test]
fn a_program_that_exits_leaves_exit_then_closed() {
    let d = Daemon::start();
    let mut c = d.client();
    create(&mut c, "t", &["sh", "-c", "sleep 0.3; printf bye; exit 3"], 40, 5);
    let s = subscribe(&mut c, "t", Role::Watch, None);
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| s.closed);
    assert!(contains(&seen.output, b"bye"));
    let n = seen.events.len();
    assert_eq!(seen.events[n - 1], Event::Closed);
    match &seen.events[n - 2] {
        Event::Exit { code, signal, seq } => {
            assert_eq!((*code, signal.as_deref()), (Some(3), None));
            assert_eq!(*seq, seen.next_seq.unwrap());
        }
        e => panic!("expected exit before closed, got {e:?}"),
    }
    assert!(s.handle != 0);
    let l: ListReply = c.request(Op::List).unwrap();
    assert!(l.terminals.is_empty());
}

#[test]
fn input_reaches_the_program_and_watch_is_read_only() {
    let d = Daemon::start();
    let mut c = d.client();
    create(&mut c, "t", &["cat"], 40, 5);
    let s = subscribe(&mut c, "t", Role::Attach, None);
    c.input(s.handle, b"hello\r").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"hello\r\nhello\r\n"));

    let mut w = d.client();
    let ws = subscribe(&mut w, "t", Role::Watch, None);
    w.input(ws.handle, b"nope\r").unwrap();
    let mut wseen = Seen::default();
    read_until(&mut w, &mut wseen, 10, |s| {
        s.events.iter().any(|e| matches!(e, Event::Error { code, .. } if code == code::READ_ONLY))
    });

    // INPUT without a subscription.
    let mut x = d.client();
    x.input(s.handle, b"x").unwrap();
    let f = x.next_frame().unwrap();
    let ev: Event = serde_json::from_slice(&f.payload).unwrap();
    assert!(matches!(ev, Event::Error { code, .. } if code == code::NOT_SUBSCRIBED));
}

/// One INPUT far bigger than the kernel's PTY input queue (1 KiB on macOS, 4 KiB on Linux)
/// reaches a raw-mode program whole and in order: termd keeps what the PTY refuses and
/// writes it as the program reads.
#[test]
fn input_bigger_than_the_pty_queue_arrives_whole() {
    let d = Daemon::start();
    let mut c = d.client();
    const N: usize = 256 << 10;
    let script = format!("stty raw -echo; printf READY; head -c {N} | cksum; sleep 5");
    create(&mut c, "t", &["sh", "-c", &script], 80, 24);
    let s = subscribe(&mut c, "t", Role::Attach, None);
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"READY"));
    // Text and newlines: nothing a raw tty still acts on (XON/XOFF, with IXON on).
    let data: Vec<u8> = (0..N).map(|i| b"abcdefghijklmnopqrstuvwxyz0123456789\n"[i % 37]).collect();
    c.input(s.handle, &data).unwrap();
    let mut ck = std::process::Command::new("cksum")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    ck.stdin.take().unwrap().write_all(&data).unwrap();
    let want = String::from_utf8(ck.wait_with_output().unwrap().stdout).unwrap();
    let want = want.trim();
    read_until(&mut c, &mut seen, 20, |s| contains(&s.output, want.as_bytes()));
}

/// Two subscribers: one from the start (its emulator is the truth), one late (its
/// emulator is built from a repaint). Both must show the same screen.
fn repaint_matches(script: &str, check_alt: bool) {
    let d = Daemon::start();
    let mut c = d.client();
    create(&mut c, "t", &["sh", "-c", script], 60, 12);
    let early = subscribe(&mut c, "t", Role::Attach, None);
    let mut truth = Seen::default();
    read_until(&mut c, &mut truth, 10, |s| contains(&s.bytes, b"READY"));

    let mut late_c = d.client();
    let late = subscribe(&mut late_c, "t", Role::Watch, None);
    let mut seen = Seen::default();
    read_until(&mut late_c, &mut seen, 10, |s| !s.repaints.is_empty());
    assert_eq!(early.handle, late.handle);
    let (head, _) = &seen.repaints[0];
    assert_eq!((head.cols, head.rows, head.flags), (60, 12, 0));
    assert_eq!(head.seq, truth.next_seq.unwrap());

    let a = viewer(60, 12, &truth.bytes);
    let b = viewer(60, 12, &seen.bytes);
    assert_eq!(plain(&a), plain(&b), "plain text differs");
    assert_eq!(
        format(&a, libghostty_vt::fmt::Format::Vt),
        format(&b, libghostty_vt::fmt::Format::Vt),
        "styled text differs"
    );
    assert_eq!(
        (a.cursor_x().unwrap(), a.cursor_y().unwrap()),
        (b.cursor_x().unwrap(), b.cursor_y().unwrap()),
        "cursor"
    );
    assert_eq!(a.active_screen().unwrap(), b.active_screen().unwrap(), "screen");
    if check_alt {
        assert_eq!(a.active_screen().unwrap(), libghostty_vt::screen::Screen::Alternate);
    }
    for m in [
        libghostty_vt::mode::Mode::BRACKETED_PASTE,
        libghostty_vt::mode::Mode::CURSOR_VISIBLE,
        libghostty_vt::mode::Mode::DECCKM,
        libghostty_vt::mode::Mode::NORMAL_MOUSE,
        libghostty_vt::mode::Mode::SGR_MOUSE,
        libghostty_vt::mode::Mode::WRAPAROUND,
        libghostty_vt::mode::Mode::ORIGIN,
    ] {
        assert_eq!(a.mode(m).unwrap(), b.mode(m).unwrap(), "mode {m:?}");
    }
    assert_eq!(a.title().unwrap(), b.title().unwrap(), "title");
}

#[test]
fn repaint_rebuilds_the_primary_screen() {
    repaint_matches(
        r#"stty -opost; printf '\033]2;my title\007\033[?2004h\033[?1h'; i=0; while [ $i -lt 30 ]; do printf '\033[3%dmline %d \033[1mbold\033[0m tail\r\n' $((i%8)) $i; i=$((i+1)); done; printf '\033[5;7Hcursor\033[4 qREADY'; exec sleep 100"#,
        false,
    );
}

#[test]
fn repaint_rebuilds_the_alternate_screen() {
    repaint_matches(
        r#"stty -opost; printf 'primary text\r\n\033[?1049h\033[2J\033[H\033[7mvim-like\033[0m\r\n\033[?1000h\033[?1006h\033[?25l\033[3;4r\033[10;5HREADY'; exec sleep 100"#,
        true,
    );
}

#[test]
fn subscribe_cut_mid_escape_sequence_continues_it() {
    let d = Daemon::start();
    let mut c = d.client();
    create(
        &mut c,
        "t",
        &["sh", "-c", r#"printf 'abc\033[3'; sleep 1.5; printf '1mRED\033[0m'; exec sleep 100"#],
        40,
        5,
    );
    std::thread::sleep(Duration::from_millis(600));
    subscribe(&mut c, "t", Role::Watch, None);
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"RED"));
    let v = viewer(40, 5, &seen.bytes);
    let text = plain(&v);
    assert!(text.starts_with("abcRED"), "screen is {text:?} (without the continuation it reads abc1mRED)");
}

#[test]
fn resize_event_seq_is_exact() {
    let d = Daemon::start();
    let mut c = d.client();
    create(
        &mut c,
        "t",
        &["sh", "-c", r#"trap 'printf "SIZE[%s]" "$(stty size)"' WINCH; printf READY; while :; do sleep 0.05; done"#],
        80,
        24,
    );
    let s = c
        .request::<SubscribeReply>(Op::Subscribe(Subscribe {
            id: "t".into(),
            mode: Mode::Raw,
            role: Role::Own,
            history_rows: None,
            flow: None,
            cols: None,
            rows: None,
        }))
        .unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
    let _: Empty = c.request(Op::Resize(Resize { handle: s.handle, cols: 100, rows: 30 })).unwrap();
    // A watcher can't resize.
    let mut w = d.client();
    let ws = subscribe(&mut w, "t", Role::Watch, None);
    assert_eq!(
        w.request::<Empty>(Op::Resize(Resize { handle: ws.handle, cols: 10, rows: 10 })).unwrap_err().code(),
        Some(code::NOT_OWNER)
    );

    let mut offset_of_size = None;
    let mut seq_at_size = 0;
    read_until(&mut c, &mut seen, 10, |s| {
        if offset_of_size.is_none()
            && let Some(Event::Size { seq, cols: 100, rows: 30 }) = s.events.last()
        {
            offset_of_size = Some(s.output.len());
            seq_at_size = *seq;
        }
        contains(&s.output, b"SIZE[30 100]")
    });
    let at = offset_of_size.expect("a size event");
    let pos = seen.output.windows(12).position(|w| w == b"SIZE[30 100]").unwrap();
    assert!(pos >= at, "the program's new-size output arrived before the size event");
    assert!(seq_at_size > 0);
    let l: ListReply = c.request(Op::List).unwrap();
    assert_eq!((l.terminals[0].cols, l.terminals[0].rows), (100, 30));
    assert_eq!(l.terminals[0].subscribers, SubscriberCounts { own: 1, attach: 0, watch: 1 });
}

#[test]
fn take_moves_ownership_and_demotes_the_old_owner() {
    let d = Daemon::start();
    let mut a = d.client();
    create(&mut a, "t", &["sleep", "100"], 80, 24);
    let sa = a
        .request::<SubscribeReply>(Op::Subscribe(Subscribe {
            id: "t".into(),
            mode: Mode::None,
            role: Role::Own,
            history_rows: None,
            flow: None,
            cols: Some(90),
            rows: Some(20),
        }))
        .unwrap();
    assert_eq!((sa.cols, sa.rows), (90, 20));
    let mut b = d.client();
    let sb = subscribe(&mut b, "t", Role::Attach, None);
    // The taker: its reply, then the size event.
    let req = b.send_request(Op::Take(Take { handle: sb.handle, cols: Some(70), rows: Some(10) })).unwrap();
    let mut order = Vec::new();
    while !(order.iter().any(|o| o == "size") && order.iter().any(|o| o == "reply")) {
        let f = b.next_frame().unwrap();
        match f.ty {
            ty::REPLY => {
                let h: ReplyHead = serde_json::from_slice(&f.payload).unwrap();
                assert_eq!(h.req, req);
                let r: TakeReply = serde_json::from_slice(&f.payload).unwrap();
                assert_eq!(r.role, Role::Own);
                order.push("reply".to_owned());
            }
            ty::EVENT => {
                let v: serde_json::Value = serde_json::from_slice(&f.payload).unwrap();
                order.push(v["ev"].as_str().unwrap().to_owned());
            }
            _ => {}
        }
    }
    let at =
        |o: &[String], what: &str| o.iter().position(|x| x == what).unwrap_or_else(|| panic!("no {what} in {o:?}"));
    assert!(at(&order, "reply") < at(&order, "size"), "taker saw {order:?}");
    // The old owner: `role` first, so it knows the size is no longer its own.
    let mut seen = Seen::default();
    read_until(&mut a, &mut seen, 5, |s| s.events.iter().any(|e| matches!(e, Event::Size { cols: 70, rows: 10, .. })));
    assert!(at(&seen.trace, "role") < at(&seen.trace, "size"), "old owner saw {:?}", seen.trace);
    assert!(seen.events.contains(&Event::Role { role: Role::Attach }));
    assert_eq!(
        a.request::<Empty>(Op::Resize(Resize { handle: sa.handle, cols: 10, rows: 10 })).unwrap_err().code(),
        Some(code::NOT_OWNER)
    );

    // Subscribing as `own` with a size takes it too; the demoted owner hears `role`, then `size`.
    let mut c = d.client();
    let _: SubscribeReply = c.request(sub_req("t", Mode::None, Role::Own, None, Some((60, 15)))).unwrap();
    let mut bseen = Seen::default();
    let is_new_size = |e: &Event| matches!(e, Event::Size { cols: 60, rows: 15, .. });
    read_until(&mut b, &mut bseen, 5, |s| s.events.iter().any(is_new_size));
    let role = bseen.events.iter().position(|e| *e == Event::Role { role: Role::Attach }).expect("a role event");
    assert!(role < bseen.events.iter().position(is_new_size).unwrap(), "{:?}", bseen.events);
}

#[test]
fn queries_are_answered_exactly_once() {
    let d = Daemon::start();
    let mut c = d.client();
    // Two raw subscribers see the query; neither answers. termd answers once.
    create(
        &mut c,
        "t",
        &[
            "sh",
            "-c",
            r#"stty -echo -icanon min 0 time 10; printf '\033[c\033[6n\033]11;?\033\\'; sleep 0.5; x=$(dd bs=512 count=1 2>/dev/null | od -An -c | tr -d ' \n'); printf 'GOT[%s]' "$x"; exec sleep 100"#,
        ],
        40,
        5,
    );
    let _a = subscribe(&mut c, "t", Role::Attach, None);
    let mut w = d.client();
    let _b = subscribe(&mut w, "t", Role::Attach, None);
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.output, b"]") && contains(&s.output, b"GOT["));
    let out = String::from_utf8_lossy(&seen.output).into_owned();
    let got = &out[out.find("GOT[").unwrap()..];
    assert_eq!(got.matches("?62;22c").count(), 1, "DA1 answers: {got}");
    assert_eq!(got.matches("R").count(), 1, "CPR answers: {got}");
    assert_eq!(got.matches("rgb:1010/1212/1414").count(), 1, "OSC 11 answers: {got}");
}

#[test]
fn view_scrolls_back_and_stays_anchored() {
    let d = Daemon::start();
    let mut c = d.client();
    create(
        &mut c,
        "t",
        &[
            "sh",
            "-c",
            r#"stty -opost; i=0; while [ $i -lt 100 ]; do printf 'L%03d\r\n' $i; i=$((i+1)); done; printf READY; read x; printf 'M1\r\nM2\r\nM3\r\n'; exec sleep 100"#,
        ],
        20,
        5,
    );
    let s = subscribe(&mut c, "t", Role::Attach, None);
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
    let v: ViewReply = c.request(Op::View(View { handle: s.handle, delta: Some(10), live: None })).unwrap();
    assert_eq!(v.offset, 10);
    assert!(v.max >= 96);
    read_until(&mut c, &mut seen, 5, |s| s.repaints.len() >= 2);
    let (h, vt) = seen.repaints.last().unwrap().clone();
    assert_eq!(h.flags, frame::REPAINT_FLAG_VIEW);
    let vw = viewer(20, 5, &vt);
    let rows: Vec<String> = plain(&vw).lines().map(|l| l.trim_end().to_owned()).collect();
    assert_eq!(rows[0], "L086", "view top: {rows:?}");

    // New output while viewing: no OUTPUT reaches this subscriber; the view stays put.
    let mut other = d.client();
    let os = subscribe(&mut other, "t", Role::Attach, None);
    other.input(os.handle, b"\r").unwrap();
    let mut oseen = Seen::default();
    read_until(&mut other, &mut oseen, 5, |s| contains(&s.output, b"M3"));
    let before = seen.output.len();
    let v: ViewReply = c.request(Op::View(View { handle: s.handle, delta: Some(1), live: None })).unwrap();
    // Four new rows (the echoed Enter, M1, M2, M3): the view moved back with them, then one more.
    assert_eq!(v.offset, 15);
    read_until(&mut c, &mut seen, 5, |s| s.repaints.len() >= 3);
    assert_eq!(seen.output.len(), before, "OUTPUT arrived while scrolled back");
    let (_, vt) = seen.repaints.last().unwrap().clone();
    let rows: Vec<String> = plain(&viewer(20, 5, &vt)).lines().map(|l| l.trim_end().to_owned()).collect();
    assert_eq!(rows[0], "L085");

    let v: ViewReply = c.request(Op::View(View { handle: s.handle, delta: None, live: Some(true) })).unwrap();
    assert_eq!(v.offset, 0);
    read_until(&mut c, &mut seen, 5, |s| s.repaints.len() >= 4);
    let (h, _) = seen.repaints.last().unwrap();
    assert_eq!(h.flags, 0);
    let live = viewer(20, 5, &seen.repaints.last().unwrap().1);
    assert!(plain(&live).contains("M3"));
}

#[test]
fn history_rows_land_in_the_viewers_scrollback() {
    let d = Daemon::start();
    let mut c = d.client();
    create(
        &mut c,
        "t",
        &[
            "sh",
            "-c",
            r#"stty -opost; i=0; while [ $i -lt 50 ]; do printf 'H%02d\r\n' $i; i=$((i+1)); done; printf READY; exec sleep 100"#,
        ],
        20,
        5,
    );
    std::thread::sleep(Duration::from_millis(500));
    let s = c
        .request::<SubscribeReply>(Op::Subscribe(Subscribe {
            id: "t".into(),
            mode: Mode::Raw,
            role: Role::Watch,
            history_rows: Some(10),
            flow: None,
            cols: None,
            rows: None,
        }))
        .unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 5, |s| !s.repaints.is_empty());
    let v = viewer(20, 5, &seen.bytes);
    assert_eq!(v.scrollback_rows().unwrap(), 10, "exactly the history rows, no blank padding");
    let all = format_screen(&v);
    let lines: Vec<&str> = all.lines().map(str::trim_end).collect();
    assert_eq!(&lines[..3], ["H36", "H37", "H38"], "{lines:?}");
    assert!(plain(&v).contains("READY"));
    let cap: CaptureReply =
        c.request(Op::Capture(Capture { id: "t".into(), format: None, history_rows: Some(3), unwrap: None })).unwrap();
    assert_eq!(cap.rows, 8);
    assert!(cap.text.starts_with("H43\nH44\nH45\nH46"), "{:?}", cap.text);
    let _ = s;
}

fn format_screen(t: &libghostty_vt::Terminal) -> String {
    use libghostty_vt::fmt::{Format, Formatter};
    let mut f = Formatter::new(t).unwrap();
    f.set_format(Format::Plain).unwrap();
    String::from_utf8_lossy(&f.format_alloc(None).unwrap()).into_owned()
}

#[test]
fn lossy_subscriber_that_falls_behind_is_resynced() {
    let d = Daemon::start();
    let mut c = d.client();
    create(&mut c, "t", &["sh", "-c", "printf READY; read x; seq 1 3000000; printf DONE; exec sleep 100"], 80, 24);
    let s = subscribe(&mut c, "t", Role::Attach, None);
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
    c.input(s.handle, b"\r").unwrap();
    // Don't read for a while: the queue passes 4 MiB.
    std::thread::sleep(Duration::from_secs(3));
    read_until(&mut c, &mut seen, 60, |s| {
        contains(&s.output[s.output.len().saturating_sub(16)..], b"DONE")
            || s.repaints.len() > 1
                && s.next_seq == s.repaints.last().map(|r| r.0.seq)
                && contains(&s.repaints.last().unwrap().1, b"DONE")
    });
    read_until(&mut c, &mut seen, 10, |s| s.trace.iter().skip_while(|t| *t != "lagged").any(|t| t == "modes"));
    let lagged = seen.events.iter().find_map(|e| match e {
        Event::Lagged { dropped, seq } => Some((*dropped, *seq)),
        _ => None,
    });
    let (dropped, seq) = lagged.expect("a lagged event");
    assert!(dropped > 0);
    assert!(seen.repaints.len() >= 2, "a repaint after the lag");
    // One `lagged`, then the repaint it names: never a run of them.
    let p = seen.trace.iter().position(|t| t == "lagged").unwrap();
    assert_eq!(seen.trace[p + 1], format!("repaint@{seq}"), "after lagged: {:?}", &seen.trace[p..]);
    assert_eq!(seen.trace[p + 2], "modes", "the state follows the repaint: {:?}", &seen.trace[p..]);
    assert!(seen.gaps.is_empty(), "output after the resync continues at the repaint's seq: {:?}", seen.gaps);
}

#[test]
fn blocking_owner_sees_every_byte_of_a_flood() {
    let d = Daemon::start();
    let mut c = d.client();
    create(
        &mut c,
        "t",
        &["sh", "-c", "stty -opost; printf READY; read x; seq 1 300000; printf DONE; exec sleep 100"],
        80,
        24,
    );
    let s = c
        .request::<SubscribeReply>(Op::Subscribe(Subscribe {
            id: "t".into(),
            mode: Mode::Raw,
            role: Role::Own,
            history_rows: None,
            flow: None,
            cols: None,
            rows: None,
        }))
        .unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
    c.input(s.handle, b"\r").unwrap();
    // Read slowly at first, so the daemon has to hold the program back.
    std::thread::sleep(Duration::from_secs(2));
    read_until(&mut c, &mut seen, 60, |s| contains(&s.output[s.output.len().saturating_sub(16)..], b"DONE"));
    assert!(seen.gaps.is_empty(), "seq gaps: {:?}", seen.gaps);
    assert!(!seen.events.iter().any(|e| matches!(e, Event::Lagged { .. })));
    let text = String::from_utf8_lossy(&seen.output).into_owned();
    let start = text.find("READY").map_or(0, |i| i + 5);
    let body = &text[start..text.rfind("DONE").unwrap()];
    let lines: Vec<&str> = body.split('\n').filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), 300000);
    for (i, l) in lines.iter().enumerate() {
        assert_eq!(l.trim_start_matches('\r').trim_end_matches('\r'), (i + 1).to_string(), "line {i}");
    }
}

#[test]
fn kill_outlasts_a_program_that_ignores_hangup() {
    let d = Daemon::start();
    let mut c = d.client();
    let r = create(&mut c, "t", &["sh", "-c", "trap '' HUP; while :; do sleep 0.1; done"], 40, 5);
    std::thread::sleep(Duration::from_millis(200));
    let t0 = Instant::now();
    let _: Empty = c.request(Op::Kill(Kill { id: "t".into(), signal: None })).unwrap();
    assert!(t0.elapsed() < Duration::from_secs(5));
    assert!(wait_dead(r.pid, 3), "the HUP-ignoring program survived kill");
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_panicking_owner_thread_closes_only_its_terminal() {
    let d = Daemon::start();
    let mut c = d.client();
    create(&mut c, "a", &["cat"], 40, 5);
    create(&mut c, "b", &["cat"], 40, 5);
    let sa = subscribe(&mut c, "a", Role::Attach, None);
    let mut seen = Seen::default();
    c.input(sa.handle, b"\x00g3d-termd-test-panic\x00").unwrap();
    read_until(&mut c, &mut seen, 10, |s| s.closed);
    let l: ListReply = c.request(Op::List).unwrap();
    assert_eq!(l.terminals.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
    let mut c2 = d.client();
    let sb = subscribe(&mut c2, "b", Role::Attach, None);
    c2.input(sb.handle, b"still here\r").unwrap();
    let mut seen = Seen::default();
    read_until(&mut c2, &mut seen, 10, |s| contains(&s.output, b"still here\r\nstill here"));
    assert!(d.log().contains("panicked"));
}

#[test]
fn a_second_daemon_on_the_namespace_is_refused() {
    let d = Daemon::start();
    let out = std::process::Command::new(bin()).arg("--socket").arg(&d.socket).output().unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("another g3d-termd") && err.contains(&format!("pid {}", d.pid())), "{err}");
    // The first still serves.
    let mut c = d.client();
    let _: Empty = c.request(Op::Ping).unwrap();
}

#[test]
fn idle_exit_removes_the_socket() {
    let mut d = Daemon::start_with(&["--idle-exit", "1"]);
    let until = Instant::now() + Duration::from_secs(10);
    let mut child = d.child.take().unwrap();
    loop {
        if let Some(st) = child.try_wait().unwrap() {
            assert!(st.success());
            break;
        }
        assert!(Instant::now() < until, "daemon did not idle-exit");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!d.socket.exists());
}

/// A log that can't be written (a full disk, a closed pipe) doesn't stop the daemon from
/// stopping: its idle exit still runs, and logs on the way out.
#[test]
fn an_unwritable_log_does_not_wedge_the_daemon() {
    let dir = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("ulog{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("t.sock");
    let mut child = std::process::Command::new(bin())
        .arg("--socket")
        .arg(&socket)
        .args(["--idle-exit", "1"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stderr.take()); // every later log write fails with EPIPE
    let until = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(st) = child.try_wait().unwrap() {
            break st;
        }
        if Instant::now() >= until {
            let _ = child.kill();
            panic!("the daemon did not idle-exit with its log unwritable");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success(), "{status}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stop_kills_every_terminal_and_exits() {
    let mut d = Daemon::start();
    let mut c = d.client();
    let a = create(&mut c, "a", &["sleep", "100"], 40, 5);
    let b = create(&mut c, "b", &["sh"], 40, 5);
    let _: Empty = c.request(Op::Stop).unwrap();
    let mut child = d.child.take().unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < until, "daemon did not exit after stop");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(wait_dead(a.pid, 3) && wait_dead(b.pid, 3));
    assert!(!d.socket.exists());
}

#[test]
fn a_crashed_daemon_takes_its_shells_down() {
    let mut d = Daemon::start();
    let mut c = d.client();
    let a = create(&mut c, "a", &["sh"], 40, 5);
    let b = create(&mut c, "b", &["sleep", "100"], 40, 5);
    let mut child = d.child.take().unwrap();
    child.kill().unwrap(); // SIGKILL: no cleanup runs
    child.wait().unwrap();
    // Every PTY master closed with the process: the kernel hangs up each session.
    assert!(wait_dead(a.pid, 3), "shell survived the daemon");
    assert!(wait_dead(b.pid, 3), "sleep survived the daemon");
}

#[test]
fn flood_in_several_terminals_stays_bounded() {
    let d = Daemon::start();
    let n = 4;
    let mut clients = Vec::new();
    for i in 0..n {
        let mut c = d.client();
        let id = format!("f{i}");
        create(
            &mut c,
            &id,
            &["sh", "-c", "stty -opost; printf READY; read x; seq 1 300000; printf DONE; exec sleep 100"],
            80,
            24,
        );
        let s = c
            .request::<SubscribeReply>(Op::Subscribe(Subscribe {
                id,
                mode: Mode::Raw,
                role: Role::Own,
                history_rows: None,
                flow: None,
                cols: None,
                rows: None,
            }))
            .unwrap();
        let mut seen = Seen::default();
        read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
        clients.push((c, s.handle, seen));
    }
    for (c, h, _) in &mut clients {
        c.input(*h, b"\r").unwrap();
    }
    // The brain holds the emulators; the holder holds only fds.
    let pid = d.brain_pid();
    let mut peak_rss_kb = 0u64;
    let handles: Vec<_> = clients
        .into_iter()
        .map(|(mut c, _, mut seen)| {
            std::thread::spawn(move || {
                read_until(&mut c, &mut seen, 120, |s| {
                    contains(&s.output[s.output.len().saturating_sub(16)..], b"DONE")
                });
                seen
            })
        })
        .collect();
    while handles.iter().any(|h| !h.is_finished()) {
        peak_rss_kb = peak_rss_kb.max(rss_kb(pid));
        std::thread::sleep(Duration::from_millis(50));
    }
    for h in handles {
        let seen = h.join().unwrap();
        assert!(seen.gaps.is_empty(), "gaps: {:?}", seen.gaps);
        let text = String::from_utf8_lossy(&seen.output).into_owned();
        let body = &text[text.find("READY").map_or(0, |i| i + 5)..text.rfind("DONE").unwrap()];
        assert_eq!(body.split('\n').filter(|l| !l.is_empty()).count(), 300000);
    }
    eprintln!("flood: daemon peak RSS {} MiB for {n} terminals", peak_rss_kb / 1024);
    assert!(peak_rss_kb < 200 * 1024, "daemon RSS {} KiB is over the 200 MiB ceiling", peak_rss_kb);
}

/// The program rings and retitles without pause; two clients stop reading (one raw, one
/// `mode: "none"`). Events count against a subscriber's queue like output and are dropped
/// with it, so the daemon stays small (and the client that reads keeps its pace: printed,
/// not asserted, as the suite's other floods share the CPU). Each
/// stalled client, once it reads again, gets one `lagged`, then a repaint (raw) or a
/// `size` (none), then the terminal's state.
#[test]
fn stalled_subscribers_do_not_hoard_events() {
    let d = Daemon::start();
    let mut c = d.client();
    create(
        &mut c,
        "t",
        &[
            "sh",
            "-c",
            r#"printf READY; read x; i=0; while :; do i=$((i+1)); printf '\a\a\a\a\a\a\a\a\033]2;t%d\007' $i; done"#,
        ],
        80,
        24,
    );
    let s = c.request::<SubscribeReply>(sub_req("t", Mode::Raw, Role::Own, None, None)).unwrap();
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
    c.input(s.handle, b"\r").unwrap();
    let pid = d.brain_pid();
    // Reads for at least `secs` and `min_bytes` of output, sampling the daemon's memory:
    // (output bytes per second, peak RSS KiB).
    let read_for = |c: &mut Client, secs: f64, min_bytes: u64| {
        let t0 = Instant::now();
        let mut last = t0;
        let (mut bytes, mut peak) = (0u64, rss_kb(pid));
        while t0.elapsed().as_secs_f64() < secs || bytes < min_bytes {
            assert!(t0.elapsed() < Duration::from_secs(90), "the flood made {bytes} B in 90 s");
            let f = c.next_frame().unwrap();
            if f.ty == ty::OUTPUT {
                bytes += f.payload.len() as u64 - 8;
            }
            if last.elapsed() > Duration::from_millis(100) {
                peak = peak.max(rss_kb(pid));
                last = Instant::now();
            }
        }
        (bytes as f64 / t0.elapsed().as_secs_f64(), peak)
    };
    let (alone, base_rss) = read_for(&mut c, 1.5, 0);

    let mut raw = stalled_client(&d);
    let _: SubscribeReply = raw.request(sub_req("t", Mode::Raw, Role::Watch, None, None)).unwrap();
    let mut none = stalled_client(&d);
    let _: SubscribeReply = none.request(sub_req("t", Mode::None, Role::Attach, None, None)).unwrap();
    // 8 MiB of output carries well over 4 MiB of events too: both stalled queues overflow.
    let (stalled, peak) = read_for(&mut c, 6.0, 8 << 20);
    eprintln!(
        "events flood: {:.1} MB/s alone, {:.1} MB/s beside two stalled clients; RSS {} -> peak {} MiB",
        alone / 1e6,
        stalled / 1e6,
        base_rss / 1024,
        peak / 1024
    );
    assert!(peak < base_rss + 48 * 1024, "the daemon grew from {base_rss} KiB to {peak} KiB");

    // The stalled raw client reads again: one lagged, the repaint it names, the state.
    let mut rs = Seen::default();
    read_until(&mut raw, &mut rs, 20, |s| s.trace.iter().skip_while(|t| *t != "lagged").any(|t| t == "title"));
    let p = rs.trace.iter().position(|t| t == "lagged").unwrap();
    let Some(Event::Lagged { dropped, seq }) = rs.events.iter().find(|e| matches!(e, Event::Lagged { .. })).cloned()
    else {
        unreachable!()
    };
    assert!(dropped > 0);
    assert_eq!(
        &rs.trace[p + 1..p + 4],
        [format!("repaint@{seq}"), "modes".into(), "title".into()],
        "{:?}",
        &rs.trace[p..]
    );

    // The `mode: "none"` client: one lagged (no output to drop), its size, the state.
    let mut ns = Seen::default();
    read_until(&mut none, &mut ns, 20, |s| s.trace.iter().skip_while(|t| *t != "lagged").any(|t| t == "title"));
    let p = ns.trace.iter().position(|t| t == "lagged").unwrap();
    assert_eq!(&ns.trace[p + 1..p + 4], ["size", "modes", "title"], "{:?}", &ns.trace[p..]);
    let lag_seq = ns.events.iter().find_map(|e| match e {
        Event::Lagged { dropped: 0, seq } => Some(*seq),
        _ => None,
    });
    let lag_seq = lag_seq.expect("lagged with nothing dropped");
    assert!(ns.events.contains(&Event::Size { cols: 80, rows: 24, seq: lag_seq }));
    let mut k = d.client();
    let _: Empty = k.request(Op::Kill(Kill { id: "t".into(), signal: None })).unwrap();
}

/// An owner that stops reading holds the program back (flow `block`). Taking the terminal
/// demotes it to a lossy `attach`, so the program runs again for the taker.
#[test]
fn taking_from_a_wedged_owner_frees_the_terminal() {
    let d = Daemon::start();
    let mut a = stalled_client(&d);
    create(&mut a, "t", &["yes"], 80, 24);
    let _: SubscribeReply = a.request(sub_req("t", Mode::Raw, Role::Own, None, None)).unwrap();
    let mut l = d.client();
    let mut seq_now = || l.request::<ListReply>(Op::List).unwrap().terminals[0].seq;
    let until = Instant::now() + Duration::from_secs(10);
    let frozen = loop {
        let s0 = seq_now();
        std::thread::sleep(Duration::from_millis(300));
        let s1 = seq_now();
        if s1 == s0 && s1 > 0 {
            break s1;
        }
        assert!(Instant::now() < until, "the wedged owner never held the program back");
    };

    let mut b = d.client();
    let sb: SubscribeReply = b.request(sub_req("t", Mode::Raw, Role::Attach, None, None)).unwrap();
    let r: TakeReply = b.request(Op::Take(Take { handle: sb.handle, cols: Some(100), rows: Some(30) })).unwrap();
    assert_eq!(r.role, Role::Own);
    let mut seen = Seen::default();
    read_until(&mut b, &mut seen, 10, |s| s.output.len() > 4 << 20);
    assert!(seen.gaps.is_empty(), "the taker owns with flow block: no gaps {:?}", seen.gaps);
    let after = seq_now();
    assert!(after > frozen + (4 << 20), "the program stayed frozen at {frozen} (now {after})");
    let l2: ListReply = l.request(Op::List).unwrap();
    assert_eq!(l2.terminals[0].subscribers, SubscriberCounts { own: 1, attach: 1, watch: 0 });
}

/// `modes` is sent when a mode changes and, for a late subscriber, right after it joins,
/// with the title: a client that runs no emulator knows whether the program wants the
/// wheel (PROTOCOL.md, `view`).
#[test]
fn a_new_subscriber_learns_the_terminals_state() {
    let d = Daemon::start();
    let mut c = d.client();
    create(
        &mut c,
        "t",
        &[
            "sh",
            "-c",
            r#"printf '\033]2;state title\007\033[?1049h\033[?1002h\033[?1006h\033[?2004hREADY'; exec sleep 100"#,
        ],
        40,
        10,
    );
    let until = Instant::now() + Duration::from_secs(10);
    while c.request::<ListReply>(Op::List).unwrap().terminals[0].title != "state title" {
        assert!(Instant::now() < until, "the title never arrived");
        std::thread::sleep(Duration::from_millis(20));
    }
    let want =
        Modes { alt: true, mouse: true, mouse_sgr: true, bracketed_paste: true, app_cursor: false, focus: false };
    for (mode, first) in [(Mode::Raw, Some("repaint@")), (Mode::None, None)] {
        let mut s = d.client();
        let _: SubscribeReply = s.request(sub_req("t", mode, Role::Watch, None, None)).unwrap();
        let mut seen = Seen::default();
        read_until(&mut s, &mut seen, 5, |s| s.events.len() >= 2);
        let rest = match first {
            Some(p) => {
                assert!(seen.trace[0].starts_with(p), "{mode:?}: {:?}", seen.trace);
                &seen.trace[1..]
            }
            None => &seen.trace[..],
        };
        assert_eq!(&rest[..2], ["modes", "title"], "{mode:?}: {:?}", seen.trace);
        assert_eq!(seen.events[0], Event::Modes(want), "{mode:?}");
        assert_eq!(seen.events[1], Event::Title { title: "state title".into() });
    }
}

/// A daemonized namespace's log rotates at --log-max-bytes: the holder moves it to `.1`, and the
/// brain, which shares the file, follows it to the new one.
#[test]
fn a_daemonized_log_rotates_and_the_brain_follows() {
    let dir = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("rot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (socket, log) = (dir.join("termd-rot.sock"), dir.join("termd-rot.log"));
    // Stops the namespace however the test ends: `stop`, else SIGKILL to the holder by its lock.
    struct Guard(std::path::PathBuf, std::path::PathBuf);
    impl Drop for Guard {
        fn drop(&mut self) {
            if let Ok(mut c) = Client::connect(&self.0, "test") {
                let _ = c.request::<Empty>(Op::Stop);
            }
            let lock = std::fs::read_to_string(format!("{}.lock", self.0.display())).unwrap_or_default();
            if let Ok(pid) = lock.trim().parse::<i32>() {
                std::thread::sleep(Duration::from_millis(500));
                if ps_field(pid as u32, "command").is_some_and(|c| c.contains("g3d-termd")) {
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            }
            if !std::thread::panicking() {
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
    }
    let st = std::process::Command::new(bin())
        .args(["--ns", "rot", "--daemon", "--idle-exit", "0", "--env-source", "daemon", "--log-max-bytes", "4096"])
        .args(["--brain-watchdog", "1"])
        .env("G3D_TERMD_DIR", &dir)
        .status()
        .unwrap();
    assert!(st.success());
    let _g = Guard(socket.clone(), dir.clone());
    let until = Instant::now() + Duration::from_secs(5);
    while std::os::unix::net::UnixStream::connect(&socket).is_err() {
        assert!(Instant::now() < until, "the daemon did not come up");
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut c = Client::connect(&socket, "test").unwrap();
    let old = dir.join("termd-rot.log.1");
    let until = Instant::now() + Duration::from_secs(20);
    let mut n = 0;
    while !old.exists() {
        assert!(Instant::now() < until, "the log never rotated: {}", std::fs::read_to_string(&log).unwrap_or_default());
        create(&mut c, &format!("t{n}"), &["true"], 20, 5);
        n += 1;
        std::thread::sleep(Duration::from_millis(20));
    }
    // The brain's next line lands in the new file, after the holder's note.
    create(&mut c, "after", &["true"], 20, 5);
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let now = std::fs::read_to_string(&log).unwrap_or_default();
        if now.contains("terminal after (handle") {
            assert!(now.contains("log rotated at 4096 bytes"), "{now}");
            assert!(std::fs::metadata(&old).unwrap().len() >= 4096);
            break;
        }
        assert!(Instant::now() < until, "the brain did not follow the rotated log: {now}");
        std::thread::sleep(Duration::from_millis(50));
    }
}
