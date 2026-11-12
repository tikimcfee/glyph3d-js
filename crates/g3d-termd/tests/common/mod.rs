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

/// The daemon's tests need its test hooks, which only a `test-hooks` build has.
#[cfg(not(feature = "test-hooks"))]
#[test]
fn the_test_hooks_feature_is_on() {
    panic!(
        "g3d-termd's tests need its test hooks: run `cargo test --workspace --features g3d-termd/test-hooks` \
         (tools/CHECKS.md, \"The terminal daemon\")"
    );
}

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
        let dir = Self::fresh_dir();
        Self::spawn_in(dir, args, &[])
    }

    /// A daemon with extra environment: test hooks that name a file in its scratch directory
    /// (`(variable, file name)`).
    pub fn start_env(args: &[&str], files: &[(&str, &str)]) -> Self {
        let dir = Self::fresh_dir();
        let env: Vec<(&str, PathBuf)> = files.iter().map(|(k, f)| (*k, dir.join(f))).collect();
        Self::spawn_in(dir, args, &env)
    }

    fn fresh_dir() -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "t{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spawn_in(dir: PathBuf, args: &[&str], env: &[(&str, PathBuf)]) -> Self {
        let env: Vec<(String, PathBuf)> = env.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        Self::spawn_cmd(dir, args, move |cmd, _| {
            for (k, v) in env {
                cmd.env(k, v);
            }
        })
    }

    /// A daemon whose command `setup` shapes first (its environment, its start state), given
    /// the scratch directory. `--env-source daemon` unless `args` names a source, and
    /// `--config <scratch>/termd.toml` (absent until a test writes it) unless `args` names one.
    pub fn start_cmd(args: &[&str], setup: impl FnOnce(&mut Command, &std::path::Path)) -> Self {
        Self::spawn_cmd(Self::fresh_dir(), args, setup)
    }

    fn spawn_cmd(dir: PathBuf, args: &[&str], setup: impl FnOnce(&mut Command, &std::path::Path)) -> Self {
        use std::os::unix::process::CommandExt;
        let socket = dir.join("termd-test.sock");
        let mut cmd = Command::new(bin());
        setup(&mut cmd, &dir);
        cmd.arg("--socket").arg(&socket);
        // The daemon's own environment, never the desktop session's (DESIGN.md, "Environment").
        if !args.contains(&"--env-source") {
            cmd.args(["--env-source", "daemon"]);
        }
        // Never the person's own termd.toml.
        if !args.contains(&"--config") {
            cmd.arg("--config").arg(dir.join("termd.toml"));
        }
        cmd.args(args)
            .env("G3D_TERMD_TEST_HOOKS", "1")
            .stdin(Stdio::null())
            .stderr(std::fs::File::create(dir.join("daemon.log")).unwrap());
        // SAFETY: setrlimit between fork and exec. A brain the watchdog aborts leaves no core.
        unsafe {
            cmd.pre_exec(|| {
                let rl = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
                libc::setrlimit(libc::RLIMIT_CORE, &rl);
                Ok(())
            });
        }
        let child = cmd.spawn().unwrap();
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

    /// The holder's pid (the process the test started).
    pub fn pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    /// Connects again after a brain restart (the holder's backlog holds the connection until the
    /// next brain accepts it), checking it is the same namespace.
    pub fn reconnect(&self, instance: &str) -> Client {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            match Client::connect(&self.socket, "test") {
                Ok(c) => {
                    assert_eq!(c.welcome.instance.as_deref(), Some(instance), "a different namespace answered");
                    c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
                    return c;
                }
                Err(e) => {
                    assert!(Instant::now() < until, "no brain came back: {e}\n{}", self.log());
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }

    /// The brain's pid, from a fresh connection's WELCOME.
    pub fn brain_pid(&self) -> u32 {
        self.client().welcome.pid.unwrap()
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
            "timed out; output so far: {:?}; frames end {:?}",
            String::from_utf8_lossy(&seen.output[seen.output.len().saturating_sub(400)..]),
            &seen.trace[seen.trace.len().saturating_sub(12)..]
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
/// One `ps` field of a process (`stat`, `rss`), or `None` once it is gone. `ps -o` reads
/// the same on Linux and macOS, which has no /proc.
pub fn ps_field(pid: u32, field: &str) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", &format!("{field}="), "-p", &pid.to_string()])
        .output()
        .expect("run ps");
    let s = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (!s.is_empty()).then_some(s)
}

/// A live process's resident set, in KiB.
pub fn rss_kb(pid: u32) -> u64 {
    let rss = ps_field(pid, "rss").unwrap_or_else(|| panic!("no process {pid} to measure"));
    rss.parse().unwrap_or_else(|_| panic!("ps rss of {pid}: {rss:?}"))
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

/// `contains` over the last 8 KiB only: a check run on every frame of a flood must not scan
/// megabytes each time (a slow reader of a blocking owner slows the program down).
pub fn tail_contains(hay: &[u8], needle: &[u8]) -> bool {
    contains(&hay[hay.len().saturating_sub(8192)..], needle)
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
