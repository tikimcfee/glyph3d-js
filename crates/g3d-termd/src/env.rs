//! What a terminal's program is started as: its path and argv, its working directory and its
//! whole environment (DESIGN.md, "Environment"; PROTOCOL.md, "The program's environment").
//! The brain decides all of it per `create`; the holder only runs the result.
//!
//! **A new terminal carries its creator's environment; a creator with none gets the desktop
//! session's.** Layers, later winning, each variable tagged with the one that set it:
//! (1) the base: the caller's environment (`create.env_base`), or, for a creator with none, the
//! session's allowlisted names ([`SESSION`] and `termd.toml`'s `pass`, less its `drop`), each
//! looked up now in the platform's session source and, when it lacks one, the daemon's start
//! value for that name; (2) minus the scrub; (3) the fill (`login(1)`'s account, `SHELL`, `PATH`
//! and a locale, where missing); (4) `termd.toml`'s `set`; (5) the request's `env`; (6) termd's
//! own. [`compose`] is the pure part (unit-tested below); [`Policy`] reads the session source and
//! the file.

use g3d_wire::msg::{ENV_VALUE_MAX, EnvSource, EnvVar, StatusEnvConfig, WireError, code, env_name_ok};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Names that point back at some other process: another terminal's tab or window, a
/// multiplexer, an editor or agent; the launcher or unit; the parent shell; termd's own controls.
/// `NAME*` is a prefix. Best effort: an unlisted variable rides along, as in tmux and screen. A
/// setting (`--env-scrub`) adds to it and `termd.toml`'s `pass` exempts from it.
pub const SCRUB: &[&str] = &[
    // Terminals, multiplexers, editors and agents.
    "TMUX",
    "TMUX_PANE",
    "STY",
    "WINDOW",
    "ZELLIJ*",
    "VTE_VERSION",
    "KONSOLE_*",
    "ITERM_*",
    "TERM_SESSION_ID",
    "KITTY_*",
    "WEZTERM_*",
    "ALACRITTY_*",
    "GHOSTTY_*",
    "WT_SESSION",
    "TERMINAL_EMULATOR",
    "REX_*",
    "VSCODE_*",
    "NVIM",
    "INSIDE_EMACS",
    "CLAUDECODE",
    "CLAUDE_CODE_*",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM*",
    "TERMINFO",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "COLORFGBG",
    "WINDOWID",
    "SHELL_SESSION_ID",
    // The creator's own terminal device (an SSH login's, the one a profile pinned GPG to).
    "SSH_TTY",
    "GPG_TTY",
    // macOS: the app and launchd job that started the creator.
    "__CFBundleIdentifier",
    "XPC_SERVICE_NAME",
    // The launcher and the unit (systemd.exec(5), "Environment Variables in Spawned Processes").
    "INVOCATION_ID",
    "JOURNAL_STREAM",
    "NOTIFY_SOCKET",
    "LISTEN_*",
    "MANAGERPID",
    "MANAGERPIDFDID",
    "MAINPID",
    "SYSTEMD_EXEC_PID",
    "WATCHDOG_*",
    "MEMORY_PRESSURE_*",
    "CREDENTIALS_DIRECTORY",
    "RUNTIME_DIRECTORY",
    "STATE_DIRECTORY",
    "CACHE_DIRECTORY",
    "LOGS_DIRECTORY",
    "CONFIGURATION_DIRECTORY",
    "FDSTORE",
    "PIDFILE",
    "TRIGGER_*",
    "MONITOR_*",
    "SERVICE_RESULT",
    "EXIT_CODE",
    "EXIT_STATUS",
    "DBUS_STARTER_*",
    "GIO_LAUNCHED_DESKTOP_FILE*",
    "DESKTOP_STARTUP_ID",
    "XDG_ACTIVATION_TOKEN",
    // The parent shell's own state.
    "SHLVL",
    "OLDPWD",
    "PWD",
    "_",
    "COLUMNS",
    "LINES",
    "ATUIN_SESSION",
    "ATUIN_HISTORY_ID",
    "ATUIN_SHLVL",
    // termd's own controls (G3D_TERMD_DIR, G3D_TERMD_ENV_SOURCE, G3D_TERMD_CONFIG, the test hooks).
    "G3D_TERMD_*",
];

/// The no-caller allowlist: what a terminal whose creator sends no environment (the wall, the
/// relay, an agent) copies from the desktop session, each name looked up at every `create`. A
/// base built from a known set, as `login(1)`, `sshd` and sudo's `env_reset` build a session;
/// the login shell's profile brings back what a person exports. The account (`HOME`, `USER`,
/// `LOGNAME`, `SHELL`) and a minimal `PATH` are the fill's (layer 3), from passwd and as
/// `login(1)` sets them, not looked up. `termd.toml`'s `pass` adds names and `drop` removes them.
pub const SESSION: &[&str] = &[
    // The locale.
    "LANG",
    "LANGUAGE",
    "LC_*",
    // The desktop session: the display server, the session bus, pam_systemd's runtime directory
    // and session names, the desktop's name and its XDG base directories.
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_*",
    // The session's credential agents (tmux's update-environment carries the same).
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GPG_AGENT_INFO",
    "KRB5CCNAME",
    // The host's: the temporary directory (macOS's is per user), the time zone, the network
    // proxies (curl's and wget's names, both cases), the user's own terminfo directories.
    "TMPDIR",
    "TZ",
    "http_proxy",
    "https_proxy",
    "ftp_proxy",
    "all_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "FTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "TERMINFO_DIRS",
    // macOS: what launchd gives every process of the GUI session.
    "__CF_USER_TEXT_ENCODING",
    "COMMAND_MODE",
];

/// For a session source asked name by name (launchd's `getenv`), the names a prefix in the
/// allowlist stands for, besides those the daemon's start environment holds: POSIX's locale
/// categories and the XDG names a session sets.
const PREFIX_NAMES: &[&str] = &[
    "LC_ALL",
    "LC_CTYPE",
    "LC_COLLATE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_DIRS",
    "XDG_DATA_DIRS",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
    "XDG_SESSION_DESKTOP",
    "XDG_SESSION_CLASS",
    "XDG_SESSION_ID",
];

/// Layer 6: they describe this terminal, so a request or `termd.toml` may neither set nor remove
/// them.
pub const RESERVED: &[&str] =
    &["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "G3D_TERMD_ID", "G3D_TERMD_SOCKET", "PWD"];

/// argv plus the environment, as `execve` counts them against `ARG_MAX`: each string and its NUL,
/// and a pointer for each (and for each list's terminating null).
pub const EXEC_MAX: usize = 1 << 20;

/// Where a no-caller base looks its names up (`--env-source`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum SessionSource {
    /// The platform's session source (Linux: the systemd user manager; macOS: launchd), each name
    /// it lacks from the daemon's start values.
    Auto,
    /// Every name from the daemon's start values: hermetic, for tests and hosts without a session.
    Daemon,
}

/// Matches `NAME` exactly, or `PREFIX*` as a prefix.
fn matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(pre) => name.starts_with(pre),
        None => name == pattern,
    }
}

fn any_match(patterns: &[impl AsRef<str>], name: &str) -> bool {
    patterns.iter().any(|p| matches(p.as_ref(), name))
}

/// One variable and the layer that set it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Var {
    pub value: String,
    pub source: EnvSource,
    /// Within the source, where (PROTOCOL.md, `env`).
    pub via: Option<&'static str>,
}

impl Var {
    fn new(value: impl Into<String>, source: EnvSource, via: Option<&'static str>) -> Self {
        Var { value: value.into(), source, via }
    }
}

/// An environment as it is composed: each name with its value and source.
pub type Env = BTreeMap<String, Var>;

/// A session source's answer: its variables, and its name (`via`).
pub type SourceAnswer = (Vec<(String, String)>, &'static str);

/// The account, as `login(1)` knows it.
#[derive(Clone, Debug)]
pub struct Account {
    pub name: String,
    pub home: String,
    /// The passwd entry's shell; empty when it has none.
    pub shell: String,
}

/// This process's account from the user database (`getpwuid_r`: on macOS the directory service).
/// Read per `create`, so a `chsh` reaches the next terminal.
pub fn account() -> Result<Account, String> {
    let uid = rustix::process::getuid().as_raw();
    let mut buf = vec![0u8; 4096];
    loop {
        // SAFETY: getpwuid_r writes the entry into `pw` and its strings into `buf`, both ours;
        // the pointers it leaves in `pw` are read before `buf` is touched again.
        let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        let rc = unsafe { libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr().cast(), buf.len(), &mut out) };
        if rc == libc::ERANGE && buf.len() < 1 << 20 {
            buf.resize(buf.len() * 2, 0);
            continue;
        }
        if rc != 0 {
            return Err(format!("getpwuid_r({uid}): {}", std::io::Error::from_raw_os_error(rc)));
        }
        if out.is_null() {
            return Err(format!("uid {uid} has no passwd entry"));
        }
        let s = |p: *const libc::c_char| {
            if p.is_null() {
                String::new()
            } else {
                // SAFETY: a NUL-terminated string inside `buf`.
                unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned()
            }
        };
        return Ok(Account { name: s(pw.pw_name), home: s(pw.pw_dir), shell: s(pw.pw_shell) });
    }
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The search path `execvp` uses when `PATH` is unset (`confstr(_CS_PATH)`).
fn default_path() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: confstr writes at most `buf.len()` bytes, NUL included.
    let n = unsafe { libc::confstr(libc::_CS_PATH, buf.as_mut_ptr().cast(), buf.len()) };
    if n == 0 || n > buf.len() {
        return "/usr/bin:/bin".into();
    }
    String::from_utf8_lossy(&buf[..n - 1]).into_owned()
}

