//! A paste streamed in chunks (protocol 1.5, `paste` with `more`): one paste for the program
//! whatever its size, framed once, its rules over the whole of it, and fed through the PTY under
//! the input buffer's flow control (DESIGN.md, "Keys and paste"). Each on a private daemon.

mod common;

use common::*;
use g3d::Client;
use g3d_wire::frame::{self, ty};
use g3d_wire::*;
use std::time::{Duration, Instant};

/// A program that sets `setup`, says READY, then echoes each byte it reads in hex (keys.rs's).
fn hexdump(setup: &str) -> String {
    format!(
        "stty raw -echo; printf '{setup}'; printf 'READY\\n'; \
         while :; do b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); printf '[%s]' \"$b\"; done"
    )
}

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

fn chunk(handle: u32, text: &str, more: bool, allow_unsafe: bool) -> Op {
    Op::Paste(Paste {
        handle,
        text: text.into(),
        allow_unsafe: allow_unsafe.then_some(true),
        more: more.then_some(true),
    })
}

/// Waits until the program has read exactly `want` since byte `from` of the output.
fn read_back(c: &mut Client, seen: &mut Seen, from: usize, want: &[u8]) {
    let h = hex(want);
    read_until(c, seen, 15, |s| s.output.len() >= from + h.len() && contains(&s.output[from..], &h));
    let got = &seen.output[from..];
    let at = got.windows(h.len()).position(|w| w == h.as_slice()).unwrap();
    assert_eq!(&got[..at], b"", "nothing before it");
}

#[test]
fn a_streamed_paste_is_one_bracket_and_a_split_terminator_is_caught() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "bracketed", "\\033[?2004h");
    assert!(c.welcome.features.iter().any(|f| f == "paste_stream"));
    let from = seen.output.len();
    let _: WrittenReply = c.request(chunk(h, "one\n", true, false)).unwrap();
    let _: WrittenReply = c.request(chunk(h, "two", false, false)).unwrap();
    read_back(&mut c, &mut seen, from, b"\x1b[200~one\ntwo\x1b[201~");

    // The bracket end, its ESC in one chunk and the rest in the next: refused as surely as whole,
    // and the bracket opened for the first chunk is closed, so the program reads no keystrokes.
    let from = seen.output.len();
    let _: WrittenReply = c.request(chunk(h, "x\x1b[2", true, false)).unwrap();
    let e = c.request::<WrittenReply>(chunk(h, "01~rm -rf ~\r", true, false)).unwrap_err();
    assert_eq!(e.code(), Some(code::UNSAFE_PASTE), "{e}");
    let e = c.request::<WrittenReply>(chunk(h, "y", false, false)).unwrap_err();
    assert_eq!(e.code(), Some(code::UNSAFE_PASTE), "a refused paste's later chunks write nothing: {e}");
    read_back(&mut c, &mut seen, from, b"\x1b[200~x [2\x1b[201~");
    // The next paste is a paste of its own.
    let from = seen.output.len();
    let _: WrittenReply = c.request(chunk(h, "after", false, false)).unwrap();
    read_back(&mut c, &mut seen, from, b"\x1b[200~after\x1b[201~");
}

#[test]
fn a_split_line_break_is_one_enter_and_keys_typed_meanwhile_follow_the_paste() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "plain", "");
    let from = seen.output.len();
    let _: WrittenReply = c.request(chunk(h, "a\r", true, true)).unwrap();
    let key = Op::Key(Key { handle: h, code: "KeyK".into(), key: "k".into(), text: "k".into(), ..Default::default() });
    let _: WrittenReply = c.request(key).unwrap();
    let _: WrittenReply = c.request(chunk(h, "\nb", false, true)).unwrap();
    read_back(&mut c, &mut seen, from, b"a\rbk");
}

#[test]
fn a_paste_whose_writer_leaves_is_closed() {
    let d = Daemon::start();
    let (mut c, h, mut seen) = start(&d, "bracketed", "\\033[?2004h");
    let mut w = d.client();
    let s = subscribe(&mut w, "bracketed", Role::Attach, None);
    let from = seen.output.len();
    let _: WrittenReply = w.request(chunk(s.handle, "abc", true, false)).unwrap();
    let _: WrittenReply = w.request(chunk(s.handle, "def", true, false)).unwrap();
    // Another writer's paste waits its turn rather than landing inside this one's bracket.
    let e = c.request::<WrittenReply>(chunk(h, "zzz", false, false)).unwrap_err();
    assert_eq!(e.code(), Some(code::BUSY), "{e}");
    let _: Empty = w.request(Op::Unsubscribe(HandleOnly { handle: s.handle })).unwrap();
    read_back(&mut c, &mut seen, from, b"\x1b[200~abcdef\x1b[201~");
    assert!(d.log().contains("a paste ended unfinished: its writer unsubscribed"), "{}", d.log());
}

/// Reads frames until the reply to `req`; `None` if none comes within `wait`.
fn reply_within(c: &mut Client, req: u64, wait: Duration) -> Option<frame::Frame> {
    c.set_read_timeout(Some(wait)).unwrap();
    let until = Instant::now() + wait;
    let got = loop {
        if Instant::now() >= until {
            break None;
        }
        match c.next_frame() {
            Ok(f) if f.ty == ty::REPLY => {
                let v: serde_json::Value = serde_json::from_slice(&f.payload).unwrap();
                if v["req"].as_u64() == Some(req) {
                    break Some(f);
                }
            }
            Ok(_) => {}
            Err(_) => break None,
        }
    };
    c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    got
}

