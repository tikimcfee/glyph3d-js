//! The environment a terminal's program gets (DESIGN.md, "Environment"): a daemon started from a
//! deliberately odd environment (stripped, a stale `DISPLAY`, another terminal's identity, a
//! parent shell's state, `SIGINT` ignored, a low fd limit), callers that send their own odd
//! environment and creators that send none, and what their terminals' programs see, read from
//! the kernel (`/proc/<pid>/environ`, `cmdline`, `cwd`, `status`, `limits`; the macOS branch
//! reads them with `ps`) and from `env`'s tags.

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
    // A Claude Code shell in Ghostty (as a relay started by an agent has): its session, its IPC
    // token, its editor stub, a shell tool's session and the window unit's cgroup state.
    ("CLAUDE_CODE_SESSION_ID", "11111111-2222"),
    ("CLAUDE_CODE_MESSAGING_TOKEN", "secret"),
    ("CLAUDE_PID", "4242"),
    ("AI_AGENT", "claude-code_test"),
    ("GIT_EDITOR", "true"),
    ("COREPACK_ENABLE_AUTO_PIN", "0"),
    ("ATUIN_SESSION", "0190abcd"),
    ("ATUIN_HISTORY_ID", "0190ef"),
    ("MEMORY_PRESSURE_WATCH", "/sys/fs/cgroup/app.slice/x.service/memory.pressure"),
    ("MANAGERPIDFDID", "1234"),
    ("HOME", "/nonexistent/scratch-home"),
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