/// `ENV_PATH` of a `login.defs(5)`, as shadow's and util-linux's `login(1)` read it (`PATH=`
/// before the list is optional).
pub fn parse_login_defs_path(text: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let mut f = l.split_whitespace();
        (f.next()? == "ENV_PATH").then(|| f.next())?.map(|v| v.strip_prefix("PATH=").unwrap_or(v).to_owned())
    })
}

/// The `PATH` `login(1)` gives a session, which the fill sets when the base has none (read once
/// at brain start).
pub fn login_path() -> String {
    platform::login_path()
}

/// What a `create` asked for that the environment depends on.
pub struct Request<'a> {
    pub id: &'a str,
    pub argv: Option<&'a [String]>,
    pub cwd: Option<&'a str>,
    pub env: Option<&'a BTreeMap<String, Option<String>>>,
    /// The caller's own environment (`create.env_base`); `None`: the creator has none.
    pub base: Option<&'a BTreeMap<String, String>>,
}

/// The daemon's settings for every terminal it starts.
#[derive(Clone, Debug)]
pub struct Settings {
    pub scrub: Vec<String>,
    /// `--shell`: replaces the passwd entry's shell for the whole namespace.
    pub shell: Option<String>,
    pub login_shell: bool,
    /// The `LANG` to fill when no locale is set: `None` when filling is off or the locale
    /// doesn't load (checked once at start).
    pub locale_fill: Option<String>,
    /// The `PATH` to fill when the base has none ([`login_path`]).
    pub login_path: String,
    pub term: String,
    pub socket: String,
    pub version: String,
    /// `--config`: the `termd.toml` to read instead of `$XDG_CONFIG_HOME/g3d/termd.toml`.
    pub config: Option<PathBuf>,
}

/// What to run, resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// The program to exec.
    pub path: String,
    /// Its argv as exec'd (`-bash` for a login shell).
    pub argv: Vec<String>,
    /// The argv the `create` reply and `list` show: the resolved path, then the arguments.
    pub shown: Vec<String>,
    pub login: bool,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    /// The same environment, each variable with its source (what `env` answers).
    pub tagged: Vec<EnvVar>,
}

fn bad(msg: impl Into<String>) -> WireError {
    WireError::new(code::BAD_REQUEST, msg)
}

/// Checks one value: no NUL, and `NAME=value` with its NUL within [`ENV_VALUE_MAX`].
fn check_value(what: &str, k: &str, v: &str) -> Result<(), WireError> {
    if v.contains('\0') {
        return Err(bad(format!("{what} {k} contains NUL")));
    }
    let n = k.len() + 1 + v.len() + 1;
    if n > ENV_VALUE_MAX {
        return Err(WireError::new(
            code::TOO_LARGE,
            format!("{what} {k} is {n} bytes as NAME=value and its NUL; the most is {ENV_VALUE_MAX}"),
        ));
    }
    Ok(())
}

/// Checks a request's `env` (PROTOCOL.md, `create`).
pub fn check_request_env(env: &BTreeMap<String, Option<String>>) -> Result<(), WireError> {
    for (k, v) in env {
        if !env_name_ok(k) {
            return Err(bad(format!("env name {k:?} must match [A-Za-z_][A-Za-z0-9_]*")));
        }
        if RESERVED.contains(&k.as_str()) {
            return Err(bad(format!("env {k} is termd's to set: it describes this terminal")));
        }
        if let Some(v) = v {
            check_value("env", k, v)?;
        }
    }
    Ok(())
}

/// Checks a request's `env_base`: `env`'s name and size rules. A reserved name may be there (a
/// caller's own `TERM`): layer 6 replaces it.
pub fn check_base_env(env: &BTreeMap<String, String>) -> Result<(), WireError> {
    for (k, v) in env {
        if !env_name_ok(k) {
            return Err(bad(format!("env_base name {k:?} must match [A-Za-z_][A-Za-z0-9_]*")));
        }
        check_value("env_base", k, v)?;
    }
    Ok(())
}

/// Checks `create.cwd`: absolute, an existing directory this user can search.
fn check_cwd(cwd: &str) -> Result<(), WireError> {
    let p = Path::new(cwd);
    if !p.is_absolute() {
        return Err(bad(format!("cwd {cwd:?} is not an absolute path")));
    }
    match std::fs::metadata(p) {
        Err(e) => return Err(bad(format!("cwd {cwd:?}: {e}"))),
        Ok(m) if !m.is_dir() => return Err(bad(format!("cwd {cwd:?} is not a directory"))),
        Ok(_) => {}
    }
    rustix::fs::access(p, rustix::fs::Access::EXEC_OK).map_err(|e| bad(format!("cwd {cwd:?}: {e}")))
}

/// The account's shell, which a terminal with no `argv` runs (unless the request names one) and
/// `SHELL` names, and where it came from: the `--shell` setting, else the passwd entry's when it
/// is an executable, else the base's `$SHELL` when it is an absolute path to one, else `/bin/sh`.
fn choose_shell(s: &Settings, account: &Account, env_shell: Option<&str>) -> (String, &'static str) {
    if let Some(sh) = &s.shell {
        return (sh.clone(), "setting");
    }
    if !account.shell.is_empty() && is_executable(Path::new(&account.shell)) {
        return (account.shell.clone(), "passwd");
    }
    if let Some(sh) = env_shell
        && sh.starts_with('/')
        && is_executable(Path::new(sh))
    {
        return (sh.to_owned(), "base");
    }
    ("/bin/sh".into(), "default")
}

