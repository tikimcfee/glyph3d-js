//! What `g3d new` sends of its own environment (DESIGN.md, "Environment"): the whole of it as
//! the terminal's base (`create.env_base`), as a multiplexer's new session starts from the shell
//! that asked (screen, dtach, zellij, tmux's first session); `--clean` sends none. `-e` adds to
//! the request's `env`. And `g3d env`'s rendering.

use g3d_wire::{ENV_VALUE_MAX, EnvVar, env_name_ok};
use std::collections::BTreeMap;
use std::ffi::OsString;

/// The caller's environment as the protocol carries it, and the names it can't: a name outside
/// `[A-Za-z_][A-Za-z0-9_]*` (bash's exported functions, `BASH_FUNC_f%%`), a name or value that
/// isn't UTF-8, or a variable too long for `execve` (no program could start with it).
pub fn caller_env(vars: impl IntoIterator<Item = (OsString, OsString)>) -> (BTreeMap<String, String>, Vec<String>) {
    let mut env = BTreeMap::new();
    let mut skipped = Vec::new();
    for (k, v) in vars {
        match (k.into_string(), v.into_string()) {
            (Ok(k), Ok(v)) if env_name_ok(&k) && k.len() + v.len() + 2 <= ENV_VALUE_MAX => {
                env.insert(k, v);
            }
            (Ok(k), _) => skipped.push(k),
            (Err(k), _) => skipped.push(k.to_string_lossy().into_owned()),
        }
    }
    skipped.sort();
    (env, skipped)
}

/// `-e` arguments as the request's `env`: `NAME=VALUE` sets; `NAME` passes this shell's `NAME`,
/// or removes it when this shell has none (`get`). A value the protocol can't carry (not UTF-8)
/// is an error: the person asked for that name by name.
pub fn request_env(
    args: &[String],
    get: impl Fn(&str) -> Option<OsString>,
) -> Result<BTreeMap<String, Option<String>>, String> {
    let mut env = BTreeMap::new();
    for a in args {
        let (k, v) = match a.split_once('=') {
            Some((k, v)) => (k, Some(v.to_owned())),
            None => match get(a).map(OsString::into_string) {
                None => (a.as_str(), None),
                Some(Ok(v)) => (a.as_str(), Some(v)),
                Some(Err(_)) => {
                    return Err(format!("-e {a}: this shell's {a} is not UTF-8, which the protocol can't carry"));
                }
            },
        };
        if !env_name_ok(k) {
            return Err(format!("-e {a:?}: a name is [A-Za-z_][A-Za-z0-9_]*"));
        }
        env.insert(k.to_owned(), v);
    }
    Ok(env)
}

/// `g3d env`: one line per variable, its source (and where within it) before it.
pub fn render(env: &[EnvVar]) -> String {
    let tag = |v: &EnvVar| {
        let s = serde_json::to_value(v.source).ok().and_then(|s| s.as_str().map(str::to_owned)).unwrap_or_default();
        match &v.via {
            Some(via) => format!("{s} ({via})"),
            None => s,
        }
    };
    let width = env.iter().map(|v| tag(v).len()).max().unwrap_or(0);
    let mut out = String::new();
    for v in env {
        let value = if v.value.chars().any(char::is_control) { format!("{:?}", v.value) } else { v.value.clone() };
        out.push_str(&format!("{:<width$}  {}={}\n", tag(v), v.name, value));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use g3d_wire::EnvSource;
    use std::os::unix::ffi::OsStringExt;

    #[test]
    fn the_whole_environment_is_sent_but_what_the_protocol_cant_carry() {
        let os = |s: &str| OsString::from(s);
        let (env, skipped) = caller_env([
            (os("FOO"), os("custom")),
            (os("DISPLAY"), os(":99")),
            (os("REX_SESSION"), os("r")),
            (os("TERM"), os("xterm-ghostty")),
            (os("BASH_FUNC_f%%"), os("() { :; }")),
            (os("BIN"), OsString::from_vec(vec![0xff])),
            (os("HUGE"), os(&"x".repeat(ENV_VALUE_MAX))),
        ]);
        assert_eq!(env.keys().map(String::as_str).collect::<Vec<_>>(), ["DISPLAY", "FOO", "REX_SESSION", "TERM"]);
        assert_eq!(skipped, ["BASH_FUNC_f%%", "BIN", "HUGE"]);
    }

    #[test]
    fn dash_e_sets_passes_or_removes() {
        let get = |k: &str| match k {
            "HERE" => Some(OsString::from("here")),
            "LATIN1" => Some(OsString::from_vec(b"caf\xe9".to_vec())),
            _ => None,
        };
        let env = request_env(&["A=1".into(), "B=".into(), "C=x=y".into(), "HERE".into(), "GONE".into()], get).unwrap();
        assert_eq!(env["A"], Some("1".into()));
        assert_eq!(env["B"], Some(String::new()));
        assert_eq!(env["C"], Some("x=y".into()));
        assert_eq!(env["HERE"], Some("here".into()));
        assert_eq!(env["GONE"], None);
        assert!(request_env(&["BAD-NAME=1".into()], get).is_err());
        assert!(request_env(&["=1".into()], get).is_err());
        // Asked for by name, a value that isn't UTF-8 is said, never sent as "unset".
        let e = request_env(&["LATIN1".into()], get).unwrap_err();
        assert!(e.contains("LATIN1") && e.contains("UTF-8"), "{e}");
    }

    #[test]
    fn env_renders_each_variable_with_its_source() {
        let v = |name: &str, value: &str, source, via: Option<&str>| EnvVar {
            name: name.into(),
            value: value.into(),
            source,
            via: via.map(str::to_owned),
        };
        let out = render(&[
            v("DISPLAY", ":0", EnvSource::Session, Some("systemd-user")),
            v("FOO", "a\nb", EnvSource::Caller, None),
            v("TERM", "xterm-256color", EnvSource::Termd, None),
        ]);
        assert_eq!(
            out,
            "session (systemd-user)  DISPLAY=:0\ncaller                  FOO=\"a\\nb\"\ntermd                   TERM=xterm-256color\n"
        );
    }
}
