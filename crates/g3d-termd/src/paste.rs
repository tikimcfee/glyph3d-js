//! A paste as it reaches the program (DESIGN.md, "Keys and paste"; PROTOCOL.md "`paste`"): framed
//! as Ghostty frames one, and streamed, so a paste of any size goes through the PTY under the
//! input buffer's flow control, as a real terminal writes its clipboard.
//!
//! One paste is one or more chunks (`paste` with `more: true` on all but the last). The rules are
//! the whole paste's, never a chunk's:
//!
//! - framing is decided once, at the first chunk, from the program's bracketed-paste mode then:
//!   `ESC [ 200 ~` before the first byte written and `ESC [ 201 ~` after the last (a paste that
//!   ends early, refused or abandoned, is still closed, so the program never stays inside a
//!   bracket swallowing keys);
//! - every chunk is encoded by libghostty's paste encoder (Ghostty's `paste.zig`: the control
//!   bytes xterm strips become spaces, and outside a bracket each `\n` becomes `\r`), which works
//!   byte by byte, so a chunk boundary can't change what a byte becomes;
//! - outside a bracket a `\r\n` is one Enter (WezTerm's `canonicalize_pasted_newlines`), also when
//!   the `\r` ends one chunk and the `\n` starts the next;
//! - Ghostty's `clipboard-paste-protection` rule (`isSafeWith`) is checked over the raw text as it
//!   streams, with the last bytes of the chunk before carried along, so a bracket end
//!   (`ESC [ 201 ~`) split across two chunks is caught as surely as one inside a chunk.

use libghostty_vt::paste;

/// Ghostty's bracketed-paste frame (src/input/paste.zig).
pub const BRACKET_START: &[u8] = b"\x1b[200~";
pub const BRACKET_END: &[u8] = b"\x1b[201~";

/// Why a chunk was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    /// Bytes that end the paste for the program (the bracket's end, when one was opened).
    pub close: Vec<u8>,
    pub why: &'static str,
}

/// One paste's state across its chunks.
#[derive(Debug)]
pub struct Stream {
    bracketed: bool,
    allow_unsafe: bool,
    /// The bracket's start has been written.
    opened: bool,
    /// The last raw bytes seen (at most the bracket end's length less one), for a terminator
    /// that straddles two chunks.
    tail: Vec<u8>,
    /// Outside a bracket: the previous chunk ended in `\r`, so a `\n` starting this one is the
    /// second half of one line break.
    cr: bool,
    /// A chunk was refused: the paste is over, and its later chunks write nothing.
    refused: bool,
    /// Bytes of the paste's text the program has been given so far.
    pub written: u64,
}

impl Stream {
    pub fn new(bracketed: bool, allow_unsafe: bool) -> Self {
        Stream { bracketed, allow_unsafe, opened: false, tail: Vec::new(), cr: false, refused: false, written: 0 }
    }

    /// The bytes for the program for one chunk (`last`: the paste's final one), or why it is
    /// refused, in which case nothing of it is written and the paste is over.
    pub fn chunk(&mut self, text: &str, last: bool) -> Result<Vec<u8>, Refused> {
        if self.refused {
            return Err(Refused { close: Vec::new(), why: "an earlier chunk of this paste was refused" });
        }
        let mut raw = text.as_bytes().to_vec();
        if !self.bracketed {
            if self.cr && raw.first() == Some(&b'\n') {
                raw.remove(0);
            }
            let canon = String::from_utf8(raw).expect("from a str").replace("\r\n", "\n");
            raw = canon.into_bytes();
        }
        if !self.allow_unsafe
            && let Some(why) = self.unsafe_in(&raw)
        {
            self.refused = true;
            return Err(Refused { close: self.close(), why });
        }
        if !self.bracketed {
            self.cr = text.ends_with('\r');
        }
        let keep = BRACKET_END.len() - 1;
        let mut seen = std::mem::take(&mut self.tail);
        seen.extend_from_slice(&raw[raw.len().saturating_sub(keep)..]);
        self.tail = seen[seen.len().saturating_sub(keep)..].to_vec();

        let mut out = Vec::with_capacity(raw.len() + 2 * BRACKET_END.len());
        if !raw.is_empty() {
            let body = encode(&mut raw, self.bracketed);
            if self.bracketed && !self.opened {
                out.extend_from_slice(BRACKET_START);
                self.opened = true;
            }
            out.extend_from_slice(&body);
            self.written += text.len() as u64;
        }
        if last {
            out.extend_from_slice(&self.close());
        }
        Ok(out)
    }

    /// The bytes that end the paste now (its last chunk, a refusal, its writer gone): the bracket's
    /// end if one was opened, once.
    pub fn close(&mut self) -> Vec<u8> {
        if std::mem::take(&mut self.opened) { BRACKET_END.to_vec() } else { Vec::new() }
    }

