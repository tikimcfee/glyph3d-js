//! What a terminal's program is started as: its path and argv, its working directory and its
//! whole environment (DESIGN.md, "Environment"; PROTOCOL.md, "The program's environment").
//! The brain decides all of it per `create`; the holder only runs the result.
//!
//! Layers, later winning: (1) the session base, (2) minus the scrub, (3) the account,
//! (4) the request's `env`, (5) termd's own. [`compose`] is the pure part (unit-tested below);
//! [`Policy::session_base`] reads layer 1, which on Linux asks the systemd user manager.

use g3d_wire::msg::{EnvBase, WireError, code};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

/// Names that describe some other process: another terminal, multiplexer, editor or agent; the
/// launcher or unit; the parent shell; termd's own controls. `NAME*` is a prefix. A setting
/// (`--env-scrub`) adds to it and `--env-keep` exempts from it.
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
    "VSCODE_*",
    "NVIM",
    "INSIDE_EMACS",
    "CLAUDECODE",
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM*",
    "TERMINFO",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "COLORFGBG",
    "WINDOWID",
    "SHELL_SESSION_ID",
    // The launcher and the unit.
    "INVOCATION_ID",
    "JOURNAL_STREAM",
    "NOTIFY_SOCKET",
    "LISTEN_*",
    "MANAGERPID",
    "SYSTEMD_EXEC_PID",
    "WATCHDOG_*",
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
    // termd's own controls (G3D_TERMD_DIR, G3D_TERMD_ENV_SOURCE, the test hooks).
    "G3D_TERMD_*",
];

/// Layer 5: they describe this terminal, so a request may neither set nor remove them.
pub const RESERVED: &[&str] =
    &["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "G3D_TERMD_ID", "G3D_TERMD_SOCKET", "PWD"];

/// One value's limit (Linux's `MAX_ARG_STRLEN`, 32 pages).
pub const VALUE_MAX: usize = 128 << 10;
/// argv plus the environment, in bytes as `execve` counts them (each string and its NUL).
pub const EXEC_MAX: usize = 1 << 20;

/// Where layer 1 comes from (`--env-source`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum EnvSource {
    /// The systemd user manager's environment when one answers (Linux), else the daemon's own.
    Auto,
    /// The environment the daemon started with: hermetic, for tests and hosts without a session.
    Daemon,
}

/// Matches `NAME` exactly, or `PREFIX*` as a prefix.
fn matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(pre) => name.starts_with(pre),
        None => name == pattern,
    }
}

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

/// What a `create` asked for that the environment depends on.
pub struct Request<'a> {
    pub id: &'a str,
    pub argv: Option<&'a [String]>,
    pub cwd: Option<&'a str>,
    pub env: Option<&'a BTreeMap<String, Option<String>>>,
}

/// The daemon's settings for every terminal it starts.
#[derive(Clone, Debug)]
pub struct Settings {
    pub scrub: Vec<String>,
    pub keep: Vec<String>,
    /// `--shell`: replaces the passwd entry's shell for the whole namespace.
    pub shell: Option<String>,
    pub login_shell: bool,
    /// The `LANG` to fill when no locale is set: `None` when filling is off or the locale
    /// doesn't load (checked once at start).
    pub locale_fill: Option<String>,
    pub term: String,
    pub socket: String,
    pub version: String,
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
}

fn bad(msg: impl Into<String>) -> WireError {
    WireError::new(code::BAD_REQUEST, msg)
}

