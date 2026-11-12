//! The environment a terminal's program gets (DESIGN.md, "Environment", and its termd-ready
//! gate): a daemon started from a deliberately odd environment (stripped, a stale `DISPLAY`,
//! another terminal's identity, a parent shell's state, `SIGINT` ignored, a low fd limit) and
//! what its terminals' programs see, read from the kernel (`/proc/<pid>/environ`, `cmdline`,
//! `cwd`, `status`, `limits`; the macOS branch reads them with `ps`).

mod common;

use common::*;
use g3d::Client;
use g3d_wire::*;
use std::collections::BTreeMap;
use std::process::Command;
use std::time::{Duration, Instant};

/// What a starter that is not a desktop session hands down: no HOME or USER, a stale display,
/// a Terminal.app identity, a tmux and an editor it isn't in, its own shell state.
const ODD: &[(&str, &str)] = &[
    ("PATH", "/usr/bin:/bin"),
    ("DISPLAY", ":99"),
    ("TMUX", "/tmp/tmux-0/default,1,0"),
    ("TMUX_PANE", "%3"),
    ("TERM", "screen"),
    ("TERM_PROGRAM", "Apple_Terminal"),
    ("TERM_PROGRAM_VERSION", "455"),
    ("TERM_SESSION_ID", "w0t0p0:0000"),
    ("SHELL_SESSION_ID", "abc"),
    ("VSCODE_IPC_HOOK_CLI", "/nonexistent/vscode.sock"),
    ("CLAUDECODE", "1"),
    ("SHLVL", "4"),
    ("PWD", "/nonexistent"),
    ("OLDPWD", "/nonexistent/old"),
    ("COLUMNS", "33"),
    ("LINES", "9"),
    ("INVOCATION_ID", "0123456789abcdef"),
    ("SHELL", "/bin/sh"),
    ("LANG", "en_US.ISO-8859-1"),
    ("G3D_TERMD_DIR", "/nonexistent/termd"),
    ("KEEP_ME", "kept"),
];

fn odd_daemon(args: &[&str]) -> Daemon {
    Daemon::start_cmd(args, |cmd, _| {
        use std::os::unix::process::CommandExt;
        cmd.env_clear().envs(ODD.iter().copied());
        // SAFETY: plain calls between fork and exec. The starter ignores SIGINT (as a shell's
        // background job does) and has a low soft fd limit; neither may reach a terminal.
        unsafe {
            cmd.pre_exec(|| {
                libc::signal(libc::SIGINT, libc::SIG_IGN);
                let mut rl: libc::rlimit = std::mem::zeroed();
                libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl);
                rl.rlim_cur = 1000.min(rl.rlim_max);
                libc::setrlimit(libc::RLIMIT_NOFILE, &rl);
                Ok(())
            });
        }
    })
}

fn create_with(c: &mut Client, id: &str, f: impl FnOnce(&mut Create)) -> Result<CreateReply, g3d::client::ClientError> {
    let mut cr = Create { id: id.into(), cols: 120, rows: 30, ..Default::default() };
    f(&mut cr);
    c.request(Op::Create(cr))
}

/// A process's environment as it was exec'd.
fn environ(pid: u32) -> BTreeMap<String, String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).unwrap();
    raw.split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|kv| {
            let s = String::from_utf8_lossy(kv);
            let (k, v) = s.split_once('=').unwrap();
            (k.to_owned(), v.to_owned())
        })
        .collect()
}

fn cmdline(pid: u32) -> Vec<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap();
    raw.split(|&b| b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
}

fn status_field(pid: u32, name: &str) -> String {
    let s = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    s.lines().find_map(|l| l.strip_prefix(name)).map(|v| v.trim().to_owned()).unwrap_or_default()
}

/// The passwd entry: (name, home, shell).
fn passwd() -> (String, String, String) {
    let out = Command::new("getent").arg("passwd").arg(unsafe { libc::getuid() }.to_string()).output().unwrap();
    let line = String::from_utf8(out.stdout).unwrap();
    let f: Vec<&str> = line.trim().split(':').collect();
    (f[0].to_owned(), f[5].to_owned(), f[6].to_owned())
}

