//! `g3d attach` driven through a real PTY, expect-style: the repaint arrives, typing
//! reaches the shell, terminal queries never reach the outer terminal, the detach chord
//! leaves the terminal running, and `--take` makes this window's size the terminal's.
//! Runs its own daemon (the `g3d-termd` built beside `g3d`: `cargo test --workspace`).

use g3d::Client;
use g3d_wire::*;
use rustix::fd::{AsFd, BorrowedFd, OwnedFd};
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Daemon {
    dir: PathBuf,
    socket: PathBuf,
    child: Child,
}

impl Daemon {
    fn start() -> Self {
        Self::start_env(&[])
    }

    /// A daemon whose own environment (its base, with `--env-source daemon`) adds `env`.
    fn start_env(env: &[(&str, &str)]) -> Self {
        let g3d = PathBuf::from(env!("CARGO_BIN_EXE_g3d"));
        let termd = g3d.with_file_name("g3d-termd");
        assert!(termd.is_file(), "no {} — run `cargo test --workspace` so the daemon is built", termd.display());
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("attach-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("termd-attach.sock");
        let child = Command::new(termd)
            .arg("--socket")
            .arg(&socket)
            .args(["--idle-exit", "0", "--env-source", "daemon"])
            .envs(env.iter().copied())
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

/// `g3d` running on a PTY we hold the master of: the stand-in for Ghostty.
struct Outer {
    master: OwnedFd,
    child: Child,
    seen: Vec<u8>,
}

impl Outer {
    fn spawn(socket: &std::path::Path, args: &[&str], cols: u16, rows: u16) -> Self {
        Self::spawn_with(socket, args, cols, rows, |_, _| {})
    }

    /// `setup` shapes g3d's command (its environment), given the PTY's name.
    fn spawn_with(
        socket: &std::path::Path,
        args: &[&str],
        cols: u16,
        rows: u16,
        setup: impl FnOnce(&mut Command, &str),
    ) -> Self {
        let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC).unwrap();
        grantpt(&master).unwrap();
        unlockpt(&master).unwrap();
        let name = ptsname(&master, Vec::new()).unwrap();
        rustix::termios::tcsetwinsize(
            &master,
            rustix::termios::Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 },
        )
        .unwrap();
        let slave = rustix::fs::open(
            name.as_c_str(),
            rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOCTTY,
            rustix::fs::Mode::empty(),
        )
        .unwrap();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_g3d"));
        cmd.arg("--socket").arg(socket).args(args);
        setup(&mut cmd, &name.to_string_lossy());
        cmd.stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave));
        unsafe {
            cmd.pre_exec(|| {
                rustix::process::setsid()?;
                rustix::process::ioctl_tiocsctty(BorrowedFd::borrow_raw(0))?;
                Ok(())
            });
        }
        let child = cmd.spawn().unwrap();
        rustix::fs::fcntl_setfl(master.as_fd(), rustix::fs::OFlags::NONBLOCK).unwrap();
        Outer { master, child, seen: Vec::new() }
    }

    fn pump(&mut self) {
        let mut buf = [0u8; 65536];
        loop {
            match rustix::io::read(&self.master, &mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => self.seen.extend_from_slice(&buf[..n]),
            }
        }
    }

    fn expect(&mut self, needle: &[u8], secs: u64) {
        let until = Instant::now() + Duration::from_secs(secs);
        loop {
            self.pump();
            if self.seen.windows(needle.len()).any(|w| w == needle) {
                return;
            }
            assert!(
                Instant::now() < until,
                "never saw {:?}; outer terminal got {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&self.seen)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn type_(&self, b: &[u8]) {
        rustix::io::write(&self.master, b).unwrap();
    }

    fn wait_exit(&mut self, secs: u64) -> std::process::ExitStatus {
        let until = Instant::now() + Duration::from_secs(secs);
        loop {
            self.pump();
            if let Some(s) = self.child.try_wait().unwrap() {
                self.pump();
                return s;
            }
            assert!(
                Instant::now() < until,
                "g3d did not exit; outer terminal got {:?}",
                String::from_utf8_lossy(&self.seen)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Outer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn list(socket: &std::path::Path) -> Vec<TermInfo> {
    let mut c = Client::connect(socket, "test").unwrap();
    c.request::<ListReply>(Op::List).unwrap().terminals
}

#[test]
fn attach_repaints_types_filters_queries_and_detaches() {
    let d = Daemon::start();
    let mut c = Client::connect(&d.socket, "test").unwrap();
    let mut env = std::collections::BTreeMap::new();
    env.insert("PS1".to_string(), Some("$ ".to_string()));
    env.insert("ENV".to_string(), None);
    let _: CreateReply = c
        .request(Op::Create(Create {
            id: "t".into(),
            argv: Some(vec!["sh".into()]),
            cols: 80,
            rows: 24,
            env: Some(env),
            ..Default::default()
        }))
        .unwrap();
    let s: SubscribeReply = c
        .request(Op::Subscribe(Subscribe {
            id: "t".into(),
            mode: Mode::None,
            role: Role::Attach,
            history_rows: None,
            flow: None,
            cols: None,
            rows: None,
        }))
        .unwrap();
    c.input(s.handle, b"echo BEFORE-$((40+2))\r").unwrap();
    std::thread::sleep(Duration::from_millis(500));

    let mut o = Outer::spawn(&d.socket, &["attach", "t"], 80, 24);
    o.expect(b"BEFORE-42", 10); // the repaint carried the screen
    o.type_(b"echo typed-$((1+2))\r");
    o.expect(b"typed-3", 10);
    // The shell asks the terminal for the cursor position and device attributes. termd
    // answered; the outer terminal must never see the questions (or it would answer too).
    // (dd swallows the answers termd sends back, so they don't land on the next prompt.)
    o.type_(b"stty -echo -icanon min 0 time 5; printf '\\033[6n\\033[c\\033]11;?\\033\\\\'; dd bs=512 count=1 >/dev/null 2>&1; stty sane; echo Q-DONE\r");
    o.expect(b"Q-DONE\r\n", 10);
    let s = String::from_utf8_lossy(&o.seen).into_owned();
    assert!(
        !s.contains("\x1b[6n") && !s.contains("\x1b[c") && !s.contains("\x1b]11;?"),
        "a query reached the outer terminal"
    );
    // Detach: Ctrl-\ twice. The terminal keeps running.
    o.type_(b"\x1c\x1c");
    let st = o.wait_exit(5);
    assert!(st.success());
    o.expect(b"[detached from t]", 2);
    let l = list(&d.socket);
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].subscribers.attach, 1, "only the test's own subscription is left");

    // watch: read-only, quits on Ctrl-C.
    let mut w = Outer::spawn(&d.socket, &["watch", "t"], 80, 24);
    w.expect(b"typed-3", 10);
    w.type_(b"echo SHOULD-NOT-RUN\r\x03");
    assert!(w.wait_exit(5).success());
    std::thread::sleep(Duration::from_millis(300));
    let mut cap: CaptureReply =
        c.request(Op::Capture(Capture { id: "t".into(), format: None, history_rows: None, unwrap: None })).unwrap();
    assert!(!cap.text.contains("SHOULD-NOT-RUN"), "watch typed into the terminal");

    // --take: this window's size becomes the terminal's, and follows it.
    let mut t = Outer::spawn(&d.socket, &["attach", "t", "--take"], 100, 30);
    t.expect(b"typed-3", 10);
    let l = list(&d.socket);
    assert_eq!((l[0].cols, l[0].rows, l[0].subscribers.own), (100, 30, 1));
    rustix::termios::tcsetwinsize(
        &t.master,
        rustix::termios::Winsize { ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0 },
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        t.pump();
        let l = list(&d.socket);
        if (l[0].cols, l[0].rows) == (120, 40) {
            break;
        }
        assert!(Instant::now() < until, "the terminal did not follow the window: {}x{}", l[0].cols, l[0].rows);
        std::thread::sleep(Duration::from_millis(50));
    }
    t.type_(b"exit\r");
    let st = t.wait_exit(5);
    assert!(st.success());
    t.expect(b"[t exited]", 2);
    cap.text.clear();
    assert!(list(&d.socket).is_empty());
}

/// The brain's pid, from a fresh connection's WELCOME.
fn brain_pid(socket: &std::path::Path) -> i32 {
    Client::connect(socket, "test").unwrap().welcome.pid.unwrap() as i32
}

/// Waits until a brain other than `old` answers.
fn wait_new_brain(socket: &std::path::Path, old: i32) {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(c) = Client::connect(socket, "test")
            && c.welcome.pid.is_some_and(|p| p as i32 != old)
        {
            return;
        }
        assert!(Instant::now() < until, "no new brain answered");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// attach and watch follow the restart rule (PROTOCOL.md "Restarts"), as the relay does: a brain
/// upgrade and a brain crash are ridden, the screen comes back and typing still reaches the shell.
#[test]
fn attach_and_watch_ride_an_upgrade_and_a_crash() {
    let d = Daemon::start();
    let mut c = Client::connect(&d.socket, "test").unwrap();
    let env =
        std::collections::BTreeMap::from([("PS1".to_string(), Some("$ ".to_string())), ("ENV".to_string(), None)]);
    let _: CreateReply = c
        .request(Op::Create(Create {
            id: "r".into(),
            argv: Some(vec!["sh".into()]),
            cols: 80,
            rows: 24,
            env: Some(env),
            ..Default::default()
        }))
        .unwrap();
    drop(c);
    let mut a = Outer::spawn(&d.socket, &["attach", "r"], 80, 24);
    let mut w = Outer::spawn(&d.socket, &["watch", "r"], 80, 24);
    // Keys typed before the attach is up, or while it reconnects, may be dropped: type until
    // one lands.
    let typed = |o: &mut Outer, tag: &str| {
        let until = Instant::now() + Duration::from_secs(15);
        let want = format!("{tag}-{}", 6 * 7);
        loop {
            o.type_(format!("echo {tag}-$((6*7))\r").as_bytes());
            std::thread::sleep(Duration::from_millis(300));
            o.pump();
            if String::from_utf8_lossy(&o.seen).contains(&want) {
                return;
            }
            assert!(o.child.try_wait().unwrap().is_none(), "g3d exited: {:?}", String::from_utf8_lossy(&o.seen));
            assert!(Instant::now() < until, "typing never landed: {:?}", String::from_utf8_lossy(&o.seen));
        }
    };
    typed(&mut a, "first");
    w.expect(b"first-42", 10);

    // An upgrade: the brain hands over and every client gets ERROR restart.
    let old = brain_pid(&d.socket);
    let mut c = Client::connect(&d.socket, "test").unwrap();
    let _: UpgradeReply = c.request(Op::Upgrade(Upgrade { binary: None, holder: None })).unwrap();
    wait_new_brain(&d.socket, old);
    typed(&mut a, "upgraded");
    w.expect(b"upgraded-42", 10);
    assert!(w.child.try_wait().unwrap().is_none(), "watch left on the upgrade");

    // A crash: the connection drops with no word, and the holder starts a new brain.
    let old = brain_pid(&d.socket);
    unsafe { libc::kill(old, libc::SIGKILL) };
    wait_new_brain(&d.socket, old);
    typed(&mut a, "crashed");
    w.expect(b"crashed-42", 10);
    assert!(w.child.try_wait().unwrap().is_none(), "watch left on the crash");
    let seen = String::from_utf8_lossy(&a.seen).into_owned();
    assert!(!seen.contains("lost the daemon"), "{seen}");

    // The terminal ending still ends them both.
    a.type_(b"exit\r");
    assert!(a.wait_exit(10).success());
    a.expect(b"[r exited]", 2);
    assert!(w.wait_exit(10).success());
}

/// A process's environment as it was exec'd (Linux's /proc; the macOS branch reads it with `ps`).
fn environ(pid: u32) -> std::collections::BTreeMap<String, String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).unwrap();
    raw.split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .filter_map(|kv| {
            let s = String::from_utf8_lossy(kv);
            s.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned()))
        })
        .collect()
}