/// Checks a request's `env` (PROTOCOL.md, `create`).
pub fn check_request_env(env: &BTreeMap<String, Option<String>>) -> Result<(), WireError> {
    for (k, v) in env {
        let mut b = k.bytes();
        let ok = b.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
            && b.all(|c| c.is_ascii_alphanumeric() || c == b'_');
        if !ok {
            return Err(bad(format!("env name {k:?} must match [A-Za-z_][A-Za-z0-9_]*")));
        }
        if RESERVED.contains(&k.as_str()) {
            return Err(bad(format!("env {k} is termd's to set: it describes this terminal")));
        }
        if let Some(v) = v {
            if v.contains('\0') {
                return Err(bad(format!("env {k} contains NUL")));
            }
            if v.len() > VALUE_MAX {
                return Err(WireError::new(
                    code::TOO_LARGE,
                    format!("env {k} is {} bytes; the most is {VALUE_MAX}", v.len()),
                ));
            }
        }
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

/// The shell a terminal with no `argv` runs, and that `SHELL` names: the `--shell` setting,
/// else the passwd entry's when it is an executable, else `$SHELL` when it is an absolute path
/// to one, else `/bin/sh`.
fn choose_shell(s: &Settings, account: &Account, env_shell: Option<&str>) -> String {
    if let Some(sh) = &s.shell {
        return sh.clone();
    }
    if !account.shell.is_empty() && is_executable(Path::new(&account.shell)) {
        return account.shell.clone();
    }
    if let Some(sh) = env_shell
        && sh.starts_with('/')
        && is_executable(Path::new(sh))
    {
        return sh.to_owned();
    }
    "/bin/sh".into()
}

/// Composes layers 2–5 on `base` (layer 1; `None` for `env_base: "none"`) and resolves the
/// program. Pure but for reading the filesystem (the cwd, the shell, the `PATH` lookup).
pub fn compose(
    s: &Settings,
    base: Option<Vec<(String, String)>>,
    account: &Account,
    req: &Request,
) -> Result<Plan, WireError> {
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
            c.to_owned()
        }
        None if !account.home.is_empty() && Path::new(&account.home).is_dir() => account.home.clone(),
        None => "/".into(),
    };
    // 1–2: the base, scrubbed.
    let mut env: BTreeMap<String, String> = base
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| !s.scrub.iter().any(|p| matches(p, k)) || s.keep.iter().any(|p| matches(p, k)))
        .collect();
    // 3: the account.
    for (k, v) in [("HOME", &account.home), ("USER", &account.name), ("LOGNAME", &account.name)] {
        if !env.contains_key(k) && !v.is_empty() {
            env.insert(k.into(), v.clone());
        }
    }
    let env_shell = match client.get("SHELL") {
        Some(v) => v.clone(),
        None => env.get("SHELL").cloned(),
    };
    let shell = choose_shell(s, account, env_shell.as_deref());
    env.insert("SHELL".into(), shell.clone());
    // 4: the request's.
    for (k, v) in client {
        match v {
            Some(v) => env.insert(k.clone(), v.clone()),
            None => env.remove(k),
        };
    }
    // The locale: filled only when none is set and the request named none of them.
    let set = |k: &str| env.get(k).is_some_and(|v| !v.is_empty());
    let asked = ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| client.contains_key(*k));
    if let Some(lang) = &s.locale_fill
        && !asked
        && !set("LC_ALL")
        && !set("LC_CTYPE")
        && !set("LANG")
    {
        env.insert("LANG".into(), lang.clone());
    }
    // 5: termd's own.
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
        env.insert(k.into(), v);
    }
    // The program.
    let (path, argv, shown, login) = match req.argv {
        Some(a) => {
            let path = resolve(&a[0], env.get("PATH").map(String::as_str))?;
            let shown = std::iter::once(path.clone()).chain(a[1..].iter().cloned()).collect();
            (path, a.to_vec(), shown, false)
        }
        None => {
            let name = Path::new(&shell).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let argv0 = if s.login_shell { format!("-{name}") } else { shell.clone() };
            (shell.clone(), vec![argv0], vec![shell.clone()], s.login_shell)
        }
    };
    let env: Vec<(String, String)> = env.into_iter().collect();
    let total: usize =
        argv.iter().map(|a| a.len() + 1).sum::<usize>() + env.iter().map(|(k, v)| k.len() + v.len() + 2).sum::<usize>();
    if total > EXEC_MAX {
        return Err(WireError::new(
            code::TOO_LARGE,
            format!("argv and environment are {total} bytes; the most is {EXEC_MAX}"),
        ));
    }
    Ok(Plan { path, argv, shown, login, cwd, env })
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

