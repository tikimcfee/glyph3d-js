//! The `key` op (PROTOCOL.md, "`key`"): a key event as the client's OS resolved it (W3C
//! `KeyboardEvent` semantics), made a libghostty key event and encoded by libghostty's
//! `KeyEncoder` against the terminal's live keyboard modes: Kitty keyboard flags, modifyOtherKeys,
//! application cursor and keypad keys, alt-sends-escape. That is Ghostty's own key path
//! (src/input/key_encode.zig), with the client standing in for Ghostty's apprt: the client says
//! which physical key (`code`), which logical key (`key`), the modifiers and the text the key
//! made; termd says what bytes those are in this terminal, now. It runs on the terminal's owner
//! thread, the one that holds its `Terminal`.

use g3d_wire::code;
use g3d_wire::msg::{Key as WireKey, KeyAction, OptionAsAlt as WireOptionAsAlt};
use libghostty_vt::Terminal;
use libghostty_vt::key::{Action, Encoder, Event, Key, KittyKeyFlags, Mods, OptionAsAlt};
use std::collections::HashMap;
use std::sync::OnceLock;

/// The most `text` one key event carries (an IME's committed phrase fits; pasted text goes by
/// `paste`).
pub const TEXT_MAX: usize = 4096;

/// A `key` request, checked: what libghostty's key event gets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec {
    pub key: Key,
    pub mods: Mods,
    /// The modifiers that went into making `text` (Shift for `A`, Option for `å`), which an
    /// encoder must not report again.
    pub consumed: Mods,
    pub text: Option<String>,
    /// The key's character with no modifiers, which the Kitty protocol reports.
    pub unshifted: Option<char>,
    pub action: Action,
    /// Whether Alt is Alt for this event (Ghostty's `macos-option-as-alt`, resolved from the
    /// request's `option_as_alt`); false: Option types characters.
    pub option_as_alt: bool,
}

/// Ghostty's key enum is named by W3C `KeyboardEvent.code` values (src/input/key.zig), the
/// letter keys as `A`..`Z` where the W3C says `KeyA`..`KeyZ`; this is that table by W3C name.
fn by_code() -> &'static HashMap<String, Key> {
    static TABLE: OnceLock<HashMap<String, Key>> = OnceLock::new();
    TABLE.get_or_init(|| {
        (1..1024)
            .filter_map(|i| Key::try_from(i).ok())
            .map(|k| {
                let name = format!("{k:?}");
                let w3c = if name.len() == 1 { format!("Key{name}") } else { name };
                (w3c, k)
            })
            .collect()
    })
}

/// Ghostty's `Key.codepoint()` (src/input/key.zig `codepoint_map`): the character a key makes on
/// a US layout, the fallback for the unshifted character when the client's `key` can't give it.
const US: &[(char, Key)] = &[
    ('a', Key::A),
    ('b', Key::B),
    ('c', Key::C),
    ('d', Key::D),
    ('e', Key::E),
    ('f', Key::F),
    ('g', Key::G),
    ('h', Key::H),
    ('i', Key::I),
    ('j', Key::J),
    ('k', Key::K),
    ('l', Key::L),
    ('m', Key::M),
    ('n', Key::N),
    ('o', Key::O),
    ('p', Key::P),
    ('q', Key::Q),
    ('r', Key::R),
    ('s', Key::S),
    ('t', Key::T),
    ('u', Key::U),
    ('v', Key::V),
    ('w', Key::W),
    ('x', Key::X),
    ('y', Key::Y),
    ('z', Key::Z),
    ('0', Key::Digit0),
    ('1', Key::Digit1),
    ('2', Key::Digit2),
    ('3', Key::Digit3),
    ('4', Key::Digit4),
    ('5', Key::Digit5),
    ('6', Key::Digit6),
    ('7', Key::Digit7),
    ('8', Key::Digit8),
    ('9', Key::Digit9),
    (';', Key::Semicolon),
    (' ', Key::Space),
    ('\'', Key::Quote),
    (',', Key::Comma),
    ('`', Key::Backquote),
    ('.', Key::Period),
    ('/', Key::Slash),
    ('-', Key::Minus),
    ('=', Key::Equal),
    ('[', Key::BracketLeft),
    (']', Key::BracketRight),
    ('\\', Key::Backslash),
    ('\t', Key::Tab),
    ('0', Key::Numpad0),
    ('1', Key::Numpad1),
    ('2', Key::Numpad2),
    ('3', Key::Numpad3),
    ('4', Key::Numpad4),
    ('5', Key::Numpad5),
    ('6', Key::Numpad6),
    ('7', Key::Numpad7),
    ('8', Key::Numpad8),
    ('9', Key::Numpad9),
    ('.', Key::NumpadDecimal),
    ('/', Key::NumpadDivide),
    ('*', Key::NumpadMultiply),
    ('-', Key::NumpadSubtract),
    ('+', Key::NumpadAdd),
    ('=', Key::NumpadEqual),
];

fn us_char(k: Key) -> Option<char> {
    US.iter().find(|(_, key)| *key == k).map(|(c, _)| *c)
}