/// The no-caller base (layer 1): each name `allowed` lets through, from the session source's
/// answer (`found`: its variables and its name), else the daemon's start value for that name.
pub fn session_base(
    allowed: &dyn Fn(&str) -> bool,
    found: Option<(&[(String, String)], &'static str)>,
    start: &[(String, String)],
) -> Env {
    let mut env = Env::new();
    if let Some((vars, via)) = found {
        for (k, v) in vars.iter().filter(|(k, _)| allowed(k)) {
            env.insert(k.clone(), Var::new(v, EnvSource::Session, Some(via)));
        }
    }
    for (k, v) in start.iter().filter(|(k, _)| allowed(k)) {
        env.entry(k.clone()).or_insert_with(|| Var::new(v, EnvSource::Session, Some("daemon")));
    }
    env
}

/// The names to ask a name-by-name session source (launchd) for: the exact names among
/// `patterns`, and for each prefix, the names of the daemon's start environment and of
/// [`PREFIX_NAMES`] it matches.
pub fn candidates(patterns: &[String], start_names: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in patterns {
        if p.ends_with('*') {
            out.extend(start_names.iter().chain(PREFIX_NAMES).filter(|n| matches(p, n)).map(|n| n.to_string()));
        } else {
            out.push(p.clone());
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Composes layers 2–6 on `base` (layer 1) with `file` (`termd.toml`) and resolves the program.
/// Pure but for reading the filesystem (the cwd, the shell, the `PATH` lookup).
pub fn compose(s: &Settings, base: Env, file: &FileEnv, account: &Account, req: &Request) -> Result<Plan, WireError> {
    let none = BTreeMap::new();
    let client = req.env.unwrap_or(&none);
    check_request_env(client)?;
    if let Some(a) = req.argv
        && a.is_empty()
    {
        return Err(bad("argv is empty"));
    }
    // The working directory: the request's, checked, else home (`/` when home is missing, as
    // login(1) does).
    let cwd = match req.cwd {
        Some(c) => {
            check_cwd(c)?;
            // PWD may not hold `.` or `..` (POSIX; a shell that finds them recomputes it): such a
            // path becomes the directory's real one. Any other keeps its spelling (a symlink's name).
            if c.split('/').any(|seg| seg == "." || seg == "..") {
                std::fs::canonicalize(c)
                    .map_err(|e| bad(format!("cwd {c:?}: {e}")))?
                    .to_str()
                    .ok_or_else(|| bad(format!("cwd {c:?} is not UTF-8 once resolved")))?
                    .to_owned()
            } else {
                c.to_owned()
            }
        }
        None if !account.home.is_empty() && Path::new(&account.home).is_dir() => account.home.clone(),
        None => "/".into(),
    };
    // 1–2: the base, scrubbed (what `pass` names stays).
    let mut env: Env = base.into_iter().filter(|(k, _)| !any_match(&s.scrub, k) || any_match(&file.pass, k)).collect();
    // 3: the fill, where the base has none (empty is none): the account from the user database,
    // as login(1) sets it, and login(1)'s PATH.
    let missing = |env: &Env, k: &str| env.get(k).is_none_or(|v| v.value.is_empty());
    for (k, v) in [("HOME", &account.home), ("USER", &account.name), ("LOGNAME", &account.name)] {
        if missing(&env, k) && !v.is_empty() {
            env.insert(k.into(), Var::new(v, EnvSource::Fill, Some("passwd")));
        }
    }
    if missing(&env, "PATH") {
        env.insert("PATH".into(), Var::new(&s.login_path, EnvSource::Fill, Some("login")));
    }
    // With no argv the program is a shell: the request's SHELL when it names one (it must be an
    // absolute path to an executable: SHELL names the shell that runs), else the account's.
    // SHELL names the account's shell whatever the base says, as login(1) sets it.
    let shell = match (req.argv, client.get("SHELL")) {
        (None, Some(Some(sh))) => {
            if !(sh.starts_with('/') && is_executable(Path::new(sh))) {
                return Err(bad(format!("env SHELL {sh:?} is not an absolute path to an executable")));
            }
            sh.clone()
        }
        _ => {
            let (sh, via) = choose_shell(s, account, env.get("SHELL").map(|v| v.value.as_str()));
            env.insert("SHELL".into(), Var::new(&sh, EnvSource::Fill, Some(via)));
            sh
        }
    };
    // The locale: filled only when none is set and neither the file nor the request names one.
    const LOCALE: [&str; 3] = ["LC_ALL", "LC_CTYPE", "LANG"];
    let named = LOCALE.iter().any(|k| client.contains_key(*k) || file.set.contains_key(*k));
    if let Some(lang) = &s.locale_fill
        && !named
        && LOCALE.iter().all(|k| missing(&env, k))
    {
        env.insert("LANG".into(), Var::new(lang, EnvSource::Fill, Some("locale")));
    }
    // 4: termd.toml's `set`, its ${VAR}s from the environment so far.
    let expanded: Vec<(String, String)> =
        file.set.iter().map(|(k, v)| (k.clone(), expand(v, |n| env.get(n).map(|v| v.value.as_str())))).collect();
    for (k, v) in expanded {
        check_value("termd.toml set", &k, &v)?;
        env.insert(k, Var::new(v, EnvSource::File, None));
    }
    // 5: the request's.
    for (k, v) in client {
        match v {
            Some(v) => env.insert(k.clone(), Var::new(v, EnvSource::Request, None)),
            None => env.remove(k),
        };
    }
    // 6: termd's own.
    let ver = s.version.rsplit('/').next().unwrap_or(&s.version).to_owned();
    for (k, v) in [
        ("TERM", s.term.clone()),
        ("COLORTERM", "truecolor".into()),
        ("TERM_PROGRAM", "g3d-termd".into()),
        ("TERM_PROGRAM_VERSION", ver),
        ("G3D_TERMD_ID", req.id.to_owned()),
        ("G3D_TERMD_SOCKET", s.socket.clone()),
        ("PWD", cwd.clone()),
    ] {
        env.insert(k.into(), Var::new(v, EnvSource::Termd, None));
    }
    // The program.
    let (path, argv, shown, login) = match req.argv {
        Some(a) => {
            let path = resolve(&a[0], env.get("PATH").map(|v| v.value.as_str()))?;
            let shown = std::iter::once(path.clone()).chain(a[1..].iter().cloned()).collect();
            (path, a.to_vec(), shown, false)
        }
        None => {
            let name = Path::new(&shell).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let argv0 = if s.login_shell { format!("-{name}") } else { shell.clone() };
            (shell.clone(), vec![argv0], vec![shell.clone()], s.login_shell)
        }
    };
    let ptr = std::mem::size_of::<usize>();
    let total: usize = argv.iter().map(|a| a.len() + 1 + ptr).sum::<usize>()
        + env.iter().map(|(k, v)| k.len() + v.value.len() + 2 + ptr).sum::<usize>()
        + 2 * ptr;
    if total > EXEC_MAX {
        return Err(WireError::new(
            code::TOO_LARGE,
            format!("argv and environment are {total} bytes; the most is {EXEC_MAX}"),
        ));
    }
    let tagged = env
        .iter()
        .map(|(k, v)| EnvVar {
            name: k.clone(),
            value: v.value.clone(),
            source: v.source,
            via: v.via.map(str::to_owned),
        })
        .collect();
    let env = env.into_iter().map(|(k, v)| (k, v.value)).collect();
    Ok(Plan { path, argv, shown, login, cwd, env, tagged })
}

/// `argv[0]` to a path: as given when it has a slash, else looked up in the program's own `PATH`
/// (execvp's semantics, with its default when `PATH` is unset).
fn resolve(prog: &str, path: Option<&str>) -> Result<String, WireError> {
    if prog.contains('/') {
        return Ok(prog.to_owned());
    }
    let search = path.map(str::to_owned).unwrap_or_else(default_path);
    search
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(prog))
        .find(|p| is_executable(p))
        .map(|p| p.display().to_string())
        .ok_or_else(|| WireError::new(code::SPAWN_FAILED, format!("{prog}: not found in PATH {search:?}")))
}

/// `${NAME}` in `value`, each replaced by `get(NAME)` (empty when unset, as environment.d(5)
/// does); any other `$` is literal. [`parse_config`] has checked the syntax.
fn expand<'a>(value: &str, get: impl Fn(&str) -> Option<&'a str>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match after.find('}') {
            Some(j) => {
                out.push_str(get(&after[..j]).unwrap_or(""));
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// `termd.toml`'s `[env]`: `pass` and `drop` adjust the no-caller allowlist ([`SESSION`]),
/// `pass` also exempting from the scrub; `set` sets names for every terminal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileEnv {
    pub pass: Vec<String>,
    pub drop: Vec<String>,
    pub set: BTreeMap<String, String>,
}

impl FileEnv {
    /// Whether a no-caller base takes `name` from the session.
    pub fn allowed(&self, name: &str) -> bool {
        (any_match(SESSION, name) || any_match(&self.pass, name)) && !any_match(&self.drop, name)
    }

    /// The allowlist's patterns: [`SESSION`] and `pass`, less the `drop` names that remove one
    /// whole (a prefix `drop` still filters per name, in [`FileEnv::allowed`]).
    pub fn patterns(&self) -> Vec<String> {
        SESSION
            .iter()
            .map(|s| s.to_string())
            .chain(self.pass.iter().cloned())
            .filter(|p| !self.drop.contains(p))
            .collect()
    }

    /// One line for the log.
    pub fn describe(&self) -> String {
        if *self == FileEnv::default() {
            return "sets nothing".into();
        }
        let list = |v: &[String]| if v.is_empty() { "none".to_owned() } else { v.join(" ") };
        let set: Vec<String> = self.set.keys().cloned().collect();
        format!("pass {}; drop {}; set {}", list(&self.pass), list(&self.drop), list(&set))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    #[serde(default)]
    env: RawEnv,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEnv {
    #[serde(default)]
    pass: Vec<toml::Spanned<String>>,
    #[serde(default)]
    drop: Vec<toml::Spanned<String>>,
    #[serde(default)]
    set: BTreeMap<toml::Spanned<String>, toml::Spanned<String>>,
}

/// The line a byte offset of `text` is on, from 1.
fn line_of(text: &str, at: usize) -> usize {
    text[..at.min(text.len())].bytes().filter(|&b| b == b'\n').count() + 1
}

/// Parses `termd.toml`. An error names its line.
pub fn parse_config(text: &str) -> Result<FileEnv, String> {
    let raw: RawFile = toml::from_str(text).map_err(|e| match e.span() {
        Some(sp) => format!("line {}: {}", line_of(text, sp.start), e.message().trim()),
        None => e.message().trim().to_owned(),
    })?;
    let at = |sp: std::ops::Range<usize>, msg: String| format!("line {}: {msg}", line_of(text, sp.start));
    let pattern = |p: &toml::Spanned<String>, key: &str| {
        let v = p.get_ref();
        let name = v.strip_suffix('*').unwrap_or(v);
        if name.is_empty() {
            return Err(at(
                p.span(),
                format!(
                    "{key} {v:?}: a pattern is a NAME or a PREFIX* with a prefix (\"*\" alone would make the daemon's start environment the base)"
                ),
            ));
        }
        if !env_name_ok(name) {
            return Err(at(p.span(), format!("{key} {v:?}: a pattern is NAME or PREFIX*, of [A-Za-z_][A-Za-z0-9_]*")));
        }
        Ok(v.clone())
    };
    let pass = raw.env.pass.iter().map(|p| pattern(p, "pass")).collect::<Result<Vec<_>, _>>()?;
    let drop = raw.env.drop.iter().map(|p| pattern(p, "drop")).collect::<Result<Vec<_>, _>>()?;
    let mut set = BTreeMap::new();
    for (k, v) in &raw.env.set {
        let (name, value) = (k.get_ref(), v.get_ref());
        if !env_name_ok(name) {
            return Err(at(k.span(), format!("set {name:?}: a name is [A-Za-z_][A-Za-z0-9_]*")));
        }
        if RESERVED.contains(&name.as_str()) {
            return Err(at(k.span(), format!("set {name}: termd's to set, it describes the terminal")));
        }
        if let Err(e) = check_value("set", name, value) {
            return Err(at(v.span(), e.message));
        }
        let mut rest = value.as_str();
        while let Some(i) = rest.find("${") {
            let after = &rest[i + 2..];
            let Some(j) = after.find('}') else {
                return Err(at(v.span(), format!("set {name}: \"${{\" without its \"}}\"")));
            };
            if !env_name_ok(&after[..j]) {
                return Err(at(v.span(), format!("set {name}: ${{{}}} is not ${{NAME}}", &after[..j])));
            }
            rest = &after[j + 1..];
        }
        set.insert(name.clone(), value.clone());
    }
    Ok(FileEnv { pass, drop, set })
}

/// `termd.toml`'s path when `--config` names none: `$XDG_CONFIG_HOME/g3d/termd.toml` (the
/// session's `XDG_CONFIG_HOME`, when absolute, as the XDG base directory spec says), else
/// `<home>/.config/g3d/termd.toml` with the home from passwd: never the starter's environment.
pub fn default_config_path(xdg_config_home: Option<&str>, home: &str) -> PathBuf {
    let base = match xdg_config_home.filter(|d| d.starts_with('/')) {
        Some(d) => PathBuf::from(d),
        None => Path::new(home).join(".config"),
    };
    base.join("g3d").join("termd.toml")
}

/// How the file was when last read: re-read when this changes.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    mtime: Option<std::time::SystemTime>,
    len: u64,
    ino: u64,
}

/// The file's last reading: its stamp (`None`: absent) and what it said.
struct Loaded {
    stamp: Option<Stamp>,
    result: Result<FileEnv, String>,
}

/// Parsing and policy warnings that come and go: the session source's, the last terminal's
/// locale (its id and the problem), the config file's.
#[derive(Default)]
struct LiveWarnings {
    source: Option<String>,
    locale: Option<(String, String)>,
    config: Option<String>,
}

/// The session source, the settings, the config file and the daemon's start values.
pub struct Policy {
    pub source: SessionSource,
    pub settings: Settings,
    /// The environment this brain started with: the holder's (its starter's). Never a base: a
    /// no-caller base takes an allowlisted name from it only when the session source lacks it.
    start_env: Vec<(String, String)>,
    pub manager_timeout: Duration,
    /// Test hook: the user manager's answer comes from this file (the busctl JSON), re-read per
    /// `create`, instead of from busctl.
    #[cfg(feature = "test-hooks")]
    pub manager_file: Option<PathBuf>,
    config_path: OnceLock<PathBuf>,
    config: Mutex<Option<Loaded>>,
    /// What the last no-caller base used, logged when it changes.
    last: Mutex<String>,
    /// The status document's `env`.
    shown: Mutex<g3d_wire::StatusEnv>,
    fixed_warnings: Vec<String>,
    live_warnings: Mutex<LiveWarnings>,
}

impl Policy {
    /// `warnings`: what is wrong for every terminal from the start (no UTF-8 locale loads).
    pub fn new(source: SessionSource, settings: Settings, manager_timeout: Duration, warnings: Vec<String>) -> Self {
        let first = match source {
            SessionSource::Daemon => "daemon",
            // Until the first base is read (probe): what this platform would use.
            SessionSource::Auto => platform::SOURCE.unwrap_or("daemon"),
        };
        Policy {
            shown: Mutex::new(g3d_wire::StatusEnv {
                source: first.into(),
                config: StatusEnvConfig { path: String::new(), state: "absent".into(), error: None },
                warnings: warnings.clone(),
            }),
            fixed_warnings: warnings,
            source,
            settings,
            start_env: std::env::vars_os()
                .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
                .collect(),
            manager_timeout,
            #[cfg(feature = "test-hooks")]
            manager_file: std::env::var_os("G3D_TERMD_TEST_SESSION_ENV_FILE")
                .filter(|_| crate::test_hooks_armed())
                .map(Into::into),
            config_path: OnceLock::new(),
            config: Mutex::new(None),
            last: Mutex::new(String::new()),
            live_warnings: Mutex::new(LiveWarnings::default()),
        }
    }

    /// Recomputes the status document's warnings after one of the live ones changed.
    fn show_warnings(&self, live: &LiveWarnings) {
        let locale = live.locale.as_ref().map(|(id, p)| format!("terminal {id}: {p}"));
        let mut shown = self.shown.lock().unwrap();
        shown.warnings = self
            .fixed_warnings
            .iter()
            .cloned()
            .chain(live.source.iter().cloned())
            .chain(live.config.iter().cloned())
            .chain(locale)
            .collect();
    }

    /// The status document's `env` as it stands.
    pub fn status(&self) -> g3d_wire::StatusEnv {
        self.shown.lock().unwrap().clone()
    }

    /// The session source's variables: the user manager's whole environment (Linux), or launchd's
    /// answer for `names` (macOS), and the source's name.
    fn source_env(&self, names: &[String]) -> Result<SourceAnswer, String> {
        #[cfg(feature = "test-hooks")]
        if let Some(f) = &self.manager_file {
            let s = std::fs::read_to_string(f).map_err(|e| format!("{}: {e}", f.display()))?;
            return Ok((parse_manager_env(&s)?, "systemd-user"));
        }
        platform::session_env(names, &self.start_env, self.manager_timeout)
    }

    /// `termd.toml`'s path, resolved once: `--config`, else the default from the session's
    /// `XDG_CONFIG_HOME` (never the daemon's start value) and passwd's home.
    fn config_path(&self) -> &Path {
        self.config_path.get_or_init(|| {
            if let Some(p) = &self.settings.config {
                return p.clone();
            }
            let xdg = match self.source {
                SessionSource::Daemon => None,
                SessionSource::Auto => self
                    .source_env(&["XDG_CONFIG_HOME".to_owned()])
                    .ok()
                    .and_then(|(v, _)| v.into_iter().find(|(k, _)| k == "XDG_CONFIG_HOME").map(|(_, v)| v)),
            };
            let home = account().map(|a| a.home).unwrap_or_default();
            default_config_path(xdg.as_deref(), &home)
        })
    }

    /// The config file as it is now: re-read when its stamp changed since the last read, said in
    /// the log and the status document when it does. Blocking.
    fn file(&self) -> Result<FileEnv, String> {
        let path = self.config_path().to_owned();
        let mut cur = self.config.lock().unwrap();
        let stamp = match std::fs::metadata(&path) {
            Ok(m) => {
                use std::os::unix::fs::MetadataExt;
                Ok(Some(Stamp { mtime: m.modified().ok(), len: m.len(), ino: m.ino() }))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{e}")),
        };
        let fresh = match (&stamp, cur.as_ref()) {
            (Ok(s), Some(l)) => l.stamp != *s,
            _ => true,
        };
        if fresh {
            let (stamp, result) = match stamp {
                Ok(None) => (None, Ok(FileEnv::default())),
                Ok(Some(s)) => {
                    (Some(s), std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| parse_config(&t)))
                }
                Err(e) => (None, Err(e)),
            };
            let shown = path.display();
            let note = match (&stamp, &result) {
                (None, Ok(_)) => format!("termd.toml: none at {shown}"),
                (_, Ok(f)) => format!("termd.toml {shown}: {}", f.describe()),
                (_, Err(e)) => format!("termd.toml {shown}: {e}: every create fails until it is fixed"),
            };
            crate::log(&note);
            {
                let mut st = self.shown.lock().unwrap();
                st.config = StatusEnvConfig {
                    path: shown.to_string(),
                    state: match (&stamp, &result) {
                        (_, Err(_)) => "error",
                        (None, _) => "absent",
                        (Some(_), Ok(_)) => "loaded",
                    }
                    .into(),
                    error: result.as_ref().err().cloned(),
                };
            }
            let mut live = self.live_warnings.lock().unwrap();
            live.config = result.as_ref().err().map(|e| format!("termd.toml {shown}: {e}"));
            self.show_warnings(&live);
            *cur = Some(Loaded { stamp, result });
        }
        cur.as_ref().unwrap().result.clone()
    }

    /// Reads the config file and the session source once without starting anything, so the log
    /// and the status document say the policy before the first terminal. Blocking.
    pub fn probe(&self) {
        let file = self.file().unwrap_or_default();
        let _ = self.session_base(&file);
        crate::log(&format!(
            "terminal environment: a caller's own when it sends one; else {}, each from {} at every create (a name it lacks: the daemon's start value); --env-scrub {}",
            file.patterns().join(" "),
            match self.source {
                SessionSource::Daemon => "the daemon's start values (--env-source daemon)",
                SessionSource::Auto => platform::SOURCE_NAME,
            },
            if self.settings.scrub.len() > SCRUB.len() {
                self.settings.scrub[SCRUB.len()..].join(" ")
            } else {
                "adds nothing".into()
            },
        ));
    }

    /// The no-caller base, read now. Blocking (it may ask the session source).
    fn session_base(&self, file: &FileEnv) -> Env {
        let start_names: Vec<&str> = self.start_env.iter().map(|(k, _)| k.as_str()).collect();
        let mut warning = None;
        let found = match self.source {
            SessionSource::Daemon => Err("--env-source daemon".to_owned()),
            SessionSource::Auto => self.source_env(&candidates(&file.patterns(), &start_names)),
        };
        let (note, source) = match &found {
            Ok((_, via)) => (format!("the session's from {}", platform::SOURCE_NAME), *via),
            Err(why) => {
                if self.source == SessionSource::Auto && platform::SOURCE.is_some() {
                    warning = Some(format!(
                        "{} is unreachable ({why}): terminals with no caller's environment take the daemon's start values",
                        platform::SOURCE_NAME
                    ));
                }
                (format!("the daemon's start values: {why}"), "daemon")
            }
        };
        self.shown.lock().unwrap().source = source.into();
        {
            let mut live = self.live_warnings.lock().unwrap();
            live.source = warning;
            self.show_warnings(&live);
        }
        {
            let mut last = self.last.lock().unwrap();
            if *last != note {
                crate::log(&format!("terminal environment: {note}"));
                *last = note;
            }
        }
        let found = found.ok();
        session_base(&|k| file.allowed(k), found.as_ref().map(|(v, via)| (v.as_slice(), *via)), &self.start_env)
    }

    /// A whole plan for one `create`: the file, the base and the account read now.
    pub fn plan(&self, req: &Request) -> Result<Plan, WireError> {
        let account = account().map_err(|e| WireError::new(code::SPAWN_FAILED, format!("the account: {e}")))?;
        let file = self.file().map_err(|e| {
            WireError::new(code::SPAWN_FAILED, format!("termd.toml {}: {e}", self.config_path().display()))
        })?;
        let base = match req.base {
            Some(b) => b.iter().map(|(k, v)| (k.clone(), Var::new(v, EnvSource::Caller, None))).collect(),
            None => self.session_base(&file),
        };
        let plan = compose(&self.settings, base, &file, &account, req)?;
        // A locale that is set is the person's and is never changed; one that doesn't give UTF-8
        // is said (DESIGN.md, "Locale"): in the log when it changes, and in the status document.
        let problem = locale_problem(&plan.env);
        let mut live = self.live_warnings.lock().unwrap();
        if let Some(p) = &problem
            && live.locale.as_ref().is_none_or(|(_, was)| was != p)
        {
            crate::log(&format!("terminal {}: {p}", req.id));
        }
        live.locale = problem.map(|p| (req.id.to_owned(), p));
        self.show_warnings(&live);
        Ok(plan)
    }
}

/// Parses the user manager's `Environment` property as `busctl --json=short` prints it:
/// `{"type":"as","data":["K=V",…]}`.
pub fn parse_manager_env(json: &str) -> Result<Vec<(String, String)>, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("not JSON: {e}"))?;
    if v.get("type").and_then(|t| t.as_str()) != Some("as") {
        return Err(format!("not a string array: {}", v.get("type").unwrap_or(&serde_json::Value::Null)));
    }
    let data = v.get("data").and_then(|d| d.as_array()).ok_or("no data")?;
    data.iter()
        .map(|e| {
            let s = e.as_str().ok_or("a non-string entry")?;
            let (k, v) = s.split_once('=').ok_or_else(|| format!("entry {s:?} has no '='"))?;
            Ok((k.to_owned(), v.to_owned()))
        })
        .collect()
}

/// launchd as the session source (macOS). Built on Linux only for its tests: the lookup itself
/// runs only on a Mac.
#[cfg(any(target_os = "macos", test))]
mod launchd {
    /// The script that asks launchd for each name given as an argument (`launchctl getenv`), printing
    /// `NAME=value` and a NUL for each it has a non-empty value for: one process per `create`, not
    /// one per name.
    pub const SCRIPT: &str =
        r#"for n do v=$(/bin/launchctl getenv "$n") && [ -n "$v" ] && printf '%s=%s\0' "$n" "$v"; done; exit 0"#;

    /// Parses [`SCRIPT`]'s output. A record without `=` or a name outside the ones asked is
    /// an error (the script didn't run as written).
    pub fn parse(out: &[u8], asked: &[String]) -> Result<Vec<(String, String)>, String> {
        out.split(|&b| b == 0)
            .filter(|r| !r.is_empty())
            .map(|r| {
                let s = std::str::from_utf8(r).map_err(|_| "a value that is not UTF-8".to_owned())?;
                let (k, v) = s.split_once('=').ok_or_else(|| format!("record {s:?} has no '='"))?;
                if !asked.iter().any(|a| a == k) {
                    return Err(format!("launchctl answered {k:?}, which was not asked"));
                }
                Ok((k.to_owned(), v.to_owned()))
            })
            .collect()
    }
}

/// Runs `cmd` to its end within `timeout` (killed past it), returning its stdout.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_bounded(mut cmd: std::process::Command, what: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Instant;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("{what}: {e}"))?;
    // Read as it runs, so a big answer can't fill the pipe and stall the child.
    let mut stdout = child.stdout.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let until = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{what} did not answer within {timeout:?}"));
            }
            Err(e) => return Err(format!("{what}: {e}")),
        }
    };
    let out = reader.join().unwrap_or_default();
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    if !status.success() {
        return Err(format!("{what}: {status}: {}", err.trim()));
    }
    Ok(out)
}