/// Layer 1's source, the settings, and the environment the daemon started with.
pub struct Policy {
    pub source: EnvSource,
    pub settings: Settings,
    /// The environment this brain started with: the holder's (its starter's).
    pub daemon_env: Vec<(String, String)>,
    pub manager_timeout: Duration,
    /// Test hook: the user manager's answer comes from this file (the busctl JSON), re-read per
    /// `create`, instead of from busctl.
    #[cfg(feature = "test-hooks")]
    pub manager_file: Option<std::path::PathBuf>,
    /// What the last `create` used, logged when it changes.
    last: Mutex<String>,
}

impl Policy {
    pub fn new(source: EnvSource, settings: Settings, manager_timeout: Duration) -> Self {
        Policy {
            source,
            settings,
            daemon_env: std::env::vars_os()
                .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
                .collect(),
            manager_timeout,
            #[cfg(feature = "test-hooks")]
            manager_file: std::env::var_os("G3D_TERMD_TEST_SESSION_ENV_FILE")
                .filter(|_| crate::test_hooks_armed())
                .map(Into::into),
            last: Mutex::new(String::new()),
        }
    }

    /// Layer 1 for `env_base`, read now. Blocking (it may ask the user manager).
    pub fn base(&self, base: EnvBase) -> Option<Vec<(String, String)>> {
        match base {
            EnvBase::None => None,
            EnvBase::Session => Some(self.session_base()),
        }
    }

    fn session_base(&self) -> Vec<(String, String)> {
        let (env, note) = match self.source {
            EnvSource::Daemon => (self.daemon_env.clone(), "the daemon's own (--env-source daemon)".to_owned()),
            EnvSource::Auto => match self.manager_env() {
                Ok(env) => (env, "the systemd user manager's".to_owned()),
                Err(why) => (self.daemon_env.clone(), format!("the daemon's own: {why}")),
            },
        };
        let mut last = self.last.lock().unwrap();
        if *last != note {
            crate::log(&format!("terminal environment: {note}"));
            *last = note;
        }
        env
    }

    fn manager_env(&self) -> Result<Vec<(String, String)>, String> {
        #[cfg(feature = "test-hooks")]
        if let Some(f) = &self.manager_file {
            let s = std::fs::read_to_string(f).map_err(|e| format!("{}: {e}", f.display()))?;
            return parse_manager_env(&s);
        }
        platform::manager_env(&self.daemon_env, self.manager_timeout)
    }