#[test]
fn a_program_that_stops_reading_holds_the_paste_back_without_loss() {
    const BUFFER: usize = 4 << 20;
    const CHUNK: usize = 512 << 10;
    const TOTAL: usize = 24 << 20;
    let d = Daemon::start_with(&["--idle-exit", "0", "--input-buffer", &BUFFER.to_string()]);
    let (out, go) = (d.dir.join("out"), d.dir.join("go"));
    let script = format!(
        "stty raw -echo; printf 'READY\\n'; while [ ! -e '{}' ]; do sleep 0.05; done; exec cat > '{}'",
        go.display(),
        out.display()
    );
    let mut c = d.client();
    create(&mut c, "slow", &["sh", "-c", &script], 80, 24);
    let s = subscribe(&mut c, "slow", Role::Attach, None);
    let mut seen = Seen::default();
    read_until(&mut c, &mut seen, 10, |s| contains(&s.bytes, b"READY"));
    let text: String = (0..TOTAL).map(|i| (b'a' + (i % 26) as u8) as char).collect();
    let chunks: Vec<&str> = (0..TOTAL / CHUNK).map(|k| &text[k * CHUNK..(k + 1) * CHUNK]).collect();
    let brain = d.brain_pid();
    let rss0 = rss_kb(brain);

    // Chunks go in while the input buffer has room, then one waits: its reply, and so the next
    // chunk, waits for the program.
    let mut sent = 0;
    let stalled = loop {
        let req = c.send_request(chunk(s.handle, chunks[sent], true, false)).unwrap();
        sent += 1;
        if reply_within(&mut c, req, Duration::from_secs(2)).is_none() {
            break req;
        }
        assert!(sent < chunks.len(), "a program that reads nothing took the whole paste");
    };
    assert!(
        (sent - 1) * CHUNK <= BUFFER + CHUNK,
        "{} chunks of {CHUNK} B went in before one waited: more than the {BUFFER} B input buffer",
        sent - 1
    );
    let rss1 = rss_kb(brain);
    assert!(rss1 < rss0 + 64 * 1024, "the brain holds the buffer and one chunk, not the paste: {rss0} → {rss1} kB");
    // A key typed meanwhile follows the paste.
    let key =
        Op::Key(Key { handle: s.handle, code: "KeyZ".into(), key: "Z".into(), text: "Z".into(), ..Default::default() });
    let _: WrittenReply = c.request(key).unwrap();

    std::fs::write(&go, "").unwrap();
    assert!(reply_within(&mut c, stalled, Duration::from_secs(30)).is_some(), "the waiting chunk went in");
    for (k, t) in chunks.iter().enumerate().skip(sent) {
        let _: WrittenReply = c.request(chunk(s.handle, t, k + 1 < chunks.len(), false)).unwrap();
    }
    let until = Instant::now() + Duration::from_secs(60);
    while std::fs::metadata(&out).map_or(0, |m| m.len()) < (TOTAL + 1) as u64 {
        assert!(Instant::now() < until, "the paste never all arrived: {:?}", std::fs::metadata(&out).map(|m| m.len()));
        std::thread::sleep(Duration::from_millis(50));
    }
    let got = std::fs::read(&out).unwrap();
    assert_eq!(got.len(), TOTAL + 1);
    assert!(got[..TOTAL] == *text.as_bytes(), "every byte, in order");
    assert_eq!(got[TOTAL], b'Z', "the key typed during the paste, after it");
}

#[test]
fn a_paste_whose_writer_goes_quiet_ends_at_the_paste_timeout() {
    let d = Daemon::start_with(&["--idle-exit", "0", "--paste-timeout-ms", "600"]);
    let (mut c, h, mut seen) = start(&d, "bracketed", "\\033[?2004h");
    let mut w = d.client();
    let s = subscribe(&mut w, "bracketed", Role::Attach, None);
    let from = seen.output.len();
    let _: WrittenReply = w.request(chunk(s.handle, "abc", true, false)).unwrap();
    // The writer stays connected and sends nothing more. A key typed meanwhile is held behind the
    // open paste, and the status document says so.
    let key = Op::Key(Key { handle: h, code: "KeyK".into(), key: "k".into(), text: "k".into(), ..Default::default() });
    let _: WrittenReply = c.request(key).unwrap();
    let st = c.request::<StatusReply>(Op::Status).unwrap().status;
    let t = st.terminals.iter().find(|t| t.id == "bracketed").unwrap();
    let p = t.paste.as_ref().expect("the open paste in the status document");
    assert_eq!(p.written, 3);
    assert!(p.idle_since.is_some(), "termd waits for its writer: {p:?}");
    assert_eq!(t.input_queued, 1, "the held key counts as input queued");
    // At the timeout the paste ends, closed, and the key follows it.
    read_back(&mut c, &mut seen, from, b"\x1b[200~abc\x1b[201~k");
    assert!(d.log().contains("its writer sent no next chunk"), "{}", d.log());
    // Its writer's later chunks are refused until its last; then it pastes again.
    let e = w.request::<WrittenReply>(chunk(s.handle, "def", true, false)).unwrap_err();
    assert_eq!(e.code(), Some(code::PASTE_TIMEOUT), "{e}");
    let e = w.request::<WrittenReply>(chunk(s.handle, "", false, false)).unwrap_err();
    assert_eq!(e.code(), Some(code::PASTE_TIMEOUT), "{e}");
    let from = seen.output.len();
    let _: WrittenReply = w.request(chunk(s.handle, "next", false, false)).unwrap();
    read_back(&mut c, &mut seen, from, b"\x1b[200~next\x1b[201~");
    let st = c.request::<StatusReply>(Op::Status).unwrap().status;
    assert!(st.terminals.iter().all(|t| t.paste.is_none()));
    assert!(st.errors.iter().any(|e| e.code == code::PASTE_TIMEOUT), "{:?}", st.errors);
}