/// `g3d new` forwards the SSH agent, display and the rest only from a live SSH login: a shell
/// below an old one (a tmux pane whose server SSH started keeps SSH_CONNECTION, and a dead agent
/// socket and display) forwards nothing and the terminal gets the session's fresh values. Inside a
/// live login, a listed name the login lacks is removed, as tmux's update-environment does.
#[cfg(target_os = "linux")]
#[test]
fn new_forwards_only_from_a_live_ssh_login() {
    // The session's own values, as the daemon's base has them.
    let d = Daemon::start_env(&[("DISPLAY", ":0"), ("XAUTHORITY", "/run/user/0/xauth_session")]);
    let stale = |cmd: &mut Command| {
        cmd.env("SSH_CONNECTION", "10.0.0.1 5 10.0.0.2 22")
            .env("SSH_CLIENT", "10.0.0.1 5 22")
            .env("DISPLAY", ":99")
            .env("SSH_AUTH_SOCK", "/nonexistent/dead-agent.sock")
            .env_remove("XAUTHORITY")
            .env_remove("WAYLAND_DISPLAY");
    };
    let pid_of = |id: &str| list(&d.socket).into_iter().find(|t| t.id == id).map(|t| t.pid).unwrap();
    let created = |o: &mut Outer, id: &str| {
        o.expect(format!("{id} handle").as_bytes(), 10);
        assert!(o.wait_exit(5).success());
    };

    // A tmux pane below an old login: this terminal is not the login's (SSH_TTY names another).
    let mut o = Outer::spawn_with(&d.socket, &["new", "pane", "--", "sleep", "600"], 80, 24, |cmd, _| {
        stale(cmd);
        cmd.env("SSH_TTY", "/dev/null");
    });
    created(&mut o, "pane");
    let e = environ(pid_of("pane"));
    assert_eq!(e.get("DISPLAY").map(String::as_str), Some(":0"), "a stale DISPLAY was forwarded");
    assert_eq!(e.get("XAUTHORITY").map(String::as_str), Some("/run/user/0/xauth_session"));
    assert_eq!(e.get("SSH_AUTH_SOCK"), None, "a dead agent socket was forwarded");
    assert_eq!(e.get("SSH_CONNECTION"), None);

    // The login's own terminal: its values, and what it lacks removed (no X forwarding here).
    let mut o = Outer::spawn_with(&d.socket, &["new", "login", "--", "sleep", "600"], 80, 24, |cmd, pty| {
        stale(cmd);
        cmd.env("SSH_TTY", pty);
    });
    created(&mut o, "login");
    let e = environ(pid_of("login"));
    assert_eq!(e.get("DISPLAY").map(String::as_str), Some(":99"));
    assert_eq!(e.get("SSH_AUTH_SOCK").map(String::as_str), Some("/nonexistent/dead-agent.sock"));
    assert_eq!(e.get("XAUTHORITY"), None, "the session's X cookie stayed beside the login's display");
    assert_eq!(e.get("SSH_CLIENT").map(String::as_str), Some("10.0.0.1 5 22"));

    // `ssh host cmd`: no terminal at all.
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_g3d"));
    cmd.arg("--socket").arg(&d.socket).args(["new", "notty", "--", "sleep", "600"]);
    stale(&mut cmd);
    cmd.env_remove("SSH_TTY").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    unsafe {
        cmd.pre_exec(|| {
            rustix::process::setsid()?;
            Ok(())
        });
    }
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let e = environ(pid_of("notty"));
    assert_eq!(e.get("DISPLAY").map(String::as_str), Some(":99"));
    assert_eq!(e.get("SSH_CONNECTION").map(String::as_str), Some("10.0.0.1 5 10.0.0.2 22"));
}