/// What is wrong with the locale a program starts with, if anything: the `LC_CTYPE` it gets
/// (`LC_ALL`, else `LC_CTYPE`, else `LANG`) doesn't load, or isn't UTF-8. `None` when it is fine
/// or no locale is set (the fill's own check covers that).
pub fn locale_problem(env: &[(String, String)]) -> Option<String> {
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty());
    let (var, name) = ["LC_ALL", "LC_CTYPE", "LANG"].into_iter().find_map(|k| Some((k, get(k)?)))?;
    let Ok(c) = std::ffi::CString::new(name) else { return Some(format!("{var}={name:?} is not a locale name")) };
    // SAFETY: newlocale with a NUL-terminated name and no base; the locale is used on this thread
    // only between the two uselocale calls, then freed.
    unsafe {
        let l = libc::newlocale(libc::LC_CTYPE_MASK, c.as_ptr(), std::ptr::null_mut());
        if l.is_null() {
            return Some(format!(
                "{var}={name} does not load here (not installed?): its programs run in the C locale, ASCII only"
            ));
        }
        let old = libc::uselocale(l);
        let p = libc::nl_langinfo(libc::CODESET);
        let set = if p.is_null() { String::new() } else { std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned() };
        libc::uselocale(old);
        libc::freelocale(l);
        let utf8 = set.eq_ignore_ascii_case("UTF-8") || set.eq_ignore_ascii_case("utf8");
        (!utf8).then(|| format!("{var}={name} is not UTF-8 (its charset is {set}): non-ASCII text shows wrong"))
    }
}

