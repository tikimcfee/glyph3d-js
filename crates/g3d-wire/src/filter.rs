//! The terminal-query filter. termd answers a program's terminal queries itself, and the
//! queries still ride the raw output (PROTOCOL.md, "Terminal queries are termd's to
//! answer"). A client that writes raw output to a real terminal must take the queries out
//! first, or that terminal's answers come back on stdin and get typed into the program.
//!
//! [`QueryFilter`] removes them from a byte stream that arrives in arbitrary chunks: an
//! escape sequence cut across two chunks is held until it ends. Everything that is not a
//! query passes through unchanged and in order. Removed:
//!
//! - DA1/DA2/DA3 (`CSI c`, `CSI > c`, `CSI = c`), DECID (`ESC Z`), DECREQTPARM (`CSI x`)
//! - DSR/CPR and the other device status requests (`CSI n`, `CSI ? n`)
//! - DECRQM (`CSI $ p`, `CSI ? $ p`), XTVERSION (`CSI > q`), the Kitty keyboard query
//!   (`CSI ? u`), XTQMODKEYS (`CSI ? m`), XTSMGRAPHICS reads, DECRQCRA (`CSI * y`)
//! - XTWINOPS reports (`CSI 11/13/14/15/16/18/19/20/21 t`)
//! - OSC 4/5 palette queries, OSC 10–19 colour queries, OSC 21 Kitty colour queries,
//!   OSC 52 clipboard reads
//! - DECRQSS (`DCS $ q … ST`) and XTGETTCAP (`DCS + q … ST`)
//! - Kitty graphics queries (`APC G a=q … ST`)

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
/// An OSC longer than this before its end is not a query (queries are short).
const OSC_DECIDE: usize = 64;
/// A CSI longer than this is malformed; it passes through as-is.
const CSI_MAX: usize = 512;
/// How much of a Kitty graphics APC's control data is read to find `a=q`.
const APC_DECIDE: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Str {
    Osc,
    Dcs,
    Apc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum St {
    Ground,
    Esc,
    EscInter,
    Csi,
    /// Buffering a string's start until it can be judged.
    Str(Str),
    /// A string judged harmless: bytes pass straight through until it ends.
    StrPass {
        bel_ends: bool,
    },
    /// A query string: bytes are dropped until it ends.
    StrDrop {
        bel_ends: bool,
    },
}

/// Removes terminal queries from a raw output stream. See the module docs.
#[derive(Debug)]
pub struct QueryFilter {
    st: St,
    pending: Vec<u8>,
    /// The string just dropped ended with ESC; a following `\` (the rest of ST) goes too.
    drop_st: bool,
}

impl Default for QueryFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl QueryFilter {
    pub fn new() -> Self {
        Self { st: St::Ground, pending: Vec::new(), drop_st: false }
    }

    /// Filters `input`, appending what passes to `out`. A sequence still open at the end of
    /// `input` is held for the next call.
    pub fn filter(&mut self, input: &[u8], out: &mut Vec<u8>) {
        let mut i = 0;
        while i < input.len() {
            if self.st == St::Ground {
                // Fast path: copy up to the next ESC.
                let rest = &input[i..];
                match rest.iter().position(|&b| b == ESC) {
                    None => {
                        out.extend_from_slice(rest);
                        return;
                    }
                    Some(p) => {
                        out.extend_from_slice(&rest[..p]);
                        i += p;
                    }
                }
            }
            self.step(input[i], out);
            i += 1;
        }
    }

    /// Convenience: filters one chunk into a new buffer.
    pub fn filter_vec(&mut self, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        self.filter(input, &mut out);
        out
    }

    fn begin_esc(&mut self) {
        self.pending.clear();
        self.pending.push(ESC);
        self.st = St::Esc;
    }

    fn emit_pending(&mut self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.pending);
        self.pending.clear();
    }

    /// Drops the held sequence, keeping only the C0 controls inside it: a terminal runs
    /// those while it parses a sequence, so they are not part of the query.
    fn drop_pending(&mut self, out: &mut Vec<u8>) {
        out.extend(self.pending.iter().copied().filter(|&b| b < 0x20 && b != ESC));
        self.pending.clear();
    }

    fn step(&mut self, b: u8, out: &mut Vec<u8>) {
        match self.st {
            St::Ground => {
                if b == ESC {
                    self.begin_esc();
                } else {
                    out.push(b);
                }
            }
            St::Esc => {
                if std::mem::take(&mut self.drop_st) && b == b'\\' {
                    self.pending.clear();
                    self.st = St::Ground;
                    return;
                }
                match b {
                    b'[' => {
                        self.pending.push(b);
                        self.st = St::Csi;
                    }
                    b']' => {
                        self.pending.push(b);
                        self.st = St::Str(Str::Osc);
                    }
                    b'P' => {
                        self.pending.push(b);
                        self.st = St::Str(Str::Dcs);
                    }
                    b'_' => {
                        self.pending.push(b);
                        self.st = St::Str(Str::Apc);
                    }
                    b'X' | b'^' => {
                        self.pending.push(b);
                        self.emit_pending(out);
                        self.st = St::StrPass { bel_ends: false };
                    }
                    0x20..=0x2f => {
                        self.pending.push(b);
                        self.st = St::EscInter;
                    }
                    ESC => {
                        self.emit_pending(out);
                        self.begin_esc();
                    }
                    CAN | SUB => {
                        self.pending.push(b);
                        self.emit_pending(out);
                        self.st = St::Ground;
                    }
                    0x00..=0x1f => self.pending.push(b),
                    b'Z' => {
                        self.drop_pending(out);
                        self.st = St::Ground;
                    }
                    _ => {
                        self.pending.push(b);
                        self.emit_pending(out);
                        self.st = St::Ground;
                    }
                }
            }
            St::EscInter => match b {
                0x20..=0x2f | 0x00..=0x17 | 0x19 | 0x1c..=0x1f => self.pending.push(b),
                ESC => {
                    self.emit_pending(out);
                    self.begin_esc();
                }
                _ => {
                    self.pending.push(b);
                    self.emit_pending(out);
                    self.st = St::Ground;
                }
            },
            St::Csi => match b {
                0x20..=0x3f | 0x7f | 0x00..=0x17 | 0x19 | 0x1c..=0x1f => {
                    self.pending.push(b);
                    if self.pending.len() > CSI_MAX {
                        self.emit_pending(out);
                        self.st = St::Ground;
                    }
                }
                0x40..=0x7e => {
                    self.pending.push(b);
                    if csi_is_query(&self.pending[2..]) {
                        self.drop_pending(out);
                    } else {
                        self.emit_pending(out);
                    }
                    self.st = St::Ground;
                }
                ESC => {
                    self.emit_pending(out);
                    self.begin_esc();
                }
                _ => {
                    // CAN, SUB or a byte that can't be in a CSI: the sequence is over.
                    self.pending.push(b);
                    self.emit_pending(out);
                    self.st = St::Ground;
                }
            },
            St::Str(kind) => self.step_str(kind, b, out),
            St::StrPass { bel_ends } => match b {
                BEL if bel_ends => {
                    out.push(b);
                    self.st = St::Ground;
                }
                ESC => self.begin_esc(),
                CAN | SUB => {
                    out.push(b);
                    self.st = St::Ground;
                }
                _ => out.push(b),
            },
            St::StrDrop { bel_ends } => match b {
                BEL if bel_ends => self.st = St::Ground,
                ESC => {
                    self.begin_esc();
                    self.drop_st = true;
                }
                CAN | SUB => self.st = St::Ground,
                _ => {}
            },
        }
    }

    fn step_str(&mut self, kind: Str, b: u8, out: &mut Vec<u8>) {
        let body_is_query = |pending: &[u8]| match kind {
            Str::Osc => osc_is_query(&pending[2..]),
            Str::Dcs => dcs_header(&pending[2..]).is_some_and(|(q, _)| q),
            Str::Apc => apc_is_query(&pending[2..]),
        };
        match b {
            BEL if kind == Str::Osc => {
                if body_is_query(&self.pending) {
                    self.pending.clear();
                } else {
                    self.pending.push(b);
                    self.emit_pending(out);
                }
                self.st = St::Ground;
            }
            ESC => {
                // The string ends here (ST, or aborted by a new sequence).
                if body_is_query(&self.pending) {
                    self.begin_esc();
                    self.drop_st = true;
                } else {
                    self.emit_pending(out);
                    self.begin_esc();
                }
            }
            CAN | SUB => {
                self.pending.push(b);
                self.emit_pending(out);
                self.st = St::Ground;
            }
            _ => {
                self.pending.push(b);
                let body = &self.pending[2..];
                let verdict = match kind {
                    Str::Osc => (body.len() > OSC_DECIDE).then_some(false),
                    Str::Dcs => dcs_header(body).map(|(q, _)| q),
                    Str::Apc => {
                        if body[0] != b'G' {
                            Some(false)
                        } else if b == b';' || body.len() > APC_DECIDE {
                            Some(apc_is_query(body))
                        } else {
                            None
                        }
                    }
                };
                match verdict {
                    None => {}
                    Some(true) => {
                        self.pending.clear();
                        self.st = St::StrDrop { bel_ends: kind == Str::Osc };
                    }
                    Some(false) => {
                        self.emit_pending(out);
                        self.st = St::StrPass { bel_ends: kind == Str::Osc };
                    }
                }
            }
        }
    }
}

