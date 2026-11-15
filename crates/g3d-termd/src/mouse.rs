//! The `mouse` op (PROTOCOL.md, "`mouse`"): a pointer event on the terminal's cells, encoded by
//! libghostty's mouse encoder (Ghostty's src/input/mouse_encode.zig) against the terminal's live
//! mouse modes: the tracking the program asked for (9 X10, 1000 normal, 1002 button-event, 1003
//! any-event) and the report format (default, 1005 UTF-8, 1006 SGR, 1015 urxvt, 1016 SGR-pixels).
//! The encoder drops what the mode doesn't report, as Ghostty does: motion without 1002/1003, a
//! release under X10, a press of a button X10 has no code for, a cell past 223 in the default
//! format. A wheel the program doesn't hear is Ghostty's alternate scroll on the alternate screen
//! (mode 1007): cursor keys (Surface.zig, `scrollCallback`). It runs on the terminal's owner
//! thread, the one that holds its `Terminal`, as `key` does.

use crate::keys;
use g3d_wire::code;
use g3d_wire::msg::{Mouse as WireMouse, MouseAction, MouseButton};
use libghostty_vt::Terminal;
use libghostty_vt::key::Mods;
use libghostty_vt::mode::Mode as VtMode;
use libghostty_vt::mouse::{Action, Button, Encoder, EncoderSize, Event, Position};
use libghostty_vt::screen::Screen;

/// A `mouse` request, checked: what libghostty's mouse event gets.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub action: Action,
    /// None: a move with no button held.
    pub button: Option<Button>,
    pub mods: Mods,
    /// The pointer, in cells from the top-left (fractions kept for SGR-pixels).
    pub col: f64,
    pub row: f64,
}

/// Which way a wheel turns, for alternate scroll.
fn wheel_vertical(b: Button) -> Option<bool> {
    match b {
        Button::Four => Some(true),
        Button::Five => Some(false),
        _ => None,
    }
}

/// Checks a `mouse` request. Errors are `(code, message)` for the reply.
pub fn spec(m: &WireMouse) -> Result<Spec, (&'static str, String)> {
    let bad = |m: String| (code::BAD_REQUEST, m);
    if !m.col.is_finite() || !m.row.is_finite() {
        return Err(bad(format!("col and row are numbers of cells, not {} and {}", m.col, m.row)));
    }
    let mut mods = Mods::empty();
    for name in &m.mods {
        mods |= keys::modifier(name).map_err(bad)?;
    }
    let action = match m.action {
        MouseAction::Press => Action::Press,
        MouseAction::Release => Action::Release,
        MouseAction::Move => Action::Motion,
    };
    if m.button.is_wheel() && m.action != MouseAction::Press {
        return Err(bad(format!("a wheel ({}) is a press, not a {:?}", m.button, m.action)));
    }
    if m.button == MouseButton::None && m.action != MouseAction::Move {
        return Err(bad(format!("a {:?} names its button; `none` is for a move with none held", m.action)));
    }
    let button = match m.button {
        MouseButton::None => None,
        MouseButton::Left => Some(Button::Left),
        MouseButton::Middle => Some(Button::Middle),
        MouseButton::Right => Some(Button::Right),
        MouseButton::WheelUp => Some(Button::Four),
        MouseButton::WheelDown => Some(Button::Five),
        MouseButton::WheelLeft => Some(Button::Six),
        MouseButton::WheelRight => Some(Button::Seven),
        MouseButton::Extra(8) => Some(Button::Eight),
        MouseButton::Extra(9) => Some(Button::Nine),
        MouseButton::Extra(10) => Some(Button::Ten),
        MouseButton::Extra(11) => Some(Button::Eleven),
        MouseButton::Extra(n) => return Err(bad(format!("button {n}: the extra buttons are 8..11"))),
    };
    Ok(Spec { action, button, mods, col: m.col, row: m.row })
}