/// The locale to fill when none is set, if it loads here (`newlocale`); else `None`, said once.
pub fn locale_fill(enabled: bool) -> Option<String> {
    if !enabled {
        return None;
    }
    let want = platform::default_locale();
    let loads = |name: &str| {
        let Ok(c) = std::ffi::CString::new(name) else { return false };
        // SAFETY: newlocale with a NUL-terminated name and no base; freed at once.
        let l = unsafe { libc::newlocale(libc::LC_CTYPE_MASK, c.as_ptr(), std::ptr::null_mut()) };
        if l.is_null() {
            return false;
        }
        unsafe { libc::freelocale(l) };
        true
    };
    if loads(&want) {
        return Some(want);
    }
    if want != "C.UTF-8" && loads("C.UTF-8") {
        crate::log(&format!("locale {want} does not load here; terminals with no locale get C.UTF-8"));
        return Some("C.UTF-8".into());
    }
    crate::log(&format!("locale {want} does not load here; terminals with no locale get none"));
    None
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    /// The session source's name in the status document, and in words.
    pub const SOURCE: Option<&str> = Some("systemd-user");
    pub const SOURCE_NAME: &str = "the systemd user manager";

    /// Linux: `C.UTF-8` (built into glibc since 2.35, and into musl).
    pub fn default_locale() -> String {
        "C.UTF-8".into()
    }

    /// `/etc/login.defs`' `ENV_PATH`, else util-linux `login(1)`'s own default.
    pub fn login_path() -> String {
        std::fs::read_to_string("/etc/login.defs")
            .ok()
            .and_then(|t| super::parse_login_defs_path(&t))
            .unwrap_or_else(|| "/usr/local/bin:/bin:/usr/bin".into())
    }

    /// The systemd user manager's whole environment, through `busctl`, systemd's own client (no
    /// D-Bus library linked); `names` is for a name-by-name source and unused here. A daemon
    /// started with a stripped environment has no bus address; then the bus is found where
    /// pam_systemd puts it, `/run/user/<uid>`, when that is ours.
    pub fn session_env(
        _names: &[String],
        start: &[(String, String)],
        timeout: Duration,
    ) -> Result<super::SourceAnswer, String> {
        let get = |k: &str| start.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty());
        let busctl = get("PATH")
            .unwrap_or("")
            .split(':')
            .chain(["/usr/bin", "/bin"])
            .filter(|d| !d.is_empty())
            .map(|d| Path::new(d).join("busctl"))
            .find(|p| p.is_file())
            .ok_or("no busctl (no systemd user manager here)")?;
        let mut cmd = Command::new(&busctl);
        cmd.args([
            "--user",
            "--json=short",
            "get-property",
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            "Environment",
        ]);
        // The user bus is where pam_systemd puts it for this uid, `/run/user/<uid>/bus`, whatever
        // the starter said: a starter's DBUS_SESSION_BUS_ADDRESS can name a bus from an earlier
        // login, and a stripped starter has none. Only without that directory is the starter's
        // address (or XDG_RUNTIME_DIR) all there is.
        match g3d::paths::user_runtime_dir() {
            Some(dir) => {
                cmd.env_remove("DBUS_SESSION_BUS_ADDRESS").env("XDG_RUNTIME_DIR", dir);
            }
            None if get("DBUS_SESSION_BUS_ADDRESS").is_none() && get("XDG_RUNTIME_DIR").is_none() => {
                return Err(format!(
                    "no bus address and no /run/user/{} of this user's",
                    rustix::process::getuid().as_raw()
                ));
            }
            None => {}
        }
        let out = super::run_bounded(cmd, &busctl.display().to_string(), timeout)
            .map_err(|e| e.replace("did not answer", "(the user manager) did not answer"))?;
        let out = String::from_utf8(out).map_err(|_| "busctl printed something that is not UTF-8".to_owned())?;
        Ok((super::parse_manager_env(&out)?, "systemd-user"))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::Command;
    use std::time::Duration;

    pub const SOURCE: Option<&str> = Some("launchd");
    pub const SOURCE_NAME: &str = "launchd (launchctl getenv)";

    /// macOS: the user's own locale (the `AppleLocale` preference, as Terminal.app, iTerm2 and
    /// Ghostty read it) as `<language>_<region>.UTF-8`; `C.UTF-8` when it has no region. The
    /// caller checks that it loads. Unverified here: the macOS branch proves it.
    pub fn default_locale() -> String {
        if let Ok(out) = Command::new("/usr/bin/defaults").args(["read", "-g", "AppleLocale"]).output()
            && out.status.success()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            let tag = s.trim().split('@').next().unwrap_or("");
            if tag.contains('_') && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return format!("{tag}.UTF-8");
            }
        }
        "C.UTF-8".into()
    }

    /// macOS `login(1)`'s `PATH` (`_PATH_DEFPATH`); `/etc/zprofile`'s `path_helper` builds the
    /// rest in the login shell.
    pub fn login_path() -> String {
        "/usr/bin:/bin".into()
    }

    /// launchd's value for each of `names` (`launchctl getenv`, one `sh` for all of them), as the
    /// GUI session holds them now. Unverified here: written on Linux, the parser unit-tested; the
    /// macOS branch proves the lookup.
    pub fn session_env(
        names: &[String],
        _start: &[(String, String)],
        timeout: Duration,
    ) -> Result<super::SourceAnswer, String> {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(super::launchd::SCRIPT).arg("sh").args(names);
        let out = super::run_bounded(cmd, "launchctl getenv", timeout)?;
        Ok((super::launchd::parse(&out, names)?, "launchd"))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use std::time::Duration;

    pub const SOURCE: Option<&str> = None;
    pub const SOURCE_NAME: &str = "no session source on this platform";

    pub fn default_locale() -> String {
        "C.UTF-8".into()
    }

    pub fn login_path() -> String {
        super::default_path()
    }

    pub fn session_env(_: &[String], _: &[(String, String)], _: Duration) -> Result<super::SourceAnswer, String> {
        Err("no session source on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings {
            scrub: SCRUB.iter().map(|s| s.to_string()).collect(),
            shell: None,
            login_shell: true,
            locale_fill: Some("C.UTF-8".into()),
            login_path: "/usr/local/bin:/usr/bin:/bin".into(),
            term: "xterm-256color".into(),
            socket: "/run/test/termd-x.sock".into(),
            version: "g3d-termd/9.9.9".into(),
            config: None,
        }
    }

    fn account() -> Account {
        Account { name: "alice".into(), home: "/".into(), shell: "/bin/sh".into() }
    }

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// A caller's environment as a base.
    fn caller(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| (k.to_string(), Var::new(*v, EnvSource::Caller, None))).collect()
    }

    fn req<'a>(argv: Option<&'a [String]>, env: Option<&'a BTreeMap<String, Option<String>>>) -> Request<'a> {
        Request { id: "t1", argv, cwd: None, env, base: None }
    }

    fn get<'a>(p: &'a Plan, k: &str) -> Option<&'a str> {
        p.env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    fn tag(p: &Plan, k: &str) -> Option<(EnvSource, Option<String>)> {
        p.tagged.iter().find(|v| v.name == k).map(|v| (v.source, v.via.clone()))
    }

    fn compose0(base: Env, r: &Request) -> Result<Plan, WireError> {
        compose(&settings(), base, &FileEnv::default(), &account(), r)
    }

    fn sleep() -> Vec<String> {
        vec!["true".into()]
    }

    #[test]
    fn scrub_removes_what_points_back_at_the_creator_and_keeps_the_rest() {
        let base = caller(&[
            ("TMUX", "/tmp/tmux-1/default,1,0"),
            ("TERM_PROGRAM", "Apple_Terminal"),
            ("TERM_PROGRAM_VERSION", "455"),
            ("TERM_SESSION_ID", "w0t0p0"),
            ("REX_SESSION", "rex-1"),
            ("REX_BLOCK", "7"),
            ("VSCODE_IPC_HOOK_CLI", "/run/vscode.sock"),
            ("KITTY_WINDOW_ID", "3"),
            ("ZELLIJ", "0"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "secret"),
            ("CLAUDE_PID", "42"),
            ("AI_AGENT", "claude-code"),
            ("ATUIN_SESSION", "0190"),
            ("MEMORY_PRESSURE_WATCH", "/sys/fs/cgroup/x/memory.pressure"),
            ("MANAGERPIDFDID", "7"),
            ("SHLVL", "3"),
            ("PWD", "/somewhere"),
            ("OLDPWD", "/else"),
            ("COLUMNS", "10"),
            ("LINES", "5"),
            ("INVOCATION_ID", "abc"),
            ("LISTEN_FDS", "1"),
            ("SSH_TTY", "/dev/pts/3"),
            ("__CFBundleIdentifier", "com.apple.Terminal"),
            ("G3D_TERMD_DIR", "/scratch"),
            ("G3D_TERMD_TEST_HOOKS", "1"),
            ("LC_TERMINAL", "iTerm2"),
            ("TERMINFO", "/opt/kitty/terminfo"),
            ("TERMINFO_DIRS", "/usr/share/terminfo"),
            ("PATH", "/usr/bin:/bin"),
            ("DISPLAY", ":0"),
            ("SSH_AUTH_SOCK", "/run/agent"),
            ("FOO", "custom"),
            ("TERMUX", "not a prefix match of TERM"),
        ]);
        let t = sleep();
        let p = compose0(base, &req(Some(&t), None)).unwrap();
        for gone in [
            "TMUX",
            "TERM_SESSION_ID",
            "REX_SESSION",
            "REX_BLOCK",
            "VSCODE_IPC_HOOK_CLI",
            "KITTY_WINDOW_ID",
            "ZELLIJ",
            "CLAUDECODE",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_PID",
            "AI_AGENT",
            "ATUIN_SESSION",
            "MEMORY_PRESSURE_WATCH",
            "MANAGERPIDFDID",
            "SHLVL",
            "OLDPWD",
            "COLUMNS",
            "LINES",
            "INVOCATION_ID",
            "LISTEN_FDS",
            "SSH_TTY",
            "__CFBundleIdentifier",
            "G3D_TERMD_DIR",
            "G3D_TERMD_TEST_HOOKS",
            "LC_TERMINAL",
            "TERMINFO",
        ] {
            assert_eq!(get(&p, gone), None, "{gone} should be scrubbed");
        }
        for (k, v) in [
            ("PATH", "/usr/bin:/bin"),
            ("DISPLAY", ":0"),
            ("SSH_AUTH_SOCK", "/run/agent"),
            ("TERMINFO_DIRS", "/usr/share/terminfo"),
            ("FOO", "custom"),
            ("TERMUX", "not a prefix match of TERM"),
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
            ("TERM_PROGRAM", "g3d-termd"),
            ("TERM_PROGRAM_VERSION", "9.9.9"),
            ("G3D_TERMD_ID", "t1"),
            ("G3D_TERMD_SOCKET", "/run/test/termd-x.sock"),
            ("PWD", "/"),
        ] {
            assert_eq!(get(&p, k), Some(v), "{k}");
        }
    }

    #[test]
    fn pass_exempts_from_the_scrub_and_an_extra_scrub_removes() {
        let mut s = settings();
        s.scrub.push("MY_*".into());
        let file = FileEnv { pass: vec!["TMUX".into()], ..Default::default() };
        let base = caller(&[("TMUX", "x"), ("MY_THING", "y"), ("MYOTHER", "z")]);
        let t = sleep();
        let p = compose(&s, base, &file, &account(), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "TMUX"), Some("x"));
        assert_eq!(get(&p, "MY_THING"), None);
        assert_eq!(get(&p, "MYOTHER"), Some("z"));
    }

    #[test]
    fn the_fill_sets_only_what_the_base_lacks_and_says_so() {
        let t = sleep();
        // A caller's own account variables are its subshell's (as tmux and screen keep them).
        let p = compose0(
            caller(&[("USER", "bob"), ("HOME", "/scratch/home"), ("PATH", "/opt/bin:/usr/bin:/bin")]),
            &req(Some(&t), None),
        )
        .unwrap();
        assert_eq!(
            (get(&p, "USER"), get(&p, "HOME"), get(&p, "PATH")),
            (Some("bob"), Some("/scratch/home"), Some("/opt/bin:/usr/bin:/bin"))
        );
        assert_eq!(tag(&p, "USER"), Some((EnvSource::Caller, None)));
        // What it lacks (or has empty) comes from passwd, and login(1)'s PATH.
        assert_eq!(get(&p, "LOGNAME"), Some("alice"));
        assert_eq!(tag(&p, "LOGNAME"), Some((EnvSource::Fill, Some("passwd".into()))));
        let p = compose0(caller(&[("HOME", "")]), &req(Some(&t), None)).unwrap();
        assert_eq!((get(&p, "HOME"), get(&p, "USER")), (Some("/"), Some("alice")));
        assert_eq!(get(&p, "PATH"), Some("/usr/local/bin:/usr/bin:/bin"));
        assert_eq!(tag(&p, "PATH"), Some((EnvSource::Fill, Some("login".into()))));
        assert_eq!(tag(&p, "SHELL"), Some((EnvSource::Fill, Some("passwd".into()))));
        assert_eq!(tag(&p, "LANG"), Some((EnvSource::Fill, Some("locale".into()))));
        assert_eq!(tag(&p, "TERM"), Some((EnvSource::Termd, None)));
        // A request that names one meant it.
        let env = BTreeMap::from([("HOME".to_string(), Some("/tmp".to_string()))]);
        let p = compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap();
        assert_eq!(get(&p, "HOME"), Some("/tmp"));
        assert_eq!(tag(&p, "HOME"), Some((EnvSource::Request, None)));
    }

    #[test]
    fn layers_win_in_order_and_each_variable_is_tagged() {
        let file = FileEnv {
            set: BTreeMap::from([
                ("FOO".to_string(), "file".to_string()),
                ("BAR".to_string(), "file".to_string()),
                ("GOPATH".to_string(), "${HOME}/go:${NOPE}:$HOME".to_string()),
            ]),
            ..Default::default()
        };
        let base = caller(&[("FOO", "caller"), ("BAR", "caller"), ("BAZ", "caller"), ("HOME", "/h")]);
        let env = BTreeMap::from([("BAR".to_string(), Some("request".to_string())), ("BAZ".to_string(), None)]);
        let t = sleep();
        let p = compose(&settings(), base, &file, &account(), &req(Some(&t), Some(&env))).unwrap();
        assert_eq!(get(&p, "FOO"), Some("file"));
        assert_eq!(tag(&p, "FOO"), Some((EnvSource::File, None)));
        assert_eq!(get(&p, "BAR"), Some("request"));
        assert_eq!(tag(&p, "BAR"), Some((EnvSource::Request, None)));
        assert_eq!(get(&p, "BAZ"), None, "a null removes");
        // ${VAR} only, from the environment before the file; unset is empty; a bare $ is literal.
        assert_eq!(get(&p, "GOPATH"), Some("/h/go::$HOME"));
        assert_eq!(tag(&p, "HOME"), Some((EnvSource::Caller, None)));
        // Every variable has a tag, and env and tagged agree.
        assert_eq!(p.tagged.len(), p.env.len());
        assert!(p.tagged.iter().zip(&p.env).all(|(t, (k, v))| &t.name == k && &t.value == v));
    }

    #[test]
    fn a_no_caller_base_is_the_allowlist_from_the_source_else_the_daemons_start_value_per_name() {
        let source = kv(&[
            ("DISPLAY", ":0"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("XDG_RUNTIME_DIR", "/run/user/1"),
            ("XDG_SESSION_TYPE", "wayland"),
            ("LANG", "en_US.UTF-8"),
            ("LC_TIME", "C"),
            ("PATH", "/home/a/.local/bin:/usr/bin"),
            ("EDITOR", "vim"),
            ("MY_TOOL", "from-session"),
        ]);
        let start = kv(&[
            ("DISPLAY", ":99"),
            ("SSH_AUTH_SOCK", "/run/agent"),
            ("TERM_PROGRAM", "Apple_Terminal"),
            ("REX_SESSION", "r"),
            ("GIT_EDITOR", "true"),
            ("HOME", "/scratch"),
            ("FOO", "x"),
        ]);
        let file = FileEnv::default();
        let b = session_base(&|k| file.allowed(k), Some((&source, "systemd-user")), &start);
        let names: Vec<&str> = b.keys().map(String::as_str).collect();
        assert_eq!(
            names,
            ["DISPLAY", "LANG", "LC_TIME", "SSH_AUTH_SOCK", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"]
        );
        // The session's fresh value wins over the daemon's stale one; a name the session lacks
        // falls back to the daemon's start value, said.
        assert_eq!(b["DISPLAY"], Var::new(":0", EnvSource::Session, Some("systemd-user")));
        assert_eq!(b["SSH_AUTH_SOCK"], Var::new("/run/agent", EnvSource::Session, Some("daemon")));
        // No source: every allowlisted name from the daemon's start values, nothing else.
        let b = session_base(&|k| file.allowed(k), None, &start);
        assert_eq!(b.keys().map(String::as_str).collect::<Vec<_>>(), ["DISPLAY", "SSH_AUTH_SOCK"]);
        assert_eq!(b["DISPLAY"].via, Some("daemon"));
        // termd.toml: pass adds names (from the session, else the daemon), drop removes them.
        let file = FileEnv {
            pass: vec!["MY_*".into(), "FOO".into()],
            drop: vec!["DISPLAY".into(), "LC_*".into()],
            ..Default::default()
        };
        let b = session_base(&|k| file.allowed(k), Some((&source, "systemd-user")), &start);
        assert_eq!(b.get("MY_TOOL").map(|v| v.value.as_str()), Some("from-session"));
        assert_eq!(b.get("FOO").map(|v| (v.value.as_str(), v.via)), Some(("x", Some("daemon"))));
        assert!(!b.contains_key("DISPLAY") && !b.contains_key("LC_TIME"));
        // And through compose: the account and PATH are the fill's, never a source's.
        let t = sleep();
        let file = FileEnv::default();
        let b = session_base(&|k| file.allowed(k), Some((&source, "systemd-user")), &start);
        let p = compose0(b, &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "HOME"), Some("/"));
        assert_eq!(get(&p, "PATH"), Some("/usr/local/bin:/usr/bin:/bin"));
        assert_eq!(get(&p, "EDITOR"), None);
        assert_eq!(get(&p, "LANG"), Some("en_US.UTF-8"));
    }

    #[test]
    fn a_name_by_name_source_is_asked_for_the_allowlist_expanded() {
        let pats: Vec<String> = ["DISPLAY", "LC_*", "MY_*", "TMPDIR"].map(String::from).to_vec();
        let got = candidates(&pats, &["MY_TOOL", "LC_TERMINAL", "OTHER"]);
        assert!(got.contains(&"DISPLAY".to_string()) && got.contains(&"TMPDIR".to_string()));
        assert!(got.contains(&"LC_ALL".to_string()) && got.contains(&"LC_TIME".to_string()));
        assert!(got.contains(&"LC_TERMINAL".to_string()) && got.contains(&"MY_TOOL".to_string()));
        assert!(!got.contains(&"OTHER".to_string()));
        let mut sorted = got.clone();
        sorted.dedup();
        assert_eq!(sorted, got);
    }

    #[test]
    fn launchctl_answers_parse() {
        let asked: Vec<String> = ["DISPLAY", "SSH_AUTH_SOCK", "LANG"].map(String::from).to_vec();
        let got =
            launchd::parse(b"SSH_AUTH_SOCK=/private/tmp/com.apple.launchd.x/Listeners\0LANG=a=b\0", &asked).unwrap();
        assert_eq!(got, kv(&[("SSH_AUTH_SOCK", "/private/tmp/com.apple.launchd.x/Listeners"), ("LANG", "a=b")]));
        assert_eq!(launchd::parse(b"", &asked).unwrap(), vec![]);
        assert!(launchd::parse(b"NOEQUALS\0", &asked).is_err());
        assert!(launchd::parse(b"OTHER=x\0", &asked).is_err());
        assert!(launchd::parse(b"LANG=\xff\0", &asked).is_err());
        // The script asks each name once, prints only names with a value, and exits 0.
        assert!(launchd::SCRIPT.contains("/bin/launchctl getenv \"$n\"") && launchd::SCRIPT.contains("\\0"));
    }

    #[test]
    fn the_config_file_parses_and_a_bad_one_names_its_line() {
        let f = parse_config(
            "# termd.toml\n[env]\npass = [\"EDITOR\", \"MY_*\"]\ndrop = [\"TMPDIR\"]\n\n[env.set]\nGOPATH = \"${HOME}/go\"\n",
        )
        .unwrap();
        assert_eq!(f.pass, ["EDITOR", "MY_*"]);
        assert_eq!(f.drop, ["TMPDIR"]);
        assert_eq!(f.set.get("GOPATH").map(String::as_str), Some("${HOME}/go"));
        assert_eq!(parse_config("").unwrap(), FileEnv::default());
        for (text, line, what) in [
            ("[env]\npass = [\"A\"\n", 2, ""),
            ("[env]\n\npasss = [\"A\"]\n", 3, "passs"),
            ("[other]\n", 1, "other"),
            ("[env]\npass = [\"*\"]\n", 2, "\"*\""),
            ("[env]\ndrop = [\"A-B\"]\n", 2, "A-B"),
            ("[env]\n[env.set]\nTERM = \"x\"\n", 3, "TERM"),
            ("[env]\n[env.set]\nA = \"${B\"\n", 3, "without"),
            ("[env]\n[env.set]\nA = \"${B-C}\"\n", 3, "${B-C}"),
            ("[env]\n[env.set]\n\"A B\" = \"x\"\n", 3, "A B"),
            ("[env]\n[env.set]\nA = \"x\\u0000\"\n", 3, "NUL"),
        ] {
            let e = parse_config(text).unwrap_err();
            assert!(e.starts_with(&format!("line {line}: ")) && e.contains(what), "{text:?}: {e}");
        }
        assert_eq!(expand("${A}${A}-${B}$", |n| (n == "A").then_some("a")), "aa-$");
    }

    #[test]
    fn the_config_path_is_the_sessions_xdg_else_passwds_home() {
        assert_eq!(default_config_path(Some("/x/cfg"), "/home/a"), PathBuf::from("/x/cfg/g3d/termd.toml"));
        assert_eq!(default_config_path(Some("relative"), "/home/a"), PathBuf::from("/home/a/.config/g3d/termd.toml"));
        assert_eq!(default_config_path(None, "/home/a"), PathBuf::from("/home/a/.config/g3d/termd.toml"));
    }

    #[test]
    fn login_defs_env_path_parses() {
        assert_eq!(
            parse_login_defs_path("# x\nENV_SUPATH\tPATH=/sbin\nENV_PATH\tPATH=/usr/local/bin:/usr/bin\n").as_deref(),
            Some("/usr/local/bin:/usr/bin")
        );
        assert_eq!(parse_login_defs_path("ENV_PATH /bin:/usr/bin").as_deref(), Some("/bin:/usr/bin"));
        assert_eq!(parse_login_defs_path("#ENV_PATH PATH=/x\n"), None);
    }

    #[test]
    fn a_caller_base_is_checked_like_env_but_may_name_termds_own() {
        let ok = BTreeMap::from([("TERM".to_string(), "screen".to_string()), ("FOO".to_string(), "x".to_string())]);
        check_base_env(&ok).unwrap();
        for (k, v, want) in [
            ("BAD-NAME", "x".to_string(), code::BAD_REQUEST),
            ("1X", "x".to_string(), code::BAD_REQUEST),
            ("NUL", "a\0b".to_string(), code::BAD_REQUEST),
            ("BIG", "x".repeat(ENV_VALUE_MAX), code::TOO_LARGE),
        ] {
            let e = check_base_env(&BTreeMap::from([(k.to_string(), v)])).unwrap_err();
            assert_eq!(e.code, want, "{k}: {}", e.message);
            assert!(e.message.contains("env_base") && e.message.contains(k), "{}", e.message);
        }
    }

    #[test]
    fn a_locale_that_does_not_give_utf8_is_named() {
        assert_eq!(locale_problem(&kv(&[("LANG", "C.UTF-8")])), None);
        assert_eq!(locale_problem(&kv(&[])), None);
        // LC_ALL wins over LANG.
        assert_eq!(locale_problem(&kv(&[("LANG", "C"), ("LC_ALL", "C.UTF-8")])), None);
        let p = locale_problem(&kv(&[("LANG", "C")])).unwrap();
        assert!(p.contains("LANG=C is not UTF-8"), "{p}");
        let p = locale_problem(&kv(&[("LC_CTYPE", "xx_NOWHERE.ISO-8859-1")])).unwrap();
        assert!(p.contains("does not load"), "{p}");
    }

    #[test]
    fn the_default_program_is_the_passwd_shell_as_a_login_shell() {
        // A $SHELL naming another shell is ignored: the passwd entry is the account's truth.
        let p = compose0(caller(&[("SHELL", "/usr/bin/env")]), &req(None, None)).unwrap();
        assert_eq!(p.path, "/bin/sh");
        assert_eq!(p.argv, vec!["-sh"]);
        assert_eq!(p.shown, vec!["/bin/sh"]);
        assert!(p.login);
        assert_eq!(get(&p, "SHELL"), Some("/bin/sh"));

        let mut s = settings();
        s.login_shell = false;
        let p = compose(&s, Env::new(), &FileEnv::default(), &account(), &req(None, None)).unwrap();
        assert_eq!(p.argv, vec!["/bin/sh"]);
        assert!(!p.login);

        // No usable passwd shell: an absolute, executable $SHELL; else /bin/sh.
        let mut a = account();
        a.shell = "/nonexistent/shell".into();
        let f = FileEnv::default();
        let p = compose(&settings(), caller(&[("SHELL", "/usr/bin/env")]), &f, &a, &req(None, None)).unwrap();
        assert_eq!(p.path, "/usr/bin/env");
        assert_eq!(tag(&p, "SHELL"), Some((EnvSource::Fill, Some("base".into()))));
        let p = compose(&settings(), caller(&[("SHELL", "env")]), &f, &a, &req(None, None)).unwrap();
        assert_eq!(p.path, "/bin/sh");

        // A request's SHELL, with no argv, is the shell that runs (as login(1) and tmux mean it);
        // one that isn't an absolute executable is refused. With an argv it is only the variable.
        let env = BTreeMap::from([("SHELL".to_string(), Some("/usr/bin/env".to_string()))]);
        let p = compose0(Env::new(), &req(None, Some(&env))).unwrap();
        assert_eq!(
            (p.path.as_str(), p.argv[0].as_str(), get(&p, "SHELL")),
            ("/usr/bin/env", "-env", Some("/usr/bin/env"))
        );
        let t = sleep();
        let p = compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap();
        assert_eq!((p.argv[0].as_str(), get(&p, "SHELL")), ("true", Some("/usr/bin/env")));
        let env = BTreeMap::from([("SHELL".to_string(), Some("zsh".to_string()))]);
        assert_eq!(compose0(Env::new(), &req(None, Some(&env))).unwrap_err().code, code::BAD_REQUEST);

        // The --shell setting replaces the passwd entry.
        let mut s = settings();
        s.shell = Some("/usr/bin/env".into());
        let p = compose(&s, Env::new(), &f, &account(), &req(None, None)).unwrap();
        assert_eq!((p.path.as_str(), p.argv[0].as_str()), ("/usr/bin/env", "-env"));
    }

    #[test]
    fn an_explicit_argv_runs_as_given_and_resolves_in_its_own_path() {
        let argv: Vec<String> = vec!["sh".into(), "-c".into(), "exit".into()];
        let p = compose0(caller(&[("PATH", "/nonexistent:/bin")]), &req(Some(&argv), None)).unwrap();
        assert_eq!(p.path, "/bin/sh");
        assert_eq!(p.argv, argv);
        assert_eq!(p.shown, vec!["/bin/sh", "-c", "exit"]);
        assert!(!p.login);
        // Not in this PATH, though it is in the daemon's.
        let e = compose0(caller(&[("PATH", "/nonexistent")]), &req(Some(&argv), None)).unwrap_err();
        assert_eq!(e.code, code::SPAWN_FAILED);
    }

    #[test]
    fn locale_is_filled_only_when_none_is_set() {
        let t = sleep();
        let p = compose0(Env::new(), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), Some("C.UTF-8"));
        // A set locale is the person's, even when it isn't UTF-8.
        let p = compose0(caller(&[("LANG", "en_US.ISO-8859-1")]), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), Some("en_US.ISO-8859-1"));
        let p = compose0(caller(&[("LC_ALL", "de_DE.UTF-8")]), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), None);
        // An empty value is unset.
        let p = compose0(caller(&[("LANG", "")]), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), Some("C.UTF-8"));
        // A request that removes LANG meant it; so does a file that sets a locale.
        let env = BTreeMap::from([("LANG".to_string(), None)]);
        let p = compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap();
        assert_eq!(get(&p, "LANG"), None);
        let file = FileEnv { set: BTreeMap::from([("LC_CTYPE".into(), "C.UTF-8".into())]), ..Default::default() };
        let p = compose(&settings(), Env::new(), &file, &account(), &req(Some(&t), None)).unwrap();
        assert_eq!((get(&p, "LANG"), get(&p, "LC_CTYPE")), (None, Some("C.UTF-8")));
        // Filling off.
        let mut s = settings();
        s.locale_fill = None;
        let p = compose(&s, Env::new(), &FileEnv::default(), &account(), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), None);
    }

    #[test]
    fn the_request_env_wins_over_the_base_and_is_checked() {
        let t = sleep();
        let env = BTreeMap::from([("FOO".to_string(), Some("bar".to_string())), ("DISPLAY".to_string(), None)]);
        let p = compose0(caller(&[("FOO", "old"), ("DISPLAY", ":0")]), &req(Some(&t), Some(&env))).unwrap();
        assert_eq!(get(&p, "FOO"), Some("bar"));
        assert_eq!(get(&p, "DISPLAY"), None);
        // A request may set a scrubbed name: it knows what this terminal is for.
        let env = BTreeMap::from([("TMUX".to_string(), Some("x".to_string()))]);
        let p = compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap();
        assert_eq!(get(&p, "TMUX"), Some("x"));

        for (name, value, want) in [
            ("TERM", Some("dumb"), code::BAD_REQUEST),
            ("PWD", None, code::BAD_REQUEST),
            ("G3D_TERMD_SOCKET", Some("/x"), code::BAD_REQUEST),
            ("1BAD", Some("x"), code::BAD_REQUEST),
            ("BAD-NAME", Some("x"), code::BAD_REQUEST),
            ("", Some("x"), code::BAD_REQUEST),
            ("NUL", Some("a\0b"), code::BAD_REQUEST),
        ] {
            let env = BTreeMap::from([(name.to_string(), value.map(str::to_string))]);
            let e = compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap_err();
            assert_eq!(e.code, want, "{name}: {}", e.message);
        }
        let env = BTreeMap::from([("BIG".to_string(), Some("x".repeat(ENV_VALUE_MAX + 1)))]);
        let e = compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap_err();
        assert_eq!(e.code, code::TOO_LARGE);
        assert!(e.message.contains("BIG"), "{}", e.message);
        // The limit is on `NAME=value` and its NUL, as execve counts it: X= plus the NUL is 3.
        let env = BTreeMap::from([("X".to_string(), Some("a".repeat(ENV_VALUE_MAX - 3)))]);
        compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap();
        let env = BTreeMap::from([("X".to_string(), Some("a".repeat(ENV_VALUE_MAX - 2)))]);
        let e = compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap_err();
        assert_eq!(e.code, code::TOO_LARGE);
        let env: BTreeMap<_, _> = (0..10).map(|i| (format!("V{i}"), Some("x".repeat(ENV_VALUE_MAX - 10)))).collect();
        let e = compose0(Env::new(), &req(Some(&t), Some(&env))).unwrap_err();
        assert_eq!(e.code, code::TOO_LARGE);
    }

    #[test]
    fn cwd_is_checked_and_defaults_to_home() {
        let t = sleep();
        let mut r = req(Some(&t), None);
        r.cwd = Some("/");
        let p = compose0(Env::new(), &r).unwrap();
        assert_eq!((p.cwd.as_str(), get(&p, "PWD")), ("/", Some("/")));
        // PWD may hold no `.` or `..`: such a cwd becomes the directory's real path.
        for given in ["/usr/../usr", "/usr/./", "/proc/self/../"] {
            let mut r = req(Some(&t), None);
            r.cwd = Some(given);
            let p = compose0(Env::new(), &r).unwrap();
            let real = std::fs::canonicalize(given).unwrap().display().to_string();
            assert_eq!((p.cwd.as_str(), get(&p, "PWD")), (real.as_str(), Some(real.as_str())), "{given}");
        }
        for bad in ["relative/dir", "/nonexistent/dir", "/bin/sh"] {
            let mut r = req(Some(&t), None);
            r.cwd = Some(bad);
            let e = compose0(Env::new(), &r).unwrap_err();
            assert_eq!(e.code, code::BAD_REQUEST, "{bad}");
        }
        let f = FileEnv::default();
        let mut a = account();
        a.home = "/usr".into();
        let p = compose(&settings(), Env::new(), &f, &a, &req(Some(&t), None)).unwrap();
        assert_eq!(p.cwd, a.home);
        a.home = "/nonexistent/home".into();
        let p = compose(&settings(), Env::new(), &f, &a, &req(Some(&t), None)).unwrap();
        assert_eq!(p.cwd, "/");
    }

    #[test]
    fn manager_env_parses_busctl_json() {
        let got = parse_manager_env(
            r#"{"type":"as","data":["HOME=/home/a","DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1/bus","EMPTY="]}"#,
        )
        .unwrap();
        assert_eq!(
            got,
            kv(&[("HOME", "/home/a"), ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1/bus"), ("EMPTY", "")])
        );
        assert!(parse_manager_env(r#"{"type":"s","data":"x"}"#).is_err());
        assert!(parse_manager_env(r#"{"type":"as","data":["NOEQUALS"]}"#).is_err());
        assert!(parse_manager_env("garbage").is_err());
    }

    #[test]
    fn the_account_is_readable() {
        let a = super::account().unwrap();
        assert!(!a.name.is_empty() && a.home.starts_with('/'), "{a:?}");
    }
}
