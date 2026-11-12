//! A private daemon per test: its own socket in the test's scratch directory, stopped
//! (every terminal killed) when the test ends, pass or fail.
#![allow(dead_code)]

use g3d::Client;
use g3d_wire::frame::{self, ty};
use g3d_wire::*;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

static N: AtomicU32 = AtomicU32::new(0);

pub struct Daemon {
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub child: Option<Child>,
}

pub fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_g3d-termd")
}

impl Daemon {
    pub fn start() -> Self {
        Self::start_with(&["--idle-exit", "0"])
    }

    pub fn start_with(args: &[&str]) -> Self {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "t{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("termd-test.sock");
        let child = Command::new(bin())
            .arg("--socket")
            .arg(&socket)
            .args(args)
            .env("G3D_TERMD_TEST_HOOKS", "1")
            .stdin(Stdio::null())
            .stderr(std::fs::File::create(dir.join("daemon.log")).unwrap())
            .spawn()
            .unwrap();
        let d = Daemon { dir, socket, child: Some(child) };
        let until = Instant::now() + Duration::from_secs(5);
        while std::os::unix::net::UnixStream::connect(&d.socket).is_err() {
            assert!(Instant::now() < until, "daemon did not come up: {}", d.log());
            std::thread::sleep(Duration::from_millis(10));
        }
        d
    }

    pub fn client(&self) -> Client {
        let c = Client::connect(&self.socket, "test").unwrap();
        c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        c
    }

    pub fn log(&self) -> String {
        std::fs::read_to_string(self.dir.join("daemon.log")).unwrap_or_default()
    }

    pub fn pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    /// Stops with SIGTERM (a clean shutdown), SIGKILL after 5 s.
    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            unsafe { libc::kill(c.id() as i32, libc::SIGTERM) };
            let until = Instant::now() + Duration::from_secs(5);
            loop {
                if c.try_wait().unwrap().is_some() {
                    break;
                }
                if Instant::now() > until {
                    let _ = c.kill();
                    let _ = c.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.stop();
        if !std::thread::panicking() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

pub fn create(c: &mut Client, id: &str, argv: &[&str], cols: u16, rows: u16) -> CreateReply {
    c.request(Op::Create(Create {
        id: id.into(),
        argv: Some(argv.iter().map(|s| s.to_string()).collect()),
        cols,
        rows,
        ..Default::default()
    }))
    .unwrap()
}

pub fn subscribe(c: &mut Client, id: &str, role: Role, flow: Option<Flow>) -> SubscribeReply {
    c.request(Op::Subscribe(Subscribe {
        id: id.into(),
        mode: Mode::Raw,
        role,
        history_rows: None,
        flow,
        cols: None,
        rows: None,
    }))
    .unwrap()
}

/// What a raw subscriber has seen of one terminal.
#[derive(Default, Debug)]
pub struct Seen {
    /// Every byte in order: repaint VT bytes, then OUTPUT bytes.
    pub bytes: Vec<u8>,
    /// Only OUTPUT bytes.
    pub output: Vec<u8>,
    /// The seq the next OUTPUT should start at.
    pub next_seq: Option<u64>,
    pub gaps: Vec<(u64, u64)>,
    pub events: Vec<Event>,
    pub repaints: Vec<(RepaintHead, Vec<u8>)>,
    pub closed: bool,
    /// Every frame in arrival order: `output@<seq>`, `repaint@<seq>`, or the event's name.
    pub trace: Vec<String>,
}

impl Seen {
    pub fn take(&mut self, f: &frame::Frame) {
        match f.ty {
            ty::OUTPUT => {
                let (seq, b) = frame::parse_output(&f.payload).unwrap();
                if let Some(n) = self.next_seq
                    && seq != n
                {
                    self.gaps.push((n, seq));
                }
                self.next_seq = Some(seq + b.len() as u64);
                self.trace.push(format!("output@{seq}"));
                self.bytes.extend_from_slice(b);
                self.output.extend_from_slice(b);
            }
            ty::REPAINT => {
                let (h, vt) = frame::parse_repaint(&f.payload).unwrap();
                self.next_seq = Some(h.seq);
                self.trace.push(format!("repaint@{}", h.seq));
                self.bytes.extend_from_slice(vt);
                self.repaints.push((h, vt.to_vec()));
            }
            ty::EVENT => {
                let ev: Event = serde_json::from_slice(&f.payload).unwrap();
                let v: serde_json::Value = serde_json::from_slice(&f.payload).unwrap();
                self.trace.push(v["ev"].as_str().unwrap_or("?").to_owned());
                if ev == Event::Closed {
                    self.closed = true;
                }
                self.events.push(ev);
            }
            _ => {}
        }
    }
}

/// Reads frames into `seen` until `done` says so (or panics after `secs`).
pub fn read_until(c: &mut Client, seen: &mut Seen, secs: u64, mut done: impl FnMut(&Seen) -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !done(seen) {
        assert!(
            Instant::now() < until,
            "timed out; output so far: {:?}",
            String::from_utf8_lossy(&seen.output[seen.output.len().saturating_sub(400)..])
        );
        let f = c.next_frame().unwrap_or_else(|e| {
            panic!("{e}; frames so far end {:?}", &seen.trace[seen.trace.len().saturating_sub(12)..])
        });
        seen.take(&f);
    }
}

/// A client whose socket buffers almost nothing: once it stops reading, the daemon's
/// queue for it fills.
pub fn stalled_client(d: &Daemon) -> Client {
    let c = d.client();
    rustix::net::sockopt::set_socket_recv_buffer_size(c.stream(), 4096).unwrap();
    c
}

/// The daemon's resident memory, in KiB.
pub fn rss_kb(pid: u32) -> u64 {
    let s = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
    s.lines()
        .find(|l| l.starts_with("VmRSS:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

pub fn sub_req(id: &str, mode: Mode, role: Role, flow: Option<Flow>, size: Option<(u16, u16)>) -> Op {
    Op::Subscribe(Subscribe {
        id: id.into(),
        mode,
        role,
        history_rows: None,
        flow,
        cols: size.map(|s| s.0),
        rows: size.map(|s| s.1),
    })
}

pub fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// The plain text of a terminal's active area, rows trimmed.
pub fn plain(t: &libghostty_vt::Terminal) -> String {
    format(t, libghostty_vt::fmt::Format::Plain)
}

pub fn format(t: &libghostty_vt::Terminal, fmt: libghostty_vt::fmt::Format) -> String {
    use libghostty_vt::fmt::{Extras, Formatter};
    use libghostty_vt::point::{Coordinate, Point};
    use libghostty_vt::selection::Selection;
    let mut f = Formatter::new(t).unwrap();
    f.set_format(fmt).unwrap().set_extras(Extras::NONE).unwrap().set_trim(true).unwrap();
    let (c, r) = (t.cols().unwrap(), t.rows().unwrap() as u32);
    let a = t.grid_ref(Point::Active(Coordinate { x: 0, y: 0 })).unwrap();
    let b = t.grid_ref(Point::Active(Coordinate { x: c - 1, y: r - 1 })).unwrap();
    let sel = Selection::new(a, b, false);
    unsafe { f.set_selection(Some(&sel)).unwrap() };
    String::from_utf8_lossy(&f.format_alloc(None).unwrap()).into_owned()
}

pub fn viewer(cols: u16, rows: u16, bytes: &[u8]) -> libghostty_vt::Terminal<'static, 'static> {
    let mut t = libghostty_vt::Terminal::new(cols, rows).unwrap();
    t.set_scrollback_max_bytes(Some(1 << 20)).unwrap();
    t.vt_write(bytes);
    t
}