fn us_key(c: char) -> Option<Key> {
    US.iter().find(|(ch, _)| *ch == c).map(|(_, k)| *k)
}

/// The one character of `s`, if it is exactly one.
fn one_char(s: &str) -> Option<char> {
    let mut it = s.chars();
    let c = it.next()?;
    it.next().is_none().then_some(c)
}

/// `c` lowercased when that is one character (`A` → `a`, `Ф` → `ф`), else `c`.
fn lower(c: char) -> char {
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// A keypad key with NumLock off: the browser names the physical key (`Numpad8`) and the logical
/// one (`ArrowUp`). Ghostty's apprt hands its encoder the keypad's navigation key then
/// (`numpad_up`, from the keysym `KP_Up`), which is the cursor key's bytes (`CSI A`) and Kitty's
/// `KP_UP`; the digit would type `8`.
fn keypad_navigation(physical: Key, logical: &str) -> Option<Key> {
    use Key::*;
    let keypad = matches!(
        physical,
        Numpad0
            | Numpad1
            | Numpad2
            | Numpad3
            | Numpad4
            | Numpad5
            | Numpad6
            | Numpad7
            | Numpad8
            | Numpad9
            | NumpadDecimal
    );
    if !keypad {
        return None;
    }
    Some(match logical {
        "ArrowUp" => NumpadUp,
        "ArrowDown" => NumpadDown,
        "ArrowLeft" => NumpadLeft,
        "ArrowRight" => NumpadRight,
        "Home" => NumpadHome,
        "End" => NumpadEnd,
        "PageUp" => NumpadPageUp,
        "PageDown" => NumpadPageDown,
        "Insert" => NumpadInsert,
        "Delete" => NumpadDelete,
        // Keypad 5 with NumLock off (X11's KP_Begin).
        "Clear" => NumpadBegin,
        _ => return None,
    })
}

/// W3C modifier key names (UI Events KeyboardEvent key values, "Modifier keys") → libghostty's.
/// The ones a terminal has no bit for (`AltGraph`, `Fn`, the lock keys but Caps and Num) are
/// accepted and dropped: they only ever shaped `text`, which the client resolved.
fn modifier(name: &str) -> Result<Mods, String> {
    Ok(match name {
        "Shift" => Mods::SHIFT,
        "Control" => Mods::CTRL,
        "Alt" => Mods::ALT,
        "Meta" | "Super" => Mods::SUPER,
        "CapsLock" => Mods::CAPS_LOCK,
        "NumLock" => Mods::NUM_LOCK,
        "AltGraph" | "Fn" | "FnLock" | "Hyper" | "ScrollLock" | "Symbol" | "SymbolLock" => Mods::empty(),
        other => {
            return Err(format!(
                "unknown modifier {other:?}: give W3C names (Shift, Control, Alt, Meta, CapsLock, NumLock)"
            ));
        }
    })
}

/// Checks a `key` request and works out what libghostty's event needs that the W3C event
/// doesn't carry directly: the physical key when `code` is missing, the unshifted character and
/// the consumed modifiers. Errors are `(code, message)` for the reply.
pub fn spec(k: &WireKey) -> Result<Spec, (&'static str, String)> {
    let bad = |m: String| (code::BAD_REQUEST, m);
    if k.text.len() > TEXT_MAX {
        return Err((
            code::TOO_LARGE,
            format!("{} B of text in one key event (at most {TEXT_MAX}); paste it", k.text.len()),
        ));
    }
    if let Some(c) = k.text.chars().find(|c| c.is_control()) {
        return Err(bad(format!(
            "text holds the control character U+{:04X}: send the key that makes it (code, key, mods) and no text",
            u32::from(c)
        )));
    }
    let mut mods = Mods::empty();
    for m in &k.mods {
        mods |= modifier(m).map_err(bad)?;
    }
    let one = one_char(&k.key);
    // The physical key: `code`; else a named `key` (W3C named key values and codes agree for
    // Enter, Tab, Escape, the arrows, F1..F24, …); else the US key of a one-character `key`.
    let table = by_code();
    let key = table
        .get(k.code.as_str())
        .or_else(|| table.get(k.key.as_str()))
        .copied()
        .or_else(|| one.and_then(|c| us_key(lower(c))))
        .unwrap_or(Key::Unidentified);
    let key = keypad_navigation(key, &k.key).unwrap_or(key);
    if key == Key::Unidentified && k.text.is_empty() {
        return Err(bad(format!("key names no key: code {:?}, key {:?} and no text", k.code, k.key)));
    }
    let shift = mods.contains(Mods::SHIFT);
    let alt = mods.contains(Mods::ALT);
    // The unshifted character: the client's own `key` when no modifier that changes characters
    // is held (its layout, not ours); a shifted letter lowercased; else the US layout's, as
    // Ghostty's `Key.codepoint()` gives it; else the key's own character.
    let unshifted = match one {
        Some(c) if !shift && !alt => Some(lower(c)),
        Some(c) if !alt && lower(c) != c => Some(lower(c)),
        _ => None,
    }
    .or_else(|| us_char(key))
    .or(one)
    .filter(|c| !c.is_control() || *c == '\t');
    let mut text = (!k.text.is_empty()).then(|| k.text.clone());
    let base = unshifted.map(String::from);
    // Option made the text: Alt is held and the text is another character than the key's own
    // (`å` on A), as a Mac's Option types one.
    let option_char = alt && text.as_ref().is_some_and(|t| base.as_deref() != Some(t.to_lowercase().as_str()));
    let option_as_alt = match k.option_as_alt {
        WireOptionAsAlt::Auto => !option_char,
        WireOptionAsAlt::True => true,
        WireOptionAsAlt::False => false,
    };
    // Alt as Alt over Option's character: the key's own character instead, with Shift as a US
    // key has it, as Ghostty's macOS apprt translates the key without Option.
    if option_as_alt
        && option_char
        && let Some(c) = unshifted
    {
        text = Some(if shift { g3d::chord::us_shifted(c).unwrap_or(c) } else { c }.to_string());
    }
    let mut consumed = Mods::empty();
    if let Some(t) = &text {
        if shift && base.as_deref() != Some(t.as_str()) {
            consumed |= Mods::SHIFT;
        }
        if !option_as_alt && option_char {
            consumed |= Mods::ALT;
        }
    }
    let action = match k.action.unwrap_or_default() {
        KeyAction::Press => Action::Press,
        KeyAction::Repeat => Action::Repeat,
        KeyAction::Release => Action::Release,
    };
    Ok(Spec { key, mods, consumed, text, unshifted, action, option_as_alt })
}

/// One terminal's key encoder and the event it reuses, on its owner thread.
pub struct Keyboard {
    enc: Encoder<'static>,
    ev: Event<'static>,
}

impl Keyboard {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            enc: Encoder::new().map_err(|e| format!("key encoder: {e}"))?,
            ev: Event::new().map_err(|e| format!("key event: {e}"))?,
        })
    }

    /// The bytes `s` is in `term`'s current modes (empty: it encodes to nothing, as a bare
    /// modifier or a release does outside Kitty's event reporting).
    ///
    /// Alt as a character modifier (`s.option_as_alt` false) is Ghostty's `macos-option-as-alt =
    /// false`, on every daemon platform. libghostty reads that option only when it is built for
    /// macOS (key_encode.zig tests the target at compile time), so termd pins it true everywhere
    /// and makes false's three differences itself, around the same encoder: no ESC prefix for Alt
    /// (mode 1036 off for the event), modifyOtherKeys not counting Alt (the event encoded without
    /// it), and Kitty's associated text kept with Alt held ([`associate_text`]).
    pub fn encode(&mut self, term: &Terminal<'_, '_>, s: &Spec) -> Result<Vec<u8>, String> {
        self.enc.set_options_from_terminal(term).set_macos_option_as_alt(OptionAsAlt::True);
        let (kitty, modify_other_keys) = self.modes(term)?;
        if let Some(bytes) = legacy_chord(s)
            && kitty == KittyKeyFlags::DISABLED
            && !modify_other_keys
        {
            return Ok(bytes);
        }
        if s.option_as_alt || !s.mods.contains(Mods::ALT) {
            return self.encode_event(s);
        }
        if kitty != KittyKeyFlags::DISABLED {
            let mut out = self.encode_event(s)?;
            if kitty.contains(KittyKeyFlags::REPORT_ASSOCIATED) {
                associate_text(&mut out, s);
            }
            return Ok(out);
        }
        self.enc.set_alt_esc_prefix(false);
        // modifyOtherKeys 2 reads a one-character key's modifiers without Alt (key_encode.zig,
        // `legacy`); taking Alt off the event changes nothing else on the way there for a key that
        // isn't a function or keypad key (only they have PC-style sequences, which come first).
        if modify_other_keys && s.text.as_deref().and_then(one_char).is_some() && !is_keypad(s.key) {
            let bare = Spec { mods: s.mods - Mods::ALT, consumed: s.consumed - Mods::ALT, ..s.clone() };
            return self.encode_event(&bare);
        }
        self.encode_event(s)
    }

    fn encode_event(&mut self, s: &Spec) -> Result<Vec<u8>, String> {
        self.ev
            .set_action(s.action)
            .set_key(s.key)
            .set_mods(s.mods)
            .set_consumed_mods(s.consumed)
            .set_composing(false)
            .set_utf8(s.text.clone())
            .set_unshifted_codepoint(s.unshifted.unwrap_or('\0'));
        let mut out = Vec::new();
        self.enc.encode_to_vec(&self.ev, &mut out).map_err(|e| format!("key encoding: {e}"))?;
        Ok(out)
    }

    /// The keyboard modes the program asked for: its Kitty flags, and (with none) whether
    /// modifyOtherKeys state 2 is on. libghostty has no getter for modifyOtherKeys; the encoder,
    /// set from the terminal just now, answers it: Ctrl+P is `0x10` unless state 2 is on
    /// (`CSI 27;5;112~`).
    fn modes(&mut self, term: &Terminal<'_, '_>) -> Result<(KittyKeyFlags, bool), String> {
        let kitty = term.kitty_keyboard_flags().map_err(|e| format!("kitty keyboard flags: {e}"))?;
        if kitty != KittyKeyFlags::DISABLED {
            return Ok((kitty, false));
        }
        let probe = Spec {
            key: Key::P,
            mods: Mods::CTRL,
            consumed: Mods::empty(),
            text: Some("p".into()),
            unshifted: Some('p'),
            action: Action::Press,
            option_as_alt: true,
        };
        Ok((kitty, self.encode_event(&probe)? != [0x10]))
    }
}

