//! `g3d send`, `g3d key` and `g3d paste` against a private daemon (the `g3d-termd` built beside
//! `g3d`: `cargo test --workspace`): what the program reads, byte for byte.

use g3d::Client;
use g3d_wire::frame::{self, ty};
use g3d_wire::*;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

struct Daemon {
    dir: PathBuf,
    socket: PathBuf,
    child: Child,
}

impl Daemon {
    fn start() -> Self {
        let g3d = PathBuf::from(env!("CARGO_BIN_EXE_g3d"));
        let termd = g3d.with_file_name("g3d-termd");
        assert!(termd.is_file(), "no {} — run `cargo test --workspace` so the daemon is built", termd.display());
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("input-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("termd-input.sock");
        let child = Command::new(termd)
            .arg("--socket")
            .arg(&socket)
            .args(["--idle-exit", "0"])
            .stderr(std::fs::File::create(dir.join("daemon.log")).unwrap())
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while std::os::unix::net::UnixStream::connect(&socket).is_err() {
            assert!(Instant::now() < until, "daemon did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        Daemon { dir, socket, child }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) };
        let until = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().unwrap().is_none() {
            if Instant::now() > until {
                let _ = self.child.kill();
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn g3d(socket: &Path, args: &[&str], stdin: Option<&[u8]>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_g3d"))
        .arg("--socket")
        .arg(socket)
        .args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(b) = stdin {
        child.stdin.take().unwrap().write_all(b).unwrap();
    }
    child.wait_with_output().unwrap()
}

/// A watcher of a program that sets `setup`, says READY and prints each byte it reads as `[hh]`.
struct Hex {
    c: Client,
    out: Vec<u8>,
}

impl Hex {
    fn start(socket: &Path, id: &str, setup: &str) -> Self {
        let mut c = Client::connect(socket, "input-test").unwrap();
        let script = format!(
            "stty raw -echo; printf '{setup}'; printf 'READY\\n'; \
             while :; do b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); printf '[%s]' \"$b\"; done"
        );
        let _: CreateReply = c
            .request(Op::Create(Create {
                id: id.into(),
                argv: Some(vec!["sh".into(), "-c".into(), script]),
                cols: 80,
                rows: 24,
                ..Default::default()
            }))
            .unwrap();
        let _: SubscribeReply = c
            .request(Op::Subscribe(Subscribe {
                id: id.into(),
                mode: Mode::Raw,
                role: Role::Watch,
                history_rows: None,
                flow: None,
                cols: None,
                rows: None,
            }))
            .unwrap();
        let mut h = Hex { c, out: Vec::new() };
        h.wait(0, b"READY");
        h
    }

    /// Reads output until `want` shows up after byte `from`.
    fn wait(&mut self, from: usize, want: &[u8]) {
        let until = Instant::now() + Duration::from_secs(10);
        while !self.out[from..].windows(want.len()).any(|w| w == want) {
            assert!(
                Instant::now() < until,
                "never read {:?}; got {:?}",
                String::from_utf8_lossy(want),
                String::from_utf8_lossy(&self.out)
            );
            // A repaint counts: what the program printed before the subscription is in it.
            let f = self.c.next_frame().unwrap();
            if f.ty == ty::OUTPUT
                && let Some((_, b)) = frame::parse_output(&f.payload)
            {
                self.out.extend_from_slice(b);
            } else if f.ty == ty::REPAINT
                && let Some((_, vt)) = frame::parse_repaint(&f.payload)
            {
                self.out.extend_from_slice(vt);
            }
        }
    }

    /// Waits for the program to have read exactly `bytes`, next.
    fn read(&mut self, bytes: &[u8]) {
        let from = self.out.len();
        let want: String = bytes.iter().map(|b| format!("[{b:02x}]")).collect();
        self.wait(from, want.as_bytes());
    }
}

#[test]
fn send_key_and_paste_type_what_a_keyboard_and_a_clipboard_would() {
    let d = Daemon::start();
    let mut k = Hex::start(&d.socket, "kitty", "\\033[>1u");
    let ok = |o: Output| assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    ok(g3d(&d.socket, &["key", "kitty", "shift+enter", "ctrl+c", "alt+left"], None));
    k.read(b"\x1b[13;2u\x1b[99;5u\x1b[1;3D");

    let mut p = Hex::start(&d.socket, "plain", "");
    ok(g3d(&d.socket, &["send", "plain", "a\x1bb"], None));
    p.read(b"a\x1bb");
    ok(g3d(&d.socket, &["send", "plain"], Some(b"\x03\r")));
    p.read(b"\x03\r");
    ok(g3d(&d.socket, &["key", "plain", "shift+enter", "!"], None));
    p.read(b"\r!");
    // Alt is Alt (ESC a) unless the person says Option types characters: then alt+a is a.
    ok(g3d(&d.socket, &["key", "plain", "alt+a"], None));
    p.read(b"\x1ba");
    ok(g3d(&d.socket, &["key", "--option-as-alt", "false", "plain", "alt+a"], None));
    p.read(b"a");
    let o = g3d(&d.socket, &["key", "--option-as-alt", "left", "plain", "alt+a"], None);
    assert!(!o.status.success() && String::from_utf8_lossy(&o.stderr).contains("auto, true or false"));
    // A line break into a program without bracketed paste would run it: refused, and said how.
    let o = g3d(&d.socket, &["paste", "plain"], Some(b"one\ntwo"));
    assert!(!o.status.success());
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("unsafe_paste") && err.contains("--unsafe"), "{err}");
    ok(g3d(&d.socket, &["paste", "--unsafe", "plain"], Some(b"one\ntwo")));
    p.read(b"one\rtwo");

    // A paste larger than the daemon takes is said, and never sent (the daemon would end the
    // connection over it, and the client would read a broken pipe).
    let big = vec![b'x'; 17_000_000];
    let o = g3d(&d.socket, &["paste", "plain"], Some(&big));
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(!o.status.success() && err.contains("too_large") && err.contains("the daemon takes at most"), "{err}");
    ok(g3d(&d.socket, &["send", "plain", "z"], None));
    p.read(b"z");

    let mut b = Hex::start(&d.socket, "bracketed", "\\033[?2004h");
    ok(g3d(&d.socket, &["paste", "bracketed", "x\ny"], None));
    b.read(b"\x1b[200~x\ny\x1b[201~");

    let o = g3d(&d.socket, &["key", "plain", "hyper+x"], None);
    assert!(!o.status.success() && String::from_utf8_lossy(&o.stderr).contains("unknown modifier"));
    let o = g3d(&d.socket, &["key", "nope", "a"], None);
    assert!(!o.status.success() && String::from_utf8_lossy(&o.stderr).contains("no_terminal"));
}
