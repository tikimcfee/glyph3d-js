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

    /// A daemon whose own environment (the start values, with `--env-source daemon`) adds `env`.
    fn start_env(env: &[(&str, &str)]) -> Self {
        Self::spawn(&["--env-source", "daemon"], |cmd, _| {
            cmd.envs(env.iter().copied());
        })
    }

    /// A daemon whose session source (the user manager) is the test hook's file holding `vars`.
    fn start_session(vars: &[&str]) -> Self {
        let data: Vec<String> = vars.iter().map(|v| format!("{v:?}")).collect();
        Self::spawn(&["--env-source", "auto"], |cmd, dir| {
            let f = dir.join("manager.json");
            std::fs::write(&f, format!(r#"{{"type":"as","data":[{}]}}"#, data.join(","))).unwrap();
            cmd.env("G3D_TERMD_TEST_HOOKS", "1").env("G3D_TERMD_TEST_SESSION_ENV_FILE", f);
        })
    }

    fn spawn(args: &[&str], setup: impl FnOnce(&mut Command, &std::path::Path)) -> Self {
        let g3d = PathBuf::from(env!("CARGO_BIN_EXE_g3d"));
        let termd = g3d.with_file_name("g3d-termd");
        assert!(termd.is_file(), "no {} — run `cargo test --workspace` so the daemon is built", termd.display());
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("attach-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("termd-attach.sock");
        let mut cmd = Command::new(termd);
        // Never the person's own termd.toml.
        cmd.arg("--socket").arg(&socket).args(["--idle-exit", "0", "--config"]).arg(dir.join("termd.toml")).args(args);
        setup(&mut cmd, &dir);
        let child = cmd.stderr(std::fs::File::create(dir.join("daemon.log")).unwrap()).spawn().unwrap();
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
        // macOS's posix_openpt takes no O_CLOEXEC; a test can set it after.
        let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY).unwrap();
        rustix::io::fcntl_setfd(&master, rustix::io::FdFlags::CLOEXEC).unwrap();
        grantpt(&master).unwrap();
        unlockpt(&master).unwrap();
        let name = ptsname(&master, Vec::new()).unwrap();
        let slave = rustix::fs::open(
            name.as_c_str(),
            rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOCTTY,
            rustix::fs::Mode::empty(),
        )
        .unwrap();
        // After the slave is open: macOS refuses TIOCSWINSZ on a master with no slave (ENOTTY).
        rustix::termios::tcsetwinsize(
            &master,
            rustix::termios::Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 },
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

    // The holder replaces itself in place (g3d upgrade --holder): the same holder pid, the same
    // shell, and both clients ride it as they ride a brain upgrade.
    let holder = d.child.id();
    let old = brain_pid(&d.socket);
    let mut c = Client::connect(&d.socket, "test").unwrap();
    let _: UpgradeReply = c.request(Op::Upgrade(Upgrade { binary: None, holder: Some(true) })).unwrap();
    wait_new_brain(&d.socket, old);
    typed(&mut a, "reexeced");
    w.expect(b"reexeced-42", 10);
    assert!(w.child.try_wait().unwrap().is_none(), "watch left on the holder's upgrade");
    let h: StatusReply = Client::connect(&d.socket, "test").unwrap().request(Op::Status).unwrap();
    assert_eq!((h.status.daemon.holder.pid, h.status.daemon.holder.upgrades), (holder, 1));

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

#[path = "../../g3d-termd/tests/common/procinfo.rs"]
mod procinfo;
use procinfo::environ;

/// How `g3d env` tags a name from the platform's session source (the daemon's test hook stands
/// in for it under that name).
#[cfg(target_os = "macos")]
const SESSION_TAG: &str = "session (launchd)";
#[cfg(not(target_os = "macos"))]
const SESSION_TAG: &str = "session (systemd-user)";

/// A second test-name filter (it matches no test) that only [`idle_argv`] passes.
const IDLE_MODE: &str = "g3d-idle-mode";

/// A program whose environment a test can read, for `g3d new <id> -- <it>`: this test binary,
/// idling in [`idle`]. Not `sleep`: macOS withholds an Apple platform binary's environment from
/// other processes.
fn idle_argv() -> [&'static str; 4] {
    static EXE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let exe = EXE.get_or_init(|| std::env::current_exe().unwrap().display().to_string());
    [exe, "--exact", "idle", IDLE_MODE]
}

/// As [`idle_argv`]'s program, waits; in an ordinary test run, does nothing.
#[test]
fn idle() {
    if std::env::args().any(|a| a == IDLE_MODE) {
        std::thread::sleep(Duration::from_secs(600));
    }
}

/// `g3d new` from a shell with an odd environment (a stale DISPLAY, a Rex tab's marker, a custom
/// FOO): its environment is the terminal's base, so FOO and even the stale DISPLAY arrive and the
/// marker doesn't; `--clean` sends none and the terminal gets the session's fresh DISPLAY; `-e`
/// sets or passes a name; `g3d env` tags every variable with its source. The session is the
/// daemon's test hook (a file standing in for the user manager): run with
/// `--features g3d-termd/test-hooks`, as tools/CHECKS.md says.
#[test]
fn new_sends_its_environment_and_clean_takes_the_sessions() {
    let d = Daemon::start_session(&["DISPLAY=:0", "XAUTHORITY=/run/user/0/xauth_session"]);
    let odd = |cmd: &mut Command| {
        cmd.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("DISPLAY", ":99")
            .env("REX_SESSION", "rex-tab-3")
            .env("FOO", "custom")
            .env("HERE", "passed")
            .env("TERM_PROGRAM", "Apple_Terminal");
    };
    let g3d = |args: &[&str]| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_g3d"));
        cmd.arg("--socket").arg(&d.socket).args(args);
        odd(&mut cmd);
        let out = cmd.stdin(Stdio::null()).output().unwrap();
        assert!(out.status.success(), "g3d {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    };
    let pid_of = |id: &str| list(&d.socket).into_iter().find(|t| t.id == id).map(|t| t.pid).unwrap();

    g3d(&[&["new", "sub", "-e", "BAR=asked", "-e", "HERE", "--"][..], &idle_argv()].concat());
    let e = environ(pid_of("sub"));
    let get = |k: &str| e.get(k).map(String::as_str);
    assert_eq!(get("FOO"), Some("custom"));
    assert_eq!(get("DISPLAY"), Some(":99"), "the caller's DISPLAY is its subshell's");
    assert_eq!(get("XAUTHORITY"), None, "the session's mixed into a caller's base");
    assert_eq!(get("REX_SESSION"), None, "the caller's tab marker reached the terminal");
    assert_eq!((get("BAR"), get("HERE")), (Some("asked"), Some("passed")));
    assert_eq!(get("TERM_PROGRAM"), Some("g3d-termd"));
    let shown = g3d(&["env", "sub"]);
    for line in ["caller ", "FOO=custom", "request ", "BAR=asked", "termd ", "TERM_PROGRAM=g3d-termd", "fill (passwd) "]
    {
        assert!(shown.contains(line), "g3d env lacks {line:?}:\n{shown}");
    }
    let tag = |out: &str, name: &str| {
        out.lines().find(|l| l.contains(&format!(" {name}="))).map(|l| l.split("  ").next().unwrap().trim().to_owned())
    };
    assert_eq!(tag(&shown, "DISPLAY").as_deref(), Some("caller"));
    let json: serde_json::Value = serde_json::from_str(&g3d(&["env", "sub", "--json"])).unwrap();
    assert!(json["env"].as_array().unwrap().iter().any(|v| v["name"] == "FOO" && v["source"] == "caller"), "{json}");

    // --clean: the session's DISPLAY, fresh; none of the caller's.
    g3d(&[&["new", "clean", "--clean", "-e", "HERE", "--"][..], &idle_argv()].concat());
    let e = environ(pid_of("clean"));
    assert_eq!(e.get("DISPLAY").map(String::as_str), Some(":0"), "the stale DISPLAY won over the session's");
    assert_eq!(
        e.get("XAUTHORITY").map(String::as_str),
        Some("/run/user/0/xauth_session"),
        "not the test hook's session: run `cargo test --workspace --features g3d-termd/test-hooks`"
    );
    assert_eq!((e.get("FOO"), e.get("REX_SESSION")), (None, None));
    assert_eq!(e.get("HERE").map(String::as_str), Some("passed"));
    let shown = g3d(&["env", "clean"]);
    assert_eq!(tag(&shown, "DISPLAY").as_deref(), Some(SESSION_TAG), "{shown}");
    assert!(!shown.lines().any(|l| l.starts_with("caller")), "{shown}");

    // `-e NAME` with a value the protocol can't carry is said, never sent as "unset".
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_g3d"));
    cmd.arg("--socket").arg(&d.socket).args(["new", "latin", "--clean", "-e", "LATIN1", "--", "sleep", "600"]);
    odd(&mut cmd);
    use std::os::unix::ffi::OsStrExt;
    cmd.env("LATIN1", std::ffi::OsStr::from_bytes(b"caf\xe9"));
    let out = cmd.stdin(Stdio::null()).output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success() && err.contains("LATIN1") && err.contains("UTF-8"), "{err}");
    assert!(!list(&d.socket).iter().any(|t| t.id == "latin"));

    // A caller whose PATH holds `.` starts a program from its own directory, as its shell does.
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_g3d"));
    cmd.arg("--socket").arg(&d.socket).args(["new", "dot", "--", "sh", "-c", "sleep 600"]);
    odd(&mut cmd);
    cmd.env("PATH", ".:/nonexistent").current_dir("/bin");
    let out = cmd.stdin(Stdio::null()).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    // Found in the caller's own directory (`/bin`, as the OS spells it): `<dir>/sh`.
    let said = String::from_utf8_lossy(&out.stdout);
    let dir = std::fs::canonicalize("/bin").unwrap();
    assert!(said.contains(&format!(": {}/sh -c sleep 600 in {}", dir.display(), dir.display())), "{said}");
}

/// The socket a namespace lives at doesn't depend on the starter's environment: a relay or daemon
/// started from `env -i` (or cron, or a service manager) and a desktop shell find the same one.
#[test]
fn the_socket_path_does_not_depend_on_the_environment() {
    let ns = format!("probe-{}", std::process::id());
    let ls = |setup: &dyn Fn(&mut Command)| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_g3d"));
        cmd.args(["--ns", &ns, "ls"]);
        setup(&mut cmd);
        let out = cmd.output().unwrap();
        assert!(!out.status.success(), "a daemon answered for {ns}");
        String::from_utf8_lossy(&out.stderr).into_owned()
    };
    let stripped = ls(&|c| {
        c.env_clear();
    });
    let desktop = ls(&|c| {
        c.env_remove("G3D_TERMD_DIR").env("XDG_RUNTIME_DIR", "/nonexistent/runtime").env("TMPDIR", "/nonexistent/tmp");
    });
    assert!(stripped.contains("no daemon at /"), "{stripped}");
    assert_eq!(stripped, desktop);
}