/// Kitty's associated text (flag 16) for an event whose Alt is Option, the character modifier:
/// Ghostty's encoder leaves it out whenever Alt is held, unless `macos-option-as-alt` is false
/// (`alt_prevents_text`), and keeps it out for Control and Super either way. `out` is the
/// encoder's sequence for the event; when it is a `CSI … u` (not the bare text it sends for an
/// unmodified key), the text goes last as Ghostty writes it: `;` and the code points, `:` between,
/// control characters skipped. Alt held means the modifier field is there, so one `;`.
fn associate_text(out: &mut Vec<u8>, s: &Spec) {
    if s.action == Action::Release || s.mods.intersects(Mods::CTRL | Mods::SUPER) {
        return;
    }
    let Some(text) = &s.text else { return };
    if !(out.starts_with(b"\x1b[") && out.last() == Some(&b'u')) {
        return;
    }
    let cps: Vec<String> = text.chars().filter(|c| !c.is_control()).map(|c| u32::from(c).to_string()).collect();
    if cps.is_empty() {
        return;
    }
    out.pop();
    out.push(b';');
    out.extend_from_slice(cps.join(":").as_bytes());
    out.push(b'u');
}

/// A keypad key that types: it has PC-style sequences (keypad application mode,
/// function_keys.zig) that libghostty matches before modifyOtherKeys.
fn is_keypad(k: Key) -> bool {
    use Key::*;
    matches!(
        k,
        Numpad0
            | Numpad1
            | Numpad2
            | Numpad3
            | Numpad4
            | Numpad5
            | Numpad6
            | Numpad7
            | Numpad8
            | Numpad9
            | NumpadDecimal
            | NumpadDivide
            | NumpadMultiply
            | NumpadSubtract
            | NumpadAdd
            | NumpadEnter
    )
}

