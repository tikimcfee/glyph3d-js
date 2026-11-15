//! The `mouse` op (protocol 1.4) against a private daemon: a program sets its own mouse modes,
//! then prints every byte it reads as `[hh]`, so what termd encoded is what the program got.

mod common;

use common::*;
use g3d::Client;
use g3d_wire::*;

/// A program that writes `setup` (the modes it asks for), says READY, then echoes each byte it
/// reads in hex. Raw and unechoed, so the tty passes every byte through as it came.
fn hexdump(setup: &str) -> String {
    format!(
        "stty raw -echo; printf '{setup}'; printf 'READY\\n'; \
         while :; do b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); printf '[%s]' \"$b\"; done"
    )
}

/// Starts the hex dumper with `setup` on a new terminal and attaches to it once it is READY.
fn start(d: &Daemon, id: &str, setup: &str) -> (Client, u32, Seen) {
    let mut c = d.client();
    create(&mut c, id, &["sh", "-c", &hexdump(setup)], 80, 24);
    let s = subscribe(&mut c, id, Role::Attach, None);
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
    (c, s.handle, seen)
}

fn hex(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|b| format!("[{b:02x}]")).collect::<String>().into_bytes()
}

fn mouse(handle: u32, action: MouseAction, button: MouseButton, col: f64, row: f64, mods: &[&str]) -> Op {
    Op::Mouse(Mouse { handle, action, button, col, row, mods: mods.iter().map(|m| m.to_string()).collect() })
}

/// Sends `op`, then waits for the program to have read exactly `want` after what it had (and
/// the reply to have counted it). An empty `want` is a reply of 0 bytes.
fn expect(c: &mut Client, seen: &mut Seen, op: Op, want: &[u8]) {
    let from = seen.output.len();
    let r: WrittenReply = c.request(op).unwrap();
    assert_eq!(r.written, want.len() as u64, "for {:?}", String::from_utf8_lossy(want));
    if !want.is_empty() {
        let h = hex(want);
        read_until(c, seen, 10, |s| contains(&s.output[from..], &h));
    }
}

#[test]
fn a_click_and_a_drag_reach_an_sgr_program_as_its_modes_ask() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "sgr", "\\033[?1000h\\033[?1006h");
    assert!(c.welcome.features.iter().any(|f| f == "mouse"));
    use MouseAction::*;
    use MouseButton::*;
    expect(&mut c, &mut seen, mouse(h, Press, Left, 3.0, 5.0, &[]), b"\x1b[<0;4;6M");
    // Normal tracking (1000) reports no motion.
    expect(&mut c, &mut seen, mouse(h, Move, Left, 4.0, 5.0, &[]), b"");
    expect(&mut c, &mut seen, mouse(h, Release, Left, 4.0, 5.0, &[]), b"\x1b[<0;5;6m");
    expect(&mut c, &mut seen, mouse(h, Press, Right, 0.0, 0.0, &["Control"]), b"\x1b[<18;1;1M");
    expect(&mut c, &mut seen, mouse(h, Press, WheelUp, 9.5, 2.0, &[]), b"\x1b[<64;10;3M");

    // Button-event tracking (1002): a drag is reported, once per cell; a move with none held isn't.
    let (mut c, h, mut seen) = start(&d, "drag", "\\033[?1002h\\033[?1006h");
    expect(&mut c, &mut seen, mouse(h, Press, Left, 1.0, 1.0, &[]), b"\x1b[<0;2;2M");
    expect(&mut c, &mut seen, mouse(h, Move, Left, 2.2, 1.0, &[]), b"\x1b[<32;3;2M");
    expect(&mut c, &mut seen, mouse(h, Move, Left, 2.8, 1.4, &[]), b"");
    expect(&mut c, &mut seen, mouse(h, Release, Left, 2.8, 1.4, &[]), b"\x1b[<0;3;2m");
    expect(&mut c, &mut seen, mouse(h, Move, None, 5.0, 5.0, &[]), b"");

    // The default format, past its 223 limit: nothing.
    let (mut c, h, mut seen) = start(&d, "x10", "\\033[?1000h");
    expect(&mut c, &mut seen, mouse(h, Press, Left, 3.0, 5.0, &[]), b"\x1b[M $&");
    expect(&mut c, &mut seen, mouse(h, Release, Left, 3.0, 5.0, &[]), b"\x1b[M#$&");
}

#[test]
fn a_wheel_on_the_alternate_screen_without_mouse_reporting_is_cursor_keys() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "pager", "\\033[?1049h");
    expect(&mut c, &mut seen, mouse(h, MouseAction::Press, MouseButton::WheelUp, 0.0, 0.0, &[]), b"\x1b[A");
    expect(&mut c, &mut seen, mouse(h, MouseAction::Press, MouseButton::WheelDown, 0.0, 0.0, &[]), b"\x1b[B");
    // A click the program didn't ask to hear: nothing, and the reply says so.
    expect(&mut c, &mut seen, mouse(h, MouseAction::Press, MouseButton::Left, 0.0, 0.0, &[]), b"");
}

#[test]
fn mouse_needs_a_writing_subscription_and_a_real_event() {
    let d = Daemon::start();
    let (mut c, h, _) = start(&d, "t", "\\033[?1000h");
    let mut w = d.client();
    subscribe(&mut w, "t", Role::Watch, None);
    let click = mouse(h, MouseAction::Press, MouseButton::Left, 0.0, 0.0, &[]);
    let e = w.request::<WrittenReply>(click.clone()).unwrap_err();
    assert_eq!(e.code(), Some(code::READ_ONLY));
    let mut x = d.client();
    assert_eq!(x.request::<WrittenReply>(click).unwrap_err().code(), Some(code::NOT_SUBSCRIBED));
    let e = c.request::<WrittenReply>(mouse(h, MouseAction::Release, MouseButton::WheelUp, 0.0, 0.0, &[])).unwrap_err();
    assert_eq!(e.code(), Some(code::BAD_REQUEST), "{e}");
    let e = c.request::<WrittenReply>(mouse(h, MouseAction::Press, MouseButton::None, 0.0, 0.0, &[])).unwrap_err();
    assert_eq!(e.code(), Some(code::BAD_REQUEST), "{e}");
}
