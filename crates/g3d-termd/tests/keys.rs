//! The `key` and `paste` ops (protocol 1.2) against a private daemon: a program sets its own
//! keyboard and paste modes, then prints every byte it reads as `[hh]`, so what termd encoded is
//! what the program got.

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

/// Starts the hex dumper with `setup` on a new terminal and attaches to it once it is READY
/// (termd has parsed its modes by then: it parses output before forwarding it).
fn start(d: &Daemon, id: &str, setup: &str) -> (Client, u32, Seen) {
    let mut c = d.client();
    create(&mut c, id, &["sh", "-c", &hexdump(setup)], 80, 24);
    let s = subscribe(&mut c, id, Role::Attach, None);
    let mut seen = Seen::default();
    // In the repaint when it printed before the subscription, else in its output.
    read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
    (c, s.handle, seen)
}

fn hex(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|b| format!("[{b:02x}]")).collect::<String>().into_bytes()
}

fn key(handle: u32, code: &str, k: &str, mods: &[&str], text: &str) -> Op {
    Op::Key(Key {
        handle,
        code: code.into(),
        key: k.into(),
        mods: mods.iter().map(|m| m.to_string()).collect(),
        text: text.into(),
        action: None,
    })
}

fn paste(handle: u32, text: &str, allow_unsafe: bool) -> Op {
    Op::Paste(Paste { handle, text: text.into(), allow_unsafe: allow_unsafe.then_some(true) })
}

/// Sends `op`, then waits for the program to have read exactly `want` after what it had.
fn expect(c: &mut Client, seen: &mut Seen, op: Op, want: &[u8]) {
    let from = seen.output.len();
    let r: WrittenReply = c.request(op).unwrap();
    assert_eq!(r.written, want.len() as u64);
    let h = hex(want);
    read_until(c, seen, 10, |s| contains(&s.output[from..], &h));
}

#[test]
fn shift_enter_reaches_a_kitty_program_as_csi_u_and_a_legacy_one_as_ghostty_sends_it() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "kitty", "\\033[>1u");
    expect(&mut c, &mut seen, key(h, "Enter", "Enter", &["Shift"], ""), b"\x1b[13;2u");
    expect(&mut c, &mut seen, key(h, "Enter", "Enter", &[], ""), b"\r");
    expect(&mut c, &mut seen, key(h, "KeyC", "c", &["Control"], "c"), b"\x1b[99;5u");

    let (mut c, h, mut seen) = start(&d, "legacy", "");
    expect(&mut c, &mut seen, key(h, "Enter", "Enter", &["Shift"], ""), b"\x1b[27;2;13~");
    expect(&mut c, &mut seen, key(h, "Enter", "Enter", &[], ""), b"\r");
    expect(&mut c, &mut seen, key(h, "KeyC", "c", &["Control"], "c"), b"\x03");
    expect(&mut c, &mut seen, key(h, "Digit1", "!", &["Shift"], "!"), b"!");
}

#[test]
fn modify_other_keys_and_application_cursor_keys_follow_the_program() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "mok", "\\033[>4;2m");
    expect(&mut c, &mut seen, key(h, "KeyP", "p", &["Control"], "p"), b"\x1b[27;5;112~");

    let (mut c, h, mut seen) = start(&d, "decckm", "\\033[?1h");
    expect(&mut c, &mut seen, key(h, "ArrowUp", "ArrowUp", &[], ""), b"\x1bOA");
    let (mut c, h, mut seen) = start(&d, "normal", "");
    expect(&mut c, &mut seen, key(h, "ArrowUp", "ArrowUp", &[], ""), b"\x1b[A");
    expect(&mut c, &mut seen, key(h, "ArrowLeft", "ArrowLeft", &["Alt"], ""), b"\x1b[1;3D");
    expect(&mut c, &mut seen, key(h, "KeyB", "b", &["Alt"], "b"), b"\x1bb");
}

#[test]
fn paste_is_bracketed_only_when_the_program_asked() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "bracketed", "\\033[?2004h");
    expect(&mut c, &mut seen, paste(h, "one\ntwo", false), b"\x1b[200~one\ntwo\x1b[201~");

    let (mut c, h, mut seen) = start(&d, "plain", "");
    expect(&mut c, &mut seen, paste(h, "echo hi", false), b"echo hi");
    // A line break would run the line: refused unless the client says the person meant it.
    let e = c.request::<WrittenReply>(paste(h, "one\ntwo", false)).unwrap_err();
    assert_eq!(e.code(), Some(code::UNSAFE_PASTE), "{e}");
    // Then as xterm and Ghostty paste it: newlines as Enter.
    expect(&mut c, &mut seen, paste(h, "one\ntwo", true), b"one\rtwo");
}

#[test]
fn a_pasted_bracket_end_cannot_close_the_bracket_early() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "bracketed", "\\033[?2004h");
    let evil = "safe\x1b[201~rm -rf ~\r";
    let e = c.request::<WrittenReply>(paste(h, evil, false)).unwrap_err();
    assert_eq!(e.code(), Some(code::UNSAFE_PASTE), "{e}");
    // Pasted anyway, ESC (and every other byte xterm strips) becomes a space: one bracket, whole.
    expect(&mut c, &mut seen, paste(h, evil, true), b"\x1b[200~safe [201~rm -rf ~\r\x1b[201~");
    // Control characters a paste must not carry (Ctrl+C, Ctrl+U, …) are spaces too.
    expect(&mut c, &mut seen, paste(h, "a\x03b\x15c", false), b"\x1b[200~a b c\x1b[201~");
}

#[test]
fn key_and_paste_need_a_writing_subscription() {
    let d = Daemon::start();
    let (_c, h, _) = start(&d, "t", "");
    let mut w = d.client();
    subscribe(&mut w, "t", Role::Watch, None);
    let e = w.request::<WrittenReply>(key(h, "KeyA", "a", &[], "a")).unwrap_err();
    assert_eq!(e.code(), Some(code::READ_ONLY));
    let e = w.request::<WrittenReply>(paste(h, "a", false)).unwrap_err();
    assert_eq!(e.code(), Some(code::READ_ONLY));
    let mut x = d.client();
    let e = x.request::<WrittenReply>(key(h, "KeyA", "a", &[], "a")).unwrap_err();
    assert_eq!(e.code(), Some(code::NOT_SUBSCRIBED));
    let e = x.request::<WrittenReply>(key(9999, "KeyA", "a", &[], "a")).unwrap_err();
    assert_eq!(e.code(), Some(code::NO_TERMINAL));
    let mut a = d.client();
    let s = subscribe(&mut a, "t", Role::Attach, None);
    let e = a.request::<WrittenReply>(key(s.handle, "", "", &[], "")).unwrap_err();
    assert_eq!(e.code(), Some(code::BAD_REQUEST));
}