    /// Ghostty's rule, `isSafeWith`, over what this chunk adds to the whole paste.
    fn unsafe_in(&self, raw: &[u8]) -> Option<&'static str> {
        if self.bracketed {
            let mut w = self.tail.clone();
            w.extend_from_slice(raw);
            w.windows(BRACKET_END.len())
                .any(|x| x == BRACKET_END)
                .then_some("it holds the bracketed-paste end (ESC [ 201 ~)")
        } else {
            raw.iter().any(|&b| b == b'\n' || b == b'\r').then_some(
                "it holds a line break and the program hasn't asked for bracketed paste, so each line would run",
            )
        }
    }
}

/// libghostty's encoder over one chunk's bytes: the strip list made spaces, and outside a bracket
/// `\n` made `\r`. Bracketed, the encoder frames the bytes itself; the frame is the stream's
/// (once per paste), so it is taken back off here.
fn encode(raw: &mut [u8], bracketed: bool) -> Vec<u8> {
    // The encoder writes the bytes one for one, plus the frame when bracketed: this is its size.
    let mut buf = vec![0u8; raw.len() + 2 * BRACKET_END.len()];
    let n = paste::encode(raw, bracketed, &mut buf).unwrap_or_else(|e| panic!("libghostty's paste encoder: {e}"));
    buf.truncate(n);
    if bracketed {
        debug_assert!(buf.starts_with(BRACKET_START) && buf.ends_with(BRACKET_END));
        buf[BRACKET_START.len()..n - BRACKET_END.len()].to_vec()
    } else {
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole paste's bytes from chunks, or the first refusal (with the bytes written before
    /// it and its close).
    fn run(bracketed: bool, allow_unsafe: bool, chunks: &[&str]) -> Result<Vec<u8>, (Vec<u8>, Refused)> {
        let mut s = Stream::new(bracketed, allow_unsafe);
        let mut out = Vec::new();
        for (i, c) in chunks.iter().enumerate() {
            match s.chunk(c, i + 1 == chunks.len()) {
                Ok(b) => out.extend_from_slice(&b),
                Err(r) => return Err((out, r)),
            }
        }
        Ok(out)
    }

    #[test]
    fn one_chunk_is_ghosttys_paste() {
        assert_eq!(run(true, false, &["a\nb\x00c"]).unwrap(), b"\x1b[200~a\nb c\x1b[201~");
        assert_eq!(run(false, true, &["a\nb\x1bc"]).unwrap(), b"a\rb c");
        assert_eq!(run(false, false, &["plain"]).unwrap(), b"plain");
        assert_eq!(run(true, false, &[""]).unwrap(), b"", "an empty paste writes nothing");
    }

    #[test]
    fn chunks_frame_once() {
        let whole = run(true, false, &["one\n", "two\n", "three"]).unwrap();
        assert_eq!(whole, b"\x1b[200~one\ntwo\nthree\x1b[201~");
        let lazy = run(true, false, &["", "x", ""]).unwrap();
        assert_eq!(lazy, b"\x1b[200~x\x1b[201~", "the bracket opens with the first byte");
    }

    #[test]
    fn a_split_crlf_is_one_enter() {
        assert_eq!(run(false, true, &["a\r", "\nb"]).unwrap(), b"a\rb");
        assert_eq!(run(false, true, &["a\r\n", "b"]).unwrap(), b"a\rb");
        assert_eq!(run(false, true, &["a\r", "b"]).unwrap(), b"a\rb");
        // Inside a bracket the text is the program's, as it came.
        assert_eq!(run(true, false, &["a\r", "\nb"]).unwrap(), b"\x1b[200~a\r\nb\x1b[201~");
    }

    #[test]
    fn a_terminator_split_across_chunks_is_caught() {
        for cut in 1..BRACKET_END.len() {
            let (a, b) = BRACKET_END.split_at(cut);
            let (a, b) = (std::str::from_utf8(a).unwrap(), std::str::from_utf8(b).unwrap());
            let first = format!("x{a}");
            let second = format!("{b}y");
            let (before, r) = run(true, false, &[&first, &second, "z"]).unwrap_err();
            assert_eq!(before, format!("\x1b[200~x{}", a.replace('\x1b', " ")).as_bytes(), "cut at {cut}");
            assert_eq!(r.close, BRACKET_END, "the bracket is closed");
        }
        // With allow_unsafe the ESC is a space either way: the bracket can't be broken.
        let ok = run(true, true, &["x\x1b[2", "01~y"]).unwrap();
        assert_eq!(ok, b"\x1b[200~x [201~y\x1b[201~");
    }

    #[test]
    fn a_refused_paste_stays_refused() {
        let mut s = Stream::new(false, false);
        assert_eq!(s.chunk("echo hi", false).unwrap(), b"echo hi");
        let r = s.chunk(" there\nrm -rf", false).unwrap_err();
        assert!(r.close.is_empty(), "nothing to close outside a bracket");
        assert!(s.chunk("more", true).is_err(), "later chunks write nothing");
        assert_eq!(s.written, 7);
    }
}
