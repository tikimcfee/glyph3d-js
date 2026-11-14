//! `g3d key` chords (`shift+enter`, `ctrl+c`, `alt+left`) as the `key` op's W3C key events.
//! The grammar is Ghostty's keybind trigger syntax (src/input/Binding.zig): modifiers joined by
//! `+`, the key last; `shift`, `ctrl` (`control`), `alt` (`opt`, `option`), `super` (`cmd`,
//! `command`); a key is a name or one character, and `+` alone is the plus key. A chord stands
//! for a US keyboard, as a terminal's own keybinds do: `shift+1` is `!`, `!` is `shift+1`.

use g3d_wire::msg::{Key, OptionAsAlt};

/// Named keys: (the names a chord may use, the W3C `code`, the W3C `key`, its text).
const NAMED: &[(&[&str], &str, &str, &str)] = &[
    (&["enter", "return", "cr"], "Enter", "Enter", ""),
    (&["tab"], "Tab", "Tab", ""),
    (&["escape", "esc"], "Escape", "Escape", ""),
    (&["backspace", "bs"], "Backspace", "Backspace", ""),
    (&["delete", "del"], "Delete", "Delete", ""),
    (&["insert", "ins"], "Insert", "Insert", ""),
    (&["home"], "Home", "Home", ""),
    (&["end"], "End", "End", ""),
    (&["pageup", "pgup"], "PageUp", "PageUp", ""),
    (&["pagedown", "pgdn", "pgdown"], "PageDown", "PageDown", ""),
    (&["arrowup", "up"], "ArrowUp", "ArrowUp", ""),
    (&["arrowdown", "down"], "ArrowDown", "ArrowDown", ""),
    (&["arrowleft", "left"], "ArrowLeft", "ArrowLeft", ""),
    (&["arrowright", "right"], "ArrowRight", "ArrowRight", ""),
    (&["space"], "Space", " ", " "),
    (&["plus"], "Equal", "+", "+"),
    (&["numpadenter", "kpenter"], "NumpadEnter", "Enter", ""),
];

/// The US layout: each key's character, then with Shift (letters aside).
const US: &[(char, char, &str)] = &[
    ('1', '!', "Digit1"),
    ('2', '@', "Digit2"),
    ('3', '#', "Digit3"),
    ('4', '$', "Digit4"),
    ('5', '%', "Digit5"),
    ('6', '^', "Digit6"),
    ('7', '&', "Digit7"),
    ('8', '*', "Digit8"),
    ('9', '(', "Digit9"),
    ('0', ')', "Digit0"),
    ('-', '_', "Minus"),
    ('=', '+', "Equal"),
    ('[', '{', "BracketLeft"),
    (']', '}', "BracketRight"),
    ('\\', '|', "Backslash"),
    (';', ':', "Semicolon"),
    ('\'', '"', "Quote"),
    (',', '<', "Comma"),
    ('.', '>', "Period"),
    ('/', '?', "Slash"),
    ('`', '~', "Backquote"),
];

/// A US key's character with Shift held: a letter's capital, a digit's or punctuation key's
/// shifted character (`1` → `!`); `None` for a character that isn't on a US key.
pub fn us_shifted(c: char) -> Option<char> {
    if c.is_ascii_lowercase() {
        return Some(c.to_ascii_uppercase());
    }
    US.iter().find(|(u, ..)| *u == c).map(|(_, s, _)| *s)
}

fn modifier(name: &str) -> Option<&'static str> {
    Some(match name {
        "shift" => "Shift",
        "ctrl" | "control" => "Control",
        "alt" | "opt" | "option" => "Alt",
        "super" | "cmd" | "command" => "Meta",
        _ => return None,
    })
}