#[test]
fn a_terminal_from_an_odd_starter_gets_the_policy_environment() {
    let d = odd_daemon(&["--idle-exit", "0"]);
    let mut c = d.client();
    let (user, home, shell) = passwd();
    let r = create_with(&mut c, "e1", |cr| cr.argv = Some(vec!["sleep".into(), "60".into()])).unwrap();
    // `sleep` resolved in the program's own PATH; an explicit argv is never a login shell.
    assert!(r.argv[0].ends_with("/sleep") && r.argv[0].starts_with('/'), "{:?}", r.argv);
    assert!(!r.login);
    let env = environ(r.pid);
    // Scrubbed: other processes' identity, the launcher, the parent shell, termd's controls.
    for gone in [
        "TMUX",
        "TMUX_PANE",
        "TERM_SESSION_ID",
        "SHELL_SESSION_ID",
        "VSCODE_IPC_HOOK_CLI",
        "CLAUDECODE",
        "SHLVL",
        "OLDPWD",
        "COLUMNS",
        "LINES",
        "INVOCATION_ID",
        "G3D_TERMD_DIR",
        "G3D_TERMD_TEST_HOOKS",
    ] {
        assert!(!env.contains_key(gone), "{gone} leaked: {:?}", env.get(gone));
    }
    let get = |k: &str| env.get(k).map(String::as_str);
    // termd's own describe this terminal.
    assert_eq!(get("TERM"), Some("xterm-256color"));
    assert_eq!(get("COLORTERM"), Some("truecolor"));
    assert_eq!(get("TERM_PROGRAM"), Some("g3d-termd"));
    assert_eq!(get("TERM_PROGRAM_VERSION"), Some(env!("CARGO_PKG_VERSION")));
    assert_eq!(get("G3D_TERMD_ID"), Some("e1"));
    assert_eq!(get("G3D_TERMD_SOCKET"), d.socket.to_str());
    // The account fills what the starter lacked; SHELL is the account's, not the starter's.
    assert_eq!(get("HOME"), Some(home.as_str()));
    assert_eq!(get("USER"), Some(user.as_str()));
    assert_eq!(get("LOGNAME"), Some(user.as_str()));
    assert_eq!(get("SHELL"), Some(shell.as_str()));
    // With --env-source daemon the starter's environment is the base: its own values pass.
    assert_eq!(get("DISPLAY"), Some(":99"));
    assert_eq!(get("KEEP_ME"), Some("kept"));
    assert_eq!(get("PATH"), Some("/usr/bin:/bin"));
    // A set locale is the person's, even when it isn't UTF-8.
    assert_eq!(get("LANG"), Some("en_US.ISO-8859-1"));
    // The default directory is home, and PWD says so.
    assert_eq!(r.cwd, home);
    assert_eq!(get("PWD"), Some(home.as_str()));
    assert_eq!(std::fs::read_link(format!("/proc/{}/cwd", r.pid)).unwrap().to_str(), Some(home.as_str()));
    // The starter's ignored SIGINT and the holder's raised fd limit stay out.
    assert_eq!(status_field(r.pid, "SigIgn:"), "0000000000000000", "ignored signals reached the program");
    assert_eq!(status_field(r.pid, "SigBlk:"), "0000000000000000", "blocked signals reached the program");
    let limits = std::fs::read_to_string(format!("/proc/{}/limits", r.pid)).unwrap();
    let nofile = limits.lines().find(|l| l.starts_with("Max open files")).unwrap();
    assert_eq!(nofile.split_whitespace().nth(3), Some("1000"), "{nofile}");
}

