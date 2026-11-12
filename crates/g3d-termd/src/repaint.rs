//! Building `REPAINT` bytes and `capture` text from a terminal (PROTOCOL.md, "REPAINT").

use libghostty_vt::Terminal;
use libghostty_vt::color::Rgb;
use libghostty_vt::fmt::{Extras, Format, Formatter};
use libghostty_vt::mode::Mode;
use libghostty_vt::point::{Coordinate, Point};
use libghostty_vt::selection::Selection;

/// Every repaint starts here: leave the alternate screen, soft-reset, put back the modes a
/// soft reset leaves alone (autowrap on; mouse reporting, focus events, bracketed paste and
/// Kitty keyboard flags off), then home and clear. The formatter then sets every mode that
/// differs from its default, so the viewer ends in termd's state whatever it held before.
const PREAMBLE: &[u8] = b"\x1b[?1049l\x1b[!p\x1b[?7h\
\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\
\x1b[?1004l\x1b[?2004l\x1b[=0;1u\x1b[H\x1b[2J";

type Term = Terminal<'static, 'static>;

/// Formats the rows between two points (inclusive) with the given format and extras.
fn format_range(
    t: &Term,
    start: Point,
    end: Point,
    format: Format,
    extras: Extras,
    trim: bool,
    unwrap: bool,
) -> Vec<u8> {
    let mut f = Formatter::new(t).expect("formatter");
    f.set_format(format).expect("format").set_extras(extras).expect("extras").set_trim(trim).expect("trim");
    f.set_unwrap(unwrap).expect("unwrap");
    let a = t.grid_ref(start).expect("start point in range");
    let b = t.grid_ref(end).expect("end point in range");
    let sel = Selection::new(a, b, false);
    // SAFETY: the selection's grid refs point into `t`, which is not modified while `f`
    // formats (both borrow it immutably for this scope).
    unsafe { f.set_selection(Some(&sel)).expect("selection") };
    f.format_alloc(None).expect("format_alloc").to_vec()
}

fn osc_color(out: &mut Vec<u8>, prefix: &str, c: Rgb) {
    out.extend_from_slice(
        format!("\x1b]{prefix};rgb:{:02x}{:02x}/{:02x}{:02x}/{:02x}{:02x}\x1b\\", c.r, c.r, c.g, c.g, c.b, c.b)
            .as_bytes(),
    );
}

/// Drops C0/C1 controls from a title so it can't end its OSC early.
pub fn clean_title(t: &[u8]) -> String {
    String::from_utf8_lossy(t).chars().filter(|&c| !(c < ' ' || ('\u{7f}'..='\u{9f}').contains(&c))).collect()
}

/// The live screen as VT bytes: after writing them to a viewer of the terminal's size, the
/// viewer shows what `t` shows and parses the bytes that follow correctly.
pub fn live(t: &mut Term, history_rows: u32) -> Vec<u8> {
    let cols = t.cols().expect("cols");
    let rows = t.rows().expect("rows");
    let mut out = PREAMBLE.to_vec();

    // History first, so it scrolls into the viewer's own scrollback.
    let sb = t.scrollback_rows().unwrap_or(0) as u32;
    let n = history_rows.min(sb);
    if n > 0 {
        let hist = format_range(
            t,
            Point::History(Coordinate { x: 0, y: sb - n }),
            Point::History(Coordinate { x: cols - 1, y: sb - 1 }),
            Format::Vt,
            Extras::NONE,
            true,
            false,
        );
        out.extend_from_slice(&hist);
        out.extend_from_slice(b"\x1b[0m\r\n");
        // The last rows printed are still on screen: push exactly those off the top.
        let on_screen = n.min(u32::from(rows) - 1);
        out.extend_from_slice(format!("\x1b[{rows};1H").as_bytes());
        out.extend(std::iter::repeat_n(b'\n', on_screen as usize));
        out.extend_from_slice(b"\x1b[H\x1b[2J");
    }

    // The active area with its modes, margins, tab stops, charsets, keyboard modes and
    // cursor. Synchronized output stays out: a viewer would wait for an end that already
    // happened. The palette is restored below, only where it differs.
    let sync = t.mode(Mode::SYNC_OUTPUT).unwrap_or(false);
    if sync {
        let _ = t.set_mode(Mode::SYNC_OUTPUT, false);
    }
    let screen = format_range(
        t,
        Point::Active(Coordinate { x: 0, y: 0 }),
        Point::Active(Coordinate { x: cols - 1, y: u32::from(rows) - 1 }),
        Format::Vt,
        Extras::ALL & !Extras::PALETTE,
        false,
        false,
    );
    if sync {
        let _ = t.set_mode(Mode::SYNC_OUTPUT, true);
    }
    out.extend_from_slice(&screen);

    // Colours the program changed.
    if let (Ok(cur), Ok(def)) = (t.color_palette(), t.default_color_palette()) {
        for i in 0..256 {
            if cur.0[i] != def.0[i] {
                osc_color(&mut out, &format!("4;{i}"), cur.0[i]);
            }
        }
    }
    for (code, cur, def) in [
        ("10", t.fg_color(), t.default_fg_color()),
        ("11", t.bg_color(), t.default_bg_color()),
        ("12", t.cursor_color(), t.default_cursor_color()),
    ] {
        if let (Ok(Some(c)), Ok(d)) = (cur, def)
            && Some(c) != d
        {
            osc_color(&mut out, code, c);
        }
    }
    let title = clean_title(t.title().unwrap_or(b""));
    out.extend_from_slice(format!("\x1b]2;{title}\x07").as_bytes());

    // The program's unfinished escape sequence, so the next OUTPUT byte continues it.
    let _ = t.continuation_write(&mut out);
    out
}

/// A scrollback view: the `rows` rows starting at screen row `top`, cursor hidden.
pub fn view(t: &Term, top: u32) -> Vec<u8> {
    let cols = t.cols().expect("cols");
    let rows = u32::from(t.rows().expect("rows"));
    let mut out = PREAMBLE.to_vec();
    out.extend_from_slice(&format_range(
        t,
        Point::Screen(Coordinate { x: 0, y: top }),
        Point::Screen(Coordinate { x: cols - 1, y: top + rows - 1 }),
        Format::Vt,
        Extras::NONE,
        false,
        false,
    ));
    out.extend_from_slice(b"\x1b[0m\x1b[?25l");
    out
}

/// The screen plus up to `history_rows` scrollback rows as text: `(text, rows)`.
pub fn capture(t: &Term, vt: bool, history_rows: u32, unwrap: bool) -> (String, u64) {
    let cols = t.cols().expect("cols");
    let rows = u32::from(t.rows().expect("rows"));
    let total = t.total_rows().expect("total_rows") as u32;
    let n = history_rows.min(total - rows);
    let top = total - rows - n;
    let bytes = format_range(
        t,
        Point::Screen(Coordinate { x: 0, y: top }),
        Point::Screen(Coordinate { x: cols - 1, y: total - 1 }),
        if vt { Format::Vt } else { Format::Plain },
        Extras::NONE,
        true,
        unwrap,
    );
    (String::from_utf8_lossy(&bytes).into_owned(), u64::from(rows + n))
}