    /// A whole plan for one `create`: the base read now, the account read now.
    pub fn plan(&self, base: EnvBase, req: &Request) -> Result<Plan, WireError> {
        let account = account().map_err(|e| WireError::new(code::SPAWN_FAILED, format!("the account: {e}")))?;
        compose(&self.settings, self.base(base), &account, req)
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
    use std::io::Read;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Linux: `C.UTF-8` (built into glibc since 2.35, and into musl).
    pub fn default_locale() -> String {
        "C.UTF-8".into()
    }

    /// The systemd user manager's environment, through `busctl`, systemd's own client (no D-Bus
    /// library linked). A daemon started with a stripped environment has no bus address; then
    /// the bus is found where pam_systemd puts it, `/run/user/<uid>`, when that is ours.
    pub fn manager_env(daemon_env: &[(String, String)], timeout: Duration) -> Result<Vec<(String, String)>, String> {
        let get = |k: &str| daemon_env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty());
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
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        if get("DBUS_SESSION_BUS_ADDRESS").is_none() && get("XDG_RUNTIME_DIR").is_none() {
            let uid = rustix::process::getuid().as_raw();
            let dir = format!("/run/user/{uid}");
            use std::os::unix::fs::MetadataExt;
            match std::fs::metadata(&dir) {
                Ok(m) if m.is_dir() && m.uid() == uid => {
                    cmd.env("XDG_RUNTIME_DIR", &dir);
                }
                _ => return Err(format!("no bus address and no {dir}")),
            }
        }
        let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", busctl.display()))?;
        let until = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(5)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("the user manager did not answer within {timeout:?}"));
                }
                Err(e) => return Err(format!("busctl: {e}")),
            }
        };
        let (mut out, mut err) = (String::new(), String::new());
        if let Some(mut o) = child.stdout.take() {
            let _ = o.read_to_string(&mut out);
        }
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        if !status.success() {
            return Err(format!("busctl: {status}: {}", err.trim()));
        }
        super::parse_manager_env(&out)
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use std::time::Duration;

    /// macOS: the user's own locale (the `AppleLocale` preference, as Terminal.app, iTerm2 and
    /// Ghostty read it) as `<language>_<region>.UTF-8`; `C.UTF-8` when it has no region. Elsewhere
    /// `C.UTF-8`. The caller checks that it loads. Unverified on macOS: the macOS branch owns it.
    pub fn default_locale() -> String {
        #[cfg(target_os = "macos")]
        if let Ok(out) = std::process::Command::new("/usr/bin/defaults").args(["read", "-g", "AppleLocale"]).output()
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

    /// No systemd user manager: the daemon's own environment is the session's (launchd's).
    pub fn manager_env(_: &[(String, String)], _: Duration) -> Result<Vec<(String, String)>, String> {
        Err("no user manager on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings {
            scrub: SCRUB.iter().map(|s| s.to_string()).collect(),
            keep: vec![],
            shell: None,
            login_shell: true,
            locale_fill: Some("C.UTF-8".into()),
            term: "xterm-256color".into(),
            socket: "/run/test/termd-x.sock".into(),
            version: "g3d-termd/9.9.9".into(),
        }
    }

    fn account() -> Account {
        Account { name: "alice".into(), home: "/".into(), shell: "/bin/sh".into() }
    }

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn req<'a>(argv: Option<&'a [String]>, env: Option<&'a BTreeMap<String, Option<String>>>) -> Request<'a> {
        Request { id: "t1", argv, cwd: None, env }
    }

    fn get<'a>(p: &'a Plan, k: &str) -> Option<&'a str> {
        p.env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    #[test]
    fn scrub_removes_other_processes_and_keeps_the_rest() {
        let base = kv(&[
            ("TMUX", "/tmp/tmux-1/default,1,0"),
            ("TERM_PROGRAM", "Apple_Terminal"),
            ("TERM_PROGRAM_VERSION", "455"),
            ("TERM_SESSION_ID", "w0t0p0"),
            ("VSCODE_IPC_HOOK_CLI", "/run/vscode.sock"),
            ("KITTY_WINDOW_ID", "3"),
            ("ZELLIJ", "0"),
            ("CLAUDECODE", "1"),
            ("SHLVL", "3"),
            ("PWD", "/somewhere"),
            ("OLDPWD", "/else"),
            ("COLUMNS", "10"),
            ("LINES", "5"),
            ("INVOCATION_ID", "abc"),
            ("LISTEN_FDS", "1"),
            ("G3D_TERMD_DIR", "/scratch"),
            ("G3D_TERMD_TEST_HOOKS", "1"),
            ("LC_TERMINAL", "iTerm2"),
            ("TERMINFO", "/opt/kitty/terminfo"),
            ("TERMINFO_DIRS", "/usr/share/terminfo"),
            ("PATH", "/usr/bin:/bin"),
            ("DISPLAY", ":0"),
            ("SSH_AUTH_SOCK", "/run/agent"),
            ("TERMUX", "not a prefix match of TERM"),
        ]);
        let p = compose(&settings(), Some(base), &account(), &req(Some(&["true".into()]), None)).unwrap();
        for gone in [
            "TMUX",
            "TERM_SESSION_ID",
            "VSCODE_IPC_HOOK_CLI",
            "KITTY_WINDOW_ID",
            "ZELLIJ",
            "CLAUDECODE",
            "SHLVL",
            "OLDPWD",
            "COLUMNS",
            "LINES",
            "INVOCATION_ID",
            "LISTEN_FDS",
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
    fn keep_exempts_and_extra_scrub_removes() {
        let mut s = settings();
        s.keep.push("TMUX".into());
        s.scrub.push("MY_*".into());
        let base = kv(&[("TMUX", "x"), ("MY_THING", "y"), ("MYOTHER", "z")]);
        let p = compose(&s, Some(base), &account(), &req(Some(&["true".into()]), None)).unwrap();
        assert_eq!(get(&p, "TMUX"), Some("x"));
        assert_eq!(get(&p, "MY_THING"), None);
        assert_eq!(get(&p, "MYOTHER"), Some("z"));
    }

    #[test]
    fn account_fills_only_what_is_missing() {
        let p =
            compose(&settings(), Some(kv(&[("USER", "bob")])), &account(), &req(Some(&["true".into()]), None)).unwrap();
        assert_eq!(get(&p, "USER"), Some("bob"));
        assert_eq!(get(&p, "LOGNAME"), Some("alice"));
        assert_eq!(get(&p, "HOME"), Some("/"));
    }

    #[test]
    fn the_default_program_is_the_passwd_shell_as_a_login_shell() {
        // A $SHELL naming another shell is ignored: the passwd entry is the account's truth.
        let base = kv(&[("SHELL", "/usr/bin/env")]);
        let p = compose(&settings(), Some(base), &account(), &req(None, None)).unwrap();
        assert_eq!(p.path, "/bin/sh");
        assert_eq!(p.argv, vec!["-sh"]);
        assert_eq!(p.shown, vec!["/bin/sh"]);
        assert!(p.login);
        assert_eq!(get(&p, "SHELL"), Some("/bin/sh"));

        let mut s = settings();
        s.login_shell = false;
        let p = compose(&s, None, &account(), &req(None, None)).unwrap();
        assert_eq!(p.argv, vec!["/bin/sh"]);
        assert!(!p.login);

        // No usable passwd shell: an absolute, executable $SHELL; else /bin/sh.
        let mut a = account();
        a.shell = "/nonexistent/shell".into();
        let p = compose(&settings(), Some(kv(&[("SHELL", "/usr/bin/env")])), &a, &req(None, None)).unwrap();
        assert_eq!(p.path, "/usr/bin/env");
        let p = compose(&settings(), Some(kv(&[("SHELL", "env")])), &a, &req(None, None)).unwrap();
        assert_eq!(p.path, "/bin/sh");

        // The --shell setting replaces the passwd entry.
        let mut s = settings();
        s.shell = Some("/usr/bin/env".into());
        let p = compose(&s, None, &account(), &req(None, None)).unwrap();
        assert_eq!((p.path.as_str(), p.argv[0].as_str()), ("/usr/bin/env", "-env"));
    }

    #[test]
    fn an_explicit_argv_runs_as_given_and_resolves_in_its_own_path() {
        let argv: Vec<String> = vec!["sh".into(), "-c".into(), "exit".into()];
        let p = compose(&settings(), Some(kv(&[("PATH", "/nonexistent:/bin")])), &account(), &req(Some(&argv), None))
            .unwrap();
        assert_eq!(p.path, "/bin/sh");
        assert_eq!(p.argv, argv);
        assert_eq!(p.shown, vec!["/bin/sh", "-c", "exit"]);
        assert!(!p.login);
        // Not in this PATH, though it is in the daemon's.
        let e = compose(&settings(), Some(kv(&[("PATH", "/nonexistent")])), &account(), &req(Some(&argv), None))
            .unwrap_err();
        assert_eq!(e.code, code::SPAWN_FAILED);
    }

    #[test]
    fn locale_is_filled_only_when_none_is_set() {
        let t: Vec<String> = vec!["true".into()];
        let p = compose(&settings(), None, &account(), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), Some("C.UTF-8"));
        // A set locale is the person's, even when it isn't UTF-8.
        let p =
            compose(&settings(), Some(kv(&[("LANG", "en_US.ISO-8859-1")])), &account(), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), Some("en_US.ISO-8859-1"));
        let p = compose(&settings(), Some(kv(&[("LC_ALL", "de_DE.UTF-8")])), &account(), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), None);
        // An empty value is unset.
        let p = compose(&settings(), Some(kv(&[("LANG", "")])), &account(), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), Some("C.UTF-8"));
        // A request that removes LANG meant it.
        let env = BTreeMap::from([("LANG".to_string(), None)]);
        let p = compose(&settings(), None, &account(), &req(Some(&t), Some(&env))).unwrap();
        assert_eq!(get(&p, "LANG"), None);
        // Filling off.
        let mut s = settings();
        s.locale_fill = None;
        let p = compose(&s, None, &account(), &req(Some(&t), None)).unwrap();
        assert_eq!(get(&p, "LANG"), None);
    }

    #[test]
    fn the_request_env_wins_over_the_base_and_is_checked() {
        let t: Vec<String> = vec!["true".into()];
        let env = BTreeMap::from([("FOO".to_string(), Some("bar".to_string())), ("DISPLAY".to_string(), None)]);
        let p = compose(
            &settings(),
            Some(kv(&[("FOO", "old"), ("DISPLAY", ":0")])),
            &account(),
            &req(Some(&t), Some(&env)),
        )
        .unwrap();
        assert_eq!(get(&p, "FOO"), Some("bar"));
        assert_eq!(get(&p, "DISPLAY"), None);
        // A request may set a scrubbed name: it knows what this terminal is for.
        let env = BTreeMap::from([("TMUX".to_string(), Some("x".to_string()))]);
        let p = compose(&settings(), None, &account(), &req(Some(&t), Some(&env))).unwrap();
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
            let e = compose(&settings(), None, &account(), &req(Some(&t), Some(&env))).unwrap_err();
            assert_eq!(e.code, want, "{name}: {}", e.message);
        }
        let env = BTreeMap::from([("BIG".to_string(), Some("x".repeat(VALUE_MAX + 1)))]);
        let e = compose(&settings(), None, &account(), &req(Some(&t), Some(&env))).unwrap_err();
        assert_eq!(e.code, code::TOO_LARGE);
        assert!(e.message.contains("BIG"), "{}", e.message);
        let env: BTreeMap<_, _> = (0..10).map(|i| (format!("V{i}"), Some("x".repeat(VALUE_MAX - 10)))).collect();
        let e = compose(&settings(), None, &account(), &req(Some(&t), Some(&env))).unwrap_err();
        assert_eq!(e.code, code::TOO_LARGE);
    }

    #[test]
    fn cwd_is_checked_and_defaults_to_home() {
        let t: Vec<String> = vec!["true".into()];
        let mut r = req(Some(&t), None);
        r.cwd = Some("/");
        let p = compose(&settings(), None, &account(), &r).unwrap();
        assert_eq!((p.cwd.as_str(), get(&p, "PWD")), ("/", Some("/")));
        for bad in ["relative/dir", "/nonexistent/dir", "/bin/sh"] {
            let mut r = req(Some(&t), None);
            r.cwd = Some(bad);
            let e = compose(&settings(), None, &account(), &r).unwrap_err();
            assert_eq!(e.code, code::BAD_REQUEST, "{bad}");
        }
        let mut a = account();
        a.home = "/usr".into();
        let p = compose(&settings(), None, &a, &req(Some(&t), None)).unwrap();
        assert_eq!(p.cwd, a.home);
        a.home = "/nonexistent/home".into();
        let p = compose(&settings(), None, &a, &req(Some(&t), None)).unwrap();
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