#[test]
fn the_default_program_is_the_account_shell_as_a_login_shell() {
    let d = odd_daemon(&["--idle-exit", "0"]);
    let mut c = d.client();
    let (_, home, shell) = passwd();
    let r = create_with(&mut c, "sh", |_| {}).unwrap();
    assert_eq!(r.argv, vec![shell.clone()]);
    assert!(r.login);
    assert_eq!(r.cwd, home);
    // argv[0] is "-<name>": the login convention (the starter's SHELL=/bin/sh is ignored).
    let name = shell.rsplit('/').next().unwrap();
    assert_eq!(cmdline(r.pid).first().map(String::as_str), Some(format!("-{name}").as_str()));
    assert_eq!(environ(r.pid).get("SHELL"), Some(&shell));
    // The list shows what runs, and an adopt answers the same.
    let a = create_with(&mut c, "sh", |cr| cr.if_exists = Some(IfExists::Adopt)).unwrap();
    assert!(!a.created && a.login && a.argv == r.argv && a.cwd == r.cwd);
    // The PTY erases whole UTF-8 characters in canonical mode.
    let t = create_with(&mut c, "stty", |cr| {
        cr.argv = Some(["/bin/sh", "-c", "stty -a; sleep 60"].map(String::from).to_vec());
    })
    .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let cap: CaptureReply = c
            .request(Op::Capture(Capture { id: "stty".into(), format: None, history_rows: None, unwrap: Some(true) }))
            .unwrap();
        if cap.text.contains("iutf8") {
            assert!(cap.text.split_whitespace().any(|w| w == "iutf8"), "IUTF8 is off: {}", cap.text);
            break;
        }
        assert!(Instant::now() < until, "no stty output: {}", cap.text);
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = t;
}

#[test]
fn env_base_none_starts_from_the_account_and_fills_the_locale() {
    let d = odd_daemon(&["--idle-exit", "0"]);
    let mut c = d.client();
    let (user, home, shell) = passwd();
    let r = create_with(&mut c, "bare", |cr| {
        cr.argv = Some(vec!["/bin/sleep".into(), "60".into()]);
        cr.env_base = Some(EnvBase::None);
        cr.env = Some(BTreeMap::from([("FOO".into(), Some("bar".into()))]));
    })
    .unwrap();
    let env = environ(r.pid);
    let keys: Vec<&str> = env.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "COLORTERM",
            "FOO",
            "G3D_TERMD_ID",
            "G3D_TERMD_SOCKET",
            "HOME",
            "LANG",
            "LOGNAME",
            "PWD",
            "SHELL",
            "TERM",
            "TERM_PROGRAM",
            "TERM_PROGRAM_VERSION",
            "USER"
        ]
    );
    assert_eq!(env["LANG"], "C.UTF-8");
    assert_eq!(
        (env["HOME"].as_str(), env["USER"].as_str(), env["SHELL"].as_str()),
        (home.as_str(), user.as_str(), shell.as_str())
    );
}

#[test]
fn create_refuses_reserved_names_bad_values_and_a_bad_cwd() {
    let d = odd_daemon(&["--idle-exit", "0"]);
    let mut c = d.client();
    let sleep = || Some(vec!["/bin/sleep".to_string(), "60".into()]);
    for (name, value) in [("TERM", Some("dumb")), ("TERM_PROGRAM", None), ("PWD", Some("/")), ("bad-name", Some("x"))] {
        let e = create_with(&mut c, "r", |cr| {
            cr.argv = sleep();
            cr.env = Some(BTreeMap::from([(name.to_string(), value.map(String::from))]));
        })
        .unwrap_err();
        assert!(e.to_string().contains("bad_request") && e.to_string().contains(name), "{name}: {e}");
    }
    let e = create_with(&mut c, "r", |cr| {
        cr.argv = sleep();
        cr.env = Some(BTreeMap::from([("HUGE".into(), Some("x".repeat(200 << 10)))]));
    })
    .unwrap_err();
    assert!(e.to_string().contains("too_large") && e.to_string().contains("HUGE"), "{e}");
    for cwd in ["relative", "/nonexistent/dir"] {
        let e = create_with(&mut c, "r", |cr| {
            cr.argv = sleep();
            cr.cwd = Some(cwd.into());
        })
        .unwrap_err();
        assert!(e.to_string().contains("bad_request"), "{cwd}: {e}");
    }
    let e = create_with(&mut c, "r", |cr| cr.argv = Some(vec!["no-such-program-here".into()])).unwrap_err();
    assert!(e.to_string().contains("spawn_failed") && e.to_string().contains("not found in PATH"), "{e}");
    // A given cwd is used as given, and PWD keeps its spelling.
    let r = create_with(&mut c, "r", |cr| {
        cr.argv = sleep();
        cr.cwd = Some("/usr/../usr".into());
    })
    .unwrap();
    assert_eq!(environ(r.pid).get("PWD").map(String::as_str), Some("/usr/../usr"));
}