/// The `env` op's answer for a terminal: name → (value, source, via).
fn tagged(c: &mut Client, id: &str) -> BTreeMap<String, (String, EnvSource, Option<String>)> {
    let r: EnvReply = c.request(Op::Env(EnvQuery { id: id.into() })).unwrap();
    assert_eq!(r.id, id);
    r.env.into_iter().map(|v| (v.name, (v.value, v.source, v.via))).collect()
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
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_PID",
        "AI_AGENT",
        "GIT_EDITOR",
        "COREPACK_ENABLE_AUTO_PIN",
        "ATUIN_SESSION",
        "ATUIN_HISTORY_ID",
        "MEMORY_PRESSURE_WATCH",
        "MANAGERPIDFDID",
        "KEEP_ME",
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
    // The account is the user database's, not the starter's (whose HOME is a scratch one); SHELL
    // is the account's too.
    assert_eq!(get("HOME"), Some(home.as_str()));
    assert_eq!(get("USER"), Some(user.as_str()));
    assert_eq!(get("LOGNAME"), Some(user.as_str()));
    assert_eq!(get("SHELL"), Some(shell.as_str()));
    // No caller's environment, and --env-source daemon: each allowlisted name from the starter's
    // values (its DISPLAY passes), nothing else of it (its own tool's KEEP_ME, its PATH: PATH is
    // login(1)'s).
    assert_eq!(get("DISPLAY"), Some(":99"));
    let t = tagged(&mut c, "e1");
    assert_eq!((t["PATH"].1, t["PATH"].2.as_deref()), (EnvSource::Fill, Some("login")));
    assert_ne!(get("PATH"), Some("/usr/bin:/bin"), "the starter's PATH is not a session's");
    assert_eq!(t["DISPLAY"], (":99".into(), EnvSource::Session, Some("daemon".into())));
    assert_eq!(t["HOME"], (home.clone(), EnvSource::Fill, Some("passwd".into())));
    assert_eq!(t["TERM"].1, EnvSource::Termd);
    assert!(t.values().all(|(_, s, _)| *s != EnvSource::Caller), "no caller sent an environment");
    assert_eq!(t.len(), environ(r.pid).len(), "env names every variable the program has");
    // A set locale is the person's, even when it isn't UTF-8; the status document and the log say
    // what it costs.
    assert_eq!(get("LANG"), Some("en_US.ISO-8859-1"));
    let st: StatusReply = c.request(Op::Status).unwrap();
    let w = st.status.daemon.env.warnings.join("\n");
    assert!(w.contains("terminal e1: LANG=en_US.ISO-8859-1"), "no locale warning: {w:?}");
    assert!(d.log().contains("terminal e1: LANG=en_US.ISO-8859-1"), "{}", d.log());
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

/// termd.toml: `pass` adds a name to the no-caller allowlist, `drop` removes one, `set` sets one
/// with `${VAR}` from the base; re-read when it changes; a bad file fails every create, naming its
/// line, until it is fixed; the status document says which.
#[test]
fn termd_toml_adjusts_the_allowlist_sets_names_and_a_bad_one_fails_loudly() {
    let d = odd_daemon(&["--idle-exit", "0"]);
    let toml = d.dir.join("termd.toml");
    let mut c = d.client();
    let sleep = || Some(vec!["/bin/sleep".to_string(), "60".into()]);
    let st: StatusReply = c.request(Op::Status).unwrap();
    assert_eq!(
        (st.status.daemon.env.config.path.as_str(), st.status.daemon.env.config.state.as_str()),
        (toml.to_str().unwrap(), "absent")
    );
    std::fs::write(&toml, "[env]\npass = [\"KEEP_*\"]\ndrop = [\"DISPLAY\"]\n[env.set]\nWHERE = \"${HOME}/x\"\n")
        .unwrap();
    let r = create_with(&mut c, "k", |cr| cr.argv = sleep()).unwrap();
    let env = environ(r.pid);
    let (_, home, _) = passwd();
    assert_eq!(env.get("KEEP_ME").map(String::as_str), Some("kept"));
    assert_eq!(env.get("DISPLAY"), None, "drop took DISPLAY off the allowlist");
    assert_eq!(env.get("WHERE"), Some(&format!("{home}/x")));
    assert_eq!(env.get("GIT_EDITOR"), None);
    let t = tagged(&mut c, "k");
    assert_eq!(t["KEEP_ME"], ("kept".into(), EnvSource::Session, Some("daemon".into())));
    assert_eq!(t["WHERE"].1, EnvSource::File);
    let st: StatusReply = c.request(Op::Status).unwrap();
    assert_eq!(st.status.daemon.env.config.state, "loaded");
    assert!(d.log().contains("pass KEEP_*; drop DISPLAY; set WHERE"), "{}", d.log());
    // A bad file: every create fails, naming the line, and the status document says so.
    std::fs::write(&toml, "[env]\npass = [\"KEEP_*\"]\n[env.set]\nTERM = \"dumb\"\n").unwrap();
    let e = create_with(&mut c, "bad", |cr| cr.argv = sleep()).unwrap_err().to_string();
    assert!(
        e.contains("spawn_failed") && e.contains("termd.toml") && e.contains("line 4") && e.contains("TERM"),
        "{e}"
    );
    let st: StatusReply = c.request(Op::Status).unwrap();
    let cfg = &st.status.daemon.env.config;
    assert_eq!(cfg.state, "error");
    assert!(cfg.error.as_deref().is_some_and(|e| e.contains("line 4")), "{cfg:?}");
    assert!(st.status.daemon.env.warnings.iter().any(|w| w.contains("line 4")), "{:?}", st.status.daemon.env.warnings);
    // Fixed: the next create reads it again.
    std::fs::write(&toml, "[env.set]\nFIXED = \"yes\"\n").unwrap();
    let r = create_with(&mut c, "fixed", |cr| cr.argv = sleep()).unwrap();
    assert_eq!(environ(r.pid).get("FIXED").map(String::as_str), Some("yes"));
    assert_eq!(environ(r.pid).get("KEEP_ME"), None, "the old pass outlived its file");
    let st: StatusReply = c.request(Op::Status).unwrap();
    assert_eq!(st.status.daemon.env.config.state, "loaded");
    assert!(
        st.status.daemon.env.warnings.iter().all(|w| !w.contains("termd.toml")),
        "{:?}",
        st.status.daemon.env.warnings
    );
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
fn an_empty_caller_environment_starts_from_the_fill_alone() {
    let d = odd_daemon(&["--idle-exit", "0"]);
    let mut c = d.client();
    let (user, home, shell) = passwd();
    let r = create_with(&mut c, "bare", |cr| {
        cr.argv = Some(vec!["/bin/sleep".into(), "60".into()]);
        cr.env_base = Some(BTreeMap::new());
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
            "PATH",
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
    // A caller's environment: the same name and size rules, but termd's own names may be there.
    let e = create_with(&mut c, "r", |cr| {
        cr.argv = sleep();
        cr.env_base = Some(BTreeMap::from([("BASH_FUNC_f%%".into(), "() { :; }".into())]));
    })
    .unwrap_err();
    assert!(e.to_string().contains("bad_request") && e.to_string().contains("env_base"), "{e}");
    let e = create_with(&mut c, "r", |cr| {
        cr.argv = sleep();
        cr.env_base = Some(BTreeMap::from([("HUGE".into(), "x".repeat(200 << 10))]));
    })
    .unwrap_err();
    assert!(e.to_string().contains("too_large") && e.to_string().contains("HUGE"), "{e}");
    let r = create_with(&mut c, "own", |cr| {
        cr.argv = sleep();
        cr.env_base = Some(BTreeMap::from([("TERM".into(), "screen".into()), ("PWD".into(), "/x".into())]));
    })
    .unwrap();
    assert_eq!(environ(r.pid).get("TERM").map(String::as_str), Some("xterm-256color"));
    let e = c.request::<EnvReply>(Op::Env(EnvQuery { id: "nope".into() })).unwrap_err();
    assert_eq!(e.code(), Some(code::NO_TERMINAL));
    let e = create_with(&mut c, "r", |cr| cr.argv = Some(vec!["no-such-program-here".into()])).unwrap_err();
    assert!(e.to_string().contains("spawn_failed") && e.to_string().contains("not found in PATH"), "{e}");
    // A given cwd keeps its spelling in PWD unless that holds `.` or `..` (POSIX forbids them
    // there): then PWD and the reply name the real directory.
    let r = create_with(&mut c, "r", |cr| {
        cr.argv = sleep();
        cr.cwd = Some("/usr/../usr".into());
    })
    .unwrap();
    assert_eq!((r.cwd.as_str(), environ(r.pid).get("PWD").map(String::as_str)), ("/usr", Some("/usr")));
}

/// Writes a stand-in for the user manager's environment (busctl's JSON; the test hook), so the
/// real desktop session is never read or changed.
#[cfg(feature = "test-hooks")]
fn write_manager(dir: &std::path::Path, vars: &[&str]) {
    let data: Vec<String> = vars.iter().map(|v| format!("{v:?}")).collect();
    std::fs::write(dir.join("manager.json"), format!(r#"{{"type":"as","data":[{}]}}"#, data.join(","))).unwrap();
}

/// A daemon whose starter is `starter` and whose user manager is the hook's file.
#[cfg(feature = "test-hooks")]
fn session_daemon(starter: &[(&str, &str)], manager: &[&str]) -> Daemon {
    let (starter, manager): (Vec<(String, String)>, Vec<String>) = (
        starter.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        manager.iter().map(|s| s.to_string()).collect(),
    );
    Daemon::start_cmd(&["--idle-exit", "0", "--env-source", "auto"], move |cmd, dir| {
        write_manager(dir, &manager.iter().map(String::as_str).collect::<Vec<_>>());
        cmd.env_clear().envs(starter).env("G3D_TERMD_TEST_SESSION_ENV_FILE", dir.join("manager.json"));
    })
}

/// The session source is read at every create: a value the session changes reaches the next
/// terminal, never a running one; only the allowlist comes from it; a name it lacks is the
/// daemon's start value; a source that can't be read leaves the start values, said.
#[cfg(feature = "test-hooks")]
#[test]
fn the_session_environment_is_read_at_every_create() {
    let manager = |display: &str| {
        vec![
            format!("DISPLAY={display}"),
            "PATH=/session/bin:/usr/bin".into(),
            "LC_TERMINAL=iTerm2".into(),
            "LANG=C.UTF-8".into(),
            "SESSION_ONLY=yes".into(),
        ]
    };
    let first = manager(":7");
    let d = session_daemon(
        &[ODD, &[("SSH_AUTH_SOCK", "/starter/agent")]].concat(),
        &first.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    let mut c = d.client();
    let sleep = || Some(vec!["/bin/sleep".to_string(), "60".into()]);
    let a = create_with(&mut c, "a", |cr| cr.argv = sleep()).unwrap();
    let ea = environ(a.pid);
    // The session's values, not the starter's stale ones; the allowlist only; the scrub too.
    assert_eq!(ea.get("DISPLAY").map(String::as_str), Some(":7"));
    assert_eq!(ea.get("LANG").map(String::as_str), Some("C.UTF-8"));
    assert_eq!(ea.get("SESSION_ONLY"), None, "a name off the allowlist came from the session");
    assert_ne!(ea.get("PATH").map(String::as_str), Some("/session/bin:/usr/bin"), "PATH is login(1)'s");
    assert_eq!(ea.get("LC_TERMINAL"), None);
    assert_eq!(ea.get("KEEP_ME"), None, "the starter's environment leaked");
    // A name the session lacks: the starter's value for that name only.
    assert_eq!(ea.get("SSH_AUTH_SOCK").map(String::as_str), Some("/starter/agent"));
    let t = tagged(&mut c, "a");
    assert_eq!(t["DISPLAY"], (":7".into(), EnvSource::Session, Some("systemd-user".into())));
    assert_eq!(t["SSH_AUTH_SOCK"], ("/starter/agent".into(), EnvSource::Session, Some("daemon".into())));
    write_manager(&d.dir, &manager(":8").iter().map(String::as_str).collect::<Vec<_>>());
    let b = create_with(&mut c, "b", |cr| cr.argv = sleep()).unwrap();
    assert_eq!(environ(b.pid).get("DISPLAY").map(String::as_str), Some(":8"));
    assert_eq!(environ(a.pid).get("DISPLAY").map(String::as_str), Some(":7"));
    assert!(d.log().contains("terminal environment: the session's from the systemd user manager"), "{}", d.log());
    let st: StatusReply = c.request(Op::Status).unwrap();
    assert_eq!(st.status.daemon.env.source, "systemd-user");
    // A manager that can't be read: the daemon's start values, said in the log and the status.
    std::fs::remove_file(d.dir.join("manager.json")).unwrap();
    let e = create_with(&mut c, "e", |cr| cr.argv = sleep()).unwrap();
    assert_eq!(environ(e.pid).get("DISPLAY").map(String::as_str), Some(":99"));
    assert!(d.log().contains("terminal environment: the daemon's start values:"), "{}", d.log());
    let st: StatusReply = c.request(Op::Status).unwrap();
    assert_eq!(st.status.daemon.env.source, "daemon");
    assert!(
        st.status.daemon.env.warnings.iter().any(|w| w.contains("unreachable")),
        "{:?}",
        st.status.daemon.env.warnings
    );
}

/// A caller's environment is the base (the multiplexer convention): its custom variable and
/// even its stale DISPLAY arrive, its tab's markers don't; the same caller with no environment
/// sent (`g3d new --clean`) gets the session's fresh DISPLAY. `env` tags each.
#[cfg(feature = "test-hooks")]
#[test]
fn a_callers_environment_is_the_base_and_none_is_the_sessions() {
    let d = session_daemon(&[("PATH", "/usr/bin:/bin")], &["DISPLAY=:0", "WAYLAND_DISPLAY=wayland-0"]);
    let mut c = d.client();
    let sleep = || Some(vec!["/bin/sleep".to_string(), "60".into()]);
    let odd: BTreeMap<String, String> = [
        ("PATH", "/caller/bin:/usr/bin:/bin"),
        ("DISPLAY", ":55"),
        ("REX_SESSION", "rex-tab-3"),
        ("REX_BLOCK", "9"),
        ("TERM_PROGRAM", "Apple_Terminal"),
        ("FOO", "custom"),
        ("HOME", "/caller/home"),
        ("SHLVL", "2"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let r = create_with(&mut c, "sub", |cr| {
        cr.argv = sleep();
        cr.env_base = Some(odd.clone());
        cr.env = Some(BTreeMap::from([("BAR".into(), Some("asked".into()))]));
    })
    .unwrap();
    let env = environ(r.pid);
    let get = |k: &str| env.get(k).map(String::as_str);
    assert_eq!(get("FOO"), Some("custom"));
    assert_eq!(get("DISPLAY"), Some(":55"), "a caller's own DISPLAY is its subshell's");
    assert_eq!(get("PATH"), Some("/caller/bin:/usr/bin:/bin"));
    assert_eq!(get("HOME"), Some("/caller/home"));
    assert_eq!((get("REX_SESSION"), get("REX_BLOCK"), get("SHLVL")), (None, None, None));
    assert_eq!(get("TERM_PROGRAM"), Some("g3d-termd"));
    assert_eq!(get("WAYLAND_DISPLAY"), None, "the session's handles mixed into a caller's base");
    let t = tagged(&mut c, "sub");
    assert_eq!(t["FOO"], ("custom".into(), EnvSource::Caller, None));
    assert_eq!(t["BAR"].1, EnvSource::Request);
    assert_eq!(t["USER"].1, EnvSource::Fill);
    assert_eq!(t["TERM_PROGRAM"].1, EnvSource::Termd);
    // No environment sent: the session's DISPLAY, looked up now.
    let r = create_with(&mut c, "clean", |cr| cr.argv = sleep()).unwrap();
    let env = environ(r.pid);
    assert_eq!(env.get("DISPLAY").map(String::as_str), Some(":0"));
    assert_eq!(env.get("FOO"), None);
    assert_eq!(tagged(&mut c, "clean")["DISPLAY"], (":0".into(), EnvSource::Session, Some("systemd-user".into())));
}

/// A creator with no shell and a stripped environment (the relay started by a unit, cron, an
/// agent): its terminals get the desktop session's handles from the session source, and none of
/// the session's other variables.
#[cfg(feature = "test-hooks")]
#[test]
fn a_stripped_creator_gets_the_sessions_handles() {
    let d = session_daemon(
        &[("PATH", "/usr/bin:/bin")],
        &[
            "DISPLAY=:0",
            "WAYLAND_DISPLAY=wayland-0",
            "XAUTHORITY=/run/user/1/xauth",
            "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1/bus",
            "XDG_RUNTIME_DIR=/run/user/1",
            "XDG_SESSION_TYPE=wayland",
            "XDG_CURRENT_DESKTOP=KDE",
            "SSH_AUTH_SOCK=/run/user/1/ssh-agent",
            "LANG=C.UTF-8",
            "EDITOR=vim",
            "GIT_EDITOR=true",
        ],
    );
    let mut c = d.client();
    let r = create_with(&mut c, "relay", |cr| cr.argv = Some(vec!["/bin/sleep".into(), "60".into()])).unwrap();
    let env = environ(r.pid);
    for (k, v) in [
        ("DISPLAY", ":0"),
        ("WAYLAND_DISPLAY", "wayland-0"),
        ("XAUTHORITY", "/run/user/1/xauth"),
        ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1/bus"),
        ("XDG_RUNTIME_DIR", "/run/user/1"),
        ("XDG_SESSION_TYPE", "wayland"),
        ("XDG_CURRENT_DESKTOP", "KDE"),
        ("SSH_AUTH_SOCK", "/run/user/1/ssh-agent"),
    ] {
        assert_eq!(env.get(k).map(String::as_str), Some(v), "{k}");
    }
    assert_eq!((env.get("EDITOR"), env.get("GIT_EDITOR")), (None, None));
    let t = tagged(&mut c, "relay");
    assert!(
        ["DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK"]
            .iter()
            .all(|k| t[*k].1 == EnvSource::Session && t[*k].2.as_deref() == Some("systemd-user")),
        "{t:?}"
    );
}

/// The real user manager, when this host has one: a starter's stale DISPLAY never wins over its
/// own. Read only (nothing is set in the session), into a terminal that runs `sleep`.
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
    // A manager without DISPLAY (a headless host) leaves the starter's for that name.
    assert_eq!(
        env.get("DISPLAY").map(String::as_str),
        Some(display.as_deref().unwrap_or(":99")),
        "the starter's DISPLAY=:99 won over the manager's"
    );
    assert_eq!(env.get("KEEP_ME"), None);
    assert!(d.log().contains("terminal environment: the session's from the systemd user manager"), "{}", d.log());
}