/// One chord as a `key` event (its `handle` 0, for the caller to fill).
pub fn parse(chord: &str) -> Result<Key, String> {
    let (mods_part, key_part) = if chord == "+" {
        ("", "+")
    } else if let Some(m) = chord.strip_suffix("++") {
        (m, "+")
    } else {
        match chord.rsplit_once('+') {
            Some((m, k)) => (m, k),
            None => ("", chord),
        }
    };
    if key_part.is_empty() {
        return Err(format!("{chord:?}: no key after the modifiers"));
    }
    let mut mods: Vec<String> = Vec::new();
    for m in mods_part.split('+').filter(|m| !m.is_empty()) {
        let w3c = modifier(&m.to_ascii_lowercase())
            .ok_or_else(|| format!("{chord:?}: unknown modifier {m:?} (shift, ctrl, alt, super)"))?;
        if !mods.iter().any(|x| x == w3c) {
            mods.push(w3c.to_owned());
        }
    }
    let shift = |mods: &mut Vec<String>| {
        if !mods.iter().any(|m| m == "Shift") {
            mods.push("Shift".into());
        }
    };
    let held = |mods: &Vec<String>, m: &str| mods.iter().any(|x| x == m);
    let mut chars = key_part.chars();
    let (first, rest) = (chars.next(), chars.next());
    let (code, key, text) = match (first, rest) {
        (Some(c), None) => {
            if c.is_ascii_alphabetic() {
                if c.is_ascii_uppercase() {
                    shift(&mut mods);
                }
                let k = if held(&mods, "Shift") { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() };
                (format!("Key{}", c.to_ascii_uppercase()), k.to_string(), k.to_string())
            } else if let Some((plain, shifted, code)) = US.iter().find(|(p, s, _)| *p == c || *s == c) {
                if c == *shifted {
                    shift(&mut mods);
                }
                let k = if held(&mods, "Shift") { *shifted } else { *plain };
                (code.to_string(), k.to_string(), k.to_string())
            } else if c == ' ' {
                ("Space".into(), " ".into(), " ".into())
            } else if c.is_control() {
                return Err(format!("{chord:?}: a control character; name the key (ctrl+c, enter, tab)"));
            } else {
                // Off the US layout (é, ß): its character, as a layout that has it types it.
                (String::new(), c.to_string(), c.to_string())
            }
        }
        _ => {
            let name: String = key_part.to_ascii_lowercase().chars().filter(|c| *c != '_' && *c != '-').collect();
            if let Some(f) = name.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=24).contains(n))
            {
                (format!("F{f}"), format!("F{f}"), String::new())
            } else if let Some((_, code, key, text)) = NAMED.iter().find(|(names, ..)| names.contains(&name.as_str())) {
                if key_part.eq_ignore_ascii_case("plus") {
                    shift(&mut mods);
                }
                (code.to_string(), key.to_string(), text.to_string())
            } else {
                return Err(format!(
                    "{chord:?}: unknown key {key_part:?} (a character, or enter, tab, esc, backspace, delete, \
                     insert, home, end, pageup, pagedown, up, down, left, right, space, plus, f1..f24)"
                ));
            }
        }
    };
    Ok(Key { handle: 0, code, key, mods, text, action: None, option_as_alt: OptionAsAlt::Auto })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> (String, String, Vec<String>, String) {
        let k = parse(s).unwrap();
        (k.code, k.key, k.mods, k.text)
    }

    fn t(code: &str, key: &str, mods: &[&str], text: &str) -> (String, String, Vec<String>, String) {
        (code.into(), key.into(), mods.iter().map(|m| m.to_string()).collect(), text.into())
    }

    #[test]
    fn chords() {
        assert_eq!(p("shift+enter"), t("Enter", "Enter", &["Shift"], ""));
        assert_eq!(p("ctrl+c"), t("KeyC", "c", &["Control"], "c"));
        assert_eq!(p("alt+left"), t("ArrowLeft", "ArrowLeft", &["Alt"], ""));
        assert_eq!(p("Control+Shift+a"), t("KeyA", "A", &["Control", "Shift"], "A"));
        assert_eq!(p("A"), t("KeyA", "A", &["Shift"], "A"));
        assert_eq!(p("shift+1"), t("Digit1", "!", &["Shift"], "!"));
        assert_eq!(p("!"), t("Digit1", "!", &["Shift"], "!"));
        assert_eq!(p("ctrl++"), t("Equal", "+", &["Control", "Shift"], "+"));
        assert_eq!(p("+"), t("Equal", "+", &["Shift"], "+"));
        assert_eq!(p("opt+é"), t("", "é", &["Alt"], "é"));
        assert_eq!(p("cmd+arrow_up"), t("ArrowUp", "ArrowUp", &["Meta"], ""));
        assert_eq!(p("f12"), t("F12", "F12", &[], ""));
        assert_eq!(p("space"), t("Space", " ", &[], " "));
        assert_eq!(p("esc"), t("Escape", "Escape", &[], ""));
    }

    #[test]
    fn bad_chords_say_why() {
        assert!(parse("hyper+a").unwrap_err().contains("unknown modifier"));
        assert!(parse("ctrl+").unwrap_err().contains("no key"));
        assert!(parse("ctrl+nope").unwrap_err().contains("unknown key"));
        assert!(parse("f25").unwrap_err().contains("unknown key"));
    }
}