/// The session source is read at every create: a value the session changes reaches the next
/// terminal, never a running one. The user manager is stood in for by a file of busctl's JSON
/// (a test hook), so the real desktop session is never read or changed.
#[cfg(feature = "test-hooks")]
#[test]
fn the_session_environment_is_read_at_every_create() {
    let write = |dir: &std::path::Path, display: &str| {
        let json = format!(
            r#"{{"type":"as","data":["DISPLAY={display}","PATH=/usr/bin:/bin","TMUX=leaked","LANG=C.UTF-8","SESSION_ONLY=yes"]}}"#
        );
        std::fs::write(dir.join("manager.json"), json).unwrap();
    };
    let d = Daemon::start_cmd(&["--idle-exit", "0", "--env-source", "auto"], |cmd, dir| {
        write(dir, ":7");
        cmd.env_clear().envs(ODD.iter().copied()).env("G3D_TERMD_TEST_SESSION_ENV_FILE", dir.join("manager.json"));
    });
    let mut c = d.client();
    let sleep = || Some(vec!["/bin/sleep".to_string(), "60".into()]);
    let a = create_with(&mut c, "a", |cr| cr.argv = sleep()).unwrap();
    let ea = environ(a.pid);
    // The session's values, not the starter's stale ones; the scrub applies to it too.
    assert_eq!(ea.get("DISPLAY").map(String::as_str), Some(":7"));
    assert_eq!(ea.get("SESSION_ONLY").map(String::as_str), Some("yes"));
    assert_eq!(ea.get("KEEP_ME"), None, "the starter's environment leaked past the session's");
    assert_eq!(ea.get("TMUX"), None);
    write(&d.dir, ":8");
    let b = create_with(&mut c, "b", |cr| cr.argv = sleep()).unwrap();
    assert_eq!(environ(b.pid).get("DISPLAY").map(String::as_str), Some(":8"));
    assert_eq!(environ(a.pid).get("DISPLAY").map(String::as_str), Some(":7"));
    assert!(d.log().contains("terminal environment: the systemd user manager's"), "{}", d.log());
    // A manager that can't be read: the daemon's own, said once in the log.
    std::fs::remove_file(d.dir.join("manager.json")).unwrap();
    let e = create_with(&mut c, "e", |cr| cr.argv = sleep()).unwrap();
    assert_eq!(environ(e.pid).get("DISPLAY").map(String::as_str), Some(":99"));
    assert!(d.log().contains("terminal environment: the daemon's own:"), "{}", d.log());
}

/// The real user manager, when this host has one: a starter's stale DISPLAY never reaches a
/// terminal. Read only (nothing is set in the session), into a terminal that runs `sleep`.
#[test]
fn the_user_manager_wins_over_a_stale_starter_when_it_answers() {
    let out = Command::new("busctl")
        .args([
            "--user",
            "--json=short",
            "get-property",
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            "Environment",
        ])
        .output();
    let Some(out) = out.ok().filter(|o| o.status.success()) else {
        eprintln!("no systemd user manager answers here; the hook-driven test covers the logic");
        return;
    };
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let display: Option<String> = v["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e.as_str()?.strip_prefix("DISPLAY=").map(str::to_owned))
        .next();
    // The odd starter has no bus address: the daemon finds the user bus at /run/user/<uid>.
    let d = odd_daemon(&["--idle-exit", "0", "--env-source", "auto"]);
    let mut c = d.client();
    let r = create_with(&mut c, "um", |cr| cr.argv = Some(vec!["/bin/sleep".into(), "60".into()])).unwrap();
    let env = environ(r.pid);
    assert_eq!(env.get("DISPLAY"), display.as_ref(), "the starter's DISPLAY=:99 reached the terminal");
    assert_eq!(env.get("KEEP_ME"), None);
    assert!(d.log().contains("terminal environment: the systemd user manager's"), "{}", d.log());
}