/// What a program that asked for no keyboard mode (no Kitty flags, no modifyOtherKeys) gets for
/// the chords where Ghostty's legacy encoding speaks a protocol the program never asked for:
/// xterm's bytes with modifyOtherKeys off, which a plain readline program reads (and the wall's
/// own encoder sent before termd encoded keys). `None`: Ghostty's encoding stands.
///
/// - Enter with Shift, Ctrl or Super is `\r` (Ghostty: `CSI 27;2;13~`, which bash runs as junk);
///   with Alt too, `ESC \r`.
/// - Ctrl+Shift+letter is the letter's C0 byte, as Ctrl+letter (Ghostty: fixterms' `CSI 97;6u`).
/// - Ctrl+`[`, Ctrl+I and Ctrl+M are ESC, TAB and CR (Ghostty leaves them to fixterms' CSI u
///   on purpose, key_encode.zig `ctrlSeq`); with Alt, ESC first.
/// - Ctrl+Backspace is `^W`, readline's and zsh's word rubout: VS Code's terminal binds it so
///   (`deleteWordLeft`), since a browser keeps Ctrl+W for itself (Ghostty: `^H`, one character).
fn legacy_chord(s: &Spec) -> Option<Vec<u8>> {
    if !matches!(s.action, Action::Press | Action::Repeat) {
        return None;
    }
    let (shift, ctrl, alt, sup) = (
        s.mods.contains(Mods::SHIFT),
        s.mods.contains(Mods::CTRL),
        s.mods.contains(Mods::ALT),
        s.mods.contains(Mods::SUPER),
    );
    let with_alt = |b: u8| if alt { vec![0x1b, b] } else { vec![b] };
    match s.key {
        Key::Enter | Key::NumpadEnter if (shift || ctrl || sup) && s.text.is_none() => Some(with_alt(b'\r')),
        Key::Backspace if ctrl && !shift && !alt && !sup => Some(vec![0x17]),
        _ if ctrl && !sup => match s.unshifted {
            Some(c @ 'a'..='z') if shift => Some(with_alt(c as u8 - b'a' + 1)),
            Some('[') if !shift => Some(with_alt(0x1b)),
            Some('i') if !shift => Some(with_alt(b'\t')),
            Some('m') if !shift => Some(with_alt(b'\r')),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(code: &str, key: &str, mods: &[&str], text: &str) -> WireKey {
        WireKey {
            handle: 1,
            code: code.into(),
            key: key.into(),
            mods: mods.iter().map(|m| m.to_string()).collect(),
            text: text.into(),
            action: None,
            option_as_alt: WireOptionAsAlt::Auto,
        }
    }

    /// Encodes `k` in a fresh terminal that has read `setup`.
    fn enc(setup: &[u8], k: &WireKey) -> Vec<u8> {
        let mut t = Terminal::new(80, 24).unwrap();
        t.vt_write(setup);
        Keyboard::new().unwrap().encode(&t, &spec(k).unwrap()).unwrap()
    }

    /// [`w`] with `option_as_alt` set.
    fn wo(code: &str, key: &str, mods: &[&str], text: &str, o: WireOptionAsAlt) -> WireKey {
        WireKey { option_as_alt: o, ..w(code, key, mods, text) }
    }

    /// The program's keyboard modes the Option table is measured in: none, Kitty disambiguate,
    /// Kitty all flags, modifyOtherKeys 2.
    const MODES: [&[u8]; 4] = [b"", b"\x1b[>1u", b"\x1b[>31u", b"\x1b[>4;2m"];

    /// `k` in each of [`MODES`].
    fn in_modes(k: &WireKey) -> Vec<Vec<u8>> {
        MODES.iter().map(|m| enc(m, k)).collect()
    }

    /// What a macOS browser sends for Option+A on a US layout (Chrome and Safari alike: `key` is
    /// the character Option typed, `altKey` set) reaches the program as Ghostty's default
    /// `macos-option-as-alt = false` sends it, in every mode (MACOS.md, "Keys"); an Alt whose text
    /// is the key's own character (`g3d key alt+a`, a Linux browser) is Alt in every mode.
    #[test]
    fn a_macos_option_character_is_its_text_and_alt_as_alt_is_alt() {
        let opt_a = w("KeyA", "å", &["Alt"], "å");
        let ghostty_default: [&[u8]; 4] = ["å".as_bytes(), "å".as_bytes(), b"\x1b[97;3;229u", "å".as_bytes()];
        assert_eq!(in_modes(&opt_a), ghostty_default);
        let alt_a = w("KeyA", "a", &["Alt"], "a");
        let alt: [&[u8]; 4] = [b"\x1ba", b"\x1b[97;3u", b"\x1b[97;3u", b"\x1b[27;3;97~"];
        assert_eq!(in_modes(&alt_a), alt);
        // Shift+Option, Ctrl+Option: Option's character, the other modifiers as they are.
        let opt_shift_a = w("KeyA", "Å", &["Alt", "Shift"], "Å");
        assert_eq!(enc(b"", &opt_shift_a), "Å".as_bytes());
        assert_eq!(enc(b"\x1b[>31u", &opt_shift_a), b"\x1b[97:197;4;197u");
        let ctrl_opt_a = w("KeyA", "å", &["Alt", "Control"], "å");
        assert_eq!(enc(b"\x1b[>4;2m", &ctrl_opt_a), b"\x1b[27;5;229~");
        assert_eq!(enc(b"\x1b[>31u", &ctrl_opt_a), b"\x1b[97;7u", "Control keeps the text out");
        // A held key repeats with its text after the event type.
        let repeat = WireKey { action: Some(KeyAction::Repeat), ..opt_a.clone() };
        assert_eq!(enc(b"\x1b[>31u", &repeat), b"\x1b[97;3:2;229u");
        // A dead key (Option+E) types nothing; the next key's text is the composed character.
        assert_eq!(enc(b"", &w("KeyE", "é", &[], "é")), "é".as_bytes());
    }

    /// `option_as_alt: false` is Ghostty's default for every event: Alt never ESC-prefixes, isn't
    /// counted by modifyOtherKeys and keeps Kitty's text, so even `alt+a` types `a`. Keys without
    /// text keep Alt (an arrow's modifier field).
    #[test]
    fn option_as_alt_false_makes_alt_a_character_modifier() {
        let f = WireOptionAsAlt::False;
        let ghostty_default: [&[u8]; 4] = ["å".as_bytes(), "å".as_bytes(), b"\x1b[97;3;229u", "å".as_bytes()];
        assert_eq!(in_modes(&wo("KeyA", "å", &["Alt"], "å", f)), ghostty_default);
        let alt_a: [&[u8]; 4] = [b"a", b"\x1b[97;3u", b"\x1b[97;3;97u", b"a"];
        assert_eq!(in_modes(&wo("KeyA", "a", &["Alt"], "a", f)), alt_a);
        let left = wo("ArrowLeft", "ArrowLeft", &["Alt"], "", f);
        assert_eq!(in_modes(&left), in_modes(&w("ArrowLeft", "ArrowLeft", &["Alt"], "")));
        assert_eq!(enc(b"", &left), b"\x1b[1;3D");
        // Control still makes its byte, ESC-prefixed for Alt as Ghostty's C0 path does.
        assert_eq!(enc(b"", &wo("KeyC", "c", &["Alt", "Control"], "c", f)), b"\x1b\x03");
    }

    /// `option_as_alt: true` is Alt for every event: Option+A is Alt+A, the key's own character
    /// (with Shift as a US key has it) in place of Option's.
    #[test]
    fn option_as_alt_true_makes_option_alt() {
        let t = WireOptionAsAlt::True;
        let alt_a: [&[u8]; 4] = [b"\x1ba", b"\x1b[97;3u", b"\x1b[97;3u", b"\x1b[27;3;97~"];
        assert_eq!(in_modes(&wo("KeyA", "å", &["Alt"], "å", t)), alt_a);
        assert_eq!(in_modes(&wo("KeyA", "a", &["Alt"], "a", t)), alt_a);
        assert_eq!(enc(b"", &wo("Digit1", "⁄", &["Alt", "Shift"], "⁄", t)), b"\x1b!");
        assert_eq!(enc(b"", &wo("KeyA", "Å", &["Alt", "Shift"], "Å", t)), b"\x1bA");
    }

    #[test]
    fn the_w3c_code_table_covers_the_keys_a_browser_sends() {
        for (code, key) in [
            ("KeyA", Key::A),
            ("KeyZ", Key::Z),
            ("Digit1", Key::Digit1),
            ("Enter", Key::Enter),
            ("ArrowLeft", Key::ArrowLeft),
            ("ShiftLeft", Key::ShiftLeft),
            ("NumpadEnter", Key::NumpadEnter),
            ("F12", Key::F12),
            ("Backquote", Key::Backquote),
        ] {
            assert_eq!(by_code().get(code), Some(&key), "{code}");
        }
    }

    #[test]
    fn a_key_is_found_by_code_then_by_name_then_by_character() {
        assert_eq!(spec(&w("KeyQ", "a", &[], "a")).unwrap().key, Key::Q, "the physical key wins (AZERTY)");
        assert_eq!(spec(&w("", "Enter", &[], "")).unwrap().key, Key::Enter);
        assert_eq!(spec(&w("", "/", &[], "/")).unwrap().key, Key::Slash);
        assert_eq!(spec(&w("", "é", &[], "é")).unwrap().key, Key::Unidentified);
        assert_eq!(spec(&w("", "", &[], "")).unwrap_err().0, code::BAD_REQUEST);
        assert_eq!(spec(&w("KeyA", "a", &["Hyperdrive"], "a")).unwrap_err().0, code::BAD_REQUEST);
        assert_eq!(spec(&w("KeyC", "c", &["Control"], "\x03")).unwrap_err().0, code::BAD_REQUEST);
        let long = "x".repeat(TEXT_MAX + 1);
        assert_eq!(spec(&w("", "", &[], &long)).unwrap_err().0, code::TOO_LARGE);
    }

    #[test]
    fn the_unshifted_character_and_what_made_the_text() {
        let s = spec(&w("KeyA", "A", &["Shift"], "A")).unwrap();
        assert_eq!((s.unshifted, s.consumed), (Some('a'), Mods::SHIFT));
        let s = spec(&w("Digit1", "!", &["Shift"], "!")).unwrap();
        assert_eq!((s.unshifted, s.consumed), (Some('1'), Mods::SHIFT));
        // A Russian layout's letter: its own character, not the US one.
        let s = spec(&w("KeyA", "Ф", &["Shift"], "Ф")).unwrap();
        assert_eq!(s.unshifted, Some('ф'));
        // Option-as-character on macOS: the text is the client's, and Option made it.
        let s = spec(&w("KeyA", "å", &["Alt"], "å")).unwrap();
        assert_eq!((s.unshifted, s.consumed, s.option_as_alt), (Some('a'), Mods::ALT, false));
        // The same event with Option as Alt: the key's own character, nothing consumed.
        let s = spec(&wo("KeyA", "å", &["Alt"], "å", WireOptionAsAlt::True)).unwrap();
        assert_eq!((s.text.as_deref(), s.consumed, s.option_as_alt), (Some("a"), Mods::empty(), true));
        // Alt as Alt: nothing consumed.
        let s = spec(&w("KeyA", "a", &["Alt"], "a")).unwrap();
        assert_eq!((s.unshifted, s.consumed), (Some('a'), Mods::empty()));
        let s = spec(&w("Enter", "Enter", &["Shift"], "")).unwrap();
        assert_eq!((s.unshifted, s.consumed, s.text), (None, Mods::empty(), None));
    }

    /// Shift+Enter is `CSI 13;2u` to a program that pushed Kitty flags, and `\r` to one that
    /// asked for no keyboard mode (xterm with modifyOtherKeys off), not
    /// Ghostty's legacy `CSI 27;2;13~`, which bash and python run as junk. Enter alone is `\r`
    /// either way; under modifyOtherKeys 2 the program asked for xterm's `CSI 27;2;13~`.
    #[test]
    fn shift_enter_is_csi_u_under_kitty_flags_and_a_carriage_return_without() {
        let k = w("Enter", "Enter", &["Shift"], "");
        let enter = w("Enter", "Enter", &[], "");
        assert_eq!(enc(b"", &k), b"\r");
        assert_eq!(enc(b"", &w("Enter", "Enter", &["Control"], "")), b"\r");
        assert_eq!(enc(b"", &w("Enter", "Enter", &["Control", "Shift"], "")), b"\r");
        assert_eq!(enc(b"", &w("Enter", "Enter", &["Alt", "Shift"], "")), b"\x1b\r");
        assert_eq!(enc(b"", &w("NumpadEnter", "Enter", &["Shift"], "")), b"\r");
        assert_eq!(enc(b"", &enter), b"\r");
        assert_eq!(enc(b"\x1b[>1u", &k), b"\x1b[13;2u");
        assert_eq!(enc(b"\x1b[>1u", &enter), b"\r");
        assert_eq!(enc(b"\x1b[>4;2m", &k), b"\x1b[27;2;13~");
        // The flags are a stack: popping them is legacy again.
        assert_eq!(enc(b"\x1b[>1u\x1b[<u", &k), b"\r");
        // A release encodes nothing outside Kitty's event reporting.
        let mut rel = k.clone();
        rel.action = Some(KeyAction::Release);
        assert_eq!(enc(b"", &rel), b"");
    }

    /// The legacy chords a plain readline program reads as xterm (modifyOtherKeys off) sends
    /// them, where Ghostty's legacy encoding sends fixterms' CSI u; a program that asked for a
    /// keyboard mode still gets Ghostty's.
    #[test]
    fn legacy_control_chords_are_xterms() {
        assert_eq!(enc(b"", &w("KeyA", "A", &["Control", "Shift"], "A")), b"\x01");
        assert_eq!(enc(b"", &w("KeyA", "A", &["Control", "Shift", "Alt"], "A")), b"\x1b\x01");
        assert_eq!(enc(b"", &w("BracketLeft", "[", &["Control"], "[")), b"\x1b");
        assert_eq!(enc(b"", &w("KeyI", "i", &["Control"], "i")), b"\t");
        assert_eq!(enc(b"", &w("KeyM", "m", &["Control"], "m")), b"\r");
        assert_eq!(enc(b"", &w("Backspace", "Backspace", &["Control"], "")), b"\x17");
        assert_eq!(enc(b"", &w("Backspace", "Backspace", &[], "")), b"\x7f");
        assert_eq!(enc(b"", &w("KeyC", "c", &["Control"], "c")), b"\x03");
        // Under Kitty flags, Ghostty's.
        assert_eq!(enc(b"\x1b[>1u", &w("KeyA", "A", &["Control", "Shift"], "A")), b"\x1b[97;6u");
        assert_eq!(enc(b"\x1b[>1u", &w("BracketLeft", "[", &["Control"], "[")), b"\x1b[91;5u");
        assert_eq!(enc(b"\x1b[>4;2m", &w("KeyA", "A", &["Control", "Shift"], "A")), b"\x1b[27;6;65~");
    }

    /// A keypad key with NumLock off is its navigation key, as Ghostty's apprt gives it: the
    /// cursor key's bytes, and Kitty's KP_ codes; with NumLock on, the digit.
    #[test]
    fn keypad_keys_with_numlock_off_navigate() {
        assert_eq!(enc(b"", &w("Numpad8", "ArrowUp", &[], "")), b"\x1b[A");
        assert_eq!(enc(b"", &w("Numpad1", "End", &[], "")), b"\x1b[F");
        assert_eq!(enc(b"", &w("NumpadDecimal", "Delete", &[], "")), b"\x1b[3~");
        assert_eq!(enc(b"", &w("Numpad9", "PageUp", &[], "")), b"\x1b[5~");
        assert_eq!(enc(b"\x1b[?1h", &w("Numpad4", "ArrowLeft", &[], "")), b"\x1bOD");
        assert_eq!(enc(b"\x1b[>1u", &w("Numpad8", "ArrowUp", &[], "")), b"\x1b[57419u");
        assert_eq!(enc(b"", &w("Numpad8", "8", &["NumLock"], "8")), b"8");
    }

    /// The lock modifiers ride in the Kitty modifiers as Ghostty sends them (key_encode.zig's
    /// `KittyMods.fromInput` carries caps_lock and num_lock; the Kitty spec gives them bits 64 and
    /// 128), so a desktop's NumLock reaches a Kitty program from the wall as it does from Ghostty.
    #[test]
    fn lock_modifiers_ride_as_ghostty_sends_them() {
        assert_eq!(enc(b"\x1b[>1u", &w("Enter", "Enter", &["Shift", "NumLock"], "")), b"\x1b[13;130u");
        assert_eq!(enc(b"", &w("Enter", "Enter", &["Shift", "NumLock"], "")), b"\r");
        assert_eq!(enc(b"", &w("KeyC", "c", &["Control", "NumLock"], "c")), b"\x03");
    }

    #[test]
    fn modify_other_keys_and_control_chords() {
        let k = w("KeyP", "p", &["Control"], "p");
        assert_eq!(enc(b"", &k), b"\x10");
        assert_eq!(enc(b"\x1b[>4;2m", &k), b"\x1b[27;5;112~");
        assert_eq!(enc(b"\x1b[>1u", &k), b"\x1b[112;5u");
    }

    #[test]
    fn cursor_keys_follow_application_mode() {
        let left = w("ArrowLeft", "ArrowLeft", &[], "");
        assert_eq!(enc(b"", &left), b"\x1b[D");
        assert_eq!(enc(b"\x1b[?1h", &left), b"\x1bOD");
        assert_eq!(enc(b"\x1b[?1h", &w("ArrowLeft", "ArrowLeft", &["Alt"], "")), b"\x1b[1;3D");
    }

    /// PROTOCOL.md's "What some keys become" table, cell for cell: the spec and the encoder can't
    /// drift apart.
    #[test]
    fn protocol_md_key_table_is_what_termd_sends() {
        let spec = include_str!("../../../docs/termd/PROTOCOL.md");
        let start = spec.find("| key | no mode set |").expect("the key table");
        let rows: Vec<&str> = spec[start..].lines().skip(2).take_while(|l| l.starts_with('|')).collect();
        assert_eq!(rows.len(), 9, "{rows:?}");
        let modes: [&[u8]; 4] = [b"", b"\x1b[>1u", b"\x1b[>4;2m", b"\x1b[?1h"];
        for row in rows {
            let cells: Vec<&str> = row.trim_matches('|').split('|').map(str::trim).collect();
            let name = cells[0].split(' ').next().unwrap();
            let k = match name {
                "Enter" => w("Enter", "Enter", &[], ""),
                "Shift+Enter" => w("Enter", "Enter", &["Shift"], ""),
                "Ctrl+C" => w("KeyC", "c", &["Control"], "c"),
                "Ctrl+Shift+A" => w("KeyA", "A", &["Control", "Shift"], "A"),
                "Ctrl+Backspace" => w("Backspace", "Backspace", &["Control"], ""),
                "Numpad8" => w("Numpad8", "ArrowUp", &[], ""),
                "Alt+B" => w("KeyB", "b", &["Alt"], "b"),
                "ArrowUp" => w("ArrowUp", "ArrowUp", &[], ""),
                "Alt+ArrowLeft" => w("ArrowLeft", "ArrowLeft", &["Alt"], ""),
                other => panic!("a key the test doesn't know: {other}"),
            };
            for (cell, mode) in cells[1..].iter().zip(modes) {
                assert_eq!(enc(mode, &k), doc_bytes(cell), "{name} after {mode:?}: the table says {cell}");
            }
        }
    }

    /// A PROTOCOL.md table cell's bytes: `CSI 97 ; 3 u`, `ESC a`, `\r`, `0x03`, `å`.
    fn doc_bytes(cell: &str) -> Vec<u8> {
        cell.trim_matches('`')
            .split(' ')
            .flat_map(|t| match t {
                "CSI" => b"\x1b[".to_vec(),
                "ESC" => b"\x1b".to_vec(),
                "\\r" => b"\r".to_vec(),
                t if t.starts_with("0x") => vec![u8::from_str_radix(&t[2..], 16).unwrap()],
                t => t.as_bytes().to_vec(),
            })
            .collect()
    }

    #[test]
    fn protocol_md_option_table_is_what_termd_sends() {
        let spec = include_str!("../../../docs/termd/PROTOCOL.md");
        let start = spec.find("| event, `option_as_alt` |").expect("the option table");
        let rows: Vec<&str> = spec[start..].lines().skip(2).take_while(|l| l.starts_with('|')).collect();
        assert_eq!(rows.len(), 5, "{rows:?}");
        for row in rows {
            let cells: Vec<&str> = row.trim_matches('|').split('|').map(str::trim).collect();
            let (event, o) = cells[0].split_once(", ").unwrap();
            let o: WireOptionAsAlt = o.trim_matches(['`', '"']).parse().unwrap();
            let k = match event {
                "Option+A" => wo("KeyA", "å", &["Alt"], "å", o),
                "Alt+A" => wo("KeyA", "a", &["Alt"], "a", o),
                other => panic!("an event the test doesn't know: {other}"),
            };
            for (cell, mode) in cells[1..].iter().zip(MODES) {
                assert_eq!(enc(mode, &k), doc_bytes(cell), "{} after {mode:?}: the table says {cell}", cells[0]);
            }
        }
    }

    #[test]
    fn text_alt_and_release() {
        assert_eq!(enc(b"", &w("KeyA", "a", &[], "a")), b"a");
        assert_eq!(enc(b"", &w("KeyA", "A", &["Shift"], "A")), b"A");
        assert_eq!(enc(b"", &w("KeyB", "b", &["Alt"], "b")), b"\x1bb");
        assert_eq!(enc(b"", &w("", "é", &[], "é")), "é".as_bytes());
        let mut rel = w("KeyA", "a", &[], "a");
        rel.action = Some(KeyAction::Release);
        assert_eq!(enc(b"", &rel), b"");
        // Kitty with event reporting (1 | 2): the release is reported.
        assert_eq!(enc(b"\x1b[>3u", &rel), b"\x1b[97;1:3u");
    }
}