/// Splits a CSI body (after `ESC [`, final included) into prefix, params, intermediates
/// and final. C0 controls inside are ignored.
fn csi_parts(body: &[u8]) -> (Option<u8>, Vec<u8>, Vec<u8>, u8) {
    let fin = *body.last().unwrap();
    let mut prefix = None;
    let mut params = Vec::new();
    let mut inter = Vec::new();
    for (i, &b) in body[..body.len() - 1].iter().enumerate() {
        match b {
            b'<' | b'=' | b'>' | b'?' if i == 0 => prefix = Some(b),
            0x30..=0x3f => params.push(b),
            0x20..=0x2f => inter.push(b),
            _ => {}
        }
    }
    (prefix, params, inter, fin)
}

fn param(params: &[u8], n: usize) -> Option<u32> {
    let s = std::str::from_utf8(params).ok()?;
    let p = s.split(';').nth(n)?;
    if p.is_empty() { Some(0) } else { p.parse().ok() }
}

fn csi_is_query(body: &[u8]) -> bool {
    let (prefix, params, inter, fin) = csi_parts(body);
    let none = inter.is_empty();
    match fin {
        b'c' => none && matches!(prefix, None | Some(b'>') | Some(b'=')),
        b'n' => none && matches!(prefix, None | Some(b'?')),
        b'p' => inter == b"$" && matches!(prefix, None | Some(b'?')),
        b'q' => none && prefix == Some(b'>'),
        b'u' => none && prefix == Some(b'?'),
        b'm' => none && prefix == Some(b'?'),
        b't' => {
            none && prefix.is_none() && matches!(param(&params, 0), Some(11 | 13 | 14 | 15 | 16 | 18 | 19 | 20 | 21))
        }
        b'x' => none && prefix.is_none() && matches!(param(&params, 0), Some(0 | 1)),
        b'S' => none && prefix == Some(b'?') && param(&params, 1) == Some(1),
        b'y' => inter == b"*",
        _ => false,
    }
}