/// The terminal's geometry as the encoder reads it: cols, rows and the cell's size in pixels
/// (`create`'s `cell_px`, what `CSI 14 t` and `CSI 16 t` report).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub cols: u16,
    pub rows: u16,
    pub cell_w: u32,
    pub cell_h: u32,
}

/// The DEC modes the encoder reads from the terminal: tracking, then format.
const MODES: [VtMode; 8] = [
    VtMode::X10_MOUSE,
    VtMode::NORMAL_MOUSE,
    VtMode::BUTTON_MOUSE,
    VtMode::ANY_MOUSE,
    VtMode::UTF8_MOUSE,
    VtMode::SGR_MOUSE,
    VtMode::URXVT_MOUSE,
    VtMode::SGR_PIXELS_MOUSE,
];

/// One terminal's mouse encoder and the event it reuses, on its owner thread.
pub struct Mouse {
    enc: Encoder<'static>,
    ev: Event<'static>,
    /// What the encoder was last set to: the modes (one bit each of [`MODES`]) and the geometry.
    /// libghostty forgets the cell it last reported whenever either is set, so they are set only
    /// when they change.
    set: Option<(u8, Geometry)>,
}

impl Mouse {
    pub fn new() -> Result<Self, String> {
        let mut enc = Encoder::new().map_err(|e| format!("mouse encoder: {e}"))?;
        // Motion is reported once per cell (Ghostty's `last_cell`): a client that sends every
        // pixel still makes one report per cell crossed. SGR-pixels reports every move.
        enc.set_track_last_cell(true);
        Ok(Self { enc, ev: Event::new().map_err(|e| format!("mouse event: {e}"))?, set: None })
    }

    /// The bytes `s` is in `term`'s current mouse modes (empty: the program didn't ask for it).
    pub fn encode(&mut self, term: &Terminal<'_, '_>, g: Geometry, s: &Spec) -> Result<Vec<u8>, String> {
        let tracking = term.is_mouse_tracking().map_err(|e| format!("mouse tracking: {e}"))?;
        if !tracking {
            return Ok(match s.button.and_then(wheel_vertical) {
                Some(up) => alternate_scroll(term, up),
                None => Vec::new(),
            });
        }
        let (w, h) = (u32::from(g.cols) * g.cell_w, u32::from(g.rows) * g.cell_h);
        let modes = MODES.iter().enumerate().fold(0u8, |m, (i, &v)| m | (u8::from(term.mode(v).unwrap_or(false)) << i));
        if self.set != Some((modes, g)) {
            self.enc
                .set_options_from_terminal(term)
                .set_size(EncoderSize {
                    screen_width: w,
                    screen_height: h,
                    cell_width: g.cell_w,
                    cell_height: g.cell_h,
                    padding_top: 0,
                    padding_bottom: 0,
                    padding_right: 0,
                    padding_left: 0,
                })
                .map_err(|e| format!("mouse geometry {g:?}: {e}"))?;
            self.set = Some((modes, g));
        }
        self.enc.set_any_button_pressed(s.button.is_some() && s.action != Action::Release);
        // Clamped to the screen, as a terminal keeps reporting a drag that left it: the last pixel
        // is the last cell's.
        let px =
            |cells: f64, cell: u32, max: u32| (cells * f64::from(cell)).clamp(0.0, f64::from(max.saturating_sub(1)));
        self.ev
            .set_action(s.action)
            .set_button(s.button)
            .set_mods(s.mods)
            .set_position(Position { x: px(s.col, g.cell_w, w) as f32, y: px(s.row, g.cell_h, h) as f32 });
        let mut out = Vec::new();
        self.enc.encode_to_vec(&self.ev, &mut out).map_err(|e| format!("mouse encoding: {e}"))?;
        Ok(out)
    }
}