fn osc_is_query(body: &[u8]) -> bool {
    let s = match std::str::from_utf8(body) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let mut parts = s.split(';');
    let num: u32 = match parts.next().and_then(|n| n.parse().ok()) {
        Some(n) => n,
        None => return false,
    };
    let rest: Vec<&str> = parts.collect();
    match num {
        4 | 5 => rest.iter().skip(1).step_by(2).any(|p| *p == "?"),
        10..=19 => rest.contains(&"?"),
        21 => rest.iter().any(|p| p.ends_with("=?")),
        52 => rest.iter().skip(1).any(|p| *p == "?"),
        _ => false,
    }
}

/// A DCS header (params, intermediates, final) once its final byte has arrived:
/// `(is_query, header_len)`.
fn dcs_header(body: &[u8]) -> Option<(bool, usize)> {
    let mut inter = Vec::new();
    for (i, &b) in body.iter().enumerate() {
        match b {
            0x30..=0x3f => {}
            0x20..=0x2f => inter.push(b),
            0x40..=0x7e => return Some(((inter == b"$" || inter == b"+") && b == b'q', i + 1)),
            _ => return Some((false, i + 1)),
        }
    }
    None
}

fn apc_is_query(body: &[u8]) -> bool {
    if body.first() != Some(&b'G') {
        return false;
    }
    let ctl = &body[1..];
    let ctl = ctl.split(|&b| b == b';').next().unwrap_or(ctl);
    ctl.split(|&b| b == b',').any(|kv| kv == b"a=q")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &[u8]) -> Vec<u8> {
        QueryFilter::new().filter_vec(input)
    }

    /// Feeding byte by byte gives the same output as feeding at once.
    fn split_invariant(input: &[u8]) {
        let whole = run(input);
        let mut f = QueryFilter::new();
        let mut out = Vec::new();
        for b in input {
            f.filter(std::slice::from_ref(b), &mut out);
        }
        assert_eq!(out, whole, "byte-at-a-time differs for {:?}", String::from_utf8_lossy(input));
        for cut in 0..input.len() {
            let mut f = QueryFilter::new();
            let mut out = Vec::new();
            f.filter(&input[..cut], &mut out);
            f.filter(&input[cut..], &mut out);
            assert_eq!(out, whole, "cut at {cut} differs");
        }
    }

    #[test]
    fn removes_queries() {
        let queries: &[&[u8]] = &[
            b"\x1b[c",
            b"\x1b[0c",
            b"\x1b[>c",
            b"\x1b[>0c",
            b"\x1b[=c",
            b"\x1bZ",
            b"\x1b[5n",
            b"\x1b[6n",
            b"\x1b[?6n",
            b"\x1b[?996n",
            b"\x1b[?2004$p",
            b"\x1b[4$p",
            b"\x1b[>q",
            b"\x1b[>0q",
            b"\x1b[?u",
            b"\x1b[?4m",
            b"\x1b[14t",
            b"\x1b[16t",
            b"\x1b[18t",
            b"\x1b[x",
            b"\x1b[?1;1S",
            b"\x1b[1;1;1;1;1;1*y",
            b"\x1b]10;?\x07",
            b"\x1b]11;?\x1b\\",
            b"\x1b]12;?\x07",
            b"\x1b]4;1;?\x07",
            b"\x1b]4;1;?;2;?\x1b\\",
            b"\x1b]52;c;?\x07",
            b"\x1b]21;foreground=?\x1b\\",
            b"\x1bP$qm\x1b\\",
            b"\x1bP$q\"q\x1b\\",
            b"\x1bP+q544e\x1b\\",
            b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
        ];
        for q in queries {
            let input = [b"a".as_slice(), q, b"b"].concat();
            assert_eq!(run(&input), b"ab", "query kept: {:?}", String::from_utf8_lossy(q));
            split_invariant(&input);
        }
    }

    #[test]
    fn keeps_everything_else() {
        let kept: &[&[u8]] = &[
            b"\x1b[1;31mred\x1b[0m",
            b"\x1b[?1049h",
            b"\x1b[?2004h",
            b"\x1b[H\x1b[2J",
            b"\x1b[!p",
            b"\x1b[>4;1m",
            b"\x1b[>1u",
            b"\x1b[=1;1u",
            b"\x1b[8;24;80t",
            b"\x1b[22;0t",
            b"\x1b[>0n",
            b"\x1b[?25l",
            b"\x1b(0lqk\x1b(B",
            b"\x1b#8",
            b"\x1b7\x1b8",
            b"\x1b]2;title\x07",
            b"\x1b]0;t\x1b\\",
            b"\x1b]10;#ffffff\x07",
            b"\x1b]4;1;#ff0000\x07",
            b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
            b"\x1b]52;c;aGk=\x07",
            b"\x1bPq#0;2;0;0;0#0!10~-\x1b\\",
            b"\x1bP1000p\x1b\\",
            b"\x1b_Gf=24,s=1,v=1,a=T;AAAA\x1b\\",
            "héllo 世界 😀".as_bytes(),
        ];
        for k in kept {
            assert_eq!(run(k), *k, "changed: {:?}", String::from_utf8_lossy(k));
            split_invariant(k);
        }
    }

    #[test]
    fn long_osc_streams_through() {
        let title = "x".repeat(10_000);
        let input = format!("a\x1b]2;{title}\x07b\x1b[6nc");
        assert_eq!(run(input.as_bytes()), format!("a\x1b]2;{title}\x07bc").as_bytes());
    }

    #[test]
    fn c0_inside_a_dropped_query_survives() {
        assert_eq!(run(b"\x1b[\r6n"), b"\r");
    }

    #[test]
    fn mixed_stream_split_everywhere() {
        let input = b"$ \x1b[?2004h\x1b]11;?\x1b\\\x1b[6n\x1b[1mbold\x1b[0m\r\n\x1bP$qm\x1b\\\x1b]2;t\x07end";
        assert_eq!(run(input), b"$ \x1b[?2004h\x1b[1mbold\x1b[0m\r\n\x1b]2;t\x07end");
        split_invariant(input);
    }
}