/// A wheel notch for a program that hears no mouse: on the alternate screen with alternate
/// scroll on (mode 1007, on by default), a cursor key, ESC O A / ESC O B under DECCKM, else
/// CSI A / CSI B (Ghostty's `scrollCallback`). Anywhere else nothing: the client scrolls its view.
fn alternate_scroll(term: &Terminal<'_, '_>, up: bool) -> Vec<u8> {
    let alt = matches!(term.active_screen(), Ok(Screen::Alternate));
    if !alt || !term.mode(VtMode::ALT_SCROLL).unwrap_or(false) {
        return Vec::new();
    }
    let app = term.mode(VtMode::DECCKM).unwrap_or(false);
    let dir = if up { b'A' } else { b'B' };
    if app { vec![0x1b, b'O', dir] } else { vec![0x1b, b'[', dir] }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: Geometry = Geometry { cols: 80, rows: 24, cell_w: 8, cell_h: 16 };

    fn m(action: MouseAction, button: MouseButton, col: f64, row: f64, mods: &[&str]) -> WireMouse {
        WireMouse { handle: 1, action, button, col, row, mods: mods.iter().map(|s| s.to_string()).collect() }
    }

    fn press(b: MouseButton, col: f64, row: f64) -> WireMouse {
        m(MouseAction::Press, b, col, row, &[])
    }

    fn release(b: MouseButton, col: f64, row: f64) -> WireMouse {
        m(MouseAction::Release, b, col, row, &[])
    }

    fn drag(b: MouseButton, col: f64, row: f64) -> WireMouse {
        m(MouseAction::Move, b, col, row, &[])
    }

    /// Encodes each of `events` in turn, on one encoder, in a fresh terminal that has read `setup`.
    fn run(setup: &[u8], g: Geometry, events: &[WireMouse]) -> Vec<Vec<u8>> {
        let mut t = Terminal::new(g.cols, g.rows).unwrap();
        t.vt_write(setup);
        let mut mouse = Mouse::new().unwrap();
        events.iter().map(|e| mouse.encode(&t, g, &spec(e).unwrap()).unwrap()).collect()
    }

    fn one(setup: &[u8], e: WireMouse) -> Vec<u8> {
        run(setup, G, &[e]).remove(0)
    }

    const TRACKING: [(&str, &[u8]); 4] =
        [("x10", b"\x1b[?9h"), ("normal", b"\x1b[?1000h"), ("button", b"\x1b[?1002h"), ("any", b"\x1b[?1003h")];

    /// A press, a drag to the next cell, a release and a move with no button held, column 3 row 5
    /// (cells 4;6 on the wire), in each tracking mode and each format: what each mode reports and
    /// how each format writes it.
    #[test]
    fn tracking_modes_report_what_they_ask_for_in_each_format() {
        let events = [
            press(MouseButton::Left, 3.0, 5.0),
            drag(MouseButton::Left, 4.0, 5.0),
            release(MouseButton::Left, 4.0, 5.0),
            drag(MouseButton::None, 5.0, 5.0),
        ];
        let sgr: [&[u8]; 4] = [b"\x1b[<0;4;6M", b"\x1b[<32;5;6M", b"\x1b[<0;5;6m", b"\x1b[<35;6;6M"];
        // Legacy formats: button + 32, then 32 + the 1-based cell; a release is button 3.
        let x10: [&[u8]; 4] = [b"\x1b[M $&", b"\x1b[M@%&", b"\x1b[M#%&", b"\x1b[MC&&"];
        let urxvt: [&[u8]; 4] = [b"\x1b[32;4;6M", b"\x1b[64;5;6M", b"\x1b[35;5;6M", b"\x1b[67;6;6M"];
        // What each tracking mode reports of the four: X10 the press alone (and no modifiers),
        // normal press and release, button-event the drag too, any-event the bare move too.
        let reports = |mode: &str| match mode {
            "x10" => [true, false, false, false],
            "normal" => [true, false, true, false],
            "button" => [true, true, true, false],
            _ => [true, true, true, true],
        };
        for (format, fsetup, want) in
            [("sgr", &b"\x1b[?1006h"[..], sgr), ("default", b"", x10), ("urxvt", b"\x1b[?1015h", urxvt)]
        {
            for (mode, msetup) in TRACKING {
                let got = run(&[msetup, fsetup].concat(), G, &events);
                for (i, r) in reports(mode).iter().enumerate() {
                    let expect: &[u8] = if *r { want[i] } else { b"" };
                    assert_eq!(got[i], expect, "{mode} {format} event {i}: {:?}", String::from_utf8_lossy(&got[i]));
                }
            }
        }
    }

    #[test]
    fn no_tracking_reports_nothing() {
        for e in
            [press(MouseButton::Left, 1.0, 1.0), drag(MouseButton::None, 2.0, 2.0), press(MouseButton::Right, 0.0, 0.0)]
        {
            assert_eq!(one(b"\x1b[?1006h", e), b"");
        }
    }

    /// Shift, Alt and Control add 4, 8 and 16 (Meta has no bit); X10 tracking carries none.
    #[test]
    fn modifiers_ride_the_button_code() {
        let sgr = b"\x1b[?1000h\x1b[?1006h";
        assert_eq!(one(sgr, m(MouseAction::Press, MouseButton::Left, 0.0, 0.0, &["Shift"])), b"\x1b[<4;1;1M");
        assert_eq!(one(sgr, m(MouseAction::Press, MouseButton::Left, 0.0, 0.0, &["Alt"])), b"\x1b[<8;1;1M");
        assert_eq!(
            one(sgr, m(MouseAction::Press, MouseButton::Right, 0.0, 0.0, &["Control", "Meta"])),
            b"\x1b[<18;1;1M"
        );
        assert_eq!(
            one(sgr, m(MouseAction::Press, MouseButton::Middle, 0.0, 0.0, &["Shift", "Alt", "Control"])),
            b"\x1b[<29;1;1M"
        );
        assert_eq!(
            one(b"\x1b[?9h\x1b[?1006h", m(MouseAction::Press, MouseButton::Left, 0.0, 0.0, &["Control"])),
            b"\x1b[<0;1;1M"
        );
    }

    /// The wheel is buttons 64–67, a press with no release; the extra buttons 128 and 129.
    #[test]
    fn wheel_and_extra_buttons() {
        let sgr = b"\x1b[?1000h\x1b[?1006h";
        assert_eq!(one(sgr, press(MouseButton::WheelUp, 9.0, 2.0)), b"\x1b[<64;10;3M");
        assert_eq!(one(sgr, press(MouseButton::WheelDown, 9.0, 2.0)), b"\x1b[<65;10;3M");
        assert_eq!(one(sgr, press(MouseButton::WheelLeft, 9.0, 2.0)), b"\x1b[<66;10;3M");
        assert_eq!(one(sgr, press(MouseButton::WheelRight, 9.0, 2.0)), b"\x1b[<67;10;3M");
        assert_eq!(one(sgr, m(MouseAction::Press, MouseButton::WheelUp, 0.0, 0.0, &["Control"])), b"\x1b[<80;1;1M");
        assert_eq!(one(sgr, press(MouseButton::Extra(8), 0.0, 0.0)), b"\x1b[<128;1;1M");
        assert_eq!(one(sgr, press(MouseButton::Extra(9), 0.0, 0.0)), b"\x1b[<129;1;1M");
        // Ghostty has no code for 10 and 11: nothing.
        assert_eq!(one(sgr, press(MouseButton::Extra(10), 0.0, 0.0)), b"");
        // X10 tracking reports left, middle and right presses only.
        assert_eq!(one(b"\x1b[?9h\x1b[?1006h", press(MouseButton::WheelUp, 0.0, 0.0)), b"");
    }

    /// The default format writes a coordinate as one byte (32 + the 1-based cell), so it stops at
    /// 223 (Ghostty sends nothing past it); UTF-8 (1005) and SGR (1006) go on.
    #[test]
    fn large_coordinates() {
        let wide = Geometry { cols: 300, rows: 300, ..G };
        let at = |setup: &[u8], col| run(setup, wide, &[press(MouseButton::Left, col, 0.0)]).remove(0);
        assert_eq!(at(b"\x1b[?1000h", 222.0), b"\x1b[M \xff!");
        assert_eq!(at(b"\x1b[?1000h", 223.0), b"");
        assert_eq!(at(b"\x1b[?1000h\x1b[?1006h", 222.0), b"\x1b[<0;223;1M");
        assert_eq!(at(b"\x1b[?1000h\x1b[?1006h", 299.0), b"\x1b[<0;300;1M");
        // UTF-8: 32 + 1 + 299 = U+014C.
        assert_eq!(at(b"\x1b[?1000h\x1b[?1005h", 299.0), "\x1b[M \u{14c}!".as_bytes());
        assert_eq!(at(b"\x1b[?1000h\x1b[?1015h", 299.0), b"\x1b[32;300;1M");
    }

    /// SGR-pixels (1016) reports the pointer in the terminal's pixels: the cell size times the
    /// cell position, fractions kept, clamped to the screen's last pixel.
    #[test]
    fn sgr_pixels_reads_the_fraction_in_the_cell_size() {
        let px = b"\x1b[?1003h\x1b[?1016h";
        assert_eq!(one(px, press(MouseButton::Left, 3.5, 5.25)), b"\x1b[<0;28;84M");
        assert_eq!(one(px, release(MouseButton::Left, 3.5, 5.25)), b"\x1b[<0;28;84m");
        let big = Geometry { cell_w: 10, cell_h: 20, ..G };
        assert_eq!(run(px, big, &[press(MouseButton::Left, 2.0, 1.0)]).remove(0), b"\x1b[<0;20;20M");
        // Every pixel moved is a report, even inside one cell.
        let moves = run(px, G, &[drag(MouseButton::None, 1.0, 1.0), drag(MouseButton::None, 1.25, 1.0)]);
        assert_eq!(moves, [b"\x1b[<35;8;16M".to_vec(), b"\x1b[<35;10;16M".to_vec()]);
        assert_eq!(one(px, press(MouseButton::Left, 500.0, -3.0)), b"\x1b[<0;639;0M");
    }

    /// Off the screen a drag is clamped to its edge; cells too.
    #[test]
    fn coordinates_clamp_to_the_screen() {
        let sgr = b"\x1b[?1002h\x1b[?1006h";
        let got = run(
            sgr,
            G,
            &[
                press(MouseButton::Left, 10.0, 10.0),
                drag(MouseButton::Left, 200.0, -5.0),
                release(MouseButton::Left, 200.0, 99.0),
            ],
        );
        assert_eq!(got, [b"\x1b[<0;11;11M".to_vec(), b"\x1b[<32;80;1M".to_vec(), b"\x1b[<0;80;24m".to_vec()]);
    }

    /// Motion is reported once per cell; a press in that cell counts as being there.
    #[test]
    fn motion_reports_once_per_cell() {
        let got = run(
            b"\x1b[?1003h\x1b[?1006h",
            G,
            &[drag(MouseButton::None, 1.1, 1.0), drag(MouseButton::None, 1.9, 1.5), drag(MouseButton::None, 2.0, 1.0)],
        );
        assert_eq!(got, [b"\x1b[<35;2;2M".to_vec(), b"".to_vec(), b"\x1b[<35;3;2M".to_vec()]);
    }

    /// A wheel the program doesn't hear: on the alternate screen, cursor keys (application mode
    /// when DECCKM is on); with alternate scroll off, or on the primary screen, nothing.
    #[test]
    fn a_wheel_without_mouse_reporting_is_alternate_scroll() {
        assert_eq!(one(b"\x1b[?1049h", press(MouseButton::WheelUp, 0.0, 0.0)), b"\x1b[A");
        assert_eq!(one(b"\x1b[?1049h", press(MouseButton::WheelDown, 0.0, 0.0)), b"\x1b[B");
        assert_eq!(one(b"\x1b[?1049h\x1b[?1h", press(MouseButton::WheelUp, 0.0, 0.0)), b"\x1bOA");
        assert_eq!(one(b"\x1b[?1049h\x1b[?1007l", press(MouseButton::WheelUp, 0.0, 0.0)), b"");
        assert_eq!(one(b"\x1b[?1049h", press(MouseButton::WheelLeft, 0.0, 0.0)), b"");
        assert_eq!(one(b"", press(MouseButton::WheelUp, 0.0, 0.0)), b"");
        // A program that hears the mouse gets the wheel as a report, on either screen.
        assert_eq!(one(b"\x1b[?1049h\x1b[?1000h\x1b[?1006h", press(MouseButton::WheelUp, 0.0, 0.0)), b"\x1b[<64;1;1M");
        assert_eq!(one(b"\x1b[?1000h\x1b[?1006h", press(MouseButton::WheelDown, 1.0, 0.0)), b"\x1b[<65;2;1M");
    }

    #[test]
    fn requests_that_name_no_event_are_refused() {
        let refused = |w: WireMouse| spec(&w).unwrap_err();
        assert!(refused(release(MouseButton::WheelUp, 0.0, 0.0)).1.contains("is a press"));
        assert!(refused(drag(MouseButton::WheelDown, 0.0, 0.0)).1.contains("is a press"));
        assert!(refused(press(MouseButton::None, 0.0, 0.0)).1.contains("names its button"));
        assert!(
            refused(m(MouseAction::Press, MouseButton::Left, 0.0, 0.0, &["Hyperdrive"])).1.contains("unknown modifier")
        );
        assert!(refused(press(MouseButton::Extra(12), 0.0, 0.0)).1.contains("8..11"));
        assert!(refused(press(MouseButton::Left, f64::NAN, 0.0)).1.contains("numbers of cells"));
        assert_eq!(refused(press(MouseButton::Left, 0.0, f64::INFINITY)).0, code::BAD_REQUEST);
    }

    /// PROTOCOL.md's table of reports is what termd sends: each row's event in each column's mode.
    #[test]
    fn protocol_md_mouse_table_is_what_termd_sends() {
        let doc = include_str!("../../../docs/termd/PROTOCOL.md");
        let table = doc.split("What a pointer event becomes").nth(1).expect("PROTOCOL.md has the mouse table");
        let modes: [&[u8]; 5] =
            [b"\x1b[?9h", b"\x1b[?1000h", b"\x1b[?1002h", b"\x1b[?1003h\x1b[?1006h", b"\x1b[?1003h\x1b[?1016h"];
        let mut rows = 0;
        for line in table.lines().skip_while(|l| !l.starts_with("| event")).skip(2).take_while(|l| l.starts_with('|')) {
            let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
            let ev: WireMouse =
                serde_json::from_str(&format!(r#"{{"handle":1,{}}}"#, cells[0].trim_matches('`'))).expect(cells[0]);
            for (i, setup) in modes.iter().enumerate() {
                let want = doc_bytes(cells[i + 1]);
                assert_eq!(one(setup, ev.clone()), want, "{} in column {}", cells[0], i + 1);
            }
            rows += 1;
        }
        assert!(rows >= 5, "the table has its rows ({rows})");
    }

    /// A table cell as bytes: `ESC`/`CSI` spelled out, `·` a space, `—` nothing.
    fn doc_bytes(cell: &str) -> Vec<u8> {
        if cell == "—" {
            return Vec::new();
        }
        let s =
            cell.trim_matches('`').replace("CSI ", "\x1b[").replace("ESC ", "\x1b").replace(' ', "").replace('·', " ");
        s.into_bytes()
    }
}
